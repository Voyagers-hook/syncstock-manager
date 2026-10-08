import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// SyncStock refund capture (accounting only).
// Pulls refunds from eBay (the order's MonetaryDetails over a rolling window) and
// Squarespace (each order's refundedTotal) and records them in the refunds table so
// they feed the Refunds page and the profit figures - WITHOUT touching stock, because
// a refund alone doesn't tell us whether the goods came back. Restocking stays a
// manual decision on the Orders page. De-duplicated on (platform, refund_ref).

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

  // eBay refunds
  try {
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
    if (appId && certId && tok?.value) {
      const token = await ebayToken(appId, certId, tok.value);
      for (const r of await fetchEbayRefunds(token, since, now)) {
        if (await record("ebay", r.ref, { platform: "ebay", order_id: r.orderId, order_number: r.orderId, item_name: r.item, amount: r.amount, reason: "eBay refund", restocked: false, note: "auto-captured", refund_ref: r.ref, source: "auto" })) ebayN++;
      }
    } else errors.push("eBay creds/token missing");
  } catch (e: any) { errors.push(`eBay: ${e.message}`); }

  // Squarespace refunds
  try {
    const { data: k } = await supabase.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
    const sqKey = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
    if (sqKey) {
      for (const o of await fetchSqOrders(sqKey, since, now)) {
        const refunded = parseFloat(o.refundedTotal?.value ?? "0");
        if (refunded > 0) {
          const ref = o.id;
          const row = { platform: "squarespace", order_id: o.id, order_number: o.orderNumber, item_name: o.lineItems?.[0]?.productName ?? "Squarespace refund", amount: refunded, reason: "Squarespace refund", restocked: false, note: "auto-captured", refund_ref: ref, source: "auto" };
          if (await record("squarespace", ref, row, refunded)) sqN++;
        }
      }
    }
  } catch (e: any) { errors.push(`Squarespace: ${e.message}`); }

  await supabase.from("sync_log").insert({ sync_type: "refund_sync", status: errors.length ? "partial" : "completed", details: { ebay_refunds: ebayN, sq_refunds: sqN, errors }, source: "edge_function" });
  return json({ ok: true, ebay_refunds: ebayN, sq_refunds: sqN, errors });
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function xtag(xml: string, t: string) { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? m[1].trim() : null; }

// Insert a refund if we haven't seen its ref; for Squarespace, update the amount if
// the cumulative refundedTotal has grown. Returns true if it wrote a new row.
async function record(platform: string, ref: string, row: any, sqAmount?: number): Promise<boolean> {
  const { data: existing } = await supabase.from("refunds").select("id, amount").eq("platform", platform).eq("refund_ref", ref).maybeSingle();
  if (existing) {
    if (sqAmount != null && Number(existing.amount) !== sqAmount) await supabase.from("refunds").update({ amount: sqAmount }).eq("id", existing.id);
    return false;
  }
  const { error } = await supabase.from("refunds").insert(row);
  return !error;
}

async function ebayToken(appId: string, certId: string, refresh: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("token refresh failed"); return d.access_token as string;
}

async function fetchEbayRefunds(token: string, since: Date, until: Date) {
  const out: { orderId: string; ref: string; amount: number; item: string }[] = [];
  let page = 1;
  while (true) {
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ModTimeFrom>${since.toISOString()}</ModTimeFrom><ModTimeTo>${until.toISOString()}</ModTimeTo><OrderRole>Seller</OrderRole><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></GetOrdersRequest>`;
    const resp = await fetch(`${EBAY}/ws/api.dll`, { method: "POST", headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "GetOrders", "X-EBAY-API-SITEID": "3" }, body });
    if (!resp.ok) throw new Error(`GetOrders ${resp.status}`);
    const xml = await resp.text();
    for (const [, oX] of xml.matchAll(/<Order>([\s\S]*?)<\/Order>/g)) {
      const orderId = xtag(oX, "OrderID") ?? "";
      const title = (oX.match(/<Transaction>([\s\S]*?)<\/Transaction>/)?.[1] && xtag(oX.match(/<Transaction>([\s\S]*?)<\/Transaction>/)![1], "Title")) || "eBay refund";
      const md = oX.match(/<MonetaryDetails>([\s\S]*?)<\/MonetaryDetails>/)?.[1] ?? "";
      let i = 0;
      for (const [, rf] of md.matchAll(/<Refund>([\s\S]*?)<\/Refund>/g)) {
        const amt = parseFloat(xtag(rf, "RefundAmount") ?? "0");
        if (!(amt > 0)) continue;
        const ref = xtag(rf, "RefundID") ?? xtag(rf, "ReferenceID") ?? `${orderId}:${xtag(rf, "RefundTime") ?? i}`;
        out.push({ orderId, ref, amount: amt, item: title });
        i++;
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
