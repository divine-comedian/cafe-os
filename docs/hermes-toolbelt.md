# Hermes Cafe OS toolbelt

Cafe OS exposes TypeScript MCP servers from `services/cafe-mcp`. The operations server translates Hermes tool calls into authenticated requests to the Cafe OS REST API; it does not connect directly to Supabase. A separate local server manages the private voice vocabulary without accessing the Cafe API.

## Tool surface

The server exposes ten Cafe-only tools:

- `discover_tools` searches the dynamic Cafe capability catalog without reading business data.
- `query_records` combines exact lookup, normalized name search, explicit match metadata, and bounded traceability expansion. Before any provider-related write, the harness requires one unfiltered provider query (up to 100 rows) so the main model sees every provider name and region. A plausible semantic, spelling, or voice-transcription match requires a human clarification and no mutation; an exact normalized duplicate cannot produce a provider proposal. Filtered name searches remain available for other records and read-only purchase queries.
- Four resource-specific create tools keep required fields obvious.
- `update_record` is the single typed patch tool for every resource.
- `void_roast_batch` marks an erroneous roast void without deleting it. Records have no draft or confirmed status and are active when created.
- `delete_record` relies on API dependency guards.
- `upload_purchase_document` accepts only regular files beneath approved roots.

Every mutation tool is two-stage without adding separate prepare/confirm tools. A full validated call persists an exact pending proposal but does not mutate business data. After the operator approves its canonical fields, the same tool accepts only the opaque `confirmation_id`, atomically claims the stored payload, and executes it once. Completed, claimed, expired, mismatched, or cross-context proposals fail closed.

The dashboard's live roast timer is browser-local and has no MCP control: the agent cannot start, pause, resume, or reset it. The toolbelt can persist confirmed roast duration, charge temperature, balance-point temperature, pre-roast notes, sensory rating, tasting notes, and control points. `balance_point_temperature_c` is the optional observed minimum temperature after charge where the falling roast curve begins to rise; it is distinct from charge and checkpoint temperatures and must not be inferred. Duration and control-point elapsed time use whole seconds; weight fields use kilograms. Each control point has elapsed time plus optional temperature, machine-relative airflow/`tiro`, gas, and note. Updating `checkpoints` replaces the full array, so the agent must first read the exact roast and preserve unchanged points.

Hermes registers these as `mcp__cafe_os__<tool>`. The accompanying project skill is `.hermes/skills/cafe-os-operations/SKILL.md`.

The voice-vocabulary server registers three tools under `mcp__voice_vocabulary__`: `list_entries`, `upsert_entry`, and `remove_entry`. A canonical term is sufficient for normal use because the resolver performs conservative bilingual phonetic matching; optional aliases handle exceptional cases. `upsert_entry` writes immediately without confirmation when the operator states a durable term or the agent resolves an exact Cafe entity. Removal retains the two-turn pending-confirmation protocol. The server writes a permission-restricted JSON file atomically; it never edits the transcript or learns solely from an unverified suggestion.

## Build and test

```bash
cd services/cafe-mcp
npm install
npm run typecheck
npm test
npm run build
```

## Environment

- `CAFE_API_TOKEN` is required and must equal the REST API token.
- `CAFE_API_URL` defaults to `http://127.0.0.1:8100`.
- `CAFE_MCP_REQUEST_TIMEOUT_MS` defaults to `15000`.
- `CAFE_MCP_UPLOAD_ROOTS` is a colon-separated allowlist. It defaults to the active Hermes cache directory, where inbound Telegram and Discord attachments are stored.
- `CAFE_MCP_STATE_DIR` stores permission-restricted pending-operation envelopes. Set it to a persistent directory in the Hermes profile.
- `CAFE_MCP_CONTEXT_ID` binds pending operations to the trusted operator profile; Hermes additionally binds confirmation IDs to the active session transcript.
- `CAFE_MCP_PENDING_TTL_MS` defaults to 7 days. Pending proposals survive gateway restarts because their envelopes live in the persistent profile state directory.
- `CAFE_TOOL_ROUTER_MODEL` defaults to `deepseek/deepseek-v4.1-flash`; router reasoning is disabled and its output is capped at 256 tokens.
- `CAFE_TOOL_ROUTER_TIMEOUT_MS` defaults to 20 seconds; the host subprocess allows 22 seconds so the TypeScript router can return its typed fallback cleanly when OpenRouter is slow.
- `CAFE_TOOL_VISIBILITY_MODE` selects `full` or `routed`. The trusted Telegram deployment uses `full`, which bypasses the intent-classifier call and exposes all ten Cafe schemas to the main model. The eval profile defaults to `routed` for historical comparisons.
- `CAFE_FULL_CATALOG_HOP_CAP` defaults to 20 and applies only in `full` mode. The aggregate completion-token and tool-result budgets still stop runaway turns earlier.
- `VOICE_VOCABULARY_PATH` points to the private vocabulary JSON used by both the STT adapter and vocabulary MCP server.
- `VOICE_VOCABULARY_PENDING_DIR` stores pending vocabulary changes, and `VOICE_VOCABULARY_CONTEXT_ID` binds them to the trusted operator profile.

