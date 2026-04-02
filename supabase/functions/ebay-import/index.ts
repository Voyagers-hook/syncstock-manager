import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.49.1/cors";

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
  let refreshToken = Deno.env.get("EBAY_REFRESH_TOKEN");

  if (!ebayAppId || !ebayCertId || !refreshToken) {
    return new Response(
      JSON.stringify({ error: "Missing eBay credentials" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Check if we have a rotated refresh token stored in DB
  const { data: storedToken } = await supabase
    .from("sync_secrets")
    .select("value")
    .eq("key", "ebay_refresh_token")
    .single();
  if (storedToken?.value) {
    refreshToken = storedToken.value;
  }

  try {
    // Step 1: Get access token (and rotate refresh token)
    const accessToken = await getAccessToken(ebayAppId, ebayCertId, refreshToken, supabase);

    // Step 2: Fetch ALL eBay listings
    const listings = await fetchAllEbayListings(accessToken);

    // Step 3: Upsert into database
    const stats = await upsertListings(supabase, listings);

    // Log success
    await supabase.from("sync_log").insert({
      sync_type: "ebay_import",
      status: "completed",
      details: JSON.stringify(stats),
      source: "edge_function",
    });

    return new Response(
      JSON.stringify({ success: true, ...stats }),
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
    });

    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function getAccessToken(
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
    const body = await resp.text();
    throw new Error(`eBay token exchange failed [${resp.status}]: ${body}`);
  }

  const data = await resp.json();

  // If eBay returns a new refresh token, store it for next time
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
  currentBidPrice?: { value: string };
  listingDetails?: { viewItemURL: string };
  variations?: { variation: EbayVariation[] };
  quantity?: number;
  quantityAvailable?: number;
  sellingStatus?: { quantitySold: number };
}

interface EbayVariation {
  sku: string;
  startPrice: { value: string };
  variationSpecifics: { nameValueList: { name: string; value: string[] }[] };
  quantity: number;
  sellingStatus?: { quantitySold: number };
}

async function fetchAllEbayListings(accessToken: string): Promise<EbayItem[]> {
  const allItems: EbayItem[] = [];
  let page = 1;
  const entriesPerPage = 200;

  while (true) {
    const url = `${EBAY_API_BASE}/ws/api.dll`;
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${accessToken}</eBayAuthToken>
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

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-SITEID": "3", // UK
      },
      body: xmlBody,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`eBay GetMyeBaySelling failed [${resp.status}]: ${body}`);
    }

    const xml = await resp.text();
    const items = parseEbayXml(xml);

    if (!items.length) break;
    allItems.push(...items);

    // Check if there are more pages
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
      quantity,
      quantityAvailable: quantity - quantitySold,
    };

    // Parse variations
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

        const specifics: { name: string; value: string[] }[] = [];
        const specRegex = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let specMatch;
        while ((specMatch = specRegex.exec(varXml)) !== null) {
          const name = extractTag(specMatch[1], "Name") || "";
          const value = extractTag(specMatch[1], "Value") || "";
          specifics.push({ name, value: [value] });
        }

        variations.push({
          sku: varSku,
          startPrice: { value: varPrice },
          variationSpecifics: { nameValueList: specifics },
          quantity: varQty,
          sellingStatus: { quantitySold: varSold },
        });
      }
      if (variations.length) {
        item.variations = { variation: variations };
      }
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
  let productsCreated = 0;
  let variantsCreated = 0;
  let listingsCreated = 0;

  for (const item of items) {
    // Check if product exists by eBay item ID (via channel_listings)
    const { data: existingListings } = await supabase
      .from("channel_listings")
      .select("id, variant_id")
      .eq("channel", "ebay")
      .eq("channel_product_id", `v1|${item.itemId}|0`)
      .limit(1);

    if (existingListings && existingListings.length > 0) {
      // Product already exists, update price
      const listing = existingListings[0];
      await supabase
        .from("channel_listings")
        .update({
          channel_price: parseFloat(item.price.value),
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", listing.id);
      continue;
    }

    // Create new product
    const { data: product, error: prodErr } = await supabase
      .from("products")
      .insert({
        name: item.title,
        sku: item.sku || item.itemId,
        status: "active",
        active: true,
      })
      .select("id")
      .single();

    if (prodErr || !product) {
      console.error(`Failed to create product for ${item.title}:`, prodErr);
      continue;
    }
    productsCreated++;

    if (item.variations?.variation?.length) {
      // Multi-variant listing
      for (const variation of item.variations.variation) {
        const variantName = variation.variationSpecifics.nameValueList
          .map((s) => s.value[0])
          .join(" / ");

        const { data: variant } = await supabase
          .from("variants")
          .insert({
            product_id: product.id,
            internal_sku: variation.sku || `${item.itemId}-${variantName}`,
            option1: variantName,
          })
          .select("id")
          .single();

        if (!variant) continue;
        variantsCreated++;

        const available = variation.quantity - (variation.sellingStatus?.quantitySold || 0);
        await supabase.from("inventory").insert({
          variant_id: variant.id,
          product_id: product.id,
          total_stock: Math.max(0, available),
        });

        await supabase.from("channel_listings").insert({
          variant_id: variant.id,
          channel: "ebay",
          channel_sku: variation.sku || variantName,
          channel_price: parseFloat(variation.startPrice.value),
          channel_product_id: `v1|${item.itemId}|0`,
          channel_variant_id: variantName,
          last_synced_at: new Date().toISOString(),
        });
        listingsCreated++;
      }
    } else {
      // Single variant
      const { data: variant } = await supabase
        .from("variants")
        .insert({
          product_id: product.id,
          internal_sku: item.sku || item.itemId,
        })
        .select("id")
        .single();

      if (!variant) continue;
      variantsCreated++;

      await supabase.from("inventory").insert({
        variant_id: variant.id,
        product_id: product.id,
        total_stock: Math.max(0, item.quantityAvailable || 0),
      });

      await supabase.from("channel_listings").insert({
        variant_id: variant.id,
        channel: "ebay",
        channel_sku: item.sku || item.itemId,
        channel_price: parseFloat(item.price.value),
        channel_product_id: `v1|${item.itemId}|0`,
        last_synced_at: new Date().toISOString(),
      });
      listingsCreated++;
    }
  }

  return {
    total_ebay_items: items.length,
    products_created: productsCreated,
    variants_created: variantsCreated,
    listings_created: listingsCreated,
  };
}
