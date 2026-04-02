import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.49.1/cors";

const SQ_API_BASE = "https://api.squarespace.com/1.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const sqApiKey = Deno.env.get("SQUARESPACE_API_KEY");
  if (!sqApiKey) {
    return new Response(
      JSON.stringify({ error: "Missing SQUARESPACE_API_KEY" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Fetch ALL Squarespace products (paginated)
    const products = await fetchAllSquarespaceProducts(sqApiKey);

    // Upsert into database
    const stats = await upsertProducts(supabase, products);

    await supabase.from("sync_log").insert({
      sync_type: "squarespace_import",
      status: "completed",
      details: JSON.stringify(stats),
      source: "edge_function",
    });

    return new Response(
      JSON.stringify({ success: true, ...stats }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Squarespace import error:", msg);

    await supabase.from("sync_log").insert({
      sync_type: "squarespace_import",
      status: "failed",
      error_message: msg,
      source: "edge_function",
    });

    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
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

    // Check for pagination
    if (data.pagination?.hasNextPage && data.pagination?.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else {
      break;
    }
  }

  return allProducts;
}

async function upsertProducts(supabase: any, sqProducts: SqProduct[]) {
  let productsCreated = 0;
  let variantsCreated = 0;
  let listingsCreated = 0;

  for (const sqProduct of sqProducts) {
    // Check if already imported via channel_listings
    const { data: existingListings } = await supabase
      .from("channel_listings")
      .select("id")
      .eq("channel", "squarespace")
      .eq("channel_product_id", sqProduct.id)
      .limit(1);

    if (existingListings && existingListings.length > 0) {
      // Already exists — update prices for all variants
      for (const sqVariant of sqProduct.variants) {
        const price = parseFloat(sqVariant.pricing?.basePrice?.value || "0") / 100;
        await supabase
          .from("channel_listings")
          .update({
            channel_price: price,
            last_synced_at: new Date().toISOString(),
          })
          .eq("channel", "squarespace")
          .eq("channel_product_id", sqProduct.id)
          .eq("channel_variant_id", sqVariant.id);
      }
      continue;
    }

    // Create new product
    const imageUrl = sqProduct.images?.[0]?.url || null;
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
    productsCreated++;

    for (const sqVariant of sqProduct.variants) {
      const price = parseFloat(sqVariant.pricing?.basePrice?.value || "0") / 100;
      const attrs = sqVariant.attributes || {};
      const optionValues = Object.values(attrs);

      const { data: variant } = await supabase
        .from("variants")
        .insert({
          product_id: product.id,
          internal_sku: sqVariant.sku || sqVariant.id,
          option1: optionValues[0] || null,
          option2: optionValues[1] || null,
        })
        .select("id")
        .single();

      if (!variant) continue;
      variantsCreated++;

      const stock = sqVariant.stock?.unlimited ? 999 : (sqVariant.stock?.quantity ?? 0);
      await supabase.from("inventory").insert({
        variant_id: variant.id,
        product_id: product.id,
        total_stock: stock,
      });

      await supabase.from("channel_listings").insert({
        variant_id: variant.id,
        channel: "squarespace",
        channel_sku: sqVariant.sku || sqVariant.id,
        channel_price: price,
        channel_product_id: sqProduct.id,
        channel_variant_id: sqVariant.id,
        last_synced_at: new Date().toISOString(),
      });
      listingsCreated++;
    }
  }

  return {
    total_squarespace_products: sqProducts.length,
    products_created: productsCreated,
    variants_created: variantsCreated,
    listings_created: listingsCreated,
  };
}
