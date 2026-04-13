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
      Deno.env.get("SUPABASE_URL")!,import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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
    if (!tokenRow?.value) return json({ error: "No eBay refresh token — connect eBay in Settings first" }, 400);

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
    if (!tokenData.access_token) return json({ error: "eBay token refresh failed", detail: JSON.stringify(tokenData) }, 500);

    const accessToken: string = tokenData.access_token;
    if (tokenData.refresh_token && tokenData.refresh_token !== tokenRow.value) {
      await supabase.from("sync_secrets").upsert({ key: "ebay_refresh_token", value: tokenData.refresh_token }, { onConflict: "key" });
    }

    const items = await fetchAllListings(accessToken);

    if (clearFirst) {
      await supabase.from("channel_listings").delete().not("id", "is", null);
      await supabase.from("inventory").delete().not("variant_id", "is", null);
      await supabase.from("variants").delete().not("id", "is", null);
      await supabase.from("products").delete().not("id", "is", null);

      const stats = await fullInsert(supabase, items);
      const invFixed = await ensureInventoryRows(supabase);

      await supabase.from("sync_log").insert({
        sync_type: "ebay_import",
        status: "completed",
        details: JSON.stringify({ mode: "full_reset", ...stats, inventory_gaps_fixed: invFixed }),
        source: "edge_function",
      });

      return json({ success: true, mode: "full_reset", ...stats, inventory_gaps_fixed: invFixed });

    } else {
      const stats = await quickSyncWithNewListings(supabase, items);

      await supabase.from("sync_log").insert({
        sync_type: "ebay_import",
        status: "completed",
        details: JSON.stringify({ mode: "quick_sync", ...stats }),
        source: "edge_function",
      });

      return json({ success: true, mode: "quick_sync", ...stats });
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ebay-import crash:", msg);
    return json({ error: msg }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xtag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
}

function parseVariationName(varXml: string): string {
  const nvMatches = [...varXml.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)];
  if (!nvMatches.length) return "";
  const parts: string[] = [];
  for (const [, nvXml] of nvMatches) {
    const value = xtag(nvXml, "Value");
    if (value) parts.push(value);
  }
  return parts.join(" / ");
}

type EbayVariation = { sku: string; price: string; name: string; qty: number; sold: number };

type EbayItem = {
  itemId: string;
  title: string;
  sku: string;
  price: string;
  qty: number;
  sold: number;
  variations: EbayVariation[];
};

