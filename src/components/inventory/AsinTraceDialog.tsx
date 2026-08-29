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

/** A shipment where Amazon checked in fewer units than were sent. */
type Discrepancy = {
  shipmentId: string;
  name: string | null;
  status: string | null;
  receivedDate: string | null;
  shipDate: string | null;
  shipped: number;
  received: number;
};

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
  discrepancies: Discrepancy[];
  receivedContradicted: boolean;
};

// Days Amazon allows a shipment discrepancy to be claimed after the shipment
// closes.
//
// 90 was reported from experience on 2026-08-28, after a seller found March
// shipments already auto-closed and unclaimable having believed the window was
// 18 months. It is NOT quoted from Amazon policy here, and Amazon has changed
// these terms more than once -- which is exactly why the UI labels anything
// near the edge as "verify" rather than asserting a deadline it cannot know.
//
// Set conservatively on purpose: warning too early costs a wasted look, warning
// too late costs the whole claim.
const CLAIM_WINDOW_DAYS = 90;
const CLAIM_WARN_DAYS = 21;

/**
 * Collapse an Amazon placement split back into the plan it came from.
 *
 * Amazon's placement service routinely splits one plan across several
 * fulfilment centres, naming them identically bar a suffix:
 *
 *   FBA STA (04/22/2026 00:06)-FWA4
 *   FBA STA (04/22/2026 00:06)-GYR2   ... and so on
 *
 * Listed flat, one shortfall becomes five near-identical "-1" lines and reads
 * as duplicated data -- it was reported as exactly that on 2026-08-28. The
 * split is real and each part keeps its own shipment id and Seller Central
 * page, so the parts are preserved; only the presentation is grouped.
 *
 * Falls back to the shipment id when there is no name, so an unnamed shipment
 * simply becomes its own group rather than being lumped in with others.
 */
function planKey(name: string | null, shipmentId: string): string {
  if (!name) return shipmentId;
  const m = name.match(/^(.*)-[A-Z0-9]{3,5}$/);
  return m ? m[1] : name;
}

