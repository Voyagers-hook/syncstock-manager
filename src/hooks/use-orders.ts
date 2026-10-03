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
  tracking_carrier: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_address_line1: string | null;
  shipping_address_line2: string | null;
  shipping_city: string | null;
  shipping_county: string | null;
  shipping_postcode: string | null;
  shipping_country: string | null;
  ordered_at: string | null;
}

// Normalise an order's dispatch status from the captured fulfilment field.
// Order matters: "undispatched" contains "dispatch", and "returned" must win first.
export function orderStatus(o: {
  fulfillment_status: string | null;
  status?: string | null;
}): "Dispatched" | "Undispatched" | "Returned" {
  const f = (o.fulfillment_status ?? "").toString().toLowerCase();
  if (f.includes("return")) return "Returned";
  if (f.startsWith("undispatch") || f === "pending" || f === "unfulfilled" || f === "not_fulfilled")
    return "Undispatched";
  if (f.includes("dispatch") || f.includes("fulfil") || f.includes("ship") || f.includes("complete"))
    return "Dispatched";
  return "Undispatched";
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
            "id, platform, platform_order_id, order_number, product_id, sku, item_name, quantity, unit_price, total_price, status, fulfillment_status, tracking_number, tracking_carrier, customer_name, customer_email, shipping_address_line1, shipping_address_line2, shipping_city, shipping_county, shipping_postcode, shipping_country, ordered_at",
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
