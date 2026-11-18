import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Hook Club admin API for the SyncStock Members page.
// Actions: members (list/search), ledger, adjust (manual points), catalog (item picker),
// shop_set (flag/price a variant into the points shop), shop_remove.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

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

    if (action === "expiring_soon") {
      const days = Number.isFinite(Number(body.days)) ? Number(body.days) : 30;
      const { data, error } = await supabase.rpc("member_expiry_status");
      if (error) throw error;
      const rows = (data ?? [])
        .filter((r: any) => r.points_balance > 0 && r.days_left <= days)
        .sort((a: any, b: any) => a.days_left - b.days_left);
      return json({ ok: true, expiring: rows });
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
