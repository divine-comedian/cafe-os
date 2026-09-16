import { describe, expect, it } from "vitest";
import { scenarios } from "../src/scenarios.ts";

const cafeTools = [
  "query_records",
  "create_provider",
  "create_purchase",
  "create_green_coffee_lot",
  "create_roast_batch",
  "update_record",
  "set_record_status",
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
    for (const scenario of scenarios) {
      for (const turn of scenario.turns) expect(turn.expect.maxApiCalls).toBeLessThanOrEqual(20);
    }
  });
});
