import { useState } from "react";
import { Pencil, Check, X, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProducts, useUpdateProduct, useUpdateChannelPrice, useUpdateInventory } from "@/hooks/use-products";
import type { ProductWithDetails } from "@/lib/types";
import { toast } from "sonner";

const ProductTable = () => {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{
    stock?: number;
    ebayPrice?: number;
    sqspPrice?: number;
    costPrice?: number;
  }>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: products = [], isLoading, error } = useProducts(search);
  const updateProduct = useUpdateProduct();
  const updateChannelPrice = useUpdateChannelPrice();
  const updateInventory = useUpdateInventory();

  const startEdit = (p: ProductWithDetails) => {
    setEditingId(p.id);
    setEditValues({
      stock: p.total_stock,
      ebayPrice: p.ebay_price ?? undefined,
      sqspPrice: p.squarespace_price ?? undefined,
      costPrice: p.cost_price ?? undefined,
    });
  };

  const saveEdit = async (p: ProductWithDetails) => {
    try {
      const promises: Promise<void>[] = [];

      if (editValues.costPrice !== undefined && editValues.costPrice !== p.cost_price) {
        promises.push(
          updateProduct.mutateAsync({
            productId: p.id,
            updates: { cost_price: editValues.costPrice },
          })
        );
      }

      const ebayListing = p.channel_listings.find((l) => l.channel === "ebay");
      if (ebayListing && editValues.ebayPrice !== undefined && editValues.ebayPrice !== p.ebay_price) {
        promises.push(
          updateChannelPrice.mutateAsync({
            listingId: ebayListing.id,
            price: editValues.ebayPrice,
          })
        );
      }

      const sqspListing = p.channel_listings.find((l) => l.channel === "squarespace");
      if (sqspListing && editValues.sqspPrice !== undefined && editValues.sqspPrice !== p.squarespace_price) {
        promises.push(
          updateChannelPrice.mutateAsync({
            listingId: sqspListing.id,
            price: editValues.sqspPrice,
          })
        );
      }

      if (p.inventory[0] && editValues.stock !== undefined && editValues.stock !== p.total_stock) {
        promises.push(
          updateInventory.mutateAsync({
            inventoryId: p.inventory[0].id,
            stock: editValues.stock,
          })
        );
      }

      await Promise.all(promises);
      toast.success("Product updated");
    } catch {
      toast.error("Failed to update product");
    }
    setEditingId(null);
    setEditValues({});
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const getStockBadge = (stock: number) => {
    if (stock === 0)
      return <Badge variant="destructive" className="text-xs">Out of Stock</Badge>;
    if (stock <= 5)
      return <Badge className="bg-warning text-warning-foreground text-xs">Low Stock</Badge>;
    return <Badge className="bg-success text-success-foreground text-xs">In Stock</Badge>;
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
        Failed to load products. Check your Supabase connection.
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
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                isEditing={editingId === product.id}
                isExpanded={expandedId === product.id}
                editValues={editValues}
                onToggleExpand={() => setExpandedId(expandedId === product.id ? null : product.id)}
                onStartEdit={() => startEdit(product)}
                onSave={() => saveEdit(product)}
                onCancel={cancelEdit}
                onEditChange={setEditValues}
                getStockBadge={getStockBadge}
                getMargin={getMargin}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

interface ProductRowProps {
  product: ProductWithDetails;
  isEditing: boolean;
  isExpanded: boolean;
  editValues: { stock?: number; ebayPrice?: number; sqspPrice?: number; costPrice?: number };
  onToggleExpand: () => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onEditChange: (v: { stock?: number; ebayPrice?: number; sqspPrice?: number; costPrice?: number }) => void;
  getStockBadge: (stock: number) => React.ReactNode;
  getMargin: (p: ProductWithDetails) => string;
}

const ProductRow = ({
  product,
  isEditing,
  isExpanded,
  editValues,
  onToggleExpand,
  onStartEdit,
  onSave,
  onCancel,
  onEditChange,
  getStockBadge,
  getMargin,
}: ProductRowProps) => {
  const margin = getMargin(product);

  return (
    <>
      <tr className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
        <td className="px-3 py-3.5">
          {product.variants.length > 0 && (
            <button onClick={onToggleExpand} className="text-muted-foreground hover:text-foreground">
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
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
          {isEditing ? (
            <Input
              type="number"
              value={editValues.stock ?? ""}
              onChange={(e) => onEditChange({ ...editValues, stock: Number(e.target.value) })}
              className="w-20 mx-auto text-center h-8 text-sm"
            />
          ) : (
            <span className="text-sm font-semibold text-foreground">{product.total_stock}</span>
          )}
        </td>
        <td className="px-5 py-3.5 text-right">
          {isEditing ? (
            <Input
              type="number"
              step="0.01"
              value={editValues.ebayPrice ?? ""}
              onChange={(e) => onEditChange({ ...editValues, ebayPrice: Number(e.target.value) })}
              className="w-24 ml-auto text-right h-8 text-sm"
            />
          ) : (
            <span className="text-sm text-foreground">
              {product.ebay_price != null ? `£${product.ebay_price.toFixed(2)}` : "—"}
            </span>
          )}
        </td>
        <td className="px-5 py-3.5 text-right">
          {isEditing ? (
            <Input
              type="number"
              step="0.01"
              value={editValues.sqspPrice ?? ""}
              onChange={(e) => onEditChange({ ...editValues, sqspPrice: Number(e.target.value) })}
              className="w-24 ml-auto text-right h-8 text-sm"
            />
          ) : (
            <span className="text-sm text-foreground">
              {product.squarespace_price != null ? `£${product.squarespace_price.toFixed(2)}` : "—"}
            </span>
          )}
        </td>
        <td className="px-5 py-3.5 text-right">
          {isEditing ? (
            <Input
              type="number"
              step="0.01"
              value={editValues.costPrice ?? ""}
              onChange={(e) => onEditChange({ ...editValues, costPrice: Number(e.target.value) })}
              className="w-24 ml-auto text-right h-8 text-sm"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {product.cost_price != null ? `£${product.cost_price.toFixed(2)}` : "—"}
            </span>
          )}
        </td>
        <td className="px-5 py-3.5 text-right">
          <span className="text-sm font-medium text-success">{margin}{margin !== "—" ? "%" : ""}</span>
        </td>
        <td className="px-5 py-3.5 text-center">{getStockBadge(product.total_stock)}</td>
        <td className="px-5 py-3.5 text-right">
          {isEditing ? (
            <div className="flex items-center justify-end gap-1">
              <Button size="icon" variant="ghost" onClick={onSave}>
                <Check className="w-4 h-4 text-success" />
              </Button>
              <Button size="icon" variant="ghost" onClick={onCancel}>
                <X className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          ) : (
            <Button size="icon" variant="ghost" onClick={onStartEdit}>
              <Pencil className="w-4 h-4 text-muted-foreground" />
            </Button>
          )}
        </td>
      </tr>
      {isExpanded && product.variants.length > 0 && (
        <tr className="bg-muted/20">
          <td colSpan={10} className="px-12 py-3">
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
};

export default ProductTable;
