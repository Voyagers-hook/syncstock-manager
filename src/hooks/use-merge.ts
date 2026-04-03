import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type UnmergedProduct = {
  id: string;
  name: string;
  sku: string | null;
  channel: string;
  channel_price: number | null;
  variant_id: string;
  listing_id: string;
};

// Returns products that only have listings on ONE channel (i.e. not yet merged)
export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async (): Promise<UnmergedProduct[]> => {
      // channel_listings has NO direct FK to products — must nest under variants
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
          // Only show if exactly one channel — meaning it hasn't been merged yet
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

// Merges two products: moves all channel_listings from removeId's variants onto keepId's variants
// matching by variant option values (size, colour, etc.)
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
        // Try to match by variant options (handles single-variant products where option1 is null)
        const match = keepVariants.find(
          (kv) => kv.option1 === rv.option1 && kv.option2 === rv.option2
        );

        if (match) {
          // Move channel_listings from the duplicate variant to the kept variant
          const { error: listErr } = await supabase
            .from("channel_listings")
            .update({ variant_id: match.id })
            .eq("variant_id", rv.id);
          if (listErr) throw listErr;

          // Delete duplicate inventory row and variant
          await supabase.from("inventory").delete().eq("variant_id", rv.id);
          await supabase.from("variants").delete().eq("id", rv.id);
        } else {
          // No matching variant — reparent the variant (and its inventory) to the kept product
          await supabase.from("variants").update({ product_id: keepId }).eq("id", rv.id);
          await supabase.from("inventory").update({ product_id: keepId }).eq("variant_id", rv.id);
        }
      }

      // Mark the removed product as inactive
      const { error: prodErr } = await supabase
        .from("products")
        .update({ active: false })
        .eq("id", removeId);
      if (prodErr) throw prodErr;

      // Flag merged variants for sync so push-stock fires on next interaction
      await supabase
        .from("variants")
        .update({ needs_sync: true, updated_at: new Date().toISOString() })
        .eq("product_id", keepId);

      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      toast.success("Merged! Both channels now share the same stock level.");
    },
    onError: (err: any) => {
      toast.error(`Merge failed: ${err.message}`);
    },
  });
}

export function useUndoMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // No-op for now — undoing a merge requires knowing what was merged
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
