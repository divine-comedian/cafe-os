begin;

alter table public.purchases
  alter column purchased_at drop not null;

commit;
