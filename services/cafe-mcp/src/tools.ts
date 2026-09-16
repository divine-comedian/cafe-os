import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { CafeApiError, CafeApiPort, JsonObject } from "./api-client.js";

const uuid = z.string().uuid().describe("UUID returned by Cafe OS");
const nullableText = z.string().nullable();
const decimal = z.union([z.number(), z.string()]);
const nullableDecimal = decimal.nullable();
const status = z.enum(["draft", "confirmed", "void"]);

const resourceRoutes = {
  provider: "/providers",
  purchase: "/purchases",
  green_coffee_lot: "/green-coffee-lots",
  roast_batch: "/roast-batches",
} as const;
type Resource = keyof typeof resourceRoutes;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function result(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent:
      payload && typeof payload === "object" ? (payload as JsonObject) : { result: payload },
  };
}

function errorResult(error: unknown) {
  const payload =
    error instanceof CafeApiError
      ? { ok: false, http_status: error.status, api_error: error.payload }
      : {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown Cafe OS tool error.",
        };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

async function safely(run: () => Promise<unknown>) {
  try {
    return result(await run());
  } catch (error) {
    return errorResult(error);
  }
}

function route(resource: Resource, id?: string): string {
  return `${resourceRoutes[resource]}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

export function registerCafeTools(server: McpServer, client: CafeApiPort): void {
  server.registerTool(
    "query_records",
    {
      title: "Cafe OS — Query records",
      description:
        "Read one Cafe OS record by UUID or list records. Supports only filters relevant to the selected resource. Never changes database state.",
      inputSchema: z.object({
        resource: z.enum(["provider", "purchase", "green_coffee_lot", "roast_batch"]),
        id: uuid.optional().describe("When present, return exactly this record"),
        provider_id: uuid.optional().describe("Purchase-list filter"),
        green_coffee_lot_id: uuid.optional().describe("Purchase or roast-batch list filter"),
        status: status.optional().describe("Purchase or roast-batch list filter"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: {
        title: "Cafe OS — Query records",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resource, id, limit, offset, ...filters }) =>
      safely(async () => {
        if (id) return client.request("GET", route(resource, id));
        const allowed: Record<Resource, string[]> = {
          provider: [],
          purchase: ["provider_id", "green_coffee_lot_id", "status"],
          green_coffee_lot: [],
          roast_batch: ["green_coffee_lot_id", "status"],
        };
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && allowed[resource].includes(key)) params.set(key, String(value));
        }
        return client.request("GET", `${route(resource)}?${params.toString()}`);
      }),
  );

  server.registerTool(
    "create_provider",
    {
      title: "Cafe OS — Create provider",
      description:
        "Create a coffee provider after the human confirms the proposed fields. Names stay display-cased; region is normalized by the API.",
      inputSchema: z.object({
        name: z.string().min(1),
        region: nullableText.optional(),
        notes: nullableText.optional(),
      }),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => client.request("POST", "/providers", input)),
  );

  server.registerTool(
    "create_purchase",
    {
      title: "Cafe OS — Create purchase draft",
      description:
        "Create an unconfirmed supplier purchase draft. Do not guess amounts, dates, currency, provider UUIDs, payment methods, or notes.",
      inputSchema: z.object({
        provider_id: uuid,
        green_coffee_lot_id: uuid,
        purchased_at: z.string().date().nullable().optional().describe("Calendar date in YYYY-MM-DD format when known"),
        received_weight_kg: decimal.describe("Purchased green-coffee weight in kilograms"),
        total_amount: nullableDecimal.optional(),
        currency: z.string().default("MXN").describe("ISO 4217 currency code"),
        payment_method: nullableText.optional(),
        notes: nullableText.optional(),
      }),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => client.request("POST", "/purchases", input)),
  );

  server.registerTool(
    "create_green_coffee_lot",
    {
      title: "Cafe OS — Create green-coffee lot",
      description:
        "Create a reusable green-coffee lot identity. Purchases carry the supplier, purchased weight, and amount and link back to this lot.",
      inputSchema: z.object({
        name: z.string().min(1),
        origin: nullableText.optional(),
        variety: z.string().min(1),
        notes: nullableText.optional(),
      }),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => client.request("POST", "/green-coffee-lots", input)),
  );

  server.registerTool(
    "create_roast_batch",
    {
      title: "Cafe OS — Create roast-batch draft",
      description:
        "Create an unconfirmed roast-batch draft linked to one green-coffee lot. Keep green input and roasted output weights distinct and in kilograms.",
      inputSchema: z.object({
        green_coffee_lot_id: uuid,
        name: nullableText.optional(),
        roasted_at: z.string().nullable().optional().describe("ISO 8601 date-time when known"),
        green_input_kg: nullableDecimal.optional(),
        roasted_output_kg: nullableDecimal.optional(),
        duration_seconds: z.number().int().min(0).nullable().optional(),
        machine_settings: z.record(z.string(), z.unknown()).nullable().optional(),
        notes: nullableText.optional(),
      }),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => client.request("POST", "/roast-batches", input)),
  );

  const updateInput = z.discriminatedUnion("resource", [
    z.object({
      resource: z.literal("provider"),
      id: uuid,
      fields: z
        .object({
          name: z.string().min(1).optional(),
          region: nullableText.optional(),
          notes: nullableText.optional(),
        })
        .refine((fields) => Object.keys(fields).length > 0, "At least one field is required"),
    }),
    z.object({
      resource: z.literal("purchase"),
      id: uuid,
      fields: z
        .object({
          provider_id: uuid.optional(),
          green_coffee_lot_id: uuid.optional(),
          purchased_at: z.string().date().nullable().optional(),
          received_weight_kg: decimal.optional(),
          total_amount: nullableDecimal.optional(),
          currency: z.string().optional(),
          payment_method: nullableText.optional(),
          notes: nullableText.optional(),
        })
        .refine((fields) => Object.keys(fields).length > 0, "At least one field is required"),
    }),
    z.object({
      resource: z.literal("green_coffee_lot"),
      id: uuid,
      fields: z
        .object({
          name: z.string().min(1).optional(),
          origin: nullableText.optional(),
          variety: z.string().min(1).optional(),
          notes: nullableText.optional(),
        })
        .refine((fields) => Object.keys(fields).length > 0, "At least one field is required"),
    }),
    z.object({
      resource: z.literal("roast_batch"),
      id: uuid,
      fields: z
        .object({
          green_coffee_lot_id: uuid.optional(),
          name: nullableText.optional(),
          roasted_at: z.string().nullable().optional(),
          green_input_kg: nullableDecimal.optional(),
          roasted_output_kg: nullableDecimal.optional(),
          duration_seconds: z.number().int().min(0).nullable().optional(),
          machine_settings: z.record(z.string(), z.unknown()).nullable().optional(),
          notes: nullableText.optional(),
        })
        .refine((fields) => Object.keys(fields).length > 0, "At least one field is required"),
    }),
  ]);

  server.registerTool(
    "update_record",
    {
      title: "Cafe OS — Update a record",
      description:
        "Patch fields on any existing Cafe OS record. Supply only fields the human confirmed; null explicitly clears a nullable field. Status changes use set_record_status instead.",
      inputSchema: updateInput,
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ resource, id, fields }) =>
      safely(() => client.request("PATCH", route(resource, id), fields)),
  );

  server.registerTool(
    "set_record_status",
    {
      title: "Cafe OS — Confirm or void a draft",
      description:
        "Confirm or void a purchase or roast batch only after explicit human approval. Confirmation marks extracted operational numbers as accepted.",
      inputSchema: z.object({
        resource: z.enum(["purchase", "roast_batch"]),
        id: uuid,
        status: z.enum(["confirmed", "void"]),
      }),
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ resource, id, status: nextStatus }) =>
      safely(() => client.request("POST", `${route(resource, id)}/${nextStatus}`)),
  );

  server.registerTool(
    "delete_record",
    {
      title: "Cafe OS — Delete a record",
      description:
        "Permanently delete one record after explicit human approval. The API refuses deletion when dependent records or a purchase document still exist.",
      inputSchema: z.object({
        resource: z.enum(["provider", "purchase", "green_coffee_lot", "roast_batch"]),
        id: uuid,
      }),
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ resource, id }) => safely(() => client.request("DELETE", route(resource, id))),
  );

  server.registerTool(
    "upload_purchase_document",
    {
      title: "Cafe OS — Upload purchase evidence",
      description:
        "Upload or replace a purchase receipt, invoice, screenshot, or PDF from an approved Hermes cache path. Existing purchase evidence is replaced.",
      inputSchema: z.object({
        purchase_id: uuid,
        file_path: z.string().min(1).describe("Absolute local path shown in the Hermes turn"),
      }),
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ purchase_id, file_path }) =>
      safely(() => client.uploadPurchaseDocument(purchase_id, file_path)),
  );
}
