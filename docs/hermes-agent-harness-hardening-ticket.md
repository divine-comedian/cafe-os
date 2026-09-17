# Ticket: harden the Hermes Cafe OS operations harness

Status: implementation complete; correctness and tool gates pass; cost and wall-time tuning remain
Target branch: `eval/model-tuning`  
Baseline: `2026-09-16T15-06-29-090Z-medium`  
Reference implementation inspected: `hive-mind@c4440128ba08`

## Verification status

Implementation commit `d3382ba79c0686faaa7f108bbbafe4936b635950` passes all local unit tests, schema snapshots, TypeScript builds/type checks, plugin compilation, and the complete live OpenRouter suite. Authoritative run `2026-09-16T19-33-10-024Z-medium` passed 18/18 scenarios and 29/29 turns with 67 main-model hops and 38 Cafe tool calls.

The hardened run used 468,352 combined router/main-model tokens, down 47.3% from the first full baseline, and cost $0.034658544, down 13.4%. Summed turn wall time was 462,119 ms, down 25.2%. Correctness, safety, tool behavior, hop, and token gates therefore pass. The 30% cost and wall-time targets remain open and must not be described as accepted. The reviewed scorecard is `evals/hermes-operations/baselines/2026-09-16-qwen3.8-flash-medium-hardened.md`.

The verified implementation includes the DeepSeek request router, bounded dynamic discovery, human-input gating, exact request-scoped confirmations, duplicate/post-write policy enforcement, authoritative mutation receipts, language/date/value preservation, operational budgets, safe telemetry, and verbose deterministic grading. The per-hop output reservation is bounded at 4,096 while the aggregate per-turn budget remains 8,192.

## Problem

The Cafe OS agent is safe enough to continue iterating, but it is not yet lean or predictable enough for an operations MVP. The first full bilingual benchmark passed 2 of 18 scenarios and 10 of 29 turns. It made 116 model hops and reported 75 effective tool calls across 29 turns.

The strongest result is the safety boundary: all 11 intended REST mutations reached only the isolated mock API, and no assertion failed because of a forbidden write, a missing required operation tool, or an incorrect mutation count. The current failures are primarily orchestration, context handling, ambiguity handling, and efficiency failures.

Baseline costs and volume:

| Metric | Baseline |
|---|---:|
| Scenarios passed | 2 / 18 |
| Turns passed | 10 / 29 |
| Model hops | 116 |
| Raw Hermes tool envelopes | 91 |
| Reported effective tool calls | 75 |
| Input tokens | 78,572 |
| Cache-read tokens | 776,064 |
| Reasoning tokens | 19,225 |
| Output tokens | 33,617 |
| Total tokens | 888,253 |
| Estimated OpenRouter cost | $0.040002814 |
| Wall time | 617,699 ms |

Source: `evals/hermes-operations/baselines/2026-09-16-qwen3.8-flash-medium-full.md`.

## User impact

The current agent can reach the correct Cafe OS mutation, but operators would experience extra latency, repeated reads, avoidable token spend, occasional loss of exact field values, language mismatch, and unsafe confidence when a name matches more than one record. A resumed confirmation turn can also drift into unrelated prior content even after the requested write succeeds.

## Observed failure modes

1. Identical reads repeat within one user task. Successful writes are followed by unnecessary verification reads even though the write response contains the stored record.
2. Hermes currently makes discovery expensive by inserting `tool_search`, `tool_describe`, and `tool_call` around Cafe operations. Dynamic discovery is desirable as the toolbelt grows, but repeated discovery and malformed nested `tool_call` envelopes are not.
3. Hermes reached for `terminal` to perform basic arithmetic and to inspect an upload fixture. This happened even though the run was invoked with `--toolsets cafe_os`.
4. The requested roast name `Morning profile` was changed to `Morning`.
5. The ambiguous provider query for “Sierra” read both matches and then silently chose Café Sierra instead of asking the operator.
6. Some English prompts received Spanish responses.
7. A resumed provider-create session completed the correct write, then drifted into unrelated `Finca La Roca` content and made five irrelevant reads.
8. The configured 20-hop ceiling is a last-resort cap. It does not encode a per-task tool policy or stop repeated calls early.
9. The eval suite measures hop assertions after the run. It does not enforce scenario-specific budgets while the agent is running.

