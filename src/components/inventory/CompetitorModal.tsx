import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLink, RefreshCw, Loader2 } from "lucide-react";
import { useCompetitorPrices, useRunCompetitorCheck } from "@/hooks/use-competitor";

export interface CompetitorTarget {
  variantId: string;
  productName: string;
  query: string;
  yourDelivered: number | null; // your eBay price = delivered, postage is free
}

const gbp = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `£${Number(n).toFixed(2)}`;

export function CompetitorModal({
  target,
  onClose,
}: {
  target: CompetitorTarget | null;
  onClose: () => void;
}) {
  const { data: rows = [], isLoading } = useCompetitorPrices(target?.variantId ?? null);
  const check = useRunCompetitorCheck();

  if (!target) return null;

  const cheapest = rows.length ? rows[0].delivered ?? null : null;
  const you = target.yourDelivered;
  const position =
    you !== null && cheapest !== null
      ? you <= cheapest
        ? "You are the cheapest delivered."
        : `£${(you - cheapest).toFixed(2)} dearer than the cheapest.`
      : null;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>eBay delivered prices</DialogTitle>
          <DialogDescription>{target.productName}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-3 mb-2">
          <div>
            <p className="text-xs text-muted-foreground">Your delivered price</p>
            <p className="text-lg font-bold">{gbp(you)}</p>
          </div>
          {position && (
            <p
              className={`text-sm font-medium ${
                you !== null && cheapest !== null && you <= cheapest
                  ? "text-success"
                  : "text-destructive"
              }`}
            >
              {position}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              check.mutate({ variantId: target.variantId, query: target.query })
            }
            disabled={check.isPending}
          >
            {check.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No competitor prices stored yet. Hit Refresh to pull current eBay listings.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 font-medium">Seller</th>
                  <th className="py-2 font-medium text-right">Item</th>
                  <th className="py-2 font-medium text-right">P&amp;P</th>
                  <th className="py-2 font-medium text-right">Delivered</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-2 truncate max-w-[140px]">{r.seller ?? "—"}</td>
                    <td className="py-2 text-right">{gbp(r.item_price)}</td>
                    <td className="py-2 text-right">{gbp(r.postage)}</td>
                    <td className="py-2 text-right font-semibold">{gbp(r.delivered)}</td>
                    <td className="py-2 pl-2 text-right">
                      {r.url && (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex text-primary hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {rows.length > 0 && rows[0].checked_at && (
          <p className="text-[11px] text-muted-foreground text-right">
            Checked {new Date(rows[0].checked_at).toLocaleString("en-GB")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
