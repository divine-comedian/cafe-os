import { CAFE_TOOL_CATALOG, CafeToolName, isCafeToolName, shortCafeToolName } from "./tool-catalog.js";

export interface RouterMessage {
  role?: unknown;
  content?: unknown;
}

export interface RouterToolDefinition {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

export interface ToolRouterInput {
  messages: RouterMessage[];
  tools: RouterToolDefinition[];
  requestId?: string;
}

export interface ToolRouterConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxTokens: number;
  maxTools: number;
  confidenceFloor: number;
}

export interface ToolRouterResult {
  ok: boolean;
  intent: string;
  toolIds: CafeToolName[];
  confidence: number;
  model: string;
  durationMs: number;
  missingRequiredFields?: string[];
  requiresUserInput?: string[];
  lookupResource?: "provider" | "purchase" | "green_coffee_lot" | "roast_batch" | "unknown";
  fallbackReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

const ROUTER_FUNCTION_NAME = "select_cafe_tools";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numeric(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadToolRouterConfig(env: NodeJS.ProcessEnv = process.env): ToolRouterConfig {
  return {
    apiKey: env.OPENROUTER_API_KEY?.trim() ?? "",
    model: env.CAFE_TOOL_ROUTER_MODEL?.trim() || "deepseek/deepseek-v4.1-flash",
    baseUrl: (env.CAFE_TOOL_ROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    timeoutMs: positiveInteger(env.CAFE_TOOL_ROUTER_TIMEOUT_MS, 20_000),
    maxTokens: positiveInteger(env.CAFE_TOOL_ROUTER_MAX_TOKENS, 256),
    maxTools: Math.min(5, positiveInteger(env.CAFE_TOOL_ROUTER_MAX_TOOLS, 5)),
    confidenceFloor: Math.max(0, Math.min(1, numeric(env.CAFE_TOOL_ROUTER_CONFIDENCE_FLOOR, 0.55))),
  };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

export function sanitizeRoutingText(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "[record-id]")
    .replace(/(?:^|\s)(?:\/[\w.-]+){2,}/gu, " [attachment-path]")
    .replace(/\b(?:MXN|USD|EUR)\s*[\d.,]+\b/giu, "[currency-amount]")
    .replace(/\b\d+(?:[.,]\d+)?\b/gu, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
}

export function routingContext(messages: RouterMessage[]): string {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => sanitizeRoutingText(textContent(message.content)))
    .filter(Boolean)
    .slice(-2);
  return userMessages.map((message, index) => `User request ${index + 1}: ${message}`).join("\n");
}

function requiredParameterNames(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
  const required = (parameters as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function compactCatalog(tools: RouterToolDefinition[]) {
  const definitions = new Map(
    tools.flatMap((tool) => {
      const rawName = tool.function?.name;
      if (typeof rawName !== "string") return [];
      const name = shortCafeToolName(rawName);
      return isCafeToolName(name) ? [[name, tool] as const] : [];
    }),
  );
  return CAFE_TOOL_CATALOG
    .filter((entry) => definitions.has(entry.name))
    .map((entry) => {
      const definition = definitions.get(entry.name);
      return {
        id: entry.name,
        kind: entry.kind,
        description:
          typeof definition?.function?.description === "string"
            ? definition.function.description.slice(0, 280)
            : entry.description,
        required_parameters: requiredParameterNames(definition?.function?.parameters),
      };
    });
}

function selectionTool(allowedNames: CafeToolName[], maxTools: number) {
  return {
    type: "function",
    function: {
      name: ROUTER_FUNCTION_NAME,
      description: "Select the smallest sufficient Cafe OS tool set for the main operations agent. This does not execute any operation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: { type: "string", minLength: 1, maxLength: 80 },
          tool_ids: {
            type: "array",
            items: { type: "string", enum: allowedNames },
            minItems: 0,
            maxItems: maxTools,
            uniqueItems: true,
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          missing_required_fields: {
            type: "array",
            description:
              "Required facts explicitly absent from the request. Purchases require provider, green-coffee lot, and received weight; green-coffee lots require name and variety.",
            items: {
              type: "string",
              enum: ["name", "variety", "provider_id", "purchase_id", "green_coffee_lot_id", "received_weight_kg", "target_id", "file_path"],
            },
            maxItems: 6,
            uniqueItems: true,
          },
          requires_user_input: {
            type: "array",
            description:
              "Missing facts the user must supply because they cannot be resolved from a named stored record. Do not include an ID when the request names the record to look up.",
            items: {
              type: "string",
              enum: ["name", "variety", "provider_id", "purchase_id", "green_coffee_lot_id", "received_weight_kg", "target_id", "file_path"],
            },
            maxItems: 6,
            uniqueItems: true,
          },
          lookup_resource: {
            type: "string",
            description: "The record type query_records must resolve first, or unknown when no lookup is needed.",
            enum: ["provider", "purchase", "green_coffee_lot", "roast_batch", "unknown"],
          },
        },
        required: ["intent", "tool_ids", "confidence", "missing_required_fields", "requires_user_input", "lookup_resource"],
      },
    },
  };
}

function fallback(config: ToolRouterConfig, started: number, reason: string): ToolRouterResult {
  return {
    ok: false,
    intent: "fallback_discovery",
    toolIds: [],
    confidence: 0,
    model: config.model,
    durationMs: Date.now() - started,
    fallbackReason: reason,
  };
}

function parseSelection(
  response: OpenRouterResponse,
  allowed: Set<string>,
  config: ToolRouterConfig,
  started: number,
  context: string,
): ToolRouterResult {
  const call = response.choices?.[0]?.message?.tool_calls?.find(
    (candidate) => candidate.function?.name === ROUTER_FUNCTION_NAME,
  );
  if (!call?.function?.arguments) return fallback(config, started, "missing_router_tool_call");
  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments);
  } catch {
    return fallback(config, started, "malformed_router_arguments");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback(config, started, "invalid_router_arguments");
  }
  const record = value as Record<string, unknown>;
  const rawIds = Array.isArray(record.tool_ids) ? record.tool_ids : [];
  const missingRequiredFields = Array.isArray(record.missing_required_fields)
    ? [...new Set(record.missing_required_fields.filter((item): item is string => typeof item === "string"))]
    : [];
  const requiresUserInput = (Array.isArray(record.requires_user_input)
    ? [...new Set(record.requires_user_input.filter((item): item is string => typeof item === "string"))]
    : [])
    .filter((field) => !(field === "file_path" && context.includes("[attachment-path]")));
  const lookupResource = ["provider", "purchase", "green_coffee_lot", "roast_batch", "unknown"].includes(String(record.lookup_resource))
    ? record.lookup_resource as ToolRouterResult["lookupResource"]
    : "unknown";
  const requiredInputByTool: Partial<Record<CafeToolName, string[]>> = {
    create_provider: ["name"],
    create_purchase: ["provider_id", "green_coffee_lot_id", "received_weight_kg"],
    create_green_coffee_lot: ["name", "variety"],
    create_roast_batch: ["green_coffee_lot_id"],
    update_record: ["target_id"],
    set_record_status: ["target_id"],
    delete_record: ["target_id"],
    upload_purchase_document: ["purchase_id", "file_path"],
  };
  const toolIds = [...new Set(rawIds)]
    .filter((item): item is string => typeof item === "string" && allowed.has(item))
    .filter(isCafeToolName)
    .filter((item) => !(requiredInputByTool[item] ?? []).some((field) => requiresUserInput.includes(field)))
    .slice(0, config.maxTools);
  const confidence = typeof record.confidence === "number" ? record.confidence : 0;
  if (confidence < config.confidenceFloor) return fallback(config, started, "router_low_confidence");
  if (!toolIds.length && !requiresUserInput.length) return fallback(config, started, "no_valid_router_tools");
  return {
    ok: true,
    intent: typeof record.intent === "string" ? record.intent.slice(0, 80) : "cafe_operation",
    toolIds,
    confidence,
    model: config.model,
    durationMs: Date.now() - started,
    missingRequiredFields,
    requiresUserInput,
    lookupResource,
    usage: {
      inputTokens: Number(response.usage?.prompt_tokens ?? 0),
      outputTokens: Number(response.usage?.completion_tokens ?? 0),
      costUsd: typeof response.usage?.cost === "number" ? response.usage.cost : null,
    },
  };
}

export async function routeCafeTools(
  input: ToolRouterInput,
  config: ToolRouterConfig = loadToolRouterConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<ToolRouterResult> {
  const started = Date.now();
  if (!config.apiKey) return fallback(config, started, "missing_openrouter_key");
  const catalog = compactCatalog(input.tools);
  const allowedNames = catalog.map((entry) => entry.id);
  if (!allowedNames.length) return fallback(config, started, "empty_cafe_catalog");
  const context = routingContext(input.messages);
  if (!context) return fallback(config, started, "missing_user_request");
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(input.requestId ? { "X-Request-ID": input.requestId } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content:
              "You route Cafe OS operational requests. Select the smallest sufficient set of tool IDs. missing_required_fields lists absent API identifiers or facts. requires_user_input lists only facts the human must provide because they cannot be resolved from a named stored record; do not put an ID there when the user supplied a record name. lookup_resource is the record type query_records must resolve first. Include query_records whenever the request names an existing provider, purchase, green-coffee lot, or roast batch but does not supply its UUID. Include both query_records and the mutation tool for complete prepare, update, status, delete, and upload workflows that identify a stored record by name or date. Purchases require a provider, green-coffee lot, and received weight; their date, amount, currency, payment method, and notes are optional. Green-coffee lots require a name and variety; origin and notes are optional. Providers require a name. Roasts require a green-coffee lot. If a human-supplied required fact is missing, omit the mutation tool and return it in requires_user_input; use an empty tool_ids array when no lookup is useful. A confirmation following a stored proposal needs only its mutation tool. Never choose tools outside the supplied catalog.",
          },
          { role: "user", content: `${context}\n\nAllowed Cafe catalog:\n${JSON.stringify(catalog)}` },
        ],
        tools: [selectionTool(allowedNames, config.maxTools)],
        tool_choice: { type: "function", function: { name: ROUTER_FUNCTION_NAME } },
        temperature: 0,
        max_tokens: config.maxTokens,
        reasoning: { enabled: false, exclude: true },
        provider: { require_parameters: true, data_collection: "deny" },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return fallback(config, started, `router_http_${response.status}`);
    return parseSelection((await response.json()) as OpenRouterResponse, new Set(allowedNames), config, started, context);
  } catch (error) {
    return fallback(
      config,
      started,
      error instanceof DOMException && error.name === "TimeoutError" ? "router_timeout" : "router_transport_error",
    );
  }
}
