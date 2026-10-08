import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useProducts, useUpdateVariantCost } from "@/hooks/use-products";
import { brandOf } from "@/lib/brand";
import { toast } from "sonner";

interface Row { variantId: string; productId: string; name: string }

const CostPricesPage = () => {
  const { data: products = [], isLoading } = useProducts();
  const updateCost = useUpdateVariantCost();
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // Variants with no cost price on the variant AND none on the product.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const p of products) {
      const productHasCost = typeof p.cost_price === "number" && p.cost_price > 0;
      for (const v of p.variants) {
        const variantHasCost = typeof v.cost_price === "number" && v.cost_price > 0;
        if (!variantHasCost && !productHasCost) {
          const opt = [v.option1, v.option2].filter(Boolean).join(" / ");
          out.push({ variantId: v.id, productId: p.id, name: opt ? `${p.name} — ${opt}` : p.name });
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const save = (r: Row) => {
    const val = parseFloat(drafts[r.variantId] ?? "");
    if (isNaN(val) || val < 0) { toast.error("Enter a valid cost."); return; }
    setSavingId(r.variantId);
    updateCost.mutate(
      { variantId: r.variantId, cost: val },
      {
        onSuccess: () => { toast.success("Cost saved."); setDrafts((d) => { const n = { ...d }; delete n[r.variantId]; return n; }); },
        onError: (e: any) => toast.error(e.message ?? "Could not save."),
        onSettled: () => setSavingId(null),
      },
    );
  };

  return (
    <ConceptLayout
      title="Cost prices"
      subtitle="Fill in what you pay, so profit and margins are accurate"
      search={search}
      onSearch={setSearch}
    >
      <div className="thead-wrap">
        <div className="cap">
          <h3>Items missing a cost price</h3>
          <div className="legend">
            <span>{rows.length} to go · cost feeds profit, margins, dead-stock value and the calculator</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: "60%" }}>Item</th>
              <th className="num">Cost price</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={3} className="empty">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={3} className="empty">{rows.length === 0 ? "Every item has a cost price. Nice." : "No items match."}</td></tr>
            ) : (
              filtered.map((r) => (
                <tr className="vrow" key={r.variantId}>
                  <td>{r.name}</td>
                  <td className="num">
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, position: "relative" }}>
                      <span style={{ position: "absolute", left: 8, color: "var(--muted)", fontSize: 13 }}>£</span>
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={drafts[r.variantId] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.variantId]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && save(r)}
                        placeholder="0.00"
                        style={{ width: 110, textAlign: "right", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px 7px 18px" }}
                      />
                    </div>
                  </td>
                  <td className="num">
                    <button
                      className="btn primary"
                      style={{ padding: "7px 14px" }}
                      disabled={savingId === r.variantId || !(drafts[r.variantId] ?? "").trim()}
                      onClick={() => save(r)}
                    >
                      {savingId === r.variantId ? "Saving…" : "Save"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Only items with no cost price show here, and they drop off the list as you fill them in. You
        can also edit any cost later from the price box on the Inventory page.
      </div>
    </ConceptLayout>
  );
};

export default CostPricesPage;