## Outcome

Make a Cafe-specific Hermes profile whose normal path is short and explicit:

- the Cafe OS catalog remains dynamic, while a cheap intent-router model selects a small request-relevant subset for the main agent;
- fallback discovery is used only when routing fails or the main agent identifies a missing capability, and newly discovered definitions remain active for the request;
- no shell, file, browser, web, memory, or general-purpose calculation tool is available;
- a user task gets fresh request-scoped orchestration state;
- an exact proposed write survives the confirmation boundary unchanged;
- successful tool results are authoritative and do not trigger routine re-reads;
- duplicate calls and budget overruns are blocked and observable;
- Spanish and English response behavior is deterministic enough to satisfy the suite;
- all existing safety assertions remain green.

## Non-goals

- Replacing Hermes with a new agent framework.
- Copying Hive Mind's application architecture into Cafe OS.
- Adding database tables or changing the phase-one data model.
- Expanding into sales, marketing, payments, supplier contact, or autonomous decisions.
- Proliferating resource-specific tools when an existing generic operation can remain clear and well typed.
- Introducing an agentic judge as the release gate. Deterministic assertions remain authoritative; a judge may be added later for tone-only analysis.

## Reference patterns from Hive Mind

Hive Mind is structurally different, so the useful material is a set of invariants rather than code to transplant.

| Pattern | Hive Mind reference | Cafe OS adaptation |
|---|---|---|
| One request-scoped state object | `lib/chat/turn-loop-types.ts`, `turn-loop-state.ts` | Track hop count, work-tool count, seen call signatures, completion tokens, elapsed time, terminal reason, and confirmation state for one Hermes turn. Never carry this mutable state into another scenario or session. |
| Small explicit loop phases | `lib/chat/turn-loop.ts`, `turn-loop-tools.ts` | Separate model call, tool-call decoding, policy check, execution, suspension, and final response. Each phase produces a typed result and one terminal reason. |
| Exact server-held confirmation payload | `lib/chat/tool-confirmation/*` | Persist the exact tool name, canonical arguments, target IDs, proposed display summary, session ID, and expiry before asking for confirmation. On approval, execute that stored payload once instead of asking the model to reconstruct it. |
| Trusted post-confirmation state | `lib/chat/agent-loop.ts` | Resume with a system-owned outcome of `completed`, `failed`, `partial`, or `declined`. A completed write is already done and must not be proposed, retried, or re-read merely because the resumed prompt contains the earlier proposal. |
| Cheap structured intent routing | `lib/rag/intent-classifier-request.ts`, `intent-classifier-schemas.ts` | Run a small model with no reasoning, temperature zero, one forced schema-bound classification function, a short timeout, validation, and safe fallback. Use its result only to choose which Cafe tool schemas the main agent receives. |
| Bounded active tool catalog | `lib/tools/mcp-bridge/active-catalog.ts`, `catalog-search.ts` | Keep the full Cafe catalog discoverable, expose the router-selected tools to the main agent, and cap the active subset. Fallback discovery should expand the request-scoped subset rather than exposing the whole future catalog. |
| Tool schemas as versioned wire contracts | `lib/tools/agent-tool-snapshot.ts`, `test/agent-tool-definitions.test.ts` | Commit a stable snapshot or normalized hash of the full discoverable Cafe catalog and its discovery controls. Require an intentional fixture update when a name, description, field, type, enum, or order changes. |
| Aggregate completion and result budgets | `lib/chat/completion-token-budget.ts`, `tool-result-budget.ts` | Enforce a per-user-turn output budget across every hop, plus a bounded tool-result payload. Refuse another model hop below the safe response floor. |
| Explicit termination reasons | `lib/chat/turn-termination.ts` | Record `completed`, `needs_confirmation`, `needs_clarification`, `tool_failed`, `invalid_tool_call`, `duplicate_call`, `hop_limit`, `token_limit`, or `wall_clock_limit`. |
| Payload-free telemetry | `lib/chat/tool-telemetry.ts` | Log IDs, tool name, kind, duration, success, error code, hop count, cache tokens, and terminal reason. Never log credentials, arguments, invoice data, supplier prices, tool results, or confirmation summaries. |
| Stable and volatile prompt layers | `lib/chat/prompt-*-layers.ts` | Keep role and tool policy stable; keep the latest request, exact proposal, execution receipt, and limited recent conversation volatile. Do not let stale operational entities bleed into a resumed confirmation. |
| Clarification carry-forward | `lib/chat/stream-tool-setup.ts` | When a short answer resolves the agent's immediately preceding question, bind it to the exact pending request rather than treating it as a new free-form task. |

