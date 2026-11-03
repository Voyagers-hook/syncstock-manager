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

            {/* API connections (password protected) */}
            <ConnectionsCard />

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
                            <span className="ml-2 text-destructive" title={s.error_message}>error</span>
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

const CONN_GROUPS: { title: string; note?: string; fields: { key: string; label: string }[] }[] = [
  { title: "QuickFile", note: "Account Settings → 3rd Party Integration → API", fields: [
    { key: "quickfile_account_number", label: "Account Number" },
    { key: "quickfile_api_key", label: "API Key" },
    { key: "quickfile_app_id", label: "Application ID" },
  ] },
  { title: "SendCloud", note: "Settings → Integrations → API", fields: [
    { key: "sendcloud_public_key", label: "Public Key" },
    { key: "sendcloud_secret_key", label: "Secret Key" },
  ] },
  { title: "Parcel2Go", note: "Developer / API portal (OAuth)", fields: [
    { key: "parcel2go_client_id", label: "Client ID" },
    { key: "parcel2go_client_secret", label: "Client Secret" },
  ] },
  { title: "DPD", note: "DPD API account credentials", fields: [
    { key: "dpd_username", label: "Username" },
    { key: "dpd_password", label: "Password" },
    { key: "dpd_account_number", label: "Account Number" },
  ] },
];

const ConnectionsCard = () => {
  const [unlocked, setUnlocked] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [vals, setVals] = useState<Record<string, string>>({});

  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("connections", { body: { action, password: pw, ...extra } });
    if (error) {
      let msg = error.message;
      try { const ctx = (error as any).context; if (ctx?.json) { const j = await ctx.json(); if (j?.error) msg = j.error; } } catch { /* keep */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  };

  const unlock = async () => {
    setBusy(true);
    try { const d = await call("status"); setStatus(d.set || {}); setUnlocked(true); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const d = await call("save", { values: vals });
      setStatus(d.set || {});
      setVals({});
      toast.success("Connections saved.");
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connections &amp; API keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!unlocked ? (
          <div className="flex items-center gap-3">
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pw && unlock()}
              placeholder="Enter password to manage keys"
              className="flex-1 max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <Button size="sm" onClick={unlock} disabled={busy || !pw}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Unlock"}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Stored keys are never shown. Leave a field blank to keep what's saved; type a new value to replace it.</p>
            {CONN_GROUPS.map((g) => (
              <div key={g.title} className="border border-border rounded-md p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{g.title}</span>
                  {g.note && <span className="text-xs text-muted-foreground">{g.note}</span>}
                </div>
                {g.fields.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <label className="text-sm w-36 shrink-0">{f.label}</label>
                    <input
                      type="password"
                      value={vals[f.key] ?? ""}
                      onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={status[f.key] ? "•••••• (saved)" : "not set"}
                      className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    />
                    {status[f.key] ? (
                      <Badge className="bg-success text-success-foreground text-xs"><CheckCircle className="w-3 h-3 mr-1" />Set</Badge>
                    ) : (
                      <Badge variant="outline" className="text-warning text-xs"><AlertCircle className="w-3 h-3 mr-1" />Not set</Badge>
                    )}
                  </div>
                ))}
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={save} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}Save keys
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setUnlocked(false); setPw(""); setVals({}); }}>Lock</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default SettingsPage;
