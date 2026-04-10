import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EBAY_API_BASE = "https://api.ebay.com";
const SQ_API_BASE   = "https://api.squarespace.com/1.0";

// XML-escape a string so it can be safely inserted into XML templates
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;")
           .replace(/</g, "&lt;")
           .replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;")
           .replace(/'/g, "&apos;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const ebayAppId  = Deno.env.get("EBAY_APP_ID");
  const ebayCertId = Deno.env.get("EBAY_CERT_ID");

  // Read Squarespace API key from DB (env var fallback)
  const { data: sqKeyRow } = await supabase
    .from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const sqApiKey = sqKeyRow?.value ?? Deno.env.get("SQUARESPACE_API_KEY");

  // ── time window ─────────────────────────────────────────────────────
  const { data: lastSyncRow } = await supabase
    .from("sync_secrets")
    .select("value")
    .eq("key", "last_order_sync")
    .maybeSingle();

  const since = lastSyncRow?.value
    ? new Date(lastSyncRow.value)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);   // first run: last 24 h

  const now = new Date();

  let ebayProcessed = 0;
  let sqProcessed   = 0;
  const errors: string[] = [];

  try {
    // ── eBay orders ───────────────────────────────────────────────────
    if (ebayAppId && ebayCertId) {
      try {
        const { data: tokenRow } = await supabase
          .from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
        if (tokenRow?.value) {
          const ebayToken = await getEbayAccessToken(ebayAppId, ebayCertId, tokenRow.value, supabase);
          const ebayOrders = await fetchEbayOrders(ebayToken, since, now);
          for (const txn of ebayOrders) {
            try {
              if (await processEbayTransaction(supabase, txn, sqApiKey, ebayToken)) ebayProcessed++;
            } catch (err: any) {
              errors.push(`eBay ${txn.orderId}/${txn.itemId}: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        errors.push(`eBay order sync error: ${err.message}`);
      }
    }

    // ── Squarespace orders ────────────────────────────────────────────
    if (sqApiKey) {
      try {
        const sqOrders = await fetchSquarespaceOrders(sqApiKey, since);
        for (const order of sqOrders) {
          for (const li of order.lineItems) {
            try {
              if (await processSquarespaceLineItem(supabase, order, li, ebayAppId, ebayCertId, sqApiKey))
                sqProcessed++;
            } catch (err: any) {
              errors.push(`SQ order ${order.id}/${li.variantId}: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        errors.push(`Squarespace order sync error: ${err.message}`);
      }
    } else {
      errors.push("Squarespace API key not found in sync_secrets or env");
    }

    // ── bookkeeping ───────────────────────────────────────────────────
    await supabase.from("sync_secrets").upsert(
      { key: "last_order_sync", value: now.toISOString(), updated_at: now.toISOString() },
      { onConflict: "key" },
    );

    await supabase.from("sync_log").insert({
      sync_type: "order_sync",
      status: errors.length ? "partial" : "completed",
      details: JSON.stringify({ ebay_processed: ebayProcessed, sq_processed: sqProcessed, errors }),
      source: "edge_function",
    });

    return json({ success: true, ebay_processed: ebayProcessed, sq_processed: sqProcessed, errors });
  } catch (error: any) {
    const msg = error?.message ?? "Unknown error";
    await supabase.from("sync_log").insert({
      sync_type: "order_sync", status: "failed", error_message: msg, source: "edge_function",
    });
    return json({ error: msg }, 500);
  }
});

/* ═══════════════════════════ helpers ═══════════════════════════ */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

/* ═══════════════════════════ eBay auth ════════════════════════= */

async function getEbayAccessToken(appId: string, certId: string, refreshToken: string, supabase: any) {
  const creds = btoa(`${appId}:${certId}`);
  const resp = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: [
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      ].join(" "),
    }),
  });
  if (!resp.ok) throw new Error(`eBay token exchange failed [${resp.status}]`);
  const data = await resp.json();
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await supabase.from("sync_secrets").upsert(
      { key: "ebay_refresh_token", value: data.refresh_token, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  }
  return data.access_token as string;
}

/* ═══════════════════════════ eBay orders ═══════════════════════ */

