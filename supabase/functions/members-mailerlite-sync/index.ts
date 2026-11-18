import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Auto-create Hook Club members from MailerLite sign-up groups. Idempotent: skips any email
// that already exists as a member primary email OR in email_aliases. Adult groups -> 'cast';
// LV group -> 'little_voyagers'. Processes cast groups first so an email in both a cast group
// and the LV group is kept as cast (a single membership per person).

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const ML = "https://connect.mailerlite.com/api";
const GROUPS: { id: string; tier: string }[] = [
  { id: "185087010590950513", tier: "cast" },            // Hook Club Members
  { id: "185167222081062184", tier: "cast" },            // Members
  { id: "185258985676342584", tier: "little_voyagers" }, // Little Voyagers Members
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { data: k } = await supabase.from("sync_secrets").select("value").eq("key", "mailerlite_api_key").maybeSingle();
    if (!k?.value) throw new Error("MailerLite API key not set");
    const headers = { Authorization: `Bearer ${k.value}`, Accept: "application/json" };
    let created = 0, skipped = 0, seen = 0; const errors: string[] = [];

    // Pre-load every known email (primary + aliases) so we never rely on a single-row match.
    const known = new Set<string>();
    { let from = 0; const step = 1000;
      for (;;) {
        const { data, error } = await supabase.from("members").select("email,email_aliases").range(from, from + step - 1);
        if (error) throw new Error(`load members: ${error.message}`);
        for (const m of data ?? []) {
          if (m.email) known.add(String(m.email).trim().toLowerCase());
          for (const a of (m.email_aliases ?? [])) if (a) known.add(String(a).trim().toLowerCase());
        }
        if (!data || data.length < step) break; from += step;
      }
    }

    for (const g of GROUPS) {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const url = `${ML}/groups/${g.id}/subscribers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const r = await fetch(url, { headers });
        if (!r.ok) { errors.push(`group ${g.id}: ${r.status}`); break; }
        const j = await r.json();
        const subs = j.data ?? [];
        for (const s of subs) {
          seen++;
          const email = (s.email || "").trim().toLowerCase();
          if (!email) { skipped++; continue; }
          if (known.has(email)) { skipped++; continue; } // already a member (any tier/source) or seen this run
          const f = s.fields || {};
          const name = [f.name, f.last_name].filter(Boolean).join(" ").trim() || null;
          const { error } = await supabase.from("members").insert({
            name, email, tier: g.tier, source: "mailerlite",
            discount_code: "NEWMEM10", discount_used: false,
          });
          if (error) { errors.push(`${email}: ${error.message}`); }
          else { created++; known.add(email); } // add immediately so later groups don't re-insert
        }
        cursor = j.meta?.next_cursor ?? null;
        if (!cursor) break;
      }
    }
    return json({ ok: true, seen, created, skipped, errorCount: errors.length, errors: errors.slice(0, 15) });
  } catch (e: any) { return json({ error: e.message }, 500); }
});
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
