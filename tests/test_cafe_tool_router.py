import importlib.util
import json
import os
import unittest
from pathlib import Path


PLUGIN = Path(__file__).parents[1] / "config" / "hermes" / "plugins" / "cafe-tool-router" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("cafe_tool_router", PLUGIN)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def tool(name, properties=None, required=None):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": name,
            "parameters": {
                "type": "object",
                "properties": properties or {},
                "required": required or [],
            },
        },
    }


def _short_tool_name(entry):
    return entry["function"]["name"].rsplit("__", 1)[-1]


class ToolPolicyTests(unittest.TestCase):
    def setUp(self):
        MODULE._STATES.clear()
        MODULE._PROVIDER_CATALOGS.clear()
        self.previous_mode = os.environ.get("CAFE_TOOL_VISIBILITY_MODE")
        os.environ["CAFE_TOOL_VISIBILITY_MODE"] = "full"

    def tearDown(self):
        if self.previous_mode is None:
            os.environ.pop("CAFE_TOOL_VISIBILITY_MODE", None)
        else:
            os.environ["CAFE_TOOL_VISIBILITY_MODE"] = self.previous_mode

    def test_full_catalog_allows_vocabulary_but_not_general_tools(self):
        request = {
            "messages": [{"role": "user", "content": "Remember Chema"}],
            "tools": [
                tool("mcp__cafe_os__query_records"),
                tool("mcp__voice_vocabulary__list_entries"),
                tool("mcp__voice_vocabulary__upsert_entry", {
                    "term": {"type": "string"},
                    "aliases": {"type": "array"},
                }, ["term"]),
                tool("terminal"),
            ],
        }
        updated = MODULE._llm_request(
            request=request,
            session_id="session",
            turn_id="turn",
            api_request_id="request",
        )["request"]
        functions = {entry["function"]["name"]: entry["function"] for entry in updated["tools"]}
        self.assertEqual(set(functions), {
            "mcp__cafe_os__query_records",
            "mcp__voice_vocabulary__list_entries",
            "mcp__voice_vocabulary__upsert_entry",
        })
        upsert = functions["mcp__voice_vocabulary__upsert_entry"]["parameters"]
        self.assertIn("term", upsert["properties"])
        self.assertEqual(upsert["required"], ["term"])
        self.assertIsNone(MODULE._pre_tool_call(
            tool_name="mcp__voice_vocabulary__list_entries",
            args={},
            session_id="session",
            turn_id="turn",
        ))
        blocked = MODULE._pre_tool_call(
            tool_name="terminal",
            args={},
            session_id="session",
            turn_id="turn",
        )
        self.assertEqual(blocked["action"], "block")

    def test_provider_write_requires_full_catalog_and_blocks_exact_duplicate(self):
        request = {
            "messages": [{"role": "user", "content": "Add provider Finca Ejemplo"}],
            "tools": [
                tool("mcp__cafe_os__query_records"),
                tool("mcp__cafe_os__create_provider", {
                    "name": {"type": "string"},
                    "region": {"type": "string"},
                }, ["name"]),
            ],
        }
        updated = MODULE._llm_request(
            request=request,
            session_id="session",
            turn_id="provider-turn",
            api_request_id="request",
        )["request"]
        system_text = "\n".join(
            message["content"] for message in updated["messages"] if message["role"] == "system"
        )
        self.assertIn("complete provider catalog", system_text)

        blocked = MODULE._pre_tool_call(
            tool_name="mcp__cafe_os__create_provider",
            args={"name": "Finca Ejemplo", "region": "Tabasco"},
            session_id="session",
            turn_id="provider-turn",
        )
        self.assertIn("POLICY_PROVIDER_CATALOG_REQUIRED", blocked["message"])

        catalog_args = {"resource": "provider", "limit": 100, "offset": 0}
        self.assertIsNone(MODULE._pre_tool_call(
            tool_name="mcp__cafe_os__query_records",
            args=catalog_args,
            session_id="session",
            turn_id="provider-turn",
        ))
        MODULE._post_tool_call(
            tool_name="mcp__cafe_os__query_records",
            args=catalog_args,
            result={
                "data": [{"id": "provider-id", "name": "finca ejemplo", "region": "tabasco"}],
                "meta": {"match_count": 1, "applied_filters": {}},
            },
            session_id="session",
            turn_id="provider-turn",
        )
        duplicate = MODULE._pre_tool_call(
            tool_name="mcp__cafe_os__create_provider",
            args={"name": "  Finca   Ejemplo ", "region": "Tabasco"},
            session_id="session",
            turn_id="provider-turn",
        )
        self.assertIn("POLICY_PROVIDER_ALREADY_EXISTS", duplicate["message"])
        self.assertIn("finca ejemplo", duplicate["message"])
        self.assertIsNone(MODULE._pre_tool_call(
            tool_name="mcp__cafe_os__create_provider",
            args={"name": "Monte Claro"},
            session_id="session",
            turn_id="provider-turn",
        ))

        MODULE._llm_request(
            request=request,
            session_id="session",
            turn_id="provider-follow-up",
            api_request_id="request-2",
        )
        self.assertIsNone(MODULE._pre_tool_call(
            tool_name="mcp__cafe_os__create_provider",
            args={"name": "Monte Claro"},
            session_id="session",
            turn_id="provider-follow-up",
        ))

    def test_glm_fallback_is_only_for_primary_availability_failures(self):
        common = {"provider": "openrouter", "model": "qwen/qwen3.8-flash"}
        rate_limit = MODULE._transform_api_error_classification(
            **common, status_code=429, error_code="rate_limit_exceeded",
        )
        self.assertTrue(rate_limit["should_fallback"])
        unavailable = MODULE._transform_api_error_classification(
            **common, status_code=404, error_code="model_not_available",
        )
        self.assertTrue(unavailable["should_fallback"])
        malformed = MODULE._transform_api_error_classification(
            **common, status_code=400, error_message="invalid tool call arguments",
        )
        self.assertFalse(malformed["should_fallback"])
        billing = MODULE._transform_api_error_classification(
            **common, status_code=402, error_message="insufficient credits",
        )
        self.assertFalse(billing["should_fallback"])
        self.assertIsNone(MODULE._transform_api_error_classification(
            provider="openrouter", model="z-ai/glm-5.3-flash", status_code=429,
        ))

    def test_provider_catalog_is_restored_from_conversation_history(self):
        messages = [
            {"role": "user", "content": "Check whether Finca Ejemplo already exists."},
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "catalog-call",
                    "type": "function",
                    "function": {
                        "name": "mcp__cafe_os__query_records",
                        "arguments": json.dumps({"resource": "provider", "limit": 100, "offset": 0}),
                    },
                }],
            },
            {
                "role": "tool",
                "tool_call_id": "catalog-call",
                "name": "mcp__cafe_os__query_records",
                "content": json.dumps({
                    "data": [{"id": "provider-id", "name": "Finca Norte", "region": "veracruz"}],
                    "meta": {"match_count": 1, "applied_filters": {}},
                }),
            },
            {"role": "assistant", "content": "Is this a separate provider?"},
            {"role": "user", "content": "Yes, Finca Ejemplo is separate. Prepare it."},
        ]
        catalog = [
            tool("mcp__cafe_os__query_records"),
            tool("mcp__cafe_os__create_provider", {"name": {"type": "string"}}, ["name"]),
        ]
        MODULE._llm_request(
            request={"messages": messages, "tools": catalog},
            session_id="restored-session",
            turn_id="follow-up",
            api_request_id="request",
        )
        self.assertIsNone(MODULE._pre_tool_call(
            tool_name="mcp__cafe_os__create_provider",
            args={"name": "Finca Ejemplo"},
            session_id="restored-session",
            turn_id="follow-up",
        ))

    def test_natural_approval_phrases_resume_the_persisted_proposal(self):
        pending_id = "11111111-1111-4111-8111-111111111111"
        wrapped_result = {
            "result": json.dumps({
                "ok": True,
                "pending_confirmation": {
                    "id": pending_id,
                    "tool_name": "create_green_coffee_lot",
                },
            }),
        }

        for approval in ("ship it", "I approve it", "sí, guárdalo", "go ahead"):
            with self.subTest(approval=approval):
                messages = [
                    {
                        "role": "tool",
                        "name": "mcp__cafe_os__create_green_coffee_lot",
                        "content": json.dumps(wrapped_result),
                    },
                    {"role": "assistant", "content": "Approve this workflow?"},
                    {"role": "user", "content": approval},
                ]
                pending = MODULE._pending_from_messages(messages)
                self.assertEqual(len(pending), 1)
                self.assertEqual(pending[0]["tool_name"], "create_green_coffee_lot")
                self.assertEqual(pending[0]["id"], pending_id)

        messages[-1] = {"role": "user", "content": "don't ship it yet"}
        self.assertEqual(MODULE._pending_from_messages(messages), [])

    def test_one_approval_can_finish_listed_non_destructive_workflow(self):
        provider_pending = "11111111-1111-4111-8111-111111111111"
        lot_pending = "22222222-2222-4222-8222-222222222222"
        purchase_pending = "33333333-3333-4333-8333-333333333333"
        provider_id = "44444444-4444-4444-8444-444444444444"
        lot_id = "55555555-5555-4555-8555-555555555555"
        purchase_id = "66666666-6666-4666-8666-666666666666"
        messages = [
            {"role": "user", "content": "Set up the provider, lot, and purchase."},
            {
                "role": "tool",
                "name": "mcp__cafe_os__create_provider",
                "content": json.dumps({
                    "ok": True,
                    "pending_confirmation": {
                        "id": provider_pending,
                        "tool_name": "create_provider",
                        "canonical_arguments": {"name": "Finca Ejemplo", "region": "Veracruz"},
                    },
                }),
            },
            {
                "role": "tool",
                "name": "mcp__cafe_os__create_green_coffee_lot",
                "content": json.dumps({
                    "ok": True,
                    "pending_confirmation": {
                        "id": lot_pending,
                        "tool_name": "create_green_coffee_lot",
                        "canonical_arguments": {"name": "Lote Ejemplo", "origin": "Veracruz"},
                    },
                }),
            },
            {
                "role": "tool",
                "name": "mcp__cafe_os__create_purchase",
                "content": json.dumps({
                    "ok": True,
                    "pending_confirmation": {
                        "id": purchase_pending,
                        "tool_name": "create_purchase",
                        "canonical_arguments": {
                            "provider_name": "Finca Ejemplo",
                            "green_coffee_lot_name": "Lote Ejemplo",
                            "received_weight_kg": 12,
                            "total_amount": 2400,
                            "currency": "MXN",
                        },
                    },
                }),
            },
            {
                "role": "assistant",
                "content": (
                    "Approve creating lot Lote Ejemplo and the related purchase from "
                    "Finca Ejemplo for 12 kg at MXN 2,400?"
                ),
            },
            {"role": "user", "content": "ship it"},
        ]
        catalog = [
            tool("mcp__cafe_os__query_records"),
            tool("mcp__cafe_os__create_provider"),
            tool("mcp__cafe_os__create_green_coffee_lot"),
            tool("mcp__cafe_os__create_purchase"),
            tool("mcp__cafe_os__delete_record"),
            tool("mcp__cafe_os__void_roast_batch"),
        ]
        request = {"messages": messages, "tools": catalog, "max_tokens": 16_384}
        updated = MODULE._llm_request(
            request=request,
            session_id="session",
            turn_id="approved-workflow",
            api_request_id="request",
        )["request"]
        self.assertEqual(
            {_short_tool_name(entry) for entry in updated["tools"]},
            {"create_provider", "create_green_coffee_lot", "create_purchase"},
        )
        system_text = "\n".join(
            message["content"] for message in updated["messages"] if message["role"] == "system"
        )
        self.assertIn("one assistant tool-call batch", system_text)

        calls = []

        provider_result = MODULE._tool_execution(
            tool_name="mcp__cafe_os__create_provider",
            args={"confirmation_id": "wrong-model-id"},
            next_call=lambda args: calls.append(("provider", args)) or {
                "ok": True,
                "operation_receipt": {
                    "operation": "create", "resource": "provider",
                    "id": provider_id, "authoritative": True,
                },
            },
            session_id="session",
            turn_id="approved-workflow",
        )
        self.assertEqual(calls, [("provider", {"confirmation_id": provider_pending})])
        MODULE._post_tool_call(
            tool_name="mcp__cafe_os__create_provider",
            args={"confirmation_id": provider_pending},
            result=provider_result,
            session_id="session",
            turn_id="approved-workflow",
        )
        lot_result = MODULE._tool_execution(
            tool_name="mcp__cafe_os__create_green_coffee_lot",
            args={"confirmation_id": "wrong-model-id"},
            next_call=lambda args: calls.append(("lot", args)) or {
                "ok": True,
                "operation_receipt": {
                    "operation": "create", "resource": "green_coffee_lot",
                    "id": lot_id, "authoritative": True,
                },
            },
            session_id="session",
            turn_id="approved-workflow",
        )
        MODULE._post_tool_call(
            tool_name="mcp__cafe_os__create_green_coffee_lot",
            args={"confirmation_id": lot_pending},
            result=lot_result,
            session_id="session",
            turn_id="approved-workflow",
        )
        state = MODULE._state("session", "approved-workflow")
        self.assertTrue(state["pending_bypass"])
        self.assertTrue(state["batch_approval"])
        self.assertEqual(state["selected"], {"create_purchase"})
        self.assertIn(provider_id, state["resolved_ids"]["provider"])
        self.assertIn(lot_id, state["resolved_ids"]["green_coffee_lot"])

        purchase_result = MODULE._tool_execution(
            tool_name="mcp__cafe_os__create_purchase",
            args={"confirmation_id": "wrong-model-id"},
            next_call=lambda args: calls.append(("purchase", args)) or {
                "ok": True,
                "operation_receipt": {
                    "operation": "create", "resource": "purchase",
                    "id": purchase_id, "authoritative": True,
                },
            },
            session_id="session",
            turn_id="approved-workflow",
        )
        self.assertEqual(
            calls[-1],
            ("purchase", {"confirmation_id": purchase_pending}),
        )
        self.assertEqual(purchase_result["operation_receipt"]["id"], purchase_id)
        MODULE._post_tool_call(
            tool_name="mcp__cafe_os__create_purchase",
            args={"confirmation_id": purchase_pending},
            result=purchase_result,
            session_id="session",
            turn_id="approved-workflow",
        )
        state = MODULE._state("session", "approved-workflow")
        self.assertFalse(state["pending_bypass"])
        self.assertTrue(state["batch_completed"])
        self.assertTrue(state["stop_tools"])
        self.assertEqual(len(state["batch_receipts"]), 3)

        final_request = MODULE._llm_request(
            request=request,
            session_id="session",
            turn_id="approved-workflow",
            api_request_id="request-3",
            api_call_count=2,
        )["request"]
        self.assertEqual(final_request["tools"], [])
        final_system_text = "\n".join(
            message["content"] for message in final_request["messages"] if message["role"] == "system"
        )
        self.assertIn("operation receipts", final_system_text)


if __name__ == "__main__":
    unittest.main()
