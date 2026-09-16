# Hermes operations evals

This suite measures how the real Hermes agent handles Cafe OS semantics in Mexican Spanish and English. It launches a stateful mock REST API, exposes the production TypeScript MCP adapter through an isolated Hermes profile, and never touches Supabase.

The catalog contains 18 scenarios—exactly nine `es-MX` and nine English—and 29 conversational turns. It covers reads, calculations, traceability, ambiguity, missing required data, all four create flows, generic patching, purchase and roast status transitions, guarded and successful deletion, and purchase-document upload. Every one of the nine Cafe OS MCP tools has at least one positive-path assertion.

For every turn it records:

- exact MCP tool names and arguments from Hermes session history;
- REST mutations observed by the mock API;
- model/API hops (`api_calls`), input/cache-read/cache-write/output/reasoning tokens, duration, and estimated cost;
- final response and deterministic assertions against tool, state, and language expectations.

Tool arguments can be checked as partial nested objects, while state checks can assert either presence or absence. This catches wrong IDs, fields, and targets even when the final prose sounds correct.

## Setup

```bash
npm --prefix services/cafe-mcp run build
./scripts/setup-hermes-eval.sh
npm --prefix evals/hermes-operations install
```

The `cafe-eval` profile clones model credentials and non-channel configuration from the active profile. Telegram and Discord remain disabled. Its Cafe API URL, token, and temporary upload root are provided only by the runner process and point to isolated fixtures. The upload case creates a disposable receipt file under the run's temporary directory and removes it afterward.
Hermes 0.21.3 intentionally ignores user-configured main-agent output caps, so setup installs the versioned `config/hermes/plugins/model-providers/openrouter` policy to enforce the ceiling on the actual OpenRouter wire request. The setup uses medium reasoning and caps total model output at 16,384 tokens. OpenRouter maps medium effort to roughly 8,192 reasoning tokens for Qwen3.8 Flash. Hermes permits one tool-free wrap-up call after its iteration budget is exhausted, so the profile uses 19 iterations for a hard ceiling of 20 model hops. It also applies an 80% completion checkpoint and a 90-second wall-clock budget.

## Run

Start with one scenario:

```bash
npm --prefix evals/hermes-operations run eval -- \
  --scenario es_read_draft_purchases \
  --reasoning medium \
  --verbose
```

Run the full suite:

```bash
npm --prefix evals/hermes-operations run eval -- --reasoning medium
```

Compare reasoning levels by producing one result for each level, then aggregate them:

```bash
npm --prefix evals/hermes-operations run eval -- --reasoning none
npm --prefix evals/hermes-operations run eval -- --reasoning minimal
npm --prefix evals/hermes-operations run eval -- --reasoning low
npm --prefix evals/hermes-operations run eval -- --reasoning medium
npm --prefix evals/hermes-operations run compare
```

Three artifacts are written under `results/` and ignored by git: machine-readable JSON, a detailed Markdown report, and append-only JSONL events. `--verbose` also streams the prompt, final response, exact tool arguments, REST mutations, every assertion, and sanitized diagnostics to stderr. A failed behavioral assertion makes the process exit nonzero while preserving all reports.

Reviewed, secret-free benchmark summaries live under `baselines/` and are committed. They deliberately omit Hermes session IDs. The first tracked baseline is `baselines/2026-09-16-qwen3.8-flash-medium.json`; it represents the original six-scenario suite's first live smoke case and should not be treated as a full 18-scenario score.

## Interpreting efficiency

`api_calls` is the real number of model hops reported by Hermes, not an estimate based on tool count. Multiple tool calls may occur in one hop. Optimize in this order:

1. correctness and no unauthorized mutations;
2. shortest valid tool trajectory;
3. fewest model hops;
4. lowest input and reasoning tokens;
5. response brevity.

Do not select a reasoning level from token totals alone. A cheap run that guesses IDs, skips confirmation, or makes an incorrect write fails regardless of cost.
