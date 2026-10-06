import { useState } from "react";
import type { ProductWithDetails } from "@/lib/types";
import { brandOf } from "@/lib/brand";
import type { BestComp } from "@/hooks/use-competitor-all";
import type { PriceTarget } from "@/components/modals/PriceModal";

export interface StockTarget {
  productName: string;
  variantLabel: string | null;
  inventoryId: string;
  variantId: string;
  productId: string;
  currentStock: number;
}
export interface CompTarget {
  variantId: string;
  productName: string;
  query: string;
  yourDelivered: number | null;
}

const LOW = 3;
const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;

interface VRow {
  productId: string;
  productName: string;
  variantId: string;
  inventoryId: string | null;
  label: string | null;
  stock: number;
  ebayPrice: number | null;
  sqPrice: number | null;
  sqOnSale: boolean;
  cost: number | null;
  priceTarget: PriceTarget;
}

function rowsFor(p: ProductWithDetails): VRow[] {
  const build = (variantId: string, v: any | null): VRow => {
    const inv = v ? p.inventory.find((i) => i.variant_id === variantId) : p.inventory[0];
    const listings = p.channel_listings.filter((l) => l.variant_id === variantId);
    const ebay = listings.find((l) => l.channel === "ebay");
    const sq = listings.find((l) => l.channel === "squarespace");
    const sqPrice = sq ? (sq.sq_on_sale ? sq.sq_sale_price ?? sq.channel_price : sq.sq_base_price ?? sq.channel_price) : null;
    const label = v ? [v.option1, v.option2].filter(Boolean).join(" / ") || null : null;
    const cost = (v && typeof v.cost_price === "number" && v.cost_price) || p.cost_price || null;
    return {
      productId: p.id,
      productName: p.name,
      variantId,
      inventoryId: inv?.id ?? null,
      label,
      stock: inv?.total_stock ?? 0,
      ebayPrice: ebay?.channel_price ?? null,
      sqPrice,
      sqOnSale: sq?.sq_on_sale ?? false,
      cost,
      priceTarget: {
        variantId,
        productName: p.name,
        variantLabel: label,
        cost,
        ebay: ebay ? { id: ebay.id, price: ebay.channel_price } : null,
        sq: sq ? { id: sq.id, base: sq.sq_base_price ?? sq.channel_price, sale: sq.sq_sale_price ?? null, onSale: sq.sq_on_sale ?? false } : null,
      },
    };
  };
  if (!p.variants.length) return [build(p.id, null)];
  return p.variants.map((v) => build(v.id, v));
}

function StatusPill({ stock }: { stock: number }) {
  if (stock <= 0) return <span className="pill out">Out</span>;
  if (stock <= LOW) return <span className="pill low">Low</span>;
  return <span className="pill good">In stock</span>;
}

