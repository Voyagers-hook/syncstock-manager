import { useEffect, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useCatalog, useShopSet, useShopRemove, CatalogItem } from "@/hooks/use-members";
import { toast } from "sonner";

function money(n: number | null | undefined) {
  return n == null ? "—" : `£${Number(n).toFixed(2)}`;
}
// 1 point = 1p, so a £10 item = 1000 points.
function suggested(price: number | null) {
  return price == null ? 0 : Math.round(price * 100);
}

const PointsShopPage = () => {
  const [search, setSearch] = useState("");
  const { data: items = [], isLoading } = useCatalog(search);

  return (
    <ConceptLayout
      title="Points Shop"
      subtitle="Choose which items members can redeem with points and set each one's point value (1 point = 1p)"
      search={search}
      onSearch={setSearch}
    >
      <div className="thead-wrap">
        <div className="cap">
          <h3>{search.trim() ? "Search results" : "Items in the points shop"}</h3>
          <div className="legend" style={{ color: "var(--muted)" }}>
            {search.trim()
              ? "Set a point value and tick Active to add an item to the shop"
              : "Search above to find items to add · stock is shared with your live listings"}
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Price</th>
              <th className="num">Stock</th>
              <th className="num">Points</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="empty">
                {search.trim() ? "No items match." : "No items in the points shop yet — search for one to add it."}
              </td></tr>
            ) : (
              items.map((it) => <ItemRow key={it.variant_id} item={it} />)
            )}
          </tbody>
        </table>
      </div>

      <div className="note">
        Items here share stock with your eBay & Squarespace listings, so a points redemption reduces
        the same stock a sale would. Point value defaults to the item's price in pence (£{(5).toFixed(2)}
        = 500 pts); change it to whatever you want. Untick <b>Active</b> to hide an item from the shop
        without losing its settings, or use <b>Remove</b> to take it out completely.
      </div>
    </ConceptLayout>
  );
};

function ItemRow({ item }: { item: CatalogItem }) {
  const set = useShopSet();
  const remove = useShopRemove();
  const [pts, setPts] = useState<string>(item.points_value != null ? String(item.points_value) : String(suggested(item.price)));
  const [active, setActive] = useState<boolean>(item.active);

  useEffect(() => {
    setPts(item.points_value != null ? String(item.points_value) : String(suggested(item.price)));
    setActive(item.active);
  }, [item.points_value, item.active, item.price]);

  const save = async (nextActive?: boolean) => {
    const n = Math.trunc(Number(pts));
    if (!Number.isFinite(n) || n <= 0) { toast.error("Enter a point value above 0."); return; }
    const a = nextActive ?? active;
    try {
      await set.mutateAsync({ variant_id: item.variant_id, points_value: n, active: a });
      setActive(a);
      toast.success(item.flagged ? "Updated." : "Added to the points shop.");
    } catch (e: any) { toast.error(e?.message ?? "Save failed."); }
  };

  const del = async () => {
    try { await remove.mutateAsync(item.variant_id); toast.success("Removed from the points shop."); }
    catch (e: any) { toast.error(e?.message ?? "Remove failed."); }
  };

  return (
    <tr className="vrow">
      <td>
        <div>{item.product_name}{item.options ? ` — ${item.options}` : ""}</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {item.sku ?? "no sku"}{item.flagged ? " · in shop" : ""}
        </div>
      </td>
      <td className="num">{money(item.price)}</td>
      <td className="num" style={{ color: item.stock > 0 ? undefined : "var(--over)" }}>{item.stock}</td>
      <td className="num">
        <input type="number" min={1} step={1} value={pts} onChange={(e) => setPts(e.target.value)}
          style={{ width: 90, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--line,#334155)", background: "var(--card2,#0f172a)", color: "var(--fg,#f1f5f9)", fontSize: 14, textAlign: "right" }} />
      </td>
      <td>
        <input type="checkbox" checked={active} onChange={(e) => save(e.target.checked)} aria-label="Active in shop" />
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button className="btn primary" style={{ padding: "6px 12px" }} disabled={set.isPending} onClick={() => save()}>
          {item.flagged ? "Save" : "Add"}
        </button>
        {item.flagged && (
          <button className="btn ghost" style={{ padding: "6px 10px", marginLeft: 6 }} disabled={remove.isPending} onClick={del}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

export default PointsShopPage;
