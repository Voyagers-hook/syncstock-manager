import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// SyncStock order capture (rebuilt 2026-10).
// - Captures BOTH eBay and Squarespace sales.
// - eBay is pulled by LAST-MODIFIED time over a rolling window, so an order that
//   completes after its creation window is still caught (fixes the dropped-order bug).
// - Dedup against the orders table (the record of truth) + a processed_orders unique
//   guard, so every order is counted exactly once - never dropped, never doubled.
// - Decrements the single shared stock figure, logs the change with a reason, and
//   pushes the new stock to the OTHER channel via push-stock (one proven routine).

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";
const SQ = "https://api.squarespace.com/1.0";
const LOOKBACK_DAYS = 30;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const now = new Date();
  let ebayN = 0, sqN = 0; const errors: string[] = [];

  const existKeys = new Set<string>();
  { let from = 0; while (true) { const { data } = await supabase.from("orders").select("platform, platform_order_id, sku").range(from, from + 999); if (!data?.length) break; for (const r of data) existKeys.add(`${r.platform}::${r.platform_order_id}::${r.sku ?? ""}`); if (data.length < 1000) break; from += 1000; } }
  const seen = (channel: string, oid: string, sku: string) => existKeys.has(`${channel}::${oid}::${sku ?? ""}`);
  const mark = (channel: string, oid: string, sku: string) => existKeys.add(`${channel}::${oid}::${sku ?? ""}`);

  try {
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
    if (appId && certId && tok?.value) {
      const token = await ebayToken(appId, certId, tok.value);
      for (const t of await fetchEbayOrders(token, since, now)) {
        const sku = t.variationSku ?? t.variationName ?? t.itemId;
        if (seen("ebay", t.orderId, sku)) { await enrich("ebay", t.orderId, t.cust); continue; }
        try { if (await applySale("ebay", t.dedupKey, { cpid: t.cpid, vSku: t.variationSku, vName: t.variationName }, t.quantity, { platform: "ebay", platform_order_id: t.orderId, order_number: t.orderId, item_name: t.itemTitle, sku, unit_price: t.price, ordered_at: t.createdTime, ...(t.cust ?? {}) })) { ebayN++; mark("ebay", t.orderId, sku); } }
        catch (e: any) { errors.push(`ebay ${t.orderId}: ${e.message}`); }
      }
    } else errors.push("eBay creds/token missing");
  } catch (e: any) { errors.push(`eBay: ${e.message}`); }

  try {
    const { data: k } = await supabase.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
    const sqKey = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
    if (sqKey) {
      for (const o of await fetchSqOrders(sqKey, since, now)) {
        const sh = o.shippingAddress ?? o.billingAddress ?? {};
        const fulfil = (o.fulfillments ?? [])[0] ?? {};
        const cust = {
          customer_name: [sh.firstName, sh.lastName].filter(Boolean).join(" ") || null,
          customer_email: o.customerEmail ?? null,
          shipping_address_line1: sh.address1 ?? null,
          shipping_address_line2: sh.address2 ?? null,
          shipping_city: sh.city ?? null,
          shipping_county: sh.state ?? null,
          shipping_postcode: sh.postalCode ?? null,
          shipping_country: sh.countryCode ?? null,
          tracking_number: fulfil.trackingNumber ?? null,
          tracking_carrier: fulfil.carrierName ?? null,
          fulfillment_status: o.fulfillmentStatus ?? null,
        };
        for (const li of (o.lineItems ?? [])) {
          if (seen("squarespace", o.id, li.variantId)) { await enrich("squarespace", o.id, cust); continue; }
          try { if (await applySale("squarespace", `${o.id}::${li.variantId}`, { sqVariantId: li.variantId }, li.quantity, { platform: "squarespace", platform_order_id: o.id, order_number: o.orderNumber, item_name: li.productName, sku: li.variantId, unit_price: parseFloat(li.unitPricePaid?.value ?? "0"), ordered_at: o.createdOn, ...cust })) { sqN++; mark("squarespace", o.id, li.variantId); } }
          catch (e: any) { errors.push(`sq ${o.id}: ${e.message}`); }
        }
      }
    }
  } catch (e: any) { errors.push(`Squarespace: ${e.message}`); }

  await supabase.from("sync_log").insert({ sync_type: "order_sync", status: errors.length ? "partial" : "completed", details: { ebay_processed: ebayN, sq_processed: sqN, errors }, source: "edge_function" });
  return json({ ok: true, ebay_processed: ebayN, sq_processed: sqN, errors });
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function xtag(xml: string, t: string) { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? m[1].trim() : null; }

