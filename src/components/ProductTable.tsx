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

  const handleSavePrice = (
    p: ProductWithDetails,
    channel: "ebay" | "squarespace",
    newPrice: number,
    priceType: "base" | "sale" = "base"
  ) => {
    const listing = p.channel_listings.find((l) => l.channel === channel);
    if (!listing) return;
    updateChannelPrice.mutate(
      { listingId: listing.id, variantId: listing.variant_id, price: newPrice, channel, priceType },
      {
        onSuccess: () => toast.success(`${channel === "ebay" ? "eBay" : "Sqsp"} ${priceType === "sale" ? "(sale)" : ""} price updated to £${newPrice.toFixed(2)}`),
        onError: () => toast.error("Failed to update price"),
      }
    );
  };

  const handleToggleSqspSale = (p: ProductWithDetails, onSale: boolean) => {
    const listing = p.channel_listings.find((l) => l.channel === "squarespace");
    if (!listing) return;
    updateChannelPrice.mutate(
      {
        listingId: listing.id,
        variantId: listing.variant_id,
        price: onSale
          ? listing.sq_sale_price ?? listing.sq_base_price ?? 0
          : listing.sq_base_price ?? listing.sq_sale_price ?? 0,
        channel: "squarespace",
        priceType: onSale ? "sale" : "base",
        updateSaleToggle: onSale,
      },
      {
        onSuccess: () => toast.success(`Sqsp is now ${onSale ? "ON SALE" : "base price"}!`),
        onError: () => toast.error("Failed to switch sale toggle"),
      }
    );
  };

  const getStockBadge = (stock: number) => {
    if (stock === 0) return <Badge variant="destructive" className="text-xs">Out</Badge>;
    if (stock <= 5) return <Badge className="bg-warning text-warning-foreground text-xs">Low</Badge>;
    return <Badge className="bg-success text-success-foreground text-xs">OK</Badge>;
  };

  // Per-channel margin calculation including fees
  const getMargins = (p: ProductWithDetails) => {
    const cost = p.cost_price ? parseFloat(String(p.cost_price)) : null;
    if (!cost || cost === 0) return { ebay: null, sqsp: null };

    let ebayMargin: number | null = null;
    if (p.ebay_price && p.ebay_price > 0) {
      const sale = p.ebay_price;
      // eBay: FVF 10.9% + £0.30 trxn + £0.03 regulatory, all + 20% VAT, plus £4 flat shipping
      const fees = (sale * 0.109 + 0.30 + 0.03) * 1.20 + 4; // £4 flat shipping included in eBay price
      ebayMargin = ((sale - cost - fees) / sale) * 100;
    }

    let sqspMargin: number | null = null;
    if (p.squarespace_price && p.squarespace_price > 0) {
      const sale = p.squarespace_price;
      // Sqsp: 5.5% blended fee is typical
      const fees = sale * 0.055;
      sqspMargin = ((sale - cost - fees) / sale) * 100;
    }

    return { ebay: ebayMargin, sqsp: sqspMargin };
  };

  const formatMargin = (margin: number | null) => {
    if (margin === null) return "—";
    const color = margin < 10 ? "text-destructive" : margin < 20 ? "text-warning-foreground" : "text-success";
    return <span className={`text-sm font-medium ${color}`}>{margin.toFixed(1)}%</span>;
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
              <th />
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">SKU</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Product</th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Stock</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">eBay Price</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Sqsp Base</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Sqsp Sale</th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">On Sale?</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Cost</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">eBay Margin</th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Sqsp Margin</th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Status</th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-2 py-3 w-10" />
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const { ebay: ebayMargin, sqsp: sqspMargin } = getMargins(product);
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
                        value={product.squarespace_base_price}
                        prefix="£"
                        onSave={(v) => handleSavePrice(product, "squarespace", v, "base")}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <InlineEditCell
                        value={product.squarespace_sale_price}
                        prefix="£"
                        onSave={(v) => handleSavePrice(product, "squarespace", v, "sale")}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <input
                        type="checkbox"
                        checked={product.squarespace_on_sale}
                        onChange={e => handleToggleSqspSale(product, e.target.checked)}
                        title="Toggle whether Squarespace uses the sale price"
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <InlineEditCell
                        value={product.cost_price}
                        prefix="£"
                        className="text-muted-foreground"
                        onSave={(v) => updateProduct.mutate({ productId: product.id, variantId: product.variants[0]?.id, updates: { cost_price: v } })}
                      />
                    </td>
                    <td className="px-5 py-3.5 text-right">{formatMargin(ebayMargin)}</td>
                    <td className="px-5 py-3.5 text-right">{formatMargin(sqspMargin)}</td>
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
                      <td colSpan={13} className="px-5 py-3">
                        <table className="w-full">
                          <thead>
                            <tr className="text-xs text-muted-foreground uppercase">
                              <th className="text-left px-3 py-1">Variant</th>
                              <th className="text-left px-3 py-1">SKU</th>
                              <th className="text-center px-3 py-1">Stock</th>
                              <th className="text-right px-3 py-1">eBay</th>
                              <th className="text-right px-3 py-1">Sqsp Base</th>
                              <th className="text-right px-3 py-1">Sqsp Sale</th>
                              <th className="text-center px-3 py-1">On Sale?</th>
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
                                            { listingId: vEbay.id, variantId: v.id, price: val, channel: "ebay", priceType: "base" },
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
                                        value={vSqsp.sq_base_price}
                                        prefix="£"
                                        onSave={(val) => updateChannelPrice.mutate({
                                          listingId: vSqsp.id,
                                          variantId: v.id,
                                          price: val,
                                          channel: "squarespace",
                                          priceType: "base"
                                        })}
                                      />
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    {vSqsp ? (
                                      <InlineEditCell
                                        value={vSqsp.sq_sale_price}
                                        prefix="£"
                                        onSave={(val) => updateChannelPrice.mutate({
                                          listingId: vSqsp.id,
                                          variantId: v.id,
                                          price: val,
                                          channel: "squarespace",
                                          priceType: "sale"
                                        })}
                                      />
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {vSqsp ? (
                                      <input
                                        type="checkbox"
                                        checked={!!vSqsp.sq_on_sale}
                                        onChange={e => updateChannelPrice.mutate({
                                          listingId: vSqsp.id,
                                          variantId: v.id,
                                          channel: "squarespace",
                                          priceType: e.target.checked ? "sale" : "base",
                                          price: e.target.checked
                                            ? vSqsp.sq_sale_price ?? vSqsp.sq_base_price ?? 0
                                            : vSqsp.sq_base_price ?? vSqsp.sq_sale_price ?? 0,
                                          updateSaleToggle: e.target.checked,
                                        })}
                                        title="Toggle whether Squarespace uses the sale price"
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
