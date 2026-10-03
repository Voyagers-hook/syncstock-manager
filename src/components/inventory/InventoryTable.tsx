import { useState } from "react";
import type { ProductWithDetails } from "@/lib/types";
import { brandOf } from "@/lib/brand";
import type { BestComp } from "@/hooks/use-competitor-all";

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
  sold: number;
  status: "good" | "low" | "out";
}

function rowsFor(p: ProductWithDetails, soldMap: Record<string, number>): VRow[] {
  const mk = (
    variantId: string,
    inventoryId: string | null,
    label: string | null,
    stock: number,
    ebay: number | null,
    sq: number | null,
  ): VRow => ({
    productId: p.id,
    productName: p.name,
    variantId,
    inventoryId,
    label,
    stock,
    ebayPrice: ebay,
    sqPrice: sq,
    sold: soldMap[p.id] ?? 0,
    status: stock <= 0 ? "out" : stock <= LOW ? "low" : "good",
  });

  if (!p.variants.length) {
    return [mk(p.id, null, null, p.total_stock, p.ebay_price, p.squarespace_price)];
  }
  return p.variants.map((v) => {
    const inv = p.inventory.find((i) => i.variant_id === v.id);
    const listings = p.channel_listings.filter((l) => l.variant_id === v.id);
    const ebay = listings.find((l) => l.channel === "ebay");
    const sq = listings.find((l) => l.channel === "squarespace");
    const sqPrice = sq
      ? sq.sq_on_sale
        ? sq.sq_sale_price ?? sq.channel_price
        : sq.sq_base_price ?? sq.channel_price
      : null;
    const label = [v.option1, v.option2].filter(Boolean).join(" / ") || null;
    return mk(
      v.id,
      inv?.id ?? null,
      label,
      inv?.total_stock ?? 0,
      ebay?.channel_price ?? p.ebay_price,
      sqPrice ?? p.squarespace_price,
    );
  });
}

function Chip({
  row,
  comp,
  onClick,
}: {
  row: VRow;
  comp: BestComp | undefined;
  onClick: () => void;
}) {
  if (!comp || row.ebayPrice === null) {
    return (
      <span className="cmp ok" onClick={onClick}>
        check market
      </span>
    );
  }
  const bd = comp.delivered;
  const dd = (row.ebayPrice - bd) / bd;
  if (dd >= 0.06)
    return (
      <span className="cmp over" onClick={onClick}>
        ▲ {Math.round(dd * 100)}% vs {money(bd)} del.
      </span>
    );
  if (dd <= -0.1)
    return (
      <span className="cmp under" onClick={onClick}>
        ▼ {Math.round(-dd * 100)}% vs {money(bd)} del.
      </span>
    );
  return (
    <span className="cmp ok" onClick={onClick}>
      in line · {money(bd)}
    </span>
  );
}

export default function InventoryTable({
  products,
  soldMap,
  compMap,
  onStock,
  onComp,
  search = "",
}: {
  products: ProductWithDetails[];
  soldMap: Record<string, number>;
  compMap: Record<string, BestComp>;
  onStock: (t: StockTarget) => void;
  onComp: (t: CompTarget) => void;
  search?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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

  const toggle = (b: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(b) ? next.delete(b) : next.add(b);
      return next;
    });

  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: "30%" }}>Item</th>
          <th className="c">Stock</th>
          <th className="num">Squarespace</th>
          <th className="num">eBay · vs market</th>
          <th className="num">Sold</th>
          <th className="c">Status</th>
        </tr>
      </thead>
      <tbody>
        {brands.length === 0 && (
          <tr>
            <td colSpan={6} className="empty">
              No items match.
            </td>
          </tr>
        )}
        {brands.map(([brand, prods]) => {
          const isCollapsed = collapsed.has(brand);
          const units = prods.reduce((s, p) => s + p.total_stock, 0);
          return (
            <ConceptBrand
              key={brand}
              brand={brand}
              count={prods.length}
              units={units}
              collapsed={isCollapsed}
              onToggle={() => toggle(brand)}
            >
              {!isCollapsed &&
                prods.flatMap((p) =>
                  rowsFor(p, soldMap).map((r) => {
                    const sc =
                      r.status === "out"
                        ? "var(--out)"
                        : r.status === "low"
                        ? "var(--low)"
                        : "var(--ink)";
                    return (
                      <tr className="vrow" key={r.variantId}>
                        <td className="pname">
                          <b>{r.productName}</b>
                          {r.label && <small>{r.label}</small>}
                        </td>
                        <td className="c">
                          <span
                            className="stockbtn"
                            style={{ color: sc }}
                            onClick={() =>
                              r.inventoryId &&
                              onStock({
                                productName: r.productName,
                                variantLabel: r.label,
                                inventoryId: r.inventoryId,
                                variantId: r.variantId,
                                productId: r.productId,
                                currentStock: r.stock,
                              })
                            }
                          >
                            {r.stock}
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
                              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                            </svg>
                          </span>
                        </td>
                        <td className="num">
                          <span className="tag sq">SQ</span>{" "}
                          <span className="price">{money(r.sqPrice)}</span>
                        </td>
                        <td className="num">
                          <div className="pcell">
                            <span>
                              <span className="tag eb">eB</span>{" "}
                              <span className="price">{money(r.ebayPrice)}</span>
                            </span>
                            <Chip
                              row={r}
                              comp={compMap[r.variantId]}
                              onClick={() =>
                                onComp({
                                  variantId: r.variantId,
                                  productName: r.productName,
                                  query: r.productName,
                                  yourDelivered: r.ebayPrice,
                                })
                              }
                            />
                          </div>
                        </td>
                        <td className="num">{r.sold}</td>
                        <td className="c">
                          <span className={`pill ${r.status}`}>
                            {r.status === "good" ? "In stock" : r.status === "low" ? "Low" : "Out"}
                          </span>
                        </td>
                      </tr>
                    );
                  }),
                )}
            </ConceptBrand>
          );
        })}
      </tbody>
    </table>
  );
}

function ConceptBrand({
  brand,
  count,
  units,
  collapsed,
  onToggle,
  children,
}: {
  brand: string;
  count: number;
  units: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr className={`brow ${collapsed ? "collapsed" : ""}`} onClick={onToggle}>
        <td colSpan={6}>
          <span className="chev">▾</span>
          {brand}
          <span className="cnt">
            {count} items · {units} in stock
          </span>
        </td>
      </tr>
      {children}
    </>
  );
}
