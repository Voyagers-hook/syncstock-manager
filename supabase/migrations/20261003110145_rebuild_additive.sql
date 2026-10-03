-- Rebuild 2026-10: additive only (new columns + tables). Existing data untouched.
alter table public.stock_log add column if not exists reason text;
alter table public.stock_log add column if not exists note text;
create unique index if not exists processed_orders_channel_order_uidx on public.processed_orders(channel, order_id);
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  platform text, order_id text, order_number text,
  variant_id uuid, product_id uuid, item_name text,
  amount numeric, reason text, restocked boolean default false, note text,
  created_at timestamptz default now()
);
create table if not exists public.competitor_prices (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid references public.variants(id) on delete cascade,
  seller text, item_price numeric, postage numeric, delivered numeric,
  url text, checked_at timestamptz default now()
);
create index if not exists competitor_prices_variant_idx on public.competitor_prices(variant_id, checked_at desc);
