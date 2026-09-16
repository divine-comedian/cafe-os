#!/usr/bin/env node
import { routeCafeTools, ToolRouterInput } from "./tool-router.js";

async function readStdin(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error("Router input exceeds 2 MB.");
  }
  return raw;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as ToolRouterInput;
  process.stdout.write(`${JSON.stringify(await routeCafeTools(input))}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      intent: "fallback_discovery",
      toolIds: [],
      confidence: 0,
      model: process.env.CAFE_TOOL_ROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash",
      durationMs: 0,
      fallbackReason: error instanceof Error ? "router_cli_error" : "router_cli_unknown_error",
    })}\n`,
  );
  process.exitCode = 1;
});
