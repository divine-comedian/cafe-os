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
} from "../schemas.js";
import { CafeStore, Row } from "../store.js";
import { notFound } from "../errors.js";
import {
  hasOwn,
  normalizeDecimal,
  normalizeDisplayText,
  normalizeNotes,
} from "../validation/normalize.js";
import {
  listEnvelope,
  pagination,
  recordEnvelope,
  requirePositiveDecimal,
  requireRow,
  roastMetrics,
  weightedGreenUnitCost,
} from "./helpers.js";

export interface RoastBatchRoutesOptions {
  store: CafeStore;
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
        {
          green_coffee_lot_id: request.query.green_coffee_lot_id,
          status: request.query.status,
        },
        limit,
        offset,
        request.query.name ? { field: "name", query: request.query.name.trim() } : undefined,
      );
      return listEnvelope(rows, limit, offset, {
        green_coffee_lot_id: request.query.green_coffee_lot_id,
        status: request.query.status,
        name: request.query.name?.trim(),
      });
    },
  );

  app.get<{ Params: IdParamsType }>(
    "/roast-batches/:id",
    { schema: { tags: ["Roast batches"], params: IdParams } },
    async (request) => {
      const roast = await requireRow(store, "roast_batches", "roast batch", request.params.id);
      await requireRow(
        store,
        "green_coffee_lots",
        "green coffee lot",
        String(roast.green_coffee_lot_id),
      );
      const purchases = await store.list(
        "purchases",
        { green_coffee_lot_id: roast.green_coffee_lot_id },
        1000,
        0,
      );
      return recordEnvelope({
        ...roast,
        metrics: roastMetrics(roast, weightedGreenUnitCost(purchases)),
      });
    },
  );

  app.post<{ Body: RoastBatchCreate }>(
    "/roast-batches",
    { schema: { tags: ["Roast batches"], body: RoastBatchCreateSchema } },
    async (request, reply) => {
      await requireRow(
        store,
        "green_coffee_lots",
        "green coffee lot",
        request.body.green_coffee_lot_id,
      );
      const input: Row = {
        green_coffee_lot_id: request.body.green_coffee_lot_id,
        name: normalizeDisplayText(request.body.name),
        roasted_at: request.body.roasted_at ?? null,
        green_input_kg:
          request.body.green_input_kg === undefined || request.body.green_input_kg === null
            ? null
            : requirePositiveDecimal(
                normalizeDecimal(request.body.green_input_kg, "green_input_kg"),
                "green_input_kg",
              ),
        roasted_output_kg:
          request.body.roasted_output_kg === undefined ||
          request.body.roasted_output_kg === null
            ? null
            : requirePositiveDecimal(
                normalizeDecimal(request.body.roasted_output_kg, "roasted_output_kg"),
                "roasted_output_kg",
              ),
        duration_seconds: request.body.duration_seconds ?? null,
        machine_settings: request.body.machine_settings ?? null,
        notes: normalizeNotes(request.body.notes),
      };
      return reply.code(201).send(recordEnvelope(await store.create("roast_batches", input)));
    },
  );

  app.patch<{ Params: IdParamsType; Body: RoastBatchPatch }>(
    "/roast-batches/:id",
    {
      schema: {
        tags: ["Roast batches"],
        params: IdParams,
        body: RoastBatchPatchSchema,
      },
    },
    async (request) => {
      const input: Row = {};
      if (request.body.green_coffee_lot_id !== undefined) {
        await requireRow(
          store,
          "green_coffee_lots",
          "green coffee lot",
          request.body.green_coffee_lot_id,
        );
        input.green_coffee_lot_id = request.body.green_coffee_lot_id;
      }
      if (hasOwn(request.body, "name")) input.name = normalizeDisplayText(request.body.name);
      if (hasOwn(request.body, "roasted_at")) input.roasted_at = request.body.roasted_at;
      if (hasOwn(request.body, "green_input_kg")) {
        input.green_input_kg =
          request.body.green_input_kg === null
            ? null
            : requirePositiveDecimal(
                normalizeDecimal(request.body.green_input_kg, "green_input_kg"),
                "green_input_kg",
              );
      }
      if (hasOwn(request.body, "roasted_output_kg")) {
        input.roasted_output_kg =
          request.body.roasted_output_kg === null
            ? null
            : requirePositiveDecimal(
                normalizeDecimal(request.body.roasted_output_kg, "roasted_output_kg"),
                "roasted_output_kg",
              );
      }
      if (hasOwn(request.body, "duration_seconds")) {
        input.duration_seconds = request.body.duration_seconds;
      }
      if (hasOwn(request.body, "machine_settings")) {
        input.machine_settings = request.body.machine_settings;
      }
      if (hasOwn(request.body, "notes")) input.notes = normalizeNotes(request.body.notes);
      const row = await store.patch("roast_batches", request.params.id, input);
      if (!row) throw notFound("roast batch", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.post<{ Params: IdParamsType }>(
    "/roast-batches/:id/confirm",
    { schema: { tags: ["Roast batches"], params: IdParams } },
    async (request) => {
      const row = await store.patch("roast_batches", request.params.id, { status: "confirmed" });
      if (!row) throw notFound("roast batch", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.post<{ Params: IdParamsType }>(
    "/roast-batches/:id/void",
    { schema: { tags: ["Roast batches"], params: IdParams } },
    async (request) => {
      const row = await store.patch("roast_batches", request.params.id, { status: "void" });
      if (!row) throw notFound("roast batch", request.params.id);
      return recordEnvelope(row);
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
