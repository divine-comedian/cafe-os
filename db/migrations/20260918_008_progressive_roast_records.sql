begin;

drop trigger if exists roast_batches_inventory_guard on public.roast_batches;
drop trigger if exists purchases_inventory_guard on public.purchases;

alter table public.roast_batches
  add column roast_date date,
  add column charge_temperature_c numeric(6, 2)
    check (charge_temperature_c is null or charge_temperature_c >= 0),
  add column setup_notes text,
  add column checkpoints jsonb not null default '[]'::jsonb
    check (jsonb_typeof(checkpoints) = 'array'),
  add column sensory_rating smallint
    check (sensory_rating is null or sensory_rating between 1 and 5),
  add column tasting_notes text,
  add column voided_at timestamptz,
  add column void_reason text,
  add column updated_at timestamptz not null default now();

update public.roast_batches
set roast_date = (roasted_at at time zone 'America/Mexico_City')::date
where roasted_at is not null;

update public.roast_batches
set
  voided_at = now(),
  void_reason = 'Migrated from legacy void status'
where status = 'void';

alter table public.roast_batches
  drop constraint if exists confirmed_roast_is_complete,
  drop constraint if exists roast_batches_status_check,
  drop column status,
  add constraint roast_batch_output_not_above_input check (
    green_input_kg is null
    or roasted_output_kg is null
    or roasted_output_kg <= green_input_kg
  ) not valid,
  add constraint roast_batch_void_reason_not_blank check (
    void_reason is null or btrim(void_reason) <> ''
  );

create index roast_batches_roast_date_idx
  on public.roast_batches (roast_date desc, created_at desc);

create or replace function public.cafe_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger roast_batches_touch_updated_at
before update on public.roast_batches
for each row execute function public.cafe_touch_updated_at();

create or replace function public.cafe_assert_roast_inventory()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  purchased_kg numeric;
  other_reserved_kg numeric;
  available_kg numeric;
begin
  if new.voided_at is not null or new.green_input_kg is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.green_coffee_lot_id::text, 0));

  select coalesce(sum(received_weight_kg), 0)
    into purchased_kg
    from public.purchases
   where green_coffee_lot_id = new.green_coffee_lot_id;

  select coalesce(sum(green_input_kg), 0)
    into other_reserved_kg
    from public.roast_batches
   where green_coffee_lot_id = new.green_coffee_lot_id
     and voided_at is null
     and green_input_kg is not null
     and id <> new.id;

  available_kg := purchased_kg - other_reserved_kg;
  if new.green_input_kg > available_kg then
    raise exception 'Green input % kg exceeds the % kg available for lot %',
      new.green_input_kg, greatest(available_kg, 0), new.green_coffee_lot_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger roast_batches_inventory_guard
before insert or update of green_coffee_lot_id, green_input_kg, voided_at
on public.roast_batches
for each row execute function public.cafe_assert_roast_inventory();

create or replace function public.cafe_assert_purchase_inventory()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  projected_purchased_kg numeric;
  reserved_kg numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(old.green_coffee_lot_id::text, 0));

  select coalesce(sum(received_weight_kg), 0)
    into projected_purchased_kg
    from public.purchases
   where green_coffee_lot_id = old.green_coffee_lot_id
     and id <> old.id;

  if tg_op = 'UPDATE'
     and new.green_coffee_lot_id = old.green_coffee_lot_id then
    projected_purchased_kg := projected_purchased_kg + new.received_weight_kg;
  end if;

  select coalesce(sum(green_input_kg), 0)
    into reserved_kg
    from public.roast_batches
   where green_coffee_lot_id = old.green_coffee_lot_id
     and voided_at is null
     and green_input_kg is not null;

  if reserved_kg > projected_purchased_kg then
    raise exception 'Purchase change would leave lot % with % kg purchased but % kg reserved for roasting',
      old.green_coffee_lot_id, projected_purchased_kg, reserved_kg
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger purchases_inventory_guard
before delete or update of green_coffee_lot_id, received_weight_kg
on public.purchases
for each row execute function public.cafe_assert_purchase_inventory();

commit;
