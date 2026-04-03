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

// ─── FIXED MERGE LOGIC v2 ────────────────────────────────────────────
// Key fix: Before deleting removed variant inventory, ensure the kept
// variant actually HAS an inventory row.  If not, MOVE it instead of
// deleting it.  If both have inventory, use MAX (same physical stock).
export function useMergeProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ keepId, removeId }: { keepId: string; removeId: string }) => {
      const { data: removeVariants } = await supabase.from("variants").select("*").eq("product_id", removeId);
      const { data: keepVariants } = await supabase.from("variants").select("*").eq("product_id", keepId);

      if (!removeVariants || !keepVariants) throw new Error("Missing data");

      for (const rv of removeVariants) {
        // Try to find a matching variant on the kept product by option values
        // Also match null-to-null (two simple/single-variant products)
        const match = keepVariants.find(kv =>
          (kv.option1 ?? null) === (rv.option1 ?? null) &&
          (kv.option2 ?? null) === (rv.option2 ?? null)
        );

        if (match) {
          // ── 1. Move all channel_listings to the kept variant ──
          await supabase
            .from("channel_listings")
            .update({ variant_id: match.id })
            .eq("variant_id", rv.id);

          // ── 2. Consolidate inventory (the critical fix) ──
          const { data: keepInv } = await supabase
            .from("inventory")
            .select("*")
            .eq("variant_id", match.id)
            .maybeSingle();

          const { data: removeInv } = await supabase
            .from("inventory")
            .select("*")
            .eq("variant_id", rv.id)
            .maybeSingle();

          if (removeInv && keepInv) {
            // Both have inventory → keep the MAX value (same physical stock)
            const maxStock = Math.max(keepInv.stock ?? 0, removeInv.stock ?? 0);
            await supabase
              .from("inventory")
              .update({ stock: maxStock })
              .eq("id", keepInv.id);
            await supabase
              .from("inventory")
              .delete()
              .eq("id", removeInv.id);
          } else if (removeInv && !keepInv) {
            // Only the removed variant has inventory → MOVE it to kept variant
            await supabase
              .from("inventory")
              .update({ variant_id: match.id })
              .eq("id", removeInv.id);
          }
          // If only keepInv exists → already fine, nothing to do
          // If neither has inventory → nothing to move

          // ── 3. Delete the now-orphaned removed variant ──
          await supabase
            .from("variants")
            .delete()
            .eq("id", rv.id);
        } else {
          // No option-match → move variant + its inventory + its listings to kept product
          await supabase
            .from("variants")
            .update({ product_id: keepId })
            .eq("id", rv.id);
        }
      }

      // Deactivate the removed product
      await supabase.from("products").update({ active: false }).eq("id", removeId);
      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      toast.success("Merged successfully — stock consolidated!");
    }
  });
}

// Placeholders so the rest of the app doesn't crash
export function useUndoMerge() { return useMutation({ mutationFn: async () => {} }); }
export function useMergeHistory() { return { history: [], refresh: () => {} }; }
