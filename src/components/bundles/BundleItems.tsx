import { useEffect, useState } from "react";
import { toast } from "sonner";
import { guessOptionName, isChoose, productVariants, searchItems, totalsFor, type BundleItem, type ItemInfo } from "@/lib/bundles";

const gbp = (n: number) => "£" + (Math.round(n * 100) / 100).toFixed(2);

// One bundle's list of items. Each item is either:
//  - Fixed: one exact variant goes in every bundle, or
//  - Customer chooses: the whole listing goes in and the buyer picks the size or colour.
export function BundleItems({
  items, onChange, info, heading, allowChoose = false, hideTotals = false,
}: {
  items: BundleItem[];
  onChange: (items: BundleItem[]) => void;
  info?: Map<string, ItemInfo>;
  heading?: string;
  allowChoose?: boolean;
  hideTotals?: boolean;
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

  const close = () => { setQ(""); setResults([]); };

  const addFixed = (r: ItemInfo) => {
    const at = items.findIndex((x) => !isChoose(x) && x.variantId === r.variantId);
    if (at >= 0) onChange(items.map((x, i) => (i === at ? { ...x, qty: x.qty + 1 } : x)));
    else onChange([...items, { variantId: r.variantId, qty: 1, label: r.label, mode: "fixed" }]);
    close();
  };

  const addChoose = async (productId: string, productName: string) => {
    if (items.some((x) => isChoose(x) && x.productId === productId)) { toast.message("That listing is already in the bundle."); return close(); }
    try {
      const vars = await productVariants(productId);
      if (vars.length < 2) { toast.message("That listing only has one option, so it's been added as a fixed item."); if (vars[0]) addFixed(vars[0]); return; }
      const used = new Map<string, number>();
      const choices = vars.map((v) => {
        let label = (v.option || v.label).trim();
        const n = (used.get(label) ?? 0) + 1;
        used.set(label, n);
        if (n > 1) label = `${label} (${n})`;
        return { variantId: v.variantId, label, on: true };
      });
      const taken = new Set(items.filter(isChoose).map((x) => (x.optionName || "").toLowerCase()));
      let name = guessOptionName(choices.map((c) => c.label));
      if (taken.has(name.toLowerCase())) name = `${productName.split(" ").slice(0, 2).join(" ")} ${name.toLowerCase()}`;
      onChange([...items, { variantId: "", qty: 1, label: productName, mode: "choose", productId, optionName: name, choices }]);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't load that listing's options.");
    }
    close();
  };

  // Group search results by listing so "whole listing" can be offered once per listing.
  const groups: { productId: string; productName: string; rows: ItemInfo[] }[] = [];
  for (const r of results) {
    let g = groups.find((x) => x.productId === r.productId);
    if (!g) { g = { productId: r.productId, productName: r.productName, rows: [] }; groups.push(g); }
    g.rows.push(r);
  }

  const t = totalsFor(items, info);
  const cols = "minmax(200px,1fr) 64px 70px 80px 80px 40px";
  const fixedRows = items.map((it, i) => ({ it, i })).filter(({ it }) => !isChoose(it));
  const chooseRows = items.map((it, i) => ({ it, i })).filter(({ it }) => isChoose(it));
  const upd = (i: number, patch: Partial<BundleItem>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const qtyInput = (it: BundleItem, i: number) => (
    <input
      inputMode="numeric"
      value={String(it.qty)}
      onChange={(e) => upd(i, { qty: Math.max(1, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 1)) })}
      aria-label="Quantity in the bundle"
    />
  );

  return (
    <div style={{ marginBottom: 14 }}>
      {heading && <div style={{ fontWeight: 700, marginBottom: 6 }}>{heading}</div>}

      {fixedRows.length > 0 && (
        <div className="cl-vars">
          <div className="cl-var head" style={{ gridTemplateColumns: cols, minWidth: 560 }}>
            <span>Fixed item</span><span>Qty</span><span>In stock</span><span>Cost</span><span>Sells at</span><span />
          </div>
          {fixedRows.map(({ it, i }) => {
            const inf = info?.get(it.variantId);
            const short = inf ? inf.stock < Math.max(1, it.qty) : false;
            return (
              <div className="cl-var" key={it.variantId + i} style={{ gridTemplateColumns: cols, minWidth: 560 }}>
                <span style={{ fontSize: 13 }}>{inf?.label || it.label}</span>
                {qtyInput(it, i)}
                <span style={{ fontSize: 13, color: short ? "var(--out)" : undefined, fontWeight: short ? 700 : undefined }}>{inf ? inf.stock : "-"}</span>
                <span style={{ fontSize: 13 }}>{inf?.cost != null ? gbp(inf.cost * it.qty) : "Not set"}</span>
                <span style={{ fontSize: 13 }}>{inf?.price ? gbp(inf.price * it.qty) : "-"}</span>
                <button className="btn ghost" aria-label="Remove item" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
              </div>
            );
          })}
        </div>
      )}

      {chooseRows.map(({ it, i }) => {
        const on = (it.choices ?? []).filter((c) => c.on).length;
        return (
          <div key={(it.productId ?? "") + i} className="cl-vars" style={{ padding: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
              <div style={{ flex: "1 1 220px" }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{it.label}</div>
                <small style={{ color: "var(--muted)" }}>Customer chooses · {on} of {(it.choices ?? []).length} offered</small>
              </div>
              <div className="fld" style={{ margin: 0, width: 180 }}>
                <label>Dropdown name</label>
                <input value={it.optionName ?? ""} onChange={(e) => upd(i, { optionName: e.target.value })} placeholder="e.g. Line size" />
              </div>
              <div className="fld" style={{ margin: 0, width: 70 }}>
                <label>Qty</label>
                {qtyInput(it, i)}
              </div>
              <button className="btn ghost" aria-label="Remove item" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(it.choices ?? []).map((c, k) => {
                const inf = info?.get(c.variantId);
                return (
                  <label
                    key={c.variantId}
                    style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, border: "1px solid var(--line)", borderRadius: 8, padding: "5px 9px", background: c.on ? "#fff" : "#f7f9fc", opacity: c.on ? 1 : 0.6, cursor: "pointer" }}
                  >
                    <input type="checkbox" checked={c.on} onChange={(e) => upd(i, { choices: (it.choices ?? []).map((x, m) => (m === k ? { ...x, on: e.target.checked } : x)) })} />
                    {c.label}
                    <span style={{ color: inf && inf.stock < it.qty ? "var(--out)" : "var(--muted)" }}>
                      {inf ? `${inf.stock} in stock · ${inf.cost != null ? gbp(inf.cost * it.qty) : "no cost set"}` : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="fld" style={{ position: "relative", marginBottom: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your stock to add an item (name or SKU)" />
        {(results.length > 0 || (busy && q.trim().length >= 2)) && (
          <div
            style={{
              position: "absolute", zIndex: 20, left: 0, right: 0, top: "100%", maxHeight: 340, overflowY: "auto",
              background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.08)",
            }}
          >
            {busy && !results.length && <div className="note" style={{ margin: 10 }}>Searching…</div>}
            {groups.map((g) => (
              <div key={g.productId} style={{ borderTop: "1px solid #f1f3f7" }}>
                {allowChoose && g.rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => addChoose(g.productId, g.productName)}
                    style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 12, padding: "8px 12px", border: 0, background: "#f7f9fc", textAlign: "left", cursor: "pointer", font: "inherit", fontSize: 13, fontWeight: 650 }}
                  >
                    <span>{g.productName}</span>
                    <span style={{ whiteSpace: "nowrap", color: "var(--accent, #0097b2)" }}>Whole listing, customer chooses ({g.rows.length})</span>
                  </button>
                )}
                {g.rows.map((r) => (
                  <button
                    key={r.variantId}
                    type="button"
                    onClick={() => addFixed(r)}
                    style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 12, padding: "8px 12px 8px 20px", border: 0, background: "none", textAlign: "left", cursor: "pointer", font: "inherit", fontSize: 13 }}
                  >
                    <span>{r.label}</span>
                    <span style={{ whiteSpace: "nowrap", color: r.stock > 0 ? "var(--muted)" : "var(--out)" }}>
                      {r.stock} in stock{r.price ? ` · ${gbp(r.price)}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {!hideTotals && fixedRows.length > 0 && (
        <div className="cl-profit">
          <div><span>Bundles you can make</span><b className={t.stock > 0 ? "plain" : "neg"}>{t.stock}</b></div>
          <div><span>Cost of the items{t.costKnown ? "" : " (some costs not set)"}</span><b className="plain">{gbp(t.cost)}</b></div>
          <div><span>Items bought separately</span><b className="plain">{gbp(t.rrp)}</b></div>
        </div>
      )}
    </div>
  );
}
