import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useOrders, OrderRow, orderStatus } from "@/hooks/use-orders";
import OrderModal from "@/components/modals/OrderModal";
import { downloadCsv } from "@/lib/csv";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";

type Filter = "all" | "ebay" | "squarespace" | "undispatched" | "returns";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["ebay", "eBay"],
  ["squarespace", "Squarespace"],
  ["undispatched", "Undispatched"],
  ["returns", "Returns"],
];

const statusOf = orderStatus;

const OrdersPage = () => {
  const { data: orders = [] } = useOrders();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<OrderRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      const st = statusOf(o);
      if (filter === "ebay" && o.platform !== "ebay") return false;
      if (filter === "squarespace" && o.platform !== "squarespace") return false;
      if (filter === "undispatched" && st !== "Undispatched") return false;
      if (filter === "returns" && st !== "Returned") return false;
      if (!q) return true;
      return (
        (o.item_name ?? "").toLowerCase().includes(q) ||
        (o.order_number ?? "").toLowerCase().includes(q) ||
        (o.platform_order_id ?? "").toLowerCase().includes(q) ||
        (o.customer_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [orders, search, filter]);

  const exportCsv = () =>
    downloadCsv(
      `orders-${new Date().toISOString().slice(0, 10)}`,
      [
        { key: "order", label: "Order" },
        { key: "date", label: "Date" },
        { key: "item", label: "Item" },
        { key: "qty", label: "Qty" },
        { key: "total", label: "Total £" },
        { key: "platform", label: "Platform" },
        { key: "status", label: "Status" },
        { key: "customer", label: "Customer" },
      ],
      filtered.map((o) => ({
        order: o.order_number ?? o.platform_order_id,
        date: fmtDate(o.ordered_at),
        item: o.item_name ?? o.sku ?? "",
        qty: o.quantity,
        total: o.total_price ?? "",
        platform: o.platform,
        status: statusOf(o),
        customer: o.customer_name ?? "",
      })),
    );

  const pill = (st: string) =>
    st === "Returned" ? "out" : st === "Undispatched" ? "low" : "good";

  return (
    <ConceptLayout
      title="Orders"
      subtitle="Every order, both platforms"
      onExport={exportCsv}
      search={search}
      onSearch={setSearch}
    >
      <div className="seg" style={{ marginBottom: 16 }}>
        {FILTERS.map(([k, lbl]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
            {lbl}
          </button>
        ))}
      </div>
      <div className="thead-wrap">
        <div className="cap">
          <h3>Orders</h3>
          <div className="legend">
            <span>click an order to see customer details, dispatch, or process a return</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Date</th>
              <th>Items</th>
              <th className="num">Total</th>
              <th className="c">Platform</th>
              <th className="c">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No orders match.
                </td>
              </tr>
            ) : (
              filtered.map((o) => {
                const st = statusOf(o);
                return (
                  <tr className="vrow" key={o.id} style={{ cursor: "pointer" }} onClick={() => setOpen(o)}>
                    <td>
                      <b>{o.order_number ?? o.platform_order_id}</b>
                    </td>
                    <td>{fmtDate(o.ordered_at)}</td>
                    <td>{o.item_name ?? o.sku ?? "—"}</td>
                    <td className="num">{money(o.total_price)}</td>
                    <td className="c">
                      <span className={`plat ${o.platform === "ebay" ? "eb" : "sq"}`}>
                        {o.platform === "ebay" ? "eBay" : "Squarespace"}
                      </span>
                    </td>
                    <td className="c">
                      <span className={`pill ${pill(st)}`}>{st}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Every order from both channels in one list. Click an order to see the customer's details and
        shipping address, or process a return — send stock back, or write it off if damaged/lost.
      </div>

      <OrderModal order={open} onClose={() => setOpen(null)} />
    </ConceptLayout>
  );
};

export default OrdersPage;
