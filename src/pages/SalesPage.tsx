import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download } from "lucide-react";
import { useSalesReport } from "@/hooks/use-sales";
import { downloadCsv } from "@/lib/csv";

const gbp = (n: number | null | undefined) =>
  n === null || n === undefined ? "£0.00" : `£${Number(n).toFixed(2)}`;

function monthOptions(count = 12) {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    out.push({ value, label });
  }
  return out;
}

const Stat = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "muted";
}) => (
  <div className="bg-card rounded-xl border p-5">
    <p className="text-sm text-muted-foreground">{label}</p>
    <p
      className={`text-2xl font-bold ${
        tone === "pos" ? "text-success" : tone === "neg" ? "text-destructive" : "text-foreground"
      }`}
    >
      {value}
    </p>
  </div>
);

const SalesPage = () => {
  const months = useMemo(() => monthOptions(12), []);
  const [month, setMonth] = useState(months[0].value);
  const { data: report, isLoading } = useSalesReport(month);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `sales-${month}`,
      [
        { key: "item_name", label: "Item" },
        { key: "platform", label: "Platform" },
        { key: "quantity", label: "Qty" },
        { key: "turnover", label: "Turnover £" },
        { key: "fees", label: "Fees £" },
        { key: "cogs", label: "Cost £" },
        { key: "profit", label: "Profit £" },
      ],
      report.products.map((p) => ({
        item_name: p.item_name,
        platform: p.platform,
        quantity: p.quantity,
        turnover: p.turnover.toFixed(2),
        fees: p.fees.toFixed(2),
        cogs: p.cogs.toFixed(2),
        profit: p.profit.toFixed(2),
      })),
    );
  };

  return (
    <AppLayout
      title="Sales & profit"
      subtitle="Turnover, fees and profit by month"
      actions={
        <>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!report}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        </>
      }
    >
      {isLoading || !report ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Crunching the numbers…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
            <Stat label="Turnover" value={gbp(report.turnover)} />
            <Stat label="eBay fees" value={`− ${gbp(report.ebayFees)}`} tone="neg" />
            <Stat label="Squarespace fees" value={`− ${gbp(report.sqFees)}`} tone="neg" />
            <Stat label="Cost of goods" value={`− ${gbp(report.cogs)}`} tone="neg" />
            <Stat label="Refunds" value={`− ${gbp(report.refunds)}`} tone="neg" />
            <Stat
              label="Gross profit (before P&P)"
              value={gbp(report.grossBeforePP)}
              tone={report.grossBeforePP >= 0 ? "pos" : "neg"}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <div className="bg-card rounded-xl border p-5">
              <p className="text-sm font-medium mb-3">Where sales came from</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">eBay</span>
                  <span className="font-semibold tabular-nums">{gbp(report.ebayTurnover)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Squarespace</span>
                  <span className="font-semibold tabular-nums">{gbp(report.sqTurnover)}</span>
                </div>
                {report.turnover > 0 && (
                  <div className="h-2 rounded-full overflow-hidden bg-muted mt-2 flex">
                    <div
                      className="bg-[#e53238]"
                      style={{ width: `${(report.ebayTurnover / report.turnover) * 100}%` }}
                    />
                    <div
                      className="bg-primary"
                      style={{ width: `${(report.sqTurnover / report.turnover) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="bg-card rounded-xl border p-5">
              <p className="text-sm text-muted-foreground">Orders</p>
              <p className="text-2xl font-bold">{report.orderCount}</p>
              <p className="text-xs text-muted-foreground mt-1">{report.unitsSold} units sold</p>
            </div>
            <div className="bg-card rounded-xl border p-5">
              <p className="text-sm text-muted-foreground">Avg profit / order</p>
              <p className="text-2xl font-bold">
                {gbp(report.orderCount ? report.grossBeforePP / report.orderCount : 0)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">before postage costs</p>
            </div>
          </div>

          <div className="bg-card rounded-xl border overflow-hidden">
            <div className="hidden md:grid grid-cols-[1fr_100px_60px_100px_100px_100px_100px] gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground bg-muted/30">
              <span>Item</span>
              <span>Platform</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Turnover</span>
              <span className="text-right">Fees</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Profit</span>
            </div>
            {report.products.length === 0 ? (
              <p className="text-sm text-muted-foreground py-10 text-center">
                No sales in this month.
              </p>
            ) : (
              report.products.map((p) => (
                <div
                  key={p.key}
                  className="grid grid-cols-2 md:grid-cols-[1fr_100px_60px_100px_100px_100px_100px] gap-2 px-4 py-2.5 border-t items-center text-sm"
                >
                  <span className="col-span-2 md:col-span-1 min-w-0 truncate font-medium">
                    {p.item_name}
                  </span>
                  <span className="capitalize text-muted-foreground">{p.platform}</span>
                  <span className="text-right tabular-nums">{p.quantity}</span>
                  <span className="text-right tabular-nums">{gbp(p.turnover)}</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {gbp(p.fees)}
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {gbp(p.cogs)}
                  </span>
                  <span
                    className={`text-right tabular-nums font-semibold ${
                      p.profit >= 0 ? "text-success" : "text-destructive"
                    }`}
                  >
                    {gbp(p.profit)}
                  </span>
                </div>
              ))
            )}
          </div>

          <p className="text-[11px] text-muted-foreground mt-3">
            Fees are estimated (eBay 12.8% + £0.30, Squarespace 2.9% + £0.30). Profit is before
            postage &amp; packing. Cost of goods uses each item's stored cost price.
          </p>
        </>
      )}
    </AppLayout>
  );
};

export default SalesPage;
