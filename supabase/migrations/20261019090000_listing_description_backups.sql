-- Backups of eBay listing descriptions taken before the listing converter replaces them.
create table if not exists public.listing_description_backups (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,
  title text,
  old_description text,
  new_description text,
  created_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists listing_description_backups_item_idx
  on public.listing_description_backups (item_id, created_at desc);
-- Only the edge function (service role) reads or writes this table.
alter table public.listing_description_backups enable row level security;
