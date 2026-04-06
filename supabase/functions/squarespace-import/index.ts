import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SQ_API_BASE = "https://api.squarespace.com/1.0";
const FILTER_CHUNK_SIZE = 150;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Read Squarespace API key from sync_secrets DB (preferred) or env fallback
  const { data: secretRow } = await supabase
    .from("sync_secrets").select("value").eq("key", "squarespace_api_key").single();
  const sqApiKey = secretRow?.value ?? Deno.env.get("SQUARESPACE_API_KEY") ?? null;
  if (!sqApiKey) {
    return new Response(JSON.stringify({ error: "Missing squarespace_api_key in sync_secrets and env" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const products = await fetchAllSquarespaceProducts(sqApiKey);
    const stats = await upsertProducts(supabase, products);

    // Ensure every variant has an inventory row after import
    await supabase.from("sync_log").insert({
      sync_type: "squarespace_import",
      status: "completed",
      details: JSON.stringify({ ...stats }),
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
    const products = data.products || [];
    allProducts.push(...products);

    if (data.pagination?.hasNextPage && data.pagination?.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else {
      break;
    }
  }

  return allProducts;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

async function fetchRowsByColumn(
  supabase: any,
  table: string,
  column: string,
  values: string[],
  select: string,
) {
  if (!values.length) return [];

  const rows: any[] = [];
  for (const chunk of chunkArray([...new Set(values)], FILTER_CHUNK_SIZE)) {
    const { data, error } = await supabase.from(table).select(select).in(column, chunk);
    if (error) throw error;
    rows.push(...(data ?? []));
  }

  return rows;
}

async function fetchExistingSquarespaceListings(supabase: any, externalVariantIds: string[]) {
  if (!externalVariantIds.length) return [];

  const rows: Array<{ id: string; variant_id: string; channel_variant_id: string }> = [];
  for (const chunk of chunkArray([...new Set(externalVariantIds)], FILTER_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("channel_listings")
      .select("id, variant_id, channel_variant_id")
      .eq("channel", "squarespace")
      .in("channel_variant_id", chunk);

    if (error) throw error;
    rows.push(...(data ?? []));
  }

  const variants = await fetchRowsByColumn(
    supabase,
    "variants",
    "id",
    rows.map((row) => row.variant_id),
    "id, product_id",
  );

  const productIdByVariantId = new Map<string, string>();
  for (const variant of variants) {
    productIdByVariantId.set(variant.id, variant.product_id);
  }

  return rows.map((row) => ({
    ...row,
    product_id: productIdByVariantId.get(row.variant_id) ?? null,
  }));
}

async function upsertProducts(supabase: any, squarespaceProducts: SqProduct[]) {
  let productsCreated = 0;
  let productsReused = 0;
  let variantsCreated = 0;
  let variantsReused = 0;
  let listingsCreated = 0;
  let listingsUpdated = 0;
  const batchListingUpserts: any[] = [];
  const batchListingInserts: { variantId: string; payload: any; productId: string; sqVariantId: string }[] = [];

  const existingProducts = await fetchRowsByColumn(
    supabase,
    "products",
    "name",
    squarespaceProducts.map((product) => product.name),
    "id, name, active",
  );

  // productIdByName removed — no auto name-matching; user merges platforms manually

  const existingListings = await fetchExistingSquarespaceListings(
    supabase,
    squarespaceProducts.flatMap((product) => product.variants.map((variant) => variant.id)),
  );

  const listingByExternalVariantId = new Map<string, { id: string; variant_id: string; product_id: string | null | undefined }>();
  for (const listing of existingListings) {
    if (!listingByExternalVariantId.has(listing.channel_variant_id)) {
      listingByExternalVariantId.set(listing.channel_variant_id, {
        id: listing.id,
        variant_id: listing.variant_id,
        product_id: listing.product_id,
      });
    }
  }

  // Fetch existing variants with option1/option2 for smart matching
  const existingVariants = await fetchRowsByColumn(
    supabase,
    "variants",
    "product_id",
    [
      ...existingProducts.map((product) => product.id),
      ...existingListings
        .map((listing) => listing.product_id)
        .filter((productId): productId is string => Boolean(productId)),
    ],
    "id, product_id, internal_sku, option1, option2",
  );

  // SKU-based lookup: product_id:sku → variant_id
  const variantIdByProductAndSku = new Map<string, string>();
  // Option-based lookup: product_id:option1:option2 → variant_id  (helps avoid duplicates)
  const variantIdByProductAndOption = new Map<string, string>();

  for (const variant of existingVariants) {
    if (variant.internal_sku) {
      variantIdByProductAndSku.set(`${variant.product_id}:${variant.internal_sku}`, variant.id);
    }
    // Build option-based key (normalise null → "")
    const opt1 = variant.option1 ?? "";
    const opt2 = variant.option2 ?? "";
    const optKey = `${variant.product_id}:${opt1}:${opt2}`;
    if (!variantIdByProductAndOption.has(optKey)) {
      variantIdByProductAndOption.set(optKey, variant.id);
    }
  }

  // Track which products already have at least one inventory row
  // (used to avoid doubling stock when adding a Squarespace variant to an eBay product)
  const productHasInventory = new Map<string, boolean>();
  const existingInventory = await fetchRowsByColumn(
    supabase,
    "inventory",
    "product_id",
    existingProducts.map((p) => p.id),
    "product_id",
  );
  for (const inv of existingInventory) {
    productHasInventory.set(inv.product_id, true);
  }

  for (const sqProduct of squarespaceProducts) {
    const imageUrl = sqProduct.images?.[0]?.url || null;
    const canonicalListing = sqProduct.variants
      .map((variant) => listingByExternalVariantId.get(variant.id))
      .find((listing): listing is { id: string; variant_id: string; product_id: string | null | undefined } => Boolean(listing));

    // Only use canonical listing lookup (by SQ variant ID) — never auto-match by name
    // User links eBay ↔ Squarespace products manually via the Merge page
    let productId = canonicalListing?.product_id ?? null;

    if (!productId) {
      const { data: product, error: prodErr } = await supabase
        .from("products")
        .insert({
          name: sqProduct.name,
          description: sqProduct.description || null,
          image_url: imageUrl,
          status: "active",
          active: true,
        })
        .select("id")
        .single();

      if (prodErr || !product) {
        console.error(`Failed to create product for ${sqProduct.name}:`, prodErr);
        continue;
      }

      productId = product.id;
      productsCreated++;
    } else {
      productsReused++;
    }

    for (const sqVariant of sqProduct.variants) {
      const existingListing = listingByExternalVariantId.get(sqVariant.id);
      if (existingListing?.product_id) {
        productId = existingListing.product_id;
      }

      const price = parseFloat(sqVariant.pricing?.basePrice?.value || "0");
      const attrs = sqVariant.attributes || {};
      const optionValues = Object.values(attrs);
      const variantSku = sqVariant.sku || sqVariant.id;
      const variantKey = `${productId}:${variantSku}`;

      // Determine option key for smart variant matching
      const opt1 = optionValues[0] || "";
      const opt2 = optionValues[1] || "";
      const optKey = `${productId}:${opt1}:${opt2}`;

      // Find an existing variant: prefer exact SKU match, then option match
      let variantId =
        existingListing?.variant_id ??
        variantIdByProductAndSku.get(variantKey) ??
        variantIdByProductAndOption.get(optKey);

      if (!variantId) {
        // No existing variant found — create a new one
        const { data: variant, error: variantErr } = await supabase
          .from("variants")
          .insert({
            product_id: productId,
            internal_sku: variantSku,
            option1: optionValues[0] || null,
            option2: optionValues[1] || null,
          })
          .select("id")
          .single();

        if (variantErr || !variant) {
          console.error(`Failed to create variant for ${sqProduct.name} / ${variantSku}:`, variantErr);
          continue;
        }

        variantId = variant.id;
        variantIdByProductAndSku.set(variantKey, variant.id);
        variantIdByProductAndOption.set(optKey, variant.id);
        variantsCreated++;

        // Only create an inventory row if this product doesn't already have one.
        // If the product was imported from eBay it already has inventory — adding another
        // row would double the stock count. The user can merge / adjust manually.
        if (!productHasInventory.get(productId!)) {
          const stock = sqVariant.stock?.unlimited ? 999 : (sqVariant.stock?.quantity ?? 0);
          await supabase.from("inventory").insert({
            variant_id: variant.id,
            product_id: productId,
            total_stock: stock,
          });
          productHasInventory.set(productId!, true);
        }
      } else {
        variantsReused++;
        variantIdByProductAndSku.set(variantKey, variantId);

        // If the variant was found via option match rather than the existing listing,
        // also register the SKU key so future runs recognise it
        if (!existingListing?.variant_id && !variantIdByProductAndSku.has(variantKey)) {
          await supabase
            .from("variants")
            .update({ internal_sku: variantSku })
            .eq("id", variantId);
        }
      }

      const listingPayload = {
        variant_id: variantId,
        channel: "squarespace",
        channel_sku: variantSku,
        channel_price: price,
        sq_base_price: price,
        channel_product_id: sqProduct.id,
        channel_variant_id: sqVariant.id,
        last_synced_at: new Date().toISOString(),
      };

      if (existingListing) {
        batchListingUpserts.push({ id: existingListing.id, ...listingPayload });
        listingsUpdated++;
      } else {
        batchListingInserts.push({ variantId: variantId!, payload: listingPayload, productId: productId!, sqVariantId: sqVariant.id });
        listingsCreated++;
      }
    }
  }

  // Bulk execute listing updates
  const LCHUNK = 200;
  if (batchListingUpserts.length > 0) {
    for (let ci = 0; ci < batchListingUpserts.length; ci += LCHUNK) {
      await supabase.from("channel_listings").upsert(batchListingUpserts.slice(ci, ci + LCHUNK));
    }
  }
  if (batchListingInserts.length > 0) {
    const insertPayloads = batchListingInserts.map(b => b.payload);
    for (let ci = 0; ci < insertPayloads.length; ci += LCHUNK) {
      const { data: inserted } = await supabase.from("channel_listings")
        .upsert(insertPayloads.slice(ci, ci + LCHUNK), { onConflict: "channel,channel_variant_id" })
        .select("id, variant_id, channel_variant_id");
      for (const row of (inserted ?? [])) {
        listingByExternalVariantId.set(row.channel_variant_id, {
          id: row.id, variant_id: row.variant_id,
          product_id: batchListingInserts.find(b => b.sqVariantId === row.channel_variant_id)?.productId ?? null,
        });
      }
    }
  }
  return {
    total_squarespace_products: squarespaceProducts.length,
    products_created: productsCreated,
    products_reused: productsReused,
    variants_created: variantsCreated,
    variants_reused: variantsReused,
    listings_created: listingsCreated,
    listings_updated: listingsUpdated,
  };
}

// ─── Ensure every variant has at least one inventory row ─────────────────────
// Runs after import to fill any gaps (stock defaults to 0 for missing rows).

async function ensureInventoryRows(supabase: any): Promise<number> {
  const CHUNK = 500;
  let fixed = 0;

  // Fetch all variants
  const { data: allVariants } = await supabase
    .from("variants")
    .select("id, product_id");

  if (!allVariants?.length) return 0;

  // Fetch all existing inventory variant_ids
  const { data: allInv } = await supabase
    .from("inventory")
    .select("variant_id");

  const existingVariantIds = new Set<string>((allInv ?? []).map((i: any) => i.variant_id));

  // Find variants with no inventory row
  const missing = (allVariants as any[]).filter((v: any) => !existingVariantIds.has(v.id));
  if (missing.length === 0) return 0;

  // Insert inventory rows in chunks
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK).map((v: any) => ({
      variant_id: v.id,
      product_id: v.product_id,
      total_stock: 0,
    }));
    const { error } = await supabase.from("inventory").insert(chunk);
    if (!error) fixed += chunk.length;
  }

  return fixed;
}
