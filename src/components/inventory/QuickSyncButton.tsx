import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function QuickSyncButton() {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [syncType, setSyncType] = useState<"quick" | "full" | null>(null);

  const runSync = async (mode: "quick" | "full") => {
    setSyncing(true);
    setSyncType(mode);
    const clearFirst = mode === "full";

    try {
      toast.info(
        clearFirst
          ? "Full reset started — clearing catalogue and re-importing everything..."
          : "Quick sync started...",
      );

      // 1. eBay import — handles the clearFirst wipe if mode === "full"
      const { data: ebayData, error: ebayErr } = await supabase.functions.invoke(
        "ebay-import",
        { body: { clearFirst } },
      );
      if (ebayErr) throw new Error(`eBay sync failed: ${ebayErr.message}`);

      // 2. Squarespace import
      const { data: sqData, error: sqErr } = await supabase.functions.invoke(
        "squarespace-import",
        { body: {} },
      );
      if (sqErr) throw new Error(`Squarespace sync failed: ${sqErr.message}`);

      // 3. Refresh all cached queries
      await queryClient.invalidateQueries();

      const ebayNew = ebayData?.products_created ?? 0;
      const ebayUpdated = ebayData?.products_updated ?? 0;
      const sqNew = sqData?.products_created ?? 0;
      const sqVariants = sqData?.variants_created ?? 0;

      toast.success(
        `✅ Sync complete! eBay: ${ebayNew} new, ${ebayUpdated} updated. ` +
          `Squarespace: ${sqNew} products, ${sqVariants} variants.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Sync error:", msg);
      toast.error(`Sync failed: ${msg}`);
    } finally {
      setSyncing(false);
      setSyncType(null);
    }
  };

  return (
    <div className="flex gap-2 items-center flex-wrap">
      <Button
        onClick={() => runSync("quick")}
        disabled={syncing}
        size="sm"
        variant="outline"
      >
        <RefreshCw
          className={`mr-2 h-4 w-4 ${syncing && syncType === "quick" ? "animate-spin" : ""}`}
        />
        {syncing && syncType === "quick" ? "Syncing..." : "Quick Sync"}
      </Button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button disabled={syncing} size="sm" variant="destructive">
            <AlertTriangle className="mr-2 h-4 w-4" />
            {syncing && syncType === "full" ? "Resetting..." : "Full Catalogue Reset"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Full Catalogue Reset</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all products, variants, inventory and channel
              listings, then re-import everything fresh from eBay and Squarespace.
              Any manual merges will be lost. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => runSync("full")}>
              Yes, reset everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
