import { supabase } from "@/integrations/supabase/client";

// Bundles hold no stock of their own: their stock is worked out from the items they are
// made of (see push-stock). These helpers keep the app from setting a bundle's stock by hand
// and put a returned bundle's items back into stock.

export interface BundleItem {
  variantId: string;
  qty: number;
  label: string; // kept so drafts show the item names without a lookup
}

export interface ItemInfo {
  variantId: string;
  label: string;
  stock: number;
  cost: number | null;
  price: number; // website price, else eBay price
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export async function bundleComponents(variantId: string): Promise<{ component_variant_id: string; quantity: number }[]> {
  const { data } = await db.from("bundle_components").select("component_variant_id, quantity").eq("bundle_variant_id", variantId);
  return data ?? [];
}

export async function assertNotBundle(variantId: string) {
  const comps = await bundleComponents(variantId);
  if (comps.length) {
    throw new Error("This is a bundle, so its stock is worked out from the items in it. Change the stock of those items instead.");
  }
}

// Returned bundle: add each item back (quantity x items returned) and push it, which also
// updates every bundle that uses it. Returns false if the variant isn't a bundle.
export async function restockBundle(variantId: string, qtyReturned: number, note: string, reason: string): Promise<boolean> {
  const comps = await bundleComponents(variantId);
  if (!comps.length) return false;
  const pushes: { variantId: string; stock: number }[] = [];
  for (const c of comps) {
    const { data: inv } = await supabase.from("inventory").select("id, total_stock, product_id").eq("variant_id", c.component_variant_id).maybeSingle();
    if (!inv) continue;
    const oldS = inv.total_stock ?? 0;
    const newS = oldS + qtyReturned * Math.max(1, c.quantity);
    await supabase.from("inventory").update({ total_stock: newS, updated_at: new Date().toISOString() }).eq("id", inv.id);
    await db.from("stock_log").insert({
      variant_id: c.component_variant_id, product_id: inv.product_id, old_stock: oldS, new_stock: newS,
      delta: newS - oldS, source: "return", reason, note: `Part of a returned bundle. ${note}`,
    });
    pushes.push({ variantId: c.component_variant_id, stock: newS });
  }
  for (const x of pushes) await supabase.functions.invoke("push-stock", { body: x });
  return true;
}

// Stock, cost and price for a set of items, read straight from SyncStock.
export async function fetchItemInfo(ids: string[]): Promise<Map<string, ItemInfo>> {
  const out = new Map<string, ItemInfo>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const [{ data: vs }, { data: inv }, { data: cls }] = await Promise.all([
    db.from("variants").select("id, option1, cost_price, products(name, cost_price)").in("id", uniq),
    db.from("inventory").select("variant_id, total_stock").in("variant_id", uniq),
    db.from("channel_listings").select("variant_id, channel, channel_price, sq_base_price").in("variant_id", uniq),
  ]);
  const stock = new Map<string, number>((inv ?? []).map((i: { variant_id: string; total_stock: number | null }) => [i.variant_id, Math.max(0, i.total_stock ?? 0)]));
  for (const v of vs ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ls = (cls ?? []).filter((l: any) => l.variant_id === v.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const web = ls.find((l: any) => l.channel === "squarespace");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eb = ls.find((l: any) => l.channel === "ebay");
    out.set(v.id, {
      variantId: v.id,
      label: [v.products?.name, v.option1].filter(Boolean).join(" - "),
      stock: stock.get(v.id) ?? 0,
      cost: v.cost_price ?? v.products?.cost_price ?? null,
      price: Number(web?.sq_base_price ?? web?.channel_price ?? eb?.channel_price ?? 0),
    });
  }
  return out;
}

export interface BundleTotals { stock: number; cost: number; costKnown: boolean; rrp: number }

export function totalsFor(items: BundleItem[], info: Map<string, ItemInfo> | undefined): BundleTotals {
  let stock = Infinity, cost = 0, rrp = 0, costKnown = true;
  for (const it of items) {
    const i = info?.get(it.variantId);
    const q = Math.max(1, Math.floor(it.qty || 1));
    stock = Math.min(stock, i ? Math.floor(i.stock / q) : 0);
    if (i?.cost == null) costKnown = false; else cost += i.cost * q;
    rrp += (i?.price ?? 0) * q;
  }
  return { stock: items.length && Number.isFinite(stock) ? stock : 0, cost: Math.round(cost * 100) / 100, costKnown, rrp: Math.round(rrp * 100) / 100 };
}

// Search normal (non-bundle) items by name or SKU, one row per option.
export async function searchItems(q: string): Promise<ItemInfo[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_]/g, "")}%`;
  const [{ data: byName }, { data: bySku }] = await Promise.all([
    db.from("products").select("id").ilike("name", like).eq("is_bundle", false).eq("active", true).limit(40),
    db.from("variants").select("id, product_id").ilike("internal_sku", like).limit(20),
  ]);
  const productIds = new Set<string>((byName ?? []).map((p: { id: string }) => p.id));
  const extraVariants = new Set<string>((bySku ?? []).map((v: { id: string }) => v.id));
  const { data: vs } = productIds.size
    ? await db.from("variants").select("id").in("product_id", [...productIds]).limit(200)
    : { data: [] };
  const ids = [...new Set([...(vs ?? []).map((v: { id: string }) => v.id), ...extraVariants])];
  const info = await fetchItemInfo(ids);
  // Leave out anything that is itself a bundle (found by SKU).
  const { data: bundleRows } = ids.length ? await db.from("bundle_components").select("bundle_variant_id").in("bundle_variant_id", ids) : { data: [] };
  const bundles = new Set((bundleRows ?? []).map((r: { bundle_variant_id: string }) => r.bundle_variant_id));
  return [...info.values()].filter((i) => !bundles.has(i.variantId)).sort((a, b) => a.label.localeCompare(b.label)).slice(0, 60);
}
