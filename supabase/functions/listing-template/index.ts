import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Listing template converter backend.
// Fetches an eBay listing's description, and replaces it with a converted one after saving a backup.
// Only the description is ever changed. Price, stock, photos and item specifics are left alone.
//
// Actions (POST JSON):
//   { action: "get", itemId }                -> current title, condition, description
//   { action: "send", itemId, html }         -> backs up the live description, then replaces it
//   { action: "restore", itemId }            -> puts back the most recent backup
//   { action: "status" }                     -> which items have been converted (latest backup per item)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const itemId = body.itemId ? String(body.itemId).replace(/\D/g, "") : "";

    if (action === "status") {
      const { data, error } = await supabase
        .from("listing_description_backups")
        .select("item_id, created_at, restored_at")
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw new Error(error.message);
      const latest: Record<string, { converted_at: string; restored: boolean }> = {};
      for (const r of data ?? []) {
        if (!latest[r.item_id]) latest[r.item_id] = { converted_at: r.created_at, restored: !!r.restored_at };
      }
      return json({ ok: true, items: latest });
    }

    if (!itemId) return json({ error: "Missing eBay item number." }, 400);
    const token = await getToken(supabase);

    if (action === "get") {
      const item = await getItem(token, itemId);
      return json({ ok: true, ...item });
    }

    if (action === "send") {
      const html = String(body.html || "");
      if (html.length < 200 || !html.includes("vh-product")) return json({ error: "The new description looks empty. Nothing was sent." }, 400);
      if (html.length > 500000) return json({ error: "The new description is too long for eBay." }, 400);
      const item = await getItem(token, itemId);
      const { error: bErr } = await supabase.from("listing_description_backups").insert({
        item_id: itemId,
        title: item.title,
        old_description: item.description,
        new_description: html,
      });
      if (bErr) throw new Error("Couldn't save a backup, so nothing was sent: " + bErr.message);
      const warnings = await reviseDescription(token, itemId, html);
      await supabase.from("sync_log").insert({ sync_type: "listing_template_send", status: "completed", details: { itemId, warnings }, source: "edge_function" });
      return json({ ok: true, warnings });
    }

    if (action === "restore") {
      const { data: rows, error } = await supabase
        .from("listing_description_backups")
        .select("id, old_description")
        .eq("item_id", itemId)
        .is("restored_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = rows?.[0];
      if (!row) return json({ error: "No backup to restore for this listing." }, 404);
      const warnings = await reviseDescription(token, itemId, row.old_description || "");
      await supabase.from("listing_description_backups").update({ restored_at: new Date().toISOString() }).eq("item_id", itemId).is("restored_at", null);
      await supabase.from("sync_log").insert({ sync_type: "listing_template_restore", status: "completed", details: { itemId, warnings }, source: "edge_function" });
      return json({ ok: true, warnings });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e: any) {
    return json({ error: e.message || String(e) }, 500);
  }
});

function json(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, t: string): string | null {
  const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
  if (!m) return null;
  let v = m[1];
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : decodeXml(v);
}

async function getToken(supabase: any): Promise<string> {
  const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
  const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
  if (!appId || !certId || !tok?.value) throw new Error("eBay connection details are missing.");
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tok.value,
      scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Couldn't log in to eBay (token refresh failed).");
  return d.access_token as string;
}

async function trading(token: string, call: string, inner: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>${inner}</${call}Request>`;
  const resp = await fetch(`${EBAY}/ws/api.dll`, {
    method: "POST",
    headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "3" },
    body,
  });
  return await resp.text();
}

function ebayErrors(xml: string, severity: "Error" | "Warning"): string[] {
  const out: string[] = [];
  for (const [, block] of xml.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)) {
    if ((tag(block, "SeverityCode") || "") !== severity) continue;
    out.push(tag(block, "LongMessage") || tag(block, "ShortMessage") || "eBay error");
  }
  return out;
}

async function getItem(token: string, itemId: string) {
  const xml = await trading(
    token,
    "GetItem",
    `<ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics>`,
  );
  if (/<Ack>Failure<\/Ack>/.test(xml)) throw new Error(ebayErrors(xml, "Error").join(" ") || "eBay couldn't find that listing.");
  // Drop nested blocks that have their own <Description> (returns policy etc.) so we read the listing's own one.
  const item = (xml.match(/<Item>([\s\S]*)<\/Item>/)?.[1] ?? "")
    .replace(/<ReturnPolicy>[\s\S]*?<\/ReturnPolicy>/g, "")
    .replace(/<ShippingDetails>[\s\S]*?<\/ShippingDetails>/g, "")
    .replace(/<SellerProfiles>[\s\S]*?<\/SellerProfiles>/g, "");
  return {
    itemId,
    title: tag(item, "Title") || "",
    description: tag(item, "Description") || "",
    condition: tag(item, "ConditionDisplayName") || "",
    url: tag(item, "ViewItemURL") || `https://www.ebay.co.uk/itm/${itemId}`,
    status: tag(item, "ListingStatus") || "",
  };
}

async function reviseDescription(token: string, itemId: string, html: string): Promise<string[]> {
  const cdata = "<![CDATA[" + html.split("]]>").join("]]]]><![CDATA[>") + "]]>";
  const xml = await trading(
    token,
    "ReviseItem",
    `<Item><ItemID>${itemId}</ItemID><Description>${cdata}</Description><DescriptionReviseMode>Replace</DescriptionReviseMode></Item>`,
  );
  if (/<Ack>Failure<\/Ack>/.test(xml)) throw new Error(ebayErrors(xml, "Error").join(" ") || "eBay rejected the update.");
  return ebayErrors(xml, "Warning");
}
