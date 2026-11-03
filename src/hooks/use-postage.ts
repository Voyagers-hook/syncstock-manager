import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PostageItem { date: string; amount: number; reference: string; memo: string }
export interface CarrierSummary {
  connected: boolean;
  total: number;
  count?: number;
  items?: PostageItem[];
  note?: string;
}
export interface PostageSummary {
  ok: boolean;
  start: string;
  end: string;
  grandTotal: number;
  carriers: {
    ebay: CarrierSummary;
    sendcloud: CarrierSummary;
    parcel2go: CarrierSummary;
    dpd: CarrierSummary;
  };
}

// Pull postage spend per carrier for a date range. eBay is exact (signed Finances API);
// other carriers report connected:false until their API key is added.
export function usePostage(start: string, end: string) {
  return useQuery({
    queryKey: ["postage", start, end],
    queryFn: async (): Promise<PostageSummary> => {
      const { data, error } = await supabase.functions.invoke("postage-summary", { body: { start, end } });
      if (error) {
        let msg = error.message;
        try {
          const ctx = (error as any).context;
          if (ctx && typeof ctx.json === "function") { const j = await ctx.json(); if (j?.error) msg = j.error; }
        } catch { /* keep */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data as PostageSummary;
    },
    staleTime: 5 * 60 * 1000,
  });
}
