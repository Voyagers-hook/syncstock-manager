import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EBAY_API_BASE = "https://api.ebay.com";
const SQ_API_BASE = "https://api.squarespace.com/1.0";

const BodySchema = z.object({
  variantId: z.string().uuid(),
  stock: z.number().int().min(0).optional(),
  price: z.number().min(0).optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid Data" }), { status: 400, headers: corsHeaders });
  }

  const { variantId, stock, price } = parsed.data;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Get all listings (eBay and SQSP) that belong to this one Variant
  const { data: listings } = await supabase
    .from("channel_listings")
    .select("*")
    .eq("variant_id", variantId);

  if (!listings || listings.length === 0) {
    return new Response(JSON.stringify({ error: "No store links found for this item." }), { status: 404, headers: corsHeaders });
  }

  const results = [];
  let ebayToken: string | null = null;

  for (const listing of listings) {
    try {
      if (listing.channel === "ebay") {
        if (!ebayToken) ebayToken = await getEbayAccessToken(supabase);
        await pushEbayUpdate(listing, stock, price, ebayToken!);
      }
      if (listing.channel === "squarespace") {
        await pushSquarespaceUpdate(listing, stock, price);
      }
      results.push({ channel: listing.channel, status: "success" });
    } catch (err) {
      results.push({ channel: listing.channel, status: "error", message: err.message });
    }
  }

  return new Response(JSON.stringify({ results }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});

async function pushEbayUpdate(listing: any, stock?: number, price?: number, token?: string) {
  const itemId = listing.channel_product_id?.match(/(\d+)/)?.[1] || listing.channel_product_id;
  const priceXml = price ? `<StartPrice>${price}</StartPrice>` : "";
  const stockXml = stock !== undefined ? `<Quantity>${stock}</Quantity>` : "";

  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
    <InventoryStatus>
      <ItemID>${itemId}</ItemID>
      ${listing.channel_sku ? `<SKU>${listing.channel_sku}</SKU>` : ""}
      ${stockXml}
      ${priceXml}
    </InventoryStatus>
  </ReviseInventoryStatusRequest>`;

  await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "ReviseInventoryStatus",
      "X-EBAY-API-SITEID": "3", // UK
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1451",
      "Content-Type": "text/xml",
    },
    body: xml,
  });
}

async function pushSquarespaceUpdate(listing: any, stock?: number, price?: number) {
  const apiKey = Deno.env.get("SQUARESPACE_API");
  if (stock !== undefined) {
    await fetch(`${SQ_API_BASE}/commerce/inventory/adjustments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ setFiniteOperations: [{ variantId: listing.channel_variant_id, quantity: stock }] })
    });
  }
  if (price !== undefined) {
    await fetch(`${SQ_API_BASE}/commerce/products/${listing.channel_product_id}/variants/${listing.channel_variant_id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ price: { value: price.toString(), currencyCode: "GBP" } })
    });
  }
}

async function getEbayAccessToken(supabase: any) {
  const { data } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
  const credentials = btoa(`${Deno.env.get("EBAY_APP_ID")}:${Deno.env.get("EBAY_CERT_ID")}`);
  const resp = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: data.value, scope: "https://api.ebay.com/oauth/api_scope/sell.inventory" }),
  });
  const json = await resp.json();
  return json.access_token;
}
