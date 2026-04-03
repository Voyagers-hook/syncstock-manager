import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { chunkArray, fetchAllPages } from "@/lib/supabase-pagination";
import { toast } from "sonner";

const PAGE_SIZE = 1000;
const CHUNK_SIZE = 150;

export interface UnmergedProduct {
  id: string;
  name: string;
  sku: string | null;
  channel: "ebay" | "squarespace";
  channel_price: number | null;
  channel_product_id: string | null;
  variant_id: string;
  listing_id: string;
}

interface VariantRow {
  id: string;
  product_id: string;
  internal_sku: string | null;
  option1: string | null;
  option2: string | null;
  needs_sync: boolean;
  created_at: string;
  updated_at: string;
}

interface InventoryRow {
  id: string;
  variant_id: string | null;
  product_id: string;
  total_stock: number;
  reserved_stock: number;
  low_stock_threshold: number | null;
  location: string | null;
  updated_at: string;
}

interface ProductRow {
  id: string;
  name: string;
}

interface ChannelListingRow {
  id: string;
  variant_id: string;
  channel: "ebay" | "squarespace";
  channel_price: number | null;
  channel_product_id: string | null;
  channel_variant_id: string | null;
  channel_sku: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

interface LinkedVariantAction {
  source_variant_id: string;
  target_variant_id: string;
  moved_listing_ids: string[];
  target_inventory_id: string | null;
  target_previous_stock: number | null;
  source_inventory_id: string | null;
  source_inventory_reassigned: boolean;
}

export interface MergeAction {
  kept_product_id: string;
  removed_product_id: string;
  moved_variant_ids: string[];
  moved_listing_ids: string[];
  moved_inventory_ids: string[];
  linked_variants: LinkedVariantAction[];
  timestamp: string;
}

async function fetchByIds<T>(
  table: string,
  column: string,
  ids: string[],
  select: string = "*",
): Promise<T[]> {
  if (!ids.length) return [];
  const chunks = chunkArray(ids, CHUNK_SIZE);
  const results = await Promise.all(
    chunks.map((chunk) =>
      fetchAllPages<T>(async (from, to) => {
        const resp = await (supabase as any)
          .from(table)
          .select(select)
          .in(column, chunk)
          .range(from, to);
        return { data: resp.data as T[] | null, error: resp.error };
      }, PAGE_SIZE),
    ),
  );
  return results.flat();
}

function readMergeHistory(): MergeAction[] {
  return JSON.parse(localStorage.getItem("merge_history") || "[]");
}

function writeMergeHistory(history: MergeAction[]) {
  localStorage.setItem("merge_history", JSON.stringify(history));
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function extractNameParts(name: string) {
  const parts = name.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  return {
    base: normalizeText(parts.slice(0, -1).join(" - ")),
    suffix: normalizeText(parts[parts.length - 1]),
  };
}

function areProductsCompatible(left: string, right: string) {
  const leftParts = extractNameParts(left);
  const rightParts = extractNameParts(right);

  if (!leftParts || !rightParts) return true;
  if (leftParts.base !== rightParts.base) return true;

  return (
    leftParts.suffix.includes(rightParts.suffix) ||
    rightParts.suffix.includes(leftParts.suffix)
  );
}

function simplifyVariantValue(value: string | null | undefined) {
  const raw = normalizeText(value);
  if (!raw) return "";

  const slashParts = raw.split("/").map((part) => part.trim()).filter(Boolean);
  const lastSlashSegment = slashParts[slashParts.length - 1] ?? raw;
  const dashParts = lastSlashSegment.split("-").map((part) => part.trim()).filter(Boolean);

  return dashParts[dashParts.length - 1] ?? lastSlashSegment;
}

function getVariantKeys(variant: Pick<VariantRow, "option1" | "option2">) {
  const full = [normalizeText(variant.option1), normalizeText(variant.option2)]
    .filter(Boolean)
    .join(" / ");
  const simple = [simplifyVariantValue(variant.option1), simplifyVariantValue(variant.option2)]
    .filter(Boolean)
    .join(" / ");

  const keys = new Set<string>();
  if (full) keys.add(`full:${full}`);
  if (simple) keys.add(`simple:${simple}`);
  if (!keys.size) keys.add("blank");
  return Array.from(keys);
}

function pickSharedStock(primary: number | null | undefined, secondary: number | null | undefined) {
  const values = [primary, secondary].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );

  if (!values.length) return 0;
  return Math.min(...values);
}

export function useUnmergedProducts() {
  return useQuery({
    queryKey: ["unmerged-products"],
    queryFn: async (): Promise<UnmergedProduct[]> => {
      const products = await fetchAllPages<{ id: string; name: string; sku: string | null }>(
        async (from, to) => {
          const { data, error } = await supabase
            .from("products")
            .select("id, name, sku")
            .eq("active", true)
            .order("name")
            .range(from, to);
          return { data, error };
        },
        PAGE_SIZE,
      );
      if (!products.length) return [];

      const productIds = products.map((product) => product.id);
      const variants = await fetchByIds<{ id: string; product_id: string }>(
        "variants",
        "product_id",
        productIds,
        "id, product_id",
      );

      const variantIds = variants.map((variant) => variant.id);
      const listings = await fetchByIds<{
        id: string;
        variant_id: string;
        channel: string;
        channel_price: number | null;
        channel_product_id: string | null;
      }>(
        "channel_listings",
        "variant_id",
        variantIds,
        "id, variant_id, channel, channel_price, channel_product_id",
      );

      const variantsByProduct = new Map<string, typeof variants>();
      for (const variant of variants) {
        const bucket = variantsByProduct.get(variant.product_id) ?? [];
        bucket.push(variant);
        variantsByProduct.set(variant.product_id, bucket);
      }

      const listingsByVariant = new Map<string, typeof listings>();
      for (const listing of listings) {
        const bucket = listingsByVariant.get(listing.variant_id) ?? [];
        bucket.push(listing);
        listingsByVariant.set(listing.variant_id, bucket);
      }

      const result: UnmergedProduct[] = [];
      for (const product of products) {
        const productVariants = variantsByProduct.get(product.id) ?? [];
        const productListings = productVariants.flatMap(
          (variant) => listingsByVariant.get(variant.id) ?? [],
        );

        const channels = new Set(productListings.map((listing) => listing.channel));
        if (channels.size === 1) {
          const channel = [...channels][0] as "ebay" | "squarespace";
          const listing = productListings[0];
          const variant = productVariants[0];

          if (listing && variant) {
            result.push({
              id: product.id,
              name: product.name,
              sku: product.sku,
              channel,
              channel_price: listing.channel_price,
              channel_product_id: listing.channel_product_id,
              variant_id: variant.id,
              listing_id: listing.id,
            });
          }
        }
      }

      return result;
    },
  });
}

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
      const now = new Date().toISOString();

