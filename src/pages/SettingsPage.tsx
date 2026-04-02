import { useEffect, useState } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, CheckCircle, XCircle, AlertCircle } from "lucide-react";

interface ChannelStats {
  channel: string;
  count: number;
  lastSynced: string | null;
}

const SettingsPage = () => {
  const [channelStats, setChannelStats] = useState<ChannelStats[]>([]);
  const [productCount, setProductCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStats() {
      const [{ count: pCount }, { data: listings }] = await Promise.all([
        supabase.from("products").select("*", { count: "exact", head: true }).eq("active", true),
        supabase.from("channel_listings").select("channel, last_synced_at"),
      ]);

      setProductCount(pCount ?? 0);

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
    }
    loadStats();
  }, []);

  const channels = [
    {
      name: "eBay",
      key: "ebay",
      secretName: "EBAY_APP_ID",
      description: "Product listings synced from eBay via API",
    },
    {
      name: "Squarespace",
      key: "squarespace",
      secretName: "SQUARESPACE_API_KEY",
      description: "Product listings synced from Squarespace Commerce API",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Platform connections and sync status</p>
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
                          <CheckCircle className="w-3 h-3 mr-1" /> Connected
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-warning">
                          <AlertCircle className="w-3 h-3 mr-1" /> No listings
                        </Badge>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="text-sm text-muted-foreground">{ch.description}</p>
                      {stats ? (
                        <>
                          <p className="text-sm">
                            <span className="font-semibold text-foreground">{stats.count}</span> listings
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Last synced: {stats.lastSynced ? new Date(stats.lastSynced).toLocaleString() : "Never"}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No {ch.name} listings found. The sync pipeline needs to import them.
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-2">
                        Secret: <code className="bg-muted px-1 rounded">{ch.secretName}</code> — stored securely
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Sync info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sync Pipeline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>Sync runs via <strong className="text-foreground">GitHub Actions</strong> on an hourly schedule.</p>
                <p>When you edit a price or stock level in the dashboard, it's saved to the database and flagged for sync. The next scheduled run pushes changes to eBay & Squarespace.</p>
                <p className="text-xs">
                  GitHub secrets needed: <code className="bg-muted px-1 rounded">SQUARESPACE_API_KEY</code>, <code className="bg-muted px-1 rounded">EBAY_APP_ID</code>, <code className="bg-muted px-1 rounded">EBAY_CERT_ID</code>, <code className="bg-muted px-1 rounded">EBAY_REFRESH_TOKEN</code>, <code className="bg-muted px-1 rounded">SUPABASE_URL</code>, <code className="bg-muted px-1 rounded">SUPABASE_SERVICE_KEY</code>
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
};

export default SettingsPage;
