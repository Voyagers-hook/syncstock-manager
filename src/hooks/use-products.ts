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
  table: string,
  column: string,
  ids: string[],
): Promise<T[]> {
  if (!ids.length) return [];

  const chunks = chunkArray(ids, FILTER_CHUNK_SIZE);
  const results = await Promise.all(
    chunks.map((chunk) =>
      fetchAllPages<T>(
        async (from, to) => {
          const resp = await (supabase as any)
            .from(table)
            .select("*")
            .in(column, chunk)
            .range(from, to);

          return { data: resp.data as T[] | null, error: resp.error };
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

      const rows = products
        .map((product) => {
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
        })
        .filter((product) => product.name.trim().length > 0);

      const dedupedProducts = new Map<string, ProductWithDetails>();

      for (const product of rows) {
        const key = product.name.trim().toLowerCase();
        const existing = dedupedProducts.get(key);

        if (!existing) {
          dedupedProducts.set(key, product);
        } else {
          // Two DB rows with the same product name (e.g. one eBay, one Squarespace
          // not yet fully merged). Combine their data so the dashboard shows a
          // single unified row rather than silently discarding one of them.
          const combined: ProductWithDetails = {
            ...existing,
            total_stock: existing.total_stock + product.total_stock,
            ebay_price: existing.ebay_price ?? product.ebay_price,
            squarespace_price: existing.squarespace_price ?? product.squarespace_price,
            channel_listings: [
              ...existing.channel_listings,
              ...product.channel_listings.filter(
                (l) => !existing.channel_listings.some((el) => el.id === l.id),
              ),
            ],
            variants: [
              ...existing.variants,
              ...product.variants.filter(
                (v) => !existing.variants.some((ev) => ev.id === v.id),
              ),
            ],
            inventory: [
              ...existing.inventory,
              ...product.inventory.filter(
                (i) => !existing.inventory.some((ei) => ei.id === i.id),
              ),
            ],
          };
          dedupedProducts.set(key, combined);
        }
      }

      return Array.from(dedupedProducts.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
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
      channel,
    }: {
      listingId: string;
      variantId: string;
      price: number;
      channel: string;
    }) => {
      // 1. Read the current price so we can roll back on push failure
      const { data: currentRow, error: readError } = await supabase
        .from("channel_listings")
        .select("channel_price")
        .eq("id", listingId)
        .single();
      if (readError) {
        console.warn("Could not read previous price for rollback:", readError.message);
      }
      const previousPrice = currentRow?.channel_price ?? null;

      // 2. Save price to DB
      const { error } = await supabase
        .from("channel_listings")
        .update({ channel_price: price, updated_at: new Date().toISOString() })
        .eq("id", listingId);
      if (error) throw error;

      await supabase
        .from("variants")
        .update({ needs_sync: false, updated_at: new Date().toISOString() })
        .eq("id", variantId);

      // 3. Push price only to the specific channel being edited
      const { data, error: pushError } = await supabase.functions.invoke("push-stock", {
        body: { variantId, price, channel },
      });

      const pushFailed =
        pushError ||
        (data?.results ?? []).some((r: any) => r.status === "error");

      if (pushFailed) {
        // Roll back DB price to the previous value so the dashboard stays in sync.
        // Only attempt rollback if we successfully read the previous price.
        if (!readError) {
          const { error: rollbackError } = await supabase
            .from("channel_listings")
            .update({ channel_price: previousPrice, updated_at: new Date().toISOString() })
            .eq("id", listingId);
          if (rollbackError) {
            console.warn("Price rollback failed:", rollbackError.message);
          }
        }

        if (pushError) {
          console.warn("push-stock price error:", pushError.message);
          throw new Error(`Failed to push price to ${channel}: ${pushError.message}`);
        }

        const failedChannels = (data?.results ?? [])
          .filter((r: any) => r.status === "error")
          .map((r: any) => `${r.channel}: ${r.message ?? "unknown error"}`);
        throw new Error(`Push failed — ${failedChannels.join("; ")}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (productId: string) => {
      // Delete related rows first (no FK constraints but clean up)
      const { data: variants } = await supabase
        .from("variants")
        .select("id")
        .eq("product_id", productId);

      if (variants?.length) {
        const variantIds = variants.map((v) => v.id);
        await supabase.from("channel_listings").delete().in("variant_id", variantIds);
        await supabase.from("variants").delete().eq("product_id", productId);
      }

      await supabase.from("inventory").delete().eq("product_id", productId);
      const { error } = await supabase.from("products").delete().eq("id", productId);
      if (error) throw error;
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
      const updatedAt = new Date().toISOString();

      const { error } = await supabase
        .from("inventory")
        .update({ total_stock: stock, updated_at: updatedAt })
        .eq("id", inventoryId);
      if (error) throw error;

      const { error: variantError } = await supabase
        .from("variants")
        .update({ needs_sync: true, updated_at: updatedAt })
        .eq("id", variantId);
      if (variantError) throw variantError;

      const { data, error: syncError } = await supabase.functions.invoke("push-stock", {
        body: { variantId, stock },
      });

      if (syncError) {
        console.warn("push-stock network error:", syncError.message);
        return { pushError: syncError.message };
      }

      const failedChannels = (data?.results ?? [])
        .filter((r: any) => r.status === "error")
        .map((r: any) => r.channel);

      if (failedChannels.length > 0) {
        throw new Error(`Stock saved locally but failed to push to: ${failedChannels.join(", ")}. ${data.results.find((r: any) => r.status === "error")?.message ?? ""}`);
      }

      return data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useCreateInventory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      variantId,
      productId,
      stock,
    }: {
      variantId: string;
      productId: string;
      stock: number;
    }) => {
      const { data, error } = await supabase
        .from("inventory")
        .insert({ variant_id: variantId, product_id: productId, total_stock: stock })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

