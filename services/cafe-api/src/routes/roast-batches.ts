import { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  IdParams,
  IdParamsType,
  RoastBatchCreate,
  RoastBatchCreateSchema,
  RoastBatchListQuery,
  RoastBatchListQueryType,
  RoastBatchPatch,
  RoastBatchPatchSchema,
  RoastBatchVoid,
  RoastBatchVoidSchema,
} from "../schemas.js";
import { CafeStore, Row } from "../store.js";
import { ApiError, notFound } from "../errors.js";
import { hasOwn, normalizeDecimal, normalizeDisplayText, normalizeNotes } from "../validation/normalize.js";
import {
  listEnvelope,
  pagination,
  recordEnvelope,
  requireAvailableGreenCoffee,
  requireNonnegativeDecimal,
  requirePositiveDecimal,
  requireRow,
  roastCompletion,
  roastMetrics,
  weightedGreenUnitCost,
} from "./helpers.js";

export interface RoastBatchRoutesOptions {
  store: CafeStore;
}

type RoastBody = RoastBatchCreate | RoastBatchPatch;

function normalizeCheckpoints(checkpoints: NonNullable<RoastBody["checkpoints"]>) {
  return checkpoints.map((checkpoint) => ({
    elapsed_seconds: checkpoint.elapsed_seconds,
    ...(hasOwn(checkpoint, "temperature_c") ? {
      temperature_c: checkpoint.temperature_c === null
        ? null
        : normalizeDecimal(checkpoint.temperature_c, "checkpoints.temperature_c"),
    } : {}),
    ...(hasOwn(checkpoint, "airflow_setting") ? {
      airflow_setting: checkpoint.airflow_setting === null
        ? null
        : normalizeDecimal(checkpoint.airflow_setting, "checkpoints.airflow_setting"),
    } : {}),
    ...(hasOwn(checkpoint, "gas_setting") ? {
      gas_setting: checkpoint.gas_setting === null
        ? null
        : normalizeDecimal(checkpoint.gas_setting, "checkpoints.gas_setting"),
    } : {}),
    ...(hasOwn(checkpoint, "note") ? { note: normalizeNotes(checkpoint.note) } : {}),
  }));
}

function optionalPositiveDecimal(value: number | string | null, field: string): string | null {
  if (value === null) return null;
  return requirePositiveDecimal(normalizeDecimal(value, field), field);
}

function roastFields(body: RoastBody, patch: boolean): Row {
  const input: Row = {};
  const put = (field: keyof RoastBody, value: unknown) => {
    if (!patch || hasOwn(body, field)) input[field] = value;
  };

  put("name", normalizeDisplayText(body.name));
  put("roast_date", body.roast_date ?? null);
  put("roasted_at", body.roasted_at ?? null);
  put("green_input_kg", body.green_input_kg === undefined ? null : optionalPositiveDecimal(body.green_input_kg, "green_input_kg"));
  put("roasted_output_kg", body.roasted_output_kg === undefined ? null : optionalPositiveDecimal(body.roasted_output_kg, "roasted_output_kg"));
  put("duration_seconds", body.duration_seconds ?? null);
  put("machine_settings", body.machine_settings ?? null);
  put(
    "charge_temperature_c",
    body.charge_temperature_c === undefined || body.charge_temperature_c === null
      ? null
      : requireNonnegativeDecimal(
          normalizeDecimal(body.charge_temperature_c, "charge_temperature_c"),
          "charge_temperature_c",
        ),
  );
  put(
    "balance_point_temperature_c",
    body.balance_point_temperature_c === undefined || body.balance_point_temperature_c === null
      ? null
      : requireNonnegativeDecimal(
          normalizeDecimal(body.balance_point_temperature_c, "balance_point_temperature_c"),
          "balance_point_temperature_c",
        ),
  );
  put("setup_notes", normalizeNotes(body.setup_notes));
  put("checkpoints", body.checkpoints === undefined ? [] : normalizeCheckpoints(body.checkpoints));
  put("sensory_rating", body.sensory_rating ?? null);
  put("tasting_notes", normalizeNotes(body.tasting_notes));
  put("notes", normalizeNotes(body.notes));
  return input;
}

function assertWeightRelationship(greenInput: unknown, roastedOutput: unknown): void {
  if (
    greenInput !== null && greenInput !== undefined &&
    roastedOutput !== null && roastedOutput !== undefined &&
    Number(roastedOutput) > Number(greenInput)
  ) {
    throw new ApiError(422, "VALIDATION_ERROR", "roasted_output_kg cannot exceed green_input_kg.", {
      field: "roasted_output_kg",
    });
  }
}

function withCompletion(row: Row): Row {
  return { ...row, completion: roastCompletion(row) };
}

