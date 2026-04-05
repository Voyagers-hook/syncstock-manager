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

    // ── Get refresh token ─────────────────────────────────────────────────────
    const { data: tokenRow } = await supabase
      .from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    if (!tokenRow?.value) return json({ error: "No eBay refresh token — connect eBay in Settings first" }, 400);

    // ── Refresh access token ──────────────────────────────────────────────────
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

    // ── Fetch all eBay listings ───────────────────────────────────────────────
    const items = await fetchAllListings(accessToken);

    if (clearFirst) {
      // ── FULL RESET: Wipe everything and reimport clean ────────────────────
      // Delete in FK-safe order: channel_listings → inventory → variants → products
      await supabase.from("channel_listings").delete().not("id", "is", null);
      await supabase.from("inventory").delete().not("variant_id", "is", null);
      await supabase.from("variants").delete().not("id", "is", null);
      await supabase.from("products").delete().not("id", "is", null);

      // Fresh import with actual current stock from eBay
      const stats = await fullInsert(supabase, items);

      await supabase.from("sync_log").insert({
        sync_type: "ebay_import",
        status: "completed",
        details: JSON.stringify({ mode: "full_reset", ...stats }),
        source: "edge_function",
      });

      return json({ success: true, mode: "full_reset", ...stats });

    } else {
      // ── QUICK SYNC: Update prices on existing + import any new listings ───
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

// ─── helpers ─────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

function xtag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
}

// ─── eBay XML types ───────────────────────────────────────────────────────────

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

// ─── fetch all active eBay listings ──────────────────────────────────────────

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

      // Parse variations
      const variations: EbayVariation[] = [];
      const varMatches = [...itemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      for (const [, varXml] of varMatches) {
        const vSku = xtag(varXml, "SKU") ?? "";
        const vPrice = xtag(varXml, "StartPrice") ?? price;
        const vQty = parseInt(xtag(varXml, "Quantity") ?? "0", 10);
        const vSold = parseInt(xtag(varXml, "QuantitySold") ?? "0", 10);
        // Get variation name from NameValueList
        const nameMatch = varXml.match(/<Value>([^<]+)<\/Value>/);
        const vName = nameMatch ? nameMatch[1].trim() : vSku;
        variations.push({ sku: vSku, price: vPrice, name: vName, qty: vQty, sold: vSold });
      }

      items.push({ itemId, title, sku, price, qty, sold, variations });
    }

    // Check if there are more pages
    const totalPages = parseInt(text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1", 10);
    if (page >= totalPages) break;
    page++;
  }

  return items;
}

// ─── Full Reset: insert everything fresh ─────────────────────────────────────

