"""Hermes host adapter for the Cafe OS tool catalog and safety boundary.

Production can expose the full Cafe catalog directly to the main model. The optional
routed mode delegates selection and validation to services/cafe-mcp/src/tool-router.ts.
This adapter also enforces request-scoped execution invariants available only inside
the Hermes process.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
from collections import OrderedDict
from typing import Any

_CAFE_PREFIX = "mcp__cafe_os__"
_VOICE_VOCABULARY_PREFIX = "mcp__voice_vocabulary__"
_AUTHORIZED_PREFIXES = (_CAFE_PREFIX, _VOICE_VOCABULARY_PREFIX)
_DISCOVERY = "discover_tools"
_PRIMARY_PROVIDER = "openrouter"
_PRIMARY_MODEL = "qwen/qwen3.8-flash"
_RATE_LIMIT_CODES = {"rate_limit", "rate_limited", "rate_limit_exceeded", "resource_exhausted", "throttled"}
_MODEL_UNAVAILABLE_CODES = {"model_not_found", "model_not_available", "invalid_model"}
_AVAILABILITY_STATUS_CODES = {408, 429, 500, 502, 503, 504, 524, 529}
_TRANSPORT_ERROR_TYPES = {
    "APIConnectionError", "APITimeoutError", "ConnectError", "ConnectTimeout",
    "ConnectionError", "ConnectionResetError", "PoolTimeout", "ReadError", "ReadTimeout",
    "RemoteProtocolError", "ServerDisconnectedError", "TimeoutError",
}


def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


_COMPLETION_BUDGET = _bounded_env_int("CAFE_HARNESS_COMPLETION_BUDGET", 8_192, 2_048, 131_072)
_MAX_HOP_TOKENS = _bounded_env_int("CAFE_HARNESS_MAX_HOP_TOKENS", 4_096, 1_024, 32_768)
_COMPLETION_RESERVE = _bounded_env_int("CAFE_HARNESS_COMPLETION_RESERVE", 1_024, 512, 8_192)
_FULL_CATALOG_HOP_CAP = _bounded_env_int("CAFE_FULL_CATALOG_HOP_CAP", 20, 2, 20)
_PROPOSAL_REQUIRED = {
    "create_provider": ["name"],
    "create_purchase": ["received_weight_kg"],
    "create_green_coffee_lot": ["name"],
    "create_roast_batch": ["green_coffee_lot_id"],
    "update_record": ["resource", "id", "fields"],
    "void_roast_batch": ["resource", "id"],
    "delete_record": ["resource", "id"],
    "upload_purchase_document": ["purchase_id", "file_path"],
    "remove_entry": ["term"],
}
_CHAINABLE_WRITES = {
    "create_provider", "create_purchase", "create_green_coffee_lot", "create_roast_batch",
    "update_record", "upload_purchase_document",
}
_MAX_APPROVED_CHAIN_WRITES = 8
_MAX_STATES = 256
_LOCK = threading.RLock()
_STATES: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
_PROVIDER_CATALOGS: "OrderedDict[str, list[dict[str, Any]]]" = OrderedDict()


def _event(event: str, **fields: Any) -> None:
    safe = {"event": event, **fields}
    encoded = json.dumps(safe, separators=(",", ":"), sort_keys=True)
    event_file = os.environ.get("CAFE_HARNESS_EVENT_FILE", "").strip()
    if event_file:
        try:
            with open(event_file, "a", encoding="utf-8") as handle:
                handle.write(encoded + "\n")
        except OSError:
            pass
    sys.stderr.write("CAFE_HARNESS_EVENT " + encoded + "\n")
    sys.stderr.flush()


def _short_name(value: str) -> str:
    return value.rsplit("__", 1)[-1]


def _tool_name(tool: Any) -> str:
    if not isinstance(tool, dict):
        return ""
    function = tool.get("function")
    return str(function.get("name") or "") if isinstance(function, dict) else ""


def _state_key(session_id: str, turn_id: str) -> str:
    return f"{session_id}:{turn_id}"


def _response_language(messages: Any) -> str:
    latest = ""
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict) and message.get("role") == "user":
                latest = str(message.get("content") or "")
    words = set(re.findall(r"[a-záéíóúñü]+", latest.lower()))
    spanish = {
        "qué", "cuál", "compras", "compra", "tenemos", "dame", "moneda", "cambies",
        "prepara", "preparar", "confirma", "confirmo", "sí", "lote", "tueste", "proveedor",
        "guarda", "guardar", "recibo", "archivo", "borrador", "elimina", "anula",
        "necesitamos", "dar", "alta", "nota", "sería", "contacto", "prepáralo", "muéstramela",
        "muestra", "espera", "aprobación", "únicamente", "cambios", "quiero", "estado", "carga",
        "cuánto", "hemos", "nada", "exactamente", "datos", "todavía", "ese", "esa",
        "peso", "exacto", "exacta", "fue", "kilo", "kilos", "kilogramo", "kilogramos",
    }
    english = {
        "what", "which", "purchase", "purchases", "prepare", "confirm", "confirmed", "save",
        "provider", "delete", "remove", "roast", "draft", "receipt", "file", "show", "find",
    }
    return "es-MX" if len(words & spanish) > len(words & english) else "en"


def _state(session_id: str, turn_id: str) -> dict[str, Any] | None:
    with _LOCK:
        return _STATES.get(_state_key(session_id, turn_id))


def _put_state(session_id: str, turn_id: str, value: dict[str, Any]) -> None:
    key = _state_key(session_id, turn_id)
    with _LOCK:
        _STATES[key] = value
        _STATES.move_to_end(key)
        while len(_STATES) > _MAX_STATES:
            _STATES.popitem(last=False)


def _provider_catalog(session_id: str) -> tuple[bool, list[dict[str, Any]]]:
    with _LOCK:
        if session_id not in _PROVIDER_CATALOGS:
            return False, []
        return True, list(_PROVIDER_CATALOGS[session_id])


def _set_provider_catalog(session_id: str, catalog: list[dict[str, Any]]) -> None:
    with _LOCK:
        _PROVIDER_CATALOGS[session_id] = list(catalog)
        _PROVIDER_CATALOGS.move_to_end(session_id)
        while len(_PROVIDER_CATALOGS) > _MAX_STATES:
            _PROVIDER_CATALOGS.popitem(last=False)


def _invalidate_provider_catalog(session_id: str) -> None:
    with _LOCK:
        _PROVIDER_CATALOGS.pop(session_id, None)


def _router_cli() -> str:
    explicit = os.environ.get("CAFE_TOOL_ROUTER_CLI", "").strip()
    if explicit:
        return explicit
    return os.path.join(os.getcwd(), "services", "cafe-mcp", "dist", "tool-router-cli.js")


def _visibility_mode() -> str:
    return "full" if os.environ.get("CAFE_TOOL_VISIBILITY_MODE", "routed").strip().lower() == "full" else "routed"


def _route(request: dict[str, Any], request_id: str) -> dict[str, Any]:
    payload = {
        "messages": request.get("messages") if isinstance(request.get("messages"), list) else [],
        "tools": request.get("tools") if isinstance(request.get("tools"), list) else [],
        "requestId": request_id,
    }
    try:
        completed = subprocess.run(
            ["node", _router_cli()],
            input=json.dumps(payload, separators=(",", ":")),
            capture_output=True,
            text=True,
            timeout=max(1.0, float(os.environ.get("CAFE_TOOL_ROUTER_PROCESS_TIMEOUT_SECONDS", "22"))),
            check=False,
            env=os.environ.copy(),
        )
        value = json.loads((completed.stdout or "").strip())
        if not isinstance(value, dict):
            raise ValueError("router result was not an object")
        return value
    except Exception:
        return {
            "ok": False,
            "intent": "fallback_discovery",
            "toolIds": [],
            "confidence": 0,
            "model": os.environ.get("CAFE_TOOL_ROUTER_MODEL", "deepseek/deepseek-v4.1-flash"),
            "durationMs": 0,
            "fallbackReason": "router_host_error",
        }


def _json_content(content: Any) -> Any:
    if isinstance(content, str):
        try:
            value = json.loads(content)
        except (TypeError, ValueError):
            start, end = content.find("{"), content.rfind("}")
            if start < 0 or end <= start:
                return None
            try:
                value = json.loads(content[start:end + 1])
            except (TypeError, ValueError):
                return None
        if isinstance(value, dict) and isinstance(value.get("result"), str):
            nested = _json_content(value["result"])
            return nested if nested is not None else value
        return value
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parsed = _json_content(part["text"])
                if parsed is not None:
                    return parsed
    return None


def _structured_result(result: Any) -> dict[str, Any]:
    value = _json_content(result) if isinstance(result, (str, list)) else result
    if not isinstance(value, dict):
        return {}
    structured = value.get("structuredContent")
    return structured if isinstance(structured, dict) else value


def _latest_user_text(messages: Any) -> str:
    latest = ""
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict) and message.get("role") == "user":
                latest = str(message.get("content") or "")
    return " ".join(latest.casefold().split())


def _is_explicit_approval(messages: Any) -> bool:
    latest = _latest_user_text(messages)
    if not latest:
        return False
    if re.search(
        r"\b(?:no|not|do not|don't|dont|wait|stop|cancel|decline|nope|nah|"
        r"todav[ií]a no|espera|alto|detente|cancela|rechazo|no lo hagas)\b",
        latest,
    ):
        return False
    return bool(re.search(
        r"(?:\bconfirm(?:ed|o|ado|ada)?\b|\bapprove(?:d)?\b|\bapproved\b|"
        r"\bi approve\b|\byes\b|\byep\b|\byeah\b|\bship it\b|\bdo it\b|"
        r"\bgo ahead\b|\bproceed\b|\bsave it\b|\bsave them\b|\bsave all\b|"
        r"\bdelete it\b|\bremove it\b|\bvoid it\b|"
        r"\bs[ií]\b|\bapruebo\b|\baprobado\b|\bdale\b|\bhazlo\b|"
        r"\badelante\b|\bprocede\b|\bgu[aá]rdalo\b|\bguarda todo\b|"
        r"\belim[ií]nalo\b|\bb[oó]rralo\b|\ban[uú]lalo\b)",
        latest,
    ))


def _activated_from_messages(messages: Any) -> set[str]:
    activated: set[str] = set()
    if not isinstance(messages, list):
        return activated
    last_user = max((index for index, message in enumerate(messages)
                     if isinstance(message, dict) and message.get("role") == "user"), default=-1)
    for message in messages[last_user + 1:]:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        name = str(message.get("name") or "")
        if name and _short_name(name) != _DISCOVERY:
            continue
        value = _json_content(message.get("content"))
        if not isinstance(value, dict):
            continue
        structured = value.get("structuredContent") if isinstance(value.get("structuredContent"), dict) else value
        tools = structured.get("tools") if isinstance(structured, dict) else None
        if not isinstance(tools, list):
            continue
        for item in tools:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                activated.add(item["name"])
    return activated


def _pending_from_messages(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return []
    if not _is_explicit_approval(messages):
        return []
    user_indexes = [
        index for index, message in enumerate(messages)
        if isinstance(message, dict) and message.get("role") == "user"
    ]
    if not user_indexes:
        return []
    approval_index = user_indexes[-1]
    proposal_start = user_indexes[-2] + 1 if len(user_indexes) > 1 else 0
    pending_operations: list[dict[str, Any]] = []
    for message in messages[proposal_start:approval_index]:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        message_tool = _short_name(str(message.get("tool_name") or message.get("name") or ""))
        value = _json_content(message.get("content"))
        if not isinstance(value, dict):
            continue
        structured = value.get("structuredContent") if isinstance(value.get("structuredContent"), dict) else value
        if (isinstance(structured.get("operation_receipt"), dict)
                or structured.get("ok") is False
                or "error" in structured
                or "api_error" in structured):
            continue
        pending = structured.get("pending_confirmation") if isinstance(structured, dict) else None
        if (isinstance(pending, dict) and isinstance(pending.get("tool_name"), str)
                and isinstance(pending.get("id"), str)):
            pending_operations.append({
                "tool_name": pending["tool_name"],
                "id": pending["id"],
                "canonical_arguments": (
                    pending.get("canonical_arguments")
                    if isinstance(pending.get("canonical_arguments"), dict)
                    else {}
                ),
                "message_tool": message_tool,
            })
    return pending_operations


def _batch_wave(pending_operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Cafe OS does not opt into Hermes' parallel MCP execution, so calls in one
    # assistant batch run sequentially. Keep the complete approved set in that
    # batch: prerequisite creates finish before a purchase resolves their names.
    return list(pending_operations)


def _pending_tool_ids(operations: list[dict[str, Any]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for operation in operations:
        tool_name = operation.get("tool_name")
        pending_id = operation.get("id")
        if isinstance(tool_name, str) and isinstance(pending_id, str):
            result.setdefault(tool_name, []).append(pending_id)
    return result


def _provider_catalog_from_messages(messages: Any) -> tuple[bool, list[dict[str, Any]]]:
    if not isinstance(messages, list):
        return False, []
    calls: dict[str, tuple[str, dict[str, Any]]] = {}
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if not isinstance(function, dict):
                continue
            arguments = function.get("arguments")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except (TypeError, ValueError):
                    arguments = {}
            call_id = call.get("id")
            if isinstance(call_id, str):
                calls[call_id] = (
                    _short_name(str(function.get("name") or "")),
                    arguments if isinstance(arguments, dict) else {},
                )

    available = False
    catalog: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        call_name, call_args = calls.get(str(message.get("tool_call_id") or ""), ("", {}))
        message_name = _short_name(str(message.get("tool_name") or message.get("name") or call_name))
        value = _json_content(message.get("content"))
        if not isinstance(value, dict):
            continue
        structured = value.get("structuredContent") if isinstance(value.get("structuredContent"), dict) else value
        receipt = structured.get("operation_receipt") if isinstance(structured, dict) else None
        if isinstance(receipt, dict) and receipt.get("resource") == "provider":
            available = False
            catalog = []
            continue
        if message_name != "query_records":
            continue
        data = structured.get("data") if isinstance(structured, dict) else None
        rows = data if isinstance(data, list) else []
        unfiltered_provider_query = (
            call_name == "query_records"
            and call_args.get("resource") == "provider"
            and not call_args.get("id")
            and not call_args.get("name")
        )
        provider_shaped_rows = bool(rows) and all(
            isinstance(row, dict) and "region" in row and "origin" not in row
            for row in rows
        )
        if unfiltered_provider_query or provider_shaped_rows:
            available = True
            catalog = [
                {key: row.get(key) for key in ("id", "name", "region") if row.get(key) is not None}
                for row in rows if isinstance(row, dict)
            ]
    return available, catalog


def _llm_request(*, request: Any = None, session_id: str = "", turn_id: str = "",
                 api_request_id: str = "", api_call_count: int = 0, **_: Any) -> dict[str, Any] | None:
    if not isinstance(request, dict):
        return None
    tools = request.get("tools")
    if not isinstance(tools, list):
        tools = []
    authorized_tools = {
        _short_name(name): tool for tool in tools
        if (name := _tool_name(tool)).startswith(_AUTHORIZED_PREFIXES)
    }
    state = _state(session_id, turn_id)
    if state is None:
        pending_operations = _pending_from_messages(request.get("messages"))
        pending_batch = (
            len(pending_operations) > 1
            and all(operation.get("tool_name") in _CHAINABLE_WRITES for operation in pending_operations)
        )
        active_pending = _batch_wave(pending_operations) if pending_batch else pending_operations[:1]
        all_pending_tools = {
            str(operation["tool_name"])
            for operation in pending_operations
            if operation.get("tool_name") in authorized_tools
        }
        pending_tools = {
            str(operation["tool_name"])
            for operation in active_pending
            if operation.get("tool_name") in authorized_tools
        }
        full_catalog = not pending_operations and _visibility_mode() == "full"
        if pending_tools:
            routed = {
                "ok": True,
                "intent": "confirm_pending_batch" if pending_batch else "confirm_pending_operation",
                "toolIds": sorted(pending_tools),
                "confidence": 1,
                "model": "pending-confirmation-bypass",
                "durationMs": 0,
                "fallbackReason": "pending_batch_bypass" if pending_batch else "pending_confirmation_bypass",
            }
        elif full_catalog:
            routed = {
                "ok": True,
                "intent": "full_catalog",
                "toolIds": sorted(name for name in authorized_tools if name != _DISCOVERY),
                "confidence": 1,
                "model": "full-catalog",
                "durationMs": 0,
                "fallbackReason": "full_catalog_mode",
            }
        else:
            routed = _route(request, api_request_id)
        selected = {
            value for value in routed.get("toolIds", [])
            if isinstance(value, str) and value in authorized_tools and value != _DISCOVERY
        }
        if (not full_catalog and not pending_operations
                and "create_provider" in selected and "query_records" in authorized_tools):
            selected.add("query_records")
        missing_required_fields = {
            value for value in routed.get("missingRequiredFields", [])
            if isinstance(value, str)
        }
        requires_user_input = {
            value for value in routed.get("requiresUserInput", [])
            if isinstance(value, str)
        }
        lookup_resource = str(routed.get("lookupResource") or "unknown")
        if lookup_resource not in {"provider", "purchase", "green_coffee_lot", "roast_batch", "unknown"}:
            lookup_resource = "unknown"
        lookup_resources = [
            str(value) for value in routed.get("lookupResources", [])
            if str(value) in {"provider", "purchase", "green_coffee_lot", "roast_batch"}
        ]
        if lookup_resource != "unknown" and lookup_resource not in lookup_resources:
            lookup_resources.insert(0, lookup_resource)
        fallback = not bool(routed.get("ok")) or (not selected and not requires_user_input)
        if fallback:
            selected = set()
        kinds = {
            short: ("read" if short in {_DISCOVERY, "query_records", "list_entries"} else "write")
            for short in authorized_tools
        }
        catalog_cached, cached_provider_catalog = _provider_catalog(session_id)
        if not catalog_cached:
            catalog_cached, cached_provider_catalog = _provider_catalog_from_messages(
                request.get("messages")
            )
            if catalog_cached:
                _set_provider_catalog(session_id, cached_provider_catalog)
        state = {
            "selected": selected,
            "fallback": fallback,
            "routed_fallback": fallback,
            "seen": set(),
            "successful": set(),
            "write_succeeded": False,
            "completion_tokens": 0,
            "kinds": kinds,
            "pending_ids": {
                str(operation["id"]) for operation in active_pending
                if isinstance(operation.get("id"), str)
            },
            "pending_ids_by_tool": _pending_tool_ids(active_pending),
            "pending_bypass": bool(active_pending),
            "approval_chain": bool(active_pending) and all(
                operation.get("tool_name") in _CHAINABLE_WRITES for operation in pending_operations
            ),
            "batch_approval": pending_batch,
            "batch_pending": list(pending_operations),
            "batch_active_ids": {
                str(operation["id"]) for operation in active_pending
                if isinstance(operation.get("id"), str)
            },
            "batch_receipts": [],
            "batch_completed": False,
            "chain_pending_confirmation": False,
            "approval_writes": 0,
            "full_catalog": full_catalog,
            "discovery_used": False,
            "pending_prepared": False,
            "activated": set(),
            "stop_tools": False,
            "terminal_reason": None,
            "intent": str(routed.get("intent") or "cafe_operation"),
            "visible": set(),
            "phase_instruction": None,
            "tool_result_chars": 0,
            "duplicate_calls": 0,
            "post_write_reads": 0,
            "resolved_ids": {},
            "provider_catalog_loaded": catalog_cached,
            "provider_catalog": cached_provider_catalog,
            "missing_required_fields": missing_required_fields,
            "blocking_missing_fields": requires_user_input,
            "lookup_resource": lookup_resource,
            "lookup_resources": lookup_resources,
            "work_hop_cap": (_FULL_CATALOG_HOP_CAP if full_catalog
                             else (4 if len(lookup_resources) > 1 else 3)),
        }
        _put_state(session_id, turn_id, state)
        if active_pending:
            _event(
                "confirmation_resume",
                session_id=session_id,
                turn_id=turn_id,
                tool=("batch" if pending_batch else next(iter(pending_tools), "unknown")),
                tools=sorted(pending_tools),
                operation_count=len(pending_operations),
            )
        _event(
            "router",
            request_id=api_request_id,
            session_id=session_id,
            turn_id=turn_id,
            model=routed.get("model"),
            ok=bool(routed.get("ok")),
            selected=sorted(all_pending_tools if pending_batch else selected),
            confidence=routed.get("confidence", 0),
            duration_ms=routed.get("durationMs", 0),
            input_tokens=(routed.get("usage") or {}).get("inputTokens", 0),
            output_tokens=(routed.get("usage") or {}).get("outputTokens", 0),
            cost_usd=(routed.get("usage") or {}).get("costUsd"),
            missing_required_fields=sorted(missing_required_fields),
            requires_user_input=sorted(requires_user_input),
            lookup_resource=lookup_resource,
            lookup_resources=lookup_resources,
            visibility_mode="full" if full_catalog else "routed",
            fallback_reason=routed.get("fallbackReason"),
        )

    newly_activated = ((_activated_from_messages(request.get("messages")) & set(authorized_tools))
                       - set(state.get("activated", set()))
                       if not state.get("pending_bypass") and not state.get("full_catalog") else set())
    if newly_activated:
        state["selected"].update(newly_activated)
        state["activated"].update(newly_activated)
        state["fallback"] = False
        _event("discovery_activated", session_id=session_id, turn_id=turn_id, tools=sorted(newly_activated))

    selected = set(state["selected"])
    if state.get("full_catalog"):
        visible = set(authorized_tools)
    else:
        visible = selected | ({_DISCOVERY} if not state.get("pending_bypass")
                              and not state.get("blocking_missing_fields")
                              and not state.get("phase_instruction")
                              and not state.get("discovery_used")
                              and state["fallback"] else set())

    # Operational cap: allow the expected work hops, then force a tool-free wrap-up.
    cap = 4 if state.get("routed_fallback") else int(state.get("work_hop_cap", 3))
    if state.get("blocking_missing_fields"):
        visible = set()
        terminal_reason = "needs_input"
        state["terminal_reason"] = terminal_reason
    elif state.get("stop_tools"):
        visible = set()
        terminal_reason = str(state.get("terminal_reason") or "completed")
    elif int(api_call_count or 0) >= cap:
        visible = set()
        terminal_reason = "hop_limit"
        state["terminal_reason"] = terminal_reason
    elif int(state.get("completion_tokens", 0)) >= _COMPLETION_BUDGET - _COMPLETION_RESERVE:
        visible = set()
        terminal_reason = "token_limit"
        state["terminal_reason"] = terminal_reason
    else:
        terminal_reason = "active"

    filtered = [tool for short, tool in authorized_tools.items() if short in visible]
    lookup_resource = str(state.get("lookup_resource") or "unknown")
    if lookup_resource != "unknown" and "query_records" in visible:
        constrained = []
        for tool in filtered:
            if _short_name(_tool_name(tool)) != "query_records":
                constrained.append(tool)
                continue
            copied = dict(tool)
            function = dict(copied.get("function") or {})
            parameters = dict(function.get("parameters") or {})
            properties = dict(parameters.get("properties") or {})
            properties["resource"] = {
                "type": "string",
                "const": lookup_resource,
                "description": f"This request must resolve a {lookup_resource} record.",
            }
            parameters["properties"] = properties
            function["parameters"] = parameters
            copied["function"] = function
            constrained.append(copied)
        filtered = constrained
    if state.get("pending_bypass"):
        confirmation_only = []
        for tool in filtered:
            copied = dict(tool)
            function = dict(copied.get("function") or {})
            short = _short_name(_tool_name(tool))
            tool_pending_ids = list(state.get("pending_ids_by_tool", {}).get(short, []))
            if not tool_pending_ids:
                continue
            function["description"] = (
                "Execute the exact stored pending operation. Call with confirmation_id only; "
                "no other argument is accepted."
            )
            confirmation_schema = (
                {"type": "string", "const": tool_pending_ids[0]}
                if len(tool_pending_ids) == 1
                else {"type": "string", "enum": tool_pending_ids}
            )
            function["parameters"] = {
                "type": "object",
                "additionalProperties": False,
                "properties": {"confirmation_id": confirmation_schema},
                "required": ["confirmation_id"],
            }
            copied["function"] = function
            confirmation_only.append(copied)
        filtered = confirmation_only
    else:
        proposal_only = []
        for tool in filtered:
            short = _short_name(_tool_name(tool))
            required = _PROPOSAL_REQUIRED.get(short)
            if not required:
                proposal_only.append(tool)
                continue
            copied = dict(tool)
            function = dict(copied.get("function") or {})
            function["description"] = (
                "Prepare a non-writing proposal only. Do not pass confirmation_id in this turn. "
                + str(function.get("description") or "")
            )
            parameters = dict(function.get("parameters") or {})
            properties = dict(parameters.get("properties") or {})
            properties.pop("confirmation_id", None)
            parameters["properties"] = properties
            parameters["required"] = required
            function["parameters"] = parameters
            copied["function"] = function
            proposal_only.append(copied)
        filtered = proposal_only
    state["visible"] = set(visible)
    updated = dict(request)
    updated["tools"] = filtered
    messages = list(updated.get("messages") or [])
    if not visible:
        batch_completion = (
            " The approved batch is complete. Combine all authoritative operation receipts into one concise "
            "user-facing result; name each created or updated record and do not expose internal IDs."
            if state.get("batch_completed") else ""
        )
        messages.append({
            "role": "system",
            "content": (
                "The authorized local-tool phase for this user turn is closed. Return the final answer now "
                "without any tool call. Match the language of the latest user message. If a proposal "
                "is pending, show its exact fields with units on every operational number (for example, "
                "12 kg and 705 s) and ask for confirmation; if execution failed, report only the "
                "actionable error." + batch_completion
            ),
        })
    elif state.get("phase_instruction"):
        messages.append({"role": "system", "content": str(state["phase_instruction"])})
    elif lookup_resource != "unknown" and "query_records" in visible:
        entity_boundary = (
            " In Spanish purchase phrasing, 'a PROVEEDOR del lote LOTE' names the provider only "
            "before 'del lote'; in English, 'from PROVIDER for the LOT lot' keeps those two names separate."
            if lookup_resource == "provider" else ""
        )
        messages.append({
            "role": "system",
            "content": (
                f"Resolve the named {lookup_resource} first with the active Cafe OS read tool. "
                f"Its resource is fixed to {lookup_resource}; do not search another record type."
                + entity_boundary
            ),
        })
    active_writes = sorted(
        name for name in visible
        if state.get("kinds", {}).get(name) == "write"
    )
    provider_write_active = bool({"create_provider", "create_purchase"} & set(active_writes)) \
        or (lookup_resource == "provider" and bool(active_writes))
    if provider_write_active and not state.get("pending_bypass"):
        messages.append({
            "role": "system",
            "content": (
                "Before this provider-related write, call query_records with resource=provider, limit=100, "
                "offset=0, and no name or id filter so you can compare the user's wording with the complete "
                "provider catalog. Treat 'from NAME' or Spanish 'de NAME'/'a NAME' in a purchase as a provider "
                "reference unless the operator explicitly labels it as a lot. If a catalog name is semantically "
                "similar but not exact, ask whether the operator means that existing provider and stop without "
                "preparing a mutation. After confirmation, use the existing provider for the requested proposal; "
                "never create a near-duplicate provider."
            ),
        })
    if state.get("full_catalog") and active_writes:
        messages.append({
            "role": "system",
            "content": (
                "The complete authorized local tool catalog is available. Choose only the tools needed for the "
                "user's request. Do not call a mutation tool for a read-only request. For a requested "
                "write, resolve stored names or UUIDs first when necessary, and call exactly one appropriate "
                "mutation tool only after every schema-required field is known. Cafe OS mutations and "
                "voice-vocabulary removal return pending_confirmation and require later approval; "
                "voice-vocabulary upsert_entry executes immediately and must not ask for confirmation. "
                "When one request needs multiple related non-destructive writes, the confirmation prompt must "
                "be backed by one assistant tool-call batch containing every separate proposal tool. For a "
                "new provider + new lot + purchase, batch create_provider, create_green_coffee_lot, and "
                "create_purchase together; the purchase may reference the exact proposed names with "
                "provider_name and green_coffee_lot_name until their IDs exist. Its remaining fields are "
                "received_weight_kg, purchased_at, total_amount, currency, payment_method, and notes. Never "
                "invent wrapper fields such as purchases, supplier_name, quantity, unit, or amount. Do not send only the first "
                "proposal. After all proposal results return, list every planned action and all known fields, "
                "and say that one confirmation covers the complete batch. Deletes and voiding a roast are excluded and must "
                "always be confirmed separately."
            ),
        })
    elif active_writes == ["upsert_entry"] and not state.get("pending_bypass"):
        messages.append({
            "role": "system",
            "content": (
                "The active voice-vocabulary upsert executes immediately without confirmation. "
                "Call it only when the operator states a durable term or after resolving an exact Cafe entity; "
                "never learn solely from an unverified transcript suggestion."
            ),
        })
    elif active_writes and not state.get("pending_bypass"):
        messages.append({
            "role": "system",
            "content": (
                "A proposal does not exist until you call the active mutation tool with the complete "
                "proposal fields. Do not merely describe a draft or ask for confirmation from prose. "
                "Call exactly one appropriate active mutation tool now after any required lookups; its "
                "pending_confirmation result is the only proposal you may present."
            ),
        })
    if state.get("chain_pending_confirmation") and state.get("pending_bypass"):
        messages.append({
            "role": "system",
            "content": (
                "This exact follow-on proposal is already covered by the operator's single workflow approval. "
                "Call the only active tool now with its confirmation_id. Do not ask the operator again and do "
                "not describe the proposal as awaiting confirmation."
            ),
        })
    elif state.get("batch_approval") and state.get("pending_bypass"):
        messages.append({
            "role": "system",
            "content": (
                "The operator approved the complete stored batch. Call every currently active confirmation "
                "tool together in one assistant tool-call batch. These are prerequisite operations selected "
                "for this wave. Do not ask another question and do not respond to the user until all remaining "
                "approved operations have executed and their combined receipts are available."
            ),
        })
    elif state.get("approval_chain") and not state.get("pending_bypass"):
        messages.append({
            "role": "system",
            "content": (
                "The operator's latest explicit confirmation authorizes the complete non-destructive workflow "
                "that was already listed in the preceding confirmation prompt. Continue now until every listed "
                "create, update, or evidence-upload action is complete, without asking again. Use only facts and "
                "fields already present in the conversation. Do not extend this approval to a delete, a "
                "roast void, an unlisted action, or a new user request. If no listed action "
                "remains, stop and return the concise final result."
            ),
        })
    if state.get("blocking_missing_fields"):
        missing = ", ".join(sorted(state["blocking_missing_fields"]))
        messages.append({
            "role": "system",
            "content": (
                f"Required user-supplied fields are missing: {missing}. Do not call discovery or any "
                "write tool. Use an already-selected read only if needed to resolve stored references, "
                "then ask the user explicitly for the missing value or file."
            ),
        })
    language = _response_language(request.get("messages"))
    messages.append({
        "role": "system",
        "content": (
            "In every user-facing reply, identify Cafe OS records by their human-readable name. "
            "Do not print record UUIDs, confirmation IDs, request IDs, raw tool calls, or raw tool errors "
            "unless the user explicitly asks for IDs or diagnostics. If a record has no name, use a concise "
            "human-readable description such as its record type plus date. Internal IDs may be used "
            "only inside tool arguments."
        ),
    })
    messages.append({
        "role": "system",
        "content": (
            "Response language for this turn: English only. Do not switch languages because a prior "
            "assistant response or stored record uses Spanish. Preserve stored calendar dates exactly "
            "in YYYY-MM-DD format; do not localize them. State units on every operational number."
            if language == "en" else
            "Idioma de respuesta para este turno: solo español mexicano natural. No cambies de idioma "
            "porque una respuesta anterior o un registro guardado use inglés. Conserva las fechas "
            "guardadas exactamente en formato YYYY-MM-DD; no las localices. Indica unidades en cada "
            "número operativo."
        ),
    })
    updated["messages"] = messages
    if "max_tokens" in updated:
        remaining = max(_COMPLETION_RESERVE, _COMPLETION_BUDGET - int(state.get("completion_tokens", 0)))
        updated["max_tokens"] = min(int(updated.get("max_tokens") or remaining), remaining, _MAX_HOP_TOKENS)
    _event(
        "model_hop",
        request_id=api_request_id,
        session_id=session_id,
        turn_id=turn_id,
        hop=int(api_call_count or 0),
        active_tools=sorted(visible),
        max_tokens=int(updated.get("max_tokens") or 0),
        completion_tokens_remaining=max(0, _COMPLETION_BUDGET - int(state.get("completion_tokens", 0))),
        tool_result_chars_remaining=max(0, 48000 - int(state.get("tool_result_chars", 0))),
        terminal_reason=terminal_reason,
    )
    return {"request": updated, "source": "cafe-tool-router", "reason": terminal_reason}


def _canonical_signature(tool_name: str, args: Any) -> str:
    raw = json.dumps(args if isinstance(args, dict) else {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((tool_name + "\n" + raw).encode("utf-8")).hexdigest()


def _normalized_display_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    plain = "".join(character for character in decomposed if not unicodedata.combining(character))
    return " ".join(plain.casefold().split())


def _provider_write_requires_catalog(short: str, args: Any) -> bool:
    if not isinstance(args, dict) or isinstance(args.get("confirmation_id"), str):
        return False
    if short in {"create_provider", "create_purchase"}:
        return True
    return short in {"update_record", "void_roast_batch", "delete_record"} \
        and args.get("resource") == "provider"


def _pre_tool_call(*, tool_name: str = "", args: Any = None, session_id: str = "",
                   turn_id: str = "", **_: Any) -> dict[str, str] | None:
    if not tool_name.startswith(_AUTHORIZED_PREFIXES):
        return {"action": "block", "message": "POLICY_UNAUTHORIZED_TOOL: only Cafe OS and voice-vocabulary tools are authorized."}
    state = _state(session_id, turn_id)
    if state is None:
        return {"action": "block", "message": "POLICY_MISSING_TURN_STATE: retry the Cafe request."}
    short = _short_name(tool_name)
    if short not in state["kinds"]:
        return {"action": "block", "message": "POLICY_UNKNOWN_TOOL: the Cafe tool is not in the authorized catalog."}
    if short not in state.get("visible", set()):
        return {"action": "block", "message": "POLICY_INACTIVE_TOOL: the tool phase is closed or this tool is not active."}
    if (not state.get("pending_bypass")
            and _provider_write_requires_catalog(short, args)
            and not state.get("provider_catalog_loaded")):
        return {
            "action": "block",
            "message": (
                "POLICY_PROVIDER_CATALOG_REQUIRED: before any provider-related proposal, call "
                "query_records with resource=provider, limit=100, offset=0, and no name or id filter. "
                "Compare the requested name with every returned provider. If a similar provider may be "
                "the intended record, ask the operator to confirm it and do not prepare a mutation yet."
            ),
        }
    if short == "create_provider" and isinstance(args, dict):
        requested = _normalized_display_name(args.get("name"))
        exact = next((row for row in state.get("provider_catalog", [])
                      if _normalized_display_name(row.get("name")) == requested), None)
        if requested and isinstance(exact, dict):
            display_name = str(exact.get("name") or args.get("name"))
            region = str(exact.get("region") or "").strip()
            suffix = f" ({region})" if region else ""
            return {
                "action": "block",
                "message": (
                    f"POLICY_PROVIDER_ALREADY_EXISTS: provider {display_name}{suffix} is already in Cafe OS. "
                    "Use that existing provider for the requested operation; do not create a duplicate."
                ),
            }
    if state.get("full_catalog") and not state.get("pending_bypass") and isinstance(args, dict):
        references: list[tuple[str, str]] = []
        resource = str(args.get("resource") or "")
        if short in {"update_record", "void_roast_batch", "delete_record"} and resource and isinstance(args.get("id"), str):
            references.append((resource, args["id"]))
        elif short == "upload_purchase_document" and isinstance(args.get("purchase_id"), str):
            references.append(("purchase", args["purchase_id"]))
        elif short == "create_purchase":
            if isinstance(args.get("provider_id"), str):
                references.append(("provider", args["provider_id"]))
            if isinstance(args.get("green_coffee_lot_id"), str):
                references.append(("green_coffee_lot", args["green_coffee_lot_id"]))
        elif short == "create_roast_batch" and isinstance(args.get("green_coffee_lot_id"), str):
            references.append(("green_coffee_lot", args["green_coffee_lot_id"]))
        fields = args.get("fields")
        if short == "update_record" and isinstance(fields, dict):
            if isinstance(fields.get("provider_id"), str):
                references.append(("provider", fields["provider_id"]))
            if isinstance(fields.get("green_coffee_lot_id"), str):
                references.append(("green_coffee_lot", fields["green_coffee_lot_id"]))
        resolved = state.get("resolved_ids", {})
        unresolved = [
            resource_name for resource_name, record_id in references
            if record_id not in resolved.get(resource_name, set())
        ]
        if unresolved:
            resources = ", ".join(sorted(set(unresolved)))
            return {
                "action": "block",
                "message": (
                    "POLICY_UNRESOLVED_REFERENCE: resolve the target with query_records in this turn before "
                    f"preparing the mutation. Missing verified resource: {resources}. Never invent or reuse an ID."
                ),
            }
    signature = _canonical_signature(tool_name, args)
    confirmation_id = args.get("confirmation_id") if isinstance(args, dict) else None
    if isinstance(confirmation_id, str) and confirmation_id not in state.get("pending_ids", set()):
        proposal_with_stray_confirmation = not state.get("pending_bypass") and len(args) > 1
        resumable_pending = state.get("pending_bypass") and len(state.get("pending_ids", set())) == 1
        if not proposal_with_stray_confirmation and not resumable_pending:
            return {
                "action": "block",
                "message": (
                    "POLICY_CONFIRMATION_CONTEXT: no pending proposal for this tool is awaiting approval in "
                    "the current conversation. Submit its complete business fields to prepare a proposal; do "
                    "not reuse a confirmation ID from another record."
                ),
            }
    if signature in state["successful"]:
        state["duplicate_calls"] = int(state.get("duplicate_calls", 0)) + 1
        return {"action": "block", "message": "POLICY_DUPLICATE_CALL: this exact successful call already ran in the current task."}
    if state["write_succeeded"] and state["kinds"].get(short) == "read":
        state["post_write_reads"] = int(state.get("post_write_reads", 0)) + 1
        return {"action": "block", "message": "POLICY_POST_WRITE_READ: the authoritative write receipt already verifies the operation."}
    if short == _DISCOVERY and state.get("discovery_used"):
        return {"action": "block", "message": "POLICY_DUPLICATE_DISCOVERY: discovery already ran for this request."}
    state["seen"].add(signature)
    _event("tool_start", session_id=session_id, turn_id=turn_id, tool=short, kind=state["kinds"].get(short))
    return None


def _post_tool_call(*, tool_name: str = "", args: Any = None, result: Any = None,
                    session_id: str = "", turn_id: str = "", duration_ms: int = 0,
                    error_type: str = "", **_: Any) -> None:
    state = _state(session_id, turn_id)
    if state is None or not tool_name.startswith(_AUTHORIZED_PREFIXES):
        return
    text = result if isinstance(result, str) else json.dumps(result, default=str)
    state["tool_result_chars"] = int(state.get("tool_result_chars", 0)) + len(text)
    success = not error_type and '"isError":true' not in text.replace(" ", "") and '"ok":false' not in text.replace(" ", "")
    signature = _canonical_signature(tool_name, args)
    short = _short_name(tool_name)
    confirmation_id = args.get("confirmation_id") if isinstance(args, dict) else None
    structured_result = _structured_result(result)
    if success:
        state["successful"].add(signature)
        if short == _DISCOVERY:
            state["discovery_used"] = True
        if state["kinds"].get(short) == "write":
            if "pending_confirmation" in text:
                pending = structured_result.get("pending_confirmation")
                chainable_follow_on = (
                    state.get("approval_chain")
                    and not state.get("pending_bypass")
                    and short in _CHAINABLE_WRITES
                    and isinstance(pending, dict)
                    and isinstance(pending.get("id"), str)
                    and pending.get("tool_name") == short
                )
                state["pending_prepared"] = True
                if chainable_follow_on:
                    state["pending_ids"] = {pending["id"]}
                    state["pending_bypass"] = True
                    state["chain_pending_confirmation"] = True
                    state["selected"] = {short}
                    state["full_catalog"] = False
                    state["stop_tools"] = False
                    state["terminal_reason"] = None
                    state["phase_instruction"] = None
                    _event("approval_chain_proposal", session_id=session_id, turn_id=turn_id, tool=short)
                else:
                    state["stop_tools"] = True
                    state["terminal_reason"] = "needs_confirmation"
                    _event("confirmation_suspend", session_id=session_id, turn_id=turn_id, tool=short)
            elif (state.get("batch_approval") and short in _CHAINABLE_WRITES
                  and isinstance(structured_result.get("operation_receipt"), dict)):
                receipt = structured_result["operation_receipt"]
                active_ids = set(state.get("batch_active_ids", set()))
                matching = next((
                    operation for operation in state.get("batch_pending", [])
                    if operation.get("tool_name") == short and operation.get("id") in active_ids
                ), None)
                if matching is not None:
                    completed_id = str(matching["id"])
                    state["batch_pending"] = [
                        operation for operation in state.get("batch_pending", [])
                        if operation.get("id") != completed_id
                    ]
                    active_ids.discard(completed_id)
                    state["batch_receipts"].append(receipt)
                    resource = str(receipt.get("resource") or "")
                    record_id = receipt.get("id")
                    if resource and isinstance(record_id, str):
                        state.setdefault("resolved_ids", {}).setdefault(resource, set()).add(record_id)
                    if resource == "provider":
                        _invalidate_provider_catalog(session_id)
                    state["approval_writes"] = int(state.get("approval_writes", 0)) + 1
                if active_ids:
                    next_wave = [
                        operation for operation in state.get("batch_pending", [])
                        if operation.get("id") in active_ids
                    ]
                else:
                    next_wave = _batch_wave(list(state.get("batch_pending", [])))
                    active_ids = {
                        str(operation["id"]) for operation in next_wave
                        if isinstance(operation.get("id"), str)
                    }
                state["batch_active_ids"] = active_ids
                state["pending_ids"] = set(active_ids)
                state["pending_ids_by_tool"] = _pending_tool_ids(next_wave)
                state["selected"] = {
                    str(operation["tool_name"]) for operation in next_wave
                    if isinstance(operation.get("tool_name"), str)
                }
                state["pending_bypass"] = bool(next_wave)
                state["pending_prepared"] = bool(next_wave)
                state["full_catalog"] = False
                state["work_hop_cap"] = _FULL_CATALOG_HOP_CAP
                state["write_succeeded"] = False
                state["stop_tools"] = not bool(next_wave)
                state["batch_completed"] = not bool(next_wave)
                state["terminal_reason"] = "completed" if state["batch_completed"] else None
                state["phase_instruction"] = None
                _event(
                    "approval_batch_write",
                    session_id=session_id,
                    turn_id=turn_id,
                    tool=short,
                    count=state["approval_writes"],
                    remaining=len(state.get("batch_pending", [])),
                )
            elif (state.get("approval_chain") and short in _CHAINABLE_WRITES
                  and isinstance(structured_result.get("operation_receipt"), dict)):
                receipt = structured_result["operation_receipt"]
                resource = str(receipt.get("resource") or "")
                record_id = receipt.get("id")
                if resource and isinstance(record_id, str):
                    state.setdefault("resolved_ids", {}).setdefault(resource, set()).add(record_id)
                if resource == "provider":
                    _invalidate_provider_catalog(session_id)
                state["approval_writes"] = int(state.get("approval_writes", 0)) + 1
                state["pending_bypass"] = False
                state["chain_pending_confirmation"] = False
                state["pending_ids"] = set()
                state["pending_prepared"] = False
                state["write_succeeded"] = False
                state["full_catalog"] = True
                state["work_hop_cap"] = _FULL_CATALOG_HOP_CAP
                state["stop_tools"] = state["approval_writes"] >= _MAX_APPROVED_CHAIN_WRITES
                state["terminal_reason"] = "approval_chain_limit" if state["stop_tools"] else None
                state["phase_instruction"] = (
                    "The last approved write succeeded. Continue every remaining non-destructive action that "
                    "was already listed in the operator-approved workflow. Do not ask for another confirmation. "
                    "If the approved workflow is complete, return the final result now."
                )
                _event(
                    "approval_chain_write",
                    session_id=session_id,
                    turn_id=turn_id,
                    tool=short,
                    count=state["approval_writes"],
                )
            else:
                state["write_succeeded"] = True
                state["stop_tools"] = True
                state["terminal_reason"] = "completed"
        elif short == "query_records":
            structured = structured_result
            meta = structured.get("meta")
            if not isinstance(meta, dict) and isinstance(structured.get("data"), dict):
                nested_meta = structured["data"].get("meta")
                meta = nested_meta if isinstance(nested_meta, dict) else None
            match_count = meta.get("match_count") if isinstance(meta, dict) else None
            exact_count = meta.get("exact_match_count") if isinstance(meta, dict) else None
            include = meta.get("include") if isinstance(meta, dict) else None
            applied_filters = meta.get("applied_filters") if isinstance(meta, dict) else None
            queried_resource = str(args.get("resource") or state.get("lookup_resource") or "") \
                if isinstance(args, dict) else str(state.get("lookup_resource") or "")
            data = structured.get("data")
            rows = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
            if (queried_resource == "provider" and isinstance(args, dict)
                    and not args.get("id") and not args.get("name")):
                state["provider_catalog_loaded"] = True
                state["provider_catalog"] = [
                    {key: row.get(key) for key in ("id", "name", "region") if row.get(key) is not None}
                    for row in rows if isinstance(row, dict)
                ]
                _set_provider_catalog(session_id, state["provider_catalog"])
                _event(
                    "provider_catalog_loaded",
                    session_id=session_id,
                    turn_id=turn_id,
                    count=len(state["provider_catalog"]),
                )
            returned_ids = {
                str(row["id"]) for row in rows
                if isinstance(row, dict) and isinstance(row.get("id"), str)
            }
            if queried_resource and returned_ids:
                resolved_ids = state.setdefault("resolved_ids", {})
                resolved_ids.setdefault(queried_resource, set()).update(returned_ids)
                _event(
                    "references_resolved",
                    session_id=session_id,
                    turn_id=turn_id,
                    resource=queried_resource,
                    count=len(returned_ids),
                )
            if state.get("blocking_missing_fields"):
                state["stop_tools"] = True
                state["terminal_reason"] = "needs_input"
            elif match_count == 0:
                state["stop_tools"] = True
                state["terminal_reason"] = "completed"
            elif (isinstance(applied_filters, dict) and isinstance(applied_filters.get("name"), str)
                  and isinstance(match_count, int) and match_count > 1 and exact_count != 1):
                state["stop_tools"] = True
                state["terminal_reason"] = "needs_clarification"
            elif (not state.get("full_catalog")
                  and (exact_count == 1 or (queried_resource == "provider" and state.get("provider_catalog_loaded")))
                  and any(name in state["selected"] for name in {
                "create_purchase", "create_green_coffee_lot", "create_roast_batch", "update_record", "delete_record"
            })):
                remaining_lookups = [
                    resource for resource in state.get("lookup_resources", [])
                    if resource != queried_resource
                ]
                state["lookup_resources"] = remaining_lookups
                if remaining_lookups:
                    state["lookup_resource"] = remaining_lookups[0]
                    state["phase_instruction"] = (
                        f"The {queried_resource} reference is resolved. Resolve the named "
                        f"{remaining_lookups[0]} next with query_records; do not propose the write yet."
                    )
                else:
                    state["selected"].discard("query_records")
                    state["lookup_resource"] = "unknown"
                if not remaining_lookups and "delete_record" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact deletion target is resolved. Do not inspect dependencies and do not "
                        "call query_records again. Call delete_record now with that resource and UUID to "
                        "create the non-writing pending deletion proposal."
                    )
                elif not remaining_lookups and "update_record" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact update target is resolved. Call update_record now with only the requested "
                        "changed fields to create the non-writing pending proposal."
                    )
                elif not remaining_lookups and "create_purchase" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact provider is resolved. Call create_purchase now with the supplied fields "
                        "to create the non-writing pending proposal."
                    )
                elif not remaining_lookups and "create_roast_batch" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact green-coffee lot is resolved. Call create_roast_batch now with the supplied "
                        "fields to create the non-writing pending proposal."
                    )
            elif not state.get("full_catalog") and match_count == 1 and any(name in state["selected"] for name in {
                "void_roast_batch", "upload_purchase_document"
            }):
                state["selected"].discard("query_records")
                if "void_roast_batch" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact roast record is resolved. Call void_roast_batch now with its resource and UUID "
                        "to create the non-writing pending proposal. "
                        "Do not ask for approval until that proposal exists."
                    )
                else:
                    state["phase_instruction"] = (
                        "The exact purchase is resolved. Call the active Cafe OS document upload tool now with "
                        "its UUID and the supplied file path to create the non-writing pending proposal."
                    )
            elif (include == "traceability" or (isinstance(args, dict) and isinstance(args.get("id"), str))) \
                    and not any(state["kinds"].get(name) == "write" for name in state["selected"]):
                state["stop_tools"] = True
                state["terminal_reason"] = "completed"
    elif isinstance(confirmation_id, str):
        state["stop_tools"] = True
        state["terminal_reason"] = "tool_failed"
    if int(state.get("tool_result_chars", 0)) >= 48000:
        state["stop_tools"] = True
        state["terminal_reason"] = "tool_result_limit"
    _event(
        "tool_end",
        session_id=session_id,
        turn_id=turn_id,
        tool=short,
        kind=state["kinds"].get(short),
        success=success,
        duration_ms=int(duration_ms or 0),
        error_code=error_type or None,
    )


def _post_api_request(*, session_id: str = "", turn_id: str = "", usage: Any = None,
                      api_call_count: int = 0, assistant_tool_call_count: int = 0, **_: Any) -> None:
    state = _state(session_id, turn_id)
    if state is None or not isinstance(usage, dict):
        return
    output = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    state["completion_tokens"] = int(state.get("completion_tokens", 0)) + max(0, output)
    _event(
        "model_hop_end",
        session_id=session_id,
        turn_id=turn_id,
        hop=int(api_call_count or 0),
        output_tokens=output,
        completion_tokens_total=state["completion_tokens"],
    )
    if int(assistant_tool_call_count or 0) == 0:
        terminal_reason = str(state.get("terminal_reason") or (
            "needs_confirmation" if state.get("pending_prepared") else "completed"
        ))
        _event(
            "terminal",
            session_id=session_id,
            turn_id=turn_id,
            terminal_reason=terminal_reason,
            hop=int(api_call_count or 0),
            duplicate_call_count=int(state.get("duplicate_calls", 0)),
            post_write_read_count=int(state.get("post_write_reads", 0)),
        )


def _transform_api_error_classification(*, provider: str = "", model: str = "",
                                        status_code: Any = None, error_type: str = "",
                                        error_code: str = "", error_message: str = "",
                                        error_body: Any = None, **_: Any) -> dict[str, Any] | None:
    """Keep the paid fallback as availability insurance, never as a quality retry."""
    if provider.strip().lower() != _PRIMARY_PROVIDER or model.strip() != _PRIMARY_MODEL:
        return None
    try:
        status = int(status_code) if status_code is not None else None
    except (TypeError, ValueError):
        status = None
    code = str(error_code or "").strip().lower()
    body = json.dumps(error_body if isinstance(error_body, dict) else {}, default=str).lower()
    message = f"{error_message} {body}".lower()

    if status == 429 or code in _RATE_LIMIT_CODES or "rate limit" in message or "rate_limit" in message:
        return {
            "reason": "rate_limit",
            "retryable": True,
            "should_rotate_credential": False,
            "should_fallback": True,
        }
    model_unavailable = (
        code in _MODEL_UNAVAILABLE_CODES
        or any(signal in message for signal in (
            "model not found", "model_not_found", "model not available", "model_not_available",
            "no endpoints found that support tool use", "no such model", "unknown model",
        ))
    )
    if model_unavailable:
        return {"reason": "model_not_found", "retryable": False, "should_fallback": True}
    if status in _AVAILABILITY_STATUS_CODES or error_type in _TRANSPORT_ERROR_TYPES:
        reason = "timeout" if status in {408, 504, 524} or "Timeout" in error_type else \
            "overloaded" if status in {503, 529} else "server_error"
        return {"reason": reason, "retryable": True, "should_fallback": True}

    if status == 413 or "context length" in message or "context_length" in message:
        return {
            "reason": "context_overflow",
            "retryable": True,
            "should_compress": True,
            "should_fallback": False,
        }
    reason = (
        "billing" if status == 402
        else "auth_permanent" if status in {401, 403}
        else "format_error" if status in {400, 404, 409, 422}
        else "unknown"
    )
    return {
        "reason": reason,
        "retryable": False,
        "should_compress": False,
        "should_rotate_credential": False,
        "should_fallback": False,
    }


def _tool_execution(*, tool_name: str = "", args: Any = None, next_call=None,
                    session_id: str = "", turn_id: str = "", **_: Any) -> Any:
    if not tool_name.startswith(_AUTHORIZED_PREFIXES):
        _event(
            "tool_blocked",
            session_id=session_id,
            turn_id=turn_id,
            tool="non_cafe",
            error_code="POLICY_UNAUTHORIZED_TOOL",
        )
        return json.dumps({"error": "POLICY_UNAUTHORIZED_TOOL: only Cafe OS and voice-vocabulary tools are authorized."})
    effective_args = dict(args) if isinstance(args, dict) else args
    state = _state(session_id, turn_id)
    if isinstance(effective_args, dict) and state is not None and state.get("pending_bypass"):
        short = _short_name(tool_name)
        tool_pending_ids = list(state.get("pending_ids_by_tool", {}).get(short, []))
        pending_id = tool_pending_ids[0] if len(tool_pending_ids) == 1 else None
        if pending_id is None and len(state.get("pending_ids", set())) == 1:
            pending_id = next(iter(state["pending_ids"]))
    else:
        pending_id = None
    if isinstance(effective_args, dict) and isinstance(pending_id, str):
        if effective_args.get("confirmation_id") != pending_id:
            effective_args["confirmation_id"] = pending_id
            _event(
                "tool_args_normalized",
                session_id=session_id,
                turn_id=turn_id,
                tool=_short_name(tool_name),
                field="confirmation_id",
                value="restored_session_pending_id",
            )
    if (isinstance(effective_args, dict) and state is not None and not state.get("pending_bypass")
            and "confirmation_id" in effective_args and len(effective_args) > 1):
        effective_args.pop("confirmation_id", None)
        _event(
            "tool_args_normalized",
            session_id=session_id,
            turn_id=turn_id,
            tool=_short_name(tool_name),
            field="confirmation_id",
            value="removed_from_proposal",
        )
    if (_short_name(tool_name) == "query_records" and isinstance(effective_args, dict)
            and not effective_args.get("resource") and state is not None):
        lookup_resource = str(state.get("lookup_resource") or "unknown")
        if lookup_resource != "unknown":
            effective_args["resource"] = lookup_resource
            _event(
                "tool_args_normalized",
                session_id=session_id,
                turn_id=turn_id,
                tool="query_records",
                field="resource",
                value=lookup_resource,
            )
    if not callable(next_call):
        return json.dumps({"error": "POLICY_EXECUTION_UNAVAILABLE"})
    return next_call(effective_args)


def register(ctx) -> None:
    ctx.register_middleware("llm_request", _llm_request)
    ctx.register_middleware("tool_execution", _tool_execution)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("post_api_request", _post_api_request)
    ctx.register_hook("transform_api_error_classification", _transform_api_error_classification)
