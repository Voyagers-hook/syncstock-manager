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

    // ── Full reset: remove old eBay data + orphans ────────────────────────────
    if (clearFirst) {
      // 1. Remove all eBay channel listings
      await supabase.from("channel_listings").delete().eq("channel", "ebay");

      // 2. Remove variants with zero remaining channel_listings (eBay-only orphans)
      // Use SQL-level delete to avoid URL length limits on large IN() sets
      const { data: orphanedVariants } = await supabase.rpc("get_orphaned_variant_ids");
      if (orphanedVariants && orphanedVariants.length > 0) {
        const orphanIds: string[] = orphanedVariants.map((r: { id: string }) => r.id);
        // Delete in chunks of 20 to stay under URL limits
        const DEL_CHUNK = 20;
        for (let i = 0; i < orphanIds.length; i += DEL_CHUNK) {
          const ids = orphanIds.slice(i, i + DEL_CHUNK);
          await supabase.from("inventory").delete().in("variant_id", ids);
          await supabase.from("variants").delete().in("id", ids);
        }
      }

      // 3. Remove products with zero remaining variants
      const { data: orphanedProducts } = await supabase.rpc("get_orphaned_product_ids");
      if (orphanedProducts && orphanedProducts.length > 0) {
        const orphanIds: string[] = orphanedProducts.map((r: { id: string }) => r.id);
        const DEL_CHUNK = 20;
        for (let i = 0; i < orphanIds.length; i += DEL_CHUNK) {
          await supabase.from("products").delete().in("id", orphanIds.slice(i, i + DEL_CHUNK));
        }
      }
    }

    // ── Bulk insert in 3 passes ───────────────────────────────────────────────
    const stats = await bulkInsert(supabase, items);

    try {
      await supabase.from("sync_log").insert({
        sync_type: "ebay_import",
        status: "completed",
        details: JSON.stringify(stats),
        source: "edge_function",
      });
    } catch (_) { /* ignore */ }

    return json({ success: true, ...stats });

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
  itemId: string; title: string; sku: string;
  price: string; qty: number; sold: number;
  variations: EbayVariation[];
};

// ─── Fetch all listings (pagination) ─────────────────────────────────────────

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
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>Low</WarningLevel>
</GetMyeBaySellingRequest>`;

    const r = await fetch(`${EBAY}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-SITEID": "3",
        Authorization: `Bearer ${token}`,
      },
      body: xml,
    });
    if (!r.ok) throw new Error(`eBay API [${r.status}]: ${await r.text()}`);
    const text = await r.text();
    const items = parseXml(text);
    all.push(...items);
    const totalPages = parseInt(xtag(text, "TotalNumberOfPages") ?? "1");
    if (page >= totalPages || items.length === 0) break;
    page++;
  }
  return all;
}

// ─── XML parser ───────────────────────────────────────────────────────────────

