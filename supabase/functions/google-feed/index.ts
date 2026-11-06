// ============================================================
// VOYAGERS HOOK - google-feed
// Public, read-only product feed for Google Merchant Center.
// Pulls live products from Squarespace (so price and stock always
// match the website) and adds brand / EAN from the additive table
// google_feed_attributes. Never writes to any table.
//
//   GET /google-feed              -> tab-separated feed for Merchant Center
//   GET /google-feed?report=1     -> JSON: what was left out and why, brand counts
//
// Rules that keep Merchant Center happy:
//  - brand is the real manufacturer, never the shop name (except own-brand items)
//  - products with no recognised brand are LEFT OUT (listed in the report)
//  - EAN (gtin) and MPN are only sent once gtin_verified = true
//  - sale_price is only sent when the website shows the item on sale
//  - donations / sponsorships are never sent
//  - every id is unique; generic SKUs like "Medium" use the Squarespace variant id
// Deploy with verify_jwt = false (public, read-only feed).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SQ = "https://api.squarespace.com/1.0";
const SITE = "https://www.voyagershook.com";
const CACHE_MS = 10 * 60 * 1000;

// Never send these to Google (not products a shopper buys for themselves).
const NEVER = /little\s*voyagers|sponsorship|donation|gift\s*card|voucher/i;

// Brand detection from the product name. First match wins, so keep specific names first.
const BRANDS: [string, RegExp][] = [
  ["Voyagers Hook", /voyagers?\s*hook/i],
  ["West Country Leads", /west\s*country\s*leads?/i],
  ["Crafty Catcher", /crafty\s*catcher/i],
  ["Filthy Bait Co", /filthy\s*bait/i],
  ["Peg No1", /peg\s*no\.?\s*1|pegno\.?1/i],
  ["Thomas & Thomas", /thomas\s*(&|and)\s*thomas/i],
  ["Shamrock Tackle", /shamrock\s*tackle/i],
  ["Easy Camp", /easy\s*camp/i],
  ["Mikado", /\bmikado\b|^\s*jaws\b/i],
  ["Maver", /\bmaver\b|\bmv-?r/i],
  ["Wychwood", /\bwychwood\b/i],
  ["Leeda", /\bleeda\b/i],
  ["MAP", /^\s*map\b/i],
  ["Mustad", /\bmustad\b/i],
  ["Fjuka", /\bfjuka\b/i],
  ["SPRO", /\bspro\b/i],
  ["Copdock", /\bcopdock\b|pigeon\s*conditioning/i],
  ["Kamasan", /\bkamasan\b/i],
  ["NGT", /\bngt\b/i],
  ["Saber", /^\s*saber\b/i],
  ["Antonini", /\bantonini\b/i],
  ["Oakwood", /^\s*oakwood\b/i],
  ["Shakespeare", /\bshakespeare\b/i],
  ["Soto", /\bsoto\b/i],
  ["Cling", /^\s*cling\b/i],
  ["Dinsmores", /\bdinsmores?\b/i],
  ["Zebco", /\bzebco\b/i],
  ["Nextool", /\bnextool\b/i],
  ["Wildo", /\bwildo\b/i],
  ["Castaway", /^\s*castaway\b/i],
  ["Rapture", /^\s*rapture\b/i],
  ["Ringers", /\bringers?\b/i],
  ["Madison", /\bmadison\b/i],
  ["Kodex", /\bkodex\b/i],
  ["Fladen", /\bfladen\b/i],
  ["Outwell", /\boutwell\b/i],
  ["Gamakatsu", /\bgamakatsu\b/i],
  ["Sonik", /\bsonik\b/i],
  ["Coppens", /\bcoppens\b/i],
  ["Robens", /\brobens\b/i],
  ["SOG", /^\s*sog\b/i],
  ["Finntrail", /\bfinntrail\b/i],
  ["Maxpedition", /\bmaxpedition\b/i],
  ["KAI", /^\s*kai\b/i],
  ["Baylys", /\bbaylys?\b/i],
  ["Korda", /\bkorda\b/i],
  ["Nash", /\bnash\b/i],
  ["Drennan", /\bdrennan\b/i],
  ["Preston Innovations", /\bpreston\b/i],
  ["Daiwa", /\bdaiwa\b/i],
  ["Shimano", /\bshimano\b/i],
  ["Savage Gear", /savage\s*gear/i],
  ["Westin", /\bwestin\b/i],
  ["Colter", /\bcolter\b/i],
  ["Douglas", /^\s*douglas\b/i],
  ["Shilton", /\bshilton\b/i],
];

