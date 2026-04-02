import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface UnmergedProduct {
  id: string;
  name: string;
  sku: string | null;
  channel: "ebay" | "squarespace";
  channel_price: number | null;
  channel_product_id: string | null;
  variant_id: string;
  listing_id: string;
}

export interface MergeAction {
  kept_product_id: string;
  removed_product_id: string;
  moved_variant_ids: string[];
  moved_listing_ids: string[];
  moved_inventory_ids: string[];
  timestamp: string;
}

export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async (): Promise<UnmergedProduct[]> => {
      // Get all products with their channel listings
      const { data: products, error: pErr } = await supabase
        .from("products")
        .select("id, name, sku")
        .eq("active", true)
        .order("name");
      if (pErr) throw pErr;
      if (!products?.length) return [];

      const productIds = products.map((p) => p.id);

      const [varRes, listRes] = await Promise.all([
        supabase.from("variants").select("id, product_id").in("product_id", productIds),
        supabase.from("channel_listings").select("id, variant_id, channel, channel_price, channel_product_id"),
      ]);

      const variants = varRes.data ?? [];
      const listings = listRes.data ?? [];

      // Find products that only appear on ONE channel
      const productChannels = new Map<string, Set<string>>();
      const productListingInfo = new Map<string, UnmergedProduct[]>();

      for (const product of products) {
        const prodVariants = variants.filter((v) => v.product_id === product.id);
        const prodVariantIds = prodVariants.map((v) => v.id);
        const prodListings = listings.filter((l) => prodVariantIds.includes(l.variant_id));

        const channels = new Set(prodListings.map((l) => l.channel));
        productChannels.set(product.id, channels);

        // Only include products on exactly one channel (candidates for merging)
        if (channels.size === 1) {
          const channel = [...channels][0] as "ebay" | "squarespace";
          const listing = prodListings[0];
          if (listing && prodVariants[0]) {
            if (!productListingInfo.has(product.id)) {
              productListingInfo.set(product.id, []);
            }
            productListingInfo.get(product.id)!.push({
              id: product.id,
              name: product.name,
              sku: product.sku,
              channel,
              channel_price: listing.channel_price,
              channel_product_id: listing.channel_product_id,
              variant_id: prodVariants[0].id,
              listing_id: listing.id,
            });
          }
        }
      }

      return Array.from(productListingInfo.values()).flat();
    },
  });
}

export function useMergeProducts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      keepId,
      removeId,
    }: {
      keepId: string;
      removeId: string;
    }) => {
      // Move all variants from removeId to keepId
      const { data: movedVariants } = await supabase
        .from("variants")
        .select("id")
        .eq("product_id", removeId);

      const variantIds = (movedVariants ?? []).map((v) => v.id);

      // Move variants
      const { error: vErr } = await supabase
        .from("variants")
        .update({ product_id: keepId, updated_at: new Date().toISOString() })
        .eq("product_id", removeId);
      if (vErr) throw vErr;

      // Move inventory
      const { data: movedInv } = await supabase
        .from("inventory")
        .select("id")
        .eq("product_id", removeId);

      const { error: iErr } = await supabase
        .from("inventory")
        .update({ product_id: keepId })
        .eq("product_id", removeId);
      if (iErr) throw iErr;

      // Deactivate the removed product
      const { error: dErr } = await supabase
        .from("products")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", removeId);
      if (dErr) throw dErr;

      // Store undo info in localStorage
      const action: MergeAction = {
        kept_product_id: keepId,
        removed_product_id: removeId,
        moved_variant_ids: variantIds,
        moved_listing_ids: [], // listings follow variants
        moved_inventory_ids: (movedInv ?? []).map((i) => i.id),
        timestamp: new Date().toISOString(),
      };

      const history = JSON.parse(localStorage.getItem("merge_history") || "[]");
      history.push(action);
      localStorage.setItem("merge_history", JSON.stringify(history));

      return action;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Products merged successfully");
    },
    onError: () => {
      toast.error("Failed to merge products");
    },
  });
}

export function useUndoMerge() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const history: MergeAction[] = JSON.parse(
        localStorage.getItem("merge_history") || "[]"
      );
      const last = history.pop();
      if (!last) throw new Error("No merge to undo");

      // Move variants back
      if (last.moved_variant_ids.length) {
        await supabase
          .from("variants")
          .update({
            product_id: last.removed_product_id,
            updated_at: new Date().toISOString(),
          })
          .in("id", last.moved_variant_ids);
      }

      // Move inventory back
      if (last.moved_inventory_ids.length) {
        await supabase
          .from("inventory")
          .update({ product_id: last.removed_product_id })
          .in("id", last.moved_inventory_ids);
      }

      // Reactivate the removed product
      await supabase
        .from("products")
        .update({ active: true, updated_at: new Date().toISOString() })
        .eq("id", last.removed_product_id);

      localStorage.setItem("merge_history", JSON.stringify(history));
      return last;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Merge undone");
    },
    onError: () => {
      toast.error("Failed to undo merge");
    },
  });
}

export function useMergeHistory() {
  const [history, setHistory] = useState<MergeAction[]>(() =>
    JSON.parse(localStorage.getItem("merge_history") || "[]")
  );

  const refresh = () => {
    setHistory(JSON.parse(localStorage.getItem("merge_history") || "[]"));
  };

  return { history, refresh };
}
