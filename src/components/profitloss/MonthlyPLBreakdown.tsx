/**
 * MonthlyPLBreakdown — InventoryLab-style yearly P&L
 *
 * Shows Income / Expenses / Other line items as ROWS,
 * with one COLUMN per month (Jan–Dec) plus a Total column.
 *
 * Source: financial_events_cache aggregated by month via
 * RPC `get_monthly_pl_breakdown(p_year)`.
 *
 * All marketplaces are included (already FX-converted to USD by sync).
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, RefreshCw, AlertTriangle, Database, Search, Copy, Download, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { formatMarketplaceDate } from "@/lib/sales/dateLocale";
// Category lists, totals and the disposition rule are shared with the Excel
// export so the two reports cannot drift apart again. See plModel.ts.
import {
  type PlMonthRow as MonthRow,
  type RowDef,
  rowValue,
  INCOME_ROWS,
  EXPENSE_ROWS,
  OTHER_ROWS,
  MEMO_ROWS,
  DISPOSITION_STATUSES,
  dispositionLoss,
} from "@/lib/profitloss/plModel";
import { Link } from "react-router-dom";
import { toast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addDays,
  addMonths,
  addWeeks,
  addQuarters,
  addYears,
  startOfYear,
  endOfYear,
  isAfter,
  isBefore,
} from "date-fns";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SETTLEMENT_REPORT_RETENTION_DAYS = 90;

const monthWindow = (year: number, month: number) => {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { start, end };
};

const reportCoversMonth = (report: any, year: number, month: number) => {
  const { start, end } = monthWindow(year, month);
  const reportStart = report?.settlement_start_date || report?.dataStartTime?.slice?.(0, 10) || report?.start;
  const reportEnd = report?.settlement_end_date || report?.dataEndTime?.slice?.(0, 10) || report?.end || reportStart;
  return Boolean(reportStart && reportEnd && reportEnd >= start && reportStart < end && report?.status !== "error");
};

const fmt = (n: number, negative = false) => {
  const abs = Math.abs(Number.isFinite(n) ? n : 0);
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(abs);
  return negative && abs > 0 ? `(${formatted})` : formatted;
};

interface Props {
  year: number;
  refreshKey?: number;
  onCogsBaseTotalChange?: (total: number) => void;
  /** 'reconciled' shows Tax + Memo sections below Net Profit. 'estimated' hides them (FEC-only data). */
  mode?: 'estimated' | 'reconciled';
  /** Optional marketplace filter: "ALL" (default) | "US" | "CA" | "MX" | "BR". */
  marketplace?: string;
  /** Controlled InventoryLab-style view (moves refund rows into Income). If omitted, component manages its own state. */
  ilStyleView?: boolean;
  onIlStyleViewChange?: (v: boolean) => void;
  /** 1-indexed month numbers (1–12) to visually highlight in the header — indicates which
   *  months the caller's period selection (Monthly / Quarterly) covers. Data is unchanged;
   *  totals still reflect the full year. Undefined = no highlight (Yearly view). */
  highlightMonths?: number[];
}

// ── Operating expense (My Expenses) ─────────────────────────────────────
interface ExpenseRow {
  id: string;
  amount: number;
  category: string | null;
  frequency: string;
  expense_date: string;
  end_date: string | null;
  is_advertising_cost: boolean | null;
  skipped_months?: string[] | null;
}

// ── Monthly COGS row from get_monthly_cogs RPC ──────────────────────────
interface CogsRow {
  month_num: number;
  cogs: number;
  units_sold: number;
  units_with_cost: number;
  units_missing_cost: number;
  orders_missing_cost: number;
  asins_missing_cost: number;
}

interface CogsAdjustmentRow {
  amount: number;
  period_start: string;
  period_end: string;
}

/** Parse a Postgres DATE ("YYYY-MM-DD") as a LOCAL date. Never use
 * `new Date("YYYY-MM-DD")` — that parses as UTC midnight and rolls back a day
 * in negative timezones, so an expense dated the 1st shows up on the previous
 * month's last day. See [DATE Column TZ Parsing]. */
function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

/** Expand one expense into all monthly occurrences inside the requested year. */
function expandExpenseIntoYear(exp: ExpenseRow, year: number): { m: number; amount: number }[] {
  const yearStart = startOfYear(new Date(year, 0, 1));
  const yearEnd = endOfYear(new Date(year, 0, 1));
  const start = parseLocalDate(exp.expense_date);
  const end = exp.end_date ? parseLocalDate(exp.end_date) : yearEnd;
  // Cap recurring operating expenses (Salary, Rent, etc.) at today so the
  // monthly breakdown doesn't pre-charge future months. COGS adjustments
  // (e.g. the $23,000 annual inventory-loss estimate) are handled in a
  // different code path and remain spread across all 12 months.
  const today = new Date();
  const cap = isAfter(yearEnd, today) ? today : yearEnd;
  const out: { m: number; amount: number }[] = [];
  const skipped = new Set((exp.skipped_months ?? []).map((s) => s.slice(0, 7)));
  const monthKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const push = (d: Date) => {
    if (isBefore(d, yearStart) || isAfter(d, yearEnd)) return;
    if (isAfter(d, end)) return;
    if (isAfter(d, cap)) return;
    if (d.getFullYear() !== year) return;
    if (skipped.has(monthKey(d))) return;
    out.push({ m: d.getMonth(), amount: Number(exp.amount) || 0 });
  };
  const SAFETY = 5000;
  let i = 0;
  const step = (advance: (d: Date) => Date) => {
    let d = new Date(start);
    while (i++ < SAFETY && !isAfter(d, end) && !isAfter(d, yearEnd)) {
      push(d);
      d = advance(d);
    }
  };
  switch (exp.frequency) {
    case "one_time": push(start); break;
    case "daily": step((d) => addDays(d, 1)); break;
    case "weekly": step((d) => addWeeks(d, 1)); break;
    case "monthly": step((d) => addMonths(d, 1)); break;
    case "quarterly": step((d) => addQuarters(d, 1)); break;
    case "half_yearly": step((d) => addMonths(d, 6)); break;
    case "annually": step((d) => addYears(d, 1)); break;
    default: push(start);
  }
  return out;
}

