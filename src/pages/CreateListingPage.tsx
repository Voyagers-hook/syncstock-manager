import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ConceptLayout from "@/components/ConceptLayout";
import { supabase } from "@/integrations/supabase/client";
import { buildListing, escapeHtml, parseListing, specRowsWithBrand, type SpecRow } from "@/lib/listing-converter";
import { FEE_RATES } from "@/hooks/use-sales";
import { toast } from "sonner";

// Create listing: one form lists a new product on eBay (with the template) and/or the
// Squarespace website, and saves it in SyncStock as ONE product with both shops linked.
// All the work happens in the create-listing edge function.

interface VariationRow { value: string; sku: string; price: string; webPrice: string; stock: string; photo: string; weightKg?: string; salePrice?: string }
interface Aspect { name: string; required: boolean; mode: string; multi: boolean; usage: string; forVariations: boolean; values: string[] }
interface Category { id: string; name: string; path: string }
interface Setup {
  ebay: { shipping: { name: string | null }; returns: { name: string | null }; payment: { name: string | null }; location: string | null; dispatchDays: string };
  storePages: { id: string; title: string; enabled: boolean }[];
}
interface VerifyResult { success: boolean; errors: string[]; warnings: string[]; fees: { name: string; amount: number }[]; problems: string[] }
interface CreateResult {
  ebay?: { itemId: string; url: string; warnings: string[] };
  website?: { productId: string; url?: string; photosUploaded: number; optionPhotos?: number; notes?: string[] };
  websiteError?: string;
  syncstock: { productId: string; variants: number; links: number; problems: string[] };
}
interface Draft { id: string; title: string; updated_at: string; data: FormState }

interface FormState {
  title: string;
  condition: string;
  brand: string;
  sku: string;
  stock: string;
  costPrice: string;
  postageCost: string; // what it costs you to post on eBay; only used for the profit figures, never sent anywhere
  price: string;
  webPrice: string;
  webPriceTouched: boolean;
  free: boolean;
  photos: string[];
  product: string;
  specs: SpecRow[];
  category: Category | null;
  specifics: Record<string, string>;
  hasVariations: boolean;
  variationName: string;
  variations: VariationRow[];
  toEbay: boolean;
  toWebsite: boolean;
  storePageId: string;
  websiteVisible: boolean;
  weightKg: string;
  // website-only details
  headline: string; // heading on the eBay description; the eBay title can carry extra search keywords
  webTitle: string;
  webSameDesc: boolean;
  webProduct: string;
  tags: string[];
  urlSlug: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  onSale: boolean;
  salePrice: string;
  seoTitle: string;
  seoDescription: string;
}

const CONDITIONS: { id: string; label: string }[] = [
  { id: "1000", label: "Brand new" },
  { id: "1500", label: "New (other)" },
  { id: "3000", label: "Used" },
];

const blank = (): FormState => ({
  title: "",
  condition: "1000",
  brand: "",
  sku: "",
  stock: "1",
  costPrice: "",
  postageCost: "",
  price: "",
  webPrice: "",
  webPriceTouched: false,
  free: true,
  photos: [],
  product: "",
  specs: [],
  category: null,
  specifics: {},
  hasVariations: false,
  variationName: "Colour",
  variations: [],
  toEbay: true,
  toWebsite: true,
  storePageId: "",
  websiteVisible: false,
  weightKg: "",
  headline: "",
  webTitle: "",
  webSameDesc: true,
  webProduct: "",
  tags: [],
  urlSlug: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  onSale: false,
  salePrice: "",
  seoTitle: "",
  seoDescription: "",
});

const emptyVar = (): VariationRow => ({ value: "", sku: "", price: "", webPrice: "", stock: "1", photo: "", weightKg: "", salePrice: "" });

async function callFn<T = unknown>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
      if (ctx && typeof ctx.json === "function") {
        const j = await ctx.json();
        if (j?.error) msg = j.error;
      }
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (data && typeof data === "object" && "error" in data && data.error) throw new Error(String(data.error));
  return data as T;
}
const cl = <T,>(body: Record<string, unknown>) => callFn<T>("create-listing", body);

