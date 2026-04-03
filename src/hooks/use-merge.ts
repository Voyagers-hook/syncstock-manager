import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// ─── Product-level types (legacy, kept for backward compatibility) ────────────

export type UnmergedProduct = {
  id: string;
  name: string;
  sku: string | null;
  channel: string;
  channel_price: number | null;
  variant_id: string;
  listing_id: string;
};

// ─── Variant-level type (new) ─────────────────────────────────────────────────

export type UnmergedVariant = {
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_name: string;
  internal_sku: string | null;
  channel: string;
  channel_price: number | null;
  listing_id: string;
  channel_sku: string | null;
};

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Products that only have listings on ONE channel (unmerged at product level) */
export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async (): Promise<UnmergedProduct[]> => {
      const { data: products, error } = await supabase
        .from("products")
        .select("id, name, sku, variants(id, option1, option2, internal_sku, channel_listings(id, channel, channel_price, channel_variant_id))")
        .eq("active", true);

      if (error) throw error;
      if (!products) return [];

      return products
        .flatMap((p: any) => {
          const allListings: any[] = (p.variants ?? []).flatMap((v: any) => v.channel_listings ?? []);
          const channels = new Set(allListings.map((l: any) => l.channel));
          if (channels.size !== 1) return [];
          return [{
            id: p.id,
            name: p.name,
            sku: p.sku ?? null,
            channel: allListings[0]?.channel ?? "",
            channel_price: allListings[0]?.channel_price ?? null,
            variant_id: (p.variants ?? [])[0]?.id ?? "",
            listing_id: allListings[0]?.id ?? "",
          }];
        })
        .sort((a: UnmergedProduct, b: UnmergedProduct) => a.name.localeCompare(b.name));
    },
  });
}

/** All variants that have listings — grouped with parent product info, for variant-level merge */
export function useUnmergedVariants() {
  return useQuery({
    queryKey: ["unmerged-variants"],
    queryFn: async (): Promise<UnmergedVariant[]> => {
      const { data: listings, error } = await supabase
        .from("channel_listings")
        .select(`
          id,
          channel,
          channel_price,
          channel_sku,
          variant_id,
          variants(
            id,
            internal_sku,
            option1,
            option2,
            product_id,
            products(id, name, active)
          )
        `);

      if (error) throw error;
      if (!listings) return [];

      // Build a map: variant_id → set of channels
      const variantChannels = new Map<string, Set<string>>();
      for (const l of listings as any[]) {
        if (!l.variant_id) continue;
        if (!variantChannels.has(l.variant_id)) variantChannels.set(l.variant_id, new Set());
        variantChannels.get(l.variant_id)!.add(l.channel);
      }

      // Only return variants with listings on exactly ONE channel (unmerged)
      const results: UnmergedVariant[] = [];
      for (const l of listings as any[]) {
        const v = l.variants;
        if (!v) continue;
        const p = v.products;
        if (!p || p.active === false) continue;
        // Skip if this variant already has listings on both channels
        const channels = variantChannels.get(l.variant_id);
        if (!channels || channels.size !== 1) continue;

        const variantName = [v.option1, v.option2].filter(Boolean).join(" / ") || "(Default)";

        results.push({
          product_id: p.id,
          product_name: p.name,
          variant_id: v.id,
          variant_name: variantName,
          internal_sku: v.internal_sku ?? null,
          channel: l.channel,
          channel_price: l.channel_price ?? null,
          listing_id: l.id,
          channel_sku: l.channel_sku ?? null,
        });
      }

      return results.sort((a, b) => a.product_name.localeCompare(b.product_name));
    },
  });
}

// ─── Merge at PRODUCT level ───────────────────────────────────────────────────

export function useMergeProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ keepId, removeId }: { keepId: string; removeId: string }) => {
      const [{ data: removeVariants }, { data: keepVariants }] = await Promise.all([
        supabase.from("variants").select("*").eq("product_id", removeId),
        supabase.from("variants").select("*").eq("product_id", keepId),
      ]);

      if (!removeVariants || !keepVariants) throw new Error("Could not load variant data");

      for (const rv of removeVariants) {
        const match = keepVariants.find(
          (kv) => kv.option1 === rv.option1 && kv.option2 === rv.option2
        );

        if (match) {
          const { error: listErr } = await supabase
            .from("channel_listings")
            .update({ variant_id: match.id })
            .eq("variant_id", rv.id);
          if (listErr) throw listErr;

          await supabase.from("inventory").delete().eq("variant_id", rv.id);
          await supabase.from("variants").delete().eq("id", rv.id);
        } else {
          // No name match — reparent variant to the kept product
          await supabase.from("variants").update({ product_id: keepId }).eq("id", rv.id);
          await supabase.from("inventory").update({ product_id: keepId }).eq("variant_id", rv.id);
        }
      }

      await supabase.from("products").update({ active: false }).eq("id", removeId);
      await supabase.from("variants")
        .update({ needs_sync: true, updated_at: new Date().toISOString() })
        .eq("product_id", keepId);

      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Products merged! Both channels now share the same stock level.");
    },
    onError: (err: any) => toast.error(`Merge failed: ${err.message}`),
  });
}

// ─── Merge at VARIANT level (new) ─────────────────────────────────────────────

/**
 * Links a specific eBay variant with a specific Squarespace variant.
 * The Squarespace channel_listing is reassigned to point to the eBay variant_id.
 * The Squarespace variant (and its inventory) are deleted.
 * If the Squarespace product has no remaining variants, it is marked inactive.
 */
export function useMergeVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      keepVariantId,
      removeVariantId,
    }: {
      keepVariantId: string;  // eBay variant to keep
      removeVariantId: string; // Squarespace variant to absorb
    }) => {
      // Move the Squarespace channel_listing to the eBay variant
      const { error: listErr } = await supabase
        .from("channel_listings")
        .update({ variant_id: keepVariantId })
        .eq("variant_id", removeVariantId);
      if (listErr) throw listErr;

      // Get the product_id of the removed variant before deleting
      const { data: removedVariant } = await supabase
        .from("variants")
        .select("product_id")
        .eq("id", removeVariantId)
        .single();

      // Delete removed variant's inventory
      await supabase.from("inventory").delete().eq("variant_id", removeVariantId);

      // Delete the removed variant
      await supabase.from("variants").delete().eq("id", removeVariantId);

      // If that product now has no variants, mark it inactive
      if (removedVariant?.product_id) {
        const { data: remaining } = await supabase
          .from("variants")
          .select("id")
          .eq("product_id", removedVariant.product_id)
          .limit(1);

        if (!remaining || remaining.length === 0) {
          await supabase.from("products").update({ active: false }).eq("id", removedVariant.product_id);
        }
      }

      // Flag the kept variant for sync
      await supabase.from("variants")
        .update({ needs_sync: true, updated_at: new Date().toISOString() })
        .eq("id", keepVariantId);

      return { keepVariantId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Variants linked! They now share the same stock level.");
    },
    onError: (err: any) => toast.error(`Variant merge failed: ${err.message}`),
  });
}

// ─── Undo / History (stubs) ───────────────────────────────────────────────────

export function useUndoMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      toast.info("Undo is not yet supported. Re-import to restore original listings.");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
    },
  });
}

export function useMergeHistory() {
  return { history: [], refresh: () => {} };
}
