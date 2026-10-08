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

async function pageAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
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
      // Orders in range (paginated — the old 1000-row cap silently dropped data).
      const orders = await pageAll<any>((f, t) => {
        let q = supabase
          .from("orders")
          .select("sku, item_name, quantity, unit_price, total_price, platform, ordered_at, product_id")
          .range(f, t);
        if (from) q = q.gte("ordered_at", from);
        if (to) q = q.lt("ordered_at", to);
        return q;
      });
      if (!orders.length) return [];

      // Build a resolver so a merged item's sales combine across channels: map each
      // (channel + the id eBay/Squarespace sends) to the shared variant, and label
      // that variant with its product name + option.
      const [listings, variants, products] = await Promise.all([
        pageAll<any>((f, t) => supabase.from("channel_listings").select("variant_id, channel, channel_sku, channel_variant_id").range(f, t)),
        pageAll<any>((f, t) => supabase.from("variants").select("id, product_id, option1, option2").range(f, t)),
        pageAll<any>((f, t) => supabase.from("products").select("id, name").range(f, t)),
      ]);
      const productName = new Map<string, string>();
      for (const p of products) productName.set(p.id, p.name);
      const vlabel = new Map<string, string>();
      for (const v of variants) {
        const opt = [v.option1, v.option2].filter(Boolean).join(" / ");
        const base = productName.get(v.product_id) ?? "Unknown";
        vlabel.set(v.id, opt ? `${base} — ${opt}` : base);
      }
      const index = new Map<string, string>(); // channel|id -> variant_id
      for (const l of listings) {
        if (l.channel_sku) index.set(`${l.channel}|${l.channel_sku}`, l.variant_id);
        if (l.channel_variant_id) index.set(`${l.channel}|${l.channel_variant_id}`, l.variant_id);
      }
      const resolve = (o: any): { key: string; name: string } => {
        const vid = index.get(`${o.platform}|${o.sku}`);
        if (vid) return { key: vid, name: vlabel.get(vid) ?? o.item_name ?? "Unknown" };
        return { key: `${o.product_id ?? "np"}::${o.sku ?? o.item_name ?? "?"}`, name: o.item_name ?? "Unknown" };
      };

      const agg = new Map<string, { variant_key: string; item_name: string; sku: string | null; total_quantity: number; total_revenue: number; platforms: Set<string> }>();
      for (const o of orders) {
        const r = resolve(o);
        const qty = o.quantity ?? 0;
        const rev = o.total_price ?? (o.unit_price ?? 0) * qty;
        const existing = agg.get(r.key);
        if (existing) {
          existing.total_quantity += qty;
          existing.total_revenue += rev;
          existing.platforms.add(o.platform ?? "unknown");
        } else {
          agg.set(r.key, { variant_key: r.key, item_name: r.name, sku: o.sku ?? null, total_quantity: qty, total_revenue: rev, platforms: new Set([o.platform ?? "unknown"]) });
        }
      }

      const sorted = Array.from(agg.values()).sort((a, b) => {
        const diff = sortBy === "revenue" ? b.total_revenue - a.total_revenue : b.total_quantity - a.total_quantity;
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
