import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Bug,
  Receipt,
  GitCompare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";

// ---- Types ----------------------------------------------------------------

export type PLMode = "reconciled" | "estimated";

/** Emitted to parent so the rest of the page can apply the same mode. */
export interface PLEstimatedAddOnSummary {
  /** Net income delta (estimated sales − estimated refunds) on top of reconciled */
  income: number;
  /** Estimated Amazon expense delta (sum of all fee buckets from sales_orders) */
  expenses: number;
  /** Estimated COGS delta */
  cogs: number;
  /** Estimated net profit delta (income − expenses − cogs) */
  profit: number;
  /** Orders not yet settled by Amazon */
  pendingOrderCount: number;
}

interface HybridPLPanelProps {
  userId: string;
  /** YYYY-MM-DD inclusive */
  startDate: string;
  /** YYYY-MM-DD inclusive */
  endDate: string;
  /**
   * Optional legacy P&L summary (the existing "old" report on the same page).
   * If provided, a side-by-side comparison view is rendered.
   */
  legacySummary?: LegacySummaryShape | null;
  /** Controlled mode from parent. If omitted, panel keeps internal state. */
  mode?: PLMode;
  /** Notifies parent of mode changes (toggle clicks). */
  onModeChange?: (mode: PLMode) => void;
  /** Emits the estimated add-on numbers so the rest of the page can apply them. */
  onAddOnChange?: (addOn: PLEstimatedAddOnSummary) => void;
}

/**
 * Subset of FinancialSummary used for the comparison view. We keep this loose
 * so the parent can pass its existing `summary` object directly.
 */
export interface LegacySummaryShape {
  sales?: number;
  refunds?: number;
  referralFees?: number;
  fbaFees?: number;
  variableClosingFees?: number;
  fixedClosingFees?: number;
  fbaInboundFees?: number;
  fbaStorageFees?: number;
  fbaRemovalFees?: number;
  fbaDisposalFees?: number;
  fbaLongTermStorageFees?: number;
  fbaCustomerReturnFees?: number;
  otherFees?: number;
  digitalServicesFee?: number;
  fbaInboundConvenienceFee?: number;
  totalExpenses?: number;
}

// PLMode is exported above

/** Signed fee categories — positive = cost to seller; negative = credit. */
interface FeeBuckets {
  sellingFees: number;            // referral + variable_closing + fixed_closing
  fbaTransactionFees: number;     // fba_fees + fba_customer_return_fees
  fbaInventoryInboundFees: number; // inbound + storage + removal + disposal + long_term + inbound_convenience
  otherAmazonExpenses: number;    // other_fees + digital_services_fee
}

interface ReconciledTotals {
  sales: number;          // gross sales (positive)
  refunds: number;        // amount refunded to buyer (positive number, deducted from income)
  reimbursements: number; // generic + reversal + free-replacement reimbursement income
  buckets: FeeBuckets;
  cogs: number;
  orderIds: Set<string>;
  rowCount: number;
}

interface EstimatedAddOn {
  sales: number;
  refunds: number;
  buckets: FeeBuckets;    // estimated cache only knows total_fees → all in sellingFees bucket
  cogs: number;
  pendingOrderCount: number;
  excludedDuplicateCount: number;
  totalSOrderCount: number;
}

interface ManualExpenseLine {
  category: string;
  name: string | null;
  amount: number;
  frequency: string | null;
}

interface ManualExpensesResult {
  total: number;
  lines: ManualExpenseLine[];
  rawCount: number;
}

interface CutoffInfo {
  date: string | null;
  source: "financial_events_cache" | "settlement_report" | "none";
}

const EMPTY_BUCKETS: FeeBuckets = {
  sellingFees: 0,
  fbaTransactionFees: 0,
  fbaInventoryInboundFees: 0,
  otherAmazonExpenses: 0,
};

const formatCurrency = (n: number) => {
  const abs = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Math.abs(n));
  return n < 0 ? `(${abs})` : abs;
};

const fmtDelta = (n: number) => {
  if (Math.abs(n) < 0.005) return "—";
  const abs = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Math.abs(n));
  return n > 0 ? `+${abs}` : `-${abs}`;
};

