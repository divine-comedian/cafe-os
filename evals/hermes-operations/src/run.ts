import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeTurn } from "./grade.ts";
import { MockCafeApi } from "./mock-api.ts";
import { scenarios } from "./scenarios.ts";
import type { EvalRun, EvalScenario, HarnessEvent, ReasoningEffort, ScenarioResult, ToolCall, TurnResult, UsageReport } from "./types.ts";

interface Options {
  profile: string;
  model: string;
  provider: string;
  reasoning: ReasoningEffort;
  scenarioIds: string[];
  outDir: string;
  list: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    profile: "cafe-eval",
    model: "qwen/qwen3.8-flash",
    provider: "openrouter",
    reasoning: "medium",
    scenarioIds: [],
    outDir: "results",
    list: false,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--list") options.list = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--profile" && value) { options.profile = value; index += 1; }
    else if (arg === "--model" && value) { options.model = value; index += 1; }
    else if (arg === "--provider" && value) { options.provider = value; index += 1; }
    else if (arg === "--reasoning" && value) { options.reasoning = value as ReasoningEffort; index += 1; }
    else if (arg === "--scenario" && value) { options.scenarioIds.push(...value.split(",")); index += 1; }
    else if (arg === "--out" && value) { options.outDir = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!["none", "minimal", "low", "medium", "high"].includes(options.reasoning)) throw new Error(`Unsupported reasoning effort: ${options.reasoning}`);
  return options;
}

function runProcess(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function sanitizeDiagnostics(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+)/g, "[REDACTED]")
    .replace(/(token|secret|api[_-]?key)(\s*[=:]\s*)\S+/gi, "$1$2[REDACTED]")
    .replace(/(openrouter\.ai\/workspaces\/[^/]+\/keys\/)[A-Za-z0-9_-]+/gi, "$1[REDACTED]")
    .trim();
}