async function fetchAllListings(token: string): Promise<EbayItem[]> {
  const items: EbayItem[] = [];
  let page = 1;

  while (true) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ActiveList>
    <Include>true</Include>
    <IncludeVariations>true</IncludeVariations>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const resp = await fetch(`${EBAY}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-SITEID": "3",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
      },
      body: xml,
    });

    const text = await resp.text();
    const itemMatches = [...text.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];
    if (itemMatches.length === 0) break;

    for (const [, itemXml] of itemMatches) {
      const itemId = xtag(itemXml, "ItemID") ?? "";
      const title = xtag(itemXml, "Title") ?? "";
      const sku = xtag(itemXml, "SKU") ?? itemId;
      const price = xtag(itemXml, "CurrentPrice") ?? xtag(itemXml, "StartPrice") ?? "0";
      const qty = parseInt(xtag(itemXml, "Quantity") ?? "0", 10);
      const sold = parseInt(xtag(itemXml, "QuantitySold") ?? "0", 10);

      const variations: EbayVariation[] = [];
      const varMatches = [...itemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      for (const [, varXml] of varMatches) {
        const vSku = xtag(varXml, "SKU") ?? "";
        const vPrice = xtag(varXml, "StartPrice") ?? price;
        const vQty = parseInt(xtag(varXml, "Quantity") ?? "0", 10);
        const vSold = parseInt(xtag(varXml, "QuantitySold") ?? "0", 10);
        const vName = parseVariationName(varXml) || vSku;
        variations.push({ sku: vSku, price: vPrice, name: vName, qty: vQty, sold: vSold });
      }

      items.push({ itemId, title, sku, price, qty, sold, variations });
    }

    const totalPages = parseInt(text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1", 10);
    if (page >= totalPages) break;
    page++;
  }

  return items;
}

async function fullInsert(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  const CHUNK = 50;

  const productRows = [...new Map(
    items.map(i => [i.itemId, { name: i.title, sku: i.itemId, active: true }])
  ).values()];

  const productByItemId = new Map<string, string>();
  for (let i = 0; i < productRows.length; i += CHUNK) {
    const { data: inserted } = await supabase
      .from("products")
      .insert(productRows.slice(i, i + CHUNK))
      .select("id, sku");
    for (const p of (inserted ?? []) as any[]) productByItemId.set(p.sku, p.id);
  }

  const variantRows: { product_id: string; internal_sku: string; option1: string | null }[] = [];
  for (const item of items) {
    const productId = productByItemId.get(item.itemId);
    if (!productId) continue;
    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        variantRows.push({ product_id: productId, internal_sku: iSku, option1: v.name || null });
      }
    } else {
      variantRows.push({ product_id: productId, internal_sku: item.itemId, option1: null });
    }
  }

  const dedupedVarRows = [...new Map(variantRows.map(r => [r.internal_sku, r])).values()];

  const variantByISku = new Map<string, string>();
  for (let i = 0; i < dedupedVarRows.length; i += CHUNK) {
    const { data: inserted } = await supabase
      .from("variants")
      .insert(dedupedVarRows.slice(i, i + CHUNK))
      .select("id, internal_sku");
    for (const v of (inserted ?? []) as any[]) variantByISku.set(v.internal_sku, v.id);
  }

  const invRows: { variant_id: string; product_id: string; total_stock: number }[] = [];
  const listRows: any[] = [];

  for (const item of items) {
    const prodId = productByItemId.get(item.itemId);
    if (!prodId) continue;
    const cpid = `v1|${item.itemId}|0`;

    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        const varId = variantByISku.get(iSku);
        if (!varId) continue;
        const stock = Math.max(0, v.qty - v.sold);
        invRows.push({ variant_id: varId, product_id: prodId, total_stock: stock });
        listRows.push({
          variant_id: varId, channel: "ebay", channel_sku: v.sku || v.name,
          channel_price: parseFloat(v.price), channel_product_id: cpid,
          channel_variant_id: v.name || v.sku || iSku, last_synced_at: now,
        });
      }
    } else {
      const varId = variantByISku.get(item.itemId);
      if (!varId) continue;
      const stock = Math.max(0, item.qty - item.sold);
      invRows.push({ variant_id: varId, product_id: prodId, total_stock: stock });
      listRows.push({
        variant_id: varId, channel: "ebay", channel_sku: item.sku,
        channel_price: parseFloat(item.price), channel_product_id: cpid,
        channel_variant_id: "", last_synced_at: now,
      });
    }
  }

  for (let i = 0; i < invRows.length; i += CHUNK)
    await supabase.from("inventory").insert(invRows.slice(i, i + CHUNK));
  for (let i = 0; i < listRows.length; i += CHUNK)
    await supabase.from("channel_listings").insert(listRows.slice(i, i + CHUNK));

  return {
    products_inserted: productRows.length,
    variants_inserted: dedupedVarRows.length,
    inventory_rows: invRows.length,
    listings_inserted: listRows.length,
  };
}

async function quickSyncWithNewListings(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  let updated = 0;
  let created = 0;

  // AUTO-MERGE GUARD
  // When auto_merge_enabled is false in the settings table, new eBay listings that
  // cannot be matched by their exact channel_product_id will ALWAYS create a fresh
  // standalone product. No name-matching, no merging. The user merges manually.
  const { data: mergeSetting } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "auto_merge_enabled")
    .maybeSingle();
  const autoMergeEnabled = mergeSetting?.value !== false && mergeSetting?.value !== "false";

  const { data: existingListings } = await supabase
    .from("channel_listings")
    .select("id, channel_product_id, channel_variant_id, variant_id")
    .eq("channel", "ebay");

  const listingMap = new Map<string, string>();
  const cpidToProductId = new Map<string, string>();

  const existingVariantIds = [...new Set(((existingListings ?? []) as any[]).map((l: any) => l.variant_id))];

  if (existingVariantIds.length > 0) {
    const CHUNK = 150;
    const variantRows: any[] = [];
    for (let i = 0; i < existingVariantIds.length; i += CHUNK) {
      const { data } = await supabase
        .from("variants").select("id, product_id")
        .in("id", existingVariantIds.slice(i, i + CHUNK));
      variantRows.push(...(data ?? []));
    }

    const variantToProduct = new Map<string, string>();
    for (const v of variantRows) variantToProduct.set(v.id, v.product_id);

    for (const l of (existingListings ?? []) as any[]) {
      listingMap.set(`${l.channel_product_id}::${l.channel_variant_id ?? ""}`, l.id);
      const pid = variantToProduct.get(l.variant_id);
      if (pid) cpidToProductId.set(l.channel_product_id, pid);
    }
  }

  // Only use name-based product matching when auto-merge is explicitly enabled.
  // When disabled, new eBay item IDs never inherit an existing product by name.
  const productByName = new Map<string, string>();
  if (autoMergeEnabled) {
    const { data: allProducts } = await supabase.from("products").select("id, name");
    for (const p of (allProducts ?? []) as any[])
      productByName.set(p.name.toLowerCase().trim(), p.id);
  }

  const updateBatch: { id: string; channel_price: number; last_synced_at: string }[] = [];

  type NewEntry = {
    productId: string | null;
    productName: string;
    productSku: string;
    internalSku: string;
    option1: string | null;
    cpid: string;
    cvid: string | null;
    channelSku: string;
    price: number;
    stock: number;
  };
  const newEntries: NewEntry[] = [];

  for (const item of items) {
    const cpid = `v1|${item.itemId}|0`;

    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const cvid = v.name || v.sku || `${item.itemId}-${v.name}`;
        const key = `${cpid}::${cvid}`;
        const existingId = listingMap.get(key);

        if (existingId) {
          updateBatch.push({ id: existingId, channel_price: parseFloat(v.price), last_synced_at: now });
        } else {
          // Only inherit product from cpidToProductId when this eBay item ID is already
          // known (has at least one variant in the DB). For a genuinely new eBay item ID,
          // productId stays null so a fresh product is always created.
          const productId = cpidToProductId.has(cpid) ? (cpidToProductId.get(cpid) ?? null) : null;
          const iSku = v.sku || `${item.itemId}-${v.name}`;
          newEntries.push({
            productId,
            productName: item.title,
            productSku: item.sku,
            internalSku: iSku,
            option1: v.name || null,
            cpid, cvid,
            channelSku: v.sku || v.name,
            price: parseFloat(v.price),
            stock: Math.max(0, v.qty - v.sold),
          });
        }
      }
    } else {
      const key = `${cpid}::`;
      const existingId = listingMap.get(key);

      if (existingId) {
        updateBatch.push({ id: existingId, channel_price: parseFloat(item.price), last_synced_at: now });
      } else {
        const productId = cpidToProductId.has(cpid) ? (cpidToProductId.get(cpid) ?? null) : null;
        newEntries.push({
          productId,
          productName: item.title,
          productSku: item.sku,
          internalSku: item.itemId,
          option1: null,
          cpid, cvid: null,
          channelSku: item.sku || item.itemId,
          price: parseFloat(item.price) || 0,
          stock: Math.max(0, item.qty - item.sold),
        });
      }
    }
  }

  if (updateBatch.length > 0) {
    const UPCHUNK = 200;
    for (let ci = 0; ci < updateBatch.length; ci += UPCHUNK)
      await supabase.from("channel_listings").upsert(updateBatch.slice(ci, ci + UPCHUNK));
    updated = updateBatch.length;
  }

  // For each new entry with no productId, always create a fresh product grouped
  // by cpid (eBay item ID) — never fall back to name-matching when auto-merge is off.
  const needProduct = newEntries.filter(e => !e.productId);
  const uniqueNewProducts = [...new Map(needProduct.map(e => [e.cpid, e])).values()];

  for (const e of uniqueNewProducts) {
    const { data: inserted } = await supabase.from("products")
      .insert({ name: e.productName, sku: e.productSku, active: true })
      .select("id, name").single();
    if (inserted) {
      for (const entry of newEntries) {
        if (!entry.productId && entry.cpid === e.cpid)
          entry.productId = inserted.id;
      }
    }
  }

  for (const e of newEntries) {
    if (!e.productId) continue;

    const { data: existingVar } = await supabase.from("variants")
      .select("id").eq("product_id", e.productId).eq("internal_sku", e.internalSku).maybeSingle();

    let variantId: string | null = existingVar?.id ?? null;

    if (!variantId) {
      const { data: newVar } = await supabase.from("variants")
        .insert({ product_id: e.productId, internal_sku: e.internalSku, option1: e.option1 })
        .select("id").single();
      variantId = newVar?.id ?? null;
    }

    if (!variantId) continue;

    const { data: existingInv } = await supabase.from("inventory")
      .select("id").eq("variant_id", variantId).maybeSingle();

    if (!existingInv) {
      await supabase.from("inventory").insert({
        variant_id: variantId,
        product_id: e.productId,
        total_stock: e.stock,
      });
    }

    await supabase.from("channel_listings").insert({
      variant_id: variantId,
      channel: "ebay",
      channel_sku: e.channelSku,
      channel_price: e.price,
      channel_product_id: e.cpid,
      channel_variant_id: e.cvid ?? null,
      last_synced_at: now,
    });

    created++;
  }

  return { listings_updated: updated, new_listings_created: created };
}

async function ensureInventoryRows(supabase: any): Promise<number> {
  const CHUNK = 500;
  let fixed = 0;

  const { data: allVariants } = await supabase.from("variants").select("id, product_id");
  if (!allVariants?.length) return 0;

  const { data: allInv } = await supabase.from("inventory").select("variant_id");
  const existingVariantIds = new Set<string>((allInv ?? []).map((i: any) => i.variant_id));

  const missing = (allVariants as any[]).filter((v: any) => !existingVariantIds.has(v.id));
  if (missing.length === 0) return 0;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK).map((v: any) => ({
      variant_id: v.id,
      product_id: v.product_id,
      total_stock: 0,
    }));
    const { error } = await supabase.from("inventory").insert(chunk);
    if (!error) fixed += chunk.length;
  }

  return fixed;
}
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const appId = Deno.env.get("EBAY_APP_ID");
    const certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "Missing EBAY_APP_ID or EBAY_CERT_ID" }, 500);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const clearFirst = body?.clearFirst === true || body?.mode === "full";

    const { data: tokenRow } = await supabase
      .from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    if (!tokenRow?.value) return json({ error: "No eBay refresh token — connect eBay in Settings first" }, 400);

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
    if (!tokenData.access_token) return json({ error: "eBay token refresh failed", detail: JSON.stringify(tokenData) }, 500);

    const accessToken: string = tokenData.access_token;
    if (tokenData.refresh_token && tokenData.refresh_token !== tokenRow.value) {
      await supabase.from("sync_secrets").upsert({ key: "ebay_refresh_token", value: tokenData.refresh_token }, { onConflict: "key" });
    }

    const items = await fetchAllListings(accessToken);

    if (clearFirst) {
      await supabase.from("channel_listings").delete().not("id", "is", null);
      await supabase.from("inventory").delete().not("variant_id", "is", null);
      await supabase.from("variants").delete().not("id", "is", null);
      await supabase.from("products").delete().not("id", "is", null);

      const stats = await fullInsert(supabase, items);
      const invFixed = await ensureInventoryRows(supabase);

      await supabase.from("sync_log").insert({
        sync_type: "ebay_import",
        status: "completed",
        details: JSON.stringify({ mode: "full_reset", ...stats, inventory_gaps_fixed: invFixed }),
        source: "edge_function",
      });

      return json({ success: true, mode: "full_reset", ...stats, inventory_gaps_fixed: invFixed });

    } else {
      const stats = await quickSyncWithNewListings(supabase, items);

      await supabase.from("sync_log").insert({
        sync_type: "ebay_import",
        status: "completed",
        details: JSON.stringify({ mode: "quick_sync", ...stats }),
        source: "edge_function",
      });

      return json({ success: true, mode: "quick_sync", ...stats });
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ebay-import crash:", msg);
    return json({ error: msg }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xtag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
}

// FIX: Extract ALL NameValueList entries from a variation block and join them.
// Previously only grabbed the first <Value> tag, which caused some variants to
// get the wrong name or clash with others, leading to missing imports.
function parseVariationName(varXml: string): string {
  const nvMatches = [...varXml.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)];
  if (!nvMatches.length) return "";
  
  const parts: string[] = [];
  for (const [, nvXml] of nvMatches) {
    const value = xtag(nvXml, "Value");
    if (value) parts.push(value);
  }
  return parts.join(" / ");
}

type EbayVariation = { sku: string; price: string; name: string; qty: number; sold: number };

type EbayItem = {
  itemId: string;
  title: string;
  sku: string;
  price: string;
  qty: number;
  sold: number;
  variations: EbayVariation[];
};

async function fetchAllListings(token: string): Promise<EbayItem[]> {
  const items: EbayItem[] = [];
  let page = 1;

  while (true) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ActiveList>
    <Include>true</Include>
    <IncludeVariations>true</IncludeVariations>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const resp = await fetch(`${EBAY}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-SITEID": "3",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
      },
      body: xml,
    });

    const text = await resp.text();
    const itemMatches = [...text.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];
    if (itemMatches.length === 0) break;

    for (const [, itemXml] of itemMatches) {
      const itemId = xtag(itemXml, "ItemID") ?? "";
      const title = xtag(itemXml, "Title") ?? "";
      const sku = xtag(itemXml, "SKU") ?? itemId;
      const price = xtag(itemXml, "CurrentPrice") ?? xtag(itemXml, "StartPrice") ?? "0";
      const qty = parseInt(xtag(itemXml, "Quantity") ?? "0", 10);
      const sold = parseInt(xtag(itemXml, "QuantitySold") ?? "0", 10);

      const variations: EbayVariation[] = [];
      const varMatches = [...itemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      for (const [, varXml] of varMatches) {
        const vSku = xtag(varXml, "SKU") ?? "";
        const vPrice = xtag(varXml, "StartPrice") ?? price;
        const vQty = parseInt(xtag(varXml, "Quantity") ?? "0", 10);
        const vSold = parseInt(xtag(varXml, "QuantitySold") ?? "0", 10);
        // FIX: Use parseVariationName to get ALL name/value pairs, not just the first
        const vName = parseVariationName(varXml) || vSku;
        variations.push({ sku: vSku, price: vPrice, name: vName, qty: vQty, sold: vSold });
      }

      items.push({ itemId, title, sku, price, qty, sold, variations });
    }

    const totalPages = parseInt(text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1", 10);
    if (page >= totalPages) break;
    page++;
  }

  return items;
}

