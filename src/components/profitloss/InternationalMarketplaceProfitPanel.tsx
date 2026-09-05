import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, AlertTriangle, Info, Globe } from "lucide-react";
import { toast } from "sonner";

// Same row taxonomy MonthlyPLBreakdown.tsx uses (INCOME_ROWS / EXPENSE_ROWS),
// applied per marketplace instead of per account. Every field here comes
// from get_monthly_pl_breakdown, which sources financial_events_cache --
// per-transaction, marketplace-tagged Amazon events. Nothing here is
// company overhead: Operating Expenses (Salary/Rent/Subscriptions/etc.) and
// Inventory Damage & Loss (dispositions/write-offs) are deliberately
// excluded because neither has a marketplace column in this account's data
// at all -- there's nothing to attribute. CA/MX/BR sell via Remote
// Fulfillment from the same US-purchased inventory, so there's no separate
// international operation to carry its own overhead anyway.
// Matches MonthlyPLBreakdown.tsx's INCOME_ROWS/EXPENSE_ROWS exactly (the
// canonical taxonomy) -- restocking_fee and promotional_rebate_refunds are
// both credits: a restocking fee is charged to the RETURNING CUSTOMER and
// kept by the seller (see fetch-profit-loss/index.ts's own comment on
// processRefundEventToCache), and a promotional-rebate refund is Amazon
// reversing an over-applied promo back to the seller. Getting either one
// backwards understates international profit.
const INCOME_KEYS = ["sales", "reimbursements", "shipping_credits", "gift_wrap_credits", "promotional_rebate_refunds", "restocking_fee", "other_income", "liquidations", "warehouse_lost", "warehouse_damage", "shipping_chargeback_refund"] as const;
const INCOME_DEDUCTION_KEYS = ["refunds", "shipping_credit_refunds", "gift_wrap_credit_refunds", "promotional_rebates"] as const;
const AMAZON_FEE_KEYS = ["referral_fees", "variable_closing_fees", "fixed_closing_fees", "fba_fees", "fba_customer_return_fees", "fba_inbound_fees", "fba_inbound_convenience_fee", "fba_storage_fees", "fba_removal_fees", "fba_disposal_fees", "fba_long_term_storage_fees", "digital_services_fee", "other_fees", "liquidations_brokerage_fee", "re_commerce_grading_charge", "hrr_non_apparel", "shipping_chargeback"] as const;

interface MarketplaceRow {
  marketplace: string;
  /** Newest event_date held for this marketplace. null = nothing cached yet. */
  newest: string | null;
  sales: number; // net income: gross sales + credits/reimbursements - refunds/promos (see INCOME_KEYS/INCOME_DEDUCTION_KEYS above)
  cogs: number;
  amazonFees: number;
  profit: number;
}

