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
      toast.info(`${label} started...`);
      
      // If it's a full reset, we tell the database to clear first
      if (mode === "full") {
        await supabase.rpc('clear_inventory_data'); // This calls a cleaner tool in Supabase
      }

      // Trigger the imports from eBay and Squarespace
      const [ebayRes, sqRes] = await Promise.all([
        supabase.functions.invoke("ebay-import", { body: { mode } }),
        supabase.functions.invoke("squarespace-import", { body: { mode } }),
      ]);

      if (ebayRes.error) toast.error(`eBay: ${ebayRes.error.message}`);
      if (sqRes.error) toast.error(`Sqsp: ${sqRes.error.message}`);

      // FORCE THE BROWSER TO FORGET OLD ITEMS
      await queryClient.clear(); 
      await queryClient.invalidateQueries();
      
      toast.success("Catalogue Refreshed Successfully!");
    } catch (err: any) {
      toast.error(err.message);
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
        <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
        {syncing ? "Syncing..." : "Quick Sync"}
      </Button>
      <Button variant="default" size="sm" onClick={() => triggerSync("full")} disabled={syncing}>
        <DatabaseZap className="w-4 h-4 mr-2" />
        Full Catalogue Reset
      </Button>
    </div>
  );
};
