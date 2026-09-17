# Hermes Cafe OS toolbelt

Cafe OS exposes a small TypeScript MCP server at `services/cafe-mcp`. It translates Hermes tool calls into authenticated requests to the Cafe OS REST API; it does not connect directly to Supabase.

## Tool surface

The server exposes ten Cafe-only tools:

- `discover_tools` searches the dynamic Cafe capability catalog without reading business data.
- `query_records` combines exact lookup, normalized name search, explicit match metadata, and bounded traceability expansion. Purchase reads can resolve `provider_name` together with date/status in one model-facing call.
- Four resource-specific create tools keep required fields obvious.
- `update_record` is the single typed patch tool for every resource.
- `set_record_status` confirms or voids purchases and roast batches.
- `delete_record` relies on API dependency guards.
- `upload_purchase_document` accepts only regular files beneath approved roots.

Every mutation tool is two-stage without adding separate prepare/confirm tools. A full validated call persists an exact pending proposal but does not mutate business data. After the operator approves its canonical fields, the same tool accepts only the opaque `confirmation_id`, atomically claims the stored payload, and executes it once. Completed, claimed, expired, mismatched, or cross-context proposals fail closed.

Hermes registers these as `mcp__cafe_os__<tool>`. The accompanying project skill is `.hermes/skills/cafe-os-operations/SKILL.md`.

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
- `CAFE_MCP_PENDING_TTL_MS` defaults to 15 minutes.
- `CAFE_TOOL_ROUTER_MODEL` defaults to `deepseek/deepseek-v4.1-flash`; router reasoning is disabled and its output is capped at 256 tokens.
- `CAFE_TOOL_ROUTER_TIMEOUT_MS` defaults to 20 seconds; the host subprocess allows 22 seconds so the TypeScript router can return its typed fallback cleanly when OpenRouter is slow.

The Hermes boundary limits the active catalog to five routed tools. Cafe-only discovery is exposed when the cheap router fails, returns no usable tool, or explicitly routes to discovery; a confident sufficient route does not also expose discovery. A request allows at most one discovery call. Each tool result is capped at 24,000 serialized characters and aggregate results at 48,000 characters per turn; the harness reserves at most 4,096 completion tokens per model hop and enforces an 8,192-token aggregate turn budget.

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
    trust: full
    tools:
      resources: false
      prompts: false
```

Store `CAFE_API_TOKEN` in that profile's `.env`, not in `config.yaml` or git. `trust: full` permits the adapter to execute its own two-stage mutation protocol: the first call stores an exact pending proposal without changing business data, and only a second call carrying its opaque confirmation ID can execute it. The Telegram profile must remain restricted to trusted operator IDs.

The deployed Telegram profile is private and allowlisted, so it may enable this server while keeping every general-purpose toolset disabled. After configuration, run:

```bash
hermes mcp test cafe_os
```

Start a new session inside this repository or use `/reload-mcp`. Project skills require one-time repository trust:

```bash
hermes skills trust
```

## Evaluation

Use the isolated bilingual suite in `evals/hermes-operations`; it runs the full dynamic catalog against a mock API and records routed subsets, sanitized trajectories, exact tool calls, main/router hops, tokens, and cost. See that directory’s README.
