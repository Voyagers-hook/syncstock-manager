import { downloadCsv } from "@/lib/csv";

export interface ListModalData {
  title: string;
  columns: { key: string; label: string; num?: boolean }[];
  rows: Record<string, any>[];
  filename: string;
}

export default function ListModal({ data, onClose }: { data: ListModalData | null; onClose: () => void }) {
  if (!data) return null;
  return (
    <div className="overlay show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 680 }}>
        <div className="mh">
          <span className="x" onClick={onClose}>×</span>
          <div className="t">{data.title}</div>
          <div className="s">{data.rows.length} item{data.rows.length === 1 ? "" : "s"}</div>
        </div>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {data.rows.length === 0 ? (
            <div className="empty" style={{ padding: 30 }}>Nothing here.</div>
          ) : (
            <table>
              <thead>
                <tr>{data.columns.map((c) => <th key={c.key} className={c.num ? "num" : ""}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr className="vrow" key={i}>
                    {data.columns.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{r[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="mf">
          <button className="btn primary" style={{ flex: 1 }} disabled={!data.rows.length}
            onClick={() => downloadCsv(data.filename, data.columns.map((c) => ({ key: c.key, label: c.label })), data.rows)}>
            Download CSV
          </button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
