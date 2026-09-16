import { ApiError, notFound } from "../errors.js";
import { CafeStore, Row, TableName } from "../store.js";

export async function requireRow(
  store: CafeStore,
  table: TableName,
  label: string,
  id: string,
): Promise<Row> {
  const row = await store.get(table, id);
  if (!row) throw notFound(label, id);
  return row;
}

export function pagination(query: { limit?: number; offset?: number }) {
  return { limit: query.limit ?? 50, offset: query.offset ?? 0 };
}

export function listEnvelope(
  data: Row[],
  limit: number,
  offset: number,
  appliedFilters: Record<string, unknown> = {},
) {
  const requestedName = typeof appliedFilters.name === "string"
    ? appliedFilters.name.trim().toLocaleLowerCase()
    : null;
  const exactMatches = requestedName
    ? data.filter((row) => typeof row.name === "string" && row.name.trim().toLocaleLowerCase() === requestedName)
    : [];
  return {
    data,
    meta: {
      limit,
      offset,
      count: data.length,
      match_count: data.length,
      ...(requestedName ? {
        exact_match_count: exactMatches.length,
        exact_match_ids: exactMatches
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string"),
      } : {}),
      applied_filters: Object.fromEntries(
        Object.entries(appliedFilters).filter(([, value]) => value !== undefined),
      ),
    },
  };
}

export function recordEnvelope(data: unknown) {
  return { data };
}

export function requirePositiveDecimal(value: string | null, field: string): string {
  if (value === null || Number(value) <= 0) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} must be greater than zero.`, {
      field,
    });
  }
  return value;
}

export function requireNonnegativeDecimal(value: string | null, field: string): string {
  if (value === null || Number(value) < 0) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} cannot be negative.`, {
      field,
    });
  }
  return value;
}

export function weightedGreenUnitCost(purchases: Row[]): number | null {
  const confirmed = purchases.filter((purchase) => purchase.status === "confirmed");
  const totals = confirmed.reduce<{ amount: number; weight: number }>(
    (result, purchase) => {
      if (purchase.total_amount === null || purchase.total_amount === undefined) return result;
      const amount = Number(purchase.total_amount);
      const weight = Number(purchase.received_weight_kg);
      if (!Number.isFinite(amount) || !Number.isFinite(weight) || amount < 0 || weight <= 0) {
        return result;
      }
      return { amount: result.amount + amount, weight: result.weight + weight };
    },
    { amount: 0, weight: 0 },
  );
  return totals.weight > 0 ? totals.amount / totals.weight : null;
}

export function roastMetrics(
  roast: Row,
  greenUnitCost: number | null,
): Record<string, string | null> {
  const green = Number(roast.green_input_kg);
  const output = Number(roast.roasted_output_kg);
  if (![green, output].every(Number.isFinite) || green <= 0 || output <= 0) {
    return { roast_loss_pct: null, base_roasted_cost_per_kg: null };
  }
  const unitCost = greenUnitCost === null ? null : Number(greenUnitCost);
  return {
    roast_loss_pct: (((green - output) / green) * 100).toFixed(2),
    base_roasted_cost_per_kg:
      unitCost !== null && Number.isFinite(unitCost)
        ? ((green * unitCost) / output).toFixed(2)
        : null,
  };
}
