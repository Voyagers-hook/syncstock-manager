import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Download, Search, Undo2 } from "lucide-react";
import { useOrders, OrderRow } from "@/hooks/use-orders";
import { ReturnModal } from "@/components/orders/ReturnModal";
import { downloadCsv } from "@/lib/csv";

const gbp = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "—";

const PlatformBadge = ({ platform }: { platform: string }) => (
  <Badge
    className={
      platform === "ebay"
        ? "bg-[#e53238]/10 text-[#e53238] hover:bg-[#e53238]/10"
        : "bg-primary/10 text-primary hover:bg-primary/10"
    }
  >
    {platform === "ebay" ? "eBay" : platform === "squarespace" ? "Squarespace" : platform}
  </Badge>
);

const OrdersPage = () => {
  const { data: orders = [], isLoading } = useOrders();
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<"all" | "ebay" | "squarespace">("all");
  const [returnTarget, setReturnTarget] = useState<OrderRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (platform !== "all" && o.platform !== platform) return false;
      if (!q) return true;
      return (
        (o.item_name ?? "").toLowerCase().includes(q) ||
        (o.order_number ?? "").toLowerCase().includes(q) ||
        (o.platform_order_id ?? "").toLowerCase().includes(q) ||
        (o.customer_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [orders, search, platform]);

  const exportCsv = () =>
    downloadCsv(
      `orders-${new Date().toISOString().slice(0, 10)}`,
      [
        { key: "ordered_at", label: "Date" },
        { key: "platform", label: "Platform" },
        { key: "order_number", label: "Order" },
        { key: "item_name", label: "Item" },
        { key: "quantity", label: "Qty" },
        { key: "unit_price", label: "Unit £" },
        { key: "total_price", label: "Total £" },
        { key: "customer_name", label: "Customer" },
      ],
      filtered.map((o) => ({
        ...o,
        ordered_at: fmtDate(o.ordered_at),
      })),
    );

  return (
    <AppLayout
      title="Orders"
      subtitle="Every sale captured from eBay & Squarespace"
      actions={
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item, order no, customer…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          {([
            ["all", "All"],
            ["ebay", "eBay"],
            ["squarespace", "Squarespace"],
          ] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setPlatform(k)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                platform === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground ml-auto">
          {filtered.length} order{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <div className="hidden md:grid grid-cols-[80px_110px_1fr_60px_90px_120px_90px] gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground bg-muted/30">
          <span>Date</span>
          <span>Platform</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Total</span>
          <span>Order</span>
          <span className="text-right">Action</span>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-10 text-center">Loading orders…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">No orders match.</p>
        ) : (
          filtered.map((o) => (
            <div
              key={o.id}
              className="grid grid-cols-2 md:grid-cols-[80px_110px_1fr_60px_90px_120px_90px] gap-2 px-4 py-3 border-t items-center text-sm"
            >
              <span className="text-muted-foreground">{fmtDate(o.ordered_at)}</span>
              <span>
                <PlatformBadge platform={o.platform} />
              </span>
              <span className="col-span-2 md:col-span-1 min-w-0 truncate font-medium">
                {o.item_name ?? o.sku ?? "—"}
              </span>
              <span className="text-right tabular-nums">{o.quantity}</span>
              <span className="text-right tabular-nums">{gbp(o.total_price)}</span>
              <span className="text-xs text-muted-foreground truncate">
                {o.order_number ?? o.platform_order_id}
              </span>
              <span className="text-right">
                <Button variant="outline" size="sm" onClick={() => setReturnTarget(o)}>
                  <Undo2 className="w-3.5 h-3.5 mr-1.5" />
                  Return
                </Button>
              </span>
            </div>
          ))
        )}
      </div>

      <ReturnModal order={returnTarget} onClose={() => setReturnTarget(null)} />
    </AppLayout>
  );
};

export default OrdersPage;
