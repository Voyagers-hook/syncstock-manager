import { useState } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useTopSellers } from "@/hooks/use-top-sellers";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trophy } from "lucide-react";

const TopSellersPage = () => {
  const [sortBy, setSortBy] = useState<"quantity" | "revenue">("quantity");
  const { data: sellers = [], isLoading, error } = useTopSellers(12, sortBy);

  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Trophy className="w-6 h-6 text-warning" />
              <div>
                <h1 className="text-2xl font-bold text-foreground tracking-tight">
                  Top 12 Sellers
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Best performing variants across all platforms
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <button
                onClick={() => setSortBy("quantity")}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  sortBy === "quantity"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Units Sold
              </button>
              <button
                onClick={() => setSortBy("revenue")}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  sortBy === "revenue"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Total Sales £
              </button>
            </div>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading sales data…</span>
          </div>
        )}

        {error && (
          <div className="bg-card rounded-xl border p-12 text-center text-destructive">
            Failed to load sales data.
          </div>
        )}

        {!isLoading && !error && sellers.length === 0 && (
          <div className="bg-card rounded-xl border p-12 text-center text-muted-foreground">
            No order data yet. Orders will appear after the sync imports them.
          </div>
        )}

        {!isLoading && !error && sellers.length > 0 && (
          <div className="bg-card rounded-xl border animate-fade-in">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3 w-12">
                      #
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                      Variant
                    </th>
                    <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                      SKU
                    </th>
                    <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                      Units Sold
                    </th>
                    <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                      Total Sales
                    </th>
                    <th className="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider px-5 py-3">
                      Platforms
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sellers.map((seller, idx) => (
                    <tr
                      key={seller.variant_key}
                      className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3.5 text-center">
                        <span
                          className={`text-sm font-bold ${
                            idx < 3 ? "text-warning" : "text-muted-foreground"
                          }`}
                        >
                          {idx + 1}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 min-w-[300px]">
                        <span className="text-sm font-medium text-foreground whitespace-normal">
                          {seller.item_name}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-xs font-mono text-muted-foreground">
                          {seller.sku ?? "—"}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <span className={`text-sm font-semibold ${sortBy === "quantity" ? "text-foreground" : "text-muted-foreground"}`}>
                          {seller.total_quantity}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <span className={`text-sm font-semibold ${sortBy === "revenue" ? "text-foreground" : "text-muted-foreground"}`}>
                          £{seller.total_revenue.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {seller.platforms.includes("ebay") && (
                            <Badge variant="outline" className="text-xs">
                              eBay
                            </Badge>
                          )}
                          {seller.platforms.includes("squarespace") && (
                            <Badge variant="outline" className="text-xs">
                              Sqsp
                            </Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default TopSellersPage;
