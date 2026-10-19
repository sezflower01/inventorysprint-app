/**
 * FBM Shipping Label Cost dialog.
 *
 * Resolution chain (sync-fbm-label-cost edge function):
 *   1. Merchant Fulfillment API (Buy Shipping rate)  -> source='buy_shipping_rate'  (within minutes)
 *   2. Amazon Finances by order ID                   -> source='amazon_finances'    (hours-to-days later)
 *   3. Amazon Finances date-range scan               -> source='amazon_finances'
 *   4. Manual entry                                  -> source='manual'
 *
 * Settlement reconciliation (source='settlement') happens automatically when FEC
 * posts the confirmed amount; it may overwrite earlier captured values.
 *
 * Background poller (poll-fbm-label-costs cron) auto-retries FBM orders younger
 * than 7 days every 30 min until a fee is found.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Truck, RefreshCw, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";

interface FbmOrderRow {
  id: string;
  order_id: string;
  order_date: string | null;
  order_status: string | null;
  fulfillment_channel: string | null;
  marketplace: string | null;
  quantity: number | null;
  sold_price: number | null;
  estimated_price: number | null;
  shipping_label_fee: number | null;
  shipping_label_fee_source: string | null;
  shipping_label_fee_synced_at: string | null;
  /** Positive only on FBA orders, so it is proof the row is NOT FBM. */
  fba_fee?: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  asin: string;
  rangeStart: string; // YYYY-MM-DD
  rangeEnd: string;   // YYYY-MM-DD
  onUpdated?: () => void;
}

// Each row's shipping_label_fee/sold_price is stored in THAT order's own
// marketplace currency (Amazon's Buy Shipping / Finances APIs never
// convert), and manual entries are written back verbatim into the same
// column. So the symbol shown/typed must match the row's own marketplace,
// never a single seller-wide home-currency symbol.
function symbolFor(marketplace: string | null | undefined): string {
  return getMarketplaceConfig(String(marketplace || "US").toUpperCase()).currencySymbol;
}

