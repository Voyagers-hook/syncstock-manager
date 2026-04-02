import DashboardSidebar from "@/components/DashboardSidebar";
import StatsCards from "@/components/StatsCards";
import ProductTable from "@/components/ProductTable";
import { RefreshCw, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />

      {/* Main content */}
      <main className="ml-60 p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">
              Inventory Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage stock across eBay & Squarespace
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm">
              <RefreshCw className="w-4 h-4 mr-2" />
              Sync Now
            </Button>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Add Product
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="mb-8">
          <StatsCards />
        </div>

        {/* Products Table */}
        <ProductTable />
      </main>
    </div>
  );
};

export default Index;
