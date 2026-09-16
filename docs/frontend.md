# Cafe OS frontend

The MVP frontend is a responsive React application in `services/cafe-web/`. It is built into the Cafe API container and served from the same loopback-only port as the REST API.

## Authentication model

Self-hosted Supabase Auth provides email/password sessions. Public signup remains disabled, so access is invite-only.

The browser receives only these safe settings from `GET /app-config.json`:

- `SUPABASE_PUBLIC_URL`
- `SUPABASE_PUBLISHABLE_KEY`

The Supabase service-role key and the Cafe API automation token never enter the browser. The browser uses the Supabase access token for `/v1` requests; the Cafe API validates that token with Supabase Auth before it uses its service credential to access operational data. Direct browser access to the four application tables remains blocked by RLS.

The existing static `CAFE_API_TOKEN` continues to work for the private MCP integration.

## Create an operator

The installed Supabase stack already has email Auth enabled and public signup disabled. Create a confirmed operator from the server:

```bash
./scripts/create-cafe-user.sh operator@example.com
```

The script prompts silently for a temporary password and does not print or persist it. Share it through an approved private channel and ask the operator to change it through an administrator until password-recovery SMTP and the account-settings screen are added.

You can also create a user through Supabase Studio under Authentication > Users. Do not enable public signup for this internal MVP.

## Configure and run

Generate the ignored API runtime environment from the local Supabase deployment:

```bash
./scripts/configure-cafe-api.sh
```

For the current headless, loopback-only deployment, start the integrated application:

```bash
docker compose -f compose.cafe.yml up -d --build
```

Forward both the application and Supabase gateway from a workstation:

```bash
ssh -N \
  -L 8100:127.0.0.1:8100 \
  -L 8000:127.0.0.1:8000 \
  chaperzcommand@SERVER_IP
```

Then open `http://127.0.0.1:8100` in the workstation browser. The second tunnel is required because the browser signs in against the self-hosted Auth endpoint at `SUPABASE_PUBLIC_URL`.

For production access, put both services behind a TLS reverse proxy and set these Supabase values to browser-reachable HTTPS URLs before regenerating the Cafe API environment:

- `SUPABASE_PUBLIC_URL`
- `API_EXTERNAL_URL`
- `SITE_URL`

## Local development

Run the API:

```bash
cd services/cafe-api
npm install
npm run dev
```

In another terminal, run the frontend:

```bash
cd services/cafe-web
npm install
npm run dev
```

Vite serves `http://127.0.0.1:5173` and proxies API/config requests to port `8100`. Supabase Auth still uses the public URL returned by the API, normally port `8000`.

## MVP workflows

The interface keeps required entry fields short and shows an exact review step before every write:

- Provider: name and optional region.
- Purchase: provider, total, received weight, optional date/payment method, and either an existing green-coffee lot or a new lot entered inline. Several purchases can select the same lot.
- Green-coffee lot: name, variety, and optional origin. Weight and amount belong to purchases rather than the reusable lot identity.
- Roast batch: lot, timestamp, green input, roasted output, and optional duration.

Purchases and roast batches are created as drafts. Confirming either record is a separate action with its own review dialog.

The UI derives but does not persist:

```text
weighted_green_unit_cost_per_kg =
  sum(confirmed purchase amounts) ÷ sum(confirmed purchased weights)

roast_loss_pct =
  (green_input_kg - roasted_output_kg) / green_input_kg × 100

roast_yield_pct =
  roasted_output_kg / green_input_kg × 100

base_roasted_cost_per_kg =
  (green_input_kg × weighted_green_unit_cost_per_kg) / roasted_output_kg
```

Draft and void purchases do not affect cost or confirmed green weight. Base roasted cost excludes packaging, labor, energy, freight allocation, and other overhead.

## Checks

```bash
cd services/cafe-web
npm run typecheck
npm run build

cd ../cafe-api
npm run typecheck
npm test
npm run build

cd ../..
docker compose -f compose.cafe.yml config
```
