import { useSetRefundOutcome, RefundRow } from "@/hooks/use-refunds";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export default function RefundModal({ refund, onClose }: { refund: RefundRow | null; onClose: () => void }) {
  const setOutcome = useSetRefundOutcome();
  if (!refund) return null;

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #f4f6f9", fontSize: 13 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontWeight: 650, textAlign: "right", maxWidth: "65%" }}>{value}</span>
    </div>
  );

  const current = refund.restock_state; // 'restocked' | 'writeoff' | null
  const opt = (state: "restocked" | "writeoff" | null, label: string) => (
    <label className={current === state ? "sel" : ""} onClick={() => setOutcome.mutate({ id: refund.id, state })}>
      <input type="radio" name="outcome" readOnly checked={current === state} /> {label}
    </label>
  );

  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh">
          <span className="x" onClick={onClose}>×</span>
          <div className="t">Refund details</div>
          <div className="s">{refund.item_name ?? "—"}</div>
        </div>
        <div className="mb">
          <Row label="Date" value={fmtDate(refund.created_at)} />
          <Row label="Platform" value={refund.platform === "ebay" ? "eBay" : "Squarespace"} />
          <Row label="Order" value={refund.order_number ?? refund.order_id} />
          <Row label="Amount refunded" value={money(refund.amount)} />
          <Row label="Reason" value={refund.reason ?? "—"} />
          <Row label="Recorded by" value={refund.source === "auto" ? "Auto-captured" : "Added manually"} />
          {refund.note && <Row label="Note" value={refund.note} />}

          <div className="fld" style={{ marginTop: 16 }}>
            <label>Stock outcome</label>
            <div className="radios">
              {opt("restocked", "Back to stock")}
              {opt("writeoff", "Written off")}
              {opt(null, "Unconfirmed")}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
              This is a record only — it won't change your stock level (set stock on Inventory). Use it
              to note what happened to the returned item.
            </div>
          </div>
        </div>
        <div className="mf">
          <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
