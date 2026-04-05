import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────
export type UnmergedProduct = {
  id: string;
  name: string;
  sku: string;
  channel: string;
  variant_id: string;
  listing_id: string;
};

export type UnmergedVariant = {
  variant_id: string;
  product_name: string;
  variant_name: string;
  channel_sku?: string | null;
  channel_price?: number | null;
  channel: string;
};

// ─── Product-level hooks ──────────────────────────────────────────────────────
export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async () => {
      const { data: products } = await supabase
        .from("products")
        .select("*, variants(*)")
        .eq("active", true);
      if (!products) return [];

      const allVariantIds = products.flatMap((p: any) =>
        (p.variants ?? []).map((v: any) => v.id)
      );
      if (allVariantIds.length === 0) return [];

      const CHUNK = 150;
      const allListings: any[] = [];
      for (let i = 0; i < allVariantIds.length; i += CHUNK) {
        const chunk = allVariantIds.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from("channel_listings")
          .select("*")
          .in("variant_id", chunk);
        if (error) throw error;
        if (data) allListings.push(...data);
      }

      const listingsByProduct = new Map<string, any[]>();
      for (const l of allListings) {
        for (const p of products) {
          if ((p as any).variants?.some((v: any) => v.id === l.variant_id)) {
            const bucket = listingsByProduct.get(p.id) ?? [];
            bucket.push(l);
            listingsByProduct.set(p.id, bucket);
            break;
          }
        }
      }

      return products
        .filter((p: any) => {
          const listings = listingsByProduct.get(p.id) ?? [];
          return (
            listings.length > 0 &&
            new Set(listings.map((l: any) => l.channel)).size === 1
          );
        })
        .map((p: any) => {
          const listings = listingsByProduct.get(p.id) ?? [];
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            channel: listings[0]?.channel,
            variant_id: p.variants[0]?.id,
            listing_id: listings[0]?.id,
          };
        });
    },
  });
}

// ─── FIXED MANUAL MERGE & UNMERGE LOGIC ──────────────────────────────────────
export function useMergeProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      keepId,
      removeId,
    }: {
      keepId: string;
      removeId: string;
    }) => {
      const { data: removeVariants } = await supabase
        .from("variants")
        .select("*")
        .eq("product_id", removeId);
      if (!removeVariants) throw new Error("Missing removed variants");

      let newVariantIds: string[] = [];
      for (const rv of removeVariants) {
        const {
          data: [newVariant],
          error: createErr,
        } = await supabase
          .from("variants")
          .insert({
            product_id: keepId,
            option1: rv.option1,
            option2: rv.option2,
          })
          .select();
        if (createErr || !newVariant)
          throw new Error("Failed to create new variant on kept product");
        newVariantIds.push(newVariant.id);

        await supabase
          .from("channel_listings")
          .update({ variant_id: newVariant.id })
          .eq("variant_id", rv.id);

        await consolidateInventory(newVariant.id, rv.id);
        await supabase.from("variants").delete().eq("id", rv.id);
      }

      await supabase.from("merge_history").insert({
        keep_product_id: keepId,
        remove_product_id: removeId,
        original_variant_ids: removeVariants.map((v: any) => v.id),
        original_variant_products: removeVariants.map((v: any) => v.product_id),
        new_variant_ids: newVariantIds,
        action: "merge",
        undoable: true,
        merged_by: null,
      });

      const { data: orphans } = await supabase
        .from("variants")
        .select("id")
        .eq("product_id", removeId);
      if (orphans?.length) {
        const orphanIds = orphans.map((v: any) => v.id);
        await supabase.from("channel_listings").delete().in("variant_id", orphanIds);
        await supabase.from("inventory").delete().in("variant_id", orphanIds);
        await supabase.from("variants").delete().eq("product_id", removeId);
      }

      await supabase.from("products").update({ active: false }).eq("id", removeId);
      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Merged successfully — stock consolidated!");
    },
  });
}

