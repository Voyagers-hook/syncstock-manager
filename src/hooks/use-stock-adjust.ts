import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface StockAdjustInput {
  inventoryId: string;
  variantId: string;
  productId: string;
  oldStock: number;
  newStock: number;
  reason: string;
  note?: string;
}

// Set a new stock figure for a single item, record WHY (reason + optional comment)
// in stock_log, then push the new figure to the other channel via the proven
// push-stock routine. This never touches any other item — no bulk operations.
export function useStockAdjust() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: StockAdjustInput) => {
      const now = new Date().toISOString();

      const { error: invErr } = await supabase
        .from("inventory")
        .update({ total_stock: input.newStock, updated_at: now })
        .eq("id", input.inventoryId);
      if (invErr) throw invErr;

      await (supabase as any).from("stock_log").insert({
        variant_id: input.variantId,
        product_id: input.productId,
        old_stock: input.oldStock,
        new_stock: input.newStock,
        delta: input.newStock - input.oldStock,
        source: "manual",
        reason: input.reason,
        note: input.note ?? null,
      });

      await supabase
        .from("variants")
        .update({ needs_sync: true, updated_at: now })
        .eq("id", input.variantId);

      const { data, error: pushErr } = await supabase.functions.invoke("push-stock", {
        body: { variantId: input.variantId, stock: input.newStock },
      });
      if (pushErr) {
        throw new Error(
          `Stock saved, but the push to the channels failed: ${pushErr.message}`,
        );
      }
      const failed = (data?.results ?? [])
        .filter((r: any) => r.status === "error")
        .map((r: any) => r.channel);
      if (failed.length) {
        throw new Error(`Stock saved, but failed to push to: ${failed.join(", ")}`);
      }
      return data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// Read the recent change history for one item (for the modal's "recent changes" list).
export function useStockHistory() {
  return useMutation({
    mutationFn: async (variantId: string) => {
      const { data } = await (supabase as any)
        .from("stock_log")
        .select("old_stock, new_stock, delta, source, reason, note, changed_at")
        .eq("variant_id", variantId)
        .order("changed_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
  });
}
