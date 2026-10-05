import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useOrders } from "@/hooks/use-orders";
import { useProducts } from "@/hooks/use-products";
import { brandOf } from "@/lib/brand";
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
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (iso: string) => iso.slice(0, 7); // YYYY-MM
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
};
const keyOf = (o: { product_id: string | null; item_name: string | null }) =>
  o.product_id ?? `name:${o.item_name ?? "unknown"}`;

const TEAL = "#0ea5a4";

const TrendsPage = () => {
  const { data: orders = [] } = useOrders();
  const { data: products = [] } = useProducts();

  const [metric, setMetric] = useState<"revenue" | "units">("revenue");
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) m.set(p.id, p.name);
    return m;
  }, [products]);
  const nameOf = (o: { product_id: string | null; item_name: string | null }) =>
    (o.product_id && nameById.get(o.product_id)) || o.item_name || "Unknown";

  // Month axis from earliest order to now
  const months = useMemo(() => {
    const dated = orders.filter((o) => o.ordered_at);
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
  }, [orders]);

  // Sales over time (all products)
  const overTime = useMemo(() => {
    const rev: Record<string, number> = {};
    const units: Record<string, number> = {};
    for (const o of orders) {
      if (!o.ordered_at) continue;
      const k = monthKey(o.ordered_at);
      rev[k] = (rev[k] ?? 0) + (o.total_price ?? 0);
      units[k] = (units[k] ?? 0) + (o.quantity ?? 0);
    }
    return months.map((k) => ({ month: monthLabel(k), revenue: Math.round(rev[k] ?? 0), units: units[k] ?? 0 }));
  }, [orders, months]);

  // Heating up / cooling down: last 30d vs previous 30d by units
  const movers = useMemo(() => {
    const now = Date.now();
    const d30 = now - 30 * 864e5;
    const d60 = now - 60 * 864e5;
    const cur: Record<string, number> = {};
    const prev: Record<string, number> = {};
    const label: Record<string, string> = {};
    for (const o of orders) {
      if (!o.ordered_at) continue;
      const t = new Date(o.ordered_at).getTime();
      const k = keyOf(o);
      label[k] = nameOf(o);
      if (t >= d30) cur[k] = (cur[k] ?? 0) + (o.quantity ?? 0);
      else if (t >= d60) prev[k] = (prev[k] ?? 0) + (o.quantity ?? 0);
    }
    const rows = Object.keys({ ...cur, ...prev }).map((k) => {
      const c = cur[k] ?? 0, p = prev[k] ?? 0;
      const pct = p === 0 ? (c > 0 ? Infinity : 0) : ((c - p) / p) * 100;
      return { k, name: label[k], c, p, pct };
    });
    const rising = rows
      .filter((r) => r.c + r.p >= 3 && r.pct > 0)
      .sort((a, b) => (b.pct === Infinity ? 1e9 : b.pct) - (a.pct === Infinity ? 1e9 : a.pct))
      .slice(0, 6);
    const cooling = rows
      .filter((r) => r.p >= 2 && r.pct < 0)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 6);
    return { rising, cooling };
  }, [orders, nameById]);

  // Brand seasonality heatmap
  const heat = useMemo(() => {
    const byBrand: Record<string, Record<string, number>> = {};
    const totals: Record<string, number> = {};
    for (const o of orders) {
      if (!o.ordered_at) continue;
      const b = brandOf(nameOf(o));
      const k = monthKey(o.ordered_at);
      byBrand[b] = byBrand[b] ?? {};
      byBrand[b][k] = (byBrand[b][k] ?? 0) + (o.quantity ?? 0);
      totals[b] = (totals[b] ?? 0) + (o.quantity ?? 0);
    }
    const topBrands = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 7);
    return topBrands.map((b) => {
      const max = Math.max(1, ...months.map((k) => byBrand[b]?.[k] ?? 0));
      return { brand: b, cells: months.map((k) => ({ key: k, units: byBrand[b]?.[k] ?? 0, intensity: (byBrand[b]?.[k] ?? 0) / max })) };
    });
  }, [orders, months, nameById]);

  // Product picker + per-product monthly
  const productList = useMemo(() => {
    const units: Record<string, number> = {};
    const label: Record<string, string> = {};
    for (const o of orders) {
      const k = keyOf(o);
      units[k] = (units[k] ?? 0) + (o.quantity ?? 0);
      label[k] = nameOf(o);
    }
    return Object.keys(units)
      .map((k) => ({ key: k, name: label[k], units: units[k] }))
      .sort((a, b) => b.units - a.units);
  }, [orders, nameById]);

  const [selected, setSelected] = useState<string>("");
  const selKey = selected || productList[0]?.key || "";
  const selName = productList.find((p) => p.key === selKey)?.name ?? "";

  const productMonthly = useMemo(() => {
    const u: Record<string, number> = {};
    for (const o of orders) {
      if (!o.ordered_at || keyOf(o) !== selKey) continue;
      u[monthKey(o.ordered_at)] = (u[monthKey(o.ordered_at)] ?? 0) + (o.quantity ?? 0);
    }
    return months.map((k) => ({ month: monthLabel(k), units: u[k] ?? 0 }));
  }, [orders, months, selKey]);

  // Two-range comparator
  const today = new Date();
  const [aFrom, setAFrom] = useState(isoDate(new Date(today.getTime() - 90 * 864e5)));
  const [aTo, setATo] = useState(isoDate(today));
  const [bFrom, setBFrom] = useState(isoDate(new Date(today.getTime() - 180 * 864e5)));
  const [bTo, setBTo] = useState(isoDate(new Date(today.getTime() - 90 * 864e5)));

  const sumRange = (from: string, to: string) => {
    const start = from + "T00:00:00Z";
    const endD = new Date(to + "T00:00:00Z");
    endD.setUTCDate(endD.getUTCDate() + 1);
    const end = endD.toISOString();
    let units = 0, revenue = 0;
    for (const o of orders) {
      if (!o.ordered_at || keyOf(o) !== selKey) continue;
      if (o.ordered_at >= start && o.ordered_at < end) {
        units += o.quantity ?? 0;
        revenue += o.total_price ?? 0;
      }
    }
    return { units, revenue };
  };
  const aTot = useMemo(() => sumRange(aFrom, aTo), [orders, selKey, aFrom, aTo]);
  const bTot = useMemo(() => sumRange(bFrom, bTo), [orders, selKey, bFrom, bTo]);

  const dateInput = { border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5 };

  return (
    <ConceptLayout title="Trends" subtitle="How sales move through the year">
      {/* Sales over time */}
      <div className="panel">
        <div className="ph" style={{ display: "flex", alignItems: "center", gap: 9, padding: "15px 20px", borderBottom: "1px solid var(--line)", fontWeight: 750 }}>
          Sales over time
          <div className="seg" style={{ marginLeft: "auto" }}>
            <button className={metric === "revenue" ? "on" : ""} onClick={() => setMetric("revenue")}>Revenue</button>
            <button className={metric === "units" ? "on" : ""} onClick={() => setMetric("units")}>Units</button>
          </div>
        </div>
        <div style={{ padding: "16px 12px" }}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={overTime} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} width={48}
                tickFormatter={(v) => (metric === "revenue" ? gbp(v) : String(v))} />
              <Tooltip formatter={(v: any) => (metric === "revenue" ? gbp(v as number) : `${v} units`)} />
              <Bar dataKey={metric} fill={TEAL} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Movers */}
      <div className="duo">
        <div className="panel">
          <h3>Heating up <span className="per">last 30d vs previous 30d</span></h3>
          <div style={{ padding: "4px 20px 10px" }}>
            {movers.rising.length === 0 ? (
              <div className="empty">Not enough recent data.</div>
            ) : (
              movers.rising.map((r) => (
                <div key={r.k} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid #f4f6f9", fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ color: "#6b7280" }}>{r.p}→{r.c}</span>
                  <span className="up" style={{ color: "#067a57", fontWeight: 750, width: 56, textAlign: "right" }}>
                    {r.pct === Infinity ? "new" : `▲ ${Math.round(r.pct)}%`}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="panel">
          <h3>Cooling down <span className="per">last 30d vs previous 30d</span></h3>
          <div style={{ padding: "4px 20px 10px" }}>
            {movers.cooling.length === 0 ? (
              <div className="empty">Not enough recent data.</div>
            ) : (
              movers.cooling.map((r) => (
                <div key={r.k} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid #f4f6f9", fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ color: "#6b7280" }}>{r.p}→{r.c}</span>
                  <span style={{ color: "var(--over)", fontWeight: 750, width: 56, textAlign: "right" }}>▼ {Math.round(-r.pct)}%</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Brand seasonality heatmap */}
      <div className="panel">
        <h3>Brand seasonality <span className="per">units per month · darker = stronger</span></h3>
        <div style={{ padding: "12px 20px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", color: "#6b7280", fontWeight: 650, padding: "4px 6px" }}>Brand</th>
                {months.map((k) => (
                  <th key={k} style={{ color: "#6b7280", fontWeight: 650, padding: "4px 6px" }}>{monthLabel(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heat.map((row) => (
                <tr key={row.brand}>
                  <td style={{ fontWeight: 650, whiteSpace: "nowrap", padding: "4px 6px" }}>{row.brand}</td>
                  {row.cells.map((c) => (
                    <td key={c.key} style={{ padding: 2 }}>
                      <div
                        title={`${c.units} units`}
                        style={{
                          height: 26,
                          borderRadius: 5,
                          background: `rgba(14,165,164,${0.08 + c.intensity * 0.9})`,
                          color: c.intensity > 0.6 ? "#fff" : "#0b3b39",
                          fontWeight: 650,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
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

      {/* Per-product trend + range compare */}
      <div className="panel">
        <h3>
          Product trend &amp; season compare
          <select
            value={selKey}
            onChange={(e) => setSelected(e.target.value)}
            style={{ marginLeft: "auto", maxWidth: 320, border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5, background: "#fff" }}
          >
            {productList.slice(0, 400).map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.units})
              </option>
            ))}
          </select>
        </h3>
        <div style={{ padding: "16px 12px 4px" }}>
          <ResponsiveContainer width="100%" height={210}>
            <LineChart data={productMonthly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} width={36} allowDecimals={false} />
              <Tooltip formatter={(v: any) => `${v} units`} />
              <Line type="monotone" dataKey="units" stroke={TEAL} strokeWidth={2.5} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div style={{ padding: "6px 20px 20px" }}>
          <p style={{ fontSize: 12.5, color: "#6b7280", margin: "6px 0 10px" }}>
            Compare two periods for <b style={{ color: "#111827" }}>{selName}</b> — e.g. Feb–Apr vs Nov–Jan — to plan stock:
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 15 }}>
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 8 }}>PERIOD A</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                <input type="date" value={aFrom} onChange={(e) => setAFrom(e.target.value)} style={dateInput} />
                <span style={{ color: "#6b7280" }}>to</span>
                <input type="date" value={aTo} onChange={(e) => setATo(e.target.value)} style={dateInput} />
              </div>
              <div style={{ fontSize: 26, fontWeight: 820 }}>{aTot.units} <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>units</span></div>
              <div style={{ fontSize: 12.5, color: "#6b7280" }}>{gbp(aTot.revenue)} sales</div>
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 8 }}>PERIOD B</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                <input type="date" value={bFrom} onChange={(e) => setBFrom(e.target.value)} style={dateInput} />
                <span style={{ color: "#6b7280" }}>to</span>
                <input type="date" value={bTo} onChange={(e) => setBTo(e.target.value)} style={dateInput} />
              </div>
              <div style={{ fontSize: 26, fontWeight: 820 }}>{bTot.units} <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>units</span></div>
              <div style={{ fontSize: 12.5, color: "#6b7280" }}>{gbp(bTot.revenue)} sales</div>
            </div>
          </div>
          <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "var(--brandSoft)", border: "1px solid #9cebe9", fontSize: 13, fontWeight: 650 }}>
            {(() => {
              const diff = aTot.units - bTot.units;
              if (aTot.units === 0 && bTot.units === 0) return "No sales in either period.";
              if (bTot.units === 0) return `Period A sold ${aTot.units} — nothing in Period B.`;
              const pct = Math.round((diff / bTot.units) * 100);
              if (diff > 0) return `Period A sold ${diff} more (${pct}% up on Period B) — a busier window for this item.`;
              if (diff < 0) return `Period A sold ${-diff} fewer (${-pct}% down on Period B) — a quieter window for this item.`;
              return "Both periods sold the same.";
            })()}
          </div>
        </div>
      </div>

      <div className="note">
        Trends are built from captured orders, which currently start 2 April 2026. Year-round and
        year-on-year patterns get richer once earlier history is imported.
      </div>
    </ConceptLayout>
  );
};

export default TrendsPage;
