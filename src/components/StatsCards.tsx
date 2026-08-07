import { Package, AlertTriangle, TrendingUp, RefreshCw } from "lucide-react";
import { useProducts } from "@/hooks/use-products";

const StatsCards = () => {
  const { data: products = [] } = useProducts();

  const totalProducts = products.length;
  const outOfStock = products.filter((p) => p.total_stock === 0).length;

  // Cost is stored per item (variant). Fall back to the old product-level cost if a
  // variant's cost hasn't been set yet.
  const variantCost = (p: (typeof products)[number], variantId: string) => {
    const v = p.variants.find((x) => x.id === variantId);
    return v?.cost_price ?? p.cost_price ?? 0;
  };

  // Inventory value = each item's stock × that item's own cost.
  const totalValue = products.reduce((acc, p) => {
    const productValue = p.inventory.reduce(
      (sum, inv) => sum + (inv.total_stock ?? 0) * variantCost(p, inv.variant_id),
      0
    );
    return acc + productValue;
  }, 0);

  // Effective cost per product for margin: average of its items' costs (fallback to product cost).
  const avgProductCost = (p: (typeof products)[number]) => {
    const costs = p.variants
      .map((v) => v.cost_price)
      .filter((c): c is number => typeof c === "number" && c > 0);
    if (costs.length) return costs.reduce((a, b) => a + b, 0) / costs.length;
    return p.cost_price ?? 0;
  };

  const productsWithMargin = products.filter((p) => {
    const prices = [p.ebay_price, p.squarespace_price].filter(Boolean) as number[];
    return prices.length > 0 && avgProductCost(p) > 0;
  });

  const avgMargin =
    productsWithMargin.length > 0
      ? productsWithMargin.reduce((acc, p) => {
          const prices = [p.ebay_price, p.squarespace_price].filter(Boolean) as number[];
          const avgSell = prices.reduce((a, b) => a + b, 0) / prices.length;
          return acc + ((avgSell - avgProductCost(p)) / avgSell) * 100;
        }, 0) / productsWithMargin.length
      : 0;

  const cards = [
    {
      label: "Total Products",
      value: totalProducts,
      icon: Package,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      label: "Out of Stock",
      value: outOfStock,
      icon: AlertTriangle,
      color: "text-destructive",
      bgColor: "bg-destructive/10",
    },
    {
      label: "Inventory Value",
      value: `£${totalValue.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`,
      icon: TrendingUp,
      color: "text-success",
      bgColor: "bg-success/10",
    },
    {
      label: "Avg Margin",
      value: `${avgMargin.toFixed(1)}%`,
      icon: RefreshCw,
      color: "text-warning",
      bgColor: "bg-warning/10",
    },
  ];

  return (
    <div className="inventory-grid">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-card rounded-xl border p-5 animate-fade-in"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">{card.label}</span>
            <div className={`w-9 h-9 rounded-lg ${card.bgColor} flex items-center justify-center`}>
              <card.icon className={`w-4 h-4 ${card.color}`} />
            </div>
          </div>
          <p className="text-2xl font-bold text-foreground">{card.value}</p>
        </div>
      ))}
    </div>
  );
};

export default StatsCards;
