import { useState } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import {
  useUnmergedProducts,
  useMergeProducts,
  useUndoMerge,
  useUnmergedVariants,
  useMergeVariants,
  type UnmergedProduct,
  type UnmergedVariant,
} from "@/hooks/use-merge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Link2, Undo2, Search, ArrowRight } from "lucide-react";
import { toast } from "sonner";

type TabId = "products" | "variants";

const MergePage = () => {
  const [tab, setTab] = useState<TabId>("products");

  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Merge Products</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Link the same item across eBay &amp; Squarespace so they share one stock level
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-border">
          <button
            onClick={() => setTab("products")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === "products"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            By Product
          </button>
          <button
            onClick={() => setTab("variants")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === "variants"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            By Variant
          </button>
        </div>

        {tab === "products" && <ProductMergeTab />}
        {tab === "variants" && <VariantMergeTab />}
      </main>
    </div>
  );
};

// ─── Product-level merge tab ──────────────────────────────────────────────────

function ProductMergeTab() {
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
    await merge.mutateAsync({ keepId: selectedEbay.id, removeId: selectedSqsp.id });
    setSelectedEbay(null);
    setSelectedSqsp(null);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-3 ml-4">
          <Button variant="outline" size="sm" onClick={() => undo.mutateAsync()} disabled={undo.isPending}>
            <Undo2 className="w-4 h-4 mr-2" />
            Undo Last Merge
          </Button>
          <Button
            size="sm"
            onClick={handleMerge}
            disabled={!selectedEbay || !selectedSqsp || merge.isPending}
          >
            {merge.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
            Merge Selected
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Select a product from each column then click <strong>Merge Selected</strong>. Variants are auto-matched by name — use the <strong>By Variant</strong> tab if you need to match them manually.
      </p>

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
      {error && <p className="text-destructive text-center p-8">Failed to load products.</p>}

      {!isLoading && !error && (
        <div className="grid grid-cols-2 gap-6">
          <ProductColumn
            label="eBay"
            badgeClass="bg-blue-600 text-white"
            items={ebayItems}
            selected={selectedEbay}
            onSelect={(item) => setSelectedEbay(selectedEbay?.id === item.id ? null : item)}
          />
          <ProductColumn
            label="Squarespace"
            badgeClass="bg-foreground text-background"
            items={sqspItems}
            selected={selectedSqsp}
            onSelect={(item) => setSelectedSqsp(selectedSqsp?.id === item.id ? null : item)}
          />
        </div>
      )}
    </>
  );
}

function ProductColumn({
  label,
  badgeClass,
  items,
  selected,
  onSelect,
}: {
  label: string;
  badgeClass: string;
  items: UnmergedProduct[];
  selected: UnmergedProduct | null;
  onSelect: (item: UnmergedProduct) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Badge className={badgeClass}>{label}</Badge>
        <span className="text-sm text-muted-foreground">{items.length} unlinked</span>
      </div>
      <div className="space-y-2 max-h-[calc(100vh-400px)] overflow-y-auto pr-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item)}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              selected?.id === item.id
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
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground p-4 text-center">All {label} items are merged</p>
        )}
      </div>
    </div>
  );
}

// ─── Variant-level merge tab ──────────────────────────────────────────────────

