// ============================================================
// VOYAGERS HOOK - points-shop (public edge function for the /redeem page)
//
// Actions (POST, body.action):
//   (every action accepts site_user_id from the member cookie; the email is confirmed via Squarespace Profiles)
//   card      { site_user_id }                        -> Hook Club dashboard member card
//   new_in    {}                                      -> 12 newest website products (public, cached 1 hour)
//   list      { email }                              -> member balance + live shop items
//   quote     { email, items:[{variant_id,qty}], postcode } -> postage + totals (all server-side)
//   checkout  { email, items, ship, return_url }     -> reserves stock, takes postage via Revolut
//   status    { email, id }                          -> redemption status (also settles with Revolut)
//   webhook   (Revolut -> us, signature verified)    -> confirms / cancels
//   sweep     (cron every 5 min, service role only)  -> settles with Revolut; cancels if unpaid 30+ min
//   clawback  (cron hourly, service role only)       -> takes points back for refunded / cancelled website orders
//
// Spending rules (points_status in the database): points from an order are held for 30 days, and nothing
// can be spent until the member has one completed purchase (an order past its hold, or imported spend).
//
// Rules: prices, points, stock and postage are always read server-side.
// Points only come off in ps_confirm, after payment has succeeded (or postage is 0).
// Each paid redemption becomes a real Squarespace order (receipt, rights, refunds as normal).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const SQ = "https://api.squarespace.com/1.0";
const REV = "https://merchant.revolut.com/api";
const REV_VER = "2024-09-01";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SERVICE);
const DEFAULT_RETURN = "https://www.voyagershook.com/redeem";

function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
class Fail extends Error { constructor(public code: string, msg: string, public status = 400) { super(msg); } }

// ---------- secrets / settings ----------
let secretCache: { at: number; map: Map<string, string> } | null = null;
async function secrets(): Promise<Map<string, string>> {
  if (secretCache && Date.now() - secretCache.at < 60_000) return secretCache.map;
  const { data } = await db.from("sync_secrets").select("key,value")
    .in("key", ["squarespace_api_key", "squarespace_points_key", "revolut_secret_key", "revolut_webhook_secret", "points_shop_postage", "service_role_key"]);
  const map = new Map((data ?? []).map((r: any) => [r.key, String(r.value ?? "").trim()]));
  secretCache = { at: Date.now(), map };
  return map;
}

