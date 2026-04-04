import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Loader2, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useProducts, useUpdateProduct, useUpdateChannelPrice, useUpdateInventory, useCreateInventory, useDeleteProduct } from "@/hooks/use-products";
import type { ProductWithDetails } from "@/lib/types";
import { toast } from "sonner";
import InlineEditCell from "./InlineEditCell";

const ProductTable = () => {
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: allProducts = [], isLoading, error } = useProducts();

  const products = useMemo(() => {
    if (!search) return allProducts;
    const q = search.toLowerCase();
    return allProducts.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.sku && p.sku.toLowerCase().includes(q))
    );
  }, [allProducts, search]);
  const updateProduct = useUpdateProduct();
  const updateChannelPrice = useUpdateChannelPrice();
  const updateInventory = useUpdateInventory();
  const deleteProduct = useDeleteProduct();
  const createInventory = useCreateInventory();

  const handleDelete = (p: ProductWithDetails) => {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    deleteProduct.mutate(p.id, {
      onSuccess: () => toast.success(`Deleted ${p.name}`),
      onError: () => toast.error("Failed to delete product"),
    });
  };

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
      { listingId: listing.id, variantId: p.variants[0].id, price: newPrice, channel },
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
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72 pl-9"
          />
        </div>
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
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-2 py-3 w-10" />
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const margin = getMargin(product);
              return (
                <>
                  <tr key={product.id} className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-3.5">
                      <button onClick={() => setExpandedId(expandedId === product.id ? null : product.id)} className="text-muted-foreground hover:text-foreground">
                        {expandedId === product.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-xs font-mono text-muted-foreground">{product.sku ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3.5 min-w-[350px]">
                      <span className="text-sm font-medium text-foreground">{product.name}</span>
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <span
                        className="text-sm font-semibold text-foreground cursor-pointer hover:text-primary"
                        title="Expand row to edit per-variant stock"
                        onClick={() => setExpandedId(expandedId === product.id ? null : product.id)}
                      >
                        {product.total_stock}
                      </span>
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
                    <td className="px-2 py-3.5 text-center">
                      <button
                        onClick={() => handleDelete(product)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        title="Delete product"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                  {expandedId === product.id && product.variants.length > 0 && (
                    <tr key={`${product.id}-exp`} className="bg-muted/20">
                      <td colSpan={10} className="px-5 py-3">
                        <table className="w-full">
                          <thead>
                            <tr className="text-xs text-muted-foreground uppercase">
                              <th className="text-left px-3 py-1">Variant</th>
                              <th className="text-left px-3 py-1">SKU</th>
                              <th className="text-center px-3 py-1">Stock</th>
                              <th className="text-right px-3 py-1">eBay</th>
                              <th className="text-right px-3 py-1">Sqsp</th>
                            </tr>
                          </thead>
                          <tbody>
                            {product.variants.map((v) => {
                              const vInventory = product.inventory.find((inv) => inv.variant_id === v.id);
                              const vEbay = product.channel_listings.find((l) => l.variant_id === v.id && l.channel === "ebay");
                              const vSqsp = product.channel_listings.find((l) => l.variant_id === v.id && l.channel === "squarespace");
                              const vStock = vInventory?.total_stock ?? 0;
                              return (
                                <tr key={v.id} className="border-t border-border/50">
                                  <td className="px-3 py-2 text-sm text-foreground">
                                    {v.option1}{v.option2 ? ` / ${v.option2}` : ""}
                                  </td>
                                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                                    {v.internal_sku ?? "—"}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {vInventory ? (
                                      <InlineEditCell
                                        value={vStock}
                                        prefix=""
                                        align="center"
                                        className="font-semibold text-foreground"
                                        onSave={(val) =>
                                          updateInventory.mutate(
                                            { inventoryId: vInventory.id, variantId: v.id, stock: val },
                                            {
                                              onSuccess: () => toast.success(`Stock updated to ${val}`),
                                              onError: () => toast.error("Failed to update stock"),
                                            }
                                          )
                                        }
                                      />
                                    ) : (
                                      <InlineEditCell
                                        value={0}
                                        prefix=""
                                        align="center"
                                        className="font-semibold text-muted-foreground"
                                        onSave={(val) =>
                                          createInventory.mutate(
                                            { variantId: v.id, productId: product.id, stock: val },
                                            {
                                              onSuccess: () => toast.success(`Inventory created with stock ${val}`),
                                              onError: () => toast.error("Failed to create inventory"),
                                            }
                                          )
                                        }
                                      />
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    {vEbay ? (
                                      <InlineEditCell
                                        value={vEbay.channel_price}
                                        prefix="£"
                                        onSave={(val) =>
                                          updateChannelPrice.mutate(
                                            { listingId: vEbay.id, variantId: v.id, price: val },
                                            {
                                              onSuccess: () => toast.success(`eBay price updated to £${val.toFixed(2)}`),
                                              onError: () => toast.error("Failed to update price"),
                                            }
                                          )
                                        }
                                      />
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    {vSqsp ? (
                                      <InlineEditCell
                                        value={vSqsp.channel_price}
                                        prefix="£"
                                        onSave={(val) =>
                                          updateChannelPrice.mutate(
                                            { listingId: vSqsp.id, variantId: v.id, price: val },
                                            {
                                              onSuccess: () => toast.success(`Sqsp price updated to £${val.toFixed(2)}`),
                                              onError: () => toast.error("Failed to update price"),
                                            }
                                          )
                                        }
                                      />
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
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
