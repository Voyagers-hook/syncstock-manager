import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Create listing backend: one form in SyncStock lists a product on eBay and/or Squarespace
// and saves it in SyncStock as ONE product with both shops already linked (no Merge needed).
//
// Links are saved in exactly the format the Quick Sync imports use, so a later sync updates
// the product instead of creating a duplicate:
//   eBay:        channel_product_id "v1|<itemId>|0", channel_variant_id = variation value(s)
//                joined with " / " (null for a single item)
//   Squarespace: channel_product_id = product id, channel_variant_id = variant id
//
// Actions (POST JSON):
//   setup                        -> eBay defaults copied from a live listing + Squarespace store pages
//   categories { query }         -> suggested eBay categories
//   aspects { categoryId }       -> item specifics eBay wants for that category
//   upload_photo { name, data }  -> uploads a photo (base64) to eBay picture hosting, returns its URL
//   verify { listing }           -> eBay test listing (VerifyAddItem): errors, warnings and fees, nothing goes live
//   item { itemId }              -> reads an existing eBay listing (Copy from existing)
//   create { listing }           -> lists on the ticked shops, then saves the product in SyncStock
//   drafts / save_draft / delete_draft
//   delete_sq_product { productId } -> removes a Squarespace product (used to clean up tests)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EBAY = "https://api.ebay.com";
const SQ = "https://api.squarespace.com/1.0";

