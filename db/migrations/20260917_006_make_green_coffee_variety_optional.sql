begin;

alter table public.green_coffee_lots
  alter column variety drop not null;

commit;
