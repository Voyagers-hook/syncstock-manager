import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useProducts } from "@/hooks/use-products";
import { useReviseTitle } from "@/hooks/use-revise-title";
import { hasSpecials, cleanTitle } from "@/lib/title";
import { toast } from "sonner";

interface Row { itemId: string; productId: string; current: string }

const TitleCleanupPage = () => {
  const { data: products = [], isLoading } = useProducts();
  const revise = useReviseTitle();
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // Only eBay-listed products whose title actually has decorative special characters.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const p of products) {
      if (!hasSpecials(p.name)) continue;
      const eb = p.channel_listings.find((l) => l.channel === "ebay");
      if (!eb) continue;
      const itemId = eb.channel_product_id?.split("|")[1];
      if (!itemId || !/^\d{6,}$/.test(itemId)) continue;
      out.push({ itemId, productId: p.id, current: p.name });
    }
    // de-dup by itemId
    const seen = new Set<string>();
    return out.filter((r) => (seen.has(r.itemId) ? false : (seen.add(r.itemId), true))).sort((a, b) => a.current.localeCompare(b.current));
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.current.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const draftFor = (r: Row) => drafts[r.itemId] ?? cleanTitle(r.current);

  const apply = (r: Row) => {
    const title = draftFor(r).trim();
    if (!title) { toast.error("Title can't be empty."); return; }
    if (title.length > 80) { toast.error("Title must be 80 characters or fewer."); return; }
    setSavingId(r.itemId);
    revise.mutate(
      { itemId: r.itemId, title },
      { onSettled: () => setSavingId(null) },
    );
  };

  return (
    <ConceptLayout
      title="Title cleanup"
      subtitle="Tidy eBay titles for better visibility — removes stray characters, keeps the important ones"
      search={search}
      onSearch={setSearch}
    >
      <div className="thead-wrap">
        <div className="cap">
          <h3>eBay titles with special characters</h3>
          <div className="legend">
            <span>{rows.length} to tidy · edits keep the same listing (ItemID), so stock &amp; merges are untouched</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: "44%" }}>Current title</th>
              <th style={{ width: "44%" }}>Cleaned title (editable)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={3} className="empty">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={3} className="empty">{rows.length === 0 ? "No titles need tidying." : "No titles match."}</td></tr>
            ) : (
              filtered.map((r) => {
                const draft = draftFor(r);
                return (
                  <tr className="vrow" key={r.itemId}>
                    <td style={{ color: "var(--muted)" }}>{r.current}</td>
                    <td>
                      <input
                        value={draft}
                        maxLength={80}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.itemId]: e.target.value }))}
                        style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", fontSize: 13 }}
                      />
                      <div style={{ fontSize: 10.5, color: draft.length > 80 ? "var(--over)" : "var(--muted)", marginTop: 2 }}>{draft.length}/80</div>
                    </td>
                    <td className="num">
                      <button className="btn primary" style={{ padding: "7px 14px" }}
                        disabled={savingId === r.itemId || draft.trim() === r.current.trim()}
                        onClick={() => apply(r)}>
                        {savingId === r.itemId ? "Saving…" : "Update eBay"}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        This edits the live eBay title only (keeping the listing, its stock, merge and history). It
        strips decorative characters like * and stray dashes but keeps meaningful ones — sizes such as
        2-10g, Pop-Up, 0.06mm are preserved. Review each suggestion before applying; titles are capped
        at eBay's 80-character limit.
      </div>
    </ConceptLayout>
  );
};

export default TitleCleanupPage;
