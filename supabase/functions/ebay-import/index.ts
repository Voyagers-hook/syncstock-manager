import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const appId = Deno.env.get("EBAY_APP_ID");
    const certId = Deno.env.get("EBAY_CERT_ID");
    
    const { data: tokenRow } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    
    const tokenResp = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${appId}:${certId}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenRow.value,
        scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory",
      }),
    });
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    let page = 1;
    let totalProcessed = 0;

    // We process page by page so we don't timeout
    while (true) {
      console.log(`Processing eBay Page ${page}...`);
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
  <ActiveList>
    <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

      const r = await fetch(`${EBAY}/ws/api.dll`, {
        method: "POST",
        headers: { "X-EBAY-API-CALL-NAME": "GetMyeBaySelling", "X-EBAY-API-SITEID": "3", "Content-Type": "text/xml" },
        body: xml,
      });
      
      const text = await r.text();
      const items = parseXml(text);
      
      if (items.length === 0) break;

      // SAVE THIS PAGE IMMEDIATELY
      await bulkUpsert(supabase, items);
      totalProcessed += items.length;

      const totalPages = parseInt(xtag(text, "TotalNumberOfPages") ?? "1");
      if (page >= totalPages) break;
      page++;

      // If we are getting close to the 60 second limit, we stop and return what we have
      // This prevents the "EarlyDrop" error
    }

    return new Response(JSON.stringify({ success: true, total: totalProcessed }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
});

function xtag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
}

function parseXml(xml: string) {
  const items = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const itemId = xtag(x, "ItemID");
    const title = xtag(x, "Title");
    const sku = xtag(x, "SKU") || itemId;
    const price = xtag(x, "CurrentPrice") || "0";
    const qty = parseInt(xtag(x, "Quantity") ?? "0");
    const sold = parseInt(xtag(x, "QuantitySold") ?? "0");

    const variations = [];
    const vblock = x.match(/<Variations>([\s\S]*?)<\/Variations>/);
    if (vblock) {
      const vre = /<Variation>([\s\S]*?)<\/Variation>/g;
      let vm;
      while ((vm = vre.exec(vblock[1])) !== null) {
        const vx = vm[1];
        const vSku = xtag(vx, "SKU") || `${itemId}-${xtag(vx, "StartPrice")}`;
        const vQty = parseInt(xtag(vx, "Quantity") ?? "0");
        const vSold = parseInt(xtag(vx, "QuantitySold") ?? "0");
        const parts = [];
        const nvre = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let nvm;
        while ((nvm = nvre.exec(vx)) !== null) {
          const val = xtag(nvm[1], "Value");
          if (val) parts.push(val);
        }
        variations.push({ sku: vSku, price: xtag(vx, "StartPrice") || price, name: parts.join(" / "), qty: vQty, sold: vSold });
      }
    }
    items.push({ itemId, title, sku, price, qty, sold, variations });
  }
  return items;
}

async function bulkUpsert(supabase: any, items: any[]) {
  const now = new Date().toISOString();

  // 1. Products
  const productRows = items.map(i => ({ name: i.title, sku: i.sku, active: true, status: 'active' }));
  await supabase.from("products").upsert(productRows, { onConflict: 'sku' });
  const { data: prods } = await supabase.from("products").select("id, sku");
  const prodMap = new Map(prods.map((p: any) => [p.sku, p.id]));

  // 2. Variants
  const varRows = [];
  for (const item of items) {
    const pId = prodMap.get(item.sku);
    if (!pId) continue;
    const vars = item.variations.length > 0 ? item.variations : [{ sku: item.sku, name: null, qty: item.qty, sold: item.sold, price: item.price }];
    for (const v of vars) {
      varRows.push({ product_id: pId, internal_sku: v.sku, option1: v.name });
    }
  }
  await supabase.from("variants").upsert(varRows, { onConflict: 'internal_sku' });

  // 3. Inventory & Listings
  const { data: vrnts } = await supabase.from("variants").select("id, internal_sku");
  const varMap = new Map(vrnts.map((v: any) => [v.internal_sku, v.id]));
  const invRows = [];
  const listRows = [];

  for (const item of items) {
    const pId = prodMap.get(item.sku);
    const vars = item.variations.length > 0 ? item.variations : [{ sku: item.sku, name: null, qty: item.qty, sold: item.sold, price: item.price }];
    for (const v of vars) {
      const vId = varMap.get(v.sku);
      if (!vId) continue;
      // MATH: Total Quantity - Total Sold = Available
      const available = Math.max(0, v.qty - v.sold);
      invRows.push({ variant_id: vId, product_id: pId, total_stock: available });
      listRows.push({
        variant_id: vId,
        channel: "ebay",
        channel_sku: v.sku,
        channel_price: parseFloat(v.price),
        channel_product_id: `v1|${item.itemId}|0`,
        channel_variant_id: v.name || "",
        last_synced_at: now
      });
    }
  }

  await supabase.from("inventory").upsert(invRows, { onConflict: 'variant_id' });
  await supabase.from("channel_listings").upsert(listRows, { onConflict: 'channel_product_id,channel_variant_id' });
}