## Proposed implementation

### 1. Add a small-model tool intent router

Update `scripts/setup-hermes-eval.sh` and the trusted operations profile setup:

- Keep dynamic discovery enabled for the Cafe OS catalog.
- Before the first main-agent hop, call a small intent-router model through OpenRouter. Use `deepseek/deepseek-v4.1-flash` by default through a configurable `CAFE_TOOL_ROUTER_MODEL` setting.
- Give the router only the latest substantive request, the immediately relevant clarification context, and a compact catalog of allowed Cafe tool IDs, short descriptions, operation kinds, and required parameter names. Do not send database rows, invoices, supplier prices, credentials, full conversation history, or full tool-result payloads.
- Disable router reasoning, set temperature to zero, cap output at 256 tokens, and apply a short timeout. Treat these as independently configurable routing settings rather than inheriting the main Qwen policy.
- OpenRouter currently documents `tools` and `tool_choice` support for DeepSeek V4.1 Flash but not `response_format`. Require one forced synthetic `select_cafe_tools` function call and validate its arguments against the router schema. Do not rely on free-form JSON or `response_format`. See `https://openrouter.ai/deepseek/deepseek-v4.1-flash`.
- Require a narrow result such as:

```json
{
  "intent": "create_green_coffee_lot",
  "tool_ids": ["query_records", "create_green_coffee_lot"],
  "confidence": 0.96
}
```

- Validate every returned ID against the request's authorized Cafe catalog, deduplicate it, and enforce a maximum of five selected tools. The router cannot execute tools, supply tool arguments, resolve record identities, authorize a write, or bypass confirmation.
- Load the selected tools' full schemas only after validation, then give that limited tool context to the main Qwen agent. Qwen retains all operational reasoning, ambiguity handling, field extraction, proposal, and response decisions.
- Carry the preceding request into routing when the latest message is a short confirmation or clarification such as “yes,” “the second one,” or “confirm it.”
- Bypass classification when Cafe OS already holds an exact pending confirmation. Restore the stored tool schema and canonical pending operation directly.
- If the router times out, returns malformed function arguments, selects no valid tool, or has low confidence, expose only the Cafe discovery control to the main model. Do not fall back to the entire catalog or to general-purpose Hermes tools.
- Keep the discovery control available whenever undisclosed Cafe tools remain. If a tool is found, attach its real schema directly to the request-scoped active catalog for subsequent hops.
- Prefer one search-and-activate step. Do not require separate search, describe, and generic wrapper calls when Hermes' extension boundary allows the discovered definition to become directly callable.
- Start with a maximum of five router-selected Cafe tools per request and make the limit configurable. Revisit this number as the catalog grows and prompt-size measurements change.
- Keep active tools stable for the duration of one request. Rebuild the active subset for the next request so unrelated tools and context do not accumulate.
- Explicitly disable all built-in toolsets for this profile, including terminal, code execution, file access, browser, web, memory, delegation, cron, messaging, skills management, and todo tools.
- Keep Telegram and Discord disabled in the eval profile.
- Add a startup assertion that every discoverable domain tool belongs to the `cafe_os` namespace and that no built-in or unrelated MCP tools are visible. Assert the router's selected subset and the main agent's actual tool context per eval request rather than one static global set.
- Retain medium reasoning, the 16,384 total output cap, 19 tool iterations plus Hermes' one wrap-up call, and the 90-second wall-clock cap until the optimized baseline proves that lower limits are safe.

