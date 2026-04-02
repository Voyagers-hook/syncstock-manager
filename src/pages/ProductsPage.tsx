import DashboardSidebar from "@/components/DashboardSidebar";
import ProductTable from "@/components/ProductTable";
import { RefreshCw, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

const ProductsPage = () => {
  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Products</h1>
            <p className="text-sm text-muted-foreground mt-1">Browse and manage your full catalogue</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm">
              <RefreshCw className="w-4 h-4 mr-2" />
              Quick Sync
            </Button>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Add Product
            </Button>
          </div>
        </div>
        <ProductTable />
      </main>
    </div>
  );
};

export default ProductsPage;
