import { useState, useEffect, useRef, useCallback, useMemo} from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, TrendingUp, TrendingDown, DollarSign, Package, Download, Loader2, Calculator, RefreshCw, Search, Trash2, CalendarIcon, ReceiptText, AlertTriangle, WifiOff, Star, Info } from "lucide-react";
import OrdersCostEditor from "@/components/profitloss/OrdersCostEditor";
import CogsAdjustmentsPanel from "@/components/profitloss/CogsAdjustmentsPanel";
// HybridPLPanel removed — Monthly P&L Breakdown is the single P&L display.
import MonthlyPLBreakdown from "@/components/profitloss/MonthlyPLBreakdown";
import SoFecParityBanner from "@/components/profitloss/SoFecParityBanner";
import InternationalMarketplaceProfitPanel from "@/components/profitloss/InternationalMarketplaceProfitPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useModuleAccess } from "@/hooks/useModuleAccess";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { getMarketplaceFromId } from "@/lib/marketplaceCurrency";
// The Excel export renders from the SAME category definitions and the SAME RPC
// as the on-screen P&L. It used to build its own totals from fetch-profit-loss,
// which omitted 10 categories entirely and produced a Net Profit $2,499.72 apart
// from the screen. See plModel.ts for the full decomposition.
import {
  type PlMonthRow,
  type DispositionRowLike,
  type RowDef,
  rowValue,
  INCOME_ROWS,
  EXPENSE_ROWS,
  OTHER_ROWS,
  MEMO_ROWS,
  DISPOSITION_STATUSES,
  dispositionLoss as computeDispositionLoss,
  sumRows,
} from "@/lib/profitloss/plModel";
import { format } from "date-fns";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { importWithRetry } from "@/lib/staleChunk";
import { useDbPressure, withTimeout, isTimeoutError, recordDbFailure, isDbPressureActive } from "@/hooks/use-db-pressure";
import { SyncReadinessBanner } from "@/components/SyncReadinessBanner";
import ReplacementCogsSection from "@/components/sales/ReplacementCogsSection";
import { getListingUnitCost, getInventoryUnitCost } from "@/lib/cost-contract";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import * as XLSX from 'xlsx';

interface RefundRecord {
  orderId: string;
  postedDate: string;
  amount: number;
  asin?: string;
}

interface FinancialSummary {
  sales: number;
  refunds: number;
  reimbursements: number;
  shippingCredits: number;
  shippingCreditRefunds: number;
  giftWrapCredits: number;
  giftWrapCreditRefunds: number;
  promotionalRebates: number;
  promotionalRebateRefunds: number;
  otherIncome: number;
  liquidations: number;
  totalIncome: number;
  referralFees: number;
  fbaFees: number;
  variableClosingFees: number;
  fixedClosingFees: number;
  fbaInboundFees: number;
  fbaStorageFees: number;
  fbaRemovalFees: number;
  fbaDisposalFees: number;
  fbaLongTermStorageFees: number;
  fbaCustomerReturnFees: number;
  otherFees: number;
  totalExpenses: number;
  salesTaxCollected: number;
  marketplaceFacilitatorTax: number;
  salesTaxRefunds: number;
  marketplaceFacilitatorTaxRefunds: number;
  totalTax: number;
  refundRecords?: RefundRecord[];
  // Granular fee/income categories
  compensatedClawback?: number;
  hrrNonApparel?: number;
  digitalServicesFee?: number;
  warehouseLost?: number;
  warehouseDamage?: number;
  reversalReimbursement?: number;
  freeReplacementRefundItems?: number;
  fbaInboundConvenienceFee?: number;
  liquidationsBrokerageFee?: number;
  reCommerceGradingCharge?: number;
  // FX metadata
  fxMetadata?: {
    source: string;
    loadedAt: string | null;
    currenciesConverted: string[];
    method: string;
  };
}

/**
 * Canonical Reconciled totals.
 *
 * Definitions (these MUST match the audit panel AND the Accounting View formula breakdown,
 * or the audit fails and Net Profit drifts).
 *
 *   Total Income   = positive income components only
 *                    sales + reimbursements + shippingCredits + giftWrapCredits
 *                    + otherIncome + liquidations
 *
 *   Total Expenses = all Amazon fees + every refund-side outflow
 *                    referralFees + fbaFees + variableClosing + fixedClosing
 *                    + fbaInbound + fbaStorage + fbaRemoval + fbaDisposal + fbaLTSF
 *                    + fbaCustomerReturn + otherFees
 *                    + refunds + shippingCreditRefunds + giftWrapCreditRefunds
 *                    + promotionalRebates - promotionalRebateRefunds
 *
 * After this normalization:
 *   Income - Expenses - COGS - OpEx - DispositionLoss - WarehouseWriteoff == Net Profit
 * by construction, for ANY period.
 */
const recomputeReconciledTotals = (s: FinancialSummary): FinancialSummary => {
  const n = (v: any) => Number(v) || 0;
  const totalIncome =
    n(s.sales) +
    n(s.reimbursements) +
    n(s.shippingCredits) +
    n(s.giftWrapCredits) +
    n(s.otherIncome) +
    n(s.liquidations);
  const totalExpenses =
    n(s.referralFees) +
    n(s.fbaFees) +
    n(s.variableClosingFees) +
    n(s.fixedClosingFees) +
    n(s.fbaInboundFees) +
    n(s.fbaStorageFees) +
    n(s.fbaRemovalFees) +
    n(s.fbaDisposalFees) +
    n(s.fbaLongTermStorageFees) +
    n(s.fbaCustomerReturnFees) +
    n(s.otherFees) +
    n(s.refunds) +
    n(s.shippingCreditRefunds) +
    n(s.giftWrapCreditRefunds) +
    n(s.promotionalRebates) -
    n(s.promotionalRebateRefunds);
  return { ...s, totalIncome, totalExpenses };
};

const MONTHS = [
  { value: 0, label: 'January' },
  { value: 1, label: 'February' },
  { value: 2, label: 'March' },
  { value: 3, label: 'April' },
  { value: 4, label: 'May' },
  { value: 5, label: 'June' },
  { value: 6, label: 'July' },
  { value: 7, label: 'August' },
  { value: 8, label: 'September' },
  { value: 9, label: 'October' },
  { value: 10, label: 'November' },
  { value: 11, label: 'December' },
];

// NOTE: Custom Range (and Daily/Weekly) are intentionally excluded. MonthlyPLBreakdown
// and its underlying RPCs (get_monthly_pl_breakdown, get_monthly_cogs) are year-scoped
// and rollup by full calendar month. Partial-month or arbitrary ranges would silently
// misreport totals. A range-aware refactor (Option B) is tracked as a follow-up.
const PERIOD_TYPES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

const getYearOptions = () => {
  const currentYear = new Date().getFullYear();
  return [
    { value: currentYear, label: String(currentYear) },
    { value: currentYear - 1, label: String(currentYear - 1) },
    { value: currentYear - 2, label: String(currentYear - 2) },
  ];
};

const calculateDateRange = (periodType: string, month: number, year: number, customStart?: Date, customEnd?: Date) => {
  let start: Date;
  let end: Date;

  switch (periodType) {
    case 'custom':
      // For custom, use provided dates or default to current month
      start = customStart || new Date(year, month, 1);
      end = customEnd || new Date(year, month + 1, 0, 23, 59, 59);
      break;
    case 'daily':
      // Today's date in the selected month/year
      const today = new Date();
      start = new Date(year, month, today.getDate());
      end = new Date(year, month, today.getDate(), 23, 59, 59);
      break;
    case 'weekly':
      // Current week in the selected month/year
      const weekStart = new Date(year, month, 1);
      const dayOfWeek = weekStart.getDay();
      start = new Date(year, month, 1 - dayOfWeek);
      end = new Date(year, month, 7 - dayOfWeek, 23, 59, 59);
      break;
    case 'monthly':
      start = new Date(year, month, 1);
      end = new Date(year, month + 1, 0, 23, 59, 59);
      break;
    case 'quarterly':
      const quarter = Math.floor(month / 3);
      start = new Date(year, quarter * 3, 1);
      end = new Date(year, quarter * 3 + 3, 0, 23, 59, 59);
      break;
    case 'yearly':
      start = new Date(year, 0, 1);
      end = new Date(year, 11, 31, 23, 59, 59);
      break;
    default:
      start = new Date(year, month, 1);
      end = new Date(year, month + 1, 0, 23, 59, 59);
  }

  // Format as YYYY-MM-DD without timezone conversion issues
  const formatLocalDate = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  return {
    start: formatLocalDate(start),
    end: formatLocalDate(end),
  };
};

const PL_SCROLL_KEY = 'lov.profitLoss.scrollY';

