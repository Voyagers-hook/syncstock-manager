import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { chunkArray, fetchAllPages } from "@/lib/supabase-pagination";
import { toast } from "sonner";

const PAGE_SIZE = 1000;
const CHUNK_SIZE = 150;

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

async function fetchByIds<T>(
  table: "variants" | "channel_listings" | "inventory",
  column: string,
  ids: string[],
  select: string = "*",
): Promise<T[]> {
  if (!ids.length) return [];
  const chunks = chunkArray(ids, CHUNK_SIZE);
  const results = await Promise.all(
    chunks.map((chunk) =>
      fetchAllPages<T>(async (from, to) => {
        const resp = await supabase
          .from(table)
          .select(select)
          .in(column, chunk)
          .range(from, to);
        return { data: resp.data as unknown as T[] | null, error: resp.error };
      }, PAGE_SIZE),
    ),
  );
  return results.flat();
}

export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async (): Promise<UnmergedProduct[]> => {
      // Fetch all active products with pagination
      const products = await fetchAllPages<{ id: string; name: string; sku: string | null }>(
        async (from, to) => {
          const { data, error } = await supabase
            .from("products")
            .select("id, name, sku")
            .eq("active", true)
            .order("name")
            .range(from, to);
          return { data, error };
        },
        PAGE_SIZE,
      );
      if (!products.length) return [];

      const productIds = products.map((p) => p.id);

      // Fetch variants and listings with chunked queries
      const variants = await fetchByIds<{ id: string; product_id: string }>(
        "variants", "product_id", productIds, "id, product_id"
      );

      const variantIds = variants.map((v) => v.id);
      const listings = await fetchByIds<{
        id: string; variant_id: string; channel: string;
        channel_price: number | null; channel_product_id: string | null;
      }>(
        "channel_listings", "variant_id", variantIds,
        "id, variant_id, channel, channel_price, channel_product_id"
      );

      // Build lookup maps
      const variantsByProduct = new Map<string, typeof variants>();
      for (const v of variants) {
        const arr = variantsByProduct.get(v.product_id) ?? [];
        arr.push(v);
        variantsByProduct.set(v.product_id, arr);
      }

      const listingsByVariant = new Map<string, typeof listings>();
      for (const l of listings) {
        const arr = listingsByVariant.get(l.variant_id) ?? [];
        arr.push(l);
        listingsByVariant.set(l.variant_id, arr);
      }

      // Find products on exactly ONE channel
      const result: UnmergedProduct[] = [];
      for (const product of products) {
        const prodVariants = variantsByProduct.get(product.id) ?? [];
        const prodListings = prodVariants.flatMap(
          (v) => listingsByVariant.get(v.id) ?? []
        );

        const channels = new Set(prodListings.map((l) => l.channel));
        if (channels.size === 1) {
          const channel = [...channels][0] as "ebay" | "squarespace";
          const listing = prodListings[0];
          const variant = prodVariants[0];
          if (listing && variant) {
            result.push({
              id: product.id,
              name: product.name,
              sku: product.sku,
              channel,
              channel_price: listing.channel_price,
              channel_product_id: listing.channel_product_id,
              variant_id: variant.id,
              listing_id: listing.id,
            });
          }
        }
      }

      return result;
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
      const { data: movedVariants } = await supabase
        .from("variants")
        .select("id")
        .eq("product_id", removeId);

      const variantIds = (movedVariants ?? []).map((v) => v.id);

      const { error: vErr } = await supabase
        .from("variants")
        .update({ product_id: keepId, updated_at: new Date().toISOString() })
        .eq("product_id", removeId);
      if (vErr) throw vErr;

      const { data: movedInv } = await supabase
        .from("inventory")
        .select("id")
        .eq("product_id", removeId);

      const { error: iErr } = await supabase
        .from("inventory")
        .update({ product_id: keepId })
        .eq("product_id", removeId);
      if (iErr) throw iErr;

      const { error: dErr } = await supabase
        .from("products")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", removeId);
      if (dErr) throw dErr;

      const action: MergeAction = {
        kept_product_id: keepId,
        removed_product_id: removeId,
        moved_variant_ids: variantIds,
        moved_listing_ids: [],
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

      if (last.moved_variant_ids.length) {
        await supabase
          .from("variants")
          .update({
            product_id: last.removed_product_id,
            updated_at: new Date().toISOString(),
          })
          .in("id", last.moved_variant_ids);
      }

      if (last.moved_inventory_ids.length) {
        await supabase
          .from("inventory")
          .update({ product_id: last.removed_product_id })
          .in("id", last.moved_inventory_ids);
      }

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