interface EbayTxn {
  orderId: string;
  createdTime: string;
  itemId: string;
  itemTitle: string;
  variationSku: string | null;
  variationName: string | null;
  quantity: number;
  price: number;
}

async function fetchEbayOrders(token: string, since: Date, until: Date): Promise<EbayTxn[]> {
  const txns: EbayTxn[] = [];
  let page = 1;
  while (true) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <CreateTimeFrom>${since.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${until.toISOString()}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetOrdersRequest>`;
    const resp = await fetch(`${EBAY_API_BASE}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetOrders",
        "X-EBAY-API-SITEID": "3",
      },
      body,
    });
    if (!resp.ok) throw new Error(`GetOrders [${resp.status}]`);
    const xml = await resp.text();
    txns.push(...parseEbayOrders(xml));
    const tp = xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
    if (page >= (tp ? parseInt(tp[1]) : 1)) break;
    page++;
  }
  return txns;
}

function parseEbayOrders(xml: string): EbayTxn[] {
  const txns: EbayTxn[] = [];
  const orderRe = /<Order>([\s\S]*?)<\/Order>/g;
  let om;
  while ((om = orderRe.exec(xml)) !== null) {
    const oXml = om[1];
    const orderId     = extractTag(oXml, "OrderID") ?? "";
    const createdTime = extractTag(oXml, "CreatedTime") ?? new Date().toISOString();
    const txRe = /<Transaction>([\s\S]*?)<\/Transaction>/g;
    let tm;
    while ((tm = txRe.exec(oXml)) !== null) {
      const tXml = tm[1];
      const itemId    = extractTag(tXml, "ItemID") ?? "";
      const itemTitle = extractTag(tXml, "Title") ?? "";
      const quantity  = parseInt(extractTag(tXml, "QuantityPurchased") ?? "1");
      const price     = parseFloat(extractTag(tXml, "TransactionPrice") ?? "0");
      let variationSku: string | null = null;
      let variationName: string | null = null;
      const vm = tXml.match(/<Variation>([\s\S]*?)<\/Variation>/);
      if (vm) {
        variationSku = extractTag(vm[1], "SKU");
        const names: string[] = [];
        const spRe = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let sp;
        while ((sp = spRe.exec(vm[1])) !== null) {
          const v = extractTag(sp[1], "Value");
          if (v) names.push(v);
        }
        variationName = names.join(" / ") || null;
      }
      if (itemId) txns.push({ orderId, createdTime, itemId, itemTitle, variationSku, variationName, quantity, price });
    }
  }
  return txns;
}

/* ═══════════════════════════ Squarespace orders ════════════════ */

interface SqOrder {
  id: string;
  orderNumber: string;
  createdOn: string;
  lineItems: SqLineItem[];
}

interface SqLineItem {
  variantId: string;
  sku: string;
  quantity: number;
  unitPricePaid: { value: string; currency: string };
  productName: string;
}

