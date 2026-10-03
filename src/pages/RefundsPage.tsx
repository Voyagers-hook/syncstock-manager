import ConceptLayout from "@/components/ConceptLayout";
import { useRefunds } from "@/hooks/use-refunds";
import { downloadCsv } from "@/lib/csv";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";

const RefundsPage = () => {
  const { data: refunds = [] } = useRefunds();

  const exportCsv = () =>
    downloadCsv(
      `refunds-${new Date().toISOString().slice(0, 10)}`,
      [
        { key: "date", label: "Date" },
        { key: "item", label: "Item" },
        { key: "order", label: "Order" },
        { key: "amount", label: "Refunded £" },
        { key: "reason", label: "Reason" },
        { key: "platform", label: "Platform" },
        { key: "stock", label: "Stock" },
      ],
      refunds.map((r) => ({
        date: fmtDate(r.created_at),
        item: r.item_name ?? "",
        order: r.order_number ?? r.order_id,
        amount: r.amount ?? "",
        reason: r.reason ?? "",
        platform: r.platform,
        stock: r.restocked ? "restocked" : "written off",
      })),
    );

  return (
    <ConceptLayout title="Refunds & returns" subtitle="With reasons and stock outcome" onExport={exportCsv}>
      <div className="thead-wrap">
        <div className="cap">
          <h3>Refunds &amp; returns</h3>
          <div className="legend">
            <span>auto-replenish on returns that go back to stock</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Item</th>
              <th>Order</th>
              <th className="num">Refunded</th>
              <th>Reason</th>
              <th className="c">Platform</th>
              <th className="c">Stock</th>
            </tr>
          </thead>
          <tbody>
            {refunds.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No refunds yet. Process a return from the Orders page.
                </td>
              </tr>
            ) : (
              refunds.map((r) => (
                <tr className="vrow" key={r.id}>
                  <td>{fmtDate(r.created_at)}</td>
                  <td>
                    <b>{r.item_name ?? "—"}</b>
                  </td>
                  <td>{r.order_number ?? r.order_id}</td>
                  <td className="num" style={{ color: "#be123c" }}>
                    -{money(r.amount)}
                  </td>
                  <td>{r.reason ?? "—"}</td>
                  <td className="c">
                    <span className={`plat ${r.platform === "ebay" ? "eb" : "sq"}`}>
                      {r.platform === "ebay" ? "eBay" : "SQ"}
                    </span>
                  </td>
                  <td className="c">
                    {r.restocked ? (
                      <span className="badge on">restocked</span>
                    ) : (
                      <span className="badge off">written off</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Every refund and return, with its reason and whether stock went back or was written off — so
        you can see which items keep getting damaged in transit or lost. Exportable to CSV for your
        accountant.
      </div>
    </ConceptLayout>
  );
};

export default RefundsPage;
