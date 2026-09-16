import { describe, expect, it, vi } from "vitest";
import {
  routeCafeTools,
  routingContext,
  sanitizeRoutingText,
  ToolRouterConfig,
} from "../src/tool-router.js";

const config: ToolRouterConfig = {
  apiKey: "test-key",
  model: "deepseek/deepseek-v4.1-flash",
  baseUrl: "https://openrouter.invalid/api/v1",
  timeoutMs: 1_000,
  maxTokens: 256,
  maxTools: 5,
  confidenceFloor: 0.55,
};

const tools = ["query_records", "create_purchase", "create_green_coffee_lot", "delete_record", "upload_purchase_document"].map((name) => ({
  type: "function",
  function: {
    name: `mcp__cafe_os__${name}`,
    description: `${name} description`,
    parameters: { type: "object", required: ["resource"] },
  },
}));

describe("Cafe tool intent router", () => {
  it("removes operational numbers, UUIDs, and paths from routing text", () => {
    const text = sanitizeRoutingText(
      "Compra MXN 3,800 para 11111111-1111-4111-8111-111111111111 desde /tmp/private/receipt.png",
    );
    expect(text).not.toContain("3,800");
    expect(text).not.toContain("11111111");
    expect(text).not.toContain("/tmp/private");
  });

  it("uses only the last two user messages and excludes tool results", () => {
    expect(
      routingContext([
        { role: "user", content: "old request" },
        { role: "tool", content: "sensitive database result" },
        { role: "user", content: "prepare a purchase" },
        { role: "assistant", content: "proposal with prices" },
        { role: "user", content: "confirmed" },
      ]),
    ).toContain("prepare a purchase");
    expect(routingContext([{ role: "tool", content: "secret" }])).toBe("");
  });

  it("validates and bounds the forced function selection", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "select_cafe_tools",
                  arguments: JSON.stringify({
                    intent: "create_purchase",
                    tool_ids: ["query_records", "create_purchase", "not_authorized"],
                    confidence: 0.95,
                    missing_required_fields: [],
                    requires_user_input: [],
                    lookup_resource: "provider",
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await routeCafeTools(
      { messages: [{ role: "user", content: "Prepare a purchase" }], tools },
      config,
      fetchMock as typeof fetch,
    );
    expect(result).toMatchObject({
      ok: true,
      intent: "create_purchase",
      toolIds: ["query_records", "create_purchase"],
      confidence: 0.95,
      lookupResource: "provider",
    });
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(request[1].body));
    expect(payload.tool_choice.function.name).toBe("select_cafe_tools");
    expect(payload.response_format).toBeUndefined();
    expect(payload.reasoning).toEqual({ enabled: false, exclude: true });
    expect(payload.messages[0].content).toContain("Green-coffee lots require a name and variety");
    expect(payload.messages[0].content).toContain("lookup_resource");
  });

  it("fails safely on malformed or low-confidence output", async () => {
    const lowConfidence = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: {
            name: "select_cafe_tools",
            arguments: JSON.stringify({ intent: "read", tool_ids: ["query_records"], confidence: 0.2 }),
          } }] } }],
        }),
        { status: 200 },
      ),
    );
    await expect(
      routeCafeTools(
        { messages: [{ role: "user", content: "Read purchases" }], tools },
        config,
        lowConfidence as typeof fetch,
      ),
    ).resolves.toMatchObject({ ok: false, fallbackReason: "router_low_confidence" });
  });

  it("removes green-coffee creation when required variety is missing", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: {
            name: "select_cafe_tools",
            arguments: JSON.stringify({
              intent: "incomplete_green_coffee_lot",
              tool_ids: ["create_green_coffee_lot"],
              confidence: 0.97,
              missing_required_fields: ["variety"],
              requires_user_input: ["variety"],
              lookup_resource: "unknown",
            }),
          } }] } }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      routeCafeTools(
        { messages: [{ role: "user", content: "Registra el lote Lote feria de Chiapas" }], tools },
        config,
        fetchMock as typeof fetch,
      ),
    ).resolves.toMatchObject({
      ok: true,
      toolIds: [],
      missingRequiredFields: ["variety"],
      requiresUserInput: ["variety"],
      lookupResource: "unknown",
    });
  });

  it("treats a redacted attachment marker as a supplied file path", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: {
          name: "select_cafe_tools",
          arguments: JSON.stringify({
            intent: "upload_purchase_document",
            tool_ids: ["query_records", "upload_purchase_document"],
            confidence: 0.96,
            missing_required_fields: ["purchase_id"],
            requires_user_input: ["file_path"],
            lookup_resource: "purchase",
          }),
        } }] } }],
      }), { status: 200 }),
    );

    await expect(
      routeCafeTools(
        { messages: [{ role: "user", content: "Attach /tmp/private/receipt.png to the purchase" }], tools },
        config,
        fetchMock as typeof fetch,
      ),
    ).resolves.toMatchObject({
      ok: true,
      toolIds: ["query_records", "upload_purchase_document"],
      requiresUserInput: [],
    });
  });
});
