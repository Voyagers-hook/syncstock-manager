import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useProducts, useUpdateProduct, useUpdateChannelPrice, useUpdateInventory } from "@/hooks/use-products";
import type { ProductWithDetails } from "@/lib/types";
import { toast } from "sonner";
import InlineEditCell from "./InlineEditCell";

const ProductTable = () => {
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: products = [], isLoading, error } = useProducts(search);
  const updateProduct = useUpdateProduct();
  const updateChannelPrice = useUpdateChannelPrice();
  const updateInventory = useUpdateInventory();

  const handleSaveStock = (p: ProductWithDetails, newStock: number) => {
    if (!p.inventory[0] || !p.variants[0]) return;
    updateInventory.mutate(
      { inventoryId: p.inventory[0].id, variantId: p.variants[0].id, stock: newStock },
      {
        onSuccess: () => toast.success(`Stock updated to ${newStock}`),
        onError: () => toast.error("Failed to update stock"),
      }
    );
  };

  const handleSavePrice = (p: ProductWithDetails, channel: "ebay" | "squarespace", newPrice: number) => {
    const listing = p.channel_listings.find((l) => l.channel === channel);
    if (!listing || !p.variants[0]) return;
    updateChannelPrice.mutate(
      { listingId: listing.id, variantId: p.variants[0].id, price: newPrice },
      {
        onSuccess: () => toast.success(`${channel === "ebay" ? "eBay" : "Sqsp"} price updated to £${newPrice.toFixed(2)}`),
        onError: () => toast.error("Failed to update price"),
      }
    );
  };

  const handleSaveCost = (p: ProductWithDetails, newCost: number) => {
    updateProduct.mutate(
      { productId: p.id, variantId: p.variants[0]?.id, updates: { cost_price: newCost } },
      {
        onSuccess: () => toast.success(`Cost updated to £${newCost.toFixed(2)}`),
        onError: () => toast.error("Failed to update cost"),
      }
    );
  };

  const getStockBadge = (stock: number) => {
    if (stock === 0) return <Badge variant="destructive" className="text-xs">Out</Badge>;
    if (stock <= 5) return <Badge className="bg-warning text-warning-foreground text-xs">Low</Badge>;
    return <Badge className="bg-success text-success-foreground text-xs">OK</Badge>;
  };

  const getMargin = (p: ProductWithDetails) => {
    const cost = p.cost_price ?? 0;
    const prices = [p.ebay_price, p.squarespace_price].filter(Boolean) as number[];
    if (!prices.length || cost === 0) return "—";
    const avgSell = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (avgSell === 0) return "—";
    return ((avgSell - cost) / avgSell * 100).toFixed(1);
  };

  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border p-12 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading inventory…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card rounded-xl border p-12 text-center text-destructive">
        Failed to load products. Check your connection.
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border animate-fade-in">
      <div className="flex items-center justify-between p-5 border-b">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Inventory</h2>
          <p className="text-sm text-muted-foreground">{products.length} products</p>
        </div>
        <Input
          placeholder="Search by name or SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3 w-8" />
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">SKU</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Product</th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Stock</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">eBay Price</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Sqsp Price</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Cost</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Margin</th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const margin = getMargin(product);
              return (
                <>
                  <tr key={product.id} className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-3.5">
                      {product.variants.length > 0 && (
                        <button onClick={() => setExpandedId(expandedId === product.id ? null : product.id)} className="text-muted-foreground hover:text-foreground">
                          {expandedId === product.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-xs font-mono text-muted-foreground">{product.sku ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-sm font-medium text-foreground truncate max-w-[250px] block">{product.name}</span>
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <InlineEditCell
                        value={product.total_stock}
                        prefix=""
                        align="center"
                        className="font-semibold text-foreground"
                        onSave={(v) => handleSaveStock(product, v)}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <InlineEditCell
                        value={product.ebay_price}
                        prefix="£"
                        onSave={(v) => handleSavePrice(product, "ebay", v)}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <InlineEditCell
                        value={product.squarespace_price}
                        prefix="£"
                        onSave={(v) => handleSavePrice(product, "squarespace", v)}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <InlineEditCell
                        value={product.cost_price}
                        prefix="£"
                        className="text-muted-foreground"
                        onSave={(v) => handleSaveCost(product, v)}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="text-sm font-medium text-success">{margin}{margin !== "—" ? "%" : ""}</span>
                    </td>
                    <td className="px-5 py-3.5 text-center">{getStockBadge(product.total_stock)}</td>
                  </tr>
                  {expandedId === product.id && product.variants.length > 0 && (
                    <tr key={`${product.id}-exp`} className="bg-muted/20">
                      <td colSpan={9} className="px-12 py-3">
                        <div className="flex flex-wrap gap-2">
                          {product.variants.map((v) => (
                            <Badge key={v.id} variant="outline" className="text-xs">
                              {v.option1}{v.option2 ? ` / ${v.option2}` : ""} — SKU: {v.internal_sku ?? "—"}
                            </Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ProductTable;
