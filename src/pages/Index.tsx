import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ConceptLayout, { Range, RANGE_LABEL, rangeSince } from "@/components/ConceptLayout";
import { useProducts } from "@/hooks/use-products";
import { useOrders } from "@/hooks/use-orders";
import { useRefunds } from "@/hooks/use-refunds";
import { useTopSellers } from "@/hooks/use-top-sellers";
import { useCompetitorMap } from "@/hooks/use-competitor-all";
import { FEE_RATES } from "@/hooks/use-sales";
import InventoryTable, { StockTarget, CompTarget } from "@/components/inventory/InventoryTable";
import StockModal from "@/components/modals/StockModal";
import CompModal from "@/components/modals/CompModal";

const gbp0 = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;

const Index = () => {
  const nav = useNavigate();
  const [range, setRange] = useState<Range>("30");
  const since = useMemo(() => rangeSince(range), [range]);
  const since30 = useMemo(() => rangeSince("30"), []);

  const { data: products = [] } = useProducts();
  const { data: orders = [] } = useOrders();
  const { data: refunds = [] } = useRefunds();
  const { data: compMap = {} } = useCompetitorMap();
  const { data: top = [] } = useTopSellers(5, "quantity", { from: since });
  const { data: worst = [] } = useTopSellers(5, "quantity", { from: since, order: "asc" });

  // Cost of goods per product (avg of its variant costs, else product cost).
  const prodCost = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      const costs = p.variants
        .map((v) => v.cost_price)
        .filter((c): c is number => typeof c === "number" && c > 0);
      if (costs.length) m.set(p.id, costs.reduce((a, b) => a + b, 0) / costs.length);
      else if (typeof p.cost_price === "number") m.set(p.id, p.cost_price);
    }
    return m;
  }, [products]);

  const stats = useMemo(() => {
    let turnover = 0,
      fees = 0,
      cogs = 0;
    for (const o of orders) {
      if (!o.ordered_at || o.ordered_at < since) continue;
      const rev = o.total_price ?? (o.unit_price ?? 0) * (o.quantity ?? 0);
      const r = o.platform === "ebay" ? FEE_RATES.ebay : FEE_RATES.squarespace;
      turnover += rev;
      fees += rev > 0 ? rev * r.pct + r.fixed : 0;
      cogs += (o.product_id ? prodCost.get(o.product_id) ?? 0 : 0) * (o.quantity ?? 0);
    }
    const profit = turnover - fees - cogs;

    const outOfStock = products.filter((p) => p.total_stock <= 0).length;
    const lowStock = products.filter((p) => p.total_stock > 0 && p.total_stock <= 3).length;

    let dearer = 0;
    for (const p of products) {
      for (const v of p.variants) {
        const listing = p.channel_listings.find((l) => l.variant_id === v.id && l.channel === "ebay");
        const eb = listing?.channel_price;
        const comp = compMap[v.id];
        if (eb && comp && (eb - comp.delivered) / comp.delivered >= 0.06) dearer++;
      }
    }
    return { turnover, profit, outOfStock, lowStock, dearer };
  }, [orders, products, compMap, prodCost, since]);

  const soldMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const o of orders) {
      if (!o.ordered_at || o.ordered_at < since30 || !o.product_id) continue;
      m[o.product_id] = (m[o.product_id] ?? 0) + (o.quantity ?? 0);
    }
    return m;
  }, [orders, since30]);

  const recentOrders = orders.slice(0, 4);
  const recentRefunds = refunds.slice(0, 3);

  const [stockTarget, setStockTarget] = useState<StockTarget | null>(null);
  const [compTarget, setCompTarget] = useState<CompTarget | null>(null);

  return (
    <ConceptLayout title="Dashboard" subtitle="Overview of everything" range={range} onRange={setRange}>
      <div className="grid5">
        <div className="card">
          <div className="lbl">Turnover ({range === "yr" ? "year" : range + "d"})</div>
          <div className="val">{gbp0(stats.turnover)}</div>
        </div>
        <div className="card">
          <div className="lbl">Profit (before P&amp;P)</div>
          <div className="val" style={{ color: stats.profit >= 0 ? "#067a57" : "var(--out)" }}>
            {gbp0(stats.profit)}
          </div>
        </div>
        <div className="card">
          <div className="lbl">
            Out of stock <span className="dot" style={{ background: "var(--out)" }} />
          </div>
          <div className="val" style={{ color: "var(--out)" }}>
            {stats.outOfStock}
          </div>
        </div>
        <div className="card">
          <div className="lbl">
            Low stock <span className="dot" style={{ background: "var(--low)" }} />
          </div>
          <div className="val" style={{ color: "var(--low)" }}>
            {stats.lowStock}
          </div>
        </div>
        <div className="card">
          <div className="lbl">
            Dearer than market <span className="dot" style={{ background: "var(--over)" }} />
          </div>
          <div className="val" style={{ color: "var(--over)" }}>
            {stats.dearer}
          </div>
        </div>
      </div>

      <div className="duo">
        <div className="panel">
          <h3>
            Top sellers <span className="per">{RANGE_LABEL[range]}</span>
          </h3>
          {top.length === 0 ? (
            <div className="empty">No sales in this period.</div>
          ) : (
            top.map((t, i) => (
              <div className="rank" key={t.variant_key}>
                <div className="n">{i + 1}</div>
                <div className="nm">{t.item_name}</div>
                <div className="q">
                  {t.total_quantity} <small>sold</small>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="panel">
          <h3>
            Worst sellers <span className="per">{RANGE_LABEL[range]}</span>
          </h3>
          {worst.length === 0 ? (
            <div className="empty">No sales in this period.</div>
          ) : (
            <div className="bars">
              {worst.map((t, i) => (
                <div className="rank" key={t.variant_key}>
                  <div className="n">{i + 1}</div>
                  <div className="nm">{t.item_name}</div>
                  <div className="q">
                    {t.total_quantity} <small>sold</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>
          Recent orders{" "}
          <span className="link" style={{ marginLeft: "auto" }} onClick={() => nav("/orders")}>
            View all →
          </span>
        </h3>
        {recentOrders.length === 0 ? (
          <div className="empty">No orders yet.</div>
        ) : (
          recentOrders.map((o) => (
            <div className="rank" key={o.id}>
              <span className={`plat ${o.platform === "ebay" ? "eb" : "sq"}`}>
                {o.platform === "ebay" ? "eBay" : "SQ"}
              </span>
              <div className="nm">{o.item_name ?? o.sku}</div>
              <div className="q">{money(o.total_price)}</div>
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h3>
          Recent refunds &amp; returns{" "}
          <span className="per" style={{ marginLeft: "auto" }}>
            <span className="link" onClick={() => nav("/refunds")}>
              View all →
            </span>
          </span>
        </h3>
        {recentRefunds.length === 0 ? (
          <div className="empty">No refunds yet.</div>
        ) : (
          recentRefunds.map((r) => (
            <div className="rank" key={r.id}>
              <span className={`plat ${r.platform === "ebay" ? "eb" : "sq"}`}>
                {r.platform === "ebay" ? "eBay" : "SQ"}
              </span>
              <div className="nm">{r.item_name}</div>
              <div className="q" style={{ color: "#be123c" }}>
                -{money(r.amount)}
              </div>
              {r.restocked ? (
                <span className="badge on">restocked</span>
              ) : (
                <span className="badge off">written off</span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="thead-wrap">
        <div className="cap">
          <h3>Inventory by brand</h3>
          <div className="legend">
            <span>
              <span className="tag sq" style={{ fontSize: 9 }}>
                SQ
              </span>{" "}
              website
            </span>
            <span>
              <span className="tag eb" style={{ fontSize: 9 }}>
                eB
              </span>{" "}
              eBay vs others' delivered
            </span>
            <span style={{ color: "var(--over)" }}>▲ dearer</span>
            <span className="link" onClick={() => nav("/inventory")}>
              Open inventory →
            </span>
          </div>
        </div>
        <InventoryTable
          products={products}
          soldMap={soldMap}
          compMap={compMap}
          onStock={setStockTarget}
          onComp={setCompTarget}
        />
      </div>

      <div className="note">
        Dashboard is the quick view of everything. Each section also has its own page in the sidebar
        if you want to focus on just that.
      </div>

      <StockModal target={stockTarget} onClose={() => setStockTarget(null)} />
      <CompModal target={compTarget} onClose={() => setCompTarget(null)} />
    </ConceptLayout>
  );
};

export default Index;
