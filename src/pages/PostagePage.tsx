import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { usePostage, CarrierSummary } from "@/hooks/use-postage";

function isoStart(d: string) { return `${d}T00:00:00.000Z`; }
function isoEndExclusive(d: string) {
  const dt = new Date(`${d}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString();
}
function firstOfMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function today(): string { return new Date().toISOString().slice(0, 10); }
const money = (n: number) => `£${(n ?? 0).toFixed(2)}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

const CARRIER_LABEL: Record<string, string> = {
  ebay: "eBay labels",
  sendcloud: "SendCloud",
  parcel2go: "Parcel2Go",
  dpd: "DPD",
};

const PostagePage = () => {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, isError, error } = usePostage(isoStart(from), isoEndExclusive(to));

  const ebay = data?.carriers.ebay;
  const others = useMemo(
    () => (data ? (["sendcloud", "parcel2go", "dpd"] as const).map((k) => ({ key: k, c: data.carriers[k] })) : []),
    [data],
  );

  return (
    <ConceptLayout
      title="Postage"
      subtitle="Exact postage spend by provider — eBay pulled live, other carriers as they're connected"
    >
      <div className="thead-wrap">
        <div className="cap">
          <h3>Postage spend</h3>
          <div className="legend" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              style={{ padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 7, fontSize: 13 }} />
            <span>to</span>
            <input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)}
              style={{ padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 7, fontSize: 13 }} />
            <div style={{ flex: 1 }} />
            {data && <span style={{ fontWeight: 600 }}>Total: {money(data.grandTotal)}</span>}
          </div>
        </div>

        {isLoading ? (
          <div className="empty" style={{ padding: 30 }}>Loading postage…</div>
        ) : isError ? (
          <div className="note" style={{ color: "var(--over)" }}>{(error as Error).message}</div>
        ) : (
          <div style={{ padding: "6px 2px" }}>
            {/* Provider tiles */}
            <div className="grid4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
              <ProviderTile name={CARRIER_LABEL.ebay} c={ebay} connected />
              {others.map(({ key, c }) => <ProviderTile key={key} name={CARRIER_LABEL[key]} c={c} />)}
            </div>

            {/* eBay label detail */}
            {ebay && ebay.count ? (
              <div className="card" style={{ padding: 0 }}>
                <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
                  <b>eBay shipping labels — {ebay.count} label{ebay.count === 1 ? "" : "s"}, {money(ebay.total)}</b>
                  <div style={{ flex: 1 }} />
                  <a href="https://www.ebay.co.uk/sh/fin/report" target="_blank" rel="noreferrer" className="btn ghost" style={{ padding: "5px 11px", fontSize: 12 }}>eBay invoices ↗</a>
                  <button className="btn ghost" style={{ padding: "5px 11px", fontSize: 12, marginLeft: 8 }} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "Hide" : "Show"} labels
                  </button>
                </div>
                {expanded && (
                  <table>
                    <thead><tr><th>Date</th><th>Order</th><th className="num">Cost</th></tr></thead>
                    <tbody>
                      {ebay.items!.map((it, i) => (
                        <tr className="vrow" key={i}>
                          <td>{fmtDate(it.date)}</td>
                          <td style={{ fontSize: 12, color: "var(--muted)" }}>{it.reference}</td>
                          <td className="num">{money(it.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="note">
        eBay label spend is pulled straight from eBay's finance records for the dates above, so it's
        exact. SendCloud, Parcel2Go and DPD show once their API keys are added — each will list its
        spend and a link to the invoices the same way. The "eBay invoices" button opens your eBay
        payments reports, where the official monthly statements live.
      </div>
    </ConceptLayout>
  );
};

const ProviderTile = ({ name, c, connected }: { name: string; c?: CarrierSummary; connected?: boolean }) => {
  const live = connected && c?.connected;
  return (
    <div className="card" style={{ padding: "14px 16px", opacity: live ? 1 : 0.62 }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{name}</div>
      {live ? (
        <>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{money(c!.total)}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{c!.count ?? 0} label{(c!.count ?? 0) === 1 ? "" : "s"}</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--muted)" }}>Not connected</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>Needs API key</div>
        </>
      )}
    </div>
  );
};

export default PostagePage;
