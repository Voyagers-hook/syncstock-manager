import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Fee assumptions (UK). Adjust here if eBay / Squarespace change their rates.
// eBay: final value fee on the whole order incl. postage, plus a per-order fixed fee.
// Squarespace: payment processing on the order total, plus a per-order fixed fee.
export const FEE_RATES = {
  ebay: { pct: 0.128, fixed: 0.3 },
  squarespace: { pct: 0.029, fixed: 0.3 },
};

export interface ProductSales {
  key: string;
  item_name: string;
  platform: string;
  quantity: number;
  turnover: number;
  fees: number;
  cogs: number;
  profit: number;
}

export interface SalesReport {
  turnover: number;
  ebayTurnover: number;
  sqTurnover: number;
  ebayFees: number;
  sqFees: number;
  totalFees: number;
  cogs: number;
  refunds: number;
  grossBeforePP: number;
  orderCount: number;
  unitsSold: number;
  products: ProductSales[];
}

function feeFor(platform: string, total: number) {
  const r = platform === "ebay" ? FEE_RATES.ebay : FEE_RATES.squarespace;
  return total > 0 ? total * r.pct + r.fixed : 0;
}

// Sales report for an explicit date range [start, end) as ISO strings.
export function useSalesReport(start: string, end: string) {
  return useQuery({
    queryKey: ["sales-report", start, end],
    queryFn: async (): Promise<SalesReport> => {
      const { data: orders } = await (supabase as any)
        .from("orders")
        .select("platform, product_id, sku, item_name, quantity, total_price, unit_price, ordered_at")
        .gte("ordered_at", start)
        .lt("ordered_at", end);

      const { data: refundRows } = await (supabase as any)
        .from("refunds")
        .select("amount, created_at")
        .gte("created_at", start)
        .lt("created_at", end);

      // Cost of goods: use each product's own variant costs (avg of set costs),
      // falling back to the product-level cost.
      const { data: variants } = await supabase
        .from("variants")
        .select("product_id, cost_price");
      const { data: products } = await supabase
        .from("products")
        .select("id, cost_price");

      const varCosts = new Map<string, number[]>();
      for (const v of variants ?? []) {
        if (typeof v.cost_price === "number" && v.cost_price > 0) {
          const b = varCosts.get(v.product_id) ?? [];
          b.push(v.cost_price);
          varCosts.set(v.product_id, b);
        }
      }
      const prodCost = new Map<string, number>();
      for (const p of products ?? []) {
        const vs = varCosts.get(p.id);
        if (vs && vs.length) prodCost.set(p.id, vs.reduce((a, b) => a + b, 0) / vs.length);
        else if (typeof p.cost_price === "number") prodCost.set(p.id, p.cost_price);
      }

      let turnover = 0,
        ebayTurnover = 0,
        sqTurnover = 0,
        ebayFees = 0,
        sqFees = 0,
        cogs = 0,
        unitsSold = 0;
      const byProduct = new Map<string, ProductSales>();

      for (const o of orders ?? []) {
        const qty = o.quantity ?? 0;
        const rev = o.total_price ?? (o.unit_price ?? 0) * qty;
        const platform = o.platform ?? "unknown";
        const fee = feeFor(platform, rev);
        const unitCost = o.product_id ? prodCost.get(o.product_id) ?? 0 : 0;
        const lineCost = unitCost * qty;

        turnover += rev;
        unitsSold += qty;
        cogs += lineCost;
        if (platform === "ebay") {
          ebayTurnover += rev;
          ebayFees += fee;
        } else if (platform === "squarespace") {
          sqTurnover += rev;
          sqFees += fee;
        }

        const key = `${o.item_name ?? o.sku ?? "Unknown"}::${platform}`;
        const row =
          byProduct.get(key) ??
          {
            key,
            item_name: o.item_name ?? o.sku ?? "Unknown",
            platform,
            quantity: 0,
            turnover: 0,
            fees: 0,
            cogs: 0,
            profit: 0,
          };
        row.quantity += qty;
        row.turnover += rev;
        row.fees += fee;
        row.cogs += lineCost;
        row.profit = row.turnover - row.fees - row.cogs;
        byProduct.set(key, row);
      }

      const refunds = (refundRows ?? []).reduce(
        (s: number, r: any) => s + (r.amount ?? 0),
        0,
      );
      const totalFees = ebayFees + sqFees;
      const grossBeforePP = turnover - totalFees - cogs - refunds;

      return {
        turnover,
        ebayTurnover,
        sqTurnover,
        ebayFees,
        sqFees,
        totalFees,
        cogs,
        refunds,
        grossBeforePP,
        orderCount: (orders ?? []).length,
        unitsSold,
        products: Array.from(byProduct.values()).sort((a, b) => b.turnover - a.turnover),
      };
    },
  });
}
