import { useState, useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import InventoryPage from "./pages/InventoryPage.tsx";
import OrdersPage from "./pages/OrdersPage.tsx";
import RefundsPage from "./pages/RefundsPage.tsx";
import SalesPage from "./pages/SalesPage.tsx";
import TrendsPage from "./pages/TrendsPage.tsx";
import CalculatorPage from "./pages/CalculatorPage.tsx";
import CostPricesPage from "./pages/CostPricesPage.tsx";
import ProductsPage from "./pages/ProductsPage.tsx";
import MergePage from "./pages/MergePage.tsx";
import TopSellersPage from "./pages/TopSellersPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import ListingTemplatesPage from "./pages/ListingTemplatesPage.tsx";
import CreateListingPage from "./pages/CreateListingPage.tsx";
import TitleCleanupPage from "./pages/TitleCleanupPage.tsx";
import SellSimilarPage from "./pages/SellSimilarPage.tsx";
import PostagePage from "./pages/PostagePage.tsx";
import MembersPage from "./pages/MembersPage.tsx";
import PointsShopPage from "./pages/PointsShopPage.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

// Sign-in uses Supabase Auth (email + password). The browser offers to save the password,
// so Face ID / Touch ID can fill it in next time. The session is remembered on this device
// and refreshed automatically, so you only sign in again if you sign out.
const LoginScreen = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setError("That email and password don't match. Try again."); setPassword(""); }
  };

  const field: React.CSSProperties = {
    width: "100%", padding: "12px 14px", borderRadius: "8px", border: "1px solid #334155",
    background: "#0f172a", color: "#f1f5f9", fontSize: "15px", outline: "none", boxSizing: "border-box", marginBottom: "10px",
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a" }}>
      <div style={{ background: "#1e293b", borderRadius: "12px", padding: "40px", width: "100%", maxWidth: "380px", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <h1 style={{ color: "#f1f5f9", fontSize: "22px", fontWeight: 700, margin: 0 }}>Voyagers Hook</h1>
          <p style={{ color: "#64748b", fontSize: "14px", marginTop: "6px" }}>Stock Manager</p>
        </div>
        <form onSubmit={handleSubmit} autoComplete="on">
          <input type="email" name="email" autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }}
            placeholder="Email" autoFocus required style={field} />
          <input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }}
            placeholder="Password" required style={{ ...field, border: error ? "1px solid #ef4444" : field.border }} />
          {error && <p style={{ color: "#ef4444", fontSize: "13px", margin: "0 0 12px" }}>{error}</p>}
          <button type="submit" disabled={busy} style={{ width: "100%", padding: "12px", borderRadius: "8px", border: "none", background: "#3b82f6",
            color: "#fff", fontSize: "15px", fontWeight: 600, cursor: "pointer", marginTop: "4px", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
};

const App = () => {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    try { localStorage.removeItem("vh_auth"); } catch { /* old password flag, no longer used */ }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) queryClient.clear();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div style={{ minHeight: "100vh", background: "#0f172a" }} />;
  if (!session) return <LoginScreen />;

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Sonner position="top-center" />
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/refunds" element={<RefundsPage />} />
            <Route path="/sales" element={<SalesPage />} />
            <Route path="/trends" element={<TrendsPage />} />
            <Route path="/calculator" element={<CalculatorPage />} />
            <Route path="/cost-prices" element={<CostPricesPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/merge" element={<MergePage />} />
            <Route path="/top-sellers" element={<TopSellersPage />} />
            <Route path="/listing-templates" element={<ListingTemplatesPage />} />
            <Route path="/title-cleanup" element={<TitleCleanupPage />} />
            <Route path="/sell-similar" element={<SellSimilarPage />} />
            <Route path="/postage" element={<PostagePage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/points-shop" element={<PointsShopPage />} />
            <Route path="/create-listing" element={<CreateListingPage key="listing" />} />
            <Route path="/create-bundle" element={<CreateListingPage key="bundle" bundle />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
