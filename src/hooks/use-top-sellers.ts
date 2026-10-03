import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface TopSeller {
  variant_key: string;
  item_name: string;
  sku: string | null;
  total_quantity: number;
  total_revenue: number;
  platforms: string[];
}

export interface TopSellersOptions {
  from?: string | null; // ISO date (inclusive)
  to?: string | null; // ISO date (exclusive)
  order?: "desc" | "asc"; // desc = best sellers, asc = worst sellers
}

export function useTopSellers(
  limit = 12,
  sortBy: "quantity" | "revenue" = "quantity",
  opts: TopSellersOptions = {},
) {
  const { from = null, to = null, order = "desc" } = opts;
  return useQuery({
    queryKey: ["top-sellers", limit, sortBy, from, to, order],
    queryFn: async (): Promise<TopSeller[]> => {
      let query = supabase
        .from("orders")
        .select("sku, item_name, quantity, unit_price, total_price, platform, ordered_at");
      if (from) query = query.gte("ordered_at", from);
      if (to) query = query.lt("ordered_at", to);
      const { data: orders, error: oErr } = await query;
      if (oErr) throw oErr;
      if (!orders?.length) return [];

      const agg = new Map<
        string,
        {
          variant_key: string;
          item_name: string;
          sku: string | null;
          total_quantity: number;
          total_revenue: number;
          platforms: Set<string>;
        }
      >();

      for (const o of orders) {
        const key = o.sku ? o.sku.trim() : (o.item_name ?? "unknown").trim();
        const qty = o.quantity ?? 0;
        const rev = o.total_price ?? (o.unit_price ?? 0) * qty;
        const existing = agg.get(key);
        if (existing) {
          existing.total_quantity += qty;
          existing.total_revenue += rev;
          existing.platforms.add(o.platform ?? "unknown");
        } else {
          agg.set(key, {
            variant_key: key,
            item_name: o.item_name ?? "Unknown",
            sku: o.sku ?? null,
            total_quantity: qty,
            total_revenue: rev,
            platforms: new Set([o.platform ?? "unknown"]),
          });
        }
      }

      const sorted = Array.from(agg.values()).sort((a, b) => {
        const diff =
          sortBy === "revenue"
            ? b.total_revenue - a.total_revenue
            : b.total_quantity - a.total_quantity;
        return order === "asc" ? -diff : diff;
      });

      return sorted.slice(0, limit).map((s) => ({
        variant_key: s.variant_key,
        item_name: s.item_name,
        sku: s.sku,
        total_quantity: s.total_quantity,
        total_revenue: s.total_revenue,
        platforms: Array.from(s.platforms),
      }));
    },
  });
}
