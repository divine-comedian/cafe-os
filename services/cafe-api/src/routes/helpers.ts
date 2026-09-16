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

async function listAll(
  store: CafeStore,
  table: TableName,
  filters: Record<string, unknown>,
): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = 0;
  while (true) {
    const page = await store.list(table, filters, 100, offset);
    rows.push(...page);
    if (page.length < 100) return rows;
    offset += 100;
  }
}

export async function greenCoffeeInventory(
  store: CafeStore,
  greenCoffeeLotId: string,
  excludeRoastId?: string,
): Promise<{ purchasedKg: number; reservedKg: number; availableKg: number }> {
  const [purchases, roasts] = await Promise.all([
    listAll(store, "purchases", { green_coffee_lot_id: greenCoffeeLotId }),
    listAll(store, "roast_batches", { green_coffee_lot_id: greenCoffeeLotId }),
  ]);
  const purchasedKg = purchases
    .filter((purchase) => purchase.status === "confirmed")
    .reduce((sum, purchase) => sum + Number(purchase.received_weight_kg || 0), 0);
  const reservedKg = roasts
    .filter((roast) => roast.status !== "void" && roast.id !== excludeRoastId)
    .reduce((sum, roast) => sum + Number(roast.green_input_kg || 0), 0);
  return {
    purchasedKg,
    reservedKg,
    availableKg: Math.max(0, purchasedKg - reservedKg),
  };
}

export async function requireAvailableGreenCoffee(
  store: CafeStore,
  greenCoffeeLotId: string,
  requestedKg: string,
  excludeRoastId?: string,
): Promise<void> {
  const inventory = await greenCoffeeInventory(store, greenCoffeeLotId, excludeRoastId);
  if (Number(requestedKg) > inventory.availableKg + 1e-9) {
    throw new ApiError(
      422,
      "INSUFFICIENT_GREEN_COFFEE",
      `Green input exceeds the ${inventory.availableKg.toFixed(3)} kg available for this lot.`,
      {
        field: "green_input_kg",
        requested_kg: Number(requestedKg),
        available_kg: inventory.availableKg,
      },
    );
  }
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
