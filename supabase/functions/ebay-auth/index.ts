import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const ebayAppId = Deno.env.get("EBAY_APP_ID")!;
  const ebayCertId = Deno.env.get("EBAY_CERT_ID")!;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  // Step 1: If no code, redirect user to eBay consent screen
  if (!code) {
    // For the consent URL, we need the RuName (redirect URI name)
    // We'll use the edge function URL itself as redirect
    const redirectUri = `${supabaseUrl}/functions/v1/ebay-auth`;
    
    const scopes = [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.marketing",
      "https://api.ebay.com/oauth/api_scope/sell.account",
      "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    ].join(" ");

    // Check if we should use the eBay RuName from secrets
    const ruName = Deno.env.get("EBAY-RUNAME");
    
    if (!ruName) {
      return new Response(
        JSON.stringify({ error: "EBAY_RUNAME not configured. Please add it as a secret." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build the eBay consent URL and redirect directly (302)
    const consentUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(ebayAppId)}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(scopes)}`;

    return new Response(null, {
      status: 302,
      headers: { ...corsHeaders, Location: consentUrl },
    });
  }

  // Step 2: Exchange authorization code for tokens
  try {
    const credentials = btoa(`${ebayAppId}:${ebayCertId}`);
    const ruName = Deno.env.get("EBAY-RUNAME")!;
    const redirectUri = `${supabaseUrl}/functions/v1/ebay-auth`;

    const tokenResp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: decodeURIComponent(code),
        redirect_uri: ruName,
      }),
    });

    const tokenBody = await tokenResp.text();
    
    if (!tokenResp.ok) {
      return new Response(
        JSON.stringify({ error: "Token exchange failed", details: tokenBody }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tokenData = JSON.parse(tokenBody);
    
    // Store refresh token in sync_secrets
    if (tokenData.refresh_token) {
      await supabase
        .from("sync_secrets")
        .upsert(
          { key: "ebay_refresh_token", value: tokenData.refresh_token, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
    }

    // Store access token too for immediate use
    if (tokenData.access_token) {
      await supabase
        .from("sync_secrets")
        .upsert(
          { key: "ebay_access_token", value: tokenData.access_token, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
    }

    const expiryDays = tokenData.refresh_token_expires_in ? Math.round(tokenData.refresh_token_expires_in / 86400) : 365;
    const html = `<!DOCTYPE html><html><head><title>eBay Connected</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#f1f5f9}
.card{text-align:center;padding:2rem;background:#1e293b;border-radius:1rem;border:1px solid #22c55e}
h2{color:#22c55e;margin-bottom:0.5rem}p{color:#94a3b8;margin:0.5rem 0}
button{margin-top:1rem;padding:0.5rem 1.5rem;background:#22c55e;color:#000;border:none;border-radius:0.5rem;cursor:pointer;font-size:1rem}
</style></head><body>
<div class="card">
  <h2>✓ eBay Connected!</h2>
  <p>Your eBay account has been linked.</p>
  <p>Refresh token valid for ~${expiryDays} days.</p>
  <p>You can close this tab and run a Full Catalogue Reset from the dashboard.</p>
  <button onclick="window.close()">Close Tab</button>
</div>
<script>setTimeout(()=>window.close(),3000);</script>
</body></html>`;
    return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html" }, status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