export default function ProfitLoss() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isAdmin } = useModuleAccess();
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
  // boundaries (get_pl_live_summary returns USD-normalized totals). No-op
  // (1) for USD sellers.
  const homeRate = fxRates[homeCurrency] ?? 1;
  const formatCurrency = (amount: number, showSign = false) => {
    const formatted = homeCurrencySymbol + new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Math.abs(amount) * homeRate);

    if (showSign && amount < 0) return `(${formatted})`;
    if (showSign && amount > 0) return formatted;
    return amount < 0 ? `(${formatted})` : formatted;
  };
  const now = new Date();
  const yearOptions = getYearOptions();

  // Restore scroll position when returning to this page, and persist on unmount / scroll.
  useEffect(() => {
    // Disable browser's automatic scroll restoration so we control it.
    const prev = typeof window !== 'undefined' ? window.history.scrollRestoration : undefined;
    if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }

    let raf = 0;
    const restore = () => {
      try {
        const saved = sessionStorage.getItem(PL_SCROLL_KEY);
        const y = saved ? parseInt(saved, 10) : 0;
        if (!Number.isNaN(y) && y > 0) window.scrollTo(0, y);
      } catch { /* ignore */ }
    };
    // Give the page a tick to render before restoring.
    raf = window.requestAnimationFrame(() => window.requestAnimationFrame(restore));

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        try { sessionStorage.setItem(PL_SCROLL_KEY, String(window.scrollY)); } catch {}
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
      try { sessionStorage.setItem(PL_SCROLL_KEY, String(window.scrollY)); } catch {}
      if (typeof window !== 'undefined' && 'scrollRestoration' in window.history && prev) {
        window.history.scrollRestoration = prev;
      }
    };
  }, []);
  
  
  const [periodType, setPeriodType] = useState('yearly');
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [customStartDate, setCustomStartDate] = useState<Date>(new Date(now.getFullYear(), 0, 1));
  const [customEndDate, setCustomEndDate] = useState<Date>(new Date(now.getFullYear(), 11, 31));
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  // Legacy "🧾 Accounting View" panel (summary cards + Net Profit Formula + Income/Expenses/COGS
  // cards + Tax + Memo + Audit). Gated off by default — the Reconciled summary + Hybrid Monthly
  // Breakdown above are now the primary P&L. Kept for reconciliation against Amazon payouts and
  // to avoid destroying evidence while the $417K vs $398K Total Income discrepancy is diagnosed.
  const [showLegacyAccountingView, setShowLegacyAccountingView] = useState(false);
  // Refunds-in-Income behavior is permanently ON (refunds netted into Income,
  // matching standard seller accounting conventions). Toggle removed from UI;
  // setter retained as no-op for child components that still accept the prop.
  const [ilStyleView] = useState<boolean>(true);
  const setIlStyleView = useCallback((_: boolean) => { /* locked ON */ }, []);
  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [cogs, setCogs] = useState(0);
  const [yearlyBaseCogs, setYearlyBaseCogs] = useState(0);
  // COGS adjustments (e.g. historical migration data) — flows directly into COGS, not Expenses
  const [cogsAdjustment, setCogsAdjustment] = useState(0);
  // Inventory Disposition Loss — separate P&L line, subtracted from Net Profit.
  // Sum of (unsellable_qty * unit_cost - recovery_amount) where status in (accepted, adjusted).
  const [dispositionLoss, setDispositionLoss] = useState(0);
  const [dispositionRowCount, setDispositionRowCount] = useState(0);
  // Inventory Write-Off (Warehouse) — separate P&L line for purchased-but-never-shipped restricted/dead stock
  const [warehouseWriteoff, setWarehouseWriteoff] = useState(0);
  const [warehouseWriteoffRowCount, setWarehouseWriteoffRowCount] = useState(0);
  const [netProfit, setNetProfit] = useState(0);
  const [showRefundsDialog, setShowRefundsDialog] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [excelDownload, setExcelDownload] = useState<{ url: string; filename: string } | null>(null);

  useEffect(() => {
    return () => {
      if (excelDownload?.url) URL.revokeObjectURL(excelDownload.url);
    };
  }, [excelDownload?.url]);

  // ── P&L mode ──
  // Estimated mode was removed: P&L is permanently Reconciled (Amazon Financial
  // Events / settlement-based). For live/estimated (order-date) numbers, users
  // go to Sales Report or Live Sales, which already implement that correctly.
  // See .lovable/profit-loss-open-items.md → "On-screen estimated add-on".
  const [plMode] = useState<"reconciled" | "estimated">("reconciled");
  const [plAddOn, setPlAddOn] = useState<{ income: number; expenses: number; cogs: number; profit: number; pendingOrderCount: number }>({
    income: 0, expenses: 0, cogs: 0, profit: 0, pendingOrderCount: 0,
  });
  // Manual operating expenses (from /tools/expenses) — Salary, rent, etc.
  // These are deducted from Net Profit on the top KPI card.
  const [manualOpExpenses, setManualOpExpenses] = useState(0);

  // ── Marketplace filter (ALL | US | CA | MX | BR) ──
  // Matches the button UI on Mobile Live Sales. Persisted so the page keeps
  // the seller's last choice across refreshes.
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>(() => {
    try {
      const v = localStorage.getItem("profitloss.marketplaceFilter");
      if (v && ["ALL", "US", "CA", "MX", "BR"].includes(v)) return v;
    } catch { /* ignore */ }
    return "ALL";
  });
  useEffect(() => {
    try { localStorage.setItem("profitloss.marketplaceFilter", marketplaceFilter); } catch { /* ignore */ }
  }, [marketplaceFilter]);
  const mpParam = marketplaceFilter === "ALL" ? null : marketplaceFilter;
  const applyMpFilter = useCallback(<T extends { eq: any; or: any }>(q: T, col = "marketplace"): T => {
    if (!mpParam) return q;
    if (mpParam === "US") return q.or(`${col}.is.null,${col}.eq.US,${col}.eq.UNKNOWN`);
    return q.eq(col, mpParam);
  }, [mpParam]);
  // Only marketplaces this account has actually connected — not a hardcoded
  // NA list, so an unconnected marketplace never shows a filter button that
  // just filters to permanently-empty data.
  const [PL_ACTIVE_MARKETPLACES, setPlActiveMarketplaces] = useState<string[]>([]);

  // Memoised because the panel below takes it as a dependency.
  //
  // This was `PL_ACTIVE_MARKETPLACES.filter(m => m !== "US")` inline, which
  // builds a NEW ARRAY on every render of this page. The panel's loader is
  // useCallback([year, marketplaces]) driven by useEffect([load]), so a fresh
  // array identity re-ran the entire fetch cascade on EVERY render -- three
  // marketplaces x three requests each. Switching the marketplace toggle
  // re-rendered, superseded the in-flight batch, and surfaced the cancellation
  // as "AbortError: signal is aborted without reason".
  //
  // The queries themselves were never slow: measured 2026-09-05, CA takes
  // 0.11s and 0.08s. The bug was how often they were fired, not how long they
  // took.
  const intlMarketplaces = useMemo(
    () => PL_ACTIVE_MARKETPLACES.filter((m) => m !== "US"),
    [PL_ACTIVE_MARKETPLACES],
  );
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("seller_authorizations")
        .select("marketplace_id")
        .eq("user_id", user.id);
      setPlActiveMarketplaces([...new Set((data || []).map((d) => getMarketplaceFromId(d.marketplace_id)))]);
    })();
  }, [user?.id]);

  // ── LIVE SUMMARY OVERLAY ────────────────────────────────────────────
  // The top KPI Net Profit must always reflect the SAME live DB aggregation
  // used by the Monthly P&L Breakdown table — it must not depend on a stale
  // sync-cached `summary`. This effect re-aggregates totals + every fee field
  // directly from financial_events_cache (signed other_fees, refunds net out)
  // every time the date range or user changes, and overlays them onto the
  // existing `summary` object so the KPI is always correct without a sync.
  useEffect(() => {
    if (!user || !startDate || !endDate) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await (supabase as any).rpc("get_pl_live_summary", {
          start_ts: startDate,
          end_ts: endDate,
          p_marketplace: mpParam,
        });
        if (cancelled || error || !data || (Array.isArray(data) && data.length === 0)) return;
        const row: any = Array.isArray(data) ? data[0] : data;
        const num = (v: any) => Number(v) || 0;
        setSummary((prev) => {
          const base: FinancialSummary = (prev ?? {
            sales: 0, refunds: 0, reimbursements: 0,
            shippingCredits: 0, shippingCreditRefunds: 0,
            giftWrapCredits: 0, giftWrapCreditRefunds: 0,
            promotionalRebates: 0, promotionalRebateRefunds: 0,
            otherIncome: 0, liquidations: 0, totalIncome: 0,
            referralFees: 0, fbaFees: 0,
            variableClosingFees: 0, fixedClosingFees: 0,
            fbaInboundFees: 0, fbaStorageFees: 0,
            fbaRemovalFees: 0, fbaDisposalFees: 0,
            fbaLongTermStorageFees: 0, fbaCustomerReturnFees: 0,
            otherFees: 0, totalExpenses: 0,
            salesTaxCollected: 0, marketplaceFacilitatorTax: 0,
            salesTaxRefunds: 0, marketplaceFacilitatorTaxRefunds: 0,
            totalTax: 0,
          }) as FinancialSummary;
          const merged: FinancialSummary = {
            ...base,
            sales: num(row.sales),
            refunds: num(row.refunds),
            reimbursements: num(row.reimbursements),
            shippingCredits: num(row.shipping_credits),
            shippingCreditRefunds: num(row.shipping_credit_refunds),
            giftWrapCredits: num(row.gift_wrap_credits),
            giftWrapCreditRefunds: num(row.gift_wrap_credit_refunds),
            promotionalRebates: num(row.promotional_rebates),
            promotionalRebateRefunds: num(row.promotional_rebate_refunds),
            otherIncome: num(row.other_income),
            liquidations: num(row.liquidations),
            referralFees: num(row.referral_fees),
            fbaFees: num(row.fba_fees),
            variableClosingFees: num(row.variable_closing_fees),
            fixedClosingFees: num(row.fixed_closing_fees),
            fbaInboundFees: num(row.fba_inbound_fees),
            fbaInboundConvenienceFee: num(row.fba_inbound_convenience_fee),
            fbaStorageFees: num(row.fba_storage_fees),
            fbaRemovalFees: num(row.fba_removal_fees),
            fbaDisposalFees: num(row.fba_disposal_fees),
            fbaLongTermStorageFees: num(row.fba_long_term_storage_fees),
            fbaCustomerReturnFees: num(row.fba_customer_return_fees),
            digitalServicesFee: num(row.digital_services_fee),
            otherFees: num(row.other_fees),
            liquidationsBrokerageFee: num(row.liquidations_brokerage_fee),
            reCommerceGradingCharge: num(row.re_commerce_grading_charge),
            compensatedClawback: num(row.compensated_clawback),
            hrrNonApparel: num(row.hrr_non_apparel),
            warehouseLost: num(row.warehouse_lost),
            warehouseDamage: num(row.warehouse_damage),
            reversalReimbursement: num(row.reversal_reimbursement),
            freeReplacementRefundItems: num(row.free_replacement_refund_items),
            salesTaxCollected: num(row.sales_tax_collected),
            marketplaceFacilitatorTax: num(row.marketplace_facilitator_tax),
            salesTaxRefunds: num(row.sales_tax_refunds),
            marketplaceFacilitatorTaxRefunds: num(row.marketplace_facilitator_tax_refunds),
            totalIncome: 0, // overwritten by recomputeReconciledTotals
            totalExpenses: 0, // overwritten by recomputeReconciledTotals
            totalTax: num(row.sales_tax_collected) + num(row.marketplace_facilitator_tax)
              - num(row.sales_tax_refunds) - num(row.marketplace_facilitator_tax_refunds),
            // Preserve audit-only data from the sync result.
            refundRecords: base.refundRecords,
            fxMetadata: base.fxMetadata,
          } as FinancialSummary;
          return recomputeReconciledTotals(merged);
        });
      } catch (err) {
        console.warn("[PL] live summary overlay failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [user, startDate, endDate, mpParam]);

  useEffect(() => {
    if (!user || !startDate || !endDate) {
      setPlAddOn({ income: 0, expenses: 0, cogs: 0, profit: 0, pendingOrderCount: 0 });
      return;
    }

    let cancelled = false;
    const PAGE_SIZE = 1000;

    const loadEstimatedAddOn = async () => {
      try {
        const reconciledOrderIds = new Set<string>();
        let from = 0;
        while (true) {
          let q: any = supabase
            .from("financial_events_cache")
            .select("amazon_order_id")
            .eq("user_id", user.id)
            .eq("event_type", "shipment")
            .gte("event_date", startDate)
            .lte("event_date", endDate);
          q = applyMpFilter(q);
          const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
          if (error) throw error;
          for (const row of data || []) {
            const orderId = String((row as any).amazon_order_id || "").trim();
            if (orderId) reconciledOrderIds.add(orderId);
          }
          if (!data || data.length < PAGE_SIZE) break;
          from += PAGE_SIZE;
        }

        let sales = 0;
        let refunds = 0;
        let expenses = 0;
        let cogsDelta = 0;
        let pendingOrderCount = 0;
        from = 0;
        while (true) {
          let q: any = supabase
            .from("sales_orders")
            .select("order_id,sold_price,total_sale_amount,quantity,total_fees,unit_cost,refund_amount,order_status,is_cancelled")
            .eq("user_id", user.id)
            .gte("order_date", startDate)
            .lte("order_date", endDate);
          q = applyMpFilter(q);
          const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
          if (error) throw error;
          for (const row of data || []) {
            const r = row as any;
            const status = String(r.order_status || "");
            if (status === "Canceled" || status === "Cancelled" || r.is_cancelled === true) continue;
            const orderId = String(r.order_id || "").trim();
            if (orderId && reconciledOrderIds.has(orderId)) continue;

            const qty = Number(r.quantity) || 1;
            const totalSale = Number(r.total_sale_amount);
            const soldPrice = Number(r.sold_price);
            const unitPrice = totalSale > 0 ? totalSale / qty : (soldPrice || 0);
            pendingOrderCount++;
            sales += unitPrice * qty;
            refunds += Math.abs(Number(r.refund_amount) || 0);
            expenses += Math.abs(Number(r.total_fees) || 0);
            cogsDelta += (Number(r.unit_cost) || 0) * qty;
          }
          if (!data || data.length < PAGE_SIZE) break;
          from += PAGE_SIZE;
        }

        if (cancelled) return;
        const income = sales - refunds;
        setPlAddOn({
          income,
          expenses,
          cogs: cogsDelta,
          profit: income - expenses - cogsDelta,
          pendingOrderCount,
        });
      } catch (err) {
        console.error("[ProfitLoss] estimated add-on load failed", err);
        if (!cancelled) setPlAddOn({ income: 0, expenses: 0, cogs: 0, profit: 0, pendingOrderCount: 0 });
      }
    };

    loadEstimatedAddOn();
    return () => {
      cancelled = true;
    };
  }, [user, startDate, endDate, mpParam, applyMpFilter]);

  // Fetch manual operating expenses for the selected period and expand
  // recurring entries (monthly/weekly/etc.) into the selected period total.
  // Annual/planned entries are intentional estimates and must not be capped
  // at the current reconciliation cutoff.
  useEffect(() => {
    if (!user || !startDate || !endDate) {
      setManualOpExpenses(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ws = new Date(`${startDate}T00:00:00`);
        const we = new Date(`${endDate}T23:59:59`);
        // Cap recurring operating expenses (Salary, Rent, etc.) at today —
        // we should not pre-charge future months for real recurring expenses.
        // (COGS adjustments like the $23,000 annual estimate are handled
        // separately and intentionally spread across all 12 months.)
        const today = new Date();
        const effEnd = we < today ? we : today;
        if (effEnd < ws) {
          if (!cancelled) setManualOpExpenses(0);
          return;
        }
        const { data, error } = await supabase
          .from("expenses")
          .select("amount,expense_date,end_date,frequency,skipped_months")
          .eq("user_id", user.id)
          .lte("expense_date", endDate);
        if (error) throw error;
        let total = 0;
        for (const r of (data || []) as Array<{
          amount: number; expense_date: string; end_date: string | null; frequency: string | null;
          skipped_months: string[] | null;
        }>) {
          const amount = Number(r.amount) || 0;
          if (amount <= 0) continue;
          const start = new Date(`${r.expense_date}T00:00:00`);
          const stop = r.end_date ? new Date(`${r.end_date}T23:59:59`) : null;
          const a = start > ws ? start : ws;
          const bWindow = stop && stop < effEnd ? stop : effEnd;
          if (bWindow < a) continue;
          const freq = (r.frequency || "one_time").toLowerCase();
          const skipped = new Set((r.skipped_months ?? []).map((s) => s.slice(0, 7)));
          const monthKey = (y: number, m0: number) =>
            `${y}-${String(m0 + 1).padStart(2, "0")}`;
          if (freq === "one_time" || freq === "once") {
            if (start >= ws && start <= effEnd) {
              if (!skipped.has(monthKey(start.getFullYear(), start.getMonth()))) total += amount;
            }
          } else if (freq === "monthly") {
            // Iterate month-by-month so we can honor skipped_months.
            const cursor = new Date(a.getFullYear(), a.getMonth(), 1);
            const last = new Date(bWindow.getFullYear(), bWindow.getMonth(), 1);
            while (cursor <= last) {
              if (!skipped.has(monthKey(cursor.getFullYear(), cursor.getMonth()))) total += amount;
              cursor.setMonth(cursor.getMonth() + 1);
            }
          } else if (freq === "weekly") {
            const weeks = Math.floor((bWindow.getTime() - a.getTime()) / (7 * 86400000)) + 1;
            total += Math.max(0, weeks) * amount;
          } else if (freq === "daily") {
            const days = Math.floor((bWindow.getTime() - a.getTime()) / 86400000) + 1;
            total += Math.max(0, days) * amount;
          } else if (freq === "quarterly") {
            const months =
              (bWindow.getFullYear() - a.getFullYear()) * 12 +
              (bWindow.getMonth() - a.getMonth()) + 1;
            total += Math.max(0, Math.ceil(months / 3)) * amount;
          } else if (freq === "half_yearly") {
            const months =
              (bWindow.getFullYear() - a.getFullYear()) * 12 +
              (bWindow.getMonth() - a.getMonth()) + 1;
            total += Math.max(0, Math.ceil(months / 6)) * amount;
          } else if (freq === "annually" || freq === "yearly" || freq === "annual") {
            const years = bWindow.getFullYear() - a.getFullYear() + 1;
            total += Math.max(0, years) * amount;
          } else {
            if (start >= ws && start <= effEnd) total += amount;
          }
        }
        if (!cancelled) setManualOpExpenses(total);
      } catch (e) {
        console.error("[ProfitLoss] manual expenses fetch failed", e);
        if (!cancelled) setManualOpExpenses(0);
      }
    })();
    return () => { cancelled = true; };
  }, [user, startDate, endDate]);

  // Fetch Inventory Disposition Loss for the period.
  // Rule: SUM(unsellable_qty * unit_cost - recovery_amount) where status IN ('accepted','adjusted').
  // Excludes pending_review and ignored. Kept SEPARATE from COGS in the P&L.
  useEffect(() => {
    if (!user || !startDate || !endDate) {
      setDispositionLoss(0);
      setDispositionRowCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await (supabase as any)
          .from("inventory_dispositions")
          .select("unsellable_qty,unit_cost,recovery_amount,status")
          .eq("user_id", user.id)
          .gte("disposition_date", startDate)
          .lte("disposition_date", endDate)
          .in("status", ["accepted", "adjusted"]);
        if (error) throw error;
        let total = 0;
        let rows = 0;
        for (const r of (data || []) as Array<{
          unsellable_qty: number | null;
          unit_cost: number | null;
          recovery_amount: number | null;
        }>) {
          const qty = Number(r.unsellable_qty) || 0;
          const cost = Number(r.unit_cost) || 0;
          const recovery = Number(r.recovery_amount) || 0;
          const loss = qty * cost - recovery;
          if (loss > 0) {
            total += loss;
            rows += 1;
          }
        }
        if (!cancelled) {
          setDispositionLoss(total);
          setDispositionRowCount(rows);
        }
      } catch (e) {
        console.error("[ProfitLoss] disposition loss fetch failed", e);
        if (!cancelled) {
          setDispositionLoss(0);
          setDispositionRowCount(0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user, startDate, endDate]);

  // Fetch Inventory Write-Off (Warehouse) for the period.
  // Rule: SUM(total_cost) where writeoff_date within [startDate, endDate].
  // Kept SEPARATE from COGS and Disposition Loss in the P&L.
  useEffect(() => {
    if (!user || !startDate || !endDate) {
      setWarehouseWriteoff(0);
      setWarehouseWriteoffRowCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await (supabase as any)
          .from("inventory_writeoffs")
          .select("total_cost")
          .eq("user_id", user.id)
          .gte("writeoff_date", startDate)
          .lte("writeoff_date", endDate);
        if (error) throw error;
        let total = 0;
        let rows = 0;
        for (const r of (data || []) as Array<{ total_cost: number | null }>) {
          const c = Number(r.total_cost) || 0;
          if (c > 0) {
            total += c;
            rows += 1;
          }
        }
        if (!cancelled) {
          setWarehouseWriteoff(total);
          setWarehouseWriteoffRowCount(rows);
        }
      } catch (e) {
        console.error("[ProfitLoss] warehouse writeoff fetch failed", e);
        if (!cancelled) {
          setWarehouseWriteoff(0);
          setWarehouseWriteoffRowCount(0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user, startDate, endDate]);

  const [retrievingCogs, setRetrievingCogs] = useState(false);
  const [cogsDetails, setCogsDetails] = useState<{ ordersWithCost: number; totalOrders: number; cogsSources?: { salesOrders: number; manualOverride: number; inventoryFallback: number; listingsFallback: number; unresolved: number }; cogsAmountBySrc?: { salesOrders: number; manualOverride: number; inventoryFallback: number; listingsFallback: number } } | null>(null);
  const [yearlyCogsBreakdown, setYearlyCogsBreakdown] = useState<
    | Array<{ month: number; label: string; cogs: number; ordersWithCost: number; totalOrders: number }>
    | null
  >(null);
  // Progress tracking
  const [progressId, setProgressId] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Monotonic request sequence — response handlers ignore stale results from a
  // prior year/range selection that resolved after the user moved on.
  const fetchSeqRef = useRef(0);

  // Track continuation state
  const [continueFromMonth, setContinueFromMonth] = useState<number | null>(null);
  const continuationInProgressRef = useRef(false);

  // Year cache status - 'partial' = synced but missing critical event types (e.g. service_fee)
  const [yearCacheStatus, setYearCacheStatus] = useState<{ cached: number; partial: number; missing: number; unknown: number; months: { month: number; label: string; status: 'cached' | 'partial' | 'missing' | 'unknown'; missing_types?: string[] }[] } | null>(null);
  const [checkingYearCache, setCheckingYearCache] = useState(false);
  const [yearCacheError, setYearCacheError] = useState<string | null>(null);
  const [yearCacheRefreshKey, setYearCacheRefreshKey] = useState(0);
  const [monthlyBreakdownRefreshKey, setMonthlyBreakdownRefreshKey] = useState(0);
  
  // DB pressure state
  const { pressureActive } = useDbPressure();
  
  // Stale cache: save last known year cache status in sessionStorage
  const STALE_CACHE_KEY = 'pl_year_cache_status';
  const saveStaleCache = (year: number, data: typeof yearCacheStatus) => {
    try { sessionStorage.setItem(`${STALE_CACHE_KEY}_${year}`, JSON.stringify({ data, savedAt: Date.now() })); } catch {}
  };
  const loadStaleCache = (year: number): typeof yearCacheStatus | null => {
    try {
      const raw = sessionStorage.getItem(`${STALE_CACHE_KEY}_${year}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Accept stale data up to 30 minutes old
      if (Date.now() - parsed.savedAt > 30 * 60 * 1000) return null;
      return parsed.data;
    } catch { return null; }
  };
  const [showingStaleCache, setShowingStaleCache] = useState(false);

  // Reset displayed totals when period/year changes so the previous selection's
  // data can never linger on screen while the new fetch is in flight. Also
  // cancels any in-flight poll by dropping progressId and bumping the fetch
  // sequence so late responses from the prior selection are ignored.
  useEffect(() => {
    fetchSeqRef.current += 1;
    setSummary(null);
    setNetProfit(0);
    setProgressId(null);
    setProgressMessage('');
    setCogs(0);
    setYearlyBaseCogs(0);
    setCogsDetails(null);
    setYearlyCogsBreakdown(null);
  }, [periodType, selectedMonth, selectedYear, customStartDate, customEndDate]);

  useEffect(() => {
    if (!user || periodType !== "yearly") return;
    let cancelled = false;

    const loadYearlyBaseCogs = async () => {
      const { data, error } = await (supabase as any).rpc("get_monthly_cogs", { p_year: selectedYear, p_marketplace: mpParam });
      if (cancelled || error) return;
      const total = ((data || []) as Array<{ cogs?: number }>).reduce((sum, row) => sum + (Number(row.cogs) || 0), 0);
      setYearlyBaseCogs(total);
    };

    loadYearlyBaseCogs();
    return () => {
      cancelled = true;
    };
  }, [user, periodType, selectedYear, mpParam]);

  // Check year cache status when yearly mode is selected or year changes
  // Now with timeout, circuit breaker, and stale-cache fallback
  useEffect(() => {
    if (periodType !== 'yearly' || !user) {
      setYearCacheStatus(null);
      setYearCacheError(null);
      setShowingStaleCache(false);
      return;
    }

    // If DB pressure is active, skip and show stale cache
    if (isDbPressureActive()) {
      const stale = loadStaleCache(selectedYear);
      if (stale) {
        setYearCacheStatus(stale);
        setShowingStaleCache(true);
        setYearCacheError('Database is under heavy load. Showing last known cache status.');
      } else {
        setYearCacheStatus({ cached: 0, partial: 0, missing: 0, unknown: 12, months: MONTHS.map((m) => ({ month: m.value, label: m.label, status: 'unknown' as const })) });
        setYearCacheError('Database is under heavy load. Cache status could not be checked right now.');
        setShowingStaleCache(false);
      }
      setCheckingYearCache(false);
      return;
    }

    const checkYearCache = async () => {
      setCheckingYearCache(true);
      setYearCacheError(null);
      setShowingStaleCache(false);

      try {
        // Single RPC call replaces 12 individual HEAD requests
        // Use type assertion since RPC may not be in generated types yet
        const rpcResult = await withTimeout(
          Promise.resolve(
            (supabase as any).rpc('get_year_cache_status', { p_year: selectedYear })
          ),
          8000,
          'year_cache_rpc'
        ) as { data: any; error: any };

        if (rpcResult.error) throw rpcResult.error;

        const data = rpcResult.data;
        const monthStatuses = (data.months || []).map((m: any) => ({
          month: m.month,
          label: MONTHS[m.month]?.label || `M${m.month + 1}`,
          status: m.status as 'cached' | 'partial' | 'missing',
          missing_types: Array.isArray(m.missing_types) ? m.missing_types : [],
        }));

        const result = {
          cached: data.cached || 0,
          partial: data.partial || 0,
          missing: data.missing || 0,
          unknown: 0,
          months: monthStatuses,
        };
        setYearCacheStatus(result);
        saveStaleCache(selectedYear, result);
      } catch (err) {
        console.error('Error checking year cache:', err);
        if (isTimeoutError(err)) recordDbFailure('year_cache_rpc');
        const stale = loadStaleCache(selectedYear);
        if (stale) {
          setYearCacheStatus(stale);
          setShowingStaleCache(true);
          setYearCacheError('Year cache status could not be loaded right now. Showing last known status.');
        } else {
          setYearCacheStatus({ cached: 0, partial: 0, missing: 0, unknown: 12, months: MONTHS.map((m) => ({ month: m.value, label: m.label, status: 'unknown' as const })) });
          setYearCacheError('Year cache status could not be loaded right now.');
        }
      } finally {
        setCheckingYearCache(false);
      }
    };

    checkYearCache();
  }, [periodType, selectedYear, user, yearCacheRefreshKey]);

  // Function to continue syncing from a specific month
  const continueSyncFromMonth = async (monthIndex: number) => {
    if (continuationInProgressRef.current) return;
    continuationInProgressRef.current = true;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { start, end } = calculateDateRange(periodType, selectedMonth, selectedYear, customStartDate, customEndDate);
      
      const response = await supabase.functions.invoke('fetch-profit-loss', {
        body: {
          startDate: `${start}T00:00:00.000Z`,
          endDate: `${end}T23:59:59.999Z`,
          forceRefresh: true,
          continueFromMonth: monthIndex,
          // Ensure the edge function updates the SAME progress row we are polling
          progressId,
        },
      });

      if (response.error) {
        console.error('Continuation error:', response.error);
      }
    } catch (e) {
      console.error('Error continuing sync:', e);
    } finally {
      continuationInProgressRef.current = false;
    }
  };

  // Poll for progress updates. This must NOT depend on the page-level loading flag:
  // yearly Amazon sync is background work and can finish after the initial button
  // request has already released the UI.
  useEffect(() => {
    if (!progressId) return;

    const pollProgress = async () => {
      try {
        const { data, error } = await supabase
          .from('pl_sync_progress')
          .select('*')
          .eq('id', progressId)
          .maybeSingle();

        if (error) {
          console.error('Error polling progress:', error);
          return;
        }

        if (!data) {
          setLoading(false);
          setProgressId(null);
          setProgressMessage('Amazon sync finished or the progress tracker expired. Click View Cached Data to refresh totals.');
          if (periodType === 'yearly') {
            setYearCacheRefreshKey((key) => key + 1);
            setMonthlyBreakdownRefreshKey((key) => key + 1);
          }
          toast.info('Amazon sync tracker closed. Click View Cached Data to refresh totals.');
          return;
        }

        if (data) {
          setProgressMessage(data.message || "");
          setCurrentChunk(data.current_chunk || 0);
          setTotalChunks(data.total_chunks || 0);

          // Detect stalled sync (background task died / got stuck) - reduced to 2 minutes
          const updatedAtMs = data.updated_at ? new Date(data.updated_at).getTime() : 0;
          const isStalled =
            data.status === "running" &&
            updatedAtMs > 0 &&
            Date.now() - updatedAtMs > 2 * 60 * 1000;

          if (isStalled) {
            // Retry the SAME month (current_chunk is 1-based)
            const currentMonthNumber = data.current_chunk || 1;
            const retryMonthIndex = Math.max(0, currentMonthNumber - 1);
            console.log(`Sync stalled at month #${currentMonthNumber}, retrying month index ${retryMonthIndex}...`);
            setProgressMessage(`Stalled — retrying month ${currentMonthNumber}...`);
            await continueSyncFromMonth(retryMonthIndex);
            return;
          }

          // Handle "continue" status - edge function processed one month and exited
          if (data.status === "continue") {
            // ContinueFromMonth expects a 0-based month index
            const nextMonthIndex = data.current_chunk || 0;
            console.log(`Month complete, continuing to month ${nextMonthIndex + 1}...`);
            await continueSyncFromMonth(nextMonthIndex);
            return;
          }

          // Update live summary
          if (data.summary) {
            const summaryData = recomputeReconciledTotals(data.summary as unknown as FinancialSummary);
            setSummary(summaryData);
          }

          if (data.status === "completed") {
            setLoading(false);
            if (data.summary) {
              setSummary(recomputeReconciledTotals(data.summary as unknown as FinancialSummary));
            }
            // COGS is now retrieved manually via "Retrieve COGS" button - don't overwrite
            // setCogs(Number(data.cogs) || 0);
            setNetProfit(Number(data.net_profit) || 0);
            toast.success("P&L calculation complete!");
            if (periodType === 'yearly') {
              setYearCacheRefreshKey((key) => key + 1);
              setMonthlyBreakdownRefreshKey((key) => key + 1);
            }

            // Cleanup progress record
            await supabase.from("pl_sync_progress").delete().eq("id", progressId);
            setProgressId(null);
          } else if (data.status === "error") {
            setLoading(false);
            toast.error(`Error calculating P&L: ${data.error}`);
            setProgressId(null);
          }
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    };

    pollIntervalRef.current = setInterval(pollProgress, 2000);
    pollProgress(); // Initial poll

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [progressId, periodType, selectedMonth, selectedYear]);

  // 1s ticker for elapsed-time display while a sync is running
  useEffect(() => {
    if (!progressId && !loading) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [progressId, loading]);

  const handleViewRetrieve = (forceRefresh = false) => {
    const { start, end } = calculateDateRange(periodType, selectedMonth, selectedYear, customStartDate, customEndDate);
    setStartDate(start);
    setEndDate(end);
    fetchProfitLossWithDates(start, end, forceRefresh);
  };

  // Single adaptive "View" — automatically decides cached vs Amazon sync
  // based on cache completeness. For yearly: if any month is missing/partial,
  // trigger a sync; otherwise use cache. For monthly/custom: use cache
  // (backend merges what exists).
  const handleSmartView = () => {
    let shouldSync = false;
    if (periodType === 'yearly') {
      const missing = yearCacheStatus?.missing ?? 0;
      const partial = yearCacheStatus?.partial ?? 0;
      shouldSync = (missing + partial) > 0;
    }
    handleViewRetrieve(shouldSync);
  };

  const handleClearCacheAndResync = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error("Please log in");
      return;
    }

    setLoading(true);
    
    // Calculate the date range for the selected period
    const { start, end } = calculateDateRange(periodType, selectedMonth, selectedYear, customStartDate, customEndDate);
    setStartDate(start);
    setEndDate(end);
    
    const periodLabel = periodType === 'yearly' 
      ? `year ${selectedYear}` 
      : periodType === 'monthly' 
        ? `${MONTHS[selectedMonth].label} ${selectedYear}`
        : `${start} to ${end}`;
    
    setProgressMessage(`Clearing cache for ${periodLabel}...`);

    try {
      // Delete cached financial events ONLY for the selected date range
      const { error: deleteError } = await supabase
        .from('financial_events_cache')
        .delete()
        .eq('user_id', session.user.id)
        .gte('event_date', start)
        .lte('event_date', end);
      
      if (deleteError) {
        throw new Error(deleteError.message);
      }
      
      toast.success(`Cache cleared for ${periodLabel}! Starting fresh sync...`);
      
      // Now trigger a fresh sync for this period
      fetchProfitLossWithDates(start, end, true);
    } catch (error: any) {
      console.error('Error clearing cache:', error);
      toast.error(`Error clearing cache: ${error.message}`);
      setLoading(false);
    }
  };

  const fetchProfitLossWithDates = async (start: string, end: string, forceRefresh = false) => {
    const mySeq = ++fetchSeqRef.current;
    setLoading(true);
    setProgressMessage(forceRefresh ? 'Syncing latest data from Amazon…' : 'Loading…');
    setProgressStartedAt(Date.now());
    // Always clear prior totals so a previous year/range can't flash on screen
    // while the new fetch is in flight (fixes 2026→2025 flicker).
    setSummary(null);
    setCogs(0);
    setNetProfit(0);
    setProgressId(null);
    setCurrentChunk(0);
    setTotalChunks(0);
    if (forceRefresh && periodType === 'yearly') {
      try { sessionStorage.removeItem(`${STALE_CACHE_KEY}_${selectedYear}`); } catch {}
    }

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Please log in');
        if (mySeq === fetchSeqRef.current) setLoading(false);
        return;
      }

      const response = await supabase.functions.invoke('fetch-profit-loss', {
        body: {
          // Send UTC timestamps to avoid local timezone shifting the range into the next day/month
          startDate: `${start}T00:00:00.000Z`,
          endDate: `${end}T23:59:59.999Z`,
          forceRefresh,
        },
      });

      // Drop stale response: user changed year/range while this was in flight.
      if (mySeq !== fetchSeqRef.current) {
        console.log('[ProfitLoss] Dropping stale fetch response (superseded)');
        return;
      }

      if (response.error) {
        throw new Error(response.error.message);
      }

      // Cache-only responses return summary immediately (no progressId / polling)
      if (response.data?.summary) {
        setSummary(recomputeReconciledTotals(response.data.summary as FinancialSummary));
        // COGS is now retrieved manually via "Retrieve COGS" button - don't overwrite
        // setCogs(Number(response.data.cogs) || 0);
        const np = Number(response.data.net_profit);
        if (!Number.isNaN(np)) setNetProfit(np);

        // If the cache isn't fully synced to the requested end date, warn (but still render fast).
        if (response.data?.stale) {
          toast.info("Showing cached data (still syncing). Click 'Sync New Data' for the full year.");
        }

        setProgressId(null);
        setLoading(false);
        if (periodType === 'yearly') {
          setYearCacheRefreshKey((key) => key + 1);
          setMonthlyBreakdownRefreshKey((key) => key + 1);
        }
        return;
      }

      // Otherwise, a sync is in progress: start polling
      if (response.data?.progressId) {
        setProgressId(response.data.progressId);
        setLoading(false);
        toast.info('Amazon sync started. P&L will update when the background sync finishes.');
        return;
      }

      setLoading(false);
      toast.warning('Amazon sync started but no progress tracker was returned. Try View Cached Data in a moment.');
    } catch (error: any) {
      if (mySeq !== fetchSeqRef.current) return; // superseded — swallow silently
      console.error('Error fetching P&L:', error);
      if (isTimeoutError(error)) {
        recordDbFailure('fetch_profit_loss');
        toast.error('Database timed out. Cached report data may still be available — try View Cached Data.');
      } else {
        toast.error(`Error loading data: ${error.message}`);
      }
      setLoading(false);
    }
  };

  // Retrieve COGS from sales_orders with fallback to inventory/created_listings costs
  const retrieveCOGS = async () => {
    setRetrievingCogs(true);
    setCogsDetails(null);
    setYearlyCogsBreakdown(null);

    // Check db pressure before starting heavy operation
    if (pressureActive) {
      toast.warning("Database is under heavy load. COGS retrieval may be slow or incomplete.");
    }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        toast.error("Please log in");
        return;
      }

      const userId = session.user.id;

      const retrieveCogsForRange = async (start: string, end: string): Promise<{
        totalCOGS: number;
        ordersWithCost: number;
        totalOrders: number;
        cogsSources: { salesOrders: number; manualOverride: number; inventoryFallback: number; listingsFallback: number; unresolved: number };
        cogsAmountBySrc: { salesOrders: number; manualOverride: number; inventoryFallback: number; listingsFallback: number };
      }> => {
        // Unified COGS engine — calls the same SQL resolver used by Live Sales,
        // Mobile Live Sales, Sales Report, P&L yearly and CSV export. Precedence:
        // sales_orders snapshot → asin_cost_overrides (date-aware) →
        // created_listings newest by date_created → inventory.cost → SKU fallback.
        const { data, error } = await (supabase as any).rpc("get_cogs_for_range", {
          p_start: start,
          p_end: end,
          p_marketplace: mpParam,
        });
        if (error) throw new Error(error.message);

        const row = Array.isArray(data) ? data[0] : data;
        const totalCOGS = Number(row?.total_cogs) || 0;
        const totalOrders = Number(row?.total_orders) || 0;
        const ordersWithCost = Number(row?.orders_with_cost) || 0;

        const cogsByJson: Record<string, number> = (row?.cogs_by_source as any) || {};
        const unitsByJson: Record<string, number> = (row?.units_by_source as any) || {};

        const cogsAmountBySrc = {
          salesOrders: Number(cogsByJson.salesOrders) || 0,
          manualOverride: Number(cogsByJson.manualOverride) || 0,
          inventoryFallback: Number(cogsByJson.inventoryFallback) || 0,
          listingsFallback: Number(cogsByJson.listingsFallback) || 0,
        };
        const cogsSources = {
          salesOrders: Number(unitsByJson.salesOrders) || 0,
          manualOverride: Number(unitsByJson.manualOverride) || 0,
          inventoryFallback: Number(unitsByJson.inventoryFallback) || 0,
          listingsFallback: Number(unitsByJson.listingsFallback) || 0,
          unresolved: Number(unitsByJson.unresolved) || 0,
        };

        return { totalCOGS, ordersWithCost, totalOrders, cogsSources, cogsAmountBySrc };
      };


      if (periodType === "yearly") {
        // User expectation: sum month-by-month for yearly to guarantee all 12 months are included.
        const yearStart = `${selectedYear}-01-01`;
        const yearEnd = `${selectedYear}-12-31`;
        setStartDate(yearStart);
        setEndDate(yearEnd);

        const toastId = toast.loading(`Retrieving COGS for ${selectedYear} (0/12 months)...`);

        let yearTotal = 0;
        let yearOrdersWithCost = 0;
        let yearTotalOrders = 0;
        let yearCogsSources = { salesOrders: 0, manualOverride: 0, inventoryFallback: 0, listingsFallback: 0, unresolved: 0 };
        let yearCogsAmountBySrc = { salesOrders: 0, manualOverride: 0, inventoryFallback: 0, listingsFallback: 0 };
        const breakdown: Array<{ month: number; label: string; cogs: number; ordersWithCost: number; totalOrders: number; error?: string }> = [];
        let failedMonths = 0;

        for (let m = 0; m < 12; m++) {
          const monthLabel = MONTHS[m]?.label ?? `Month ${m + 1}`;
          toast.loading(`Retrieving COGS for ${selectedYear} (${m + 1}/12: ${monthLabel})...`, { id: toastId });
          
          try {
            const { start, end } = calculateDateRange("monthly", m, selectedYear);
            const res = await retrieveCogsForRange(start, end);

            breakdown.push({
              month: m,
              label: monthLabel,
              cogs: res.totalCOGS,
              ordersWithCost: res.ordersWithCost,
              totalOrders: res.totalOrders,
            });

            yearTotal += res.totalCOGS;
            yearOrdersWithCost += res.ordersWithCost;
            yearTotalOrders += res.totalOrders;
            if (res.cogsSources) {
              yearCogsSources.salesOrders += res.cogsSources.salesOrders;
              yearCogsSources.manualOverride += res.cogsSources.manualOverride;
              yearCogsSources.inventoryFallback += res.cogsSources.inventoryFallback;
              yearCogsSources.listingsFallback += res.cogsSources.listingsFallback;
              yearCogsSources.unresolved += res.cogsSources.unresolved;
            }
            if (res.cogsAmountBySrc) {
              yearCogsAmountBySrc.salesOrders += res.cogsAmountBySrc.salesOrders;
              yearCogsAmountBySrc.manualOverride += res.cogsAmountBySrc.manualOverride;
              yearCogsAmountBySrc.inventoryFallback += res.cogsAmountBySrc.inventoryFallback;
              yearCogsAmountBySrc.listingsFallback += res.cogsAmountBySrc.listingsFallback;
            }
          } catch (monthError: any) {
            console.error(`[COGS] Failed to retrieve ${monthLabel}:`, monthError);
            failedMonths++;
            breakdown.push({
              month: m,
              label: monthLabel,
              cogs: 0,
              ordersWithCost: 0,
              totalOrders: 0,
              error: monthError.message || 'Timeout',
            });
            // Continue with other months instead of failing entirely
          }
        }

        setYearlyCogsBreakdown(breakdown);
        setCogs(yearTotal);
        setCogsDetails({ ordersWithCost: yearOrdersWithCost, totalOrders: yearTotalOrders, cogsSources: yearCogsSources, cogsAmountBySrc: yearCogsAmountBySrc });

        if (summary) {
          const newNetProfit = summary.totalIncome - summary.totalExpenses - yearTotal;
          setNetProfit(newNetProfit);
        }

        // Show final result with appropriate toast type
        if (failedMonths === 0) {
          toast.success(`COGS retrieved (year): ${formatCurrency(yearTotal)} from ${yearOrdersWithCost.toLocaleString()} orders`, { id: toastId });
        } else if (failedMonths < 12) {
          toast.warning(`COGS partially retrieved: ${formatCurrency(yearTotal)} (${failedMonths} months failed due to timeouts)`, { id: toastId });
        } else {
          toast.error(`COGS retrieval failed for all months. Try again when database load is lower.`, { id: toastId });
        }
        return;
      }

      // Default: use the currently selected range
      const { start, end } = calculateDateRange(periodType, selectedMonth, selectedYear, customStartDate, customEndDate);
      setStartDate(start);
      setEndDate(end);

      toast.info(`Retrieving COGS for ${start} to ${end}...`);

      const res = await retrieveCogsForRange(start, end);

      setCogs(res.totalCOGS);
      setCogsDetails({ ordersWithCost: res.ordersWithCost, totalOrders: res.totalOrders, cogsSources: res.cogsSources, cogsAmountBySrc: res.cogsAmountBySrc });

      if (summary) {
        const newNetProfit = summary.totalIncome - summary.totalExpenses - res.totalCOGS;
        setNetProfit(newNetProfit);
      }

      toast.success(`COGS retrieved: ${formatCurrency(res.totalCOGS)} from ${res.ordersWithCost.toLocaleString()} orders`);
    } catch (error: any) {
      console.error("Error retrieving COGS:", error);
      toast.error(`Error: ${error.message}`);
    } finally {
      setRetrievingCogs(false);
    }
  };

  const exportToExcel = async () => {
    if (exportingExcel) return;
    if (!user || !startDate || !endDate || !summary) {
      toast.error("Load P&L data before exporting Excel.");
      return;
    }

    setExportingExcel(true);
    const exportToast = toast.loading("Preparing month-by-month export…");
    try {
      // Always export the FULL selected year month-by-month (Jan → Dec),
      // regardless of whether the user is currently viewing a monthly or yearly window.
      // This guarantees all 12 columns appear in the spreadsheet.
      const exportYear = selectedYear;
      const months: Array<{ key: string; label: string; year: number; month: number; from: string; to: string }> = [];
      const cursor = new Date(exportYear, 0, 1);
      const lastMonth = new Date(exportYear, 11, 1);
      while (cursor <= lastMonth) {
        const y = cursor.getFullYear();
        const m = cursor.getMonth();
        const first = new Date(y, m, 1);
        const last = new Date(y, m + 1, 0);
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const fromStr = fmt(first);
        const toStr = fmt(last);
        months.push({
          key: `${y}-${String(m + 1).padStart(2, '0')}`,
          label: first.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
          year: y,
          month: m,
          from: fromStr,
          to: toStr,
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }

      type MonthData = {
        summary: FinancialSummary | null;
        /** The row the on-screen P&L uses. Source of every income/expense line. */
        plRow: PlMonthRow | null;
        cogs: number;
        cogsAdjustment: number;
        disposition: number;
        writeoff: number;
        opExpenses: number;
        opByCategory: Record<string, number>;
        /**
         * FBM Buy Shipping label cost. The one Amazon charge NOT carried on
         * plRow, because it comes from sales_orders rather than
         * financial_events_cache -- Amazon does not deliver it as a financial
         * event. It therefore cannot live in EXPENSE_ROWS and has to be summed
         * explicitly here, exactly as cogs and opExpenses are.
         */
        fbmLabel: number;
      };
      const perMonth: Record<string, MonthData> = {};

      // Authoritative base COGS for the monthly export. This is the same RPC
      // used by the visible InventoryLab-style monthly table, so Excel cannot
      // drift from the on-screen "COGS (from Sold Orders)" total.
      const authoritativeCogsMonthly: number[] = Array(12).fill(0);
      let hasAuthoritativeMonthlyCogs = false;
      try {
        const { data: cogsData, error: cogsErr } = await (supabase as any).rpc("get_monthly_cogs", { p_year: exportYear, p_marketplace: mpParam });
        if (cogsErr) throw cogsErr;
        for (const row of (cogsData || []) as Array<{ month_num: number; cogs: number }>) {
          const idx = (Number(row.month_num) || 0) - 1;
          if (idx >= 0 && idx < 12) authoritativeCogsMonthly[idx] = Number(row.cogs) || 0;
        }
        hasAuthoritativeMonthlyCogs = authoritativeCogsMonthly.some((v) => Math.abs(v) > 0.005);
      } catch (e) {
        console.error('[Export] get_monthly_cogs fetch failed', e);
      }

      // Pre-fetch COGS adjustments for the year and bucket per month using the
      // SAME logic as MonthlyPLBreakdown (split adjustment evenly across overlap months)
      // so the Excel matches the on-screen Net Profit.
      const cogsAdjustmentMonthly: number[] = Array(12).fill(0);
      try {
        const yearStartIso = `${exportYear}-01-01`;
        const yearEndIso = `${exportYear}-12-31`;
        const yearEndExclusiveIso = `${exportYear + 1}-01-01`;
        const { data: adjData } = await supabase
          .from('cogs_adjustments')
          .select('amount,period_start,period_end')
          .eq('user_id', user.id)
          .lt('period_start', yearEndExclusiveIso)
          .gte('period_end', yearStartIso);
        // Cap distribution at the selected period's endDate AND at today, so
        // a yearly $23,000 adjustment isn't pre-charged into future months
        // (May–Dec) when the on-screen P&L only counts it once for the period.
        const adjToday = new Date();
        const adjPeriodEnd = endDate ? new Date(`${endDate}T23:59:59`) : adjToday;
        const adjCap = adjPeriodEnd < adjToday ? adjPeriodEnd : adjToday;
        const adjCapMonth = adjCap.getFullYear() === exportYear ? adjCap.getMonth() : 11;
        for (const adj of (adjData || []) as Array<{ amount: number; period_start: string; period_end: string }>) {
          const amount = Number(adj.amount) || 0;
          if (!amount) continue;
          const start = new Date(`${adj.period_start}T00:00:00`);
          const end = new Date(`${adj.period_end}T00:00:00`);
          // Only distribute across months that fall within both the
          // adjustment's own period AND the active P&L window (up to today /
          // selected endDate). This makes the monthly columns sum to the
          // SAME total the UI shows for the selected period — no phantom
          // future-month COGS, no under-counting.
          const activeOverlap: number[] = [];
          for (let i = 0; i <= adjCapMonth; i++) {
            const ms = new Date(exportYear, i, 1);
            const me = new Date(exportYear, i + 1, 1);
            if (start < me && end >= ms) activeOverlap.push(i);
          }
          if (!activeOverlap.length) continue;
          const per = amount / activeOverlap.length;
          for (const i of activeOverlap) cogsAdjustmentMonthly[i] += per;
        }
      } catch (e) {
        console.error('[Export] cogs_adjustments fetch failed', e);
      }

      // Pre-fetch all manual operating expenses (Salary, rent, etc.) once,
      // then expand per month using the same logic as the on-page calculation.
      let opExpenseRows: Array<{
        amount: number; expense_date: string; end_date: string | null;
        frequency: string | null; skipped_months: string[] | null; category?: string | null;
      }> = [];
      try {
        const { data: opData } = await supabase
          .from('expenses')
          .select('amount,expense_date,end_date,frequency,skipped_months,category')
          .eq('user_id', user.id)
          .lte('expense_date', `${exportYear}-12-31`);
        opExpenseRows = (opData || []) as any;
      } catch (e) {
        console.error('[Export] expenses fetch failed', e);
      }

      // Collect all distinct categories across the year so we can render
      // one dynamic row per category in the export (Salary, Rent, etc.).
      const allCategories = Array.from(new Set(
        opExpenseRows.map(r => (r.category && String(r.category).trim()) || 'Uncategorized')
      )).sort((a, b) => a.localeCompare(b));

      const exportToday = new Date();
      const computeOpExpensesForMonth = (mo: typeof months[number]): { total: number; byCategory: Record<string, number> } => {
        const ws = new Date(mo.year, mo.month, 1, 0, 0, 0);
        const we = new Date(mo.year, mo.month + 1, 0, 23, 59, 59);
        // Cap recurring operating expenses at today so future months don't
        // get pre-charged with Salary/Rent that hasn't been paid yet.
        const effEnd = we < exportToday ? we : exportToday;
        const byCategory: Record<string, number> = {};
        for (const c of allCategories) byCategory[c] = 0;
        if (effEnd < ws) return { total: 0, byCategory };
        let total = 0;
        const add = (cat: string, amt: number) => {
          if (amt <= 0) return;
          total += amt;
          byCategory[cat] = (byCategory[cat] || 0) + amt;
        };
        for (const r of opExpenseRows) {
          const amount = Number(r.amount) || 0;
          if (amount <= 0) continue;
          const cat = (r.category && String(r.category).trim()) || 'Uncategorized';
          const start = new Date(`${r.expense_date}T00:00:00`);
          const stop = r.end_date ? new Date(`${r.end_date}T23:59:59`) : null;
          const a = start > ws ? start : ws;
          const bWindow = stop && stop < effEnd ? stop : effEnd;
          if (bWindow < a) continue;
          const freq = (r.frequency || 'one_time').toLowerCase();
          const skipped = new Set((r.skipped_months ?? []).map((s) => s.slice(0, 7)));
          const monthKey = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, '0')}`;
          if (freq === 'one_time' || freq === 'once') {
            if (start >= ws && start <= effEnd) {
              if (!skipped.has(monthKey(start.getFullYear(), start.getMonth()))) add(cat, amount);
            }
          } else if (freq === 'monthly') {
            const cursor = new Date(a.getFullYear(), a.getMonth(), 1);
            const last = new Date(bWindow.getFullYear(), bWindow.getMonth(), 1);
            while (cursor <= last) {
              if (!skipped.has(monthKey(cursor.getFullYear(), cursor.getMonth()))) add(cat, amount);
              cursor.setMonth(cursor.getMonth() + 1);
            }
          } else if (freq === 'weekly') {
            const weeks = Math.floor((bWindow.getTime() - a.getTime()) / (7 * 86400000)) + 1;
            add(cat, Math.max(0, weeks) * amount);
          } else if (freq === 'daily') {
            const days = Math.floor((bWindow.getTime() - a.getTime()) / 86400000) + 1;
            add(cat, Math.max(0, days) * amount);
          } else if (freq === 'quarterly') {
            const monthsCount = (bWindow.getFullYear() - a.getFullYear()) * 12 + (bWindow.getMonth() - a.getMonth()) + 1;
            add(cat, Math.max(0, Math.ceil(monthsCount / 3)) * amount);
          } else if (freq === 'half_yearly') {
            const monthsCount = (bWindow.getFullYear() - a.getFullYear()) * 12 + (bWindow.getMonth() - a.getMonth()) + 1;
            add(cat, Math.max(0, Math.ceil(monthsCount / 6)) * amount);
          } else if (freq === 'annually' || freq === 'yearly' || freq === 'annual') {
            const annMonth = start.getMonth();
            if (mo.month === annMonth && mo.year >= start.getFullYear()) {
              if (!skipped.has(monthKey(mo.year, mo.month))) add(cat, amount);
            }
          } else {
            if (start >= ws && start <= effEnd) add(cat, amount);
          }
        }
        return { total, byCategory };
      };

      // Helper: fetch one month's summary + COGS + disposition + writeoff
      const fetchMonth = async (mo: typeof months[number]): Promise<MonthData> => {
        const result: MonthData = { summary: null, plRow: null, cogs: 0, cogsAdjustment: 0, disposition: 0, writeoff: 0, opExpenses: 0, opByCategory: {}, fbmLabel: 0 };

        // 1) Summary via cached fetch-profit-loss (no force refresh)
        try {
          const resp = await supabase.functions.invoke('fetch-profit-loss', {
            body: {
              startDate: `${mo.from}T00:00:00.000Z`,
              endDate: `${mo.to}T23:59:59.999Z`,
              forceRefresh: false,
            },
          });
          if (resp.data?.summary) {
            result.summary = resp.data.summary as FinancialSummary;
            result.cogs = Number(resp.data.cogs) || 0;
          }
        } catch (e) {
          console.error('[Export] summary fetch failed for', mo.key, e);
        }

        // 2) Disposition Loss
        try {
          // sellable_qty and outcome are selected because the shared rule needs
          // them: once a business outcome is recorded the SELLABLE units are lost
          // too. Counting only unsellable understated the loss on those rows.
          const { data } = await (supabase as any)
            .from('inventory_dispositions')
            .select('sellable_qty,unsellable_qty,unit_cost,recovery_amount,outcome,status')
            .eq('user_id', user.id)
            .gte('disposition_date', mo.from)
            .lte('disposition_date', mo.to)
            .in('status', DISPOSITION_STATUSES as unknown as string[]);
          let total = 0;
          for (const r of (data || []) as DispositionRowLike[]) {
            total += computeDispositionLoss(r).loss;
          }
          result.disposition = total;
        } catch (e) {
          console.error('[Export] disposition fetch failed for', mo.key, e);
        }

        // 3) Warehouse Write-Off
        try {
          const { data } = await (supabase as any)
            .from('inventory_writeoffs')
            .select('total_cost')
            .eq('user_id', user.id)
            .gte('writeoff_date', mo.from)
            .lte('writeoff_date', mo.to);
          let total = 0;
          for (const r of (data || []) as Array<{ total_cost: number | null }>) {
            const c = Number(r.total_cost) || 0;
            if (c > 0) total += c;
          }
          result.writeoff = total;
        } catch (e) {
          console.error('[Export] writeoff fetch failed for', mo.key, e);
        }

        // 4) Manual Operating Expenses (Salary, rent, etc.) for this month — by category
        try {
          const { total, byCategory } = computeOpExpensesForMonth(mo);
          result.opExpenses = total;
          result.opByCategory = byCategory;
        } catch (e) {
          console.error('[Export] op expenses compute failed for', mo.key, e);
        }

        return result;
      };

      // The on-screen P&L's data source, fetched once for the whole year with the
      // same marketplace filter. One call, not twelve -- it returns all months.
      let plRowsByMonth: Array<PlMonthRow | null> = Array(12).fill(null);
      try {
        const { data: plData, error: plErr } = await (supabase as any)
          .rpc('get_monthly_pl_breakdown', { p_year: exportYear, p_marketplace: mpParam });
        if (plErr) throw plErr;
        const byMonth: Array<PlMonthRow | null> = Array(12).fill(null);
        for (const r of (plData || []) as PlMonthRow[]) {
          const idx = Number(r.month_num) - 1;
          if (idx >= 0 && idx < 12) byMonth[idx] = r;
        }
        plRowsByMonth = byMonth;

        // Marketplace facilitator tax comes from a SEPARATE rpc, exactly as
        // MonthlyPLBreakdown does on screen.
        //
        // get_monthly_pl_breakdown's own facilitator columns read Financial
        // Events, which does not carry ItemWithheldTax for this account, so
        // they are ~0 for every month -- measured 2026-09-05: zero for January
        // through August and $646.54 for September. The real figures live in
        // settlement_line_items (90-day retention) plus the manual
        // facilitator_tax_adjustments seeded for the months that fell outside
        // it, which is what get_monthly_facilitator_tax unions.
        //
        // The export read only the breakdown, so the web showed $51,652.18 for
        // the year and the spreadsheet showed zeros. That is the exact drift
        // this file's model is meant to prevent: one number, two readers, one
        // of them updated. The merge below is a copy of the on-screen one and
        // must stay in step with it -- if a third reader ever appears, this
        // belongs inside get_monthly_pl_breakdown instead.
        try {
          const { data: facData, error: facErr } = await (supabase as any)
            .rpc('get_monthly_facilitator_tax', { p_year: exportYear, p_marketplace: mpParam });
          if (facErr) throw facErr;
          // the settlement source is AUTHORITATIVE ONLY WHERE IT HAS DATA.
          // 
          //             settlement_line_items keeps ~90 days, so the current month has
          //             usually not posted yet and get_monthly_facilitator_tax returns 0.00
          //             for it. Overwriting with that zero strands the offsetting line:
          //             Amazon COLLECTS the tax from the buyer and WITHHOLDS the same money
          //             to remit it, so "Sales Tax Collected" and this row cancel out.
          // 
          //             Measured 2026-09-05: January to August net to noise (-160.62 to
          //             +374.39) because settlements carry them and Financial Events does
          //             not. September had collected 646.54 against a settlement value of
          //             0.00 -- a clean +646.54 of phantom profit -- while Financial Events
          //             already held exactly 646.54 for it.
          // 
          //             So a zero from settlements means NOT YET POSTED, not zero tax. Only
          //             a non-zero value overrides, and the Financial Events figure stands
          //             until the settlement arrives and replaces it.
          for (const fr of (facData || []) as Array<any>) {
            const fi = Number(fr?.month_num) - 1;
            if (fi < 0 || fi > 11 || !plRowsByMonth[fi]) continue;
            const fTax = Number(fr?.facilitator_tax) || 0;
            const fRef = Number(fr?.facilitator_tax_refunds) || 0;
            if (fTax === 0 && fRef === 0) continue;
            plRowsByMonth[fi] = {
              ...(plRowsByMonth[fi] as PlMonthRow),
              marketplace_facilitator_tax: fTax,
              marketplace_facilitator_tax_refunds: fRef,
            };
          }
        } catch (fe) {
          // Warn rather than fail the export: every other line is still
          // correct, and a silent zero here is what caused the original
          // mismatch.
          console.warn('[Export] get_monthly_facilitator_tax unavailable', fe);
        }
      } catch (e) {
        console.error('[Export] get_monthly_pl_breakdown failed', e);
        // Loud, because every income and expense line depends on it. Silently
        // exporting zeros would look like a genuinely empty year.
        toast.error('Could not load the P&L breakdown — export aborted rather than write zeros.');
        toast.dismiss(exportToast);
        return;
      }

      // Same RPC the screen uses, so the two cannot disagree on this line.
      // Not fatal if it fails -- unlike the breakdown above, one missing expense
      // row is worth a warning, not an aborted export.
      const fbmLabelByMonth: number[] = Array(12).fill(0);
      try {
        const { data: fbmData, error: fbmErr } = await (supabase as any)
          .rpc('get_monthly_fbm_label_cost', { p_year: exportYear, p_marketplace: mpParam });
        if (fbmErr) throw fbmErr;
        for (const r of (fbmData || []) as Array<{ month_num: number; label_cost: number }>) {
          const idx = Number(r.month_num) - 1;
          if (idx >= 0 && idx < 12) fbmLabelByMonth[idx] = Number(r.label_cost) || 0;
        }
      } catch (e) {
        console.warn('[Export] get_monthly_fbm_label_cost failed', e);
      }

      // Sequential with 800ms spacing to respect inter-edge-function rate limits
      for (let i = 0; i < months.length; i++) {
        const mo = months[i];
        toast.loading(`Fetching ${mo.label} (${i + 1}/${months.length})…`, { id: exportToast });
        const md = await fetchMonth(mo);
        if (hasAuthoritativeMonthlyCogs) md.cogs = authoritativeCogsMonthly[mo.month] || 0;
        md.cogsAdjustment = cogsAdjustmentMonthly[mo.month] || 0;
        // Every income and expense line comes from here -- the SAME RPC row the
        // on-screen P&L renders -- not from the fetch-profit-loss summary, which
        // does not expose shipping_chargeback or restocking_fee at all.
        md.plRow = plRowsByMonth[mo.month] ?? null;
        md.fbmLabel = fbmLabelByMonth[mo.month] ?? 0;
        perMonth[mo.key] = md;
        if (i < months.length - 1) await new Promise(r => setTimeout(r, 800));
      }

      // ── Estimated add-on per month (only when UI is in "estimated" mode) ──
      // Mirrors loadEstimatedAddOn(): pull sales_orders not present in
      // financial_events_cache (shipment) for the same month, bucket by
      // order_date, and add deltas to income / expenses / cogs so Excel
      // matches the on-screen Live View totals exactly.
      const estDeltaMonthly: Record<string, { income: number; expenses: number; cogs: number }> = {};
      for (const m of months) estDeltaMonthly[m.key] = { income: 0, expenses: 0, cogs: 0 };
      const isEstimatedExport = plMode === "estimated";
      if (isEstimatedExport) {
        try {
          const yearStartIso = `${exportYear}-01-01`;
          const yearEndIso = `${exportYear}-12-31`;
          const PAGE = 1000;

          // 1) Reconciled order ids for the whole year
          const reconciledOrderIds = new Set<string>();
          let from = 0;
          while (true) {
            let q: any = supabase
              .from("financial_events_cache")
              .select("amazon_order_id")
              .eq("user_id", user.id)
              .eq("event_type", "shipment")
              .gte("event_date", yearStartIso)
              .lte("event_date", yearEndIso);
            q = applyMpFilter(q);
            const { data, error } = await q.range(from, from + PAGE - 1);
            if (error) throw error;
            for (const row of data || []) {
              const id = String((row as any).amazon_order_id || "").trim();
              if (id) reconciledOrderIds.add(id);
            }
            if (!data || data.length < PAGE) break;
            from += PAGE;
          }

          // 2) Sales orders for the year, bucketed per month for unsettled rows
          from = 0;
          while (true) {
            let q: any = supabase
              .from("sales_orders")
              .select("order_id,order_date,sold_price,total_sale_amount,quantity,total_fees,unit_cost,refund_amount,order_status,is_cancelled")
              .eq("user_id", user.id)
              .gte("order_date", yearStartIso)
              .lte("order_date", yearEndIso);
            q = applyMpFilter(q);
            const { data, error } = await q.range(from, from + PAGE - 1);
            if (error) throw error;
            for (const row of data || []) {
              const r = row as any;
              const status = String(r.order_status || "");
              if (status === "Canceled" || status === "Cancelled" || r.is_cancelled === true) continue;
              const orderId = String(r.order_id || "").trim();
              if (orderId && reconciledOrderIds.has(orderId)) continue;
              const od = r.order_date ? new Date(r.order_date) : null;
              if (!od || od.getFullYear() !== exportYear) continue;
              const key = `${od.getFullYear()}-${String(od.getMonth() + 1).padStart(2, "0")}`;
              const bucket = estDeltaMonthly[key];
              if (!bucket) continue;
              const qty = Number(r.quantity) || 1;
              const totalSale = Number(r.total_sale_amount);
              const soldPrice = Number(r.sold_price);
              const unitPrice = totalSale > 0 ? totalSale / qty : (soldPrice || 0);
              const sales = unitPrice * qty;
              const refunds = Math.abs(Number(r.refund_amount) || 0);
              const fees = Math.abs(Number(r.total_fees) || 0);
              const cogsDelta = (Number(r.unit_cost) || 0) * qty;
              bucket.income += sales - refunds;
              bucket.expenses += fees;
              bucket.cogs += cogsDelta;
            }
            if (!data || data.length < PAGE) break;
            from += PAGE;
          }
        } catch (e) {
          console.error("[Export] estimated add-on per-month failed", e);
        }

        // Apply deltas onto the per-month summary so every row reflects the Live View
        for (const m of months) {
          const md = perMonth[m.key];
          const d = estDeltaMonthly[m.key];
          if (!md || !d) continue;
          if (md.summary) {
            md.summary = {
              ...md.summary,
              sales: (Number(md.summary.sales) || 0) + d.income, // approximate: income delta into Sales line
              totalIncome: (Number(md.summary.totalIncome) || 0) + d.income,
              totalExpenses: (Number(md.summary.totalExpenses) || 0) + d.expenses,
            } as any;
          }
          // The rows render from plRow, so the delta MUST land there too. Updating
          // only md.summary (as this did until 2026-08-19) would silently export
          // reconciled figures under an "ESTIMATED" heading.
          //
          // Same approximation as above: the income delta goes to Sales and the
          // expense delta to Amazon Fee Adjustments, because the estimate is a
          // per-order total with no category breakdown to distribute.
          if (md.plRow) {
            md.plRow = {
              ...md.plRow,
              sales: (Number(md.plRow.sales) || 0) + d.income,
              other_fees: (Number(md.plRow.other_fees) || 0) + d.expenses,
            };
          }
          md.cogs = (md.cogs || 0) + d.cogs;
        }
      }

      // Reconcile per-month base COGS to match the exact source used by the
      // on-screen yearly P&L. In yearly mode the UI prefers `yearlyBaseCogs`
      // from get_monthly_cogs; using the older manual `cogs` state here was
      // why Excel stayed at $24,838.33 instead of the displayed $43,025.81.
      const exportPeriodCogsTotal = hasAuthoritativeMonthlyCogs
        ? authoritativeCogsMonthly.reduce((sum, value) => sum + value, 0)
        : periodType === 'yearly' && yearlyBaseCogs > 0
          ? yearlyBaseCogs
        : (Number(cogs) || 0);
      // Only rescale in reconciled mode. In estimated mode each month already
      // received its unsettled-orders COGS delta and rescaling would erase it.
      if (!isEstimatedExport && exportPeriodCogsTotal > 0) {
        const exportRawSum = months.reduce((acc, m) => acc + (perMonth[m.key]?.cogs || 0), 0);
        if (exportRawSum > 0 && Math.abs(exportRawSum - exportPeriodCogsTotal) > 0.5) {
          const scale = exportPeriodCogsTotal / exportRawSum;
          for (const m of months) {
            const md = perMonth[m.key];
            if (md) md.cogs = +(md.cogs * scale).toFixed(2);
          }
          console.info('[Export] Reconciled per-month COGS to UI total', {
            uiTotal: exportPeriodCogsTotal,
            rawSum: exportRawSum,
            scale,
          });
        }
      }

      // Build rows: each metric is a row, each month is a column
      const headerRow = ['Category', ...months.map(m => m.label), 'TOTAL'];
      const EMPTY_MD: MonthData = { summary: null, plRow: null, cogs: 0, cogsAdjustment: 0, disposition: 0, writeoff: 0, opExpenses: 0, opByCategory: {}, fbmLabel: 0 };
      const get = (key: string, sel: (d: MonthData) => number) => {
        const vals = months.map(m => sel(perMonth[m.key] || EMPTY_MD));
        const total = vals.reduce((a, b) => a + b, 0);
        return [key, ...vals.map(v => Number(v.toFixed(2))), Number(total.toFixed(2))];
      };
      const s = (d: MonthData) => d.summary;
      const num = (v: number | undefined | null) => Number(v) || 0;

      // Render one shared RowDef. Same label, same columns, same sign as the
      // screen -- because it is literally the same definition object.
      const getDef = (def: RowDef) =>
        get(def.label, d => {
          const r = d.plRow;
          if (!r) return 0;
          const v = rowValue(r, def);
          return def.negative ? -v : v;
        });
      const sumDefs = (defs: RowDef[]) => (d: MonthData) => (d.plRow ? sumRows(d.plRow, defs) : 0);

      const rows: any[][] = [];
      const modeLabel = isEstimatedExport ? 'ESTIMATED' : 'RECONCILED';
      rows.push([`PROFIT & LOSS — Month by Month (${exportYear})`]);
      rows.push([`Mode: ${modeLabel}${isEstimatedExport ? ' ⚠ Not for tax use — includes unsettled orders' : ' ✔ Settled financial events (tax-ready)'}`]);
      rows.push([]);

      // INCOME and EXPENSES are rendered from the shared row definitions, in the
      // shared order. Adding a category in plModel.ts adds it to both reports at
      // once -- which is the whole point: the previous hand-written list here
      // silently omitted 10 categories the screen counted.
      // Honour the screen's InventoryLab-style toggle. When it is on, the four
      // refund/rebate rows sit under Income as negatives instead of under
      // Expenses. Net Profit is identical either way, but the SECTION totals are
      // not -- so a sheet that ignored the toggle would disagree with the screen
      // it was exported from on both Total Income and Total Amazon Fees.
      const ilStyle = (() => {
        try { return localStorage.getItem('pl_il_style_view') === '1'; } catch { return false; }
      })();
      const RECLASSIFIED = new Set(['refunds', 'shipping_credit_refunds', 'gift_wrap_credit_refunds', 'promotional_rebates']);
      const isReclassified = (d: RowDef) => !!d.key && RECLASSIFIED.has(d.key as string);
      const incomeDefs: RowDef[] = ilStyle
        ? [...INCOME_ROWS, ...EXPENSE_ROWS.filter(isReclassified)]
        : INCOME_ROWS;
      const expenseDefs: RowDef[] = ilStyle
        ? EXPENSE_ROWS.filter((d) => !isReclassified(d))
        : EXPENSE_ROWS;

      rows.push(['INCOME']);
      rows.push(headerRow);
      for (const def of incomeDefs) rows.push(getDef(def));
      rows.push(get('TOTAL INCOME', sumDefs(incomeDefs)));
      rows.push([]);

      // Expenses (Amazon Fees + Refunds + Promotional Rebates + Credit Refunds).
      // Rendered negative, and TOTAL EXPENSES is negative to match.
      rows.push(['EXPENSES (Amazon Fees)']);
      rows.push(headerRow);
      for (const def of expenseDefs) rows.push(getDef(def));
      rows.push(get('TOTAL EXPENSES', sumDefs(expenseDefs)));
      rows.push([]);

      // COGS + Inventory Damage & Loss (combined IRS-friendly line)
      rows.push(['COST OF GOODS SOLD']);
      rows.push(headerRow);
      rows.push(get('Cost of Goods Sold',      d => -(d.cogs + d.cogsAdjustment)));
      rows.push(get('Inventory Damage & Loss', d => -(d.disposition + d.writeoff)));
      rows.push([]);

      // Operating Expenses — one dynamic row per category (Salary, Rent, Software, etc.)
      // Categories come from the user's /tools/expenses entries.
      rows.push(['OPERATING EXPENSES (by Category)']);
      rows.push(headerRow);
      if (allCategories.length === 0) {
        rows.push(get('Operating Expenses', d => -d.opExpenses));
      } else {
        for (const cat of allCategories) {
          rows.push(get(cat, d => -(d.opByCategory?.[cat] || 0)));
        }
        rows.push(get('TOTAL OPERATING EXPENSES', d => -d.opExpenses));
      }
      rows.push([]);

      // Tax
      rows.push(['TAX SUMMARY']);
      rows.push(headerRow);
      for (const def of OTHER_ROWS) rows.push(getDef(def));
      rows.push(get('NET TAX', sumDefs(OTHER_ROWS)));
      rows.push([]);

      // Memo — already counted inside a line above, never added again.
      rows.push(['MEMO (already counted above — do not add)']);
      rows.push(headerRow);
      for (const def of MEMO_ROWS) rows.push(getDef(def));
      rows.push([]);

      // Net Profit per month
      rows.push(['PROFIT & LOSS SUMMARY']);
      rows.push(headerRow);
      rows.push(get('Total Income',            sumDefs(incomeDefs)));
      rows.push(get('Total Amazon Fees',       sumDefs(expenseDefs)));
      rows.push(get('Cost of Goods Sold',      d => -(d.cogs + d.cogsAdjustment)));
      rows.push(get('Inventory Damage & Loss', d => -(d.disposition + d.writeoff)));
      rows.push(get('Operating Expenses',      d => -d.opExpenses));
      // EXPENSE_ROWS already carry their own sign, so this is a sum, not a
      // subtraction -- identical to the screen's
      // income + expenses - COGS - opEx - inventory loss.
      // Computed once and pushed twice. The confirmation line at the very bottom
      // has to be the SAME selector, not a re-derivation -- two formulas that are
      // meant to agree is how the web and Excel P&L drifted $2,491.75 apart in
      // the first place, and a confirmation line that can disagree with the total
      // it confirms is worse than no confirmation line.
      const netProfitSel = (d: MonthData) => {
        if (!d.plRow) return 0;
        return sumRows(d.plRow, incomeDefs)
          + sumRows(d.plRow, expenseDefs)
          - (d.cogs + d.cogsAdjustment)
          - (d.disposition + d.writeoff)
          - d.opExpenses
          // Screen subtracts this too (MonthlyPLBreakdown's monthTotals.net).
          // Omitting it here would recreate the web/Excel drift on day one.
          - d.fbmLabel;
      };
      rows.push(get('FBM Shipping Labels', (d: MonthData) => -d.fbmLabel));
      rows.push(get('NET PROFIT/LOSS', netProfitSel));

      // Restated on its own at the foot of the sheet, so the figure can be read
      // without scrolling back up through the sections.
      rows.push([]);
      rows.push(get('NET PROFIT/LOSS (confirmation)', netProfitSel));

      // Build a styled workbook using ExcelJS (borders, section headers, bold totals, freeze pane)
      // Retried, then reloaded once, if the chunk is stale.
      //
      // A tab left open across a deploy still asks for the OLD content-hashed
      // filename, and the SPA rewrite answers with index.html at HTTP 200
      // rather than a 404 -- measured 2026-09-05 on
      // exceljs.min-kycDTznP.js. The browser then reports "Failed to fetch
      // dynamically imported module", which reads like the exporter is broken
      // when the export is fine and the tab is simply old.
      const ExcelJS = (await importWithRetry(() => import('exceljs'))).default;
      const wb2 = new ExcelJS.Workbook();
      const ws2 = wb2.addWorksheet('P&L by Month', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }],
      });

      const totalCols = 1 + months.length + 1;
      const lastColLetter = ws2.getColumn(totalCols).letter;

      // Section header fills / styles
      const SECTION_TITLES = new Set([
        'INCOME', 'EXPENSES (Amazon Fees)', 'COST OF GOODS SOLD',
        'OPERATING EXPENSES (by Category)', 'TAX SUMMARY', 'PROFIT & LOSS SUMMARY'
      ]);
      const TOTAL_LABELS = new Set([
        'TOTAL INCOME', 'TOTAL EXPENSES', 'TOTAL OPERATING EXPENSES',
        'NET TAX', 'NET PROFIT/LOSS', 'NET PROFIT/LOSS (confirmation)'
      ]);

      const thinBorder = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
      const thickBorder = { style: 'medium' as const, color: { argb: 'FF1F2A44' } };

      const sectionRanges: { startRow: number; endRow: number }[] = [];
      let currentSectionStart: number | null = null;

      rows.forEach((row, idx) => {
        const excelRow = ws2.addRow(row);
        const rowNum = excelRow.number;
        const firstCell = String(row[0] ?? '');

        // Title row (row 1) — big bold
        if (idx === 0) {
          ws2.mergeCells(`A${rowNum}:${lastColLetter}${rowNum}`);
          excelRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
          excelRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1C3F' } };
          excelRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
          excelRow.height = 24;
          return;
        }
        // Subtitle (mode) row 2
        if (idx === 1) {
          ws2.mergeCells(`A${rowNum}:${lastColLetter}${rowNum}`);
          excelRow.getCell(1).font = { italic: true, size: 11, color: { argb: 'FF374151' } };
          excelRow.getCell(1).alignment = { horizontal: 'center' };
          return;
        }

        // Section title row
        if (row.length === 1 && SECTION_TITLES.has(firstCell)) {
          if (currentSectionStart !== null) {
            sectionRanges.push({ startRow: currentSectionStart, endRow: rowNum - 1 });
          }
          currentSectionStart = rowNum;
          ws2.mergeCells(`A${rowNum}:${lastColLetter}${rowNum}`);
          const c = excelRow.getCell(1);
          c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };
          c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
          excelRow.height = 20;
          return;
        }

        // Header row (Category | months… | TOTAL)
        if (firstCell === 'Category') {
          excelRow.eachCell((cell, colNumber) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B5998' } };
            cell.alignment = { horizontal: colNumber === 1 ? 'left' : 'center', vertical: 'middle' };
            cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
          });
          return;
        }

        // Empty spacer row
        if (row.length === 0) return;

        // Data row — apply currency format, borders, alternating fill
        const isTotal = TOTAL_LABELS.has(firstCell);
        const isMemo = firstCell.toLowerCase().includes('(memo)');
        const zebra = (rowNum % 2 === 0) ? 'FFF7F9FC' : 'FFFFFFFF';

        excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (colNumber > totalCols) return;
          cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
          if (colNumber === 1) {
            cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
            cell.font = {
              bold: isTotal,
              italic: isMemo,
              color: { argb: isMemo ? 'FF6B7280' : 'FF111827' },
            };
          } else {
            cell.numFmt = '$#,##0.00;[Red]($#,##0.00);"-"';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
            cell.font = {
              bold: isTotal,
              italic: isMemo,
              color: { argb: isMemo ? 'FF6B7280' : 'FF111827' },
            };
          }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: isTotal ? 'FFE5EDF7' : zebra },
          };
        });

        if (isTotal) {
          excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            if (colNumber > totalCols) return;
            cell.border = {
              top: thickBorder,
              bottom: thickBorder,
              left: thinBorder,
              right: thinBorder,
            };
          });
        }
      });

      // Close the last section
      if (currentSectionStart !== null) {
        sectionRanges.push({ startRow: currentSectionStart, endRow: ws2.rowCount });
      }

      // Thick outside border around each section
      sectionRanges.forEach(({ startRow, endRow }) => {
        for (let r = startRow; r <= endRow; r++) {
          for (let c = 1; c <= totalCols; c++) {
            const cell = ws2.getCell(r, c);
            const existing = cell.border || {};
            const newBorder: any = { ...existing };
            if (r === startRow) newBorder.top = thickBorder;
            if (r === endRow) newBorder.bottom = thickBorder;
            if (c === 1) newBorder.left = thickBorder;
            if (c === totalCols) newBorder.right = thickBorder;
            cell.border = newBorder;
          }
        }
      });

      // Column widths
      ws2.getColumn(1).width = 42;
      for (let i = 2; i <= 1 + months.length; i++) ws2.getColumn(i).width = 15;
      ws2.getColumn(totalCols).width = 17;

      const arrayBuffer = await wb2.xlsx.writeBuffer();
      const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const filename = `ProfitLoss_${isEstimatedExport ? 'Estimated' : 'Reconciled'}_${exportYear}_MonthByMonth.xlsx`;
      setExcelDownload(prev => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { url, filename };
      });
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      document.body.removeChild(a);

      toast.success("Excel file is ready. If it does not download automatically, click Download Ready File.", { id: exportToast });
    } catch (err: any) {
      console.error('[Export] failed', err);
      toast.error(`Export failed: ${err?.message || 'unknown error'}`, { id: exportToast });
    } finally {
      setExportingExcel(false);
    }
  };

  const syncInProgress = Boolean(progressId);
  const controlsDisabled = loading;
  const syncControlsDisabled = loading || syncInProgress;
  const progressPercent = totalChunks > 0 ? (currentChunk / totalChunks) * 100 : 0;

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-background pt-20">
        <div className="container mx-auto px-4 py-8">
        {/* Header */}
        {/* Tax-only report banner — highly visible, non-dismissible */}
        <div
          role="alert"
          className="mb-6 rounded-lg border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 shadow-md flex items-start gap-3"
        >
          <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-base font-bold text-amber-900 dark:text-amber-100 uppercase tracking-wide">
              This report is for tax purposes only
            </p>
            <p className="text-sm text-amber-800 dark:text-amber-200 mt-0.5">
              Settlement-based (Amazon Financial Events) numbers intended for tax filing and accounting reconciliation.
              For live / order-date views, use <strong>Sales Report</strong> or <strong>Live Sales</strong>.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-4 mb-8 flex-wrap">
          <Button variant="ghost" size="icon" onClick={() => navigate('/tools')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-bold text-foreground">Profit & Loss</h1>
            <p className="text-muted-foreground">
              Orders <strong>shipped / settled</strong> in this period — sourced from Amazon Financial Events.
              <span className="block text-xs mt-0.5 opacity-75">
                Tip: orders are often placed days earlier and ship later. The Live Sales chart shows the placement-date view.
              </span>
            </p>
          </div>
          {/* Refunds-in-Income toggle removed — permanently ON. */}

        </div>

        <SyncReadinessBanner module="pl" />

        {user?.id && (() => {
          const { start, end } = calculateDateRange(periodType, selectedMonth, selectedYear, customStartDate, customEndDate);
          return (
            <SoFecParityBanner
              userId={user.id}
              startDate={String(start).slice(0, 10)}
              endDate={String(end).slice(0, 10)}
            />
          );
        })()}

        {/* International Marketplace Profit — always visible, independent of
            the ALL/US/CA/MX/BR filter below. This is the third distinct P&L
            concept: marketplace-attributable costs only, no US overhead. */}
        <div className="mb-8">
          <InternationalMarketplaceProfitPanel
            year={selectedYear}
            marketplaces={intlMarketplaces}
          />
        </div>

        {/* Date Range Selector */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5" />
              Select Period
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Marketplace filter — matches Mobile Live Sales buttons */}
            <div className="mb-4 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setMarketplaceFilter("ALL")}
                disabled={controlsDisabled}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider border transition-colors disabled:opacity-50 ${
                  marketplaceFilter === "ALL"
                    ? "bg-blue-500 text-white border-blue-400"
                    : "bg-muted/40 text-foreground border-border hover:bg-muted"
                }`}
              >
                All
              </button>
              {PL_ACTIVE_MARKETPLACES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMarketplaceFilter(m)}
                  disabled={controlsDisabled}
                  title={m === homeMarketplace ? "Your primary marketplace" : undefined}
                  className={`relative px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider border transition-colors disabled:opacity-50 ${
                    marketplaceFilter === m
                      ? "bg-blue-500 text-white border-blue-400"
                      : "bg-muted/40 text-foreground border-border hover:bg-muted"
                  } ${m === homeMarketplace ? "ring-2 ring-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]" : ""}`}
                >
                  {m}
                  {m === homeMarketplace && <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400 absolute -top-1.5 -right-1.5" />}
                </button>
              ))}
              {marketplaceFilter !== "ALL" && (
                <span className="ml-2 text-xs text-muted-foreground">
                  Filtering P&amp;L to {marketplaceFilter} only
                </span>
              )}
            </div>
            {/* Three distinct P&L concepts, per explicit request: US Full P&L
                (complete business incl. overhead) vs. All Marketplaces
                (consolidated company total, same overhead) vs. International
                Marketplace Profit (its own always-visible panel below --
                marketplace-attributable costs only, no US overhead). This
                note exists so the ALL/US/CA/MX/BR buttons above aren't
                mistaken for that third concept. */}
            <p className="mb-4 text-xs text-muted-foreground flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {marketplaceFilter === "US"
                ? "US Full P&L: your complete business profitability, including Operating Expenses (Salary, Rent, Subscriptions, etc.) and Inventory Damage & Loss."
                : marketplaceFilter === "ALL"
                ? "All Marketplaces: the full consolidated company P&L — Amazon activity and COGS across every marketplace, plus company-wide Operating Expenses and Inventory Damage & Loss. Those two are whole-business overhead, not specific to any international marketplace — see \"International Marketplace Profit\" below for a channel-only view."
                : `${marketplaceFilter}-only view below shows Amazon activity and COGS for ${marketplaceFilter} exactly as filtered — Operating Expenses and Inventory Damage & Loss are account-wide figures with no per-marketplace data behind them, so they aren't meaningful to attribute here. For a clean marketplace-only profit number, see "International Marketplace Profit" below.`}
            </p>
            <div className="flex flex-wrap items-end gap-4">
              {/* Period Type Dropdown */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Period</p>
                <Select value={periodType} onValueChange={setPeriodType} disabled={controlsDisabled}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Select period" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIOD_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Month Dropdown — hidden in yearly mode */}
              {periodType !== 'yearly' && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Month</p>
                  <Select 
                    value={String(selectedMonth)} 
                    onValueChange={(v) => setSelectedMonth(Number(v))} 
                    disabled={controlsDisabled}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder="Select month" />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((month) => (
                        <SelectItem key={month.value} value={String(month.value)}>
                          {month.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Year Dropdown */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Year</p>
                <Select 
                  value={String(selectedYear)} 
                  onValueChange={(v) => setSelectedYear(Number(v))} 
                  disabled={controlsDisabled}
                >
                  <SelectTrigger className="w-[100px]">
                    <SelectValue placeholder="Year" />
                  </SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((year) => (
                      <SelectItem key={year.value} value={String(year.value)}>
                        {year.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/*
                Estimated mode removed — P&L is permanently Reconciled
                (Amazon Financial Events, settlement-based). Sales Report and
                Live Sales provide the order-date / estimated view.
                See .lovable/profit-loss-open-items.md → "On-screen estimated add-on".
              */}



              {/* Adaptive View button — auto decides cached vs Amazon sync */}
              {(() => {
                const willSync = periodType === 'yearly'
                  && ((yearCacheStatus?.missing ?? 0) + (yearCacheStatus?.partial ?? 0)) > 0;
                const busy = loading || syncInProgress;
                return (
                  <Button onClick={handleSmartView} disabled={busy} className="gap-2">
                    {busy ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        View
                      </>
                    )}
                  </Button>
                );
              })()}

              {/* Clear Cache & Full Resync Button — admin only */}
              {isAdmin && (
                <Button 
                  variant="destructive" 
                  onClick={handleClearCacheAndResync} 
                  disabled={syncControlsDisabled} 
                  className="gap-2"
                  title="Admin only — regular users never see this button. Deletes cached financial events for the selected period and re-fetches from Amazon. Rarely needed now: the normal sync upserts on (user_id, event_type, event_date, amazon_order_id, asin) with ignoreDuplicates false, so View already overwrites anything Amazon restates. Deleting first only risks the range not coming back in full."
                >
                  <Trash2 className="h-4 w-4" />
                  Clear Cache &amp; Resync
                  {/* The badge is the whole point of keeping the label busy:
                      without it there is nothing on screen to say this control
                      is admin-gated, and it is the one destructive button on
                      the page. */}
                  <span className="ml-1 rounded bg-white/25 px-1.5 py-0.5 text-[10px] font-normal leading-none">
                    hidden for users
                  </span>
                </Button>
              )}
              
              
              {/* COGS source audit.
                  Named "Retrieve COGS" until 2026-09-05, which implied the
                  totals would not appear without pressing it. They do: the
                  export reads get_monthly_cogs itself and the breakdown shows
                  "COGS coverage 100.0%" unaided. What this actually reports is
                  the SOURCE of every figure, which is how a cost taken from
                  the weakest rung gets spotted -- the $2,136 unit cost on a
                  foam sword the day before came from inventoryFallback. */}
              <Button 
                onClick={retrieveCOGS} 
                disabled={controlsDisabled || retrievingCogs} 
                className="gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold text-base px-6 py-5 shadow-md"
                title="Shows where each cost came from — sales orders, manual override, purchase batch, listing or the weak current-inventory fallback — and flags orders with no cost at all. Your COGS totals appear without this; it is an audit, not a fetch."
              >
                {retrievingCogs ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Calculating...
                  </>
                ) : (
                  <>
                    <ReceiptText className="h-4 w-4" />
                    Check COGS sources
                  </>
                )}
              </Button>
              
              {summary && (
                <>
                  {/* Same big-green treatment already used for the other
                      primary actions on this page, so the export reads as a
                      main action rather than a secondary one. */}
                  <Button onClick={exportToExcel} disabled={exportingExcel} className="gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold text-base px-6 py-5 shadow-md">
                    {exportingExcel ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {exportingExcel ? 'Preparing Excel...' : 'Export Excel'}
                  </Button>
                  {excelDownload && !exportingExcel && (
                    <Button asChild className="gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold text-base px-6 py-5 shadow-md">
                      <a href={excelDownload.url} download={excelDownload.filename}>
                        <Download className="h-4 w-4" />
                        Download again
                      </a>
                    </Button>
                  )}
                </>
              )}
            </div>

            {/* Sync Requirement Notice */}
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>💡 The Monthly P&amp;L Breakdown table below loads instantly from cache. Click <strong>View</strong> to load or refresh the data from Amazon.</span>

            </div>

            {/* Show selected date range */}
            {startDate && endDate && (
              <p className="mt-2 text-sm text-muted-foreground">
                Date Range: {startDate} to {endDate}
              </p>
            )}

            {/* DB Pressure / Year Cache Error Banner */}
            {yearCacheError && periodType === 'yearly' && (
              <Alert variant="destructive" className="mt-4">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Database Load</AlertTitle>
                <AlertDescription>
                  {yearCacheError}
                  {showingStaleCache && <span className="ml-1 italic">(Showing last known cache status)</span>}
                  <Button variant="outline" size="sm" className="ml-3" onClick={() => {
                    setYearCacheError(null);
                    setShowingStaleCache(false);
                    // Re-trigger cache check by toggling year
                    setSelectedYear(prev => prev);
                  }}>
                    <RefreshCw className="h-3 w-3 mr-1" /> Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {/* Global DB Pressure Banner */}
            {pressureActive && (
              <Alert className="mt-4 border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
                <WifiOff className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-amber-700 dark:text-amber-400">Database Under Heavy Load</AlertTitle>
                <AlertDescription className="text-amber-600 dark:text-amber-300">
                  Optional diagnostics are temporarily reduced. Core P&L functions (View Cached Data, Sync from Amazon, Retrieve COGS) remain available.
                  Cached report data may still be available — try <strong>View Cached Data</strong>.
                </AlertDescription>
              </Alert>
            )}

            {/* Year Cache Status Grid */}
            {periodType === 'yearly' && yearCacheStatus && !loading && (
              <div className="mt-4 rounded-md border border-border p-3">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <p className="text-sm font-medium">
                    {selectedYear} Cache Status: {yearCacheStatus.cached}/12 fully cached
                    {yearCacheStatus.partial > 0 && `, ${yearCacheStatus.partial} partial`}
                    {yearCacheStatus.unknown > 0 && `, ${yearCacheStatus.unknown} unknown`}
                    {yearCacheStatus.cached === 12 ? ' ✅' : (yearCacheStatus.partial > 0 ? ' ⚠️' : yearCacheStatus.cached > 0 ? ' 🟡' : ' ⚪')}
                  </p>
                  <div className="flex items-center gap-3 text-xs">
                    {yearCacheStatus.partial > 0 && (
                      <span className="text-orange-600">⚠ {yearCacheStatus.partial} months missing fee data — re-sync recommended</span>
                    )}
                    {yearCacheStatus.missing > 0 && (
                      <span className="text-amber-600">{yearCacheStatus.missing} months not synced</span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-12 gap-1.5">
                  {yearCacheStatus.months.map((m) => {
                    const missingLabel = (m.missing_types || []).map((t) =>
                      t === 'service_fee' ? 'FBA fees (storage/inbound/removal)' : t
                    ).join(', ');
                    const tooltip =
                      m.status === 'cached' ? `${m.label}: Fully cached`
                      : m.status === 'partial' ? `${m.label}: Synced but missing ${missingLabel || 'some event types'} — click "Sync from Amazon" to backfill`
                      : m.status === 'unknown' ? `${m.label}: Unknown (timeout)`
                      : `${m.label}: Not synced`;
                    return (
                      <div
                        key={m.month}
                        className={cn(
                          "rounded px-1.5 py-1 text-center text-xs font-medium border",
                          m.status === 'cached'
                            ? "bg-primary/10 border-primary/30 text-primary"
                            : m.status === 'partial'
                              ? "bg-orange-50 dark:bg-orange-950/20 border-orange-400 dark:border-orange-700 text-orange-700 dark:text-orange-400"
                              : m.status === 'unknown'
                                ? "bg-amber-50 dark:bg-amber-950/20 border-amber-300 dark:border-amber-700 text-amber-600"
                                : "bg-muted border-border text-muted-foreground"
                        )}
                        title={tooltip}
                      >
                        {m.label.substring(0, 3)}
                        <div className="text-[10px] mt-0.5">
                          {m.status === 'cached' ? '✓'
                            : m.status === 'partial' ? '⚠'
                            : m.status === 'unknown' ? '?'
                            : '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {periodType === 'yearly' && checkingYearCache && (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking cache status for {selectedYear}...
              </div>
            )}
            
            {/* Live Progress */}
            {(loading || syncInProgress) && (() => {
              const elapsedMs = progressStartedAt ? Math.max(0, nowTick - progressStartedAt) : 0;
              const secs = Math.floor(elapsedMs / 1000);
              const mm = Math.floor(secs / 60);
              const ss = secs % 60;
              const elapsedLabel = `${mm}:${String(ss).padStart(2, '0')}`;
              // Friendlier message: "2026-02: page 35..." → "Fetching Feb 2026 (page 35)"
              const rawMsg = progressMessage || (loading ? 'Working…' : '');
              const m = rawMsg.match(/^(\d{4})-(\d{2}):\s*page\s+(\d+)/i);
              const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              const friendly = m
                ? `Fetching ${monthLabels[Number(m[2]) - 1]} ${m[1]} — page ${m[3]} (this can take a few minutes for large months)`
                : rawMsg;
              const indeterminate = !(totalChunks > 0);
              return (
                <div className="mt-6 space-y-3">
                  <div className="flex items-center justify-between text-sm gap-3">
                    <span className="text-muted-foreground flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                      </span>
                      {friendly}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                      {totalChunks > 0 && <>Month {currentChunk}/{totalChunks} · </>}
                      {elapsedLabel}
                    </span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden relative">
                    {indeterminate ? (
                      <div className="absolute inset-y-0 left-0 w-1/3 bg-primary/70 rounded-full animate-[shimmer_1.4s_ease-in-out_infinite]"
                        style={{ animation: 'pl-indeterminate 1.4s ease-in-out infinite' }} />
                    ) : (
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${progressPercent}%` }}
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    You can leave this page — the sync continues in the background and results will be cached.
                  </p>
                  <style>{`@keyframes pl-indeterminate {0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
                </div>
              );
            })()}
            {/* Legacy mid-sync mini-KPI row removed. Monthly P&L Breakdown table is the display. */}

          </CardContent>
        </Card>

        {/* HybridPLPanel removed — Monthly P&L Breakdown is the single P&L display. plMode toggle preserved next to year picker. */}

        {/* InventoryLab-style monthly columns. Rendered for Yearly, Quarterly, and Monthly.
            The table always shows the full calendar year so totals stay verifiable; the
            selected month(s) are highlighted so users can see which columns their period
            picker covers. Range-aware clipping is deferred to the future Option B refactor. */}
        {user && (periodType === 'yearly' || periodType === 'quarterly' || periodType === 'monthly') && (
          <MonthlyPLBreakdown
            year={selectedYear}
            refreshKey={monthlyBreakdownRefreshKey}
            onCogsBaseTotalChange={setYearlyBaseCogs}
            mode={plMode}
            marketplace={marketplaceFilter}
            ilStyleView={ilStyleView}
            onIlStyleViewChange={setIlStyleView}
            highlightMonths={
              periodType === 'monthly'
                ? [selectedMonth + 1]
                : periodType === 'quarterly'
                  ? (() => { const q = Math.floor(selectedMonth / 3); return [q * 3 + 1, q * 3 + 2, q * 3 + 3]; })()
                  : undefined
            }
          />
        )}

        {/* Legacy empty-state + Accounting-View toggle removed. Monthly P&L Breakdown table is the single P&L display. */}


        {/* Legacy Accounting View block removed — Monthly P&L Breakdown table above is the single source of truth. */}



            {/* Orders Cost Editor - for adding missing costs */}
            {user && startDate && endDate && (
              <OrdersCostEditor
                userId={user.id}
                startDate={startDate}
                endDate={endDate}
                onCostUpdated={() => {
                  // Trigger COGS re-retrieval hint
                  toast.info("Cost updated! Click 'Retrieve COGS' to recalculate.");
                }}
              />
            )}

            {/* COGS Adjustments - flow directly into COGS line, NOT into Expenses */}
            {user && startDate && endDate && (
              <CogsAdjustmentsPanel
                userId={user.id}
                startDate={startDate}
                endDate={endDate}
                onChanged={(total) => setCogsAdjustment(total)}
              />
            )}

            {/* P&L Audit panel removed with legacy Accounting View. */}


        {/* Refunds Dialog */}
        <Dialog open={showRefundsDialog} onOpenChange={setShowRefundsDialog}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Refund Details ({summary?.refundRecords?.length || 0} refunds)</DialogTitle>
            </DialogHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order ID</TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead>Posted Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary?.refundRecords?.map((refund, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-sm">{refund.orderId}</TableCell>
                    <TableCell className="font-mono text-sm">{refund.asin || '-'}</TableCell>
                    <TableCell>{new Date(refund.postedDate).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right text-red-600">{formatCurrency(refund.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DialogContent>
        </Dialog>

        {startDate && endDate && (
          <div className="mt-4">
            <ReplacementCogsSection
              rangeStart={startDate}
              rangeEnd={endDate}
              label={`${startDate} → ${endDate}`}
              currencySymbol={homeCurrencySymbol}
              homeRate={homeRate}
            />
            <p className="text-[11px] text-muted-foreground mt-2">
              Replacement / free-shipment COGS shown above is informational. P&amp;L profit
              numbers stay based on settled FEC events only (Amazon-funded replacements that
              post real fees / cost-of-goods entries are already reflected in those settled
              totals). Pending un-settled replacements are listed here so you can see the
              inventory cost impact before FEC catches up.
            </p>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
