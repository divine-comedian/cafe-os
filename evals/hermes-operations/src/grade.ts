import type { AssertionResult, CafeState, RecordedOperation, ToolCall, TurnExpectation, UsageReport } from "./types.ts";

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

export function gradeTurn(expectation: TurnExpectation, response: string, toolCalls: ToolCall[], operations: RecordedOperation[], usage: UsageReport, state: CafeState): AssertionResult[] {
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
    const found = state[expected.table].some((row) => Object.entries(expected.fields).every(([key, value]) => sameValue(row[key], value)));
    results.push(check(found, `state contains matching ${expected.table} record`));
  }
  if (usage.failed) results.push(check(false, `Hermes run failed: ${usage.failure ?? "unknown failure"}`));
  return results;
}
