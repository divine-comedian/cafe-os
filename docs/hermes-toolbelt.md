# Hermes Cafe OS toolbelt

Cafe OS exposes a small TypeScript MCP server at `services/cafe-mcp`. It translates Hermes tool calls into authenticated requests to the Cafe OS REST API; it does not connect directly to Supabase.

## Tool surface

The server exposes nine tools:

- `query_records` combines exact lookup and filtered listing.
- Four resource-specific create tools keep required fields obvious.
- `update_record` is the single typed patch tool for every resource.
- `set_record_status` confirms or voids purchases and roast batches.
- `delete_record` relies on API dependency guards.
- `upload_purchase_document` accepts only regular files beneath approved roots.

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
    trust: untrusted
    tools:
      include:
        - query_records
        - create_provider
        - create_purchase
        - create_green_coffee_lot
        - create_roast_batch
        - update_record
        - set_record_status
        - delete_record
        - upload_purchase_document
      resources: false
      prompts: false
```

Store `CAFE_API_TOKEN` in that profile's `.env`, not in `config.yaml` or git. `trust: untrusted` makes Hermes request approval for every tool lacking `readOnlyHint: true`, adding a runtime gate around database writes.

Do not add this MCP server to the current public Telegram profile. Create a private operations profile with an allowlist first, then enable the server there. After configuration, run:

```bash
hermes mcp test cafe_os
```

Start a new session inside this repository or use `/reload-mcp`. Project skills require one-time repository trust:

```bash
hermes skills trust
```

## Read-only rollout

For the safest first live test, expose only:

```yaml
tools:
  include: [query_records]
  resources: false
  prompts: false
```

Expand the allowlist after the private profile and approval flow are verified.
