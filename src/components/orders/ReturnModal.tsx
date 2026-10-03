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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateRefund } from "@/hooks/use-refunds";
import type { OrderRow } from "@/hooks/use-orders";

const REASONS = [
  "Changed mind",
  "Not as described",
  "Damaged / faulty",
  "Arrived late",
  "Wrong item",
  "Other",
];

export function ReturnModal({
  order,
  onClose,
}: {
  order: OrderRow | null;
  onClose: () => void;
}) {
  const create = useCreateRefund();
  const [amount, setAmount] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState(REASONS[0]);
  const [restock, setRestock] = useState("restock");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (order) {
      setAmount(String(order.total_price ?? order.unit_price ?? 0));
      setQty(String(order.quantity ?? 1));
      setReason(REASONS[0]);
      setRestock("restock");
      setNote("");
    }
  }, [order?.id]);

  if (!order) return null;

  const submit = () => {
    create.mutate(
      {
        platform: order.platform,
        orderId: order.platform_order_id,
        orderNumber: order.order_number,
        productId: order.product_id,
        sku: order.sku,
        itemName: order.item_name,
        amount: parseFloat(amount) || 0,
        reason,
        note: note.trim() || undefined,
        quantity: parseInt(qty, 10) || 1,
        restock: restock === "restock",
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={!!order} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Process return / refund</DialogTitle>
          <DialogDescription>
            {order.item_name ?? order.sku} · {order.platform} ·{" "}
            {order.order_number ?? order.platform_order_id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Refund amount (£)</label>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Quantity</label>
              <Input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>
          </div>

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

          <div className="space-y-2">
            <label className="text-sm font-medium">What happens to the stock?</label>
            <RadioGroup value={restock} onValueChange={setRestock} className="gap-2">
              <label className="flex items-start gap-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/40">
                <RadioGroupItem value="restock" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Back to stock</span>
                  <span className="block text-xs text-muted-foreground">
                    Item is resellable — add {qty || 1} back and push to both channels.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/40">
                <RadioGroupItem value="writeoff" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Write off</span>
                  <span className="block text-xs text-muted-foreground">
                    Damaged or kept by buyer — record the loss, leave stock as-is.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Comments (optional)</label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything worth noting…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Record refund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