// --- Manual expense expansion ---------------------------------------------
function expandExpense(
  row: {
    amount: number;
    expense_date: string;
    end_date: string | null;
    frequency: string | null;
  },
  windowStart: Date,
  windowEnd: Date,
): number {
  const amount = Number(row.amount) || 0;
  if (amount <= 0) return 0;
  const start = parseISO(row.expense_date);
  const stop = row.end_date ? parseISO(row.end_date) : null;
  const freq = (row.frequency || "one_time").toLowerCase();

  const effStart = start;
  const effEnd = stop && stop < windowEnd ? stop : windowEnd;
  if (effEnd < windowStart) return 0;
  if (effStart > windowEnd) return 0;

  if (freq === "one_time" || freq === "once") {
    return start >= windowStart && start <= windowEnd ? amount : 0;
  }
  if (freq === "monthly") {
    const a = effStart > windowStart ? effStart : windowStart;
    const b = effEnd < windowEnd ? effEnd : windowEnd;
    const months =
      (b.getFullYear() - a.getFullYear()) * 12 +
      (b.getMonth() - a.getMonth()) +
      1;
    return Math.max(0, months) * amount;
  }
  if (freq === "yearly" || freq === "annual" || freq === "annually") {
    const a = effStart > windowStart ? effStart : windowStart;
    const b = effEnd < windowEnd ? effEnd : windowEnd;
    const years = b.getFullYear() - a.getFullYear() + 1;
    return Math.max(0, years) * amount;
  }
  return start >= windowStart && start <= windowEnd ? amount : 0;
}

const PAGE = 1000;