      const { data: selectedProducts, error: productErr } = await supabase
        .from("products")
        .select("id, name")
        .in("id", [keepId, removeId]);

      if (productErr) throw productErr;

      const keepProduct = (selectedProducts as ProductRow[] | null)?.find((product) => product.id === keepId);
      const removeProduct = (selectedProducts as ProductRow[] | null)?.find((product) => product.id === removeId);

      if (!keepProduct || !removeProduct) {
        throw new Error("Could not load the selected products.");
      }

      if (!areProductsCompatible(keepProduct.name, removeProduct.name)) {
        throw new Error("Those look like different colourways, so the merge was blocked to stop duplicate variants.");
      }

      const [keepVariantsResp, removeVariantsResp] = await Promise.all([
        supabase.from("variants").select("*").eq("product_id", keepId),
        supabase.from("variants").select("*").eq("product_id", removeId),
      ]);

      if (keepVariantsResp.error) throw keepVariantsResp.error;
      if (removeVariantsResp.error) throw removeVariantsResp.error;

      const keepVariants = (keepVariantsResp.data ?? []) as VariantRow[];
      const removeVariants = (removeVariantsResp.data ?? []) as VariantRow[];
      const removeVariantIds = removeVariants.map((variant) => variant.id);
      const allVariantIds = [...keepVariants.map((variant) => variant.id), ...removeVariantIds];

