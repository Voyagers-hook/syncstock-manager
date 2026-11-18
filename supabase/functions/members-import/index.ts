import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// One-off / re-runnable seed of Hook Club members from the Little Voyagers Google Sheet.
// Keeps existing membership numbers. On re-run it updates name/email/tier/discount but NEVER
// overwrites points_balance / lifetime_spend / credited_from, so live points are preserved.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const SHEET_CSV = "https://docs.google.com/spreadsheets/d/1loWRLLaoJyeRrK8YwJqCQPeIyZ5EGLByr7_D2b5qgUY/export?format=csv";

function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ""; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function tierOf(s: string): string {
  const t = (s || "").trim().toLowerCase();
  if (t.startsWith("little")) return "little_voyagers";
  if (t.startsWith("strike")) return "strike";
  if (t.startsWith("specimen")) return "specimen";
  return "cast";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const r = await fetch(SHEET_CSV);
    if (!r.ok) throw new Error(`Sheet fetch ${r.status}`);
    const rows = parseCSV(await r.text());
    rows.shift();
    let inserted = 0, updated = 0, skipped = 0; const errors: string[] = [];

    for (const row of rows) {
      const name = (row[0] || "").trim();
      const email = (row[1] || "").trim().toLowerCase();
      const num = (row[2] || "").trim();
      if (!email && !num) { skipped++; continue; } // blank template row
      const points = Math.round(parseFloat(row[3] || "0") || 0);
      const spend = parseFloat(row[5] || "0") || 0;
      const codeRaw = (row[8] || "").trim();
      const discount_code = (codeRaw === "-" || codeRaw === "") ? null : codeRaw;
      const discount_used = !(codeRaw === "NEWMEM10");
      const tier = tierOf(row[11] || "");
      const base = { name: name || null, email: email || null, tier, discount_code, discount_used, source: "sheet", updated_at: new Date().toISOString() };

      try {
        // Match strictly by membership number when the row has one; only fall back to email
        // (for the rare no-number row) otherwise. This keeps dual memberships on one email separate.
        let existing: any = null;
        if (num) {
          const { data } = await supabase.from("members").select("id").eq("membership_number", num).maybeSingle();
          existing = data;
        } else if (email) {
          const { data } = await supabase.from("members").select("id").eq("email", email).is("membership_number", null).maybeSingle();
          existing = data;
        }
        if (existing) {
          await supabase.from("members").update(base).eq("id", existing.id); // never touches points/spend
          updated++;
        } else {
          const ins: any = { ...base, points_balance: points, lifetime_spend: spend };
          if (num) ins.membership_number = num;
          const { error } = await supabase.from("members").insert(ins);
          if (error) { errors.push(`${num || email}: ${error.message}`); } else inserted++;
        }
      } catch (e: any) { errors.push(`${num || email}: ${e.message}`); }
    }
    return json({ ok: true, inserted, updated, skipped, errorCount: errors.length, errors: errors.slice(0, 20) });
  } catch (e: any) { return json({ error: e.message }, 500); }
});
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
