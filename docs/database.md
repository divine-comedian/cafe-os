# Cafe OS database

The phase-one schema intentionally contains only four application tables:

```text
providers
  └── purchases
        └── green_coffee_lots
              └── roast_batches
```

Every table uses a UUID primary key and a `created_at` timestamp. Records are linked with restrictive foreign keys so operational history cannot be removed accidentally through a cascading delete.

## Tables

### `providers`

- `name`
- `region`
- `notes`

### `purchases`

- `provider_id`
- `purchased_at`
- `status`: `draft`, `confirmed`, or `void`
- `total_amount`
- `currency`, defaulting to `MXN`
- `payment_method`
- `document_path`
- `notes`

`document_path` is an object path inside the private `purchase-documents` Storage bucket, not a public or signed URL. Use this convention:

```text
providers/{provider_id}/purchases/{purchase_id}/{filename}
```

### `green_coffee_lots`

- `purchase_id`
- optional `name`
- `origin`
- `variety`
- `received_weight_kg`
- `unit_cost_per_kg`
- `notes`

### `roast_batches`

- `green_coffee_lot_id`
- optional `name`
- `roasted_at`
- `status`: `draft`, `confirmed`, or `void`
- `green_input_kg`
- `roasted_output_kg`
- `duration_seconds`
- optional JSON object `machine_settings`
- `notes`

A confirmed purchase must have a total. A confirmed roast must have its timestamp and both weights, and roasted output cannot exceed green input.

## Calculations

Calculations are derived from source measurements rather than stored:

```text
roast_loss_pct =
  (green_input_kg - roasted_output_kg) / green_input_kg * 100

base_roasted_cost_per_kg =
  (green_input_kg * unit_cost_per_kg) / roasted_output_kg
```

The base roasted cost excludes packaging, labor, energy, freight allocation, and other overhead.

## Security

Row Level Security is enabled on all four tables. No client policies exist yet, so the anonymous and authenticated API roles have no data access. The Storage bucket is private and likewise has no client upload/read policies. Administrative access currently goes through the local database helper:

```bash
./scripts/db.sh
```

## Migrations

The applied SQL is stored in `db/migrations/` in execution order. Do not edit an applied migration; add the next numbered migration for future changes.