// FIXED: Squarespace requires BOTH modifiedAfter AND modifiedBefore together.
// Cursor cannot be combined with date params — pagination uses cursor alone.
async function fetchSquarespaceOrders(apiKey: string, since: Date): Promise<SqOrder[]> {
  const all: SqOrder[] = [];
  const until = new Date();
  let cursor: string | undefined;

  while (true) {
    const params = cursor
      ? `cursor=${cursor}`
      : `modifiedAfter=${encodeURIComponent(since.toISOString())}&modifiedBefore=${encodeURIComponent(until.toISOString())}`;

    const resp = await fetch(`${SQ_API_BASE}/commerce/orders?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "SyncStock/1.0" },
    });
    if (!resp.ok) throw new Error(`SQ orders [${resp.status}]`);
    const data = await resp.json();
    all.push(...(data.result ?? []));
    if (data.pagination?.hasNextPage && data.pagination?.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else break;
  }
  return all;
}

/* ═══════════════════════════ stock adjustment ══════════════════ */

async function processEbayTransaction(
  supabase: any, txn: EbayTxn, sqApiKey?: string, ebayToken?: string
): Promise<boolean> {
  // deduplicate
  const { data: dup } = await supabase.from("orders").select("id")
    .eq("platform", "ebay").eq("platform_order_id", txn.orderId)
    .eq("sku", txn.variationSku ?? txn.itemId).maybeSingle();
  if (dup) return false;

  // find listing — try v1|itemId|0 format first, then plain itemId
  const cpid = `v1|${txn.itemId}|0`;
  let { data: listings } = await supabase.from("channel_listings")
    .select("*").eq("channel", "ebay").eq("channel_product_id", cpid);
  
  // fallback: some listings may store just the itemId
  if (!listings?.length) {
    const { data: listings2 } = await supabase.from("channel_listings")
      .select("*").eq("channel", "ebay").like("channel_product_id", `%${txn.itemId}%`);
    listings = listings2;
  }
  if (!listings?.length) return false;

  let listing = listings[0];
  if (txn.variationSku) {
    const m = listings.find((l: any) => l.channel_sku === txn.variationSku);
    if (m) listing = m;
  } else if (txn.variationName) {
    const m = listings.find((l: any) => l.channel_variant_id === txn.variationName);
    if (m) listing = m;
  }

  const { data: inv } = await supabase.from("inventory")
    .select("id, total_stock, product_id").eq("variant_id", listing.variant_id).maybeSingle();
  if (!inv) return false;

  const newStock = Math.max(0, (inv.total_stock ?? 0) - txn.quantity);
  await supabase.from("inventory").update({ total_stock: newStock }).eq("id", inv.id);

  // push to Squarespace
  if (sqApiKey) await pushStockToSquarespace(supabase, listing.variant_id, newStock, sqApiKey);

  // record
  await supabase.from("orders").insert({
    platform: "ebay", platform_order_id: txn.orderId,
    product_id: inv.product_id, sku: txn.variationSku ?? txn.itemId,
    quantity: txn.quantity, unit_price: txn.price,
    total_price: txn.price * txn.quantity, currency: "GBP",
    status: "completed", ordered_at: txn.createdTime,
    synced_at: new Date().toISOString(), item_name: txn.itemTitle,
    order_number: txn.orderId,
  });
  return true;
}

async function processSquarespaceLineItem(
  supabase: any, order: SqOrder, li: SqLineItem,
  ebayAppId?: string, ebayCertId?: string, sqApiKey?: string,
): Promise<boolean> {
  const { data: dup } = await supabase.from("orders").select("id")
    .eq("platform", "squarespace").eq("platform_order_id", order.id)
    .eq("sku", li.sku || li.variantId).maybeSingle();
  if (dup) return false;

  const { data: listings } = await supabase.from("channel_listings")
    .select("*").eq("channel", "squarespace").eq("channel_variant_id", li.variantId);
  if (!listings?.length) return false;

  const listing = listings[0];
  const { data: inv } = await supabase.from("inventory")
    .select("id, total_stock, product_id").eq("variant_id", listing.variant_id).maybeSingle();
  if (!inv) return false;

  const newStock = Math.max(0, (inv.total_stock ?? 0) - li.quantity);
  await supabase.from("inventory").update({ total_stock: newStock }).eq("id", inv.id);

  // push to eBay (full fallback logic — same as push-stock function)
  if (ebayAppId && ebayCertId) {
    try {
      const { data: tokenRow } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
      if (tokenRow?.value) {
        const token = await getEbayAccessToken(ebayAppId, ebayCertId, tokenRow.value, supabase);
        await pushStockToEbay(supabase, listing.variant_id, newStock, token);
      }
    } catch (err: any) {
      // Log but don't block the order record — eBay push failure is non-fatal for SQ orders
      console.error(`eBay stock push failed for variant ${listing.variant_id}: ${err.message}`);
    }
  }

  // push back to Squarespace too (keeps SQ in sync with DB)
  if (sqApiKey) {
    try {
      await pushStockToSquarespace(supabase, listing.variant_id, newStock, sqApiKey);
    } catch (_) { /* non-fatal */ }
  }

  await supabase.from("orders").insert({
    platform: "squarespace", platform_order_id: order.id,
    product_id: inv.product_id, sku: li.sku || li.variantId,
    quantity: li.quantity,
    unit_price: parseFloat(li.unitPricePaid?.value ?? "0"),
    total_price: parseFloat(li.unitPricePaid?.value ?? "0") * li.quantity,
    currency: li.unitPricePaid?.currency ?? "GBP",
    status: "pending", ordered_at: order.createdOn,
    synced_at: new Date().toISOString(), item_name: li.productName,
    order_number: order.orderNumber,
  });
  return true;
}

/* ═══════════════════════════ push helpers ══════════════════════ */

async function pushStockToSquarespace(supabase: any, variantId: string, stock: number, apiKey: string) {
  const { data: listings } = await supabase.from("channel_listings")
    .select("channel_variant_id").eq("variant_id", variantId).eq("channel", "squarespace");
  for (const l of listings ?? []) {
    if (!l.channel_variant_id) continue;
    const resp = await fetch(`${SQ_API_BASE}/commerce/inventory/adjustments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "SyncStock/1.0",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ setFiniteOperations: [{ variantId: l.channel_variant_id, quantity: stock }] }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`SQ push failed [${resp.status}]: ${body.slice(0, 200)}`);
    }
  }
}

