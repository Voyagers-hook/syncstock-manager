import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SellSimilarResult {
  status: "ok" | "ended_not_relisted" | "end_failed" | "error";
  oldItemId?: string;
  newItemId?: string;
  relinked?: number;
  error?: string;
}

// Re-list an eBay item (Sell Similar) to refresh its 30-day visibility. The edge
// function ends the old listing, re-lists a faithful copy (new ItemID) and re-links
// the tracker onto the new ItemID — keeping the same variant, so the Squarespace
// merge, stock, cost and history all carry over.
//
// mode "relist_only" retries a listing that was already ended but failed to relist.
export function useSellSimilar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, mode }: { itemId: string; mode?: "relist_only" }): Promise<SellSimilarResult> => {
      const { data, error } = await supabase.functions.invoke("ebay-sell-similar", {
        body: mode ? { itemId, mode } : { itemId },
      });
      if (error) {
        let msg = error.message;
        let payload: any = null;
        try {
          const ctx = (error as any).context;
          if (ctx && typeof ctx.json === "function") payload = await ctx.json();
        } catch { /* keep */ }
        if (payload?.status) return payload as SellSimilarResult;
        if (payload?.error) msg = payload.error;
        return { status: "error", error: msg };
      }
      return (data ?? { status: "error", error: "No response" }) as SellSimilarResult;
    },
    onSuccess: (res) => {
      if (res.status === "ok") {
        queryClient.invalidateQueries({ queryKey: ["products"] });
        queryClient.invalidateQueries({ queryKey: ["orders-list"] });
      }
    },
  });
}
