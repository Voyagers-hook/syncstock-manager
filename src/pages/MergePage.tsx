import { useState, useMemo } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import {
  useUnmergedProducts,
  useMergeProducts,
  useUnmergedVariants,
  useMergeVariants,
  useAllProductsForConsolidate,
  useConsolidateProducts,
  type UnmergedProduct,
  type UnmergedVariant,
  type ConsolidatableProduct,
} from "@/hooks/use-merge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, Link2, Undo2, Search, ArrowRight, Layers } from "lucide-react";
import { toast } from "sonner";

type TabId = "products" | "variants" | "consolidate";

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
          <button
            onClick={() => setTab("consolidate")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === "consolidate"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Consolidate
          </button>
        </div>

        {tab === "products" && <ProductMergeTab />}
        {tab === "variants" && <VariantMergeTab />}
        {tab === "consolidate" && <ConsolidateTab />}
      </main>
    </div>
  );
};

// ─── Consolidate tab ──────────────────────────────────────────────────────────
// Select multiple products → collapse them into one parent product with variants.
// Each product becomes a named variant. Channel listings stay attached to their
// variant, so eBay + Squarespace both remain linked after consolidation.

type ConsolidateSelection = {
  product: ConsolidatableProduct;
  variantId: string;
  variantName: string;
};