function harnessEvents(value: string): HarnessEvent[] {
  return value.split("\n").flatMap((line) => {
    const marker = "CAFE_HARNESS_EVENT ";
    const offset = line.indexOf(marker);
    if (offset < 0) return [];
    try {
      const parsed = JSON.parse(line.slice(offset + marker.length)) as HarnessEvent;
      return parsed && typeof parsed.event === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function inferFailure(processResult: { stdout: string; stderr: string; code: number }): string {
  const detail = sanitizeDiagnostics([processResult.stderr, processResult.stdout].filter(Boolean).join("\n"));
  return detail || `Hermes exited ${processResult.code}; inspect the persisted turn diagnostics.`;
}

export function decodeToolCalls(session: Record<string, unknown>): { raw: ToolCall[]; effective: ToolCall[] } {
  const messages = Array.isArray(session.messages) ? session.messages as Array<Record<string, unknown>> : [];
  const lastUser = messages.reduce((found, message, index) => message.role === "user" ? index : found, -1);
  const raw: ToolCall[] = [];
  const effective: ToolCall[] = [];
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    const rawCalls = typeof message.tool_calls === "string" ? JSON.parse(message.tool_calls) : message.tool_calls;
    if (!Array.isArray(rawCalls)) continue;
    for (const item of rawCalls as Array<Record<string, unknown>>) {
      const fn = item.function as Record<string, unknown> | undefined;
      if (!fn || typeof fn.name !== "string") continue;
      let parsed: Record<string, unknown> = {};
      if (typeof fn.arguments === "string") {
        try { parsed = JSON.parse(fn.arguments) as Record<string, unknown>; } catch { parsed = { _raw: fn.arguments }; }
      } else if (fn.arguments && typeof fn.arguments === "object") parsed = fn.arguments as Record<string, unknown>;
      const envelope = { name: fn.name, arguments: parsed };
      raw.push(envelope);
      if (fn.name === "tool_call") {
        if (Array.isArray(parsed.calls)) {
          for (const nested of parsed.calls as Array<Record<string, unknown>>) {
            if (typeof nested.name !== "string") continue;
            const args = nested.arguments && typeof nested.arguments === "object" ? nested.arguments as Record<string, unknown> : {};
            effective.push({ name: nested.name, arguments: args });
          }
        }
      } else if (!['tool_search', 'tool_describe'].includes(fn.name)) {
        effective.push(envelope);
      }
    }
  }
  return { raw, effective };
}

async function exportToolCalls(projectRoot: string, profile: string, sessionId: string, target: string): Promise<{ raw: ToolCall[]; effective: ToolCall[] }> {
  const exported = await runProcess("hermes", ["-p", profile, "sessions", "export", target, "--format", "jsonl", "--session-id", sessionId, "--yes"], { cwd: projectRoot });
  if (exported.code !== 0) throw new Error(`Session export failed: ${exported.stderr.trim()}`);
  const raw = await fs.readFile(target, "utf8");
  const firstLine = raw.split("\n").find(Boolean);
  if (!firstLine) throw new Error(`Session ${sessionId} exported no records.`);
  return decodeToolCalls(JSON.parse(firstLine) as Record<string, unknown>);
}

function renderMarkdown(run: EvalRun): string {
  const lines = [
    `# Hermes operations eval — ${run.runId}`,
    "",
    `Model: \`${run.model}\` via \`${run.provider}\`; reasoning: \`${run.reasoning}\``,
    "",
    "| Scenario | Locale | Pass | Hops | Tools | Envelopes | Input | Cache read | Reasoning | Output | Cost USD |",
    "|---|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of run.scenarios) {
    const turns = scenario.turns;
    const hops = turns.reduce((sum, turn) => sum + Number(turn.usage.api_calls ?? 0), 0);
    const tools = turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
    const envelopes = turns.reduce((sum, turn) => sum + turn.rawToolCalls.length, 0);
    const input = turns.reduce((sum, turn) => sum + Number(turn.usage.input_tokens ?? 0), 0);
    const output = turns.reduce((sum, turn) => sum + Number(turn.usage.output_tokens ?? 0), 0);
    const cacheRead = turns.reduce((sum, turn) => sum + Number(turn.usage.cache_read_tokens ?? 0), 0);
    const reasoning = turns.reduce((sum, turn) => sum + Number(turn.usage.reasoning_tokens ?? 0), 0);
    const cost = turns.reduce((sum, turn) => sum + Number(turn.usage.estimated_cost_usd ?? 0), 0);
    lines.push(`| ${scenario.id} | ${scenario.locale} | ${scenario.pass ? "yes" : "NO"} | ${hops} | ${tools} | ${envelopes} | ${input} | ${cacheRead} | ${reasoning} | ${output} | ${cost.toFixed(6)} |`);
  }
  lines.push("", `Passed: ${run.summary.passed}/${run.scenarios.length}; main hops: ${run.summary.totalApiCalls}; router calls: ${run.summary.routerCalls}; tools: ${run.summary.totalToolCalls}; envelopes: ${run.summary.totalRawToolCalls}; main tokens: ${run.summary.totalTokens}; router tokens: ${run.summary.routerInputTokens + run.summary.routerOutputTokens}; combined tokens: ${run.summary.combinedTokens}; main cost: $${run.summary.estimatedCostUsd.toFixed(6)}; router cost: $${run.summary.routerCostUsd.toFixed(6)}; combined cost: $${run.summary.combinedCostUsd.toFixed(6)}`, "", "## Failures", "");
  let failures = 0;
  for (const scenario of run.scenarios) for (const [index, turn] of scenario.turns.entries()) {
    const failed = turn.assertions.filter((item) => !item.pass);
    if (!failed.length) continue;
    failures += failed.length;
    lines.push(`### ${scenario.id}, turn ${index + 1}`, "", ...failed.map((item) => `- ${item.message}`), "");
  }
  if (!failures) lines.push("None.", "");
  lines.push("## Turn details", "");
  for (const scenario of run.scenarios) for (const [index, turn] of scenario.turns.entries()) {
    lines.push("### " + scenario.id + ", turn " + (index + 1), "", "**Prompt**", "", turn.prompt, "", "**Response**", "", turn.response || "_(empty)_", "", "**Metrics**", "", "- Session: `" + turn.sessionId + "`", "- Exit code: " + turn.exitCode, "- Hops: " + Number(turn.usage.api_calls ?? 0), "- Input tokens: " + Number(turn.usage.input_tokens ?? 0), "- Cache-read tokens: " + Number(turn.usage.cache_read_tokens ?? 0), "- Reasoning tokens: " + Number(turn.usage.reasoning_tokens ?? 0), "- Output tokens: " + Number(turn.usage.output_tokens ?? 0), "- Total tokens: " + Number(turn.usage.total_tokens ?? 0), "- Estimated cost: $" + Number(turn.usage.estimated_cost_usd ?? 0).toFixed(6), "- Duration: " + turn.durationMs + " ms", "", "**Sanitized harness trajectory**", "", "```json", JSON.stringify(turn.harnessEvents, null, 2), "```", "", "**Raw Hermes tool envelopes**", "", "```json", JSON.stringify(turn.rawToolCalls, null, 2), "```", "", "**Effective Cafe OS tool calls**", "", "```json", JSON.stringify(turn.toolCalls, null, 2), "```", "", "**REST mutations**", "", "```json", JSON.stringify(turn.operations, null, 2), "```", "", "**Assertions**", "", ...turn.assertions.map((item) => "- " + (item.pass ? "PASS" : "FAIL") + ": " + item.message), "");
    if (turn.diagnostics) lines.push("**Sanitized diagnostics**", "", "```text", turn.diagnostics, "```", "");
  }
  return lines.join("\n");
}

async function runScenario(scenario: EvalScenario, options: Options, projectRoot: string, api: MockCafeApi, apiUrl: string, tempDir: string, logPath: string): Promise<ScenarioResult> {
  api.reset();
  let sessionId: string | undefined;
  const turns: TurnResult[] = [];
  for (const [turnIndex, turn] of scenario.turns.entries()) {
    const prompt = turn.prompt.replaceAll("{{UPLOAD_FIXTURE_PATH}}", path.join(tempDir, "eval-receipt.png"));
    const beforeOperations = api.operations.length;
    const usagePath = path.join(tempDir, `${scenario.id}-${turnIndex}-usage.json`);
    const exportPath = path.join(tempDir, `${scenario.id}-${turnIndex}-session.jsonl`);
    const harnessEventPath = path.join(tempDir, `${scenario.id}-${turnIndex}-harness.jsonl`);
    const args = [
      "-p", options.profile, "-z", prompt,
      "--usage-file", usagePath,
      "--model", options.model,
      "--provider", options.provider,
      "--reasoning", options.reasoning,
      "--toolsets", "cafe_os",
      "--in", projectRoot,
    ];
    if (sessionId) args.push("--resume", sessionId);
    const started = Date.now();
    const processResult = await runProcess("hermes", args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        CAFE_EVAL_API_URL: apiUrl,
        CAFE_EVAL_API_TOKEN: api.token,
        CAFE_EVAL_UPLOAD_ROOT: tempDir,
        CAFE_TOOL_ROUTER_CLI: path.join(projectRoot, "services/cafe-mcp/dist/tool-router-cli.js"),
        CAFE_HARNESS_EVENT_FILE: harnessEventPath,
      },
      timeoutMs: 120_000,
    });
    let usage: UsageReport;
    try {
      usage = JSON.parse(await fs.readFile(usagePath, "utf8")) as UsageReport;
    } catch {
      usage = { failed: true, failure: inferFailure(processResult), api_calls: 0, total_tokens: 0 };
    }
    if (usage.failed && !usage.failure) usage.failure = inferFailure(processResult);
    if (processResult.code !== 0 && !usage.failed) {
      usage.failed = true;
      usage.failure = inferFailure(processResult);
    }
    sessionId = String(usage.session_id ?? sessionId ?? "");
    const trajectory = sessionId ? await exportToolCalls(projectRoot, options.profile, sessionId, exportPath) : { raw: [], effective: [] };
    const rawToolCalls = trajectory.raw;
    const toolCalls = trajectory.effective;
    const operations = api.operations.slice(beforeOperations);
    const response = sanitizeDiagnostics(processResult.stdout.trim());
    let fileHarnessEvents: HarnessEvent[] = [];
    try {
      fileHarnessEvents = (await fs.readFile(harnessEventPath, "utf8")).split("\n").flatMap((line) => {
        if (!line) return [];
        try { return [JSON.parse(line) as HarnessEvent]; } catch { return []; }
      });
    } catch {
      // The middleware may not have reached its first event on a startup failure.
    }
    const safeHarnessEvents = fileHarnessEvents.length ? fileHarnessEvents : harnessEvents(processResult.stderr);
    const assertions = gradeTurn(turn.expect, response, toolCalls, operations, usage, api.snapshot(), safeHarnessEvents, scenario.locale, rawToolCalls);
    const turnResult: TurnResult = {
      prompt,
      response,
      toolCalls,
      rawToolCalls,
      sessionId: sessionId ?? "",
      exitCode: processResult.code,
      diagnostics: sanitizeDiagnostics(processResult.stderr),
      harnessEvents: safeHarnessEvents,
      operations,
      usage,
      durationMs: Date.now() - started,
      assertions,
      pass: assertions.every((item) => item.pass),
    };
    turns.push(turnResult);
    for (const event of safeHarnessEvents) {
      await fs.appendFile(logPath, JSON.stringify({ ...event, run_scenario: scenario.id, run_turn: turnIndex + 1 }) + "\n");
    }
    await fs.appendFile(logPath, JSON.stringify({ event: "turn", scenario: scenario.id, turn: turnIndex + 1, ...turnResult }) + "\n");
    const metric = "  turn " + (turnIndex + 1) + ": " + (turnResult.pass ? "PASS" : "FAIL") + "; hops=" + Number(usage.api_calls ?? 0) + "; tools=" + toolCalls.length + "; envelopes=" + rawToolCalls.length + "; tokens=" + Number(usage.total_tokens ?? 0) + "; cost=$" + Number(usage.estimated_cost_usd ?? 0).toFixed(6) + "; duration=" + turnResult.durationMs + "ms\n";
    process.stderr.write(metric);
    if (options.verbose) process.stderr.write(JSON.stringify({ prompt: turnResult.prompt, response: turnResult.response, rawToolCalls, toolCalls, operations, harnessEvents: safeHarnessEvents, assertions, diagnostics: turnResult.diagnostics }, null, 2) + "\n");
  }
  return { id: scenario.id, locale: scenario.locale, description: scenario.description, turns, pass: turns.every((turn) => turn.pass) };
}

function summarize(run: Omit<EvalRun, "summary">): EvalRun["summary"] {
  const turns = run.scenarios.flatMap((scenario) => scenario.turns);
  const routerEvents = turns.flatMap((turn) => turn.harnessEvents)
    .filter((event) => event.event === "router" && event.model !== "pending-confirmation-bypass");
  const mainTokens = turns.reduce((sum, turn) => sum + Number(turn.usage.total_tokens ?? 0), 0);
  const mainCost = turns.reduce((sum, turn) => sum + Number(turn.usage.estimated_cost_usd ?? 0), 0);
  const routerInput = routerEvents.reduce((sum, event) => sum + Number(event.input_tokens ?? 0), 0);
  const routerOutput = routerEvents.reduce((sum, event) => sum + Number(event.output_tokens ?? 0), 0);
  const routerCost = routerEvents.reduce((sum, event) => sum + Number(event.cost_usd ?? 0), 0);
  return {
    passed: run.scenarios.filter((scenario) => scenario.pass).length,
    failed: run.scenarios.filter((scenario) => !scenario.pass).length,
    totalApiCalls: turns.reduce((sum, turn) => sum + Number(turn.usage.api_calls ?? 0), 0),
    totalToolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0),
    totalRawToolCalls: turns.reduce((sum, turn) => sum + turn.rawToolCalls.length, 0),
    inputTokens: turns.reduce((sum, turn) => sum + Number(turn.usage.input_tokens ?? 0), 0),
    outputTokens: turns.reduce((sum, turn) => sum + Number(turn.usage.output_tokens ?? 0), 0),
    cacheReadTokens: turns.reduce((sum, turn) => sum + Number(turn.usage.cache_read_tokens ?? 0), 0),
    cacheWriteTokens: turns.reduce((sum, turn) => sum + Number(turn.usage.cache_write_tokens ?? 0), 0),
    reasoningTokens: turns.reduce((sum, turn) => sum + Number(turn.usage.reasoning_tokens ?? 0), 0),
    totalTokens: mainTokens,
    estimatedCostUsd: mainCost,
    routerCalls: routerEvents.length,
    routerInputTokens: routerInput,
    routerOutputTokens: routerOutput,
    routerCostUsd: routerCost,
    routerDurationMs: routerEvents.reduce((sum, event) => sum + Number(event.duration_ms ?? 0), 0),
    combinedTokens: mainTokens + routerInput + routerOutput,
    combinedCostUsd: mainCost + routerCost,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of scenarios) console.log(`${scenario.id}\t${scenario.locale}\t${scenario.description}`);
    return;
  }
  const selected = options.scenarioIds.length ? scenarios.filter((scenario) => options.scenarioIds.includes(scenario.id)) : scenarios;
  if (!selected.length) throw new Error("No matching eval scenarios.");
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  await fs.access(path.join(projectRoot, ".hermes/skills/cafe-os-operations/SKILL.md"));
  await fs.access(path.join(projectRoot, "services/cafe-mcp/dist/server.js"));
  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-hermes-eval-"));
  await fs.writeFile(path.join(tempDir, "eval-receipt.png"), "Cafe OS eval receipt fixture\n");
  const api = new MockCafeApi();
  const apiUrl = await api.start();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.reasoning}`;
  const logPath = path.join(outDir, runId + ".events.jsonl");
  await fs.writeFile(logPath, JSON.stringify({ event: "run_started", runId, model: options.model, provider: options.provider, reasoning: options.reasoning, scenarios: selected.map((scenario) => scenario.id) }) + "\n");
  try {
    const scenarioResults: ScenarioResult[] = [];
    const scenarioSessions = new Set<string>();
    for (const scenario of selected) {
      process.stderr.write(`eval ${scenario.id} (${options.reasoning})...\n`);
      const result = await runScenario(scenario, options, projectRoot, api, apiUrl, tempDir, logPath);
      const scenarioSession = result.turns[0]?.sessionId;
      if (scenarioSession && scenarioSessions.has(scenarioSession)) {
        throw new Error(`Scenario isolation failed: session ${scenarioSession} was reused.`);
      }
      if (scenarioSession) scenarioSessions.add(scenarioSession);
      scenarioResults.push(result);
    }
    const base = { runId, startedAt: new Date().toISOString(), model: options.model, provider: options.provider, profile: options.profile, reasoning: options.reasoning, scenarios: scenarioResults };
    const run: EvalRun = { ...base, summary: summarize(base) };
    const jsonPath = path.join(outDir, `${runId}.json`);
    const markdownPath = path.join(outDir, `${runId}.md`);
    await fs.writeFile(jsonPath, `${JSON.stringify(run, null, 2)}\n`);
    await fs.writeFile(markdownPath, renderMarkdown(run));
    console.log(renderMarkdown(run));
    console.error("results: " + jsonPath);
    console.error("events: " + logPath);
    if (run.summary.failed) process.exitCode = 1;
  } finally {
    await api.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
