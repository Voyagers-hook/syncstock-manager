import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Push a cleaned title to eBay (ReviseItem — keeps the ItemID, so merge/stock/history
// are untouched) and update the tracker name.
export function useReviseTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, title }: { itemId: string; title: string }) => {
      const { data, error } = await supabase.functions.invoke("ebay-revise-title", { body: { itemId, title } });
      if (error) {
        let msg = error.message;
        try {
          const ctx = (error as any).context;
          if (ctx && typeof ctx.json === "function") { const j = await ctx.json(); if (j?.error) msg = j.error; }
        } catch { /* keep */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Title updated on eBay.");
    },
    onError: (e: any) => toast.error(`Could not update title: ${e.message}`),
  });
}
