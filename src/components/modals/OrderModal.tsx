import { useEffect, useState } from "react";
import { useCreateRefund } from "@/hooks/use-refunds";
import type { OrderRow } from "@/hooks/use-orders";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

const REASONS = [
  "Returned unwanted",
  "Faulty / not as described",
  "Damaged in transit",
  "Lost in post",
  "Changed mind",
];

export default function OrderModal({
  order,
  onClose,
}: {
  order: OrderRow | null;
  onClose: () => void;
}) {
  const create = useCreateRefund();
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [restock, setRestock] = useState(true);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (order) {
      setReturning(false);
      setReason(REASONS[0]);
      setRestock(true);
      setNote("");
    }
  }, [order?.id]);

  if (!order) return null;

  const addr = [
    order.shipping_address_line1,
    order.shipping_address_line2,
    order.shipping_city,
    order.shipping_county,
    order.shipping_postcode,
    order.shipping_country,
  ].filter(Boolean);

  const confirm = () => {
    create.mutate(
      {
        platform: order.platform,
        orderId: order.platform_order_id,
        orderNumber: order.order_number,
        productId: order.product_id,
        sku: order.sku,
        itemName: order.item_name,
        amount: order.total_price ?? order.unit_price ?? 0,
        reason,
        note: note.trim() || undefined,
        quantity: order.quantity ?? 1,
        restock,
      },
      { onSuccess: onClose },
    );
  };

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #f4f6f9", fontSize: 13 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontWeight: 650, textAlign: "right", maxWidth: "65%" }}>{value}</span>
    </div>
  );

  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh">
          <span className="x" onClick={onClose}>
            ×
          </span>
          <div className="t">Order {order.order_number ?? order.platform_order_id}</div>
          <div className="s">
            {order.platform === "ebay" ? "eBay" : "Squarespace"} · {fmtDate(order.ordered_at)}
          </div>
        </div>
        <div className="mb">
          {!returning ? (
            <>
              <div style={{ marginBottom: 14 }}>
                <Row label="Item" value={order.item_name ?? order.sku ?? "—"} />
                <Row label="Quantity" value={String(order.quantity ?? 1)} />
                <Row label="Unit price" value={money(order.unit_price)} />
                <Row label="Order total" value={money(order.total_price)} />
                <Row label="Status" value={order.fulfillment_status ?? order.status ?? "—"} />
                {order.tracking_number && (
                  <Row
                    label="Tracking"
                    value={`${order.tracking_carrier ? order.tracking_carrier + " · " : ""}${order.tracking_number}`}
                  />
                )}
              </div>

              <div className="fld">
                <label>Customer</label>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 650 }}>{order.customer_name ?? "—"}</div>
                  {order.customer_email && (
                    <div style={{ color: "var(--muted)" }}>{order.customer_email}</div>
                  )}
                  {addr.length > 0 && (
                    <div style={{ color: "var(--muted)" }}>{addr.join(", ")}</div>
                  )}
                  {!order.customer_name && !order.customer_email && addr.length === 0 && (
                    <div style={{ color: "var(--muted)" }}>
                      No customer details captured for this order.
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="fld">
                <label>What happened?</label>
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label>Stock</label>
                <div className="radios">
                  <label className={restock ? "sel" : ""} onClick={() => setRestock(true)}>
                    <input type="radio" name="rr" readOnly checked={restock} /> Put back into stock (+
                    {order.quantity ?? 1})
                  </label>
                  <label className={!restock ? "sel" : ""} onClick={() => setRestock(false)}>
                    <input type="radio" name="rr" readOnly checked={!restock} /> Write off (don't
                    restock)
                  </label>
                </div>
              </div>
              <div className="fld">
                <label>Comments (optional)</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. returned sealed, resaleable"
                />
              </div>
            </>
          )}
        </div>
        <div className="mf">
          {!returning ? (
            <>
              <button className="btn primary" style={{ flex: 1 }} onClick={() => setReturning(true)}>
                Process return
              </button>
              <button className="btn ghost" onClick={onClose}>
                Close
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" style={{ flex: 1 }} onClick={confirm} disabled={create.isPending}>
                {create.isPending ? "Saving…" : "Confirm return & refund"}
              </button>
              <button className="btn ghost" onClick={() => setReturning(false)} disabled={create.isPending}>
                Back
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
