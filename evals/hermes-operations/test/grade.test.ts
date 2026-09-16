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
});
