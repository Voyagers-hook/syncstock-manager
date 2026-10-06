import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Batch competitor refresh. Walks the eBay-listed items that haven't been checked
// in the last ~20 hours and stores fresh delivered prices for a batch of them, so the
// inventory chips (cheaper / dearer vs market) fill in and stay current on a schedule.
// Processes a limited batch per run to stay within time/rate limits; run on a cron.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";
const BATCH = 40;
const STALE_HOURS = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "EBAY creds missing" }, 400);
    const body = await req.json().catch(() => ({}));
    const limit = body.batch ?? BATCH;
    const token = await appToken(appId, certId);

    // eBay-listed variants
    const { data: listings } = await supabase
      .from("channel_listings")
      .select("variant_id")
      .eq("channel", "ebay");
    const variantIds = [...new Set((listings ?? []).map((l: any) => l.variant_id).filter(Boolean))];

    // Skip variants checked recently
    const since = new Date(Date.now() - STALE_HOURS * 3600000).toISOString();
    const { data: recent } = await supabase
      .from("competitor_prices")
      .select("variant_id")
      .gte("checked_at", since);
    const fresh = new Set((recent ?? []).map((r: any) => r.variant_id));
    const todo = variantIds.filter((v) => !fresh.has(v)).slice(0, limit);
    if (!todo.length) return json({ ok: true, processed: 0, remaining: 0, note: "all fresh" });

    // Map variant -> product name
    const vToP = new Map<string, string>();
    for (let i = 0; i < todo.length; i += 100) {
      const { data } = await supabase.from("variants").select("id, product_id").in("id", todo.slice(i, i + 100));
      for (const v of data ?? []) vToP.set(v.id, v.product_id);
    }
    const pids = [...new Set([...vToP.values()])];
    const pName = new Map<string, string>();
    for (let i = 0; i < pids.length; i += 100) {
      const { data } = await supabase.from("products").select("id, name").in("id", pids.slice(i, i + 100));
      for (const p of data ?? []) pName.set(p.id, p.name);
    }

    let processed = 0;
    for (const variantId of todo) {
      const name = pName.get(vToP.get(variantId) ?? "") ?? "";
      if (!name) continue;
      try {
        const results = await search(token, name);
        await supabase.from("competitor_prices").delete().eq("variant_id", variantId);
        if (results.length)
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
        else
          // Record a marker so we don't re-check it every run even when nothing matched.
          await supabase.from("competitor_prices").insert({
            variant_id: variantId,
            seller: null,
            title: "No match found",
            item_price: null,
            postage: null,
            delivered: null,
            url: null,
            checked_at: new Date().toISOString(),
          });
        processed++;
      } catch (_e) {
        // skip this one, continue the batch
      }
    }
    return json({ ok: true, processed, remaining: variantIds.filter((v) => !fresh.has(v)).length - processed });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

async function appToken(appId: string, certId: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("eBay app token failed");
  return d.access_token as string;
}

const STOP = new Set(["the", "and", "for", "with", "pack", "new", "free", "post", "fishing", "bait", "tackle", "all", "flavours", "size", "sizes", "choose"]);
function words(s: string): string[] {
  return (s || "").toLowerCase().replace(/[^a-z0-9. ]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));
}
function relevant(qw: string[], titleLower: string): boolean {
  const tw = new Set(words(titleLower));
  for (const s of qw.filter((w) => /\d/.test(w))) if (!tw.has(s)) return false;
  const plain = qw.filter((w) => !/\d/.test(w));
  if (!plain.length) return true;
  return plain.filter((w) => tw.has(w)).length / plain.length >= 0.6;
}

async function search(token: string, query: string) {
  const q = query.slice(0, 100);
  const qw = words(q);
  const url = `${EBAY}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE}")}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB", "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`Browse ${r.status}`);
  const d = await r.json();
  return ((d.itemSummaries ?? []) as any[])
    .filter((it) => relevant(qw, (it.title ?? "").toLowerCase()))
    .map((it) => {
      const item = parseFloat(it.price?.value ?? "0");
      let postage = 0;
      const ship = it.shippingOptions?.[0]?.shippingCost;
      if (ship && ship.value) postage = parseFloat(ship.value);
      return { seller: it.seller?.username ?? "eBay seller", title: it.title ?? "", item, postage, delivered: Math.round((item + postage) * 100) / 100, url: it.itemWebUrl ?? null };
    })
    .filter((x) => x.item > 0)
    .sort((a, b) => a.delivered - b.delivered)
    .slice(0, 12);
}
