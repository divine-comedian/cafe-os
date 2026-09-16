begin;

-- A purchase can only be backfilled safely when exactly one legacy lot points to it.
do $$
begin
  if exists (
    select purchase_id
    from public.green_coffee_lots
    group by purchase_id
    having count(*) > 1
  ) then
    raise exception 'Cannot invert purchase/lot relationship: a purchase has multiple green coffee lots';
  end if;

  if exists (
    select 1
    from public.purchases p
    left join public.green_coffee_lots l on l.purchase_id = p.id
    where l.id is null
  ) then
    raise exception 'Cannot invert purchase/lot relationship: a purchase has no green coffee lot';
  end if;

  if exists (
    select 1
    from public.green_coffee_lots
    where nullif(btrim(name), '') is null
       or nullif(btrim(variety), '') is null
  ) then
    raise exception 'Cannot invert purchase/lot relationship: every green coffee lot needs a name and variety';
  end if;
end $$;

alter table public.purchases
  add column green_coffee_lot_id uuid,
  add column received_weight_kg numeric(12, 3);

update public.purchases p
set
  green_coffee_lot_id = l.id,
  received_weight_kg = l.received_weight_kg
from public.green_coffee_lots l
where l.purchase_id = p.id;

alter table public.purchases
  alter column green_coffee_lot_id set not null,
  alter column received_weight_kg set not null,
  add constraint purchases_green_coffee_lot_id_fkey
    foreign key (green_coffee_lot_id)
    references public.green_coffee_lots (id)
    on delete restrict,
  add constraint purchases_received_weight_kg_check
    check (received_weight_kg > 0);

create index purchases_green_coffee_lot_id_idx
  on public.purchases (green_coffee_lot_id);

drop index public.green_coffee_lots_purchase_id_idx;

alter table public.green_coffee_lots
  drop column purchase_id,
  drop column received_weight_kg,
  drop column unit_cost_per_kg,
  alter column name set not null,
  alter column variety set not null,
  add constraint green_coffee_lots_name_not_blank check (btrim(name) <> ''),
  add constraint green_coffee_lots_variety_not_blank check (btrim(variety) <> '');

commit;
