import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// SyncStock eBay import (rebuilt 2026-10).
// Quick-sync of active eBay listings. Key safeguard: if eBay returns a variation
// item "flat" (no variations) but we already hold variation rows for it, we REFUSE
// to create a no-variation parent row (that is what spawned the phantom entries).
// Auto-merge is never used - genuinely new items come in as standalone products and
// are merged manually. Existing stock is never overwritten - only brand-new variants
// are seeded.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "EBAY_APP_ID / EBAY_CERT_ID not set" }, 400);
    const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
    if (!tok?.value) return json({ error: "No eBay refresh token" }, 400);
    const token = await ebayToken(appId, certId, tok.value);
    const items = await fetchAllListings(token);
    const stats = await quickSync(supabase, items);
    await supabase.from("sync_log").insert({ sync_type: "ebay_import", status: "completed", details: { mode: "quick_sync", ...stats }, source: "edge_function" });
    return json({ ok: true, ...stats });
  } catch (e: any) {
    await supabase.from("sync_log").insert({ sync_type: "ebay_import", status: "failed", error_message: e.message, source: "edge_function" });
    return json({ error: e.message }, 500);
  }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function dec(s: string) { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
function xtag(xml: string, t: string) { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? dec(m[1].trim()) : null; }
function varName(vx: string) { const parts: string[] = []; for (const [, nv] of vx.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) { const v = xtag(nv, "Value"); if (v) parts.push(v); } return parts.join(" / "); }

async function ebayToken(appId: string, certId: string, refresh: string) {
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory" }) });
  const d = await r.json(); if (!d.access_token) throw new Error("eBay token refresh failed"); return d.access_token as string;
}

type EVar = { sku: string; price: string; name: string; qty: number; sold: number };
type EItem = { itemId: string; title: string; sku: string; price: string; qty: number; sold: number; variations: EVar[] };

async function fetchAllListings(token: string): Promise<EItem[]> {
  const items: EItem[] = []; let page = 1;
  while (true) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><IncludeVariations>true</IncludeVariations><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel></GetMyeBaySellingRequest>`;
    const resp = await fetch(`${EBAY}/ws/api.dll`, { method: "POST", headers: { "Content-Type": "text/xml", "X-EBAY-API-SITEID": "3", "X-EBAY-API-COMPATIBILITY-LEVEL": "967", "X-EBAY-API-CALL-NAME": "GetMyeBaySelling" }, body: xml });
    const text = await resp.text();
    const matches = [...text.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];
    if (!matches.length) break;
    for (const [, ix] of matches) {
      const itemId = xtag(ix, "ItemID") ?? ""; const title = xtag(ix, "Title") ?? ""; const sku = xtag(ix, "SKU") ?? itemId;
      const price = xtag(ix, "CurrentPrice") ?? xtag(ix, "StartPrice") ?? "0";
      const qty = parseInt(xtag(ix, "Quantity") ?? "0"); const sold = parseInt(xtag(ix, "QuantitySold") ?? "0");
      const variations: EVar[] = [];
      for (const [, vx] of ix.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
        const vSku = xtag(vx, "SKU") ?? ""; const vPrice = xtag(vx, "StartPrice") ?? price;
        variations.push({ sku: vSku, price: vPrice, name: varName(vx) || vSku, qty: parseInt(xtag(vx, "Quantity") ?? "0"), sold: parseInt(xtag(vx, "QuantitySold") ?? "0") });
      }
      items.push({ itemId, title, sku, price, qty, sold, variations });
    }
    const tp = parseInt(text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1");
    if (page >= tp) break; page++;
  }
  return items;
}

async function quickSync(supabase: any, items: EItem[]) {
  const now = new Date().toISOString();
  let updated = 0, created = 0, phantomsBlocked = 0;
  const { data: existing } = await supabase.from("channel_listings").select("id, channel_product_id, channel_variant_id, variant_id").eq("channel", "ebay");
  const listingMap = new Map<string, any>();
  const cpidToProduct = new Map<string, string>();
  const cpidHasVariations = new Set<string>();
  const varIds = [...new Set((existing ?? []).map((l: any) => l.variant_id))];
  const vToP = new Map<string, string>();
  for (let i = 0; i < varIds.length; i += 150) { const { data } = await supabase.from("variants").select("id, product_id").in("id", varIds.slice(i, i + 150)); for (const v of data ?? []) vToP.set(v.id, v.product_id); }
  for (const l of existing ?? []) { listingMap.set(`${l.channel_product_id}::${l.channel_variant_id ?? ""}`, l); const pid = vToP.get(l.variant_id); if (pid) cpidToProduct.set(l.channel_product_id, pid); if ((l.channel_variant_id ?? "") !== "") cpidHasVariations.add(l.channel_product_id); }
  const updates: any[] = [];
  type NewE = { productId: string | null; title: string; itemSku: string; iSku: string; option1: string | null; cpid: string; cvid: string | null; channelSku: string; price: number; stock: number };
  const news: NewE[] = [];
  for (const item of items) {
    const cpid = `v1|${item.itemId}|0`;
    if (item.variations.length > 0) {
      for (const v of item.variations) {
        const cvid = v.name || v.sku || `${item.itemId}-${v.name}`;
        const ex = listingMap.get(`${cpid}::${cvid}`);
        if (ex) updates.push({ id: ex.id, channel_price: parseFloat(v.price), last_synced_at: now });
        else news.push({ productId: cpidToProduct.get(cpid) ?? null, title: item.title, itemSku: item.sku, iSku: v.sku || `${item.itemId}-${v.name}`, option1: v.name || null, cpid, cvid, channelSku: v.sku || v.name, price: parseFloat(v.price), stock: Math.max(0, v.qty - v.sold) });
      }
    } else {
      // PHANTOM GUARD: eBay returned this item flat. If we already hold variation rows for
      // it, that is a bad/partial response - skip rather than create a phantom parent.
      if (cpidHasVariations.has(cpid)) { phantomsBlocked++; continue; }
      const ex = listingMap.get(`${cpid}::`);
      if (ex) updates.push({ id: ex.id, channel_price: parseFloat(item.price) || 0, last_synced_at: now });
      else news.push({ productId: cpidToProduct.get(cpid) ?? null, title: item.title, itemSku: item.sku, iSku: item.itemId, option1: null, cpid, cvid: null, channelSku: item.sku || item.itemId, price: parseFloat(item.price) || 0, stock: Math.max(0, item.qty - item.sold) });
    }
  }
  for (let i = 0; i < updates.length; i += 200) await supabase.from("channel_listings").upsert(updates.slice(i, i + 200));
  updated = updates.length;
  const needProduct = news.filter((e) => !e.productId);
  const uniqueCpids = [...new Map(needProduct.map((e) => [e.cpid, e])).values()];
  for (const e of uniqueCpids) { const { data: p } = await supabase.from("products").insert({ name: e.title, sku: e.itemSku, active: true }).select("id").single(); if (p) for (const n of news) if (!n.productId && n.cpid === e.cpid) n.productId = p.id; }
  for (const e of news) {
    if (!e.productId) continue;
    let { data: ev } = await supabase.from("variants").select("id").eq("product_id", e.productId).eq("internal_sku", e.iSku).maybeSingle();
    let variantId = ev?.id ?? null;
    if (!variantId) { const { data: nv } = await supabase.from("variants").insert({ product_id: e.productId, internal_sku: e.iSku, option1: e.option1 }).select("id").single(); variantId = nv?.id ?? null; }
    if (!variantId) continue;
    const { data: inv } = await supabase.from("inventory").select("id").eq("variant_id", variantId).maybeSingle();
    if (!inv) await supabase.from("inventory").insert({ variant_id: variantId, product_id: e.productId, total_stock: e.stock });
    await supabase.from("channel_listings").insert({ variant_id: variantId, channel: "ebay", channel_sku: e.channelSku, channel_price: e.price, channel_product_id: e.cpid, channel_variant_id: e.cvid });
    created++;
  }
  return { listings_updated: updated, new_listings_created: created, phantoms_blocked: phantomsBlocked };
}
