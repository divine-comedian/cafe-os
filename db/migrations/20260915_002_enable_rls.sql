begin;

alter table public.providers enable row level security;
alter table public.purchases enable row level security;
alter table public.green_coffee_lots enable row level security;
alter table public.roast_batches enable row level security;

commit;
