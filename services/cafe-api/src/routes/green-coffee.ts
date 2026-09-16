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
import { ApiError, dependencyConflict, notFound } from "../errors.js";
import {
  hasOwn,
  normalizeDisplayText,
  normalizeLabel,
  normalizeNotes,
} from "../validation/normalize.js";
import {
  listEnvelope,
  pagination,
  recordEnvelope,
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
      const rows = await store.list("green_coffee_lots", {}, limit, offset);
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
      const name = normalizeDisplayText(request.body.name);
      const variety = normalizeLabel(request.body.variety);
      if (!name) {
        throw new ApiError(422, "VALIDATION_ERROR", "name is required.", { field: "name" });
      }
      if (!variety) {
        throw new ApiError(422, "VALIDATION_ERROR", "variety is required.", {
          field: "variety",
        });
      }
      const input: Row = {
        name,
        origin: normalizeLabel(request.body.origin),
        variety,
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
      if (hasOwn(request.body, "name")) {
        input.name = normalizeDisplayText(request.body.name);
        if (!input.name) {
          throw new ApiError(422, "VALIDATION_ERROR", "name is required.", { field: "name" });
        }
      }
      if (hasOwn(request.body, "origin")) input.origin = normalizeLabel(request.body.origin);
      if (hasOwn(request.body, "variety")) {
        input.variety = normalizeLabel(request.body.variety);
        if (!input.variety) {
          throw new ApiError(422, "VALIDATION_ERROR", "variety is required.", {
            field: "variety",
          });
        }
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
      const purchases = await store.count("purchases", {
        green_coffee_lot_id: request.params.id,
      });
      const dependencies: Record<string, number> = {};
      if (purchases) dependencies.purchases = purchases;
      if (roasts) dependencies.roast_batches = roasts;
      if (Object.keys(dependencies).length) {
        throw dependencyConflict("green coffee lot", dependencies);
      }
      await store.delete("green_coffee_lots", request.params.id);
      return reply.code(204).send();
    },
  );
};