async function fullInsert(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  const CHUNK = 50;

  const productRows = [...new Map(
    items.map(i => [i.itemId, { name: i.title, sku: i.itemId, active: true }])
  ).values()];

  const productByItemId = new Map<string, string>();
  for (let i = 0; i < productRows.length; i += CHUNK) {
    const { data: inserted } = await supabase
      .from("products")
      .insert(productRows.slice(i, i + CHUNK))
      .select("id, sku");
    for (const p of (inserted ?? []) as any[]) productByItemId.set(p.sku, p.id);
  }

  const variantRows: { product_id: string; internal_sku: string; option1: string | null }[] = [];
  for (const item of items) {
    const productId = productByItemId.get(item.itemId);
    if (!productId) continue;
    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        variantRows.push({ product_id: productId, internal_sku: iSku, option1: v.name || null });
      }
    } else {
      variantRows.push({ product_id: productId, internal_sku: item.itemId, option1: null });
    }
  }

  const dedupedVarRows = [...new Map(variantRows.map(r => [r.internal_sku, r])).values()];

  const variantByISku = new Map<string, string>();
  for (let i = 0; i < dedupedVarRows.length; i += CHUNK) {
    const { data: inserted } = await supabase
      .from("variants")
      .insert(dedupedVarRows.slice(i, i + CHUNK))
      .select("id, internal_sku");
    for (const v of (inserted ?? []) as any[]) variantByISku.set(v.internal_sku, v.id);
  }

  const invRows: { variant_id: string; product_id: string; total_stock: number }[] = [];
  const listRows: any[] = [];

  for (const item of items) {
    const prodId = productByItemId.get(item.itemId);
    if (!prodId) continue;
    const cpid = `v1|${item.itemId}|0`;

    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        const varId = variantByISku.get(iSku);
        if (!varId) continue;

        const stock = Math.max(0, v.qty - v.sold);
        invRows.push({ variant_id: varId, product_id: prodId, total_stock: stock });
        listRows.push({
          variant_id: varId,
          channel: "ebay",
          channel_sku: v.sku || v.name,
          channel_price: parseFloat(v.price),
          channel_product_id: cpid,
          channel_variant_id: v.name || v.sku || iSku,
          last_synced_at: now,
        });
      }
    } else {
      const varId = variantByISku.get(item.itemId);
      if (!varId) continue;

      const stock = Math.max(0, item.qty - item.sold);
      invRows.push({ variant_id: varId, product_id: prodId, total_stock: stock });
      listRows.push({
        variant_id: varId,
        channel: "ebay",
        channel_sku: item.sku,
        channel_price: parseFloat(item.price),
        channel_product_id: cpid,
        channel_variant_id: "",
        last_synced_at: now,
      });
    }
  }

  for (let i = 0; i < invRows.length; i += CHUNK) {
    await supabase.from("inventory").insert(invRows.slice(i, i + CHUNK));
  }
  for (let i = 0; i < listRows.length; i += CHUNK) {
    await supabase.from("channel_listings").insert(listRows.slice(i, i + CHUNK));
  }

  return {
    products_inserted: productRows.length,
    variants_inserted: dedupedVarRows.length,
    inventory_rows: invRows.length,
    listings_inserted: listRows.length,
  };
}

