import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

const LOGO_URL = "https://voyagers-hook.github.io/images/logo%20trans.png";

const NAV: {
  group?: string;
  items: { label: string; path: string; icon: ReactNode }[];
}[] = [
  {
    items: [
      {
        label: "Dashboard",
        path: "/",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="7" height="9" rx="1.5" />
            <rect x="14" y="3" width="7" height="5" rx="1.5" />
            <rect x="14" y="12" width="7" height="9" rx="1.5" />
            <rect x="3" y="16" width="7" height="5" rx="1.5" />
          </svg>
        ),
      },
    ],
  },
  {
    group: "Operations",
    items: [
      {
        label: "Inventory",
        path: "/inventory",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="M3.3 7 12 12l8.7-5M12 22V12" />
          </svg>
        ),
      },
      {
        label: "Orders",
        path: "/orders",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 7h13l-1 9H5z" />
            <path d="m3 7-1-3H1M8 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM15 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />
          </svg>
        ),
      },
      {
        label: "Merge",
        path: "/merge",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M8 7h12M8 7 5 4M8 7 5 10M16 17H4M16 17l3-3M16 17l3 3" />
          </svg>
        ),
      },
      {
        label: "Refunds",
        path: "/refunds",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 7h13l-1.5 9h-10z" />
            <path d="m3 7-1-3H1" />
            <path d="M14 11 11 8m0 3 3-3" />
          </svg>
        ),
      },
    ],
  },
  {
    group: "Insight",
    items: [
      {
        label: "Sales & profit",
        path: "/sales",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
        ),
      },
      {
        label: "Trends",
        path: "/trends",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 3v18h18" />
            <path d="m7 14 3-4 3 3 4-6" />
          </svg>
        ),
      },
      {
        label: "Calculator",
        path: "/calculator",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="4" y="2" width="16" height="20" rx="2" />
            <path d="M8 6h8M8 10h2M12 10h4M8 14h2M12 14h4M8 18h2M12 18h4" />
          </svg>
        ),
      },
      {
        label: "Settings",
        path: "/settings",
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7" />
          </svg>
        ),
      },
    ],
  },
];

const DashboardSidebar = () => {
  const { pathname } = useLocation();
  const isActive = (p: string) => (p === "/" ? pathname === "/" : pathname.startsWith(p));

  return (
    <aside className="side">
      <div className="brand">
        <div className="mark">
          <img src={LOGO_URL} alt="Voyagers Hook" />
        </div>
        <div>
          <h1>Voyagers Hook</h1>
          <span>Stock Manager</span>
        </div>
      </div>
      <nav className="nav">
        {NAV.map((grp, gi) => (
          <div key={gi}>
            {grp.group && <div className="navlbl">{grp.group}</div>}
            {grp.items.map((it) => (
              <Link key={it.path} to={it.path} className={isActive(it.path) ? "active" : ""}>
                {it.icon}
                {it.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="foot">
        <b>eBay + Squarespace</b>
        <br />
        connected &amp; syncing
      </div>
    </aside>
  );
};

export default DashboardSidebar;
