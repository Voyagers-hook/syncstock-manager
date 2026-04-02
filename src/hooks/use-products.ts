import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ProductWithDetails } from "@/lib/types";

export function useProducts(search: string = "") {
  return useQuery({
    queryKey: ["products", search],
    queryFn: async (): Promise<ProductWithDetails[]> => {
      // Fetch products
      let query = supabase
        .from("products")
        .select("*")
        .eq("active", true)
        .order("name");

      if (search) {
        query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
      }

      const { data: products, error: pErr } = await query;
      if (pErr) throw pErr;
      if (!products?.length) return [];

      const productIds = products.map((p) => p.id);

      // Fetch related data in parallel
      const [variantsRes, inventoryRes, listingsRes] = await Promise.all([
        supabase.from("variants").select("*").in("product_id", productIds),
        supabase.from("inventory").select("*").in("product_id", productIds),
        supabase.from("channel_listings").select("*"),
      ]);

      const variants = variantsRes.data ?? [];
      const inventory = inventoryRes.data ?? [];
      const listings = listingsRes.data ?? [];

      // Build variant→listings lookup
      const variantIds = variants.map((v) => v.id);
      const relevantListings = listings.filter((l) =>
        variantIds.includes(l.variant_id)
      );

      return products.map((product) => {
        const prodVariants = variants.filter(
          (v) => v.product_id === product.id
        );
        const prodInventory = inventory.filter(
          (i) => i.product_id === product.id
        );
        const prodVariantIds = prodVariants.map((v) => v.id);
        const prodListings = relevantListings.filter((l) =>
          prodVariantIds.includes(l.variant_id)
        );

        const totalStock = prodInventory.reduce(
          (sum, i) => sum + (i.total_stock ?? 0),
          0
        );

        const ebayListing = prodListings.find((l) => l.channel === "ebay");
        const sqspListing = prodListings.find(
          (l) => l.channel === "squarespace"
        );

        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          cost_price: product.cost_price,
          status: product.status,
          total_stock: totalStock,
          ebay_price: ebayListing?.channel_price ?? null,
          squarespace_price: sqspListing?.channel_price ?? null,
          variants: prodVariants,
          inventory: prodInventory,
          channel_listings: prodListings,
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

      // Mark variant as needing sync so the hourly job pushes changes
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

      // Mark variant as needing sync
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

      // Mark variant as needing sync
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
