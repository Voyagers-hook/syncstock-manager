-- Lock SyncStock data to the signed-in admin (Supabase Auth). Applied 23/11/2026 after the
-- new sign-in screen went live. Edge functions, cron jobs and the website use the service role
-- key, which bypasses RLS, so they are unaffected. Public website tables (settings,
-- category_featured_products, chatbot_product_knowledge) are untouched.
-- To add another admin: insert into public.app_admins (email) values ('name@example.com');
create table if not exists public.app_admins (email text primary key);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;
insert into public.app_admins (email) values ('info@voyagershook.com') on conflict do nothing;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from app_admins where email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['products','variants','inventory','channel_listings','orders','refunds','stock_log','merge_history',
                           'competitor_prices','bundle_components','sync_log','members','points_ledger','points_shop_items',
                           'processed_orders','redemptions'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
