// supabase/functions/fix-inventory/index.ts
// One-time repair function: scans all active products and ensures every
// variant has exactly one inventory row.  Fixes:
//   1. Variants with ZERO inventory rows (creates one with stock=0)
//   2. Variants with MULTIPLE inventory rows (keeps MAX, deletes rest)
//   3. Merged products where both channels kept separate stock
//      (consolidates to one row per variant using MAX)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const fixes: string[] = [];

    // Get all active products with their variants
    const { data: products, error: pErr } = await sb
      .from("products")
      .select("id, name, variants(id, option1, option2)")
      .eq("active", true);

    if (pErr) throw pErr;

    for (const product of products ?? []) {
      for (const variant of (product as any).variants ?? []) {
        // Get all inventory rows for this variant
        const { data: invRows } = await sb
          .from("inventory")
          .select("*")
          .eq("variant_id", variant.id);

        if (!invRows || invRows.length === 0) {
          // No inventory at all → create with stock 0
          const { error } = await sb.from("inventory").insert({
            variant_id: variant.id,
            product_id: product.id,
            total_stock: 0,
          });
          if (!error) {
            fixes.push(`Created missing inventory for variant ${variant.id} (product: ${product.name}, option: ${variant.option1 ?? 'default'})`);
          }
        } else if (invRows.length > 1) {
          // Multiple inventory rows → keep MAX, delete rest
          const maxStock = Math.max(...invRows.map((r: any) => r.total_stock ?? 0));
          const keepRow = invRows[0];

          // Update the kept row to MAX
          await sb.from("inventory").update({ total_stock: maxStock }).eq("id", keepRow.id);

          // Delete the extras
          for (let i = 1; i < invRows.length; i++) {
            await sb.from("inventory").delete().eq("id", invRows[i].id);
          }
          fixes.push(`Consolidated ${invRows.length} inventory rows → stock ${maxStock} for variant ${variant.id} (product: ${product.name})`);
        }
        // Exactly 1 row → fine, skip
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        fixes_applied: fixes.length,
        details: fixes,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
// force-redeploy-1775234015
