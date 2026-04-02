import DashboardSidebar from "@/components/DashboardSidebar";

const SettingsPage = () => {
  return (
    <div className="min-h-screen bg-background">
      <DashboardSidebar />
      <main className="ml-60 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure your sync preferences and account</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="text-muted-foreground">Settings page coming soon — platform connections, sync intervals, and notifications will live here.</p>
        </div>
      </main>
    </div>
  );
};

export default SettingsPage;
