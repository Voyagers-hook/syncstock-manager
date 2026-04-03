import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// This makes sure the "Unmerged" list still works
export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async () => {
      const { data: products } = await supabase.from("products").select("*, variants(*), channel_listings(*)").eq("active", true);
      if (!products) return [];
      return products.filter(p => new Set(p.channel_listings.map((l: any) => l.channel)).size === 1).map((p: any) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        channel: p.channel_listings[0]?.channel,
        variant_id: p.variants[0]?.id,
        listing_id: p.channel_listings[0]?.id,
      }));
    }
  });
}

// FIXED MERGE LOGIC
// - Uses MAX(keep_stock, remove_stock) so no stock is ever lost
// - Moves inventory product_id when carrying over unmatched variants
export function useMergeProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ keepId, removeId }: { keepId: string; removeId: string }) => {
      const { data: removeVariants } = await supabase.from("variants").select("*").eq("product_id", removeId);
      const { data: keepVariants } = await supabase.from("variants").select("*").eq("product_id", keepId);

      if (!removeVariants || !keepVariants) throw new Error("Missing variant data");

      for (const rv of removeVariants) {
        const match = keepVariants.find(
          kv => kv.option1 === rv.option1 && kv.option2 === rv.option2
        );

        if (match) {
          // ── Fetch both inventory rows ──────────────────────────────────────
          const { data: keepInv } = await supabase
            .from("inventory")
            .select("id, total_stock")
            .eq("variant_id", match.id)
            .maybeSingle();

          const { data: removeInv } = await supabase
            .from("inventory")
            .select("id, total_stock")
            .eq("variant_id", rv.id)
            .maybeSingle();

          // ── Set final stock to MAX of both (same physical items) ───────────
          const finalStock = Math.max(keepInv?.total_stock ?? 0, removeInv?.total_stock ?? 0);

          if (keepInv) {
            // Update kept variant's inventory to the correct MAX stock
            await supabase
              .from("inventory")
              .update({ total_stock: finalStock })
              .eq("id", keepInv.id);

            // Delete the duplicate inventory row for the removed variant
            if (removeInv) {
              await supabase.from("inventory").delete().eq("id", removeInv.id);
            }
          } else if (removeInv) {
            // Kept variant had no inventory row — move the removed one across
            await supabase
              .from("inventory")
              .update({ variant_id: match.id, product_id: keepId, total_stock: finalStock })
              .eq("id", removeInv.id);
          }

          // Move channel listings to the kept variant
          await supabase
            .from("channel_listings")
            .update({ variant_id: match.id })
            .eq("variant_id", rv.id);

          // Delete the now-redundant removed variant (cascade will clean any remaining inventory)
          await supabase.from("variants").delete().eq("id", rv.id);

        } else {
          // No matching variant in keep product — move this variant over wholesale
          await supabase
            .from("variants")
            .update({ product_id: keepId })
            .eq("id", rv.id);

          // Keep inventory consistent by updating its product_id too
          await supabase
            .from("inventory")
            .update({ product_id: keepId })
            .eq("variant_id", rv.id);
        }
      }

      // Deactivate the removed product
      await supabase.from("products").update({ active: false }).eq("id", removeId);

      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Merged successfully!");
    },
    onError: (err: any) => {
      toast.error(`Merge failed: ${err.message}`);
    },
  });
}

// Placeholders so the rest of the app doesn't crash
export function useUndoMerge() { return useMutation({ mutationFn: async () => {} }); }
export function useMergeHistory() { return { history: [], refresh: () => {} }; }
