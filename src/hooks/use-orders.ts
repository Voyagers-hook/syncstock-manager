import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface OrderRow {
  id: string;
  platform: string;
  platform_order_id: string;
  order_number: string | null;
  product_id: string | null;
  sku: string | null;
  item_name: string | null;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  status: string | null;
  fulfillment_status: string | null;
  tracking_number: string | null;
  customer_name: string | null;
  ordered_at: string | null;
}

// Pull every order line, newest first. Orders are the record of truth, so the
// page reads them directly rather than through any cached aggregate.
export function useOrders() {
  return useQuery({
    queryKey: ["orders-list"],
    queryFn: async (): Promise<OrderRow[]> => {
      const all: OrderRow[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await (supabase as any)
          .from("orders")
          .select(
            "id, platform, platform_order_id, order_number, product_id, sku, item_name, quantity, unit_price, total_price, status, fulfillment_status, tracking_number, customer_name, ordered_at",
          )
          .order("ordered_at", { ascending: false })
          .range(from, from + 999);
        if (error) throw error;
        if (!data?.length) break;
        all.push(...(data as OrderRow[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      return all;
    },
  });
}
