import { describe, expect, it } from "vitest";
import { coreFixture } from "../src/fixtures.ts";
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
  it("keeps 22 uniquely named scenarios with balanced locales", () => {
    expect(scenarios).toHaveLength(22);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(22);
    expect(scenarios.filter((scenario) => scenario.locale === "es-MX")).toHaveLength(11);
    expect(scenarios.filter((scenario) => scenario.locale === "en")).toHaveLength(11);
  });

  it("positively exercises every Cafe OS MCP tool", () => {
    const required = new Set([...scenarios, ...partialRequestScenarios]
      .flatMap((scenario) => scenario.turns.flatMap((turn) => turn.expect.requiredTools ?? [])));
    expect([...required].sort()).toEqual([...cafeTools].sort());
  });

  it("models the current progressive roast table shape", () => {
    const roastFields = [
      "roast_date", "roasted_at", "green_input_kg", "roasted_output_kg", "duration_seconds",
      "machine_settings", "charge_temperature_c", "balance_point_temperature_c", "setup_notes", "checkpoints", "sensory_rating",
      "tasting_notes", "notes", "voided_at", "void_reason",
    ];
    for (const roast of coreFixture().roast_batches) {
      for (const field of roastFields) expect(roast).toHaveProperty(field);
      expect(Array.isArray(roast.checkpoints)).toBe(true);
    }
  });

  it("keeps every turn within the configured 20-hop ceiling", () => {
    for (const scenario of [...scenarios, ...partialRequestScenarios]) {
      for (const turn of scenario.turns) expect(turn.expect.maxApiCalls).toBeLessThanOrEqual(20);
    }
  });

  it("covers incomplete requests, required follow-ups, and optional omissions", () => {
    expect(partialRequestScenarios).toHaveLength(9);
    expect(new Set(partialRequestScenarios.map((scenario) => scenario.id)).size).toBe(9);
    expect(partialRequestScenarios.flatMap((scenario) => scenario.turns)).toHaveLength(24);
    expect(partialRequestScenarios.some((scenario) => scenario.id.includes("voice_note"))).toBe(true);
    const turns = partialRequestScenarios.flatMap((scenario) => scenario.turns);
    expect(turns.some((turn) => (turn.expect.routerRequiresUserInput?.length ?? 0) > 0)).toBe(true);
    expect(turns.some((turn) => (turn.expect.toolCallOmits?.length ?? 0) > 0)).toBe(true);
  });
});
