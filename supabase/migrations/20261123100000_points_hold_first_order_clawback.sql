-- ============================================================
-- Hook Club points: 30-day hold, first-purchase rule, refund clawback
--
-- 1. Points from an order (and referral points it triggers) can't be spent for 30 days.
-- 2. A member can't spend any points until they have one completed purchase:
--    a website order that has passed its 30-day hold, or real spend brought over
--    from the old members sheet (prior_spend > 0).
-- 3. Refunds/cancellations take points back (done by the points-shop "clawback"
--    action, hourly). A balance can go below zero; nothing can be spent until it recovers.
--
-- Nothing here touches orders, inventory, order-sync or push-stock.
-- ============================================================

-- Spend brought in from the old system, so imported members who had bought before
-- don't have to buy again. lifetime_spend minus anything credited from website orders.
alter table public.members add column if not exists prior_spend numeric not null default 0;

update public.members m
   set prior_spend = greatest(0, coalesce(m.lifetime_spend, 0) - coalesce((
         select sum(coalesce(o.total_price, o.unit_price * o.quantity))
           from public.points_ledger l
           join public.orders o on o.platform = 'squarespace' and 'order:' || o.platform_order_id = l.ref
          where l.member_id = m.id and l.reason = 'order'), 0))
 where m.prior_spend = 0;

