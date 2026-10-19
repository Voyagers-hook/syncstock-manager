import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ConceptLayout from "@/components/ConceptLayout";
import { useProducts } from "@/hooks/use-products";
import { supabase } from "@/integrations/supabase/client";
import { buildListing, parseListing, type SpecRow } from "@/lib/listing-converter";
import { toast } from "sonner";

// One row per eBay listing (multi-variation listings share one item number).
interface EbayItem {
  itemId: string;
  name: string;
  stock: number;
  onSquarespace: boolean;
}

interface ConvertStatus {
  converted_at: string;
  restored: boolean;
}

type Filter = "todo" | "done" | "ended" | "all";

function itemIdOf(channelProductId: string | null, sku: string | null): string | null {
  const fromId = channelProductId?.split("|")[1];
  if (fromId && /^\d{9,}$/.test(fromId)) return fromId;
  if (sku && /^\d{9,}$/.test(sku)) return sku;
  return null;
}

async function callFn<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("listing-template", { body });
  if (error) {
    // Edge function errors carry our message in the response body.
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

const ListingTemplatesPage = () => {
  const qc = useQueryClient();
  const { data: products = [], isLoading } = useProducts();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("todo");
  const [selected, setSelected] = useState<EbayItem | null>(null);

  const statusQ = useQuery({
    queryKey: ["listing-template-status"],
    queryFn: async () => (await callFn<{ items: Record<string, ConvertStatus> }>({ action: "status" })).items,
  });
  const status = statusQ.data ?? {};

  // Live eBay item numbers. Anything SyncStock knows about that isn't live has ended.
  const activeQ = useQuery({
    queryKey: ["listing-template-active"],
    queryFn: async () => new Set((await callFn<{ itemIds: string[] }>({ action: "active" })).itemIds),
    staleTime: 5 * 60 * 1000,
  });
  const active = activeQ.data;
  const isEnded = (id: string) => !!active && !active.has(id);

  const items = useMemo(() => {
    const map = new Map<string, EbayItem>();
    for (const p of products) {
      for (const l of p.channel_listings) {
        if (l.channel !== "ebay") continue;
        const id = itemIdOf(l.channel_product_id, l.channel_sku);
        if (id && !map.has(id)) {
          map.set(id, {
            itemId: id,
            name: p.name,
            stock: p.total_stock ?? 0,
            onSquarespace: p.channel_listings.some((c) => c.channel === "squarespace"),
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  const isDone = (id: string) => !!status[id] && !status[id].restored;
  const liveItems = items.filter((i) => !isEnded(i.itemId));
  const doneCount = liveItems.filter((i) => isDone(i.itemId)).length;
  const endedCount = items.length - liveItems.length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      const ended = isEnded(i.itemId);
      if (filter === "todo" && (ended || isDone(i.itemId))) return false;
      if (filter === "done" && (ended || !isDone(i.itemId))) return false;
      if (filter === "ended" && !ended) return false;
      return !q || i.name.toLowerCase().includes(q) || i.itemId.includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, filter, status, active]);

  return (
    <ConceptLayout
      title="Listing templates"
      subtitle="Move eBay listings onto the new description template, one at a time"
      search={search}
      onSearch={setSearch}
    >
      <div className="lt-wrap">
        <div className="lt-grid">
          <div className="thead-wrap lt-list">
            <div className="cap">
              <h3>eBay listings</h3>
              <div className="seg">
                {(["todo", "done", "ended", "all"] as Filter[]).map((f) => (
                  <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                    {f === "todo" ? "To do" : f === "done" ? "Done" : f === "ended" ? `Ended${endedCount ? ` (${endedCount})` : ""}` : "All"}
                  </button>
                ))}
              </div>
            </div>
            <div className="lt-progress">
              <span>
                <b>{doneCount}</b> of {liveItems.length} live listings on the new template
              </span>
              <div className="splitbar" style={{ marginTop: 8 }}>
                <i style={{ width: liveItems.length ? `${(doneCount / liveItems.length) * 100}%` : 0, background: "var(--brand)" }} />
              </div>
              {activeQ.isError && <div style={{ marginTop: 6, color: "var(--low)" }}>Couldn't check which listings have ended.</div>}
            </div>
            <div className="lt-scroll">
              {isLoading ? (
                <div className="empty">Loading listings…</div>
              ) : visible.length === 0 ? (
                <div className="empty">
                  {filter === "ended"
                    ? activeQ.isLoading ? "Checking eBay for ended listings…" : "No ended listings."
                    : filter === "todo" && items.length ? "Every live listing is on the new template." : "No listings match."}
                </div>
              ) : (
                visible.map((i) => (
                  <button
                    key={i.itemId}
                    className={`lt-item${selected?.itemId === i.itemId ? " sel" : ""}`}
                    onClick={() => setSelected(i)}
                  >
                    <span className="nm">{i.name}</span>
                    <span className="meta">
                      {i.itemId}
                      {isEnded(i.itemId) ? (
                        <span className="pill out" style={{ marginLeft: 8, padding: "2px 8px" }}>Ended</span>
                      ) : isDone(i.itemId) && <span className="badge on" style={{ marginLeft: 8 }}>Done</span>}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="lt-editor">
            {selected && isEnded(selected.itemId) ? (
              <EndedPanel
                key={selected.itemId}
                item={selected}
                onRemoved={() => {
                  setSelected(null);
                  qc.invalidateQueries({ queryKey: ["products"] });
                }}
              />
            ) : selected ? (
              <Editor
                key={selected.itemId}
                item={selected}
                status={status[selected.itemId]}
                onChanged={() => qc.invalidateQueries({ queryKey: ["listing-template-status"] })}
              />
            ) : (
              <div className="panel">
                <div className="empty" style={{ padding: "60px 30px" }}>
                  <b style={{ color: "var(--ink)", fontSize: 15 }}>Pick a listing on the left</b>
                  <br />
                  SyncStock loads its current description from eBay and converts it. You check it, then send it.
                  Nothing changes on eBay until you press Send.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </ConceptLayout>
  );
};

const EndedPanel = ({ item, onRemoved }: { item: EbayItem; onRemoved: () => void }) => {
  const [alsoSq, setAlsoSq] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const r = await callFn<{ removed: string[]; squarespaceDeleted: string[] }>({
        action: "remove",
        itemId: item.itemId,
        deleteSquarespace: alsoSq,
      });
      toast.success(
        r.squarespaceDeleted?.length
          ? "Removed from SyncStock and deleted from Squarespace."
          : "Removed from SyncStock.",
      );
      onRemoved();
    } catch (err) {
      toast.error((err as Error).message || "Couldn't remove this listing.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <div className="panel lt-ed">
      <h3>
        <span className="lt-ttl">{item.name}</span>
        <a className="per link" href={`https://www.ebay.co.uk/itm/${item.itemId}`} target="_blank" rel="noreferrer">View on eBay ↗</a>
      </h3>
      <div className="mb">
        <div className="lt-note warn">
          This listing has ended on eBay, so its description can't be changed. Decide whether to restock it or remove it.
        </div>
        <div className="lt-ended-facts">
          <div><span>eBay item</span><b>{item.itemId}</b></div>
          <div><span>Stock in SyncStock</span><b>{item.stock}</b></div>
          <div><span>On your website</span><b>{item.onSquarespace ? "Yes" : "No"}</b></div>
        </div>
        <div className="lt-sub" style={{ marginTop: 18 }}>Restock it</div>
        <p className="note" style={{ marginTop: 0 }}>
          Reorder from your supplier, then relist it from eBay's Seller Hub (Unsold &rarr; Relist). eBay gives it a new item
          number, so run a Quick Sync afterwards to pick it up.
        </p>
        <div className="lt-sub" style={{ marginTop: 18 }}>Remove it</div>
        <p className="note" style={{ marginTop: 0 }}>
          Deletes the product from SyncStock with its stock, eBay and website links and competitor prices. Past orders stay in
          your sales history.
        </p>
        {item.onSquarespace && (
          <div className="lt-checks">
            <label>
              <input type="checkbox" checked={alsoSq} onChange={(e) => setAlsoSq(e.target.checked)} /> Also delete it from the
              Squarespace website
            </label>
          </div>
        )}
      </div>
      <div className="mf" style={{ flexWrap: "wrap", alignItems: "center" }}>
        {confirm ? (
          <>
            <span className="lt-confirm">
              {alsoSq ? "Remove from SyncStock and delete it from your website? This can't be undone." : "Remove this product from SyncStock? This can't be undone."}
            </span>
            <button className="btn primary" style={{ background: "var(--out)" }} disabled={busy} onClick={remove}>
              {busy ? "Removing…" : "Yes, remove it"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn ghost" style={{ color: "var(--out)", borderColor: "#fecdd6" }} onClick={() => setConfirm(true)}>
            Remove product
          </button>
        )}
      </div>
    </div>
  );
};

interface EditorProps {
  item: EbayItem;
  status?: ConvertStatus;
  onChanged: () => void;
}

const Editor = ({ item, status, onChanged }: EditorProps) => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; kind: "ok" | "warn" } | null>(null);
  const [url, setUrl] = useState<string>(`https://www.ebay.co.uk/itm/${item.itemId}`);
  const [title, setTitle] = useState("");
  const [condition, setCondition] = useState("Brand new");
  const [free, setFree] = useState(true);
  const [showSpecs, setShowSpecs] = useState(true);
  const [hideRepeats, setHideRepeats] = useState(true);
  const [product, setProduct] = useState("");
  const [specs, setSpecs] = useState<SpecRow[]>([]);
  const [canConvert, setCanConvert] = useState(false);
  const [view, setView] = useState<"desk" | "phone">("desk");
  const [confirm, setConfirm] = useState<"send" | "restore" | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    setConfirm(null);
    try {
      const d = await callFn<{ title: string; description: string; condition: string; url: string }>({
        action: "get",
        itemId: item.itemId,
      });
      setUrl(d.url || url);
      const r = parseListing(d.description);
      setCanConvert(r.ok);
      setNote({ text: r.note, kind: r.ok ? "ok" : "warn" });
      setTitle(r.title || d.title || item.name);
      setCondition(r.condition || (d.condition && !/^new$/i.test(d.condition) ? d.condition : "Brand new"));
      setFree(r.free);
      setProduct(r.product);
      setSpecs(r.specs);
    } catch (err) {
      const e = err as Error;
      setLoadError(e.message || "Couldn't load this listing from eBay.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.itemId]);

  const html = useMemo(
    () => buildListing({ title, condition, free, showSpecs, hideRepeats, product, specs }),
    [title, condition, free, showSpecs, hideRepeats, product, specs],
  );

  const send = async () => {
    setBusy(true);
    try {
      const r = await callFn<{ warnings: string[] }>({ action: "send", itemId: item.itemId, html });
      toast.success("Sent to eBay. The old description is backed up.");
      if (r.warnings?.length) toast.message("eBay said: " + r.warnings.join(" "));
      setLastSent(new Date().toLocaleTimeString());
      onChanged();
    } catch (err) {
      const e = err as Error;
      toast.error(e.message || "eBay didn't accept the update.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await callFn({ action: "restore", itemId: item.itemId });
      toast.success("Old description put back on eBay.");
      setLastSent(null);
      onChanged();
      await load();
    } catch (err) {
      const e = err as Error;
      toast.error(e.message || "Couldn't restore the old description.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const setSpec = (i: number, col: 0 | 1, v: string) =>
    setSpecs((rows) => rows.map((r, j) => (j === i ? ((col === 0 ? [v, r[1]] : [r[0], v]) as SpecRow) : r)));

  const done = (!!status && !status.restored) || !!lastSent;

  if (loading) {
    return <div className="panel"><div className="empty" style={{ padding: 50 }}>Loading the listing from eBay…</div></div>;
  }
  if (loadError) {
    return (
      <div className="panel">
        <div className="empty" style={{ padding: 40 }}>
          <b style={{ color: "var(--out)" }}>{loadError}</b>
          <br />
          <button className="btn ghost" style={{ marginTop: 14 }} onClick={load}>Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel lt-ed">
      <h3>
        <span className="lt-ttl">{item.name}</span>
        <a className="per link" href={url} target="_blank" rel="noreferrer">View on eBay ↗</a>
      </h3>
      <div className="mb">
        {note && <div className={`lt-note ${note.kind}`}>{note.text}</div>}
        {done && (
          <div className="lt-note ok">
            {lastSent ? `Sent to eBay at ${lastSent}.` : `Converted ${new Date(status!.converted_at).toLocaleDateString("en-GB")}.`} You can
            put the old description back with Restore.
          </div>
        )}

        {canConvert && (
          <>
            <div className="lt-fields">
              <div className="fld">
                <label htmlFor="lt-title">Title</label>
                <input id="lt-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="lt-cond">Condition</label>
                <input id="lt-cond" value={condition} onChange={(e) => setCondition(e.target.value)} />
              </div>
            </div>
            <div className="lt-checks">
              <label><input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} /> Free delivery on this item</label>
              <label><input type="checkbox" checked={showSpecs} onChange={(e) => setShowSpecs(e.target.checked)} /> Show the numbers (spec table)</label>
              <label><input type="checkbox" checked={hideRepeats} onChange={(e) => setHideRepeats(e.target.checked)} /> Hide features that repeat the numbers</label>
            </div>

            {showSpecs && (
              <div className="lt-specs">
                <div className="lt-sub">The numbers</div>
                {specs.map((r, i) => (
                  <div className="lt-spec" key={i}>
                    <input aria-label="Label" value={r[0]} onChange={(e) => setSpec(i, 0, e.target.value)} placeholder="Label" />
                    <input aria-label="Value" value={r[1]} onChange={(e) => setSpec(i, 1, e.target.value)} placeholder="Value" />
                    <button className="btn ghost" aria-label="Remove row" onClick={() => setSpecs((rows) => rows.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                <button className="btn ghost" onClick={() => setSpecs((rows) => [...rows, ["", ""]])}>+ Add row</button>
                {!specs.some((r) => /^brand$/i.test(r[0])) && (
                  <div className="note" style={{ marginTop: 8 }}>Brand is added automatically from the first word of the title.</div>
                )}
              </div>
            )}

            <div className="lt-prevhead">
              <div className="lt-sub">Preview</div>
              <div className="seg">
                <button className={view === "desk" ? "on" : ""} onClick={() => setView("desk")}>Desktop</button>
                <button className={view === "phone" ? "on" : ""} onClick={() => setView("phone")}>Phone</button>
              </div>
            </div>
            <div className="lt-frame">
              <iframe title="Listing preview" sandbox="" srcDoc={html} style={{ width: view === "phone" ? 390 : "100%" }} />
            </div>
          </>
        )}
      </div>

      <div className="mf" style={{ flexWrap: "wrap", alignItems: "center" }}>
        {confirm === "send" ? (
          <>
            <span className="lt-confirm">Replace the description on eBay? The current one is backed up first.</span>
            <button className="btn primary" disabled={busy} onClick={send}>{busy ? "Sending…" : "Yes, send it"}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </>
        ) : confirm === "restore" ? (
          <>
            <span className="lt-confirm">Put the previous description back on eBay?</span>
            <button className="btn primary" disabled={busy} onClick={restore}>{busy ? "Restoring…" : "Yes, restore"}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn primary" disabled={!canConvert || busy} onClick={() => setConfirm("send")}>Send to eBay</button>
            {done && <button className="btn ghost" disabled={busy} onClick={() => setConfirm("restore")}>Restore old description</button>}
            <button className="btn ghost" disabled={busy} onClick={load} style={{ marginLeft: "auto" }}>Reload from eBay</button>
          </>
        )}
      </div>
    </div>
  );
};

export default ListingTemplatesPage;
