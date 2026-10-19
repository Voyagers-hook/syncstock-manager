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
//   { action: "active" }                     -> item numbers of every live eBay listing (anything else has ended)
//   { action: "remove", itemId, deleteSquarespace } -> delete an ended listing's product from SyncStock,
//                                               and optionally its Squarespace product. Past orders are kept.

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

    if (action === "active") {
      const token = await getToken(supabase);
      const ids = await activeItemIds(token);
      if (!ids.length) throw new Error("eBay returned no active listings, so ended listings can't be worked out right now.");
      return json({ ok: true, itemIds: ids });
    }

    if (!itemId) return json({ error: "Missing eBay item number." }, 400);

    if (action === "remove") {
      // Only ended listings can be removed here, so a live listing is never deleted by mistake.
      const live = await getItem(await getToken(supabase), itemId).catch(() => null);
      if (live && live.status === "Active") return json({ error: "That listing is still live on eBay, so nothing was removed." }, 400);
      const result = await removeListing(supabase, itemId, !!body.deleteSquarespace);
      return json({ ok: true, ...result });
    }

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

async function activeItemIds(token: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const xml = await trading(
      token,
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>`,
    );
    if (/<Ack>Failure<\/Ack>/.test(xml)) throw new Error(ebayErrors(xml, "Error").join(" ") || "eBay couldn't list active items.");
    const found = [...xml.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map((m) => m[1]);
    found.forEach((id) => ids.add(id));
    const pages = parseInt(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1");
    if (!found.length || page >= pages) break;
  }
  return [...ids];
}

async function removeListing(supabase: any, itemId: string, deleteSquarespace: boolean) {
  // Find the SyncStock product(s) behind this eBay item.
  const { data: eb1, error: e1 } = await supabase
    .from("channel_listings").select("variant_id").eq("channel", "ebay").like("channel_product_id", `%|${itemId}|%`);
  if (e1) throw new Error(e1.message);
  const { data: eb2, error: e1b } = await supabase
    .from("channel_listings").select("variant_id").eq("channel", "ebay").eq("channel_sku", itemId);
  if (e1b) throw new Error(e1b.message);
  const variantIds = [...new Set([...(eb1 ?? []), ...(eb2 ?? [])].map((r: any) => r.variant_id))];
  if (!variantIds.length) throw new Error("SyncStock has no product linked to that eBay listing.");
  const { data: vs, error: e2 } = await supabase.from("variants").select("product_id").in("id", variantIds);
  if (e2) throw new Error(e2.message);
  const productIds = [...new Set((vs ?? []).map((r: any) => r.product_id))];
  if (productIds.length > 3) throw new Error("That eBay listing is linked to more products than expected, so nothing was removed. Check it in Merge first.");
  const { data: prods } = await supabase.from("products").select("id, name").in("id", productIds);

  // Squarespace products linked to those SyncStock products.
  const { data: allVars } = await supabase.from("variants").select("id").in("product_id", productIds);
  const { data: sq } = await supabase
    .from("channel_listings")
    .select("channel_product_id")
    .eq("channel", "squarespace")
    .in("variant_id", (allVars ?? []).map((v: any) => v.id));
  const sqIds = [...new Set((sq ?? []).map((r: any) => r.channel_product_id).filter(Boolean))] as string[];

  // Delete on Squarespace first. If that fails, stop before touching SyncStock.
  const sqDeleted: string[] = [];
  if (deleteSquarespace && sqIds.length) {
    const { data: k } = await supabase.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
    const key = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
    if (!key) throw new Error("Squarespace API key not set, so nothing was removed.");
    for (const id of sqIds) {
      const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}`, "User-Agent": "SyncStock/2.0" },
      });
      if (!r.ok && r.status !== 404) {
        const t = await r.text();
        throw new Error(`Squarespace wouldn't delete the product (${r.status}), so nothing was removed. ${t.slice(0, 200)}`);
      }
      sqDeleted.push(id);
    }
  }

  // Keep past orders in sales history, just unlinked from the product.
  const { error: e3 } = await supabase.from("orders").update({ product_id: null }).in("product_id", productIds);
  if (e3) throw new Error("Couldn't unlink past orders, so nothing was removed: " + e3.message);
  // Variants, stock, channel links and competitor prices go with the product.
  const { error: e4 } = await supabase.from("products").delete().in("id", productIds);
  if (e4) throw new Error(e4.message);

  const names = (prods ?? []).map((p: any) => p.name);
  await supabase.from("sync_log").insert({
    sync_type: "listing_remove",
    status: "completed",
    details: { itemId, products: names, squarespaceDeleted: sqDeleted, squarespaceKept: deleteSquarespace ? [] : sqIds },
    source: "edge_function",
  });
  return { removed: names, squarespaceDeleted: sqDeleted, squarespaceKept: deleteSquarespace ? [] : sqIds };
}
