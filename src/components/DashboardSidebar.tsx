import { Package, LayoutDashboard, Settings, RefreshCw, BarChart3 } from "lucide-react";

interface SidebarItem {
  icon: React.ElementType;
  label: string;
  active?: boolean;
}

const items: SidebarItem[] = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },
  { icon: Package, label: "Products" },
  { icon: RefreshCw, label: "Sync Log" },
  { icon: BarChart3, label: "Analytics" },
  { icon: Settings, label: "Settings" },
];

const DashboardSidebar = () => {
  return (
    <aside className="fixed left-0 top-0 h-screen w-60 bg-sidebar flex flex-col z-30">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-6 border-b border-sidebar-border">
        <div className="w-8 h-8 rounded-lg bg-sidebar-primary flex items-center justify-center">
          <Package className="w-4 h-4 text-sidebar-primary-foreground" />
        </div>
        <span className="text-sidebar-primary-foreground font-semibold text-lg tracking-tight">
          StockSync
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map((item) => (
          <button
            key={item.label}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              item.active
                ? "bg-sidebar-accent text-sidebar-primary-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-primary-foreground"
            }`}
          >
            <item.icon className="w-[18px] h-[18px]" />
            {item.label}
          </button>
        ))}
      </nav>

      {/* Platforms */}
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
