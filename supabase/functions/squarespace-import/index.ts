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

  const sqApiKey = Deno.env.get("SQUARESPACE_API_KEY");
  if (!sqApiKey) {
    return new Response(JSON.stringify({ error: "Missing SQUARESPACE_API_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const products = await fetchAllSquarespaceProducts(sqApiKey);
    const stats = await upsertProducts(supabase, products);

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

  const existingProducts = await fetchRowsByColumn(
    supabase,
    "products",
    "name",
    squarespaceProducts.map((product) => product.name),
    "id, name, active",
  );

  const productIdByName = new Map<string, string>();
  const productIsActiveByName = new Map<string, boolean>();
  for (const product of existingProducts) {
    if (!product.name) continue;

    const selectedIsActive = productIsActiveByName.get(product.name);
    if (!productIdByName.has(product.name) || (!selectedIsActive && product.active)) {
      productIdByName.set(product.name, product.id);
      productIsActiveByName.set(product.name, Boolean(product.active));
    }
  }

  const existingListings = await fetchExistingSquarespaceListings(
    supabase,
    squarespaceProducts.flatMap((product) => product.variants.map((variant) => variant.id)),
  );

  const listingByExternalVariantId = new Map<string, {
    id: string;
    variant_id: string;
    product_id: string | null;
  }>();
  for (const listing of existingListings) {
    if (!listingByExternalVariantId.has(listing.channel_variant_id)) {
      listingByExternalVariantId.set(listing.channel_variant_id, {
        id: listing.id,
        variant_id: listing.variant_id,
        product_id: listing.product_id,
      });
    }
  }

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
    "id, product_id, internal_sku",
  );

  const variantIdByProductAndSku = new Map<string, string>();
  for (const variant of existingVariants) {
    if (variant.internal_sku) {
      variantIdByProductAndSku.set(`${variant.product_id}:${variant.internal_sku}`, variant.id);
    }
  }

  for (const sqProduct of squarespaceProducts) {
    const imageUrl = sqProduct.images?.[0]?.url || null;
    const canonicalListing = sqProduct.variants
      .map((variant) => listingByExternalVariantId.get(variant.id))
      .find((listing): listing is { id: string; variant_id: string; product_id: string | null } => Boolean(listing));

    let productId = canonicalListing?.product_id ?? productIdByName.get(sqProduct.name);

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
      productIdByName.set(sqProduct.name, product.id);
      productIsActiveByName.set(sqProduct.name, true);
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

      let variantId = existingListing?.variant_id ?? variantIdByProductAndSku.get(variantKey);
      if (!variantId) {
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
        variantsCreated++;

        const stock = sqVariant.stock?.unlimited ? 999 : (sqVariant.stock?.quantity ?? 0);
        await supabase.from("inventory").insert({
          variant_id: variant.id,
          product_id: productId,
          total_stock: stock,
        });
      } else {
        variantsReused++;
        variantIdByProductAndSku.set(variantKey, variantId);
        // FIX: update inventory to reflect latest Squarespace stock quantity
        const stock = sqVariant.stock?.unlimited ? 999 : (sqVariant.stock?.quantity ?? 0);
        await supabase.from("inventory").update({ total_stock: stock }).eq("variant_id", variantId);
      }

      const listingPayload = {
        variant_id: variantId,
        channel: "squarespace",
        channel_sku: variantSku,
        channel_price: price,
        channel_product_id: sqProduct.id,
        channel_variant_id: sqVariant.id,
        last_synced_at: new Date().toISOString(),
      };

      if (existingListing) {
        const { error: listingErr } = await supabase
          .from("channel_listings")
          .update({ ...listingPayload, updated_at: new Date().toISOString() })
          .eq("id", existingListing.id);

        if (listingErr) {
          console.error(`Failed to update listing for ${sqProduct.name} / ${variantSku}:`, listingErr);
          continue;
        }

        listingsUpdated++;
      } else {
        const { data: listing, error: listingErr } = await supabase
          .from("channel_listings")
          .insert(listingPayload)
          .select("id, variant_id, channel_variant_id")
          .single();

        if (listingErr || !listing) {
          console.error(`Failed to create listing for ${sqProduct.name} / ${variantSku}:`, listingErr);
          continue;
        }

        listingByExternalVariantId.set(listing.channel_variant_id, {
          id: listing.id,
          variant_id: listing.variant_id,
          product_id: productId,
        });
        listingsCreated++;
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
