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
  channel: z.string().optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid body", details: parsed.error.issues }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { variantId, stock, price, channel } = parsed.data;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Read Squarespace API key from DB (env var fallback)
  const { data: sqKeyRow } = await supabase
    .from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const sqApiKey = sqKeyRow?.value ?? Deno.env.get("SQUARESPACE_API_KEY") ?? Deno.env.get("SQUARESPACE_API");

  // Get all channel_listings for this variant
  const { data: listings, error: listErr } = await supabase
    .from("channel_listings")
    .select("*")
    .eq("variant_id", variantId);

  if (listErr) {
    return new Response(JSON.stringify({ error: `DB error: ${listErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!listings || listings.length === 0) {
    return new Response(JSON.stringify({ ok: true, results: [], note: "No channel listings for this variant" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Only update the listings for the requested channel
  const targetListings = channel ? listings.filter((l: any) => l.channel === channel) : listings;

  const results: { channel: string; status: string; message?: string }[] = [];
  let ebayToken: string | null = null;

  for (const listing of targetListings) {
    try {
      if (listing.channel === "ebay") {
        if (!ebayToken) {
          ebayToken = await getEbayAccessToken(supabase);
        }
        const ebayResult = await pushEbayUpdate(listing, stock, price, ebayToken!);
        results.push({ channel: "ebay", status: "success", message: ebayResult });
      } else if (listing.channel === "squarespace") {
        if (!sqApiKey) throw new Error("Squarespace API key not found in sync_secrets or env");
        await pushSquarespaceUpdate(listing, stock, price, sqApiKey);
        results.push({ channel: "squarespace", status: "success" });
      }
    } catch (err: any) {
      results.push({ channel: listing.channel, status: "error", message: err.message });
    }
  }

  const anyFailed = results.some((r) => r.status === "error");
  return new Response(
    JSON.stringify({ ok: !anyFailed, results }),
    {
      status: anyFailed ? 207 : 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});

// ── eBay: ReviseInventoryStatus (Trading API, OAuth token) ────────────────────
async function pushEbayUpdate(
  listing: any,
  stock: number | undefined,
  price: number | undefined,
  token: string
): Promise<string> {
  const itemId = listing.channel_product_id?.replace(/^v1\|/, "").replace(/\|.*$/, "") ||
    listing.channel_product_id;
  if (!itemId) throw new Error("Missing eBay item ID");

  const priceXml = price !== undefined ? `<StartPrice>${price.toFixed(2)}</StartPrice>` : "";
  const stockXml = stock !== undefined ? `<Quantity>${stock}</Quantity>` : "";
  if (!priceXml && !stockXml) return "nothing to update";

  const isVariation = listing.channel_variant_id &&
    listing.channel_variant_id !== "" &&
    !/^\d+$/.test(listing.channel_variant_id);

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    ${isVariation && listing.channel_sku ? `<SKU>${listing.channel_sku}</SKU>` : ""}
    ${stockXml}
    ${priceXml}
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

  const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "ReviseInventoryStatus",
      "X-EBAY-API-SITEID": "3",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1451",
      "X-EBAY-API-APP-NAME": Deno.env.get("EBAY_APP_ID") ?? "",
      "Content-Type": "text/xml",
    },
    body: xml,
  });

  const respText = await resp.text();
  if (respText.includes("<Ack>Failure</Ack>") || respText.includes("<Ack>PartialFailure</Ack>")) {
    const errMatch = respText.match(/<LongMessage>(.*?)<\/LongMessage>/);
    throw new Error(errMatch ? errMatch[1] : "eBay API returned Failure");
  }

  return "ok";
}

// ── Squarespace: stock via inventory adjustments, price via variant endpoint ──
async function pushSquarespaceUpdate(
  listing: any,
  stock: number | undefined,
  price: number | undefined,
  apiKey: string
): Promise<void> {
  const variantId = listing.channel_variant_id;
  if (!variantId) throw new Error("Missing Squarespace variant ID");

  // Stock update — inventory adjustments endpoint (unchanged)
  if (stock !== undefined) {
    const resp = await fetch(`${SQ_API_BASE}/commerce/inventory/adjustments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "SyncStock/1.0",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        setFiniteOperations: [{ variantId, quantity: stock }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Squarespace inventory update failed [${resp.status}]: ${body.slice(0, 200)}`);
    }
  }

  // Price update — always use the variant endpoint directly, never product-level
  if (price !== undefined) {
    const productId = listing.channel_product_id;
    if (!productId) throw new Error("Missing Squarespace product ID for price update");
    if (!variantId) throw new Error("Missing Squarespace variant ID for price update");

    const resp = await fetch(
      `${SQ_API_BASE}/commerce/products/${productId}/variants/${variantId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "SyncStock/1.0",
        },
        body: JSON.stringify({
          pricing: {
            basePrice: {
              value: price.toFixed(2),
              currency: "GBP",
            },
          },
        }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Squarespace price update failed [${resp.status}]: ${body.slice(0, 300)}`);
    }
  }
}

// ── eBay OAuth: exchange refresh_token for access_token ──────────────────────
async function getEbayAccessToken(supabase: any): Promise<string> {
  const { data, error } = await supabase
    .from("sync_secrets")
    .select("value")
    .eq("key", "ebay_refresh_token")
    .single();
  if (error || !data?.value) throw new Error("eBay refresh token not found in sync_secrets");

  const appId = Deno.env.get("EBAY_APP_ID");
  const certId = Deno.env.get("EBAY_CERT_ID");
  if (!appId || !certId) throw new Error("EBAY_APP_ID or EBAY_CERT_ID env var not set");

  const credentials = btoa(`${appId}:${certId}`);
  const resp = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.value,
      scope: "https://api.ebay.com/oauth/api_scope/sell.inventory",
    }),
  });

  const json = await resp.json();
  if (!json.access_token) {
    throw new Error(`eBay token refresh failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}