export const roastBatchRoutes: FastifyPluginAsyncTypebox<RoastBatchRoutesOptions> = async (
  app,
  { store },
) => {
  app.get<{ Querystring: RoastBatchListQueryType }>(
    "/roast-batches",
    { schema: { tags: ["Roast batches"], querystring: RoastBatchListQuery } },
    async (request) => {
      const { limit, offset } = pagination(request.query);
      const rows = await store.list(
        "roast_batches",
        { green_coffee_lot_id: request.query.green_coffee_lot_id },
        limit,
        offset,
        request.query.name ? { field: "name", query: request.query.name.trim() } : undefined,
      );
      return listEnvelope(rows.map(withCompletion), limit, offset, {
        green_coffee_lot_id: request.query.green_coffee_lot_id,
        name: request.query.name?.trim(),
      });
    },
  );

  app.get<{ Params: IdParamsType }>(
    "/roast-batches/:id",
    { schema: { tags: ["Roast batches"], params: IdParams } },
    async (request) => {
      const roast = await requireRow(store, "roast_batches", "roast batch", request.params.id);
      await requireRow(store, "green_coffee_lots", "green coffee lot", String(roast.green_coffee_lot_id));
      const purchases = await store.list("purchases", { green_coffee_lot_id: roast.green_coffee_lot_id }, 1000, 0);
      return recordEnvelope({
        ...withCompletion(roast),
        metrics: roastMetrics(roast, weightedGreenUnitCost(purchases)),
      });
    },
  );

  app.post<{ Body: RoastBatchCreate }>(
    "/roast-batches",
    { schema: { tags: ["Roast batches"], body: RoastBatchCreateSchema } },
    async (request, reply) => {
      await requireRow(store, "green_coffee_lots", "green coffee lot", request.body.green_coffee_lot_id);
      const input: Row = {
        green_coffee_lot_id: request.body.green_coffee_lot_id,
        ...roastFields(request.body, false),
      };
      assertWeightRelationship(input.green_input_kg, input.roasted_output_kg);
      if (input.green_input_kg !== null) {
        await requireAvailableGreenCoffee(store, request.body.green_coffee_lot_id, String(input.green_input_kg));
      }
      const row = await store.create("roast_batches", input);
      return reply.code(201).send(recordEnvelope(withCompletion(row)));
    },
  );

  app.patch<{ Params: IdParamsType; Body: RoastBatchPatch }>(
    "/roast-batches/:id",
    { schema: { tags: ["Roast batches"], params: IdParams, body: RoastBatchPatchSchema } },
    async (request) => {
      const existing = await requireRow(store, "roast_batches", "roast batch", request.params.id);
      if (existing.voided_at) {
        throw new ApiError(409, "VOIDED_RECORD", "A voided roast batch cannot be updated.");
      }
      if (request.body.green_coffee_lot_id !== undefined) {
        await requireRow(store, "green_coffee_lots", "green coffee lot", request.body.green_coffee_lot_id);
      }
      const input = roastFields(request.body, true);
      if (request.body.green_coffee_lot_id !== undefined) input.green_coffee_lot_id = request.body.green_coffee_lot_id;
      const effectiveLotId = String(input.green_coffee_lot_id ?? existing.green_coffee_lot_id);
      const effectiveGreenInput = hasOwn(input, "green_input_kg") ? input.green_input_kg : existing.green_input_kg;
      const effectiveOutput = hasOwn(input, "roasted_output_kg") ? input.roasted_output_kg : existing.roasted_output_kg;
      assertWeightRelationship(effectiveGreenInput, effectiveOutput);
      if (effectiveGreenInput !== null && effectiveGreenInput !== undefined) {
        await requireAvailableGreenCoffee(store, effectiveLotId, String(effectiveGreenInput), request.params.id);
      }
      const row = await store.patch("roast_batches", request.params.id, input);
      if (!row) throw notFound("roast batch", request.params.id);
      return recordEnvelope(withCompletion(row));
    },
  );

  app.post<{ Params: IdParamsType; Body: RoastBatchVoid }>(
    "/roast-batches/:id/void",
    { schema: { tags: ["Roast batches"], params: IdParams, body: RoastBatchVoidSchema } },
    async (request) => {
      const existing = await requireRow(store, "roast_batches", "roast batch", request.params.id);
      if (existing.voided_at) return recordEnvelope(withCompletion(existing));
      const row = await store.patch("roast_batches", request.params.id, {
        voided_at: new Date().toISOString(),
        void_reason: normalizeNotes(request.body.reason),
      });
      if (!row) throw notFound("roast batch", request.params.id);
      return recordEnvelope(withCompletion(row));
    },
  );

  app.delete<{ Params: IdParamsType }>(
    "/roast-batches/:id",
    { schema: { tags: ["Roast batches"], params: IdParams } },
    async (request, reply) => {
      await requireRow(store, "roast_batches", "roast batch", request.params.id);
      await store.delete("roast_batches", request.params.id);
      return reply.code(204).send();
    },
  );
};