function parseXml(xml: string): EbayItem[] {
  const items: EbayItem[] = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const itemId = xtag(x, "ItemID");
    const title = xtag(x, "Title");
    if (!itemId || !title) continue;
    const priceStr = xtag(x, "CurrentPrice") ?? xtag(x, "BuyItNowPrice") ?? "0";
    const sku = xtag(x, "SKU") || itemId;  // fallback to itemId if sku is blank/missing
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

// ─── Bulk insert (3 round-trips, no upsert = no constraint dependency) ────────

async function bulkInsert(supabase: any, items: EbayItem[]) {
  const now = new Date().toISOString();

  // ── Pass 1: insert products ───────────────────────────────────────────────
  // Build unique product rows by sku (use existing product if sku already in DB from Squarespace)
  const allSkus = [...new Set(items.map(i => i.sku))];

  // Check which skus already exist (Squarespace products with same sku)
  const { data: existingProds } = await supabase.from("products").select("id, sku").in("sku", allSkus);
  const existingSkuMap = new Map<string, string>((existingProds ?? []).map((p: any) => [p.sku, p.id]));

  // Only insert products that DON'T exist yet
  const newProdRows = items
    .filter(item => !existingSkuMap.has(item.sku))
    .map(item => ({ name: item.title, sku: item.sku, active: true }));
  const uniqueNewProds = [...new Map(newProdRows.map(p => [p.sku, p])).values()];

  if (uniqueNewProds.length > 0) {
    const { data: inserted } = await supabase.from("products").insert(uniqueNewProds).select("id, sku");
    for (const p of (inserted ?? []) as any[]) existingSkuMap.set(p.sku, p.id);
  }

  const productBySku = existingSkuMap;

  // ── Pass 2: insert variants ───────────────────────────────────────────────
  // Build all variant rows to insert
  type VarInsert = { product_id: string; internal_sku: string; option1: string | null };
  const varRows: VarInsert[] = [];
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

  // Deduplicate varRows by internal_sku (some eBay items share SKUs)
  const seenVarSkus = new Set<string>();
  const dedupedVarRows = varRows.filter(r => {
    if (seenVarSkus.has(r.internal_sku)) return false;
    seenVarSkus.add(r.internal_sku);
    return true;
  });

  // Pre-load ALL existing variants so re-runs can match
  const variantByISku = new Map<string, string>();
  const insertErrors: string[] = [];
  {
    const allISkus = dedupedVarRows.map(r => r.internal_sku);
    const LOOKUP_CHUNK = 150;
    for (let i = 0; i < allISkus.length; i += LOOKUP_CHUNK) {
      const chunk = allISkus.slice(i, i + LOOKUP_CHUNK);
      const { data: existing } = await supabase
        .from("variants").select("id, internal_sku").in("internal_sku", chunk);
      for (const v of (existing ?? []) as any[]) variantByISku.set(v.internal_sku, v.id);
    }
  }
  // Insert only genuinely new variants
  for (const varRow of dedupedVarRows) {
    if (variantByISku.has(varRow.internal_sku)) continue;
    const { data: inserted, error: insErr } = await supabase
      .from("variants").insert(varRow).select("id, internal_sku");
    if (insErr) {
      insertErrors.push(`${varRow.internal_sku}: ${insErr.message}`);
    } else if (inserted && inserted.length > 0) {
      variantByISku.set(inserted[0].internal_sku, inserted[0].id);
    }
  }

  // ── Pass 3: inventory + channel_listings ──────────────────────────────────
  type InvInsert = { variant_id: string; product_id: string; total_stock: number };
  type ListInsert = { variant_id: string; channel: string; channel_sku: string; channel_price: number; channel_product_id: string; channel_variant_id: string; last_synced_at: string };

  const invRows: InvInsert[] = [];
  const listRows: ListInsert[] = [];
  const seenListings = new Set<string>();

  for (const item of items) {
    const cpid = `v1|${item.itemId}|0`;

    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const iSku = v.sku || `${item.itemId}-${v.name}`;
        const varId = variantByISku.get(iSku);
        const prodId = productBySku.get(item.sku);
        if (!varId || !prodId) continue;

        const stock = Math.max(0, v.qty - v.sold);
        invRows.push({ variant_id: varId, product_id: prodId, total_stock: stock });

        const cvid = v.name || v.sku || iSku;
        const lKey = `${cpid}::${cvid}`;
        if (!seenListings.has(lKey)) {
          seenListings.add(lKey);
          listRows.push({ variant_id: varId, channel: "ebay", channel_sku: v.sku || v.name, channel_price: parseFloat(v.price), channel_product_id: cpid, channel_variant_id: cvid, last_synced_at: now });
        }
      }
    } else {
      const iSku = item.itemId;
      const varId = variantByISku.get(iSku);
      const prodId = productBySku.get(item.sku);
      if (!varId || !prodId) continue;

      const stock = Math.max(0, item.qty - item.sold);
      invRows.push({ variant_id: varId, product_id: prodId, total_stock: stock });

      const lKey = `${cpid}::`;
      if (!seenListings.has(lKey)) {
        seenListings.add(lKey);
        listRows.push({ variant_id: varId, channel: "ebay", channel_sku: item.sku, channel_price: parseFloat(item.price), channel_product_id: cpid, channel_variant_id: "", last_synced_at: now });
      }
    }
  }

  // Inventory: update existing rows, insert new ones
  const CHUNK = 50;
  // First get all existing inventory variant_ids
  const existingInvSet = new Set<string>();
  for (let i = 0; i < invRows.length; i += 150) {
    const chunk = invRows.slice(i, i + 150).map(r => r.variant_id);
    const { data: existing } = await supabase.from("inventory").select("variant_id").in("variant_id", chunk);
    for (const inv of (existing ?? [])) existingInvSet.add(inv.variant_id);
  }
  // Update existing
  for (const row of invRows) {
    if (existingInvSet.has(row.variant_id)) {
      await supabase.from("inventory").update({ total_stock: row.total_stock }).eq("variant_id", row.variant_id);
    }
  }
  // Insert new
  const newInvRows = invRows.filter(r => !existingInvSet.has(r.variant_id));
  for (let i = 0; i < newInvRows.length; i += CHUNK) {
    await supabase.from("inventory").insert(newInvRows.slice(i, i + CHUNK));
  }
  for (let i = 0; i < listRows.length; i += CHUNK) {
    await supabase.from("channel_listings").insert(listRows.slice(i, i + CHUNK));
  }

  return {
    total_items: items.length,
    products_new: uniqueNewProds.length,
    variants_attempted: dedupedVarRows.length,
    variants_inserted: variantByISku.size,
    listings: listRows.length,
    insert_errors: insertErrors.slice(0, 5),  // show first 5 errors
  };
}
// force-redeploy-1775234014
