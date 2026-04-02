import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { chunkArray, fetchAllPages } from "@/lib/supabase-pagination";
import type {
  ChannelListing,
  Inventory,
  Product,
  ProductWithDetails,
  Variant,
} from "@/lib/types";

const PAGE_SIZE = 1000;
const FILTER_CHUNK_SIZE = 150;

async function fetchRowsByIds<T>(
  table: "variants" | "inventory" | "channel_listings",
  column: "product_id" | "variant_id",
  ids: string[],
): Promise<T[]> {
  if (!ids.length) return [];

  const chunks = chunkArray(ids, FILTER_CHUNK_SIZE);
  const results = await Promise.all(
    chunks.map((chunk) =>
      fetchAllPages<T>(
        async (from, to) => {
          const resp = await supabase
            .from(table)
            .select("*")
            .in(column, chunk)
            .range(from, to);

          return { data: (resp.data as unknown as T[] | null), error: resp.error };
        },
        PAGE_SIZE,
      ),
    ),
  );

  return results.flat();
}

export function useProducts() {
  return useQuery({
    queryKey: ["products"],
    queryFn: async (): Promise<ProductWithDetails[]> => {
      const products = await fetchAllPages<Product>(async (from, to) => {
        const query = supabase
          .from("products")
          .select("*")
          .eq("active", true)
          .order("name");

        const { data, error } = await query.range(from, to);
        return { data, error };
      }, PAGE_SIZE);

      if (!products.length) return [];

      const productIds = products.map((product) => product.id);
      const [variants, inventory] = await Promise.all([
        fetchRowsByIds<Variant>("variants", "product_id", productIds),
        fetchRowsByIds<Inventory>("inventory", "product_id", productIds),
      ]);

      const listings = await fetchRowsByIds<ChannelListing>(
        "channel_listings",
        "variant_id",
        variants.map((variant) => variant.id),
      );

      const variantsByProduct = new Map<string, Variant[]>();
      for (const variant of variants) {
        const bucket = variantsByProduct.get(variant.product_id) ?? [];
        bucket.push(variant);
        variantsByProduct.set(variant.product_id, bucket);
      }

      const inventoryByProduct = new Map<string, Inventory[]>();
      for (const stockRow of inventory) {
        const bucket = inventoryByProduct.get(stockRow.product_id) ?? [];
        bucket.push(stockRow);
        inventoryByProduct.set(stockRow.product_id, bucket);
      }

      const listingsByVariant = new Map<string, ChannelListing[]>();
      for (const listing of listings) {
        const bucket = listingsByVariant.get(listing.variant_id) ?? [];
        bucket.push(listing);
        listingsByVariant.set(listing.variant_id, bucket);
      }

      return products.map((product) => {
        const productVariants = variantsByProduct.get(product.id) ?? [];
        const productInventory = inventoryByProduct.get(product.id) ?? [];
        const productListings = productVariants.flatMap(
          (variant) => listingsByVariant.get(variant.id) ?? [],
        );

        const totalStock = productInventory.reduce(
          (sum, stockRow) => sum + (stockRow.total_stock ?? 0),
          0,
        );

        const ebayListing = productListings.find((listing) => listing.channel === "ebay");
        const squarespaceListing = productListings.find(
          (listing) => listing.channel === "squarespace",
        );

        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          cost_price: product.cost_price,
          status: product.status,
          total_stock: totalStock,
          ebay_price: ebayListing?.channel_price ?? null,
          squarespace_price: squarespaceListing?.channel_price ?? null,
          variants: productVariants,
          inventory: productInventory,
          channel_listings: productListings,
        };
      });
    },
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      productId,
      variantId,
      updates,
    }: {
      productId: string;
      variantId?: string;
      updates: { cost_price?: number };
    }) => {
      const { error } = await supabase
        .from("products")
        .update(updates)
        .eq("id", productId);
      if (error) throw error;

      if (variantId) {
        await supabase
          .from("variants")
          .update({ needs_sync: true, updated_at: new Date().toISOString() })
          .eq("id", variantId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useUpdateChannelPrice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      listingId,
      variantId,
      price,
    }: {
      listingId: string;
      variantId: string;
      price: number;
    }) => {
      const { error } = await supabase
        .from("channel_listings")
        .update({ channel_price: price, updated_at: new Date().toISOString() })
        .eq("id", listingId);
      if (error) throw error;

      await supabase
        .from("variants")
        .update({ needs_sync: true, updated_at: new Date().toISOString() })
        .eq("id", variantId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useUpdateInventory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      inventoryId,
      variantId,
      stock,
    }: {
      inventoryId: string;
      variantId: string;
      stock: number;
    }) => {
      const { error } = await supabase
        .from("inventory")
        .update({ total_stock: stock })
        .eq("id", inventoryId);
      if (error) throw error;

      await supabase
        .from("variants")
        .update({ needs_sync: true, updated_at: new Date().toISOString() })
        .eq("id", variantId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}