      const [inventoriesResp, listingsResp] = await Promise.all([
        allVariantIds.length
          ? supabase
              .from("inventory")
              .select("id, variant_id, product_id, total_stock, reserved_stock, low_stock_threshold, location, updated_at")
              .in("variant_id", allVariantIds)
          : Promise.resolve({ data: [], error: null }),
        removeVariantIds.length
          ? supabase
              .from("channel_listings")
              .select("id, variant_id, channel, channel_price, channel_product_id, channel_variant_id, channel_sku, last_synced_at, updated_at")
              .in("variant_id", removeVariantIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (inventoriesResp.error) throw inventoriesResp.error;
      if (listingsResp.error) throw listingsResp.error;

      const inventories = (inventoriesResp.data ?? []) as InventoryRow[];
      const removeListings = (listingsResp.data ?? []) as ChannelListingRow[];

      const inventoryByVariantId = new Map<string, InventoryRow>();
      for (const inventory of inventories) {
        if (inventory.variant_id && !inventoryByVariantId.has(inventory.variant_id)) {
          inventoryByVariantId.set(inventory.variant_id, inventory);
        }
      }

      const listingsByVariantId = new Map<string, ChannelListingRow[]>();
      for (const listing of removeListings) {
        const bucket = listingsByVariantId.get(listing.variant_id) ?? [];
        bucket.push(listing);
        listingsByVariantId.set(listing.variant_id, bucket);
      }

      const keepVariantByKey = new Map<string, VariantRow>();
      for (const variant of keepVariants) {
        for (const key of getVariantKeys(variant)) {
          if (!keepVariantByKey.has(key)) {
            keepVariantByKey.set(key, variant);
          }
        }
      }

      const movedVariantIds: string[] = [];
      const movedInventoryIds: string[] = [];
      const linkedVariants: LinkedVariantAction[] = [];

      for (const sourceVariant of removeVariants) {
        const matchingVariant = getVariantKeys(sourceVariant)
          .map((key) => keepVariantByKey.get(key))
          .find(Boolean);

        if (!matchingVariant) {
          const { error: moveVariantErr } = await supabase
            .from("variants")
            .update({ product_id: keepId, needs_sync: true, updated_at: now })
            .eq("id", sourceVariant.id);

          if (moveVariantErr) throw moveVariantErr;
          movedVariantIds.push(sourceVariant.id);

          const sourceInventory = inventoryByVariantId.get(sourceVariant.id);
          if (sourceInventory) {
            const { error: moveInventoryErr } = await supabase
              .from("inventory")
              .update({ product_id: keepId, updated_at: now })
              .eq("id", sourceInventory.id);

            if (moveInventoryErr) throw moveInventoryErr;
            movedInventoryIds.push(sourceInventory.id);
          }

          continue;
        }

        const sourceListings = listingsByVariantId.get(sourceVariant.id) ?? [];
        const movedListingIds = sourceListings.map((listing) => listing.id);
        if (movedListingIds.length) {
          const { error: moveListingErr } = await supabase
            .from("channel_listings")
            .update({ variant_id: matchingVariant.id, updated_at: now })
            .in("id", movedListingIds);

          if (moveListingErr) throw moveListingErr;
        }

        const targetInventory = inventoryByVariantId.get(matchingVariant.id) ?? null;
        const sourceInventory = inventoryByVariantId.get(sourceVariant.id) ?? null;

        let targetInventoryId: string | null = null;
        let targetPreviousStock: number | null = null;
        let sourceInventoryReassigned = false;

        if (targetInventory && sourceInventory) {
          targetInventoryId = targetInventory.id;
          targetPreviousStock = targetInventory.total_stock;
          const sharedStock = pickSharedStock(targetInventory.total_stock, sourceInventory.total_stock);

          if (sharedStock !== targetInventory.total_stock) {
            const { error: syncInventoryErr } = await supabase
              .from("inventory")
              .update({ total_stock: sharedStock, updated_at: now })
              .eq("id", targetInventory.id);

            if (syncInventoryErr) throw syncInventoryErr;
            inventoryByVariantId.set(matchingVariant.id, {
              ...targetInventory,
              total_stock: sharedStock,
              updated_at: now,
            });
          }
        } else if (!targetInventory && sourceInventory) {
          const { error: reassignInventoryErr } = await supabase
            .from("inventory")
            .update({ variant_id: matchingVariant.id, product_id: keepId, updated_at: now })
            .eq("id", sourceInventory.id);

          if (reassignInventoryErr) throw reassignInventoryErr;
          sourceInventoryReassigned = true;
          inventoryByVariantId.delete(sourceVariant.id);
          inventoryByVariantId.set(matchingVariant.id, {
            ...sourceInventory,
            variant_id: matchingVariant.id,
            product_id: keepId,
            updated_at: now,
          });
        }

        const { error: syncVariantErr } = await supabase
          .from("variants")
          .update({ needs_sync: true, updated_at: now })
          .eq("id", matchingVariant.id);

        if (syncVariantErr) throw syncVariantErr;

        linkedVariants.push({
          source_variant_id: sourceVariant.id,
          target_variant_id: matchingVariant.id,
          moved_listing_ids: movedListingIds,
          target_inventory_id: targetInventoryId,
          target_previous_stock: targetPreviousStock,
          source_inventory_id: sourceInventory?.id ?? null,
          source_inventory_reassigned: sourceInventoryReassigned,
        });
      }

      const { error: deactivateErr } = await supabase
        .from("products")
        .update({ active: false, updated_at: now })
        .eq("id", removeId);

      if (deactivateErr) throw deactivateErr;

      const action: MergeAction = {
        kept_product_id: keepId,
        removed_product_id: removeId,
        moved_variant_ids: movedVariantIds,
        moved_listing_ids: linkedVariants.flatMap((variant) => variant.moved_listing_ids),
        moved_inventory_ids: movedInventoryIds,
        linked_variants: linkedVariants,
        timestamp: now,
      };

      const history = readMergeHistory();
      history.push(action);
      writeMergeHistory(history);

      return action;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Products merged successfully");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to merge products");
    },
  });
}