export function useUndoMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ historyId }: { historyId: string }) => {
      const { data: history, error } = await supabase
        .from("merge_history")
        .select("*")
        .eq("id", historyId)
        .maybeSingle();
      if (error || !history) throw new Error("Merge history not found!");

      for (let i = 0; i < history.original_variant_ids.length; ++i) {
        const oldVariantId = history.original_variant_ids[i];
        const oldProductId = history.original_variant_products[i];
        const newVariantId = history.new_variant_ids[i];

        const { data: variantExists } = await supabase
          .from("variants")
          .select("id")
          .eq("id", oldVariantId)
          .maybeSingle();
        if (!variantExists) {
          await supabase.from("variants").insert({
            id: oldVariantId,
            product_id: oldProductId,
          });
        }

        await supabase
          .from("channel_listings")
          .update({ variant_id: oldVariantId })
          .eq("variant_id", newVariantId);

        await consolidateInventory(oldVariantId, newVariantId);
        await supabase.from("variants").delete().eq("id", newVariantId);
      }

      await supabase
        .from("products")
        .update({ active: true })
        .eq("id", history.remove_product_id);
      await supabase
        .from("merge_history")
        .update({ undoable: false })
        .eq("id", historyId);

      return { undone: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Unmerge/Undo successful!");
    },
    onError: (err: any) => {
      toast.error(`Undo failed: ${err.message}`);
    },
  });
}

// ─── Variant-level hooks ──────────────────────────────────────────────────────
export function useUnmergedVariants() {
  return useQuery({
    queryKey: ["unmerged-variants"],
    queryFn: async () => {
      // Use a server-side RPC instead of fetching all listings client-side.
      // The RPC does the unlinked filtering in Postgres — accurate, fast,
      // and avoids the client-side mapping issues that caused wrong results.
      const { data, error } = await supabase.rpc("get_unmerged_variants");
      if (error) throw error;
      return (data ?? []) as UnmergedVariant[];
    },
  });
}

export function useMergeVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      keepVariantId,
      removeVariantId,
    }: {
      keepVariantId: string;
      removeVariantId: string;
    }) => {
      const { data: removeVariantData } = await supabase
        .from("variants")
        .select("product_id")
        .eq("id", removeVariantId)
        .maybeSingle();

      await supabase
        .from("channel_listings")
        .update({ variant_id: keepVariantId })
        .eq("variant_id", removeVariantId);

      await consolidateInventory(keepVariantId, removeVariantId);
      await supabase.from("variants").delete().eq("id", removeVariantId);

      if (removeVariantData?.product_id) {
        const { data: remaining } = await supabase
          .from("variants")
          .select("id")
          .eq("product_id", removeVariantData.product_id);
        if (!remaining?.length) {
          await supabase
            .from("products")
            .update({ active: false })
            .eq("id", removeVariantData.product_id);
        }
      }

      return { keepVariantId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      toast.success("Variants linked — they now share the same inventory!");
    },
    onError: (err: any) => {
      toast.error(`Link failed: ${err.message}`);
    },
  });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
async function consolidateInventory(keepId: string, removeId: string) {
  const { data: keepInv } = await supabase
    .from("inventory")
    .select("*")
    .eq("variant_id", keepId)
    .maybeSingle();

  const { data: removeInv } = await supabase
    .from("inventory")
    .select("*")
    .eq("variant_id", removeId)
    .maybeSingle();

  if (removeInv && keepInv) {
    const maxStock = Math.max(
      keepInv.total_stock ?? 0,
      removeInv.total_stock ?? 0
    );
    await supabase
      .from("inventory")
      .update({ total_stock: maxStock })
      .eq("id", keepInv.id);
    await supabase.from("inventory").delete().eq("id", removeInv.id);
  } else if (removeInv && !keepInv) {
    await supabase
      .from("inventory")
      .update({ variant_id: keepId })
      .eq("id", removeInv.id);
  }

  const { data: keepVariant } = await supabase
    .from("variants")
    .select("product_id")
    .eq("id", keepId)
    .maybeSingle();
  if (keepVariant?.product_id) {
    await supabase
      .from("inventory")
      .update({ product_id: keepVariant.product_id })
      .eq("variant_id", keepId);
  }
}

