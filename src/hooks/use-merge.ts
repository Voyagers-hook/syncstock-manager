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

// THE FIXED MERGE LOGIC (No double stock)
export function useMergeProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ keepId, removeId }: { keepId: string; removeId: string }) => {
      const { data: removeVariants } = await supabase.from("variants").select("*").eq("product_id", removeId);
      const { data: keepVariants } = await supabase.from("variants").select("*").eq("product_id", keepId);
      
      if (!removeVariants || !keepVariants) throw new Error("Missing data");

      for (const rv of removeVariants) {
        const match = keepVariants.find(kv => kv.option1 === rv.option1 && kv.option2 === rv.option2);
        if (match) {
          await supabase.from("channel_listings").update({ variant_id: match.id }).eq("variant_id", rv.id);
          await supabase.from("inventory").delete().eq("variant_id", rv.id); // Delete duplicate stock
          await supabase.from("variants").delete().eq("id", rv.id);
        } else {
          await supabase.from("variants").update({ product_id: keepId }).eq("id", rv.id);
        }
      }
      await supabase.from("products").update({ active: false }).eq("id", removeId);
      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Merged successfully!");
    }
  });
}

// Placeholders so the rest of the app doesn't crash
export function useUndoMerge() { return useMutation({ mutationFn: async () => {} }); }
export function useMergeHistory() { return { history: [], refresh: () => {} }; }
