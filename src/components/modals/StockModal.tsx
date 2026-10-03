import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useStockAdjust } from "@/hooks/use-stock-adjust";
import type { StockTarget } from "@/components/inventory/InventoryTable";

const REASONS = [
  "Sold (off-platform)",
  "Returned - back to stock",
  "Damaged in transit - write off",
  "Lost in post - write off",
  "Stocktake correction",
  "New stock received",
];

export default function StockModal({
  target,
  onClose,
}: {
  target: StockTarget | null;
  onClose: () => void;
}) {
  const adjust = useStockAdjust();
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (target) {
      setQty(target.currentStock);
      setReason(REASONS[0]);
      setNote("");
    }
  }, [target?.variantId]);

  if (!target) return null;

  const save = () => {
    if (qty === target.currentStock) {
      toast.info("That's the same as the current stock.");
      return;
    }
    adjust.mutate(
      {
        inventoryId: target.inventoryId,
        variantId: target.variantId,
        productId: target.productId,
        oldStock: target.currentStock,
        newStock: qty,
        reason,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Stock updated and pushed to both channels.");
          onClose();
        },
        onError: (e: any) => toast.error(e.message),
      },
    );
  };

  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh">
          <span className="x" onClick={onClose}>
            ×
          </span>
          <div className="t">
            {target.productName}
            {target.variantLabel ? ` ${target.variantLabel}` : ""}
          </div>
          <div className="s">Every change is logged with a reason</div>
        </div>
        <div className="mb">
          <div className="fld">
            <label>New stock level</label>
            <div className="stepper">
              <button onClick={() => setQty((q) => Math.max(0, q - 1))}>−</button>
              <span className="q">{qty}</span>
              <button onClick={() => setQty((q) => q + 1)}>+</button>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                was <b>{target.currentStock}</b>
              </span>
            </div>
          </div>
          <div className="fld">
            <label>Reason</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label>Comments (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. box crushed by courier, 2 unusable"
            />
          </div>
        </div>
        <div className="mf">
          <button className="btn primary" style={{ flex: 1 }} onClick={save} disabled={adjust.isPending}>
            {adjust.isPending ? "Saving…" : "Save change"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