export function useMergeHistory() {
  return { history: [], refresh: () => {} };
}          return listings.length > 0 && new Set(listings.map((l: any) => l.channel)).size === 1;
        })
        .map((p: any) => {
          const listings = listingsByProduct.get(p.id) ?? [];
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            channel: listings[0]?.channel,
            variant_id: p.variants[0]?.id,
            listing_id: listings[0]?.id,
          };
        });
    },
  });
}

// ─── FIXED MANUAL MERGE & UNMERGE LOGIC ────────────────────────────────────────────
export function useMergeProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      keepId,
      removeId,
    }: {
      keepId: string;
      removeId: string;
    }) => {
      const { data: removeVariants } = await supabase
        .from("variants")
        .select("*")
        .eq("product_id", removeId);

      if (!removeVariants) throw new Error("Missing removed variants");
      let newVariantIds: string[] = [];
      for (const rv of removeVariants) {
        const { data: [newVariant], error: createErr } = await supabase
          .from("variants")
          .insert({
            product_id: keepId,
            option1: rv.option1,
            option2: rv.option2,
          })
          .select();

        if (createErr || !newVariant) throw new Error("Failed to create new variant on kept product");
        newVariantIds.push(newVariant.id);

        await supabase
          .from("channel_listings")
          .update({ variant_id: newVariant.id })
          .eq("variant_id", rv.id);

        await consolidateInventory(newVariant.id, rv.id);

        await supabase.from("variants").delete().eq("id", rv.id);
      }

      await supabase
        .from("merge_history")
        .insert({
          keep_product_id: keepId,
          remove_product_id: removeId,
          original_variant_ids: removeVariants.map((v: any) => v.id),
          original_variant_products: removeVariants.map((v: any) => v.product_id),
          new_variant_ids: newVariantIds,
          action: "merge",
          undoable: true,
          merged_by: null
        });

      const { data: orphans } = await supabase
        .from("variants")
        .select("id")
        .eq("product_id", removeId);
      if (orphans?.length) {
        const orphanIds = orphans.map((v: any) => v.id);
        await supabase.from("channel_listings").delete().in("variant_id", orphanIds);
        await supabase.from("inventory").delete().in("variant_id", orphanIds);
        await supabase.from("variants").delete().eq("product_id", removeId);
      }

      await supabase
        .from("products")
        .update({ active: false })
        .eq("id", removeId);

      return { keepId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Merged successfully — stock consolidated!");
    },
  });
}

export function useUndoMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ historyId }: { historyId: string }) => {
      const { data: history, error } = await supabase
        .from("merge_history")
        .select("*")
        .eq("id", historyId)
        .maybeSingle();

      if (error || !history) throw new Error("Merge history not found!");
    
      for (let i = 0; i < history.original_variant_ids.length; ++i) {
        const oldVariantId = history.original_variant_ids[i];
        const oldProductId = history.original_variant_products[i];
        const newVariantId = history.new_variant_ids[i];

        const { data: variantExists } = await supabase
          .from("variants")
          .select("id")
          .eq("id", oldVariantId)
          .maybeSingle();

        if (!variantExists) {
          await supabase.from("variants").insert({
            id: oldVariantId,
            product_id: oldProductId,
          });
        }

        await supabase
          .from("channel_listings")
          .update({ variant_id: oldVariantId })
          .eq("variant_id", newVariantId);

        await consolidateInventory(oldVariantId, newVariantId);

        await supabase.from("variants").delete().eq("id", newVariantId);
      }

      await supabase
        .from("products")
        .update({ active: true })
        .eq("id", history.remove_product_id);

      await supabase
        .from("merge_history")
        .update({ undoable: false })
        .eq("id", historyId);

      return { undone: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      toast.success("Unmerge/Undo successful!");
    },
    onError: (err: any) => {
      toast.error(`Undo failed: ${err.message}`);
    },
  });
}

