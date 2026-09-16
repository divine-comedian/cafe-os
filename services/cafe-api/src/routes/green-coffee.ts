import { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  GreenCoffeeCreate,
  GreenCoffeeCreateSchema,
  GreenCoffeeListQuery,
  GreenCoffeeListQueryType,
  GreenCoffeePatch,
  GreenCoffeePatchSchema,
  IdParams,
  IdParamsType,
} from "../schemas.js";
import { CafeStore, Row } from "../store.js";
import { dependencyConflict, notFound } from "../errors.js";
import {
  hasOwn,
  normalizeDecimal,
  normalizeDisplayText,
  normalizeLabel,
  normalizeNotes,
} from "../validation/normalize.js";
import {
  listEnvelope,
  pagination,
  recordEnvelope,
  requireNonnegativeDecimal,
  requirePositiveDecimal,
  requireRow,
} from "./helpers.js";

export interface GreenCoffeeRoutesOptions {
  store: CafeStore;
}

export const greenCoffeeRoutes: FastifyPluginAsyncTypebox<GreenCoffeeRoutesOptions> = async (
  app,
  { store },
) => {
  app.get<{ Querystring: GreenCoffeeListQueryType }>(
    "/green-coffee-lots",
    { schema: { tags: ["Green coffee"], querystring: GreenCoffeeListQuery } },
    async (request) => {
      const { limit, offset } = pagination(request.query);
      const rows = await store.list(
        "green_coffee_lots",
        { purchase_id: request.query.purchase_id },
        limit,
        offset,
      );
      return listEnvelope(rows, limit, offset);
    },
  );

  app.get<{ Params: IdParamsType }>(
    "/green-coffee-lots/:id",
    { schema: { tags: ["Green coffee"], params: IdParams } },
    async (request) =>
      recordEnvelope(
        await requireRow(store, "green_coffee_lots", "green coffee lot", request.params.id),
      ),
  );

  app.post<{ Body: GreenCoffeeCreate }>(
    "/green-coffee-lots",
    { schema: { tags: ["Green coffee"], body: GreenCoffeeCreateSchema } },
    async (request, reply) => {
      await requireRow(store, "purchases", "purchase", request.body.purchase_id);
      const weight = requirePositiveDecimal(
        normalizeDecimal(request.body.received_weight_kg, "received_weight_kg"),
        "received_weight_kg",
      );
      const unitCost = requireNonnegativeDecimal(
        normalizeDecimal(request.body.unit_cost_per_kg, "unit_cost_per_kg"),
        "unit_cost_per_kg",
      );
      const input: Row = {
        purchase_id: request.body.purchase_id,
        name: normalizeDisplayText(request.body.name),
        origin: normalizeLabel(request.body.origin),
        variety: normalizeLabel(request.body.variety),
        received_weight_kg: weight,
        unit_cost_per_kg: unitCost,
        notes: normalizeNotes(request.body.notes),
      };
      return reply
        .code(201)
        .send(recordEnvelope(await store.create("green_coffee_lots", input)));
    },
  );

  app.patch<{ Params: IdParamsType; Body: GreenCoffeePatch }>(
    "/green-coffee-lots/:id",
    {
      schema: {
        tags: ["Green coffee"],
        params: IdParams,
        body: GreenCoffeePatchSchema,
      },
    },
    async (request) => {
      const input: Row = {};
      if (request.body.purchase_id !== undefined) {
        await requireRow(store, "purchases", "purchase", request.body.purchase_id);
        input.purchase_id = request.body.purchase_id;
      }
      if (hasOwn(request.body, "name")) input.name = normalizeDisplayText(request.body.name);
      if (hasOwn(request.body, "origin")) input.origin = normalizeLabel(request.body.origin);
      if (hasOwn(request.body, "variety")) input.variety = normalizeLabel(request.body.variety);
      if (request.body.received_weight_kg !== undefined) {
        input.received_weight_kg = requirePositiveDecimal(
          normalizeDecimal(request.body.received_weight_kg, "received_weight_kg"),
          "received_weight_kg",
        );
      }
      if (request.body.unit_cost_per_kg !== undefined) {
        input.unit_cost_per_kg = requireNonnegativeDecimal(
          normalizeDecimal(request.body.unit_cost_per_kg, "unit_cost_per_kg"),
          "unit_cost_per_kg",
        );
      }
      if (hasOwn(request.body, "notes")) input.notes = normalizeNotes(request.body.notes);
      const row = await store.patch("green_coffee_lots", request.params.id, input);
      if (!row) throw notFound("green coffee lot", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.delete<{ Params: IdParamsType }>(
    "/green-coffee-lots/:id",
    { schema: { tags: ["Green coffee"], params: IdParams } },
    async (request, reply) => {
      await requireRow(store, "green_coffee_lots", "green coffee lot", request.params.id);
      const roasts = await store.count("roast_batches", {
        green_coffee_lot_id: request.params.id,
      });
      if (roasts) throw dependencyConflict("green coffee lot", { roast_batches: roasts });
      await store.delete("green_coffee_lots", request.params.id);
      return reply.code(204).send();
    },
  );
};
