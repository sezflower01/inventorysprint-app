/**
 * "Where did the units go?" for a single ASIN.
 *
 * Built from a query that was being written by hand to answer a real case
 * (B0G8811NCN, 2026-08-28): 15 purchased, US Seller Central showed 1 sold, and
 * the remaining 14 looked lost. 12 of them had sold in CANADA.
 *
 * That is the whole reason this exists. CA/MX/BR are remote fulfilment and sell
 * out of the same physical US stock — `inventory` has no marketplace column at
 * all — so units leave without ever appearing in US Seller Central. Looking at
 * one marketplace and concluding stock is missing is the default mistake, and
 * it points the seller at their supplier for units that were simply sold.
 *
 * Sales are aggregated client-side because PostgREST has no GROUP BY. Scoped to
 * one ASIN that is fine; do not lift this pattern to a whole-catalogue view.
 */

import { useEffect, useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

type Props = {
  asin: string | null;
  title?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type MarketRow = { marketplace: string; units: number; refunded: number; last: string | null };

type Trace = {
  purchased: number;
  receivedFromSupplier: number | null;
  firstPurchase: string | null;
  shipped: number | null;
  receivedAtAmazon: number | null;
  onHand: number;
  inbound: number;
  hasInventoryRow: boolean;
  sales: MarketRow[];
};

const fmtDate = (v: string | null) => {
  if (!v) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
};

export default function AsinTraceDialog({ asin, title, open, onOpenChange }: Props) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [trace, setTrace] = useState<Trace | null>(null);

  useEffect(() => {
    if (!open || !asin || !user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setTrace(null);

      // user_id is filtered explicitly even though RLS already scopes these
      // tables. It matches how every other query in src/ is written, and it
      // means an RLS regression would show no rows rather than someone else's.
      const [purch, ship, inv] = await Promise.all([
        supabase.from("created_listings").select("units, received_quantity, date_created, created_at").eq("user_id", user.id).eq("asin", asin),
        supabase.from("fba_shipment_items").select("quantity_shipped, quantity_received").eq("user_id", user.id).eq("asin", asin),
        supabase.from("inventory").select("available, reserved, inbound").eq("user_id", user.id).eq("asin", asin),
      ]);

      // Paged. PostgREST caps a response at 1000 rows by default, and a
      // long-running ASIN can exceed that in orders alone — which would
      // silently understate units sold and manufacture an "unaccounted"
      // number out of nothing. That is the failure this dialog exists to
      // prevent, so it must not commit it itself.
      const oRows: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("sales_orders")
          .select("marketplace, quantity, refund_quantity, order_date")
          .eq("user_id", user.id)
          .eq("asin", asin)
          .range(from, from + 999);
        if (error) { console.warn("[asin-trace] sales_orders:", error.message); break; }
        const batch = data ?? [];
        oRows.push(...batch);
        if (batch.length < 1000) break;
      }
      if (cancelled) return;

      const pRows = purch.data ?? [];
      const sRows = ship.data ?? [];
      const iRows = inv.data ?? [];

      const byMarket = new Map<string, MarketRow>();
      for (const o of oRows as any[]) {
        const mk = o.marketplace || "—";
        const row = byMarket.get(mk) ?? { marketplace: mk, units: 0, refunded: 0, last: null };
        row.units += Number(o.quantity) || 0;
        row.refunded += Number(o.refund_quantity) || 0;
        if (o.order_date && (!row.last || o.order_date > row.last)) row.last = o.order_date;
        byMarket.set(mk, row);
      }

      const anyReceived = (pRows as any[]).some((r) => r.received_quantity != null);
      const dates = (pRows as any[])
        .map((r) => r.date_created || r.created_at)
        .filter(Boolean)
        .sort();

      setTrace({
        purchased: (pRows as any[]).reduce((n, r) => n + (Number(r.units) || 0), 0),
        // null, not 0: nobody has recorded it. Showing 0 would read as "the
        // supplier sent nothing", which is a very different claim.
        receivedFromSupplier: anyReceived
          ? (pRows as any[]).reduce((n, r) => n + (Number(r.received_quantity) || 0), 0)
          : null,
        firstPurchase: dates[0] ?? null,
        shipped: sRows.length ? (sRows as any[]).reduce((n, r) => n + (Number(r.quantity_shipped) || 0), 0) : null,
        receivedAtAmazon: sRows.length ? (sRows as any[]).reduce((n, r) => n + (Number(r.quantity_received) || 0), 0) : null,
        onHand: (iRows as any[]).reduce((n, r) => n + (Number(r.available) || 0) + (Number(r.reserved) || 0), 0),
        inbound: (iRows as any[]).reduce((n, r) => n + (Number(r.inbound) || 0), 0),
        hasInventoryRow: iRows.length > 0,
        sales: Array.from(byMarket.values()).sort((a, b) => b.units - a.units),
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, asin, user]);

  const soldTotal = trace?.sales.reduce((n, r) => n + r.units, 0) ?? 0;
  // Purchased minus everything that can be located. Negative means MORE was
  // sold than recorded as bought, which is a purchase-record gap rather than
  // missing stock — so it is labelled differently below.
  const unaccounted = trace ? trace.purchased - soldTotal - trace.onHand - trace.inbound : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            Unit trace
            {asin && (
              <a href={`https://www.amazon.com/dp/${asin}`} target="_blank" rel="noopener noreferrer"
                 className="ml-2 font-mono text-sm text-primary hover:underline inline-flex items-center gap-1">
                {asin}<ExternalLink className="h-3 w-3" />
              </a>
            )}
          </DialogTitle>
          {title && <div className="text-xs text-muted-foreground line-clamp-2">{title}</div>}
        </DialogHeader>

        {loading || !trace ? (
          <div className="flex items-center gap-2 justify-center p-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Tracing units…
          </div>
        ) : (
          <div className="space-y-4">
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b">
                  <td className="py-1.5 text-muted-foreground">Purchased</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">{trace.purchased}</td>
                  <td className="py-1.5 text-right text-xs text-muted-foreground">{fmtDate(trace.firstPurchase)}</td>
                </tr>
                <tr className="border-b">
                  <td className="py-1.5 text-muted-foreground">Received from supplier</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {trace.receivedFromSupplier ?? <span className="text-muted-foreground">not recorded</span>}
                  </td>
                  <td />
                </tr>
                <tr className="border-b">
                  <td className="py-1.5 text-muted-foreground">Shipped to Amazon</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {trace.shipped ?? <span className="text-muted-foreground">no shipment record</span>}
                  </td>
                  <td className="py-1.5 text-right text-xs text-muted-foreground">
                    {trace.receivedAtAmazon != null ? `${trace.receivedAtAmazon} received` : ""}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-1.5 text-muted-foreground">In stock now</td>
                  <td className="py-1.5 text-right tabular-nums">{trace.onHand}</td>
                  <td className="py-1.5 text-right text-xs text-muted-foreground">
                    {trace.inbound > 0 ? `${trace.inbound} inbound` : ""}
                  </td>
                </tr>
              </tbody>
            </table>

            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Sold, by marketplace</div>
              {trace.sales.length === 0 ? (
                <div className="text-sm text-muted-foreground">No sales recorded.</div>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {trace.sales.map((m) => (
                      <tr key={m.marketplace} className="border-b">
                        <td className="py-1.5">
                          <Badge variant="secondary" className="text-[11px]">{m.marketplace}</Badge>
                        </td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{m.units}</td>
                        <td className="py-1.5 text-right text-xs text-muted-foreground">
                          {m.refunded > 0 ? `${m.refunded} refunded · ` : ""}last {fmtDate(m.last)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="py-1.5 font-medium">Total sold</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{soldTotal}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              )}
            </div>

            <div className={`rounded-md p-3 text-sm ${
              unaccounted > 0 ? "bg-amber-500/10 border border-amber-500/30" : "bg-muted"
            }`}>
              {unaccounted > 0 ? (
                <>
                  <strong>{unaccounted} unit{unaccounted === 1 ? "" : "s"} unaccounted.</strong>{" "}
                  Not sold, not in stock, not inbound. Amazon's Inventory Ledger
                  (Reports → Fulfilment → Inventory Ledger) reconciles receipts, adjustments,
                  damage and removals and will say which.
                </>
              ) : unaccounted < 0 ? (
                <>
                  <strong>{Math.abs(unaccounted)} more sold than recorded as purchased.</strong>{" "}
                  The purchase record is incomplete rather than stock being missing — likely an
                  earlier buy that was never entered.
                </>
              ) : (
                <>Every purchased unit is accounted for.</>
              )}
            </div>

            <div className="text-[11px] text-muted-foreground leading-relaxed border-t pt-2">
              CA, MX and BR are remote fulfilment and sell from the same physical US stock, so units
              can leave without appearing in US Seller Central — check the marketplace breakdown
              before treating stock as missing.
              {trace.shipped == null && trace.hasInventoryRow && (
                <> No shipment record exists for this ASIN, which usually means it predates the FBA
                shipment sync rather than that nothing was ever sent.</>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
