import { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  IdParams,
  IdParamsType,
  ProviderListQuery,
  ProviderListQueryType,
  ProviderCreate,
  ProviderCreateSchema,
  ProviderPatch,
  ProviderPatchSchema,
} from "../schemas.js";
import { CafeStore, Row } from "../store.js";
import { dependencyConflict, notFound } from "../errors.js";
import {
  normalizeLabel,
  normalizeNotes,
  requireDisplayText,
} from "../validation/normalize.js";
import { listEnvelope, pagination, recordEnvelope, requireRow } from "./helpers.js";

export interface ProviderRoutesOptions {
  store: CafeStore;
}

export const providerRoutes: FastifyPluginAsyncTypebox<ProviderRoutesOptions> = async (
  app,
  { store },
) => {
  app.get<{ Querystring: ProviderListQueryType }>(
    "/providers",
    { schema: { tags: ["Providers"], querystring: ProviderListQuery } },
    async (request) => {
      const { limit, offset } = pagination(request.query);
      const name = request.query.name?.trim();
      return listEnvelope(
        await store.list("providers", {}, limit, offset, name ? { field: "name", query: name } : undefined),
        limit,
        offset,
        { name },
      );
    },
  );

  app.get<{ Params: IdParamsType }>(
    "/providers/:id",
    { schema: { tags: ["Providers"], params: IdParams } },
    async (request) =>
      recordEnvelope(await requireRow(store, "providers", "provider", request.params.id)),
  );

  app.post<{ Body: ProviderCreate }>(
    "/providers",
    { schema: { tags: ["Providers"], body: ProviderCreateSchema } },
    async (request, reply) => {
      const input: Row = {
        name: requireDisplayText(request.body.name, "name"),
        region: normalizeLabel(request.body.region),
        notes: normalizeNotes(request.body.notes),
      };
      return reply.code(201).send(recordEnvelope(await store.create("providers", input)));
    },
  );

  app.patch<{ Params: IdParamsType; Body: ProviderPatch }>(
    "/providers/:id",
    {
      schema: { tags: ["Providers"], params: IdParams, body: ProviderPatchSchema },
    },
    async (request) => {
      const input: Row = {};
      if (request.body.name !== undefined) {
        input.name = requireDisplayText(request.body.name, "name");
      }
      if (request.body.region !== undefined) input.region = normalizeLabel(request.body.region);
      if (request.body.notes !== undefined) input.notes = normalizeNotes(request.body.notes);
      const row = await store.patch("providers", request.params.id, input);
      if (!row) throw notFound("provider", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.delete<{ Params: IdParamsType }>(
    "/providers/:id",
    { schema: { tags: ["Providers"], params: IdParams } },
    async (request, reply) => {
      await requireRow(store, "providers", "provider", request.params.id);
      const purchases = await store.count("purchases", { provider_id: request.params.id });
      if (purchases) throw dependencyConflict("provider", { purchases });
      await store.delete("providers", request.params.id);
      return reply.code(204).send();
    },
  );
};
