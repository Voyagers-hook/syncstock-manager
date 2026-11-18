import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Password-protected store for 3rd-party API keys (QuickFile, SendCloud, Parcel2Go, DPD, Revolut).
// Never returns stored secret values to the browser — only whether each is set.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const APP_PW = "VoyagersHook25!"; // same gate as the app login

// Allowed keys the box can set.
const FIELDS = [
  "quickfile_account_number", "quickfile_api_key", "quickfile_app_id",
  "sendcloud_public_key", "sendcloud_secret_key",
  "parcel2go_client_id", "parcel2go_client_secret",
  "dpd_username", "dpd_password", "dpd_account_number",
  "revolut_api_key",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");
    const { data: pwRow } = await supabase.from("sync_secrets").select("value").eq("key", "connections_password").maybeSingle();
    const expected = pwRow?.value || APP_PW;
    if (String(body.password || "") !== expected) return json({ error: "Wrong password." }, 401);

    if (action === "save") {
      const values = (body.values || {}) as Record<string, string>;
      const rows: any[] = [];
      const now = new Date().toISOString();
      for (const f of FIELDS) {
        const v = values[f];
        if (typeof v === "string" && v.trim() !== "") rows.push({ key: f, value: v.trim(), updated_at: now });
      }
      if (rows.length) await supabase.from("sync_secrets").upsert(rows, { onConflict: "key" });
      return json({ ok: true, saved: rows.map((r) => r.key), set: await statusMap(supabase) });
    }

    return json({ ok: true, set: await statusMap(supabase) });
  } catch (e: any) { return json({ error: e.message }, 500); }
});

async function statusMap(supabase: any): Promise<Record<string, boolean>> {
  const { data } = await supabase.from("sync_secrets").select("key, value").in("key", FIELDS);
  const have = new Map<string, string>((data ?? []).map((r: any) => [r.key, r.value]));
  const out: Record<string, boolean> = {};
  for (const f of FIELDS) out[f] = !!(have.get(f) && String(have.get(f)).trim() !== "");
  return out;
}

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
