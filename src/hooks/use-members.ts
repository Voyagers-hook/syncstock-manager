import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Member {
  id: string;
  membership_number: string | null;
  name: string | null;
  email: string | null;
  tier: string;
  status: string;
  join_date: string | null;
  points_balance: number;
  lifetime_spend: number;
  spend_tier: string | null;
  discount_code: string | null;
  discount_used: boolean;
  source: string | null;
  email_aliases: string[] | null;
}

export interface LedgerRow {
  id: string;
  change: number;
  reason: string;
  ref: string | null;
  balance_after: number;
  note: string | null;
  created_at: string;
}

export interface CatalogItem {
  variant_id: string;
  product_name: string;
  options: string | null;
  sku: string | null;
  price: number | null;
  stock: number;
  points_value: number | null;
  active: boolean;
  flagged: boolean;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("members-admin", { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === "function") { const p = await ctx.json(); if (p?.error) msg = p.error; }
    } catch { /* keep */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export function useMembers(search: string) {
  return useQuery({
    queryKey: ["members", search],
    queryFn: () => call<{ members: Member[] }>({ action: "members", search }).then((r) => r.members),
    staleTime: 30_000,
  });
}

export function useMemberLedger(memberId: string | null) {
  return useQuery({
    queryKey: ["member-ledger", memberId],
    queryFn: () => call<{ ledger: LedgerRow[] }>({ action: "ledger", member_id: memberId }).then((r) => r.ledger),
    enabled: !!memberId,
  });
}

export function useAdjustPoints() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { member_id: string; delta: number; note?: string }) =>
      call<{ balance: number }>({ action: "adjust", ...v }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-ledger", v.member_id] });
    },
  });
}

export function useCatalog(search: string) {
  return useQuery({
    queryKey: ["points-catalog", search],
    queryFn: () => call<{ items: CatalogItem[] }>({ action: "catalog", search }).then((r) => r.items),
    staleTime: 15_000,
  });
}

export function useShopSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { variant_id: string; points_value: number; active?: boolean }) =>
      call({ action: "shop_set", ...v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["points-catalog"] }),
  });
}

export function useShopRemove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (variant_id: string) => call({ action: "shop_remove", variant_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["points-catalog"] }),
  });
}
