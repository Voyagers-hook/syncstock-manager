import { useMemo, useState } from "react";
import ConceptLayout, { rangeSince } from "@/components/ConceptLayout";
import { useProducts } from "@/hooks/use-products";
import { useOrders } from "@/hooks/use-orders";
import { useCompetitorMap } from "@/hooks/use-competitor-all";
import InventoryTable, { StockTarget, CompTarget } from "@/components/inventory/InventoryTable";
import StockModal from "@/components/modals/StockModal";
import CompModal from "@/components/modals/CompModal";
import { brandOf } from "@/lib/brand";
import { downloadCsv } from "@/lib/csv";

const LOW = 3;

const InventoryPage = () => {
  const { data: products = [] } = useProducts();
  const { data: orders = [] } = useOrders();
  const { data: compMap = {} } = useCompetitorMap();
  const [search, setSearch] = useState("");
  const [stockTarget, setStockTarget] = useState<StockTarget | null>(null);
  const [compTarget, setCompTarget] = useState<CompTarget | null>(null);

  const since30 = useMemo(() => rangeSince("30"), []);
  const soldMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const o of orders) {
      if (!o.ordered_at || o.ordered_at < since30 || !o.product_id) continue;
      m[o.product_id] = (m[o.product_id] ?? 0) + (o.quantity ?? 0);
    }
    return m;
  }, [orders, since30]);

  const exportCsv = () => {
    const rows: Record<string, unknown>[] = [];
    for (const p of products) {
      const variants = p.variants.length ? p.variants : [{ id: p.id, option1: null, option2: null } as any];
      for (const v of variants) {
        const inv = p.inventory.find((i) => i.variant_id === v.id);
        const listings = p.channel_listings.filter((l) => l.variant_id === v.id);
        const ebay = listings.find((l) => l.channel === "ebay");
        const sq = listings.find((l) => l.channel === "squarespace");
        const stock = inv?.total_stock ?? (p.variants.length ? 0 : p.total_stock);
        rows.push({
          brand: brandOf(p.name),
          item: p.name,
          variant: [v.option1, v.option2].filter(Boolean).join(" / "),
          stock,
          squarespace: sq?.channel_price ?? p.squarespace_price ?? "",
          ebay: ebay?.channel_price ?? p.ebay_price ?? "",
          best_market: compMap[v.id]?.delivered ?? "",
          status: stock <= 0 ? "Out" : stock <= LOW ? "Low" : "In stock",
        });
      }
    }
    downloadCsv(
      `inventory-${new Date().toISOString().slice(0, 10)}`,
      [
        { key: "brand", label: "Brand" },
        { key: "item", label: "Item" },
        { key: "variant", label: "Variant" },
        { key: "stock", label: "Stock" },
        { key: "squarespace", label: "Squarespace £" },
        { key: "ebay", label: "eBay £" },
        { key: "best_market", label: "Best market delivered £" },
        { key: "status", label: "Status" },
      ],
      rows,
    );
  };

  return (
    <ConceptLayout
      title="Inventory"
      subtitle="Stock across both channels"
      onExport={exportCsv}
      search={search}
      onSearch={setSearch}
    >
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
            <span style={{ color: "var(--under)" }}>▼ under</span>
            <span>click stock to adjust · click chip for listings</span>
          </div>
        </div>
        <InventoryTable
          products={products}
          soldMap={soldMap}
          compMap={compMap}
          onStock={setStockTarget}
          onComp={setCompTarget}
          search={search}
        />
      </div>
      <div className="note">
        One shared stock figure pushed to both channels. Click a stock number to adjust it — you'll be
        asked a reason (and can add a note), so every change is tracked. Exportable to CSV.
      </div>

      <StockModal target={stockTarget} onClose={() => setStockTarget(null)} />
      <CompModal target={compTarget} onClose={() => setCompTarget(null)} />
    </ConceptLayout>
  );
};

export default InventoryPage;
