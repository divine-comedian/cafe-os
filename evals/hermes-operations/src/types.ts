export type Locale = "es-MX" | "en";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
export type TableName = "providers" | "purchases" | "green_coffee_lots" | "roast_batches";
export type Row = Record<string, unknown> & { id: string };

export interface CafeState {
  providers: Row[];
  purchases: Row[];
  green_coffee_lots: Row[];
  roast_batches: Row[];
}

export interface RecordedOperation {
  method: string;
  path: string;
  body?: unknown;
}

export interface TurnExpectation {
  requiredTools?: string[];
  forbiddenTools?: string[];
  allowedTools?: string[];
  minToolCalls?: number;
  maxToolCalls?: number;
  maxApiCalls?: number;
  mutationCount?: number;
  responsePatterns?: string[];
  stateContains?: Array<{ table: TableName; fields: Record<string, unknown> }>;
  stateAbsent?: Array<{ table: TableName; fields: Record<string, unknown> }>;
  toolCallContains?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface EvalTurn { prompt: string; expect: TurnExpectation }
export interface EvalScenario {
  id: string;
  locale: Locale;
  description: string;
  turns: EvalTurn[];
}
export interface ToolCall { name: string; arguments: Record<string, unknown> }
export interface UsageReport {
  estimated_cost_usd?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
  api_calls?: number | null;
  model?: string | null;
  provider?: string | null;
  session_id?: string | null;
  completed?: boolean | null;
  failed?: boolean;
  failure?: string;
}
export interface AssertionResult { pass: boolean; message: string }
export interface TurnResult {
  prompt: string;
  response: string;
  toolCalls: ToolCall[];
  rawToolCalls: ToolCall[];
  sessionId: string;
  exitCode: number;
  diagnostics: string;
  operations: RecordedOperation[];
  usage: UsageReport;
  durationMs: number;
  assertions: AssertionResult[];
  pass: boolean;
}
export interface ScenarioResult {
  id: string;
  locale: Locale;
  description: string;
  turns: TurnResult[];
  pass: boolean;
}
export interface EvalRun {
  runId: string;
  startedAt: string;
  model: string;
  provider: string;
  profile: string;
  reasoning: ReasoningEffort;
  scenarios: ScenarioResult[];
  summary: {
    passed: number;
    failed: number;
    totalApiCalls: number;
    totalToolCalls: number;
    totalRawToolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
}
