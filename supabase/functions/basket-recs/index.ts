// ============================================================
// VOYAGERS HOOK — basket-recs
// Public, read-only. Returns best-selling, in-stock Squarespace
// products grouped by fishing style, for the cart page widget.
// Only public product info is returned (name, url, image, price).
// No order or customer data ever leaves the database.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SQ = "https://api.squarespace.com/1.0";
const DAYS = 120;          // sales window
const POOL = 80;           // top sellers to consider
const PER_STYLE = 8;       // items returned per style
const CACHE_MS = 60 * 60 * 1000;

export const STYLES: Record<string, string[]> = {
  lrf:    ["lrf", "ultralight", "ultra light", "light rock"],
  lure:   ["lure", "spinning", "spinner", "jig", "dropshot", "drop shot", "cheb", "pike", "perch", "predator", "trace", "twister", "shad", "spoon", "snap"],
  feeder: ["feeder", "method", "match", "pole", "whip", "groundbait", "ground bait", "pellet", "bander", "expander"],
  carp:   ["carp", "boilie", "pop up", "pop-up", "pop ups", "pva", "bivvy", "brolly", "bite alarm", "baitrunner", "bait runner", "free runner", "bed chair", "bedchair", "zig"],
  float:  ["float", "waggler", "stick float"],
};

function stylesFor(name: string): string[] {
  const n = name.toLowerCase();
  return Object.keys(STYLES).filter((s) => STYLES[s].some((k) => n.includes(k)));
}

let cache: { at: number; body: string } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), body: JSON.stringify(await build()) };
    return new Response(cache.body, {
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message, general: [] }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

async function build() {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: k } = await sb.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const key = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
  if (!key) throw new Error("Squarespace API key not set");

  // 1. Units sold per product over the window (both channels)
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const units = new Map<string, number>();
  let from = 0;
  while (true) {
    const { data, error } = await sb.from("orders").select("product_id, quantity, status")
      .gte("ordered_at", since).not("product_id", "is", null).range(from, from + 999);
    if (error) throw error;
    for (const o of data ?? []) {
      if ((o.status ?? "").toLowerCase().includes("cancel")) continue;
      units.set(o.product_id, (units.get(o.product_id) ?? 0) + (o.quantity ?? 1));
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  const ranked = [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, POOL);
  if (!ranked.length) return { updated: new Date().toISOString(), general: [] };

  // 2. Map product -> Squarespace product id
  const pids = ranked.map(([id]) => id);
  const { data: vars } = await sb.from("variants").select("id, product_id").in("product_id", pids);
  const vToP = new Map((vars ?? []).map((v) => [v.id, v.product_id]));
  const { data: cls } = await sb.from("channel_listings").select("variant_id, channel_product_id")
    .eq("channel", "squarespace").in("variant_id", [...vToP.keys()]);
  const pToSq = new Map<string, string>();
  for (const c of cls ?? []) {
    const p = vToP.get(c.variant_id);
    if (p && c.channel_product_id && !pToSq.has(p)) pToSq.set(p, c.channel_product_id);
  }

  // 3. Live details from Squarespace (url, image, price, stock, visibility)
  const sqIds = [...new Set(ranked.map(([p]) => pToSq.get(p)).filter(Boolean))] as string[];
  const sqById = new Map<string, any>();
  for (let i = 0; i < sqIds.length; i += 50) {
    const r = await fetch(`${SQ}/commerce/products/${sqIds.slice(i, i + 50).join(",")}`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-BasketRecs/1.0" },
    });
    if (!r.ok) continue;
    const d = await r.json();
    for (const p of d.products ?? []) sqById.set(p.id, p);
  }

  // 4. Build the list in best-seller order
  const items: any[] = [];
  const seen = new Set<string>();
  for (const [pid] of ranked) {
    const sqId = pToSq.get(pid); if (!sqId || seen.has(sqId)) continue;
    const p = sqById.get(sqId); if (!p || p.isVisible === false || !p.url) continue;
    const vs = p.variants ?? [];
    const inStock = vs.some((v: any) => v.stock?.unlimited || (v.stock?.quantity ?? 0) > 0);
    if (!inStock) continue;
    const priced = vs.map((v: any) => {
      const base = parseFloat(v.pricing?.basePrice?.value ?? "0");
      const sale = v.pricing?.onSale ? parseFloat(v.pricing?.salePrice?.value ?? "0") : null;
      return { price: sale && sale > 0 ? sale : base, was: sale && sale > 0 ? base : null };
    }).filter((x: any) => x.price > 0);
    if (!priced.length) continue;
    const cheapest = priced.reduce((a: any, b: any) => (b.price < a.price ? b : a));
    const img = p.images?.[0]?.url ?? "";
    seen.add(sqId);
    items.push({
      name: p.name,
      url: p.url,
      image: img ? img + (img.includes("?") ? "&" : "?") + "format=300w" : "",
      price: cheapest.price,
      was: cheapest.was,
      from: new Set(priced.map((x: any) => x.price)).size > 1,
      styles: stylesFor(p.name),
    });
  }

  const out: Record<string, any> = { updated: new Date().toISOString(), general: items.slice(0, PER_STYLE).map(strip) };
  for (const s of Object.keys(STYLES)) out[s] = items.filter((i) => i.styles.includes(s)).slice(0, PER_STYLE).map(strip);
  return out;
}

function strip(i: any) {
  return { name: i.name, url: i.url, image: i.image, price: i.price, was: i.was, from: i.from };
}
