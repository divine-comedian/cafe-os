begin;

alter table public.roast_batches
  add column balance_point_temperature_c numeric(6, 2)
    check (
      balance_point_temperature_c is null
      or balance_point_temperature_c >= 0
    );

commit;
