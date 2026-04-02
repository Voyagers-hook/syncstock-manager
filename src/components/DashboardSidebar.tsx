import { Package, LayoutDashboard, Link2, Trophy, Settings } from "lucide-react";
import { useLocation, Link } from "react-router-dom";

const LOGO_URL = "https://voyagers-hook.github.io/images/logo%20trans.png";

const items = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/" },
  { icon: Package, label: "Products", path: "/" },
  { icon: Link2, label: "Merge Items", path: "/merge" },
  { icon: Trophy, label: "Top Sellers", path: "/top-sellers" },
  { icon: Settings, label: "Settings", path: "/" },
];

const DashboardSidebar = () => {
  const location = useLocation();

  return (
    <aside className="fixed left-0 top-0 h-screen w-60 bg-sidebar flex flex-col z-30">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
        <img src={LOGO_URL} alt="Voyager's Hook" className="w-10 h-10 object-contain" />
        <span className="text-sidebar-primary-foreground font-semibold text-base tracking-tight leading-tight">
          Voyager's Hook
        </span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map((item) => {
          const isActive = location.pathname === item.path && 
            (item.path !== "/" || ["Dashboard", "Products"].includes(item.label));
          
          return (
            <Link
              key={item.label}
              to={item.path}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-primary-foreground"
              }`}
            >
              <item.icon className="w-[18px] h-[18px]" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 pb-5 space-y-2">
        <p className="text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider px-1">
          Platforms
        </p>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sidebar-accent">
          <div className="w-2 h-2 rounded-full bg-success" />
          <span className="text-xs text-sidebar-foreground">eBay — Connected</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sidebar-accent">
          <div className="w-2 h-2 rounded-full bg-warning" />
          <span className="text-xs text-sidebar-foreground">Squarespace — Pending</span>
        </div>
      </div>
    </aside>
  );
};

export default DashboardSidebar;
