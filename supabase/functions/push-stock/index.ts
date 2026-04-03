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
  stock: z.number().int().min(0),
});

interface ListingRow {
  id: string;
  channel: string;
  channel_sku: string | null;
  channel_product_id: string | null;
  channel_variant_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { variantId, stock } = parsed.data;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data, error } = await supabase
    .from("channel_listings")
    .select("id, channel, channel_sku, channel_product_id, channel_variant_id")
    .eq("variant_id", variantId);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const listings = (data ?? []) as ListingRow[];
  const syncedIds: string[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();
  let ebayAccessToken: string | null | undefined;

  for (const listing of listings) {
    try {
      if (listing.channel === "ebay") {
        if (ebayAccessToken === undefined) {
          ebayAccessToken = await getEbayAccessToken(supabase);
        }

        if (!ebayAccessToken) {
          throw new Error("Missing eBay authorization.");
        }

        await pushEbayStock(listing, stock, ebayAccessToken);
      }

      if (listing.channel === "squarespace") {
        await pushSquarespaceStock(listing, stock);
      }

      syncedIds.push(listing.id);
    } catch (syncError) {
      errors.push(`${listing.channel}: ${syncError instanceof Error ? syncError.message : "Unknown sync error"}`);
    }
  }

  if (syncedIds.length) {
    await supabase
      .from("channel_listings")
      .update({ last_synced_at: now, updated_at: now })
      .in("id", syncedIds);
  }

  await supabase
    .from("variants")
    .update({ needs_sync: errors.length > 0, updated_at: now })
    .eq("id", variantId);

  await supabase.from("sync_log").insert({
    sync_type: "stock_push",
    status: errors.length ? (syncedIds.length ? "partial" : "failed") : "completed",
    details: JSON.stringify({ variant_id: variantId, stock, synced: syncedIds.length, failed: errors.length }),
    error_message: errors.length ? errors.join(" | ").slice(0, 1000) : null,
    source: "edge_function",
  });

  return new Response(
    JSON.stringify({
      success: errors.length === 0,
      synced: syncedIds.length,
      failed: errors.length,
      errors,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});

async function getEbayAccessToken(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const ebayAppId = Deno.env.get("EBAY_APP_ID");
  const ebayCertId = Deno.env.get("EBAY_CERT_ID");

  if (!ebayAppId || !ebayCertId) {
    return null;
  }

  const { data: storedToken } = await supabase
    .from("sync_secrets")
    .select("value")
    .eq("key", "ebay_refresh_token")
    .single();

  const refreshToken = storedToken?.value
    ?? Deno.env.get("EBAY_OAUTH_REFRESH_TOKEN")
    ?? Deno.env.get("EBAY_REFRESH_TOKEN");

  if (!refreshToken) {
    return null;
  }

  const credentials = btoa(`${ebayAppId}:${ebayCertId}`);
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
    throw new Error(`eBay token exchange failed: ${body}`);
  }

  const tokenData = await resp.json();
  return tokenData.access_token ?? null;
}

async function pushEbayStock(listing: ListingRow, stock: number, accessToken: string) {
  const itemId = extractEbayItemId(listing.channel_product_id);
  if (!itemId) {
    throw new Error("Missing eBay item id.");
  }

  const skuXml = listing.channel_sku
    ? `<SKU>${escapeXml(listing.channel_sku)}</SKU>`
    : "";

  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${escapeXml(itemId)}</ItemID>
    ${skuXml}
    <Quantity>${stock}</Quantity>
  </InventoryStatus>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</ReviseInventoryStatusRequest>`;

  const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1451",
      "X-EBAY-API-CALL-NAME": "ReviseInventoryStatus",
      "X-EBAY-API-SITEID": "3",
    },
    body: xmlBody,
  });

  const responseText = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${responseText.slice(0, 200)}`);
  }

  const ack = extractXmlTag(responseText, "Ack");
  if (ack !== "Success" && ack !== "Warning") {
    const message = extractXmlTag(responseText, "LongMessage")
      ?? extractXmlTag(responseText, "ShortMessage")
      ?? responseText.slice(0, 200);
    throw new Error(message);
  }
}

async function pushSquarespaceStock(listing: ListingRow, stock: number) {
  const sqApiKey = Deno.env.get("SQUARESPACE_API_KEY");
  if (!sqApiKey) {
    throw new Error("Missing Squarespace API key.");
  }

  if (!listing.channel_variant_id) {
    throw new Error("Missing Squarespace variant id.");
  }

  const resp = await fetch(`${SQ_API_BASE}/commerce/inventory/adjustments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sqApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "LovableSync/1.0",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      setFiniteOperations: [
        {
          variantId: listing.channel_variant_id,
          quantity: stock,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const responseText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${responseText.slice(0, 200)}`);
  }
}

function extractEbayItemId(channelProductId: string | null) {
  if (!channelProductId) return null;

  const match = channelProductId.match(/^v1\|(\d+)\|/);
  if (match) return match[1];
  return channelProductId;
}

function extractXmlTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
