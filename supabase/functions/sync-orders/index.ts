import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY_API_BASE = "https://api.ebay.com";
const SQ_API_BASE = "https://api.squarespace.com/1.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const stats = { ebay_orders: 0, sq_orders: 0, stock_adjustments: 0, errors: [] as string[] };

  try {
    // --- eBay Orders ---
    const ebayAppId = Deno.env.get("EBAY_APP_ID");
    const ebayCertId = Deno.env.get("EBAY_CERT_ID");
    
    const { data: refreshTokenRow } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    const { data: lastEbaySyncRow } = await supabase.from("sync_secrets").select("value").eq("key", "last_ebay_order_sync").single();

    if (refreshTokenRow?.value && ebayAppId && ebayCertId) {
      const accessToken = await getEbayAccessToken(ebayAppId, ebayCertId, refreshTokenRow.value, supabase);
      const fromDate = lastEbaySyncRow?.value || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const toDate = new Date().toISOString();

      const ebayOrders = await fetchEbayOrders(accessToken, fromDate, toDate);
      
      for (const order of ebayOrders) {
        const { data: alreadyProcessed } = await supabase
          .from("sync_secrets")
          .select("id")
          .eq("key", `processed_ebay_${order.orderId}`)
          .maybeSingle();

        if (alreadyProcessed) continue;

        for (const lineItem of order.lineItems) {
          try {
            await adjustStockForEbayItem(supabase, lineItem, accessToken);
            stats.stock_adjustments++;
          } catch (e: any) {
            stats.errors.push(`eBay order ${order.orderId} item ${lineItem.itemId}: ${e.message}`);
          }
        }

        await supabase.from("sync_secrets").upsert({ key: `processed_ebay_${order.orderId}`, value: "1" }, { onConflict: "key" });
        stats.ebay_orders++;
      }

      // Update last sync time
      await supabase.from("sync_secrets").upsert(
        { key: "last_ebay_order_sync", value: new Date().toISOString() },
        { onConflict: "key" }
      );
    }

    // --- Squarespace Orders ---
    const sqApiKey = Deno.env.get("SQUARESPACE_API");
    const { data: lastSqSyncRow } = await supabase.from("sync_secrets").select("value").eq("key", "last_sq_order_sync").single();

    if (sqApiKey) {
      const fromDate = lastSqSyncRow?.value || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const sqOrders = await fetchSquarespaceOrders(sqApiKey, fromDate);

      for (const order of sqOrders) {
        const { data: alreadyProcessed } = await supabase
          .from("processed_orders")
          .select("id")
          .eq("channel", "squarespace")
          .eq("order_id", order.id)
          .single();

        if (alreadyProcessed) continue;

        for (const lineItem of order.lineItems) {
          try {
            await adjustStockForSquarespaceItem(supabase, lineItem, sqApiKey);
            stats.stock_adjustments++;
          } catch (e: any) {
            stats.errors.push(`SQ order ${order.id} item ${lineItem.variantId}: ${e.message}`);
          }
        }

        await supabase.from("sync_secrets").upsert({ key: `processed_sq_${order.id}`, value: "1" }, { onConflict: "key" });
        stats.sq_orders++;
      }

      await supabase.from("sync_secrets").upsert(
        { key: "last_sq_order_sync", value: new Date().toISOString() },
        { onConflict: "key" }
      );
    }

    await supabase.from("sync_log").insert({
      sync_type: "order_sync",
      status: stats.errors.length === 0 ? "completed" : "partial",
      details: JSON.stringify(stats),
      source: "edge_function",
    });

    return new Response(JSON.stringify({ success: true, ...stats }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("sync-orders error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function getEbayAccessToken(appId: string, certId: string, refreshToken: string, supabase: any): Promise<string> {
  const credentials = btoa(`${appId}:${certId}`);
  const resp = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    }),
  });
  if (!resp.ok) throw new Error(`eBay token refresh failed: ${await resp.text()}`);
  const data = await resp.json();
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await supabase.from("sync_secrets").upsert({ key: "ebay_refresh_token", value: data.refresh_token }, { onConflict: "key" });
  }
  return data.access_token;
}