export function useUndoMerge() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const history = readMergeHistory();
      const last = history.pop();
      if (!last) throw new Error("No merge to undo");

      const now = new Date().toISOString();

      if (last.moved_variant_ids.length) {
        const { error: undoVariantErr } = await supabase
          .from("variants")
          .update({
            product_id: last.removed_product_id,
            updated_at: now,
          })
          .in("id", last.moved_variant_ids);

        if (undoVariantErr) throw undoVariantErr;
      }

      if (last.moved_inventory_ids.length) {
        const { error: undoInventoryErr } = await supabase
          .from("inventory")
          .update({ product_id: last.removed_product_id, updated_at: now })
          .in("id", last.moved_inventory_ids);

        if (undoInventoryErr) throw undoInventoryErr;
      }

      for (const linkedVariant of last.linked_variants ?? []) {
        if (linkedVariant.moved_listing_ids.length) {
          const { error: undoListingErr } = await supabase
            .from("channel_listings")
            .update({ variant_id: linkedVariant.source_variant_id, updated_at: now })
            .in("id", linkedVariant.moved_listing_ids);

          if (undoListingErr) throw undoListingErr;
        }

        if (linkedVariant.source_inventory_reassigned && linkedVariant.source_inventory_id) {
          const { error: undoReassignErr } = await supabase
            .from("inventory")
            .update({
              variant_id: linkedVariant.source_variant_id,
              product_id: last.removed_product_id,
              updated_at: now,
            })
            .eq("id", linkedVariant.source_inventory_id);

          if (undoReassignErr) throw undoReassignErr;
        }

        if (
          !linkedVariant.source_inventory_reassigned &&
          linkedVariant.target_inventory_id &&
          linkedVariant.target_previous_stock !== null
        ) {
          const { error: undoStockErr } = await supabase
            .from("inventory")
            .update({
              total_stock: linkedVariant.target_previous_stock,
              updated_at: now,
            })
            .eq("id", linkedVariant.target_inventory_id);

          if (undoStockErr) throw undoStockErr;
        }
      }

      const { error: reactivateErr } = await supabase
        .from("products")
        .update({ active: true, updated_at: now })
        .eq("id", last.removed_product_id);

      if (reactivateErr) throw reactivateErr;

      writeMergeHistory(history);
      return last;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmerged-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Merge undone");
    },
    onError: () => {
      toast.error("Failed to undo merge");
    },
  });
}

export function useMergeHistory() {
  const [history, setHistory] = useState<MergeAction[]>(() => readMergeHistory());

  const refresh = () => {
    setHistory(readMergeHistory());
  };

  return { history, refresh };
}
