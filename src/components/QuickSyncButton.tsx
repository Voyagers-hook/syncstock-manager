import { useState, useCallback } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

export function useQuickSync() {
  const [syncing, setSyncing] = useState(false);
  const queryClient = useQueryClient();

  const triggerSync = useCallback(async (mode: "quick" | "full" = "quick") => {
    if (syncing) return;
    setSyncing(true);

    const label = mode === "full" ? "Full Catalogue Reset" : "Quick Sync";

    try {
      toast.info(`${label} started — importing from eBay & Squarespace…`);

      // Call both import edge functions in parallel
      const [ebayResult, sqResult] = await Promise.all([
        supabase.functions.invoke("ebay-import", { body: { mode } }),
        supabase.functions.invoke("squarespace-import", { body: { mode } }),
      ]);

      const errors: string[] = [];
      let totalItems = 0;

      if (ebayResult.error) {
        errors.push(`eBay: ${ebayResult.error.message}`);
      } else {
        const d = ebayResult.data;
        totalItems += d?.total_ebay_items ?? 0;
        toast.success(
          `eBay: ${d?.total_ebay_items ?? 0} items found, ${d?.products_created ?? 0} new products created`
        );
      }

      if (sqResult.error) {
        errors.push(`Squarespace: ${sqResult.error.message}`);
      } else {
        const d = sqResult.data;
        totalItems += d?.total_squarespace_products ?? 0;
        toast.success(
          `Squarespace: ${d?.total_squarespace_products ?? 0} items found, ${d?.products_created ?? 0} new products created`
        );
      }

      if (errors.length) {
        toast.error(errors.join(". "));
      }

      // Refresh dashboard data
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
    } catch (err) {
      toast.error(`${label} failed — ${err instanceof Error ? err.message : "check your connection."}`);
    } finally {
      setSyncing(false);
    }
  }, [syncing, queryClient]);

  return { triggerSync, syncing };
}

interface QuickSyncButtonProps {
  variant?: "outline" | "default";
  size?: "sm" | "default";
}

export const QuickSyncButton = ({ variant = "outline", size = "sm" }: QuickSyncButtonProps) => {
  const { triggerSync, syncing } = useQuickSync();

  return (
    <Button variant={variant} size={size} onClick={() => triggerSync("quick")} disabled={syncing}>
      {syncing ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : (
        <RefreshCw className="w-4 h-4 mr-2" />
      )}
      {syncing ? "Syncing…" : "Quick Sync"}
    </Button>
  );
};
