import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useOrders } from "@/hooks/use-orders";
import { useProducts } from "@/hooks/use-products";
import { brandOf } from "@/lib/brand";
import { downloadCsv } from "@/lib/csv";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (iso: string) => iso.slice(0, 7);
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
};
const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "—";
const keyOf = (o: { product_id: string | null; item_name: string | null }) =>
  o.product_id ?? `name:${o.item_name ?? "unknown"}`;
const TEAL = "#0ea5a4";

const TrendsPage = () => {
  const { data: orders = [] } = useOrders();
  const { data: products = [] } = useProducts();

  const [metric, setMetric] = useState<"revenue" | "units">("revenue");
  const [brand, setBrand] = useState("All brands");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>("");

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) m.set(p.id, p.name);
    return m;
  }, [products]);
  const nameOf = (o: { product_id: string | null; item_name: string | null }) =>
    (o.product_id && nameById.get(o.product_id)) || o.item_name || "Unknown";

  const brands = useMemo(() => {
    const s = new Set<string>();
    for (const o of orders) s.add(brandOf(nameOf(o)));
    return ["All brands", ...Array.from(s).sort()];
  }, [orders, nameById]);

  // Orders scoped by the brand filter
  const fOrders = useMemo(
    () => (brand === "All brands" ? orders : orders.filter((o) => brandOf(nameOf(o)) === brand)),
    [orders, brand, nameById],
  );

  const months = useMemo(() => {
    const dated = fOrders.filter((o) => o.ordered_at);
    if (!dated.length) return [] as string[];
    const earliest = dated.reduce((a, o) => (o.ordered_at! < a ? o.ordered_at! : a), dated[0].ordered_at!);
    const start = new Date(earliest);
    const out: string[] = [];
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const now = new Date();
    while (cur <= now) {
      out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return out;
  }, [fOrders]);

  const overTime = useMemo(() => {
    const rev: Record<string, number> = {}, units: Record<string, number> = {};
    for (const o of fOrders) {
      if (!o.ordered_at) continue;
      const k = monthKey(o.ordered_at);
      rev[k] = (rev[k] ?? 0) + (o.total_price ?? 0);
      units[k] = (units[k] ?? 0) + (o.quantity ?? 0);
    }
    return months.map((k) => ({ month: monthLabel(k), revenue: Math.round(rev[k] ?? 0), units: units[k] ?? 0 }));
  }, [fOrders, months]);

  const movers = useMemo(() => {
    const now = Date.now(), d30 = now - 30 * 864e5, d60 = now - 60 * 864e5;
    const cur: Record<string, number> = {}, prev: Record<string, number> = {}, label: Record<string, string> = {};
    for (const o of fOrders) {
      if (!o.ordered_at) continue;
      const t = new Date(o.ordered_at).getTime(), k = keyOf(o);
      label[k] = nameOf(o);
      if (t >= d30) cur[k] = (cur[k] ?? 0) + (o.quantity ?? 0);
      else if (t >= d60) prev[k] = (prev[k] ?? 0) + (o.quantity ?? 0);
    }
    const rows = Object.keys({ ...cur, ...prev }).map((k) => {
      const c = cur[k] ?? 0, p = prev[k] ?? 0;
      const pct = p === 0 ? (c > 0 ? Infinity : 0) : ((c - p) / p) * 100;
      return { k, name: label[k], c, p, pct };
    });
    return {
      rising: rows.filter((r) => r.c + r.p >= 3 && r.pct > 0).sort((a, b) => (b.pct === Infinity ? 1e9 : b.pct) - (a.pct === Infinity ? 1e9 : a.pct)).slice(0, 8),
      cooling: rows.filter((r) => r.p >= 2 && r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 8),
    };
  }, [fOrders, nameById]);

  const heat = useMemo(() => {
    const byBrand: Record<string, Record<string, number>> = {}, totals: Record<string, number> = {};
    for (const o of fOrders) {
      if (!o.ordered_at) continue;
      const b = brandOf(nameOf(o)), k = monthKey(o.ordered_at);
      byBrand[b] = byBrand[b] ?? {};
      byBrand[b][k] = (byBrand[b][k] ?? 0) + (o.quantity ?? 0);
      totals[b] = (totals[b] ?? 0) + (o.quantity ?? 0);
    }
    const top = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 8);
    return top.map((b) => {
      const max = Math.max(1, ...months.map((k) => byBrand[b]?.[k] ?? 0));
      return { brand: b, cells: months.map((k) => ({ key: k, units: byBrand[b]?.[k] ?? 0, intensity: (byBrand[b]?.[k] ?? 0) / max })) };
    });
  }, [fOrders, months, nameById]);

  const productList = useMemo(() => {
    const units: Record<string, number> = {}, label: Record<string, string> = {};
    for (const o of fOrders) {
      const k = keyOf(o);
      units[k] = (units[k] ?? 0) + (o.quantity ?? 0);
      label[k] = nameOf(o);
    }
    return Object.keys(units).map((k) => ({ key: k, name: label[k], units: units[k] })).sort((a, b) => b.units - a.units);
  }, [fOrders, nameById]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return productList.slice(0, 8);
    return productList.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 10);
  }, [productList, query]);

  const selKey = selected || "";
  const selName = productList.find((p) => p.key === selKey)?.name ?? "";

  const selectProduct = (k: string, name: string) => {
    setSelected(k);
    setQuery(name);
    setOpen(false);
  };

  const productOrders = useMemo(
    () =>
      fOrders
        .filter((o) => keyOf(o) === selKey)
        .sort((a, b) => (b.ordered_at ?? "").localeCompare(a.ordered_at ?? "")),
    [fOrders, selKey],
  );

  const productMonthly = useMemo(() => {
    const u: Record<string, number> = {};
    for (const o of productOrders) if (o.ordered_at) u[monthKey(o.ordered_at)] = (u[monthKey(o.ordered_at)] ?? 0) + (o.quantity ?? 0);
    return months.map((k) => ({ month: monthLabel(k), units: u[k] ?? 0 }));
  }, [productOrders, months]);

  const today = new Date();
  const [aFrom, setAFrom] = useState(isoDate(new Date(today.getTime() - 90 * 864e5)));
  const [aTo, setATo] = useState(isoDate(today));
  const [bFrom, setBFrom] = useState(isoDate(new Date(today.getTime() - 180 * 864e5)));
  const [bTo, setBTo] = useState(isoDate(new Date(today.getTime() - 90 * 864e5)));
  const sumRange = (from: string, to: string) => {
    const start = from + "T00:00:00Z";
    const endD = new Date(to + "T00:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 1);
    const end = endD.toISOString();
    let units = 0, revenue = 0;
    for (const o of productOrders) if (o.ordered_at && o.ordered_at >= start && o.ordered_at < end) { units += o.quantity ?? 0; revenue += o.total_price ?? 0; }
    return { units, revenue };
  };
  const aTot = useMemo(() => sumRange(aFrom, aTo), [productOrders, aFrom, aTo]);
  const bTot = useMemo(() => sumRange(bFrom, bTo), [productOrders, bFrom, bTo]);

  const di = { border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5 };

  const exportMovers = () =>
    downloadCsv(
      `trends-movers-${isoDate(new Date())}`,
      [
        { key: "dir", label: "Direction" },
        { key: "name", label: "Item" },
        { key: "prev", label: "Prev 30d units" },
        { key: "cur", label: "Last 30d units" },
        { key: "pct", label: "Change %" },
      ],
      [
        ...movers.rising.map((r) => ({ dir: "Rising", name: r.name, prev: r.p, cur: r.c, pct: r.pct === Infinity ? "new" : Math.round(r.pct) })),
        ...movers.cooling.map((r) => ({ dir: "Cooling", name: r.name, prev: r.p, cur: r.c, pct: Math.round(r.pct) })),
      ],
    );

  const exportProductOrders = () =>
    downloadCsv(
      `sales-${selName.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`,
      [
        { key: "date", label: "Date" },
        { key: "order", label: "Order" },
        { key: "platform", label: "Platform" },
        { key: "qty", label: "Qty" },
        { key: "unit", label: "Unit £" },
        { key: "total", label: "Total £" },
        { key: "customer", label: "Customer" },
        { key: "town", label: "Town" },
      ],
      productOrders.map((o) => ({
        date: fmtDay(o.ordered_at),
        order: o.order_number ?? o.platform_order_id,
        platform: o.platform,
        qty: o.quantity,
        unit: o.unit_price ?? "",
        total: o.total_price ?? "",
        customer: o.customer_name ?? "",
        town: o.shipping_city ?? "",
      })),
    );

  const MoverRow = ({ r, down }: { r: any; down?: boolean }) => (
    <div
      onClick={() => selectProduct(r.k, r.name)}
      style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid #f4f6f9", fontSize: 13, cursor: "pointer" }}
      title="Click to see this item's sales"
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
      <span style={{ color: "#6b7280" }}>{r.p}→{r.c}</span>
      <span style={{ color: down ? "var(--over)" : "#067a57", fontWeight: 750, width: 56, textAlign: "right" }}>
        {down ? `▼ ${Math.round(-r.pct)}%` : r.pct === Infinity ? "new" : `▲ ${Math.round(r.pct)}%`}
      </span>
    </div>
  );

  return (
    <ConceptLayout title="Trends" subtitle="How sales move through the year" onExport={exportMovers}>
      <div className="bar" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={metric === "revenue" ? "on" : ""} onClick={() => setMetric("revenue")}>Revenue</button>
          <button className={metric === "units" ? "on" : ""} onClick={() => setMetric("units")}>Units</button>
        </div>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ ...di, background: "#fff", fontWeight: 600 }}>
          {brands.map((b) => <option key={b}>{b}</option>)}
        </select>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{productList.length} items in view</span>
      </div>

      {/* Sales over time */}
      <div className="panel">
        <h3>Sales over time <span className="per">{brand}</span></h3>
        <div style={{ padding: "16px 12px" }}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={overTime} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} width={48} tickFormatter={(v) => (metric === "revenue" ? gbp(v) : String(v))} />
              <Tooltip formatter={(v: any) => (metric === "revenue" ? gbp(v as number) : `${v} units`)} />
              <Bar dataKey={metric} fill={TEAL} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Movers (clickable) */}
      <div className="duo">
        <div className="panel">
          <h3>Heating up <span className="per">click an item · last 30d vs prev</span></h3>
          <div style={{ padding: "4px 20px 10px" }}>
            {movers.rising.length === 0 ? <div className="empty">Not enough recent data.</div> : movers.rising.map((r) => <MoverRow key={r.k} r={r} />)}
          </div>
        </div>
        <div className="panel">
          <h3>Cooling down <span className="per">click an item · last 30d vs prev</span></h3>
          <div style={{ padding: "4px 20px 10px" }}>
            {movers.cooling.length === 0 ? <div className="empty">Not enough recent data.</div> : movers.cooling.map((r) => <MoverRow key={r.k} r={r} down />)}
          </div>
        </div>
      </div>

      {/* Heatmap */}
      <div className="panel">
        <h3>Brand seasonality <span className="per">units per month · darker = stronger</span></h3>
        <div style={{ padding: "12px 20px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr>
              <th style={{ textAlign: "left", color: "#6b7280", fontWeight: 650, padding: "4px 6px" }}>Brand</th>
              {months.map((k) => <th key={k} style={{ color: "#6b7280", fontWeight: 650, padding: "4px 6px" }}>{monthLabel(k)}</th>)}
            </tr></thead>
            <tbody>
              {heat.map((row) => (
                <tr key={row.brand}>
                  <td style={{ fontWeight: 650, whiteSpace: "nowrap", padding: "4px 6px" }}>{row.brand}</td>
                  {row.cells.map((c) => (
                    <td key={c.key} style={{ padding: 2 }}>
                      <div title={`${c.units} units`} style={{ height: 26, borderRadius: 5, background: `rgba(14,165,164,${0.08 + c.intensity * 0.9})`, color: c.intensity > 0.6 ? "#fff" : "#0b3b39", fontWeight: 650, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {c.units || ""}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product search + detail */}
      <div className="panel">
        <h3>Find a product</h3>
        <div style={{ padding: "14px 20px" }}>
          <div style={{ position: "relative", maxWidth: 460 }}>
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              placeholder="Search for an item…"
              style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5, outline: "none" }}
            />
            {open && matches.length > 0 && (
              <div style={{ position: "absolute", zIndex: 5, top: "calc(100% + 4px)", left: 0, right: 0, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 10px 30px rgba(17,24,39,.12)", maxHeight: 280, overflowY: "auto" }}>
                {matches.map((p) => (
                  <div key={p.key} onClick={() => selectProduct(p.key, p.name)}
                    style={{ padding: "9px 12px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f4f6f9", display: "flex", gap: 8 }}
                    onMouseDown={(e) => e.preventDefault()}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span style={{ color: "#6b7280" }}>{p.units} sold</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {!selKey ? (
          <div className="empty" style={{ paddingBottom: 24 }}>Search for an item, or click one in Heating up / Cooling down above.</div>
        ) : (
          <>
            <div style={{ padding: "0 20px 6px", display: "flex", alignItems: "center", gap: 10 }}>
              <h3 style={{ border: 0, padding: 0, margin: 0 }}>{selName}</h3>
              <button className="btn ghost" style={{ marginLeft: "auto", padding: "7px 11px" }} onClick={exportProductOrders}>Download sales CSV</button>
            </div>
            <div style={{ padding: "6px 12px 4px" }}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={productMonthly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} width={36} allowDecimals={false} />
                  <Tooltip formatter={(v: any) => `${v} units`} />
                  <Line type="monotone" dataKey="units" stroke={TEAL} strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Period compare */}
            <div style={{ padding: "6px 20px 14px" }}>
              <p style={{ fontSize: 12.5, color: "#6b7280", margin: "6px 0 10px" }}>Compare two periods — e.g. Feb–Apr vs Nov–Jan:</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 15 }}>
                {[
                  { lbl: "PERIOD A", f: aFrom, t: aTo, sf: setAFrom, st: setATo, tot: aTot },
                  { lbl: "PERIOD B", f: bFrom, t: bTo, sf: setBFrom, st: setBTo, tot: bTot },
                ].map((p) => (
                  <div key={p.lbl} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 8 }}>{p.lbl}</div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                      <input type="date" value={p.f} onChange={(e) => p.sf(e.target.value)} style={di} />
                      <span style={{ color: "#6b7280" }}>to</span>
                      <input type="date" value={p.t} onChange={(e) => p.st(e.target.value)} style={di} />
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 820 }}>{p.tot.units} <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>units</span></div>
                    <div style={{ fontSize: 12.5, color: "#6b7280" }}>{gbp(p.tot.revenue)} sales</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "var(--brandSoft)", border: "1px solid #9cebe9", fontSize: 13, fontWeight: 650 }}>
                {(() => {
                  const diff = aTot.units - bTot.units;
                  if (aTot.units === 0 && bTot.units === 0) return "No sales in either period.";
                  if (bTot.units === 0) return `Period A sold ${aTot.units} — nothing in Period B.`;
                  const pct = Math.round((diff / bTot.units) * 100);
                  if (diff > 0) return `Period A sold ${diff} more (${pct}% up) — a busier window for this item.`;
                  if (diff < 0) return `Period A sold ${-diff} fewer (${-pct}% down) — a quieter window for this item.`;
                  return "Both periods sold the same.";
                })()}
              </div>
            </div>

            {/* Order history — when sold & to whom */}
            <div className="thead-wrap" style={{ margin: "0 20px 20px", borderRadius: 12 }}>
              <div className="cap"><h3>When it sold &amp; to whom <span className="per" style={{ marginLeft: "auto" }}>{productOrders.length} orders</span></h3></div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table>
                  <thead><tr>
                    <th>Date</th><th>Order</th><th className="c">Platform</th><th className="num">Qty</th><th className="num">Total</th><th>Customer</th><th>Town</th>
                  </tr></thead>
                  <tbody>
                    {productOrders.length === 0 ? (
                      <tr><td colSpan={7} className="empty">No sales recorded.</td></tr>
                    ) : productOrders.map((o) => (
                      <tr className="vrow" key={o.id}>
                        <td>{fmtDay(o.ordered_at)}</td>
                        <td style={{ fontSize: 12, color: "#6b7280" }}>{o.order_number ?? o.platform_order_id}</td>
                        <td className="c"><span className={`plat ${o.platform === "ebay" ? "eb" : "sq"}`}>{o.platform === "ebay" ? "eBay" : "SQ"}</span></td>
                        <td className="num">{o.quantity}</td>
                        <td className="num">{money(o.total_price)}</td>
                        <td>{o.customer_name ?? "—"}</td>
                        <td style={{ color: "#6b7280" }}>{o.shipping_city ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="note">
        Trends are built from captured orders, which currently start 2 April 2026. Use the brand
        filter and search to focus; click any mover to load its sales history. Year-round patterns get
        richer once earlier history is imported.
      </div>
    </ConceptLayout>
  );
};

export default TrendsPage;