export default function FbmLabelCostDialog({
  open, onOpenChange, asin, rangeStart, rangeEnd, onUpdated,
}: Props) {
  const { toast } = useToast();
  const [rows, setRows] = useState<FbmOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!asin || !open) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("sales_orders")
        .select("id, order_id, order_date, order_status, fulfillment_channel, marketplace, quantity, sold_price, estimated_price, shipping_label_fee, shipping_label_fee_source, shipping_label_fee_synced_at, fba_fee")
        .eq("asin", asin)
        .gte("order_date", rangeStart)
        .lte("order_date", rangeEnd)
        .not("order_id", "like", "%-REFUND")
        .order("order_date", { ascending: false })
        .limit(100);
      if (error) throw error;
      setRows(((data ?? []) as FbmOrderRow[]).filter((row) => {
        const channel = String(row.fulfillment_channel || "").toUpperCase();
        if (channel.startsWith("AFN")) return false;
        if (channel.startsWith("MFN")) return true;
        // UNTAGGED. `channel !== "AFN"` used to let these through, which meant
        // a missing tag was read as "this is FBM, a label fee is coming". That
        // default is wrong far more often than it is right: 1,774 of 2,743
        // October orders carry no fulfillment_channel at all (65 pct).
        //
        // Measured 2026-10-19 on the six rows the seller was typing in by
        // hand, all ASIN B08229T8SS: two carry fba_fee 4.36, so they are FBA
        // and NO seller-paid label will ever exist for them -- yet they showed
        // "awaiting label fee" indefinitely and the poller would not touch
        // them either, because it filters .eq("fulfillment_channel","MFN")
        // while this list filtered !== "AFN". The two criteria disagreed, and
        // the gap was the seller doing data entry.
        //
        // An FBA fulfilment fee is Amazon charging to ship it, which only
        // happens on FBA, so it is positive proof this is not FBM. Without
        // that proof the row is still shown (it may genuinely be FBM) but the
        // caller can label it honestly rather than promising a fee.
        return Number(row.fba_fee || 0) <= 0;
      }));
    } catch (err) {
      toast({ title: "Failed to load FBM orders", description: (err as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [asin, rangeStart, rangeEnd, open, toast]);

  useEffect(() => { void load(); }, [load]);

  const runSync = async (row: FbmOrderRow, manualAmount?: number) => {
    setBusyId(row.id);
    try {
      const body: Record<string, unknown> = { sales_order_id: row.id, order_id: row.order_id };
      if (manualAmount != null) body.manual_amount = manualAmount;
      const { data, error } = await supabase.functions.invoke("sync-fbm-label-cost", { body });
      if (error) throw error;
      const r = data as { success?: boolean; found?: boolean; source?: string; amount?: number; reason?: string };
      if (r?.success && r?.found !== false) {
        const sourceLabel = r.source === "buy_shipping_rate" ? "Buy Shipping rate"
          : r.source === "amazon_finances" ? "Amazon Finances"
          : r.source === "settlement" ? "Settlement"
          : r.source === "manual" ? "Manual entry"
          : "Amazon";
        toast({
          title: `Saved (${sourceLabel})`,
          description: `${symbolFor(row.marketplace)}${(r.amount ?? 0).toFixed(2)} applied to order ${row.order_id}`,
        });
        setManualValues((m) => ({ ...m, [row.id]: "" }));
        await load();
        onUpdated?.();
      } else {
        toast({
          title: "Amazon hasn't posted the label fee yet",
          description: r?.reason ?? "We'll keep checking in the background. You can also enter it manually below.",
        });
      }
    } catch (err) {
      toast({ title: "Sync failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4" /> FBM Shipping Label Cost — {asin}
          </DialogTitle>
          <DialogDescription>
            We try Amazon's Buy Shipping rate first (usually available within minutes), then Amazon Finances (hours-to-days later), then settlement reconciliation. If none have posted yet, you can enter it manually. The cost is treated as an order-level fee and reduces profit for that order only — it does <strong>not</strong> change COGS or ROI denominator.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto -mx-2 px-2">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              No seller-fulfilled orders found for this ASIN in the selected period.
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => {
                const price = row.sold_price ?? row.estimated_price ?? 0;
                const hasFee = (row.shipping_label_fee ?? 0) > 0;
                const rowSymbol = symbolFor(row.marketplace);
                const sourceTag = row.shipping_label_fee_source;
                const sourceLabel = (() => {
                  switch (sourceTag) {
                    case "buy_shipping_rate": return "Buy Shipping rate";
                    case "amazon_finances":   return "Amazon Finances";
                    case "settlement":        return "Settlement";
                    case "manual":            return "Manual entry";
                    case "amazon":            return "Amazon Finances"; // legacy
                    default:                  return sourceTag ?? "label";
                  }
                })();
                const sourceClass = (() => {
                  switch (sourceTag) {
                    case "buy_shipping_rate": return "bg-blue-500/10 text-blue-600 border border-blue-500/30";
                    case "amazon_finances":
                    case "amazon":            return "bg-amber-500/10 text-amber-700 border border-amber-500/30";
                    case "settlement":        return "bg-emerald-500/10 text-emerald-700 border border-emerald-500/30";
                    case "manual":            return "bg-muted text-muted-foreground border border-border";
                    default:                  return "bg-muted text-muted-foreground border border-border";
                  }
                })();
                return (
                  <div key={row.id} className="rounded-lg border border-border p-3 space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="text-xs">
                        <p className="font-mono font-semibold">{row.order_id}</p>
                        <p className="text-muted-foreground">
                          {row.order_date} · {row.order_status || "order"} · qty {row.quantity ?? 1} · {rowSymbol}{price.toFixed(2)}
                        </p>
                      </div>
                      <div className="text-right text-xs">
                        {hasFee ? (
                          <>
                            <p className="font-bold text-emerald-600 tabular-nums">
                              −{rowSymbol}{(row.shipping_label_fee ?? 0).toFixed(2)}
                            </p>
                            <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide font-semibold ${sourceClass}`}>
                              {sourceLabel}
                            </span>
                          </>
                        ) : (
                          <p className="text-[10px] uppercase text-muted-foreground">
                            {String(row.fulfillment_channel || "").toUpperCase().startsWith("MFN")
                              ? "awaiting label fee"
                              : "channel not reported by Amazon — may not be FBM"}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px] gap-1"
                        disabled={busyId === row.id}
                        onClick={() => runSync(row)}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Check Amazon now
                      </Button>
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-muted-foreground">{rowSymbol}</span>
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          placeholder="manual"
                          value={manualValues[row.id] ?? ""}
                          onChange={(e) => setManualValues((m) => ({ ...m, [row.id]: e.target.value }))}
                          className="h-7 w-24 text-[11px]"
                        />
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-[11px] gap-1"
                          disabled={busyId === row.id || !manualValues[row.id]}
                          onClick={() => {
                            const v = Number(manualValues[row.id]);
                            if (!Number.isFinite(v) || v < 0) {
                              toast({ title: "Enter a valid amount", variant: "destructive" });
                              return;
                            }
                            void runSync(row, v);
                          }}
                        >
                          <Check className="h-3 w-3" />
                          Save
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
