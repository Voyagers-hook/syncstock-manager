import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useSalesReport } from "@/hooks/use-sales";
import { downloadCsv } from "@/lib/csv";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "£0.00" : `£${Number(n).toFixed(2)}`;

function monthFromOffset(offset: number) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const label = d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return { value, label };
}

const SalesPage = () => {
  const [offset, setOffset] = useState(0);
  const { value: month, label } = useMemo(() => monthFromOffset(offset), [offset]);
  const { data: report } = useSalesReport(month);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `sales-${month}`,
      [
        { key: "item", label: "Item" },
        { key: "units", label: "Units" },
        { key: "sales", label: "Sales £" },
        { key: "fees", label: "Fees £" },
        { key: "cogs", label: "Cost of goods £" },
        { key: "profit", label: "Gross profit £" },
        { key: "margin", label: "Margin %" },
      ],
      report.products.map((p) => ({
        item: p.item_name,
        units: p.quantity,
        sales: p.turnover.toFixed(2),
        fees: p.fees.toFixed(2),
        cogs: p.cogs.toFixed(2),
        profit: p.profit.toFixed(2),
        margin: p.turnover ? Math.round((p.profit / p.turnover) * 100) : 0,
      })),
    );
  };

  const r = report;
  const ebayPct = r && r.turnover > 0 ? (r.ebayTurnover / r.turnover) * 100 : 0;
  const sqPct = r && r.turnover > 0 ? (r.sqTurnover / r.turnover) * 100 : 0;

  return (
    <ConceptLayout title="Sales & profit" subtitle="Monthly accounting view" onExport={exportCsv}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
        <div className="seg">
          <button onClick={() => setOffset((o) => o + 1)}>‹</button>
          <button className="on" style={{ minWidth: 150 }}>
            {label}
          </button>
          <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0}>
            ›
          </button>
        </div>
        <div className="net" style={{ marginLeft: "auto" }}>
          <small>Gross profit (before P&amp;P)</small>
          <b>{money(r?.grossBeforePP)}</b>
        </div>
      </div>

      <div className="grid4">
        <div className="card">
          <div className="lbl">Turnover</div>
          <div className="val">{money(r?.turnover)}</div>
        </div>
        <div className="card">
          <div className="lbl">eBay fees</div>
          <div className="val" style={{ color: "#be123c" }}>
            -{money(r?.ebayFees)}
          </div>
          <span className="trend flat">on {money(r?.ebayTurnover)} sales</span>
        </div>
        <div className="card">
          <div className="lbl">Squarespace fees</div>
          <div className="val" style={{ color: "#be123c" }}>
            -{money(r?.sqFees)}
          </div>
          <span className="trend flat">on {money(r?.sqTurnover)} sales</span>
        </div>
        <div className="card">
          <div className="lbl">
            Cost of goods
          </div>
          <div className="val" style={{ color: "#be123c" }}>
            -{money(r?.cogs)}
          </div>
          <span className="trend flat">refunds -{money(r?.refunds)}</span>
        </div>
      </div>

      <div className="panel">
        <h3>
          Sales by platform <span className="per">{label} · {r?.unitsSold ?? 0} units</span>
        </h3>
        <div style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 650 }}>
            <span>
              <span className="tag eb" style={{ padding: "1px 5px" }}>
                eB
              </span>{" "}
              eBay {money(r?.ebayTurnover)}
            </span>
            <span>
              <span className="tag sq" style={{ padding: "1px 5px" }}>
                SQ
              </span>{" "}
              Squarespace {money(r?.sqTurnover)}
            </span>
          </div>
          <div className="splitbar">
            <i style={{ width: `${ebayPct}%`, background: "var(--brand)" }} />
            <i style={{ width: `${sqPct}%`, background: "#111827" }} />
          </div>
        </div>
      </div>

      <div className="thead-wrap">
        <div className="cap">
          <h3>Sales by product — {label}</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: "30%" }}>Item</th>
              <th className="num">Units</th>
              <th className="num">Sales</th>
              <th className="num">Fees</th>
              <th className="num">Cost of goods</th>
              <th className="num">Gross profit</th>
              <th className="num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {!r || r.products.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No sales in this month.
                </td>
              </tr>
            ) : (
              <>
                {r.products.map((p) => (
                  <tr className="vrow" key={p.key}>
                    <td className="pname">
                      <b>{p.item_name}</b>
                    </td>
                    <td className="num">{p.quantity}</td>
                    <td className="num">{money(p.turnover)}</td>
                    <td className="num" style={{ color: "#be123c" }}>
                      -{money(p.fees)}
                    </td>
                    <td className="num" style={{ color: "#be123c" }}>
                      -{money(p.cogs)}
                    </td>
                    <td className="num" style={{ fontWeight: 750, color: "#067a57" }}>
                      {money(p.profit)}
                    </td>
                    <td className="num">
                      {p.turnover ? Math.round((p.profit / p.turnover) * 100) : 0}%
                    </td>
                  </tr>
                ))}
                <tr className="foot-row">
                  <td>Total</td>
                  <td className="num">{r.unitsSold}</td>
                  <td className="num">{money(r.turnover)}</td>
                  <td className="num">-{money(r.totalFees)}</td>
                  <td className="num">-{money(r.cogs)}</td>
                  <td className="num" style={{ color: "#067a57" }}>
                    {money(r.turnover - r.totalFees - r.cogs)}
                  </td>
                  <td className="num">
                    {r.turnover
                      ? Math.round(((r.turnover - r.totalFees - r.cogs) / r.turnover) * 100)
                      : 0}
                    %
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Gross profit is before postage &amp; packaging and uses your stored cost prices. Fees are
        estimated (eBay 12.8% + £0.30, Squarespace 2.9% + £0.30). Export to CSV for accounting.
      </div>
    </ConceptLayout>
  );
};

export default SalesPage;