async function fetchEbayOrders(accessToken: string, fromDate: string, toDate: string): Promise<any[]> {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
  <ModTimeFrom>${fromDate}</ModTimeFrom>
  <ModTimeTo>${toDate}</ModTimeTo>
  <OrderStatus>Completed</OrderStatus>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
</GetOrdersRequest>`;

  const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-CALL-NAME": "GetOrders",
      "X-EBAY-API-SITEID": "3",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: xmlBody,
  });

  if (!resp.ok) {
    console.error("eBay GetOrders failed:", await resp.text());
    return [];
  }

  const xml = await resp.text();
  const orders: any[] = [];
  const orderRegex = /<Order>([\s\S]*?)<\/Order>/g;
  let orderMatch;

  while ((orderMatch = orderRegex.exec(xml)) !== null) {
    const orderXml = orderMatch[1];
    const orderId = extractTag(orderXml, "OrderID");
    if (!orderId) continue;

    const lineItems: any[] = [];
    const txRegex = /<Transaction>([\s\S]*?)<\/Transaction>/g;
    let txMatch;
    while ((txMatch = txRegex.exec(orderXml)) !== null) {
      const txXml = txMatch[1];
      const itemId = extractTag(txXml, "ItemID");
      const sku = extractTag(txXml, "SKU");
      const qty = parseInt(extractTag(txXml, "QuantityPurchased") || "1");
      
      // Extract variation name if present
      const varNameParts: string[] = [];
      const nvRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
      let nvMatch;
      while ((nvMatch = nvRegex.exec(txXml)) !== null) {
        const val = extractTag(nvMatch[1], "Value");
        if (val) varNameParts.push(val);
      }
      
      if (itemId) {
        lineItems.push({ 
          itemId, 
          sku, 
          quantity: qty, 
          variantName: varNameParts.join(" / ") || null
        });
      }
    }

    if (lineItems.length > 0) {
      orders.push({ orderId, lineItems });
    }
  }

  return orders;
}

async function fetchSquarespaceOrders(apiKey: string, fromDate: string): Promise<any[]> {
  const url = `${SQ_API_BASE}/commerce/orders?modifiedAfter=${encodeURIComponent(fromDate)}&fulfillmentStatus=PENDING`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "SyncStock/1.0" },
  });

  if (!resp.ok) {
    console.error("Squarespace orders fetch failed:", await resp.text());
    return [];
  }

  const data = await resp.json();
  return data.result || [];
}

async function adjustStockForEbayItem(supabase: any, lineItem: any, ebayToken: string) {
  const channelProductId = `v1|${lineItem.itemId}|0`;
  
  // Find the channel_listing for this eBay item
  let query = supabase
    .from("channel_listings")
    .select("variant_id, channel_sku, channel_variant_id")
    .eq("channel", "ebay")
    .eq("channel_product_id", channelProductId);

  // If we have a variant name, filter by it
  if (lineItem.variantName) {
    query = query.eq("channel_variant_id", lineItem.variantName);
  } else if (lineItem.sku) {
    query = query.eq("channel_sku", lineItem.sku);
  } else {
    query = query.eq("channel_variant_id", "");
  }

  const { data: listings } = await query.limit(1);
  if (!listings || listings.length === 0) {
    console.warn(`No listing found for eBay item ${lineItem.itemId} variant "${lineItem.variantName}"`);
    return;
  }

  const variantId = listings[0].variant_id;
  await adjustAndPushStock(supabase, variantId, lineItem.quantity, ebayToken);
}

async function adjustStockForSquarespaceItem(supabase: any, lineItem: any, sqApiKey: string) {
  if (!lineItem.variantId) return;

  const { data: listings } = await supabase
    .from("channel_listings")
    .select("variant_id")
    .eq("channel", "squarespace")
    .eq("channel_variant_id", lineItem.variantId)
    .limit(1);

  if (!listings || listings.length === 0) {
    console.warn(`No listing found for Squarespace variant ${lineItem.variantId}`);
    return;
  }

  const variantId = listings[0].variant_id;
  const ebayAppId = Deno.env.get("EBAY_APP_ID");
  const ebayCertId = Deno.env.get("EBAY_CERT_ID");
  let ebayToken: string | null = null;

  if (ebayAppId && ebayCertId) {
    const { data: rt } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    if (rt?.value) {
      ebayToken = await getEbayAccessToken(ebayAppId, ebayCertId, rt.value, supabase).catch(() => null);
    }
  }

  await adjustAndPushStock(supabase, variantId, lineItem.quantity || 1, ebayToken);
}

async function adjustAndPushStock(supabase: any, variantId: string, qtySold: number, ebayToken: string | null) {
  // Get current stock
  const { data: inv } = await supabase
    .from("inventory")
    .select("total_stock")
    .eq("variant_id", variantId)
    .single();

  if (!inv) return;

  const newStock = Math.max(0, (inv.total_stock || 0) - qtySold);

  // Update internal inventory
  await supabase
    .from("inventory")
    .update({ total_stock: newStock })
    .eq("variant_id", variantId);

  // Get all channel_listings for this variant (push to all linked platforms)
  const { data: allListings } = await supabase
    .from("channel_listings")
    .select("*")
    .eq("variant_id", variantId);

  if (!allListings) return;

  const sqApiKey = Deno.env.get("SQUARESPACE_API");

  for (const listing of allListings) {
    try {
      if (listing.channel === "ebay" && ebayToken) {
        await pushEbayStock(listing, newStock, ebayToken);
        await supabase.from("channel_listings").update({ last_synced_at: new Date().toISOString() }).eq("id", listing.id);
      } else if (listing.channel === "squarespace" && sqApiKey) {
        await pushSquarespaceStock(listing, newStock, sqApiKey);
        await supabase.from("channel_listings").update({ last_synced_at: new Date().toISOString() }).eq("id", listing.id);
      }
    } catch (e: any) {
      console.error(`Failed to push stock to ${listing.channel}:`, e.message);
    }
  }
}

async function pushEbayStock(listing: any, stock: number, token: string) {
  const itemId = listing.channel_product_id?.match(/\d+/)?.[0] || listing.channel_product_id;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    ${listing.channel_sku ? `<SKU>${listing.channel_sku}</SKU>` : ""}
    <Quantity>${stock}</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

  const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "ReviseInventoryStatus",
      "X-EBAY-API-SITEID": "3",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1451",
      "Content-Type": "text/xml",
      "Authorization": `Bearer ${token}`,
    },
    body: xml,
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    console.error("eBay stock push failed:", text);
  }
}

async function pushSquarespaceStock(listing: any, stock: number, apiKey: string) {
  const resp = await fetch(`${SQ_API_BASE}/commerce/inventory/adjustments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      setFiniteOperations: [{ variantId: listing.channel_variant_id, quantity: stock }],
    }),
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    console.error("Squarespace stock push failed:", text);
  }
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}
