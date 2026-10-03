import { useMemo } from "react";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download } from "lucide-react";
import { useRefunds } from "@/hooks/use-refunds";
import { downloadCsv } from "@/lib/csv";

const gbp = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "—";

const RefundsPage = () => {
  const { data: refunds = [], isLoading } = useRefunds();

  const totals = useMemo(() => {
    const total = refunds.reduce((s, r) => s + (r.amount ?? 0), 0);
    const restocked = refunds.filter((r) => r.restocked).length;
    const writeoffs = refunds.length - restocked;
    return { total, restocked, writeoffs };
  }, [refunds]);

  const exportCsv = () =>
    downloadCsv(
      `refunds-${new Date().toISOString().slice(0, 10)}`,
      [
        { key: "created_at", label: "Date" },
        { key: "platform", label: "Platform" },
        { key: "order_number", label: "Order" },
        { key: "item_name", label: "Item" },
        { key: "amount", label: "Amount £" },
        { key: "reason", label: "Reason" },
        { key: "outcome", label: "Outcome" },
        { key: "note", label: "Note" },
      ],
      refunds.map((r) => ({
        ...r,
        created_at: fmtDate(r.created_at),
        order_number: r.order_number ?? r.order_id,
        outcome: r.restocked ? "Back to stock" : "Write-off",
      })),
    );

  return (
    <AppLayout
      title="Refunds & returns"
      subtitle="Money refunded, and whether stock came back"
      actions={
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-xl border p-5">
          <p className="text-sm text-muted-foreground">Total refunded</p>
          <p className="text-2xl font-bold">{gbp(totals.total)}</p>
        </div>
        <div className="bg-card rounded-xl border p-5">
          <p className="text-sm text-muted-foreground">Back to stock</p>
          <p className="text-2xl font-bold text-success">{totals.restocked}</p>
        </div>
        <div className="bg-card rounded-xl border p-5">
          <p className="text-sm text-muted-foreground">Write-offs</p>
          <p className="text-2xl font-bold text-destructive">{totals.writeoffs}</p>
        </div>
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <div className="hidden md:grid grid-cols-[80px_110px_1fr_90px_140px_120px] gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground bg-muted/30">
          <span>Date</span>
          <span>Platform</span>
          <span>Item</span>
          <span className="text-right">Amount</span>
          <span>Reason</span>
          <span>Outcome</span>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>
        ) : refunds.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            No refunds yet. Process a return from the Orders page.
          </p>
        ) : (
          refunds.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-2 md:grid-cols-[80px_110px_1fr_90px_140px_120px] gap-2 px-4 py-3 border-t items-center text-sm"
            >
              <span className="text-muted-foreground">{fmtDate(r.created_at)}</span>
              <span className="capitalize">{r.platform}</span>
              <span className="col-span-2 md:col-span-1 min-w-0 truncate font-medium">
                {r.item_name ?? "—"}
              </span>
              <span className="text-right tabular-nums">{gbp(r.amount)}</span>
              <span className="text-xs text-muted-foreground truncate">{r.reason ?? "—"}</span>
              <span>
                {r.restocked ? (
                  <Badge className="bg-success/10 text-success hover:bg-success/10">
                    Back to stock
                  </Badge>
                ) : (
                  <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/10">
                    Write-off
                  </Badge>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </AppLayout>
  );
};

export default RefundsPage;
