import type { CoffeeLot, RoastBatch } from "./types";

export type CurveMetric = "temperature_c" | "airflow_setting" | "gas_setting";
export type HistoryStatus = "all" | "complete" | "incomplete" | "void";
export type CurvePoint = { seconds: number; value: number; source: "charge" | "checkpoint"; note?: string | null };

export function numericReading(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (value === null || value === undefined || value === "" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatRoastTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const parts = [Math.floor(seconds / 60), seconds % 60];
  if (seconds >= 3600) parts.splice(0, 1, Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60));
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

// The business date takes precedence; timestamps are interpreted in the operation's timezone.
export function roastDay(roast: RoastBatch): string {
  if (roast.roast_date) return roast.roast_date;
  if (!roast.roasted_at) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(roast.roasted_at));
}

export function roastName(roast: RoastBatch, lots: CoffeeLot[]) {
  return roast.name || `Tostado · ${lots.find((lot) => lot.id === roast.green_coffee_lot_id)?.name || "Sin lote"}`;
}

export function roastState(roast: RoastBatch) {
  return roast.voided_at ? "Anulado" : roast.completion?.is_complete ? "Completo" : "Faltan datos";
}

export function filterRoasts(roasts: RoastBatch[], lots: CoffeeLot[], filters: { search: string; lotId: string; status: HistoryStatus; from: string; to: string }) {
  const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
  const term = normalize(filters.search.trim());
  return roasts.filter((roast) => {
    const lot = lots.find((item) => item.id === roast.green_coffee_lot_id);
    const day = roastDay(roast);
    const matchesStatus = filters.status === "all" || (filters.status === "void" ? !!roast.voided_at : !roast.voided_at && (filters.status === "complete" ? !!roast.completion?.is_complete : !roast.completion?.is_complete));
    return matchesStatus && (!filters.lotId || filters.lotId === roast.green_coffee_lot_id)
      && (!filters.from || (!!day && day >= filters.from)) && (!filters.to || (!!day && day <= filters.to))
      && normalize([roast.name, lot?.name, lot?.origin, lot?.variety, roast.notes, roast.tasting_notes, roastState(roast)].filter(Boolean).join(" ")).includes(term);
  }).sort((a, b) => roastDay(b).localeCompare(roastDay(a)) || (b.roasted_at || b.created_at).localeCompare(a.roasted_at || a.created_at));
}

// Preserve missing readings as gaps. Charge has a known time (0); the balance point does not.
export function curveSegments(roast: RoastBatch, metric: CurveMetric): CurvePoint[][] {
  const points = [...(roast.checkpoints || [])]
    .filter((point) => Number.isFinite(point.elapsed_seconds) && point.elapsed_seconds >= 0)
    .sort((a, b) => a.elapsed_seconds - b.elapsed_seconds);
  const segments: CurvePoint[][] = [];
  let current: CurvePoint[] = [];
  const charge = numericReading(roast.charge_temperature_c);
  if (metric === "temperature_c" && charge !== null && !points.some((point) => point.elapsed_seconds === 0 && numericReading(point.temperature_c) !== null)) {
    current.push({ seconds: 0, value: charge, source: "charge", note: "Carga" });
  }
  for (const point of points) {
    const value = numericReading(point[metric]);
    if (value === null) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push({ seconds: point.elapsed_seconds, value, source: "checkpoint", note: point.note });
  }
  if (current.length) segments.push(current);
  return segments;
}

export function curveExtent(roasts: RoastBatch[], metric: CurveMetric) {
  const points = roasts.flatMap((roast) => curveSegments(roast, metric).flat());
  const end = Math.max(60, ...points.map((point) => point.seconds), ...roasts.map((roast) => roast.duration_seconds || 0));
  const values = points.map((point) => point.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const padding = Math.max(1, (max - min) * .12);
  return { end, min: min >= 0 ? Math.max(0, min - padding) : min - padding, max: max + padding, count: points.length };
}
