import { useState } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useUnmergedProducts, useMergeProducts, useUndoMerge, type UnmergedProduct } from "@/hooks/use-merge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Link2, Undo2, Search, ArrowRight } from "lucide-react";
import { toast } from "sonner";

const MergePage = () => {
  const { data: unmerged = [], isLoading, error } = useUnmergedProducts();
  const merge = useMergeProducts();
  const undo = useUndoMerge();
  const [search, setSearch] = useState("");
  const [selectedEbay, setSelectedEbay] = useState<UnmergedProduct | null>(null);
  const [selectedSqsp, setSelectedSqsp] = useState<UnmergedProduct | null>(null);

  const filtered = unmerged.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.sku?.toLowerCase().includes(search.toLowerCase()) ?? false)
  );

  const ebayItems = filtered.filter((p) => p.channel === "ebay");
  const sqspItems = filtered.filter((p) => p.channel === "squarespace");

  const handleMerge = async () => {
    if (!selectedEbay || !selectedSqsp) {
      toast.error("Select one item from each channel");
      return;
    }
    // Keep the eBay product, merge Squarespace into it
    await merge.mutateAsync({ keepId: selectedEbay.id, removeId: selectedSqsp.id });
    setSelectedEbay(null);
    setSelectedSqsp(null);
  };

  const handleUndo = async () => {
    await undo.mutateAsync();
  };

  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">
              Merge Products
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Link the same item across eBay & Squarespace into one internal product
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleUndo} disabled={undo.isPending}>
              <Undo2 className="w-4 h-4 mr-2" />
              Undo Last Merge
            </Button>
            <Button
              size="sm"
              onClick={handleMerge}
              disabled={!selectedEbay || !selectedSqsp || merge.isPending}
            >
              {merge.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Link2 className="w-4 h-4 mr-2" />
              )}
              Merge Selected
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-6 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Selection preview */}
        {(selectedEbay || selectedSqsp) && (
          <div className="bg-card border rounded-xl p-4 mb-6 flex items-center gap-4">
            <div className="flex-1 text-center">
              {selectedEbay ? (
                <div>
                  <Badge className="bg-blue-600 text-white mb-1">eBay</Badge>
                  <p className="text-sm font-medium text-foreground truncate">{selectedEbay.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedEbay.sku ?? "No SKU"}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Select an eBay item ←</p>
              )}
            </div>
            <ArrowRight className="w-5 h-5 text-primary shrink-0" />
            <div className="flex-1 text-center">
              {selectedSqsp ? (
                <div>
                  <Badge className="bg-foreground text-background mb-1">Squarespace</Badge>
                  <p className="text-sm font-medium text-foreground truncate">{selectedSqsp.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedSqsp.sku ?? "No SKU"}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">→ Select a Squarespace item</p>
              )}
            </div>
          </div>
        )}

        {isLoading && (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading products…</span>
          </div>
        )}

        {error && (
          <div className="bg-card rounded-xl border p-12 text-center text-destructive">
            Failed to load products.
          </div>
        )}

        {!isLoading && !error && (
          <div className="grid grid-cols-2 gap-6">
            {/* eBay column */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Badge className="bg-blue-600 text-white">eBay</Badge>
                <span className="text-sm text-muted-foreground">{ebayItems.length} unlinked</span>
              </div>
              <div className="space-y-2 max-h-[calc(100vh-320px)] overflow-y-auto pr-2">
                {ebayItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() =>
                      setSelectedEbay(selectedEbay?.id === item.id ? null : item)
                    }
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedEbay?.id === item.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:bg-muted/50"
                    }`}
                  >
                    <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-muted-foreground font-mono">{item.sku ?? "—"}</span>
                      {item.channel_price != null && (
                        <span className="text-xs text-foreground">£{item.channel_price.toFixed(2)}</span>
                      )}
                    </div>
                  </button>
                ))}
                {ebayItems.length === 0 && (
                  <p className="text-sm text-muted-foreground p-4 text-center">
                    All eBay items are merged
                  </p>
                )}
              </div>
            </div>

            {/* Squarespace column */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Badge className="bg-foreground text-background">Squarespace</Badge>
                <span className="text-sm text-muted-foreground">{sqspItems.length} unlinked</span>
              </div>
              <div className="space-y-2 max-h-[calc(100vh-320px)] overflow-y-auto pr-2">
                {sqspItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() =>
                      setSelectedSqsp(selectedSqsp?.id === item.id ? null : item)
                    }
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedSqsp?.id === item.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:bg-muted/50"
                    }`}
                  >
                    <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-muted-foreground font-mono">{item.sku ?? "—"}</span>
                      {item.channel_price != null && (
                        <span className="text-xs text-foreground">£{item.channel_price.toFixed(2)}</span>
                      )}
                    </div>
                  </button>
                ))}
                {sqspItems.length === 0 && (
                  <p className="text-sm text-muted-foreground p-4 text-center">
                    All Squarespace items are merged
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default MergePage;