// ── Full eBay push with VariationSpecifics fallback ───────────────────────────
// Mirrors push-stock/index.ts exactly so both paths use identical logic.

async function pushStockToEbay(supabase: any, variantId: string, stock: number, token: string) {
  const { data: listings } = await supabase.from("channel_listings")
    .select("channel_product_id, channel_sku, channel_variant_id")
    .eq("variant_id", variantId).eq("channel", "ebay");

  for (const l of listings ?? []) {
    try {
      await pushEbayUpdate(l, stock, undefined, token);
    } catch (err: any) {
      // Surface the error so it appears in order_sync logs rather than silently failing
      throw new Error(`eBay push failed for item ${l.channel_product_id}: ${err.message}`);
    }
  }
}

async function pushEbayUpdate(
  listing: any,
  stock: number | undefined,
  price: number | undefined,
  token: string,
): Promise<string> {
  const itemId = listing.channel_product_id?.replace(/^v1\|/, "").replace(/\|.*$/, "") ||
    listing.channel_product_id;
  if (!itemId) throw new Error("Missing eBay item ID");

  if (stock === undefined && price === undefined) return "nothing to update";

  const sku  = listing.channel_sku as string | undefined;
  const cvid = listing.channel_variant_id as string | undefined;

  // 1. Try SKU-based ReviseInventoryStatus first
  if (sku) {
    try {
      return await reviseInventoryStatus(itemId, sku, stock, price, token);
    } catch (err: any) {
      // eBay item has no custom labels — fall back to VariationSpecifics
      if (
        err.message?.includes("SKU does not exist") ||
        err.message?.includes("Non-ManageBySKU")
      ) {
        const specifics = await getVariationSpecificsFromEbay(itemId, sku, token);
        if (specifics && specifics.length > 0) {
          return await reviseItemVariation(itemId, specifics, stock, price, token);
        }
        throw new Error(
          `eBay item ${itemId} has no custom labels and value "${sku}" not found via GetItem`,
        );
      }
      throw err;
    }
  }

  // 2. No SKU — try parsing channel_variant_id as "Name:Value_Name:Value" pairs
  if (cvid) {
    const stripped = cvid.replace(/^v1\|[^|]+\|/, "").replace(/^\d+_/, "");
    const nameValuePairs = stripped.split("_").map((pair: string) => {
      const colonIdx = pair.indexOf(":");
      if (colonIdx === -1) return null;
      return { name: pair.substring(0, colonIdx), value: pair.substring(colonIdx + 1) };
    }).filter(Boolean) as { name: string; value: string }[];

    if (nameValuePairs.length > 0) {
      return await reviseItemVariation(itemId, nameValuePairs, stock, price, token);
    }

    // 3. Last resort: GetItem to find variation specifics by matching cvid value
    const specifics = await getVariationSpecificsFromEbay(itemId, cvid, token);
    if (specifics && specifics.length > 0) {
      return await reviseItemVariation(itemId, specifics, stock, price, token);
    }
  }

  // 4. Single-item listing (no variation info)
  return await reviseInventoryStatus(itemId, null, stock, price, token);
}

async function getVariationSpecificsFromEbay(
  itemId: string,
  valueToFind: string,
  token: string,
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

async function reviseInventoryStatus(
  itemId: string,
  sku: string | null,
  stock: number | undefined,
  price: number | undefined,
  token: string,
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
  token: string,
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
