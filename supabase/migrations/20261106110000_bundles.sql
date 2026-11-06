-- Bundles: a bundle is a normal product/variant (so it lists and syncs like any other item),
-- but it holds no stock of its own. Its stock is worked out from the items it is made of:
--   bundle stock = lowest of floor(component stock / quantity needed)
-- Each bundle option (variant) has its own list of components, so a bundle can come in sizes.
-- Additive only: no existing data is changed.

alter table public.products add column if not exists is_bundle boolean not null default false;

create table if not exists public.bundle_components (
  id uuid primary key default gen_random_uuid(),
  bundle_variant_id uuid not null references public.variants(id) on delete cascade,
  component_variant_id uuid not null references public.variants(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (bundle_variant_id, component_variant_id),
  check (bundle_variant_id <> component_variant_id)
);
create index if not exists bundle_components_component_idx on public.bundle_components (component_variant_id);

alter table public.bundle_components enable row level security;
-- Same access pattern as products/inventory: the app can read; writes happen in edge functions.
drop policy if exists "Anon read access" on public.bundle_components;
create policy "Anon read access" on public.bundle_components for select using (true);
