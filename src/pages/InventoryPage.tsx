import { useMemo, useState } from "react";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRight,
  ChevronDown,
  Download,
  Search,
  TrendingUp,
  PencilLine,
} from "lucide-react";
import { useProducts } from "@/hooks/use-products";
import { brandOf } from "@/lib/brand";
import { downloadCsv } from "@/lib/csv";
import { QuickSyncButton } from "@/components/QuickSyncButton";
import {
  StockAdjustModal,
  StockAdjustTarget,
} from "@/components/inventory/StockAdjustModal";
import { CompetitorModal, CompetitorTarget } from "@/components/inventory/CompetitorModal";
import type { ProductWithDetails } from "@/lib/types";

const LOW = 3;
const gbp = (n: number | null | undefined) =>
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
}

function buildRows(p: ProductWithDetails): VRow[] {
  const variants = p.variants.length ? p.variants : [];
  if (!variants.length) {
    return [
      {
        productId: p.id,
        productName: p.name,
        variantId: p.id,
        inventoryId: null,
        label: null,
        stock: p.total_stock,
        ebayPrice: p.ebay_price,
        sqPrice: p.squarespace_price,
        sqOnSale: false,
      },
    ];
  }
  return variants.map((v) => {
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
    return {
      productId: p.id,
      productName: p.name,
      variantId: v.id,
      inventoryId: inv?.id ?? null,
      label,
      stock: inv?.total_stock ?? 0,
      ebayPrice: ebay?.channel_price ?? p.ebay_price,
      sqPrice: sqPrice ?? p.squarespace_price,
      sqOnSale: sq?.sq_on_sale ?? false,
    };
  });
}

function StatusBadge({ stock }: { stock: number }) {
  if (stock <= 0)
    return <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/10">Out of stock</Badge>;
  if (stock <= LOW)
    return <Badge className="bg-warning/15 text-warning hover:bg-warning/15">Low ({stock})</Badge>;
  return <Badge className="bg-success/10 text-success hover:bg-success/10">In stock</Badge>;
}

