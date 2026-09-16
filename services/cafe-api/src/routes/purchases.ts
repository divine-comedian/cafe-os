import path from "node:path";
import { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  IdParams,
  IdParamsType,
  PurchaseCreate,
  PurchaseCreateSchema,
  PurchaseListQuery,
  PurchaseListQueryType,
  PurchaseWithGreenCoffeeLotCreate,
  PurchaseWithGreenCoffeeLotCreateSchema,
  PurchasePatch,
  PurchasePatchSchema,
} from "../schemas.js";
import { ApiError, dependencyConflict, notFound } from "../errors.js";
import { CafeStore, Row } from "../store.js";
import {
  hasOwn,
  normalizeCurrency,
  normalizeDecimal,
  normalizeDisplayText,
  normalizeLabel,
  normalizeNotes,
} from "../validation/normalize.js";
import { detectMimeType, purchaseDocumentPath } from "../validation/uploads.js";
import {
  listEnvelope,
  pagination,
  recordEnvelope,
  requireNonnegativeDecimal,
  requirePositiveDecimal,
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
        {
          provider_id: request.query.provider_id,
          green_coffee_lot_id: request.query.green_coffee_lot_id,
          status: request.query.status,
        },
        limit,
        offset,
      );
      return listEnvelope(rows, limit, offset);
    },
  );

  app.post<{ Body: PurchaseWithGreenCoffeeLotCreate }>(
    "/purchases/with-green-coffee-lot",
    {
      schema: {
        tags: ["Purchases", "Green coffee"],
        body: PurchaseWithGreenCoffeeLotCreateSchema,
      },
    },
    async (request, reply) => {
      await requireRow(store, "providers", "provider", request.body.provider_id);
      const amount = requireNonnegativeDecimal(
        normalizeDecimal(request.body.total_amount, "total_amount"),
        "total_amount",
      );
      const receivedWeight = requirePositiveDecimal(
        normalizeDecimal(request.body.received_weight_kg, "received_weight_kg"),
        "received_weight_kg",
      );
      const hasExistingLot = request.body.green_coffee_lot_id !== undefined;
      const hasNewLot = request.body.new_green_coffee_lot !== undefined;
      if (hasExistingLot === hasNewLot) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Provide exactly one of green_coffee_lot_id or new_green_coffee_lot.",
        );
      }
      let greenCoffeeLot: Row;
      let createdLotId: string | null = null;
      if (request.body.green_coffee_lot_id) {
        greenCoffeeLot = await requireRow(
          store,
          "green_coffee_lots",
          "green coffee lot",
          request.body.green_coffee_lot_id,
        );
      } else {
        const newLot = request.body.new_green_coffee_lot!;
        const name = normalizeDisplayText(newLot.name);
        const variety = normalizeLabel(newLot.variety);
        if (!name || !variety) {
          const field = !name ? "new_green_coffee_lot.name" : "new_green_coffee_lot.variety";
          throw new ApiError(422, "VALIDATION_ERROR", `${field} is required.`, { field });
        }
        greenCoffeeLot = await store.create("green_coffee_lots", {
          name,
          origin: normalizeLabel(newLot.origin),
          variety,
          notes: normalizeNotes(newLot.notes),
        });
        createdLotId = String(greenCoffeeLot.id);
      }
      try {
        const purchase = await store.create("purchases", {
          provider_id: request.body.provider_id,
          green_coffee_lot_id: greenCoffeeLot.id,
          ...(hasOwn(request.body, "purchased_at")
            ? { purchased_at: request.body.purchased_at }
            : {}),
          received_weight_kg: receivedWeight,
          total_amount: amount,
          currency: normalizeCurrency(request.body.currency ?? "MXN"),
          payment_method: normalizeLabel(request.body.payment_method),
          notes: normalizeNotes(request.body.notes),
        });
        return reply
          .code(201)
          .send(recordEnvelope({ purchase, green_coffee_lot: greenCoffeeLot }));
      } catch (error) {
        if (createdLotId) {
          const rolledBack = await store.delete("green_coffee_lots", createdLotId).catch(
            () => false,
          );
          if (!rolledBack) {
            request.log.error(
              { greenCoffeeLotId: createdLotId },
              "Could not roll back lot after purchase creation failed",
            );
          }
        }
        throw error;
      }
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
      await requireRow(
        store,
        "green_coffee_lots",
        "green coffee lot",
        request.body.green_coffee_lot_id,
      );
      const amount = normalizeDecimal(request.body.total_amount, "total_amount");
      const input: Row = {
        provider_id: request.body.provider_id,
        green_coffee_lot_id: request.body.green_coffee_lot_id,
        ...(hasOwn(request.body, "purchased_at")
          ? { purchased_at: request.body.purchased_at }
          : {}),
        received_weight_kg: requirePositiveDecimal(
          normalizeDecimal(request.body.received_weight_kg, "received_weight_kg"),
          "received_weight_kg",
        ),
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
      if (request.body.green_coffee_lot_id !== undefined) {
        await requireRow(
          store,
          "green_coffee_lots",
          "green coffee lot",
          request.body.green_coffee_lot_id,
        );
        input.green_coffee_lot_id = request.body.green_coffee_lot_id;
      }
      if (hasOwn(request.body, "purchased_at")) input.purchased_at = request.body.purchased_at;
      if (request.body.received_weight_kg !== undefined) {
        input.received_weight_kg = requirePositiveDecimal(
          normalizeDecimal(request.body.received_weight_kg, "received_weight_kg"),
          "received_weight_kg",
        );
      }
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
      const dependencies: Record<string, number> = {};
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
