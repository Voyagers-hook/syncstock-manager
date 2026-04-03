import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SQ_API_BASE = "https://api.squarespace.com/1.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const sqApiKey = Deno.env.get("SQUARESPACE_API");
  if (!sqApiKey) {
    return new Response(JSON.stringify({ error: "Missing SQUARESPACE_API" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Fetch all products from Squarespace
    const sqProducts = await fetchAllSquarespaceProducts(sqApiKey);

    // 2. Build flat list of all variants with their parent product info
    type SqRow = {
      productExternalId: string;
      productName: string;
      productDescription: string | null;
      imageUrl: string | null;
      variantExternalId: string;
      sku: string;
      price: number;
      stock: number;
      option1: string | null;
      option2: string | null;
    };

    const rows: SqRow[] = [];
    for (const p of sqProducts) {
      const imageUrl = p.images?.[0]?.url || null;
      for (const v of p.variants) {
        const attrs = v.attributes || {};
        const optionValues = Object.values(attrs);
        rows.push({
          productExternalId: p.id,
          productName: p.name,
          productDescription: p.description || null,
          imageUrl,
          variantExternalId: v.id,
          sku: v.sku || v.id,
          price: parseFloat(v.pricing?.basePrice?.value || "0"),
          stock: v.stock?.unlimited ? 999 : (v.stock?.quantity ?? 0),
          option1: (optionValues[0] as string) || null,
          option2: (optionValues[1] as string) || null,
        });
      }
    }

    // 3. Load existing products by name
    const { data: existingProducts } = await supabase
      .from("products")
      .select("id, name");
    const productIdByName = new Map<string, string>();
    for (const p of existingProducts ?? []) {
      if (p.name) productIdByName.set(p.name, p.id);
    }

    // 4. Load existing channel_listings for squarespace by channel_variant_id
    const { data: existingListings } = await supabase
      .from("channel_listings")
      .select("id, variant_id, channel_variant_id, channel_product_id")
      .eq("channel", "squarespace");
    const listingByExtVariantId = new Map<string, { id: string; variant_id: string }>();
    for (const l of existingListings ?? []) {
      listingByExtVariantId.set(l.channel_variant_id, { id: l.id, variant_id: l.variant_id });
    }

    // 5. Load existing variants by id (for those already linked)
    const linkedVariantIds = [...listingByExtVariantId.values()].map((l) => l.variant_id);
    const variantIdByLinkedId = new Set<string>(linkedVariantIds);

    // 6. Create missing products in bulk
    const uniqueProductNames = [...new Set(rows.map((r) => r.productName))];
    const missingProductNames = uniqueProductNames.filter((n) => !productIdByName.has(n));

    if (missingProductNames.length > 0) {
      // Build product rows - one per unique name
      const nameToRow = new Map<string, SqRow>();
      for (const r of rows) {
        if (!nameToRow.has(r.productName)) nameToRow.set(r.productName, r);
      }
      const newProducts = missingProductNames.map((name) => {
        const r = nameToRow.get(name)!;
        return {
          name,
          description: r.productDescription,
          image_url: r.imageUrl,
          status: "active",
          active: true,
        };
      });

      // Insert in chunks of 500
      for (let i = 0; i < newProducts.length; i += 500) {
        const chunk = newProducts.slice(i, i + 500);
        const { data: inserted } = await supabase
          .from("products")
          .insert(chunk)
          .select("id, name");
        for (const p of inserted ?? []) {
          if (p.name) productIdByName.set(p.name, p.id);
        }
      }
    }

    // 7. For each row, determine variant_id — either from existing listing or create
    //    Group new variants by product
    const newVariantRows: Array<{
      product_id: string;
      internal_sku: string;
      option1: string | null;
      option2: string | null;
      _variantExternalId: string;
      _stock: number;
      _price: number;
    }> = [];
    const rowsWithExistingVariant: Array<{
      variantExternalId: string;
      variantId: string;
      stock: number;
      price: number;
      sku: string;
      productExternalId: string;
      productName: string;
      imageUrl: string | null;
    }> = [];

    for (const r of rows) {
      const existing = listingByExtVariantId.get(r.variantExternalId);
      if (existing) {
        rowsWithExistingVariant.push({
          variantExternalId: r.variantExternalId,
          variantId: existing.variant_id,
          stock: r.stock,
          price: r.price,
          sku: r.sku,
          productExternalId: r.productExternalId,
          productName: r.productName,
          imageUrl: r.imageUrl,
        });
      } else {
        const productId = productIdByName.get(r.productName);
        if (!productId) continue;
        newVariantRows.push({
          product_id: productId,
          internal_sku: r.sku,
          option1: r.option1,
          option2: r.option2,
          _variantExternalId: r.variantExternalId,
          _stock: r.stock,
          _price: r.price,
        });
      }
    }

    // 8. Bulk update inventory for existing variants
    if (rowsWithExistingVariant.length > 0) {
      // Group by stock value to minimise round trips — or just do it in chunks
      // We'll do batch updates using upsert on variant_id
      for (let i = 0; i < rowsWithExistingVariant.length; i += 200) {
        const chunk = rowsWithExistingVariant.slice(i, i + 200);
        // Build upsert payload
        const invUpserts = chunk.map((r) => ({
          variant_id: r.variantId,
          total_stock: r.stock,
        }));
        await supabase
          .from("inventory")
          .upsert(invUpserts, { onConflict: "variant_id" });
      }
    }

    // 9. Insert new variants in bulk, then create their inventory + listings
    const createdVariantMap = new Map<string, { variantId: string; stock: number; price: number; sku: string; productId: string }>();

    for (let i = 0; i < newVariantRows.length; i += 200) {
      const chunk = newVariantRows.slice(i, i + 200);
      const insertPayload = chunk.map((r) => ({
        product_id: r.product_id,
        internal_sku: r.internal_sku,
        option1: r.option1,
        option2: r.option2,
      }));
      const { data: inserted } = await supabase
        .from("variants")
        .insert(insertPayload)
        .select("id, product_id, internal_sku");

      for (let j = 0; j < (inserted ?? []).length; j++) {
        const v = inserted![j];
        const orig = chunk[j];
        createdVariantMap.set(orig._variantExternalId, {
          variantId: v.id,
          stock: orig._stock,
          price: orig._price,
          sku: orig.internal_sku,
          productId: v.product_id,
        });
      }
    }

    // 10. Bulk insert inventory for new variants
    if (createdVariantMap.size > 0) {
      const invRows = [...createdVariantMap.values()].map((v) => ({
        variant_id: v.variantId,
        product_id: v.productId,
        total_stock: v.stock,
      }));
      for (let i = 0; i < invRows.length; i += 500) {
        await supabase.from("inventory").insert(invRows.slice(i, i + 500));
      }
    }

    // 11. Build all channel_listings upserts
    const now = new Date().toISOString();
    const listingUpserts: Array<{
      id?: string;
      variant_id: string;
      channel: string;
      channel_sku: string;
      channel_price: number;
      channel_product_id: string;
      channel_variant_id: string;
      last_synced_at: string;
    }> = [];

    for (const r of rows) {
      const existing = listingByExtVariantId.get(r.variantExternalId);
      let variantId = existing?.variant_id;
      if (!variantId) {
        const created = createdVariantMap.get(r.variantExternalId);
        variantId = created?.variantId;
      }
      if (!variantId) continue;

      const payload: typeof listingUpserts[0] = {
        variant_id: variantId,
        channel: "squarespace",
        channel_sku: r.sku,
        channel_price: r.price,
        channel_product_id: r.productExternalId,
        channel_variant_id: r.variantExternalId,
        last_synced_at: now,
      };
      if (existing) payload.id = existing.id;
      listingUpserts.push(payload);
    }

    for (let i = 0; i < listingUpserts.length; i += 500) {
      await supabase
        .from("channel_listings")
        .upsert(listingUpserts.slice(i, i + 500), { onConflict: "id" });
    }

    const stats = {
      total_squarespace_products: sqProducts.length,
      total_variants: rows.length,
      new_variants: createdVariantMap.size,
      updated_variants: rowsWithExistingVariant.length,
      listings_upserted: listingUpserts.length,
    };

    await supabase.from("sync_log").insert({
      sync_type: "squarespace_import",
      status: "completed",
      details: JSON.stringify(stats),
      source: "edge_function",
    });

    return new Response(JSON.stringify({ success: true, ...stats }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Squarespace import error:", msg);

    await supabase.from("sync_log").insert({
      sync_type: "squarespace_import",
      status: "failed",
      error_message: msg,
      source: "edge_function",
    });

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

interface SqProduct {
  id: string;
  name: string;
  description?: string;
  url?: string;
  variants: SqVariant[];
  images?: { url: string }[];
}

interface SqVariant {
  id: string;
  sku?: string;
  pricing: { basePrice: { value: string; currency: string } };
  stock?: { quantity: number; unlimited: boolean };
  attributes?: Record<string, string>;
}

async function fetchAllSquarespaceProducts(apiKey: string): Promise<SqProduct[]> {
  const allProducts: SqProduct[] = [];
  let cursor: string | undefined;

  while (true) {
    const url = cursor
      ? `${SQ_API_BASE}/commerce/products?cursor=${cursor}`
      : `${SQ_API_BASE}/commerce/products`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "LovableSync/1.0",
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Squarespace API failed [${resp.status}]: ${body}`);
    }

    const data = await resp.json();
    allProducts.push(...(data.products || []));

    if (data.pagination?.hasNextPage && data.pagination?.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else {
      break;
    }
  }

  return allProducts;
}
