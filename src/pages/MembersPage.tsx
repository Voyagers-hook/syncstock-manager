import { useState } from "react";
import ConceptLayout from "@/components/ConceptLayout";
import { useMembers, useMemberLedger, useAdjustPoints, Member } from "@/hooks/use-members";
import { toast } from "sonner";

function money(n: number | null | undefined) {
  return `£${(Number(n) || 0).toFixed(2)}`;
}
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
const tierLabel: Record<string, string> = { cast: "Cast", little_voyagers: "Little Voyagers" };
function spendBadge(t: string | null) {
  const c = t === "gold" ? "#d97706" : t === "silver" ? "#64748b" : "#b45309";
  return <span className="badge" style={{ color: c, textTransform: "capitalize" }}>{t ?? "bronze"}</span>;
}

type TierFilter = "all" | "cast" | "little_voyagers";

const MembersPage = () => {
  const [search, setSearch] = useState("");
  const { data: allMembers = [], isLoading } = useMembers(search);
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const members = tierFilter === "all" ? allMembers : allMembers.filter((m) => m.tier === tierFilter);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = members.find((m) => m.id === openId) ?? null;

  const counts = {
    all: allMembers.length,
    cast: allMembers.filter((m) => m.tier === "cast").length,
    little_voyagers: allMembers.filter((m) => m.tier === "little_voyagers").length,
  };

  return (
    <ConceptLayout
      title="Hook Club Members"
      subtitle="Members, points balances, spend tiers and manual adjustments — auto-synced from sign-ups & sales"
      search={search}
      onSearch={setSearch}
    >
      <div className="thead-wrap">
        <div className="cap">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h3 style={{ margin: 0 }}>Members</h3>
            <div className="seg">
              <button className={tierFilter === "all" ? "on" : ""} onClick={() => setTierFilter("all")}>All ({counts.all})</button>
              <button className={tierFilter === "cast" ? "on" : ""} onClick={() => setTierFilter("cast")}>Cast ({counts.cast})</button>
              <button className={tierFilter === "little_voyagers" ? "on" : ""} onClick={() => setTierFilter("little_voyagers")}>Little Voyagers ({counts.little_voyagers})</button>
            </div>
          </div>
          <div className="legend" style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ color: "var(--muted)" }}>1 point = 1p · band by last-12-month spend: Bronze 5 / Silver 6.25 / Gold 7.5 per £1</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Membership #</th>
              <th>Tier</th>
              <th className="num">Spend (12 mo)</th>
              <th>Band</th>
              <th className="num">Points</th>
              <th>NEWMEM10</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="empty">Loading…</td></tr>
            ) : members.length === 0 ? (
              <tr><td colSpan={7} className="empty">No members match.</td></tr>
            ) : (
              members.map((m) => (
                <tr className="vrow" key={m.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(m.id)}>
                  <td>
                    <div>{m.name ?? "—"}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{m.email}</div>
                  </td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{m.membership_number ?? "—"}</td>
                  <td>{tierLabel[m.tier] ?? m.tier}</td>
                  <td className="num">{money(m.spend_12m ?? m.lifetime_spend)}</td>
                  <td>{spendBadge(m.spend_tier)}</td>
                  <td className="num"><b>{m.points_balance.toLocaleString()}</b></td>
                  <td>{m.discount_used ? <span style={{ color: "var(--over)" }}>Used</span> : <span style={{ color: "var(--ok,#16a34a)" }}>Available</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {open && <MemberDrawer member={open} onClose={() => setOpenId(null)} />}
    </ConceptLayout>
  );
};

function MemberDrawer({ member, onClose }: { member: Member; onClose: () => void }) {
  const { data: ledger = [], isLoading } = useMemberLedger(member.id);
  const adjust = useAdjustPoints();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [sign, setSign] = useState<1 | -1>(1);

  const submit = async () => {
    const n = Math.trunc(Math.abs(Number(amount)));
    if (!Number.isFinite(n) || n <= 0) { toast.error("Enter a whole number of points."); return; }
    try {
      const res = await adjust.mutateAsync({ member_id: member.id, delta: sign * n, note: note.trim() || undefined });
      toast.success(`${sign > 0 ? "Added" : "Removed"} ${n} points · new balance ${(res as any).balance?.toLocaleString?.() ?? ""}`);
      setAmount(""); setNote("");
    } catch (e: any) { toast.error(e?.message ?? "Adjustment failed."); }
  };

  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 620 }}>
        <div className="mh">
          <span className="x" onClick={onClose}>×</span>
          <div className="t">{member.name ?? "Member"}</div>
          <div className="s">
            {member.email} · {tierLabel[member.tier] ?? member.tier}
            {member.membership_number ? ` · #${member.membership_number}` : ""}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, padding: "6px 2px 12px", flexWrap: "wrap" }}>
          <Stat label="Points balance" value={member.points_balance.toLocaleString()} />
          <Stat label="Spend (last 12 mo)" value={money(member.spend_12m ?? member.lifetime_spend)} />
          <Stat label="Band (12 mo)" value={(member.spend_tier ?? "bronze")} cap />
          <Stat label="Lifetime spend" value={money(member.lifetime_spend)} />
        </div>
        {member.email_aliases && member.email_aliases.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Also known by: {member.email_aliases.join(", ")}
          </div>
        )}

        <div style={{ border: "1px solid var(--line,#eceff4)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Manual points adjustment</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="seg">
              <button className={sign === 1 ? "on" : ""} onClick={() => setSign(1)}>Add</button>
              <button className={sign === -1 ? "on" : ""} onClick={() => setSign(-1)}>Remove</button>
            </div>
            <input type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="Points" style={inp(110)} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)" style={inp(230)} />
            <button className="btn primary" disabled={adjust.isPending} onClick={submit}>
              {adjust.isPending ? "Saving…" : "Apply"}
            </button>
          </div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Points history</div>
        <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
          <table>
            <thead>
              <tr><th>When</th><th>Reason</th><th className="num">Change</th><th className="num">Balance</th></tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={4} className="empty">Loading…</td></tr>
              ) : ledger.length === 0 ? (
                <tr><td colSpan={4} className="empty">No points activity yet.</td></tr>
              ) : (
                ledger.map((l) => (
                  <tr className="vrow" key={l.id}>
                    <td style={{ fontSize: 12 }}>{fmtDateTime(l.created_at)}</td>
                    <td style={{ fontSize: 12 }}>
                      {l.reason}{l.note ? <span style={{ color: "var(--muted)" }}> — {l.note}</span> : ""}
                    </td>
                    <td className="num" style={{ color: l.change >= 0 ? "var(--ok,#16a34a)" : "var(--over)" }}>
                      {l.change >= 0 ? "+" : ""}{l.change}
                    </td>
                    <td className="num">{l.balance_after.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, cap }: { label: string; value: string; cap?: boolean }) {
  return (
    <div style={{ flex: "1 1 120px", background: "var(--bg,#f6f8fb)", border: "1px solid var(--line,#eceff4)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink,#111827)", textTransform: cap ? "capitalize" : "none" }}>{value}</div>
    </div>
  );
}
function inp(w: number): React.CSSProperties {
  return { width: w, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line,#eceff4)", background: "#fff", color: "var(--ink,#111827)", fontSize: 14 };
}

export default MembersPage;
