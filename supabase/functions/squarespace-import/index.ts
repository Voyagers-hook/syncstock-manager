import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// SyncStock Squarespace import (rebuilt 2026-10).
// Imports/updates Squarespace products. Never overwrites existing stock (only seeds
// brand-new variants). Name-refresh: for website-only products (no eBay listing), if
// the Squarespace title has changed, the tracker name is updated - so a renamed or
// repurposed listing stops hiding under its old name. Merged products (with an eBay
// listing) keep their name so eBay and Squarespace titles never fight.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const SQ = "https://api.squarespace.com/1.0";
const CH = 150;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: k } = await supabase.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const key = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
  if (!key) return json({ error: "Squarespace API key not set" }, 400);
  try {
    const products = await fetchAll(key);
    const stats = await upsert(supabase, products);
    await supabase.from("sync_log").insert({ sync_type: "squarespace_import", status: "completed", details: stats, source: "edge_function" });
    return json({ ok: true, ...stats });
  } catch (e: any) {
    await supabase.from("sync_log").insert({ sync_type: "squarespace_import", status: "failed", error_message: e.message, source: "edge_function" });
    return json({ error: e.message }, 500);
  }
});

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
function chunk<T>(a: T[], n: number) { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function fetchAll(key: string) {
  const all: any[] = []; let cursor: string | undefined;
  while (true) {
    const url = cursor ? `${SQ}/commerce/products?cursor=${cursor}` : `${SQ}/commerce/products`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "SyncStock/2.0" } });
    if (!r.ok) throw new Error(`Squarespace API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json(); all.push(...(d.products ?? []));
    if (d.pagination?.hasNextPage && d.pagination?.nextPageCursor) cursor = d.pagination.nextPageCursor; else break;
  }
  return all;
}

async function rowsByCol(supabase: any, table: string, col: string, vals: string[], sel: string) {
  if (!vals.length) return [] as any[]; const out: any[] = [];
  for (const c of chunk([...new Set(vals)], CH)) { const { data } = await supabase.from(table).select(sel).in(col, c); out.push(...(data ?? [])); }
  return out;
}

async function upsert(supabase: any, sqProducts: any[]) {
  let productsCreated = 0, productsReused = 0, variantsCreated = 0, listingsCreated = 0, listingsUpdated = 0, namesRefreshed = 0;
  const extVarIds = sqProducts.flatMap((p) => (p.variants ?? []).map((v: any) => v.id));
  const skus = sqProducts.flatMap((p) => (p.variants ?? []).map((v: any) => v.sku).filter(Boolean));
  const existBase = [
    ...(await rowsByCol(supabase, "channel_listings", "channel_variant_id", extVarIds, "id, variant_id, channel_variant_id, channel_sku")),
    ...(await rowsByCol(supabase, "channel_listings", "channel_sku", skus, "id, variant_id, channel_variant_id, channel_sku")),
  ].filter((r) => r);
  const seen = new Set<string>(); const exist = existBase.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const vrows = await rowsByCol(supabase, "variants", "id", exist.map((r) => r.variant_id), "id, product_id, internal_sku, option1");
  const vToP = new Map<string, string>(); for (const v of vrows) vToP.set(v.id, v.product_id);
  const byExtVar = new Map<string, any>(); const bySku = new Map<string, any>();
  for (const l of exist) { const e = { id: l.id, variant_id: l.variant_id, product_id: vToP.get(l.variant_id) ?? null }; if (l.channel_variant_id) byExtVar.set(l.channel_variant_id, e); if (l.channel_sku) bySku.set(l.channel_sku, e); }
  const prodIds = [...new Set(vrows.map((v) => v.product_id))];
  const ebayVars = await rowsByCol(supabase, "channel_listings", "variant_id", vrows.map((v) => v.id), "variant_id, channel");
  const hasEbay = new Set<string>(); for (const e of ebayVars) if (e.channel === "ebay") { const pid = vToP.get(e.variant_id); if (pid) hasEbay.add(pid); }
  const prodRows = await rowsByCol(supabase, "products", "id", prodIds, "id, name");
  const prodName = new Map<string, string>(); for (const p of prodRows) prodName.set(p.id, p.name);
  const variantByPO = new Map<string, string>();
  const existVars = await rowsByCol(supabase, "variants", "product_id", prodIds, "id, product_id, internal_sku, option1, option2");
  for (const v of existVars) variantByPO.set(`${v.product_id}:${v.internal_sku ?? ""}`, v.id);
  const invSet = new Set<string>(); const invRows = await rowsByCol(supabase, "inventory", "variant_id", existVars.map((v) => v.id), "variant_id"); for (const i of invRows) invSet.add(i.variant_id);
  for (const p of sqProducts) {
    const canon = (p.variants ?? []).map((v: any) => byExtVar.get(v.id) ?? bySku.get(v.sku ?? v.id)).find((x: any) => x);
    let productId = canon?.product_id ?? null;
    if (!productId) {
      const { data: np } = await supabase.from("products").insert({ name: p.name, description: p.description ?? null, image_url: p.images?.[0]?.url ?? null, status: "active", active: true }).select("id").single();
      if (!np) continue; productId = np.id; productsCreated++;
    } else {
      productsReused++;
      if (!hasEbay.has(productId) && prodName.get(productId) && prodName.get(productId) !== p.name) { await supabase.from("products").update({ name: p.name, updated_at: new Date().toISOString() }).eq("id", productId); namesRefreshed++; }
      await supabase.from("products").update({ active: true }).eq("id", productId);
    }
    for (const v of (p.variants ?? [])) {
      const ex = byExtVar.get(v.id) ?? bySku.get(v.sku ?? v.id);
      const attrs = Object.values(v.attributes ?? {});
      const sku = v.sku || v.id;
      const price = parseFloat(v.pricing?.basePrice?.value ?? "0");
      let variantId = ex?.variant_id ?? variantByPO.get(`${productId}:${sku}`) ?? null;
      if (!variantId) {
        const { data: nv } = await supabase.from("variants").insert({ product_id: productId, internal_sku: sku, option1: attrs[0] ?? null, option2: attrs[1] ?? null }).select("id").single();
        variantId = nv?.id ?? null; if (!variantId) continue; variantsCreated++; variantByPO.set(`${productId}:${sku}`, variantId);
        if (!invSet.has(variantId)) { const init = v.stock?.unlimited ? 999 : (v.stock?.quantity ?? 0); await supabase.from("inventory").insert({ variant_id: variantId, product_id: productId, total_stock: init }); invSet.add(variantId); }
      }
      const payload = { variant_id: variantId, channel: "squarespace", channel_sku: sku, channel_price: price, sq_base_price: price, channel_product_id: p.id, channel_variant_id: v.id, last_synced_at: new Date().toISOString() };
      if (ex) { await supabase.from("channel_listings").update(payload).eq("id", ex.id); listingsUpdated++; }
      else { await supabase.from("channel_listings").insert(payload); listingsCreated++; }
    }
  }
  return { total: sqProducts.length, products_created: productsCreated, products_reused: productsReused, variants_created: variantsCreated, listings_created: listingsCreated, listings_updated: listingsUpdated, names_refreshed: namesRefreshed };
}
