import { describe, expect, it } from "vitest";
import { gradeTurn, shortToolName } from "../src/grade.ts";
import { decodeToolCalls } from "../src/run.ts";
import { coreFixture } from "../src/fixtures.ts";

describe("eval grading", () => {
  it("normalizes Hermes MCP tool prefixes", () => {
    expect(shortToolName("mcp__cafe_os__query_records")).toBe("query_records");
  });
  it("checks trajectories, spend, response, and state deterministically", () => {
    const assertions = gradeTurn(
      {
        requiredTools: ["query_records"], allowedTools: ["query_records"], maxToolCalls: 1,
        maxApiCalls: 2, mutationCount: 0, responsePatterns: ["MXN"],
        stateContains: [{ table: "providers", fields: { name: "café sierra" } }],
        stateAbsent: [{ table: "providers", fields: { name: "Monte Azul" } }],
        toolCallContains: [{ name: "query_records", arguments: { resource: "provider", filters: { status: "draft" } } }],
      },
      "MXN 12,500", [{ name: "mcp__cafe_os__query_records", arguments: { resource: "provider", filters: { status: "draft", limit: 10 } } }], [], { api_calls: 2 }, coreFixture(),
    );
    expect(assertions.every((item) => item.pass)).toBe(true);
  });
  it("separates Hermes envelopes from nested MCP calls", () => {
    const decoded = decodeToolCalls({ messages: [
      { role: "user", content: "fixture" },
      { role: "assistant", tool_calls: [
        { function: { name: "tool_search", arguments: "{\"queries\":[\"cafe\"]}" } },
        { function: { name: "tool_call", arguments: "{\"calls\":[{\"name\":\"mcp__cafe_os__query_records\",\"arguments\":{\"resource\":\"provider\"}}]}" } },
        { function: { name: "tool_call", arguments: "{\"calls\":\"malformed nested payload\"}" } },
      ] },
    ] });
    expect(decoded.raw.map((call) => call.name)).toEqual(["tool_search", "tool_call", "tool_call"]);
    expect(decoded.effective).toEqual([{ name: "mcp__cafe_os__query_records", arguments: { resource: "provider" } }]);
  });

  it("matches the structured roast checkpoint array recursively", () => {
    const checkpoints = [
      { elapsed_seconds: 510, temperature_c: 190, airflow_setting: 3, gas_setting: 2, note: "primer crack" },
    ];
    const assertions = gradeTurn(
      {
        toolCallContains: [{ name: "create_roast_batch", arguments: { checkpoints } }],
        toolCallFieldPatterns: [{ name: "create_roast_batch", path: ["checkpoints", 0, "note"], pattern: "primer\\s+crack" }],
        stateContains: [{ table: "roast_batches", fields: { id: "new-roast", checkpoints } }],
      },
      "Prepared for confirmation.",
      [{ name: "mcp__cafe_os__create_roast_batch", arguments: { checkpoints: [{ ...checkpoints[0], temperature_c: "190" }] } }],
      [],
      { api_calls: 1 },
      { ...coreFixture(), roast_batches: [{ id: "new-roast", checkpoints: [{ ...checkpoints[0], gas_setting: "2" }] }] },
    );
    expect(assertions.filter((item) => item.message.includes("contains") || item.message.includes("matches")).every((item) => item.pass)).toBe(true);
  });

  it("rejects an incorrectly placed roast-loss decimal", () => {
    const assertions = gradeTurn(
      { roastLoss: { greenInputKg: 12, roastedOutputKg: 10.2 } },
      "Salida tostada: 10.2 kg — merma 1.5%.",
      [], [], { api_calls: 1 }, coreFixture(),
    );
    expect(assertions.find((item) => item.message.startsWith("reported roast loss"))?.pass).toBe(false);
  });

  it("rejects unsupported optional fields and checks the terminal state", () => {
    const assertions = gradeTurn(
      {
        toolCallOmits: [{ name: "create_purchase", fields: ["notes", "purchased_at"] }],
        terminalReason: "needs_confirmation",
      },
      "Confirm this proposal.",
      [{ name: "mcp__cafe_os__create_purchase", arguments: { received_weight_kg: 20, notes: "invented" } }],
      [],
      { api_calls: 1 },
      coreFixture(),
      [{ event: "terminal", terminal_reason: "completed" }],
      "en",
    );

    expect(assertions.find((item) => item.message.startsWith("create_purchase omits"))?.pass).toBe(false);
    expect(assertions.find((item) => item.message === "terminal reason is needs_confirmation")?.pass).toBe(false);
  });
});
