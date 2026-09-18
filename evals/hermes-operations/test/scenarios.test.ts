import { describe, expect, it } from "vitest";
import { scenarios } from "../src/scenarios.ts";
import { partialRequestScenarios } from "../src/partial-request-scenarios.ts";

const cafeTools = [
  "query_records",
  "create_provider",
  "create_purchase",
  "create_green_coffee_lot",
  "create_roast_batch",
  "update_record",
  "void_roast_batch",
  "delete_record",
  "upload_purchase_document",
];

describe("scenario catalog", () => {
  it("triples the catalog to 18 uniquely named scenarios with balanced locales", () => {
    expect(scenarios).toHaveLength(18);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(18);
    expect(scenarios.filter((scenario) => scenario.locale === "es-MX")).toHaveLength(9);
    expect(scenarios.filter((scenario) => scenario.locale === "en")).toHaveLength(9);
  });

  it("positively exercises every Cafe OS MCP tool", () => {
    const required = new Set(scenarios.flatMap((scenario) => scenario.turns.flatMap((turn) => turn.expect.requiredTools ?? [])));
    expect([...required].sort()).toEqual([...cafeTools].sort());
  });

  it("keeps every turn within the configured 20-hop ceiling", () => {
    for (const scenario of [...scenarios, ...partialRequestScenarios]) {
      for (const turn of scenario.turns) expect(turn.expect.maxApiCalls).toBeLessThanOrEqual(20);
    }
  });

  it("covers incomplete requests, required follow-ups, and optional omissions", () => {
    expect(partialRequestScenarios).toHaveLength(8);
    expect(new Set(partialRequestScenarios.map((scenario) => scenario.id)).size).toBe(8);
    expect(partialRequestScenarios.flatMap((scenario) => scenario.turns)).toHaveLength(21);
    expect(partialRequestScenarios.some((scenario) => scenario.id.includes("voice_note"))).toBe(true);
    const turns = partialRequestScenarios.flatMap((scenario) => scenario.turns);
    expect(turns.some((turn) => (turn.expect.routerRequiresUserInput?.length ?? 0) > 0)).toBe(true);
    expect(turns.some((turn) => (turn.expect.toolCallOmits?.length ?? 0) > 0)).toBe(true);
  });
});