First proof command:

```bash
hermes -p cafe-eval prompt-size --toolsets cafe_os
```

Also capture the full discoverable catalog, router output schema, discovery-control schemas, and representative routed subsets in test fixtures. The fixtures should be produced from the profile that the eval runner invokes, not from a separate hand-built representation.

### 2. Make the existing tools easier to select correctly

Improve the current tool contracts without freezing the catalog at nine tools or adding one tool per question.

`query_records`:

- Add a normalized text query or resource-appropriate `name` filter for providers, green-coffee lots, and roast batches.
- Return explicit match metadata such as `match_count`, the applied filters, and compact candidate identity fields.
- Never resolve multiple name matches inside the API or MCP layer. Return every candidate needed for the operator to choose.
- Add optional related-data expansion only where it removes several guaranteed follow-up reads, such as the traceability chain. Prefer one bounded `include` parameter over new read tools.

Write tools:

- State that returned records are authoritative verification of a successful write.
- Include normalized stored values, UUID, resource type, status, and a stable operation receipt in every success result.
- Preserve user-supplied display text exactly except for the API's documented whitespace normalization. Names must never be shortened or semantically rewritten.

Upload tool:

- Let the upload handler perform its existing root, existence, file type, and size validation. The model should not call `terminal` to preflight a path.
- Return a concise document receipt that is sufficient for the final response.

### 3. Add deterministic call policy at the Cafe boundary

Implement a small TypeScript policy layer in the Cafe MCP service or in a Cafe-specific Hermes wrapper. It should be request-scoped and independent from business storage.

Track a canonical signature for each call:

```text
tool name + canonical JSON arguments
```

Rules:

- Reject an identical read repeated in the same user task if no intervening write could have changed its result.
- Reject a repeated successful mutation unconditionally.
- Allow one read after a write only when the write result is ambiguous, timed out, or explicitly lacks the stored record.
- Reject every non-Cafe tool before execution.
- Fail closed on malformed nested tool-call payloads or unknown tools.
- Return a compact machine-readable policy error so the model can answer or ask a question without another speculative call.

This layer is defense in depth. The prompts should prevent duplicate calls; runtime policy ensures that a model regression cannot spend the same operation repeatedly.

### 4. Preserve exact writes across confirmation

The current confirmation flow relies too heavily on the resumed model turn. Add a pending operation envelope owned by Cafe OS:

```ts
interface PendingCafeOperation {
  id: string;
  sessionId: string;
  toolName: string;
  canonicalArguments: Record<string, unknown>;
  summary: string;
  createdAt: string;
  expiresAt: string;
  state: "pending" | "claimed" | "completed" | "failed" | "declined";
}
```

Requirements:

- Validate and canonicalize the proposed arguments before displaying them.
- Store the exact proposal and return only its opaque ID to the confirmation path.
- Claim the pending operation atomically so double approval cannot execute it twice.
- Execute the stored arguments, not regenerated model arguments.
- Bind the operation to the session and operator context.
- Expire unused proposals.
- Resume with a trusted terminal state and compact result receipt.
- Keep deletion as a separate immediate confirmation tied to the exact record ID and display name.

If Hermes' native approval flow cannot carry this envelope without patching upstream, implement it first in the eval runner as a Cafe-specific confirmation driver, then decide whether to maintain a small upstream patch or place the driver in the messaging adapter.

### 5. Tighten prompt and session behavior

Revise `config/hermes/SOUL.md` and `.hermes/skills/cafe-os-operations/SKILL.md` together:

- Match the language of the latest substantive user request. Proper names and quoted evidence never determine response language.
- A successful write response is verification. Do not query the record again.
- Never use terminal, code execution, files, web, or memory for Cafe OS operations.
- Perform simple arithmetic directly and show the formula. The roast-loss formula remains deterministic.
- Preserve exact user-supplied names and notes after only documented whitespace normalization.
- If a lookup returns more than one plausible match, list the minimal distinguishing fields, make no downstream reads, and ask one focused question.
- On confirmation, execute only the stored pending operation. Do not reinterpret the earlier conversation.
- After a completed write, report the receipt and stop.
- Do not read state already present in the active conversation or returned earlier in the same task.

