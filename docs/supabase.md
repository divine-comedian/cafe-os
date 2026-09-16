# Self-hosted Supabase

Cafe OS runs the official Supabase Docker deployment from `supabase/`. The generated directory contains secrets and persistent state and is intentionally ignored by the project repository.

## Installed deployment

- Supabase self-hosted release: `v0.8.1`
- PostgreSQL: `17.6`
- Compose project: `supabase`
- Studio/API gateway: `http://127.0.0.1:8000`
- Session-mode pooler: `127.0.0.1:5432`
- Transaction-mode pooler: `127.0.0.1:6543`
- Public Auth signup: disabled during database design
- Analytics/Logflare: not enabled
- Application tables in `public`: `providers`, `purchases`, `green_coffee_lots`, and `roast_batches`

The deployment uses generated asymmetric signing keys and rotated credentials. Its `.env` is owner-readable only (`0600`). Do not copy values from that file into Git, chat, tickets, or logs.

## Database access

Open an interactive Postgres shell without reading or copying the password:

```bash
./scripts/db.sh
```

Run a one-shot query:

```bash
./scripts/db.sh -Atc 'select current_database(), version();'
```

This helper enters the database container and connects over its local Unix socket. It does not require `psql` or a password on the host.

## Service operations

```bash
cd supabase
sh run.sh start
sh run.sh stop
docker compose ps
sh run.sh logs db
```

Containers use `restart: unless-stopped`, so the stack returns when Docker starts unless an operator explicitly stops it.

## Studio on a headless server

Studio is deliberately not exposed to the public network. From a workstation, create an SSH tunnel:

```bash
ssh -N -L 8000:127.0.0.1:8000 chaperzcommand@SERVER_IP
```

Then open `http://127.0.0.1:8000` in the workstation browser. Retrieve the generated Studio username/password directly on the server when needed:

```bash
cd supabase
sh run.sh secrets
```

That command prints credentials to the terminal. Do not paste its output into chat.

## Application-data boundary

Supabase creates its built-in schemas, roles, extensions, and Auth/Storage/Realtime metadata. Cafe OS adds four application tables and the private `purchase-documents` bucket through the tracked migrations in `db/migrations/`. See `docs/database.md` for the current application shape.

## Before production use

- Create a least-privilege application/agent role instead of using `postgres`.
- Configure tested, off-host database and storage backups.
- Configure SMTP before enabling email-based Auth.
- Put a TLS reverse proxy in front of the gateway before any public exposure.
- Review Auth redirect URLs, CORS, signup policy, and rate limits.
- Document credential rotation and recovery procedures.

Follow the official [Supabase Docker self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker) for updates and production hardening.
