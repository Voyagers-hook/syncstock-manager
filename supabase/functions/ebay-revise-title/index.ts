import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Revise an eBay listing's TITLE only, via ReviseItem. This keeps the same ItemID,
// so the merge, shared stock, cost and sales history are all untouched. Also updates
// the tracker's product name so the app shows the tidy title.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { itemId, title } = await req.json();
    if (!itemId || !title) return json({ error: "itemId and title required" }, 400);
    if (String(title).length > 80) return json({ error: "Title must be 80 characters or fewer" }, 400);
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
    if (!appId || !certId || !tok?.value) return json({ error: "eBay creds/token missing" }, 400);
    const token = await ebayToken(appId, certId, tok.value);

    const body = `<?xml version="1.0" encoding="utf-8"?>\n<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><Item><ItemID>${itemId}</ItemID><Title>${xmlEscape(String(title))}</Title></Item></ReviseItemRequest>`;
    const resp = await fetch(`${EBAY}/ws/api.dll`, { method: "POST", headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "ReviseItem", "X-EBAY-API-SITEID": "3" }, body });
    const xml = await resp.text();
    const ack = xml.match(/<Ack>([^<]*)<\/Ack>/)?.[1] ?? "";
    if (ack !== "Success" && ack !== "Warning") {
      const err = xml.match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1] ?? xml.match(/<ShortMessage>([^<]*)<\/ShortMessage>/)?.[1] ?? "eBay ReviseItem failed";
      return json({ error: err }, 500);
    }

    // Update the tracker product name for the product that owns this eBay listing.
    const cpid = `v1|${itemId}|0`;
    const { data: cl } = await supabase.from("channel_listings").select("variant_id").eq("channel", "ebay").eq("channel_product_id", cpid).limit(1).maybeSingle();
    if (cl?.variant_id) {
      const { data: v } = await supabase.from("variants").select("product_id").eq("id", cl.variant_id).maybeSingle();
      if (v?.product_id) await supabase.from("products").update({ name: title, updated_at: new Date().toISOString() }).eq("id", v.product_id);
    }
    return json({ ok: true, itemId, title });
  } catch (e: any) { return json({ error: e.message }, 500); }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function xmlEscape(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

async function ebayToken(appId: string, certId: string, refresh: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("token refresh failed"); return d.access_token as string;
}
