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
    if (!appId || !certId) return json({ error: "Missing EBAY_APP_ID or EBAY_CERT_ID" }, 500);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const clearFirst = body?.clearFirst === true || body?.mode === "full";

    const { data: tokenRow } = await supabase
      .from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    if (!tokenRow?.value) return json({ error: "No eBay refresh token" }, 400);

    const tokenResp = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${appId}:${certId}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenRow.value,
        scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/sell.account",
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) return json({ error: "eBay token refresh failed" }, 500);

    const accessToken: string = tokenData.access_token;
    const items = await fetchAllListings(accessToken);

    if (clearFirst) {
      await supabase.from("channel_listings").delete().eq("channel", "ebay");
      const { data: orphanedVariants } = await supabase.rpc("get_orphaned_variant_ids");
      if (orphanedVariants && orphanedVariants.length > 0) {
        const orphanIds = orphanedVariants.map((r: any) => r.id);
        for (let i = 0; i < orphanIds.length; i += 20) {
          await supabase.from("inventory").delete().in("variant_id", orphanIds.slice(i, i + 20));
          await supabase.from("variants").delete().in("id", orphanIds.slice(i, i + 20));
        }
      }
      const { data: orphanedProducts } = await supabase.rpc("get_orphaned_product_ids");
      if (orphanedProducts && orphanedProducts.length > 0) {
        const orphanIds = orphanedProducts.map((r: any) => r.id);
        for (let i = 0; i < orphanIds.length; i += 20) {
          await supabase.from("products").delete().in("id", orphanIds.slice(i, i + 20));
        }
      }
    }

    const stats = await bulkInsert(supabase, items);
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

type EbayVariation = { sku: string; price: string; name: string; qty: number; sold: number };
type EbayItem = {
  itemId: string; title: string; sku: string;
  price: string; qty: number; sold: number;
  variations: EbayVariation[];
};

async function fetchAllListings(token: string): Promise<EbayItem[]> {
  const all: EbayItem[] = [];
  let page = 1;
  for (;;) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ActiveList>
    <Sort>ItemID</Sort>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const r = await fetch(`${EBAY}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-SITEID": "3",
      },
      body: xml,
    });
    const text = await r.text();
    const items = parseXml(text);
    all.push(...items);
    const totalPages = parseInt(xtag(text, "TotalNumberOfPages") ?? "1");
    if (page >= totalPages || items.length === 0) break;
    page++;
  }
  return all;
}

function parseXml(xml: string): EbayItem[] {
  const items: EbayItem[] = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const itemId = xtag(x, "ItemID");
    const title = xtag(x, "Title");
    if (!itemId || !title) continue;
    const priceStr = xtag(x, "CurrentPrice") ?? "0";
    const sku = xtag(x, "SKU") || itemId;
    const qty = parseInt(xtag(x, "Quantity") ?? "0");
    const sold = parseInt(xtag(x, "QuantitySold") ?? "0");
    const variations: EbayVariation[] = [];
    const vblock = x.match(/<Variations>([\s\S]*?)<\/Variations>/);
    if (vblock) {
      const vre = /<Variation>([\s\S]*?)<\/Variation>/g;
      let vm;
      while ((vm = vre.exec(vblock[1])) !== null) {
        const vx = vm[1];
        const vSku = xtag(vx, "SKU") ?? "";
        const vPrice = xtag(vx, "StartPrice") ?? priceStr;
        const vQty = parseInt(xtag(vx, "Quantity") ?? "0");
        const vSold = parseInt(xtag(vx, "QuantitySold") ?? "0");
        const parts: string[] = [];
        const nvre = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let nvm;
        while ((nvm = nvre.exec(vx)) !== null) {
          const val = xtag(nvm[1], "Value");
          if (val) parts.push(val);
        }
        variations.push({ sku: vSku, price: vPrice, name: parts.join(" / "), qty: vQty, sold: vSold });
      }
    }
    items.push({ itemId, title, sku, price: priceStr, qty, sold, variations });
  }
  return items;
}

async function bulkInsert(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  const allSkus = [...new Set(items.map(i => i.sku))];
  const { data: existingProds } = await supabase.from("products").select("id, sku").in("sku", allSkus);
  const existingSkuMap = new Map<string, string>((existingProds ?? []).map((p: any) => [p.sku, p.id]));
  const newProdRows = items
    .filter(item => !existingSkuMap.has(item.sku))
    .map(item => ({ name: item.title, sku: item.sku, active: true }));
  const uniqueNewProds = [...new Map(newProdRows.map((p: any) => [p.sku, p])).values()];

  if (uniqueNewProds.length > 0) {
    const { data: inserted } = await supabase.from("products").insert(uniqueNewProds).select("id, sku");
    for (const p of (inserted ?? [])) existingSkuMap.set(p.sku, p.id);
  }

  const productBySku = existingSkuMap;
  const varRows: any[] = [];
  for (const item of items) {
    const productId = productBySku.get(item.sku);
    if (!productId) continue;
    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        varRows.push({ product_id: productId, internal_sku: iSku, option1: v.name || null });
      }
    } else {
      varRows.push({ product_id: productId, internal_sku: item.itemId, option1: null });
    }
  }

  const seenVarSkus = new Set<string>();
  const dedupedVarRows = varRows.filter(r => {
    if (seenVarSkus.has(r.internal_sku)) return false;
    seenVarSkus.add(r.internal_sku);
    return true;
  });

  const variantByISku = new Map<string, string>();
  const allISkus = dedupedVarRows.map(r => r.internal_sku);
  for (let i = 0; i < allISkus.length; i += 150) {
    const chunk = allISkus.slice(i, i + 150);
    const { data: existing } = await supabase.from("variants").select("id, internal_sku").in("internal_sku", chunk);
    for (const v of (existing ?? [])) variantByISku.set(v.internal_sku, v.id);
  }

  for (const varRow of dedupedVarRows) {
    if (variantByISku.has(varRow.internal_sku)) continue;
    const { data: inserted } = await supabase.from("variants").insert(varRow).select("id, internal_sku");
    if (inserted && inserted.length > 0) variantByISku.set(inserted[0].internal_sku, inserted[0].id);
  }

  const invRows: any[] = [];
  const listRows: any[] = [];
  for (const item of items) {
    const cpid = `v1|${item.itemId}|0`;
    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        const varId = variantByISku.get(iSku);
        const prodId = productBySku.get(item.sku);
        if (!varId || !prodId) continue;
        invRows.push({ variant_id: varId, product_id: prodId, total_stock: Math.max(0, v.qty - v.sold) });
        listRows.push({ variant_id: varId, channel: "ebay", channel_sku: v.sku || v.name, channel_price: parseFloat(v.price), channel_product_id: cpid, channel_variant_id: v.name || v.sku || iSku, last_synced_at: now });
      }
    } else {
      const iSku = item.itemId;
      const varId = variantByISku.get(iSku);
      const prodId = productBySku.get(item.sku);
      if (!varId || !prodId) continue;
      invRows.push({ variant_id: varId, product_id: prodId, total_stock: Math.max(0, item.qty - item.sold) });
      listRows.push({ variant_id: varId, channel: "ebay", channel_sku: item.sku, channel_price: parseFloat(item.price), channel_product_id: cpid, channel_variant_id: "", last_synced_at: now });
    }
  }

  for (const row of invRows) {
    await supabase.from("inventory").upsert(row, { onConflict: 'variant_id' });
  }
  for (let i = 0; i < listRows.length; i += 50) {
    await supabase.from("channel_listings").insert(listRows.slice(i, i + 50));
  }

  return { total_items: items.length, variants: dedupedVarRows.length };
}
