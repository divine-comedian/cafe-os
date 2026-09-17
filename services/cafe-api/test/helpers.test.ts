import { describe, expect, it } from "vitest";
import { roastMetrics, weightedGreenUnitCost } from "../src/routes/helpers.js";

describe("purchase-derived coffee costs", () => {
  it("uses every stored purchase in the weighted unit cost", () => {
    const cost = weightedGreenUnitCost([
      { total_amount: "1000.00", received_weight_kg: "10.000" },
      { total_amount: "3000.00", received_weight_kg: "20.000" },
    ]);

    expect(cost).toBeCloseTo(133.333333, 5);
    expect(
      roastMetrics({ green_input_kg: "10", roasted_output_kg: "8" }, cost),
    ).toEqual({ roast_loss_pct: "20.00", base_roasted_cost_per_kg: "166.67" });
  });

  it("does not infer a cost without a valid purchase", () => {
    expect(weightedGreenUnitCost([])).toBeNull();
    expect(
      roastMetrics({ green_input_kg: "10", roasted_output_kg: "8" }, null),
    ).toEqual({ roast_loss_pct: "20.00", base_roasted_cost_per_kg: null });
  });
});
