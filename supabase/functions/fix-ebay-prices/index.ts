import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Fixes eBay listings stored at £0. The quick-sync feed (GetMyeBaySelling) doesn't
// always carry a usable price for every listing (notably some variation listings),
// which left a few items at £0. This calls GetItem directly for each £0 eBay listing
// — the authoritative source — and fills the real price (per variation where needed).

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
    if (!appId || !certId || !tok?.value) return json({ error: "eBay creds/token missing" }, 400);
    const token = await ebayToken(appId, certId, tok.value);

    // Diagnostic: { "debug": "<itemId>" } returns that listing's live price + variations.
    const body = await req.json().catch(() => ({}));
    if (body && body.debug) {
      const info = await getItem(token, String(body.debug));
      await supabase.from("sync_log").insert({ sync_type: "ebay_item_debug", status: "completed", details: { itemId: String(body.debug), flat: info.flat, variations: info.variations }, source: "edge_function" });
      return json({ ok: true, itemId: String(body.debug), ...info });
    }

    const { data: zero } = await supabase
      .from("channel_listings")
      .select("id, channel_product_id, channel_sku, channel_variant_id")
      .eq("channel", "ebay")
      .or("channel_price.is.null,channel_price.eq.0");
    const rows = zero ?? [];
    // Group rows by eBay item id.
    const byItem = new Map<string, any[]>();
    for (const r of rows) {
      const itemId = (r.channel_product_id?.split("|")[1]) || r.channel_sku;
      if (!itemId) continue;
      (byItem.get(itemId) ?? byItem.set(itemId, []).get(itemId)!).push(r);
    }

    let fixed = 0; const notes: string[] = [];
    for (const [itemId, group] of byItem) {
      try {
        const info = await getItem(token, itemId);
        for (const r of group) {
          let price = info.flat;
          if (info.variations.length) {
            const m = info.variations.find((v) => v.sku && (v.sku === r.channel_sku || v.sku === r.channel_variant_id))
              || info.variations.find((v) => v.name && (v.name === r.channel_variant_id || v.name === r.channel_sku));
            if (m) price = m.price;
          }
          if (price && price > 0) { await supabase.from("channel_listings").update({ channel_price: price, last_synced_at: new Date().toISOString() }).eq("id", r.id); fixed++; }
          else notes.push(`${itemId}: no price found`);
        }
      } catch (e: any) { notes.push(`${itemId}: ${e.message}`); }
    }
    await supabase.from("sync_log").insert({ sync_type: "fix_ebay_prices", status: "completed", details: { checked: rows.length, fixed, notes }, source: "edge_function" });
    return json({ ok: true, checked: rows.length, fixed, notes });
  } catch (e: any) { return json({ error: e.message }, 500); }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function xtag(xml: string, t: string) { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? m[1].trim() : null; }

async function ebayToken(appId: string, certId: string, refresh: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("token refresh failed"); return d.access_token as string;
}

async function getItem(token: string, itemId: string) {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeVariations>true</IncludeVariations></GetItemRequest>`;
  const resp = await fetch(`${EBAY}/ws/api.dll`, { method: "POST", headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "GetItem", "X-EBAY-API-SITEID": "3" }, body });
  const xml = await resp.text();
  const itemBlock = xml.match(/<Item>([\s\S]*?)<\/Item>/)?.[1] ?? xml;
  // Flat price: prefer StartPrice, then CurrentPrice.
  const flat = parseFloat(xtag(itemBlock, "StartPrice") ?? xtag(itemBlock, "CurrentPrice") ?? "0") || 0;
  const variations: { sku: string | null; name: string | null; price: number }[] = [];
  const varBlock = xml.match(/<Variations>([\s\S]*?)<\/Variations>/)?.[1] ?? "";
  for (const [, vx] of varBlock.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
    const sku = xtag(vx, "SKU");
    const names: string[] = [];
    for (const [, nv] of vx.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) { const v = xtag(nv, "Value"); if (v) names.push(v); }
    variations.push({ sku, name: names.join(" / ") || null, price: parseFloat(xtag(vx, "StartPrice") ?? "0") || 0 });
  }
  return { flat, variations };
}
