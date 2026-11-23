import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Auto-create Hook Club members from MailerLite sign-up groups (runs hourly).
// - New email in a group -> new member with that group's plan. The database then adds the
//   sign-up points automatically (trg_members_signup_bonus: Cast/LV 100, Strike 300, Specimen 500).
// - Paid plans: put each paid group's id in sync_secrets "members_paid_groups" as
//   {"strike":"<group id>","specimen":"<group id>"}. An existing member found in a paid group is
//   moved up to that plan, and the database tops their sign-up points up to the difference.
// - Paid groups are read first, so a new paid member is created on the right plan; then Cast,
//   then Little Voyagers (one membership per person).
// - Saves referred_by from the sign-up form so referral points can be paid on the first order.
// - Copies the sign-up form details onto the member every run (new and existing members):
//   parent's name, child's name, date of birth, fishing style, photo consent and location.
//   Blank form values never wipe what's already saved. Older Little Voyagers sign-ups had the
//   date of birth in "company" and photo consent in "membership_type"; those are read as a fallback.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const ML = "https://connect.mailerlite.com/api";
const BASE_GROUPS: { id: string; tier: string }[] = [
  { id: "185087010590950513", tier: "cast" },            // Hook Club Members
  { id: "185167222081062184", tier: "cast" },            // Members
  { id: "185258985676342584", tier: "little_voyagers" }, // Little Voyagers Members
];
const RANK: Record<string, number> = { little_voyagers: 0, cast: 1, strike: 2, specimen: 3 };
const PROFILE_COLS = ["parent_name", "child_name", "date_of_birth", "fishing_style", "photo_consent", "location"] as const;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDob(v: unknown): string | null {
  const t = String(v ?? "").trim(); if (!t) return null;
  let y = 0, m = 0, d = 0, mm: RegExpMatchArray | null;
  if ((mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = t.match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})$/))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; if (y < 100) y += y > 30 ? 1900 : 2000; }
  else if ((mm = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})$/i))) { d = +mm[1]; m = MONTHS[mm[2].slice(0, 3).toLowerCase()] ?? 0; y = +mm[3]; }
  else return null;
  const now = new Date().getFullYear();
  if (y < 1900 || y > now || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function parseConsent(v: unknown): boolean | null {
  const t = String(v ?? "").trim().toLowerCase(); if (!t || t === "select here") return null;
  if (/\b(not|no|don'?t|do not|refuse)\b/.test(t)) return false;
  if (/\b(yes|consent|agree|give|happy)\b/.test(t)) return true;
  return null;
}
const clean = (v: unknown, n = 120) => { const t = String(v ?? "").trim(); return t && t.toLowerCase() !== "select here" ? t.slice(0, n) : null; };
function profileFrom(f: any, tier: string) {
  const legacyConsent = parseConsent(f.membership_type);
  return {
    parent_name: clean(f.parents_name),
    child_name: clean(f.childs_name_or_nickname),
    date_of_birth: parseDob(f.date_of_birth) ?? (tier === "little_voyagers" ? parseDob(f.company) : null),
    fishing_style: clean(f.childs_preferred_fishing_style) ?? clean(f.preferred_fishing_style),
    photo_consent: parseConsent(f.photo_consent) ?? (tier === "little_voyagers" ? legacyConsent : null),
    location: clean(f.city) ?? clean(f.state),
  } as Record<string, any>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { data: sec } = await supabase.from("sync_secrets").select("key,value").in("key", ["mailerlite_api_key", "members_paid_groups"]);
    const get = (k: string) => (sec ?? []).find((r: any) => r.key === k)?.value;
    const apiKey = get("mailerlite_api_key");
    if (!apiKey) throw new Error("MailerLite API key not set");
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

    const paid: { id: string; tier: string }[] = [];
    try {
      const cfg = JSON.parse(get("members_paid_groups") || "{}");
      for (const tier of ["specimen", "strike"]) if (cfg[tier]) paid.push({ id: String(cfg[tier]), tier });
    } catch { /* no paid groups configured */ }
    const GROUPS = [...paid, ...BASE_GROUPS];

    let created = 0, upgraded = 0, updated = 0, skipped = 0, seen = 0; const errors: string[] = [];

    // Every known email (primary + aliases) -> member id and plan.
    const known = new Map<string, { id: string; tier: string; row: any }>();
    { let from = 0; const step = 1000;
      for (;;) {
        const { data, error } = await supabase.from("members").select(`id,email,email_aliases,tier,${PROFILE_COLS.join(",")}`).range(from, from + step - 1);
        if (error) throw new Error(`load members: ${error.message}`);
        for (const m of data ?? []) {
          const v = { id: m.id, tier: m.tier, row: m };
          if (m.email) known.set(String(m.email).trim().toLowerCase(), v);
          for (const a of (m.email_aliases ?? [])) if (a) known.set(String(a).trim().toLowerCase(), v);
        }
        if (!data || data.length < step) break; from += step;
      }
    }

    for (const g of GROUPS) {
      const isPaid = g.tier === "strike" || g.tier === "specimen";
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const url = `${ML}/groups/${g.id}/subscribers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const r = await fetch(url, { headers });
        if (!r.ok) { errors.push(`group ${g.id}: ${r.status}`); break; }
        const j = await r.json();
        for (const s of j.data ?? []) {
          seen++;
          const email = (s.email || "").trim().toLowerCase();
          if (!email) { skipped++; continue; }
          const have = known.get(email);
          const f = s.fields || {};
          if (have) {
            // fill in or correct form details (never blank them)
            const prof = profileFrom(f, have.tier), patch: Record<string, any> = {};
            for (const c of PROFILE_COLS) if (prof[c] !== null && prof[c] !== undefined && prof[c] !== have.row[c]) patch[c] = prof[c];
            if (Object.keys(patch).length) {
              const { error } = await supabase.from("members").update(patch).eq("id", have.id);
              if (error) errors.push(`${email}: ${error.message}`); else { updated++; Object.assign(have.row, patch); }
            }
            // existing member: only ever move up to a paid plan
            if (isPaid && (RANK[g.tier] ?? 0) > (RANK[have.tier] ?? 0)) {
              const { error } = await supabase.from("members").update({ tier: g.tier, updated_at: new Date().toISOString() }).eq("id", have.id);
              if (error) errors.push(`${email}: ${error.message}`); else { upgraded++; have.tier = g.tier; }
            } else skipped++;
            continue;
          }
          const prof = profileFrom(f, g.tier);
          const name = [f.name, f.last_name].filter(Boolean).join(" ").trim() || prof.child_name || null;
          const referred_by = (f.referred_by || f.ref || f.referral || "").toString().trim() || null;
          const { data: ins, error } = await supabase.from("members").insert({
            name, email, tier: g.tier, source: "mailerlite",
            discount_code: "NEWMEM10", discount_used: false,
            referred_by, ...prof,
          }).select("id").single();
          if (error) { errors.push(`${email}: ${error.message}`); }
          else { created++; known.set(email, { id: ins.id, tier: g.tier, row: { ...prof } }); }
        }
        cursor = j.meta?.next_cursor ?? null;
        if (!cursor) break;
      }
    }
    return json({ ok: true, seen, created, upgraded, updated, skipped, paidGroups: paid.map((p) => p.tier), errorCount: errors.length, errors: errors.slice(0, 15) });
  } catch (e: any) { return json({ error: e.message }, 500); }
});
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
