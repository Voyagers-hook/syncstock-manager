import { ReactNode } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";

export type Range = "7" | "30" | "90" | "yr";
export const RANGE_LABEL: Record<Range, string> = {
  "7": "last 7 days",
  "30": "last 30 days",
  "90": "last 90 days",
  yr: "this year",
};
export function rangeSince(r: Range): string {
  const d = new Date();
  if (r === "7") d.setDate(d.getDate() - 7);
  else if (r === "30") d.setDate(d.getDate() - 30);
  else if (r === "90") d.setDate(d.getDate() - 90);
  else d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

interface Props {
  title: string;
  subtitle?: string;
  children: ReactNode;
  range?: Range;
  onRange?: (r: Range) => void;
  onExport?: () => void;
  search?: string;
  onSearch?: (v: string) => void;
}

const ConceptLayout = ({
  title,
  subtitle,
  children,
  range,
  onRange,
  onExport,
  search,
  onSearch,
}: Props) => {
  return (
    <div className="app">
      <DashboardSidebar />

      <div className="main">
        <div className="topbar">
          <h2>{title}</h2>
          {subtitle && <span className="sub">{subtitle}</span>}
          <div className="spacer" />
          {range && onRange && (
            <div className="seg">
              {(["7", "30", "90", "yr"] as Range[]).map((r) => (
                <button
                  key={r}
                  className={range === r ? "on" : ""}
                  onClick={() => onRange(r)}
                >
                  {r === "yr" ? "Year" : `${r}d`}
                </button>
              ))}
            </div>
          )}
          {onExport && (
            <button className="btn ghost" onClick={onExport}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" />
              </svg>
              Export CSV
            </button>
          )}
          {onSearch && (
            <div className="search">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4-4" />
              </svg>
              <input
                placeholder="Search…"
                value={search ?? ""}
                onChange={(e) => onSearch(e.target.value)}
              />
            </div>
          )}
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
};

export default ConceptLayout;
