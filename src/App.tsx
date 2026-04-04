import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import ProductsPage from "./pages/ProductsPage.tsx";
import MergePage from "./pages/MergePage.tsx";
import TopSellersPage from "./pages/TopSellersPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import NotFound from "./pages/NotFound.tsx";

const CORRECT_PASSWORD = "VoyagersHook25!";
const STORAGE_KEY = "vh_auth";

const queryClient = new QueryClient();

const LoginScreen = ({ onLogin }: { onLogin: () => void }) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === CORRECT_PASSWORD) {
      localStorage.setItem(STORAGE_KEY, "1");
      onLogin();
    } else {
      setError(true);
      setPassword("");
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#0f172a",
    }}>
      <div style={{
        background: "#1e293b",
        borderRadius: "12px",
        padding: "40px",
        width: "100%",
        maxWidth: "360px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{ fontSize: "32px", marginBottom: "8px" }}>⚓</div>
          <h1 style={{ color: "#f1f5f9", fontSize: "22px", fontWeight: 700, margin: 0 }}>
            Voyagers Hook
          </h1>
          <p style={{ color: "#64748b", fontSize: "14px", marginTop: "6px" }}>
            Stock Manager
          </p>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(false); }}
            placeholder="Enter password"
            autoFocus
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: "8px",
              border: error ? "1px solid #ef4444" : "1px solid #334155",
              background: "#0f172a",
              color: "#f1f5f9",
              fontSize: "15px",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: "8px",
            }}
          />
          {error && (
            <p style={{ color: "#ef4444", fontSize: "13px", margin: "0 0 12px" }}>
              Incorrect password. Try again.
            </p>
          )}
          <button
            type="submit"
            style={{
              width: "100%",
              padding: "12px",
              borderRadius: "8px",
              border: "none",
              background: "#3b82f6",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 600,
              cursor: "pointer",
              marginTop: error ? "0" : "8px",
            }}
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
};

const App = () => {
  const [authed, setAuthed] = useState(() => localStorage.getItem(STORAGE_KEY) === "1");

  if (!authed) {
    return <LoginScreen onLogin={() => setAuthed(true)} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Sonner />
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/merge" element={<MergePage />} />
            <Route path="/top-sellers" element={<TopSellersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
