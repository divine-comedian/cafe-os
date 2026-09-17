# Cafe OS REST API

The Cafe OS backend is a TypeScript/Fastify service at `services/cafe-api/`. It is the only application component that holds the Supabase service credential. Hermes must interact with this service rather than connecting directly to Postgres or Supabase Storage.

The service listens on `127.0.0.1:8100`. It is not exposed publicly. The local Cafe MCP adapter connects it to the allowlisted Telegram operations agent; Hermes never connects directly to Supabase.

## Operations

```bash
./scripts/cafe-api.sh start
./scripts/cafe-api.sh status
./scripts/cafe-api.sh logs
./scripts/cafe-api.sh restart
./scripts/cafe-api.sh stop
```

`scripts/configure-cafe-api.sh` creates `runtime/cafe-api.env` from the local Supabase deployment and generates a stable API bearer token. The ignored file is mode `0600`; neither credential is printed.

Health and OpenAPI endpoints do not require authentication:

```text
GET http://127.0.0.1:8100/healthz
GET http://127.0.0.1:8100/openapi.json
```

All `/v1` routes require `Authorization: Bearer …`. The bearer may be the private automation token or an access token issued by the local Supabase Auth service. User tokens are validated server-side before any service-role operation runs.

`GET /app-config.json` is public and returns only the Supabase public URL and publishable key needed by the browser. The built frontend is served at `/`.

## Resources

Each domain resource supports list, get, create, patch, and delete:

```text
/v1/providers
/v1/purchases
/v1/green-coffee-lots
/v1/roast-batches
```

The frontend purchase flow associates a purchase with an existing lot or creates a reusable lot inline:

```text
POST /v1/purchases/with-green-coffee-lot  # create active purchase
POST /v1/roast-batches/confirmed          # create confirmed roast batch
```

Only roast batches expose explicit confirmation and void actions. Purchases are active when created and have no status:

```text
POST /v1/roast-batches/{id}/confirm
PUT  /v1/roast-batches/{id}/confirm  # update fields and confirm atomically
POST /v1/roast-batches/{id}/void
```

Purchase documents use the private `purchase-documents` bucket:

```text
PUT    /v1/purchases/{id}/document
GET    /v1/purchases/{id}/document
DELETE /v1/purchases/{id}/document
```

The upload route accepts one multipart field named `file`. The service validates the file signature, generates the object path, and stores only that path on the purchase.

## MVP validation

- Unknown request fields are rejected.
- Required fields must be present.
- Labels such as region, origin, variety, and payment method are trimmed and lowercased.
- Display names are trimmed but retain capitalization.
- Notes retain internal whitespace and line breaks.
- Currency is trimmed and uppercased to a three-letter value.
- Positive/nonnegative number checks mirror the database constraints.
- Foreign-key parents are checked before writes.
- Roast input cannot exceed purchased weight for its lot minus green input reserved by other non-void roasts.
- Deletes return `409 DEPENDENCY_CONFLICT` when child records or a purchase document exist.
- PDFs, JPEGs, PNGs, WebP images, and HEIC images are accepted up to 15 MiB.

The service deliberately does not implement automatic delete cascades, duplicate-provider matching, immutable records, or a complex state machine during the MVP.

## Development checks

```bash
cd services/cafe-api
npm install
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Expose this API to Hermes only through the small Cafe MCP surface and only on an allowlisted operations profile. Do not grant the Telegram profile direct SQL, Supabase service credentials, shell, or general file access.
