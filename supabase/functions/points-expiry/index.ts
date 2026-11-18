import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Weekly Hook Points expiry job.
// 1) Finds members within 30 days of their 12-month inactivity expiry who haven't been warned
//    this cycle, adds them to the MailerLite "Points Expiring Soon" group (which fires the
//    warning email), and stamps expiry_warning_sent_at so the warning counts.
// 2) Expires whole balances for members who are past expiry AND were warned >= 14 days ago —
//    but ONLY when points_expiry_enabled = 'true', so nothing is ever deducted before the
//    warning email is confirmed live. Everything is logged in points_ledger.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const ML = "https://connect.mailerlite.com/api";
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const settings = await supabase.from("sync_secrets").select("key,value")
      .in("key", ["mailerlite_api_key", "mailerlite_expiry_group", "points_expiry_enabled"]);
    const s = new Map((settings.data ?? []).map((r: any) => [r.key, r.value]));
    const mlKey = s.get("mailerlite_api_key");
    const groupId = s.get("mailerlite_expiry_group");
    const expiryEnabled = String(s.get("points_expiry_enabled") || "false") === "true";

    // ---- 1) Warnings ----
    const { data: due, error: dueErr } = await supabase.rpc("points_warnings_due", { p_days: 30 });
    if (dueErr) throw dueErr;
    let warned = 0; const warnErrors: string[] = [];
    for (const m of (due ?? [])) {
      if (!m.email) continue;
      let emailed = false;
      if (mlKey && groupId) {
        // Upsert the subscriber into the warning group (triggers the MailerLite automation).
        const r = await fetch(`${ML}/subscribers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${mlKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email: m.email, groups: [groupId], fields: { points_balance: String(m.points_balance) } }),
        });
        emailed = r.ok;
        if (!r.ok) warnErrors.push(`${m.email}: ML ${r.status}`);
      }
      // Only stamp the warning (which gates expiry) if the email actually went out.
      if (emailed) {
        await supabase.from("members").update({ expiry_warning_sent_at: new Date().toISOString() }).eq("id", m.member_id);
        warned++;
      }
    }

    // ---- 2) Expiry (gated) ----
    let expired = 0;
    if (expiryEnabled) {
      const { data: ex, error: exErr } = await supabase.rpc("expire_lapsed_points");
      if (exErr) throw exErr;
      expired = ex ?? 0;
    }

    return json({ ok: true, due: (due ?? []).length, warned, expired, expiryEnabled, warnErrors: warnErrors.slice(0, 15) });
  } catch (e: any) { return json({ error: e.message ?? String(e) }, 500); }
});
