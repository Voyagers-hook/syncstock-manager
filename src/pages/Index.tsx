import { useMemo } from "react";
import { Link } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import StatsCards from "@/components/StatsCards";
import { QuickSyncButton } from "@/components/QuickSyncButton";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Trophy, ShoppingCart, AlertTriangle } from "lucide-react";
import { useOrders } from "@/hooks/use-orders";
import { useProducts } from "@/hooks/use-products";
import { useTopSellers } from "@/hooks/use-top-sellers";

const gbp = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";

const Panel = ({
  title,
  icon: Icon,
  to,
  children,
}: {
  title: string;
  icon: any;
  to: string;
  children: React.ReactNode;
}) => (
  <div className="bg-card rounded-xl border p-5">
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <h2 className="font-semibold">{title}</h2>
      </div>
      <Link to={to} className="text-sm text-primary hover:underline inline-flex items-center gap-1">
        View all <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </div>
    {children}
  </div>
);

const Index = () => {
  const { data: orders = [] } = useOrders();
  const { data: products = [] } = useProducts();
  const since = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  }, []);
  const { data: topSellers = [] } = useTopSellers(6, "quantity", { from: since });

  const recent = orders.slice(0, 7);
  const outOfStock = products.filter((p) => p.total_stock <= 0);

  return (
    <AppLayout
      title="Dashboard"
      subtitle="A quick view of the whole operation"
      actions={<QuickSyncButton />}
    >
      <div className="mb-6">
        <StatsCards />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <Panel title="Recent orders" icon={ShoppingCart} to="/orders">
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No orders yet.</p>
          ) : (
            <div className="divide-y">
              {recent.map((o) => (
                <div key={o.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="text-xs text-muted-foreground w-12 shrink-0">
                    {fmtDate(o.ordered_at)}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{o.item_name ?? o.sku}</span>
                  <Badge
                    variant="secondary"
                    className="text-[10px] capitalize shrink-0"
                  >
                    {o.platform}
                  </Badge>
                  <span className="tabular-nums font-medium w-14 text-right shrink-0">
                    {gbp(o.total_price)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Top sellers (30 days)" icon={Trophy} to="/top-sellers">
          {topSellers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No sales in the last 30 days.</p>
          ) : (
            <div className="divide-y">
              {topSellers.map((t, i) => (
                <div key={t.variant_key} className="flex items-center gap-3 py-2 text-sm">
                  <span className="text-xs font-bold text-muted-foreground w-5 shrink-0">
                    {i + 1}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{t.item_name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t.total_quantity} sold
                  </span>
                  <span className="tabular-nums font-medium w-16 text-right shrink-0">
                    {gbp(t.total_revenue)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title={`Needs attention — ${outOfStock.length} out of stock`} icon={AlertTriangle} to="/inventory">
        {outOfStock.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">Everything is in stock.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {outOfStock.slice(0, 24).map((p) => (
              <Badge key={p.id} variant="secondary" className="font-normal">
                {p.name}
              </Badge>
            ))}
            {outOfStock.length > 24 && (
              <Badge variant="secondary" className="font-normal">
                +{outOfStock.length - 24} more
              </Badge>
            )}
          </div>
        )}
      </Panel>
    </AppLayout>
  );
};

export default Index;
