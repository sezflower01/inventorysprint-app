import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { formatMarketplaceDate } from "@/lib/sales/dateLocale";
import { Loader2, RotateCw, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

interface FECRow {
  id: string;
  amazon_order_id: string | null;
  asin: string | null;
  marketplace: string | null;
  event_date: string | null;
  sales: number | null;
  refunds: number | null;
  promotional_rebate_refunds: number | null;
  marketplace_facilitator_tax_refunds: number | null;
  shipping_credit_refunds: number | null;
  shipping_chargeback_refund: number | null;
  referral_fees: number | null;
  fba_fees: number | null;
  fba_customer_return_fees: number | null;
  restocking_fee: number | null;
  reversal_reimbursement: number | null;
  other_fees: number | null;
  digital_services_fee: number | null;
  sales_tax_refunds: number | null;
  gift_wrap_credit_refunds: number | null;
}

interface OrderInfo {
  asin: string | null;
  title: string | null;
  image_url: string | null;
  marketplace: string | null;
  quantity: number | null;
  // Original fees from the sale shipment event (SP-API Finances → sales_orders)
  orig_referral_fee: number | null;
  orig_fba_fee: number | null;
  orig_closing_fee: number | null;
}

interface Props {
  rangeStart: string;
  rangeEnd: string;
  label: string;
}

const fmt = (n: number) =>
  n === 0 ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

const num = (v: any) => Number(v ?? 0) || 0;

export default function RefundsSection({ rangeStart, rangeEnd, label }: Props) {
  const { user } = useAuth();
  const { homeMarketplace } = useHomeMarketplace();
  const [rows, setRows] = useState<FECRow[]>([]);
  const [orderMap, setOrderMap] = useState<Record<string, OrderInfo>>({});
  const [loading, setLoading] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string>("");

  const resyncYear = useCallback(async () => {
    if (!user?.id) return;
    setResyncing(true);
    setProgressMsg("Starting…");
    try {
      const year = new Date().getFullYear();
      const start = `${year}-01-01`;
      const end = new Date().toISOString().slice(0, 10);
      toast({ title: "Re-syncing refunds…", description: `Recomputing all refunds from ${start} to ${end}.` });

      const { data, error } = await supabase.functions.invoke("sync-sales-orders", {
        body: {
          sync_refunds_only: true,
          custom_start_date: start,
          custom_end_date: end,
          track_progress: true,
        },
      });
      if (error) throw error;
      const progressId = (data as any)?.progressId;
      if (!progressId) throw new Error((data as any)?.message || "No progress tracker returned.");

      const startTs = Date.now();
      const TIMEOUT_MS = 10 * 60 * 1000;
      while (Date.now() - startTs < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 3000));
        const { data: prog } = await supabase
          .from("pl_sync_progress")
          .select("status, message, summary, error")
          .eq("id", progressId)
          .maybeSingle();
        if (!prog) continue;
        const s: any = prog.summary || {};
        setProgressMsg(`${prog.message || "Working…"} (${s.refundsApplied ?? 0}/${s.refundsFound ?? 0})`);
        if (prog.status === "done") {
          toast({ title: "Refund re-sync complete", description: `${s.refundsFound ?? 0} found · ${s.refundsApplied ?? 0} updated/created` });
          await fetchRefunds();
          return;
        }
        if (prog.status === "error") throw new Error((prog as any).error || "Background job failed");
      }
      throw new Error("Timed out after 10 minutes.");
    } catch (e: any) {
      toast({ title: "Re-sync failed", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setResyncing(false);
      setProgressMsg("");
    }
  }, [user?.id]);

  const fetchRefunds = useCallback(async () => {
    if (!user?.id || !rangeStart || !rangeEnd) return;
    setLoading(true);
    try {
      const PAGE = 1000;
      const all: FECRow[] = [];
      for (let from = 0; from < 50000; from += PAGE) {
        const { data, error } = await supabase
          .from("financial_events_cache")
          .select(
            "id, amazon_order_id, asin, marketplace, event_date, sales, refunds, promotional_rebate_refunds, marketplace_facilitator_tax_refunds, shipping_credit_refunds, shipping_chargeback_refund, referral_fees, fba_fees, fba_customer_return_fees, restocking_fee, reversal_reimbursement, other_fees, digital_services_fee, sales_tax_refunds, gift_wrap_credit_refunds",
          )
          .eq("user_id", user.id)
          .eq("event_type", "refund")
          .gte("event_date", rangeStart)
          .lte("event_date", rangeEnd)
          .order("event_date", { ascending: false })
          .range(from, from + PAGE - 1);

        if (error) {
          console.warn("[RefundsSection] fetch error:", error.message);
          break;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as FECRow[]));
        if (data.length < PAGE) break;
      }
      setRows(all);

      // Enrich with product info from sales_orders (first match per order)
      const orderIds = Array.from(new Set(all.map(r => r.amazon_order_id).filter(Boolean) as string[]));
      const map: Record<string, OrderInfo> = {};
      const CHUNK = 200;
      for (let i = 0; i < orderIds.length; i += CHUNK) {
        const chunk = orderIds.slice(i, i + CHUNK);
        const { data: so } = await supabase
          .from("sales_orders")
          .select("order_id, asin, title, image_url, marketplace, quantity, referral_fee, fba_fee, closing_fee")
          .eq("user_id", user.id)
          .in("order_id", chunk)
          .not("asin", "in", "(PENDING,UNKNOWN)");
        (so || []).forEach((row: any) => {
          if (!map[row.order_id] && row.asin) {
            map[row.order_id] = {
              asin: row.asin,
              title: row.title,
              image_url: row.image_url,
              marketplace: row.marketplace,
              quantity: row.quantity,
              orig_referral_fee: num(row.referral_fee),
              orig_fba_fee: num(row.fba_fee),
              orig_closing_fee: num(row.closing_fee),
            };
          }
        });
      }
      setOrderMap(map);
    } finally {
      setLoading(false);
    }
  }, [user?.id, rangeStart, rangeEnd]);

  useEffect(() => { fetchRefunds(); }, [fetchRefunds]);

  // FEC sign convention: positive = seller paid (cost), negative = seller received (credit).
  // Display as P&L impact (negative = cost to seller, positive = credit).
  // Tax refund is excluded — marketplace facilitator tax is collected & remitted by Amazon,
  // refunding it is a pass-through with $0 impact on the seller.
  const impacts = (r: FECRow) => {
    const product = -num(r.refunds);
    const promo = -num(r.promotional_rebate_refunds);
    const ship = -(num(r.shipping_credit_refunds) + num(r.shipping_chargeback_refund) + num(r.gift_wrap_credit_refunds));
    // Gross referral credit Amazon returns (FEC reports this as a negative cost → positive credit)
    const refFee = -num(r.referral_fees);
    // Amazon retains a refund administration fee = min($5.00, 20% of referral fee).
    // This is NOT in FEC referral_fees — it's a separate Amazon retention. Always negative.
    const refundAdmin = -Math.min(5.0, Math.abs(refFee) * 0.20);
    const fbaRet = -num(r.fba_customer_return_fees);
    // ⚠️ NOT negated, and it is the ONLY column here that is not.
    //
    // The blanket -num() above implements the FEC convention stated at the top
    // of this function: positive = seller paid. restocking_fee is the one
    // column that breaks it -- it is stored POSITIVE (ingest takes abs()) while
    // being money the seller RECEIVED. Amazon charges the restocking penalty to
    // the returning BUYER, withholds it from their refund and passes it on.
    //
    // Negating it therefore turned a credit into a displayed cost. Order
    // 113-8267165-1606605 (sold 32.00, 20% tier): the row showed
    // -32.00 - 6.40 = -38.40 when the seller was actually out -25.60, so the
    // error is 2x the fee -- once for not crediting it, once for charging it.
    //
    // The stored sign is NOT the bug and must not be "fixed" at ingest:
    // plModel.ts carries restocking_fee in INCOME_ROWS, which needs it
    // positive. Only the consumers that assume the cost convention were wrong.
    const restock = num(r.restocking_fee);
    const other = -(num(r.other_fees) + num(r.digital_services_fee) + num(r.reversal_reimbursement) + num(r.fba_fees));
    const net = product + promo + ship + refFee + refundAdmin + fbaRet + restock + other;
    return { product, promo, ship, refFee, refundAdmin, fbaRet, restock, other, net };
  };

  const totals = rows.reduce(
    (acc, r) => {
      const i = impacts(r);
      acc.product += i.product; acc.promo += i.promo; acc.ship += i.ship;
      acc.refFee += i.refFee; acc.refundAdmin += i.refundAdmin;
      acc.fbaRet += i.fbaRet; acc.restock += i.restock; acc.other += i.other; acc.net += i.net;
      return acc;
    },
    { product: 0, promo: 0, ship: 0, refFee: 0, refundAdmin: 0, fbaRet: 0, restock: 0, other: 0, net: 0 },
  );



  return (
    <section className="container mx-auto px-4 py-6">
      <div className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">Refunds</h2>
            <p className="text-xs text-muted-foreground">
              {label} · {rangeStart === rangeEnd ? rangeStart : `${rangeStart} → ${rangeEnd}`} ·{" "}
              {rows.length} refund{rows.length === 1 ? "" : "s"} · Net impact:{" "}
              <span className="text-destructive font-medium">{fmt(totals.net)}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {resyncing && progressMsg && (
              <span className="text-xs text-muted-foreground max-w-[260px] truncate">{progressMsg}</span>
            )}
            <Button size="sm" variant="outline" onClick={resyncYear} disabled={resyncing || loading}>
              {resyncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCcw className="h-4 w-4 mr-2" />}
              Re-sync {new Date().getFullYear()} refunds
            </Button>
            <Button size="sm" variant="ghost" onClick={fetchRefunds} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          {loading && rows.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading refunds…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No refunds for {label.toLowerCase()}.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Order</th>
                  <th className="px-3 py-2 text-left">Mkt</th>
                  <th className="px-3 py-2 text-right" title="Refund principal returned to customer">Product Charge</th>
                  <th className="px-3 py-2 text-right" title="Promotional rebate reversed">Promo</th>
                  
                  <th className="px-3 py-2 text-right" title="Shipping/gift wrap refund">Shipping</th>
                  <th className="px-3 py-2 text-right" title="Referral fee returned (gross from Finances API, before Amazon's refund admin retention)">Referral Fee</th>
                  <th className="px-3 py-2 text-right" title="Refund administration fee Amazon retains = min($5.00, 20% of referral fee)">Refund Admin</th>
                  <th className="px-3 py-2 text-right" title="FBA fulfilment fee charged on the original sale (NOT reversed on refund — seller eats this)">FBA Fee (sale)</th>
                  <th className="px-3 py-2 text-right" title="Variable closing fee charged on the original sale (NOT reversed on refund)">Var. Closing (sale)</th>
                  <th className="px-3 py-2 text-right" title="FBA customer return / refund admin fee charged at refund time">Return Fee</th>
                  <th className="px-3 py-2 text-right" title="Restocking penalty Amazon charges the returning BUYER (15/20/50% of item price) and passes to you — a CREDIT that offsets the gross refund, not a fee you pay">Restock Credit</th>
                  <th className="px-3 py-2 text-right" title="Other reversals / digital services / reimbursements">Other</th>
                  <th className="px-3 py-2 text-right font-semibold">Net</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const info = (r.amazon_order_id && orderMap[r.amazon_order_id]) || null;
                  const { product, promo, ship, refFee, refundAdmin, fbaRet, restock, other, net } = impacts(r);
                  const asin = r.asin || info?.asin || "—";
                  const title = info?.title || asin;
                  const mkt = r.marketplace || info?.marketplace || "US";
                  const origFba = -Math.abs(num(info?.orig_fba_fee));
                  const origClose = -Math.abs(num(info?.orig_closing_fee));
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 whitespace-nowrap">{formatMarketplaceDate(r.event_date, r.marketplace || homeMarketplace)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {info?.image_url && (
                            <img src={info.image_url} alt="" className="h-10 w-10 min-w-10 rounded object-cover" />
                          )}
                          <div>
                            <div className="font-medium truncate max-w-[260px]">{title}</div>
                            <div className="text-xs text-muted-foreground">{asin}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.amazon_order_id}</td>
                      <td className="px-3 py-2 text-xs">{mkt}</td>
                      <td className="px-3 py-2 text-right text-destructive">{fmt(product)}</td>
                      <td className="px-3 py-2 text-right">{fmt(promo)}</td>
                      
                      <td className="px-3 py-2 text-right">{fmt(ship)}</td>
                      <td className={`px-3 py-2 text-right ${refFee > 0 ? "text-emerald-600" : ""}`}>{fmt(refFee)}</td>
                      <td className="px-3 py-2 text-right text-destructive">{fmt(refundAdmin)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{fmt(origFba)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{fmt(origClose)}</td>
                      <td className="px-3 py-2 text-right">{fmt(fbaRet)}</td>
                      <td className="px-3 py-2 text-right">{fmt(restock)}</td>
                      <td className="px-3 py-2 text-right">{fmt(other)}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${net < 0 ? "text-destructive" : "text-emerald-600"}`}>{fmt(net)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-muted/30 border-t font-semibold">
                <tr>
                  <td className="px-3 py-2" colSpan={4}>Totals</td>
                  <td className="px-3 py-2 text-right text-destructive">{fmt(totals.product)}</td>
                  <td className="px-3 py-2 text-right">{fmt(totals.promo)}</td>
                  
                  <td className="px-3 py-2 text-right">{fmt(totals.ship)}</td>
                  <td className={`px-3 py-2 text-right ${totals.refFee > 0 ? "text-emerald-600" : ""}`}>{fmt(totals.refFee)}</td>
                  <td className="px-3 py-2 text-right text-destructive">{fmt(totals.refundAdmin)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{fmt(-Math.abs(rows.reduce((s, r) => s + num((r.amazon_order_id && orderMap[r.amazon_order_id]?.orig_fba_fee) || 0), 0)))}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{fmt(-Math.abs(rows.reduce((s, r) => s + num((r.amazon_order_id && orderMap[r.amazon_order_id]?.orig_closing_fee) || 0), 0)))}</td>
                  <td className="px-3 py-2 text-right">{fmt(totals.fbaRet)}</td>
                  <td className="px-3 py-2 text-right">{fmt(totals.restock)}</td>
                  <td className="px-3 py-2 text-right">{fmt(totals.other)}</td>
                  <td className={`px-3 py-2 text-right ${totals.net < 0 ? "text-destructive" : "text-emerald-600"}`}>{fmt(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
