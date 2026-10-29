import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useProducts } from "@/hooks/use-products";
import { useOrders } from "@/hooks/use-orders";
import { useSellSimilar, SellSimilarResult } from "@/hooks/use-sell-similar";
import { toast } from "sonner";

interface Row {
  itemId: string;
  productId: string;
  name: string;
  stock: number;
  lastSale: string | null; // ISO
  daysSince: number | null; // null = never sold on eBay
}

type Threshold = 30 | 60 | 90;

function itemIdOf(cpid: string | null | undefined): string | null {
  const id = cpid?.split("|")[1];
  return id && /^\d{6,}$/.test(id) ? id : null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const SellSimilarPage = () => {
  const { data: products = [], isLoading } = useProducts();
  const { data: orders = [] } = useOrders();
  const relist = useSellSimilar();

  const [threshold, setThreshold] = useState<Threshold>(30);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, SellSimilarResult>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  // Last eBay sale per tracker product (orders carry the resolved tracker product_id).
  const lastEbaySale = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orders) {
      if ((o.platform ?? "").toLowerCase() !== "ebay") continue;
      if (!o.product_id || !o.ordered_at) continue;
      const cur = m.get(o.product_id);
      if (!cur || o.ordered_at > cur) m.set(o.product_id, o.ordered_at);
    }
    return m;
  }, [orders]);

  // One row per eBay ItemID (variation listings share an ItemID → de-duped).
  const allRows = useMemo(() => {
    const now = Date.now();
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const p of products) {
      const eb = p.channel_listings.find((l) => l.channel === "ebay");
      if (!eb) continue;
      const itemId = itemIdOf(eb.channel_product_id);
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      const last = lastEbaySale.get(p.id) ?? null;
      const daysSince = last ? Math.floor((now - new Date(last).getTime()) / 86400000) : null;
      out.push({ itemId, productId: p.id, name: p.name, stock: p.total_stock, lastSale: last, daysSince });
    }
    return out;
  }, [products, lastEbaySale]);

  // Candidates: in stock, and either never sold on eBay or no eBay sale within the window.
  const stale = useMemo(() => {
    const rows = allRows.filter((r) => r.stock > 0 && (r.daysSince === null || r.daysSince >= threshold));
    // Most stale first: never-sold, then oldest last-sale.
    rows.sort((a, b) => {
      if (a.daysSince === null && b.daysSince === null) return a.name.localeCompare(b.name);
      if (a.daysSince === null) return -1;
      if (b.daysSince === null) return 1;
      return b.daysSince - a.daysSince;
    });
    return rows;
  }, [allRows, threshold]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? stale.filter((r) => r.name.toLowerCase().includes(q) || r.itemId.includes(q)) : stale;
  }, [stale, search]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.itemId));
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) filtered.forEach((r) => n.delete(r.itemId));
      else filtered.forEach((r) => n.add(r.itemId));
      return n;
    });

  const selectedRows = filtered.filter((r) => selected.has(r.itemId));

  const runRelist = async () => {
    setConfirmOpen(false);
    setRunning(true);
    let ok = 0, fail = 0;
    for (const r of selectedRows) {
      setBusyId(r.itemId);
      try {
        const res = await relist.mutateAsync({ itemId: r.itemId });
        setResults((m) => ({ ...m, [r.itemId]: res }));
        if (res.status === "ok") ok++; else fail++;
      } catch (e: any) {
        setResults((m) => ({ ...m, [r.itemId]: { status: "error", error: e?.message ?? "Failed" } }));
        fail++;
      }
    }
    setBusyId(null);
    setRunning(false);
    setSelected(new Set());
    if (ok) toast.success(`${ok} listing${ok === 1 ? "" : "s"} refreshed on eBay.`);
    if (fail) toast.error(`${fail} need${fail === 1 ? "s" : ""} attention — see the Status column.`);
  };

  const retry = async (itemId: string) => {
    setBusyId(itemId);
    try {
      const res = await relist.mutateAsync({ itemId, mode: "relist_only" });
      setResults((m) => ({ ...m, [itemId]: res }));
      if (res.status === "ok") toast.success("Re-listed and re-linked.");
      else toast.error(res.error ?? "Retry failed.");
    } catch (e: any) {
      setResults((m) => ({ ...m, [itemId]: { status: "error", error: e?.message ?? "Failed" } }));
    }
    setBusyId(null);
  };

  const statusCell = (r: Row) => {
    const res = results[r.itemId];
    if (busyId === r.itemId) return <span style={{ color: "var(--muted)" }}>Working…</span>;
    if (!res) return <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>;
    if (res.status === "ok")
      return <span className="badge" style={{ color: "var(--ok, #16a34a)" }}>Refreshed → {res.newItemId}</span>;
    if (res.status === "ended_not_relisted")
      return (
        <span style={{ fontSize: 12, color: "var(--over)" }}>
          Ended, relist failed —{" "}
          <button className="btn ghost" style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => retry(r.itemId)}>Retry relist</button>
        </span>
      );
    return <span style={{ fontSize: 12, color: "var(--over)" }}>{res.error ?? "Failed"}</span>;
  };

  return (
    <ConceptLayout
      title="Sell Similar"
      subtitle="Refresh stale eBay listings to win back the 30-day visibility boost — keeps stock, merge & history"
      search={search}
      onSearch={setSearch}
    >
      <div className="thead-wrap">
        <div className="cap">
          <h3>Listings with no recent eBay sales</h3>
          <div className="legend" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span>No eBay sale in</span>
            <div className="seg">
              {([30, 60, 90] as Threshold[]).map((t) => (
                <button key={t} className={threshold === t ? "on" : ""} onClick={() => { setThreshold(t); }}>{t}d+</button>
              ))}
            </div>
            <span>{stale.length} candidate{stale.length === 1 ? "" : "s"} (in stock)</span>
            <div style={{ flex: 1 }} />
            <button
              className="btn primary"
              style={{ padding: "8px 16px" }}
              disabled={running || selected.size === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {running ? "Relisting…" : `Relist selected (${selected.size})`}
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th>Listing</th>
              <th className="num">Stock</th>
              <th className="num">Last eBay sale</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="empty">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} className="empty">{stale.length === 0 ? "No stale listings — every in-stock eBay item has sold inside the window." : "No listings match."}</td></tr>
            ) : (
              filtered.map((r) => (
                <tr className="vrow" key={r.itemId}>
                  <td>
                    <input type="checkbox" checked={selected.has(r.itemId)} onChange={() => toggle(r.itemId)} aria-label={`Select ${r.name}`} />
                  </td>
                  <td>
                    <div>{r.name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>ItemID {r.itemId}</div>
                  </td>
                  <td className="num">{r.stock}</td>
                  <td className="num">
                    {r.daysSince === null
                      ? <span style={{ color: "var(--over)" }}>Never</span>
                      : <span>{fmtDate(r.lastSale)}<br /><span style={{ fontSize: 11, color: "var(--muted)" }}>{r.daysSince}d ago</span></span>}
                  </td>
                  <td>{statusCell(r)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="note">
        Re-listing refreshes eBay's 30-day push. It ends the old listing and creates a faithful
        copy (new ItemID) — SyncStock re-links the new ItemID onto the same tracker product, so your
        Squarespace merge, shared stock, cost and sales history stay intact and nothing needs
        re-merging. Pick a few, try them, and check they come back up before doing more. If a relist
        ever fails after the old listing has ended, the item isn't deleted (eBay keeps it for 90 days)
        — use "Retry relist" on that row.
      </div>

      {confirmOpen && (
        <div className="overlay show" onClick={(e) => e.target === e.currentTarget && setConfirmOpen(false)}>
          <div className="modal" style={{ width: 560 }}>
            <div className="mh">
              <span className="x" onClick={() => setConfirmOpen(false)}>×</span>
              <div className="t">Relist {selectedRows.length} listing{selectedRows.length === 1 ? "" : "s"}?</div>
              <div className="s">Each one is ended on eBay and re-listed as a fresh copy (new ItemID). Stock, merge and history carry over automatically.</div>
            </div>
            <div style={{ maxHeight: "48vh", overflowY: "auto", padding: "4px 2px" }}>
              <table>
                <tbody>
                  {selectedRows.map((r) => (
                    <tr className="vrow" key={r.itemId}>
                      <td>{r.name}</td>
                      <td className="num" style={{ color: "var(--muted)", fontSize: 12 }}>
                        {r.daysSince === null ? "Never sold" : `${r.daysSince}d since sale`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mf">
              <button className="btn primary" style={{ flex: 1 }} onClick={runRelist}>Relist {selectedRows.length}</button>
              <button className="btn ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </ConceptLayout>
  );
};

export default SellSimilarPage;
