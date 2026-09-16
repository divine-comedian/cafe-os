begin;

create table public.providers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  region text,
  notes text,
  created_at timestamptz not null default now()
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete restrict,
  purchased_at date not null,
  status text not null default 'draft'
    check (status in ('draft', 'confirmed', 'void')),
  total_amount numeric(14, 2)
    check (total_amount is null or total_amount >= 0),
  currency text not null default 'MXN'
    check (currency ~ '^[A-Z]{3}$'),
  payment_method text,
  document_path text,
  notes text,
  created_at timestamptz not null default now(),
  constraint confirmed_purchase_has_total
    check (status <> 'confirmed' or total_amount is not null)
);

create table public.green_coffee_lots (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases (id) on delete restrict,
  name text,
  origin text,
  variety text,
  received_weight_kg numeric(12, 3) not null
    check (received_weight_kg > 0),
  unit_cost_per_kg numeric(14, 4) not null
    check (unit_cost_per_kg >= 0),
  notes text,
  created_at timestamptz not null default now()
);

create table public.roast_batches (
  id uuid primary key default gen_random_uuid(),
  green_coffee_lot_id uuid not null
    references public.green_coffee_lots (id) on delete restrict,
  name text,
  roasted_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft', 'confirmed', 'void')),
  green_input_kg numeric(12, 3)
    check (green_input_kg is null or green_input_kg > 0),
  roasted_output_kg numeric(12, 3)
    check (roasted_output_kg is null or roasted_output_kg > 0),
  duration_seconds integer
    check (duration_seconds is null or duration_seconds >= 0),
  machine_settings jsonb
    check (machine_settings is null or jsonb_typeof(machine_settings) = 'object'),
  notes text,
  created_at timestamptz not null default now(),
  constraint confirmed_roast_is_complete check (
    status <> 'confirmed'
    or (
      roasted_at is not null
      and green_input_kg is not null
      and roasted_output_kg is not null
      and roasted_output_kg <= green_input_kg
    )
  )
);

create index purchases_provider_id_idx
  on public.purchases (provider_id);

create index green_coffee_lots_purchase_id_idx
  on public.green_coffee_lots (purchase_id);

create index roast_batches_green_coffee_lot_id_idx
  on public.roast_batches (green_coffee_lot_id);

insert into storage.buckets (id, name, public, allowed_mime_types)
values (
  'purchase-documents',
  'purchase-documents',
  false,
  array[
    'application/pdf',
    'image/heic',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