function sumField(rows: any[], key: string): number {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

/** Whole days between an event date (YYYY-MM-DD) and today, floored at 0. */
function staleDays(isoDate: string): number {
  const then = new Date(`${isoDate}T00:00:00`);
  const now = new Date();
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

const fmtMoney = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Props {
  year: number;
  /** Connected non-US marketplaces (e.g. ["CA","MX","BR"]) -- derived from seller_authorizations by the parent page. */
  marketplaces: string[];
}

export default function InternationalMarketplaceProfitPanel({ year, marketplaces }: Props) {
  const [rows, setRows] = useState<MarketplaceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (marketplaces.length === 0) { setRows([]); return; }
    setLoading(true);
    setError(null);
    try {
      const results: MarketplaceRow[] = [];
      for (const mp of marketplaces) {
        const [plRes, cogsRes] = await Promise.all([
          supabase.rpc("get_monthly_pl_breakdown", { p_year: year, p_marketplace: mp }),
          supabase.rpc("get_monthly_cogs", { p_year: year, p_marketplace: mp }),
        ]);
        if (plRes.error) throw plRes.error;
        if (cogsRes.error) throw cogsRes.error;
        const plRows = (plRes.data as any[]) || [];
        const cogsRows = (cogsRes.data as any[]) || [];
        const income = INCOME_KEYS.reduce((s, k) => s + sumField(plRows, k), 0)
          - INCOME_DEDUCTION_KEYS.reduce((s, k) => s + sumField(plRows, k), 0);
        const amazonFees = AMAZON_FEE_KEYS.reduce((s, k) => s + sumField(plRows, k), 0);
        const cogs = sumField(cogsRows, "cogs");
        // Freshness, read straight from the cache these totals are built on.
        //
        // This exists because "the numbers have not moved in a week" is
        // indistinguishable from "nothing has synced in a week" without it. On
        // 2026-08-20 the answer was neither: CA/MX were current to the previous
        // day and BR to five days earlier, and the totals only looked frozen
        // because international volume is ~1 event/day. Showing the date turns
        // that from an investigation into a glance.
        const { data: newestRow } = await supabase
          .from("financial_events_cache")
          .select("event_date")
          .eq("marketplace", mp)
          .order("event_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        const newest = (newestRow as { event_date?: string } | null)?.event_date ?? null;
        results.push({ marketplace: mp, newest, sales: income, cogs, amazonFees, profit: income - cogs - amazonFees });
      }
      setRows(results);
    } catch (e: any) {
      // A superseded request is not a failure. When this reload is replaced by
      // a newer one the old fetch is cancelled, and reporting that as an error
      // put "AbortError: signal is aborted without reason" in front of the
      // user for something entirely internal -- while the newer request was
      // already on its way to succeeding.
      const msg = String(e?.message || e?.name || "");
      if (e?.name === "AbortError" || /aborted|abortError/i.test(msg)) {
        return;
      }
      setError(e?.message || "Failed to load");
      toast.error("Failed to load International Marketplace Profit: " + (e?.message || "unknown error"));
    } finally {
      setLoading(false);
    }
  }, [year, marketplaces]);

  useEffect(() => { load(); }, [load]);

  const total: MarketplaceRow = (rows || []).reduce(
    (acc, r) => ({
      marketplace: "International Total",
      newest: null,
      sales: acc.sales + r.sales,
      cogs: acc.cogs + r.cogs,
      amazonFees: acc.amazonFees + r.amazonFees,
      profit: acc.profit + r.profit,
    }),
    { marketplace: "International Total", newest: null, sales: 0, cogs: 0, amazonFees: 0, profit: 0 },
  );

  return (
    <Card className="border-primary/40">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><Globe className="h-5 w-5" /> International Marketplace Profit</CardTitle>
          <CardDescription>
            How much your CA/MX/BR Amazon channels actually made — marketplace-attributable costs only. No US business overhead (Salary, Rent, Subscriptions, general inventory write-offs) is allocated here; that stays in the US Full P&L / All Marketplaces view below.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Reload
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {marketplaces.length === 0 && !loading && !error && (
          <p className="text-sm text-muted-foreground">No international marketplaces (CA/MX/BR) connected on this account.</p>
        )}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marketplace</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">COGS</TableHead>
                  <TableHead className="text-right">Amazon Fees</TableHead>
                  <TableHead className="text-right">Marketplace Profit</TableHead>
                  <TableHead className="text-right">Data through</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.marketplace}>
                    <TableCell className="font-medium">{r.marketplace}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.sales)}</TableCell>
                    <TableCell className="text-right">{fmtMoney(-r.cogs)}</TableCell>
                    <TableCell className="text-right">{fmtMoney(-r.amazonFees)}</TableCell>
                    <TableCell className={`text-right font-semibold ${r.profit < 0 ? "text-destructive" : ""}`}>{fmtMoney(r.profit)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                      {r.newest ?? "—"}
                      {r.newest && staleDays(r.newest) >= 3 && (
                        <span className="ml-1.5 text-amber-600">{staleDays(r.newest)}d</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-primary/5 font-semibold">
                  <TableCell>{total.marketplace}</TableCell>
                  <TableCell className="text-right">{fmtMoney(total.sales)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(-total.cogs)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(-total.amazonFees)}</TableCell>
                  <TableCell className={`text-right ${total.profit < 0 ? "text-destructive" : ""}`}>{fmtMoney(total.profit)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <strong>Reload</strong> re-reads saved data; it does not fetch from Amazon. Use
            <strong> Refresh</strong> at the top of the P&amp;L page to pull new financial events.
            "Data through" is the newest event held for each marketplace — international volume is
            low, so a total can legitimately sit unchanged for days.
          </span>
        </p>
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          "Sales" here is net of refunds, shipping/gift-wrap credit refunds, promotional rebates, and restocking fees — the same income definition the P&L uses elsewhere — plus reimbursements, shipping/gift-wrap credits, other income, liquidations, and Amazon-paid warehouse-lost/damage reimbursements. "Amazon Fees" is every Amazon-charged fee line (referral, FBA fulfillment/inbound/storage/removal/disposal, closing, shipping chargebacks, etc.). Marketplace Profit = Sales − COGS − Amazon Fees, exactly.
        </p>
      </CardContent>
    </Card>
  );
}
