import type { AssertionResult, CafeState, HarnessEvent, Locale, RecordedOperation, ToolCall, TurnExpectation, UsageReport } from "./types.ts";

export function shortToolName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

function check(pass: boolean, message: string): AssertionResult {
  return { pass, message };
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" || typeof expected === "number") return Number(actual) === Number(expected);
  if (typeof actual === "string" && typeof expected === "string") return actual.toLocaleLowerCase() === expected.toLocaleLowerCase();
  return Object.is(actual, expected);
}

function containsFields(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const candidate = actual[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
        && containsFields(candidate as Record<string, unknown>, value as Record<string, unknown>);
    }
    return sameValue(candidate, value);
  });
}

export function gradeTurn(expectation: TurnExpectation, response: string, toolCalls: ToolCall[], operations: RecordedOperation[], usage: UsageReport, state: CafeState, harnessEvents: HarnessEvent[] = [], locale?: Locale, rawToolCalls: ToolCall[] = toolCalls): AssertionResult[] {
  const results: AssertionResult[] = [];
  const tools = toolCalls.map((call) => shortToolName(call.name));
  for (const required of expectation.requiredTools ?? []) results.push(check(tools.includes(required), `required tool: ${required}`));
  for (const forbidden of expectation.forbiddenTools ?? []) results.push(check(!tools.includes(forbidden), `forbidden tool absent: ${forbidden}`));
  if (expectation.allowedTools) {
    const unexpected = tools.filter((tool) => !expectation.allowedTools?.includes(tool));
    results.push(check(unexpected.length === 0, `only allowed tools used${unexpected.length ? `; saw ${unexpected.join(", ")}` : ""}`));
  }
  if (expectation.minToolCalls !== undefined) results.push(check(toolCalls.length >= expectation.minToolCalls, `tool calls >= ${expectation.minToolCalls}; got ${toolCalls.length}`));
  if (expectation.maxToolCalls !== undefined) results.push(check(toolCalls.length <= expectation.maxToolCalls, `tool calls <= ${expectation.maxToolCalls}; got ${toolCalls.length}`));
  if (expectation.maxApiCalls !== undefined) results.push(check(Number(usage.api_calls ?? 0) <= expectation.maxApiCalls, `model hops <= ${expectation.maxApiCalls}; got ${usage.api_calls ?? 0}`));
  if (expectation.mutationCount !== undefined) results.push(check(operations.length === expectation.mutationCount, `REST mutations = ${expectation.mutationCount}; got ${operations.length}`));
  for (const pattern of expectation.responsePatterns ?? []) results.push(check(new RegExp(pattern, "iu").test(response), `response matches /${pattern}/iu`));
  for (const expected of expectation.stateContains ?? []) {
    const found = state[expected.table].some((row) => containsFields(row, expected.fields));
    results.push(check(found, `state contains matching ${expected.table} record`));
  }
  for (const expected of expectation.stateAbsent ?? []) {
    const found = state[expected.table].some((row) => containsFields(row, expected.fields));
    results.push(check(!found, `state excludes matching ${expected.table} record`));
  }
  for (const expected of expectation.toolCallContains ?? []) {
    const found = toolCalls.some((call) => shortToolName(call.name) === expected.name && containsFields(call.arguments, expected.arguments));
    results.push(check(found, `tool call contains ${expected.name} arguments`));
  }
  for (const expected of expectation.confirmationTools ?? []) {
    const found = toolCalls.some((call) => shortToolName(call.name) === expected
      && typeof call.arguments.confirmation_id === "string"
      && /^[0-9a-f-]{36}$/iu.test(call.arguments.confirmation_id));
    results.push(check(found, `tool confirms stored ${expected} proposal by opaque ID`));
  }
  const nonCafe = toolCalls.filter((call) => !call.name.startsWith("mcp__cafe_os__"));
  results.push(check(nonCafe.length === 0, `no non-Cafe tools used${nonCafe.length ? `; saw ${nonCafe.map((call) => call.name).join(", ")}` : ""}`));
  const wrapperCalls = rawToolCalls.filter((call) => ["tool_call", "tool_search", "tool_describe"].includes(call.name));
  const malformedCalls = rawToolCalls.filter((call) => Object.hasOwn(call.arguments, "_raw"));
  results.push(check(wrapperCalls.length === 0, "no generic discovery or wrapper envelopes"));
  results.push(check(malformedCalls.length === 0, "no malformed tool-call arguments"));
  const signatures = toolCalls.map((call) => `${call.name}:${JSON.stringify(call.arguments, Object.keys(call.arguments).sort())}`);
  results.push(check(new Set(signatures).size === signatures.length, "no identical duplicate tool calls"));
  const confirmedWrite = toolCalls.findIndex((call) => typeof call.arguments.confirmation_id === "string");
  const postWriteRead = confirmedWrite >= 0 && toolCalls.slice(confirmedWrite + 1)
    .some((call) => shortToolName(call.name) === "query_records");
  results.push(check(!postWriteRead, "no routine read after a confirmed write"));
  const discoveryCalls = tools.filter((tool) => tool === "discover_tools");
  results.push(check(discoveryCalls.length <= 1, `at most one discovery call; got ${discoveryCalls.length}`));
  const sameTurnConfirmation = toolCalls.some((call, index) =>
    typeof call.arguments.confirmation_id === "string"
    && toolCalls.slice(0, index).some((earlier) =>
      earlier.name === call.name && typeof earlier.arguments.confirmation_id !== "string"));
  results.push(check(!sameTurnConfirmation, "a proposal is not executed in the same user turn"));
  results.push(check(!/Finca La Roca/iu.test(response), "no stale cross-scenario entity leakage"));
  if (locale === "en") {
    results.push(check(!/^(?:¿|Encontré|Listo|Guardado|Necesito|Preparé|Compra|Propuesta|Recibo|Eliminación|Cambio|Trazabilidad|No se)\b/iu.test(response), "response language is English"));
  } else if (locale === "es-MX") {
    results.push(check(!/^(?:I|The|Found|Saved|Which|Done|Draft|Purchase|Deletion|Provider|Receipt|Here|Pending|Nothing|Reply|Exact)\b/iu.test(response), "response language is Spanish"));
  }
  if (harnessEvents.length) {
    const routerEvents = harnessEvents.filter((event) => event.event === "router");
    results.push(check(routerEvents.length === 1, `one router decision per user turn; got ${routerEvents.length}`));
    const routed = new Set(Array.isArray(routerEvents[0]?.selected) ? routerEvents[0].selected as string[] : []);
    const missingRouted = (expectation.requiredTools ?? []).filter((tool) => !routed.has(tool));
    results.push(check(
      missingRouted.length === 0,
      `router selected required tools${missingRouted.length ? `; missing ${missingRouted.join(", ")}` : ""}`,
    ));
    const forbiddenRouted = (expectation.forbiddenTools ?? []).filter((tool) => routed.has(tool));
    results.push(check(
      forbiddenRouted.length === 0,
      `router excludes forbidden tools${forbiddenRouted.length ? `; saw ${forbiddenRouted.join(", ")}` : ""}`,
    ));
    const activeToolSets = harnessEvents
      .filter((event) => event.event === "model_hop" && Array.isArray(event.active_tools))
      .map((event) => event.active_tools as unknown[]);
    const oversized = activeToolSets.some((active) => active.length > 6);
    results.push(check(!oversized, "active Cafe tool subset stays within five selected tools plus discovery"));
    const invalid = activeToolSets.flat().filter((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(name));
    results.push(check(invalid.length === 0, "active tool context contains only Cafe catalog IDs"));
    if (expectation.confirmationTools?.length) {
      results.push(check(
        routerEvents[0]?.model === "pending-confirmation-bypass",
        "stored pending confirmation bypasses the intent model",
      ));
    }
    const terminalEvents = harnessEvents.filter((event) => event.event === "terminal");
    results.push(check(terminalEvents.length >= 1, "turn records an explicit terminal reason"));
  }
  if (usage.failed) results.push(check(false, `Hermes run failed: ${usage.failure ?? "unknown failure"}`));
  return results;
}
