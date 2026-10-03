import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface CompetitorRow {
  id: string;
  variant_id: string;
  seller: string | null;
  item_price: number | null;
  postage: number | null;
  delivered: number | null;
  url: string | null;
  checked_at: string;
}

// Latest stored competitor delivered prices for one item (cheapest first).
export function useCompetitorPrices(variantId: string | null) {
  return useQuery({
    queryKey: ["competitor", variantId],
    enabled: !!variantId,
    queryFn: async (): Promise<CompetitorRow[]> => {
      if (!variantId) return [];
      const { data, error } = await (supabase as any)
        .from("competitor_prices")
        .select("*")
        .eq("variant_id", variantId)
        .order("delivered", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CompetitorRow[];
    },
  });
}

// Ask eBay (via the edge function) for current delivered prices for this item.
export function useRunCompetitorCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ variantId, query }: { variantId: string; query: string }) => {
      const { data, error } = await supabase.functions.invoke("competitor-price-check", {
        body: { variantId, query },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["competitor", vars.variantId] });
    },
    onError: (err: any) =>
      toast.error(`Competitor check failed: ${err.message ?? "unavailable"}`),
  });
}
