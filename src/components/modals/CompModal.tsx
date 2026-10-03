import { useCompetitorPrices, useRunCompetitorCheck } from "@/hooks/use-competitor";
import type { CompTarget } from "@/components/inventory/InventoryTable";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;

export default function CompModal({
  target,
  onClose,
}: {
  target: CompTarget | null;
  onClose: () => void;
}) {
  const { data: rows = [], isLoading } = useCompetitorPrices(target?.variantId ?? null);
  const check = useRunCompetitorCheck();
  if (!target) return null;

  const best = rows.length ? rows[0].delivered : null;

  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="mh">
          <span className="x" onClick={onClose}>
            ×
          </span>
          <div className="t">{target.productName}</div>
          <div className="s">What others charge, delivered</div>
        </div>
        <div className="mine">
          <div>
            Your price <span style={{ color: "var(--muted)", fontSize: 12 }}>(free P&amp;P)</span>
          </div>
          <b>{money(target.yourDelivered)}</b>
        </div>
        <div className="clist" style={{ padding: "0 24px 6px" }}>
          {isLoading ? (
            <div className="empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              No competitor prices stored yet. Hit refresh to pull current eBay listings.
            </div>
          ) : (
            rows.map((r) => {
              const bb = r.delivered === best;
              return (
                <div className={`co ${bb ? "best" : ""}`} key={r.id}>
                  <div className="seller">
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                        {r.seller ?? "eBay seller"}
                      </a>
                    ) : (
                      r.seller ?? "eBay seller"
                    )}
                    {bb && <span className="flag">cheapest</span>}
                    <br />
                    <small>item {money(r.item_price)}</small>
                  </div>
                  <div className="pp">
                    + {r.postage ? `${money(r.postage)} P&P` : "free P&P"}
                  </div>
                  <div className="del">{money(r.delivered)}</div>
                </div>
              );
            })
          )}
        </div>
        <div className="mf">
          <button
            className="btn primary"
            style={{ flex: 1 }}
            onClick={() => check.mutate({ variantId: target.variantId, query: target.query })}
            disabled={check.isPending}
          >
            {check.isPending ? "Checking eBay…" : "Refresh from eBay"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