const LONG = /\b(rods?|poles?|whip|net handle|landing net handle)\b/i;
const NOT_LONG = /(rod rest|rod pod|rod bag|rod holder|rod clip|rod band|rod strap|rod sleeve|buzz bar|bank stick|rod tube|rod lock)/i;

let cache: { at: number; tsv: string; report: string } | null = null;

const clean = (s: unknown) => String(s ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
const stripHtml = (h: string) =>
  clean(String(h ?? "").replace(/<br\s*\/?>(\s*)/gi, " ").replace(/<\/(p|li|h\d|div)>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ndash;|&mdash;/g, "-").replace(/&[a-z]+;/gi, " "));
const abs = (u: string) => (!u ? "" : u.startsWith("http") ? u : SITE + (u.startsWith("/") ? u : "/" + u));

function brandOf(name: string): string | null {
  for (const [b, re] of BRANDS) if (re.test(name)) return b;
  return null;
}

function kg(w: any): number | null {
  const v = parseFloat(w?.value ?? "");
  if (!isFinite(v) || v <= 0) return null;
  const u = String(w?.unit ?? "").toUpperCase();
  if (u.startsWith("POUND") || u === "LB") return v * 0.453592;
  if (u.startsWith("OUNCE") || u === "OZ") return v * 0.0283495;
  if (u.startsWith("GRAM") || u === "G") return v / 1000;
  return v; // KILOGRAM
}

async function build() {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: k } = await sb.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const key = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
  if (!key) throw new Error("Squarespace API key not set");

  const { data: attrRows } = await sb.from("google_feed_attributes").select("sku, brand, gtin, gtin_verified, mpn, exclude");
  const attrs = new Map<string, any>((attrRows ?? []).map((r: any) => [String(r.sku).trim(), r]));

  const products: any[] = [];
  let cursor = "";
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${SQ}/commerce/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-GoogleFeed/1.0" },
    });
    if (!r.ok) throw new Error(`Squarespace ${r.status}`);
    const d = await r.json();
    products.push(...(d.products ?? []));
    if (!d.pagination?.hasNextPage) break;
    cursor = d.pagination.nextPageCursor;
  }

  const cols = ["id", "item_group_id", "title", "description", "link", "image_link", "additional_image_link", "availability",
    "price", "sale_price", "brand", "gtin", "mpn", "condition", "google_product_category", "product_type",
    "shipping_weight", "shipping_label"];
  const lines = [cols.join("\t")];
  const excluded: any[] = [];
  const gtinPending: string[] = [];
  const brandCounts: Record<string, number> = {};
  const brandExamples: Record<string, string[]> = {};
  const seenIds = new Set<string>();
  let included = 0, onSaleCount = 0, noWeight = 0;

  for (const p of products) {
    const name = clean(p.name);
    if (p.type && p.type !== "PHYSICAL") { excluded.push({ name, reason: `not a physical product (${p.type})` }); continue; }
    if (p.isVisible === false) { excluded.push({ name, reason: "hidden on website" }); continue; }
    if (NEVER.test(name)) { excluded.push({ name, reason: "donation / voucher, not sent to Google" }); continue; }
    if (!p.url) { excluded.push({ name, reason: "no product page URL" }); continue; }
    const images = (p.images ?? []).map((im: any) => im?.url).filter(Boolean);
    if (!images.length) { excluded.push({ name, reason: "no image" }); continue; }
    const vs = p.variants ?? [];
    const multi = vs.length > 1;
    const desc = (stripHtml(p.description ?? "") || name).slice(0, 4900);
    const path = String(p.url).replace(/^https?:\/\/[^/]+/, "").split("/").filter(Boolean);
    const productType = path.length > 1 ? path[0].replace(/-\d+$/, "").replace(/-/g, " ") : "";

    for (const v of vs) {
      const rawSku = clean(v.sku);
      const generic = !rawSku || /^[A-Za-z][A-Za-z \-]*$/.test(rawSku) || seenIds.has(rawSku);
      const sku = generic ? `VH-${clean(v.id)}` : rawSku;
      seenIds.add(sku);
      const a = attrs.get(rawSku) ?? attrs.get(sku);
      const optText = Object.values(v.attributes ?? {}).map((x) => clean(x)).filter(Boolean).join(" / ");
      const label = multi && optText ? `${name} (${optText})` : name;
      if (a?.exclude) { excluded.push({ sku, name: label, reason: "excluded in google_feed_attributes" }); continue; }
      const brand = clean(a?.brand) || brandOf(name);
      if (!brand) { excluded.push({ sku, name: label, reason: "brand not recognised - add it to google_feed_attributes" }); continue; }
      const base = parseFloat(v.pricing?.basePrice?.value ?? "0");
      const cur = v.pricing?.basePrice?.currency ?? "GBP";
      if (!(base > 0)) { excluded.push({ sku, name: label, reason: "no price" }); continue; }
      const onSale = !!v.pricing?.onSale;
      const sale = onSale ? parseFloat(v.pricing?.salePrice?.value ?? "0") : 0;
      const inStock = !!(v.stock?.unlimited || (v.stock?.quantity ?? 0) > 0);
      const w = kg(v.shippingMeasurements?.weight);
      if (w === null) noWeight++;
      const labels: string[] = [];
      if (LONG.test(name) && !NOT_LONG.test(name)) labels.push("long_item");
      if (w !== null && w >= 15) labels.push("heavy_item");
      let gtin = "", mpn = "";
      if (a?.gtin && a.gtin_verified) { gtin = clean(a.gtin); mpn = clean(a.mpn); }
      else if (a?.gtin) gtinPending.push(sku);
      const salePrice = sale > 0 && sale < base ? `${sale.toFixed(2)} ${cur}` : "";
      if (salePrice) onSaleCount++;
      brandCounts[brand] = (brandCounts[brand] ?? 0) + 1;
      (brandExamples[brand] ??= []).length < 2 && brandExamples[brand].push(name.slice(0, 60));
      const row = [
        sku.slice(0, 50),
        multi ? clean(p.id) : "",
        label.slice(0, 150),
        desc,
        abs(p.url),
        images[0],
        images.slice(1, 10).join(","),
        inStock ? "in_stock" : "out_of_stock",
        `${base.toFixed(2)} ${cur}`,
        salePrice,
        brand,
        gtin,
        mpn,
        "new",
        "3334",
        clean(productType),
        w !== null ? `${w.toFixed(3)} kg` : "",
        labels.join(","),
      ];
      lines.push(row.map(clean).join("\t"));
      included++;
    }
  }
  const report = JSON.stringify({
    updated: new Date().toISOString(),
    included,
    on_sale: onSaleCount,
    missing_weight: noWeight,
    excluded_count: excluded.length,
    gtin_waiting_for_check: gtinPending.length,
    brands: brandCounts,
    brand_examples: brandExamples,
    excluded,
  }, null, 2);
  return { tsv: lines.join("\n") + "\n", report };
}

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    if (!cache || Date.now() - cache.at > CACHE_MS || u.searchParams.get("fresh") === "1") {
      const b = await build();
      cache = { at: Date.now(), ...b };
    }
    if (u.searchParams.get("report")) {
      return new Response(cache.report, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    return new Response(cache.tsv, {
      headers: { "Content-Type": "text/tab-separated-values; charset=utf-8", "Cache-Control": "public, max-age=600" },
    });
  } catch (e) {
    return new Response(`error: ${(e as Error).message}`, { status: 500 });
  }
});