// ─── Variant-level hooks ──────────────────────────────────────────────────────

export function useUnmergedVariants() {
  return useQuery({
    queryKey: ["unmerged-variants"],
    queryFn: async () => {
      const { data: listings, error } = await supabase
        .from("channel_listings")
        .select(
          "variant_id, channel, channel_sku, channel_price, variants!inner(option1, option2, product_id, products!inner(name, active))"
        );

      if (error) throw error;
      if (!listings) return [];

      const active = listings.filter(
        (l: any) => l.variants?.products?.active !== false
      );

      const channelsByVariant = new Map<string, Set<string>>();
      for (const l of active) {
        const set = channelsByVariant.get(l.variant_id) ?? new Set();
        set.add(l.channel);
        channelsByVariant.set(l.variant_id, set);
      }

      const unlinked = active.filter(
        (l: any) => (channelsByVariant.get(l.variant_id)?.size ?? 0) === 1
      );

      return unlinked.map((l: any) => {
        const v = l.variants;
        const optParts = [v?.option1, v?.option2].filter(Boolean);
        const variantName =
          optParts.length > 0 ? optParts.join(" / ") : "Default";
        return {
          variant_id: l.variant_id,
          product_name: v?.products?.name ?? "Unknown",
          variant_name: variantName,
          channel_sku: l.channel_sku,
          channel_price: l.channel_price,
          channel: l.channel,
        } as UnmergedVariant;
      });
    },
  });
}

export function useMergeVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      keepVariantId,
      removeVariantId,
    }: {
      keepVariantId: string;
      removeVariantId: string;
    }) => {
      const { data: removeVariantData } = await supabase
        .from("variants")
        .select("product_id")
        .eq("id", removeVariantId)
        .maybeSingle();

      await supabase
        .from("channel_listings")
        .update({ variant_id: keepVariantId })
        .eq("variant_id", removeVariantId);

      await consolidateInventory(keepVariantId, removeVariantId);

      await supabase.from("variants").delete().eq("id", removeVariantId);

      if (removeVariantData?.product_id) {
        const { data: remaining } = await supabase
          .from("variants")
          .select("id")
          .eq("product_id", removeVariantData.product_id);
        if (!remaining?.length) {
          await supabase
            .from("products")
            .update({ active: false })
            .eq("id", removeVariantData.product_id);
        }
      }

      return { keepVariantId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-variants"] });
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      toast.success("Variants linked — they now share the same inventory!");
    },
    onError: (err: any) => {
      toast.error(`Link failed: ${err.message}`);
    },
  });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function consolidateInventory(keepId: string, removeId: string) {
  const { data: keepInv } = await supabase
    .from("inventory")
    .select("*")
    .eq("variant_id", keepId)
    .maybeSingle();

  const { data: removeInv } = await supabase
    .from("inventory")
    .select("*")
    .eq("variant_id", removeId)
    .maybeSingle();

  if (removeInv && keepInv) {
    const maxStock = Math.max(
      keepInv.total_stock ?? 0,
      removeInv.total_stock ?? 0
    );
    await supabase
      .from("inventory")
      .update({ total_stock: maxStock })
      .eq("id", keepInv.id);
    await supabase.from("inventory").delete().eq("id", removeInv.id);
  } else if (removeInv && !keepInv) {
    await supabase
      .from("inventory")
      .update({ variant_id: keepId })
      .eq("id", removeInv.id);
  }

  const { data: keepVariant } = await supabase
    .from("variants")
    .select("product_id")
    .eq("id", keepId)
    .maybeSingle();

  if (keepVariant?.product_id) {
    await supabase
      .from("inventory")
      .update({ product_id: keepVariant.product_id })
      .eq("variant_id", keepId);
  }
}

export function useMergeHistory() {
  return { history: [], refresh: () => {} };
}
