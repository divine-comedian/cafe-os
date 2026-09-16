begin;

create function public.cafe_assert_roast_inventory()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  purchased_kg numeric;
  other_reserved_kg numeric;
  available_kg numeric;
begin
  if new.status = 'void' or new.green_input_kg is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.green_coffee_lot_id::text, 0));

  select coalesce(sum(received_weight_kg), 0)
    into purchased_kg
    from public.purchases
   where green_coffee_lot_id = new.green_coffee_lot_id
     and status = 'confirmed';

  select coalesce(sum(green_input_kg), 0)
    into other_reserved_kg
    from public.roast_batches
   where green_coffee_lot_id = new.green_coffee_lot_id
     and status <> 'void'
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
before insert or update of green_coffee_lot_id, green_input_kg, status
on public.roast_batches
for each row execute function public.cafe_assert_roast_inventory();

create function public.cafe_assert_purchase_inventory()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  projected_purchased_kg numeric;
  reserved_kg numeric;
begin
  if old.status <> 'confirmed' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(old.green_coffee_lot_id::text, 0));

  select coalesce(sum(received_weight_kg), 0)
    into projected_purchased_kg
    from public.purchases
   where green_coffee_lot_id = old.green_coffee_lot_id
     and status = 'confirmed'
     and id <> old.id;

  if tg_op = 'UPDATE'
     and new.status = 'confirmed'
     and new.green_coffee_lot_id = old.green_coffee_lot_id then
    projected_purchased_kg := projected_purchased_kg + new.received_weight_kg;
  end if;

  select coalesce(sum(green_input_kg), 0)
    into reserved_kg
    from public.roast_batches
   where green_coffee_lot_id = old.green_coffee_lot_id
     and status <> 'void'
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
before delete or update of green_coffee_lot_id, received_weight_kg, status
on public.purchases
for each row execute function public.cafe_assert_purchase_inventory();

commit;
