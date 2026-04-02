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
    const ruName = Deno.env.get("EBAY_RUNAME");
    
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
    const ruName = Deno.env.get("EBAY_RUNAME")!;
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
        `<!DOCTYPE html>
<html><head><title>eBay Auth Error</title>
<style>body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; background: #0f172a; color: #e2e8f0; }
.error { background: #7f1d1d; padding: 16px; border-radius: 8px; } code { font-size: 12px; word-break: break-all; }</style>
</head><body>
<h1>❌ Token exchange failed</h1>
<div class="error"><code>${tokenBody}</code></div>
<p>Please try again or contact support.</p>
</body></html>`,
        { headers: { ...corsHeaders, "Content-Type": "text/html" }, status: 200 }
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

    return new Response(
      `<!DOCTYPE html>
<html><head><title>eBay Auth Success</title>
<style>body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; background: #0f172a; color: #e2e8f0; text-align: center; }
.success { background: #14532d; padding: 24px; border-radius: 12px; margin: 24px 0; }
h1 { color: #2dd4bf; font-size: 48px; margin-bottom: 8px; }</style>
</head><body>
<div class="success">
<h1>✅</h1>
<h2>eBay Connected!</h2>
<p>Your eBay tokens have been saved. You can close this tab and run the eBay sync from your dashboard.</p>
<p style="color: #94a3b8; font-size: 14px;">Refresh token expires: ${tokenData.refresh_token_expires_in ? Math.round(tokenData.refresh_token_expires_in / 86400) + ' days' : 'unknown'}</p>
</div>
</body></html>`,
      { headers: { ...corsHeaders, "Content-Type": "text/html" }, status: 200 }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      `<!DOCTYPE html><html><body><h1>Error</h1><p>${msg}</p></body></html>`,
      { headers: { ...corsHeaders, "Content-Type": "text/html" }, status: 500 }
    );
  }
});
