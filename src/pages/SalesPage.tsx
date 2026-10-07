import { useMemo, useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useSalesReport } from "@/hooks/use-sales";
import { downloadCsv } from "@/lib/csv";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "£0.00" : `£${Number(n).toFixed(2)}`;

type Mode = "week" | "month" | "year" | "custom";

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Work out the [start,end) range + a label from the chosen mode and offset.
function computeRange(mode: Mode, offset: number, customFrom: string, customTo: string) {
  const now = new Date();
  if (mode === "week") {
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1 - offset * 7);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 7);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: offset === 0 ? "Last 7 days" : `Week of ${start.toLocaleDateString("en-GB")}`,
    };
  }
  if (mode === "year") {
    const y = now.getUTCFullYear() - offset;
    return {
      start: new Date(Date.UTC(y, 0, 1)).toISOString(),
      end: new Date(Date.UTC(y + 1, 0, 1)).toISOString(),
      label: String(y),
    };
  }
  if (mode === "custom") {
    const s = customFrom ? new Date(customFrom + "T00:00:00Z") : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const e = customTo ? new Date(customTo + "T00:00:00Z") : new Date();
    const eInc = new Date(e);
    eInc.setUTCDate(eInc.getUTCDate() + 1); // make 'to' inclusive
    return {
      start: s.toISOString(),
      end: eInc.toISOString(),
      label: `${s.toLocaleDateString("en-GB")} – ${e.toLocaleDateString("en-GB")}`,
    };
  }
  // month
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  return {
    start: d.toISOString(),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
    label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  };
}

const SalesPage = () => {
  const [mode, setMode] = useState<Mode>("month");
  const [offset, setOffset] = useState(0);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const { start, end, label } = useMemo(
    () => computeRange(mode, offset, customFrom, customTo),
    [mode, offset, customFrom, customTo],
  );
  const { data: r } = useSalesReport(start, end);

  const setModeReset = (m: Mode) => {
    setMode(m);
    setOffset(0);
  };

  const exportCsv = () => {
    if (!r) return;
    downloadCsv(
      `sales-${label.replace(/[^a-z0-9]+/gi, "-")}`,
      [
        { key: "item", label: "Item" },
        { key: "units", label: "Units" },
        { key: "sales", label: "Sales £" },
        { key: "fees", label: "Fees £" },
        { key: "cogs", label: "Cost of goods £" },
        { key: "profit", label: "Gross profit £" },
        { key: "margin", label: "Margin %" },
      ],
      r.products.map((p) => ({
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

  const ebayPct = r && r.turnover > 0 ? (r.ebayTurnover / r.turnover) * 100 : 0;
  const sqPct = r && r.turnover > 0 ? (r.sqTurnover / r.turnover) * 100 : 0;
  const steppable = mode === "month" || mode === "week" || mode === "year";

  return (
    <ConceptLayout title="Sales & profit" subtitle="Accounting view" onExport={exportCsv}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        <div className="seg">
          {(["week", "month", "year", "custom"] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setModeReset(m)}>
              {m === "week" ? "Week" : m === "month" ? "Month" : m === "year" ? "Year" : "Custom"}
            </button>
          ))}
        </div>

        {steppable && (
          <div className="seg">
            <button onClick={() => setOffset((o) => o + 1)}>‹</button>
            <button className="on" style={{ minWidth: 150 }}>
              {label}
            </button>
            <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0}>
              ›
            </button>
          </div>
        )}

        {mode === "custom" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", fontSize: 13 }}
            />
            <span style={{ color: "var(--muted)" }}>to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", fontSize: 13 }}
            />
          </div>
        )}

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
          <div className="lbl">Cost of goods</div>
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
                  No sales in this period.
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
                    <td className="num">{p.turnover ? Math.round((p.profit / p.turnover) * 100) : 0}%</td>
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
                    {r.turnover ? Math.round(((r.turnover - r.totalFees - r.cogs) / r.turnover) * 100) : 0}%
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Gross profit is before postage &amp; packaging and uses your stored cost prices. Fees are
        estimated (eBay 10.9% + £0.32 incl. VAT, Squarespace 2% + £0.25). Export to CSV for accounting.
      </div>
    </ConceptLayout>
  );
};

export default SalesPage;