function ConsolidateTab() {
  const { data: allProducts = [], isLoading, error } = useAllProductsForConsolidate();
  const consolidate = useConsolidateProducts();

  const [search, setSearch] = useState("");
  // productId → ConsolidateSelection
  const [selected, setSelected] = useState<Map<string, ConsolidateSelection>>(new Map());
  const [parentName, setParentName] = useState("");
  const [keepProductId, setKeepProductId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return allProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku?.toLowerCase().includes(q) ?? false)
    );
  }, [allProducts, search]);

  const selectedList = Array.from(selected.values());

  const toggleProduct = (product: ConsolidatableProduct) => {
    const next = new Map(selected);
    if (next.has(product.id)) {
      next.delete(product.id);
      if (keepProductId === product.id) {
        setKeepProductId(next.size > 0 ? next.keys().next().value : null);
      }
    } else {
      const firstVariant = product.variants[0];
      next.set(product.id, {
        product,
        variantId: firstVariant?.id ?? "",
        variantName: firstVariant?.name === "Default" ? "" : (firstVariant?.name ?? ""),
      });
      if (!keepProductId) {
        setKeepProductId(product.id);
        setParentName(product.name);
      }
    }
    setSelected(next);
  };

  const updateVariantName = (productId: string, name: string) => {
    const next = new Map(selected);
    const entry = next.get(productId);
    if (entry) next.set(productId, { ...entry, variantName: name });
    setSelected(next);
  };

  const setKeep = (productId: string) => {
    setKeepProductId(productId);
    const prod = selected.get(productId)?.product;
    if (prod) setParentName(prod.name);
  };

  const handleConsolidate = async () => {
    if (!keepProductId) return toast.error("Choose a parent product");
    if (selectedList.length < 2) return toast.error("Select at least 2 products");
    const missing = selectedList.find((s) => !s.variantName.trim());
    if (missing) return toast.error(`Set a variant name for "${missing.product.name}"`);

    await consolidate.mutateAsync({
      keepProductId,
      parentName: parentName.trim() || selectedList[0].product.name,
      selections: selectedList.map((s) => ({
        productId: s.product.id,
        variantId: s.variantId,
        variantName: s.variantName.trim(),
      })),
    });

    setSelected(new Map());
    setKeepProductId(null);
    setParentName("");
    setSearch("");
  };

  return (
    <>
      <p className="text-xs text-muted-foreground mb-4">
        Use this when several separate listings are actually <strong>size/colour variants of the same product</strong> (e.g. three separate eBay listings for a 3005, 4005 and 5005 reel). Search, tick them all, name each variant, then hit <strong>Consolidate</strong>. They'll collapse into one product row with a variant dropdown — eBay &amp; Squarespace stay linked on each variant.
      </p>

      <div className="grid grid-cols-2 gap-6">
        {/* LEFT — search + checklist */}
        <div>
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search products to consolidate…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>

          {isLoading && (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && <p className="text-destructive text-sm p-4">Failed to load products.</p>}

          {!isLoading && !error && (
            <>
              {!search.trim() && (
                <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
                  <Search className="w-7 h-7 mb-2 opacity-40" />
                  <p className="text-sm">Type to search and select products to consolidate</p>
                </div>
              )}
              {search.trim() && filtered.length === 0 && (
                <p className="text-sm text-muted-foreground text-center p-8">No products match</p>
              )}
              <div className="space-y-2 max-h-[calc(100vh-380px)] overflow-y-auto pr-1">
                {filtered.map((product) => {
                  const isChecked = selected.has(product.id);
                  return (
                    <button
                      key={product.id}
                      onClick={() => toggleProduct(product)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors flex items-start gap-3 ${
                        isChecked
                          ? "border-primary bg-primary/10"
                          : "border-border bg-card hover:bg-muted/50"
                      }`}
                    >
                      <div className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                        isChecked ? "bg-primary border-primary" : "border-muted-foreground"
                      }`}>
                        {isChecked && (
                          <svg className="w-2.5 h-2.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{product.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {product.sku && (
                            <span className="text-xs font-mono text-muted-foreground">{product.sku}</span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {product.variants.length} variant{product.variants.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* RIGHT — consolidation panel */}
        <div>
          {selectedList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-12 text-center text-muted-foreground border rounded-xl border-dashed">
              <Layers className="w-7 h-7 mb-2 opacity-40" />
              <p className="text-sm">Tick products on the left to set them up as variants</p>
            </div>
          ) : (
            <div className="bg-card border rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Consolidation Setup</h3>

              {/* Parent product name */}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Parent product name</label>
                <Input
                  value={parentName}
                  onChange={(e) => setParentName(e.target.value)}
                  placeholder="e.g. Mikado Intro Carp Reel"
                  className="text-sm"
                />
              </div>

              <div className="space-y-3">
                {selectedList.map((sel) => (
                  <div key={sel.product.id} className={`p-3 rounded-lg border ${
                    keepProductId === sel.product.id ? "border-primary bg-primary/5" : "border-border"
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-foreground truncate flex-1 mr-2">{sel.product.name}</p>
                      {keepProductId === sel.product.id ? (
                        <Badge className="bg-primary text-primary-foreground text-xs flex-shrink-0">Parent</Badge>
                      ) : (
                        <button
                          onClick={() => setKeep(sel.product.id)}
                          className="text-xs text-muted-foreground hover:text-primary transition-colors flex-shrink-0"
                        >
                          Set as parent
                        </button>
                      )}
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Variant name (e.g. 4005, Red, Large)</label>
                      <Input
                        value={sel.variantName}
                        onChange={(e) => updateVariantName(sel.product.id, e.target.value)}
                        placeholder="Variant name…"
                        className="text-sm h-8"
                      />
                    </div>
                  </div>
                ))}
              </div>

              <Button
                className="w-full"
                onClick={handleConsolidate}
                disabled={selectedList.length < 2 || consolidate.isPending}
              >
                {consolidate.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Layers className="w-4 h-4 mr-2" />
                )}
                Consolidate {selectedList.length} Products into Variants
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Product-level merge tab ──────────────────────────────────────────────────

function ProductMergeTab() {
  const { data: unmerged = [], isLoading, error } = useUnmergedProducts();
  const merge = useMergeProducts();
  const [search, setSearch] = useState("");
  const [selectedEbay, setSelectedEbay] = useState<UnmergedProduct | null>(null);
  const [selectedSqsp, setSelectedSqsp] = useState<UnmergedProduct | null>(null);

  const filtered = search.trim()
    ? unmerged.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          (p.sku?.toLowerCase().includes(search.toLowerCase()) ?? false)
      )
    : [];

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
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button variant="outline" size="sm" disabled>
                    <Undo2 className="w-4 h-4 mr-2" />
                    Undo Last Merge
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Coming soon — undo merge is not yet available</TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
        Search for a product to find it in each column, then click <strong>Merge Selected</strong>. Variants are auto-matched by name — use the <strong>By Variant</strong> tab if you need to match them manually. For products that are size/colour variants of the same item, use the <strong>Consolidate</strong> tab instead.
      </p>

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
        <>
          {!search.trim() && (
            <div className="flex flex-col items-center justify-center p-16 text-center text-muted-foreground">
              <Search className="w-8 h-8 mb-3 opacity-40" />
              <p className="text-sm">Type a product name or SKU above to find items to merge</p>
            </div>
          )}
          {search.trim() && (
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
        <span className="text-sm text-muted-foreground">{items.length} result{items.length !== 1 ? "s" : ""}</span>
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
              {'channel_price' in item && (item as any).channel_price != null && (
                <span className="text-xs text-foreground">£{(item as any).channel_price.toFixed(2)}</span>
              )}
            </div>
          </button>
        ))}
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground p-4 text-center">No {label} results</p>
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

  const filtered = search.trim()
    ? variants.filter((v) =>
        v.product_name.toLowerCase().includes(search.toLowerCase())
      )
    : [];

  const ebayVariants = filtered.filter((v) => v.channel === "ebay");
  const sqspVariants = filtered.filter((v) => v.channel === "squarespace");

  const handleMerge = async () => {
    if (!selectedEbay || !selectedSqsp) {
      toast.error("Select one variant from each channel");
      return;
    }
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
            placeholder="Search by product name…"
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
        Search for a product, pick the matching eBay and Squarespace variants, then click <strong>Link Variants</strong>. After linking they share the same inventory — a sale on either platform adjusts both.
      </p>

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
        <>
          {!search.trim() && (
            <div className="flex flex-col items-center justify-center p-16 text-center text-muted-foreground">
              <Search className="w-8 h-8 mb-3 opacity-40" />
              <p className="text-sm">Type a product name above to find variants to link</p>
            </div>
          )}
          {search.trim() && (
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
        <span className="text-sm text-muted-foreground">{items.length} result{items.length !== 1 ? "s" : ""}</span>
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
          <p className="text-sm text-muted-foreground p-4 text-center">No {label} results</p>
        )}
      </div>
    </div>
  );
}

export default MergePage;