const daysSince = (v: string | null): number | null => {
  if (!v) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
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
        supabase.from("fba_shipment_items").select("shipment_id, quantity_shipped, quantity_received").eq("user_id", user.id).eq("asin", asin),
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

      // Per-shipment shortfalls. Amazon reconciles a claim against a specific
      // shipment, so an ASIN-level total is not actionable -- the seller needs
      // to know WHICH shipment to open.
      const shortfalls = (sRows as any[]).filter(
        (r) => r.shipment_id && (Number(r.quantity_shipped) || 0) > (Number(r.quantity_received) || 0),
      );
      // Whether the received figures can be trusted at all for this ASIN.
      // If more units sold than Amazon supposedly received, the received data
      // is wrong rather than the units being missing -- so the shortfalls are
      // shown as unverified rather than as claims. Filing against these would
      // be contradicted by the seller's own order history.
      const totalShipped = (sRows as any[]).reduce((n, r) => n + (Number(r.quantity_shipped) || 0), 0);
      const totalReceived = (sRows as any[]).reduce((n, r) => n + (Number(r.quantity_received) || 0), 0);
      let discrepancies: Discrepancy[] = [];
      if (shortfalls.length > 0) {
        const ids = Array.from(new Set(shortfalls.map((r) => r.shipment_id)));
        const { data: shipMeta } = await supabase
          .from("fba_shipments")
          .select("shipment_id, shipment_name, shipment_status, received_date, ship_date, last_updated_date")
          .eq("user_id", user.id)
          .in("shipment_id", ids);
        const metaById = new Map((shipMeta ?? []).map((m: any) => [m.shipment_id, m]));
        discrepancies = shortfalls.map((r) => {
          const m: any = metaById.get(r.shipment_id);
          return {
            shipmentId: r.shipment_id,
            name: m?.shipment_name ?? null,
            status: m?.shipment_status ?? null,
            receivedDate: m?.received_date ?? null,
            // ship_date and last_updated_date as fallbacks. An old shipment can
            // be CLOSED with no received_date, and the row would otherwise show
            // no date at all -- leaving the table's Age column (which measures
            // the PURCHASE, not the shipment) to be read as the shipment age.
            // Reported 2026-08-28: a row showed 169d while its shipments were
            // dated 22 April, ~128 days.
            shipDate: m?.ship_date ?? m?.last_updated_date ?? null,
            shipped: Number(r.quantity_shipped) || 0,
            received: Number(r.quantity_received) || 0,
          };
        }).sort((a, b) => (b.shipped - b.received) - (a.shipped - a.received));
      }

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
        discrepancies,
        // soldTotal is computed from byMarket above; recompute inline so this
        // does not depend on render-time state.
        receivedContradicted:
          totalShipped > 0 &&
          (Array.from(byMarket.values()).reduce((n, m) => n + m.units, 0)
            + (iRows as any[]).reduce((n, r) => n + (Number(r.available) || 0) + (Number(r.reserved) || 0), 0))
          >= totalReceived + (totalShipped - totalReceived),
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

            {trace.discrepancies.length > 0 && (
              <div className="rounded-md border border-orange-500/40 bg-orange-500/10 p-3">
                <div className="text-xs uppercase tracking-wide text-orange-700 dark:text-orange-400 font-semibold mb-1.5">
                  {trace.receivedContradicted
                    ? "Shipment records — received counts look stale"
                    : "Shipment shortfalls — reimbursement claims"}
                </div>
                <div className="text-xs text-muted-foreground mb-2">
                  {trace.receivedContradicted ? (
                    <>
                      <strong className="text-foreground">Do not file these as claims.</strong>{" "}
                      More units have sold or are in stock than Amazon is recorded as having
                      received, so the received figures below are stale rather than the units
                      being missing. Listed only so you can check the shipments yourself.
                    </>
                  ) : (
                    <>
                      Amazon checked in fewer units than were sent. Each link opens that
                      shipment&apos;s contents page in Seller Central, where the claim is filed.
                    </>
                  )}
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {Object.values(
                      trace.discrepancies.reduce((acc, d) => {
                        const k = planKey(d.name, d.shipmentId);
                        (acc[k] ??= { key: k, parts: [] as Discrepancy[] }).parts.push(d);
                        return acc;
                      }, {} as Record<string, { key: string; parts: Discrepancy[] }>),
                    )
                      .sort((a, b) =>
                        b.parts.reduce((n, d) => n + d.shipped - d.received, 0) -
                        a.parts.reduce((n, d) => n + d.shipped - d.received, 0))
                      .map((group) => {
                        const first = group.parts[0];
                        const shipped = group.parts.reduce((n, d) => n + d.shipped, 0);
                        const received = group.parts.reduce((n, d) => n + d.received, 0);
                        const d: Discrepancy = {
                          ...first,
                          name: group.key,
                          shipped,
                          received,
                        };
                        const split = group.parts.length > 1 ? group.parts : null;
                        return { d, split, key: group.key };
                      })
                      .map(({ d, split, key }) => (
                      <tr key={key} className="border-b border-orange-500/20 last:border-0">
                        <td className="py-1.5">
                          {split ? (
                            // A split plan has no single Seller Central page --
                            // each destination is reconciled separately -- so
                            // every part keeps its own link.
                            <>
                              <span className="font-medium">{d.name}</span>
                              <span className="block text-[10px] text-muted-foreground">
                                split across {split.length} fulfilment centres
                                {(d.receivedDate || d.shipDate) && <> · {fmtDate(d.receivedDate || d.shipDate)}</>}
                              </span>
                              <span className="mt-1 flex flex-wrap gap-1">
                                {split.map((part) => (
                                  <a
                                    key={part.shipmentId}
                                    href={`https://sellercentral.amazon.com/fba/inbound-shipment/summary/${part.shipmentId}/contents`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] font-mono rounded border border-orange-500/40 px-1 py-0.5 text-primary hover:underline"
                                    title={`${part.shipmentId} — ${part.shipped} sent / ${part.received} received`}
                                  >
                                    {(part.name || "").match(/-([A-Z0-9]{3,5})$/)?.[1] ?? part.shipmentId}
                                  </a>
                                ))}
                              </span>
                            </>
                          ) : (
                            <>
                              <a
                                href={`https://sellercentral.amazon.com/fba/inbound-shipment/summary/${d.shipmentId}/contents`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline inline-flex items-center gap-1"
                              >
                                {d.name || d.shipmentId}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                              <span className="block text-[10px] text-muted-foreground font-mono">
                                {d.shipmentId}{d.status ? ` · ${d.status}` : ""}
                                {(d.receivedDate || d.shipDate) && (
                                  <> · {fmtDate(d.receivedDate || d.shipDate)}</>
                                )}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="py-1.5 text-right text-xs text-muted-foreground whitespace-nowrap">
                          {d.shipped} sent / {d.received} received
                        </td>
                        <td className="py-1.5 text-right font-semibold tabular-nums text-orange-700 dark:text-orange-400">
                          −{d.shipped - d.received}
                          {(() => {
                            // Counted from received_date, the closest thing in
                            // our data to when the shipment closed. Where it is
                            // absent nothing is claimed either way -- a guessed
                            // deadline is worse than none.
                            const age = daysSince(d.receivedDate ?? d.shipDate);
                            if (age == null) {
                              return (
                                <span className="block text-[10px] font-normal text-muted-foreground">
                                  no close date — check
                                </span>
                              );
                            }
                            const left = CLAIM_WINDOW_DAYS - age;
                            if (left <= 0) {
                              return (
                                <span className="block text-[10px] font-normal text-muted-foreground">
                                  {age}d old — likely closed
                                </span>
                              );
                            }
                            return (
                              <span className={`block text-[10px] font-semibold ${
                                left <= CLAIM_WARN_DAYS ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"
                              }`}>
                                {left}d left to claim
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                      ))}
                  </tbody>
                </table>
                <div className="text-[10px] text-muted-foreground mt-2">
                  Countdown assumes a {CLAIM_WINDOW_DAYS}-day window from the received date.
                  Amazon has changed these terms before and they differ by claim type — treat
                  this as a prompt to check, not as the deadline itself. Anything showing
                  &quot;likely closed&quot; is still worth opening once: Amazon auto-reimburses some
                  discrepancies without a claim.
                </div>
              </div>
            )}

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
