import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface TopSeller {
  product_id: string;
  item_name: string;
  sku: string | null;
  total_quantity: number;
  total_revenue: number;
  avg_price: number;
  cost_price: number | null;
  total_stock: number;
  platforms: string[];
}

export function useTopSellers(limit = 20) {
  return useQuery({
    queryKey: ["top-sellers", limit],
    queryFn: async (): Promise<TopSeller[]> => {
      // Get orders grouped by product
      const { data: orders, error: oErr } = await supabase
        .from("orders")
        .select("product_id, sku, item_name, quantity, unit_price, total_price, platform")
        .not("product_id", "is", null);
      if (oErr) throw oErr;
      if (!orders?.length) return [];

      // Aggregate by product_id
      const agg = new Map<
        string,
        {
          product_id: string;
          item_name: string;
          sku: string | null;
          total_quantity: number;
          total_revenue: number;
          prices: number[];
          platforms: Set<string>;
        }
      >();

      for (const o of orders) {
        if (!o.product_id) continue;
        const existing = agg.get(o.product_id);
        if (existing) {
          existing.total_quantity += o.quantity ?? 0;
          existing.total_revenue += o.total_price ?? o.unit_price * (o.quantity ?? 1);
          existing.prices.push(o.unit_price);
          existing.platforms.add(o.platform);
        } else {
          agg.set(o.product_id, {
            product_id: o.product_id,
            item_name: o.item_name ?? "Unknown",
            sku: o.sku,
            total_quantity: o.quantity ?? 0,
            total_revenue: o.total_price ?? o.unit_price * (o.quantity ?? 1),
            prices: [o.unit_price],
            platforms: new Set([o.platform]),
          });
        }
      }

      // Sort by total_quantity desc, take top N
      const sorted = Array.from(agg.values())
        .sort((a, b) => b.total_quantity - a.total_quantity)
        .slice(0, limit);

      if (!sorted.length) return [];

      // Fetch cost_price and stock for these products
      const productIds = sorted.map((s) => s.product_id);
      const [prodRes, invRes] = await Promise.all([
        supabase.from("products").select("id, cost_price").in("id", productIds),
        supabase.from("inventory").select("product_id, total_stock").in("product_id", productIds),
      ]);

      const products = prodRes.data ?? [];
      const inventory = invRes.data ?? [];

      const costMap = new Map(products.map((p) => [p.id, p.cost_price]));
      const stockMap = new Map<string, number>();
      for (const inv of inventory) {
        stockMap.set(
          inv.product_id,
          (stockMap.get(inv.product_id) ?? 0) + (inv.total_stock ?? 0)
        );
      }

      return sorted.map((s) => ({
        product_id: s.product_id,
        item_name: s.item_name,
        sku: s.sku,
        total_quantity: s.total_quantity,
        total_revenue: s.total_revenue,
        avg_price: s.prices.reduce((a, b) => a + b, 0) / s.prices.length,
        cost_price: costMap.get(s.product_id) ?? null,
        total_stock: stockMap.get(s.product_id) ?? 0,
        platforms: Array.from(s.platforms),
      }));
    },
  });
}
