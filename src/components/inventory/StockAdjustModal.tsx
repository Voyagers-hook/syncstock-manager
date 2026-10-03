import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useStockAdjust, useStockHistory } from "@/hooks/use-stock-adjust";

export interface StockAdjustTarget {
  productName: string;
  variantLabel: string | null;
  inventoryId: string;
  variantId: string;
  productId: string;
  currentStock: number;
}

const REASONS = [
  "Stock take / correction",
  "New stock arrived",
  "Damaged / discarded",
  "Used / sample",
  "Lost",
  "Other",
];

export function StockAdjustModal({
  target,
  onClose,
}: {
  target: StockAdjustTarget | null;
  onClose: () => void;
}) {
  const adjust = useStockAdjust();
  const history = useStockHistory();
  const [value, setValue] = useState<string>("");
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    if (target) {
      setValue(String(target.currentStock));
      setReason(REASONS[0]);
      setNote("");
      history.mutate(target.variantId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.variantId]);

  if (!target) return null;

  const newStock = parseInt(value, 10);
  const valid = !isNaN(newStock) && newStock >= 0;
  const delta = valid ? newStock - target.currentStock : 0;

  const save = () => {
    if (!valid) {
      toast.error("Enter a valid stock number (0 or more).");
      return;
    }
    if (newStock === target.currentStock) {
      toast.info("That is the same as the current stock.");
      return;
    }
    adjust.mutate(
      {
        inventoryId: target.inventoryId,
        variantId: target.variantId,
        productId: target.productId,
        oldStock: target.currentStock,
        newStock,
        reason,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Stock updated and pushed to both channels.");
          onClose();
        },
        onError: (e: any) => toast.error(e.message),
      },
    );
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change stock</DialogTitle>
          <DialogDescription>
            {target.productName}
            {target.variantLabel ? ` — ${target.variantLabel}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="text-sm text-muted-foreground">
              Current: <span className="font-semibold text-foreground">{target.currentStock}</span>
            </div>
            <div className="flex-1" />
            <Input
              type="number"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-28 text-right"
              autoFocus
            />
          </div>
          {valid && delta !== 0 && (
            <p className={`text-xs ${delta > 0 ? "text-success" : "text-destructive"}`}>
              {delta > 0 ? "+" : ""}
              {delta} vs current
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Reason</label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Comments (optional)</label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything worth noting about this change…"
              rows={2}
            />
          </div>

          {Array.isArray(history.data) && history.data.length > 0 && (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Recent changes</p>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {history.data.map((h: any, i: number) => (
                  <div key={i} className="text-xs flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">
                      {h.changed_at ? new Date(h.changed_at).toLocaleDateString("en-GB") : ""}
                    </span>
                    <span className="font-medium">
                      {h.old_stock} → {h.new_stock}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {h.reason ?? h.source}
                      {h.note ? ` · ${h.note}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={adjust.isPending}>
            {adjust.isPending ? "Saving…" : "Save & push"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
