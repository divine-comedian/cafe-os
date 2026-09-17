import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { CafeApiError, CafeApiPort, JsonObject } from "./api-client.js";
import { discoverCafeTools } from "./tool-catalog.js";
import { PendingOperationStore } from "./pending-operations.js";

const uuid = z.string().uuid().describe("UUID returned by Cafe OS");
const nullableText = z.string().nullable();
const decimal = z.union([z.number(), z.string()]);
const nullableDecimal = decimal.nullable();
const status = z.enum(["draft", "confirmed", "void"]);

function exactProposalSchema<T extends z.ZodRawShape>(shape: T, requiredFields: string[]) {
  return z.object({ confirmation_id: uuid.optional(), ...shape }).strict().superRefine((value, context) => {
    const record = value as Record<string, unknown>;
    if (record.confirmation_id !== undefined) {
      if (Object.keys(value).length !== 1) {
        context.addIssue({ code: "custom", message: "confirmation_id must be supplied alone" });
      }
      return;
    }
    for (const field of requiredFields) {
      if (record[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `${field} is required for a proposal` });
      }
    }
  });
}

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

const MAX_TOOL_RESULT_CHARS = 24_000;

function result(payload: unknown) {
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized.length > MAX_TOOL_RESULT_CHARS) {
    return errorResult(new Error("TOOL_RESULT_LIMIT: narrow the query or reduce the requested limit."));
  }
  return {
    content: [{ type: "text" as const, text: serialized }],
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

function envelopeData(payload: unknown): unknown {
  return payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload;
}

function storedReceipt(payload: unknown, operation: string, resource: Resource | "purchase_document") {
  const data = envelopeData(payload);
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const statusValue = record.status;
  return {
    ok: true,
    operation_receipt: {
      operation,
      resource,
      id: record.id ?? (record.purchase && typeof record.purchase === "object"
        ? (record.purchase as Record<string, unknown>).id
        : undefined),
      ...(statusValue !== undefined ? { status: statusValue } : {}),
      authoritative: true,
    },
    data,
  };
}

function proposalResult(operation: Awaited<ReturnType<PendingOperationStore["prepare"]>>) {
  return {
    ok: true,
    pending_confirmation: {
      id: operation.id,
      tool_name: operation.toolName,
      canonical_arguments: operation.canonicalArguments,
      summary: operation.summary,
      expires_at: operation.expiresAt,
      instruction: "Show these exact fields to the human. After explicit approval, call the same tool with only confirmation_id.",
    },
  };
}

async function pendingMutation(
  pending: PendingOperationStore,
  toolName: string,
  input: Record<string, unknown>,
  execute: (stored: Record<string, unknown>) => Promise<unknown>,
) {
  if (typeof input.confirmation_id !== "string") {
    return proposalResult(await pending.prepare(toolName, input));
  }
  const operation = await pending.claim(input.confirmation_id, toolName);
  try {
    const receipt = await execute(operation.canonicalArguments);
    await pending.complete(operation, receipt);
    return receipt;
  } catch (error) {
    await pending.fail(operation).catch(() => undefined);
    throw error;
  }
}

function objectData(payload: unknown): Record<string, unknown> | null {
  const value = envelopeData(payload);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayData(payload: unknown): Record<string, unknown>[] {
  const value = envelopeData(payload);
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function payloadMeta(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    && "meta" in payload && payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
    ? payload.meta as Record<string, unknown>
    : {};
}

function normalizedName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/['’]s\b/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function nameSimilarity(query: string, candidate: string): number {
  const needle = normalizedName(query);
  const values = [normalizedName(candidate), ...normalizedName(candidate).split(" ")].filter(Boolean);
  if (!needle || !values.length) return 0;
  return Math.max(...values.map((value) =>
    1 - editDistance(needle, value) / Math.max(needle.length, value.length)));
}

function nameSuggestions(query: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows
    .flatMap((row) => {
      if (typeof row.name !== "string") return [];
      const similarity = nameSimilarity(query, row.name);
      if (similarity < 0.45) return [];
      return [{
        name: row.name,
        ...(typeof row.region === "string" ? { region: row.region } : {}),
        ...(typeof row.origin === "string" ? { origin: row.origin } : {}),
        similarity: Number(similarity.toFixed(2)),
      }];
    })
    .sort((left, right) => Number(right.similarity) - Number(left.similarity)
      || String(left.name).localeCompare(String(right.name)))
    .slice(0, 3);
}

async function withNameSuggestions(
  client: CafeApiPort,
  resource: "provider" | "green_coffee_lot" | "roast_batch",
  query: string,
  payload: unknown,
): Promise<unknown> {
  if (arrayData(payload).length) return payload;
  const all = await client.request("GET", `${route(resource)}?limit=100&offset=0`);
  const suggestions = nameSuggestions(query, arrayData(all));
  return {
    data: [],
    meta: {
      ...payloadMeta(payload),
      name_suggestions: suggestions,
      suggestion_count: suggestions.length,
      suggestion_instruction: suggestions.length
        ? "These are possible transcription or spelling matches, not resolved records. Ask the user to confirm the intended name, then query that exact name in the next turn before writing."
        : "No close display-name match was found.",
    },
  };
}

async function traceability(client: CafeApiPort, lotPayload: unknown): Promise<unknown> {
  const lots = Array.isArray(envelopeData(lotPayload))
    ? arrayData(lotPayload)
    : [objectData(lotPayload)].filter((row): row is Record<string, unknown> => row !== null);
  if (lots.length !== 1) return lotPayload;
  const lot = lots[0];
  const purchasesPayload = await client.request(
    "GET",
    `/purchases?limit=50&offset=0&green_coffee_lot_id=${encodeURIComponent(String(lot.id))}`,
  );
  const purchases = arrayData(purchasesPayload);
  const providerIds = [...new Set(purchases
    .map((purchase) => purchase.provider_id)
    .filter((id): id is string => typeof id === "string"))];
  const providers = await Promise.all(providerIds.map(async (id) =>
    objectData(await client.request("GET", `/providers/${encodeURIComponent(id)}`))));
  const roastsPayload = await client.request(
    "GET",
    `/roast-batches?limit=50&offset=0&green_coffee_lot_id=${encodeURIComponent(String(lot.id))}`,
  );
  return {
    data: {
      providers: providers.filter((provider): provider is Record<string, unknown> => provider !== null),
      purchases,
      green_coffee_lot: lot,
      roast_batches: arrayData(roastsPayload),
    },
    meta: { include: "traceability", match_count: 1 },
  };
}

export function registerCafeTools(
  server: McpServer,
  client: CafeApiPort,
  pending = new PendingOperationStore(),
): void {
  server.registerTool(
    "discover_tools",
    {
      title: "Cafe OS — Discover capabilities",
      description:
        "Search only the Cafe OS capability catalog when the currently active tools are insufficient. Returns names and descriptions; it never reads business records or changes state.",
      inputSchema: z.object({
        query: z.string().min(2).max(240),
        limit: z.number().int().min(1).max(5).default(5),
      }),
      annotations: {
        title: "Cafe OS — Discover capabilities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => result({
      tools: discoverCafeTools(query, limit)
        .filter((entry) => entry.name !== "discover_tools")
        .map(({ name, kind, description }) => ({ name, kind, description })),
      meta: { query, limit, catalog: "cafe_os", activates_for_current_request: true },
    }),
  );

  server.registerTool(
    "query_records",
    {
      title: "Cafe OS — Query records",
      description:
        "Read one Cafe OS record by UUID or search/list records. Before a write involving a named provider, list the complete provider catalog with resource=provider, limit=100, offset=0, and no name or id filter; compare all returned names and ask the operator to confirm any plausible non-exact match. For purchases named by an already exact provider, resource=purchase with provider_name plus optional purchased_at resolves it in one call. Purchase and green-coffee-lot records have no status. Other name searches return partial candidates and bounded near-name suggestions. Suggestions are never resolved automatically. Never choose when multiple plausible matches remain. For traceability, resolve a lot name once, then query its ID with include=traceability. Never changes database state.",
      inputSchema: z.object({
        resource: z.enum(["provider", "purchase", "green_coffee_lot", "roast_batch"]),
        id: uuid.optional().describe("When present, return exactly this record"),
        provider_id: uuid.optional().describe("Purchase-list filter"),
        provider_name: z.string().min(1).max(160).optional().describe("Purchase lookup: resolves one exact provider name inside this call"),
        purchased_at: z.string().date().optional().describe("Purchase-list calendar-date filter"),
        green_coffee_lot_id: uuid.optional().describe("Purchase or roast-batch list filter"),
        status: status.optional().describe("Roast-batch list filter only"),
        name: z.string().min(1).max(160).optional().describe("Case-insensitive partial display-name filter for providers, green-coffee lots, or roast batches"),
        include: z.literal("traceability").optional().describe("Only for one green-coffee lot; expands provider, purchase, lot, and roast batches"),
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
    async ({ resource, id, limit, offset, include, provider_name: providerName, ...filters }) =>
      safely(async () => {
        if (include && resource !== "green_coffee_lot") {
          throw new Error("VALIDATION_ERROR: include=traceability is only valid for green_coffee_lot.");
        }
        if (filters.status !== undefined && resource !== "roast_batch") {
          throw new Error("VALIDATION_ERROR: status is only valid for roast_batch queries.");
        }
        if (id) {
          const payload = await client.request("GET", route(resource, id));
          return include ? traceability(client, payload) : payload;
        }
        let resolvedProvider: Record<string, unknown> | null = null;
        if (providerName !== undefined) {
          if (resource !== "purchase") {
            throw new Error("VALIDATION_ERROR: provider_name is only valid for purchase queries.");
          }
          if (filters.provider_id !== undefined) {
            throw new Error("VALIDATION_ERROR: use provider_id or provider_name, not both.");
          }
          const initialProviderPayload = await client.request(
            "GET",
            `/providers?limit=50&offset=0&name=${encodeURIComponent(providerName)}`,
          );
          const providerPayload = await withNameSuggestions(
            client,
            "provider",
            providerName,
            initialProviderPayload,
          );
          const candidates = arrayData(providerPayload);
          const requested = providerName.trim().toLocaleLowerCase();
          const exact = candidates.filter((candidate) =>
            typeof candidate.name === "string" && candidate.name.trim().toLocaleLowerCase() === requested);
          const resolved = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
          if (!resolved || typeof resolved.id !== "string") {
            return {
              data: candidates,
              meta: {
                ...payloadMeta(providerPayload),
                relation_resolution: "provider",
                requested_purchase_filters: filters,
              },
            };
          }
          filters.provider_id = resolved.id;
          resolvedProvider = { id: resolved.id, name: resolved.name, region: resolved.region };
        }
        const allowed: Record<Resource, string[]> = {
          provider: ["name"],
          purchase: ["provider_id", "green_coffee_lot_id", "purchased_at"],
          green_coffee_lot: ["name"],
          roast_batch: ["green_coffee_lot_id", "status", "name"],
        };
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && allowed[resource].includes(key)) params.set(key, String(value));
        }
        const initialPayload = await client.request("GET", `${route(resource)}?${params.toString()}`);
        const payload = typeof filters.name === "string" && resource !== "purchase"
          ? await withNameSuggestions(client, resource, filters.name, initialPayload)
          : initialPayload;
        if (include) return traceability(client, payload);
        return resolvedProvider
          ? {
              data: arrayData(payload),
              meta: { ...payloadMeta(payload), resolved_provider: resolvedProvider },
            }
          : payload;
      }),
  );

  server.registerTool(
    "create_provider",
    {
      title: "Cafe OS — Create provider",
      description:
        "Prepare a provider proposal from validated fields without writing, but only after an unfiltered provider-catalog read shows no exact or plausibly similar existing provider. Preserve the full name. Ask the operator about a similar catalog entry instead of creating a near-duplicate. After approval, call this same tool with only confirmation_id to execute it once. Its stored receipt is authoritative; do not re-read.",
      inputSchema: exactProposalSchema({
        name: z.string().min(1).optional(),
        region: nullableText.optional(),
        notes: nullableText.optional(),
      }, ["name"]),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => pendingMutation(pending, "create_provider", input, async (stored) =>
      storedReceipt(await client.request("POST", "/providers", stored), "create", "provider"))),
  );

  server.registerTool(
    "create_purchase",
    {
      title: "Cafe OS — Create purchase",
      description:
        "Prepare an active purchase proposal without writing; never guess values. Purchase records have no status. After approval, call this same tool with only confirmation_id to execute the stored fields once. The receipt is authoritative; do not re-read.",
      inputSchema: exactProposalSchema({
        provider_id: uuid.optional(),
        green_coffee_lot_id: uuid.optional(),
        purchased_at: z.string().date().nullable().optional().describe("Calendar date in YYYY-MM-DD format when known"),
        received_weight_kg: decimal.optional().describe("Purchased green-coffee weight in kilograms"),
        total_amount: nullableDecimal.optional(),
        currency: z.string().optional().describe("ISO 4217 currency code; API default is MXN"),
        payment_method: nullableText.optional(),
        notes: nullableText.optional(),
      }, ["provider_id", "green_coffee_lot_id", "received_weight_kg"]),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => pendingMutation(pending, "create_purchase", input, async (stored) =>
      storedReceipt(await client.request("POST", "/purchases", stored), "create", "purchase"))),
  );

  server.registerTool(
    "create_green_coffee_lot",
    {
      title: "Cafe OS — Create green-coffee lot",
      description:
        "Prepare a reusable green-coffee-lot proposal without writing. Preserve the exact name; origin, variety, and notes are optional and must never be inferred. Purchases carry supplier, weight, and amount. After approval, call this same tool with only confirmation_id; its receipt is authoritative.",
      inputSchema: exactProposalSchema({
        name: z.string().min(1).optional(),
        origin: nullableText.optional(),
        variety: z.string().trim().min(1).optional().describe("Optional known variety; omit when unknown"),
        notes: nullableText.optional(),
      }, ["name"]),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => pendingMutation(pending, "create_green_coffee_lot", input, async (stored) =>
      storedReceipt(await client.request("POST", "/green-coffee-lots", stored), "create", "green_coffee_lot"))),
  );

  server.registerTool(
    "create_roast_batch",
    {
      title: "Cafe OS — Create roast-batch draft",
      description:
        "Prepare a roast-draft proposal without writing. Preserve the exact name and distinct weights. After approval, call this same tool with only confirmation_id; its receipt is authoritative.",
      inputSchema: exactProposalSchema({
        green_coffee_lot_id: uuid.optional(),
        name: nullableText.optional(),
        roasted_at: z.string().nullable().optional().describe("ISO 8601 date-time when known"),
        green_input_kg: nullableDecimal.optional(),
        roasted_output_kg: nullableDecimal.optional(),
        duration_seconds: z.number().int().min(0).nullable().optional(),
        machine_settings: z.record(z.string(), z.unknown()).nullable().optional(),
        notes: nullableText.optional(),
      }, ["green_coffee_lot_id"]),
      annotations: writeAnnotations,
    },
    async (input) => safely(() => pendingMutation(pending, "create_roast_batch", input, async (stored) =>
      storedReceipt(await client.request("POST", "/roast-batches", stored), "create", "roast_batch"))),
  );

  const updateFields = z.object({
    provider_id: uuid.optional(),
    green_coffee_lot_id: uuid.optional(),
    name: nullableText.optional(),
    region: nullableText.optional(),
    purchased_at: z.string().date().nullable().optional(),
    total_amount: nullableDecimal.optional(),
    currency: z.string().optional(),
    payment_method: nullableText.optional(),
    origin: nullableText.optional(),
    variety: nullableText.optional(),
    received_weight_kg: decimal.optional(),
    roasted_at: z.string().nullable().optional(),
    green_input_kg: nullableDecimal.optional(),
    roasted_output_kg: nullableDecimal.optional(),
    duration_seconds: z.number().int().min(0).nullable().optional(),
    machine_settings: z.record(z.string(), z.unknown()).nullable().optional(),
    notes: nullableText.optional(),
  }).strict();
  const updateInput = exactProposalSchema({
    resource: z.enum(["provider", "purchase", "green_coffee_lot", "roast_batch"]).optional(),
    id: uuid.optional(),
    fields: updateFields.optional(),
  }, ["resource", "id", "fields"]).superRefine((value, context) => {
    if (value.confirmation_id !== undefined || !value.resource || !value.fields) return;
    const allowed: Record<Resource, Set<string>> = {
      provider: new Set(["name", "region", "notes"]),
      purchase: new Set(["provider_id", "green_coffee_lot_id", "purchased_at", "received_weight_kg", "total_amount", "currency", "payment_method", "notes"]),
      green_coffee_lot: new Set(["name", "origin", "variety", "notes"]),
      roast_batch: new Set(["green_coffee_lot_id", "name", "roasted_at", "green_input_kg", "roasted_output_kg", "duration_seconds", "machine_settings", "notes"]),
    };
    if (!Object.keys(value.fields).length) {
      context.addIssue({ code: "custom", path: ["fields"], message: "At least one field is required" });
    }
    for (const field of Object.keys(value.fields)) {
      if (!allowed[value.resource].has(field)) {
        context.addIssue({ code: "custom", path: ["fields", field], message: `${field} is not valid for ${value.resource}` });
      }
    }
  });

  server.registerTool(
    "update_record",
    {
      title: "Cafe OS — Update a record",
      description:
        "Prepare an exact record patch without writing; null explicitly clears a nullable field. After approval, call this same tool with only confirmation_id. Only roast batches have status; their status changes use set_record_status.",
      inputSchema: updateInput,
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (input) => safely(async () => {
      let target: Record<string, unknown> | null = null;
      if (typeof input.confirmation_id !== "string") {
        target = objectData(await client.request(
          "GET",
          route(input.resource as Resource, String(input.id)),
        ));
      }
      const response = await pendingMutation(pending, "update_record", input, async (stored) => {
        const resource = stored.resource as Resource;
        return storedReceipt(
          await client.request("PATCH", route(resource, String(stored.id)), stored.fields as JsonObject),
          "update",
          resource,
        );
      });
      if (target && response && typeof response === "object" && "pending_confirmation" in response) {
        const confirmation = (response as { pending_confirmation: Record<string, unknown> }).pending_confirmation;
        confirmation.display_target = {
          resource: input.resource,
          ...(typeof target.name === "string" ? { name: target.name } : {}),
          ...(typeof target.purchased_at === "string" ? { purchased_at: target.purchased_at } : {}),
          ...(typeof target.roasted_at === "string" ? { roasted_at: target.roasted_at } : {}),
        };
      }
      return response;
    }),
  );

  server.registerTool(
    "set_record_status",
    {
      title: "Cafe OS — Confirm or void a roast batch",
      description:
        "Prepare an exact roast-batch status change without writing. Purchases and green-coffee lots have no status. After separate explicit approval, call this same tool with only confirmation_id to execute once.",
      inputSchema: exactProposalSchema({
        resource: z.literal("roast_batch").optional(),
        id: uuid.optional(),
        status: z.enum(["confirmed", "void"]).optional(),
      }, ["resource", "id", "status"]),
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (input) => safely(() => pendingMutation(pending, "set_record_status", input, async (stored) => {
      const resource = stored.resource as "roast_batch";
      const nextStatus = String(stored.status);
      return storedReceipt(
        await client.request("POST", `${route(resource, String(stored.id))}/${nextStatus}`),
        nextStatus,
        resource,
      );
    })),
  );

  server.registerTool(
    "delete_record",
    {
      title: "Cafe OS — Delete a record",
      description:
        "Prepare deletion of one exact record without deleting it. After immediate explicit approval, call this same tool with only confirmation_id. Dependencies are never cascaded.",
      inputSchema: exactProposalSchema({
        resource: z.enum(["provider", "purchase", "green_coffee_lot", "roast_batch"]).optional(),
        id: uuid.optional(),
      }, ["resource", "id"]),
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) => safely(() => pendingMutation(pending, "delete_record", input, async (stored) => {
      const resource = stored.resource as Resource;
      const id = String(stored.id);
      await client.request("DELETE", route(resource, id));
      return {
        ok: true,
        operation_receipt: { operation: "delete", resource, id, authoritative: true },
      };
    })),
  );

  server.registerTool(
    "upload_purchase_document",
    {
      title: "Cafe OS — Upload purchase evidence",
      description:
        "Prepare an evidence upload without reading the file. After approval, call this same tool with only confirmation_id; the handler then validates root, existence, type, and size. Never preflight with terminal or file tools.",
      inputSchema: exactProposalSchema({
        purchase_id: uuid.optional(),
        file_path: z.string().min(1).optional().describe("Absolute local path shown in the Hermes turn"),
      }, ["purchase_id", "file_path"]),
      annotations: {
        ...writeAnnotations,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) => safely(() => pendingMutation(pending, "upload_purchase_document", input, async (stored) =>
      storedReceipt(
        await client.uploadPurchaseDocument(String(stored.purchase_id), String(stored.file_path)),
        "upload",
        "purchase_document",
      ))),
  );
}
