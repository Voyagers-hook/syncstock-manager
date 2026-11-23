import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Small account control in the top bar: change password and sign out.
const AccountMenu = () => {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (pw.length < 10) { toast.error("Use at least 10 characters."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Password changed. Let your browser save the new one.");
    setPw(""); setOpen(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)}>Account</button>
      {open && (
        <div className="panel" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 300, zIndex: 50, margin: 0, padding: 14 }}>
          <form onSubmit={(e) => { e.preventDefault(); save(); }} autoComplete="on">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Change password</div>
            <input type="password" name="new-password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)}
              placeholder="New password"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line,#eceff4)", fontSize: 14, marginBottom: 8 }} />
            <button className="btn primary" type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "Saving..." : "Save password"}</button>
          </form>
          <button className="btn ghost" style={{ width: "100%", marginTop: 10 }} onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
};

export default AccountMenu;
