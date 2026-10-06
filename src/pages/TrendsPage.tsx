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
const TEAL = "#0ea5a4";

type Item = { key: string; name: string; productId: string };

// Tiny inline sparkline from a series of numbers.
function Sparkline({ data, color = TEAL }: { data: number[]; color?: string }) {
  const w = 72, h = 22, n = data.length;
  if (!n) return <svg width={w} height={h} />;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / Math.max(1, n - 1)) * (w - 2) + 1},${h - 1 - (v / max) * (h - 3)}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const TrendsPage = () => {
  const { data: orders = [] } = useOrders();
  const { data: products = [] } = useProducts();

  const [metric, setMetric] = useState<"revenue" | "units">("revenue");
  const [brand, setBrand] = useState("All brands");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [focusMonth, setFocusMonth] = useState<string | null>(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) m.set(p.id, p.name);
    return m;
  }, [products]);

  // Map an order's (channel + sku) to its specific VARIANT, with a readable label
  // like "Fjuka 2mm Pellets — Yellow". This is what makes the page item-level.
  const itemIndex = useMemo(() => {
    const m = new Map<string, Item>();
    for (const p of products) {
      for (const v of p.variants) {
        const opt = [v.option1, v.option2].filter(Boolean).join(" / ");
        const label = opt ? `${p.name} — ${opt}` : p.name;
        for (const l of p.channel_listings.filter((x) => x.variant_id === v.id)) {
          if (l.channel_sku) m.set(`${l.channel}|${l.channel_sku}`, { key: v.id, name: label, productId: p.id });
          if (l.channel_variant_id) m.set(`${l.channel}|${l.channel_variant_id}`, { key: v.id, name: label, productId: p.id });
        }
      }
    }
    return m;
  }, [products]);

  const resolve = (o: { platform: string; sku: string | null; product_id: string | null; item_name: string | null }): Item => {
    const hit = itemIndex.get(`${o.platform}|${o.sku}`);
    if (hit) return hit;
    const base = (o.product_id && nameById.get(o.product_id)) || o.item_name || "Unknown";
    return { key: `${o.product_id ?? "np"}::${o.sku ?? ""}`, name: o.sku && o.sku !== base ? `${base} — ${o.sku}` : base, productId: o.product_id ?? "" };
  };

  const brands = useMemo(() => {
    const s = new Set<string>();
    for (const o of orders) s.add(brandOf(resolve(o).name));
    return ["All brands", ...Array.from(s).sort()];
  }, [orders, itemIndex, nameById]);

  const fOrders = useMemo(
    () => (brand === "All brands" ? orders : orders.filter((o) => brandOf(resolve(o).name) === brand)),
    [orders, brand, itemIndex, nameById],
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
    return months.map((k) => ({ key: k, month: monthLabel(k), revenue: Math.round(rev[k] ?? 0), units: units[k] ?? 0 }));
  }, [fOrders, months]);

  const movers = useMemo(() => {
    const now = Date.now(), d30 = now - 30 * 864e5, d60 = now - 60 * 864e5;
    const cur: Record<string, number> = {}, prev: Record<string, number> = {}, label: Record<string, string> = {};
    for (const o of fOrders) {
      if (!o.ordered_at) continue;
      const t = new Date(o.ordered_at).getTime(), r = resolve(o);
      label[r.key] = r.name;
      if (t >= d30) cur[r.key] = (cur[r.key] ?? 0) + (o.quantity ?? 0);
      else if (t >= d60) prev[r.key] = (prev[r.key] ?? 0) + (o.quantity ?? 0);
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
  }, [fOrders, itemIndex, nameById]);

  const heat = useMemo(() => {
    const byBrand: Record<string, Record<string, number>> = {}, totals: Record<string, number> = {};
    for (const o of fOrders) {
      if (!o.ordered_at) continue;
      const b = brandOf(resolve(o).name), k = monthKey(o.ordered_at);
      byBrand[b] = byBrand[b] ?? {};
      byBrand[b][k] = (byBrand[b][k] ?? 0) + (o.quantity ?? 0);
      totals[b] = (totals[b] ?? 0) + (o.quantity ?? 0);
    }
    const top = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 8);
    return top.map((b) => {
      const max = Math.max(1, ...months.map((k) => byBrand[b]?.[k] ?? 0));
      return { brand: b, cells: months.map((k) => ({ key: k, units: byBrand[b]?.[k] ?? 0, intensity: (byBrand[b]?.[k] ?? 0) / max })) };
    });
  }, [fOrders, months, itemIndex, nameById]);

  const itemList = useMemo(() => {
    const units: Record<string, number> = {}, label: Record<string, string> = {};
    for (const o of fOrders) {
      const r = resolve(o);
      units[r.key] = (units[r.key] ?? 0) + (o.quantity ?? 0);
      label[r.key] = r.name;
    }
    return Object.keys(units).map((k) => ({ key: k, name: label[k], units: units[k] })).sort((a, b) => b.units - a.units);
  }, [fOrders, itemIndex, nameById]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return itemList.slice(0, 8);
    return itemList.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [itemList, query]);

  // Per-variant stock, cost and readable name (for restock + dead-stock).
  const variantMeta = useMemo(() => {
    const m = new Map<string, { name: string; stock: number; cost: number }>();
    for (const p of products) {
      for (const v of p.variants) {
        const opt = [v.option1, v.option2].filter(Boolean).join(" / ");
        const inv = p.inventory.find((i) => i.variant_id === v.id);
        m.set(v.id, {
          name: opt ? `${p.name} — ${opt}` : p.name,
          stock: inv?.total_stock ?? 0,
          cost: (typeof v.cost_price === "number" && v.cost_price) || p.cost_price || 0,
        });
      }
    }
    return m;
  }, [products]);

  // One pass: units in last 56d / 90d and a 10-week series per item key.
  const pass = useMemo(() => {
    const u56: Record<string, number> = {}, u90: Record<string, number> = {}, weekly: Record<string, number[]> = {};
    const now = Date.now();
    for (const o of fOrders) {
      if (!o.ordered_at) continue;
      const r = resolve(o);
      const days = (now - new Date(o.ordered_at).getTime()) / 864e5;
      const q = o.quantity ?? 0;
      if (days < 56) u56[r.key] = (u56[r.key] ?? 0) + q;
      if (days < 90) u90[r.key] = (u90[r.key] ?? 0) + q;
      const wk = Math.floor(days / 7);
      if (wk >= 0 && wk < 10) (weekly[r.key] = weekly[r.key] ?? new Array(10).fill(0))[9 - wk] += q;
    }
    return { u56, u90, weekly };
  }, [fOrders, itemIndex, nameById]);

  // Restock suggestions + dead stock
  const stockInsight = useMemo(() => {
    const restock: { id: string; name: string; stock: number; perWeek: number; weeksCover: number }[] = [];
    const dead: { id: string; name: string; stock: number; cash: number }[] = [];
    for (const [id, meta] of variantMeta) {
      const u56 = pass.u56[id] ?? 0;
      const u90 = pass.u90[id] ?? 0;
      if (u56 > 0) {
        const perWeek = u56 / 8;
        const weeksCover = meta.stock / Math.max(0.01, u56 / 8);
        restock.push({ id, name: meta.name, stock: meta.stock, perWeek, weeksCover });
      }
      if (meta.stock > 0 && u90 === 0) dead.push({ id, name: meta.name, stock: meta.stock, cash: meta.stock * meta.cost });
    }
    restock.sort((a, b) => a.weeksCover - b.weeksCover);
    dead.sort((a, b) => b.cash - a.cash);
    const deadCash = dead.reduce((s, d) => s + d.cash, 0);
    return { restock: restock.filter((r) => r.weeksCover < 4).slice(0, 12), dead: dead.slice(0, 12), deadCash };
  }, [variantMeta, pass]);

  // Price position vs market (from eBay price + stored competitor delivered).
  const priceOps = useMemo(() => {
    const over: { label: string; pct: number; price: number; del: number }[] = [];
    const under: { label: string; pct: number; price: number; del: number }[] = [];
    for (const p of products) {
      if (brand !== "All brands" && brandOf(p.name) !== brand) continue;
      for (const v of p.variants) {
        const l = p.channel_listings.find((x) => x.variant_id === v.id && x.channel === "ebay");
        const price = l?.channel_price;
        const comp = compMap[v.id];
        if (price && comp && comp.delivered > 0) {
          const dd = (price - comp.delivered) / comp.delivered;
          const opt = [v.option1, v.option2].filter(Boolean).join(" / ");
          const label = opt ? `${p.name} — ${opt}` : p.name;
          if (dd >= 0.12) over.push({ label, pct: Math.round(dd * 100), price, del: comp.delivered });
          else if (dd <= -0.12) under.push({ label, pct: Math.round(-dd * 100), price, del: comp.delivered });
        }
      }
    }
    over.sort((a, b) => b.pct - a.pct);
    under.sort((a, b) => b.pct - a.pct);
    return { over, under };
  }, [products, compMap, brand]);

  // Drill-down: items sold in the clicked month
  const monthItems = useMemo(() => {
    if (!focusMonth) return [] as { key: string; name: string; units: number; revenue: number }[];
    const u: Record<string, number> = {}, rev: Record<string, number> = {}, label: Record<string, string> = {};
    for (const o of fOrders) {
      if (!o.ordered_at || monthKey(o.ordered_at) !== focusMonth) continue;
      const r = resolve(o);
      u[r.key] = (u[r.key] ?? 0) + (o.quantity ?? 0);
      rev[r.key] = (rev[r.key] ?? 0) + (o.total_price ?? 0);
      label[r.key] = r.name;
    }
    return Object.keys(u).map((k) => ({ key: k, name: label[k], units: u[k], revenue: rev[k] })).sort((a, b) => b.units - a.units).slice(0, 20);
  }, [fOrders, focusMonth, itemIndex, nameById]);

  const selKey = selected || "";
  const selName = itemList.find((p) => p.key === selKey)?.name ?? "";
  const selectItem = (k: string, name: string) => { setSelected(k); setQuery(name); setOpen(false); };

  const itemOrders = useMemo(
    () => fOrders.filter((o) => resolve(o).key === selKey).sort((a, b) => (b.ordered_at ?? "").localeCompare(a.ordered_at ?? "")),
    [fOrders, selKey, itemIndex, nameById],
  );

  const itemMonthly = useMemo(() => {
    const u: Record<string, number> = {};
    for (const o of itemOrders) if (o.ordered_at) u[monthKey(o.ordered_at)] = (u[monthKey(o.ordered_at)] ?? 0) + (o.quantity ?? 0);
    return months.map((k) => ({ month: monthLabel(k), units: u[k] ?? 0 }));
  }, [itemOrders, months]);

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
    for (const o of itemOrders) if (o.ordered_at && o.ordered_at >= start && o.ordered_at < end) { units += o.quantity ?? 0; revenue += o.total_price ?? 0; }
    return { units, revenue };
  };
  const aTot = useMemo(() => sumRange(aFrom, aTo), [itemOrders, aFrom, aTo]);
  const bTot = useMemo(() => sumRange(bFrom, bTo), [itemOrders, bFrom, bTo]);

  const shiftYear = (iso: string) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return isoDate(d);
  };
  const aLastYear = useMemo(() => sumRange(shiftYear(aFrom), shiftYear(aTo)), [itemOrders, aFrom, aTo]);
  // Projected next 30 days for the selected item, from its last-8-week velocity.
  const projected30 = useMemo(() => Math.round(((pass.u56[selKey] ?? 0) / 56) * 30), [pass, selKey]);

  const di = { border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5 };

  const exportMovers = () =>
    downloadCsv(`trends-movers-${isoDate(new Date())}`,
      [{ key: "dir", label: "Direction" }, { key: "name", label: "Item" }, { key: "prev", label: "Prev 30d" }, { key: "cur", label: "Last 30d" }, { key: "pct", label: "Change %" }],
      [...movers.rising.map((r) => ({ dir: "Rising", name: r.name, prev: r.p, cur: r.c, pct: r.pct === Infinity ? "new" : Math.round(r.pct) })),
       ...movers.cooling.map((r) => ({ dir: "Cooling", name: r.name, prev: r.p, cur: r.c, pct: Math.round(r.pct) }))]);

  const exportItemOrders = () =>
    downloadCsv(`sales-${selName.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`,
      [{ key: "date", label: "Date" }, { key: "order", label: "Order" }, { key: "platform", label: "Platform" }, { key: "qty", label: "Qty" }, { key: "unit", label: "Unit £" }, { key: "total", label: "Total £" }, { key: "customer", label: "Customer" }, { key: "town", label: "Town" }],
      itemOrders.map((o) => ({ date: fmtDay(o.ordered_at), order: o.order_number ?? o.platform_order_id, platform: o.platform, qty: o.quantity, unit: o.unit_price ?? "", total: o.total_price ?? "", customer: o.customer_name ?? "", town: o.shipping_city ?? "" })));

  const MoverRow = ({ r, down }: { r: any; down?: boolean }) => (
    <div onClick={() => selectItem(r.k, r.name)} title="Click to see this item's sales"
      style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid #f4f6f9", fontSize: 13, cursor: "pointer" }}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
      <Sparkline data={pass.weekly[r.k] ?? []} color={down ? "#e11d48" : "#067a57"} />
      <span style={{ color: "#6b7280", width: 44, textAlign: "right" }}>{r.p}→{r.c}</span>
      <span style={{ color: down ? "var(--over)" : "#067a57", fontWeight: 750, width: 56, textAlign: "right" }}>
        {down ? `▼ ${Math.round(-r.pct)}%` : r.pct === Infinity ? "new" : `▲ ${Math.round(r.pct)}%`}
      </span>
    </div>
  );

  return (
    <ConceptLayout title="Trends" subtitle="Item-level sales through the year" onExport={exportMovers}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={metric === "revenue" ? "on" : ""} onClick={() => setMetric("revenue")}>Revenue</button>
          <button className={metric === "units" ? "on" : ""} onClick={() => setMetric("units")}>Units</button>
        </div>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ ...di, background: "#fff", fontWeight: 600 }}>
          {brands.map((b) => <option key={b}>{b}</option>)}
        </select>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{itemList.length} items in view</span>
      </div>

      {/* Actionable suggestions */}
      {(() => {
        const peak = overTime.reduce((a, b) => (b.revenue > (a?.revenue ?? -1) ? b : a), overTime[0]);
        const TONES: Record<string, { bg: string; fg: string }> = {
          REORDER: { bg: "#fff0f3", fg: "#be123c" },
          RISING: { bg: "#e8f8f1", fg: "#067a57" },
          PRICE: { bg: "#e6fbfa", fg: "#0b7c7b" },
          CLEAR: { bg: "#eff4ff", fg: "#2563eb" },
          SLOWING: { bg: "#fff7e8", fg: "#a9640a" },
          SEASON: { bg: "#f1f5f9", fg: "#475569" },
        };
        const sugg: { tag: string; text: string }[] = [];
        for (const r of stockInsight.restock) {
          if (r.weeksCover < 2.5) sugg.push({ tag: "REORDER", text: `${r.name} — about ${r.weeksCover.toFixed(1)} weeks of stock left at ~${r.perWeek.toFixed(1)}/week. Reorder now.` });
          if (sugg.length >= 2) break;
        }
        const riser = movers.rising[0];
        if (riser) sugg.push({ tag: "RISING", text: `${riser.name} is ${riser.pct === Infinity ? "newly selling" : `up ${Math.round(riser.pct)}%`} on the previous 30 days — keep it well stocked.` });
        if (priceOps.over[0]) { const o = priceOps.over[0]; sugg.push({ tag: "PRICE", text: `You're ${o.pct}% above the market on ${o.label} (${money(o.price)} vs ${money(o.del)} delivered). Consider lowering to stay competitive.` }); }
        if (priceOps.under[0]) { const u = priceOps.under[0]; sugg.push({ tag: "PRICE", text: `You're ${u.pct}% below the market on ${u.label} (${money(u.price)} vs ${money(u.del)} delivered) — room to raise your price.` }); }
        if (stockInsight.deadCash > 0) { const names = stockInsight.dead.slice(0, 3).map((d) => d.name).join(", "); sugg.push({ tag: "CLEAR", text: `${gbp(stockInsight.deadCash)} tied up in ${stockInsight.dead.length} items with no sales in 90 days — consider discounting ${names}.` }); }
        const cooler = movers.cooling[0];
        if (cooler) sugg.push({ tag: "SLOWING", text: `${cooler.name} is down ${Math.round(-cooler.pct)}% on the previous 30 days — ease off reordering.` });
        if (peak) sugg.push({ tag: "SEASON", text: `Your strongest month so far is ${peak.month} (${gbp(peak.revenue)}). Build stock ahead of it.` });
        const shown = sugg.slice(0, 6);
        if (!shown.length) return null;
        return (
          <div className="panel" style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 10 }}>Suggestions</div>
            <div style={{ display: "grid", gap: 9 }}>
              {shown.map((s, i) => {
                const tone = TONES[s.tag] ?? TONES.SEASON;
                return (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.55 }}>
                    <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, letterSpacing: ".04em", padding: "3px 8px", borderRadius: 6, background: tone.bg, color: tone.fg, minWidth: 68, textAlign: "center" }}>{s.tag}</span>
                    <span>{s.text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Sales over time — click a month to drill in */}
      <div className="panel">
        <h3>Sales over time <span className="per">{brand} · click a month to drill in</span></h3>
        <div style={{ padding: "16px 12px" }}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={overTime} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
              onClick={(st: any) => {
                const lbl = st?.activeLabel;
                const row = overTime.find((r) => r.month === lbl);
                if (row) setFocusMonth(row.key === focusMonth ? null : row.key);
              }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} width={48} tickFormatter={(v) => (metric === "revenue" ? gbp(v) : String(v))} />
              <Tooltip formatter={(v: any) => (metric === "revenue" ? gbp(v as number) : `${v} units`)} />
              <Bar dataKey={metric} fill={TEAL} radius={[4, 4, 0, 0]} cursor="pointer" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Month drill-down */}
      {focusMonth && (
        <div className="thead-wrap" style={{ marginBottom: 15 }}>
          <div className="cap">
            <h3>Items sold in {monthLabel(focusMonth)} <span className="per" style={{ marginLeft: 10 }}>{monthItems.length} items</span></h3>
            <span className="link" onClick={() => setFocusMonth(null)}>Clear</span>
          </div>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            <table>
              <thead><tr><th style={{ width: "55%" }}>Item</th><th className="num">Units</th><th className="num">Sales</th><th></th></tr></thead>
              <tbody>
                {monthItems.map((m) => (
                  <tr className="vrow" key={m.key} style={{ cursor: "pointer" }} onClick={() => selectItem(m.key, m.name)}>
                    <td>{m.name}</td>
                    <td className="num">{m.units}</td>
                    <td className="num">{gbp(m.revenue)}</td>
                    <td className="num"><span className="link">view →</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Movers */}
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

      {/* Restock + dead stock */}
      <div className="duo">
        <div className="panel">
          <h3>Reorder soon <span className="per">stock vs recent pace</span></h3>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th style={{ width: "40%" }}>Item</th><th className="num">In stock</th><th className="num">~ / week</th><th className="num">Cover</th><th></th></tr></thead>
              <tbody>
                {stockInsight.restock.length === 0 ? (
                  <tr><td colSpan={5} className="empty">Nothing running low.</td></tr>
                ) : stockInsight.restock.map((r) => (
                  <tr className="vrow" key={r.id} style={{ cursor: "pointer" }} onClick={() => selectItem(r.id, r.name)}>
                    <td>{r.name}</td>
                    <td className="num">{r.stock}</td>
                    <td className="num">{r.perWeek.toFixed(1)}</td>
                    <td className="num" style={{ fontWeight: 750, color: r.weeksCover < 1.5 ? "var(--over)" : r.weeksCover < 3 ? "var(--low)" : "inherit" }}>
                      {r.weeksCover < 0.1 ? "0" : r.weeksCover.toFixed(1)}w
                    </td>
                    <td><Sparkline data={pass.weekly[r.id] ?? []} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h3>Dead stock <span className="per">no sales in 90 days · {gbp(stockInsight.deadCash)} tied up</span></h3>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th style={{ width: "55%" }}>Item</th><th className="num">In stock</th><th className="num">Cash</th></tr></thead>
              <tbody>
                {stockInsight.dead.length === 0 ? (
                  <tr><td colSpan={3} className="empty">No dead stock — nice.</td></tr>
                ) : stockInsight.dead.map((d) => (
                  <tr className="vrow" key={d.id} style={{ cursor: "pointer" }} onClick={() => selectItem(d.id, d.name)}>
                    <td>{d.name}</td>
                    <td className="num">{d.stock}</td>
                    <td className="num">{gbp(d.cash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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

      {/* Item search + detail */}
      <div className="panel">
        <h3>Find an item</h3>
        <div style={{ padding: "14px 20px" }}>
          <div style={{ position: "relative", maxWidth: 480 }}>
            <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
              placeholder="Search for an item (e.g. Fjuka Yellow)…"
              style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5, outline: "none" }} />
            {open && matches.length > 0 && (
              <div style={{ position: "absolute", zIndex: 5, top: "calc(100% + 4px)", left: 0, right: 0, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 10px 30px rgba(17,24,39,.12)", maxHeight: 300, overflowY: "auto" }}>
                {matches.map((p) => (
                  <div key={p.key} onMouseDown={(e) => e.preventDefault()} onClick={() => selectItem(p.key, p.name)}
                    style={{ padding: "9px 12px", fontSize: 13, cursor: "pointer", borderBottom: "1px solid #f4f6f9", display: "flex", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span style={{ color: "#6b7280" }}>{p.units} sold</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {!selKey ? (
          <div className="empty" style={{ paddingBottom: 24 }}>Search for an item, click one in the lists above, or click a month on the chart.</div>
        ) : (
          <>
            <div style={{ padding: "0 20px 6px", display: "flex", alignItems: "center", gap: 10 }}>
              <h3 style={{ border: 0, padding: 0, margin: 0 }}>{selName}</h3>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#067a57", background: "#e8f8f1", borderRadius: 999, padding: "4px 10px" }}>
                ~{projected30} forecast next 30d
              </span>
              <button className="btn ghost" style={{ marginLeft: "auto", padding: "7px 11px" }} onClick={exportItemOrders}>Download sales CSV</button>
            </div>
            <div style={{ padding: "6px 12px 4px" }}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={itemMonthly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f8" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} width={36} allowDecimals={false} />
                  <Tooltip formatter={(v: any) => `${v} units`} />
                  <Line type="monotone" dataKey="units" stroke={TEAL} strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

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
              <div style={{ marginTop: 8, fontSize: 12.5, color: "#6b7280" }}>
                Period A the year before: {aLastYear.units > 0 ? `${aLastYear.units} units (${gbp(aLastYear.revenue)})` : "no history yet — import earlier orders to compare year-on-year"}
              </div>
            </div>

            <div className="thead-wrap" style={{ margin: "0 20px 20px", borderRadius: 12 }}>
              <div className="cap"><h3>When it sold &amp; to whom <span className="per" style={{ marginLeft: "auto" }}>{itemOrders.length} orders</span></h3></div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table>
                  <thead><tr><th>Date</th><th>Order</th><th className="c">Platform</th><th className="num">Qty</th><th className="num">Total</th><th>Customer</th><th>Town</th></tr></thead>
                  <tbody>
                    {itemOrders.length === 0 ? (
                      <tr><td colSpan={7} className="empty">No sales recorded.</td></tr>
                    ) : itemOrders.map((o) => (
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
        Every figure here is item-level (each size/colour counted separately). Click a month on the
        chart, or any mover, to drill in. Built from orders captured since 2 April 2026.
      </div>
    </ConceptLayout>
  );
};

export default TrendsPage;
