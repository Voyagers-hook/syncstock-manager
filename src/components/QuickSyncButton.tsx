import { useState, useCallback } from "react";
import { RefreshCw, Loader2, DatabaseZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

export function useQuickSync() {
  const [syncing, setSyncing] = useState(false);
  const queryClient = useQueryClient();

  const triggerSync = useCallback(async (mode: "quick" | "full" = "quick") => {
    setSyncing(true);
    const label = mode === "full" ? "Full Catalogue Reset" : "Quick Sync";

    try {
      toast.info(`${label} started…`);

      // Run both imports — the edge functions handle clearing when mode === "full"
      const [ebayRes, sqRes] = await Promise.all([
        supabase.functions.invoke("ebay-import", { body: { mode } }),
        supabase.functions.invoke("squarespace-import", { body: { mode } }),
      ]);

      const errors: string[] = [];
      if (ebayRes.error) errors.push(`eBay: ${ebayRes.error.message}`);
      if (sqRes.error)   errors.push(`Squarespace: ${sqRes.error.message}`);

      if (errors.length > 0) {
        errors.forEach(e => toast.error(e));
        toast.error(`${label} failed — check errors above`);
        return;
      }

      // Only reach here if both calls succeeded
      await queryClient.clear();
      await queryClient.invalidateQueries();

      const ebayCount = ebayRes.data?.imported ?? "?";
      const sqCount   = sqRes.data?.imported ?? "?";
      toast.success(`${label} complete! eBay: ${ebayCount} items, Squarespace: ${sqCount} items`);
    } catch (err: any) {
      toast.error(`${label} error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [queryClient]);

  return { triggerSync, syncing };
}

export const QuickSyncButton = () => {
  const { triggerSync, syncing } = useQuickSync();

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => triggerSync("quick")} disabled={syncing}>
        {syncing
          ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          : <RefreshCw className="w-4 h-4 mr-2" />}
        {syncing ? "Syncing…" : "Quick Sync"}
      </Button>
      <Button variant="default" size="sm" onClick={() => triggerSync("full")} disabled={syncing}>
        <DatabaseZap className="w-4 h-4 mr-2" />
        Full Catalogue Reset
      </Button>
    </div>
  );
};
