import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EBAY_API_BASE = "https://api.ebay.com";
const SQ_API_BASE = "https://api.squarespace.com/1.0";

// XML-escape a string so it can be safely inserted into XML templates
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;")
           .replace(/</g, "&lt;")
           .replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;")
           .replace(/'/g, "&apos;");
}



// Accept optional sq_base_price, sq_sale_price, sq_on_sale for Squarespace
const BodySchema = z.object({
  variantId: z.string().uuid(),
  stock: z.number().int().min(0).optional(),
  price: z.number().min(0).optional(),
  channel: z.string().optional(),
  priceType: z.enum(["base", "sale"]).optional().default("base"),
  sq_on_sale: z.boolean().optional(),
  sq_base_price: z.number().min(0).optional(),
  sq_sale_price: z.number().min(0).optional(),
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

  const { variantId, stock, price, channel, priceType, sq_on_sale, sq_base_price, sq_sale_price } = parsed.data;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: sqKeyRow } = await supabase
    .from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const sqApiKey = sqKeyRow?.value ?? Deno.env.get("SQUARESPACE_API_KEY") ?? Deno.env.get("SQUARESPACE_API");

  const results: { channel: string; status: string; message?: string; variantId?: string }[] = [];
  const tokenBox: { ebay: string | null } = { ebay: null };

  // Bundles hold no stock of their own. If this variant is a bundle, ignore the figure we
  // were given and use the one worked out from its components, so it can never drift.
  let effStock = stock;
  if (stock !== undefined) {
    const calc = await bundleStock(supabase, variantId);
    if (calc !== null) {
      effStock = calc;
      await setInventory(supabase, variantId, calc, "bundle_calc");
    }
  }

  const listErr = await pushToListings(supabase, variantId, effStock, price, channel, priceType, sq_on_sale, sq_base_price, sq_sale_price, sqApiKey, tokenBox, results);
  if (listErr) {
    return new Response(JSON.stringify({ error: `DB error: ${listErr}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // If this item is part of any bundles, work out each bundle's new stock and push it too.
  // Only stock changes ripple to bundles; price changes never do.
  let bundlesUpdated = 0;
  if (stock !== undefined) {
    const { data: parents } = await supabase
      .from("bundle_components").select("bundle_variant_id").eq("component_variant_id", variantId);
    const ids: string[] = [...new Set<string>((parents ?? []).map((r: any) => String(r.bundle_variant_id)))];
    for (const bid of ids) {
      try {
        const calc = await bundleStock(supabase, bid);
        if (calc === null) continue;
        const changed = await setInventory(supabase, bid, calc, "bundle_component_change", variantId);
        if (!changed) continue;
        bundlesUpdated++;
        await pushToListings(supabase, bid, calc, undefined, undefined, "base", undefined, undefined, undefined, sqApiKey, tokenBox, results);
      } catch (err: any) {
        results.push({ channel: "bundle", status: "error", message: err.message, variantId: bid });
      }
    }
  }

  const anyFailed = results.some((r) => r.status === "error");
  return new Response(
    JSON.stringify({ ok: !anyFailed, results, bundlesUpdated, ...(effStock !== stock ? { bundleStock: effStock } : {}) }),
    {
      status: anyFailed ? 207 : 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});

// Push stock and/or price for one variant to every shop it is listed on (or just one channel).
// Returns an error message if the listings couldn't be read, otherwise null.
async function pushToListings(
  supabase: any, variantId: string, stock: number | undefined, price: number | undefined,
  channel: string | undefined, priceType: "base" | "sale",
  sq_on_sale: boolean | undefined, sq_base_price: number | undefined, sq_sale_price: number | undefined,
  sqApiKey: string | undefined, tokenBox: { ebay: string | null },
  results: { channel: string; status: string; message?: string; variantId?: string }[],
): Promise<string | null> {
  const { data: listings, error: listErr } = await supabase
    .from("channel_listings")
    .select("*")
    .eq("variant_id", variantId);
  if (listErr) return listErr.message;
  const targetListings = channel ? (listings ?? []).filter((l: any) => l.channel === channel) : (listings ?? []);

  for (const listing of targetListings) {
    try {
      if (listing.channel === "ebay") {
        if (!tokenBox.ebay) tokenBox.ebay = await getEbayAccessToken(supabase);
        // eBay has no base/sale distinction — StartPrice is always the actual price
        const ebayResult = await pushEbayUpdate(listing, stock, price, tokenBox.ebay!);
        results.push({ channel: "ebay", status: "success", message: ebayResult, variantId });
      } else if (listing.channel === "squarespace") {
        if (!sqApiKey) throw new Error("Squarespace API key not found in sync_secrets or env");
        await pushSquarespaceUpdate(
          { ...listing, sq_on_sale, sq_base_price, sq_sale_price, }, // supply new fields
          stock,
          price,
          sqApiKey,
          priceType
        );
        results.push({ channel: "squarespace", status: "success", variantId });
      }
    } catch (err: any) {
      results.push({ channel: listing.channel, status: "error", message: err.message, variantId });
    }
  }
  return null;
}

// ── Bundles ──────────────────────────────────────────────────────────────────
// A bundle's stock = the lowest of floor(component stock / quantity needed).
// Returns null if the variant is not a bundle (has no components).
async function bundleStock(supabase: any, bundleVariantId: string): Promise<number | null> {
  const { data: comps } = await supabase
    .from("bundle_components").select("component_variant_id, quantity").eq("bundle_variant_id", bundleVariantId);
  if (!comps?.length) return null;
  const { data: inv } = await supabase
    .from("inventory").select("variant_id, total_stock").in("variant_id", comps.map((c: any) => c.component_variant_id));
  const have = new Map<string, number>((inv ?? []).map((i: any) => [i.variant_id, Math.max(0, i.total_stock ?? 0)]));
  let min = Infinity;
  for (const c of comps) min = Math.min(min, Math.floor((have.get(c.component_variant_id) ?? 0) / Math.max(1, c.quantity)));
  return Number.isFinite(min) ? min : 0;
}

// Save a worked-out bundle stock figure. Returns true if it changed.
async function setInventory(supabase: any, variantId: string, stock: number, reason: string, causedBy?: string): Promise<boolean> {
  const { data: inv } = await supabase.from("inventory").select("id, total_stock, product_id").eq("variant_id", variantId).maybeSingle();
  const now = new Date().toISOString();
  if (!inv) {
    const { data: v } = await supabase.from("variants").select("product_id").eq("id", variantId).maybeSingle();
    await supabase.from("inventory").insert({ variant_id: variantId, product_id: v?.product_id ?? null, total_stock: stock });
    return true;
  }
  if ((inv.total_stock ?? 0) === stock) return false;
  await supabase.from("inventory").update({ total_stock: stock, updated_at: now }).eq("id", inv.id);
  await supabase.from("stock_log").insert({
    variant_id: variantId, product_id: inv.product_id, old_stock: inv.total_stock ?? 0, new_stock: stock,
    delta: stock - (inv.total_stock ?? 0), source: "bundle", reason,
    note: causedBy ? `Worked out from component ${causedBy}` : "Worked out from its components",
  });
  return true;
}

// ── eBay ─────────────────────────────────────────────────────────────────────
// Fetch variation specifics from eBay GetItem so we can use VariationSpecifics
// when the item has no custom labels (SKUs) set on its variations
async function getVariationSpecificsFromEbay(
  itemId: string,
  valueToFind: string,
  token: string
): Promise<{ name: string; value: string }[] | null> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;

  const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "GetItem",
      "X-EBAY-API-SITEID": "3",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1451",
      "X-EBAY-API-APP-NAME": Deno.env.get("EBAY_APP_ID") ?? "",
      "Content-Type": "text/xml",
    },
    body: xml,
  });

  const text = await resp.text();
  const varMatches = [...text.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];

  for (const [, varXml] of varMatches) {
    const nvlists = [...varXml.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)];
    const pairs: { name: string; value: string }[] = [];
    let matchFound = false;

    for (const [, nvl] of nvlists) {
      const nameMatch = nvl.match(/<Name>(.*?)<\/Name>/);
      const valueMatch = nvl.match(/<Value>(.*?)<\/Value>/);
      if (nameMatch && valueMatch) {
        pairs.push({ name: nameMatch[1], value: valueMatch[1] });
        if (valueMatch[1].trim() === valueToFind.trim()) matchFound = true;
      }
    }

    if (matchFound && pairs.length > 0) return pairs;
  }

  return null;
}

async function pushEbayUpdate(
  listing: any,
  stock: number | undefined,
  price: number | undefined,
  token: string
): Promise<string> {
  const itemId = listing.channel_product_id?.replace(/^v1\|/, "").replace(/\|.*$/, "") ||
    listing.channel_product_id;
  if (!itemId) throw new Error("Missing eBay item ID");

  if (!stock && stock !== 0 && !price) return "nothing to update";

  const sku = listing.channel_sku as string | undefined;
  const cvid = listing.channel_variant_id as string | undefined;

  // If a SKU is stored, always try it first — works for both ManageBySKU and variation SKUs
  if (sku) {
    try {
      return await reviseInventoryStatus(itemId, sku, stock, price, token);
    } catch (err: any) {
      // eBay item has no custom labels — fall back to VariationSpecifics via GetItem
      if (
        err.message?.includes("SKU does not exist") ||
        err.message?.includes("Non-ManageBySKU")
      ) {
        const specifics = await getVariationSpecificsFromEbay(itemId, sku, token);
        if (specifics && specifics.length > 0) {
          return await reviseItemVariation(itemId, specifics, stock, price, token);
        }
        // Single-item listing (no variations) — retry without SKU
        return await reviseInventoryStatus(itemId, null, stock, price, token);
      }
      throw err;
    }
  }

  // No SKU — check if cvid contains Name:Value pairs (e.g. "Colour:Red_Size:M")
  if (cvid) {
    // Strip v1|ItemID| prefix if present
    const stripped = cvid.replace(/^v1\|[^|]+\|/, "").replace(/^\d+_/, "");
    const nameValuePairs = stripped.split("_").map((pair: string) => {
      const colonIdx = pair.indexOf(":");
      if (colonIdx === -1) return null;
      return { name: pair.substring(0, colonIdx), value: pair.substring(colonIdx + 1) };
    }).filter(Boolean) as { name: string; value: string }[];

    if (nameValuePairs.length > 0) {
      return await reviseItemVariation(itemId, nameValuePairs, stock, price, token);
    }

    // Last resort: use cvid raw value to find variation specifics via GetItem
    const specifics = await getVariationSpecificsFromEbay(itemId, cvid, token);
    if (specifics && specifics.length > 0) {
      return await reviseItemVariation(itemId, specifics, stock, price, token);
    }
  }

  // No variation info at all — single-item listing
  return await reviseInventoryStatus(itemId, null, stock, price, token);
}

async function reviseInventoryStatus(
  itemId: string,
  sku: string | null,
  stock: number | undefined,
  price: number | undefined,
  token: string
): Promise<string> {
  const priceXml = price !== undefined ? `<StartPrice>${price.toFixed(2)}</StartPrice>` : "";
  const stockXml = stock !== undefined ? `<Quantity>${stock}</Quantity>` : "";
  if (!priceXml && !stockXml) return "nothing to update";

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    ${sku ? `<SKU>${xmlEscape(sku)}</SKU>` : ""}
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
    throw new Error(errMatch ? errMatch[1] : "eBay ReviseInventoryStatus returned Failure");
  }
  return "ok";
}

async function reviseItemVariation(
  itemId: string,
  nameValuePairs: { name: string; value: string }[],
  stock: number | undefined,
  price: number | undefined,
  token: string
): Promise<string> {
  const specificsXml = nameValuePairs.map(({ name, value }: { name: string; value: string }) => `
      <NameValueList>
        <Name>${xmlEscape(name)}</Name>
        <Value>${xmlEscape(value)}</Value>
      </NameValueList>`).join("");

  const priceXml = price !== undefined ? `<StartPrice>${price.toFixed(2)}</StartPrice>` : "";
  const stockXml = stock !== undefined ? `<Quantity>${stock}</Quantity>` : "";
  if (!priceXml && !stockXml) return "nothing to update";

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${token}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    <Variations>
      <Variation>
        <VariationSpecifics>${specificsXml}
        </VariationSpecifics>
        ${stockXml}
        ${priceXml}
      </Variation>
    </Variations>
  </Item>
</ReviseItemRequest>`;

  const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "ReviseItem",
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
    throw new Error(errMatch ? errMatch[1] : "eBay ReviseItem returned Failure");
  }
  return "ok (via VariationSpecifics)";
}

// ── Squarespace update, supports sq_base_price, sq_sale_price, sq_on_sale ────
async function pushSquarespaceUpdate(
  listing: any,
  stock: number | undefined,
  _price: number | undefined,
  apiKey: string,
  _priceType: "base" | "sale" = "base"
): Promise<void> {
  const variantId = listing.channel_variant_id;
  if (!variantId) throw new Error("Missing Squarespace variant ID");

  // Stock update (unchanged)
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

  // Price update (now with base vs. sale logic)
  const productId = listing.channel_product_id;
  if (!productId) throw new Error("Missing Squarespace product ID for price update");
  // If neither base nor sale price is supplied, do nothing
  if (listing.sq_base_price === undefined && listing.sq_sale_price === undefined) return;

  const saleActive = listing.sq_on_sale ?? false;
  const livePrice = saleActive
    ? (listing.sq_sale_price ?? listing.channel_price)
    : (listing.sq_base_price ?? listing.channel_price);

  let pricingBody: object;
  if (saleActive && livePrice !== undefined) {
    pricingBody = {
      pricing: {
        salePrice: {
          value: Number(livePrice).toFixed(2),
          currency: "GBP",
        },
        onSale: true,
      },
    };
  } else if (livePrice !== undefined) {
    pricingBody = {
      pricing: {
        basePrice: {
          value: Number(livePrice).toFixed(2),
          currency: "GBP",
        },
        onSale: false,
      },
    };
  } else {
    return; // no price or update to send
  }

  const resp = await fetch(
    `${SQ_API_BASE}/commerce/products/${productId}/variants/${variantId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "SyncStock/1.0",
      },
      body: JSON.stringify(pricingBody),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Squarespace price update failed [${resp.status}]: ${body.slice(0, 300)}`);
  }
}

// ── eBay OAuth ────────────────────────────────────────────────────────────────
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

