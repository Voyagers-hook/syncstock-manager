import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useUpdateChannelPrice,
  useClearSalePrice,
  useUpdateVariantCost,
} from "@/hooks/use-products";

export interface PriceTarget {
  variantId: string;
  productName: string;
  variantLabel: string | null;
  cost: number | null;
  ebay: { id: string; price: number | null } | null;
  sq: { id: string; base: number | null; sale: number | null; onSale: boolean } | null;
}

export default function PriceModal({
  target,
  onClose,
}: {
  target: PriceTarget | null;
  onClose: () => void;
}) {
  const updatePrice = useUpdateChannelPrice();
  const clearSale = useClearSalePrice();
  const updateCost = useUpdateVariantCost();
  const [saving, setSaving] = useState(false);

  const [ebay, setEbay] = useState("");
  const [sqBase, setSqBase] = useState("");
  const [sqSale, setSqSale] = useState("");
  const [onSale, setOnSale] = useState(false);
  const [cost, setCost] = useState("");

  useEffect(() => {
    if (target) {
      setEbay(target.ebay?.price != null ? String(target.ebay.price) : "");
      setSqBase(target.sq?.base != null ? String(target.sq.base) : "");
      setSqSale(target.sq?.sale != null ? String(target.sq.sale) : "");
      setOnSale(target.sq?.onSale ?? false);
      setCost(target.cost != null ? String(target.cost) : "");
    }
  }, [target?.variantId]);

  if (!target) return null;

  const num = (s: string) => (s.trim() === "" ? null : parseFloat(s));

  const save = async () => {
    setSaving(true);
    try {
      // eBay price
      if (target.ebay && num(ebay) != null && num(ebay) !== target.ebay.price) {
        await updatePrice.mutateAsync({ listingId: target.ebay.id, variantId: target.variantId, price: num(ebay)!, channel: "ebay" });
      }
      // Squarespace base price
      if (target.sq && num(sqBase) != null && num(sqBase) !== target.sq.base) {
        await updatePrice.mutateAsync({ listingId: target.sq.id, variantId: target.variantId, price: num(sqBase)!, channel: "squarespace", priceType: "base", updateSaleToggle: onSale });
      }
      // Squarespace sale price / toggle
      if (target.sq) {
        const saleNum = num(sqSale);
        if (saleNum == null && target.sq.sale != null) {
          await clearSale.mutateAsync({ listingId: target.sq.id });
        } else if (saleNum != null && (saleNum !== target.sq.sale || onSale !== target.sq.onSale)) {
          await updatePrice.mutateAsync({ listingId: target.sq.id, variantId: target.variantId, price: saleNum, channel: "squarespace", priceType: "sale", updateSaleToggle: onSale });
        }
      }
      // Cost price
      if (num(cost) != null && num(cost) !== target.cost) {
        await updateCost.mutateAsync({ variantId: target.variantId, cost: num(cost)! });
      }
      toast.success("Saved and pushed to the channels.");
      onClose();
    } catch (e: any) {
      toast.error(e.message ?? "Could not save prices.");
    } finally {
      setSaving(false);
    }
  };

  const fieldRow = (label: string, input: React.ReactNode, note?: string) => (
    <div className="fld">
      <label>{label}</label>
      {input}
      {note && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{note}</div>}
    </div>
  );
  const priceInput = (v: string, set: (s: string) => void) => (
    <div style={{ position: "relative" }}>
      <span style={{ position: "absolute", left: 11, top: 10, color: "var(--muted)" }}>£</span>
      <input type="number" step="0.01" min={0} value={v} onChange={(e) => set(e.target.value)} style={{ paddingLeft: 22 }} />
    </div>
  );

  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh">
          <span className="x" onClick={onClose}>×</span>
          <div className="t">Prices &amp; cost</div>
          <div className="s">{target.productName}{target.variantLabel ? ` — ${target.variantLabel}` : ""}</div>
        </div>
        <div className="mb">
          {target.ebay && fieldRow("eBay price", priceInput(ebay, setEbay), "Pushes straight to the eBay listing.")}
          {target.sq && fieldRow("Squarespace price", priceInput(sqBase, setSqBase))}
          {target.sq && fieldRow(
            "Squarespace sale price (optional)",
            priceInput(sqSale, setSqSale),
            undefined,
          )}
          {target.sq && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: -6, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={onSale} onChange={(e) => setOnSale(e.target.checked)} style={{ width: "auto" }} />
              Sale price active
            </label>
          )}
          {fieldRow("Cost price (what you pay)", priceInput(cost, setCost), "Used for profit and margin figures. Not shown to buyers.")}
          {!target.ebay && !target.sq && (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>This item has no live listing to price — you can still set a cost.</div>
          )}
        </div>
        <div className="mf">
          <button className="btn primary" style={{ flex: 1 }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
