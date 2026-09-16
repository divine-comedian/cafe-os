import path from "node:path";
import { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  IdParams,
  IdParamsType,
  PurchaseCreate,
  PurchaseCreateSchema,
  PurchaseListQuery,
  PurchaseListQueryType,
  PurchasePatch,
  PurchasePatchSchema,
} from "../schemas.js";
import { ApiError, dependencyConflict, notFound } from "../errors.js";
import { CafeStore, Row } from "../store.js";
import {
  hasOwn,
  normalizeCurrency,
  normalizeDecimal,
  normalizeLabel,
  normalizeNotes,
} from "../validation/normalize.js";
import { detectMimeType, purchaseDocumentPath } from "../validation/uploads.js";
import {
  listEnvelope,
  pagination,
  recordEnvelope,
  requireNonnegativeDecimal,
  requireRow,
} from "./helpers.js";

export interface PurchaseRoutesOptions {
  store: CafeStore;
  maxUploadBytes: number;
}

export const purchaseRoutes: FastifyPluginAsyncTypebox<PurchaseRoutesOptions> = async (
  app,
  { store, maxUploadBytes },
) => {
  app.get<{ Querystring: PurchaseListQueryType }>(
    "/purchases",
    { schema: { tags: ["Purchases"], querystring: PurchaseListQuery } },
    async (request) => {
      const { limit, offset } = pagination(request.query);
      const rows = await store.list(
        "purchases",
        { provider_id: request.query.provider_id, status: request.query.status },
        limit,
        offset,
      );
      return listEnvelope(rows, limit, offset);
    },
  );

  app.get<{ Params: IdParamsType }>(
    "/purchases/:id",
    { schema: { tags: ["Purchases"], params: IdParams } },
    async (request) =>
      recordEnvelope(await requireRow(store, "purchases", "purchase", request.params.id)),
  );

  app.post<{ Body: PurchaseCreate }>(
    "/purchases",
    { schema: { tags: ["Purchases"], body: PurchaseCreateSchema } },
    async (request, reply) => {
      await requireRow(store, "providers", "provider", request.body.provider_id);
      const amount = normalizeDecimal(request.body.total_amount, "total_amount");
      const input: Row = {
        provider_id: request.body.provider_id,
        purchased_at: request.body.purchased_at,
        total_amount:
          amount === null ? null : requireNonnegativeDecimal(amount, "total_amount"),
        currency: normalizeCurrency(request.body.currency ?? "MXN"),
        payment_method: normalizeLabel(request.body.payment_method),
        notes: normalizeNotes(request.body.notes),
      };
      return reply.code(201).send(recordEnvelope(await store.create("purchases", input)));
    },
  );

  app.patch<{ Params: IdParamsType; Body: PurchasePatch }>(
    "/purchases/:id",
    {
      schema: { tags: ["Purchases"], params: IdParams, body: PurchasePatchSchema },
    },
    async (request) => {
      const input: Row = {};
      if (request.body.provider_id !== undefined) {
        await requireRow(store, "providers", "provider", request.body.provider_id);
        input.provider_id = request.body.provider_id;
      }
      if (request.body.purchased_at !== undefined) input.purchased_at = request.body.purchased_at;
      if (hasOwn(request.body, "total_amount")) {
        const amount = normalizeDecimal(request.body.total_amount, "total_amount");
        input.total_amount =
          amount === null ? null : requireNonnegativeDecimal(amount, "total_amount");
      }
      if (request.body.currency !== undefined) {
        input.currency = normalizeCurrency(request.body.currency);
      }
      if (hasOwn(request.body, "payment_method")) {
        input.payment_method = normalizeLabel(request.body.payment_method);
      }
      if (hasOwn(request.body, "notes")) input.notes = normalizeNotes(request.body.notes);
      const row = await store.patch("purchases", request.params.id, input);
      if (!row) throw notFound("purchase", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.post<{ Params: IdParamsType }>(
    "/purchases/:id/confirm",
    { schema: { tags: ["Purchases"], params: IdParams } },
    async (request) => {
      const row = await store.patch("purchases", request.params.id, { status: "confirmed" });
      if (!row) throw notFound("purchase", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.post<{ Params: IdParamsType }>(
    "/purchases/:id/void",
    { schema: { tags: ["Purchases"], params: IdParams } },
    async (request) => {
      const row = await store.patch("purchases", request.params.id, { status: "void" });
      if (!row) throw notFound("purchase", request.params.id);
      return recordEnvelope(row);
    },
  );

  app.delete<{ Params: IdParamsType }>(
    "/purchases/:id",
    { schema: { tags: ["Purchases"], params: IdParams } },
    async (request, reply) => {
      const purchase = await requireRow(store, "purchases", "purchase", request.params.id);
      const lots = await store.count("green_coffee_lots", { purchase_id: request.params.id });
      const dependencies: Record<string, number> = {};
      if (lots) dependencies.green_coffee_lots = lots;
      if (purchase.document_path) dependencies.document = 1;
      if (Object.keys(dependencies).length) {
        throw dependencyConflict("purchase", dependencies);
      }
      await store.delete("purchases", request.params.id);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: IdParamsType }>(
    "/purchases/:id/document",
    {
      bodyLimit: maxUploadBytes + 128 * 1024,
      schema: {
        tags: ["Purchase documents"],
        params: IdParams,
        consumes: ["multipart/form-data"],
      },
    },
    async (request) => {
      const purchase = await requireRow(store, "purchases", "purchase", request.params.id);
      const part = await request.file({ limits: { files: 1, fileSize: maxUploadBytes } });
      if (!part) {
        throw new ApiError(422, "VALIDATION_ERROR", "A document file is required.");
      }
      const content = await part.toBuffer();
      if (!content.length) {
        throw new ApiError(422, "VALIDATION_ERROR", "The uploaded file is empty.");
      }
      const mimeType = detectMimeType(content);
      const objectPath = purchaseDocumentPath(
        String(purchase.provider_id),
        request.params.id,
        part.filename,
        mimeType,
      );
      await store.uploadObject(objectPath, content, mimeType);
      let updated: Row | null;
      try {
        updated = await store.patch("purchases", request.params.id, {
          document_path: objectPath,
        });
      } catch (error) {
        await store.deleteObject(objectPath).catch(() => undefined);
        throw error;
      }
      const oldPath = purchase.document_path;
      if (typeof oldPath === "string" && oldPath !== objectPath) {
        await store.deleteObject(oldPath).catch((error: unknown) => {
          request.log.warn({ error, oldPath }, "Could not remove replaced document");
        });
      }
      return recordEnvelope({
        purchase: updated,
        document: { path: objectPath, mime_type: mimeType },
      });
    },
  );

  app.get<{ Params: IdParamsType }>(
    "/purchases/:id/document",
    { schema: { tags: ["Purchase documents"], params: IdParams } },
    async (request, reply) => {
      const purchase = await requireRow(store, "purchases", "purchase", request.params.id);
      if (typeof purchase.document_path !== "string") {
        throw notFound("purchase document", request.params.id);
      }
      const document = await store.downloadObject(purchase.document_path);
      reply.header(
        "Content-Disposition",
        `attachment; filename="${path.basename(purchase.document_path)}"`,
      );
      return reply.type(document.mimeType).send(document.content);
    },
  );

  app.delete<{ Params: IdParamsType }>(
    "/purchases/:id/document",
    { schema: { tags: ["Purchase documents"], params: IdParams } },
    async (request, reply) => {
      const purchase = await requireRow(store, "purchases", "purchase", request.params.id);
      if (typeof purchase.document_path === "string") {
        await store.deleteObject(purchase.document_path);
        await store.patch("purchases", request.params.id, { document_path: null });
      }
      return reply.code(204).send();
    },
  );
};
