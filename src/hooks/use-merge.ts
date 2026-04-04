import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UnmergedProduct = {
  id: string;
  name: string;
  sku: string;
  channel: string;
  variant_id: string;
  listing_id: string;
};

export type UnmergedVariant = {
  variant_id: string;
  product_name: string;
  variant_name: string;
  channel_sku?: string | null;
  channel_price?: number | null;
  channel: string;
};

// ─── Product-level hooks ──────────────────────────────────────────────────────

export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async () => {
      // Fetch products with variants, then fetch listings per variant
      const { data: products } = await supabase
        .from("products")
        .select("*, variants(*)")
        .eq("active", true);
      if (!products) return [];

      const allVariantIds = products.flatMap((p: any) => (p.variants ?? []).map((v: any) => v.id));
      if (allVariantIds.length === 0) return [];

      // Fetch all channel_listings for these variants
      const { data: allListings } = await supabase
        .from("channel_listings")
        .select("*")
        .in("variant_id", allVariantIds);

      const listingsByProduct = new Map<string, any[]>();
      for (const l of (allListings ?? [])) {
        // Find which product this variant belongs to
        for (const p of products) {
          if ((p as any).variants?.some((v: any) => v.id === l.variant_id)) {
            const bucket = listingsByProduct.get(p.id) ?? [];
            bucket.push(l);
            listingsByProduct.set(p.id, bucket);
            break;
          }
        }
      }

      return products
        .filter((p: any) => {
          const listings = listingsByProduct.get(p.id) ?? [];
          return listings.length > 0 && new Set(listings.map((l: any) => l.channel)).size === 1;
        })
        .map((p: any) => {
          const listings = listingsByProduct.get(p.id) ?? [];
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            channel: listings[0]?.channel,
            variant_id: p.variants[0]?.id,
            listing_id: listings[0]?.id,
          };
        });
    },
  });
}

// ─── FIXED MERGE LOGIC v2 ────────────────────────────────────────────
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
      const { data: removeVariants } = await supabase
        .from("variants")
        .select("*")
        .eq("product_id", removeId);
      const { data: keepVariants } = await supabase
        .from("variants")
        .select("*")
        .eq("product_id", keepId);

      if (!removeVariants || !keepVariants) throw new Error("Missing data");

      for (const rv of removeVariants) {
        const match = keepVariants.find(
          (kv) =>
            (kv.option1 ?? null) === (rv.option1 ?? null) &&
            (kv.option2 ?? null) === (rv.option2 ?? null)
        );

        if (match) {
          await supabase
            .from("channel_listings")
            .update({ variant_id: match.id })
            .eq("variant_id", rv.id);

          await consolidateInventory(match.id, rv.id);

          await supabase.from("variants").delete().eq("id", rv.id);
        } else {
          await supabase
            .from("variants")
            .update({ product_id: keepId })
            .eq("id", rv.id);
        }
      }

      await supabase
        .from("products")
        .update({ active: false })
        .eq("id", removeId);
      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Merged successfully — stock consolidated!");
    },
  });
}

// ─── Variant-level hooks ──────────────────────────────────────────────────────

export function useUnmergedVariants() {
  return useQuery({
    queryKey: ["unmerged-variants"],
    queryFn: async () => {
      // Get all channel listings with variant + product info
      const { data: listings, error } = await supabase
        .from("channel_listings")
        .select(
          "variant_id, channel, channel_sku, channel_price, variants!inner(option1, option2, product_id, products!inner(name, active))"
        );

      if (error) throw error;
      if (!listings) return [];

      // Filter out inactive products
      const active = listings.filter(
        (l: any) => l.variants?.products?.active !== false
      );

      // Count how many channels each variant has
      const channelsByVariant = new Map<string, Set<string>>();
      for (const l of active) {
        const set = channelsByVariant.get(l.variant_id) ?? new Set();
        set.add(l.channel);
        channelsByVariant.set(l.variant_id, set);
      }

      // Only include variants with exactly 1 channel listing
      const unlinked = active.filter(
        (l: any) => (channelsByVariant.get(l.variant_id)?.size ?? 0) === 1
      );

      return unlinked.map((l: any) => {
        const v = l.variants;
        const optParts = [v?.option1, v?.option2].filter(Boolean);
        const variantName =
          optParts.length > 0 ? optParts.join(" / ") : "Default";
        return {
          variant_id: l.variant_id,
          product_name: v?.products?.name ?? "Unknown",
          variant_name: variantName,
          channel_sku: l.channel_sku,
          channel_price: l.channel_price,
          channel: l.channel,
        } as UnmergedVariant;
      });
    },
  });
}

export function useMergeVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      keepVariantId,
      removeVariantId,
    }: {
      keepVariantId: string;
      removeVariantId: string;
    }) => {
      // Move all channel_listings from removeVariantId → keepVariantId
      await supabase
        .from("channel_listings")
        .update({ variant_id: keepVariantId })
        .eq("variant_id", removeVariantId);

      // Consolidate inventory
      await consolidateInventory(keepVariantId, removeVariantId);

      // Delete the absorbed variant
      await supabase.from("variants").delete().eq("id", removeVariantId);

      return { keepVariantId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      toast.success("Variants linked — they now share the same inventory!");
    },
    onError: (err: any) => {
      toast.error(`Link failed: ${err.message}`);
    },
  });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function consolidateInventory(keepId: string, removeId: string) {
  const { data: keepInv } = await supabase
    .from("inventory")
    .select("*")
    .eq("variant_id", keepId)
    .maybeSingle();

  const { data: removeInv } = await supabase
    .from("inventory")
    .select("*")
    .eq("variant_id", removeId)
    .maybeSingle();

  if (removeInv && keepInv) {
    const maxStock = Math.max(
      keepInv.total_stock ?? 0,
      removeInv.total_stock ?? 0
    );
    await supabase
      .from("inventory")
      .update({ total_stock: maxStock })
      .eq("id", keepInv.id);
    await supabase.from("inventory").delete().eq("id", removeInv.id);
  } else if (removeInv && !keepInv) {
    await supabase
      .from("inventory")
      .update({ variant_id: keepId })
      .eq("id", removeInv.id);
  }
}

// Placeholders
export function useUndoMerge() {
  return useMutation({ mutationFn: async () => {} });
}
export function useMergeHistory() {
  return { history: [], refresh: () => {} };
}
