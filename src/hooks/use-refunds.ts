import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface RefundRow {
  id: string;
  platform: string;
  order_id: string;
  order_number: string | null;
  variant_id: string | null;
  product_id: string | null;
  item_name: string | null;
  amount: number | null;
  reason: string | null;
  restocked: boolean;
  note: string | null;
  created_at: string;
}

export function useRefunds() {
  return useQuery({
    queryKey: ["refunds-list"],
    queryFn: async (): Promise<RefundRow[]> => {
      const { data, error } = await (supabase as any)
        .from("refunds")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as RefundRow[];
    },
  });
}

export interface CreateRefundInput {
  platform: string;
  orderId: string;
  orderNumber?: string | null;
  variantId?: string | null;
  productId?: string | null;
  sku?: string | null;
  itemName?: string | null;
  amount: number;
  reason: string;
  note?: string;
  quantity: number;
  restock: boolean; // true = back to stock, false = write-off
}

// Work out which variant a returned order line belongs to, so stock goes back on
// the right item. Prefer an explicit variant; otherwise match the order's SKU to a
// listing, or fall back to the product's only variant.
async function resolveVariantId(input: CreateRefundInput): Promise<string | null> {
  if (input.variantId) return input.variantId;
  if (!input.productId) return null;
  const { data: variants } = await supabase
    .from("variants")
    .select("id")
    .eq("product_id", input.productId);
  if (!variants?.length) return null;
  if (variants.length === 1) return variants[0].id;
  if (input.sku) {
    const ids = variants.map((v) => v.id);
    const { data: listings } = await supabase
      .from("channel_listings")
      .select("variant_id, channel_sku, channel_variant_id")
      .in("variant_id", ids);
    const match = (listings ?? []).find(
      (l: any) => l.channel_sku === input.sku || l.channel_variant_id === input.sku,
    );
    if (match) return match.variant_id;
  }
  return null;
}

// Record a refund/return. If the goods come back in sellable condition we add the
// quantity back to stock and push it to the channels; a write-off records the money
// lost without touching stock.
export function useCreateRefund() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateRefundInput) => {
      const variantId = input.restock ? await resolveVariantId(input) : input.variantId ?? null;

      const { error } = await (supabase as any).from("refunds").insert({
        platform: input.platform,
        order_id: input.orderId,
        order_number: input.orderNumber ?? null,
        variant_id: variantId,
        product_id: input.productId ?? null,
        item_name: input.itemName ?? null,
        amount: input.amount,
        reason: input.reason,
        restocked: input.restock,
        note: input.note ?? null,
      });
      if (error) throw error;

      if (input.restock && variantId) {
        const { data: inv } = await supabase
          .from("inventory")
          .select("id, total_stock, product_id")
          .eq("variant_id", variantId)
          .maybeSingle();
        if (inv) {
          const oldS = inv.total_stock ?? 0;
          const newS = oldS + input.quantity;
          await supabase
            .from("inventory")
            .update({ total_stock: newS, updated_at: new Date().toISOString() })
            .eq("id", inv.id);
          await (supabase as any).from("stock_log").insert({
            variant_id: variantId,
            product_id: inv.product_id,
            old_stock: oldS,
            new_stock: newS,
            delta: input.quantity,
            source: "return",
            reason: input.reason,
            note: `Return on order ${input.orderNumber ?? input.orderId}`,
          });
          await supabase.functions.invoke("push-stock", {
            body: { variantId, stock: newS },
          });
        }
      }
    },
    onSuccess: (_d, input) => {
      queryClient.invalidateQueries({ queryKey: ["refunds-list"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success(
        input.restock ? "Return recorded — stock added back." : "Refund recorded as a write-off.",
      );
    },
    onError: (err: any) => toast.error(`Could not record refund: ${err.message}`),
  });
}
