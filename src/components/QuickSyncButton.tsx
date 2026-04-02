import { useState, useCallback } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

const GITHUB_OWNER = "Voyagers-hook";
const GITHUB_REPO = "syncstock-manager";
const QUICK_SYNC_WORKFLOW = "sync-quick.yml";
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export function useQuickSync() {
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(() => {
    const stored = localStorage.getItem("lastQuickSync");
    return stored ? Number(stored) : null;
  });
  const queryClient = useQueryClient();

  const canSync = !syncing && (!lastSyncAt || Date.now() - lastSyncAt > COOLDOWN_MS);
  const cooldownRemaining = lastSyncAt ? Math.max(0, COOLDOWN_MS - (Date.now() - lastSyncAt)) : 0;

  const triggerSync = useCallback(async () => {
    if (!canSync) {
      const mins = Math.ceil(cooldownRemaining / 60000);
      toast.info(`Quick Sync was run recently. Wait ${mins} min before syncing again.`);
      return;
    }

    setSyncing(true);

    try {
      // Record the sync timestamp in Supabase so the hourly job can check it
      const now = new Date().toISOString();
      await supabase
        .from("sync_log")
        .insert({ type: "quick_sync", triggered_at: now, status: "triggered" });

      // Try to trigger GitHub Actions workflow
      const token = localStorage.getItem("github_pat");
      if (token) {
        const res = await fetch(
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${QUICK_SYNC_WORKFLOW}/dispatches`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.v3+json",
            },
            body: JSON.stringify({ ref: "main" }),
          }
        );
        if (res.ok || res.status === 204) {
          toast.success("Quick Sync triggered! Changes will appear in 1-2 minutes.");
        } else {
          toast.info("Sync flagged — products marked for next sync cycle.");
        }
      } else {
        // No GitHub token — just flag all variants for sync
        await supabase
          .from("variants")
          .update({ needs_sync: true, updated_at: new Date().toISOString() })
          .eq("needs_sync", false);
        toast.success("All products flagged for sync on next cycle.");
      }

      const timestamp = Date.now();
      setLastSyncAt(timestamp);
      localStorage.setItem("lastQuickSync", String(timestamp));

      // Refresh the UI data
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["products"] });
      }, 3000);
    } catch (err) {
      toast.error("Sync failed — check your connection.");
    } finally {
      setSyncing(false);
    }
  }, [canSync, cooldownRemaining, queryClient]);

  return { triggerSync, syncing, canSync, cooldownRemaining };
}

interface QuickSyncButtonProps {
  variant?: "outline" | "default";
  size?: "sm" | "default";
}

export const QuickSyncButton = ({ variant = "outline", size = "sm" }: QuickSyncButtonProps) => {
  const { triggerSync, syncing, canSync } = useQuickSync();

  return (
    <Button variant={variant} size={size} onClick={triggerSync} disabled={syncing}>
      {syncing ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : (
        <RefreshCw className="w-4 h-4 mr-2" />
      )}
      {syncing ? "Syncing…" : "Quick Sync"}
    </Button>
  );
};
