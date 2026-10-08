import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SlowMover {
  variant_key: string;
  item_name: string;
  units: number;
  stock: number;
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

// Items you're holding stock in, ranked by FEWEST sold over the period (including
// zero). This is "what isn't selling" — the slow movers tying up stock — as opposed
// to top sellers. Zero-sellers are ranked worst, with the most stock sitting first.
export function useSlowMovers(fromISO: string | null, limit = 8) {
  return useQuery({
    queryKey: ["slow-movers", fromISO, limit],
    queryFn: async (): Promise<SlowMover[]> => {
      const [orders, listings, variants, inventory, products] = await Promise.all([
        pageAll<any>((f, t) => {
          let q = supabase.from("orders").select("sku, platform, quantity, ordered_at, product_id").range(f, t);
          if (fromISO) q = q.gte("ordered_at", fromISO);
          return q;
        }),
        pageAll<any>((f, t) => supabase.from("channel_listings").select("variant_id, channel, channel_sku, channel_variant_id").range(f, t)),
        pageAll<any>((f, t) => supabase.from("variants").select("id, product_id, option1, option2").range(f, t)),
        pageAll<any>((f, t) => supabase.from("inventory").select("variant_id, total_stock").range(f, t)),
        pageAll<any>((f, t) => supabase.from("products").select("id, name, active").range(f, t)),
      ]);

      const productName = new Map<string, string>();
      const activeProduct = new Map<string, boolean>();
      for (const p of products) { productName.set(p.id, p.name); activeProduct.set(p.id, p.active); }
      const index = new Map<string, string>();
      for (const l of listings) {
        if (l.channel_sku) index.set(`${l.channel}|${l.channel_sku}`, l.variant_id);
        if (l.channel_variant_id) index.set(`${l.channel}|${l.channel_variant_id}`, l.variant_id);
      }
      const unitsByVariant: Record<string, number> = {};
      for (const o of orders) {
        const vid = index.get(`${o.platform}|${o.sku}`);
        if (vid) unitsByVariant[vid] = (unitsByVariant[vid] ?? 0) + (o.quantity ?? 0);
      }
      const stockByVariant = new Map<string, number>();
      for (const i of inventory) stockByVariant.set(i.variant_id, i.total_stock ?? 0);

      const rows: SlowMover[] = [];
      for (const v of variants) {
        if (!activeProduct.get(v.product_id)) continue;
        const stock = stockByVariant.get(v.id) ?? 0;
        if (stock <= 0) continue; // only things actually sitting in stock
        const opt = [v.option1, v.option2].filter(Boolean).join(" / ");
        const base = productName.get(v.product_id) ?? "Unknown";
        rows.push({ variant_key: v.id, item_name: opt ? `${base} — ${opt}` : base, units: unitsByVariant[v.id] ?? 0, stock });
      }
      // Fewest sold first; break ties by most stock sitting.
      rows.sort((a, b) => (a.units - b.units) || (b.stock - a.stock));
      return rows.slice(0, limit);
    },
  });
}
