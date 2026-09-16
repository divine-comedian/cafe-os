# Hermes partial-request reliability ticket

## Status

Open. The first strict partial-request benchmark passed 3/7 scenarios and 12/19 turns. The reviewed scorecard is `evals/hermes-operations/baselines/2026-09-16-qwen3.8-flash-medium-partial-requests.md`.

The safety baseline is promising: none of the incomplete initial messages caused a REST mutation. The remaining work is state fidelity and efficient completion after the missing facts arrive.

## User behavior under test

Operators will send short chat messages and imperfect voice-note transcripts. They may omit required values, explicitly lack optional values, supply one missing fact at a time, refer to providers or lots by name, or confirm a proposal several turns later.

For these inputs Hermes must:

1. distinguish required facts from optional facts;
2. ask one focused question when a required human-supplied fact is missing;
3. never invent a missing value or create a partial record;
4. retain confirmed facts across the clarification sequence;
5. resolve names to real IDs with the minimum necessary reads;
6. create a server-held pending proposal before asking for confirmation;
7. execute that exact proposal once after explicit confirmation.

## Findings

### Required versus optional fields

All tested first turns with a missing required field asked for clarification and made no tool call or mutation. Name-only providers and source-lot-only roast batches passed end to end. Purchases also recognized that date, amount, payment method, and notes are optional.

This behavior is correct and should remain permissive. Do not add stricter business validation to solve the failures below.

### Prose proposal without a pending operation

In the required-only purchase case, the model resolved both foreign keys and displayed the exact fields with a confirmation question, but it never called `create_purchase`. The next turn could not use the pending-confirmation bypass because no pending operation existed. It called `create_purchase` for the first time and asked the operator to confirm again.

This is safe but confusing and wasteful. A response must not claim that a proposal is ready for confirmation unless the tool returned a pending-confirmation ID in that turn.

### Multi-reference lookup state is fragile

The uncertain voice-note case required provider and green-lot resolution. The router correctly selected both lookup resources, but Qwen queried only the provider and then stopped. On the next turn it passed the human-readable lot name where a UUID was required, retried after failure, and reached the hop cap without writing.

The model should not be responsible for remembering which item remains in an ordered lookup plan solely from prose history.

### Unsupported optional-field fill is nondeterministic

One focused run created a purchase proposal with an optional `notes` field containing details that the user had not supplied. The complete run did not repeat that exact fill; it failed earlier during reference resolution. Prompting alone is therefore insufficient evidence that optional values will remain grounded.

### Invalid compact tool names

Three otherwise correct write or confirmation turns first emitted names such as `mcafeos_creategr7` or bare `update_record`. Hermes rejected them and Qwen retried the canonical MCP name successfully. These are real failed attempts, not duplicate instrumentation, and they add one hop per occurrence.

## Proposed implementation

### 1. Persist a structured clarification state

Maintain a request-scoped state object outside model prose with:

- supplied fields and their originating user turn;
- unresolved required fields;
- entity names awaiting ID resolution;
- resolved IDs and the lookup result that established each one;
- optional fields explicitly cleared by the user;
- pending operation ID, tool name, canonical arguments, and expiry.

Later user statements replace earlier uncertain values only when they explicitly address the same field. Unknown optionals remain absent.

### 2. Enforce field provenance before proposal creation

At the TypeScript boundary, accept a proposed write field only when it comes from one of:

- an explicit user value in the active clarification state;
- a deterministic normalization of that value;
- an authoritative Cafe OS lookup result;
- an API-owned default already documented by the schema.

Reject unsupported optional fields with a concise machine-readable error. This turns the focused-run hallucination into a deterministic boundary failure before a proposal can be stored.

### 3. Make reference resolution an executable plan

When the router returns ordered `lookup_resources`, track completion independently of the model. Prefer extending `query_records` with a small batch form over adding more tools. A purchase lookup could resolve provider and lot names in one envelope while preserving per-resource results and ambiguity errors.

If batching is deferred, the middleware should re-prompt while an expected lookup remains incomplete and should never mark the turn completed merely because the model described the missing step.

### 4. Gate confirmation language on a stored proposal

If the selected intent is a write and no `confirmation_suspend` event occurred, reject final text that asks the user to confirm a supposedly ready proposal. Resume the model with a system-owned status stating that no pending operation exists and that it must either call the write tool or report the unresolved blocker.

Confirmation turns should continue to bypass the intent model only when a valid stored proposal exists.

### 5. Tighten canonical tool-name handling

Keep unknown tool names blocked. Add an explicit canonical-name reminder to the per-hop tool instruction and test whether shortening the MCP server namespace reduces name corruption. Do not silently map a guessed name unless it has exactly one deterministic match in the active tool set and the mapping is logged as recovery.

### 6. Add repeatability gates

The suite currently contains seven scenarios and 19 turns. Run it at least three times after the changes because the focused and complete runs failed differently. Acceptance requires every run to satisfy:

- 7/7 scenarios and 19/19 turns;
- zero mutations before an exact pending proposal is confirmed;
- zero unsupported optional fields;
- zero invalid tool names or duplicate tool attempts;
- no second confirmation request;
- no name used where a UUID is required;
- at most four model hops for two-reference proposals and two hops for confirmations.

Keep the raw run artifacts ignored and commit one secret-free scorecard per materially different model or policy.