In the trusted Telegram deployment, the main model sees the complete ten-tool Cafe catalog on every ordinary turn. This removes classifier omissions when a request changes from a lookup into a write. A pending-confirmation turn first exposes only the exact mutation tool and opaque confirmation ID stored for that session. After the operator confirms, that approval remains active for the rest of the same model turn so the agent can complete every related non-destructive create, update, or evidence-upload action that was already listed in the confirmation prompt. Follow-on proposals are executed through the same persisted two-stage protocol without another user round trip. The grant ends with the turn, permits at most eight successful writes, and never covers deletes or voiding a roast; those always require their own explicit approval. General-purpose Hermes tools remain unavailable. In optional `routed` mode, the boundary limits the active catalog to five classifier-selected tools and uses Cafe-only discovery as its fallback. In either mode, a request allows at most one discovery call. Each tool result is capped at 24,000 serialized characters and aggregate results at 48,000 characters per turn; the harness reserves at most 4,096 completion tokens per model hop and enforces an 8,192-token aggregate turn budget.

The configured GLM model is availability insurance only. The Cafe plugin permits fallback from the primary Qwen model for rate limiting, model-not-found/unavailable responses, retryable upstream 5xx overloads, and transport timeouts. Content/format errors, malformed tool calls, authentication, billing, validation, and poor semantic decisions fail on Qwen and are logged without a GLM quality retry.

In full-catalog mode, every UUID used by a mutation proposal must have been returned by `query_records` in that same user turn. This prevents a model from inventing or reusing a stale record ID. `update_record` also preflights the target through the REST API before storing a pending proposal. Failed or completed confirmations close the stored proposal so a later “yes” cannot retry it. These IDs remain internal tool arguments: user-facing replies name records and omit UUIDs, confirmation IDs, request IDs, raw tool calls, and raw tool errors unless the operator explicitly requests diagnostics.

The upload adapter resolves symlinks before checking the allowlist. It refuses directories and paths outside the configured roots, preventing an agent-supplied path from turning into arbitrary host-file access.

## Trusted Hermes profile configuration

Build the server first, then add this only to a trusted operations profile:

```yaml
mcp_servers:
  cafe_os:
    command: node
    args:
      - "${workspaceFolder}/services/cafe-mcp/dist/server.js"
    env:
      CAFE_API_URL: "http://127.0.0.1:8100"
      CAFE_API_TOKEN: "${CAFE_API_TOKEN}"
      CAFE_MCP_UPLOAD_ROOTS: "${userHome}/.hermes/cache"
      CAFE_MCP_STATE_DIR: "${userHome}/.hermes/state/cafe-mcp"
      CAFE_MCP_CONTEXT_ID: "cafe-operations"
      CAFE_MCP_PENDING_TTL_MS: "604800000"
    trust: full
    tools:
      resources: false
      prompts: false
```

Store `CAFE_API_TOKEN` in that profile's `.env`, not in `config.yaml` or git. `trust: full` permits the adapter to execute its own two-stage mutation protocol: the first call stores an exact pending proposal without changing business data, and only a second call carrying its opaque confirmation ID can execute it. The Telegram profile must remain restricted to trusted operator IDs.

The deployed Telegram profile is private and allowlisted, so it may enable these servers while keeping every general-purpose toolset disabled. After configuration, run:

```bash
hermes mcp test cafe_os
hermes mcp test voice_vocabulary
```

Start a new session inside this repository or use `/reload-mcp`. Project skills require one-time repository trust:

```bash
hermes skills trust
```

## Evaluation

Use the isolated bilingual suite in `evals/hermes-operations`; it runs the full dynamic catalog against a mock API and records routed subsets, sanitized trajectories, exact tool calls, main/router hops, tokens, and cost. See that directory’s README.
