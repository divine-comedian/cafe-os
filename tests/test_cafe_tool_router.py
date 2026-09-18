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
                self.assertEqual(
                    MODULE._pending_from_messages(messages),
                    ("create_green_coffee_lot", pending_id),
                )

        messages[-1] = {"role": "user", "content": "don't ship it yet"}
        self.assertIsNone(MODULE._pending_from_messages(messages))

    def test_one_approval_can_finish_listed_non_destructive_workflow(self):
        pending_id = "11111111-1111-4111-8111-111111111111"
        lot_id = "22222222-2222-4222-8222-222222222222"
        purchase_id = "33333333-3333-4333-8333-333333333333"
        messages = [
            {
                "role": "tool",
                "name": "mcp__cafe_os__create_green_coffee_lot",
                "content": json.dumps({
                    "ok": True,
                    "pending_confirmation": {
                        "id": pending_id,
                        "tool_name": "create_green_coffee_lot",
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
            {"create_green_coffee_lot"},
        )

        initial_calls = []

        def confirm_lot(args):
            initial_calls.append(args)
            return {
                "ok": True,
                "operation_receipt": {
                    "operation": "create",
                    "resource": "green_coffee_lot",
                    "id": lot_id,
                    "authoritative": True,
                },
            }

        lot_result = MODULE._tool_execution(
            tool_name="mcp__cafe_os__create_green_coffee_lot",
            args={"confirmation_id": "wrong-model-id"},
            next_call=confirm_lot,
            session_id="session",
            turn_id="approved-workflow",
        )
        self.assertEqual(initial_calls, [{"confirmation_id": pending_id}])
        MODULE._post_tool_call(
            tool_name="mcp__cafe_os__create_green_coffee_lot",
            args={"confirmation_id": pending_id},
            result=lot_result,
            session_id="session",
            turn_id="approved-workflow",
        )
        state = MODULE._state("session", "approved-workflow")
        self.assertTrue(state["approval_chain"])
        self.assertTrue(state["full_catalog"])
        self.assertFalse(state["stop_tools"])
        self.assertIn(lot_id, state["resolved_ids"]["green_coffee_lot"])

        continued = MODULE._llm_request(
            request=request,
            session_id="session",
            turn_id="approved-workflow",
            api_request_id="request-2",
            api_call_count=1,
        )["request"]
        self.assertIn("create_purchase", {_short_tool_name(entry) for entry in continued["tools"]})
        system_text = "\n".join(
            message["content"] for message in continued["messages"] if message["role"] == "system"
        )
        self.assertIn("without asking again", system_text)

        follow_on_calls = []

        def create_purchase(args):
            follow_on_calls.append(args)
            if len(follow_on_calls) == 1:
                return {
                    "ok": True,
                    "pending_confirmation": {
                        "id": "44444444-4444-4444-8444-444444444444",
                        "tool_name": "create_purchase",
                    },
                }
            return {
                "ok": True,
                "operation_receipt": {
                    "operation": "create",
                    "resource": "purchase",
                    "id": purchase_id,
                    "status": "draft",
                    "authoritative": True,
                },
            }

        purchase_result = MODULE._tool_execution(
            tool_name="mcp__cafe_os__create_purchase",
            args={
                "provider_id": "55555555-5555-4555-8555-555555555555",
                "green_coffee_lot_id": lot_id,
                "received_weight_kg": 20,
                "total_cost": 15_000,
                "currency": "MXN",
            },
            next_call=create_purchase,
            session_id="session",
            turn_id="approved-workflow",
        )
        self.assertEqual(len(follow_on_calls), 2)
        self.assertEqual(
            follow_on_calls[1],
            {"confirmation_id": "44444444-4444-4444-8444-444444444444"},
        )
        self.assertEqual(purchase_result["operation_receipt"]["id"], purchase_id)

        destructive_calls = []
        destructive_result = MODULE._tool_execution(
            tool_name="mcp__cafe_os__delete_record",
            args={"resource": "purchase", "id": purchase_id},
            next_call=lambda args: destructive_calls.append(args) or {
                "ok": True,
                "pending_confirmation": {
                    "id": "66666666-6666-4666-8666-666666666666",
                    "tool_name": "delete_record",
                },
            },
            session_id="session",
            turn_id="approved-workflow",
        )
        self.assertEqual(len(destructive_calls), 1)
        self.assertIn("pending_confirmation", destructive_result)


if __name__ == "__main__":
    unittest.main()