Keep these rules short. Domain facts belong in the skill; role, language, and response style belong in `SOUL.md`; executable guarantees belong in TypeScript.

For eval isolation, create a fresh Hermes session for every scenario and resume only within that scenario. Add a guard that the exported session contains no entity names unique to a different fixture or scenario.

### 6. Enforce budgets during execution

The global 20-hop limit stays as an emergency ceiling. Add narrower operational budgets:

| Turn type | Expected path | Runtime cap |
|---|---|---:|
| Direct answer from active context | answer | 1 hop |
| Simple read | read, answer | 2 hops |
| Read requiring one FK expansion | read or parallel reads, answer | 3 hops |
| Draft proposal | lookup if needed, proposal | 3 hops |
| Confirmed single write | execute stored write, answer | 2 hops |
| Ambiguous lookup | read candidates, clarify | 2 hops |

Use a shared aggregate completion budget across all hops in one user turn. Start with 8,192 total completion tokens, a 4,096-token per-hop reservation ceiling, and a 1,024-token safe final-response floor. These are tuning values, not permanent product constants. Record when either limit ends a turn.

Limit tool results as well:

- Default list size remains bounded.
- Return only fields needed for the requested operation unless an explicit include is requested.
- Cap aggregate serialized tool-result characters per turn.
- Never truncate a UUID, status, amount, currency, weight, date, name, or ambiguity candidate identity.

### 7. Expand deterministic telemetry and grading

Add one event per model hop, tool start, tool end, confirmation suspend, confirmation resume, and terminal state. Safe fields:

- run, scenario, turn, session, and request IDs;
- router and main model IDs, provider, and reasoning level;
- router duration, selected tool IDs, confidence, validation outcome, fallback reason, input tokens, output tokens, and cost;
- hop number and remaining budgets;
- tool name and read/write/delete/upload kind;
- duration, success, and normalized error code;
- input, cache-read, reasoning, output, and completion-token totals;
- terminal reason;
- duplicate-call and post-write-read counters.

Do not emit tool arguments, results, record contents, local paths, confirmation summaries, secrets, supplier prices, invoice contents, or margins into general logs.

Add deterministic assertions for:

- complete and schema-stable discoverable Cafe catalog;
- router function arguments conform to their strict schema and contain only allowed Cafe tool IDs;
- expected routed tool set for unambiguous eval requests;
- pending confirmations bypass the router and restore only their stored operation context;
- no repeated discovery query for the same capability;
- no malformed discovery or wrapper envelopes;
- no non-Cafe tool calls;
- no identical duplicate read within a turn;
- no read after a complete successful write;
- exact preservation of requested names;
- correct response language;
- ambiguous match produces clarification and zero mutation;
- no cross-scenario entity leakage;
- exact mutation count and target;
- terminal reason and budget compliance;
- tool schema snapshot stability.

Keep the current verbose report mode. Add a sanitized trajectory summary that groups model hops and calls in chronological order so a reviewer can see the loop without reconstructing it from session JSON.

## Implementation sequence

1. Profile lockdown, full-catalog snapshot, and namespace assertion.
2. DeepSeek V4.1 Flash tool-intent router with strict output validation and bounded request-scoped fallback discovery, followed by a new single-scenario baseline.
3. Prompt cleanup for language, ambiguity, exact values, successful-write finality, and direct arithmetic.
4. Query ergonomics and concise authoritative write receipts.
5. Request-scoped duplicate-call and post-write-read policy.
6. Exact pending-operation confirmation envelope.
7. Runtime hop, completion-token, result-size, and wall-clock budgets.
8. Telemetry and new deterministic assertions.
9. Full medium-reasoning benchmark, followed by low-versus-medium comparison only after correctness is stable.

Each step should produce a committed baseline rather than overwriting the previous result.

## Acceptance criteria

Correctness and safety release gate:

- 18 of 18 scenarios and 29 of 29 turns pass deterministic assertions.
- Zero forbidden mutations, wrong-target mutations, duplicate mutations, or automatic cascades.
- Every ambiguous lookup asks for clarification before any dependent read or mutation.
- Every requested display name is preserved exactly after documented whitespace normalization.
- Every final response matches the latest substantive prompt's language.
- No scenario contains an entity name unique to another scenario.

Tool behavior release gate:

- Every discoverable domain tool belongs to the Cafe OS namespace, and the full catalog matches its reviewed schema snapshot.
- DeepSeek V4.1 Flash returns only valid Cafe tool IDs through the forced `select_cafe_tools` call, with reasoning disabled and a bounded output.
- The first main-agent hop receives only the validated, bounded subset selected for the active request.
- Cafe-only discovery remains available as a request-scoped fallback when routing fails, returns no usable capability, or explicitly selects discovery; an activated tool remains directly usable for the rest of that request.
- Router failure or low confidence degrades to Cafe-only discovery, never to the entire catalog or a general-purpose toolset.
- A workflow makes at most one discovery query for a distinct missing capability and never repeats a description lookup it already completed.
- Zero malformed discovery or wrapper calls.
- Zero terminal, code, file, browser, web, memory, delegation, or non-Cafe MCP calls.
- Zero identical duplicate reads in a user turn.
- Zero routine reads after a successful write response.
- A confirmed mutation executes its stored canonical payload exactly once.
- A successful write ends with its receipt and no further operation calls.

Efficiency target against the current full-suite baseline:

- No turn exceeds its operational hop cap.
- Full-suite model hops are at most 75, down from 116.
- Router calls are reported separately from main-agent hops, then included in total latency, token, and cost accounting.
- Combined router and main-agent tokens and estimated OpenRouter cost each fall by at least 30 percent without weakening correctness or safety.
- Wall time falls by at least 30 percent under comparable provider conditions.
- Medium reasoning remains the default until a lower-effort run passes the same correctness gate.

## Verification

Run focused cases first:

```bash
npm --prefix services/cafe-mcp test
npm --prefix services/cafe-mcp run build
./scripts/setup-hermes-eval.sh

npm --prefix evals/hermes-operations run eval -- \
  --scenario en_roast_loss \
  --reasoning medium \
  --verbose

npm --prefix evals/hermes-operations run eval -- \
  --scenario es_create_green_lot_confirmation \
  --reasoning medium \
  --verbose

npm --prefix evals/hermes-operations run eval -- \
  --scenario es_ambiguous_provider_name \
  --reasoning medium \
  --verbose
```

Then run the full gate:

```bash
npm --prefix evals/hermes-operations test
npm --prefix evals/hermes-operations run eval -- --reasoning medium --verbose
```

Commit a new reviewed, secret-free baseline under `evals/hermes-operations/baselines/`. Keep transient session IDs and raw reports in the ignored `results/` directory.

## Risks and decisions

- Patching Hermes upstream gives the strongest loop control but increases maintenance burden. Prefer profile configuration and a Cafe-owned TypeScript boundary first.
- Server-held confirmation state adds storage and expiry semantics. It is justified because exact-once writes and exact field preservation are core operational requirements.
- Read deduplication must not hide a legitimate post-write state change. Reset or version the read cache after any write attempt with an ambiguous outcome.
- Aggressive token caps can create incomplete confirmations. Tune caps only after intent routing, discovery cleanup, and prompt cleanup remove unnecessary hops.
- Cost is a secondary metric. A cheaper run that guesses a record, changes a name, skips confirmation, or writes the wrong target still fails.

## Definition of done

The ticket is complete when the full deterministic suite passes, the dynamic Cafe catalog and bounded request-specific activation are proven at runtime, confirmation executes a stored canonical operation once, no general-purpose tools appear in Cafe trajectories, and the new benchmark meets the hop and cost targets without relaxing safety assertions.

Current disposition: every functional condition above is met, as is the hop target. Keep the ticket open for cost and comparable-provider wall-time tuning; do not weaken those thresholds or trade away the passing deterministic suite.
