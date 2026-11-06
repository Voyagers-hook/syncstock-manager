-- Additive table for the Google Merchant Center feed (google-feed edge function).
-- Per Squarespace SKU: brand override, EAN/GTIN (only sent when gtin_verified), MPN, exclude flag.
-- Does not touch products / variants / inventory / channel_listings.
create table if not exists public.google_feed_attributes (
  sku text primary key,
  brand text,
  gtin text,
  gtin_verified boolean not null default false,
  mpn text,
  exclude boolean not null default false,
  notes text,
  updated_at timestamptz not null default now()
);
comment on table public.google_feed_attributes is 'Additive table for the Google Merchant Center feed: per Squarespace SKU brand, EAN/GTIN (sent only when gtin_verified), MPN and exclude flag. Does not affect inventory sync.';
alter table public.google_feed_attributes enable row level security;