async function quickSyncWithNewListings(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  let updated = 0;
  let created = 0;

  const { data: existingListings } = await supabase
    .from("channel_listings")
    .select("id, channel_product_id, channel_variant_id, variant_id")
    .eq("channel", "ebay");

  // Match existing listings by internal variant_id — this is the stable key set by merges.
  // We also keep a channel_variant_id lookup for brand new listings that haven't been merged yet.
  // This means: if you merge a variant, the import will ALWAYS find it by variant_id
  // regardless of whether eBay changes the variation name format.
  const listingByVariantId = new Map<string, string>();   // cpid::variant_id -> listing id
  const listingByCvid = new Map<string, string>();         // cpid::cvid -> listing id
  const cpidToProductId = new Map<string, string>();

  const existingVariantIds = [...new Set(((existingListings ?? []) as any[]).map((l: any) => l.variant_id))];

  if (existingVariantIds.length > 0) {
    const CHUNK = 150;
    const variantRows: any[] = [];
    for (let i = 0; i < existingVariantIds.length; i += CHUNK) {
      const { data } = await supabase
        .from("variants")
        .select("id, product_id")
        .in("id", existingVariantIds.slice(i, i + CHUNK));
      variantRows.push(...(data ?? []));
    }

    const variantToProduct = new Map<string, string>();
    for (const v of variantRows) variantToProduct.set(v.id, v.product_id);

    for (const l of (existingListings ?? []) as any[]) {
      const cvid = l.channel_variant_id ?? "";
      listingByVariantId.set(`${l.channel_product_id}::${l.variant_id}`, l.id);
      listingByCvid.set(`${l.channel_product_id}::${cvid}`, l.id);
      const pid = variantToProduct.get(l.variant_id);
      if (pid) cpidToProductId.set(l.channel_product_id, pid);
    }
  }

  const { data: allProducts } = await supabase.from("products").select("id, name");
  const productByName = new Map<string, string>();
  for (const p of (allProducts ?? []) as any[]) {
    productByName.set(p.name.toLowerCase().trim(), p.id);
  }

  const updateBatch: { id: string; channel_price: number; last_synced_at: string }[] = [];

  type NewEntry = {
    productId: string | null;
    productName: string;
    productSku: string;
    internalSku: string;
    option1: string | null;
    cpid: string;
    cvid: string | null;
    channelSku: string;
    price: number;
    stock: number;
  };
  const newEntries: NewEntry[] = [];

  // Load existing variants so we can look up variant_id by internal_sku for matching
  const { data: existingVariants } = await supabase
    .from("variants")
    .select("id, product_id, internal_sku, option1");

  const variantByProductAndSku = new Map<string, string>();
  const variantByProductAndOption = new Map<string, string>();
  for (const v of (existingVariants ?? []) as any[]) {
    if (v.internal_sku) variantByProductAndSku.set(`${v.product_id}:${v.internal_sku}`, v.id);
    if (v.option1) variantByProductAndOption.set(`${v.product_id}:${v.option1}`, v.id);
  }

  for (const item of items) {
    const cpid = `v1|${item.itemId}|0`;

    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const cvid = v.name || v.sku || `${item.itemId}-${v.name}`;
        const iSku = v.sku || `${item.itemId}-${v.name}`;

        // Try to find existing listing:
        // 1. By cpid + internal_sku (most reliable — survives name format changes)
        // 2. By cpid + channel_variant_id (for unmerged listings)
        const productId = cpidToProductId.get(cpid) ?? null;
        let existingId: string | undefined;

        if (productId) {
          const variantId = variantByProductAndSku.get(`${productId}:${iSku}`)
            ?? variantByProductAndOption.get(`${productId}:${v.name}`);
          if (variantId) {
            existingId = listingByVariantId.get(`${cpid}::${variantId}`);
          }
        }
        if (!existingId) existingId = listingByCvid.get(`${cpid}::${cvid}`);

        if (existingId) {
          updateBatch.push({ id: existingId, channel_price: parseFloat(v.price), last_synced_at: now });
        } else {
          newEntries.push({
            productId,
            productName: item.title,
            productSku: item.sku,
            internalSku: iSku,
            option1: v.name || null,
            cpid,
            cvid,
            channelSku: v.sku || v.name,
            price: parseFloat(v.price),
            stock: Math.max(0, v.qty - v.sold),
          });
        }
      }
    } else {
      const existingId = listingByCvid.get(`${cpid}::`);

      if (existingId) {
        updateBatch.push({ id: existingId, channel_price: parseFloat(item.price), last_synced_at: now });
      } else {
        const productId = cpidToProductId.get(cpid) ?? null;
        newEntries.push({
          productId,
          productName: item.title,
          productSku: item.sku,
          internalSku: item.itemId,
          option1: null,
          cpid,
          cvid: null,
          channelSku: item.sku || item.itemId,
          price: parseFloat(item.price) || 0,
          stock: Math.max(0, item.qty - item.sold),
        });
      }
    }
  }

  if (updateBatch.length > 0) {
    const UPCHUNK = 200;
    for (let ci = 0; ci < updateBatch.length; ci += UPCHUNK) {
      await supabase.from("channel_listings").upsert(updateBatch.slice(ci, ci + UPCHUNK));
    }
    updated = updateBatch.length;
  }

  const needProduct = newEntries.filter(e => !e.productId);
  const uniqueNewProducts = [...new Map(needProduct.map(e => [e.productName, e])).values()];

  for (const e of uniqueNewProducts) {
    const { data: inserted } = await supabase.from("products")
      .insert({ name: e.productName, sku: e.productSku, active: true })
      .select("id, name")
      .single();
    if (inserted) {
      productByName.set(e.productName.toLowerCase().trim(), inserted.id);
      for (const entry of newEntries) {
        if (!entry.productId && entry.productName === e.productName) {
          entry.productId = inserted.id;
        }
      }
    }
  }

  for (const e of newEntries) {
    if (!e.productId) continue;

    const { data: existingVar } = await supabase.from("variants")
      .select("id")
      .eq("product_id", e.productId)
      .eq("internal_sku", e.internalSku)
      .maybeSingle();

    let variantId: string | null = existingVar?.id ?? null;

    if (!variantId) {
      const { data: newVar } = await supabase.from("variants")
        .insert({ product_id: e.productId, internal_sku: e.internalSku, option1: e.option1 })
        .select("id")
        .single();
      variantId = newVar?.id ?? null;
    }

    if (!variantId) continue;

    const { data: existingInv } = await supabase.from("inventory")
      .select("id")
      .eq("variant_id", variantId)
      .maybeSingle();

    if (!existingInv) {
      await supabase.from("inventory").insert({
        variant_id: variantId,
        product_id: e.productId,
        total_stock: e.stock,
      });
    }

    await supabase.from("channel_listings").insert({
      variant_id: variantId,
      channel: "ebay",
      channel_sku: e.channelSku,
      channel_price: e.price,
      channel_product_id: e.cpid,
      channel_variant_id: e.cvid ?? null,
      last_synced_at: now,
    });

    created++;
  }

  return {
    listings_updated: updated,
    new_listings_created: created,
  };
}

async function ensureInventoryRows(supabase: any): Promise<number> {
  const CHUNK = 500;
  let fixed = 0;

  const { data: allVariants } = await supabase.from("variants").select("id, product_id");
  if (!allVariants?.length) return 0;

  const { data: allInv } = await supabase.from("inventory").select("variant_id");
  const existingVariantIds = new Set<string>((allInv ?? []).map((i: any) => i.variant_id));

  const missing = (allVariants as any[]).filter((v: any) => !existingVariantIds.has(v.id));
  if (missing.length === 0) return 0;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK).map((v: any) => ({
      variant_id: v.id,
      product_id: v.product_id,
      total_stock: 0,
    }));
    const { error } = await supabase.from("inventory").insert(chunk);
    if (!error) fixed += chunk.length;
  }

  return fixed;
}
