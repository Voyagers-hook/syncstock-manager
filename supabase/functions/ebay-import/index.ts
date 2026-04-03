import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EBAY = "https://api.ebay.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const appId = Deno.env.get("EBAY_APP_ID");
    const certId = Deno.env.get("EBAY_CERT_ID");
    if (!appId || !certId) return json({ error: "Missing EBAY_APP_ID or EBAY_CERT_ID" }, 500);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const clearFirst = body?.clearFirst === true || body?.mode === "full";

    const { data: tokenRow } = await supabase
      .from("sync_secrets").select("value").eq("key", "ebay_refresh_token").single();
    if (!tokenRow?.value) return json({ error: "No eBay refresh token" }, 400);

    const tokenResp = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${appId}:${certId}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenRow.value,
        scope: "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.marketing https://api.ebay.com/oauth/api_scope/sell.account",
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) return json({ error: "eBay token refresh failed" }, 500);

    const accessToken: string = tokenData.access_token;
    
    // Fetch items
    const items = await fetchAllListings(accessToken);

    if (clearFirst) {
      // (Keep your existing cleanup logic here as is)
      await supabase.from("channel_listings").delete().eq("channel", "ebay");
    }

    // Process items
    const stats = await bulkInsert(supabase, items);

    return json({ success: true, ...stats });

  } catch (err: unknown) {
    return json({ error: String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

function xtag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
}

type EbayVariation = { sku: string; price: string; name: string; qty: number };
type EbayItem = {
  itemId: string; title: string; sku: string;
  price: string; qty: number;
  variations: EbayVariation[];
};

async function fetchAllListings(token: string): Promise<EbayItem[]> {
  const all: EbayItem[] = [];
  let page = 1;

  for (;;) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ActiveList>
    <Sort>ItemID</Sort>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const r = await fetch(`${EBAY}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-SITEID": "3",
      },
      body: xml,
    });
    
    const text = await r.text();
    const items = parseXml(text);
    all.push(...items);
    
    const totalPages = parseInt(xtag(text, "TotalNumberOfPages") ?? "1");
    if (page >= totalPages || items.length === 0) break;
    page++;
  }
  return all;
}

function parseXml(xml: string): EbayItem[] {
  const items: EbayItem[] = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const itemId = xtag(x, "ItemID");
    const title = xtag(x, "Title");
    if (!itemId || !title) continue;

    const priceStr = xtag(x, "CurrentPrice") ?? "0";
    const sku = xtag(x, "SKU") || itemId;
    
    // FIX: Use Quantity directly. In GetMyeBaySelling ActiveList, 
    // Quantity is the current available stock.
    const qty = parseInt(xtag(x, "QuantityAvailable") ?? xtag(x, "Quantity") ?? "0");
    
    const variations: EbayVariation[] = [];
    const vblock = x.match(/<Variations>([\s\S]*?)<\/Variations>/);
    
    if (vblock) {
      const vre = /<Variation>([\s\S]*?)<\/Variation>/g;
      let vm;
      while ((vm = vre.exec(vblock[1])) !== null) {
        const vx = vm[1];
        const vSku = xtag(vx, "SKU") ?? "";
        const vPrice = xtag(vx, "StartPrice") ?? priceStr;
        // FIX: Same fix for variants
        const vQty = parseInt(xtag(vx, "Quantity") ?? "0");
        
        const parts: string[] = [];
        const nvre = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let nvm;
        while ((nvm = nvre.exec(vx)) !== null) {
          const val = xtag(nvm[1], "Value");
          if (val) parts.push(val);
        }
        variations.push({ sku: vSku, price: vPrice, name: parts.join(" / "), qty: vQty });
      }
    }
    items.push({ itemId, title, sku, price: priceStr, qty, variations });
  }
  return items;
}

// ... (Rest of your bulkInsert helper remains the same)
// ensure the invRows logic inside bulkInsert uses v.qty and item.qty directly.