const InventoryPage = () => {
  const { data: products = [], isLoading } = useProducts();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "out" | "low">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stockTarget, setStockTarget] = useState<StockAdjustTarget | null>(null);
  const [compTarget, setCompTarget] = useState<CompetitorTarget | null>(null);

  const brands = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, { products: ProductWithDetails[]; stock: number }>();
    for (const p of products) {
      if (q && !p.name.toLowerCase().includes(q)) continue;
      if (filter === "out" && p.total_stock > 0) continue;
      if (filter === "low" && !(p.total_stock > 0 && p.total_stock <= LOW)) continue;
      const b = brandOf(p.name);
      const entry = map.get(b) ?? { products: [], stock: 0 };
      entry.products.push(p);
      entry.stock += p.total_stock;
      map.set(b, entry);
    }
    return Array.from(map.entries())
      .map(([brand, v]) => ({ brand, ...v }))
      .sort((a, b) => a.brand.localeCompare(b.brand));
  }, [products, search, filter]);

  const toggle = (brand: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(brand) ? next.delete(brand) : next.add(brand);
      return next;
    });

  const exportCsv = () => {
    const rows: Record<string, unknown>[] = [];
    for (const b of brands) {
      for (const p of b.products) {
        for (const r of buildRows(p)) {
          rows.push({
            brand: b.brand,
            item: r.productName,
            variant: r.label ?? "",
            stock: r.stock,
            ebay_price: r.ebayPrice ?? "",
            squarespace_price: r.sqPrice ?? "",
            status: r.stock <= 0 ? "Out of stock" : r.stock <= LOW ? "Low" : "In stock",
          });
        }
      }
    }
    downloadCsv(
      `inventory-${new Date().toISOString().slice(0, 10)}`,
      [
        { key: "brand", label: "Brand" },
        { key: "item", label: "Item" },
        { key: "variant", label: "Variant" },
        { key: "stock", label: "Stock" },
        { key: "ebay_price", label: "eBay £" },
        { key: "squarespace_price", label: "Squarespace £" },
        { key: "status", label: "Status" },
      ],
      rows,
    );
  };

  const totalItems = brands.reduce((s, b) => s + b.products.length, 0);

  return (
    <AppLayout
      title="Inventory"
      subtitle="Shared stock across eBay & Squarespace, grouped by brand"
      actions={
        <>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
          <QuickSyncButton />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          {([
            ["all", "All"],
            ["out", "Out of stock"],
            ["low", "Low"],
          ] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                filter === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground ml-auto">
          {totalItems} product{totalItems === 1 ? "" : "s"} · {brands.length} brand
          {brands.length === 1 ? "" : "s"}
        </span>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Loading inventory…</p>
      ) : brands.length === 0 ? (
        <p className="text-sm text-muted-foreground py-10 text-center">No items match.</p>
      ) : (
        <div className="space-y-2">
          {brands.map((b) => {
            const open = expanded.has(b.brand);
            return (
              <div key={b.brand} className="bg-card rounded-xl border overflow-hidden">
                <button
                  onClick={() => toggle(b.brand)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                >
                  {open ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  )}
                  <span className="font-semibold">{b.brand}</span>
                  <Badge variant="secondary" className="ml-1">
                    {b.products.length}
                  </Badge>
                  <span className="ml-auto text-sm text-muted-foreground">
                    {b.stock} in stock
                  </span>
                </button>

                {open && (
                  <div className="border-t">
                    <div className="hidden sm:grid grid-cols-[1fr_90px_110px_90px_110px_80px] gap-2 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/30">
                      <span>Item</span>
                      <span className="text-right">eBay</span>
                      <span className="text-right">Squarespace</span>
                      <span className="text-right">Stock</span>
                      <span>Status</span>
                      <span className="text-right">Compare</span>
                    </div>
                    {b.products.map((p) =>
                      buildRows(p).map((r) => (
                        <div
                          key={r.variantId}
                          className="grid grid-cols-2 sm:grid-cols-[1fr_90px_110px_90px_110px_80px] gap-2 px-4 py-2.5 border-t items-center text-sm"
                        >
                          <div className="col-span-2 sm:col-span-1 min-w-0">
                            <p className="truncate font-medium">{r.productName}</p>
                            {r.label && (
                              <p className="text-xs text-muted-foreground truncate">{r.label}</p>
                            )}
                          </div>
                          <div className="text-right tabular-nums">{gbp(r.ebayPrice)}</div>
                          <div className="text-right tabular-nums">
                            {gbp(r.sqPrice)}
                            {r.sqOnSale && (
                              <span className="ml-1 text-[10px] text-destructive font-semibold">
                                SALE
                              </span>
                            )}
                          </div>
                          <div className="text-right">
                            <button
                              onClick={() =>
                                r.inventoryId &&
                                setStockTarget({
                                  productName: r.productName,
                                  variantLabel: r.label,
                                  inventoryId: r.inventoryId,
                                  variantId: r.variantId,
                                  productId: r.productId,
                                  currentStock: r.stock,
                                })
                              }
                              disabled={!r.inventoryId}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-muted font-semibold tabular-nums disabled:opacity-40"
                              title={r.inventoryId ? "Change stock" : "No stock record"}
                            >
                              {r.stock}
                              {r.inventoryId && (
                                <PencilLine className="w-3 h-3 text-muted-foreground" />
                              )}
                            </button>
                          </div>
                          <div>
                            <StatusBadge stock={r.stock} />
                          </div>
                          <div className="text-right">
                            <button
                              onClick={() =>
                                setCompTarget({
                                  variantId: r.variantId,
                                  productName: r.productName,
                                  query: r.productName,
                                  yourDelivered: r.ebayPrice,
                                })
                              }
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs hover:bg-muted"
                              title="Compare eBay delivered prices"
                            >
                              <TrendingUp className="w-3 h-3" />
                              eBay
                            </button>
                          </div>
                        </div>
                      )),
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <StockAdjustModal target={stockTarget} onClose={() => setStockTarget(null)} />
      <CompetitorModal target={compTarget} onClose={() => setCompTarget(null)} />
    </AppLayout>
  );
};

export default InventoryPage;
