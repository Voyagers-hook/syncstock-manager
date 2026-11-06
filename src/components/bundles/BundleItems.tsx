import { useEffect, useState } from "react";
import { searchItems, totalsFor, type BundleItem, type ItemInfo } from "@/lib/bundles";

const gbp = (n: number) => "£" + (Math.round(n * 100) / 100).toFixed(2);

// One bundle's list of items: search to add, set quantities, see stock and cost as you go.
export function BundleItems({
  items, onChange, info, heading,
}: {
  items: BundleItem[];
  onChange: (items: BundleItem[]) => void;
  info?: Map<string, ItemInfo>;
  heading?: string;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ItemInfo[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    let live = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchItems(term);
        if (live) setResults(r);
      } finally {
        if (live) setBusy(false);
      }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const add = (r: ItemInfo) => {
    const at = items.findIndex((x) => x.variantId === r.variantId);
    if (at >= 0) onChange(items.map((x, i) => (i === at ? { ...x, qty: x.qty + 1 } : x)));
    else onChange([...items, { variantId: r.variantId, qty: 1, label: r.label }]);
    setQ("");
    setResults([]);
  };

  const t = totalsFor(items, info);
  const cols = "minmax(200px,1fr) 64px 70px 80px 80px 40px";

  return (
    <div style={{ marginBottom: 14 }}>
      {heading && <div style={{ fontWeight: 700, marginBottom: 6 }}>{heading}</div>}
      {items.length > 0 && (
        <div className="cl-vars">
          <div className="cl-var head" style={{ gridTemplateColumns: cols, minWidth: 560 }}>
            <span>Item</span><span>Qty</span><span>In stock</span><span>Cost</span><span>Sells at</span><span />
          </div>
          {items.map((it, i) => {
            const inf = info?.get(it.variantId);
            const short = inf ? inf.stock < Math.max(1, it.qty) : false;
            return (
              <div className="cl-var" key={it.variantId} style={{ gridTemplateColumns: cols, minWidth: 560 }}>
                <span style={{ fontSize: 13 }}>{inf?.label || it.label}</span>
                <input
                  inputMode="numeric"
                  value={String(it.qty)}
                  onChange={(e) => {
                    const n = Math.max(1, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 1));
                    onChange(items.map((x, j) => (j === i ? { ...x, qty: n } : x)));
                  }}
                  aria-label="Quantity in the bundle"
                />
                <span style={{ fontSize: 13, color: short ? "var(--out)" : undefined, fontWeight: short ? 700 : undefined }}>{inf ? inf.stock : "-"}</span>
                <span style={{ fontSize: 13 }}>{inf?.cost != null ? gbp(inf.cost * it.qty) : "Not set"}</span>
                <span style={{ fontSize: 13 }}>{inf?.price ? gbp(inf.price * it.qty) : "-"}</span>
                <button className="btn ghost" aria-label="Remove item" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
              </div>
            );
          })}
        </div>
      )}
      <div className="fld" style={{ position: "relative", marginBottom: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your stock to add an item (name or SKU)" />
        {(results.length > 0 || (busy && q.trim().length >= 2)) && (
          <div
            style={{
              position: "absolute", zIndex: 20, left: 0, right: 0, top: "100%", maxHeight: 300, overflowY: "auto",
              background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.08)",
            }}
          >
            {busy && !results.length && <div className="note" style={{ margin: 10 }}>Searching…</div>}
            {results.map((r) => (
              <button
                key={r.variantId}
                type="button"
                onClick={() => add(r)}
                style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 12, padding: "8px 12px", border: 0, borderTop: "1px solid #f1f3f7", background: "none", textAlign: "left", cursor: "pointer", font: "inherit", fontSize: 13 }}
              >
                <span>{r.label}</span>
                <span style={{ whiteSpace: "nowrap", color: r.stock > 0 ? "var(--muted)" : "var(--out)" }}>
                  {r.stock} in stock{r.price ? ` · ${gbp(r.price)}` : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {items.length > 0 && (
        <div className="cl-profit">
          <div><span>Bundles you can make</span><b className={t.stock > 0 ? "plain" : "neg"}>{t.stock}</b></div>
          <div><span>Cost of the items{t.costKnown ? "" : " (some costs not set)"}</span><b className="plain">{gbp(t.cost)}</b></div>
          <div><span>Items bought separately</span><b className="plain">{gbp(t.rrp)}</b></div>
        </div>
      )}
    </div>
  );
}
