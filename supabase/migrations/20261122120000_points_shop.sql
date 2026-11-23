-- ============================================================
-- SECURITY: sync_secrets readable by server code only (applied 22 Nov 2026).
-- Before this, the public website key could read every secret.
-- ============================================================
drop policy if exists "Service role full access" on public.sync_secrets;
create policy "Service role full access" on public.sync_secrets for all to service_role using (true) with check (true);
revoke all on table public.sync_secrets from anon, authenticated;

-- ============================================================
-- HOOK CLUB POINTS SHOP - redemptions
-- Additive only: one new table, four new functions, one settings row.
-- Nothing existing is altered.
-- 1 point = 1p.
-- ============================================================

create table if not exists public.points_redemptions (
  id               uuid primary key default gen_random_uuid(),
  ref              text not null unique default ('PS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))),
  member_id        uuid not null references public.members(id),
  email            text not null,
  items            jsonb not null,               -- snapshot: [{variant_id, sq_product_id, sq_variant_id, product_name, options, sku, qty, points, unit_price, weight_g}]
  points_total     integer not null check (points_total > 0),
  postage_pence    integer not null default 0 check (postage_pence >= 0),
  postage_method   text,
  ship             jsonb not null,               -- {name, line1, line2, city, county, postcode, phone}
  status           text not null default 'pending'
                   check (status in ('pending','paid','cancelled')),
  revolut_order_id text unique,
  revolut_state    text,
  ledger_id        uuid references public.points_ledger(id),
  sq_order_id      text,
  sq_order_number  text,
  sq_error         text,
  receipt_sent_at  timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  paid_at          timestamptz,
  cancelled_at     timestamptz
);
create index if not exists points_redemptions_member_idx on public.points_redemptions(member_id);
create index if not exists points_redemptions_pending_idx on public.points_redemptions(created_at) where status = 'pending';
alter table public.points_redemptions enable row level security;  -- no policies: service role only
revoke all on table public.points_redemptions from anon, authenticated;

-- ------------------------------------------------------------
-- RESERVE: locks member + stock rows, re-checks everything from the DB,
-- takes the units out of stock now (so they can't sell on eBay/Squarespace
-- while the member pays) and writes a pending redemption.
-- Points are NOT deducted here, only held against the member's balance.
-- p_items: [{variant_id, qty, sq_product_id, sq_variant_id, unit_price, weight_g}]
-- ------------------------------------------------------------
create or replace function public.ps_reserve(
  p_member uuid, p_email text, p_items jsonb, p_ship jsonb,
  p_postage_pence int, p_postage_method text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m members%rowtype; it jsonb; v_var uuid; v_qty int; v_pts int; v_stock int; v_inv uuid;
  v_name text; v_opts text; v_sku text; held int; total int := 0; snap jsonb := '[]'::jsonb;
  stock_out jsonb := '[]'::jsonb; r points_redemptions%rowtype; pend int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_BASKET'; end if;
  if jsonb_array_length(p_items) > 10 then raise exception 'TOO_MANY_ITEMS'; end if;
  if coalesce(p_postage_pence, -1) < 0 then raise exception 'BAD_POSTAGE'; end if;

  select * into m from members where id = p_member for update;
  if not found then raise exception 'NO_MEMBER'; end if;

  select count(*) into pend from points_redemptions where member_id = p_member and status = 'pending';
  if pend >= 3 then raise exception 'TOO_MANY_PENDING'; end if;

  perform set_config('app.stock_source', 'points_shop', true);

  -- lock in a fixed order so two baskets can't deadlock each other
  for it in select value from jsonb_array_elements(p_items) order by value->>'variant_id' loop
    v_var := (it->>'variant_id')::uuid;
    v_qty := coalesce((it->>'qty')::int, 0);
    if v_qty < 1 or v_qty > 5 then raise exception 'BAD_QTY'; end if;

    select psi.points_value into v_pts from points_shop_items psi
      where psi.variant_id = v_var and psi.active = true;
    if v_pts is null or v_pts <= 0 then raise exception 'NOT_IN_SHOP:%', v_var; end if;

    select i.id, coalesce(i.total_stock, 0) into v_inv, v_stock from inventory i where i.variant_id = v_var for update;
    if v_inv is null or v_stock < v_qty then raise exception 'OUT_OF_STOCK:%', v_var; end if;

    select p.name, nullif(trim(concat_ws(' / ', v.option1, v.option2)), ''), v.internal_sku
      into v_name, v_opts, v_sku
      from variants v join products p on p.id = v.product_id where v.id = v_var;

    update inventory set total_stock = v_stock - v_qty, updated_at = now() where id = v_inv;
    stock_out := stock_out || jsonb_build_object('variant_id', v_var, 'stock', v_stock - v_qty);

    total := total + v_pts * v_qty;
    snap := snap || jsonb_build_object(
      'variant_id', v_var, 'qty', v_qty, 'points', v_pts,
      'product_name', v_name, 'options', v_opts, 'sku', v_sku,
      'sq_product_id', it->>'sq_product_id', 'sq_variant_id', it->>'sq_variant_id',
      'unit_price', coalesce((it->>'unit_price')::numeric, 0), 'weight_g', coalesce((it->>'weight_g')::int, 0));
  end loop;

  -- points already held by this member's other unpaid checkouts
  select coalesce(sum(points_total), 0) into held from points_redemptions
    where member_id = p_member and status = 'pending';
  if coalesce(m.points_balance, 0) - held < total then raise exception 'NOT_ENOUGH_POINTS'; end if;

  insert into points_redemptions (member_id, email, items, points_total, postage_pence, postage_method, ship)
  values (p_member, lower(trim(p_email)), snap, total, p_postage_pence, p_postage_method, p_ship)
  returning * into r;

  return jsonb_build_object('ok', true, 'id', r.id, 'ref', r.ref, 'points_total', total,
                            'postage_pence', p_postage_pence, 'stock', stock_out);
end $$;

-- ------------------------------------------------------------
-- CONFIRM: the only place points ever come off for a redemption.
-- Called after Revolut confirms payment (or straight away when postage is 0).
-- Idempotent: a second call returns already=true and changes nothing.
-- ------------------------------------------------------------
create or replace function public.ps_confirm(p_id uuid, p_revolut_order_id text, p_revolut_state text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r points_redemptions%rowtype; new_bal int; lid uuid;
begin
  select * into r from points_redemptions where id = p_id for update;
  if not found then raise exception 'NO_REDEMPTION'; end if;
  if r.status = 'paid' then return jsonb_build_object('ok', true, 'already', true, 'ref', r.ref); end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'status', r.status); end if;

  update members set points_balance = points_balance - r.points_total, updated_at = now()
   where id = r.member_id and points_balance >= r.points_total
   returning points_balance into new_bal;
  if new_bal is null then return jsonb_build_object('ok', false, 'code', 'NOT_ENOUGH_POINTS'); end if;

  insert into points_ledger (member_id, change, reason, ref, balance_after, note)
  values (r.member_id, -r.points_total, 'redeem', 'redeem:' || r.ref, new_bal,
          'Points shop ' || r.ref || ': ' ||
          (select string_agg((x->>'qty') || ' x ' || (x->>'product_name'), ', ') from jsonb_array_elements(r.items) x))
  returning id into lid;

  update points_redemptions set status = 'paid', paid_at = now(), ledger_id = lid,
         revolut_order_id = coalesce(p_revolut_order_id, revolut_order_id),
         revolut_state = coalesce(p_revolut_state, revolut_state)
   where id = p_id;

  return jsonb_build_object('ok', true, 'already', false, 'ref', r.ref, 'balance_after', new_bal);
end $$;

-- ------------------------------------------------------------
-- CANCEL: releases a pending redemption and puts the stock back.
-- Never touches points (they were only held, never taken).
-- ------------------------------------------------------------
create or replace function public.ps_cancel(p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r points_redemptions%rowtype; x jsonb; s int; stock_out jsonb := '[]'::jsonb;
begin
  select * into r from points_redemptions where id = p_id for update;
  if not found then raise exception 'NO_REDEMPTION'; end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', true, 'already', true, 'status', r.status); end if;
  perform set_config('app.stock_source', 'points_shop', true);
  for x in select value from jsonb_array_elements(r.items) order by value->>'variant_id' loop
    update inventory set total_stock = coalesce(total_stock, 0) + (x->>'qty')::int, updated_at = now()
     where variant_id = (x->>'variant_id')::uuid returning total_stock into s;
    stock_out := stock_out || jsonb_build_object('variant_id', x->>'variant_id', 'stock', s);
  end loop;
  update points_redemptions set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason where id = p_id;
  return jsonb_build_object('ok', true, 'already', false, 'stock', stock_out);
end $$;

-- Only the edge function (service role) may call these.
revoke all on function public.ps_reserve(uuid, text, jsonb, jsonb, int, text) from public, anon, authenticated;
revoke all on function public.ps_confirm(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ps_cancel(uuid, text) from public, anon, authenticated;
grant execute on function public.ps_reserve(uuid, text, jsonb, jsonb, int, text) to service_role;
grant execute on function public.ps_confirm(uuid, text, text) to service_role;
grant execute on function public.ps_cancel(uuid, text) to service_role;

-- ------------------------------------------------------------
-- POSTAGE: mirrors the website's shipping table. Edit this one row if the
-- Squarespace rates change. Weights come live from Squarespace per variant.
-- ------------------------------------------------------------
insert into public.sync_secrets (key, value) values ('points_shop_postage', $json${
  "method": "Standard Shipping",
  "small": { "max_g": 100, "under_value": 20, "price": 1.99, "method": "Royal Mail 2nd Class (untracked)" },
  "bands": [ [2000, 3.99], [5000, 4.99], [10000, 6.99], [15000, 9.99], [null, 12.99] ],
  "free_over_value": 75,
  "free_store_paths": ["rods"],
  "remote": {
    "bands": [ [2000, 6.99], [5000, 7.99], [10000, 9.99], [15000, 12.99], [null, 15.99] ],
    "long_order": 10.99, "long_each": 5.99,
    "areas": ["HS","IV","KW","ZE","BT","IM","GY","JE"],
    "districts": { "AB": [31,56], "FK": [17,21], "KA": [27,28], "PA": [20,80], "PH": [15,50], "PO": [30,41], "TR": [21,25] }
  }
}$json$)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- SWEEP: every 5 minutes ask the edge function to settle unpaid checkouts with
-- Revolut (confirms paid ones; cancels any left unpaid 30+ minutes).
-- ------------------------------------------------------------
create or replace function public.trigger_points_shop_sweep()
returns void language plpgsql security definer as $$
declare k text;
begin
  if not exists (select 1 from public.points_redemptions where status = 'pending' and created_at < now() - interval '3 minutes') then
    return;
  end if;
  select value into k from public.sync_secrets where key = 'service_role_key';
  perform net.http_post(
    url := 'https://czoppjnkjxmduldxlbqh.supabase.co/functions/v1/points-shop',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || k),
    body := '{"action":"sweep"}'::jsonb);
end $$;

select cron.schedule('points-shop-sweep', '*/5 * * * *', 'select public.trigger_points_shop_sweep()');
