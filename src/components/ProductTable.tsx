import { useState } from "react";
import { Pencil, Check, X, ChevronDown, ChevronRight } from "lucide-react";
import { Product, mockProducts } from "@/lib/mock-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ProductTable = () => {
  const [products, setProducts] = useState<Product[]>(mockProducts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<Product>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const startEdit = (product: Product) => {
    setEditingId(product.id);
    setEditValues({
      stock: product.stock,
      ebayPrice: product.ebayPrice,
      squarespacePrice: product.squarespacePrice,
      costPrice: product.costPrice,
    });
  };

  const saveEdit = (id: string) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...editValues } : p))
    );
    setEditingId(null);
    setEditValues({});
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const filtered = products.filter(
    (p) =>
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase())
  );

  const getStockBadge = (stock: number) => {
    if (stock === 0)
      return <Badge variant="destructive" className="text-xs">Out of Stock</Badge>;
    if (stock <= 5)
      return <Badge className="bg-warning text-warning-foreground text-xs">Low Stock</Badge>;
    return <Badge className="bg-success text-success-foreground text-xs">In Stock</Badge>;
  };

  const getMargin = (product: Product) => {
    const avgSell = (product.ebayPrice + product.squarespacePrice) / 2;
    return ((avgSell - product.costPrice) / avgSell * 100).toFixed(1);
  };

  return (
    <div className="bg-card rounded-xl border animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between p-5 border-b">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Inventory</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} products</p>
        </div>
        <Input
          placeholder="Search by name or SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3 w-8" />
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                SKU
              </th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Product
              </th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Stock
              </th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                eBay Price
              </th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Sqsp Price
              </th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Cost
              </th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Margin
              </th>
              <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Status
              </th>
              <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((product) => (
              <>
                <tr
                  key={product.id}
                  className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                >
                  {/* Expand */}
                  <td className="px-3 py-3.5">
                    {product.variants.length > 0 && (
                      <button
                        onClick={() =>
                          setExpandedId(expandedId === product.id ? null : product.id)
                        }
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {expandedId === product.id ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </td>

                  {/* SKU */}
                  <td className="px-5 py-3.5">
                    <span className="text-xs font-mono text-muted-foreground">{product.sku}</span>
                  </td>

                  {/* Title */}
                  <td className="px-5 py-3.5">
                    <span className="text-sm font-medium text-foreground">{product.title}</span>
                  </td>

                  {/* Stock */}
                  <td className="px-5 py-3.5 text-center">
                    {editingId === product.id ? (
                      <Input
                        type="number"
                        value={editValues.stock ?? ""}
                        onChange={(e) =>
                          setEditValues({ ...editValues, stock: Number(e.target.value) })
                        }
                        className="w-20 mx-auto text-center h-8 text-sm"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-foreground">{product.stock}</span>
                    )}
                  </td>

                  {/* eBay Price */}
                  <td className="px-5 py-3.5 text-right">
                    {editingId === product.id ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editValues.ebayPrice ?? ""}
                        onChange={(e) =>
                          setEditValues({ ...editValues, ebayPrice: Number(e.target.value) })
                        }
                        className="w-24 ml-auto text-right h-8 text-sm"
                      />
                    ) : (
                      <span className="text-sm text-foreground">
                        £{product.ebayPrice.toFixed(2)}
                      </span>
                    )}
                  </td>

                  {/* Squarespace Price */}
                  <td className="px-5 py-3.5 text-right">
                    {editingId === product.id ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editValues.squarespacePrice ?? ""}
                        onChange={(e) =>
                          setEditValues({
                            ...editValues,
                            squarespacePrice: Number(e.target.value),
                          })
                        }
                        className="w-24 ml-auto text-right h-8 text-sm"
                      />
                    ) : (
                      <span className="text-sm text-foreground">
                        £{product.squarespacePrice.toFixed(2)}
                      </span>
                    )}
                  </td>

                  {/* Cost */}
                  <td className="px-5 py-3.5 text-right">
                    {editingId === product.id ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editValues.costPrice ?? ""}
                        onChange={(e) =>
                          setEditValues({ ...editValues, costPrice: Number(e.target.value) })
                        }
                        className="w-24 ml-auto text-right h-8 text-sm"
                      />
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        £{product.costPrice.toFixed(2)}
                      </span>
                    )}
                  </td>

                  {/* Margin */}
                  <td className="px-5 py-3.5 text-right">
                    <span className="text-sm font-medium text-success">
                      {getMargin(product)}%
                    </span>
                  </td>

                  {/* Status */}
                  <td className="px-5 py-3.5 text-center">{getStockBadge(product.stock)}</td>

                  {/* Actions */}
                  <td className="px-5 py-3.5 text-right">
                    {editingId === product.id ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button size="icon" variant="ghost" onClick={() => saveEdit(product.id)}>
                          <Check className="w-4 h-4 text-success" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={cancelEdit}>
                          <X className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    ) : (
                      <Button size="icon" variant="ghost" onClick={() => startEdit(product)}>
                        <Pencil className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    )}
                  </td>
                </tr>

                {/* Variants row */}
                {expandedId === product.id && product.variants.length > 0 && (
                  <tr key={`${product.id}-variants`} className="bg-muted/20">
                    <td colSpan={10} className="px-12 py-3">
                      <div className="flex flex-wrap gap-2">
                        {product.variants.map((v) => (
                          <Badge key={v.id} variant="outline" className="text-xs">
                            {v.name}: {v.value}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ProductTable;