async function fullInsert(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  const CHUNK = 50;

  // Pass 1: Insert all unique products
  const productRows = [...new Map(
    items.map(i => [i.sku, { name: i.title, sku: i.sku, active: true }])
  ).values()];

  const productBySku = new Map<string, string>();
  for (let i = 0; i < productRows.length; i += CHUNK) {
    const { data: inserted } = await supabase
      .from("products")
      .insert(productRows.slice(i, i + CHUNK))
      .select("id, sku");
    for (const p of (inserted ?? []) as any[]) productBySku.set(p.sku, p.id);
  }

  // Pass 2: Insert all variants
  const variantRows: { product_id: string; internal_sku: string; option1: string | null }[] = [];
  for (const item of items) {
    const productId = productBySku.get(item.sku);
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

  // Deduplicate by internal_sku
  const dedupedVarRows = [...new Map(variantRows.map(r => [r.internal_sku, r])).values()];

  const variantByISku = new Map<string, string>();
  for (let i = 0; i < dedupedVarRows.length; i += CHUNK) {
    const { data: inserted } = await supabase
      .from("variants")
      .insert(dedupedVarRows.slice(i, i + CHUNK))
      .select("id, internal_sku");
    for (const v of (inserted ?? []) as any[]) variantByISku.set(v.internal_sku, v.id);
  }

  // Pass 3: Insert inventory and channel_listings
  const invRows: { variant_id: string; product_id: string; total_stock: number }[] = [];
  const listRows: any[] = [];

  for (const item of items) {
    const prodId = productBySku.get(item.sku);
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

// ─── Quick Sync: update prices + import any brand-new listings ────────────────
// Safe: never touches or duplicates existing merged products.
// New variations on existing eBay items → added under same product.
// Completely new eBay items → product name matched first, then created if no match.

async function quickSyncWithNewListings(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();
  let updated = 0;
  let created = 0;

  // 1. Load all existing eBay channel_listings with their variant_ids
  const { data: existingListings } = await supabase
    .from("channel_listings")
    .select("id, channel_product_id, channel_variant_id, variant_id")
    .eq("channel", "ebay");

  // Map: "cpid::cvid" → listing id (for price updates)
  const listingMap = new Map<string, string>();
  // Map: cpid → product_id (so new variations go under the same product)
  const cpidToProductId = new Map<string, string>();

  const existingVariantIds = [...new Set(((existingListings ?? []) as any[]).map((l: any) => l.variant_id))];

  if (existingVariantIds.length > 0) {
    const { data: variantRows } = await supabase
      .from("variants")
      .select("id, product_id")
      .in("id", existingVariantIds);

    const variantToProduct = new Map<string, string>();
    for (const v of (variantRows ?? []) as any[]) variantToProduct.set(v.id, v.product_id);

    for (const l of (existingListings ?? []) as any[]) {
      listingMap.set(`${l.channel_product_id}::${l.channel_variant_id}`, l.id);
      const pid = variantToProduct.get(l.variant_id);
      if (pid) cpidToProductId.set(l.channel_product_id, pid);
    }
  }

  // 2. Load all existing products for name-based dedup
  const { data: allProducts } = await supabase.from("products").select("id, name");
  const productByName = new Map<string, string>();
  for (const p of (allProducts ?? []) as any[]) {
    productByName.set(p.name.toLowerCase().trim(), p.id);
  }

  // 3. Process each eBay item
  const updateBatch: { id: string; channel_price: number; last_synced_at: string }[] = [];
  // Collect new items to process
  type NewEntry = {
    productId: string | null;
    productName: string;
    productSku: string;
    internalSku: string;
    option1: string | null;
    cpid: string;
    cvid: string;
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
          // New variation — find product via same eBay item ID, then name, then create
          const productId = cpidToProductId.get(cpid) ?? productByName.get(item.title.toLowerCase().trim()) ?? null;
          const iSku = v.sku || `${item.itemId}-${v.name}`;
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
      const key = `${cpid}::`;
      const existingId = listingMap.get(key);

      if (existingId) {
        updateBatch.push({ id: existingId, channel_price: parseFloat(item.price), last_synced_at: now });
      } else {
        const productId = cpidToProductId.get(cpid) ?? productByName.get(item.title.toLowerCase().trim()) ?? null;
        newEntries.push({
          productId,
          productName: item.title,
          productSku: item.sku,
          internalSku: item.itemId,
          option1: null,
          cpid,
          cvid: "",
          channelSku: item.sku,
          price: parseFloat(item.price),
          stock: Math.max(0, item.qty - item.sold),
        });
      }
    }
  }

  // 4. Apply price updates
  for (const row of updateBatch) {
    await supabase.from("channel_listings")
      .update({ channel_price: row.channel_price, last_synced_at: row.last_synced_at })
      .eq("id", row.id);
    updated++;
  }

  // 5. Create products for entries that still have no productId
  const needProduct = newEntries.filter(e => !e.productId);
  const uniqueNewProducts = [...new Map(needProduct.map(e => [e.productName, e])).values()];

  for (const e of uniqueNewProducts) {
    const { data: inserted } = await supabase.from("products")
      .insert({ name: e.productName, sku: e.productSku, active: true })
      .select("id, name")
      .single();
    if (inserted) {
      productByName.set(e.productName.toLowerCase().trim(), inserted.id);
      // Assign to all matching entries
      for (const entry of newEntries) {
        if (!entry.productId && entry.productName === e.productName) {
          entry.productId = inserted.id;
        }
      }
    }
  }

  // 6. Create variants, inventory, channel_listings for each new entry
  for (const e of newEntries) {
    if (!e.productId) continue;

    // Check if variant already exists (avoid duplicate if somehow present)
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

    // Upsert inventory (don't overwrite existing stock if variant already had inventory)
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

    // Insert channel_listing (skip if somehow already there due to race)
    await supabase.from("channel_listings").upsert({
      variant_id: variantId,
      channel: "ebay",
      channel_sku: e.channelSku,
      channel_price: e.price,
      channel_product_id: e.cpid,
      channel_variant_id: e.cvid,
      last_synced_at: now,
    }, { onConflict: "channel,channel_variant_id" });

    created++;
  }

  return {
    listings_updated: updated,
    new_listings_created: created,
  };
}
