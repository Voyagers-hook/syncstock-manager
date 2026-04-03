import { useState } from "react";
import { RefreshCw, Loader2, DatabaseZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

export const QuickSyncButton = () => {
  const [syncing, setSyncing] = useState(false);
  const queryClient = useQueryClient();

  const handleFullReset = async () => {
    if (!confirm("This will pull a fresh copy of everything from eBay and Squarespace. Proceed?")) return;
    setSyncing(true);
    toast.info("Importing all products from stores...");

    try {
      // 1. Trigger eBay Import
      const { data: ebayData, error: ebayError } = await supabase.functions.invoke("ebay-import");
      if (ebayError) throw new Error(`eBay Error: ${ebayError.message}`);
      toast.success(`eBay: ${ebayData?.products_created || 0} products imported`);

      // 2. Trigger Squarespace Import
      const { data: sqData, error: sqError } = await supabase.functions.invoke("squarespace-import");
      if (sqError) throw new Error(`Squarespace Error: ${sqError.message}`);
      toast.success(`Squarespace: ${sqData?.products_created || 0} products imported`);

      // 3. Refresh Dashboard
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Import Complete!");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Button variant="default" onClick={handleFullReset} disabled={syncing}>
        {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DatabaseZap className="w-4 h-4 mr-2" />}
        {syncing ? "Importing..." : "Full Catalogue Reset"}
      </Button>
    </div>
  );
};  variant?: "outline" | "default";
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