export default function InventoryTable({
  products,
  soldMap,
  compMap,
  onStock,
  onComp,
  onPrice,
  search = "",
}: {
  products: ProductWithDetails[];
  soldMap: Record<string, number>;
  compMap: Record<string, BestComp>;
  onStock: (t: StockTarget) => void;
  onComp: (t: CompTarget) => void;
  onPrice: (t: PriceTarget) => void;
  search?: string;
}) {
  const [closedBrands, setClosedBrands] = useState<Set<string>>(new Set());
  const [openProducts, setOpenProducts] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();

  const byBrand = new Map<string, ProductWithDetails[]>();
  for (const p of products) {
    if (q && !p.name.toLowerCase().includes(q)) continue;
    const b = brandOf(p.name);
    const bucket = byBrand.get(b) ?? [];
    bucket.push(p);
    byBrand.set(b, bucket);
  }
  const brands = Array.from(byBrand.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  const toggleBrand = (b: string) =>
    setClosedBrands((prev) => { const n = new Set(prev); n.has(b) ? n.delete(b) : n.add(b); return n; });
  const toggleProduct = (id: string) =>
    setOpenProducts((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const priceCell = (r: VRow) => (
    <div className="pcell">
      <span>
        <span className="tag eb">eB</span>{" "}
        <span className="price" style={{ cursor: "pointer", borderBottom: "1px dashed #cbd5e1" }} onClick={() => onPrice(r.priceTarget)}>{money(r.ebayPrice)}</span>
      </span>
      {r.ebayPrice !== null && <Chip row={r} comp={compMap[r.variantId]} onClick={() => onComp({ variantId: r.variantId, productName: r.productName, query: r.productName, yourDelivered: r.ebayPrice })} />}
    </div>
  );

  const stockBtn = (r: VRow) => (
    <span className="stockbtn" style={{ color: r.stock <= 0 ? "var(--out)" : r.stock <= LOW ? "var(--low)" : "var(--ink)" }}
      onClick={() => r.inventoryId && onStock({ productName: r.productName, variantLabel: r.label, inventoryId: r.inventoryId, variantId: r.variantId, productId: r.productId, currentStock: r.stock })}>
      {r.stock}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
    </span>
  );

  const sqCell = (r: VRow) => (
    <>
      <span className="tag sq">SQ</span>{" "}
      <span className="price" style={{ cursor: "pointer", borderBottom: "1px dashed #cbd5e1" }} onClick={() => onPrice(r.priceTarget)}>{money(r.sqPrice)}</span>
      {r.sqOnSale && <span style={{ marginLeft: 4, fontSize: 10, color: "var(--over)", fontWeight: 700 }}>SALE</span>}
    </>
  );

  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: "34%" }}>Item</th>
          <th className="c">Stock</th>
          <th className="num">Squarespace</th>
          <th className="num">eBay · vs market</th>
          <th className="num">Sold 30d</th>
          <th className="c">Status</th>
        </tr>
      </thead>
      <tbody>
        {brands.length === 0 && <tr><td colSpan={6} className="empty">No items match.</td></tr>}
        {brands.map(([brand, prods]) => {
          const brandOpen = !closedBrands.has(brand);
          const units = prods.reduce((s, p) => s + p.total_stock, 0);
          return (
            <>
              <tr className={`brow ${brandOpen ? "" : "collapsed"}`} key={`b-${brand}`} onClick={() => toggleBrand(brand)}>
                <td colSpan={6}>
                  <span className="chev">▾</span>{brand}
                  <span className="cnt">{prods.length} product{prods.length === 1 ? "" : "s"} · {units} in stock</span>
                </td>
              </tr>
              {brandOpen && prods.map((p) => {
                const rows = rowsFor(p);
                const sold = soldMap[p.id] ?? 0;
                if (rows.length === 1) {
                  const r = rows[0];
                  return (
                    <tr className="vrow" key={`p-${p.id}`}>
                      <td className="pname" style={{ paddingLeft: 36 }}><b>{r.productName}</b>{r.label && <small>{r.label}</small>}</td>
                      <td className="c">{stockBtn(r)}</td>
                      <td className="num">{sqCell(r)}</td>
                      <td className="num">{priceCell(r)}</td>
                      <td className="num">{sold}</td>
                      <td className="c"><StatusPill stock={r.stock} /></td>
                    </tr>
                  );
                }
                const prodOpen = openProducts.has(p.id);
                return (
                  <>
                    <tr className={`brow ${prodOpen ? "" : "collapsed"}`} key={`pg-${p.id}`} style={{ cursor: "pointer" }} onClick={() => toggleProduct(p.id)}>
                      <td colSpan={6} style={{ paddingLeft: 36, background: "#fbfcfe", fontWeight: 650 }}>
                        <span className="chev">▾</span>{p.name}
                        <span className="cnt">{rows.length} options · {p.total_stock} in stock · {sold} sold 30d</span>
                      </td>
                    </tr>
                    {prodOpen && rows.map((r) => (
                      <tr className="vrow" key={`v-${r.variantId}`}>
                        <td style={{ paddingLeft: 56, color: "#374151" }}>{r.label ?? "Default"}</td>
                        <td className="c">{stockBtn(r)}</td>
                        <td className="num">{sqCell(r)}</td>
                        <td className="num">{priceCell(r)}</td>
                        <td className="num"></td>
                        <td className="c"><StatusPill stock={r.stock} /></td>
                      </tr>
                    ))}
                  </>
                );
              })}
            </>
          );
        })}
      </tbody>
    </table>
  );
}

function Chip({ row, comp, onClick }: { row: VRow; comp: BestComp | undefined; onClick: () => void }) {
  if (!comp || row.ebayPrice === null) return <span className="cmp ok" onClick={onClick}>check market</span>;
  const bd = comp.delivered;
  const dd = (row.ebayPrice - bd) / bd;
  if (dd >= 0.06) return <span className="cmp over" onClick={onClick}>▲ {Math.round(dd * 100)}% vs {money(bd)} del.</span>;
  if (dd <= -0.1) return <span className="cmp under" onClick={onClick}>▼ {Math.round(-dd * 100)}% vs {money(bd)} del.</span>;
  return <span className="cmp ok" onClick={onClick}>in line · {money(bd)}</span>;
}
