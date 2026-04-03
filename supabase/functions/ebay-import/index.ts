import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

const EBAY_API_BASE = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const ebayAppId = Deno.env.get("EBAY_APP_ID");
  const ebayCertId = Deno.env.get("EBAY_CERT_ID");

  if (!ebayAppId || !ebayCertId) {
    return new Response(
      JSON.stringify({ error: "Missing EBAY_APP_ID or EBAY_CERT_ID" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const body = await req.json().catch(() => ({}));
  const clearFirst: boolean = body?.clearFirst === true || body?.mode === "full";

  try {
    const { data: storedToken } = await supabase
      .from("sync_secrets")
      .select("value")
      .eq("key", "ebay_refresh_token")
      .single();

    if (!storedToken?.value) {
      return new Response(
        JSON.stringify({ error: "No eBay refresh token found. Please authorise via the eBay Auth flow first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userToken = await getOAuthAccessToken(ebayAppId, ebayCertId, storedToken.value, supabase);
    
    // If full reset, wipe ONLY eBay data first
    if (clearFirst) {
      console.log("Full reset: clearing eBay data only...");
      await supabase.from("channel_listings").delete().eq("channel", "ebay");
      console.log("eBay data cleared. Starting fresh import...");
    }

    const listings = await fetchAllEbayListings(userToken);
    const stats = await upsertListings(supabase, listings);

    await supabase.from("sync_log").insert({
      sync_type: "ebay_import",
      status: "completed",
      details: JSON.stringify(stats),
      source: "edge_function",
    }).catch(() => {});

    return new Response(
      JSON.stringify({ success: true, imported: stats.listings_upserted, ...stats }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("eBay import error:", msg);

    await supabase.from("sync_log").insert({
      sync_type: "ebay_import",
      status: "failed",
      error_message: msg,
      source: "edge_function",
    }).catch(() => {});

    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function getOAuthAccessToken(
  appId: string,
  certId: string,
  refreshToken: string,
  supabase: any,
): Promise<string> {
  const credentials = btoa(`${appId}:${certId}`);
  const resp = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`eBay OAuth token exchange failed [${resp.status}]: ${text}`);
  }

  const data = await resp.json();

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await supabase
      .from("sync_secrets")
      .upsert(
        { key: "ebay_refresh_token", value: data.refresh_token, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
  }

  return data.access_token;
}

interface EbayItem {
  itemId: string;
  title: string;
  sku?: string;
  price: { value: string; currency: string };
  variations?: EbayVariation[];
  quantityAvailable?: number;
}

interface EbayVariation {
  sku: string;
  startPrice: string;
  variantName: string;
  quantity: number;
  quantitySold: number;
}

async function fetchAllEbayListings(authToken: string): Promise<EbayItem[]> {
  const allItems: EbayItem[] = [];
  let page = 1;
  const entriesPerPage = 200;

  while (true) {
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${authToken}</eBayAuthToken>
  </RequesterCredentials>
  <ActiveList>
    <Sort>ItemID</Sort>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>Low</WarningLevel>
</GetMyeBaySellingRequest>`;

    const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-SITEID": "3",
        "Authorization": `Bearer ${authToken}`,
      },
      body: xmlBody,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`eBay GetMyeBaySelling failed [${resp.status}]: ${text}`);
    }

    const xml = await resp.text();
    const items = parseEbayXml(xml);
    if (!items.length) break;
    allItems.push(...items);

    const totalPagesMatch = xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
    const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1;
    if (page >= totalPages) break;
    page++;
  }

  return allItems;
}

function parseEbayXml(xml: string): EbayItem[] {
  const items: EbayItem[] = [];
  const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const itemId = extractTag(itemXml, "ItemID");
    const title = extractTag(itemXml, "Title");
    const priceStr = extractTag(itemXml, "CurrentPrice") || extractTag(itemXml, "BuyItNowPrice") || "0";
    const currencyMatch = itemXml.match(/currencyID="(\w+)"/);
    const currency = currencyMatch ? currencyMatch[1] : "GBP";
    const sku = extractTag(itemXml, "SKU");
    const quantity = parseInt(extractTag(itemXml, "Quantity") || "0");
    const quantitySold = parseInt(extractTag(itemXml, "QuantitySold") || "0");

    if (!itemId || !title) continue;

    const item: EbayItem = {
      itemId,
      title,
      sku: sku || undefined,
      price: { value: priceStr, currency },
      quantityAvailable: Math.max(0, quantity - quantitySold),
    };

    const variationsMatch = itemXml.match(/<Variations>([\s\S]*?)<\/Variations>/);
    if (variationsMatch) {
      const variations: EbayVariation[] = [];
      const varRegex = /<Variation>([\s\S]*?)<\/Variation>/g;
      let varMatch;
      while ((varMatch = varRegex.exec(variationsMatch[1])) !== null) {
        const varXml = varMatch[1];
        const varSku = extractTag(varXml, "SKU") || "";
        const varPrice = extractTag(varXml, "StartPrice") || priceStr;
        const varQty = parseInt(extractTag(varXml, "Quantity") || "0");
        const varSold = parseInt(extractTag(varXml, "QuantitySold") || "0");
        const nameParts: string[] = [];
        const specRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let specMatch;
        while ((specMatch = specRegex.exec(varXml)) !== null) {
          const value = extractTag(specMatch[1], "Value") || "";
          if (value) nameParts.push(value);
        }
        const variantName = nameParts.join(" / ");
        variations.push({
          sku: varSku,
          startPrice: varPrice,
          variantName,
          quantity: varQty,
          quantitySold: varSold,
        });
      }
      if (variations.length) item.variations = variations;
    }

    items.push(item);
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

async function upsertListings(supabase: any, items: EbayItem[]) {
  let productsUpserted = 0;
  let listingsUpserted = 0;

  for (const item of items) {
    const channelProductId = `v1|${item.itemId}|0`;

    // Upsert product
    const { data: product, error: prodErr } = await supabase
      .from("products")
      .upsert(
        {
          name: item.title,
          sku: item.sku || item.itemId,
          status: "active",
          active: true,
        },
        { onConflict: "sku", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (prodErr || !product) {
      // Product might already exist with different sku, try to find it
      const { data: existing } = await supabase
        .from("products")
        .select("id")
        .eq("sku", item.sku || item.itemId)
        .single();
      if (!existing) {
        console.error(`Failed to upsert product ${item.title}:`, prodErr?.message);
        continue;
      }
      productsUpserted++;
      await processItemListings(supabase, item, existing.id, channelProductId);
    } else {
      productsUpserted++;
      await processItemListings(supabase, item, product.id, channelProductId);
    }
    listingsUpserted++;
  }

  return {
    total_ebay_items: items.length,
    products_upserted: productsUpserted,
    listings_upserted: listingsUpserted,
  };
}

async function processItemListings(supabase: any, item: EbayItem, productId: string, channelProductId: string) {
  if (item.variations && item.variations.length > 0) {
    for (const variation of item.variations) {
      const variantKey = variation.sku || `${item.itemId}-${variation.variantName}`;
      const available = Math.max(0, variation.quantity - variation.quantitySold);
      const channelVariantId = variation.variantName || variation.sku || '';

      // Upsert variant
      const { data: variant } = await supabase
        .from("variants")
        .upsert(
          { product_id: productId, internal_sku: variantKey, option1: variation.variantName },
          { onConflict: "internal_sku", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (!variant) continue;

      // Upsert inventory
      await supabase
        .from("inventory")
        .upsert(
          { variant_id: variant.id, product_id: productId, total_stock: available },
          { onConflict: "variant_id" }
        );

      // Upsert channel_listing using the new unique constraint
      await supabase
        .from("channel_listings")
        .upsert(
          {
            variant_id: variant.id,
            channel: "ebay",
            channel_sku: variation.sku || variation.variantName,
            channel_price: parseFloat(variation.startPrice),
            channel_product_id: channelProductId,
            channel_variant_id: channelVariantId,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: "channel,channel_product_id,channel_variant_id" }
        );
    }
  } else {
    // Non-varianted item
    const variantKey = item.sku || item.itemId;
    const available = Math.max(0, item.quantityAvailable || 0);

    const { data: variant } = await supabase
      .from("variants")
      .upsert(
        { product_id: productId, internal_sku: variantKey },
        { onConflict: "internal_sku", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (!variant) return;

    await supabase
      .from("inventory")
      .upsert(
        { variant_id: variant.id, product_id: productId, total_stock: available },
        { onConflict: "variant_id" }
      );

    await supabase
      .from("channel_listings")
      .upsert(
        {
          variant_id: variant.id,
          channel: "ebay",
          channel_sku: item.sku || item.itemId,
          channel_price: parseFloat(item.price.value),
          channel_product_id: channelProductId,
          channel_variant_id: "",  // empty string for non-varianted (NOT null — avoids unique constraint NULL bypass)
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "channel,channel_product_id,channel_variant_id" }
      );
  }
}