// Backfill customer/shipping/tracking onto an order we've already recorded, so
// existing orders show their details without re-importing. Only fills blanks.
async function enrich(channel: string, orderId: string, cust: any) {
  if (!cust) return;
  const patch: Record<string, any> = {};
  for (const k of Object.keys(cust)) if (cust[k] != null && cust[k] !== "") patch[k] = cust[k];
  if (Object.keys(patch).length)
    await supabase.from("orders").update(patch).eq("platform", channel).eq("platform_order_id", orderId);
}

async function applySale(channel: string, dedupKey: string, match: any, qty: number, meta: any): Promise<boolean> {
  const { error: dupErr } = await supabase.from("processed_orders").insert({ channel, order_id: dedupKey });
  if (dupErr) return false; // race guard
  let listing: any = null;
  if (channel === "ebay") {
    const { data: ls } = await supabase.from("channel_listings").select("*").eq("channel", "ebay").eq("channel_product_id", match.cpid);
    if (ls?.length) { listing = ls[0]; if (match.vSku) listing = ls.find((l: any) => l.channel_sku === match.vSku) ?? listing; else if (match.vName) listing = ls.find((l: any) => l.channel_variant_id === match.vName) ?? listing; }
  } else {
    const { data: ls } = await supabase.from("channel_listings").select("*").eq("channel", "squarespace").eq("channel_variant_id", match.sqVariantId);
    if (ls?.length) listing = ls[0];
  }
  const orderRow: any = { ...meta, quantity: qty, total_price: (meta.unit_price ?? 0) * qty, synced_at: new Date().toISOString(), status: "completed" };
  if (listing) {
    const { data: inv } = await supabase.from("inventory").select("id, total_stock, product_id").eq("variant_id", listing.variant_id).maybeSingle();
    if (inv) {
      const oldS = inv.total_stock ?? 0, newS = Math.max(0, oldS - qty);
      await supabase.from("inventory").update({ total_stock: newS, updated_at: new Date().toISOString() }).eq("id", inv.id);
      await supabase.from("stock_log").insert({ variant_id: listing.variant_id, product_id: inv.product_id, old_stock: oldS, new_stock: newS, delta: newS - oldS, source: "order_sync", reason: "sale", note: `${channel} order ${meta.order_number ?? meta.platform_order_id}` });
      orderRow.product_id = inv.product_id;
      await pushStock(listing.variant_id, newS);
    }
  }
  await supabase.from("orders").insert(orderRow);
  return true;
}

async function pushStock(variantId: string, stock: number) {
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-stock`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` }, body: JSON.stringify({ variantId, stock }) });
    const d = await r.json().catch(() => ({}));
    const failed = (d?.results ?? []).filter((x: any) => x.status === "error");
    if (failed.length) await supabase.from("sync_log").insert({ sync_type: "order_sync", status: "partial", source: "edge_function", error_message: `push-stock failed ${variantId}: ${JSON.stringify(failed)}` });
  } catch (e: any) { await supabase.from("sync_log").insert({ sync_type: "order_sync", status: "partial", source: "edge_function", error_message: `push threw ${variantId}: ${e.message}` }); }
}

