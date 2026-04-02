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
      // Insert a sync_log row so the external runner picks it up
      const now = new Date().toISOString();
      await supabase
        .from("sync_log")
        .insert({ sync_type: mode, status: "started", started_at: now, source: "dashboard" });

      // Flag all variants for sync so the runner processes everything
      await supabase
        .from("variants")
        .update({ needs_sync: true, updated_at: new Date().toISOString() })
        .neq("needs_sync", true);

      toast.success(`${label} requested — syncing now.`);

      // Poll for completion
      pollForCompletion(mode, now, queryClient);
    } catch {
      toast.error(`${label} failed — check your connection.`);
    } finally {
      setSyncing(false);
    }
  }, [syncing, queryClient]);

  return { triggerSync, syncing };
}

async function pollForCompletion(
  mode: string,
  startedAfter: string,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10000)); // every 10s

    const { data } = await supabase
      .from("sync_log")
      .select("status, details, error_message")
      .eq("sync_type", mode)
      .gte("started_at", startedAfter)
      .order("started_at", { ascending: false })
      .limit(1);

    const row = data?.[0];
    if (!row) continue;

    if (row.status === "completed") {
      const details = row.details ? JSON.parse(row.details) : {};
      toast.success(`Sync complete — ${details.items_synced ?? "all"} items synced.`);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      return;
    }
    if (row.status === "failed") {
      toast.error(`Sync failed: ${row.error_message ?? "unknown error"}`);
      return;
    }
  }
  // After 5 minutes of polling, refresh anyway
  queryClient.invalidateQueries({ queryKey: ["products"] });
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
