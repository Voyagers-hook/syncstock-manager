import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface BestComp {
  delivered: number;
  count: number;
}

// One fetch of every stored competitor price, reduced to the cheapest delivered
// figure per variant. The inventory table uses this to show the ▲/▼/in-line chip
// without a separate call per row.
export function useCompetitorMap() {
  return useQuery({
    queryKey: ["competitor-map"],
    queryFn: async (): Promise<Record<string, BestComp>> => {
      const { data } = await (supabase as any)
        .from("competitor_prices")
        .select("variant_id, delivered");
      const map: Record<string, BestComp> = {};
      for (const r of data ?? []) {
        if (r.delivered === null || r.delivered === undefined) continue;
        const cur = map[r.variant_id];
        if (!cur) map[r.variant_id] = { delivered: r.delivered, count: 1 };
        else {
          cur.count += 1;
          if (r.delivered < cur.delivered) cur.delivered = r.delivered;
        }
      }
      return map;
    },
  });
}