async function ebayToken(appId: string, certId: string, refresh: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("token refresh failed"); return d.access_token as string;
}

async function fetchEbayOrders(token: string, since: Date, until: Date) {
  const out: any[] = []; let page = 1;
  while (true) {
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ModTimeFrom>${since.toISOString()}</ModTimeFrom><ModTimeTo>${until.toISOString()}</ModTimeTo><OrderRole>Seller</OrderRole><OrderStatus>Completed</OrderStatus><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></GetOrdersRequest>`;
    const resp = await fetch(`${EBAY}/ws/api.dll`, { method: "POST", headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "GetOrders", "X-EBAY-API-SITEID": "3" }, body });
    if (!resp.ok) throw new Error(`GetOrders ${resp.status}`);
    const xml = await resp.text();
    for (const [, oX] of xml.matchAll(/<Order>([\s\S]*?)<\/Order>/g)) {
      const orderId = xtag(oX, "OrderID") ?? ""; const created = xtag(oX, "CreatedTime") ?? new Date().toISOString();
      // Order-level buyer, delivery address and tracking (shared by all lines in the order).
      const sa = oX.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/)?.[1] ?? "";
      const track = oX.match(/<ShipmentTrackingDetails>([\s\S]*?)<\/ShipmentTrackingDetails>/)?.[1] ?? "";
      const shipped = xtag(oX, "ShippedTime");
      const cust = {
        customer_name: xtag(sa, "Name") ?? xtag(oX, "BuyerUserID"),
        customer_email: xtag(oX, "Email"),
        shipping_address_line1: xtag(sa, "Street1"),
        shipping_address_line2: xtag(sa, "Street2"),
        shipping_city: xtag(sa, "CityName"),
        shipping_county: xtag(sa, "StateOrProvince"),
        shipping_postcode: xtag(sa, "PostalCode"),
        shipping_country: xtag(sa, "CountryName") ?? xtag(sa, "Country"),
        tracking_number: xtag(track, "ShipmentTrackingNumber"),
        tracking_carrier: xtag(track, "ShippingCarrierUsed"),
        fulfillment_status: shipped ? "Dispatched" : "Undispatched",
      };
      for (const [, tX] of oX.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)) {
        const itemId = xtag(tX, "ItemID") ?? ""; if (!itemId) continue;
        let vSku: string | null = null, vName: string | null = null;
        const vm = tX.match(/<Variation>([\s\S]*?)<\/Variation>/);
        if (vm) { vSku = xtag(vm[1], "SKU"); const n: string[] = []; for (const [, nv] of vm[1].matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) { const v = xtag(nv, "Value"); if (v) n.push(v); } vName = n.join(" / ") || null; }
        out.push({ orderId, createdTime: created, itemId, cpid: `v1|${itemId}|0`, itemTitle: xtag(tX, "Title") ?? "", variationSku: vSku, variationName: vName, quantity: parseInt(xtag(tX, "QuantityPurchased") ?? "1"), price: parseFloat(xtag(tX, "TransactionPrice") ?? "0"), dedupKey: `${orderId}::${vSku ?? vName ?? itemId}`, cust });
      }
    }
    const tp = parseInt(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1");
    if (page >= tp) break; page++;
  }
  return out;
}

async function fetchSqOrders(key: string, since: Date, until: Date) {
  const all: any[] = []; let cursor: string | undefined;
  while (true) {
    const q = cursor ? `cursor=${cursor}` : `modifiedAfter=${since.toISOString()}&modifiedBefore=${until.toISOString()}`;
    const r = await fetch(`${SQ}/commerce/orders?${q}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "SyncStock/2.0" } });
    if (!r.ok) throw new Error(`SQ orders ${r.status}`);
    const d = await r.json(); all.push(...(d.result ?? []));
    if (d.pagination?.hasNextPage && d.pagination?.nextPageCursor) cursor = d.pagination.nextPageCursor; else break;
  }
  return all;
}
