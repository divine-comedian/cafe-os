export interface RoastMetrics {
  lossPct: number | null;
  yieldPct: number | null;
  roastedCostPerKg: number | null;
}

export function roastMetrics(
  greenInput: string | number | null,
  roastedOutput: string | number | null,
  greenUnitCost: string | number | null,
): RoastMetrics {
  const green = Number(greenInput);
  const output = Number(roastedOutput);
  if (
    !Number.isFinite(green) ||
    !Number.isFinite(output) ||
    green <= 0 ||
    output <= 0
  ) {
    return { lossPct: null, yieldPct: null, roastedCostPerKg: null };
  }
  const unitCost = greenUnitCost === null ? null : Number(greenUnitCost);

  return {
    lossPct: ((green - output) / green) * 100,
    yieldPct: (output / green) * 100,
    roastedCostPerKg:
      unitCost !== null && Number.isFinite(unitCost) ? (green * unitCost) / output : null,
  };
}

export function weightedGreenUnitCost(
  purchases: Array<{
    status: string;
    total_amount: string | number | null;
    received_weight_kg: string | number;
  }>,
): number | null {
  const totals = purchases.reduce(
    (result, purchase) => {
      if (purchase.status !== "confirmed") return result;
      if (purchase.total_amount === null || purchase.total_amount === undefined) return result;
      const amount = Number(purchase.total_amount);
      const purchasedWeight = Number(purchase.received_weight_kg);
      if (!Number.isFinite(amount) || !Number.isFinite(purchasedWeight) || amount < 0 || purchasedWeight <= 0) return result;
      return { amount: result.amount + amount, weight: result.weight + purchasedWeight };
    },
    { amount: 0, weight: 0 },
  );
  return totals.weight > 0 ? totals.amount / totals.weight : null;
}
