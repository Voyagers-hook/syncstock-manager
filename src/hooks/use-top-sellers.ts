import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface TopSeller {
  product_id: string;
  item_name: string;
  sku: string | null;
  total_quantity: number;
  total_revenue: number;
  platforms: string[];
}

export function useTopSellers(limit = 12) {
  return useQuery({
    queryKey: ["top-sellers", limit],
    queryFn: async (): Promise<TopSeller[]> => {
      const { data: orders, error: oErr } = await supabase
        .from("orders")
        .select("product_id, sku, item_name, quantity, unit_price, total_price, platform")
        .not("product_id", "is", null);
      if (oErr) throw oErr;
      if (!orders?.length) return [];

      const agg = new Map<
        string,
        {
          product_id: string;
          item_name: string;
          sku: string | null;
          total_quantity: number;
          total_revenue: number;
          platforms: Set<string>;
        }
      >();

      for (const o of orders) {
        if (!o.product_id) continue;
        const existing = agg.get(o.product_id);
        if (existing) {
          existing.total_quantity += o.quantity ?? 0;
          existing.total_revenue += o.total_price ?? o.unit_price * (o.quantity ?? 1);
          existing.platforms.add(o.platform);
        } else {
          agg.set(o.product_id, {
            product_id: o.product_id,
            item_name: o.item_name ?? "Unknown",
            sku: o.sku,
            total_quantity: o.quantity ?? 0,
            total_revenue: o.total_price ?? o.unit_price * (o.quantity ?? 1),
            platforms: new Set([o.platform]),
          });
        }
      }

      return Array.from(agg.values())
        .sort((a, b) => b.total_quantity - a.total_quantity)
        .slice(0, limit)
        .map((s) => ({
          product_id: s.product_id,
          item_name: s.item_name,
          sku: s.sku,
          total_quantity: s.total_quantity,
          total_revenue: s.total_revenue,
          platforms: Array.from(s.platforms),
        }));
    },
  });
}