export default function MonthlyPLBreakdown({ year, refreshKey = 0, onCogsBaseTotalChange, mode = 'reconciled', marketplace = 'ALL', ilStyleView: ilStyleViewProp, onIlStyleViewChange, highlightMonths }: Props) {
  const highlightSet = useMemo(() => new Set(highlightMonths ?? []), [highlightMonths]);
  const mpParam = marketplace && marketplace !== 'ALL' ? marketplace : null;
  const applyMp = <T extends { eq: any; or: any }>(q: T, col = 'marketplace'): T => {
    if (!mpParam) return q;
    if (mpParam === 'US') return q.or(`${col}.is.null,${col}.eq.US,${col}.eq.UNKNOWN`);
    return q.eq(col, mpParam);
  };
  const { user } = useAuth();
  const { homeMarketplace, homeCurrency, homeCurrencySymbol } = useHomeMarketplace();
  const [fxRates, setFxRates] = useState<Record<string, number>>({ USD: 1 });
  useEffect(() => {
    let cancelled = false;
    supabase.from("fx_rates").select("quote, rate").then(({ data }) => {
      if (cancelled || !data) return;
      const m: Record<string, number> = { USD: 1 };
      for (const r of data as { quote: string; rate: number }[]) m[r.quote] = Number(r.rate);
      setFxRates(m);
    });
    return () => { cancelled = true; };
  }, []);
  // USD -> seller's home currency multiplier, applied only at display
  // boundaries (the RPCs return USD-normalized totals). No-op (1) for USD sellers.
  const homeRate = fxRates[homeCurrency] ?? 1;
  const fmt = (n: number, negative = false) => {
    const abs = Math.abs(Number.isFinite(n) ? n : 0) * homeRate;
    const formatted = homeCurrencySymbol + new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(abs);
    return negative && abs > 0 ? `(${formatted})` : formatted;
  };
  const [rows, setRows] = useState<MonthRow[] | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [cogsRows, setCogsRows] = useState<CogsRow[] | null>(null);
  const [cogsAdjustments, setCogsAdjustments] = useState<CogsAdjustmentRow[]>([]);
  const [dispoMonthly, setDispoMonthly] = useState<number[]>(() => Array(12).fill(0));
  const [dispoUnits, setDispoUnits] = useState(0);
  // Warehouse write-offs. This report had NO write-off term at all until
  // 2026-08-19: real inventory losses recorded in inventory_writeoffs never
  // reached the on-screen Net Profit, while the Excel export did include them.
  // That was one of the three components of the $2,499.72 gap between them.
  const [writeoffMonthly, setWriteoffMonthly] = useState<number[]>(() => Array(12).fill(0));
  // FBM Buy Shipping label cost. Comes from sales_orders, NOT
  // financial_events_cache -- Amazon does not deliver it as a financial event,
  // which is why it never appeared in the P&L despite being collected since
  // 2026-06-01. See 20260831160000.
  const [fbmLabelMonthly, setFbmLabelMonthly] = useState<number[]>(() => Array(12).fill(0));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── InventoryLab-style view toggle ────────────────────────────────────
  // When ON, the four "reclassified from Income" rows (Refunds, Shipping
  // Credit Refunds, Gift Wrap Credit Refunds, Promotional Rebates) move
  // BACK into the Income section as negative contributions — matching
  // InventoryLab's convention of netting refunds directly into Income.
  // Net Profit is unchanged (same subtraction, different section).
  const [ilStyleViewLocal, setIlStyleViewLocal] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pl_il_style_view') === '1';
  });
  const ilStyleView = ilStyleViewProp ?? ilStyleViewLocal;
  const setIlStyleView = (v: boolean) => {
    if (onIlStyleViewChange) onIlStyleViewChange(v);
    else setIlStyleViewLocal(v);
  };
  useEffect(() => {
    try { localStorage.setItem('pl_il_style_view', ilStyleView ? '1' : '0'); } catch {}
  }, [ilStyleView]);

  // -- Amazon-only view ---------------------------------------------------
  // Hides COGS, Operating Expenses and Inventory Loss, leaving only what
  // Amazon actually pays and charges.
  //
  // WHY IT EARNS A TOGGLE. Everything that survives comes straight from
  // financial_events_cache, so this view cannot be moved by manual
  // bookkeeping. That matters: reconciling 2026 against InventoryLab on
  // 2026-08-31 produced a $34,136 disagreement, and $17,657 of it was
  // hand-entered COGS and operating expenses -- subscriptions alone differed
  // by $11,319, and IL was simply missing July and August rent. None of that
  // can reach the rows left standing here, which is the whole point.
  //
  // Net becomes Income + Amazon Expenses: what Amazon net-deposits before a
  // single unit of inventory is paid for.
  const [amazonOnly, setAmazonOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pl_amazon_only') === '1';
  });
  useEffect(() => {
    try { localStorage.setItem('pl_amazon_only', amazonOnly ? '1' : '0'); } catch {}
  }, [amazonOnly]);

  const RECLASSIFIED_REFUND_KEYS = useMemo(
    () => new Set<keyof MonthRow>([
      'refunds',
      'shipping_credit_refunds',
      'gift_wrap_credit_refunds',
      'promotional_rebates',
    ]),
    []
  );

  const effectiveIncomeRows = useMemo<RowDef[]>(() => {
    if (!ilStyleView) return INCOME_ROWS;
    const moved = EXPENSE_ROWS.filter(r => r.key && RECLASSIFIED_REFUND_KEYS.has(r.key));
    return [...INCOME_ROWS, ...moved];
  }, [ilStyleView, RECLASSIFIED_REFUND_KEYS]);

  const effectiveExpenseRows = useMemo<RowDef[]>(() => {
    if (!ilStyleView) return EXPENSE_ROWS;
    return EXPENSE_ROWS.filter(r => !(r.key && RECLASSIFIED_REFUND_KEYS.has(r.key)));
  }, [ilStyleView, RECLASSIFIED_REFUND_KEYS]);

  // ── Other Amazon Fees drill-down ──────────────────────────────────────
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillRows, setDrillRows] = useState<Array<{
    event_type: string;
    event_date: string;
    marketplace: string | null;
    amazon_order_id: string | null;
    amount: number;
  }>>([]);
  const [drillError, setDrillError] = useState<string | null>(null);

  const openOtherFeesDrilldown = async () => {
    if (!user) return;
    setDrillOpen(true);
    setDrillLoading(true);
    setDrillError(null);
    try {
      const yearStartIso = `${year}-01-01`;
      const yearEndExclusiveIso = `${year + 1}-01-01`;
      let drillQ: any = (supabase as any)
        .from("financial_events_cache")
        .select("event_type,event_date,marketplace,amazon_order_id,other_fees")
        .eq("user_id", user.id)
        .gte("event_date", yearStartIso)
        .lt("event_date", yearEndExclusiveIso)
        .not("other_fees", "is", null)
        .neq("other_fees", 0)
        .order("event_date", { ascending: false })
        .limit(5000);
      drillQ = applyMp(drillQ);
      const { data, error: err } = await drillQ;
      if (err) throw err;
      setDrillRows(
        (data || []).map((r: any) => ({
          event_type: r.event_type,
          event_date: r.event_date,
          marketplace: r.marketplace,
          amazon_order_id: r.amazon_order_id,
          amount: Number(r.other_fees) || 0,
        }))
      );
    } catch (e: any) {
      setDrillError(e?.message || String(e));
    } finally {
      setDrillLoading(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const yearStartIso = `${year}-01-01`;
      const yearEndIso = `${year}-12-31`;
      const yearEndExclusiveIso = `${year + 1}-01-01`;

      const [rpcRes, expRes, cogsRes, cogsAdjustmentsRes, dispoRes, writeoffRes, fbmLabelRes] = await Promise.all([
        (supabase as any).rpc("get_monthly_pl_breakdown", { p_year: year, p_marketplace: mpParam }),
        user
          ? supabase
              .from("expenses")
              .select("id,amount,category,frequency,expense_date,end_date,is_advertising_cost,skipped_months")
              .eq("user_id", user.id)
              .lte("expense_date", yearEndIso)
              .or(`end_date.is.null,end_date.gte.${yearStartIso}`)
          : Promise.resolve({ data: [], error: null }),
        (supabase as any).rpc("get_monthly_cogs", { p_year: year, p_marketplace: mpParam }),
        user
          ? supabase
              .from("cogs_adjustments")
              .select("amount,period_start,period_end")
              .eq("user_id", user.id)
              .lt("period_start", yearEndExclusiveIso)
              .gte("period_end", yearStartIso)
          : Promise.resolve({ data: [], error: null }),
        user
          ? (supabase as any)
              .from("inventory_dispositions")
              .select("disposition_date,sellable_qty,unsellable_qty,unit_cost,recovery_amount,outcome,status")
              .eq("user_id", user.id)
              .gte("disposition_date", yearStartIso)
              .lte("disposition_date", yearEndIso)
              .in("status", DISPOSITION_STATUSES as unknown as string[])
          : Promise.resolve({ data: [], error: null }),
        user
          ? (supabase as any)
              .from("inventory_writeoffs")
              .select("writeoff_date,total_cost")
              .eq("user_id", user.id)
              .gte("writeoff_date", yearStartIso)
              .lte("writeoff_date", yearEndIso)
          : Promise.resolve({ data: [], error: null }),
        (supabase as any).rpc("get_monthly_fbm_label_cost", { p_year: year, p_marketplace: mpParam }),
      ]);

      if (rpcRes.error) throw rpcRes.error;
      if (expRes.error) throw expRes.error;
      if (cogsRes.error) throw cogsRes.error;
      if (cogsAdjustmentsRes.error) throw cogsAdjustmentsRes.error;

      // Bucket disposition losses by month, via the rule shared with the export.
      const dispoBuckets = Array(12).fill(0) as number[];
      let unitsCount = 0;
      for (const r of ((dispoRes as any)?.data || []) as Array<any>) {
        const d = r.disposition_date ? new Date(r.disposition_date) : null;
        if (!d || d.getFullYear() !== year) continue;
        const { loss, units } = dispositionLoss(r);
        if (loss > 0) {
          dispoBuckets[d.getMonth()] += loss;
          unitsCount += units;
        }
      }
      setDispoMonthly(dispoBuckets);
      setDispoUnits(unitsCount);

      // Warehouse write-offs, bucketed the same way. Only positive costs count,
      // matching the export -- a zero or negative total_cost is not a loss.
      const writeoffBuckets = Array(12).fill(0) as number[];
      for (const r of ((writeoffRes as any)?.data || []) as Array<any>) {
        const d = r.writeoff_date ? new Date(r.writeoff_date) : null;
        if (!d || d.getFullYear() !== year) continue;
        const c = Number(r.total_cost) || 0;
        if (c > 0) writeoffBuckets[d.getMonth()] += c;
      }
      setWriteoffMonthly(writeoffBuckets);

      // Not fatal: a stale deployment without the RPC should still render the
      // rest of the P&L rather than blanking the page over one row.
      const fbmBuckets: number[] = Array(12).fill(0);
      if ((fbmLabelRes as any)?.error) {
        console.warn("[P&L] get_monthly_fbm_label_cost unavailable:", (fbmLabelRes as any).error?.message);
      } else {
        for (const r of ((fbmLabelRes as any)?.data || []) as Array<any>) {
          const m = Number(r?.month_num);
          if (m >= 1 && m <= 12) fbmBuckets[m - 1] = Number(r?.label_cost) || 0;
        }
      }
      setFbmLabelMonthly(fbmBuckets);

      const filled: MonthRow[] = Array.from({ length: 12 }, (_, i) => {
        const found = (rpcRes.data as MonthRow[] | null)?.find((r) => r.month_num === i + 1);
        return (
          found ?? ({
            month_num: i + 1,
            sales: 0, refunds: 0, reimbursements: 0,
            shipping_credits: 0, shipping_credit_refunds: 0,
            gift_wrap_credits: 0, gift_wrap_credit_refunds: 0,
            promotional_rebates: 0, promotional_rebate_refunds: 0,
            other_income: 0, liquidations: 0, intl_markets: 0,
            referral_fees: 0, fba_fees: 0, variable_closing_fees: 0,
            fixed_closing_fees: 0, fba_inbound_fees: 0, fba_storage_fees: 0,
            fba_removal_fees: 0, fba_disposal_fees: 0, fba_long_term_storage_fees: 0,
            fba_customer_return_fees: 0, digital_services_fee: 0,
            fba_inbound_convenience_fee: 0, other_fees: 0,
            liquidations_brokerage_fee: 0, re_commerce_grading_charge: 0,
            compensated_clawback: 0, hrr_non_apparel: 0,
            warehouse_lost: 0, warehouse_damage: 0,
            reversal_reimbursement: 0, free_replacement_refund_items: 0,
            sales_tax_collected: 0, marketplace_facilitator_tax: 0,
            sales_tax_refunds: 0, marketplace_facilitator_tax_refunds: 0,
            shipping_chargeback: 0, shipping_chargeback_refund: 0,
            restocking_fee: 0,
          } as MonthRow)
        );
      });
      setRows(filled);
      setExpenses((expRes.data ?? []) as ExpenseRow[]);

      const cogsFilled: CogsRow[] = Array.from({ length: 12 }, (_, i) => {
        const found = (cogsRes.data as CogsRow[] | null)?.find((r) => r.month_num === i + 1);
        return (
          found ?? {
            month_num: i + 1,
            cogs: 0, units_sold: 0, units_with_cost: 0,
            units_missing_cost: 0, orders_missing_cost: 0, asins_missing_cost: 0,
          }
        );
      });
      setCogsRows(cogsFilled);
      setCogsAdjustments((cogsAdjustmentsRes.data ?? []) as CogsAdjustmentRow[]);
      onCogsBaseTotalChange?.(cogsFilled.reduce((sum, row) => sum + (Number(row.cogs) || 0), 0));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load monthly breakdown");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, user?.id, refreshKey, mpParam]);

  // Stabilization phase: do NOT auto-refresh on tab focus / visibilitychange.
  // Users have explicit Refresh + Backfill + Settlement Reports buttons in
  // the header. Auto-reloading on return-to-tab caused the whole P&L page
  // to visibly re-render every time the user switched tabs, and violated
  // the heavy-page CPU controls (see mem://strategy/platform/heavy-page-cpu-controls-v1).


  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number; current: string | null; startedAt: number } | null>(null);
  const [backfillResult, setBackfillResult] = useState<{ ok: boolean; failures: number; total: number; elapsedSec: number } | null>(null);

  const backfillYear = async () => {
    if (!user?.id) return;
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth(); // 0-indexed
    // Build list of months in the selected year up to current month (inclusive)
    const months: string[] = [];
    const lastMonth = year === currentYear ? currentMonth : 11;
    for (let m = 0; m <= lastMonth; m++) {
      months.push(`${year}-${String(m + 1).padStart(2, "0")}`);
    }

    const startedAt = Date.now();
    setBackfillResult(null);
    setBackfilling(true);
    setBackfillProgress({ done: 0, total: months.length, current: `Queueing ${months[0]}…`, startedAt });
    let queueFailures = 0;

    // Mark every month as 'running' upfront so polling can detect transitions
    try {
      await supabase.from("historical_sync_checkpoints").upsert(
        months.map((mk) => ({
          user_id: user.id,
          sync_type: "settled",
          month_key: mk,
          status: "running",
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,sync_type,month_key" }
      );
    } catch (e) {
      console.warn("[backfill] could not pre-mark checkpoints:", e);
    }

    try {
      // PHASE 1 — Queue all 12 background jobs (fast, ~5–10s)
      for (let i = 0; i < months.length; i++) {
        const monthKey = months[i];
        setBackfillProgress({ done: i, total: months.length, current: `Queueing ${monthKey}…`, startedAt });
        try {
          const { error } = await supabase.functions.invoke("sync-historical-settled", {
            body: { mode: "execute", month_key: monthKey, force: true },
          });
          if (error) {
            console.error(`[backfill] ${monthKey} queue failed:`, error);
            queueFailures++;
          }
        } catch (err) {
          console.error(`[backfill] ${monthKey} queue error:`, err);
          queueFailures++;
        }
      }

      toast({
        title: `📦 ${months.length} jobs queued — now waiting for Amazon`,
        description: `Each month takes ~2–5 minutes. Total ~10–40 min. Keep this tab open.`,
      });

      // PHASE 2 — Poll checkpoints until every month is done or errored.
      // Uses a hard cap of 60 minutes; checks every 10 seconds.
      const POLL_INTERVAL_MS = 10_000;
      const MAX_WAIT_MS = 60 * 60 * 1000;
      const pollStart = Date.now();
      let lastDoneCount = 0;

      while (Date.now() - pollStart < MAX_WAIT_MS) {
        const { data: checkpoints, error: cpErr } = await supabase
          .from("historical_sync_checkpoints")
          .select("month_key,status,error_message,updated_at")
          .eq("user_id", user.id)
          .eq("sync_type", "settled")
          .in("month_key", months);

        if (cpErr) {
          console.warn("[backfill] checkpoint poll error:", cpErr);
        }

        const byKey = new Map<string, { status: string; error_message: string | null }>();
        for (const cp of checkpoints || []) {
          byKey.set(cp.month_key as string, { status: cp.status as string, error_message: cp.error_message as string | null });
        }

        const doneCount = months.filter((m) => byKey.get(m)?.status === "done").length;
        const errCount = months.filter((m) => byKey.get(m)?.status === "error").length;
        const finishedCount = doneCount + errCount;
        const stillRunning = months.find((m) => {
          const s = byKey.get(m)?.status;
          return s !== "done" && s !== "error";
        });

        // Reload the P&L view incrementally as each month completes
        if (doneCount > lastDoneCount) {
          lastDoneCount = doneCount;
          load().catch(() => {});
        }

        setBackfillProgress({
          done: finishedCount,
          total: months.length,
          current: stillRunning ? `Fetching ${stillRunning} from Amazon…` : null,
          startedAt,
        });

        if (finishedCount >= months.length) {
          const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
          setBackfillResult({ ok: errCount === 0 && queueFailures === 0, failures: errCount + queueFailures, total: months.length, elapsedSec });
          toast({
            title: errCount === 0
              ? `✅ Backfill truly complete — ${months.length} months in ${Math.round(elapsedSec / 60)} min`
              : `⚠ Backfill finished with ${errCount} error(s) in ${Math.round(elapsedSec / 60)} min`,
            description: `All Amazon SP-API fetches done. Reloading P&L…`,
            variant: errCount === 0 ? "default" : "destructive",
          });
          await load();
          return;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Timed out (>60 min)
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      setBackfillResult({ ok: false, failures: -1, total: months.length, elapsedSec });
      toast({
        title: `⏰ Backfill still running after 60 min`,
        description: `Some months may still be processing in the background. Refresh the page in a few minutes.`,
        variant: "destructive",
      });
      await load();
    } finally {
      setBackfilling(false);
      setBackfillProgress(null);
    }
  };

  // Live elapsed-time tick for the progress banner
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!backfilling) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [backfilling]);

  const [diagnoseOpen, setDiagnoseOpen] = useState(false);
  const [diagnoseMonth, setDiagnoseMonth] = useState<number>(new Date().getMonth() + 1);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<any | null>(null);

  const runDiagnoseLiquidations = async () => {
    if (!user?.id) return;
    setDiagnosing(true);
    setDiagnoseResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("diagnose-liquidations", {
        body: { year, month: diagnoseMonth, maxPages: 100 },
      });
      if (error) throw error;
      setDiagnoseResult(data);
      const summary = (data as any)?.summary;
      toast({
        title: "Diagnosis complete",
        description: summary
          ? `${summary.total_events} events scanned, ${summary.events_with_liquidation_keyword} liquidation hits.`
          : "Done.",
      });
    } catch (err: any) {
      console.error("[diagnose-liquidations] failed:", err);
      toast({
        title: "Diagnosis failed",
        description: err?.message || "Unknown error — see console.",
        variant: "destructive",
      });
    } finally {
      setDiagnosing(false);
    }
  };

  const copyDiagnoseJson = async () => {
    if (!diagnoseResult) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnoseResult, null, 2));
      toast({ title: "Copied", description: "Full diagnostic JSON copied to clipboard." });
    } catch (err: any) {
      toast({ title: "Copy failed", description: err?.message || "Select the text manually.", variant: "destructive" });
    }
  };

  const downloadDiagnoseJson = () => {
    if (!diagnoseResult) return;
    const blob = new Blob([JSON.stringify(diagnoseResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnose-liquidations-${year}-${String(diagnoseMonth).padStart(2, "0")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ─── Settlement Reports Sync + Reconciliation ──────────────────────
  // Pulls Amazon's auto-scheduled GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
  // reports — the only source for full disposal fees, removal-order processing
  // fees, and storage fees that the FinancialEvents API does not return.
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [settlementSyncing, setSettlementSyncing] = useState(false);
  const [settlementSyncResult, setSettlementSyncResult] = useState<any | null>(null);
  const [reconciliation, setReconciliation] = useState<any | null>(null);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const settlementRetentionCutoff = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - SETTLEMENT_REPORT_RETENTION_DAYS);
    return cutoff.toISOString().slice(0, 10);
  }, []);
  const selectedYearOutsideSettlementRetention = `${year}-12-31` < settlementRetentionCutoff;
  const settlementCoverage = useMemo(() => {
    const reports = reconciliation?.reports || [];
    const targetMonths = year === 2026 ? [1, 2, 3, 4] : [];
    const storedMonths = targetMonths.map((month) => ({ month, covered: reports.some((r: any) => reportCoversMonth(r, year, month)) }));
    const parsedReports = reports.filter((r: any) => r.status === "parsed");
    const dates = parsedReports.flatMap((r: any) => [r.settlement_start_date, r.settlement_end_date]).filter(Boolean).sort();
    return {
      storedMonths,
      isSafe: targetMonths.length > 0 && storedMonths.every((m) => m.covered),
      missingMonths: storedMonths.filter((m) => !m.covered).map((m) => MONTHS[m.month - 1]),
      earliest: dates[0] || null,
      latest: dates[dates.length - 1] || null,
      localLineItems: parsedReports.reduce((sum: number, r: any) => sum + Number(r.rows_parsed || 0), 0),
      currencies: Array.from(new Set(parsedReports.map((r: any) => r.currency).filter(Boolean))),
    };
  }, [reconciliation?.reports, year]);

  const loadReconciliation = async () => {
    if (!user?.id) return;
    setReconcileLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("reconcile-settlement", {
        body: { year },
      });
      if (error) throw error;
      setReconciliation(data);
    } catch (err: any) {
      toast({ title: "Reconciliation failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setReconcileLoading(false);
    }
  };

  const runSettlementSync = async (forceFullYear = false) => {
    if (!user?.id) return;
    setSettlementSyncing(true);
    setSettlementSyncResult(null);
    toast({
      title: "Syncing settlement reports…",
      description: `Checking Amazon's retrievable settlement reports. Amazon only keeps report documents for ${SETTLEMENT_REPORT_RETENTION_DAYS} days.`,
    });
    try {
      const { data, error } = await supabase.functions.invoke("sync-settlement-reports", {
        body: {
          action: "sync",
          fromDate: forceFullYear ? "2026-01-01" : `${year}-01-01`,
          toDate: new Date().toISOString().slice(0, 10),
        },
      });
      if (error) throw error;
      setSettlementSyncResult(data);
      const d: any = data;
      toast({
        title: "Settlement sync complete",
        description: d?.retentionWarning || `${d?.reportsFound ?? 0} reports found · ${d?.reportsDownloaded ?? d?.processed ?? 0} downloaded · ${d?.processed ?? 0} parsed · ${d?.totalLineItems ?? 0} line items.`,
      });
      // Refresh dashboard + reconciliation
      await loadReconciliation();
      await load();
    } catch (err: any) {
      console.error("[settlement-sync] failed:", err);
      toast({ title: "Settlement sync failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSettlementSyncing(false);
    }
  };

  // ─── Yearly Liquidation Audit (per-month per-source breakdown) ──────
  // Runs ONE month per edge-function call so we don't hit the function CPU
  // budget. Results stream into the table as each month completes, and the
  // Copy/Download buttons enable as soon as the first month is in.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<any | null>(null);
  const [auditProgress, setAuditProgress] = useState<{ done: number; total: number; current: number | null }>({ done: 0, total: 0, current: null });

  const runLiquidationAudit = async () => {
    if (!user?.id) return;
    setAuditing(true);
    const monthsList = Array.from({ length: 12 }, (_, i) => i + 1);
    setAuditProgress({ done: 0, total: monthsList.length, current: monthsList[0] });
    // Seed the result so the table renders immediately with placeholders.
    const initial: any = {
      ok: true,
      year,
      months: [] as any[],
      totals: {
        removal_event_revenue: 0, removal_adjustment_revenue: 0,
        fba_event_revenue: 0, adjustment_event_revenue: 0,
        computed_revenue: 0, computed_fee: 0,
        cached_revenue: 0, cached_fee: 0,
      },
    };
    setAuditResult(initial);

    let failures = 0;
    const accMonths: any[] = [];
    const totals = { ...initial.totals };

    for (let i = 0; i < monthsList.length; i++) {
      const m = monthsList[i];
      setAuditProgress({ done: i, total: monthsList.length, current: m });
      try {
        const { data, error } = await supabase.functions.invoke("audit-liquidations-year", {
          body: { year, months: [m], maxPagesPerMonth: 200 },
        });
        if (error) throw error;
        const monthRow = (data as any)?.months?.[0];
        if (monthRow) {
          accMonths.push(monthRow);
          totals.removal_event_revenue += monthRow.removal_event_liquidation_revenue || 0;
          totals.removal_adjustment_revenue += monthRow.removal_adjustment_liquidation_revenue || 0;
          totals.fba_event_revenue += monthRow.fba_liquidation_event_revenue || 0;
          totals.adjustment_event_revenue += monthRow.adjustment_event_liquidation_revenue || 0;
          totals.computed_revenue += monthRow.computed_liquidations_revenue || 0;
          totals.computed_fee += monthRow.computed_liquidations_brokerage_fee || 0;
          totals.cached_revenue += monthRow.cached_liquidations || 0;
          totals.cached_fee += monthRow.cached_liquidations_brokerage_fee || 0;
          // Update the visible result after each month so the table populates live.
          setAuditResult({ ok: true, year, months: [...accMonths], totals: { ...totals } });
        }
      } catch (err: any) {
        failures++;
        console.error(`[audit-liquidations-year] month ${m} failed:`, err);
        // Push a placeholder error row so the user sees which month failed.
        accMonths.push({
          year, month: m, label: `${year}-${String(m).padStart(2, "0")}`,
          pages_fetched: 0,
          removal_event_liquidation_revenue: 0, removal_event_liquidation_fee: 0, removal_event_liquidation_count: 0,
          removal_adjustment_liquidation_revenue: 0, removal_adjustment_liquidation_fee: 0, removal_adjustment_liquidation_count: 0,
          fba_liquidation_event_revenue: 0, fba_liquidation_event_fee: 0, fba_liquidation_event_count: 0,
          service_fee_liquidation_revenue: 0, service_fee_liquidation_count: 0,
          adjustment_event_liquidation_revenue: 0, adjustment_event_liquidation_count: 0,
          other_lists_with_liquidation: [],
          computed_liquidations_revenue: 0, computed_liquidations_brokerage_fee: 0,
          cached_liquidations: 0, cached_liquidations_brokerage_fee: 0, cached_event_count: 0,
          transaction_types_seen: {},
          error: err?.message || String(err),
        });
        setAuditResult({ ok: true, year, months: [...accMonths], totals: { ...totals } });
      }
    }

    setAuditProgress({ done: monthsList.length, total: monthsList.length, current: null });
    setAuditing(false);
    toast({
      title: failures > 0 ? `Audit finished with ${failures} month error(s)` : "Audit complete",
      description: `${accMonths.length} months analyzed for ${year}.${failures > 0 ? " See ⚠ rows for details." : ""}`,
      variant: failures > 0 ? "destructive" : "default",
    });
  };

  const copyAuditCsv = async () => {
    if (!auditResult?.months) return;
    const headers = [
      "Month",
      "RemovalEvent Rev", "RemovalEvent Fee", "RemovalEvent #",
      "RemovalAdjustment Rev", "RemovalAdjustment Fee", "RemovalAdjustment #",
      "FBALiquidationEvent Rev", "FBALiquidationEvent Fee", "FBALiquidationEvent #",
      "ServiceFee Liq Rev", "ServiceFee Liq #",
      "AdjustmentEvent Liq Rev", "AdjustmentEvent Liq #",
      "Computed Rev (sum)", "Computed Fee (sum)",
      "Cached/Displayed Rev", "Cached/Displayed Fee", "Cached events",
      "Other lists w/ 'liquid'",
      "Pages", "Error",
    ];
    const rows = (auditResult.months as any[]).map((m) => [
      m.label,
      m.removal_event_liquidation_revenue.toFixed(2),
      m.removal_event_liquidation_fee.toFixed(2),
      m.removal_event_liquidation_count,
      m.removal_adjustment_liquidation_revenue.toFixed(2),
      m.removal_adjustment_liquidation_fee.toFixed(2),
      m.removal_adjustment_liquidation_count,
      m.fba_liquidation_event_revenue.toFixed(2),
      m.fba_liquidation_event_fee.toFixed(2),
      m.fba_liquidation_event_count,
      m.service_fee_liquidation_revenue.toFixed(2),
      m.service_fee_liquidation_count,
      m.adjustment_event_liquidation_revenue.toFixed(2),
      m.adjustment_event_liquidation_count,
      m.computed_liquidations_revenue.toFixed(2),
      m.computed_liquidations_brokerage_fee.toFixed(2),
      m.cached_liquidations.toFixed(2),
      m.cached_liquidations_brokerage_fee.toFixed(2),
      m.cached_event_count,
      (m.other_lists_with_liquidation || []).map((o: any) => `${o.list}:${o.hits}`).join("|"),
      m.pages_fetched,
      m.error || "",
    ].join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    try {
      await navigator.clipboard.writeText(csv);
      toast({ title: "Copied", description: "Audit table copied as CSV." });
    } catch (err: any) {
      toast({ title: "Copy failed", description: err?.message || "Manual copy required.", variant: "destructive" });
    }
  };

  const downloadAuditJson = () => {
    if (!auditResult) return;
    const blob = new Blob([JSON.stringify(auditResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `liquidation-audit-${year}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };


  // ─── Per-row signed values (used by both totals + cells) ────────────
  const signedRows = useMemo(() => {
    if (!rows) return null;
    const sign = (key: keyof MonthRow, negative?: boolean) =>
      rows.map((r) => {
        const v = Number(r[key] ?? 0);
        return negative ? -v : v;
      });
    return { sign };
  }, [rows]);

  // ─── Operating Expenses (My Expenses) → grouped by category × month ──
  // Each category becomes a row. All values negative (deduct from profit).
  const opExpensesByCategory = useMemo(() => {
    if (!expenses) return null;
    const map = new Map<string, number[]>();
    for (const exp of expenses) {
      const cat = (exp.category || "Uncategorized").trim() || "Uncategorized";
      const occ = expandExpenseIntoYear(exp, year);
      if (occ.length === 0) continue;
      let arr = map.get(cat);
      if (!arr) {
        arr = Array(12).fill(0);
        map.set(cat, arr);
      }
      for (const o of occ) arr[o.m] += o.amount;
    }
    return Array.from(map.entries())
      .map(([category, monthly]) => ({
        category,
        monthly,
        total: monthly.reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total); // biggest first
  }, [expenses, year]);

  const opExpensesMonthTotals = useMemo(() => {
    if (!opExpensesByCategory) return Array(12).fill(0);
    return Array.from({ length: 12 }, (_, m) =>
      opExpensesByCategory.reduce((acc, c) => acc + c.monthly[m], 0)
    );
  }, [opExpensesByCategory]);

  const opExpensesGrandTotal = useMemo(
    () => opExpensesMonthTotals.reduce((a, b) => a + b, 0),
    [opExpensesMonthTotals]
  );

  // ─── COGS monthly + coverage stats ──────────────────────────────────
  const cogsMonthly = useMemo(
    () => (cogsRows ?? Array(12).fill(0).map((_, i) => ({ month_num: i + 1, cogs: 0 } as CogsRow)))
      .map((r) => Number(r.cogs) || 0),
    [cogsRows]
  );
  const cogsGrandTotal = useMemo(() => cogsMonthly.reduce((a, b) => a + b, 0), [cogsMonthly]);
  const cogsAdjustmentMonthly = useMemo(() => {
    const monthly = Array(12).fill(0) as number[];
    for (const adjustment of cogsAdjustments) {
      const amount = Number(adjustment.amount) || 0;
      const start = new Date(`${adjustment.period_start}T00:00:00`);
      const end = new Date(`${adjustment.period_end}T00:00:00`);
      const overlapMonths: number[] = [];
      for (let i = 0; i < 12; i++) {
        const monthStart = new Date(year, i, 1);
        const monthEnd = new Date(year, i + 1, 1);
        if (start < monthEnd && end >= monthStart) overlapMonths.push(i);
      }
      if (overlapMonths.length === 0) continue;
      const perMonth = amount / overlapMonths.length;
      for (const i of overlapMonths) monthly[i] += perMonth;
    }
    return monthly;
  }, [cogsAdjustments, year]);
  const cogsAdjustmentGrandTotal = useMemo(() => cogsAdjustmentMonthly.reduce((a, b) => a + b, 0), [cogsAdjustmentMonthly]);
  const totalCogsMonthly = useMemo(() => cogsMonthly.map((v, i) => v + cogsAdjustmentMonthly[i]), [cogsMonthly, cogsAdjustmentMonthly]);
  const totalCogsGrandTotal = useMemo(() => totalCogsMonthly.reduce((a, b) => a + b, 0), [totalCogsMonthly]);
  const cogsCoverage = useMemo(() => {
    if (!cogsRows) return null;
    const totalUnits = cogsRows.reduce((a, r) => a + Number(r.units_sold || 0), 0);
    const withCost = cogsRows.reduce((a, r) => a + Number(r.units_with_cost || 0), 0);
    const missingUnits = cogsRows.reduce((a, r) => a + Number(r.units_missing_cost || 0), 0);
    const missingOrders = cogsRows.reduce((a, r) => a + Number(r.orders_missing_cost || 0), 0);
    const missingAsins = cogsRows.reduce((a, r) => a + Number(r.asins_missing_cost || 0), 0);
    const pct = totalUnits > 0 ? (withCost / totalUnits) * 100 : 0;
    return { totalUnits, withCost, missingUnits, missingOrders, missingAsins, pct };
  }, [cogsRows]);

  // Inventory Loss = disposition + warehouse write-off. Both halves are real
  // losses; the write-off half was missing from this report entirely until
  // 2026-08-19, which is why its Net Profit was better than the Excel export's.
  const inventoryLossMonthly = useMemo(
    () => Array.from({ length: 12 }, (_, i) => (dispoMonthly[i] || 0) + (writeoffMonthly[i] || 0)),
    [dispoMonthly, writeoffMonthly],
  );
  const writeoffGrandTotal = useMemo(
    () => writeoffMonthly.reduce((a, b) => a + b, 0),
    [writeoffMonthly],
  );

  // ─── Section totals per month + grand totals ────────────────────────
  const monthTotals = useMemo(() => {
    if (!rows || !signedRows) return null;
    const sum = (defs: RowDef[]) =>
      Array.from({ length: 12 }, (_, m) =>
        defs.reduce((acc, d) => {
          if (d.informational) return acc;
          const v = rowValue(rows[m], d);
          return acc + (d.negative ? -v : v);
        }, 0)
      );
    const income = sum(effectiveIncomeRows);
    const expenses = sum(effectiveExpenseRows);
    const other = sum(OTHER_ROWS);
    // Net = Income + Amazon expenses (negative) − COGS − operating expenses − disposition loss
    //
    // In the Amazon-only view those last three terms are not RENDERED, so they
    // must not be subtracted either -- a total that disagrees with the visible
    // rows is worse than no total at all.
    // fbmLabelMonthly is subtracted in BOTH views: it is money Amazon charged,
    // so it belongs in "net from Amazon" just as much as in Net Profit.
    const net = income.map((v, i) =>
      amazonOnly
        ? v + expenses[i] - (fbmLabelMonthly[i] || 0)
        : v + expenses[i] - totalCogsMonthly[i] - opExpensesMonthTotals[i] - (inventoryLossMonthly[i] || 0) - (fbmLabelMonthly[i] || 0)
    );
    return { income, expenses, other, net };
  }, [rows, signedRows, opExpensesMonthTotals, totalCogsMonthly, inventoryLossMonthly, effectiveIncomeRows, effectiveExpenseRows, amazonOnly, fbmLabelMonthly]);

  const dispoGrandTotal = useMemo(() => dispoMonthly.reduce((a, b) => a + b, 0), [dispoMonthly]);
  const inventoryLossGrandTotal = useMemo(
    () => inventoryLossMonthly.reduce((a, b) => a + b, 0),
    [inventoryLossMonthly],
  );

  const grand = useMemo(() => {
    if (!monthTotals) return null;
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    return {
      income: sum(monthTotals.income),
      expenses: sum(monthTotals.expenses),
      other: sum(monthTotals.other),
      net: sum(monthTotals.net),
    };
  }, [monthTotals]);

  const fbmLabelGrandTotal = useMemo(
    () => fbmLabelMonthly.reduce((a, b) => a + b, 0),
    [fbmLabelMonthly],
  );

  // Amazon's cut as a share of gross sales. The headline ratio of the
  // Amazon-only view, and the only figure here comparable across months
  // regardless of volume -- 2026 ran 38.3%-41.3% with no month out of line,
  // so a month that breaks that band is signal rather than seasonality.
  const feeRate = useMemo(() => {
    if (!rows || !monthTotals || !grand) return null;
    const monthly = Array.from({ length: 12 }, (_, m) => {
      const s = Number(rows[m]?.sales ?? 0);
      return s > 0.005 ? (Math.abs(monthTotals.expenses[m]) / s) * 100 : null;
    });
    const totalSales = rows.reduce((a, r) => a + Number(r?.sales ?? 0), 0);
    return {
      monthly,
      grand: totalSales > 0.005 ? (Math.abs(grand.expenses) / totalSales) * 100 : null,
    };
  }, [rows, monthTotals, grand]);

  if (loading) {
    return (
      <Card className="mb-8">
        <CardContent className="py-10 flex items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading monthly breakdown…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-8">
        <CardContent className="py-6 text-center text-destructive text-sm">
          {error}
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={load}>
              <RefreshCw className="w-3 h-3 mr-1" /> Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!rows || !grand || !monthTotals) return null;

  const renderSection = (title: string, defs: RowDef[], totals: number[], grandTotal: number) => (
    <>
      {/* Section header — label only, no values (InventoryLab style) */}
      <tr className="bg-muted/60">
        <td
          className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/60 z-10"
          colSpan={14}
        >
          {title}
        </td>
      </tr>
      {/* Line items */}
      {defs.map((d) => {
        const monthly = rows.map((r) => {
          const v = rowValue(r, d);
          return d.negative ? -v : v;
        });
        const total = monthly.reduce((a, b) => a + b, 0);
        return (
          <tr key={d.label} className={`hover:bg-muted/30 border-b border-border/40 ${d.informational ? "italic" : ""}`}>
            <td className={`px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 ${d.indent ? "pl-8 text-muted-foreground" : d.informational ? "text-muted-foreground" : "text-foreground"}`}>
              {d.key === "other_fees" ? (
                <button
                  type="button"
                  onClick={openOtherFeesDrilldown}
                  className="text-left underline decoration-dotted underline-offset-2 hover:text-primary"
                  title="Click to see what's inside Amazon Fee Adjustments"
                >
                  {d.label}
                </button>
              ) : (
                d.label
              )}
            </td>
            <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${d.informational ? "text-muted-foreground" : total < 0 ? "text-destructive" : "text-foreground"}`}>
              {fmt(total, total < 0)}
            </td>
            {monthly.map((v, i) => (
              <td key={i} className={`px-3 py-1.5 text-right tabular-nums ${d.informational ? "text-muted-foreground" : v < 0 ? "text-destructive" : "text-foreground"}`}>
                {fmt(v, v < 0)}
              </td>
            ))}
          </tr>
        );
      })}
      {/* Section "Total" row — bold, sits at the bottom (InventoryLab style) */}
      <tr className="bg-muted/40 border-y-2 border-border">
        <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/40 z-10">Total</td>
        <td className={`px-3 py-2 text-right font-bold tabular-nums ${grandTotal < 0 ? "text-destructive" : "text-foreground"}`}>
          {fmt(grandTotal, grandTotal < 0)}
        </td>
        {totals.map((v, i) => (
          <td key={i} className={`px-3 py-2 text-right font-bold tabular-nums ${v < 0 ? "text-destructive" : "text-foreground"}`}>
            {fmt(v, v < 0)}
          </td>
        ))}
      </tr>
    </>
  );

  return (
    <>
    {/* Sticky live progress banner — visible while Backfill is running */}
    {backfilling && backfillProgress && (
      <div className="sticky top-0 z-50 mb-3 rounded-lg border-2 border-primary bg-primary/10 backdrop-blur px-4 py-3 shadow-lg animate-pulse">
        <div className="flex items-center gap-3">
          <Database className="w-5 h-5 text-primary animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="font-semibold text-sm">
                ⏳ Backfilling {year} — {backfillProgress.done} of {backfillProgress.total} months done
                {backfillProgress.current && <span className="ml-2 font-mono text-primary">{backfillProgress.current}</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                Elapsed: {(() => {
                  const s = Math.round((Date.now() - backfillProgress.startedAt) / 1000);
                  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
                })()} · Each month ~2–5 min · Keep tab open
              </div>
            </div>
            <div className="mt-2 h-2 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: `${(backfillProgress.done / Math.max(backfillProgress.total, 1)) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    )}
    {/* Completion banner — shows briefly after backfill finishes */}
    {!backfilling && backfillResult && (
      <div className={`mb-3 rounded-lg border-2 px-4 py-3 flex items-center justify-between gap-3 ${backfillResult.ok ? "border-green-500 bg-green-500/10" : "border-destructive bg-destructive/10"}`}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-lg">{backfillResult.ok ? "✅" : "⚠️"}</span>
          {backfillResult.ok
            ? `Backfill complete — ${backfillResult.total} months re-synced in ${backfillResult.elapsedSec}s`
            : `Backfill finished with ${backfillResult.failures} error(s) of ${backfillResult.total} months (${backfillResult.elapsedSec}s)`}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setBackfillResult(null)}>Dismiss</Button>
      </div>
    )}
    <Card className="mb-8">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base">Monthly P&L Breakdown — {year}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Settlement-based view. All marketplaces aggregated in USD. Source: financial_events_cache.
              {amazonOnly && " Amazon only — COGS, operating expenses and inventory loss are hidden, so nothing below is hand-entered."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={amazonOnly ? "default" : "outline"}
              onClick={() => setAmazonOnly(!amazonOnly)}
              title={amazonOnly
                ? "Showing only what Amazon pays and charges. Click to bring back COGS, operating expenses and inventory loss."
                : "Show only what Amazon pays and charges -- hides COGS, operating expenses and inventory loss, all of which are hand-entered."}
            >
              <Store className="w-3 h-3 mr-1" />
              {amazonOnly ? "Amazon only — on" : "Amazon only"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={backfillYear}
              disabled={backfilling || loading}
              title={`Re-parse all of ${year} from Amazon SP-API. Use after schema changes (e.g. new Shipping Chargeback fields) to populate historical data.`}
            >
              <Database className={`w-3 h-3 mr-1 ${backfilling ? "animate-spin" : ""}`} />
              {backfilling
                ? `Backfilling ${backfillProgress?.done ?? 0}/${backfillProgress?.total ?? 0}…`
                : `Backfill ${year}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setDiagnoseResult(null); setDiagnoseOpen(true); }}
              disabled={loading}
              title="Read-only diagnostic. Fetches one month of raw SP-API financial events and reports which event lists contain liquidation data for your account."
            >
              <Search className="w-3 h-3 mr-1" />
              Diagnose Liquidations
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setAuditResult(null); setAuditOpen(true); }}
              disabled={loading}
              title="Read-only. For every month of the year, breaks down liquidation revenue/fees by SP-API source list and compares to what's currently in your P&L cache. Slow — fetches all 12 months from Amazon."
            >
              <Search className="w-3 h-3 mr-1" />
              Audit Liquidations ({year})
            </Button>
            <Button
              size="lg"
              onClick={async () => { setSettlementOpen(true); await loadReconciliation(); }}
              disabled={loading || settlementSyncing}
              title="Pull Amazon's settlement reports — the ONLY source of full disposal fees, removal-order processing fees, and storage fees. Required for full settlement-based reconciliation."
              className="bg-green-600 hover:bg-green-700 text-white font-semibold text-base px-6 py-5 shadow-md"
            >
              <Database className={`w-5 h-5 mr-2 ${settlementSyncing ? "animate-spin" : ""}`} />
              {settlementSyncing ? "Syncing settlements…" : "Settlement Reports"}
            </Button>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3 h-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-background z-20">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground sticky left-0 bg-background z-30 min-w-[260px]">Category</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground bg-muted/30 min-w-[110px]">Total</th>
                {MONTHS.map((m, i) => {
                  const isHighlighted = highlightSet.has(i + 1);
                  return (
                    <th
                      key={m}
                      className={`px-3 py-2 text-right font-semibold min-w-[100px] ${isHighlighted ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}
                    >
                      {m}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* ─── COGS Coverage banner — PROMOTED to top so users see P&L completeness first ─── */}
              {/* Hidden in the Amazon-only view: it reports on COGS, which is not shown there. */}
              {!amazonOnly && cogsCoverage && (
                <tr>
                  <td
                    colSpan={14}
                    className={`px-3 py-2.5 text-xs border-b-2 ${
                      cogsCoverage.pct >= 99
                        ? "bg-green-50 dark:bg-green-950/30 border-green-500/50 text-green-800 dark:text-green-300"
                        : cogsCoverage.pct >= 95
                          ? "bg-amber-50 dark:bg-amber-950/30 border-amber-500/50 text-amber-800 dark:text-amber-300"
                          : "bg-destructive/10 border-destructive/40 text-destructive"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {cogsCoverage.pct >= 99 ? (
                        <span className="text-base leading-none mt-0.5">✓</span>
                      ) : (
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                      )}
                      <div className="flex-1">
                        <strong className="text-sm">
                          {cogsCoverage.pct >= 99
                            ? `P&L is complete — COGS coverage ${cogsCoverage.pct.toFixed(1)}%`
                            : cogsCoverage.pct >= 95
                              ? `Mostly complete — COGS coverage ${cogsCoverage.pct.toFixed(1)}%`
                              : `Incomplete — COGS coverage ${cogsCoverage.pct.toFixed(1)}%`}
                        </strong>
                        {cogsCoverage.missingUnits > 0 && (
                          <span className="ml-2">
                            {cogsCoverage.missingUnits.toLocaleString()} units across{" "}
                            {cogsCoverage.missingOrders.toLocaleString()} orders and{" "}
                            {cogsCoverage.missingAsins.toLocaleString()} ASINs missing cost.{" "}
                            <Link to="/tools/my-database-products" className="underline font-medium">
                              Fix in Product Library →
                            </Link>
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}

              {renderSection("Income", effectiveIncomeRows, monthTotals.income, grand.income)}
              {renderSection("Amazon Expenses", effectiveExpenseRows, monthTotals.expenses, grand.expenses)}

              {/* FBM Shipping Labels — its own section because it is the one
                  Amazon charge sourced from sales_orders rather than
                  financial_events_cache, and folding it into the block above
                  would imply it shares that provenance. Shown in the
                  Amazon-only view too: Amazon charged it. */}
              {fbmLabelGrandTotal > 0.005 && (
                <>
                  <tr className="bg-muted/60">
                    <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/60 z-10" colSpan={14}>
                      FBM Shipping Labels
                    </td>
                  </tr>
                  <tr className="hover:bg-muted/30 border-b border-border/40" title="Amazon Buy Shipping label cost on merchant-fulfilled orders. Source: sales_orders.shipping_label_fee, filled by poll-fbm-label-costs.">
                    <td className="px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 text-foreground">
                      Buy Shipping Label Cost
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-destructive">
                      {fmt(-fbmLabelGrandTotal, fbmLabelGrandTotal > 0.005)}
                    </td>
                    {fbmLabelMonthly.map((v, i) => (
                      <td key={i} className="px-3 py-1.5 text-right tabular-nums text-destructive">
                        {fmt(-v, v > 0.005)}
                      </td>
                    ))}
                  </tr>
                </>
              )}

              {/* COGS, Operating Expenses and Inventory Loss — the three sections that are
                  NOT sourced from Amazon. Every figure in them is hand-entered, so they are
                  hidden wholesale in the Amazon-only view rather than zeroed: a zero would
                  read as "no COGS", which is a different and false claim. */}
              {!amazonOnly && (<>
              {/* Cost of Goods Sold — from sales_orders.unit_cost (with created_listings fallback) */}
              <tr className="bg-muted/60">
                <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/60 z-10" colSpan={14}>
                  Cost of Goods Sold (COGS)
                  <Link to="/tools/my-database-products" className="ml-2 text-xs font-normal text-primary hover:underline">
                    Manage costs →
                  </Link>
                </td>
              </tr>
              <tr className="hover:bg-muted/30 border-b border-border/40">
                <td className="px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 text-foreground">
                  COGS (unit cost × units sold)
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-destructive">
                  {fmt(-cogsGrandTotal, cogsGrandTotal > 0)}
                </td>
                {cogsMonthly.map((v, i) => (
                  <td key={i} className="px-3 py-1.5 text-right tabular-nums text-destructive">
                    {fmt(-v, v > 0)}
                  </td>
                ))}
              </tr>
              {Math.abs(cogsAdjustmentGrandTotal) > 0.005 && (
                <tr className="hover:bg-muted/30 border-b border-border/40" title="Manual COGS adjustments (e.g. migration / opening balance / manual corrections). Manage in the COGS Adjustments panel below the table.">
                  <td className="px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 text-foreground pl-6">
                    + COGS Adjustments
                    <span className="ml-2 text-[11px] text-muted-foreground">(migration / manual / opening balance)</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-destructive">
                    {fmt(-cogsAdjustmentGrandTotal, cogsAdjustmentGrandTotal > 0)}
                  </td>
                  {cogsAdjustmentMonthly.map((v, i) => (
                    <td key={i} className="px-3 py-1.5 text-right tabular-nums text-destructive">
                      {fmt(-v, v > 0)}
                    </td>
                  ))}
                </tr>
              )}
              <tr className="bg-muted/40 border-y-2 border-border">
                <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/40 z-10">Total COGS</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums text-destructive">
                  {fmt(-totalCogsGrandTotal, totalCogsGrandTotal > 0)}
                </td>
                {totalCogsMonthly.map((v, i) => (
                  <td key={i} className="px-3 py-2 text-right font-bold tabular-nums text-destructive">
                    {fmt(-v, v > 0)}
                  </td>
                ))}
              </tr>

              {/* Operating Expenses (My Expenses) — operating costs by category */}
              <tr className="bg-muted/60">
                <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/60 z-10" colSpan={14}>
                  Operating Expenses
                  <Link to="/tools/expenses" className="ml-2 text-xs font-normal text-primary hover:underline">
                    Manage →
                  </Link>
                </td>
              </tr>
              {opExpensesByCategory && opExpensesByCategory.length > 0 ? (
                <>
                  {opExpensesByCategory.map((row) => (
                    <tr key={row.category} className="hover:bg-muted/30 border-b border-border/40">
                      <td className="px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 text-foreground">
                        {row.category}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium text-destructive">
                        {fmt(-row.total, true)}
                      </td>
                      {row.monthly.map((v, i) => (
                        <td key={i} className="px-3 py-1.5 text-right tabular-nums text-destructive">
                          {fmt(-v, v > 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="bg-muted/40 border-y-2 border-border">
                    <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/40 z-10">Total Operating Expenses</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-destructive">
                      {fmt(-opExpensesGrandTotal, opExpensesGrandTotal > 0)}
                    </td>
                    {opExpensesMonthTotals.map((v, i) => (
                      <td key={i} className="px-3 py-2 text-right font-bold tabular-nums text-destructive">
                        {fmt(-v, v > 0)}
                      </td>
                    ))}
                  </tr>
                </>
              ) : (
                <tr>
                  <td colSpan={14} className="px-3 py-3 text-xs text-muted-foreground italic">
                    No operating expenses recorded for {year}.{" "}
                    <Link to="/tools/expenses" className="text-primary hover:underline">
                      Add an expense →
                    </Link>
                  </td>
                </tr>
              )}

              {/* Inventory Disposition Loss */}
              <tr className="bg-muted/60">
                <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/60 z-10" colSpan={14}>
                  Inventory Disposition
                  <Link to="/tools/disposition-management" className="ml-2 text-xs font-normal text-primary hover:underline">
                    Manage →
                  </Link>
                </td>
              </tr>
              {inventoryLossGrandTotal > 0.005 ? (
                <>
                  <tr className="hover:bg-muted/30 border-b border-border/40">
                    <td className="px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 text-foreground">
                      Removal / Disposal / Restricted Loss
                      <span className="text-[11px] text-muted-foreground ml-2">
                        ({dispoUnits.toLocaleString()} units written off)
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium text-destructive">
                      {fmt(-dispoGrandTotal, true)}
                    </td>
                    {dispoMonthly.map((v, i) => (
                      <td key={i} className="px-3 py-1.5 text-right tabular-nums text-destructive">
                        {fmt(-v, v > 0.005)}
                      </td>
                    ))}
                  </tr>
                  {/* Warehouse write-offs. Shown as its own line rather than folded
                      into the disposition row, because the two come from different
                      tables and only one of them was previously counted here. */}
                  {writeoffGrandTotal > 0.005 && (
                    <tr className="hover:bg-muted/30 border-b border-border/40">
                      <td className="px-3 py-1.5 sticky left-0 bg-background hover:bg-muted/30 z-10 text-foreground">
                        Warehouse Write-Off
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium text-destructive">
                        {fmt(-writeoffGrandTotal, true)}
                      </td>
                      {writeoffMonthly.map((v, i) => (
                        <td key={i} className="px-3 py-1.5 text-right tabular-nums text-destructive">
                          {fmt(-v, v > 0.005)}
                        </td>
                      ))}
                    </tr>
                  )}
                  <tr className="bg-muted/40 border-y-2 border-border">
                    <td className="px-3 py-2 font-bold text-foreground sticky left-0 bg-muted/40 z-10">Total Inventory Loss</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-destructive">
                      {fmt(-inventoryLossGrandTotal, inventoryLossGrandTotal > 0.005)}
                    </td>
                    {inventoryLossMonthly.map((v, i) => (
                      <td key={i} className="px-3 py-2 text-right font-bold tabular-nums text-destructive">
                        {fmt(-v, v > 0.005)}
                      </td>
                    ))}
                  </tr>
                </>
              ) : (
                <tr>
                  <td colSpan={14} className="px-3 py-3 text-xs text-muted-foreground italic">
                    No accepted disposition losses recorded for {year}.{" "}
                    <Link to="/tools/disposition-management" className="text-primary hover:underline">
                      Review removals →
                    </Link>
                  </td>
                </tr>
              )}
              </>)}

              {/* ═══════════════ NET PROFIT/LOSS — prominent, large, easy to scan ═══════════════ */}
              <tr className="border-t-4 border-primary">
                <td colSpan={14} className="px-3 pt-3 pb-0 sticky left-0 bg-background z-10" />
              </tr>
              <tr className={`${grand.net >= 0 ? "bg-green-50 dark:bg-green-950/40" : "bg-red-50 dark:bg-red-950/40"} border-y-2 border-primary`}>
                <td className={`px-3 py-4 font-extrabold text-base sticky left-0 z-10 ${grand.net >= 0 ? "bg-green-50 dark:bg-green-950/40 text-foreground" : "bg-red-50 dark:bg-red-950/40 text-foreground"}`}>
                  {amazonOnly ? "NET FROM AMAZON" : "NET PROFIT/LOSS"}
                  <div className="text-[10px] font-normal text-muted-foreground mt-0.5">
                    {amazonOnly
                      ? "Income − Amazon Expenses. What Amazon net-deposits, before COGS and overhead. This is NOT profit."
                      : "Income − Amazon Expenses − COGS − Operating Expenses − Inventory Loss"}
                  </div>
                </td>
                <td className={`px-3 py-4 text-right font-extrabold tabular-nums text-lg ${grand.net < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}>
                  {fmt(grand.net, grand.net < 0)}
                </td>
                {monthTotals.net.map((v, i) => (
                  <td key={i} className={`px-3 py-4 text-right font-bold tabular-nums text-sm ${v < 0 ? "text-destructive" : "text-foreground"}`}>
                    {fmt(v, v < 0)}
                  </td>
                ))}
              </tr>

              {/* Amazon's take as a share of gross sales. Only meaningful in the
                  Amazon-only view, where the rows above are the whole picture. */}
              {amazonOnly && feeRate && (
                <tr className="border-b-2 border-border bg-muted/30">
                  <td className="px-3 py-2 font-semibold text-foreground sticky left-0 bg-muted/30 z-10">
                    Amazon's take
                    <div className="text-[10px] font-normal text-muted-foreground mt-0.5">
                      Amazon Expenses as % of gross Sales
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-foreground">
                    {feeRate.grand === null ? "—" : `${feeRate.grand.toFixed(1)}%`}
                  </td>
                  {feeRate.monthly.map((v, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {v === null ? "—" : `${v.toFixed(1)}%`}
                    </td>
                  ))}
                </tr>
              )}

              {/* ═══════════════ Informational sections — BELOW Net Profit, NEVER in profit math ═══════════════ */}
              {mode === 'reconciled' && (
                <>
                  {/* Tax Information — collapsed by default, clearly labeled informational */}
                  {renderSection(
                    "▾ Tax Information (Informational Only — not included in Net Profit/Loss)",
                    OTHER_ROWS,
                    monthTotals.other,
                    grand.other,
                  )}

                  {/* Memo / Informational Items — already counted elsewhere */}
                  {renderSection(
                    "▾ Memo / Informational Items (already included above — shown for audit)",
                    MEMO_ROWS,
                    Array(12).fill(0),
                    0,
                  )}
                </>
              )}
            </tbody>

          </table>
        </div>
        <p className="text-[11px] text-muted-foreground px-4 py-3 border-t border-border">
          COGS is calculated as <strong>unit_cost × units sold</strong> from your sales orders, falling back to the latest cost in the Product Library when the order has no cost yet. Add costs in the Product Library to improve coverage.
        </p>

        {/* ═══════════════ Bottom summary bar — Net Profit (left) · Total Expenses (right) ═══════════════ */}
        <div className="flex items-center justify-between gap-4 px-4 py-4 border-t-2 border-primary bg-muted/40">
          <div className="flex flex-col">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Net Profit/Loss</span>
            <span className={`text-2xl font-extrabold tabular-nums ${grand.net < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}>
              {fmt(grand.net, grand.net < 0)}
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Total Sales</span>
            <span className="text-2xl font-extrabold tabular-nums text-foreground">
              {fmt(grand.income, false)}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Total Expenses</span>
            {(() => {
              const trueTotal = Math.abs(grand.expenses) + totalCogsGrandTotal + opExpensesGrandTotal + inventoryLossGrandTotal;
              return (
                <span className="text-2xl font-extrabold tabular-nums text-foreground">
                  {fmt(-trueTotal, true)}
                </span>
              );
            })()}
            <span className="text-[10px] text-muted-foreground mt-0.5">
              Amazon + COGS + Operating + Inventory Loss
            </span>
          </div>
        </div>
      </CardContent>
    </Card>

    <Dialog open={diagnoseOpen} onOpenChange={setDiagnoseOpen}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Diagnose Liquidations — {year}</DialogTitle>
          <DialogDescription>
            Read-only. Fetches one month of raw SP-API financial events and reports which event lists contain liquidation data for your account. Does not modify your P&L.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 py-2">
          <span className="text-sm text-muted-foreground">Month:</span>
          <Select value={String(diagnoseMonth)} onValueChange={(v) => setDiagnoseMonth(Number(v))} disabled={diagnosing}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>{m} {year}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={runDiagnoseLiquidations} disabled={diagnosing}>
            {diagnosing ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Running…</> : <><Search className="w-3 h-3 mr-1" /> Run diagnostic</>}
          </Button>
        </div>

        {diagnoseResult && (
          <div className="flex-1 overflow-auto border border-border rounded-md bg-muted/30">
            {(() => {
              const summary = (diagnoseResult as any)?.summary;
              const samples = (diagnoseResult as any)?.liquidation_samples ?? [];
              const reports = (diagnoseResult as any)?.reports ?? [];
              const hitReports = reports.filter((r: any) => r.events_with_liquidation_keyword > 0);
              return (
                <div className="p-3 space-y-3">
                  {summary && (
                    <div className="text-xs space-y-1">
                      <div><strong>Month:</strong> {summary.month}</div>
                      <div><strong>Pages fetched:</strong> {summary.pages_fetched}</div>
                      <div><strong>Total events:</strong> {summary.total_events}</div>
                      <div><strong>Liquidation hits:</strong> {summary.events_with_liquidation_keyword}</div>
                      <div><strong>Lists with liquidation data:</strong>{" "}
                        {(summary.lists_with_liquidation_data?.length ?? 0) === 0
                          ? <span className="text-muted-foreground">none</span>
                          : summary.lists_with_liquidation_data.join(", ")}
                      </div>
                    </div>
                  )}
                  {hitReports.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold mb-1">Lists with liquidation hits:</div>
                      <pre className="text-[10px] whitespace-pre-wrap break-all bg-background p-2 rounded border border-border">
{JSON.stringify(hitReports, null, 2)}
                      </pre>
                    </div>
                  )}
                  {samples.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold mb-1">Sample liquidation events ({samples.length}):</div>
                      <pre className="text-[10px] whitespace-pre-wrap break-all bg-background p-2 rounded border border-border">
{JSON.stringify(samples, null, 2)}
                      </pre>
                    </div>
                  )}
                  <details>
                    <summary className="text-xs font-semibold cursor-pointer">Full raw JSON</summary>
                    <pre className="text-[10px] whitespace-pre-wrap break-all bg-background p-2 rounded border border-border mt-1">
{JSON.stringify(diagnoseResult, null, 2)}
                    </pre>
                  </details>
                </div>
              );
            })()}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={copyDiagnoseJson} disabled={!diagnoseResult}>
            <Copy className="w-3 h-3 mr-1" /> Copy JSON
          </Button>
          <Button size="sm" variant="outline" onClick={downloadDiagnoseJson} disabled={!diagnoseResult}>
            <Download className="w-3 h-3 mr-1" /> Download
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDiagnoseOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
      <DialogContent className="max-w-[95vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Liquidation Audit — {year}</DialogTitle>
          <DialogDescription>
            Per-month breakdown of liquidation revenue & fees split by SP-API source list, compared to what's currently in your P&L cache. Slow — fetches all 12 months of financial events from Amazon. Read-only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 py-2">
          <Button size="sm" onClick={runLiquidationAudit} disabled={auditing}>
            {auditing
              ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Auditing month {auditProgress.current ?? "—"} ({auditProgress.done}/{auditProgress.total})…</>
              : <><Search className="w-3 h-3 mr-1" /> Run audit for {year}</>}
          </Button>
          {auditResult?.totals && (
            <span className="text-xs text-muted-foreground ml-2">
              Total computed rev: <strong>${(auditResult.totals.computed_revenue ?? 0).toFixed(2)}</strong> · cached rev: <strong>${(auditResult.totals.cached_revenue ?? 0).toFixed(2)}</strong>
            </span>
          )}
        </div>

        {auditResult?.months && (
          <div className="flex-1 overflow-auto border border-border rounded-md">
            <table className="w-full text-[11px] border-collapse">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-semibold">Month</th>
                  <th className="px-2 py-2 text-right font-semibold" title="RemovalShipmentEventList with TransactionType containing LIQUIDATION">RemovalEvent Rev</th>
                  <th className="px-2 py-2 text-right font-semibold">RemovalEvent Fee</th>
                  <th className="px-2 py-2 text-right font-semibold" title="RemovalShipmentAdjustmentEventList with TransactionType containing LIQUIDATION">Adj Rev</th>
                  <th className="px-2 py-2 text-right font-semibold">Adj Fee</th>
                  <th className="px-2 py-2 text-right font-semibold" title="FBALiquidationEventList (legacy/alt list)">FBALiqEvent Rev</th>
                  <th className="px-2 py-2 text-right font-semibold">FBALiqEvent Fee</th>
                  <th className="px-2 py-2 text-right font-semibold" title="ServiceFeeEventList entries whose FeeType matches /liquid/i">SvcFee Liq</th>
                  <th className="px-2 py-2 text-right font-semibold" title="AdjustmentEventList with AdjustmentType containing LIQUID">AdjEvt Liq</th>
                  <th className="px-2 py-2 text-right font-semibold bg-muted/40" title="Sum of all source revenues — what your P&L SHOULD show">Computed Rev</th>
                  <th className="px-2 py-2 text-right font-semibold bg-muted/40">Computed Fee</th>
                  <th className="px-2 py-2 text-right font-semibold bg-primary/10" title="What is currently in financial_events_cache (= shown in P&L)">Cached Rev</th>
                  <th className="px-2 py-2 text-right font-semibold bg-primary/10">Cached Fee</th>
                  <th className="px-2 py-2 text-right font-semibold" title="Computed Rev − Cached Rev. >0 means cache is missing data.">Δ Rev</th>
                  <th className="px-2 py-2 text-left font-semibold">Other lists w/ 'liquid'</th>
                  <th className="px-2 py-2 text-right font-semibold">Pages</th>
                </tr>
              </thead>
              <tbody>
                {(auditResult.months as any[]).map((m) => {
                  const delta = (m.computed_liquidations_revenue ?? 0) - (m.cached_liquidations ?? 0);
                  const fmt = (n: number) => (n === 0 ? "—" : `$${n.toFixed(2)}`);
                  return (
                    <tr key={m.label} className="border-b border-border hover:bg-muted/30">
                      <td className="px-2 py-1 font-mono">{m.label}{m.error ? <span className="text-destructive ml-1" title={m.error}>⚠</span> : null}</td>
                      <td className="px-2 py-1 text-right">{fmt(m.removal_event_liquidation_revenue)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{fmt(m.removal_event_liquidation_fee)}</td>
                      <td className="px-2 py-1 text-right">{fmt(m.removal_adjustment_liquidation_revenue)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{fmt(m.removal_adjustment_liquidation_fee)}</td>
                      <td className="px-2 py-1 text-right">{fmt(m.fba_liquidation_event_revenue)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{fmt(m.fba_liquidation_event_fee)}</td>
                      <td className="px-2 py-1 text-right">{fmt(m.service_fee_liquidation_revenue)}</td>
                      <td className="px-2 py-1 text-right">{fmt(m.adjustment_event_liquidation_revenue)}</td>
                      <td className="px-2 py-1 text-right font-semibold bg-muted/30">{fmt(m.computed_liquidations_revenue)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground bg-muted/30">{fmt(m.computed_liquidations_brokerage_fee)}</td>
                      <td className="px-2 py-1 text-right font-semibold bg-primary/5">{fmt(m.cached_liquidations)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground bg-primary/5">{fmt(m.cached_liquidations_brokerage_fee)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${Math.abs(delta) > 0.01 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>
                        {Math.abs(delta) < 0.01 ? "—" : (delta > 0 ? "+" : "") + delta.toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-[10px] text-muted-foreground">
                        {(m.other_lists_with_liquidation || []).length === 0
                          ? "—"
                          : (m.other_lists_with_liquidation as any[]).map((o) => `${o.list} (${o.hits})`).join(", ")}
                      </td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{m.pages_fetched}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="p-3 text-[11px] text-muted-foreground space-y-1 border-t border-border">
              <div><strong>How to read this:</strong></div>
              <ul className="list-disc list-inside space-y-0.5">
                <li><strong>Computed Rev</strong> = total liquidation revenue Amazon returned across all source lists for that month.</li>
                <li><strong>Cached Rev</strong> = what is currently in <code>financial_events_cache</code> (= what your P&L row shows).</li>
                <li><strong>Δ Rev ≠ 0</strong> → run <em>Backfill {year}</em> to re-parse that month with the latest parser logic.</li>
                <li>If <strong>Computed Rev = $0</strong> but your external accounting shows liquidations for that month → Amazon's <code>financialEvents</code> endpoint is not returning it for that period; the data lives only in settlement reports. Use <em>Diagnose Liquidations</em> on that month to confirm.</li>
                <li><strong>Other lists w/ 'liquid'</strong> = unexpected lists where the keyword appeared. If you see entries here, paste them back to me — they may be a new source we should map.</li>
              </ul>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={copyAuditCsv} disabled={!auditResult?.months?.length}>
            <Copy className="w-3 h-3 mr-1" /> Copy CSV {auditResult?.months?.length ? `(${auditResult.months.length} mo)` : ""}
          </Button>
          <Button size="sm" variant="outline" onClick={downloadAuditJson} disabled={!auditResult?.months?.length}>
            <Download className="w-3 h-3 mr-1" /> Download JSON {auditResult?.months?.length ? `(${auditResult.months.length} mo)` : ""}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAuditOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* ─── Settlement Reports Dialog ───────────────────────────────── */}
    <Dialog open={settlementOpen} onOpenChange={setSettlementOpen}>
      <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settlement Reports — {year}</DialogTitle>
          <DialogDescription>
            Amazon auto-schedules settlement reports every ~14 days. These are the <strong>only</strong> source for full
            disposal fees, removal-order processing fees, and monthly storage fees — categories the FinancialEvents API
            does not return. Amazon only keeps downloadable report documents for {SETTLEMENT_REPORT_RETENTION_DAYS} days.
          </DialogDescription>
        </DialogHeader>

        {selectedYearOutsideSettlementRetention && (
          <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-foreground">
            <strong>{year} settlement reports are outside Amazon's retention window.</strong> SP-API cannot download them now unless they were synced earlier.
            The reconciliation will stay at $0.00 for settlement data until current/future reports are synced within 90 days.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 my-2">
          <Button size="sm" variant="default" onClick={() => runSettlementSync(false)} disabled={settlementSyncing}>
            <Database className={`w-3 h-3 mr-1 ${settlementSyncing ? "animate-spin" : ""}`} />
            {settlementSyncing ? "Syncing from Amazon…" : selectedYearOutsideSettlementRetention ? "Check Amazon Retention" : `Sync ${year} Settlements`}
          </Button>
          {year === 2026 && (
            <Button size="sm" variant="secondary" onClick={() => runSettlementSync(true)} disabled={settlementSyncing}>
              <Search className={`w-3 h-3 mr-1 ${settlementSyncing ? "animate-spin" : ""}`} />
              Force discover reports from 2026-01-01 to today
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={loadReconciliation} disabled={reconcileLoading}>
            <RefreshCw className={`w-3 h-3 mr-1 ${reconcileLoading ? "animate-spin" : ""}`} />
            Refresh Reconciliation
          </Button>
        </div>

        {year === 2026 && (
          <div className={`rounded border p-3 text-xs ${settlementCoverage.isSafe ? "bg-green-50 text-green-950 border-green-200" : "bg-muted/30"}`}>
            <div className="font-semibold">2026 settlement coverage: {settlementCoverage.isSafe ? "SAFE" : "NOT PROVEN"}</div>
            <div className="mt-1 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
              {settlementCoverage.storedMonths.map((m) => (
                <div key={m.month}>{m.covered ? "✅" : "❌"} {MONTHS[m.month - 1]} 2026 stored</div>
              ))}
            </div>
            <div className="mt-2 text-muted-foreground">
              Stored range: {settlementCoverage.earliest || "—"} → {settlementCoverage.latest || "—"} · Local parsed line items: {settlementCoverage.localLineItems} · Currencies: {settlementCoverage.currencies.join(", ") || "—"}
            </div>
            {!settlementCoverage.isSafe && <div className="mt-1 text-destructive">Missing months: {settlementCoverage.missingMonths.join(", ") || "unknown"}. Do not treat 2026 settlement coverage as safe yet.</div>}
          </div>
        )}

        {settlementSyncResult && (
          <div className="rounded border bg-muted/30 p-2 text-xs space-y-2">
            <strong>Last sync:</strong> {settlementSyncResult.reportsFound} reports found ·{" "}
            {settlementSyncResult.reportsDownloaded ?? settlementSyncResult.processed} downloaded · {settlementSyncResult.processed} parsed · {settlementSyncResult.skipped} already up-to-date ·{" "}
            {settlementSyncResult.totalLineItems} line items
            <div className="mt-1 text-muted-foreground">
              Amazon API range used: {settlementSyncResult.amazonApiRange?.createdSince || "—"} → {settlementSyncResult.amazonApiRange?.createdUntil || "—"} · Report type: {settlementSyncResult.amazonApiRange?.reportType || "—"} · Raw reports returned before filtering: {settlementSyncResult.amazonReportsReturned?.length ?? 0}
            </div>
            {settlementSyncResult.amazonReportsReturned?.length > 0 && (
              <div className="overflow-x-auto border rounded bg-background">
                <table className="w-full text-[10px] border-collapse">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left">Amazon Report ID</th>
                      <th className="px-2 py-1 text-left">Type</th>
                      <th className="px-2 py-1 text-left">Created</th>
                      <th className="px-2 py-1 text-left">Report Period</th>
                      <th className="px-2 py-1 text-left">Marketplace</th>
                      <th className="px-2 py-1 text-left">Currency</th>
                      <th className="px-2 py-1 text-left">Skipped / Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlementSyncResult.amazonReportsReturned.map((r: any) => {
                      const parsed = settlementSyncResult.results?.find((x: any) => x.reportId === r.reportId);
                      const skipped = settlementSyncResult.skippedReports?.find((x: any) => x.reportId === r.reportId);
                      const failed = settlementSyncResult.errors?.find((x: any) => x.reportId === r.reportId);
                      return (
                        <tr key={r.reportId} className="border-t">
                          <td className="px-2 py-1 font-mono">{r.reportId}</td>
                          <td className="px-2 py-1 font-mono">{r.reportType || "—"}</td>
                          <td className="px-2 py-1">{r.createdTime?.slice?.(0, 10) || "—"}</td>
                          <td className="px-2 py-1">{r.dataStartTime?.slice?.(0, 10) || "—"} → {r.dataEndTime?.slice?.(0, 10) || "—"}</td>
                          <td className="px-2 py-1">{parsed?.marketplace || r.marketplaceIds?.join(", ") || "—"}</td>
                          <td className="px-2 py-1">{parsed?.currency || "—"}</td>
                          <td className="px-2 py-1">{failed?.error || skipped?.skippedReason || "included"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {settlementSyncResult.retentionWarning && (
              <div className="mt-1 text-muted-foreground">{settlementSyncResult.retentionWarning}</div>
            )}
            {settlementSyncResult.errors?.length > 0 && (
              <span className="text-destructive"> · {settlementSyncResult.errors.length} errors</span>
            )}
          </div>
        )}

        {/* Reports list */}
        <div>
          <h4 className="text-xs font-semibold mb-1">Settlement reports for {year}</h4>
          {!reconciliation?.reports?.length ? (
            <div className="text-xs text-muted-foreground py-2">
              {selectedYearOutsideSettlementRetention
                ? `No ${year} settlement reports are stored locally. Amazon no longer makes those report documents available through SP-API.`
                : `No settlement reports synced yet. Click "Sync ${year} Settlements" to pull from Amazon.`}
            </div>
          ) : (
            <div className="overflow-x-auto border rounded">
              <table className="w-full text-[11px] border-collapse">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-left">Settlement ID</th>
                    <th className="px-2 py-1 text-left">Period</th>
                    <th className="px-2 py-1 text-left">Deposit</th>
                    <th className="px-2 py-1 text-right">Total</th>
                    <th className="px-2 py-1 text-right">Lines</th>
                    <th className="px-2 py-1 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.reports.map((r: any) => (
                    <tr key={r.amazon_report_id} className="border-t">
                      <td className="px-2 py-1 font-mono">{r.settlement_id || r.amazon_report_id.slice(-12)}</td>
                      <td className="px-2 py-1">{r.settlement_start_date} → {r.settlement_end_date}</td>
                      <td className="px-2 py-1">{r.deposit_date || "—"}</td>
                      <td className="px-2 py-1 text-right">{r.currency || "$"} {Number(r.total_amount || 0).toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">{r.rows_parsed}</td>
                      <td className="px-2 py-1">
                        <span className={
                          r.status === "parsed" ? "text-green-600" :
                          r.status === "error" ? "text-destructive" : "text-muted-foreground"
                        }>
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Reconciliation table */}
        <div className="mt-3">
          <h4 className="text-xs font-semibold mb-1">Reconciliation — FinancialEvents vs Settlement Report</h4>
          {!reconciliation?.reconciliation?.length ? (
            <div className="text-xs text-muted-foreground py-2">
              No reconciliation data yet. Sync settlement reports first.
            </div>
          ) : (
            <div className="overflow-x-auto border rounded">
              <table className="w-full text-[11px] border-collapse">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-left">Month</th>
                    <th className="px-2 py-1 text-left">Category</th>
                    <th className="px-2 py-1 text-right">FinancialEvents</th>
                    <th className="px-2 py-1 text-right">Settlement</th>
                    <th className="px-2 py-1 text-right">Difference</th>
                    <th className="px-2 py-1 text-left">Authoritative</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.reconciliation
                    .filter((r: any) => Math.abs(r.difference) > 0.01 || r.settlement_total > 0)
                    .map((r: any, i: number) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1">{r.period_year}-{String(r.period_month).padStart(2, "0")}</td>
                        <td className="px-2 py-1 font-mono">{r.category}</td>
                        <td className="px-2 py-1 text-right">${Number(r.fec_total).toFixed(2)}</td>
                        <td className="px-2 py-1 text-right font-semibold">${Number(r.settlement_total).toFixed(2)}</td>
                        <td className={`px-2 py-1 text-right ${
                          Math.abs(r.difference) > 1 ? "text-destructive font-semibold" : ""
                        }`}>
                          {r.difference >= 0 ? "+" : ""}${Number(r.difference).toFixed(2)}
                        </td>
                        <td className="px-2 py-1">
                          <span className={r.authoritative_source === "settlement" ? "text-green-600 font-semibold" : "text-muted-foreground"}>
                            {r.authoritative_source}
                          </span>
                        </td>
                      </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setSettlementOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Other Amazon Fees — drill-down */}
    <Dialog open={drillOpen} onOpenChange={setDrillOpen}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Amazon Fee Adjustments (Net) — Breakdown ({year})</DialogTitle>
          <DialogDescription>
            Every financial event with a non-zero <code>other_fees</code> value. Refunds (negative) reduce the total; charges (positive) add to it. Net total below matches the row in the P&L.
          </DialogDescription>
        </DialogHeader>

        {drillLoading ? (
          <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : drillError ? (
          <div className="text-destructive text-sm py-4">{drillError}</div>
        ) : drillRows.length === 0 ? (
          <div className="text-muted-foreground text-sm py-4">No "Amazon Fee Adjustments" entries found for {year}.</div>
        ) : (
          <>
            {(() => {
              const total = drillRows.reduce((a, r) => a + r.amount, 0);
              const charges = drillRows.filter(r => r.amount > 0).reduce((a, r) => a + r.amount, 0);
              const refunds = drillRows.filter(r => r.amount < 0).reduce((a, r) => a + r.amount, 0);
              return (
                <div className="grid grid-cols-3 gap-3 mb-3 text-sm">
                  <div className="rounded border border-border p-2">
                    <div className="text-muted-foreground text-xs">Charges</div>
                    <div className="font-bold tabular-nums">{fmt(charges)}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-muted-foreground text-xs">Refunds / Reversals</div>
                    <div className="font-bold tabular-nums text-destructive">{fmt(refunds, refunds < 0)}</div>
                  </div>
                  <div className="rounded border-2 border-primary p-2">
                    <div className="text-muted-foreground text-xs">Net Total</div>
                    <div className={`font-bold tabular-nums ${total < 0 ? "text-destructive" : ""}`}>{fmt(total, total < 0)}</div>
                  </div>
                </div>
              );
            })()}

            <div className="max-h-[55vh] overflow-auto border border-border rounded">
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr className="text-left">
                    <th className="px-2 py-1.5">Date</th>
                    <th className="px-2 py-1.5">Month</th>
                    <th className="px-2 py-1.5">Event Type</th>
                    <th className="px-2 py-1.5">Marketplace</th>
                    <th className="px-2 py-1.5">Order ID</th>
                    <th className="px-2 py-1.5 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {drillRows.map((r, i) => {
                    const d = new Date(r.event_date);
                    const monthLabel = isNaN(d.getTime()) ? "—" : MONTHS[d.getMonth()];
                    return (
                      <tr key={i} className="border-t border-border/40 hover:bg-muted/30">
                        <td className="px-2 py-1 font-mono">{formatMarketplaceDate(r.event_date, r.marketplace || homeMarketplace)}</td>
                        <td className="px-2 py-1">{monthLabel}</td>
                        <td className="px-2 py-1">{r.event_type}</td>
                        <td className="px-2 py-1">{r.marketplace || "—"}</td>
                        <td className="px-2 py-1 font-mono">{r.amazon_order_id || "—"}</td>
                        <td className={`px-2 py-1 text-right tabular-nums font-medium ${r.amount < 0 ? "text-destructive" : ""}`}>
                          {fmt(r.amount, r.amount < 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              Showing {drillRows.length} rows (max 5,000). "Amazon Fee Adjustments (Net)" = the signed sum of the <code>other_fees</code> column on <code>financial_events_cache</code> — corrections, reversals, and miscellaneous Amazon fees that don't fit the named buckets (referral, FBA, storage, etc.). Charges add, refunds/reversals subtract.
            </div>
          </>
        )}

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const csv = [
                "date,month,event_type,marketplace,order_id,amount",
                ...drillRows.map(r => {
                  const d = new Date(r.event_date);
                  const m = isNaN(d.getTime()) ? "" : MONTHS[d.getMonth()];
                  return `${r.event_date},${m},${r.event_type},${r.marketplace || ""},${r.amazon_order_id || ""},${r.amount}`;
                })
              ].join("\n");
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `amazon-fee-adjustments-${year}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={drillRows.length === 0}
          >
            <Download className="w-3 h-3 mr-1" /> Export CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDrillOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