const num = (s: string) => {
  const n = parseFloat(String(s).replace(/[£,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const gbp = (n: number) => "£" + (Math.round(n * 100) / 100).toFixed(2);
const fee = (platform: "ebay" | "squarespace", price: number) => {
  const r = FEE_RATES[platform];
  return price > 0 ? price * r.pct + r.fixed : 0;
};
// Website price defaults to the eBay price minus 10%.
const suggestWeb = (price: string) => (num(price) > 0 ? (Math.round(num(price) * 0.9 * 100) / 100).toFixed(2) : "");

// Shrink big photos before upload so they go up quickly (eBay's max is 7MB).
async function photoToBase64(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That file isn't a photo SyncStock can read."));
      i.src = url;
    });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Plain description for the website: the text plus the numbers as a simple table.
function websiteHtml(product: string, specs: SpecRow[], title: string): string {
  const rows = specRowsWithBrand(specs, title).filter((r) => r[0].trim() && r[1].trim());
  const table = rows.length
    ? `<h3>The numbers</h3><table>${rows.map((r) => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td>${escapeHtml(r[1])}</td></tr>`).join("")}</table>`
    : "";
  const body = (product || "").trim();
  return (body && !body.startsWith("<") ? `<p>${body}</p>` : body) + table;
}

const CreateListingPage = () => {
  const qc = useQueryClient();
  const [view, setView] = useState<"new" | "drafts">("new");
  const [f, setF] = useState<FormState>(blank);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0); // bumps when a draft/copy loads, to refill the text editor
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const setupQ = useQuery({ queryKey: ["create-listing-setup"], queryFn: () => cl<Setup>({ action: "setup" }), staleTime: 30 * 60 * 1000 });
  const draftsQ = useQuery({ queryKey: ["listing-drafts"], queryFn: async () => (await cl<{ drafts: Draft[] }>({ action: "drafts" })).drafts });
  const setup = setupQ.data;

  // Default the website shop page to the first enabled one.
  useEffect(() => {
    if (setup && !f.storePageId) {
      const first = setup.storePages.find((p) => p.enabled);
      if (first) set("storePageId", first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  // ── item specifics for the picked category ──
  const aspectsQ = useQuery({
    queryKey: ["ebay-aspects", f.category?.id],
    enabled: !!f.category?.id,
    queryFn: async () => (await cl<{ aspects: Aspect[] }>({ action: "aspects", categoryId: f.category!.id })).aspects,
    staleTime: 60 * 60 * 1000,
  });
  const aspects = useMemo(() => {
    const all = aspectsQ.data ?? [];
    const req = all.filter((a) => a.required);
    const rec = all.filter((a) => !a.required && a.usage === "RECOMMENDED").slice(0, 9);
    return [...req, ...rec].filter((a) => !(f.hasVariations && a.name === f.variationName));
  }, [aspectsQ.data, f.hasVariations, f.variationName]);

  // Fill item specifics from the brand and the numbers where the names match.
  useEffect(() => {
    if (!aspects.length) return;
    setF((s) => {
      const next = { ...s.specifics };
      for (const a of aspects) {
        if (next[a.name]) continue;
        if (/^brand$/i.test(a.name) && s.brand) next[a.name] = s.brand;
        const row = s.specs.find((r) => r[0].trim().toLowerCase() === a.name.toLowerCase());
        if (row?.[1]) next[a.name] = row[1];
      }
      return { ...s, specifics: next };
    });
  }, [aspects, f.brand, f.specs]);

  const missingSpecifics = aspects.filter((a) => a.required && !(f.specifics[a.name] || "").trim()).map((a) => a.name);

  // ── the listing sent to the function ──
  const conditionLabel = CONDITIONS.find((c) => c.id === f.condition)?.label ?? "Brand new";
  const specsForTemplate = useMemo(
    () => (f.brand && !f.specs.some((r) => /^brand$/i.test(r[0])) ? ([["Brand", f.brand], ...f.specs] as SpecRow[]) : f.specs),
    [f.brand, f.specs],
  );
  const ebayHtml = useMemo(
    () => buildListing({ title: f.headline.trim() || f.title, condition: conditionLabel, free: f.free, showSpecs: true, hideRepeats: true, product: f.product, specs: specsForTemplate }),
    [f.headline, f.title, conditionLabel, f.free, f.product, specsForTemplate],
  );
  const webHtml = useMemo(
    () => websiteHtml(f.webSameDesc ? f.product : f.webProduct, specsForTemplate, f.title),
    [f.webSameDesc, f.product, f.webProduct, specsForTemplate, f.title],
  );

  const listing = useMemo(() => {
    const specifics: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(f.specifics)) if (v.trim()) specifics[k] = v.split(/\s*;\s*/).filter(Boolean);
    if (f.brand && !Object.keys(specifics).some((k) => /^brand$/i.test(k))) specifics.Brand = [f.brand];
    const vars = f.hasVariations
      ? f.variations.map((v) => ({
          value: v.value.trim(),
          sku: v.sku.trim(),
          price: num(v.price),
          webPrice: num(v.webPrice) || num(v.price),
          stock: Math.floor(num(v.stock)),
          ...(v.photo !== "" ? { photo: Number(v.photo) } : {}),
          ...(num(v.weightKg || "") > 0 ? { weightKg: num(v.weightKg || "") } : {}),
          ...(f.onSale && num(v.salePrice || "") > 0 ? { salePrice: num(v.salePrice || "") } : {}),
        }))
      : [];
    return {
      title: f.title.trim(),
      sku: f.sku.trim(),
      brand: f.brand.trim(),
      conditionId: f.condition,
      price: num(f.price),
      webPrice: num(f.webPrice) || num(f.price),
      stock: Math.floor(num(f.stock)),
      costPrice: f.costPrice ? num(f.costPrice) : undefined,
      photos: f.photos,
      descriptionHtml: ebayHtml,
      websiteHtml: webHtml,
      categoryId: f.category?.id ?? "",
      specifics,
      variationName: f.hasVariations ? f.variationName.trim() : undefined,
      variations: vars,
      toEbay: f.toEbay,
      toWebsite: f.toWebsite,
      website: f.toWebsite
        ? {
            storePageId: f.storePageId,
            tags: f.tags,
            visible: f.websiteVisible,
            title: f.webTitle.trim() || f.headline.trim() || undefined,
            urlSlug: f.urlSlug.trim() || undefined,
            weightKg: num(f.weightKg) || undefined,
            lengthCm: num(f.lengthCm) || undefined,
            widthCm: num(f.widthCm) || undefined,
            heightCm: num(f.heightCm) || undefined,
            onSale: f.onSale,
            salePrice: f.onSale && !f.hasVariations ? num(f.salePrice) || undefined : undefined,
            seoTitle: f.seoTitle.trim() || undefined,
            seoDescription: f.seoDescription.trim() || undefined,
          }
        : undefined,
    };
  }, [f, ebayHtml, webHtml]);

  // ── checklist ──
  const priceOk = f.hasVariations
    ? f.variations.length > 0 && f.variations.every((v) => v.value.trim() && num(v.price) > 0) && !!f.variationName.trim()
    : num(f.price) > 0;
  const varNames = f.variations.map((v) => v.value.trim().toLowerCase());
  const varsUnique = new Set(varNames).size === varNames.length;
  const checks: { label: string; ok: boolean; hint?: string; show: boolean }[] = [
    { label: "Title, price and stock", ok: !!f.title.trim() && f.title.length <= 80 && priceOk && varsUnique, hint: f.title.length > 80 ? "Title is over 80 characters" : !varsUnique ? "Two options have the same name" : undefined, show: true },
    { label: "Photos", ok: f.photos.length > 0, show: true },
    { label: "Description", ok: f.product.replace(/<[^>]+>/g, "").trim().length > 0, show: true },
    { label: "eBay category", ok: !!f.category, show: f.toEbay },
    { label: missingSpecifics.length ? `${missingSpecifics.join(", ")} ${missingSpecifics.length === 1 ? "is" : "are"} required` : "Item specifics", ok: !!f.category && !aspectsQ.isLoading && missingSpecifics.length === 0, show: f.toEbay },
    { label: "Website shop page", ok: !!f.storePageId, show: f.toWebsite },
    {
      label: "Website weight (sets the postage)",
      ok: f.hasVariations ? f.variations.length > 0 && f.variations.every((v) => num(v.weightKg || "") > 0 || num(f.weightKg) > 0) : num(f.weightKg) > 0,
      hint: "Squarespace works out postage from the weight",
      show: f.toWebsite,
    },
    {
      label: "Website sale price",
      ok: !f.onSale || (f.hasVariations ? f.variations.some((v) => num(v.salePrice || "") > 0) : num(f.salePrice) > 0 && num(f.salePrice) < (num(f.webPrice) || num(f.price))),
      hint: "Lower than the website price",
      show: f.toWebsite && f.onSale,
    },
    { label: "Delivery and returns", ok: !!setup, hint: setupQ.isError ? "Couldn't load your eBay policies" : undefined, show: f.toEbay },
    { label: "Where to list", ok: f.toEbay || f.toWebsite, show: true },
  ];
  const visibleChecks = checks.filter((c) => c.show);
  const allGreen = visibleChecks.every((c) => c.ok);

  // ── check with eBay / list it ──
  const fingerprint = JSON.stringify(listing);
  const [check, setCheck] = useState<{ fp: string; r: VerifyResult } | null>(null);
  const [checking, setChecking] = useState(false);
  const [listing_, setListing_] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const checkPassed = !!check && check.fp === fingerprint && check.r.success && !check.r.problems.length;
  const canList = allGreen && (!f.toEbay || checkPassed);

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await cl<VerifyResult>({ action: "verify", listing });
      setCheck({ fp: fingerprint, r });
      if (r.success && !r.problems.length) toast.success("eBay is happy with it. Nothing has gone live.");
      else toast.error("eBay found something to fix. See the list on the right.");
    } catch (e) {
      toast.error((e as Error).message || "Couldn't check with eBay.");
    } finally {
      setChecking(false);
    }
  };

  const listIt = async () => {
    setListing_(true);
    try {
      const r = await cl<CreateResult>({ action: "create", listing, draftId });
      setResult(r);
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
      if (r.websiteError) toast.error("Listed on eBay, but the website didn't take it: " + r.websiteError);
      else toast.success("Listed.");
    } catch (e) {
      toast.error((e as Error).message || "Listing failed. Nothing was saved in SyncStock.");
    } finally {
      setListing_(false);
    }
  };

  // ── drafts ──
  const [saving, setSaving] = useState(false);
  const saveDraft = async () => {
    setSaving(true);
    try {
      const r = await cl<{ id: string }>({ action: "save_draft", id: draftId, data: f });
      setDraftId(r.id);
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
      toast.success("Draft saved.");
    } catch (e) {
      toast.error((e as Error).message || "Couldn't save the draft.");
    } finally {
      setSaving(false);
    }
  };
  const openDraft = (d: Draft) => {
    setF({ ...blank(), ...d.data });
    setDraftId(d.id);
    setResult(null);
    setCheck(null);
    setFormKey((k) => k + 1);
    setView("new");
  };
  const deleteDraft = async (id: string) => {
    try {
      await cl({ action: "delete_draft", id });
      if (id === draftId) setDraftId(null);
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
    } catch (e) {
      toast.error((e as Error).message || "Couldn't delete the draft.");
    }
  };
  const startNew = () => {
    setF(blank());
    setDraftId(null);
    setResult(null);
    setCheck(null);
    setFormKey((k) => k + 1);
    setView("new");
  };

  // ── copy from an existing eBay listing ──
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyId, setCopyId] = useState("");
  const [copying, setCopying] = useState(false);
  const copyFrom = async () => {
    const id = (copyId.match(/\d{9,}/) || [""])[0];
    if (!id) return toast.error("Paste an eBay item number or link.");
    setCopying(true);
    try {
      const it = await cl<{
        title: string; sku: string | null; conditionId: string | null; price: number; categoryId: string | null; categoryName: string | null;
        photos: string[]; specifics: Record<string, string[]>; variationName: string | null;
        variations: { sku: string; value: string; price: number }[];
      }>({ action: "item", itemId: id });
      let product = "";
      let specs: SpecRow[] = [];
      let headline = "";
      try {
        const d = await callFn<{ description: string }>("listing-template", { action: "get", itemId: id });
        const p = parseListing(d.description);
        if (p.ok) { product = p.product; specs = p.specs; if (p.title && p.title.trim() !== (it.title || "").trim()) headline = p.title.trim(); }
      } catch { /* description is optional */ }
      const specifics: Record<string, string> = {};
      for (const [k, v] of Object.entries(it.specifics || {})) specifics[k] = v.join("; ");
      setF({
        ...blank(),
        storePageId: f.storePageId,
        title: it.title || "",
        headline,
        condition: CONDITIONS.some((c) => c.id === it.conditionId) ? it.conditionId! : "1000",
        brand: (it.specifics?.Brand || [])[0] || "",
        price: it.price ? it.price.toFixed(2) : "",
        webPrice: suggestWeb(it.price ? String(it.price) : ""),
        photos: it.photos || [],
        product,
        specs,
        category: it.categoryId ? { id: it.categoryId, name: (it.categoryName || "").split(":").pop() || it.categoryId, path: (it.categoryName || "").split(":").slice(0, -1).join(" › ") } : null,
        specifics,
        hasVariations: it.variations.length > 0,
        variationName: it.variationName || "Colour",
        // SKUs are left blank on purpose: SyncStock needs new ones for a new listing.
        variations: it.variations.map((v) => ({ value: v.value, sku: "", price: v.price.toFixed(2), webPrice: suggestWeb(String(v.price)), stock: "1", photo: "" })),
      });
      setDraftId(null);
      setResult(null);
      setCheck(null);
      setFormKey((k) => k + 1);
      setCopyOpen(false);
      setCopyId("");
      toast.success("Copied. Change what's different, add new SKUs and stock, then check it.");
    } catch (e) {
      toast.error((e as Error).message || "Couldn't read that listing.");
    } finally {
      setCopying(false);
    }
  };

  const drafts = draftsQ.data ?? [];
  // Sections are numbered in the order they show, so hiding eBay or website ones doesn't leave gaps.
  let sectionNo = 0;
  const num_ = (_name: string) => ++sectionNo;

  return (
    <ConceptLayout title="Create listing" subtitle="One form, listed on eBay and your website">
      <div className="cl-top">
        <div className="seg">
          <button className={view === "new" ? "on" : ""} onClick={() => setView("new")}>{draftId ? "Draft" : "New"}</button>
          <button className={view === "drafts" ? "on" : ""} onClick={() => setView("drafts")}>Drafts{drafts.length ? ` (${drafts.length})` : ""}</button>
        </div>
        <button className="btn ghost" onClick={startNew}>Start a new one</button>
        <button className="btn ghost" onClick={() => setCopyOpen((o) => !o)}>Copy from existing…</button>
        {copyOpen && (
          <div className="cl-copy">
            <input
              autoFocus
              placeholder="eBay item number or link"
              value={copyId}
              onChange={(e) => setCopyId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && copyFrom()}
            />
            <button className="btn primary" disabled={copying} onClick={copyFrom}>{copying ? "Copying…" : "Copy"}</button>
          </div>
        )}
      </div>

      {view === "drafts" ? (
        <div className="panel">
          <h3>Drafts</h3>
          {draftsQ.isLoading ? (
            <div className="empty">Loading drafts…</div>
          ) : drafts.length === 0 ? (
            <div className="empty">No drafts. Press "Save as draft" on a listing to keep it for later.</div>
          ) : (
            drafts.map((d) => (
              <div className="cl-draft" key={d.id}>
                <div>
                  <b>{d.title}</b>
                  <small>Saved {new Date(d.updated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</small>
                </div>
                <button className="btn primary" onClick={() => openDraft(d)}>Open</button>
                <button className="btn ghost" onClick={() => deleteDraft(d.id)}>Delete</button>
              </div>
            ))
          )}
        </div>
      ) : result ? (
        <ResultPanel result={result} onAnother={startNew} />
      ) : (
        <div className="cl-grid">
          <div>
            <Section n={num_("where")} title="Where to list">
              <div className="cl-where">
                <label className={f.toEbay ? "on" : ""}>
                  <input type="checkbox" checked={f.toEbay} onChange={(e) => set("toEbay", e.target.checked)} />
                  <span><b>eBay</b><small>Listed with your template, live straight away</small></span>
                </label>
                <label className={f.toWebsite ? "on" : ""}>
                  <input type="checkbox" checked={f.toWebsite} onChange={(e) => set("toWebsite", e.target.checked)} />
                  <span><b>Website (Squarespace)</b><small>{f.websiteVisible ? "Shown on the website straight away" : "Added hidden so you can finish it in Squarespace"}</small></span>
                </label>
              </div>
            </Section>
            <ProductSection n={num_("product")} f={f} set={set} />
            <PhotosSection n={num_("photos")} f={f} set={set} />
            <DescriptionSection key={formKey} n={num_("description")} f={f} set={set} />
            {f.toEbay && <CategorySection n={num_("category")} f={f} set={set} />}
            {f.toEbay && (
              <Section n={num_("specifics")} title="Item specifics" badge={!f.category ? undefined : aspectsQ.isLoading ? "Loading…" : missingSpecifics.length ? `${missingSpecifics.length} required left` : "Done"} warn={missingSpecifics.length > 0}>
                {!f.category ? (
                  <div className="note" style={{ margin: 0 }}>Pick an eBay category first. eBay then says which details it wants.</div>
                ) : aspectsQ.isError ? (
                  <div className="lt-note warn">Couldn't load the item specifics: {(aspectsQ.error as Error).message}</div>
                ) : (
                  <>
                    <div className="cl-specifics">
                      {aspects.map((a) => (
                        <div className="fld" key={a.name}>
                          <label>
                            {a.name}
                            {a.required && <span className="cl-req">required</span>}
                          </label>
                          <input
                            list={a.values.length ? `asp-${a.name}` : undefined}
                            className={a.required && !(f.specifics[a.name] || "").trim() ? "cl-missing" : ""}
                            value={f.specifics[a.name] || ""}
                            placeholder={a.mode === "SELECTION_ONLY" ? "Choose…" : ""}
                            onChange={(e) => set("specifics", { ...f.specifics, [a.name]: e.target.value })}
                          />
                          {a.values.length > 0 && (
                            <datalist id={`asp-${a.name}`}>
                              {a.values.map((v) => <option key={v} value={v} />)}
                            </datalist>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="note" style={{ margin: 0 }}>
                      Filled in from the brand and the numbers where the names match. Separate more than one value with a semicolon.
                    </div>
                  </>
                )}
              </Section>
            )}
            <VariationsSection n={num_("variations")} f={f} set={set} />
            {f.toEbay && (
              <Section n={num_("delivery")} title="Delivery and returns" badge={setup ? "Your usual" : undefined}>
                {setupQ.isLoading ? (
                  <div className="note" style={{ margin: 0 }}>Loading your eBay policies…</div>
                ) : setupQ.isError ? (
                  <div className="lt-note warn">Couldn't load your eBay policies: {(setupQ.error as Error).message}</div>
                ) : (
                  <>
                    <div className="cl-tiles">
                      <div><b>Free standard</b><small>2 to 5 working days</small></div>
                      <div><b>Express £6.99</b><small>Offered at checkout</small></div>
                      <div><b>30-day returns</b><small>Same as your other listings</small></div>
                    </div>
                    <div className="note" style={{ marginBottom: 0 }}>
                      Uses the same eBay policies as your live listings: {[setup?.ebay.shipping.name, setup?.ebay.returns.name].filter(Boolean).map((n) => String(n).replace(/\s*\(\d+\)$/, "")).join(", ")}. Dispatch within{" "}
                      {setup?.ebay.dispatchDays} working day{setup?.ebay.dispatchDays === "1" ? "" : "s"} from {setup?.ebay.location}.
                    </div>
                    <div className="lt-checks" style={{ margin: "12px 0 0" }}>
                      <label><input type="checkbox" checked={f.free} onChange={(e) => set("free", e.target.checked)} /> Show "Free UK delivery" on the listing</label>
                    </div>
                  </>
                )}
              </Section>
            )}
            {f.toWebsite && <WebsiteSection key={"w" + formKey} n={num_("website")} f={f} set={set} setup={setup} />}
          </div>

          <aside className="cl-side">
            <PreviewPanel ebayHtml={ebayHtml} webHtml={webHtml} f={f} />
            <div className="panel">
              <h3>Ready to list?</h3>
              <div className="cl-checklist">
                {visibleChecks.map((c) => (
                  <div key={c.label} className={c.ok ? "ok" : "no"}>
                    <i>{c.ok ? "✓" : "!"}</i>
                    <span>{c.label}{!c.ok && c.hint ? <small>{c.hint}</small> : null}</span>
                  </div>
                ))}
              </div>
              {check && check.fp === fingerprint && (
                <div className="cl-checkres">
                  {check.r.success && !check.r.problems.length ? (
                    <div className="lt-note ok" style={{ margin: 0 }}>
                      eBay accepted the test listing.{check.r.fees.length ? ` Fees: ${check.r.fees.map((x) => `${x.name} ${gbp(x.amount)}`).join(", ")}.` : " No listing fees."}
                    </div>
                  ) : (
                    <div className="lt-note warn" style={{ margin: 0 }}>
                      {[...check.r.problems, ...check.r.errors].map((m, i) => <div key={i}>{m}</div>)}
                    </div>
                  )}
                  {check.r.warnings.length > 0 && (
                    <div className="note" style={{ marginTop: 8 }}>eBay also said: {check.r.warnings.join(" ")}</div>
                  )}
                </div>
              )}
              {check && check.fp !== fingerprint && f.toEbay && (
                <div className="note" style={{ margin: "0 20px 12px" }}>You've changed something since the last check. Check again before listing.</div>
              )}
            </div>
            <div className="panel cl-actions">
              {confirm ? (
                <>
                  <div className="lt-confirm" style={{ marginBottom: 10 }}>
                    {f.toEbay && f.toWebsite
                      ? `List it on eBay now and add it to the website${f.websiteVisible ? "" : " (hidden)"}?`
                      : f.toEbay ? "List it on eBay now? It goes live straight away." : `Add it to the website${f.websiteVisible ? "" : " (hidden)"}?`}
                  </div>
                  <div className="cl-btns">
                    <button className="btn primary" disabled={listing_} onClick={listIt}>{listing_ ? "Listing…" : "Yes, list it"}</button>
                    <button className="btn ghost" disabled={listing_} onClick={() => setConfirm(false)}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="cl-btns">
                    {f.toEbay && (
                      <button className="btn ghost" disabled={checking || !allGreen} onClick={runCheck}>{checking ? "Checking…" : "Check with eBay"}</button>
                    )}
                    <button className="btn primary" disabled={!canList} onClick={() => setConfirm(true)}>List it</button>
                  </div>
                  <button className="btn ghost cl-wide" disabled={saving} onClick={saveDraft}>{saving ? "Saving…" : draftId ? "Save draft" : "Save as draft"}</button>
                  <div className="note">
                    {f.toEbay
                      ? '"Check with eBay" runs a test listing that doesn\'t go live and shows any problems and eBay\'s fees. "List it" unlocks once everything is green and eBay is happy.'
                      : '"List it" unlocks once everything is green.'}
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </ConceptLayout>
  );
};

// ── sections ────────────────────────────────────────────────────────────────

type SetFn = <K extends keyof FormState>(k: K, v: FormState[K]) => void;

const Section = ({ n, title, badge, warn, children }: { n: number; title: string; badge?: string; warn?: boolean; children: React.ReactNode }) => (
  <div className="panel cl-sec">
    <h3>
      <span className="cl-n">{n}</span>
      {title}
      {badge && <span className={`cl-badge${warn ? " warn" : ""}`}>{badge}</span>}
    </h3>
    <div className="mb">{children}</div>
  </div>
);

const ProductSection = ({ n, f, set }: { n: number; f: FormState; set: SetFn }) => {
  const price = num(f.price), web = num(f.webPrice) || price, cost = num(f.costPrice), post = num(f.postageCost);
  const eFee = fee("ebay", price), sFee = fee("squarespace", web);
  const eProfit = price - eFee - cost - post, sProfit = web - sFee - cost;
  const pct = (p: number, of: number) => (of > 0 ? ` · ${Math.round((p / of) * 100)}%` : "");
  const done = !!f.title.trim() && (f.hasVariations || num(f.price) > 0);
  return (
    <Section n={n} title="Product" badge={done ? "Done" : undefined}>
      <div className="cl-row-title">
        <div className="fld">
          <label>eBay title <span className={`cl-count${f.title.length > 80 ? " over" : ""}`}>{f.title.length} / 80</span></label>
          <input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Brand, product, size, colour, plus search keywords" />
        </div>
        <div className="fld">
          <label>Condition</label>
          <select value={f.condition} onChange={(e) => set("condition", e.target.value)}>
            {CONDITIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
      </div>
      <div className="fld">
        <label>Heading on the description <span className="cl-count">{f.headline ? `${f.headline.length} characters` : "Same as the eBay title if left blank"}</span></label>
        <input value={f.headline} onChange={(e) => set("headline", e.target.value)} placeholder={f.title || "The clean product name, without the extra keywords"} />
      </div>
      <div className="cl-row4">
        <div className="fld"><label>Brand</label><input value={f.brand} onChange={(e) => set("brand", e.target.value)} /></div>
        <div className="fld"><label>Your SKU</label><input value={f.sku} onChange={(e) => set("sku", e.target.value)} placeholder={f.hasVariations ? "Optional" : "Optional"} /></div>
        <div className="fld"><label>Stock</label><input inputMode="numeric" value={f.hasVariations ? "Set per option" : f.stock} disabled={f.hasVariations} onChange={(e) => set("stock", e.target.value)} /></div>
        <div className="fld"><label>Cost price</label><input inputMode="decimal" value={f.costPrice} onChange={(e) => set("costPrice", e.target.value)} placeholder="£" /></div>
      </div>
      {f.hasVariations && (
        <div className="fld" style={{ maxWidth: 260 }}>
          <label>Your eBay postage cost <span className="cl-count">not shown to buyers</span></label>
          <input inputMode="decimal" value={f.postageCost} placeholder="£" onChange={(e) => set("postageCost", e.target.value)} />
        </div>
      )}
      {!f.hasVariations && (
        <>
          <div className="cl-row3">
            <div className="fld">
              <label>eBay price</label>
              <input
                inputMode="decimal"
                value={f.price}
                placeholder="£"
                onChange={(e) => {
                  set("price", e.target.value);
                  if (!f.webPriceTouched) set("webPrice", suggestWeb(e.target.value));
                }}
              />
            </div>
            <div className="fld">
              <label>Website price <span className="cl-count">eBay minus 10%</span></label>
              <input inputMode="decimal" value={f.webPrice} placeholder="£" onChange={(e) => { set("webPrice", e.target.value); set("webPriceTouched", true); }} />
            </div>
            <div className="fld">
              <label>Your eBay postage cost <span className="cl-count">not shown to buyers</span></label>
              <input inputMode="decimal" value={f.postageCost} placeholder="£" onChange={(e) => set("postageCost", e.target.value)} />
            </div>
          </div>
          {price > 0 && (
            <div className="cl-profit">
              <div><span>eBay profit{!cost ? " (add a cost price)" : !post && f.free ? " (add postage)" : ""}</span><b className={eProfit < 0 ? "neg" : ""}>{gbp(eProfit)}{pct(eProfit, price)}</b></div>
              <div><span>Website profit</span><b className={sProfit < 0 ? "neg" : ""}>{gbp(sProfit)}{pct(sProfit, web)}</b></div>
              <div><span>eBay fees (est.)</span><b className="plain">{gbp(eFee)}</b></div>
            </div>
          )}
          {price > 0 && (
            <div className="note" style={{ marginTop: 8 }}>
              eBay profit is after eBay fees, the cost price and your postage. Website profit is after Squarespace fees and the cost price; buyers pay postage on the website.
            </div>
          )}
        </>
      )}
    </Section>
  );
};

const PhotosSection = ({ n, f, set }: { n: number; f: FormState; set: SetFn }) => {
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef(f.photos);
  photosRef.current = f.photos;

  const add = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((x) => x.type.startsWith("image/")).slice(0, Math.max(0, 12 - photosRef.current.length));
    if (!list.length) return;
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const data = await photoToBase64(file);
        const r = await cl<{ url: string }>({ action: "upload_photo", name: file.name, data });
        set("photos", [...photosRef.current, r.url]);
        photosRef.current = [...photosRef.current, r.url];
      } catch (e) {
        toast.error(`${file.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const move = (i: number, d: number) => {
    const p = [...f.photos];
    const j = i + d;
    if (j < 0 || j >= p.length) return;
    [p[i], p[j]] = [p[j], p[i]];
    set("photos", p);
  };
  const remove = (i: number) => {
    set("photos", f.photos.filter((_, j) => j !== i));
    // Keep variation photo picks pointing at the right photo.
    set("variations", f.variations.map((v) => {
      if (v.photo === "") return v;
      const n = Number(v.photo);
      return { ...v, photo: n === i ? "" : n > i ? String(n - 1) : v.photo };
    }));
  };

  return (
    <Section n={n} title="Photos" badge={f.photos.length ? `${f.photos.length} added` : undefined}>
      <div className="cl-photos">
        {f.photos.map((u, i) => (
          <div className="cl-photo" key={u + i}>
            <img src={u} alt={`Photo ${i + 1}`} />
            {i === 0 && <span className="cl-main">Main</span>}
            <div className="cl-photo-tools">
              <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move left">‹</button>
              <button onClick={() => remove(i)} aria-label="Remove">×</button>
              <button onClick={() => move(i, 1)} disabled={i === f.photos.length - 1} aria-label="Move right">›</button>
            </div>
          </div>
        ))}
        {Array.from({ length: uploading }).map((_, i) => <div className="cl-photo cl-up" key={"u" + i}>Uploading…</div>)}
        {f.photos.length + uploading < 12 && (
          <button
            className={`cl-drop${over ? " over" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
          >
            + Add or drop photos
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="note" style={{ marginBottom: 0 }}>
        Up to 12. The first is the main photo; use the arrows to reorder. Photos are stored by eBay and copied to your website when you list.
      </div>
    </Section>
  );
};

// Text editor with a small toolbar and an HTML mode. Pastes as plain text so supplier styling doesn't come along.
const RichEditor = ({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) => {
  const [mode, setMode] = useState<"text" | "html">("text");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode === "text" && ref.current) ref.current.innerHTML = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const fmt = (cmd: string, v?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, v);
    if (ref.current) onChange(ref.current.innerHTML);
  };
  return (
    <>
      <div className="lt-desc-head">
        <div className="lt-sub" style={{ margin: 0 }}>{label}</div>
        <div className="seg">
          <button className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>Text</button>
          <button className={mode === "html" ? "on" : ""} onClick={() => setMode("html")}>HTML</button>
        </div>
      </div>
      {mode === "text" ? (
        <>
          <div className="lt-toolbar" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" onClick={() => fmt("bold")} title="Bold"><b>B</b></button>
            <button type="button" onClick={() => fmt("formatBlock", "h3")}>Heading</button>
            <button type="button" onClick={() => fmt("formatBlock", "p")}>Normal text</button>
            <button type="button" onClick={() => fmt("insertUnorderedList")}>• List</button>
            <button type="button" onClick={() => fmt("undo")}>Undo</button>
          </div>
          <div
            ref={ref}
            className="lt-desc"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
            onPaste={(e) => {
              e.preventDefault();
              document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
            }}
          />
        </>
      ) : (
        <textarea className="lt-desc-html" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} HTML`} />
      )}
    </>
  );
};

const DescriptionSection = ({ n, f, set }: { n: number; f: FormState; set: SetFn }) => {
  const setSpec = (i: number, col: 0 | 1, v: string) =>
    set("specs", f.specs.map((r, j) => (j === i ? ((col === 0 ? [v, r[1]] : [r[0], v]) as SpecRow) : r)));
  const done = f.product.replace(/<[^>]+>/g, "").trim().length > 0;
  return (
    <Section n={n} title="Description" badge={done ? "Done" : undefined}>
      <RichEditor
        value={f.product}
        onChange={(v) => set("product", v)}
        label="About the product"
        placeholder="What it is, what it's for, and the key features. Paste from the supplier's site if you like; the styling is stripped."
      />
      <div className="lt-specs" style={{ marginTop: 16, marginBottom: 0 }}>
        <div className="lt-sub">The numbers</div>
        {f.specs.map((r, i) => (
          <div className="lt-spec" key={i}>
            <input aria-label="Label" value={r[0]} onChange={(e) => setSpec(i, 0, e.target.value)} placeholder="Label, e.g. Length" />
            <input aria-label="Value" value={r[1]} onChange={(e) => setSpec(i, 1, e.target.value)} placeholder="Value, e.g. 24cm" />
            <button className="btn ghost" aria-label="Remove row" onClick={() => set("specs", f.specs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="btn ghost" onClick={() => set("specs", [...f.specs, ["", ""]])}>+ Add row</button>
        <div className="note" style={{ marginTop: 8 }}>Brand is added from the Brand box. Feature bullets that repeat the numbers are hidden on eBay.</div>
      </div>
    </Section>
  );
};

const CategorySection = ({ n, f, set }: { n: number; f: FormState; set: SetFn }) => {
  const [q, setQ] = useState("");
  const [cats, setCats] = useState<Category[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async (query = q || f.title) => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const r = await cl<{ categories: Category[] }>({ action: "categories", query });
      setCats(r.categories);
    } catch (e) {
      toast.error((e as Error).message || "Category search failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section n={n} title="eBay category" badge={f.category ? "Picked" : undefined}>
      {f.category && (
        <div className="cl-picked">
          <b>{f.category.name}</b>
          <small>{f.category.path}{f.category.path ? " · " : ""}{f.category.id}</small>
          <button className="btn ghost" onClick={() => { set("category", null); set("specifics", {}); }}>Change</button>
        </div>
      )}
      {!f.category && (
        <>
          <div className="cl-search">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder={f.title ? `Search, or press Find to use the title` : "e.g. pike soft lure"} />
            <button className="btn primary" disabled={busy} onClick={() => search()}>{busy ? "Finding…" : "Find"}</button>
          </div>
          {cats && (cats.length === 0 ? (
            <div className="note">No matches. Try fewer or different words.</div>
          ) : (
            <div className="cl-cats">
              {cats.map((c) => (
                <button key={c.id} onClick={() => { set("category", c); set("specifics", {}); }}>
                  <b>{c.name}</b>
                  <small>{c.path}</small>
                </button>
              ))}
            </div>
          ))}
        </>
      )}
    </Section>
  );
};

const VariationsSection = ({ n, f, set }: { n: number; f: FormState; set: SetFn }) => {
  const upd = (i: number, k: keyof VariationRow, v: string) =>
    set("variations", f.variations.map((r, j) => (j === i ? { ...r, [k]: v, ...(k === "price" && (!r.webPrice || r.webPrice === suggestWeb(r.price)) ? { webPrice: suggestWeb(v) } : {}) } : r)));
  const web = f.toWebsite;
  const cols = [
    "minmax(110px,1.2fr)", "minmax(110px,1.2fr)", "84px", "84px",
    ...(web && f.onSale ? ["84px"] : []), "64px", ...(web ? ["78px"] : []), "100px", "84px", "40px",
  ].join(" ");
  const ebayProfit = (v: VariationRow) => {
    const pr = num(v.price);
    return pr > 0 ? pr - fee("ebay", pr) - num(f.costPrice) - num(f.postageCost) : null;
  };
  return (
    <Section n={n} title="Variations" badge={f.hasVariations && f.variations.length ? `${f.variations.length} options` : undefined}>
      <div className="lt-checks" style={{ marginTop: 0 }}>
        <label>
          <input
            type="checkbox"
            checked={f.hasVariations}
            onChange={(e) => {
              set("hasVariations", e.target.checked);
              if (e.target.checked && !f.variations.length) {
                const base = { ...emptyVar(), price: f.price, webPrice: f.webPrice || suggestWeb(f.price) };
                set("variations", [{ ...base }, { ...base }]);
              }
            }}
          />{" "}
          This item comes in options (colours, sizes, weights)
        </label>
      </div>
      {f.hasVariations && (
        <>
          <div className="fld" style={{ maxWidth: 260 }}>
            <label>Options are called</label>
            <input value={f.variationName} onChange={(e) => set("variationName", e.target.value)} placeholder="Colour, Size, Weight…" />
          </div>
          <div className="cl-vars">
            <div className="cl-var head" style={{ gridTemplateColumns: cols }}>
              <span>{f.variationName || "Option"}</span><span>SKU</span><span>eBay price</span><span>Website</span>
              {web && f.onSale && <span>Sale</span>}<span>Stock</span>{web && <span>Weight kg</span>}<span>Photo</span><span>eBay profit</span><span />
            </div>
            {f.variations.map((v, i) => (
              <div className="cl-var" key={i} style={{ gridTemplateColumns: cols }}>
                <input value={v.value} onChange={(e) => upd(i, "value", e.target.value)} placeholder="e.g. Perch" />
                <input value={v.sku} onChange={(e) => upd(i, "sku", e.target.value)} placeholder="Optional" />
                <input inputMode="decimal" value={v.price} onChange={(e) => upd(i, "price", e.target.value)} placeholder="£" />
                <input inputMode="decimal" value={v.webPrice} onChange={(e) => upd(i, "webPrice", e.target.value)} placeholder="£" />
                {web && f.onSale && <input inputMode="decimal" value={v.salePrice ?? ""} onChange={(e) => upd(i, "salePrice", e.target.value)} placeholder="£" aria-label="Website sale price" />}
                <input inputMode="numeric" value={v.stock} onChange={(e) => upd(i, "stock", e.target.value)} />
                {web && <input inputMode="decimal" value={v.weightKg ?? ""} onChange={(e) => upd(i, "weightKg", e.target.value)} placeholder={f.weightKg || "kg"} aria-label="Weight in kg" />}
                <select value={v.photo} onChange={(e) => upd(i, "photo", e.target.value)}>
                  <option value="">None</option>
                  {f.photos.map((_, j) => <option key={j} value={String(j)}>Photo {j + 1}</option>)}
                </select>
                {(() => {
                  const pf = ebayProfit(v);
                  return <span className={`cl-vprofit${pf !== null && pf < 0 ? " neg" : ""}`}>{pf === null ? "-" : gbp(pf)}</span>;
                })()}
                <button className="btn ghost" aria-label="Remove option" onClick={() => set("variations", f.variations.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
          <button className="btn ghost" onClick={() => set("variations", [...f.variations, { ...emptyVar(), price: f.variations.at(-1)?.price ?? "", webPrice: f.variations.at(-1)?.webPrice ?? "" }])}>+ Add option</button>
          <div className="note" style={{ marginBottom: 0 }}>
            Leave SKU blank and SyncStock makes one. A photo picked here shows when a buyer picks that option{f.toEbay && web ? " on eBay and the website" : ""}.{web ? " Leave an option's weight blank to use the weight in the Website section." : ""}
          </div>
        </>
      )}
    </Section>
  );
};

const WebsiteSection = ({ n, f, set, setup }: { n: number; f: FormState; set: SetFn; setup?: Setup }) => {
  const tagsQ = useQuery({
    queryKey: ["website-tags"],
    queryFn: async () => (await cl<{ tags: { tag: string; count: number }[] }>({ action: "website_tags" })).tags,
    staleTime: 60 * 60 * 1000,
  });
  const [tagText, setTagText] = useState("");
  const have = new Set(f.tags.map((t) => t.toLowerCase()));
  const addTags = (raw: string) => {
    const next = [...f.tags];
    for (const t of raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) if (!next.includes(t)) next.push(t);
    set("tags", next.slice(0, 100));
    setTagText("");
  };
  // Suggest tags you already use that match words in the title, brand, options or eBay category.
  const words = ` ${[f.title, f.webTitle, f.brand, f.category?.name ?? "", ...f.variations.map((v) => v.value)].join(" ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  const all = tagsQ.data ?? [];
  const suggested = all.filter((t) => !have.has(t.tag) && words.includes(` ${t.tag} `)).slice(0, 14);
  const common = all.filter((t) => !have.has(t.tag) && !suggested.includes(t)).slice(0, 8);
  const typed = tagText.trim().toLowerCase();
  const matches = typed ? all.filter((t) => !have.has(t.tag) && t.tag.includes(typed)).slice(0, 8) : [];
  const price = num(f.webPrice) || num(f.price);
  const slugPreview = (f.urlSlug || f.webTitle || f.headline || f.title).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const page = setup?.storePages.find((p) => p.id === f.storePageId);

  return (
    <Section n={n} title="Website" badge={f.tags.length ? `${f.tags.length} tags` : undefined}>
      <div className="cl-row-title">
        <div className="fld">
          <label>Shop page</label>
          <select value={f.storePageId} onChange={(e) => set("storePageId", e.target.value)}>
            <option value="">Choose…</option>
            {(setup?.storePages ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.title}{p.enabled ? "" : " (hidden page)"}</option>
            ))}
          </select>
        </div>
        <div className="lt-checks" style={{ alignSelf: "end", marginBottom: 22 }}>
          <label><input type="checkbox" checked={f.websiteVisible} onChange={(e) => set("websiteVisible", e.target.checked)} /> Show it on the website straight away</label>
        </div>
      </div>

      <div className="fld">
        <label>Website title <span className="cl-count">{f.webTitle ? `${f.webTitle.length} / 200` : "Same as the description heading if left blank"}</span></label>
        <input value={f.webTitle} onChange={(e) => set("webTitle", e.target.value)} placeholder={f.headline || f.title || "Product name on the website"} />
      </div>

      <div className="lt-sub" style={{ marginTop: 6 }}>Tags</div>
      <div className="cl-tags">
        {f.tags.map((t) => (
          <span key={t} className="cl-tag">
            {t}
            <button aria-label={`Remove ${t}`} onClick={() => set("tags", f.tags.filter((x) => x !== t))}>×</button>
          </span>
        ))}
        <input
          value={tagText}
          onChange={(e) => {
            if (e.target.value.includes(",")) addTags(e.target.value);
            else setTagText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagText.trim()) { e.preventDefault(); addTags(tagText); }
            if (e.key === "Backspace" && !tagText && f.tags.length) set("tags", f.tags.slice(0, -1));
          }}
          placeholder={f.tags.length ? "Add another…" : "Type a tag and press Enter"}
        />
      </div>
      {matches.length > 0 && (
        <div className="cl-sugg"><span>Matching:</span>{matches.map((t) => <button key={t.tag} onClick={() => addTags(t.tag)}>+ {t.tag}</button>)}</div>
      )}
      {tagsQ.isLoading ? (
        <div className="note" style={{ marginTop: 6 }}>Loading the tags your website uses…</div>
      ) : tagsQ.isError ? (
        <div className="note" style={{ marginTop: 6 }}>Couldn't load your website's tags. You can still type them in.</div>
      ) : (
        <>
          {suggested.length > 0 && (
            <div className="cl-sugg">
              <span>Suggested:</span>
              {suggested.map((t) => <button key={t.tag} onClick={() => addTags(t.tag)}>+ {t.tag}</button>)}
              {suggested.length > 1 && <button className="all" onClick={() => addTags(suggested.map((t) => t.tag).join(","))}>Add all</button>}
            </div>
          )}
          {common.length > 0 && (
            <div className="cl-sugg"><span>You often use:</span>{common.map((t) => <button key={t.tag} onClick={() => addTags(t.tag)}>+ {t.tag}</button>)}</div>
          )}
        </>
      )}

      <div className="cl-row4" style={{ marginTop: 16 }}>
        <div className="fld">
          <label>Weight (kg)</label>
          <input inputMode="decimal" value={f.weightKg} onChange={(e) => set("weightKg", e.target.value)} placeholder="e.g. 0.1" className={num(f.weightKg) > 0 || (f.hasVariations && f.variations.every((v) => num(v.weightKg || "") > 0)) ? "" : "cl-missing"} />
        </div>
        <div className="fld"><label>Length (cm)</label><input inputMode="decimal" value={f.lengthCm} onChange={(e) => set("lengthCm", e.target.value)} placeholder="Optional" /></div>
        <div className="fld"><label>Width (cm)</label><input inputMode="decimal" value={f.widthCm} onChange={(e) => set("widthCm", e.target.value)} placeholder="Optional" /></div>
        <div className="fld"><label>Height (cm)</label><input inputMode="decimal" value={f.heightCm} onChange={(e) => set("heightCm", e.target.value)} placeholder="Optional" /></div>
      </div>
      <div className="note" style={{ marginTop: -6 }}>
        Website postage comes from your Squarespace shipping rules, which use this weight. {f.hasVariations ? "Options can have their own weight in the Variations table. " : ""}
      </div>

      <div className="lt-checks" style={{ marginTop: 14 }}>
        <label><input type="checkbox" checked={f.onSale} onChange={(e) => set("onSale", e.target.checked)} /> On sale on the website</label>
      </div>
      {f.onSale && !f.hasVariations && (
        <div className="fld" style={{ maxWidth: 220 }}>
          <label>Sale price <span className="cl-count">was {price ? gbp(price) : "£"}</span></label>
          <input inputMode="decimal" value={f.salePrice} onChange={(e) => set("salePrice", e.target.value)} placeholder="£" />
        </div>
      )}
      {f.onSale && f.hasVariations && <div className="note" style={{ marginTop: 0 }}>Put each option's sale price in the Variations table.</div>}

      <div className="lt-checks" style={{ marginTop: 14 }}>
        <label><input type="checkbox" checked={f.webSameDesc} onChange={(e) => set("webSameDesc", e.target.checked)} /> Use the same description as eBay</label>
      </div>
      {!f.webSameDesc && (
        <RichEditor
          value={f.webProduct}
          onChange={(v) => set("webProduct", v)}
          label="Website description"
          placeholder="The description for the website. The numbers table is added underneath automatically."
        />
      )}

      <div className="lt-sub" style={{ marginTop: 18 }}>Search engines (optional)</div>
      <div className="fld">
        <label>SEO title <span className={`cl-count${f.seoTitle.length > 60 ? " over" : ""}`}>{f.seoTitle.length} / 60</span></label>
        <input value={f.seoTitle} onChange={(e) => set("seoTitle", e.target.value)} placeholder={f.webTitle || f.headline || f.title} />
      </div>
      <div className="fld">
        <label>SEO description <span className={`cl-count${f.seoDescription.length > 160 ? " over" : ""}`}>{f.seoDescription.length} / 160</span></label>
        <textarea value={f.seoDescription} onChange={(e) => set("seoDescription", e.target.value)} placeholder="One or two sentences shown under the link in Google" />
      </div>
      <div className="fld">
        <label>Web address</label>
        <input value={f.urlSlug} onChange={(e) => set("urlSlug", e.target.value)} placeholder={slugPreview || "made from the title"} />
        <div className="note" style={{ marginTop: 6 }}>Ends in /p/{slugPreview || "…"}{page ? ` on the ${page.title} page` : ""}</div>
      </div>

      <div className="lt-note warn" style={{ marginBottom: 0 }}>
        <b>Finish these in Squarespace:</b> categories, recommended add-ons and related products. Squarespace doesn't let other apps set them. The product
        goes on {f.websiteVisible ? "the website straight away" : "hidden"}, and SyncStock gives you a link to it once it's listed.
      </div>
    </Section>
  );
};

const PreviewPanel = ({ ebayHtml, webHtml, f }: { ebayHtml: string; webHtml: string; f: FormState }) => {
  const [tab, setTab] = useState<"ebay" | "web">("ebay");
  const [phone, setPhone] = useState(false);
  const lowest = (xs: number[]) => (xs.filter((n) => n > 0).length ? Math.min(...xs.filter((n) => n > 0)) : 0);
  const minVar = f.hasVariations ? lowest(f.variations.map((v) => num(v.price))) : num(f.price);
  const minWeb = f.hasVariations ? lowest(f.variations.map((v) => num(v.webPrice) || num(v.price))) : num(f.webPrice) || num(f.price);
  const webDoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;padding:22px;color:#26241f;line-height:1.6;font-size:14px}img{width:100%;border-radius:8px;background:#f1ece3}h1{font-size:22px;margin:16px 0 4px}.p{font-size:18px;font-weight:700;margin-bottom:14px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #e4ddd0;padding:6px 4px}h3{font-size:14px;text-transform:uppercase;letter-spacing:.05em}</style></head><body>${f.photos[0] ? `<img src="${escapeHtml(f.photos[0])}">` : ""}<h1>${escapeHtml(f.webTitle || f.headline || f.title || "Product title")}</h1><div class="p">${minWeb > 0 ? (f.hasVariations ? "From " : "") + (f.onSale && !f.hasVariations && num(f.salePrice) > 0 ? `<s style="opacity:.5;font-weight:500">${gbp(minWeb)}</s> ${gbp(num(f.salePrice))}` : gbp(minWeb)) : ""}</div>${f.tags.length ? `<div style="font-size:11px;color:#7a746a;margin-bottom:12px">Tags: ${escapeHtml(f.tags.join(", "))}</div>` : ""}${webHtml || "<p>Description goes here.</p>"}</body></html>`;
  const stock = f.hasVariations ? f.variations.reduce((s, v) => s + Math.floor(num(v.stock)), 0) : Math.floor(num(f.stock));
  return (
    <>
      <div className="panel">
        <h3>
          Preview
          <div className="seg" style={{ marginLeft: "auto" }}>
            <button className={tab === "ebay" ? "on" : ""} onClick={() => setTab("ebay")}>eBay</button>
            <button className={tab === "web" ? "on" : ""} onClick={() => setTab("web")}>Website</button>
          </div>
          <div className="seg">
            <button className={!phone ? "on" : ""} onClick={() => setPhone(false)}>Desktop</button>
            <button className={phone ? "on" : ""} onClick={() => setPhone(true)}>Phone</button>
          </div>
        </h3>
        <div className="cl-prev">
          <iframe
            title="Preview"
            sandbox=""
            srcDoc={tab === "ebay" ? ebayHtml : webDoc}
            style={phone ? { width: 390, transform: "none" } : undefined}
            className={phone ? "phone" : ""}
          />
        </div>
      </div>
      <div className="panel cl-summary">
        {f.photos[0] ? <img src={f.photos[0]} alt="" /> : <div className="cl-noimg" />}
        <div>
          <b>{minVar > 0 ? `${f.hasVariations ? "From " : ""}${gbp(minVar)}` : "No price yet"} · {stock} in stock</b>
          <small>
            {f.category?.name ?? "No category"}
            {f.hasVariations ? ` · ${f.variations.length} options` : ""} · {f.photos.length} photo{f.photos.length === 1 ? "" : "s"}
          </small>
        </div>
      </div>
    </>
  );
};

const ResultPanel = ({ result, onAnother }: { result: CreateResult; onAnother: () => void }) => (
  <div className="panel" style={{ maxWidth: 760 }}>
    <h3>Listed</h3>
    <div className="mb">
      {result.ebay && (
        <div className="lt-note ok">
          Live on eBay as item {result.ebay.itemId}.{" "}
          <a href={result.ebay.url} target="_blank" rel="noreferrer" className="link">View it on eBay ↗</a>
        </div>
      )}
      {result.website && (
        <div className="lt-note ok">
          Added to the website with {result.website.photosUploaded} photo{result.website.photosUploaded === 1 ? "" : "s"}.{" "}
          {result.website.url && <a href={result.website.url} target="_blank" rel="noreferrer" className="link">Open the product page ↗</a>}{" "}
          <a href="https://www.voyagershook.com/config/commerce/inventory" target="_blank" rel="noreferrer" className="link">Open Squarespace inventory ↗</a>
          <br />Now add the category and any recommended add-ons in Squarespace. If you added it hidden, switch it on when you're happy. Photos can take a minute to appear there.
          {result.website.notes?.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}
        </div>
      )}
      {result.websiteError && <div className="lt-note warn">The website didn't accept it: {result.websiteError}. The eBay listing is fine and saved in SyncStock.</div>}
      <div className={`lt-note ${result.syncstock.problems.length ? "warn" : "ok"}`}>
        Saved in SyncStock as one product with {result.syncstock.variants} option{result.syncstock.variants === 1 ? "" : "s"} and {result.syncstock.links} shop link{result.syncstock.links === 1 ? "" : "s"}. No merge needed.
        {result.syncstock.problems.map((p, i) => <div key={i}>{p}</div>)}
      </div>
      {result.ebay?.warnings?.length ? <div className="note">eBay said: {result.ebay.warnings.join(" ")}</div> : null}
    </div>
    <div className="mf">
      <button className="btn primary" onClick={onAnother}>List another</button>
    </div>
  </div>
);

export default CreateListingPage;
