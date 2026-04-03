import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const appId = Deno.env.get("EBAY_APP_ID");
    const certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "Missing API Keys" }, 500);

    const { data: tokenRow } = await supabase
      .from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    if (!tokenRow?.value) return json({ error: "No eBay refresh token" }, 400);

    // Refresh Token Logic
    const tokenResp = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${appId}:${certId}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenRow.value,
        scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      }),
    });
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    // 1. FETCH FROM EBAY
    const items = await fetchAllListings(accessToken);

    // 2. SAFE UPDATE (NO DELETES)
    // We remove the 'clearFirst' logic entirely so your listings are never wiped.
    const stats = await bulkUpsert(supabase, items);

    return json({ success: true, ...stats });

  } catch (err: unknown) {
    return json({ error: String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

function xtag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
}

// Fixed XML Parser to handle Fjuka Variants correctly
function parseXml(xml: string) {
  const items: any[] = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const itemId = xtag(x, "ItemID");
    const title = xtag(x, "Title");
    if (!itemId || !title) continue;

    const sku = xtag(x, "SKU") || itemId;
    const price = xtag(x, "CurrentPrice") || "0";
    // FIX: Use Quantity directly (not minus sold)
    const qty = parseInt(xtag(x, "QuantityAvailable") ?? xtag(x, "Quantity") ?? "0");

    const variations: any[] = [];
    const vblock = x.match(/<Variations>([\s\S]*?)<\/Variations>/);
    if (vblock) {
      const vre = /<Variation>([\s\S]*?)<\/Variation>/g;
      let vm;
      while ((vm = vre.exec(vblock[1])) !== null) {
        const vx = vm[1];
        const vSku = xtag(vx, "SKU") || `${itemId}-${xtag(vx, "StartPrice")}`;
        const vQty = parseInt(xtag(vx, "Quantity") ?? "0");
        const parts: string[] = [];
        const nvre = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let nvm;
        while ((nvm = nvre.exec(vx)) !== null) {
          const val = xtag(nvm[1], "Value");
          if (val) parts.push(val);
        }
        variations.push({ sku: vSku, price: xtag(vx, "StartPrice") || price, name: parts.join(" / "), qty: vQty });
      }
    }
    items.push({ itemId, title, sku, price, qty, variations });
  }
  return items;
}

// ... (fetchAllListings helper stays the same)

async function bulkUpsert(supabase: any, items: any[]) {
  let productsCount = 0, variantsCount = 0;

  for (const item of items) {
    // 1. Upsert Product (Matches by SKU or Name)
    const { data: prod } = await supabase.from("products").upsert({
      name: item.title,
      sku: item.sku,
      active: true,
      status: 'active'
    }, { onConflict: 'sku' }).select("id").single();

    if (!prod) continue;
    productsCount++;

    const variations = item.variations.length > 0 ? item.variations : [{ sku: item.sku, name: null, qty: item.qty, price: item.price }];

    for (const v of variations) {
      // 2. Upsert Variant
      const { data: vrnt } = await supabase.from("variants").upsert({
        product_id: prod.id,
        internal_sku: v.sku,
        option1: v.name,
      }, { onConflict: 'internal_sku' }).select("id").single();

      if (!vrnt) continue;
      variantsCount++;

      // 3. Update Inventory
      await supabase.from("inventory").upsert({
        variant_id: vrnt.id,
        product_id: prod.id,
        total_stock: v.qty
      }, { onConflict: 'variant_id' });

      // 4. Update Listing Link
      await supabase.from("channel_listings").upsert({
        variant_id: vrnt.id,
        channel: "ebay",
        channel_sku: v.sku,
        channel_price: parseFloat(v.price),
        channel_product_id: `v1|${item.itemId}|0`,
        channel_variant_id: v.name || "",
        last_synced_at: new Date().toISOString()
      }, { onConflict: 'channel_product_id,channel_variant_id' });
    }
  }
  return { productsCount, variantsCount };
}
