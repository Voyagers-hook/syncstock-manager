import { useEffect, useState } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, CheckCircle, AlertCircle, RotateCcw, RefreshCw, ExternalLink } from "lucide-react";
import { useQuickSync } from "@/components/QuickSyncButton";
import { toast } from "sonner";

const EBAY_AUTH_URL = "https://czoppjnkjxmduldxlbqh.supabase.co/functions/v1/ebay-auth";

interface ChannelStats {
  channel: string;
  count: number;
  lastSynced: string | null;
}

interface SyncLogEntry {
  sync_type: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  details: any;
  error_message: string | null;
}

const SettingsPage = () => {
  const [channelStats, setChannelStats] = useState<ChannelStats[]>([]);
  const [productCount, setProductCount] = useState<number | null>(null);
  const [recentSyncs, setRecentSyncs] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { triggerSync, syncing } = useQuickSync();

  const loadStats = async () => {
    const [{ count: pCount }, { data: listings }, { data: syncLogs }] = await Promise.all([
      supabase.from("products").select("*", { count: "exact", head: true }).eq("active", true),
      supabase.from("channel_listings").select("channel, last_synced_at"),
      supabase
        .from("sync_log")
        .select("sync_type, status, started_at, completed_at, details, error_message")
        .order("started_at", { ascending: false })
        .limit(10),
    ]);

    setProductCount(pCount ?? 0);
    setRecentSyncs((syncLogs ?? []) as SyncLogEntry[]);

    const statsMap = new Map<string, { count: number; lastSynced: string | null }>();
    for (const l of listings ?? []) {
      const existing = statsMap.get(l.channel) ?? { count: 0, lastSynced: null };
      existing.count++;
      if (l.last_synced_at && (!existing.lastSynced || l.last_synced_at > existing.lastSynced)) {
        existing.lastSynced = l.last_synced_at;
      }
      statsMap.set(l.channel, existing);
    }

    setChannelStats(
      Array.from(statsMap.entries()).map(([channel, s]) => ({
        channel,
        count: s.count,
        lastSynced: s.lastSynced,
      }))
    );
    setLoading(false);
  };

  useEffect(() => { loadStats(); }, []);

  const handleConnectEbay = () => {
    const popup = window.open(EBAY_AUTH_URL, "ebay-auth", "width=600,height=700,scrollbars=yes");
    if (!popup) {
      // Fallback if popup blocked
      window.open(EBAY_AUTH_URL, "_blank");
      toast.info("eBay auth opened in new tab. Return here when done and click Refresh.");
      return;
    }
    toast.info("Complete the eBay login in the popup window. This page will refresh automatically.");
    // Poll for popup close, then reload stats
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        toast.success("eBay auth window closed — refreshing connection status…");
        setLoading(true);
        loadStats();
      }
    }, 1000);
  };

  const channels = [
    {
      name: "eBay",
      key: "ebay",
      description: "Product listings synced from eBay via API",
      connectLabel: "Connect eBay",
      onConnect: handleConnectEbay,
    },
    {
      name: "Squarespace",
      key: "squarespace",
      description: "Product listings synced from Squarespace Commerce API",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Platform connections, sync controls, and history</p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-6">
            {/* Overview */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Catalogue Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  <span className="text-foreground font-semibold">{productCount}</span> active products in database
                </p>
              </CardContent>
            </Card>

            {/* Channel connections */}
            <div className="grid gap-4 md:grid-cols-2">
              {channels.map((ch) => {
                const stats = channelStats.find((s) => s.channel === ch.key);
                const connected = stats && stats.count > 0;
                return (
                  <Card key={ch.key}>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-base">{ch.name}</CardTitle>
                      {connected ? (
                        <Badge className="bg-success text-success-foreground">
                          <CheckCircle className="w-3 h-3 mr-1" /> {stats!.count} listings
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-warning">
                          <AlertCircle className="w-3 h-3 mr-1" /> No listings
                        </Badge>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">{ch.description}</p>
                      {stats?.lastSynced && (
                        <p className="text-xs text-muted-foreground">
                          Last synced: {new Date(stats.lastSynced).toLocaleString()}
                        </p>
                      )}
                      {ch.onConnect && (
                        <Button
                          variant={connected ? "outline" : "default"}
                          size="sm"
                          onClick={ch.onConnect}
                        >
                          <ExternalLink className="w-3 h-3 mr-2" />
                          {connected ? "Re-authorise eBay" : ch.connectLabel}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Sync Controls */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sync Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <Button onClick={() => triggerSync("quick")} disabled={syncing} variant="outline">
                    {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                    Quick Sync
                  </Button>
                  <Button
                    onClick={() => {
                      if (confirm("This will re-import the full catalogue from eBay & Squarespace. Continue?")) {
                        triggerSync("full");
                      }
                    }}
                    disabled={syncing}
                    variant="destructive"
                  >
                    {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
                    Full Catalogue Reset
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Quick Sync pushes pending changes to both platforms. Full Catalogue Reset re-imports everything fresh.
                </p>
              </CardContent>
            </Card>

            {/* Recent Sync History */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent Sync History</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {recentSyncs.map((s, i) => {
                    let details: any = {};
                    try { details = typeof s.details === "string" ? JSON.parse(s.details) : (s.details ?? {}); } catch {}
                    return (
                      <div key={i} className="flex items-center justify-between text-sm border-b border-border pb-2 last:border-0">
                        <div className="flex items-center gap-3">
                          <Badge
                            variant={s.status === "completed" ? "default" : s.status === "failed" ? "destructive" : "outline"}
                            className="text-xs"
                          >
                            {s.status}
                          </Badge>
                          <span className="text-muted-foreground capitalize">{s.sync_type.replace(/_/g, " ")}</span>
                          {details.imported != null && (
                            <span className="text-xs text-muted-foreground">({details.imported} items)</span>
                          )}
                          {details.items_synced != null && (
                            <span className="text-xs text-muted-foreground">({details.items_synced} items)</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(s.started_at).toLocaleString()}
                          {s.error_message && (
                            <span className="ml-2 text-destructive" title={s.error_message}>⚠ error</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {recentSyncs.length === 0 && (
                    <p className="text-sm text-muted-foreground">No sync history found.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
};

export default SettingsPage;
