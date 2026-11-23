import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Pushes SyncStock's own point changes (orders/manual/expiry) + spend to the Hook Club
// Google Sheet, which feeds the Clubhouse. Only sends DELTAS (the Apps Script ADDS them),
// so challenge/referral points in the sheet are never overwritten. Advances each member's
// sheet_points_synced cursor only after a successful POST, so nothing is ever lost or double-counted.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const cfg = await supabase.from("sync_secrets").select("key,value").in("key", ["sheet_webapp_url", "sheet_sync_secret"]);
    const map = new Map((cfg.data ?? []).map((r: any) => [r.key, r.value]));
    const url = map.get("sheet_webapp_url"); const secret = map.get("sheet_sync_secret");
    if (!url || !secret) throw new Error("sheet_webapp_url / sheet_sync_secret not set");

    const { data: rows, error } = await supabase.rpc("members_sheet_deltas");
    if (error) throw error;
    const all = rows ?? [];
    let pushed = 0; const errors: string[] = [];

    for (let i = 0; i < all.length; i += 50) {
      const batch = all.slice(i, i + 50);
      const members = batch.map((m: any) => ({
        membership_number: m.membership_number,
        email: m.email,
        name: m.name,
        tier: m.tier,
        points_delta: m.delta,
        spend: m.spend,
      }));
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "syncstockSync", secret, members }),
      });
      const txt = await r.text();
      let ok = false;
      try { ok = r.ok && JSON.parse(txt).ok === true; } catch { ok = false; }
      if (!ok) { errors.push(`batch ${i}: ${r.status} ${txt.slice(0, 120)}`); continue; }
      // Advance the cursor only for members we successfully pushed.
      for (const m of batch) {
        await supabase.from("members").update({ sheet_points_synced: m.attributable }).eq("id", m.id);
        pushed++;
      }
    }
    return json({ ok: true, candidates: all.length, pushed, errorCount: errors.length, errors: errors.slice(0, 10) });
  } catch (e: any) { return json({ error: e.message ?? String(e) }, 500); }
});
