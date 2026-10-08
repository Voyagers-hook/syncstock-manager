import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useRefunds, RefundRow } from "@/hooks/use-refunds";
import RefundModal from "@/components/modals/RefundModal";
import { downloadCsv } from "@/lib/csv";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "—";
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

type Preset = "30d" | "month" | "year" | "all" | "custom";

function outcomeLabel(r: RefundRow) {
  if (r.restock_state === "restocked") return { text: "Back to stock", cls: "badge on" };
  if (r.restock_state === "writeoff") return { text: "Written off", cls: "badge off" };
  return { text: "Unconfirmed", cls: "badge", style: { background: "#fff7e8", color: "#a9640a" } as any };
}

const RefundsPage = () => {
  const { data: refunds = [] } = useRefunds();
  const [preset, setPreset] = useState<Preset>("30d");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const [open, setOpen] = useState<RefundRow | null>(null);

  const range = useMemo(() => {
    const now = new Date();
    if (preset === "all") return { start: "", end: "" };
    if (preset === "month") return { start: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), end: "" };
    if (preset === "year") return { start: isoDate(new Date(now.getFullYear(), 0, 1)), end: "" };
    if (preset === "custom") return { start: cFrom, end: cTo };
    return { start: isoDate(new Date(now.getTime() - 30 * 864e5)), end: "" }; // 30d
  }, [preset, cFrom, cTo]);

  const filtered = useMemo(() => {
    return refunds.filter((r) => {
      const d = (r.created_at ?? "").slice(0, 10);
      if (range.start && d < range.start) return false;
      if (range.end && d > range.end) return false;
      return true;
    });
  }, [refunds, range]);

  const totals = useMemo(() => {
    const total = filtered.reduce((s, r) => s + (r.amount ?? 0), 0);
    const restocked = filtered.filter((r) => r.restock_state === "restocked").length;
    const writeoffs = filtered.filter((r) => r.restock_state === "writeoff").length;
    const unconfirmed = filtered.filter((r) => !r.restock_state).length;
    return { total, restocked, writeoffs, unconfirmed };
  }, [filtered]);

  const exportCsv = () =>
    downloadCsv(`refunds-${isoDate(new Date())}`,
      [
        { key: "date", label: "Date" }, { key: "platform", label: "Platform" }, { key: "order", label: "Order" },
        { key: "item", label: "Item" }, { key: "amount", label: "Refunded £" }, { key: "reason", label: "Reason" },
        { key: "outcome", label: "Stock" }, { key: "recorded", label: "Recorded" },
      ],
      filtered.map((r) => ({
        date: fmtDate(r.created_at), platform: r.platform, order: r.order_number ?? r.order_id,
        item: r.item_name ?? "", amount: r.amount ?? "", reason: r.reason ?? "",
        outcome: r.restock_state === "restocked" ? "Back to stock" : r.restock_state === "writeoff" ? "Written off" : "Unconfirmed",
        recorded: r.source === "auto" ? "Auto" : "Manual",
      })));

  const PRESETS: [Preset, string][] = [["30d", "Last 30 days"], ["month", "This month"], ["year", "This year"], ["all", "All"], ["custom", "Custom"]];

  return (
    <ConceptLayout title="Refunds & returns" subtitle="With reasons and stock outcome" onExport={exportCsv}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div className="seg">
          {PRESETS.map(([k, lbl]) => (
            <button key={k} className={preset === k ? "on" : ""} onClick={() => setPreset(k)}>{lbl}</button>
          ))}
        </div>
        {preset === "custom" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="date" value={cFrom} onChange={(e) => setCFrom(e.target.value)} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5 }} />
            <span style={{ color: "var(--muted)" }}>to</span>
            <input type="date" value={cTo} onChange={(e) => setCTo(e.target.value)} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5 }} />
          </div>
        )}
      </div>

      <div className="grid4" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <div className="card"><div className="lbl">Total refunded</div><div className="val">{money(totals.total)}</div></div>
        <div className="card"><div className="lbl">Back to stock</div><div className="val" style={{ color: "#067a57" }}>{totals.restocked}</div></div>
        <div className="card"><div className="lbl">Written off</div><div className="val" style={{ color: "var(--over)" }}>{totals.writeoffs}</div></div>
        <div className="card"><div className="lbl">Unconfirmed</div><div className="val" style={{ color: "#a9640a" }}>{totals.unconfirmed}</div></div>
      </div>

      <div className="thead-wrap">
        <div className="cap">
          <h3>Refunds &amp; returns</h3>
          <div className="legend"><span>click a refund to see details and set its stock outcome</span></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Item</th><th>Order</th><th className="num">Refunded</th><th>Reason</th><th className="c">Platform</th><th className="c">Stock</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="empty">No refunds in this period.</td></tr>
            ) : (
              filtered.map((r) => {
                const o = outcomeLabel(r);
                return (
                  <tr className="vrow" key={r.id} style={{ cursor: "pointer" }} onClick={() => setOpen(r)}>
                    <td>{fmtDate(r.created_at)}</td>
                    <td><b>{r.item_name ?? "—"}</b></td>
                    <td style={{ fontSize: 12, color: "var(--muted)" }}>{r.order_number ?? r.order_id}</td>
                    <td className="num" style={{ color: "#be123c" }}>-{money(r.amount)}</td>
                    <td style={{ fontSize: 12.5 }}>{r.reason ?? "—"}</td>
                    <td className="c"><span className={`plat ${r.platform === "ebay" ? "eb" : "sq"}`}>{r.platform === "ebay" ? "eBay" : "SQ"}</span></td>
                    <td className="c"><span className={o.cls} style={o.style}>{o.text}</span></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Refunds from eBay and Squarespace are captured automatically for your accounting. Auto-captured
        ones start as "Unconfirmed" — click a refund to record whether the item came back to stock or
        was written off. Exportable to CSV for your accountant.
      </div>

      <RefundModal refund={open} onClose={() => setOpen(null)} />
    </ConceptLayout>
  );
};

export default RefundsPage;
