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

export function listEnvelope(data: Row[], limit: number, offset: number) {
  return { data, meta: { limit, offset, count: data.length } };
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

export function roastMetrics(roast: Row, lot: Row): Record<string, string | null> {
  const green = Number(roast.green_input_kg);
  const output = Number(roast.roasted_output_kg);
  const unitCost = Number(lot.unit_cost_per_kg);
  if (![green, output, unitCost].every(Number.isFinite) || green <= 0 || output <= 0) {
    return { roast_loss_pct: null, base_roasted_cost_per_kg: null };
  }
  return {
    roast_loss_pct: (((green - output) / green) * 100).toFixed(2),
    base_roasted_cost_per_kg: ((green * unitCost) / output).toFixed(2),
  };
}
