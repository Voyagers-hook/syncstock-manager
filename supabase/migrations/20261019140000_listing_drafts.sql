-- Unfinished Create listing forms. Only the create-listing edge function (service role) uses it.
create table if not exists public.listing_drafts (
  id uuid primary key default gen_random_uuid(),
  title text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.listing_drafts enable row level security;
