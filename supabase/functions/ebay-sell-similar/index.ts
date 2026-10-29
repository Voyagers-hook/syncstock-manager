import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Refresh an eBay listing's 30-day visibility by re-listing it (eBay's "Sell Similar").
// Re-listing ALWAYS creates a new ItemID, so this also re-links the tracker's
// channel_listings onto the new ItemID while keeping the same variant_id -- which
// means the merge with Squarespace, the shared stock, cost and sales history are all
// preserved untouched.
//
// Two modes:
//   { itemId }                 -> End the live listing, then RelistFixedPriceItem (faithful
//                                 copy incl. variations/specifics/photos), then re-link.
//   { mode:"relist_only", itemId } -> The listing is ALREADY ended (a previous run ended it
//                                 but the relist failed). Just relist + re-link. Lets the
//                                 page offer a safe retry with no risk of a double-end.
//
// Order matters: a faithful relist requires the source listing to be ended first, so
// end->relist is unavoidable. If the relist fails after a successful end, we DO NOT touch
// the tracker and report status "ended_not_relisted" with the ended ItemID so the page can
// retry. An ended listing is recoverable on eBay for 90 days -- it is never deleted.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { itemId, mode } = await req.json();
    if (!itemId || !/^[0-9]{6,}$/.test(String(itemId))) return json({ error: "valid itemId required" }, 400);
    const relistOnly = mode === "relist_only";

    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
    if (!appId || !certId || !tok?.value) return json({ error: "eBay creds/token missing" }, 400);
    const token = await ebayToken(appId, certId, tok.value);

    // 1. End the live listing (skipped when retrying an already-ended one).
    if (!relistOnly) {
      const endBody = `<?xml version="1.0" encoding="utf-8"?>\n<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${itemId}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`;
      const endXml = await trading(endBody, "EndFixedPriceItem");
      const endAck = ack(endXml);
      if (endAck !== "Success" && endAck !== "Warning") {
        // A listing that is already ended reports an error here; treat that as fine and continue.
        const msg = longErr(endXml);
        if (!/already|ended|not active|invalid item state|can not be ended|cannot be ended/i.test(msg)) {
          return json({ status: "end_failed", itemId, error: msg || "Could not end the eBay listing" }, 500);
        }
      }
    }

    // 2. Relist -> faithful copy with a brand new ItemID.
    const relistBody = `<?xml version="1.0" encoding="utf-8"?>\n<RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><Item><ItemID>${itemId}</ItemID></Item></RelistFixedPriceItemRequest>`;
    const relistXml = await trading(relistBody, "RelistFixedPriceItem");
    const relistAck = ack(relistXml);
    const newItemId = relistXml.match(/<ItemID>([0-9]+)<\/ItemID>/)?.[1] ?? "";
    if ((relistAck !== "Success" && relistAck !== "Warning") || !newItemId) {
      return json({ status: "ended_not_relisted", itemId, error: longErr(relistXml) || "Relist failed" }, 500);
    }

    // 3. Re-link the tracker: every ebay channel_listing on the old ItemID -> new ItemID.
    //    Keep variant_id (preserves merge/stock/history). Single-item listings also carry
    //    the ItemID as their channel_sku, so flip that too. Flag variants for a stock re-push.
    const oldCpid = `v1|${itemId}|0`, newCpid = `v1|${newItemId}|0`;
    const { data: affected } = await supabase.from("channel_listings").select("id, variant_id, channel_sku").eq("channel", "ebay").eq("channel_product_id", oldCpid);
    const variantIds = (affected ?? []).map((r: any) => r.variant_id).filter(Boolean);
    // channel_sku == old ItemID (single-item listings)
    await supabase.from("channel_listings").update({ channel_sku: newItemId }).eq("channel", "ebay").eq("channel_product_id", oldCpid).eq("channel_sku", String(itemId));
    // channel_product_id for all rows (single + every variation row)
    await supabase.from("channel_listings").update({ channel_product_id: newCpid, last_synced_at: new Date().toISOString() }).eq("channel", "ebay").eq("channel_product_id", oldCpid);
    if (variantIds.length) await supabase.from("variants").update({ needs_sync: true, updated_at: new Date().toISOString() }).in("id", variantIds);

    await supabase.from("sync_log").insert({ type: "ebay_sell_similar", message: `relisted ${itemId} -> ${newItemId}`, created_at: new Date().toISOString() }).then(() => {}, () => {});

    return json({ status: "ok", oldItemId: String(itemId), newItemId, relinked: variantIds.length });
  } catch (e: any) { return json({ error: e.message }, 500); }
});

async function trading(body: string, call: string): Promise<string> {
  const resp = await fetch(`${EBAY}/ws/api.dll`, { method: "POST", headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "3" }, body });
  return await resp.text();
}
function ack(xml: string) { return xml.match(/<Ack>([^<]*)<\/Ack>/)?.[1] ?? ""; }
function longErr(xml: string) { return xml.match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1] ?? xml.match(/<ShortMessage>([^<]*)<\/ShortMessage>/)?.[1] ?? ""; }
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }

async function ebayToken(appId: string, certId: string, refresh: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("token refresh failed"); return d.access_token as string;
}