// ---------- who is this? ----------
// Squarespace member areas give the page the member's siteUserId (a long random id) in a cookie,
// not always their email. We ask Squarespace's Profiles API for that id's email, so the email is
// confirmed by Squarespace rather than taken from the browser. Email from the browser is only a fallback.
const profileCache = new Map<string, { at: number; email: string | null }>();
async function resolveEmail(body: any): Promise<string> {
  const sid = String(body?.site_user_id || "").trim();
  if (/^[a-f0-9]{24}$/i.test(sid)) {
    const hit = profileCache.get(sid);
    if (hit && Date.now() - hit.at < 10 * 60_000) { if (hit.email) return hit.email; }
    else {
      try {
        const key = (await secrets()).get("squarespace_points_key");
        const r = await fetch(`${SQ}/profiles/${sid}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-PointsShop/1.0" } });
        const d = r.ok ? await r.json() : null;
        const p = d?.profiles?.[0] ?? d;
        const em = p?.email ? String(p.email).toLowerCase() : null;
        profileCache.set(sid, { at: Date.now(), email: em });
        if (em) return em;
        await db.from("sync_log").insert({ sync_type: "points_shop", status: "partial", source: "edge_function", error_message: `profile lookup ${sid}: HTTP ${r.status}` });
      } catch (e) { await db.from("sync_log").insert({ sync_type: "points_shop", status: "partial", source: "edge_function", error_message: `profile lookup ${sid}: ${(e as Error).message}` }); }
    }
  }
  return String(body?.email || "");
}

// ---------- new in: the 12 most recently listed, visible, in-stock website products ----------
let newCache: { at: number; items: any[] } | null = null;
async function newIn(): Promise<any[]> {
  if (newCache && Date.now() - newCache.at < 60 * 60_000) return newCache.items;
  const key = (await secrets()).get("squarespace_api_key");
  const all: any[] = []; let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const r = await fetch(`${SQ}/commerce/products?${cursor ? `cursor=${cursor}` : "type=PHYSICAL"}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-PointsShop/1.0" } });
    if (!r.ok) break;
    const d = await r.json();
    all.push(...(d.products ?? []));
    if (d.pagination?.hasNextPage && d.pagination?.nextPageCursor) cursor = d.pagination.nextPageCursor; else break;
  }
  const items = all
    .filter((p) => p.isVisible !== false && p.url && (p.variants ?? []).some((v: any) => v.stock?.unlimited || (v.stock?.quantity ?? 0) > 0))
    .sort((a, b) => String(b.createdOn).localeCompare(String(a.createdOn)))
    .slice(0, 12)
    .map((p) => {
      const priced = (p.variants ?? []).map((v: any) => {
        const base = parseFloat(v.pricing?.basePrice?.value ?? "0");
        const sale = v.pricing?.onSale ? parseFloat(v.pricing?.salePrice?.value ?? "0") : 0;
        return { price: sale > 0 ? sale : base, was: sale > 0 ? base : null };
      }).filter((x: any) => x.price > 0);
      const cheapest = priced.length ? priced.reduce((a: any, b: any) => (b.price < a.price ? b : a)) : { price: 0, was: null };
      const img = p.images?.[0]?.url ?? "";
      return { name: p.name, url: p.url, image: img ? img + (img.includes("?") ? "&" : "?") + "format=300w" : "",
        price: cheapest.price, was: cheapest.was, from: new Set(priced.map((x: any) => x.price)).size > 1, listed: p.createdOn };
    });
  if (items.length) newCache = { at: Date.now(), items };
  return items;
}

// ---------- member ----------
async function memberByEmail(email: string) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 200 || !e.includes("@")) throw new Fail("NO_EMAIL", "Sign in to use your points.", 401);
  const { data, error } = await db.from("members")
    .select("id,name,email,points_balance,membership_number,tier")
    .or(`email.eq.${e},email_aliases.cs.{${e}}`).limit(1);
  if (error) throw error;
  const m = (data ?? [])[0];
  if (!m) throw new Fail("NOT_MEMBER", "Your login isn't linked to a Hook Club account yet.", 404);
  const st = await pointsStatus(m.id);
  return { ...m, held: st.held, available: st.spendable, status: st };
}
async function pointsStatus(id: string) {
  const { data, error } = await db.rpc("points_status", { p_member: id });
  if (error) throw error;
  return data as { balance: number; held: number; locked: number; qualified: boolean; spendable: number; next_unlock: string | null; first_unlock: string | null };
}
function statusOut(st: any) {
  return { balance: st.balance, spendable: st.spendable, locked: st.locked, held: st.held, qualified: st.qualified, next_unlock: st.next_unlock, first_unlock: st.first_unlock };
}

// ---------- shop items (DB) + live Squarespace details (weight, image, url) ----------
type Item = { variant_id: string; product_id: string; product_name: string; options: string | null; points_value: number; stock: number;
  sq_product_id: string | null; sq_variant_id: string | null; unit_price: number; image_url: string | null; weight_g: number; url: string | null };

let sqCache: { at: number; byId: Map<string, any> } = { at: 0, byId: new Map() };
async function sqProducts(ids: string[]): Promise<Map<string, any>> {
  if (Date.now() - sqCache.at > 10 * 60_000) sqCache = { at: Date.now(), byId: new Map() };
  const need = [...new Set(ids.filter((i) => i && !sqCache.byId.has(i)))];
  if (need.length) {
    const key = (await secrets()).get("squarespace_api_key");
    for (let i = 0; i < need.length; i += 50) {
      const r = await fetch(`${SQ}/commerce/products/${need.slice(i, i + 50).join(",")}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-PointsShop/1.0" } });
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of d.products ?? []) sqCache.byId.set(p.id, p);
    }
  }
  return sqCache.byId;
}

async function shopItems(onlyIds?: string[]): Promise<Item[]> {
  let q = db.from("points_shop_items").select("variant_id, points_value").eq("active", true);
  if (onlyIds) q = q.in("variant_id", onlyIds);
  const { data: psi, error } = await q;
  if (error) throw error;
  const ids = (psi ?? []).map((r: any) => r.variant_id);
  if (!ids.length) return [];
  const [{ data: vars }, { data: inv }, { data: cls }] = await Promise.all([
    db.from("variants").select("id, product_id, option1, option2, products(name, image_url)").in("id", ids),
    db.from("inventory").select("variant_id, total_stock").in("variant_id", ids),
    db.from("channel_listings").select("variant_id, channel_product_id, channel_variant_id, sq_base_price, sq_sale_price, sq_on_sale, channel_price").eq("channel", "squarespace").in("variant_id", ids),
  ]);
  const vById = new Map((vars ?? []).map((v: any) => [v.id, v]));
  const sById = new Map((inv ?? []).map((i: any) => [i.variant_id, i.total_stock ?? 0]));
  const cById = new Map((cls ?? []).map((c: any) => [c.variant_id, c]));
  const sq = await sqProducts([...cById.values()].map((c: any) => c.channel_product_id));
  const out: Item[] = [];
  for (const r of psi ?? []) {
    const v: any = vById.get(r.variant_id); if (!v) continue;
    const c: any = cById.get(r.variant_id) ?? {};
    const p = c.channel_product_id ? sq.get(c.channel_product_id) : null;
    const sv = p ? (p.variants ?? []).find((x: any) => x.id === c.channel_variant_id) : null;
    const w = sv?.shippingMeasurements?.weight;
    const weight_g = w ? Math.round((w.unit === "POUND" ? w.value * 453.592 : w.value * 1000)) : 0;
    const sale = c.sq_on_sale && Number(c.sq_sale_price) > 0 ? Number(c.sq_sale_price) : null;
    const img = sv?.image?.url ?? p?.images?.[0]?.url ?? v.products?.image_url ?? null;
    out.push({
      variant_id: r.variant_id, product_id: v.product_id, product_name: v.products?.name ?? "Item",
      options: [v.option1, v.option2].filter(Boolean).join(" / ") || null,
      points_value: r.points_value, stock: Number(sById.get(r.variant_id) ?? 0),
      sq_product_id: c.channel_product_id ?? null, sq_variant_id: c.channel_variant_id ?? null,
      unit_price: sale ?? Number(c.sq_base_price ?? c.channel_price ?? 0),
      image_url: img ? img + (img.includes("?") ? "&" : "?") + "format=500w" : null,
      weight_g, url: p?.url ?? null,
    });
  }
  return out.sort((a, b) => a.points_value - b.points_value);
}

// ---------- postage (mirrors the website shipping table, settings row: points_shop_postage) ----------
function isRemote(pc: string, cfg: any): boolean {
  const s = pc.toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z]{1,2})(\d{1,2})/); if (!m) return false;
  const area = m[1], district = parseInt(m[2], 10);
  if ((cfg.areas ?? []).includes(area)) return true;
  const rng = cfg.districts?.[area];
  return !!(rng && district >= rng[0] && district <= rng[1]);
}
function band(bands: any[], g: number): number { for (const [max, p] of bands) if (max === null || g <= max) return p; return bands[bands.length - 1][1]; }

async function postage(lines: { it: Item; qty: number }[], postcode: string) {
  const cfg = JSON.parse((await secrets()).get("points_shop_postage") || "{}");
  const freePaths: string[] = cfg.free_store_paths ?? [];
  const isLong = (it: Item) => !!it.url && freePaths.some((p) => new RegExp(`voyagershook\\.com/${p}/`, "i").test(it.url!));
  const value = lines.reduce((a, l) => a + l.it.unit_price * l.qty, 0);
  const normal = lines.filter((l) => !isLong(l.it)), long = lines.filter((l) => isLong(l.it));
  const g = normal.reduce((a, l) => a + l.it.weight_g * l.qty, 0);
  const longQty = long.reduce((a, l) => a + l.qty, 0);
  const remote = postcode ? isRemote(postcode, cfg.remote ?? {}) : false;
  let pounds = 0, method = cfg.method || "Standard Shipping";
  if (remote) {
    if (normal.length) pounds += band(cfg.remote.bands, g);
    if (longQty) pounds += cfg.remote.long_order + cfg.remote.long_each * longQty;
    method = "Standard Shipping (Highlands, Islands & remote)";
  } else if (normal.length) {
    if (cfg.free_over_value && value >= cfg.free_over_value) pounds = 0;
    else if (cfg.small && g <= cfg.small.max_g && value < cfg.small.under_value) { pounds = cfg.small.price; method = cfg.small.method || method; }
    else pounds = band(cfg.bands, g);
  }
  return { pence: Math.round(pounds * 100), method, remote, weight_g: g, value: Math.round(value * 100) / 100 };
}

// ---------- basket validation ----------
async function basket(raw: any): Promise<{ it: Item; qty: number }[]> {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) throw new Fail("EMPTY_BASKET", "Your basket is empty.");
  const want = new Map<string, number>();
  for (const r of raw) {
    const id = String(r?.variant_id || ""); const q = Math.trunc(Number(r?.qty));
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(q >= 1 && q <= 5)) throw new Fail("BAD_ITEM", "Something in your basket isn't right. Please refresh and try again.");
    want.set(id, (want.get(id) ?? 0) + q);
  }
  const items = await shopItems([...want.keys()]);
  const byId = new Map(items.map((i) => [i.variant_id, i]));
  return [...want.entries()].map(([id, qty]) => {
    const it = byId.get(id);
    if (!it) throw new Fail("NOT_IN_SHOP", "One of your items is no longer in the points shop.");
    if (it.stock < qty) throw new Fail("OUT_OF_STOCK", `Sorry, ${it.product_name} has just sold out.`);
    if (qty > 5) throw new Fail("BAD_QTY", "Maximum 5 of each item.");
    return { it, qty };
  });
}

function cleanShip(s: any) {
  const t = (v: any, n: number) => String(v ?? "").trim().slice(0, n);
  const ship = { name: t(s?.name, 80), line1: t(s?.line1, 120), line2: t(s?.line2, 120), city: t(s?.city, 80), county: t(s?.county, 80),
    postcode: t(s?.postcode, 10).toUpperCase(), phone: t(s?.phone, 30) };
  if (!ship.name || !ship.line1 || !ship.city) throw new Fail("BAD_ADDRESS", "Please fill in your name and address.");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/.test(ship.postcode)) throw new Fail("BAD_POSTCODE", "Please check your postcode.");
  return ship;
}

// ---------- stock push (same routine order-sync uses) ----------
async function pushStock(list: { variant_id: string; stock: number }[]) {
  await Promise.all((list ?? []).map(async (s) => {
    try {
      await fetch(`${SB_URL}/functions/v1/push-stock`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
        body: JSON.stringify({ variantId: s.variant_id, stock: s.stock }) });
    } catch (e) { await db.from("sync_log").insert({ sync_type: "points_shop", status: "partial", source: "edge_function", error_message: `push-stock ${s.variant_id}: ${(e as Error).message}` }); }
  }));
}

// ---------- Revolut ----------
async function rev(path: string, method = "GET", body?: unknown) {
  const key = (await secrets()).get("revolut_secret_key");
  const r = await fetch(`${REV}${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Revolut-Api-Version": REV_VER, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let d: any = {}; try { d = JSON.parse(txt); } catch { /* */ }
  if (!r.ok) throw new Error(`Revolut ${r.status}: ${txt.slice(0, 200)}`);
  return d;
}

// ---------- finalise a paid redemption: points off, Squarespace order, SyncStock record ----------
async function finalise(id: string, revOrderId: string | null, revState: string | null) {
  const { data: conf, error } = await db.rpc("ps_confirm", { p_id: id, p_revolut_order_id: revOrderId, p_revolut_state: revState });
  if (error) throw error;
  if (!conf?.ok) {
    // Paid but can't be honoured (cancelled meanwhile / points gone): give the postage back.
    if (revOrderId) {
      try { const o = await rev(`/orders/${revOrderId}`); if (o.state === "completed") await rev(`/orders/${revOrderId}/refund`, "POST", { amount: o.amount, description: "Hook Club points order could not be completed" }); } catch (e) {
        await db.from("sync_log").insert({ sync_type: "points_shop", status: "partial", source: "edge_function", error_message: `refund ${id}: ${(e as Error).message}` }); }
    }
    if (conf?.code === "NOT_ENOUGH_POINTS") { const { data: c } = await db.rpc("ps_cancel", { p_id: id, p_reason: "points no longer available" }); await pushStock(c?.stock ?? []); }
    return conf;
  }
  await createSqOrder(id);
  return conf;
}

async function createSqOrder(id: string) {
  const { data: r } = await db.from("points_redemptions").select("*").eq("id", id).maybeSingle();
  if (!r || r.status !== "paid" || r.sq_order_id) return;
  const key = (await secrets()).get("squarespace_points_key");
  const money = (n: number) => ({ currency: "GBP", value: (Math.round(n * 100) / 100).toFixed(2) });
  const subtotal = (r.items as any[]).reduce((a, x) => a + Number(x.unit_price) * x.qty, 0);
  const postage = r.postage_pence / 100;
  const [first, ...rest] = String(r.ship.name).split(" ");
  const addr = { firstName: first || r.ship.name, lastName: rest.join(" ") || "-", address1: r.ship.line1, address2: r.ship.line2 || null,
    city: r.ship.city, state: r.ship.county || null, countryCode: "GB", postalCode: r.ship.postcode, phone: r.ship.phone || null };
  const body = {
    channelName: "Hook Club Points", externalOrderReference: r.ref,
    createdOn: new Date(r.paid_at ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    customerEmail: r.email, shippingAddress: addr, billingAddress: addr,
    lineItems: (r.items as any[]).map((x) => ({ lineItemType: "PHYSICAL_PRODUCT", variantId: x.sq_variant_id, quantity: x.qty,
      unitPricePaid: money(Number(x.unit_price)), nonSaleUnitPrice: money(Number(x.unit_price)) })),
    discountLines: [{ name: `Hook Points: ${r.points_total.toLocaleString("en-GB")} pts`, amount: money(subtotal) }],
    shippingLines: [{ method: r.postage_method || "Standard Shipping", amount: money(postage) }],
    priceTaxInterpretation: "INCLUSIVE",
    subtotal: money(subtotal), discountTotal: money(subtotal), shippingTotal: money(postage), taxTotal: money(0), grandTotal: money(postage),
    fulfillmentStatus: "PENDING", fulfillments: [],
    inventoryBehavior: "SKIP",                 // stock already handled by SyncStock + push-stock
  };
  try {
    const resp = await fetch(`${SQ}/commerce/orders`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-PointsShop/1.0", "Content-Type": "application/json", "Idempotency-Key": r.sq_error ? `${r.id}-retry-${String(r.sq_error).length}` : r.id }, body: JSON.stringify(body) });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`Squarespace ${resp.status}: ${txt.slice(0, 300)}`);
    const o = JSON.parse(txt);
    // Tell order-sync this order is already handled, and record it in SyncStock at GBP0 item value
    // so it shows in sales but never earns points or counts as spend.
    await db.from("processed_orders").insert((r.items as any[]).map((x) => ({ channel: "squarespace", order_id: `${o.id}::${x.sq_variant_id}` })));
    const { data: vs } = await db.from("variants").select("id, product_id").in("id", (r.items as any[]).map((x) => x.variant_id));
    const pid = new Map((vs ?? []).map((v: any) => [v.id, v.product_id]));
    await db.from("orders").insert((r.items as any[]).map((x) => ({
      platform: "squarespace", platform_order_id: o.id, order_number: o.orderNumber, product_id: pid.get(x.variant_id) ?? null, sku: x.sq_variant_id,
      quantity: x.qty, unit_price: 0, total_price: 0, order_total: postage, currency: "GBP", status: "completed", ordered_at: o.createdOn,
      synced_at: new Date().toISOString(), item_name: `${x.product_name} (Hook Points ${r.ref})`, customer_name: r.ship.name, customer_email: r.email,
      shipping_address_line1: r.ship.line1, shipping_address_line2: r.ship.line2 || null, shipping_city: r.ship.city, shipping_county: r.ship.county || null,
      shipping_postcode: r.ship.postcode, shipping_country: "GB", fulfillment_status: "PENDING" })));
    await db.from("points_redemptions").update({ sq_order_id: o.id, sq_order_number: o.orderNumber, sq_error: null }).eq("id", id);
  } catch (e) {
    await db.from("points_redemptions").update({ sq_error: (e as Error).message.slice(0, 500) }).eq("id", id);
    await db.from("sync_log").insert({ sync_type: "points_shop", status: "partial", source: "edge_function", error_message: `sq order ${r.ref}: ${(e as Error).message}` });
  }
}

async function cancelRedemption(id: string, reason: string, revOrderId?: string | null) {
  if (revOrderId) { try { await rev(`/orders/${revOrderId}/cancel`, "POST", {}); } catch { /* already gone */ } }
  const { data: c, error } = await db.rpc("ps_cancel", { p_id: id, p_reason: reason });
  if (error) throw error;
  if (!c?.already) await pushStock(c?.stock ?? []);
  return c;
}

// Ask Revolut where a pending redemption stands, and settle it.
async function settle(r: any) {
  if (r.status !== "pending" || !r.revolut_order_id) return r.status;
  const o = await rev(`/orders/${r.revolut_order_id}`);
  if (o.state === "completed") { await finalise(r.id, r.revolut_order_id, o.state); return "paid"; }
  if (o.state === "cancelled" || o.state === "failed") { await cancelRedemption(r.id, `revolut ${o.state}`); return "cancelled"; }
  return "pending";
}

// ---------- webhook signature ----------
async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const raw = await req.text();

  // Revolut webhook (identified by its signature header)
  const revSig = req.headers.get("revolut-signature");
  if (revSig) {
    try {
      const ts = req.headers.get("revolut-request-timestamp") ?? "";
      const secret = (await secrets()).get("revolut_webhook_secret");
      if (!secret) return json({ error: "not configured" }, 500);
      if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return json({ error: "stale" }, 401);
      const expect = "v1=" + (await hmacHex(secret, `v1.${ts}.${raw}`));
      if (!revSig.split(",").map((s) => s.trim()).includes(expect)) return json({ error: "bad signature" }, 401);
      const ev = JSON.parse(raw);
      const { data: r } = await db.from("points_redemptions").select("*").eq("revolut_order_id", ev.order_id).maybeSingle();
      if (!r) return json({ ok: true, ignored: true });
      if (ev.event === "ORDER_COMPLETED") await finalise(r.id, ev.order_id, "completed");
      else if (ev.event === "ORDER_CANCELLED") await cancelRedemption(r.id, "revolut cancelled");
      return json({ ok: true });
    } catch (e) {
      await db.from("sync_log").insert({ sync_type: "points_shop", status: "failed", source: "edge_function", error_message: `webhook: ${(e as Error).message}` });
      return json({ ok: false }, 500);   // Revolut retries; everything is idempotent
    }
  }

  let body: any = {}; try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "bad json" }, 400); }
  try {
    if (body.action === "new_in") return json({ ok: true, items: await newIn() });   // public, no member needed
    if (body.action !== "sweep" && body.action !== "clawback") body.email = await resolveEmail(body);
    switch (body.action) {
      case "card": {   // Hook Club dashboard (same shape as members-admin member_card)
        const e = String(body.email || "").trim().toLowerCase();
        if (!e.includes("@")) return json({ ok: true, found: false, member: null });
        const { data } = await db.from("members")
          .select("id,name,email,membership_number,tier,spend_12m,spend_tier,points_balance,lifetime_spend,discount_code,discount_used")
          .or(`email.eq.${e},email_aliases.cs.{${e}}`).limit(1);
        const m = (data ?? [])[0];
        if (!m) return json({ ok: true, found: false, member: null, email: e });
        const { count } = await db.from("points_ledger").select("id", { count: "exact", head: true }).eq("member_id", m.id).eq("reason", "order");
        const { id: _id, ...pub } = m;
        const st = await pointsStatus(m.id);
        return json({ ok: true, found: true, member: { ...pub, orders_completed: count ?? 0, points: statusOut(st) } });
      }
      case "list": {
        const m = await memberByEmail(body.email);
        const items = await shopItems();
        return json({ ok: true, member: { name: m.name, points_balance: m.points_balance, available: m.available, held: m.held, ...statusOut(m.status) },
          items: items.filter((i) => i.stock > 0).map((i) => ({ variant_id: i.variant_id, product_name: i.product_name, options: i.options,
            points_value: i.points_value, stock: i.stock, image_url: i.image_url, url: i.url })) });
      }
      case "quote": {
        const m = await memberByEmail(body.email);
        const lines = await basket(body.items);
        const points = lines.reduce((a, l) => a + l.it.points_value * l.qty, 0);
        const post = await postage(lines, String(body.postcode || ""));
        return json({ ok: true, points_total: points, available: m.available, qualified: m.status.qualified, affordable: m.status.qualified && m.available >= points,
          postage_pence: post.pence, postage_method: post.method, remote: post.remote, postcode_needed: !body.postcode });
      }
      case "checkout": {
        const m = await memberByEmail(body.email);
        if (!m.status.qualified) throw new Fail("NO_FIRST_ORDER", "Your points unlock 30 days after your first order. Thanks for your patience.");
        const ship = cleanShip(body.ship);
        const lines = await basket(body.items);
        const post = await postage(lines, ship.postcode);
        const { data: res, error } = await db.rpc("ps_reserve", {
          p_member: m.id, p_email: m.email, p_ship: ship, p_postage_pence: post.pence, p_postage_method: post.method,
          p_items: lines.map((l) => ({ variant_id: l.it.variant_id, qty: l.qty, sq_product_id: l.it.sq_product_id, sq_variant_id: l.it.sq_variant_id, unit_price: l.it.unit_price, weight_g: l.it.weight_g })),
        });
        if (error) {
          const code = String(error.message || "").split(":")[0];
          const msg: Record<string, string> = { NOT_ENOUGH_POINTS: "You don't have enough points ready to spend for this basket.", NO_FIRST_ORDER: "Your points unlock 30 days after your first order.", OUT_OF_STOCK: "Sorry, something in your basket has just sold out.",
            NOT_IN_SHOP: "One of your items is no longer in the points shop.", TOO_MANY_PENDING: "You have unfinished checkouts. Please wait 30 minutes or complete them first." };
          throw new Fail(code, msg[code] ?? "We couldn't start your checkout. Please try again.");
        }
        await pushStock(res.stock);
        if (post.pence === 0) {
          await finalise(res.id, null, "no_postage");
          return json({ ok: true, id: res.id, ref: res.ref, done: true });
        }
        let ret = DEFAULT_RETURN;
        try { const u = new URL(String(body.return_url || "")); if (/(^|\.)voyagershook\.com$/.test(u.hostname)) ret = u.origin + u.pathname; } catch { /* default */ }
        try {
          const o = await rev("/orders", "POST", { amount: post.pence, currency: "GBP", description: `Hook Club points order ${res.ref} - postage`,
            customer: { email: m.email }, merchant_order_data: { reference: res.ref }, redirect_url: `${ret}?ps=${res.id}` });
          await db.from("points_redemptions").update({ revolut_order_id: o.id, revolut_state: o.state }).eq("id", res.id);
          return json({ ok: true, id: res.id, ref: res.ref, checkout_url: o.checkout_url, postage_pence: post.pence });
        } catch (e) {
          await cancelRedemption(res.id, "revolut order failed");
          await db.from("sync_log").insert({ sync_type: "points_shop", status: "failed", source: "edge_function", error_message: `revolut create ${res.ref}: ${(e as Error).message}` });
          throw new Fail("PAYMENT_UNAVAILABLE", "Card payment isn't available right now. Nothing has been taken. Please try again later.", 502);
        }
      }
      case "status": {
        const m = await memberByEmail(body.email);
        const { data: r } = await db.from("points_redemptions").select("*").eq("id", String(body.id || "")).eq("member_id", m.id).maybeSingle();
        if (!r) throw new Fail("NOT_FOUND", "We couldn't find that order.", 404);
        let status = r.status;
        if (status === "pending" && r.revolut_order_id) status = await settle(r);
        if (status === "paid" && !r.sq_order_id) await createSqOrder(r.id);
        const { data: f } = await db.from("points_redemptions").select("ref,status,points_total,postage_pence,postage_method,items,ship,sq_order_number,created_at").eq("id", r.id).maybeSingle();
        const { data: mm } = await db.from("members").select("points_balance").eq("id", m.id).maybeSingle();
        return json({ ok: true, ...f, items: (f?.items ?? []).map((x: any) => ({ product_name: x.product_name, options: x.options, qty: x.qty, points: x.points })),
          balance: mm?.points_balance ?? null });
      }
      case "cancel": {   // member backs out of the Revolut page
        const m = await memberByEmail(body.email);
        const { data: r } = await db.from("points_redemptions").select("*").eq("id", String(body.id || "")).eq("member_id", m.id).maybeSingle();
        if (!r) throw new Fail("NOT_FOUND", "We couldn't find that order.", 404);
        const st = await settle(r);          // never cancel something Revolut says is paid
        if (st === "pending") await cancelRedemption(r.id, "member cancelled", r.revolut_order_id);
        return json({ ok: true, status: st === "pending" ? "cancelled" : st });
      }
      case "sweep": {
        const auth = req.headers.get("authorization") || "", sk = (await secrets()).get("service_role_key");
        if (auth !== `Bearer ${SERVICE}` && !(sk && auth === `Bearer ${sk}`)) return json({ error: "forbidden" }, 403);
        // Settle anything unpaid for 3+ minutes by asking Revolut (works with or without a webhook);
        // only cancel once a checkout has sat unpaid for 30 minutes.
        const { data: stale } = await db.from("points_redemptions").select("*").eq("status", "pending").lt("created_at", new Date(Date.now() - 3 * 60_000).toISOString());
        const done: any[] = [];
        for (const r of stale ?? []) {
          try {
            const st = r.revolut_order_id ? await settle(r) : "pending";
            const old = Date.now() - new Date(r.created_at).getTime() > 30 * 60_000;
            if (st === "pending" && old) { await cancelRedemption(r.id, "timed out", r.revolut_order_id); done.push({ ref: r.ref, result: "cancelled" }); }
            else done.push({ ref: r.ref, result: st });
          } catch (e) { done.push({ ref: r.ref, error: (e as Error).message }); }
        }
        // retry any paid redemption whose Squarespace order didn't get created
        const { data: orphan } = await db.from("points_redemptions").select("id").eq("status", "paid").is("sq_order_id", null).limit(20);
        for (const o of orphan ?? []) await createSqOrder(o.id);
        return json({ ok: true, swept: done, retried: (orphan ?? []).length });
      }
      case "clawback": {
        const auth = req.headers.get("authorization") || "", sk = (await secrets()).get("service_role_key");
        if (auth !== `Bearer ${SERVICE}` && !(sk && auth === `Bearer ${sk}`)) return json({ error: "forbidden" }, 403);
        // Re-read every website order that earned points in the last 120 days and take points back for any
        // refund or cancellation. points_clawback only ever removes the difference, so re-running is safe.
        const since = new Date(Date.now() - 120 * 86400_000).toISOString();
        const { data: rows } = await db.from("points_ledger").select("ref").eq("reason", "order").gte("created_at", since).limit(500);
        const key = (await secrets()).get("squarespace_points_key");
        const out: any[] = []; let checked = 0;
        for (const r of rows ?? []) {
          const oid = String(r.ref).replace(/^order:/, "");
          if (!/^[a-f0-9]{24}$/i.test(oid)) continue;
          try {
            const resp = await fetch(`${SQ}/commerce/orders/${oid}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "VoyagersHook-PointsShop/1.0" } });
            if (resp.status === 429) { await new Promise((z) => setTimeout(z, 2000)); continue; }
            if (!resp.ok) { out.push({ oid, error: `HTTP ${resp.status}` }); continue; }
            const o = await resp.json(); checked++;
            const pence = (m: any) => Math.round(parseFloat(m?.value ?? "0") * 100);
            const refunded = pence(o.refundedTotal), total = pence(o.grandTotal), cancelled = o.fulfillmentStatus === "CANCELED";
            if (!cancelled && refunded <= 0) continue;
            const { data: c, error } = await db.rpc("points_clawback", { p_order_id: oid, p_order_total_pence: total, p_refunded_pence: refunded, p_cancelled: cancelled });
            if (error) throw error;
            if (c?.taken) out.push({ order: o.orderNumber, taken: c.taken, cancelled, refunded });
          } catch (e) { out.push({ oid, error: (e as Error).message }); }
        }
        if (out.some((x) => x.error)) await db.from("sync_log").insert({ sync_type: "points_shop", status: "partial", source: "edge_function", error_message: `clawback: ${JSON.stringify(out.filter((x) => x.error)).slice(0, 500)}` });
        return json({ ok: true, checked, results: out });
      }
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof Fail) return json({ ok: false, code: e.code, error: e.message }, e.status);
    await db.from("sync_log").insert({ sync_type: "points_shop", status: "failed", source: "edge_function", error_message: `${body.action}: ${(e as Error).message}` });
    return json({ ok: false, code: "SERVER", error: "Something went wrong. Nothing has been taken. Please try again." }, 500);
  }
});
