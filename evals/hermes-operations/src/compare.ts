import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRun } from "./types.ts";

async function main(): Promise<void> {
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "results");
  const supplied = process.argv.slice(2);
  const files = supplied.length ? supplied.map((file) => path.resolve(file)) : (await fs.readdir(base)).filter((file) => file.endsWith(".json")).map((file) => path.join(base, file));
  const runs = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8")) as EvalRun));
  console.log("reasoning\tpass\thops\ttools\tenvelopes\tinput\tcache_read\toutput\treasoning_tokens\ttotal\tcost_usd");
  for (const run of runs.sort((a, b) => a.reasoning.localeCompare(b.reasoning))) {
    const s = run.summary;
    console.log([run.reasoning, `${s.passed}/${run.scenarios.length}`, s.totalApiCalls, s.totalToolCalls, s.totalRawToolCalls, s.inputTokens, s.cacheReadTokens, s.outputTokens, s.reasoningTokens, s.totalTokens, s.estimatedCostUsd.toFixed(6)].join("\t"));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
