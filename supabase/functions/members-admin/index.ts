import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Hook Club admin API for the SyncStock Members page.
// Actions: members (list/search), ledger, adjust (manual points), catalog (item picker),
// shop_set (flag/price a variant into the points shop), shop_remove,
// profile (sign-up form details for one member), birthdays_soon (dashboard reminder).

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // Everything except member_card (read by the website) needs the signed-in SyncStock admin.
    if (action !== "member_card") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = token ? await supabase.auth.getUser(token) : { data: { user: null } };
      const email = (u?.user?.email || "").toLowerCase();
      const { data: adm } = email ? await supabase.from("app_admins").select("email").eq("email", email).maybeSingle() : { data: null };
      if (!adm) return json({ error: "Please sign in to SyncStock again." }, 401);
    }

    if (action === "members") {
      const q = (body.search || "").trim();
      let query = supabase.from("members")
        .select("id,membership_number,name,email,tier,status,join_date,points_balance,lifetime_spend,spend_12m,spend_tier,discount_code,discount_used,source,email_aliases")
        .order("name", { ascending: true }).limit(2000);
      if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,membership_number.ilike.%${q}%`);
      const { data, error } = await query;
      if (error) throw error;
      return json({ ok: true, members: data ?? [] });
    }

    if (action === "member_card") {
      // Public endpoint the member-facing website page reads (SyncStock = single source of truth).
      const email = (body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "email required" }, 400);
      const { data, error } = await supabase.from("members")
        .select("id,name,email,membership_number,tier,spend_12m,spend_tier,points_balance,lifetime_spend,discount_code,discount_used")
        .or(`email.eq.${email},email_aliases.cs.{${email}}`).limit(1);
      if (error) throw error;
      const m = (data ?? [])[0];
      let orders = 0;
      if (m) {
        const { count } = await supabase.from("points_ledger")
          .select("id", { count: "exact", head: true }).eq("member_id", m.id).eq("reason", "order");
        orders = count ?? 0;
      }
      return json({ ok: true, found: !!m, member: m ? { ...m, orders_completed: orders } : null });
    }

    if (action === "expiring_soon") {
      const days = Number.isFinite(Number(body.days)) ? Number(body.days) : 30;
      const { data, error } = await supabase.rpc("member_expiry_status");
      if (error) throw error;
      const rows = (data ?? [])
        .filter((r: any) => r.points_balance > 0 && r.days_left <= days)
        .sort((a: any, b: any) => a.days_left - b.days_left);
      return json({ ok: true, expiring: rows });
    }

    if (action === "profile") {
      if (!body.member_id) return json({ error: "member_id required" }, 400);
      const { data, error } = await supabase.from("members")
        .select("parent_name,child_name,date_of_birth,fishing_style,photo_consent,location")
        .eq("id", body.member_id).maybeSingle();
      if (error) throw error;
      return json({ ok: true, profile: data ?? null });
    }

    if (action === "birthdays_soon") {
      const days = Number.isFinite(Number(body.days)) ? Math.min(60, Math.max(0, Number(body.days))) : 14;
      const { data, error } = await supabase.rpc("member_birthdays", { p_days: days });
      if (error) throw error;
      return json({ ok: true, birthdays: data ?? [] });
    }

    if (action === "ledger") {
      const { data, error } = await supabase.from("points_ledger")
        .select("id,change,reason,ref,balance_after,note,created_at")
        .eq("member_id", body.member_id).order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return json({ ok: true, ledger: data ?? [] });
    }

    if (action === "adjust") {
      const delta = Math.trunc(Number(body.delta));
      if (!body.member_id || !Number.isFinite(delta) || delta === 0) return json({ error: "member_id and non-zero whole-number delta required" }, 400);
      const { data, error } = await supabase.rpc("adjust_member_points", { p_member: body.member_id, p_delta: delta, p_note: body.note || null });
      if (error) throw error;
      return json({ ok: true, balance: data });
    }

    if (action === "catalog") {
      const { data, error } = await supabase.rpc("points_shop_catalog", { p_search: body.search || null });
      if (error) throw error;
      return json({ ok: true, items: data ?? [] });
    }

    if (action === "shop_set") {
      const pv = Math.trunc(Number(body.points_value));
      if (!body.variant_id || !Number.isFinite(pv) || pv <= 0) return json({ error: "variant_id and positive points_value required" }, 400);
      // Never allow a point price below the item's cost (COGS). 1 point = 1p, so min points = cost*100.
      const { data: vrow } = await supabase.from("variants").select("cost_price, product_id").eq("id", body.variant_id).maybeSingle();
      let cost = vrow?.cost_price ?? 0;
      if (!cost && vrow?.product_id) {
        const { data: prow } = await supabase.from("products").select("cost_price").eq("id", vrow.product_id).maybeSingle();
        cost = prow?.cost_price ?? 0;
      }
      const minPts = Math.ceil((Number(cost) || 0) * 100);
      if (minPts > 0 && pv < minPts) return json({ error: `Point price (${pv}) is below cost. Minimum is ${minPts} points (£${(minPts/100).toFixed(2)}).`, minPts }, 400);
      const active = body.active === false ? false : true;
      const { error } = await supabase.from("points_shop_items")
        .upsert({ variant_id: body.variant_id, points_value: pv, active }, { onConflict: "variant_id" });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "shop_remove") {
      if (!body.variant_id) return json({ error: "variant_id required" }, 400);
      const { error } = await supabase.from("points_shop_items").delete().eq("variant_id", body.variant_id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e: any) { return json({ error: e.message ?? String(e) }, 500); }
});
