"""Thin Hermes host adapter for the TypeScript Cafe tool router.

Selection and validation live in services/cafe-mcp/src/tool-router.ts. This file only
bridges Hermes's Python plugin API, filters model-facing schemas, and enforces
request-scoped execution invariants available only inside the Hermes process.
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
from collections import OrderedDict
from typing import Any

_CAFE_PREFIX = "mcp__cafe_os__"
_DISCOVERY = "discover_tools"
_MAX_STATES = 256
_LOCK = threading.RLock()
_STATES: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


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


def _router_cli() -> str:
    explicit = os.environ.get("CAFE_TOOL_ROUTER_CLI", "").strip()
    if explicit:
        return explicit
    return os.path.join(os.getcwd(), "services", "cafe-mcp", "dist", "tool-router-cli.js")


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
            timeout=max(1.0, float(os.environ.get("CAFE_TOOL_ROUTER_PROCESS_TIMEOUT_SECONDS", "10"))),
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


def _pending_from_messages(messages: Any) -> tuple[str, str] | None:
    if not isinstance(messages, list):
        return None
    latest_user = ""
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "user":
            latest_user = str(message.get("content") or "").strip().lower()
    confirmation_words = ("confirm", "sí", "si,", "yes", "approved", "apruebo", "guarda", "save", "void", "delete")
    if not any(word in latest_user for word in confirmation_words):
        return None
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        value = _json_content(message.get("content"))
        if not isinstance(value, dict):
            continue
        structured = value.get("structuredContent") if isinstance(value.get("structuredContent"), dict) else value
        pending = structured.get("pending_confirmation") if isinstance(structured, dict) else None
        if (isinstance(pending, dict) and isinstance(pending.get("tool_name"), str)
                and isinstance(pending.get("id"), str)):
            return pending["tool_name"], pending["id"]
    return None


def _llm_request(*, request: Any = None, session_id: str = "", turn_id: str = "",
                 api_request_id: str = "", api_call_count: int = 0, **_: Any) -> dict[str, Any] | None:
    if not isinstance(request, dict):
        return None
    tools = request.get("tools")
    if not isinstance(tools, list):
        tools = []
    cafe_tools = { _short_name(name): tool for tool in tools if (name := _tool_name(tool)).startswith(_CAFE_PREFIX) }
    state = _state(session_id, turn_id)
    if state is None:
        pending_context = _pending_from_messages(request.get("messages"))
        pending_tool = pending_context[0] if pending_context else None
        routed = ({
            "ok": True,
            "intent": "confirm_pending_operation",
            "toolIds": [pending_tool],
            "confidence": 1,
            "model": "pending-confirmation-bypass",
            "durationMs": 0,
            "fallbackReason": "pending_confirmation_bypass",
        } if pending_tool in cafe_tools else _route(request, api_request_id))
        selected = {
            value for value in routed.get("toolIds", [])
            if isinstance(value, str) and value in cafe_tools and value != _DISCOVERY
        }
        fallback = not bool(routed.get("ok")) or not selected
        if fallback:
            selected = set()
        kinds = {
            short: ("read" if short in {_DISCOVERY, "query_records"} else "write")
            for short in cafe_tools
        }
        state = {
            "selected": selected,
            "fallback": fallback,
            "routed_fallback": fallback,
            "seen": set(),
            "successful": set(),
            "write_succeeded": False,
            "completion_tokens": 0,
            "kinds": kinds,
            "pending_ids": {pending_context[1]} if pending_context else set(),
            "pending_bypass": bool(pending_context),
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
        }
        _put_state(session_id, turn_id, state)
        if pending_context:
            _event("confirmation_resume", session_id=session_id, turn_id=turn_id, tool=pending_tool)
        _event(
            "router",
            request_id=api_request_id,
            session_id=session_id,
            turn_id=turn_id,
            model=routed.get("model"),
            ok=bool(routed.get("ok")),
            selected=sorted(selected),
            confidence=routed.get("confidence", 0),
            duration_ms=routed.get("durationMs", 0),
            input_tokens=(routed.get("usage") or {}).get("inputTokens", 0),
            output_tokens=(routed.get("usage") or {}).get("outputTokens", 0),
            cost_usd=(routed.get("usage") or {}).get("costUsd"),
            fallback_reason=routed.get("fallbackReason"),
        )

    newly_activated = ((_activated_from_messages(request.get("messages")) & set(cafe_tools))
                       - set(state.get("activated", set()))
                       if not state.get("pending_bypass") else set())
    if newly_activated:
        state["selected"].update(newly_activated)
        state["activated"].update(newly_activated)
        state["fallback"] = False
        _event("discovery_activated", session_id=session_id, turn_id=turn_id, tools=sorted(newly_activated))

    selected = set(state["selected"])
    undisclosed = set(cafe_tools) - selected - {_DISCOVERY}
    visible = selected | ({_DISCOVERY} if not state.get("pending_bypass")
                          and not state.get("discovery_used")
                          and (state["fallback"] or undisclosed) else set())

    # Operational cap: allow the expected work hops, then force a tool-free wrap-up.
    cap = 4 if state.get("routed_fallback") else 3
    if state.get("stop_tools"):
        visible = set()
        terminal_reason = str(state.get("terminal_reason") or "completed")
    elif int(api_call_count or 0) >= cap:
        visible = set()
        terminal_reason = "hop_limit"
    elif int(state.get("completion_tokens", 0)) >= 7168:
        visible = set()
        terminal_reason = "token_limit"
    else:
        terminal_reason = "active"

    filtered = [tool for short, tool in cafe_tools.items() if short in visible]
    state["visible"] = set(visible)
    updated = dict(request)
    updated["tools"] = filtered
    messages = list(updated.get("messages") or [])
    if not visible:
        messages.append({
            "role": "system",
            "content": (
                "The Cafe OS tool phase for this user turn is closed. Return the final answer now "
                "without any tool call. Match the language of the latest user message. If a proposal "
                "is pending, show its exact fields and ask for confirmation; if execution failed, "
                "report only the actionable error."
            ),
        })
    elif state.get("phase_instruction"):
        messages.append({"role": "system", "content": str(state["phase_instruction"])})
    language = _response_language(request.get("messages"))
    messages.append({
        "role": "system",
        "content": (
            "Response language for this turn: English only. Do not switch languages because a prior "
            "assistant response or stored record uses Spanish."
            if language == "en" else
            "Idioma de respuesta para este turno: solo español mexicano natural. No cambies de idioma "
            "porque una respuesta anterior o un registro guardado use inglés."
        ),
    })
    updated["messages"] = messages
    if "max_tokens" in updated:
        remaining = max(1024, 8192 - int(state.get("completion_tokens", 0)))
        updated["max_tokens"] = min(int(updated.get("max_tokens") or remaining), remaining, 4096)
    _event(
        "model_hop",
        request_id=api_request_id,
        session_id=session_id,
        turn_id=turn_id,
        hop=int(api_call_count or 0),
        active_tools=sorted(visible),
        completion_tokens_remaining=max(0, 8192 - int(state.get("completion_tokens", 0))),
        tool_result_chars_remaining=max(0, 48000 - int(state.get("tool_result_chars", 0))),
        terminal_reason=terminal_reason,
    )
    return {"request": updated, "source": "cafe-tool-router", "reason": terminal_reason}


def _canonical_signature(tool_name: str, args: Any) -> str:
    raw = json.dumps(args if isinstance(args, dict) else {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((tool_name + "\n" + raw).encode("utf-8")).hexdigest()


def _pre_tool_call(*, tool_name: str = "", args: Any = None, session_id: str = "",
                   turn_id: str = "", **_: Any) -> dict[str, str] | None:
    if not tool_name.startswith(_CAFE_PREFIX):
        return {"action": "block", "message": "POLICY_NON_CAFE_TOOL: only Cafe OS tools are authorized."}
    state = _state(session_id, turn_id)
    if state is None:
        return {"action": "block", "message": "POLICY_MISSING_TURN_STATE: retry the Cafe request."}
    short = _short_name(tool_name)
    if short not in state["kinds"]:
        return {"action": "block", "message": "POLICY_UNKNOWN_TOOL: the Cafe tool is not in the authorized catalog."}
    if short not in state.get("visible", set()):
        return {"action": "block", "message": "POLICY_INACTIVE_TOOL: the tool phase is closed or this tool is not active."}
    signature = _canonical_signature(tool_name, args)
    confirmation_id = args.get("confirmation_id") if isinstance(args, dict) else None
    if isinstance(confirmation_id, str) and confirmation_id not in state.get("pending_ids", set()):
        return {"action": "block", "message": "POLICY_CONFIRMATION_CONTEXT: this proposal is not bound to the active session."}
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
    if state is None or not tool_name.startswith(_CAFE_PREFIX):
        return
    text = result if isinstance(result, str) else json.dumps(result, default=str)
    state["tool_result_chars"] = int(state.get("tool_result_chars", 0)) + len(text)
    success = not error_type and '"isError":true' not in text.replace(" ", "") and '"ok":false' not in text.replace(" ", "")
    signature = _canonical_signature(tool_name, args)
    short = _short_name(tool_name)
    confirmation_id = args.get("confirmation_id") if isinstance(args, dict) else None
    if success:
        state["successful"].add(signature)
        if short == _DISCOVERY:
            state["discovery_used"] = True
        if state["kinds"].get(short) == "write":
            if "pending_confirmation" in text:
                state["pending_prepared"] = True
                state["stop_tools"] = True
                state["terminal_reason"] = "needs_confirmation"
                _event("confirmation_suspend", session_id=session_id, turn_id=turn_id, tool=short)
            else:
                state["write_succeeded"] = True
                state["stop_tools"] = True
                state["terminal_reason"] = "completed"
        elif short == "query_records":
            structured = _structured_result(result)
            meta = structured.get("meta")
            if not isinstance(meta, dict) and isinstance(structured.get("data"), dict):
                nested_meta = structured["data"].get("meta")
                meta = nested_meta if isinstance(nested_meta, dict) else None
            match_count = meta.get("match_count") if isinstance(meta, dict) else None
            exact_count = meta.get("exact_match_count") if isinstance(meta, dict) else None
            include = meta.get("include") if isinstance(meta, dict) else None
            applied_filters = meta.get("applied_filters") if isinstance(meta, dict) else None
            if match_count == 0:
                state["stop_tools"] = True
                state["terminal_reason"] = "completed"
            elif (isinstance(applied_filters, dict) and isinstance(applied_filters.get("name"), str)
                  and isinstance(match_count, int) and match_count > 1 and exact_count != 1):
                state["stop_tools"] = True
                state["terminal_reason"] = "needs_clarification"
            elif exact_count == 1 and any(name in state["selected"] for name in {
                "create_purchase", "create_roast_batch", "update_record", "delete_record"
            }):
                state["selected"].discard("query_records")
                if "delete_record" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact deletion target is resolved. Do not inspect dependencies and do not "
                        "call query_records again. Call delete_record now with that resource and UUID to "
                        "create the non-writing pending deletion proposal."
                    )
                elif "update_record" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact update target is resolved. Call update_record now with only the requested "
                        "changed fields to create the non-writing pending proposal."
                    )
                elif "create_purchase" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact provider is resolved. Call create_purchase now with the supplied fields "
                        "to create the non-writing pending proposal."
                    )
                elif "create_roast_batch" in state["selected"]:
                    state["phase_instruction"] = (
                        "The exact green-coffee lot is resolved. Call create_roast_batch now with the supplied "
                        "fields to create the non-writing pending proposal."
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


def _tool_execution(*, tool_name: str = "", args: Any = None, next_call=None,
                    session_id: str = "", turn_id: str = "", **_: Any) -> Any:
    if not tool_name.startswith(_CAFE_PREFIX):
        _event(
            "tool_blocked",
            session_id=session_id,
            turn_id=turn_id,
            tool="non_cafe",
            error_code="POLICY_NON_CAFE_TOOL",
        )
        return json.dumps({"error": "POLICY_NON_CAFE_TOOL: only Cafe OS tools are authorized."})
    return next_call(args) if callable(next_call) else json.dumps({"error": "POLICY_EXECUTION_UNAVAILABLE"})


def register(ctx) -> None:
    ctx.register_middleware("llm_request", _llm_request)
    ctx.register_middleware("tool_execution", _tool_execution)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("post_api_request", _post_api_request)