export default function HybridPLPanel({
  userId,
  startDate,
  endDate,
  legacySummary,
  mode: modeProp,
  onModeChange,
  onAddOnChange,
}: HybridPLPanelProps) {
  // Default to "reconciled" (tax-grade / accountant view). Persist user's choice.
  const [internalMode, setInternalMode] = useState<PLMode>(() => {
    try {
      const saved = localStorage.getItem("profitloss.plMode");
      if (saved === "estimated" || saved === "reconciled") return saved as PLMode;
    } catch { /* ignore */ }
    return "reconciled";
  });
  const mode: PLMode = modeProp ?? internalMode;
  const setMode = (next: PLMode) => {
    if (modeProp === undefined) setInternalMode(next);
    onModeChange?.(next);
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<ReconciledTotals | null>(null);
  const [estimatedAddOn, setEstimatedAddOn] = useState<EstimatedAddOn | null>(
    null,
  );
  const [manualExpenses, setManualExpenses] =
    useState<ManualExpensesResult | null>(null);
  const [cutoff, setCutoff] = useState<CutoffInfo>({
    date: null,
    source: "none",
  });
  const [showDebug, setShowDebug] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  // ---- 1. Cutoff (MAX(FEC.event_date) for this user) --------------------
  const fetchCutoff = useCallback(async () => {
    const { data, error: e1 } = await supabase
      .from("financial_events_cache")
      .select("event_date")
      .eq("user_id", userId)
      .order("event_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e1) throw e1;
    setCutoff({
      date: data?.event_date ?? null,
      source: data?.event_date ? "financial_events_cache" : "none",
    });
  }, [userId]);

  // ---- 2. Reconciled totals from FEC ------------------------------------
  // SIGN CONVENTION:
  //  - On 'shipment' rows, fee columns are typically NEGATIVE (cost). We flip
  //    them to positive so the bucket totals represent costs.
  //  - On 'refund' rows, fee columns are typically POSITIVE (Amazon credits
  //    the fee back). We flip them to NEGATIVE so they REDUCE the bucket total
  //    (correct accounting: fee refunds are expense reductions, NOT income).
  //  - Refunds (the buyer payout) are tracked separately and ALWAYS deducted
  //    from income, never added as positive.
  const fetchReconciled = useCallback(async (): Promise<ReconciledTotals> => {
    const orderIds = new Set<string>();
    let sales = 0;
    let refunds = 0;
    let reimbursements = 0;
    const buckets: FeeBuckets = { ...EMPTY_BUCKETS };
    let cogs = 0;
    let rowCount = 0;

    let from = 0;
    while (true) {
      const { data, error: e1 } = await supabase
        .from("financial_events_cache")
        .select(
          "amazon_order_id,event_type,sales,refunds,reimbursements,reversal_reimbursement,free_replacement_refund_items,referral_fees,fba_fees,variable_closing_fees,fixed_closing_fees,fba_inbound_fees,fba_storage_fees,fba_removal_fees,fba_disposal_fees,fba_long_term_storage_fees,fba_customer_return_fees,fba_inbound_convenience_fee,digital_services_fee,other_fees",
        )
        .eq("user_id", userId)
        .gte("event_date", startDate)
        .lte("event_date", endDate)
        // Stable order is REQUIRED for .range() paging: two pages are two
        // independent queries, and Postgres promises no row order between
        // them -- so without a total order a financial event can be counted
        // twice or missed entirely.
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (e1) throw e1;
      if (!data || data.length === 0) break;
      for (const r of data as any[]) {
        rowCount++;
        const isShipment = r.event_type === "shipment";
        const isRefund = r.event_type === "refund";

        if (isShipment) {
          sales += Math.abs(Number(r.sales) || 0);
          if (r.amazon_order_id) orderIds.add(String(r.amazon_order_id));
        } else if (isRefund) {
          refunds += Math.abs(Number(r.refunds) || 0);
        }

        // InventoryLab parity: reimbursement income is split across generic,
        // reversal, and free-replacement subtypes in Amazon Financial Events.
        reimbursements +=
          (Number(r.reimbursements) || 0) +
          Math.abs(Number(r.reversal_reimbursement) || 0) +
          Math.abs(Number(r.free_replacement_refund_items) || 0);

        // Fee sign normalization: shipment fees → cost (positive),
        // refund fees → credit (negative bucket impact).
        const flip = (raw: any) => {
          const v = Number(raw) || 0;
          if (isShipment) return Math.abs(v);
          if (isRefund) return -Math.abs(v);
          // unknown event type — pass through magnitude as cost
          return Math.abs(v);
        };

        // Selling fees
        buckets.sellingFees +=
          flip(r.referral_fees) +
          flip(r.variable_closing_fees) +
          flip(r.fixed_closing_fees);

        // FBA transaction fees
        buckets.fbaTransactionFees +=
          flip(r.fba_fees) + flip(r.fba_customer_return_fees);

        // FBA inventory & inbound service fees
        buckets.fbaInventoryInboundFees +=
          flip(r.fba_inbound_fees) +
          flip(r.fba_storage_fees) +
          flip(r.fba_removal_fees) +
          flip(r.fba_disposal_fees) +
          flip(r.fba_long_term_storage_fees) +
          flip(r.fba_inbound_convenience_fee);

        // Other Amazon expenses (the "other" Amazon fees, not manual ones)
        buckets.otherAmazonExpenses +=
          flip(r.other_fees) + flip(r.digital_services_fee);
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // COGS for these reconciled order IDs.
    // Primary source: sales_orders.unit_cost (snapshotted at order time).
    // Fallback: created_listings (Product Library) — same logic the repricer and
    // get_sellerboard_period_totals use, so a missing snapshot doesn't drop COGS.
    // Contract A: prefer `amount` (unit cost); else derive `cost / units`.
    if (orderIds.size > 0) {
      const idsArr = Array.from(orderIds);
      const missingCostAsins = new Set<string>();
      const ordersNeedingFallback: { asin: string; qty: number }[] = [];

      for (let i = 0; i < idsArr.length; i += 200) {
        const batch = idsArr.slice(i, i + 200);
        const { data, error: e2 } = await supabase
          .from("sales_orders")
          .select("order_id,unit_cost,quantity,asin")
          .eq("user_id", userId)
          .in("order_id", batch);
        if (e2) throw e2;
        for (const r of (data || []) as any[]) {
          const uc = Number(r.unit_cost) || 0;
          const qty = Number(r.quantity) || 1;
          if (uc > 0) {
            cogs += uc * qty;
          } else if (r.asin) {
            const asin = String(r.asin);
            missingCostAsins.add(asin);
            ordersNeedingFallback.push({ asin, qty });
          }
        }
      }

      // Fallback: pull latest unit cost from created_listings for ASINs missing it.
      if (missingCostAsins.size > 0) {
        const asinList = Array.from(missingCostAsins);
        const unitCostByAsin = new Map<string, number>();
        for (let i = 0; i < asinList.length; i += 200) {
          const batch = asinList.slice(i, i + 200);
          const { data: clRows, error: e3 } = await supabase
            .from("created_listings")
            .select("asin,amount,cost,units,updated_at")
            .eq("user_id", userId)
            .in("asin", batch)
            .order("updated_at", { ascending: false });
          if (e3) {
            console.warn("[P&L] created_listings fallback error:", e3.message);
            break;
          }
          for (const r of (clRows || []) as any[]) {
            const asin = String(r.asin || "");
            if (!asin || unitCostByAsin.has(asin)) continue; // first row = newest
            const amount = Number(r.amount);
            const cost = Number(r.cost);
            const units = Number(r.units);
            let unitCost = 0;
            if (Number.isFinite(amount) && amount >= 0) {
              unitCost = amount;
            } else if (cost > 0 && units > 0) {
              unitCost = cost / units;
            }
            if (unitCost > 0) unitCostByAsin.set(asin, unitCost);
          }
        }
        for (const o of ordersNeedingFallback) {
          const uc = unitCostByAsin.get(o.asin);
          if (uc && uc > 0) cogs += uc * o.qty;
        }
      }
    }

    return { sales, refunds, reimbursements, buckets, cogs, orderIds, rowCount };
  }, [userId, startDate, endDate]);

  // ---- 3. Estimated add-on (sales_orders NOT in FEC) --------------------
  // sales_orders only stores total_fees (no breakdown), so the estimated
  // add-on lumps fees into sellingFees. Acceptable: estimates are a small
  // tail (post-cutoff days) and they get reconciled within ~1-2 weeks.
  const fetchEstimatedAddOn = useCallback(
    async (reconciledOrderIds: Set<string>): Promise<EstimatedAddOn> => {
      let sales = 0;
      let refunds = 0;
      const buckets: FeeBuckets = { ...EMPTY_BUCKETS };
      let cogs = 0;
      let pendingOrderCount = 0;
      let excludedDuplicateCount = 0;
      let totalSOrderCount = 0;

      let from = 0;
      const missingCostAsins = new Set<string>();
      const ordersNeedingFallback: { asin: string; qty: number }[] = [];
      while (true) {
        const { data, error: e1 } = await supabase
          .from("sales_orders")
          .select(
            "order_id,asin,sold_price,total_sale_amount,quantity,total_fees,unit_cost,refund_amount,order_status,is_cancelled",
          )
          .eq("user_id", userId)
          .gte("order_date", startDate)
          .lte("order_date", endDate)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (e1) throw e1;
        if (!data || data.length === 0) break;
        for (const r of data as any[]) {
          totalSOrderCount++;
          const status = String(r.order_status || "");
          if (
            status === "Canceled" ||
            status === "Cancelled" ||
            r.is_cancelled === true
          )
            continue;
          const oid = String(r.order_id || "");
          if (oid && reconciledOrderIds.has(oid)) {
            excludedDuplicateCount++;
            continue;
          }
          pendingOrderCount++;
          const qty = Number(r.quantity) || 1;
          const unitPrice =
            Number(r.sold_price) ||
            (Number(r.total_sale_amount) > 0
              ? Number(r.total_sale_amount) / qty
              : 0);
          sales += unitPrice * qty;
          buckets.sellingFees += Math.abs(Number(r.total_fees) || 0);
          refunds += Math.abs(Number(r.refund_amount) || 0);
          const uc = Number(r.unit_cost) || 0;
          if (uc > 0) {
            cogs += uc * qty;
          } else if (r.asin) {
            const asin = String(r.asin);
            missingCostAsins.add(asin);
            ordersNeedingFallback.push({ asin, qty });
          }
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }

      // Fallback to created_listings (Product Library) for ASINs without unit_cost.
      if (missingCostAsins.size > 0) {
        const asinList = Array.from(missingCostAsins);
        const unitCostByAsin = new Map<string, number>();
        for (let i = 0; i < asinList.length; i += 200) {
          const batch = asinList.slice(i, i + 200);
          const { data: clRows, error: e3 } = await supabase
            .from("created_listings")
            .select("asin,amount,cost,units,updated_at")
            .eq("user_id", userId)
            .in("asin", batch)
            .order("updated_at", { ascending: false });
          if (e3) {
            console.warn("[P&L estimated] created_listings fallback error:", e3.message);
            break;
          }
          for (const r of (clRows || []) as any[]) {
            const asin = String(r.asin || "");
            if (!asin || unitCostByAsin.has(asin)) continue;
            const amount = Number(r.amount);
            const cost = Number(r.cost);
            const units = Number(r.units);
            let unitCost = 0;
            if (Number.isFinite(amount) && amount >= 0) {
              unitCost = amount;
            } else if (cost > 0 && units > 0) {
              unitCost = cost / units;
            }
            if (unitCost > 0) unitCostByAsin.set(asin, unitCost);
          }
        }
        for (const o of ordersNeedingFallback) {
          const uc = unitCostByAsin.get(o.asin);
          if (uc && uc > 0) cogs += uc * o.qty;
        }
      }

      return {
        sales,
        refunds,
        buckets,
        cogs,
        pendingOrderCount,
        excludedDuplicateCount,
        totalSOrderCount,
      };
    },
    [userId, startDate, endDate],
  );

  // ---- 4. Manual expenses ----------------------------------------------
  const fetchManualExpenses =
    useCallback(async (): Promise<ManualExpensesResult> => {
      const ws = parseISO(startDate);
      const we = parseISO(endDate);
      const lines: ManualExpenseLine[] = [];
      let total = 0;
      let rawCount = 0;

      let from = 0;
      while (true) {
        const { data, error: e1 } = await supabase
          .from("expenses")
          .select("category,name,amount,expense_date,end_date,frequency")
          .eq("user_id", userId)
          .lte("expense_date", endDate)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (e1) throw e1;
        if (!data || data.length === 0) break;
        for (const r of data as any[]) {
          rawCount++;
          const contributing = expandExpense(
            {
              amount: Number(r.amount) || 0,
              expense_date: r.expense_date,
              end_date: r.end_date,
              frequency: r.frequency,
            },
            ws,
            we,
          );
          if (contributing > 0) {
            lines.push({
              category: r.category || "Other",
              name: r.name || null,
              amount: contributing,
              frequency: r.frequency || null,
            });
            total += contributing;
          }
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return { total, lines, rawCount };
    }, [userId, startDate, endDate]);

  const load = useCallback(async () => {
    if (!userId || !startDate || !endDate) return;
    setLoading(true);
    setError(null);
    try {
      await fetchCutoff();
      const rec = await fetchReconciled();
      setReconciled(rec);
      const est = await fetchEstimatedAddOn(rec.orderIds);
      setEstimatedAddOn(est);
      const man = await fetchManualExpenses();
      setManualExpenses(man);
    } catch (e: any) {
      console.error("[HybridPL] load failed", e);
      setError(e?.message || "Failed to load hybrid P&L");
    } finally {
      setLoading(false);
    }
  }, [
    userId,
    startDate,
    endDate,
    fetchCutoff,
    fetchReconciled,
    fetchEstimatedAddOn,
    fetchManualExpenses,
  ]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, startDate, endDate]);

  // ---- Aggregations -----------------------------------------------------
  const totals = useMemo(() => {
    const rec =
      reconciled ||
      ({
        sales: 0,
        refunds: 0,
        reimbursements: 0,
        buckets: { ...EMPTY_BUCKETS },
        cogs: 0,
        orderIds: new Set<string>(),
        rowCount: 0,
      } as ReconciledTotals);
    const add =
      estimatedAddOn ||
      ({
        sales: 0,
        refunds: 0,
        buckets: { ...EMPTY_BUCKETS },
        cogs: 0,
        pendingOrderCount: 0,
        excludedDuplicateCount: 0,
        totalSOrderCount: 0,
      } as EstimatedAddOn);

    const useEst = mode === "estimated";
    const sales = rec.sales + (useEst ? add.sales : 0);
    const refunds = rec.refunds + (useEst ? add.refunds : 0);
    const buckets: FeeBuckets = {
      sellingFees:
        rec.buckets.sellingFees + (useEst ? add.buckets.sellingFees : 0),
      fbaTransactionFees:
        rec.buckets.fbaTransactionFees +
        (useEst ? add.buckets.fbaTransactionFees : 0),
      fbaInventoryInboundFees:
        rec.buckets.fbaInventoryInboundFees +
        (useEst ? add.buckets.fbaInventoryInboundFees : 0),
      otherAmazonExpenses:
        rec.buckets.otherAmazonExpenses +
        (useEst ? add.buckets.otherAmazonExpenses : 0),
    };
    const cogs = rec.cogs + (useEst ? add.cogs : 0);
    const manual = manualExpenses?.total || 0;

    // INCOME = Sales − Refunds + Reimbursements (all subtypes; counted once)
    const income = sales - refunds + rec.reimbursements;

    // Total Amazon-side cost buckets
    const amazonExpenses =
      buckets.sellingFees +
      buckets.fbaTransactionFees +
      buckets.fbaInventoryInboundFees +
      buckets.otherAmazonExpenses;

    // Manual + COGS roll into Other Expenses display group, but kept separate for clarity
    const otherExpensesTotal = buckets.otherAmazonExpenses + manual;

    const totalExpenses =
      buckets.sellingFees +
      buckets.fbaTransactionFees +
      buckets.fbaInventoryInboundFees +
      otherExpensesTotal +
      cogs;

    const profit = income - amazonExpenses - cogs - manual;

    return {
      sales,
      refunds,
      reimbursements: rec.reimbursements,
      buckets,
      cogs,
      manual,
      income,
      amazonExpenses,
      otherExpensesTotal,
      totalExpenses,
      profit,
    };
  }, [mode, reconciled, estimatedAddOn, manualExpenses]);

  // Emit estimated add-on numbers to the parent so the rest of the page
  // (top KPI tiles, charts, etc.) can apply the same mode.
  useEffect(() => {
    if (!onAddOnChange) return;
    const add = estimatedAddOn;
    if (!add) {
      onAddOnChange({ income: 0, expenses: 0, cogs: 0, profit: 0, pendingOrderCount: 0 });
      return;
    }
    const expenses =
      add.buckets.sellingFees +
      add.buckets.fbaTransactionFees +
      add.buckets.fbaInventoryInboundFees +
      add.buckets.otherAmazonExpenses;
    const income = add.sales - add.refunds;
    const profit = income - expenses - add.cogs;
    onAddOnChange({
      income,
      expenses,
      cogs: add.cogs,
      profit,
      pendingOrderCount: add.pendingOrderCount,
    });
  }, [estimatedAddOn, onAddOnChange]);

  // ---- Comparison values from legacy summary ----------------------------
  const legacy = useMemo(() => {
    if (!legacySummary) return null;
    const s = legacySummary;
    const sellingFees =
      (s.referralFees || 0) +
      (s.variableClosingFees || 0) +
      (s.fixedClosingFees || 0);
    const fbaTransactionFees =
      (s.fbaFees || 0) + (s.fbaCustomerReturnFees || 0);
    const fbaInventoryInboundFees =
      (s.fbaInboundFees || 0) +
      (s.fbaStorageFees || 0) +
      (s.fbaRemovalFees || 0) +
      (s.fbaDisposalFees || 0) +
      (s.fbaLongTermStorageFees || 0) +
      (s.fbaInboundConvenienceFee || 0);
    const otherAmazonExpenses =
      (s.otherFees || 0) + (s.digitalServicesFee || 0);
    return {
      sales: s.sales || 0,
      refunds: s.refunds || 0,
      sellingFees,
      fbaTransactionFees,
      fbaInventoryInboundFees,
      otherAmazonExpenses,
    };
  }, [legacySummary]);

  const periodInWindow = (() => {
    if (!cutoff.date) return false;
    return cutoff.date >= startDate && cutoff.date <= endDate;
  })();

  return (
    <Card className="mb-6 border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Hybrid P&amp;L (Settlement-based)
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {startDate} → {endDate}
            </p>
          </div>

          <div className="inline-flex rounded-md border bg-muted/30 p-0.5">
            <Button
              size="sm"
              variant={mode === "reconciled" ? "default" : "ghost"}
              className="h-7 px-3 text-xs"
              onClick={() => {
                setMode("reconciled");
                try { localStorage.setItem("profitloss.plMode", "reconciled"); } catch { /* ignore */ }
              }}
              disabled={loading}
              title="Tax-grade view — uses only Amazon-settled financial events. Recommended for accounting, CPA exports, and year-end reporting."
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Reconciled Only <span className="ml-1 text-[10px] opacity-70">(Tax)</span>
            </Button>
            <Button
              size="sm"
              variant={mode === "estimated" ? "default" : "ghost"}
              className="h-7 px-3 text-xs"
              onClick={() => {
                setMode("estimated");
                try { localStorage.setItem("profitloss.plMode", "estimated"); } catch { /* ignore */ }
              }}
              disabled={loading}
              title="Adds recent orders not yet settled by Amazon. Useful for daily operations, not for tax filing."
            >
              <Clock className="h-3 w-3 mr-1" />
              Include Estimated
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Cutoff banner */}
        <Alert
          className={cn(
            "border-primary/30",
            periodInWindow
              ? "bg-amber-50 dark:bg-amber-950/20"
              : "bg-emerald-50 dark:bg-emerald-950/20",
          )}
        >
          <CalendarClock className="h-4 w-4" />
          <AlertTitle className="text-sm">
            {cutoff.date ? (
              <>
                Reconciliation cutoff:{" "}
                <span className="font-mono">
                  {format(parseISO(cutoff.date), "PPP")}
                </span>
              </>
            ) : (
              "No reconciled financial events found yet"
            )}
          </AlertTitle>
          <AlertDescription className="text-xs">
            Source:{" "}
            <span className="font-mono">
              {cutoff.source === "financial_events_cache"
                ? "MAX(financial_events_cache.event_date)"
                : "—"}
            </span>
            {periodInWindow && (
              <>
                {" "}
                · Cutoff falls inside this report window. Days after the cutoff
                are{" "}
                {mode === "estimated"
                  ? "filled in with estimated orders."
                  : "not yet reconciled and excluded."}
              </>
            )}
          </AlertDescription>
        </Alert>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not load hybrid P&amp;L</AlertTitle>
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {/* Income + Expenses table — InventoryLab category structure */}
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableBody>
              {/* INCOME */}
              <TableRow className="bg-muted/40">
                <TableCell className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Income
                </TableCell>
                <TableCell />
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">Sales</TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(totals.sales)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  Refunds{" "}
                  <span className="text-xs text-muted-foreground">
                    (deducted from income — never added as positive)
                  </span>
                </TableCell>
                <TableCell className="text-right font-medium text-red-600">
                  ({formatCurrency(totals.refunds)})
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  Reimbursements{" "}
                  <span className="text-xs text-muted-foreground">
                    (generic + reversal + free-replacement)
                  </span>
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(totals.reimbursements)}
                </TableCell>
              </TableRow>
              <TableRow className="border-t-2">
                <TableCell className="text-sm pl-6 font-semibold">
                  Net Income
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {formatCurrency(totals.income)}
                </TableCell>
              </TableRow>

              {/* EXPENSES */}
              <TableRow className="bg-muted/40">
                <TableCell className="text-xs font-semibold uppercase tracking-wide text-muted-foreground pt-4">
                  Expenses
                </TableCell>
                <TableCell />
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  Selling Fees{" "}
                  <span className="text-xs text-muted-foreground">
                    (referral + variable & fixed closing)
                  </span>
                </TableCell>
                <TableCell className="text-right text-red-600">
                  ({formatCurrency(totals.buckets.sellingFees)})
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  FBA Transaction Fees{" "}
                  <span className="text-xs text-muted-foreground">
                    (fulfillment + customer return)
                  </span>
                </TableCell>
                <TableCell className="text-right text-red-600">
                  ({formatCurrency(totals.buckets.fbaTransactionFees)})
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  FBA Inventory &amp; Inbound Service Fees{" "}
                  <span className="text-xs text-muted-foreground">
                    (storage, removal, disposal, LTSF, inbound)
                  </span>
                </TableCell>
                <TableCell className="text-right text-red-600">
                  ({formatCurrency(totals.buckets.fbaInventoryInboundFees)})
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  Other Expenses{" "}
                  <span className="text-xs text-muted-foreground">
                    (Amazon misc + digital services + manual entries
                    {manualExpenses && manualExpenses.lines.length > 0 ? (
                      <> · {manualExpenses.lines.length} manual items</>
                    ) : null}
                    )
                  </span>
                </TableCell>
                <TableCell className="text-right text-red-600">
                  ({formatCurrency(totals.otherExpensesTotal)})
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm pl-6">
                  COGS{" "}
                  <span className="text-xs text-muted-foreground">
                    (cost of goods sold)
                  </span>
                </TableCell>
                <TableCell className="text-right text-orange-600">
                  ({formatCurrency(totals.cogs)})
                </TableCell>
              </TableRow>
              <TableRow className="border-t-2">
                <TableCell className="text-sm pl-6 font-semibold">
                  Total Expenses
                </TableCell>
                <TableCell className="text-right font-semibold text-red-600">
                  ({formatCurrency(totals.totalExpenses)})
                </TableCell>
              </TableRow>

              {/* NET PROFIT */}
              <TableRow
                className={cn(
                  "font-bold",
                  totals.profit >= 0
                    ? "bg-green-50 dark:bg-green-950/30"
                    : "bg-red-50 dark:bg-red-950/30",
                )}
              >
                <TableCell>
                  NET PROFIT (
                  {mode === "reconciled"
                    ? "Reconciled Only"
                    : "Hybrid: Reconciled + Estimated"}
                  )
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right",
                    totals.profit >= 0 ? "text-green-600" : "text-red-600",
                  )}
                >
                  {formatCurrency(totals.profit)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        {/* Manual expenses breakdown */}
        {manualExpenses && manualExpenses.lines.length > 0 && (
          <div className="rounded-md border">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/40">
              Other Expenses — manual entries breakdown
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Category</TableHead>
                  <TableHead className="text-xs">Name</TableHead>
                  <TableHead className="text-xs">Frequency</TableHead>
                  <TableHead className="text-right text-xs">
                    Amount in period
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {manualExpenses.lines.map((l, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="text-xs">{l.category}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {l.name || "—"}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {l.frequency || "one_time"}
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">
                      {formatCurrency(l.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Action row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={load}
            disabled={loading}
            className="gap-1"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </Button>

          <div className="flex items-center gap-2">
            {legacy && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowCompare((v) => !v)}
                className="gap-1 text-xs"
              >
                <GitCompare className="h-3 w-3" />
                {showCompare ? "Hide" : "Show"} Hybrid vs Legacy
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDebug((v) => !v)}
              className="gap-1 text-xs"
            >
              <Bug className="h-3 w-3" />
              {showDebug ? "Hide" : "Show"} Debug
            </Button>
          </div>
        </div>

        {/* Comparison view */}
        {showCompare && legacy && (
          <div className="rounded-md border">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/40 flex items-center gap-2">
              <GitCompare className="h-3 w-3" />
              Hybrid ({mode === "reconciled" ? "Reconciled Only" : "Include Estimated"}) vs Legacy P&amp;L
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Category</TableHead>
                  <TableHead className="text-right text-xs">Hybrid</TableHead>
                  <TableHead className="text-right text-xs">Legacy</TableHead>
                  <TableHead className="text-right text-xs">Δ Hybrid − Legacy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  { label: "Sales", h: totals.sales, l: legacy.sales },
                  { label: "Refunds (deducted)", h: totals.refunds, l: legacy.refunds },
                  { label: "Selling Fees", h: totals.buckets.sellingFees, l: legacy.sellingFees },
                  { label: "FBA Transaction Fees", h: totals.buckets.fbaTransactionFees, l: legacy.fbaTransactionFees },
                  { label: "FBA Inventory & Inbound", h: totals.buckets.fbaInventoryInboundFees, l: legacy.fbaInventoryInboundFees },
                  { label: "Other Amazon Expenses", h: totals.buckets.otherAmazonExpenses, l: legacy.otherAmazonExpenses },
                ].map((row) => {
                  const delta = row.h - row.l;
                  return (
                    <TableRow key={row.label}>
                      <TableCell className="text-xs">{row.label}</TableCell>
                      <TableCell className="text-right text-xs font-mono">
                        {formatCurrency(row.h)}
                      </TableCell>
                      <TableCell className="text-right text-xs font-mono text-muted-foreground">
                        {formatCurrency(row.l)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right text-xs font-mono",
                          Math.abs(delta) < 0.01
                            ? "text-muted-foreground"
                            : delta > 0
                              ? "text-amber-600"
                              : "text-blue-600",
                        )}
                      >
                        {fmtDelta(delta)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="px-3 py-2 text-[11px] text-muted-foreground border-t bg-muted/20">
              Legacy values come from the existing on-page P&amp;L computation
              (settled actuals from the fetch-profit-loss edge function). Hybrid
              uses the same reconciliation source plus, in Estimated mode, only
              orders not yet present in the financial events cache. COGS and
              manual expenses are not included in this diff because the legacy
              report does not categorize them the same way.
            </div>
          </div>
        )}

        {/* Debug panel */}
        {showDebug && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1 font-mono">
            <div>
              Reconciled order count (FEC shipments):{" "}
              <span className="font-bold">
                {reconciled?.orderIds.size.toLocaleString() ?? "—"}
              </span>
            </div>
            <div>
              Reconciled FEC rows in window:{" "}
              <span className="font-bold">
                {reconciled?.rowCount.toLocaleString() ?? "—"}
              </span>
            </div>
            <div>
              Pending estimated orders (sales_orders NOT in FEC):{" "}
              <span className="font-bold">
                {estimatedAddOn?.pendingOrderCount.toLocaleString() ?? "—"}
              </span>
            </div>
            <div>
              Excluded duplicate orders (in both SO and FEC):{" "}
              <span className="font-bold">
                {estimatedAddOn?.excludedDuplicateCount.toLocaleString() ?? "—"}
              </span>
            </div>
            <div>
              Total sales_orders rows in window:{" "}
              <span className="font-bold">
                {estimatedAddOn?.totalSOrderCount.toLocaleString() ?? "—"}
              </span>
            </div>
            <div>
              Manual expense rows considered:{" "}
              <span className="font-bold">
                {manualExpenses?.rawCount.toLocaleString() ?? "—"}
              </span>{" "}
              · Contributing lines:{" "}
              <span className="font-bold">
                {manualExpenses?.lines.length ?? "—"}
              </span>{" "}
              · Total manual:{" "}
              <span className="font-bold">
                {formatCurrency(manualExpenses?.total ?? 0)}
              </span>
            </div>
            <div className="pt-2 border-t mt-2 space-y-0.5">
              <div className="font-semibold">Net Profit calculation ({mode}):</div>
              <div>
                Income = Sales − Refunds + Reimbursements = {formatCurrency(totals.sales)} −{" "}
                {formatCurrency(totals.refunds)} + {formatCurrency(totals.reimbursements)} ={" "}
                <span className="font-bold">{formatCurrency(totals.income)}</span>
              </div>
              <div>
                Amazon Fees = SellingFees + FBA Tx + FBA Inv/Inbound + Other
                Amazon = {formatCurrency(totals.buckets.sellingFees)} +{" "}
                {formatCurrency(totals.buckets.fbaTransactionFees)} +{" "}
                {formatCurrency(totals.buckets.fbaInventoryInboundFees)} +{" "}
                {formatCurrency(totals.buckets.otherAmazonExpenses)} ={" "}
                <span className="font-bold">
                  {formatCurrency(totals.amazonExpenses)}
                </span>
              </div>
              <div>
                Net Profit = Income − Amazon Fees − COGS − Manual Expenses ={" "}
                {formatCurrency(totals.income)} −{" "}
                {formatCurrency(totals.amazonExpenses)} −{" "}
                {formatCurrency(totals.cogs)} −{" "}
                {formatCurrency(totals.manual)} ={" "}
                <span className="font-bold">
                  {formatCurrency(totals.profit)}
                </span>
              </div>
            </div>
            <div className="text-muted-foreground pt-1">
              Sign rule: shipment-event fees → cost (positive bucket); refund-
              event fees → credit (negative bucket impact). Buyer refunds are
              deducted from income, never added as positive.
            </div>
            <div className="text-muted-foreground">
              Cutoff: {cutoff.date || "—"} (source: {cutoff.source})
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
