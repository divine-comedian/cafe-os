# Cafe OS database

The phase-one schema intentionally contains only four application tables:

```text
providers
  └── purchases
        └── green_coffee_lots ── roast_batches
```

Each purchase belongs to exactly one green-coffee lot. A green-coffee lot is a reusable identity and can have many purchases.

Every table uses a UUID primary key and a `created_at` timestamp. Records are linked with restrictive foreign keys so operational history cannot be removed accidentally through a cascading delete.

## Tables

### `providers`

- `name`
- `region`
- `notes`

### `purchases`

- `provider_id`
- `green_coffee_lot_id`
- optional `purchased_at`
- `received_weight_kg`
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

- `name`
- optional `origin`
- optional `variety`
- optional `notes`

### `roast_batches`

- `green_coffee_lot_id`
- optional `name`
- optional business `roast_date` and exact `roasted_at` timestamp
- optional `green_input_kg` and `roasted_output_kg`
- optional `duration_seconds`
- optional JSON object `machine_settings`
- optional charge temperature, setup notes, curve checkpoints, sensory rating, tasting notes, and operator notes
- nullable `voided_at` and `void_reason` for reversal without deletion

Every stored record is active and there is no draft or confirmed status. A roast requires only its green-coffee lot at creation and can be filled in progressively. When both weights are present, roasted output cannot exceed green input. Completeness is derived from `roast_date`, `green_input_kg`, and `roasted_output_kg` rather than persisted as lifecycle state.

## Calculations

Calculations are derived from source measurements rather than stored:

```text
roast_loss_pct =
  (green_input_kg - roasted_output_kg) / green_input_kg * 100

base_roasted_cost_per_kg =
  (green_input_kg * weighted_green_unit_cost_per_kg) / roasted_output_kg

weighted_green_unit_cost_per_kg =
  sum(purchase total_amount) /
  sum(purchase received_weight_kg)

available_green_kg =
  sum(purchase received_weight_kg) -
  sum(non-voided roast green_input_kg)
```

Every purchase enters weighted cost and available supply immediately. Non-voided roast batches reserve inventory as soon as `green_input_kg` is supplied, even when other roast fields are missing. Database triggers serialize inventory-changing writes per lot and reject both excess roast input and purchase changes that would reduce supply below already-reserved roast input.

The base roasted cost excludes packaging, labor, energy, freight allocation, and other overhead.

## Security

Row Level Security is enabled on all four tables. No client policies exist yet, so the anonymous and authenticated API roles have no data access. The Storage bucket is private and likewise has no client upload/read policies. Administrative access currently goes through the local database helper:

```bash
./scripts/db.sh
```

## Migrations

The applied SQL is stored in `db/migrations/` in execution order. Do not edit an applied migration; add the next numbered migration for future changes.