interface Variation { value: string; sku: string; price: number; webPrice: number; stock: number; photo?: number }
interface Listing {
  title: string;
  sku: string;
  brand: string;
  conditionId: string;
  price: number;
  webPrice: number;
  stock: number;
  costPrice?: number;
  photos: string[];               // eBay-hosted URLs, first is the main photo
  descriptionHtml: string;        // full eBay template HTML
  websiteHtml: string;            // plain description for Squarespace
  categoryId: string;
  specifics: Record<string, string[]>;
  variationName?: string;         // e.g. "Colour"
  variations?: Variation[];
  toEbay: boolean;
  toWebsite: boolean;
  website?: { storePageId: string; tags: string[]; urlSlug?: string; weightKg?: number; visible: boolean };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "drafts") {
      const { data, error } = await supabase.from("listing_drafts").select("id, title, updated_at, data").order("updated_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return json({ ok: true, drafts: data });
    }
    if (action === "save_draft") {
      const row = { title: String(body.data?.title || "Untitled draft").slice(0, 200), data: body.data ?? {}, updated_at: new Date().toISOString() };
      const q = body.id
        ? supabase.from("listing_drafts").update(row).eq("id", body.id).select("id").single()
        : supabase.from("listing_drafts").insert(row).select("id").single();
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json({ ok: true, id: data.id });
    }
    if (action === "delete_draft") {
      const { error } = await supabase.from("listing_drafts").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    if (action === "delete_sq_product") {
      const key = await sqKey(supabase);
      const r = await fetch(`${SQ}/commerce/products/${encodeURIComponent(String(body.productId))}`, { method: "DELETE", headers: sqHeaders(key) });
      return json({ ok: r.ok || r.status === 404, status: r.status });
    }

    if (action === "setup") {
      const token = await userToken(supabase);
      const out: Record<string, unknown> = { ok: true };
      out.ebay = await ebayDefaults(supabase, token);
      try {
        const key = await sqKey(supabase);
        const r = await fetch(`${SQ}/commerce/store_pages`, { headers: sqHeaders(key) });
        const d = await r.json();
        out.storePages = (d.storePages ?? []).map((p: any) => ({ id: p.id, title: p.title, enabled: p.isEnabled }));
      } catch (e: any) {
        out.storePages = [];
        out.storePagesError = e.message;
      }
      return json(out);
    }

    if (action === "categories") {
      // Taxonomy API (the old Trading API GetSuggestedCategories call has been retired by eBay).
      const appToken = await appTokenFn();
      const r = await fetch(
        `${EBAY}/commerce/taxonomy/v1/category_tree/3/get_category_suggestions?q=${encodeURIComponent(String(body.query || "").slice(0, 350))}`,
        { headers: { Authorization: `Bearer ${appToken}`, "Accept-Language": "en-GB" } },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 204) throw new Error(d?.errors?.[0]?.message || "eBay category search failed.");
      const cats = (d.categorySuggestions ?? []).map((c: any) => ({
        id: c.category?.categoryId,
        name: c.category?.categoryName,
        path: (c.categoryTreeNodeAncestors ?? []).map((a: any) => a.categoryName).reverse().join(" › "),
      }));
      return json({ ok: true, categories: cats });
    }

    if (action === "aspects") {
      const appToken = await appTokenFn();
      const r = await fetch(
        `${EBAY}/commerce/taxonomy/v1/category_tree/3/get_item_aspects_for_category?category_id=${encodeURIComponent(String(body.categoryId))}`,
        { headers: { Authorization: `Bearer ${appToken}`, "Accept-Language": "en-GB" } },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d?.errors?.[0]?.message || "eBay couldn't load item specifics for that category.");
      const aspects = (d.aspects ?? []).map((a: any) => ({
        name: a.localizedAspectName,
        required: !!a.aspectConstraint?.aspectRequired,
        mode: a.aspectConstraint?.aspectMode,                    // FREE_TEXT or SELECTION_ONLY
        multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
        usage: a.aspectConstraint?.aspectUsage,                  // RECOMMENDED / OPTIONAL
        forVariations: !!a.aspectConstraint?.aspectEnabledForVariations,
        values: (a.aspectValues ?? []).slice(0, 200).map((v: any) => v.localizedValue),
      }));
      return json({ ok: true, aspects });
    }

    if (action === "item") {
      // Read an existing eBay listing (used by "Copy from existing" and for checking SKUs).
      const token = await userToken(supabase);
      const id = String(body.itemId || "").replace(/\D/g, "");
      const xml = await trading(token, "GetItem", `<ItemID>${id}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`);
      const r = ebayResult(xml);
      if (!r.success) throw new Error(r.errors.join(" ") || "eBay couldn't find that listing.");
      const item = xml.match(/<Item>([\s\S]*)<\/Item>/)?.[1] ?? "";
      const noVars = item.replace(/<Variations>[\s\S]*<\/Variations>/, "").replace(/<ItemSpecifics>[\s\S]*?<\/ItemSpecifics>/, "");
      const specifics: Record<string, string[]> = {};
      for (const [, nv] of (item.match(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/)?.[1] ?? "").matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/g)) {
        const n = tag(nv, "Name"); if (n) specifics[n] = [...nv.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => decode(m[1]));
      }
      const varBlock = item.match(/<Variations>([\s\S]*)<\/Variations>/)?.[1] ?? "";
      const variations = [...varBlock.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(([, v]) => ({
        sku: tag(v, "SKU") || "",
        value: [...v.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => decode(m[1])).join(" / "),
        price: Number(tag(v, "StartPrice") || 0),
        stock: Number(tag(v, "Quantity") || 0) - Number(tag(v.replace(/<SellingStatus>|<\/SellingStatus>/g, ""), "QuantitySold") || 0),
      }));
      const variationName = tag(varBlock.match(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/)?.[1] ?? "", "Name");
      const photos = [...(noVars.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)?.[1] ?? "").matchAll(/<PictureURL>([^<]*)<\/PictureURL>/g)].map((m) => decode(m[1]));
      const cat = noVars.match(/<PrimaryCategory>([\s\S]*?)<\/PrimaryCategory>/)?.[1] ?? "";
      return json({
        ok: true,
        itemId: id,
        title: tag(noVars, "Title"),
        sku: tag(noVars, "SKU"),
        status: tag(noVars, "ListingStatus"),
        startTime: tag(noVars, "StartTime"),
        conditionId: tag(noVars, "ConditionID"),
        price: Number(tag(noVars, "StartPrice") || 0),
        stock: Number(tag(noVars, "Quantity") || 0) - Number(tag(noVars, "QuantitySold") || 0),
        categoryId: tag(cat, "CategoryID"),
        categoryName: tag(cat, "CategoryName"),
        photos,
        specifics,
        variationName,
        variations,
      });
    }

    if (action === "upload_photo") {
      const token = await userToken(supabase);
      const url = await uploadPhoto(token, String(body.name || "photo.jpg"), String(body.data || ""));
      return json({ ok: true, url });
    }

    if (action === "verify") {
      const L = body.listing as Listing;
      const token = await userToken(supabase);
      const defaults = await ebayDefaults(supabase, token);
      const xml = await trading(token, "VerifyAddFixedPriceItem", itemXml(L, defaults));
      return json({ ok: true, ...ebayResult(xml), problems: [...validate(L), ...(await skuClashes(supabase, L))] });
    }

    if (action === "test_website") {
      // Creates the product hidden on Squarespace, reads back what was saved, then deletes it.
      const L = body.listing as Listing;
      L.website = { ...(L.website as any), visible: false };
      const sq = await createSquarespace(supabase, L);
      const key = await sqKey(supabase);
      const back = await (await fetch(`${SQ}/commerce/products/${sq.productId}`, { headers: sqHeaders(key) })).json();
      const del = await fetch(`${SQ}/commerce/products/${sq.productId}`, { method: "DELETE", headers: sqHeaders(key) });
      const prod = back.products?.[0] ?? back;
      return json({ ok: true, created: sq, savedDescription: prod.description, savedVisible: prod.isVisible, images: (prod.images ?? []).length, deleted: del.ok });
    }

    if (action === "create") {
      const L = body.listing as Listing;
      const problems = [...validate(L), ...(await skuClashes(supabase, L))];
      if (problems.length) return json({ error: problems.join(" ") }, 400);
      const result: Record<string, unknown> = { ok: true };

      // 1. eBay first. If eBay refuses, stop before anything else is created.
      let ebayItemId: string | null = null;
      if (L.toEbay) {
        const token = await userToken(supabase);
        const defaults = await ebayDefaults(supabase, token);
        const xml = await trading(token, "AddFixedPriceItem", itemXml(L, defaults));
        const r = ebayResult(xml);
        if (!r.success || !r.itemId) return json({ error: "eBay didn't accept the listing: " + (r.errors.join(" ") || "unknown error"), ebay: r }, 400);
        ebayItemId = r.itemId;
        result.ebay = { itemId: ebayItemId, url: `https://www.ebay.co.uk/itm/${ebayItemId}`, warnings: r.warnings, fees: r.fees };
      }

      // 2. Squarespace. If this fails after eBay worked, still save the product so stock syncs on eBay.
      let sq: { productId: string; variants: { id: string; sku: string }[]; url?: string } | null = null;
      if (L.toWebsite) {
        try {
          sq = await createSquarespace(supabase, L);
          result.website = { productId: sq.productId, url: sq.url, photosUploaded: (sq as any).photosUploaded };
        } catch (e: any) {
          result.websiteError = e.message;
          if (!L.toEbay) return json({ error: "Squarespace didn't accept the product: " + e.message }, 400);
        }
      }

      // 3. SyncStock: one product, its variants and stock, and both shop links.
      result.syncstock = await saveToSyncStock(supabase, L, ebayItemId, sq);
      await supabase.from("sync_log").insert({ sync_type: "create_listing", status: result.websiteError ? "partial" : "completed", details: { title: L.title, ebayItemId, squarespace: sq?.productId ?? null, websiteError: result.websiteError ?? null }, source: "edge_function" });
      if (body.draftId) await supabase.from("listing_drafts").delete().eq("id", body.draftId);
      return json(result);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e: any) {
    return json({ error: e.message || String(e) }, 500);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

function json(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
function esc(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function decode(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
}
function tag(xml: string, t: string): string | null {
  const m = xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
  if (!m) return null;
  const c = m[1].match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return c ? c[1] : decode(m[1]);
}
function cdata(s: string) {
  return "<![CDATA[" + String(s).split("]]>").join("]]]]><![CDATA[>") + "]]>";
}
function money(n: number) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

async function userToken(supabase: any): Promise<string> {
  const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
  const { data: tok } = await supabase.from("sync_secrets").select("value").eq("key", "ebay_refresh_token").maybeSingle();
  if (!appId || !certId || !tok?.value) throw new Error("eBay connection details are missing.");
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.value, scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Couldn't log in to eBay (token refresh failed).");
  return d.access_token;
}

async function appTokenFn(): Promise<string> {
  const appId = Deno.env.get("EBAY_APP_ID"), certId = Deno.env.get("EBAY_CERT_ID");
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${appId}:${certId}`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Couldn't get an eBay app token.");
  return d.access_token;
}

async function trading(token: string, call: string, inner: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>${inner}</${call}Request>`;
  const resp = await fetch(`${EBAY}/ws/api.dll`, {
    method: "POST",
    headers: { "Content-Type": "text/xml", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "3" },
    body,
  });
  return await resp.text();
}

function ebayResult(xml: string) {
  const errors: string[] = [], warnings: string[] = [];
  for (const [, b] of xml.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)) {
    const msg = tag(b, "LongMessage") || tag(b, "ShortMessage") || "eBay error";
    ((tag(b, "SeverityCode") || "") === "Warning" ? warnings : errors).push(msg);
  }
  const fees: { name: string; amount: number }[] = [];
  for (const [, f] of xml.matchAll(/<Fee>([\s\S]*?)<\/Fee>/g)) {
    const amount = Number(tag(f, "Fee") || 0);
    if (amount > 0) fees.push({ name: tag(f, "Name") || "", amount });
  }
  const ack = tag(xml, "Ack") || "";
  return { success: ack === "Success" || ack === "Warning", ack, itemId: tag(xml, "ItemID"), errors, warnings, fees };
}

// Copy delivery/returns/payment policies, location and dispatch time from a live listing,
// so new listings use exactly what the existing ones do. Cached in sync_secrets for a day.
async function ebayDefaults(supabase: any, token: string) {
  const { data: cached } = await supabase.from("sync_secrets").select("value, updated_at").eq("key", "ebay_listing_defaults").maybeSingle();
  if (cached?.value && cached.updated_at && Date.now() - new Date(cached.updated_at).getTime() < 86400000) {
    try { return JSON.parse(cached.value); } catch { /* refresh below */ }
  }
  const { data: rows } = await supabase.from("channel_listings").select("channel_product_id").eq("channel", "ebay").order("last_synced_at", { ascending: false }).limit(20);
  const ids = [...new Set((rows ?? []).map((r: any) => (r.channel_product_id || "").split("|")[1]).filter(Boolean))] as string[];
  for (const id of ids) {
    const xml = await trading(token, "GetItem", `<ItemID>${id}</ItemID><DetailLevel>ReturnAll</DetailLevel>`);
    if (!/<ListingStatus>Active<\/ListingStatus>/.test(xml)) continue;
    const sp = xml.match(/<SellerProfiles>([\s\S]*?)<\/SellerProfiles>/)?.[1] ?? "";
    const prof = (n: string) => {
      const b = sp.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? "";
      return { id: tag(b, "ShippingProfileID") || tag(b, "ReturnProfileID") || tag(b, "PaymentProfileID"), name: tag(b, "ShippingProfileName") || tag(b, "ReturnProfileName") || tag(b, "PaymentProfileName") };
    };
    const d = {
      fromItem: id,
      shipping: prof("SellerShippingProfile"),
      returns: prof("SellerReturnProfile"),
      payment: prof("SellerPaymentProfile"),
      location: tag(xml, "Location"),
      postalCode: tag(xml, "PostalCode"),
      country: tag(xml, "Country") || "GB",
      dispatchDays: tag(xml, "DispatchTimeMax") || "1",
    };
    if (!d.shipping.id || !d.returns.id || !d.payment.id) continue;
    await supabase.from("sync_secrets").upsert({ key: "ebay_listing_defaults", value: JSON.stringify(d), updated_at: new Date().toISOString() }, { onConflict: "key" });
    return d;
  }
  throw new Error("Couldn't find a live eBay listing with business policies to copy delivery and returns from.");
}

function validate(L: Listing): string[] {
  const p: string[] = [];
  if (!L.title?.trim()) p.push("Add a title.");
  if (L.title && L.title.length > 80) p.push("eBay titles can be 80 characters at most.");
  if (!L.toEbay && !L.toWebsite) p.push("Tick eBay, the website, or both.");
  if (L.toEbay && !L.categoryId) p.push("Pick an eBay category.");
  if (!L.photos?.length) p.push("Add at least one photo.");
  if (L.toWebsite && !L.website?.storePageId) p.push("Pick which website shop page it goes on.");
  const vars = L.variations ?? [];
  if (vars.length) {
    if (!L.variationName?.trim()) p.push("Name the variation, for example Colour or Size.");
    const vals = vars.map((v) => v.value.trim().toLowerCase());
    if (vals.some((v) => !v)) p.push("Every variation needs a name.");
    if (new Set(vals).size !== vals.length) p.push("Two variations have the same name.");
    if (vars.some((v) => !(v.price > 0))) p.push("Every variation needs a price.");
  } else if (!(L.price > 0)) p.push("Add a price.");
  return p;
}

// SyncStock needs every SKU to be unique (products.sku and variants.internal_sku), so check
// before anything is listed. A clash would otherwise list on eBay but fail to save here.
async function skuClashes(supabase: any, L: Listing): Promise<string[]> {
  const skus = [...new Set([L.sku, ...(L.variations ?? []).map((v) => v.sku)].map((s) => (s || "").trim()).filter(Boolean))];
  if (!skus.length) return [];
  const [{ data: p }, { data: v }] = await Promise.all([
    supabase.from("products").select("sku, name").in("sku", skus),
    supabase.from("variants").select("internal_sku, products(name)").in("internal_sku", skus),
  ]);
  const used = new Map<string, string>();
  for (const r of p ?? []) used.set(r.sku, r.name);
  for (const r of v ?? []) used.set(r.internal_sku, r.products?.name ?? "another product");
  return [...used].map(([s, n]) => `SKU "${s}" is already used by "${n}". Give it a different SKU.`);
}

function itemXml(L: Listing, d: any): string {
  const vars = L.variations ?? [];
  const specifics = Object.entries(L.specifics || {})
    .filter(([n, v]) => n && v && v.length && !(vars.length && n === L.variationName))
    .map(([n, vals]) => `<NameValueList><Name>${esc(n)}</Name>${vals.filter(Boolean).map((v) => `<Value>${esc(v)}</Value>`).join("")}</NameValueList>`)
    .join("");
  const pics = (L.photos || []).slice(0, 24).map((u) => `<PictureURL>${esc(u)}</PictureURL>`).join("");
  let variationsXml = "";
  if (vars.length) {
    const vn = esc(L.variationName || "Option");
    const withPhoto = vars.filter((v) => v.photo !== undefined && v.photo !== null && L.photos[v.photo]);
    variationsXml = `<Variations>
      <VariationSpecificsSet><NameValueList><Name>${vn}</Name>${vars.map((v) => `<Value>${esc(v.value)}</Value>`).join("")}</NameValueList></VariationSpecificsSet>
      ${vars.map((v) => `<Variation>${v.sku?.trim() ? `<SKU>${esc(v.sku.trim())}</SKU>` : ""}<StartPrice>${money(v.price)}</StartPrice><Quantity>${Math.max(0, Math.floor(v.stock || 0))}</Quantity><VariationSpecifics><NameValueList><Name>${vn}</Name><Value>${esc(v.value)}</Value></NameValueList></VariationSpecifics></Variation>`).join("")}
      ${withPhoto.length ? `<Pictures><VariationSpecificName>${vn}</VariationSpecificName>${withPhoto.map((v) => `<VariationSpecificPictureSet><VariationSpecificValue>${esc(v.value)}</VariationSpecificValue><PictureURL>${esc(L.photos[v.photo as number])}</PictureURL></VariationSpecificPictureSet>`).join("")}</Pictures>` : ""}
    </Variations>`;
  }
  return `<Item>
    <Title>${esc(L.title.trim())}</Title>
    <Description>${cdata(L.descriptionHtml)}</Description>
    <PrimaryCategory><CategoryID>${esc(L.categoryId)}</CategoryID></PrimaryCategory>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <ConditionID>${esc(L.conditionId || "1000")}</ConditionID>
    <Country>${esc(d.country || "GB")}</Country>
    <Currency>GBP</Currency>
    <Site>UK</Site>
    ${d.location ? `<Location>${esc(d.location)}</Location>` : ""}
    ${d.postalCode ? `<PostalCode>${esc(d.postalCode)}</PostalCode>` : ""}
    <DispatchTimeMax>${esc(d.dispatchDays || "1")}</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    ${vars.length ? "" : `<StartPrice>${money(L.price)}</StartPrice><Quantity>${Math.max(0, Math.floor(L.stock || 0))}</Quantity>`}
    ${vars.length || !L.sku ? "" : `<SKU>${esc(L.sku)}</SKU>`}
    <PictureDetails>${pics}</PictureDetails>
    ${specifics ? `<ItemSpecifics>${specifics}</ItemSpecifics>` : ""}
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>${esc(d.shipping.id)}</ShippingProfileID></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>${esc(d.returns.id)}</ReturnProfileID></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>${esc(d.payment.id)}</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles>
    ${variationsXml}
  </Item>`;
}

async function uploadPhoto(token: string, name: string, base64: string): Promise<string> {
  const raw = base64.replace(/^data:[^,]+,/, "");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length > 7 * 1024 * 1024) throw new Error("That photo is too large (7MB max).");
  const boundary = "----SyncStock" + crypto.randomUUID();
  const xml = `<?xml version="1.0" encoding="utf-8"?><UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><PictureName>${esc(name.slice(0, 80))}</PictureName><PictureSet>Supersize</PictureSet></UploadSiteHostedPicturesRequest>`;
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml;charset=utf-8\r\n\r\n${xml}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name.replace(/"/g, "")}"\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const payload = new Uint8Array(head.length + bytes.length + tail.length);
  payload.set(head, 0); payload.set(bytes, head.length); payload.set(tail, head.length + bytes.length);
  const r = await fetch(`${EBAY}/ws/api.dll`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures", "X-EBAY-API-SITEID": "3" },
    body: payload,
  });
  const out = await r.text();
  const url = tag(out, "FullURL");
  if (!url) throw new Error("eBay didn't accept the photo: " + (tag(out, "LongMessage") || tag(out, "ShortMessage") || "unknown error"));
  return url;
}

async function sqKey(supabase: any): Promise<string> {
  const { data: k } = await supabase.from("sync_secrets").select("value").eq("key", "squarespace_api_key").maybeSingle();
  const key = k?.value ?? Deno.env.get("SQUARESPACE_API_KEY");
  if (!key) throw new Error("Squarespace API key not set.");
  return key;
}
function sqHeaders(key: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${key}`, "User-Agent": "SyncStock/2.0", ...extra };
}

async function createSquarespace(supabase: any, L: Listing) {
  const key = await sqKey(supabase);
  const vars = L.variations ?? [];
  const w = L.website!;
  const weight = w.weightKg && w.weightKg > 0 ? { shippingMeasurements: { weight: { unit: "KILOGRAM", value: w.weightKg }, dimensions: { unit: "CENTIMETER", length: 0, width: 0, height: 0 } } } : {};
  const variants = vars.length
    ? vars.map((v) => ({
        sku: v.sku || undefined,
        pricing: { basePrice: { currency: "GBP", value: money(v.webPrice || v.price) } },
        stock: { quantity: Math.max(0, Math.floor(v.stock || 0)), unlimited: false },
        attributes: { [L.variationName || "Option"]: v.value },
        ...weight,
      }))
    : [{
        sku: L.sku || undefined,
        pricing: { basePrice: { currency: "GBP", value: money(L.webPrice || L.price) } },
        stock: { quantity: Math.max(0, Math.floor(L.stock || 0)), unlimited: false },
        ...weight,
      }];
  const payload: Record<string, unknown> = {
    type: "PHYSICAL",
    storePageId: w.storePageId,
    name: L.title.trim(),
    description: L.websiteHtml || "",
    isVisible: !!w.visible,
    tags: (w.tags || []).filter(Boolean),
    variants,
  };
  if (w.urlSlug) payload.urlSlug = w.urlSlug;
  if (vars.length) payload.variantAttributes = [L.variationName || "Option"];
  const r = await fetch(`${SQ}/commerce/products`, {
    method: "POST",
    headers: sqHeaders(key, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${d?.message || JSON.stringify(d).slice(0, 300)}`);

  // Photos: copy each eBay-hosted photo to Squarespace (in order, main photo first).
  let photosUploaded = 0;
  for (const [i, url] of (L.photos || []).slice(0, 12).entries()) {
    try {
      const img = await fetch(url);
      if (!img.ok) continue;
      const blob = await img.blob();
      const form = new FormData();
      form.append("file", new File([blob], `photo-${i + 1}.jpg`, { type: blob.type || "image/jpeg" }));
      const up = await fetch(`${SQ}/commerce/products/${d.id}/images`, { method: "POST", headers: sqHeaders(key), body: form });
      if (up.ok) photosUploaded++;
    } catch { /* keep going; the product exists either way */ }
  }
  return {
    productId: d.id as string,
    url: d.url as string | undefined,
    photosUploaded,
    variants: (d.variants ?? []).map((v: any) => ({ id: v.id as string, sku: (v.sku || "") as string, attrs: v.attributes ?? {} })),
  };
}

async function saveToSyncStock(supabase: any, L: Listing, ebayItemId: string | null, sq: any) {
  const vars = L.variations ?? [];
  const now = new Date().toISOString();
  const { data: p, error: pe } = await supabase
    .from("products")
    .insert({ name: L.title.trim(), sku: L.sku || null, active: true, status: "active", cost_price: L.costPrice ?? null, image_url: L.photos?.[0] ?? null, description: L.websiteHtml || null })
    .select("id")
    .single();
  if (pe || !p) throw new Error("Listed, but couldn't save the product in SyncStock: " + (pe?.message || "unknown error"));
  // Fallback SKUs follow the Quick Sync pattern (<itemId>-<value>, or the item id), so they never clash.
  const base = ebayItemId ?? `WEB-${String(p.id).slice(0, 8)}`;
  const rows = vars.length
    ? vars.map((v) => ({ value: v.value, sku: v.sku?.trim() || `${base}-${v.value}`, price: v.price, webPrice: v.webPrice || v.price, stock: v.stock }))
    : [{ value: null as string | null, sku: L.sku?.trim() || base, price: L.price, webPrice: L.webPrice || L.price, stock: L.stock }];
  const problems: string[] = [];
  const cpid = ebayItemId ? `v1|${ebayItemId}|0` : null;
  const linked: string[] = [];
  for (const row of rows) {
    const { data: v, error: ve } = await supabase.from("variants").insert({ product_id: p.id, internal_sku: row.sku, option1: row.value, cost_price: L.costPrice ?? null }).select("id").single();
    if (!v) { problems.push(`Couldn't save option "${row.value ?? row.sku}": ${ve?.message ?? "unknown error"}`); continue; }
    await supabase.from("inventory").insert({ variant_id: v.id, product_id: p.id, total_stock: Math.max(0, Math.floor(row.stock || 0)) });
    if (cpid) {
      // Same shape the eBay Quick Sync writes, so it recognises these rows.
      const { error: le } = await supabase.from("channel_listings").insert({ variant_id: v.id, channel: "ebay", channel_sku: row.value ? (row.sku || row.value) : (L.sku || ebayItemId), channel_price: row.price, channel_product_id: cpid, channel_variant_id: row.value ?? null, last_synced_at: now });
      if (le) problems.push(`eBay link for "${row.value ?? row.sku}": ${le.message}`); else linked.push("ebay");
    }
    if (sq) {
      const match = row.value
        ? sq.variants.find((x: any) => Object.values(x.attrs).map(String).includes(row.value!)) ?? sq.variants.find((x: any) => x.sku && x.sku === row.sku)
        : sq.variants[0];
      if (match) {
        const { error: se } = await supabase.from("channel_listings").insert({ variant_id: v.id, channel: "squarespace", channel_sku: match.sku || row.sku, channel_price: row.webPrice, sq_base_price: row.webPrice, channel_product_id: sq.productId, channel_variant_id: match.id, last_synced_at: now });
        if (se) problems.push(`Website link for "${row.value ?? row.sku}": ${se.message}`); else linked.push("squarespace");
      } else problems.push(`Couldn't find the website option for "${row.value ?? row.sku}".`);
    }
  }
  return { productId: p.id, variants: rows.length, links: linked.length, problems };
}
