import DashboardSidebar from "@/components/DashboardSidebar";
import StatsCards from "@/components/StatsCards";
import ProductTable from "@/components/ProductTable";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuickSyncButton } from "@/components/QuickSyncButton";

const LOGO_URL = "https://voyagers-hook.github.io/images/logo%20trans.png";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <img src={LOGO_URL} alt="Voyager's Hook" className="w-10 h-10 object-contain lg:hidden" />
            <div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">Inventory Dashboard</h1>
              <p className="text-sm text-muted-foreground mt-1">Manage stock across eBay & Squarespace</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <QuickSyncButton />
            <Button size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Add Product
            </Button>
          </div>
        </div>
        <div className="mb-8">
          <StatsCards />
        </div>
        <ProductTable />
      </main>
    </div>
  );
};

export default Index;
