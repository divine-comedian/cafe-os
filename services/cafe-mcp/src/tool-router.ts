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
    timeoutMs: positiveInteger(env.CAFE_TOOL_ROUTER_TIMEOUT_MS, 8_000),
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
            minItems: 1,
            maxItems: maxTools,
            uniqueItems: true,
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["intent", "tool_ids", "confidence"],
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
  const toolIds = [...new Set(rawIds)]
    .filter((item): item is string => typeof item === "string" && allowed.has(item))
    .filter(isCafeToolName)
    .slice(0, config.maxTools);
  const confidence = typeof record.confidence === "number" ? record.confidence : 0;
  if (!toolIds.length) return fallback(config, started, "no_valid_router_tools");
  if (confidence < config.confidenceFloor) return fallback(config, started, "router_low_confidence");
  return {
    ok: true,
    intent: typeof record.intent === "string" ? record.intent.slice(0, 80) : "cafe_operation",
    toolIds,
    confidence,
    model: config.model,
    durationMs: Date.now() - started,
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
              "You route Cafe OS operational requests. Select the smallest sufficient set of tool IDs. Include query_records whenever the request names an existing provider, purchase, green-coffee lot, or roast batch but does not supply its UUID; mutation tools need those foreign keys or target IDs. Include both query_records and the mutation tool for prepare, update, status, delete, and upload workflows that identify a stored record by name or date. A confirmation that follows an earlier request needs only the matching mutation tool. Never choose tools outside the supplied catalog.",
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
    return parseSelection((await response.json()) as OpenRouterResponse, new Set(allowedNames), config, started);
  } catch (error) {
    return fallback(
      config,
      started,
      error instanceof DOMException && error.name === "TimeoutError" ? "router_timeout" : "router_transport_error",
    );
  }
}
