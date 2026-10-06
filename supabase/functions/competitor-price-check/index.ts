import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Competitor price check for ONE item. Stores delivered prices (item + postage),
// relevance-filtered: any size/number token in the item name (2mm, 7m, 100g, 0.06)
// MUST appear in a competitor's title, and at least 60% of the other key words too —
// so a 7m refill no longer matches a 10m one. The listing title is kept so you can
// see exactly what was compared.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { variantId, query } = await req.json();
    if (!variantId || !query) return json({ error: "variantId and query required" }, 400);
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "EBAY_APP_ID / EBAY_CERT_ID not set" }, 400);
    const token = await appToken(appId, certId);
    const results = await search(token, query);
    await supabase.from("competitor_prices").delete().eq("variant_id", variantId);
    if (results.length) await supabase.from("competitor_prices").insert(results.map((r) => ({ variant_id: variantId, seller: r.seller, title: r.title, item_price: r.item, postage: r.postage, delivered: r.delivered, url: r.url, checked_at: new Date().toISOString() })));
    return json({ ok: true, count: results.length, results });
  } catch (e: any) { return json({ error: e.message }, 500); }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

async function appToken(appId: string, certId: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("eBay app token failed"); return d.access_token as string;
}

const STOP = new Set(["the", "and", "for", "with", "pack", "new", "free", "post", "fishing", "bait", "tackle", "all", "flavours", "size", "sizes", "choose"]);
function words(s: string): string[] { return (s || "").toLowerCase().replace(/[^a-z0-9. ]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w)); }
export function relevant(qw: string[], titleLower: string): boolean {
  const tw = new Set(words(titleLower));
  for (const s of qw.filter((w) => /\d/.test(w))) if (!tw.has(s)) return false; // every size/number must be present as a whole token
  const plain = qw.filter((w) => !/\d/.test(w));
  if (!plain.length) return true;
  return plain.filter((w) => tw.has(w)).length / plain.length >= 0.6;
}

async function search(token: string, query: string) {
  const q = query.slice(0, 100); const qw = words(q);
  const url = `${EBAY}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE}")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB", "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`Browse API ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  return ((d.itemSummaries ?? []) as any[])
    .filter((it) => relevant(qw, (it.title ?? "").toLowerCase()))
    .map((it) => { const item = parseFloat(it.price?.value ?? "0"); let postage = 0; const ship = it.shippingOptions?.[0]?.shippingCost; if (ship && ship.value) postage = parseFloat(ship.value); return { seller: it.seller?.username ?? "eBay seller", title: it.title ?? "", item, postage, delivered: Math.round((item + postage) * 100) / 100, url: it.itemWebUrl ?? null }; })
    .filter((x) => x.item > 0)
    .sort((a, b) => a.delivered - b.delivered)
    .slice(0, 12);
}