-- One place that decides what a member can spend.
create or replace function public.points_status(p_member uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  m members%rowtype; held int; locked int; qualified boolean; first_unlock timestamptz; next_unlock timestamptz; spendable int;
begin
  select * into m from members where id = p_member;
  if not found then return null; end if;

  select coalesce(sum(points_total), 0) into held
    from points_redemptions where member_id = p_member and status = 'pending';

  -- points earned in the last 30 days (orders + referrals), less anything already taken back for those orders
  select coalesce(sum(l.change), 0), min(l.created_at) + interval '30 days'
    into locked, next_unlock
    from points_ledger l
   where l.member_id = p_member and l.change > 0
     and l.reason in ('order', 'referral')
     and l.created_at > now() - interval '30 days';
  locked := greatest(0, locked - coalesce((
      select -sum(r.change) from points_ledger r
       where r.member_id = p_member and r.reason = 'refund'
         and exists (select 1 from points_ledger o where o.member_id = p_member and o.reason = 'order'
                       and o.created_at > now() - interval '30 days'
                       and r.ref like 'refund:' || substr(o.ref, 7) || ':%')), 0));

  -- first completed purchase: an order past its hold and not fully refunded, or imported spend
  qualified := coalesce(m.prior_spend, 0) > 0 or exists (
    select 1 from points_ledger o
     where o.member_id = p_member and o.reason = 'order' and o.created_at <= now() - interval '30 days'
       and coalesce((select -sum(r.change) from points_ledger r
                      where r.member_id = p_member and r.reason = 'refund'
                        and r.ref like 'refund:' || substr(o.ref, 7) || ':%'), 0) < o.change);

  select min(o.created_at) + interval '30 days' into first_unlock
    from points_ledger o where o.member_id = p_member and o.reason = 'order';

  spendable := case when qualified
                    then greatest(0, coalesce(m.points_balance, 0) - held - least(locked, greatest(0, coalesce(m.points_balance, 0))))
                    else 0 end;

  return jsonb_build_object(
    'balance', coalesce(m.points_balance, 0),
    'held', held,
    'locked', least(locked, greatest(0, coalesce(m.points_balance, 0))),
    'qualified', qualified,
    'spendable', spendable,
    'next_unlock', next_unlock,
    'first_unlock', case when qualified then null else first_unlock end);
end $$;

revoke all on function public.points_status(uuid) from public, anon, authenticated;

-- ps_reserve: same as before, but checks spendable points instead of balance - held.
create or replace function public.ps_reserve(p_member uuid, p_email text, p_items jsonb, p_ship jsonb, p_postage_pence integer, p_postage_method text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m members%rowtype; it jsonb; v_var uuid; v_qty int; v_pts int; v_stock int; v_inv uuid;
  v_name text; v_opts text; v_sku text; total int := 0; snap jsonb := '[]'::jsonb;
  stock_out jsonb := '[]'::jsonb; r points_redemptions%rowtype; pend int; st jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_BASKET'; end if;
  if jsonb_array_length(p_items) > 10 then raise exception 'TOO_MANY_ITEMS'; end if;
  if coalesce(p_postage_pence, -1) < 0 then raise exception 'BAD_POSTAGE'; end if;

  select * into m from members where id = p_member for update;
  if not found then raise exception 'NO_MEMBER'; end if;

  st := points_status(p_member);
  if not (st->>'qualified')::boolean then raise exception 'NO_FIRST_ORDER'; end if;

  select count(*) into pend from points_redemptions where member_id = p_member and status = 'pending';
  if pend >= 3 then raise exception 'TOO_MANY_PENDING'; end if;

  perform set_config('app.stock_source', 'points_shop', true);

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

    total := total + v_pts * v_qty;
    snap := snap || jsonb_build_object(
      'variant_id', v_var, 'qty', v_qty, 'points', v_pts,
      'product_name', v_name, 'options', v_opts, 'sku', v_sku,
      'sq_product_id', it->>'sq_product_id', 'sq_variant_id', it->>'sq_variant_id',
      'unit_price', coalesce((it->>'unit_price')::numeric, 0), 'weight_g', coalesce((it->>'weight_g')::int, 0));
    stock_out := stock_out || jsonb_build_object('variant_id', v_var, 'stock', v_stock - v_qty, 'inv', v_inv);
  end loop;

  -- check points before any stock is taken
  if coalesce((st->>'spendable')::int, 0) < total then raise exception 'NOT_ENOUGH_POINTS'; end if;

  for it in select value from jsonb_array_elements(stock_out) loop
    update inventory set total_stock = (it->>'stock')::int, updated_at = now() where id = (it->>'inv')::uuid;
  end loop;
  stock_out := (select coalesce(jsonb_agg(x - 'inv'), '[]'::jsonb) from jsonb_array_elements(stock_out) x);

  insert into points_redemptions (member_id, email, items, points_total, postage_pence, postage_method, ship)
  values (p_member, lower(trim(p_email)), snap, total, p_postage_pence, p_postage_method, p_ship)
  returning * into r;

  return jsonb_build_object('ok', true, 'id', r.id, 'ref', r.ref, 'points_total', total,
                            'postage_pence', p_postage_pence, 'stock', stock_out);
end $function$;

revoke all on function public.ps_reserve(uuid, text, jsonb, jsonb, integer, text) from public, anon, authenticated;

-- Take points back for a refund. p_refunded_pence is the order's total refunded so far;
-- calling again with the same figure does nothing (ledger ref is unique).
create or replace function public.points_clawback(p_order_id text, p_order_total_pence int, p_refunded_pence int, p_cancelled boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  o points_ledger%rowtype; frac numeric; target int; done int; take int; nb int; mem members%rowtype; rl points_ledger%rowtype; ref_take int;
begin
  select * into o from points_ledger where ref = 'order:' || p_order_id and reason = 'order';
  if not found then return jsonb_build_object('ok', true, 'skip', 'no points for this order'); end if;

  frac := case when p_cancelled then 1
               when coalesce(p_order_total_pence, 0) <= 0 then 0
               else least(1, greatest(0, p_refunded_pence::numeric / p_order_total_pence)) end;
  target := round(o.change * frac);
  select coalesce(-sum(change), 0) into done from points_ledger
   where member_id = o.member_id and reason = 'refund' and ref like 'refund:' || p_order_id || ':%' and ref not like '%:ref:%';
  take := target - done;
  if take <= 0 then return jsonb_build_object('ok', true, 'skip', 'already taken back'); end if;

  update members set points_balance = points_balance - take,
         lifetime_spend = greatest(0, lifetime_spend - round(take::numeric / greatest(o.change, 1) * coalesce(nullif(substring(o.note from '£([0-9.]+)'), '')::numeric, 0), 2)),
         updated_at = now()
   where id = o.member_id returning points_balance into nb;
  insert into points_ledger (member_id, change, reason, ref, balance_after, note)
  values (o.member_id, -take, 'refund', 'refund:' || p_order_id || ':' || coalesce(p_refunded_pence, 0) || case when p_cancelled then 'c' else '' end, nb,
          case when p_cancelled then 'order cancelled' else 'order refunded £' || round(p_refunded_pence / 100.0, 2) end);

  -- A fully refunded/cancelled first order also takes back the referral points it triggered.
  if frac >= 1 then
    for rl in select * from points_ledger where reason = 'referral' and (ref = 'refpaid:' || o.member_id or ref = 'refbonus:' || o.member_id)
                 and abs(extract(epoch from (created_at - o.created_at))) < 5 loop
      if not exists (select 1 from points_ledger where ref = 'refund:' || p_order_id || ':ref:' || rl.id) then
        update members set points_balance = points_balance - rl.change, updated_at = now() where id = rl.member_id returning points_balance into nb;
        insert into points_ledger (member_id, change, reason, ref, balance_after, note)
        values (rl.member_id, -rl.change, 'refund', 'refund:' || p_order_id || ':ref:' || rl.id, nb, 'referral reversed: referred order refunded');
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'member_id', o.member_id, 'taken', take);
end $$;

revoke all on function public.points_clawback(text, int, int, boolean) from public, anon, authenticated;

-- Hourly refund check (calls points-shop "clawback" with the service key, same as the sweep).
create or replace function public.trigger_points_clawback()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare k text;
begin
  select value into k from sync_secrets where key = 'service_role_key';
  perform net.http_post(
    url := 'https://czoppjnkjxmduldxlbqh.supabase.co/functions/v1/points-shop',
    body := '{"action":"clawback"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
    timeout_milliseconds := 120000);
end $$;

select cron.unschedule('points-clawback') where exists (select 1 from cron.job where jobname = 'points-clawback');
select cron.schedule('points-clawback', '23 * * * *', 'select public.trigger_points_clawback()');