function VariantMergeTab() {
  const { data: variants = [], isLoading, error } = useUnmergedVariants();
  const merge = useMergeVariants();
  const [search, setSearch] = useState("");
  const [selectedEbay, setSelectedEbay] = useState<UnmergedVariant | null>(null);
  const [selectedSqsp, setSelectedSqsp] = useState<UnmergedVariant | null>(null);

  const filtered = variants.filter(
    (v) =>
      v.product_name.toLowerCase().includes(search.toLowerCase()) ||
      v.variant_name.toLowerCase().includes(search.toLowerCase()) ||
      (v.channel_sku?.toLowerCase().includes(search.toLowerCase()) ?? false)
  );

  const ebayVariants = filtered.filter((v) => v.channel === "ebay");
  const sqspVariants = filtered.filter((v) => v.channel === "squarespace");

  const handleMerge = async () => {
    if (!selectedEbay || !selectedSqsp) {
      toast.error("Select one variant from each channel");
      return;
    }
    // Keep eBay variant, absorb Squarespace variant
    await merge.mutateAsync({
      keepVariantId: selectedEbay.variant_id,
      removeVariantId: selectedSqsp.variant_id,
    });
    setSelectedEbay(null);
    setSelectedSqsp(null);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by product or variant name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button
          size="sm"
          onClick={handleMerge}
          disabled={!selectedEbay || !selectedSqsp || merge.isPending}
          className="ml-4"
        >
          {merge.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
          Link Variants
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Pick a specific eBay variant and its matching Squarespace variant, then click <strong>Link Variants</strong>. After linking they share the same inventory — a sale on either platform adjusts both.
      </p>

      {/* Selection preview */}
      {(selectedEbay || selectedSqsp) && (
        <div className="bg-card border rounded-xl p-4 mb-6 flex items-center gap-4">
          <div className="flex-1 text-center">
            {selectedEbay ? (
              <div>
                <Badge className="bg-blue-600 text-white mb-1">eBay</Badge>
                <p className="text-sm font-medium text-foreground truncate">{selectedEbay.product_name}</p>
                <p className="text-xs text-primary font-medium">{selectedEbay.variant_name}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Select an eBay variant ←</p>
            )}
          </div>
          <ArrowRight className="w-5 h-5 text-primary shrink-0" />
          <div className="flex-1 text-center">
            {selectedSqsp ? (
              <div>
                <Badge className="bg-foreground text-background mb-1">Squarespace</Badge>
                <p className="text-sm font-medium text-foreground truncate">{selectedSqsp.product_name}</p>
                <p className="text-xs text-primary font-medium">{selectedSqsp.variant_name}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">→ Select a Squarespace variant</p>
            )}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading variants…</span>
        </div>
      )}
      {error && <p className="text-destructive text-center p-8">Failed to load variants.</p>}

      {!isLoading && !error && (
        <div className="grid grid-cols-2 gap-6">
          <VariantColumn
            label="eBay"
            badgeClass="bg-blue-600 text-white"
            items={ebayVariants}
            selected={selectedEbay}
            onSelect={(v) => setSelectedEbay(selectedEbay?.variant_id === v.variant_id ? null : v)}
          />
          <VariantColumn
            label="Squarespace"
            badgeClass="bg-foreground text-background"
            items={sqspVariants}
            selected={selectedSqsp}
            onSelect={(v) => setSelectedSqsp(selectedSqsp?.variant_id === v.variant_id ? null : v)}
          />
        </div>
      )}
    </>
  );
}

function VariantColumn({
  label,
  badgeClass,
  items,
  selected,
  onSelect,
}: {
  label: string;
  badgeClass: string;
  items: UnmergedVariant[];
  selected: UnmergedVariant | null;
  onSelect: (v: UnmergedVariant) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Badge className={badgeClass}>{label}</Badge>
        <span className="text-sm text-muted-foreground">{items.length} unlinked variants</span>
      </div>
      <div className="space-y-2 max-h-[calc(100vh-420px)] overflow-y-auto pr-2">
        {items.map((v) => (
          <button
            key={v.variant_id}
            onClick={() => onSelect(v)}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              selected?.variant_id === v.variant_id
                ? "border-primary bg-primary/10"
                : "border-border bg-card hover:bg-muted/50"
            }`}
          >
            <p className="text-sm font-medium text-foreground truncate">{v.product_name}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-primary font-medium">{v.variant_name}</span>
              {v.channel_sku && (
                <span className="text-xs text-muted-foreground font-mono">{v.channel_sku}</span>
              )}
              {v.channel_price != null && (
                <span className="text-xs text-foreground ml-auto">£{v.channel_price.toFixed(2)}</span>
              )}
            </div>
          </button>
        ))}
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground p-4 text-center">All {label} variants are linked</p>
        )}
      </div>
    </div>
  );
}

export default MergePage;
