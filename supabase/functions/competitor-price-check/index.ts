import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// SyncStock competitor price check.
// Looks up current eBay UK listings for an item and stores the DELIVERED price
// (item price + postage) per seller, cheapest first. Voyagers Hook sells with free
// postage, so comparison is on the delivered figure. Results are relevance-filtered
// against the item's words so unrelated listings are dropped, and the listing title
// is stored so you can see exactly what was compared.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EBAY = "https://api.ebay.com";

export async function runCheck(supabase: any, token: string, variantId: string, query: string) {
  const results = await search(token, query);
  await supabase.from("competitor_prices").delete().eq("variant_id", variantId);
  if (results.length) {
    await supabase.from("competitor_prices").insert(
      results.map((r) => ({
        variant_id: variantId,
        seller: r.seller,
        title: r.title,
        item_price: r.item,
        postage: r.postage,
        delivered: r.delivered,
        url: r.url,
        checked_at: new Date().toISOString(),
      })),
    );
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { variantId, query } = await req.json();
    if (!variantId || !query) return json({ error: "variantId and query required" }, 400);
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "EBAY_APP_ID / EBAY_CERT_ID not set" }, 400);
    const token = await appToken(appId, certId);
    const results = await runCheck(supabase, token, variantId, query);
    return json({ ok: true, count: results.length, results });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

function json(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}

async function appToken(appId: string, certId: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${appId}:${certId}`)}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("eBay app token failed");
  return d.access_token as string;
}

const STOP = new Set([
  "the", "and", "for", "with", "x", "pack", "of", "new", "uk", "free", "pp", "post",
  "fishing", "bait", "tackle",
]);
function words(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9. ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}
function relevant(queryWords: string[], title: string): boolean {
  if (!queryWords.length) return true;
  const tw = new Set(words(title));
  const hits = queryWords.filter((w) => tw.has(w)).length;
  return hits / queryWords.length >= 0.5; // at least half the key words must appear
}

export async function search(token: string, query: string) {
  const q = query.slice(0, 100);
  const qWords = words(q);
  const url = `${EBAY}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(
    q,
  )}&limit=40&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE}")}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) throw new Error(`Browse API ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  const items = (d.itemSummaries ?? []) as any[];
  return items
    .filter((it) => relevant(qWords, it.title ?? ""))
    .map((it) => {
      const item = parseFloat(it.price?.value ?? "0");
      let postage = 0;
      const ship = it.shippingOptions?.[0]?.shippingCost;
      if (ship && ship.value) postage = parseFloat(ship.value);
      return {
        seller: it.seller?.username ?? "eBay seller",
        title: it.title ?? "",
        item,
        postage,
        delivered: Math.round((item + postage) * 100) / 100,
        url: it.itemWebUrl ?? null,
      };
    })
    .filter((x) => x.item > 0)
    .sort((a, b) => a.delivered - b.delivered)
    .slice(0, 12);
}
