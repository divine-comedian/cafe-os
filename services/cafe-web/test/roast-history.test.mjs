import assert from "node:assert/strict";
import { test } from "node:test";
import { curveExtent, curveSegments, filterRoasts, formatRoastTime, numericReading, roastDay, roastName } from "../src/roast-history.ts";

const lots = [{ id: "lot", name: "Café de prueba", origin: "México", variety: "Bourbon" }];
const batch = (overrides = {}) => ({
  id: "roast", green_coffee_lot_id: "lot", name: null, roast_date: "2026-10-08", roasted_at: null,
  duration_seconds: null, charge_temperature_c: null, balance_point_temperature_c: null,
  checkpoints: [], notes: null, tasting_notes: null, voided_at: null, completion: { is_complete: false },
  created_at: "2026-10-08T12:00:00Z", ...overrides,
});
const filters = { search: "", lotId: "", status: "all", from: "", to: "" };

test("missing readings remain missing; numeric zero is a measurement", () => {
  for (const value of [null, undefined, "", "  ", "unknown", NaN, Infinity]) assert.equal(numericReading(value), null);
  assert.equal(numericReading("0.000"), 0);
  assert.equal(numericReading("182.5"), 182.5);
});

test("curves sort checkpoints without changing stored data, and break at missing readings", () => {
  const roast = batch({ charge_temperature_c: "200", checkpoints: [
    { elapsed_seconds: 180, temperature_c: "150" }, { elapsed_seconds: 60, temperature_c: "100" },
    { elapsed_seconds: 120, gas_setting: "0" }, { elapsed_seconds: 240, temperature_c: "170" },
  ] });
  const original = JSON.stringify(roast);
  assert.deepEqual(curveSegments(roast, "temperature_c").map((segment) => segment.map((point) => [point.seconds, point.value])), [
    [[0, 200], [60, 100]], [[180, 150], [240, 170]],
  ]);
  assert.equal(JSON.stringify(roast), original);
  assert.deepEqual(curveSegments(roast, "gas_setting").map((segment) => segment.map((point) => [point.seconds, point.value])), [[[120, 0]]]);
});

test("balance temperature and duration never fabricate timed curve points", () => {
  const roast = batch({ balance_point_temperature_c: "90", duration_seconds: 650 });
  assert.deepEqual(curveSegments(roast, "temperature_c"), []);
  assert.equal(curveExtent([roast], "temperature_c").count, 0);
  assert.equal(curveExtent([roast], "temperature_c").end, 650);
});

test("a real checkpoint at time zero takes precedence over charge on the curve", () => {
  const roast = batch({ charge_temperature_c: "200", checkpoints: [{ elapsed_seconds: 0, temperature_c: "195" }] });
  assert.deepEqual(curveSegments(roast, "temperature_c").flat().map((point) => point.value), [195]);
});

test("single-point and zero-value curves have usable axes", () => {
  const roast = batch({ checkpoints: [{ elapsed_seconds: 720, gas_setting: "0" }] });
  const extent = curveExtent([roast], "gas_setting");
  assert.equal(extent.count, 1);
  assert.equal(extent.end, 720);
  assert.ok(extent.max > extent.min);
});

test("history filters combine lot, inclusive dates, state, and accent-insensitive search", () => {
  const roasts = [batch({ id: "match", name: "Sesión especial", completion: { is_complete: true } }),
    batch({ id: "void", voided_at: "2026-10-08T12:00:00Z", completion: { is_complete: true } }),
    batch({ id: "incomplete" }), batch({ id: "undated", roast_date: null }),
    batch({ id: "other", green_coffee_lot_id: "other" }), batch({ id: "earlier", roast_date: "2026-10-07" })];
  assert.deepEqual(filterRoasts(roasts, lots, { ...filters, search: "sesion", lotId: "lot", status: "complete", from: "2026-10-08", to: "2026-10-08" }).map((roast) => roast.id), ["match"]);
  assert.deepEqual(filterRoasts(roasts, lots, { ...filters, status: "void" }).map((roast) => roast.id), ["void"]);
  assert.ok(!filterRoasts(roasts, lots, { ...filters, status: "incomplete" }).some((roast) => roast.id === "void"));
});

test("history is newest-first and does not mutate input", () => {
  const roasts = [batch({ id: "old", roast_date: "2026-10-07" }), batch({ id: "new" })];
  assert.deepEqual(filterRoasts(roasts, lots, filters).map((roast) => roast.id), ["new", "old"]);
  assert.equal(roasts[0].id, "old");
});

test("business date wins; timestamp fallback uses Mexico City, not UTC", () => {
  assert.equal(roastDay(batch({ roast_date: null, roasted_at: "2026-10-08T02:00:00Z" })), "2026-10-07");
  assert.equal(roastDay(batch({ roasted_at: "2026-10-08T02:00:00Z" })), "2026-10-08");
  assert.equal(roastName(batch(), lots), "Tostado · Café de prueba");
});

test("elapsed formatting preserves seconds and hour-long roasts", () => {
  assert.equal(formatRoastTime(0), "00:00");
  assert.equal(formatRoastTime(659), "10:59");
  assert.equal(formatRoastTime(3600), "01:00:00");
  assert.equal(formatRoastTime(3661), "01:01:01");
});
