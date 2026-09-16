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
  const unitCost = Number(greenUnitCost);
  if (
    !Number.isFinite(green) ||
    !Number.isFinite(output) ||
    !Number.isFinite(unitCost) ||
    green <= 0 ||
    output <= 0
  ) {
    return { lossPct: null, yieldPct: null, roastedCostPerKg: null };
  }

  return {
    lossPct: ((green - output) / green) * 100,
    yieldPct: (output / green) * 100,
    roastedCostPerKg: (green * unitCost) / output,
  };
}

export function lotValue(
  weight: string | number | null,
  unitCost: string | number | null,
): number | null {
  const parsedWeight = Number(weight);
  const parsedCost = Number(unitCost);
  if (
    !Number.isFinite(parsedWeight) ||
    !Number.isFinite(parsedCost) ||
    parsedWeight <= 0 ||
    parsedCost < 0
  ) {
    return null;
  }
  return parsedWeight * parsedCost;
}
