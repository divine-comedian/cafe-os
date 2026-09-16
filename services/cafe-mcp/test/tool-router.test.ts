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

const tools = ["query_records", "create_purchase", "delete_record"].map((name) => ({
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
    });
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(request[1].body));
    expect(payload.tool_choice.function.name).toBe("select_cafe_tools");
    expect(payload.response_format).toBeUndefined();
    expect(payload.reasoning).toEqual({ enabled: false, exclude: true });
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
});
