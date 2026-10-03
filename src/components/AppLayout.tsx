import { ReactNode } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";

const LOGO_URL = "https://voyagers-hook.github.io/images/logo%20trans.png";

interface AppLayoutProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

const AppLayout = ({ title, subtitle, actions, children }: AppLayoutProps) => {
  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-6 lg:p-8">
        <div className="flex items-start justify-between gap-4 mb-7">
          <div className="flex items-center gap-4">
            <img
              src={LOGO_URL}
              alt="Voyager's Hook"
              className="w-10 h-10 object-contain lg:hidden"
            />
            <div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">{title}</h1>
              {subtitle && (
                <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex items-center gap-3 flex-wrap justify-end">{actions}</div>}
        </div>
        {children}
      </main>
    </div>
  );
};

export default AppLayout;
