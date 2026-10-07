import { useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";

const money = (n: number) => `£${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (s: string) => {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

// Small labelled money input with a £ prefix.
function MoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (s: string) => void }) {
  return (
    <div className="fld">
      <label>{label}</label>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 11, top: 10, color: "var(--muted)" }}>£</span>
        <input type="number" step="0.01" min={0} value={value} onChange={(e) => onChange(e.target.value)} style={{ paddingLeft: 22 }} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 650 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 820, marginTop: 4, color: tone === "pos" ? "#067a57" : tone === "neg" ? "var(--over)" : "var(--ink)" }}>{value}</div>
    </div>
  );
}

// A full profit calculator for one channel.
function ChannelCalc({ title, defPct, defFixed, accent }: { title: string; defPct: string; defFixed: string; accent: string }) {
  const [cost, setCost] = useState("");
  const [postage, setPostage] = useState("");
  const [price, setPrice] = useState("");
  const [feePct, setFeePct] = useState(defPct);
  const [feeFixed, setFeeFixed] = useState(defFixed);

  const p = num(price);
  const fee = p > 0 ? p * (num(feePct) / 100) + num(feeFixed) : 0;
  const totalCosts = num(cost) + num(postage) + fee;
  const profit = p - totalCosts;
  const margin = p > 0 ? (profit / p) * 100 : 0;

  return (
    <div className="panel" style={{ padding: 0 }}>
      <h3 style={{ borderLeft: `4px solid ${accent}` }}>{title} profit</h3>
      <div style={{ padding: "16px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <MoneyInput label="Cost price" value={cost} onChange={setCost} />
          <MoneyInput label="Your postage cost" value={postage} onChange={setPostage} />
          <MoneyInput label="Sale price" value={price} onChange={setPrice} />
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{title} fee:</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="number" step="0.1" value={feePct} onChange={(e) => setFeePct(e.target.value)} style={{ width: 70 }} />
            <span style={{ fontSize: 13 }}>%</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 13 }}>+ £</span>
            <input type="number" step="0.01" value={feeFixed} onChange={(e) => setFeeFixed(e.target.value)} style={{ width: 70 }} />
            <span style={{ fontSize: 13, color: "var(--muted)" }}>per order</span>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          <Stat label={`${title} fee`} value={money(fee)} tone="neg" />
          <Stat label="Total costs" value={money(totalCosts)} tone="neg" />
          <Stat label="Profit" value={money(profit)} tone={profit >= 0 ? "pos" : "neg"} />
          <Stat label="Margin" value={p > 0 ? pct(margin) : "—"} tone={profit >= 0 ? "pos" : "neg"} />
        </div>
      </div>
    </div>
  );
}

// Sale / discount calculator with a channel toggle.
function SaleCalc() {
  const [channel, setChannel] = useState<"ebay" | "squarespace">("ebay");
  const [cost, setCost] = useState("");
  const [postage, setPostage] = useState("");
  const [original, setOriginal] = useState("");
  const [sale, setSale] = useState("");

  const rates = channel === "ebay" ? { pct: 12.8, fixed: 0.3 } : { pct: 2.9, fixed: 0.3 };
  const feeOf = (price: number) => (price > 0 ? price * (rates.pct / 100) + rates.fixed : 0);

  const o = num(original), s = num(sale);
  const customerSavingPct = o > 0 ? ((o - s) / o) * 100 : 0;
  const customerSaving = o - s;

  const profitAt = (price: number) => price - feeOf(price) - num(cost) - num(postage);
  const profitOrig = profitAt(o);
  const profitSale = profitAt(s);
  const marginSale = s > 0 ? (profitSale / s) * 100 : 0;

  return (
    <div className="panel" style={{ padding: 0 }}>
      <h3 style={{ borderLeft: "4px solid #7c3aed" }}>
        Sale / discount
        <span className="per" style={{ marginLeft: "auto" }}>
          <span className="seg" style={{ display: "inline-flex" }}>
            <button className={channel === "ebay" ? "on" : ""} onClick={() => setChannel("ebay")}>eBay</button>
            <button className={channel === "squarespace" ? "on" : ""} onClick={() => setChannel("squarespace")}>Squarespace</button>
          </span>
        </span>
      </h3>
      <div style={{ padding: "16px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          <MoneyInput label="Cost price" value={cost} onChange={setCost} />
          <MoneyInput label="Your postage cost" value={postage} onChange={setPostage} />
          <MoneyInput label="Original price" value={original} onChange={setOriginal} />
          <MoneyInput label="Sale price" value={sale} onChange={setSale} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          <Stat label="Customer saving" value={o > 0 ? `${pct(customerSavingPct)}` : "—"} />
          <Stat label="They save" value={o > 0 ? money(customerSaving) : "—"} />
          <Stat label="Profit at sale price" value={s > 0 ? money(profitSale) : "—"} tone={profitSale >= 0 ? "pos" : "neg"} />
          <Stat label="Margin at sale price" value={s > 0 ? pct(marginSale) : "—"} tone={profitSale >= 0 ? "pos" : "neg"} />
        </div>
        {o > 0 && s > 0 && (
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 12 }}>
            At the original {money(o)} you make {money(profitOrig)}; dropping to {money(s)} ({pct(customerSavingPct)} off for the customer) leaves {money(profitSale)} profit.
          </p>
        )}
      </div>
    </div>
  );
}

const CalculatorPage = () => {
  return (
    <ConceptLayout title="Calculator" subtitle="Work out profit and sale prices before you list">
      <ChannelCalc title="eBay" defPct="12.8" defFixed="0.30" accent="#e53238" />
      <ChannelCalc title="Squarespace" defPct="2.9" defFixed="0.30" accent="#0ea5a4" />
      <SaleCalc />
      <div className="note">
        Fees are editable — the defaults are typical UK rates (eBay 12.8% + £0.30, Squarespace
        payment processing 2.9% + £0.30). "Your postage cost" is what you pay to ship, not what you
        charge the customer. Profit is before VAT.
      </div>
    </ConceptLayout>
  );
};

export default CalculatorPage;
