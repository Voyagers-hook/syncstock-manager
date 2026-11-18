import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Postage spend summary. eBay shipping labels are pulled EXACTLY from the signed Finances API
// (transactionType SHIPPING_LABEL). Other carriers (SendCloud, Parcel2Go, DPD) are added as
// live connectors; until each is connected it reports connected:false.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";

function b64toBytes(b64: string): Uint8Array { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function bytesToB64(buf: ArrayBuffer): string { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }

async function financesGet(supabase: any, qs: string): Promise<any> {
  const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
  const { data: rt } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
  const { data: pk } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_signing_private").maybeSingle();
  const { data: jk } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_signing_jwe").maybeSingle();
  if (!rt?.value || !pk?.value || !jk?.value) throw new Error("eBay finance access isn't set up. Reconnect eBay (with finances) in Settings.");
  const jwe = jk.value;
  const tr = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt.value, scope: "https://api.ebay.com/oauth/api_scope/sell.finances" }) });
  const token = (await tr.json()).access_token;
  if (!token) throw new Error("eBay login failed.");
  const authority = "apiz.ebay.com", path = "/sell/finances/v1/transaction";
  const created = Math.floor(Date.now() / 1000);
  const sigParams = `("x-ebay-signature-key" "@method" "@path" "@authority");created=${created}`;
  const base = [`"x-ebay-signature-key": ${jwe}`, `"@method": GET`, `"@path": ${path}`, `"@authority": ${authority}`, `"@signature-params": ${sigParams}`].join("\n");
  const key = await crypto.subtle.importKey("pkcs8", b64toBytes(pk.value), { name: "Ed25519" }, false, ["sign"]);
  const sigB64 = bytesToB64(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(base)));
  const r = await fetch(`https://${authority}${path}?${qs}`, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB", "x-ebay-signature-key": jwe, "Signature-Input": `sig1=${sigParams}`, "Signature": `sig1=:${sigB64}:` } });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`eBay finances ${r.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const b = await req.json().catch(() => ({}));
    const start = String(b.start || "2026-10-02T00:00:00.000Z");
    const end = String(b.end || "2026-11-02T00:00:00.000Z");

    // eBay shipping labels (paginated)
    let labelTotal = 0; const items: any[] = []; let offset = 0;
    for (let page = 0; page < 20; page++) {
      const j = await financesGet(supabase, `filter=transactionDate:%5B${start}..${end}%5D&limit=1000&offset=${offset}`);
      const txns = j.transactions ?? [];
      for (const t of txns) {
        if (t.transactionType === "SHIPPING_LABEL") {
          const amt = Number(t.amount?.value || 0);
          labelTotal += amt;
          const ref = (t.references ?? []).find((x: any) => x.referenceType === "ORDER_ID")?.referenceId || t.orderId || t.transactionId;
          items.push({ date: t.transactionDate, amount: Math.round(amt * 100) / 100, reference: ref, memo: t.transactionMemo || "" });
        }
      }
      if (txns.length < 1000) break;
      offset += 1000;
    }

    const carriers = {
      ebay: { connected: true, total: Math.round(labelTotal * 100) / 100, count: items.length, items },
      sendcloud: { connected: false, total: 0, note: "Add your SendCloud API key to enable." },
      parcel2go: { connected: false, total: 0, note: "Add your Parcel2Go API key to enable." },
      dpd: { connected: false, total: 0, note: "Add your DPD API credentials to enable." },
    };
    const grandTotal = Math.round(labelTotal * 100) / 100;
    return json({ ok: true, start, end, grandTotal, carriers });
  } catch (e: any) { return json({ error: e.message }, 500); }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
