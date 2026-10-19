// PeriodStatsBlocks — Sales period summary blocks
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { getInventoryCache, setInventoryCache } from "@/hooks/use-inventory-cache";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/sales/paginatedFetch";
import { cn } from "@/lib/utils";
import { getGrossSalesForOrder, buildSnapshotMap, type SaleOrder, type InventoryInfo as SalesInventoryInfo, type PriceSnapshot } from "@/lib/salesCalculations";
import { getPendingEstimateUsd, type ToUsdConverter } from "@/lib/sales/currencyConversion";
import { addDaysISO, getBusinessDateISO, makePeriodKey, SALES_BUSINESS_TZ } from "@/lib/sales/dateRange";
import { TrendingUp, TrendingDown, Info, RefreshCw, History, CalendarRange, X, Calendar } from "lucide-react";
import SellerboardBreakdown from "./SellerboardBreakdown";
import { computePeriodTotals, assertPeriodConsistency, EMPTY_FEE_BREAKDOWN, EMPTY_REFUND_BREAKDOWN, EMPTY_RECORD_FEES, type PeriodTotals, type FeeBreakdown, type RecordFees } from "@/lib/sales/periodTotals";
import { getListingUnitCost } from "@/lib/cost-contract";
import { fetchPromotionDeductions } from "@/lib/sales/promotionDeductions";
import ReplacementCogsLine from "./ReplacementCogsLine";
import { computeNetRefundFromFecRows, type CanonicalRefundTotals } from "@/lib/sales/refundMath";
import { REFUND_FEC_SELECT } from "@/lib/sales/fetchCanonicalRefunds";

// ── Refund GROSS-vs-NET telemetry (verified bug 2026-06-17, see
//    .lovable/architecture-audit.md §1.2 and refundGrossNetDrift.test.ts).
//    Four stat paths in this file emit `refundedReferralFee: 0` alongside a
//    principal `refundedAmount`, which forces `computePeriodTotals` to compute
//    GROSS refund cost. Until the refactor that threads the referral-fee
//    credit through, log every occurrence (once per period+source per session)
//    so we can quantify ongoing exposure in the browser console.
const __refundGrossWarned = new Set<string>();
function warnRefundGrossBranch(source: string, periodId: string, refundedAmount: number) {
  if (refundedAmount <= 0) return;
  const k = `${source}:${periodId}`;
  if (__refundGrossWarned.has(k)) return;
  __refundGrossWarned.add(k);
  console.warn(
    `[PeriodStatsBlocks] REFUND_GROSS_BRANCH source=${source} periodId=${periodId} ` +
    `refundedAmount=$${refundedAmount.toFixed(2)} refundedReferralFee=$0.00 ` +
    `→ computePeriodTotals will use GROSS refund cost (no referral-credit subtraction). ` +
    `See architecture-audit.md §1.2.`
  );
}

// ── Canonical refund-cost fetch (architecture-audit.md §1.2). All three
//    stat fetchers below MUST call this and feed the result into
//    `refundsFromCache` so that `computePeriodTotals` produces the SAME
//    NET refund cost that Live Sales / Mobile Live Sales display.
//
//    Telemetry graduation rule: when `__refundGrossWarned` records zero
//    REFUND_GROSS_BRANCH fires for 14 consecutive production days, the
//    warning function and any remaining `refundedReferralFee: 0` literals
//    in this file may be deleted. Until then, keep both.

async function fetchCanonicalRefundsForPeriod(
  userId: string,
  startDate: string,
  endDate: string,
  selectedMarketplaces: string[] | undefined,
  label: string,
): Promise<CanonicalRefundTotals> {
  const rows = await fetchAllPages<any>(() => {
    let q = supabase
      .from("financial_events_cache")
      .select(REFUND_FEC_SELECT)
      .eq("user_id", userId)
      .eq("event_type", "refund")
      .gte("event_date", startDate)
      .lte("event_date", endDate)
      .order("event_date", { ascending: true });
    if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
      const mktConds = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
      if (selectedMarketplaces.includes('US')) mktConds.push('marketplace.is.null');
      q = q.or(mktConds.join(','));
    }
    return q;
  }, { label });
  return computeNetRefundFromFecRows(rows as any[], 'full');
}


/**
 * Extract Amazon fees for profit calculation.
 *
 * If FEC has an itemized breakdown, it is authoritative for accounting-grade
 * profit: include every FEC fee category and subtract reimbursement credits.
 * Fall back to sales_orders estimates only when FEC is not available.
 */
function getOrderLevelFeesForGrossProfit(
  feeBreakdown: FeeBreakdown | undefined | null,
  recordFees: RecordFees | undefined | null,
  statTotalFees: number
): number {
  if (feeBreakdown && ((feeBreakdown.eventCount || 0) > 0 || getItemizedFeeBreakdownTotal(feeBreakdown as any) > 0)) {
    const feesOnly = Math.max(
      Number(feeBreakdown.totalFees || 0),
      getItemizedFeeBreakdownTotal(feeBreakdown as any)
    );
    const credits =
      Number(feeBreakdown.freeReplacementRefundItems || 0) +
      Number(feeBreakdown.liquidationsRevenue || 0) +
      Number(feeBreakdown.warehouseDamage || 0) +
      Number(feeBreakdown.warehouseLost || 0) +
      Number(feeBreakdown.reversalReimbursement || 0) +
      Number(feeBreakdown.otherReimbursements || 0) +
      Number(feeBreakdown.otherIncome || 0);
    const explicitNet = Number(feeBreakdown.netAmazonFees || 0);
    return explicitNet > 0 ? explicitNet : Math.max(0, feesOnly - credits);
  }

  if (recordFees) {
    const itemizedRecordFees = (recordFees.fbaFee || 0) + (recordFees.referralFee || 0) + (recordFees.closingFee || 0);
    if ((recordFees.totalFees || 0) > 0) {
      return recordFees.totalFees || 0;
    }
    if (itemizedRecordFees > 0) {
      return itemizedRecordFees;
    }
  }

  return statTotalFees;
}
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { usePeriodCache, PeriodCacheKey, PeriodCacheTotals } from "@/hooks/use-period-cache";
import { isTimeoutError, useDbPressure } from "@/hooks/use-db-pressure";
import * as periodStatsCache from "@/lib/sales/periodStatsCache";
import { toast } from "sonner";
import AwaitingVerificationDialog from "./AwaitingVerificationDialog";
import CancelledOrdersDialog from "./CancelledOrdersDialog";
import MarketplaceAttributionDebug from "./MarketplaceAttributionDebug";
import CacheAgeBadge from "./CacheAgeBadge";

// Debug row for fee mismatch tracking
interface DebugFeeRow {
  order_id: string;
  asin: string;
  units: number;
  sold_price: number;
  total_fees: number;
  fba_fee: number;
  referral_fee: number;
  closing_fee: number;
  estimated_price: number | null;
  price_source: string | null;
  diff: number;
}

// Period stat summary with detailed breakdown
export interface PeriodStat {
  id: string;
  label: string;
  sublabel: string;
  dateLabel: string;
  sales: number;
  orders: number;
  units: number;
  refunds: number;
  refundAmount: number;
  refundedReferralFee: number;
  advCost: number;
  estPayout: number;
  grossProfit: number;
  netProfit: number;
  fbaFee: number;
  referralFee: number;
  closingFee: number;
  totalFees: number;
  uncategorizedFees: number; // NEW: difference between totalFees and itemized
  // DB-only fees from actual order records (no cache estimates) — used in popup
  recordFees: { totalFees: number; fbaFee: number; referralFee: number; closingFee: number };
  // Per-ASIN fee breakdown for popup itemized list
  perAsinFees?: Array<{ asin: string; totalFee: number; source: 'db' | 'estimate' }>;
  // DEBUG: Direct sum from DB columns only (no cache, no estimates) for testing
  debugDirectDbFees: { totalFees: number; fbaFee: number; referralFee: number; closingFee: number; recordCount: number; recordsWithFees: number; estimatedFees: number; estimatedFba: number; estimatedReferral: number; recordsWithEstimates: number; recordsMissingBoth: number; missingAsins: string[] };
  totalCost: number;
  roi: number;
  margin: number;
  refundPercent: number;
  avgOrderValue: number;
  avgUnitPrice: number;
  profitPerUnit: number;
  salesChange?: number;
  profitChange?: number;
  expenses: number;
  inboundFees: number; // FBA inbound transportation fees
  inboundFeesCount: number; // Number of inbound fee records
  cancelledOrders: number; // Number of cancelled orders in this period
  pendingStatusCheck: number; // Orders awaiting cancellation status verification from Amazon
  
  // Unattributed (UNKNOWN marketplace) settled fees — shown separately when marketplace filter is active
  unattributedSettledFees?: number;
  
  // Pending enrichment indicator (orders with asin='PENDING' or title='Order Processing...')
  pendingEnrichment?: {
    orders: number;
    units: number;
  };
  
  // Net Sales breakdown (Sellerboard-style: Gross Sales - Promo Rebates - Shipping Credits - Gift Wrap)
  netSalesBreakdown?: {
    grossSales: number;           // Total product principal (what we currently show)
    promotionalRebates: number;   // Coupons, lightning deals, etc.
    shippingCredits: number;      // Shipping credits given to customers
    giftWrapCredits: number;      // Gift wrap credits
    netSales: number;             // grossSales - rebates - credits (Sellerboard-style)
  };
  
  // Detailed fee breakdown from financial_events_cache (Sellerboard-style)
  // ALL fees and credits EXCLUSIVELY from financial_events_cache
  feeBreakdown: {
    // Fees (stored as positive values for display, shown as negative)
    fbaFulfillmentFee: number;
    referralFee: number;
    inboundTransportation: number;
    variableClosingFee: number;
    fixedClosingFee: number;
    storageFees: number;
    removalFees: number;
    disposalFees: number;
    longTermStorageFees: number;
    digitalServicesFee: number;
    liquidationsBrokerageFee: number;
    compensatedClawback: number;
    hrrNonApparelRollup: number;
    reCommerceGradingCharge: number;
    fbaCustomerReturnFee: number; // FBA Customer Return Per Unit Fee
    otherFees: number;
    // Breakdown of otherFees
    amazonOtherFees: number; // From Amazon's other_fees column
    inboundDelta: number; // Difference between financial events inbound and fba_inbound_fees table
    // Credits/Income (positive - reduce net fees)
    freeReplacementRefundItems: number;
    liquidationsRevenue: number;
    warehouseDamage: number;
    warehouseLost: number;
    reversalReimbursement: number;
    otherReimbursements: number;
    otherIncome: number;
    // Totals
    totalFees: number; // Sum of all fees (positive value)
    totalCredits: number; // Sum of all credits (positive value)
    netAmazonFees: number; // totalFees - totalCredits
    // Source data counts for reconciliation
    eventCount: number;
    dateRangeUsed: string;
  };
  
  // Refunds from financial_events_cache ONLY
  refundsFromCache: {
    refundedAmount: number; // Principal refunded to buyer (positive cost)
    refundedReferralFee: number; // Referral fee credits Amazon returned (positive credit)
    refundedOtherFees: number; // Other fee credits from refunds
    refundEventCount: number;
    /** Optional admin retention (min($5, 20%·|referral|)). See audit §1.2. */
    refundAdminRetention?: number;
  };
  
  // Debug fields for reconciliation
  debug: {
    rowsUsedForPopupFeesCount: number;
    sumTotalFees: number;
    sumItemizedFees: number;
    difference: number;
    countTotalFeesNullOrZero: number;
    mismatchRows: DebugFeeRow[];
    // Reconciliation
    financialEventsCount: number;
    dateRangeWithCutoff: string;
  };

  // Optional COGS reconciliation details (used for Yesterday parity diagnostics)
  cogsReconciliation?: {
    missingRows: number;
    missingEstimatedCost: number;
    sample: Array<{
      order_id: string;
      asin: string;
      sku: string;
      qty: number;
      unit_cost: number;
      estimated_unit_cost: number;
    }>;
  };
  /** OPTION 2: which retrieval stage produced this stat.
   *  - 'fast'       = SO/RPC totals only (instant render, Smart enrich pending).
   *  - 'fast-stale' = Smart enrich exceeded 5s — keep fast result, flag it visibly.
   *  - 'smart'      = Smart Fallback complete (matches Repricer-in-Action graph). */
  dataStage?: 'fast' | 'fast-stale' | 'smart';
  /** Debug: source that produced the itemized feeBreakdown shown in SellerboardBreakdown. */
  feeBreakdownSource?: string;
  /** Debug: fee dollars that could not be mapped to a named fee category. */
  unknownResidualFee?: number;
}

// Totals computed from the table rows in Sales.tsx (single source of truth)
interface TableTotals {
  salesTotal: number;
  amazonFeesTotal: number;
  fbaTotal: number;
  referralTotal: number;
  closingTotal: number;
  cogsTotal: number;
  refundAmount: number;
  refundedFee: number;
  units: number;
  orders: number;
  refundCount: number;
}

export interface PeriodBlockDebugState {
  selectedPeriodLabel: string;
  selectedTZ: string;
  selectedRangeStart: string;
  selectedRangeEnd: string;
  periodKey: string;
  rpcPeriodKey: string;
  rpcGrossSales: number;
  rpcUnits: number;
  tablePeriodKey: string;
  tableGrossSales: number;
  tableUnits: number;
  appliedCorrectionToKey: string;
  cacheHit: boolean;
  cacheKeyUsed: string;
}

// Live refund record (from API, matches Sales.tsx LiveRefund interface)
interface LiveRefundForBlock {
  orderId: string;
  postedDate: string;
  amount: number;
  asin: string;
  referralFee: number;
  isDeferred?: boolean;
}

interface PeriodStatsBlocksProps {
  userId: string;
  selectedPeriod: string;
  /**
   * Sales data-source mode (mirrors Live Sales / P&L wording):
   *  - "smart"      → SO-primary by order_date, FEC fill-in for missing/incomplete days
   *  - "estimated"  → sales_orders by order_date (matches Live Sales "Estimated")
   *  - "reconciled" → financial_events_cache by event_date (matches P&L exactly)
   * Default = "smart".
   */
  salesMode?: 'smart' | 'estimated' | 'reconciled';
  onPeriodSelect: (period: string) => void;
  selectedMarketplaces?: string[];
  asinSearch?: string;
  refreshKey?: number;
  className?: string;
  showEstimatedPrices?: boolean;
  buyBoxPricesMap?: Map<string, { price: number; totalFees: number }>;
  hideDeferred?: boolean;
  tableTotals?: TableTotals; // Table-only totals for diagnostics/export; never rewrites summary stats
  tablePeriodTotals?: PeriodTotals | null; // Table-only PeriodTotals computed in Sales.tsx for diagnostics/export
  tableReady?: boolean; // True when Sales table data has finished loading for selectedPeriod
  // True when the records table holds only a paginated subset of the period.
  recordsArePartial?: boolean;
  onForceRefresh?: () => void; // Callback when cache is force refreshed

  // Preloaded authoritative COGS per period (computed in background by Sales.tsx)
  // Key = period id (e.g., month_to_date), Value = corrected COGS total for that period.
  preloadedCogsByPeriod?: Record<string, number>;

  // Custom period date range - passed from the "More Date Options" dropdown
  customStartDate?: string;
  customEndDate?: string;
  // Callbacks to update custom dates from within PeriodStatsBlocks
  onCustomStartDateChange?: (date: string) => void;
  onCustomEndDateChange?: (date: string) => void;
  // Date range that tableTotals corresponds to (for matching across periods)
  tableTotalsDateRange?: { startDate: string; endDate: string };
  // Home currency symbol for the seller (e.g. "$", "£", "€")
  // Defaults to "$" for backward compatibility with USD sellers
  currencySymbol?: string;
  // Whether a background sales sync is currently in progress
  isSyncing?: boolean;
  // Live refunds from API — used to overlay accurate refund counts on ALL period blocks
  liveRefunds?: LiveRefundForBlock[];
  // Whether refund data is delayed (no source available for recent periods)
  refundsDelayed?: boolean;
  // Callback to emit breakdown data for the selected period (for standalone panel)
  onBreakdownData?: (data: {
    stat: any;
    salesTotal: number;
    unitsTotal: number;
    ordersTotal: number;
    cogsTotal: number;
    amazonFeesNetTotal: number;
    refundCostTotal: number;
    grossProfit: number;
    netProfit: number;
  } | null) => void;
  onDebugStateChange?: (debug: PeriodBlockDebugState) => void;
  // Fires when the currently selected period's summary is ready (has a stat AND not loading).
  // Used by the parent page to gate "Load Details" button visibility until the block has data.
  onSelectedReadyChange?: (ready: boolean) => void;
}

// Fee estimation - NO FALLBACK DEFAULTS
// Fees are null when asin_fee_cache is missing - accuracy > completeness

/**
 * Calculate settlement-only operational fees NOT captured at the order level.
 * These include storage, removal, disposal, and other Amazon-level fees/credits
 * from financial_events_cache. When using table authority (order-level fees),
 * these must be added on top so net profit is accurate.
 */
function getSettlementOperationalFees(fb: PeriodStat['feeBreakdown']): number {
  if (!fb || fb.eventCount === 0) return 0;

  const additionalFees =
    fb.storageFees + fb.removalFees + fb.otherFees +
    fb.disposalFees + fb.longTermStorageFees +
    fb.compensatedClawback + fb.hrrNonApparelRollup +
    fb.digitalServicesFee + fb.reCommerceGradingCharge +
    fb.liquidationsBrokerageFee + fb.fbaCustomerReturnFee;

  const credits =
    fb.otherReimbursements + fb.warehouseLost + fb.warehouseDamage +
    fb.reversalReimbursement + fb.liquidationsRevenue +
    fb.freeReplacementRefundItems + fb.otherIncome;

  return additionalFees - credits;
}

function getItemizedFeeBreakdownTotal(fb: PeriodStat['feeBreakdown'] | undefined | null): number {
  if (!fb) return 0;
  return Number(fb.fbaFulfillmentFee || 0) + Number(fb.referralFee || 0) +
    Number(fb.variableClosingFee || 0) + Number(fb.fixedClosingFee || 0) +
    Number(fb.storageFees || 0) + Number(fb.removalFees || 0) +
    Number(fb.disposalFees || 0) + Number(fb.longTermStorageFees || 0) +
    Number(fb.fbaCustomerReturnFee || 0) + Number(fb.digitalServicesFee || 0) +
    Number(fb.inboundTransportation || 0) + Number(fb.liquidationsBrokerageFee || 0) +
    Number(fb.compensatedClawback || 0) + Number(fb.hrrNonApparelRollup || 0) +
    Number(fb.reCommerceGradingCharge || 0) + Number(fb.otherFees || 0) +
    Number(fb.amazonOtherFees || 0) + Number(fb.inboundDelta || 0);
}

function hasCollapsedFeeBreakdown(stat: Partial<PeriodStat> | undefined | null): boolean {
  if (!stat) return false;
  const totalFees = Number(stat.totalFees || stat.feeBreakdown?.totalFees || 0);
  if (totalFees <= 0.01) return false;
  const recordItemized = Number(stat.recordFees?.fbaFee || 0) + Number(stat.recordFees?.referralFee || 0) + Number(stat.recordFees?.closingFee || 0);
  return getItemizedFeeBreakdownTotal(stat.feeBreakdown as any) <= 0.01 && recordItemized <= 0.01;
}

/**
 * Calculate estimated fees for a pending order using cached fee data ONLY
 * Returns null if no cache entry exists - NO fallback guessing
 */
const calculateEstimatedFees = (
  price: number,
  quantity: number,
  feeCache?: { fbaFeeFixed: number; referralRate: number; isMedia: boolean } | null
): { referralFee: number; fbaFee: number; closingFee: number; totalFees: number } | null => {
  // STRICT: No cache = no fees (null, not estimated)
  if (!feeCache) {
    return null;
  }
  
  const { referralRate, fbaFeeFixed } = feeCache;
  
  const referralFee = (price * referralRate) * quantity;
  const fbaFee = fbaFeeFixed * quantity;
  const closingFee = 0; // Closing fee is $0 until order settles
  
  return {
    referralFee,
    fbaFee,
    closingFee,
    totalFees: referralFee + fbaFee + closingFee,
  };
};

// Amazon stores order_date in Pacific Time — match that for day boundaries
const AMAZON_BUSINESS_TZ = SALES_BUSINESS_TZ;

function getTodayLocalDate(): string {
  return getBusinessDateISO(new Date(), AMAZON_BUSINESS_TZ);
}

function getMonthBoundsISO(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const y = d.getFullYear();
  const m = d.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    start: `${y}-${String(m + 1).padStart(2, "0")}-01`,
    end: `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
  };
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  const sMonth = s.toLocaleDateString('en-US', { month: 'long' });
  const eMonth = e.toLocaleDateString('en-US', { month: 'long' });
  if (sMonth === eMonth) {
    return `${sMonth} ${s.getDate()}-${e.getDate()}`;
  }
  return `${sMonth} ${s.getDate()} - ${eMonth} ${e.getDate()}`;
}

function formatFullDateRange(start: string, end: string): string {
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  if (start === end) return fmt(s);
  return `${fmt(s)} – ${fmt(e)}`;
}

function formatMoney(value: number, symbol: string = '$'): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${symbol}${Math.abs(safe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatChange(value: number | undefined): React.ReactNode {
  if (value === undefined) return null;
  const isPositive = value >= 0;
  return (
    <span className={cn(
      "text-xs font-medium flex items-center gap-0.5",
      isPositive ? "text-green-500" : "text-red-500"
    )}>
      {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {isPositive ? "+" : ""}{value.toFixed(1)}%
    </span>
  );
}

// Period definitions (custom is handled separately)

// ── Graph-equivalent strict row processing (mirrors LiveSales.tsx exactly) ──
type StrictSalesOrderRow = {
  order_id?: string | null;
  asin?: string | null;
  title?: string | null;
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  marketplace?: string | null;
  is_cancelled?: boolean | null;
  order_status?: string | null;
  order_type?: string | null;
};

const normalizeStrictOrderId = (orderId: string | null | undefined) =>
  String(orderId || '').trim();

const isPendingPlaceholderStrict = (row: { asin?: string | null; title?: string | null }) => {
  const asin = String(row.asin || '').trim().toUpperCase();
  const title = String(row.title || '').trim().toLowerCase();
  return asin === 'PENDING' || title.startsWith('order processing');
};

const isRealAsinStrict = (val: string | null | undefined): boolean =>
  /^B0[A-Z0-9]{8}$/i.test(String(val || '').trim());

  // NOTE: this component is currently NOT imported by any page -- only
  // `import type { PeriodStat }` is, which is erased at build time. These
  // helpers therefore display nothing today. They are routed through the
  // shared converter anyway so that reviving the component cannot revive the
  // bug: each of the three used `estimated_price * qty` with no conversion,
  // which would put pesos into a USD total the moment it rendered.
const getStrictLineRevenue = (row: StrictSalesOrderRow, toUsd?: ToUsdConverter) =>
  settledOnlyOrConverted(row, toUsd);

/**
 * Shared fallback for this file's revenue helpers.
 *
 * With a converter, the one shared helper does the work. WITHOUT one it
 * returns the SETTLED figure only and never estimated_price, because
 * estimated_price is native for non-US and this file has no FX source of its
 * own -- no fxRates, no toUsd anywhere in it.
 *
 * I originally wrote these three call sites as getPendingEstimateUsd(row,
 * toUsd) with no `toUsd` in scope. That is a ReferenceError, and it shipped
 * because `npm run build` does not typecheck and this component is not
 * imported by any page, so the line never executes. Reviving the component
 * would have crashed it -- the exact failure the routing was meant to prevent.
 * A caller that wants non-US revenue here must pass a converter.
 */
function settledOnlyOrConverted(
  row: { quantity?: number | null; sold_price?: number | null; total_sale_amount?: number | null },
  toUsd?: ToUsdConverter,
): number {
  if (toUsd) return getPendingEstimateUsd(row as never, toUsd);
  const qty = Math.max(1, Number(row.quantity || 0));
  const totalSale = Number(row.total_sale_amount || 0);
  if (totalSale > 0) return totalSale;
  const soldPrice = Number(row.sold_price || 0);
  if (soldPrice > 0) return soldPrice * qty;
  return 0;
}

const dedupeStrictRows = <T extends { order_id?: string | null; asin?: string | null; quantity?: number | null; sold_price?: number | null }>(rows: T[]): T[] => {
  // Phase 1: exact (order_id + asin) dedup
  const seen = new Set<string>();
  const phase1: T[] = [];
  for (const row of rows) {
    const key = `${normalizeStrictOrderId(row.order_id)}::${String(row.asin || '').trim()}`;
    if (!seen.has(key)) { seen.add(key); phase1.push(row); }
  }
  // Phase 2: ASIN/SKU pair detection within same order
  const byOrder = new Map<string, T[]>();
  for (const row of phase1) {
    const oid = normalizeStrictOrderId(row.order_id);
    if (!oid) continue;
    if (!byOrder.has(oid)) byOrder.set(oid, []);
    byOrder.get(oid)!.push(row);
  }
  const dropSet = new Set<T>();
  for (const [, group] of byOrder) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (Number(a.quantity || 1) !== Number(b.quantity || 1)) continue;
        if (Math.abs(Number(a.sold_price || 0) - Number(b.sold_price || 0)) > 1.0) continue;
        const aReal = isRealAsinStrict(a.asin), bReal = isRealAsinStrict(b.asin);
        if (aReal && !bReal) dropSet.add(b);
        else if (bReal && !aReal) dropSet.add(a);
      }
    }
  }
  return phase1.filter((r) => !dropSet.has(r));
};

/** Apply graph-identical cancel/replacement/pending/dedup filters to raw SO rows */
const buildGraphEquivalentRows = (rawRows: StrictSalesOrderRow[]): StrictSalesOrderRow[] => {
  // Step 1: filter out cancelled, replacement, empty rows
  const filtered = rawRows.filter((row) => {
    if (row.is_cancelled === true) return false;
    const status = String(row.order_status || '').toLowerCase();
    if (status === 'canceled' || status === 'cancelled') return false;
    if (!status && !String(row.order_id || '').trim()) return false;
    const orderType = String(row.order_type || '').toLowerCase();
    if (orderType.includes('replacement')) return false;
    return true;
  });
  // Step 2: drop pending placeholders that already have a resolved order
  const resolvedOrderIds = new Set(
    filtered
      .filter((r) => !isPendingPlaceholderStrict(r))
      .map((r) => normalizeStrictOrderId(r.order_id))
      .filter(Boolean)
  );
  const withoutStalePending = filtered.filter((row) => {
    if (!isPendingPlaceholderStrict(row)) return true;
    const oid = normalizeStrictOrderId(row.order_id);
    return !!oid && !resolvedOrderIds.has(oid);
  });
  // Step 3: dedup (exact + ASIN/SKU pair)
  return dedupeStrictRows(withoutStalePending);
};

const PERIODS = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'month_to_date', label: 'Month to date' },
  { id: 'this_month', label: 'This month (forecast)' },
  { id: 'last_month', label: 'Last month' },
];

const CUSTOM_PERIOD_DEF = { id: 'custom', label: 'Custom Range' } as const;

const getPeriodDef = (periodId: string) =>
  periodId === 'custom' ? CUSTOM_PERIOD_DEF : PERIODS.find((p) => p.id === periodId);

const makeBlankPeriodStat = (
  periodId: string,
  periodDef: { id: string; label: string },
  range: { start: string; end: string; label: string; dateLabel: string }
): PeriodStat => ({
  id: periodId,
  label: periodDef.label,
  sublabel: range.label,
  dateLabel: range.dateLabel,
  sales: 0,
  orders: 0,
  units: 0,
  refunds: 0,
  refundAmount: 0,
  refundedReferralFee: 0,
  advCost: 0,
  estPayout: 0,
  grossProfit: 0,
  netProfit: 0,
  fbaFee: 0,
  referralFee: 0,
  closingFee: 0,
  totalFees: 0,
  uncategorizedFees: 0,
  recordFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0 },
  perAsinFees: [],
  debugDirectDbFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0, recordCount: 0, recordsWithFees: 0, estimatedFees: 0, estimatedFba: 0, estimatedReferral: 0, recordsWithEstimates: 0, recordsMissingBoth: 0, missingAsins: [] },
  totalCost: 0,
  roi: 0,
  margin: 0,
  refundPercent: 0,
  avgOrderValue: 0,
  avgUnitPrice: 0,
  profitPerUnit: 0,
  salesChange: undefined,
  profitChange: undefined,
  expenses: 0,
  inboundFees: 0,
  inboundFeesCount: 0,
  cancelledOrders: 0,
  pendingStatusCheck: 0,
  feeBreakdown: {
    ...EMPTY_FEE_BREAKDOWN,
    dateRangeUsed: `${range.start} to ${range.end}`,
  },
  refundsFromCache: { ...EMPTY_REFUND_BREAKDOWN },
  debug: {
    rowsUsedForPopupFeesCount: 0,
    sumTotalFees: 0,
    sumItemizedFees: 0,
    difference: 0,
    countTotalFeesNullOrZero: 0,
    mismatchRows: [],
    financialEventsCount: 0,
    dateRangeWithCutoff: `[${range.start}, ${range.end}] (blank scaffold)`,
  },
});

const makeInstantEstimatedStatFromTableTotals = (
  periodId: string,
  periodDef: { id: string; label: string },
  range: { start: string; end: string; label: string; dateLabel: string },
  totals: PeriodTotals
): PeriodStat => ({
  ...makeBlankPeriodStat(periodId, periodDef, range),
  sales: totals.salesPrincipal,
  orders: totals.orders,
  units: totals.units,
  refunds: totals.refundCount,
  refundAmount: totals.refundBreakdown.refundedAmount,
  refundedReferralFee: totals.refundBreakdown.refundedReferralFee,
  estPayout: totals.estPayout,
  grossProfit: totals.grossProfit,
  netProfit: totals.netProfit,
  totalFees: totals.amazonFeesNet,
  fbaFee: totals.recordFees.fbaFee,
  referralFee: totals.recordFees.referralFee,
  closingFee: totals.recordFees.closingFee,
  recordFees: totals.recordFees,
  totalCost: totals.cogsTotal,
  roi: totals.roi,
  margin: totals.margin,
  refundPercent: totals.refundPercent,
  avgOrderValue: totals.avgOrderValue,
  avgUnitPrice: totals.avgUnitPrice,
  profitPerUnit: totals.profitPerUnit,
  expenses: totals.expenses,
  inboundFees: totals.inboundFees,
  feeBreakdown: totals.feeBreakdown,
  refundsFromCache: totals.refundBreakdown,
  netSalesBreakdown: totals.netSalesBreakdown,
  cancelledOrders: totals.cancelledOrders,
  pendingStatusCheck: totals.pendingStatusCheck,
  pendingEnrichment: totals.pendingEnrichment,
  dataStage: 'fast',
  feeBreakdownSource: 'SO estimated',
});

// Priority order for loading: selected first, then visible ones
const PRIORITY_PERIODS = ['today', 'yesterday', 'month_to_date', 'this_month', 'last_month', 'custom'];
const PERIOD_STATS_QUERY_KEY = 'period_stats_blocks';

export default function PeriodStatsBlocks({ 
  userId, 
  selectedPeriod, 
  salesMode = 'smart',
  onPeriodSelect,
  selectedMarketplaces,
  asinSearch,
  refreshKey = 0,
  className,
  showEstimatedPrices = false,
  buyBoxPricesMap = new Map(),
  hideDeferred = false,
  tablePeriodTotals,
  tableReady = false,
  onForceRefresh,
  preloadedCogsByPeriod,
  customStartDate = '',
  customEndDate = '',
  onCustomStartDateChange,
  onCustomEndDateChange,
  tableTotalsDateRange,
  currencySymbol: cs = '$',
  isSyncing = false,
  liveRefunds = [],
  refundsDelayed = false,
  onBreakdownData,
  onDebugStateChange,
  onSelectedReadyChange,
}: PeriodStatsBlocksProps) {
  // Local currency-aware money formatter using seller's home currency symbol
  const fmtMoney = (value: number) => formatMoney(value, cs);
  const { pressureActive, isQueryCircuitOpen, recordFailure, recordSuccess } = useDbPressure();
  const [stats, setStats] = useState<Map<string, PeriodStat>>(new Map());
  const [loadingPeriods, setLoadingPeriods] = useState<Set<string>>(new Set());
  const [periodErrors, setPeriodErrors] = useState<Map<string, string>>(new Map());
  const [expandedPeriod, setExpandedPeriod] = useState<string | null>(null);
  // Always show live orders only (no settled financial events toggle)
  const includeSettled = false;
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const [settledSyncingPeriod, setSettledSyncingPeriod] = useState<string | null>(null);
  const appliedCorrectionToKey = '';
  
  // STALE-WHILE-REVALIDATE: Keep previous stats visible during refresh
  // Only show skeleton on truly initial load (no previous data)
  const previousStatsRef = useRef<Map<string, PeriodStat>>(new Map());
  const [isRefreshing, setIsRefreshing] = useState(false);

  // ── Smart cache (period + mode + dateRange + marketplaces) ────────────
  // Hydrate from localStorage once per session.
  useEffect(() => { periodStatsCache.hydrateFromStorage(); }, []);
  // Re-render trigger so "Cached Xs ago" badge ticks.
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    const unsub = periodStatsCache.subscribeCache(() => setCacheTick(t => t + 1));
    const interval = setInterval(() => setCacheTick(t => t + 1), 15_000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  // Notify parent when the selected period's summary block is ready
  // (has a stat from cache or fetch AND is not currently in a blocking load).
  // Stale-while-revalidate: cached data counts as ready even while background refresh runs.
  useEffect(() => {
    if (!onSelectedReadyChange) return;
    const key = cacheKeyFor.current(selectedPeriod);
    const cached = key ? periodStatsCache.getAny(key) : null;
    const hasStat = stats.has(selectedPeriod) || !!cached;
    const hasInstantEstimatedTableTotals = salesMode === 'estimated' && selectedPeriod === 'today' && tableReady && !!tablePeriodTotals;
    const isLoadingNow = loadingPeriods.has(selectedPeriod);
    const ready = hasInstantEstimatedTableTotals || (hasStat && !isLoadingNow);
    onSelectedReadyChange(ready);
  }, [selectedPeriod, stats, loadingPeriods, cacheTick, onSelectedReadyChange, salesMode, tableReady, tablePeriodTotals]);

  const cacheKeyFor = useRef<(periodId: string) => string | null>(() => null);
  
  const traceSummaryWrite = useCallback((source: string, periodId: string, stat?: Partial<PeriodStat> | null) => {
    return;
  }, []);
  
  // FETCH GENERATION: prevents stale async responses from overwriting newer data.
  // Incremented on every new fetch cycle; responses are discarded if generation changed.
  const fetchGenerationRef = useRef(0);
  
  // Ref mirror of loadingPeriods to avoid stale closures in callbacks
  const loadingPeriodsRef = useRef<Set<string>>(new Set());
  
  // Stub maps kept for compatibility with any remaining references
  const correctedCogsMap = useMemo(() => new Map<string, number>(), []);
  const correctedSalesMap = useMemo(() => new Map<string, number>(), []);
  const correctedOrdersMap = useMemo(() => new Map<string, number>(), []);
  const correctedUnitsMap = useMemo(() => new Map<string, number>(), []);

  // Reset stats when marketplace filter changes
  const prevMarketplacesRef = useRef<string[] | undefined>(selectedMarketplaces);
  useEffect(() => {
    const prev = prevMarketplacesRef.current;
    const curr = selectedMarketplaces;
    const prevSorted = prev ? [...prev].sort().join(',') : '';
    const currSorted = curr ? [...curr].sort().join(',') : '';
    if (prevSorted !== currSorted) {
      setStats(new Map());
      setPeriodErrors(new Map());
      setExpandedPeriod(null);
      console.log('🔄 Marketplace filter changed - resetting stats');
    }
    prevMarketplacesRef.current = curr;
  }, [selectedMarketplaces]);

  // Emit breakdown data for the selected period (for standalone panel in Sales.tsx)
  // Keep TODAY aligned with the same table-authoritative correction/pin used by the card.
  useEffect(() => {
    if (!onBreakdownData) return;
    const rawStat = stats.get(selectedPeriod);
    if (!rawStat) {
      onBreakdownData(null);
      return;
    }

    const stat = rawStat;

    const statSales = Number(stat.sales || 0);
    const statUnits = Number(stat.units || 0);
    const statOrders = Number(stat.orders || 0);
    const statCogs = Number(stat.totalCost || 0);

    // Use order-level fees only for gross profit (FBA + Referral + Closing)
    const feesVal = getOrderLevelFeesForGrossProfit(
      stat.feeBreakdown,
      stat.recordFees,
      Number(stat.totalFees || 0)
    );

    const emittedTotals = computePeriodTotals({
      periodId: selectedPeriod,
      periodStart: '',
      periodEnd: '',
      salesPrincipal: statSales,
      shippingCredits: stat.netSalesBreakdown?.shippingCredits || 0,
      giftWrapCredits: stat.netSalesBreakdown?.giftWrapCredits || 0,
      promoRebates: stat.netSalesBreakdown?.promotionalRebates || 0,
      units: statUnits,
      orders: statOrders,
      refundCount: stat.refunds,
      amazonFeesNet: feesVal,
      feeBreakdown: stat.feeBreakdown,
      recordFees: stat.recordFees,
      refundBreakdown: stat.refundsFromCache || {
        refundedAmount: Number(stat.refundAmount || 0),
        refundedReferralFee: Number(stat.refundedReferralFee || 0),
        refundedOtherFees: 0,
        refundEventCount: stat.refunds,
      },
      cogsTotal: statCogs,
      expenses: Number(stat.expenses || 0),
      inboundFees: Number(stat.inboundFees || 0),
    });

    onBreakdownData({
      stat,
      salesTotal: emittedTotals.salesPrincipal,
      unitsTotal: emittedTotals.units,
      ordersTotal: emittedTotals.orders,
      cogsTotal: emittedTotals.cogsTotal,
      amazonFeesNetTotal: emittedTotals.amazonFeesNet,
      refundCostTotal: emittedTotals.refundCostTotal,
      grossProfit: emittedTotals.grossProfit,
      netProfit: emittedTotals.netProfit,
    });
  }, [
    selectedPeriod,
    stats,
    onBreakdownData,
  ]);

  // Full History Sync state
  const [historySyncExpanded, setHistorySyncExpanded] = useState(false);
  const [historySyncSelectedMonth, setHistorySyncSelectedMonth] = useState<number>(new Date().getMonth() === 0 ? 11 : new Date().getMonth() - 1); // default to last month (0-11)
  const [historySyncSelectedYear, setHistorySyncSelectedYear] = useState<number>(new Date().getFullYear());
  const [historySyncProgress, setHistorySyncProgress] = useState<{
    running: boolean;
    progressId: string | null;
    currentMonth: number;
    totalMonths: number;
    message: string;
    status: 'idle' | 'running' | 'done' | 'partial' | 'error';
  }>({
    running: false,
    progressId: null,
    currentMonth: 0,
    totalMonths: 12,
    message: '',
    status: 'idle',
  });
  const historySyncAbortRef = useRef(false);

  useEffect(() => {
    if (!historySyncProgress.running || historySyncProgress.progressId) return;

    const startTimeout = window.setTimeout(() => {
      setHistorySyncProgress(prev => {
        if (!prev.running || prev.progressId) return prev;
        return {
          ...prev,
          running: false,
          status: 'error',
          message: 'History sync did not start. Please try again.',
        };
      });
    }, 45000);

    return () => window.clearTimeout(startTimeout);
  }, [historySyncProgress.running, historySyncProgress.progressId]);
  
  // Sellerboard Mode removed - always use live data
  
  // Custom period visibility toggle - hidden by default to avoid loading delays
  const [showCustomBlock, setShowCustomBlock] = useState(false);
  
  // Pending custom dates (local state before Save is clicked)
  const [pendingCustomStart, setPendingCustomStart] = useState('');
  const [pendingCustomEnd, setPendingCustomEnd] = useState('');
  
  // Awaiting verification dialog state
  const [awaitingVerificationDialog, setAwaitingVerificationDialog] = useState<{
    open: boolean;
    periodId: string;
    dateRange: { start: string; end: string };
    periodLabel: string;
  } | null>(null);
  
  // Cancelled orders dialog state
  const [cancelledOrdersDialog, setCancelledOrdersDialog] = useState<{
    open: boolean;
    periodId: string;
    dateRange: { start: string; end: string };
    periodLabel: string;
  } | null>(null);
  // Sellerboard comparison removed - always use live data
  
  // Period cache hook
  const { 
    readCache, 
    writeCache, 
    invalidateCache,
    isCacheStale, 
    forceRefreshAll: clearAllCache,
    getCachedTotals,
    getCacheKeyString,
  } = usePeriodCache(userId);

  // Track if we've loaded from cache - reset when filters change
  const cacheLoadedRef = useRef(false);
  const lastFilterKeyRef = useRef<string>('');
  
  // Get seller ID (default to 'all' for now)
  const sellerId = 'all';
  
  // Get marketplace ID from selected marketplaces
  const marketplaceId = useMemo(() => {
    if (!selectedMarketplaces || selectedMarketplaces.length === 0 || selectedMarketplaces.length >= 4) {
      return 'all';
    }
    return selectedMarketplaces.sort().join(',');
  }, [selectedMarketplaces]);

  // Calculate date ranges for each period
  const dateRanges = useMemo(() => {
    const today = getTodayLocalDate();
    const yesterday = addDaysISO(today, -1);
    const currentMonthBounds = getMonthBoundsISO(today);
    const lastMonthStart = new Date(today + "T12:00:00");
    lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
    lastMonthStart.setDate(1);
    const lastMonthBounds = getMonthBoundsISO(
      `${lastMonthStart.getFullYear()}-${String(lastMonthStart.getMonth() + 1).padStart(2, "0")}-01`
    );
    
    const todayDate = new Date(today + "T12:00:00");
    const daysInMonth = parseInt(currentMonthBounds.end.split('-')[2]);
    const daysElapsed = todayDate.getDate();
    const forecastMultiplier = daysInMonth / Math.max(daysElapsed, 1);
    
    // Custom period dates - use provided dates or default to today
    const customStart = customStartDate || today;
    const customEnd = customEndDate || today;
    const hasCustomDates = customStartDate && customEndDate;
    
    return {
      all: { 
        start: currentMonthBounds.start, 
        end: today, 
        label: formatDateRange(currentMonthBounds.start, today),
        dateLabel: `All: ${formatFullDateRange(currentMonthBounds.start, today)}`
      },
      today: { start: today, end: today, label: formatDate(today), dateLabel: formatDate(today) },
      yesterday: { start: yesterday, end: yesterday, label: formatDate(yesterday), dateLabel: formatDate(yesterday) },
      month_to_date: { 
        start: currentMonthBounds.start, 
        end: today, 
        label: formatDateRange(currentMonthBounds.start, today),
        dateLabel: formatFullDateRange(currentMonthBounds.start, today)
      },
      this_month: { 
        start: currentMonthBounds.start, 
        end: currentMonthBounds.end,
        label: formatDateRange(currentMonthBounds.start, currentMonthBounds.end),
        dateLabel: formatFullDateRange(currentMonthBounds.start, currentMonthBounds.end),
        isForecast: true,
        forecastMultiplier,
        daysElapsed,
        daysInMonth
      },
      last_month: { 
        start: lastMonthBounds.start, 
        end: lastMonthBounds.end, 
        label: formatDateRange(lastMonthBounds.start, lastMonthBounds.end),
        dateLabel: formatFullDateRange(lastMonthBounds.start, lastMonthBounds.end)
      },
      custom: {
        start: customStart,
        end: customEnd,
        label: hasCustomDates ? formatDateRange(customStart, customEnd) : 'Select dates',
        dateLabel: hasCustomDates ? formatFullDateRange(customStart, customEnd) : 'Select a date range',
        isCustom: true,
      },
    };
  }, [customStartDate, customEndDate]);

  // Real cacheKeyFor — must be defined AFTER dateRanges.
  cacheKeyFor.current = (periodId: string): string | null => {
    if (!userId) return null;
    const r = (dateRanges as any)[periodId];
    if (!r) return null;
    return periodStatsCache.makeCacheKey({
      userId,
      periodId,
      mode: salesMode as periodStatsCache.CacheMode,
      start: r.start,
      end: r.end,
      marketplaces: selectedMarketplaces,
    });
  };

  // Centralized cache writer — call this from every setStats success site so
  // the summary cache stays in lock-step with on-screen `stats`.
  // Only persists when totals actually changed (avoids redundant writes).
  const writeStatToCache = useCallback((periodId: string, nextStat: PeriodStat | undefined | null) => {
    if (!nextStat) return;
    const key = cacheKeyFor.current(periodId);
    if (!key) return;
    const existing = periodStatsCache.getAny(key)?.stat;
    if (!existing || periodStatsCache.totalsDiffer(existing, nextStat)) {
      periodStatsCache.set(key, nextStat);
    }
  }, [userId, salesMode, selectedMarketplaces, dateRanges]);

  // Smart cache: on mode/period switch, instantly hydrate `stats` from cache
  // (so the user sees numbers immediately) and let the loadFresh effect decide
  // whether to revalidate in the background based on TTL.
  // refreshKey (Force Refresh) still bypasses cache and forces a refetch.
  const prevRefreshKeyRef = useRef(refreshKey);
  const prevSalesModeRef = useRef(salesMode);
  const prevSelectedPeriodRef = useRef(selectedPeriod);
  const [pendingForceRefresh, setPendingForceRefresh] = useState(false);
  useEffect(() => {
    const modeChanged = prevSalesModeRef.current !== salesMode;
    const keyChanged = prevRefreshKeyRef.current !== refreshKey;
    const periodChanged = prevSelectedPeriodRef.current !== selectedPeriod;
    if (keyChanged || modeChanged || periodChanged) {
      prevRefreshKeyRef.current = refreshKey;
      prevSalesModeRef.current = salesMode;
      prevSelectedPeriodRef.current = selectedPeriod;
      setPeriodErrors(new Map());
      if (modeChanged || periodChanged) {
        // Instant cache hydration for the newly-selected period+mode.
        const bypassLiveEstimatedCache = salesMode === 'estimated' && (selectedPeriod === 'today' || selectedPeriod === 'yesterday');
        const key = cacheKeyFor.current(selectedPeriod);
        const cached = key && !bypassLiveEstimatedCache ? periodStatsCache.getAny(key) : null;
        if (cached) {
          setStats(prev => {
            const next = new Map(prev);
            next.set(selectedPeriod, { ...cached.stat, id: selectedPeriod });
            return next;
          });
          previousStatsRef.current = new Map([[selectedPeriod, { ...cached.stat, id: selectedPeriod }]]);
          console.log(`[periodStatsCache] instant hydrate ${selectedPeriod}:${salesMode} (age ${Math.round((Date.now() - cached.fetchedAt)/1000)}s)`);
        } else {
          setStats(new Map());
          previousStatsRef.current = new Map();
        }
        setExpandedPeriod(null);
      }
      // Only the explicit Force Refresh button should invalidate/refetch through
      // handleForceRefresh. Period/mode switches are handled by the SWR load
      // effect below so stale cached stats stay visible instead of skeletoning.
      if (keyChanged) setPendingForceRefresh(true);
    }
  }, [refreshKey, salesMode, selectedPeriod]);


  // Table rows are paginated/async and must never write back into summary stats.
  // Summary blocks stay sourced from the period RPC; records/table totals remain table-only state.
  useEffect(() => {
    return;
  }, []);


  useEffect(() => {
    if (!onDebugStateChange) return;

    const selectedRange = dateRanges[selectedPeriod as keyof typeof dateRanges];
    const marketplacesKey = [...(selectedMarketplaces || [])].sort().join(',') || 'all';
    const periodKey = selectedRange
      ? makePeriodKey({ marketplaceKey: marketplacesKey, startDate: selectedRange.start, endDate: selectedRange.end })
      : '';

    const selectedStat = stats.get(selectedPeriod);
    const tablePeriodKey = tableTotalsDateRange
      ? makePeriodKey({
          marketplaceKey: marketplacesKey,
          startDate: tableTotalsDateRange.startDate,
          endDate: tableTotalsDateRange.endDate,
        })
      : '';

    onDebugStateChange({
      selectedPeriodLabel: selectedPeriod,
      selectedTZ: AMAZON_BUSINESS_TZ,
      selectedRangeStart: selectedRange?.start || '',
      selectedRangeEnd: selectedRange?.end || '',
      periodKey,
      rpcPeriodKey: periodKey,
      rpcGrossSales: Number(selectedStat?.sales || 0),
      rpcUnits: Number(selectedStat?.units || 0),
      tablePeriodKey,
      tableGrossSales: Number(tablePeriodTotals?.salesPrincipal || 0),
      tableUnits: Number(tablePeriodTotals?.units || 0),
      appliedCorrectionToKey,
      cacheHit: false,
      cacheKeyUsed: periodKey,
    });
  }, [
    onDebugStateChange,
    dateRanges,
    selectedPeriod,
    selectedMarketplaces,
    stats,
    tableTotalsDateRange,
    tablePeriodTotals,
    appliedCorrectionToKey,
  ]);

  // Fetch historical period stats from financial_events_cache ONLY via server-side RPC (Sellerboard approach)
  // Uses half-open [start, end) date boundaries to avoid timezone drift and row-limit issues.
  const fetchHistoricalPeriodStat = useCallback(async (periodId: string): Promise<PeriodStat | null> => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!periodDef || !range) return null;

    // Default empty fee breakdown
    const emptyFeeBreakdown = {
      fbaFulfillmentFee: 0, referralFee: 0, inboundTransportation: 0, variableClosingFee: 0,
      fixedClosingFee: 0, storageFees: 0, removalFees: 0, disposalFees: 0, longTermStorageFees: 0,
      digitalServicesFee: 0, liquidationsBrokerageFee: 0, compensatedClawback: 0, hrrNonApparelRollup: 0,
      reCommerceGradingCharge: 0, fbaCustomerReturnFee: 0, otherFees: 0, amazonOtherFees: 0, inboundDelta: 0,
      freeReplacementRefundItems: 0, liquidationsRevenue: 0, warehouseDamage: 0, warehouseLost: 0,
      reversalReimbursement: 0, otherReimbursements: 0, otherIncome: 0, totalFees: 0, totalCredits: 0,
      netAmazonFees: 0, eventCount: 0, dateRangeUsed: `${range.start} to ${range.end}`,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Use half-open date boundaries: start_ts inclusive, end_ts exclusive.
    // For December 2025: start = 2025-12-01T00:00:00Z, end = 2026-01-01T00:00:00Z
    // ─────────────────────────────────────────────────────────────────────────
    const startTs = `${range.start}T00:00:00.000Z`;
    // Calculate exclusive end (day after range.end) using UTC to avoid timezone issues
    // Parse the date parts directly to avoid JS Date parsing issues
    let [endYear, endMonth, endDay] = range.end.split('-').map(Number);
    // Fix legacy bug where years like 2025 were stored as 0025
    // Also fix JS Date year-0-99 behavior (Date.UTC treats 0-99 as 1900+year)
    if (endYear >= 0 && endYear < 100) endYear += 2000;
    if (endYear > 0 && endYear < 1900) endYear += 2000;
    const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1));
    const endY = String(endDateObj.getUTCFullYear());
    const endM = String(endDateObj.getUTCMonth() + 1).padStart(2, "0");
    const endD = String(endDateObj.getUTCDate()).padStart(2, "0");
    const endTs = `${endY}-${endM}-${endD}T00:00:00.000Z`;

    console.log(`[fetchHistoricalPeriodStat] ${periodId}: range [${startTs}, ${endTs})`);

    // Call the server-side RPC to aggregate totals (avoids 1000-row limit, client drift)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Use AUTHORITATIVE RPC that computes COGS the same way as the Sales table
    // This ensures all blocks show consistent COGS without needing to be "selected"
    const { data: rpcData, error: rpcError } = await supabase.rpc("get_authoritative_period_totals", {
      start_ts: startTs,
      end_ts: endTs,
    }) as { data: Record<string, number>[] | null; error: any };

    if (rpcError) {
      console.error("[fetchHistoricalPeriodStat] RPC error:", rpcError);
      return null;
    }

    const row = Array.isArray(rpcData) && rpcData.length > 0 ? rpcData[0] : null;
    const n = (key: string) => Number(row?.[key] ?? 0);

    // ─────────────────────────────────────────────────────────────────────────
    // PURCHASE-DATE AUTHORITY: Sales, Units, Orders, COGS always come from
    // sales_orders (purchase-date), NOT from settlement events.
    // This ensures MTD totals match the sum of daily blocks.
    // Settlement RPC still provides fees, refunds, and operational charges.
    // ─────────────────────────────────────────────────────────────────────────
    const normalizedOrderId = (id: string) => String(id || '').replace(/-REFUND.*$/i, '');
    // See the note on getStrictLineRevenue: estimated_price is native for
    // non-US, so it only becomes revenue through the shared converter.
    const getLineSales = (r: any) => settledOnlyOrConverted(r);

    const purchaseOrderRows = await fetchAllPages<any>(() => {
      let q = supabase
        .from('sales_orders')
        .select('order_id, asin, sku, seller_sku, quantity, sold_price, total_sale_amount, estimated_price, unit_cost, total_cost, is_cancelled, order_status, order_type')
        .eq('user_id', userId)
        .gte('order_date', range.start)
        .lte('order_date', range.end)
        .order('order_date', { ascending: true });

      if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
        const mktConds = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
        if (selectedMarketplaces.includes('US')) mktConds.push('marketplace.is.null');
        q = q.or(mktConds.join(','));
      }
      return q;
    }, { label: `historical SO ${periodId}` });

    const validPurchaseOrders = (purchaseOrderRows || []).filter((r: any) => {
      const cancelled = r.is_cancelled === true;
      const status = String(r.order_status || '').toLowerCase();
      const orderType = String(r.order_type || '').toLowerCase();
      const isReplacement = orderType.includes('replacement');
      return !cancelled && status !== 'canceled' && status !== 'cancelled' && !isReplacement;
    });

    // Authoritative Sales/Units/Orders from purchase-date orders
    const totalSales = validPurchaseOrders.reduce((s: number, r: any) => s + getLineSales(r), 0);
    const shipmentUnits = validPurchaseOrders.reduce((s: number, r: any) => s + Math.max(1, Number(r.quantity || 0)), 0);
    const allPurchaseOrderIds = Array.from(new Set(validPurchaseOrders.map((r: any) => normalizedOrderId(r.order_id)).filter(Boolean)));
    const orderCount = allPurchaseOrderIds.length;

    // Authoritative COGS from purchase-date orders (same priority chain as parity mode)
    const [clCostResH, invCostResH] = await Promise.all([
      supabase.from('created_listings').select('asin, sku, cost, units, amount').eq('user_id', userId),
      supabase.from('inventory').select('asin, sku, cost').eq('user_id', userId),
    ]);

    const clCostMapH = new Map<string, number>();
    for (const clRow of (clCostResH.data || []) as any[]) {
      const cost = Number(clRow.cost || 0);
      const clUnits = Number(clRow.units || 0);
      const amount = Number(clRow.amount || 0);
      let perUnit = 0;
      if (cost > 0) {
        perUnit = clUnits > 1 ? cost / clUnits : cost;
      } else if (amount > 0) {
        perUnit = amount;
      }
      if (perUnit <= 0) continue;
      if (clRow.asin && !clCostMapH.has(clRow.asin)) clCostMapH.set(clRow.asin, perUnit);
      if (clRow.asin && clRow.sku) {
        const compositeKey = `${clRow.asin}:${clRow.sku.toUpperCase()}`;
        if (!clCostMapH.has(compositeKey)) clCostMapH.set(compositeKey, perUnit);
      }
    }

    const invCostByAsinH = new Map<string, number>();
    const invCostBySkuH = new Map<string, number>();
    for (const invRow of (invCostResH.data || []) as any[]) {
      const c = Number(invRow.cost || 0);
      if (c <= 0) continue;
      if (invRow.asin && !invCostByAsinH.has(invRow.asin)) invCostByAsinH.set(invRow.asin, c);
      if (invRow.sku && !invCostBySkuH.has(invRow.sku)) invCostBySkuH.set(invRow.sku, c);
    }

    let totalCogs = 0;
    for (const r of validPurchaseOrders) {
      const sku = r.seller_sku || r.sku || '';
      const qty = Math.max(1, Number(r.quantity || 0));
      const compositeKey = sku ? `${r.asin}:${sku.toUpperCase()}` : '';
      const compositeCost = compositeKey ? (clCostMapH.get(compositeKey) || 0) : 0;
      if (compositeCost > 0) { totalCogs += compositeCost * qty; continue; }
      const asinCost = clCostMapH.get(r.asin) || 0;
      if (asinCost > 0) { totalCogs += asinCost * qty; continue; }
      const orderTotalCost = Number(r.total_cost || 0);
      if (orderTotalCost > 0) { totalCogs += orderTotalCost; continue; }
      const orderUnitCost = Number(r.unit_cost || 0);
      if (orderUnitCost > 0) { totalCogs += orderUnitCost * qty; continue; }
      const invCost = invCostBySkuH.get(sku) || invCostByAsinH.get(r.asin) || 0;
      totalCogs += invCost * qty;
    }

    // Settlement-derived values (fees, refunds, adjustments — NOT sales/units)
    const totalRefunds = n('refunds');
    const totalFeesRpc = n('total_fees');
    const refundEventCount = n('refund_count');
    const rowCount = n('row_count');

    const promotionalRebates = n('promotional_rebates_total');
    const shippingCredits = n('shipping_credits_total');
    const giftWrapCredits = n('gift_wrap_credits_total');
    const netSales = totalSales - promotionalRebates;

    // Individual fee components from RPC
    const rpcReferralFees = n('referral_fees_total');
    const rpcFbaFees = n('fba_fees_total');
    const rpcVariableClosingFees = n('variable_closing_fees_total');
    const rpcFixedClosingFees = n('fixed_closing_fees_total');
    const rpcStorageFees = n('storage_fees_total');
    const rpcRemovalFees = n('removal_fees_total');
    const rpcDisposalFees = n('disposal_fees_total');
    const rpcLongTermStorageFees = n('long_term_storage_fees_total');
    const rpcCustomerReturnFees = n('customer_return_fees_total');
    const rpcOtherFees = n('other_fees_total');
    const rpcDigitalServicesFee = n('digital_services_fee_total');
    const rpcInboundFees = n('inbound_fees_total');
    const rpcInboundConvenienceFee = n('inbound_convenience_fee_total');
    const rpcCompensatedClawback = n('compensated_clawback_total');
    const rpcHrrNonApparel = n('hrr_non_apparel_total');
    const rpcReCommerceGrading = n('re_commerce_grading_total');
    const rpcLiquidations = n('liquidations_total');
    const rpcLiquidationsBrokerage = n('liquidations_brokerage_total');
    const rpcWarehouseDamage = n('warehouse_damage_total');
    const rpcWarehouseLost = n('warehouse_lost_total');
    const rpcReversalReimbursement = n('reversal_reimbursement_total');
    const rpcOtherIncome = n('other_income_total');
    const rpcFreeReplacement = n('free_replacement_total');

    console.log(`[fetchHistoricalPeriodStat] ${periodId}: purchase-date authority: sales=$${totalSales.toFixed(2)}, units=${shipmentUnits}, orders=${orderCount}, cogs=$${totalCogs.toFixed(2)} | settlement fees=$${totalFeesRpc.toFixed(2)} (referral=${rpcReferralFees.toFixed(2)}, fba=${rpcFbaFees.toFixed(2)})`);

    // Fetch inbound fees from fba_inbound_fees table (Sellerboard-aligned)
    const { data: inboundFeesData } = await supabase
      .from("fba_inbound_fees")
      .select("fee_amount")
      .eq("user_id", userId)
      .ilike("fee_type", "%Transportation%")
      .or(`and(shipment_day.gte.${range.start},shipment_day.lte.${range.end}),and(shipment_day.is.null,posted_date.gte.${range.start},posted_date.lte.${range.end})`);

    const totalInboundFees = (inboundFeesData || []).reduce((sum, f) => sum + Math.abs(Number(f.fee_amount) || 0), 0);

    const feeBreakdown = {
      ...emptyFeeBreakdown,
      eventCount: rowCount,
      fbaFulfillmentFee: rpcFbaFees,
      referralFee: rpcReferralFees,
      variableClosingFee: rpcVariableClosingFees,
      fixedClosingFee: rpcFixedClosingFees,
      storageFees: rpcStorageFees,
      removalFees: rpcRemovalFees,
      disposalFees: rpcDisposalFees,
      longTermStorageFees: rpcLongTermStorageFees,
      fbaCustomerReturnFee: rpcCustomerReturnFees,
      otherFees: rpcOtherFees,
      digitalServicesFee: rpcDigitalServicesFee,
      inboundTransportation: totalInboundFees > 0 ? totalInboundFees : rpcInboundFees,
      compensatedClawback: rpcCompensatedClawback,
      hrrNonApparelRollup: rpcHrrNonApparel,
      reCommerceGradingCharge: rpcReCommerceGrading,
      liquidationsRevenue: rpcLiquidations,
      liquidationsBrokerageFee: rpcLiquidationsBrokerage,
      warehouseDamage: rpcWarehouseDamage,
      warehouseLost: rpcWarehouseLost,
      reversalReimbursement: rpcReversalReimbursement,
      otherIncome: rpcOtherIncome,
      freeReplacementRefundItems: rpcFreeReplacement,
      totalFees: totalFeesRpc,
      netAmazonFees: totalFeesRpc,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // UNSETTLED ORDER FEE SUPPLEMENT
    // Settlement RPC sums fees by posting-date, but recent orders (last ~2 days)
    // may not have settled yet. Supplement with order-level fees for those days.
    // ─────────────────────────────────────────────────────────────────────────
    let unsettledFbaFee = 0;
    let unsettledReferralFee = 0;
    let unsettledClosingFee = 0;
    let unsettledTotalFees = 0;

    // Check if this period includes today or yesterday (unsettled window)
    const todayStr = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

    const periodIncludesRecent = range.end >= yesterdayStr;

    if (periodIncludesRecent) {
      // Query order-level fees for the last 2 unsettled days within this period's range
      const unsettledStart = range.start > yesterdayStr ? range.start : yesterdayStr;
      const unsettledEnd = range.end;

      const unsettledRows = await fetchAllPages<any>(() => {
        let q = supabase
          .from('sales_orders')
          .select('order_id, fba_fee, referral_fee, closing_fee, total_fees, sold_price, total_sale_amount, is_cancelled, order_status, order_type')
          .eq('user_id', userId)
          .gte('order_date', unsettledStart)
          .lte('order_date', unsettledEnd)
          .order('order_date', { ascending: true });

        if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
          const mktConds = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
          if (selectedMarketplaces.includes('US')) mktConds.push('marketplace.is.null');
          q = q.or(mktConds.join(','));
        }
        return q;
      }, { label: `unsettled SO ${periodId}` });

      if (unsettledRows && unsettledRows.length > 0) {
        // Filter to valid revenue rows (same logic as parity mode)
        const validRows = unsettledRows.filter((r: any) => {
          const cancelled = r.is_cancelled === true;
          const status = String(r.order_status || '').toLowerCase();
          const orderType = String(r.order_type || '').toLowerCase();
          const isReplacement = orderType.includes('replacement');
          const hasSales = Number(r.total_sale_amount || r.sold_price || 0) > 0;
          return !cancelled && status !== 'canceled' && status !== 'cancelled' && !isReplacement && hasSales;
        });

        // Check which order_ids already have settlement data
        const orderIds = Array.from(new Set(validRows.map((r: any) => String(r.order_id || '').replace(/-REFUND.*$/i, '')).filter(Boolean)));

        // Query financial_events_cache in chunks to find already-settled orders
        const settledOrderIds = new Set<string>();
        const chunkSize = 200;
        for (let i = 0; i < orderIds.length; i += chunkSize) {
          const chunk = orderIds.slice(i, i + chunkSize);
          const { data: feRows } = await supabase
            .from('financial_events_cache')
            .select('amazon_order_id, fba_fees')
            .eq('user_id', userId)
            .in('amazon_order_id', chunk);

          if (feRows) {
            for (const fe of feRows) {
              if (Math.abs(Number(fe.fba_fees || 0)) > 0) {
                settledOrderIds.add(fe.amazon_order_id);
              }
            }
          }
        }

        // Sum order-level fees only for truly unsettled orders
        for (const r of validRows) {
          const normalizedId = String(r.order_id || '').replace(/-REFUND.*$/i, '');
          if (settledOrderIds.has(normalizedId)) continue;

          unsettledFbaFee += Math.abs(Number(r.fba_fee || 0));
          unsettledReferralFee += Math.abs(Number(r.referral_fee || 0));
          unsettledClosingFee += Math.abs(Number(r.closing_fee || 0));
          unsettledTotalFees += Math.abs(Number(r.total_fees || 0));
        }

        console.log(`[fetchHistoricalPeriodStat] ${periodId}: unsettled supplement: fba=${unsettledFbaFee.toFixed(2)}, referral=${unsettledReferralFee.toFixed(2)}, closing=${unsettledClosingFee.toFixed(2)}, total=${unsettledTotalFees.toFixed(2)} (from ${validRows.length - settledOrderIds.size} unsettled orders)`);
      }
    }

    // Use itemized unsettled fees if available, otherwise fall back to total_fees column
    const unsettledItemized = unsettledFbaFee + unsettledReferralFee + unsettledClosingFee;
    const unsettledToAdd = unsettledItemized > 0 ? unsettledItemized : unsettledTotalFees;

    // Augment the RPC totals with unsettled order fees
    const augmentedTotalFees = totalFeesRpc + unsettledToAdd;
    const augmentedFbaFees = rpcFbaFees + unsettledFbaFee;
    const augmentedReferralFees = rpcReferralFees + unsettledReferralFee;
    const augmentedClosingFees = rpcVariableClosingFees + rpcFixedClosingFees + unsettledClosingFee;

    // Update fee breakdown with augmented values
    feeBreakdown.fbaFulfillmentFee = augmentedFbaFees;
    feeBreakdown.referralFee = augmentedReferralFees;
    feeBreakdown.variableClosingFee = rpcVariableClosingFees + unsettledClosingFee;
    feeBreakdown.totalFees = augmentedTotalFees;
    feeBreakdown.netAmazonFees = augmentedTotalFees;

    // Expenses for the period
    let totalExpenses = 0;
    const { data: expenseData } = await supabase
      .from("expenses")
      .select("amount, frequency, expense_date, end_date")
      .eq("user_id", userId);

    if (expenseData) {
      const rangeStart = new Date(range.start + "T00:00:00");
      const rangeEnd = new Date(range.end + "T23:59:59");
      for (const expense of expenseData) {
        const expenseDate = new Date(expense.expense_date + "T00:00:00");
        const expenseEndDate = expense.end_date ? new Date(expense.end_date + "T23:59:59") : null;
        if (expense.frequency === "one_time" && expenseDate >= rangeStart && expenseDate <= rangeEnd) {
          totalExpenses += Number(expense.amount || 0);
        } else if (expense.frequency === "monthly") {
          const expenseEnd = expenseEndDate || new Date("2099-12-31");
          if (expenseDate <= rangeEnd && expenseEnd >= rangeStart) {
            totalExpenses += Number(expense.amount || 0);
          }
        }
      }
    }

    // CANONICAL refund cost — replaces the GROSS principal sum that previously
    // drove this block. See architecture-audit.md §1.2.
    const canonicalRefunds = await fetchCanonicalRefundsForPeriod(
      userId, range.start, range.end, selectedMarketplaces,
      `historical_rpc refunds ${periodId}`,
    );
    const refundCostNet = canonicalRefunds.refundCostNet;

    // Calculate profits using NET refund cost (was GROSS).
    const grossProfit = totalSales - promotionalRebates - augmentedTotalFees - refundCostNet - totalCogs;
    const netProfit = grossProfit - totalExpenses;
    const estPayout = totalSales - augmentedTotalFees - refundCostNet;
    const roi = totalCogs > 0 ? ((grossProfit / totalCogs) * 100) : 0;
    const margin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;
    const refundPercent = totalSales > 0 ? (refundCostNet / totalSales) * 100 : 0;
    const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;
    // Use shipment units from RPC, fallback to order count if not available
    const estimatedUnits = shipmentUnits > 0 ? shipmentUnits : orderCount;


    return {
      id: periodId,
      label: periodDef.label,
      sublabel: range.label,
      dateLabel: range.dateLabel,
      sales: totalSales,
      orders: orderCount,
      units: estimatedUnits,
      refunds: refundEventCount,
      refundAmount: refundCostNet,
      refundedReferralFee: canonicalRefunds.referralFeeCreditPositive,
      advCost: 0,
      estPayout,
      grossProfit,
      netProfit,
      fbaFee: augmentedFbaFees,
      referralFee: augmentedReferralFees,
      closingFee: augmentedClosingFees,
      totalFees: augmentedTotalFees,
      uncategorizedFees: 0,
      recordFees: { totalFees: augmentedTotalFees, fbaFee: augmentedFbaFees, referralFee: augmentedReferralFees, closingFee: augmentedClosingFees },
      perAsinFees: [],
      debugDirectDbFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0, recordCount: 0, recordsWithFees: 0, estimatedFees: 0, estimatedFba: 0, estimatedReferral: 0, recordsWithEstimates: 0, recordsMissingBoth: 0, missingAsins: [] },
      totalCost: totalCogs,
      roi,
      margin,
      refundPercent,
      avgOrderValue,
      avgUnitPrice: estimatedUnits > 0 ? totalSales / estimatedUnits : 0,
      profitPerUnit: estimatedUnits > 0 ? netProfit / estimatedUnits : 0,
      expenses: totalExpenses,
      inboundFees: totalInboundFees,
      inboundFeesCount: inboundFeesData?.length || 0,
      cancelledOrders: 0, // Historical periods don't track cancelled orders
      pendingStatusCheck: 0, // Historical periods don't track pending checks
      feeBreakdownSource: 'FEC',
      unknownResidualFee: Math.max(0, augmentedTotalFees - getItemizedFeeBreakdownTotal(feeBreakdown)),
      feeBreakdown,
      refundsFromCache: {
        refundedAmount: canonicalRefunds.principalRefunded,
        refundedReferralFee: canonicalRefunds.referralFeeCreditPositive,
        refundedOtherFees: 0,
        refundAdminRetention: canonicalRefunds.refundAdminRetention,
        refundEventCount: canonicalRefunds.refundEventCount,
      },
      // NEW: Net Sales breakdown (Sellerboard-style)
      netSalesBreakdown: {
        grossSales: totalSales,
        promotionalRebates,
        shippingCredits,
        giftWrapCredits,
        netSales,
      },
      debug: {
        rowsUsedForPopupFeesCount: rowCount,
        sumTotalFees: totalFeesRpc,
        sumItemizedFees: totalFeesRpc,
        difference: 0,
        countTotalFeesNullOrZero: 0,
        mismatchRows: [],
        financialEventsCount: rowCount,
        dateRangeWithCutoff: `[${startTs}, ${endTs}) (settled RPC)`,
      },
    };
  }, [userId, dateRanges, selectedMarketplaces]);

  // Fetch Sellerboard Mode data using PurchaseDate from sales_orders instead of PostedDate
  // This RPC uses the order_date (purchase date) as month attribution, matching Sellerboard's approach
  const fetchSellerboardModeStat = useCallback(async (
    periodId: string,
    options?: { skipGraphParity?: boolean }
  ): Promise<PeriodStat | null> => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!periodDef || !range) return null;

    // Default empty fee breakdown
    const emptyFeeBreakdown = {
      fbaFulfillmentFee: 0, referralFee: 0, inboundTransportation: 0, variableClosingFee: 0,
      fixedClosingFee: 0, storageFees: 0, removalFees: 0, disposalFees: 0, longTermStorageFees: 0,
      digitalServicesFee: 0, liquidationsBrokerageFee: 0, compensatedClawback: 0, hrrNonApparelRollup: 0,
      reCommerceGradingCharge: 0, fbaCustomerReturnFee: 0, otherFees: 0, amazonOtherFees: 0, inboundDelta: 0,
      freeReplacementRefundItems: 0, liquidationsRevenue: 0, warehouseDamage: 0, warehouseLost: 0,
      reversalReimbursement: 0, otherReimbursements: 0, otherIncome: 0, totalFees: 0, totalCredits: 0,
      netAmazonFees: 0, eventCount: 0, dateRangeUsed: `${range.start} to ${range.end}`,
    };

    const startTs = `${range.start}T00:00:00.000Z`;
    // Calculate exclusive end (day after range.end) using UTC to avoid timezone issues
    let [endYear, endMonth, endDay] = range.end.split('-').map(Number);
    if (endYear >= 0 && endYear < 100) endYear += 2000;
    if (endYear > 0 && endYear < 1900) endYear += 2000;
    const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1));
    const endY = String(endDateObj.getUTCFullYear());
    const endM = String(endDateObj.getUTCMonth() + 1).padStart(2, "0");
    const endD = String(endDateObj.getUTCDate()).padStart(2, "0");
    const endTs = `${endY}-${endM}-${endD}T00:00:00.000Z`;

    console.log(`[fetchSellerboardModeStat] ${periodId}: range [${startTs}, ${endTs}) using PurchaseDate`);

    // ── PARALLEL FAN-OUT ─────────────────────────────────────────────────────
    // FAST-FIRST mode (skipGraphParity=true): only run the totals RPC. The
    // expenses query and cancelled-orders count are deferred — they'll be
    // recomputed by the background Smart enrich, so paying for them here just
    // delays the first paint of the MTD block.
    const tParallel = performance.now();
    const fastOnly = options?.skipGraphParity === true;
    const deferRecentFeeDetails = fastOnly && (periodId === 'month_to_date' || periodId === 'custom' || periodId === 'year_to_date');
    // Pull FEC fee breakdown ONLY when not in fast-first mode.
    // The get_authoritative_period_totals RPC is the slow path (often 30s+);
    // including it in fast-first defeats the entire purpose. Background
    // Smart enrich (or popup-on-open fetch) will populate the breakdown.
    const wantsFeeBreakdown = !fastOnly;
    const [rpcResult, expenseResEarly, cancelledResEarly, fecRefundsRes, feeBreakdownRes] = await Promise.all([
      supabase.rpc("get_sellerboard_period_totals", {
        start_ts: startTs,
        end_ts: endTs,
      }),
      fastOnly
        ? Promise.resolve({ data: [] as any[], error: null })
        : supabase
            .from("expenses")
            .select("amount, frequency, expense_date, end_date")
            .eq("user_id", userId),
      fastOnly
        ? Promise.resolve({ count: 0, error: null })
        : supabase
            .from("sales_orders")
            .select("order_id", { count: 'exact', head: true })
            .eq("user_id", userId)
            .gte("order_date", range.start)
            .lte("order_date", range.end)
            .or("is_cancelled.eq.true,order_status.eq.Canceled,order_status.eq.Cancelled"),
      // FEC refunds — authoritative source. SO only contains the few synthetic
      // -REFUND rows; the real $ live in financial_events_cache.
      deferRecentFeeDetails
        ? Promise.resolve({ data: [] as any[], error: null })
        : fetchAllPages<any>(() =>
            supabase
              .from("financial_events_cache")
              .select("refunds, amazon_order_id")
              .eq("user_id", userId)
              .eq("event_type", "refund")
              .gte("event_date", range.start)
              .lte("event_date", range.end)
              .order("event_date", { ascending: true }),
            { label: `FEC refunds ${periodId}` },
          ).then((data) => ({ data, error: null as any })),
      // FEC full fee breakdown (referral, FBA, closing, storage, inbound, etc.)
      // — required so the MTD/Custom popup shows fee components instead of one lump.
      wantsFeeBreakdown
        ? supabase.rpc("get_authoritative_period_totals", { start_ts: startTs, end_ts: endTs })
        : Promise.resolve({ data: null, error: null }),
    ]);
    console.log(`[fetchSellerboardModeStat] ${periodId}: parallel ${fastOnly ? 'RPC-only (fast)+FEC-refunds' : 'RPC+expenses+cancelled+FEC-refunds'}${wantsFeeBreakdown ? '+FEC-fees' : ''} in ${(performance.now() - tParallel).toFixed(0)}ms`);

    const rpcData = rpcResult.data as {
      sales: number;
      refunds: number;
      total_fees: number;
      unique_orders: number;
      refund_count: number;
      row_count: number;
      total_units: number;
      cogs: number;
    }[] | null;
    const rpcError = rpcResult.error;

    if (rpcError) {
      console.error("[fetchSellerboardModeStat] RPC error:", rpcError);
      return null;
    }

    const row = Array.isArray(rpcData) && rpcData.length > 0 ? rpcData[0] : null;
    let totalSales = Number(row?.sales ?? 0);
    const soRefunds = Number(row?.refunds ?? 0);
    const totalFeesRpc = Number(row?.total_fees ?? 0);
    let orderCount = Number(row?.unique_orders ?? 0);
    const soRefundCount = Number(row?.refund_count ?? 0);
    let rowCount = Number(row?.row_count ?? 0);
    let totalUnits = Number(row?.total_units ?? 0);
    const totalCogs = Number(row?.cogs ?? 0);

    // Prefer FEC refunds (authoritative). Fall back to SO refunds if FEC empty.
    const fecRefundRows = (fecRefundsRes as any)?.data as { refunds: number | null; amazon_order_id: string | null }[] | null;
    let totalRefunds = soRefunds;
    let refundEventCount = soRefundCount;
    if (Array.isArray(fecRefundRows) && fecRefundRows.length > 0) {
      const fecTotal = fecRefundRows.reduce((s, r) => s + Math.abs(Number(r.refunds || 0)), 0);
      totalRefunds = fecTotal;
      refundEventCount = fecRefundRows.length;
      console.log(`[fetchSellerboardModeStat] ${periodId}: FEC refunds=$${fecTotal.toFixed(2)} (${fecRefundRows.length} events) overrides SO refunds=$${soRefunds.toFixed(2)}`);
    }


    // ── Live Sales row authority: use exact same sales_orders rowset/filtering as Live Sales ──
    // Daily live periods must not trust RPC totals if duplicate/pending rows exist.
    const useLiveSalesRowAuthority =
      periodId === 'today' ||
      periodId === 'yesterday' ||
      (periodId === 'month_to_date' && !options?.skipGraphParity);
    if (useLiveSalesRowAuthority) {
      const strictRows: StrictSalesOrderRow[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        let q = supabase
          .from('sales_orders')
          .select('order_id, asin, title, quantity, sold_price, total_sale_amount, estimated_price, marketplace, is_cancelled, order_status, order_type')
          .eq('user_id', userId)
          .gte('order_date', range.start)
          .lte('order_date', range.end)
          .not('order_id', 'like', '%-REFUND')
          .order('order_date', { ascending: true })
          .range(from, from + PAGE - 1);

        if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
          const mktConds = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
          if (selectedMarketplaces.includes('US')) mktConds.push('marketplace.is.null');
          q = q.or(mktConds.join(','));
        }

        const { data: page, error: pageErr } = await q;
        if (pageErr) throw pageErr;
        if (!page || page.length === 0) break;
        strictRows.push(...(page as StrictSalesOrderRow[]));
        if (page.length < PAGE) break;
      }

      const graphRows = buildGraphEquivalentRows(strictRows);
      totalSales = graphRows.reduce((s, r) => s + getStrictLineRevenue(r), 0);
      totalUnits = graphRows.reduce((s, r) => s + Math.max(1, Number(r.quantity || 0)), 0);
      orderCount = new Set(graphRows.map((r) => normalizeStrictOrderId(r.order_id)).filter(Boolean)).size;
      rowCount = graphRows.length;

      console.log(
        `[fetchSellerboardModeStat] ${periodId} LiveSales-row authority: rawFetched=${strictRows.length}, afterFilter=${graphRows.length}, ` +
        `orders=${orderCount}, units=${totalUnits}, grossSales=$${totalSales.toFixed(2)} (RPC was $${Number(row?.sales ?? 0).toFixed(2)})`
      );
    }

    // Shared promo deductions — same helper that <PromotionsDeductedSection />
    // renders, so the number subtracted here is provably identical to the
    // value the user sees in the collapsible block. Covers FEC + SO (USD-safe).
    let promotionalRebates = 0;
    try {
      const promoRes = await fetchPromotionDeductions({
        userId,
        rangeStart: range.start,
        rangeEnd: range.end,
        marketplace: "ALL",
      });
      promotionalRebates = promoRes.totalUsd || 0;
    } catch (e: any) {
      console.warn(`[fetchSellerboardModeStat] promo fetch failed (non-fatal):`, e?.message || e);
    }

    // Net sales: subtract refunds and promo from gross (Sellerboard-style)
    const netSales = totalSales - promotionalRebates - totalRefunds;

    console.log(`[fetchSellerboardModeStat] ${periodId}: grossSales=${totalSales.toFixed(2)}, netSales=${netSales.toFixed(2)}, orders=${orderCount}, units=${totalUnits}, refunds=${totalRefunds.toFixed(2)}`);

    // Reuse expenses + cancelled-count results that were fetched in parallel
    // with the RPC above (see top of fetchSellerboardModeStat).
    const cancelledCount = cancelledResEarly.count || 0;
    const expenseData = expenseResEarly.data;

    let totalExpenses = 0;
    if (expenseData) {
      const rangeStart = new Date(range.start + "T00:00:00");
      const rangeEnd = new Date(range.end + "T23:59:59");
      for (const expense of expenseData) {
        const expenseDate = new Date(expense.expense_date + "T00:00:00");
        const expenseEndDate = expense.end_date ? new Date(expense.end_date + "T23:59:59") : null;
        if (expense.frequency === "one_time" && expenseDate >= rangeStart && expenseDate <= rangeEnd) {
          totalExpenses += Number(expense.amount || 0);
        } else if (expense.frequency === "monthly") {
          const expenseEnd = expenseEndDate || new Date("2099-12-31");
          if (expenseDate <= rangeEnd && expenseEnd >= rangeStart) {
            totalExpenses += Number(expense.amount || 0);
          }
        }
      }
    }

    // CANONICAL refund cost — see architecture-audit.md §1.2.
    const canonicalRefunds = await fetchCanonicalRefundsForPeriod(
      userId, range.start, range.end, selectedMarketplaces,
      `sellerboard_mode refunds ${periodId}`,
    );
    const refundCostNet = canonicalRefunds.refundCostNet;

    const grossProfit = totalSales - promotionalRebates - totalFeesRpc - refundCostNet - totalCogs;
    const netProfit = grossProfit - totalExpenses;
    const estPayout = totalSales - totalFeesRpc - refundCostNet;
    const roi = totalCogs > 0 ? ((grossProfit / totalCogs) * 100) : 0;
    const margin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;
    const refundPercent = totalSales > 0 ? (refundCostNet / totalSales) * 100 : 0;
    const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;

    const feeBreakdown = { ...emptyFeeBreakdown, netAmazonFees: totalFeesRpc };

    // Populate component breakdown from FEC RPC (MTD/Month/Custom) so popup
    // shows referral / FBA / closing / storage / inbound / etc.
    const fbRow = Array.isArray((feeBreakdownRes as any)?.data) && (feeBreakdownRes as any).data.length > 0
      ? (feeBreakdownRes as any).data[0]
      : null;
    if (fbRow) {
      feeBreakdown.referralFee = Number(fbRow.referral_fees_total || 0);
      feeBreakdown.fbaFulfillmentFee = Number(fbRow.fba_fees_total || 0);
      feeBreakdown.variableClosingFee = Number(fbRow.variable_closing_fees_total || 0);
      feeBreakdown.fixedClosingFee = Number(fbRow.fixed_closing_fees_total || 0);
      feeBreakdown.storageFees = Number(fbRow.storage_fees_total || 0);
      feeBreakdown.removalFees = Number(fbRow.removal_fees_total || 0);
      feeBreakdown.disposalFees = Number(fbRow.disposal_fees_total || 0);
      feeBreakdown.longTermStorageFees = Number(fbRow.long_term_storage_fees_total || 0);
      feeBreakdown.fbaCustomerReturnFee = Number(fbRow.customer_return_fees_total || 0);
      feeBreakdown.otherFees = Number(fbRow.other_fees_total || 0);
      feeBreakdown.digitalServicesFee = Number(fbRow.digital_services_fee_total || 0);
      feeBreakdown.inboundTransportation = Number(fbRow.inbound_fees_total || 0);
      feeBreakdown.compensatedClawback = Number(fbRow.compensated_clawback_total || 0);
      feeBreakdown.hrrNonApparelRollup = Number(fbRow.hrr_non_apparel_total || 0);
      feeBreakdown.reCommerceGradingCharge = Number(fbRow.re_commerce_grading_total || 0);
      feeBreakdown.liquidationsBrokerageFee = Number(fbRow.liquidations_brokerage_total || 0);
      feeBreakdown.liquidationsRevenue = Number(fbRow.liquidations_total || 0);
      feeBreakdown.warehouseDamage = Number(fbRow.warehouse_damage_total || 0);
      feeBreakdown.warehouseLost = Number(fbRow.warehouse_lost_total || 0);
      feeBreakdown.reversalReimbursement = Number(fbRow.reversal_reimbursement_total || 0);
      feeBreakdown.otherIncome = Number(fbRow.other_income_total || 0);
      feeBreakdown.freeReplacementRefundItems = Number(fbRow.free_replacement_total || 0);
      feeBreakdown.eventCount = Number(fbRow.row_count || 0);
      console.log(`[fetchSellerboardModeStat] ${periodId}: FEC fee breakdown loaded — referral=$${feeBreakdown.referralFee.toFixed(2)}, fba=$${feeBreakdown.fbaFulfillmentFee.toFixed(2)}, closing=$${(feeBreakdown.variableClosingFee + feeBreakdown.fixedClosingFee).toFixed(2)}, storage=$${feeBreakdown.storageFees.toFixed(2)}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // P&L itemization contract — applies to ALL modes (Smart / Estimated / Reconciled).
    //
    //   Reconciled  → FEC only (no SO supplementation)
    //   Estimated   → SO only itemized into referral/FBA/closing; residual → amazonOtherFees
    //   Smart       → FEC for settled order_ids; supplement ONLY unsettled order_ids from SO,
    //                 each fee mapped to its own category; residual → amazonOtherFees.
    //
    // Goal: NEVER collapse all Amazon fees into the FBA fulfillment fee bucket.
    // ─────────────────────────────────────────────────────────────────────

    // Build a set of order_ids settled in FEC for this window so we can dedupe
    // when supplementing from sales_orders. Only needed when this Sellerboard
    // path is used as the Smart fast-first (fastOnly=true) — the per-day Smart
    // resolver downstream already handles per-day dedupe; this guarantees the
    // popup we paint immediately is itemized correctly without double-counting.
    let settledOrderIds = new Set<string>();
    let soFbaFee = 0, soReferralFee = 0, soClosingFee = 0, soTotalFees = 0;
    let unsettledFba = 0, unsettledReferral = 0, unsettledClosing = 0, unsettledTotal = 0;

    try {
      // 2) Pull SO rows with order_id FIRST so we can scope the FEC dedup query
      // to the exact order_ids in this purchase-date window. This prevents
      // double-counting caused by mixing FEC's settlement-date window with
      // SO's purchase-date window (per memory: SO=order_date, FEC=settlement_date).
      const soFeeRows = await fetchAllPages<any>(() => {
        let q = supabase
          .from('sales_orders')
          .select('order_id, fba_fee, referral_fee, closing_fee, total_fees, is_cancelled, order_status, order_type, total_sale_amount, sold_price')
          .eq('user_id', userId)
          .gte('order_date', range.start)
          .lte('order_date', range.end)
          .order('order_date', { ascending: true });

        if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
          const mktConds = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
          if (selectedMarketplaces.includes('US')) mktConds.push('marketplace.is.null');
          q = q.or(mktConds.join(','));
        }
        return q;
      }, { label: `SO fee rows ${periodId}` });

      // 1) Build dedup set: query FEC for which of THESE specific SO order_ids
      // have already been settled (any time, not just within this window). This
      // avoids the cohort mismatch caused by FEC.event_date vs SO.order_date.
      const candidateOrderIds = Array.isArray(soFeeRows)
        ? Array.from(new Set((soFeeRows as any[])
            .map((r: any) => String(r.order_id || '').trim())
            .filter(Boolean)))
        : [];
      if (candidateOrderIds.length > 0) {
        // Chunk to avoid URL-length limits on .in()
        const CHUNK = 200;
        for (let i = 0; i < candidateOrderIds.length; i += CHUNK) {
          const chunk = candidateOrderIds.slice(i, i + CHUNK);
          const { data: fecMatchRows } = await supabase
            .from('financial_events_cache')
            .select('amazon_order_id')
            .eq('user_id', userId)
            .in('amazon_order_id', chunk);
          if (Array.isArray(fecMatchRows)) {
            for (const r of fecMatchRows as any[]) {
              const oid = String(r.amazon_order_id || '').trim();
              if (oid) settledOrderIds.add(oid);
            }
          }
        }
      }

      if (soFeeRows && soFeeRows.length > 0) {
        for (const r of soFeeRows as any[]) {
          const cancelled = r.is_cancelled === true;
          const status = String(r.order_status || '').toLowerCase();
          const orderType = String(r.order_type || '').toLowerCase();
          const isReplacement = orderType.includes('replacement');
          const hasSales = Number(r.total_sale_amount || r.sold_price || 0) > 0;
          if (cancelled || status === 'canceled' || status === 'cancelled' || isReplacement || !hasSales) continue;

          const fba = Math.abs(Number(r.fba_fee || 0));
          const ref = Math.abs(Number(r.referral_fee || 0));
          const clo = Math.abs(Number(r.closing_fee || 0));
          const tot = Math.abs(Number(r.total_fees || 0));

          soFbaFee += fba;
          soReferralFee += ref;
          soClosingFee += clo;
          soTotalFees += tot;

          // Dedupe: if this order_id is already in FEC, do NOT supplement.
          // In fast-first estimated mode, the SO itemized totals above still
          // feed the visible popup so fees do not collapse into one bucket.
          const oid = String(r.order_id || '').trim();
          if (oid && settledOrderIds.has(oid)) continue;

          unsettledFba += fba;
          unsettledReferral += ref;
          unsettledClosing += clo;
          unsettledTotal += tot;
        }
        console.log(
          `[fetchSellerboardModeStat] ${periodId}: SO fee components — ` +
          `fba=$${soFbaFee.toFixed(2)} referral=$${soReferralFee.toFixed(2)} closing=$${soClosingFee.toFixed(2)} | ` +
          `unsettled (will supplement) — fba=$${unsettledFba.toFixed(2)} referral=$${unsettledReferral.toFixed(2)} closing=$${unsettledClosing.toFixed(2)} | ` +
          `SO order_ids: ${candidateOrderIds.length} | settled-in-FEC (any time): ${settledOrderIds.size} | unsettled count: ${candidateOrderIds.length - settledOrderIds.size}`
        );
      }
    } catch (soFeeErr) {
      console.warn(`[fetchSellerboardModeStat] ${periodId}: SO fee/dedupe query failed (non-fatal)`, soFeeErr);
    }

    // Apply the contract by mode.
    //   - For Reconciled callers, this Sellerboard path is bypassed upstream
    //     (router uses fetchHistoricalPeriodStat / fetchParityModeStat) so we
    //     always treat this path as Smart-or-Estimated.
    //   - If FEC has ANY itemized data, Smart-supplement unsettled-only.
    //   - If FEC is completely empty (Today/Yesterday/early MTD), fall back to
    //     full SO itemization with residual into amazonOtherFees.
    const fecItemizedSum =
      feeBreakdown.fbaFulfillmentFee + feeBreakdown.referralFee +
      feeBreakdown.variableClosingFee + feeBreakdown.fixedClosingFee +
      feeBreakdown.storageFees + feeBreakdown.removalFees +
      feeBreakdown.disposalFees + feeBreakdown.longTermStorageFees +
      feeBreakdown.fbaCustomerReturnFee + feeBreakdown.digitalServicesFee +
      feeBreakdown.inboundTransportation + feeBreakdown.liquidationsBrokerageFee +
      feeBreakdown.compensatedClawback + feeBreakdown.hrrNonApparelRollup +
      feeBreakdown.reCommerceGradingCharge + feeBreakdown.otherFees;
    const fecHasEvents = (feeBreakdown.eventCount || 0) > 0 || fecItemizedSum > 0;

    if (fecHasEvents) {
      // Smart mode — FEC is authoritative for settled orders. Add only the
      // unsettled order_ids' fees on top, per-category. Never overwrite.
      feeBreakdown.fbaFulfillmentFee += unsettledFba;
      feeBreakdown.referralFee       += unsettledReferral;
      feeBreakdown.variableClosingFee += unsettledClosing;
      const itemizedUnsettled = unsettledFba + unsettledReferral + unsettledClosing;
      const unsettledResidual = Math.max(0, unsettledTotal - itemizedUnsettled);
      if (unsettledResidual > 0) {
        feeBreakdown.amazonOtherFees = (feeBreakdown.amazonOtherFees || 0) + unsettledResidual;
      }
    } else if (soTotalFees > 0) {
      // Estimated fallback — SO only. Itemize the 3 known categories, dump
      // residual into amazonOtherFees so the popup never shows "everything is
      // FBA fulfillment fee".
      feeBreakdown.fbaFulfillmentFee = soFbaFee;
      feeBreakdown.referralFee = soReferralFee;
      feeBreakdown.variableClosingFee = soClosingFee;
      const itemizedTotal = soFbaFee + soReferralFee + soClosingFee;
      const residual = Math.max(0, soTotalFees - itemizedTotal);
      if (residual > 0) {
        feeBreakdown.amazonOtherFees = (feeBreakdown.amazonOtherFees || 0) + residual;
      }
      feeBreakdown.eventCount = 0;
    }

    // Recompute totals from itemized fields so the popup reconciles to the RPC total.
    const recomputedFees =
      feeBreakdown.fbaFulfillmentFee + feeBreakdown.referralFee +
      feeBreakdown.variableClosingFee + feeBreakdown.fixedClosingFee +
      feeBreakdown.storageFees + feeBreakdown.removalFees +
      feeBreakdown.disposalFees + feeBreakdown.longTermStorageFees +
      feeBreakdown.fbaCustomerReturnFee + feeBreakdown.digitalServicesFee +
      feeBreakdown.inboundTransportation + feeBreakdown.liquidationsBrokerageFee +
      feeBreakdown.compensatedClawback + feeBreakdown.hrrNonApparelRollup +
      feeBreakdown.reCommerceGradingCharge + feeBreakdown.otherFees +
      (feeBreakdown.amazonOtherFees || 0) + (feeBreakdown.inboundDelta || 0);

    // If RPC total exceeds itemized sum (FEC categories we don't have rows for),
    // park the gap in amazonOtherFees so the popup reconciles instead of
    // dumping into FBA fulfillment fee.
    const rpcGap = totalFeesRpc - recomputedFees;
    if (rpcGap > 0.5) {
      feeBreakdown.amazonOtherFees = (feeBreakdown.amazonOtherFees || 0) + rpcGap;
    }

    feeBreakdown.totalFees = Math.max(totalFeesRpc, recomputedFees + Math.max(0, rpcGap));
    feeBreakdown.totalCredits =
      (feeBreakdown.freeReplacementRefundItems || 0) +
      (feeBreakdown.liquidationsRevenue || 0) +
      (feeBreakdown.warehouseDamage || 0) +
      (feeBreakdown.warehouseLost || 0) +
      (feeBreakdown.reversalReimbursement || 0) +
      (feeBreakdown.otherReimbursements || 0) +
      (feeBreakdown.otherIncome || 0);
    feeBreakdown.netAmazonFees = feeBreakdown.totalFees - feeBreakdown.totalCredits;

    const recordFbaFee = soFbaFee;
    const recordReferralFee = soReferralFee;
    const recordClosingFee = soClosingFee;
    const recordTotalFees = soTotalFees > 0 ? soTotalFees : totalFeesRpc;
    const feeBreakdownSource = fecHasEvents ? (soTotalFees > 0 ? 'FEC + SO unsettled' : 'FEC') : 'SO estimated';
    const unknownResidualFee = Math.max(0, feeBreakdown.amazonOtherFees || 0);

    warnRefundGrossBranch('sellerboard_mode', periodId, 0); // canonicalized; will not fire
    return {
      id: periodId,
      label: periodDef.label,
      sublabel: range.label,
      dateLabel: range.dateLabel,
      sales: totalSales,
      orders: orderCount,
      units: totalUnits, // Actual QuantityShipped from sales_orders
      refunds: refundEventCount,
      refundAmount: refundCostNet,
      refundedReferralFee: canonicalRefunds.referralFeeCreditPositive,
      advCost: 0,
      estPayout,
      grossProfit,
      netProfit,
      fbaFee: 0,
      referralFee: 0,
      closingFee: 0,
      totalFees: totalFeesRpc,
      uncategorizedFees: 0,
      recordFees: { totalFees: recordTotalFees, fbaFee: recordFbaFee, referralFee: recordReferralFee, closingFee: recordClosingFee },
      perAsinFees: [],
      debugDirectDbFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0, recordCount: 0, recordsWithFees: 0, estimatedFees: 0, estimatedFba: 0, estimatedReferral: 0, recordsWithEstimates: 0, recordsMissingBoth: 0, missingAsins: [] },
      totalCost: totalCogs,
      roi,
      margin,
      refundPercent,
      avgOrderValue,
      avgUnitPrice: totalUnits > 0 ? totalSales / totalUnits : 0,
      profitPerUnit: totalUnits > 0 ? netProfit / totalUnits : 0,
      expenses: totalExpenses,
      inboundFees: 0,
      inboundFeesCount: 0,
      cancelledOrders: cancelledCount,
      pendingStatusCheck: 0, // Sellerboard mode doesn't track pending checks
      feeBreakdownSource,
      unknownResidualFee,
      feeBreakdown,
      refundsFromCache: {
        refundedAmount: canonicalRefunds.principalRefunded,
        refundedReferralFee: canonicalRefunds.referralFeeCreditPositive,
        refundedOtherFees: 0,
        refundAdminRetention: canonicalRefunds.refundAdminRetention,
        refundEventCount: canonicalRefunds.refundEventCount,
      },
      // Net Sales breakdown (Sellerboard Mode shows net after refunds)
      netSalesBreakdown: {
        grossSales: totalSales,
        promotionalRebates, // shared helper — matches <PromotionsDeductedSection />
        shippingCredits: 0,
        giftWrapCredits: 0,
        netSales: netSales,
      },
      debug: {
        rowsUsedForPopupFeesCount: rowCount,
        sumTotalFees: totalFeesRpc,
        sumItemizedFees: totalFeesRpc,
        difference: 0,
        countTotalFeesNullOrZero: 0,
        mismatchRows: [],
        financialEventsCount: rowCount,
        dateRangeWithCutoff: `[${startTs}, ${endTs}) (Sellerboard Mode - PurchaseDate)`,
      },
    };
  }, [userId, dateRanges, selectedMarketplaces]);

  // Fetch Sellerboard Mode comparison data (both PostedDate and PurchaseDate for Last Month)
  const fetchSellerboardComparison = useCallback(async () => {
    const range = dateRanges.last_month;
    if (!range) return;

    const startTs = `${range.start}T00:00:00.000Z`;
    // Calculate exclusive end (day after range.end) using UTC to avoid timezone issues
    let [endYear, endMonth, endDay] = range.end.split('-').map(Number);
    if (endYear >= 0 && endYear < 100) endYear += 2000;
    if (endYear > 0 && endYear < 1900) endYear += 2000;
    const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1));
    const endY = String(endDateObj.getUTCFullYear());
    const endM = String(endDateObj.getUTCMonth() + 1).padStart(2, "0");
    const endD = String(endDateObj.getUTCDate()).padStart(2, "0");
    const endTs = `${endY}-${endM}-${endD}T00:00:00.000Z`;

    // Fetch both RPCs in parallel
    const [postedResult, purchaseResult] = await Promise.all([
      supabase.rpc("get_settled_period_totals", { start_ts: startTs, end_ts: endTs }),
      supabase.rpc("get_sellerboard_period_totals", { start_ts: startTs, end_ts: endTs }),
    ]);

    const posted = Array.isArray(postedResult.data) && postedResult.data.length > 0 ? postedResult.data[0] : null;
    const purchase = Array.isArray(purchaseResult.data) && purchaseResult.data.length > 0 ? purchaseResult.data[0] : null;

    if (!posted || !purchase) {
      console.error("[fetchSellerboardComparison] Missing data", { posted, purchase });
      return;
    }

    const postedSales = Number(posted.sales ?? 0);
    const purchaseSales = Number(purchase.sales ?? 0);
    const delta = postedSales - purchaseSales;

    // Sellerboard comparison removed - always use live data
    console.log('[Sellerboard comparison] Data available but feature removed:', { postedSales, purchaseSales, delta });
  }, [dateRanges.last_month]);

  // Compute refund totals from liveRefunds for a given date range
  const computeLiveRefundsForRange = useCallback((startDate: string, endDate: string): {
    refundCount: number;
    refundAmount: number;
    refundedReferralFee: number;
  } => {
    if (!liveRefunds || liveRefunds.length === 0) return { refundCount: 0, refundAmount: 0, refundedReferralFee: 0 };

    const filtered = liveRefunds.filter(r => {
      const d = String(r.postedDate || '').slice(0, 10);
      return d >= startDate && d <= endDate;
    });

    // Deduplicate by orderId-asin, keeping largest amount
    const deduped = new Map<string, typeof filtered[0]>();
    for (const r of filtered) {
      const key = `${r.orderId}-${r.asin}`;
      const existing = deduped.get(key);
      if (!existing || Math.abs(r.amount) > Math.abs(existing.amount)) {
        deduped.set(key, r);
      }
    }

    let totalAmount = 0;
    let totalReferralFee = 0;
    for (const r of deduped.values()) {
      totalAmount += Math.abs(r.amount);
      totalReferralFee += Math.abs(r.referralFee || 0);
    }

    return {
      refundCount: deduped.size,
      refundAmount: totalAmount,
      refundedReferralFee: totalReferralFee,
    };
  }, [liveRefunds]);

  // Overlay liveRefunds onto a stat, recalculating derived metrics
  const overlayLiveRefunds = useCallback((stat: PeriodStat, range: { start: string; end: string }): PeriodStat => {
    const liveRefundData = computeLiveRefundsForRange(range.start, range.end);
    // Only keep RPC refunds when live refunds are not materially higher.
    // Count alone can be misleading (fewer events but larger $ amount), so compare both.
    if (
      liveRefundData.refundCount <= stat.refunds &&
      liveRefundData.refundAmount <= (stat.refundAmount + 0.01)
    ) return stat;

    console.log(`[overlayLiveRefunds] ${stat.id}: RPC refunds=${stat.refunds} (${stat.refundAmount.toFixed(2)}) → live refunds=${liveRefundData.refundCount} (${liveRefundData.refundAmount.toFixed(2)})`);

    const refundAmount = liveRefundData.refundAmount;
    const updated = { ...stat };
    updated.refunds = liveRefundData.refundCount;
    updated.refundAmount = refundAmount;
    updated.refundedReferralFee = liveRefundData.refundedReferralFee;
    updated.refundsFromCache = {
      refundedAmount: refundAmount,
      refundedReferralFee: liveRefundData.refundedReferralFee,
      refundedOtherFees: 0,
      refundEventCount: liveRefundData.refundCount,
    };
    // Recalculate derived metrics
    const totalSales = updated.sales;
    const totalFees = updated.totalFees;
    const totalCogs = updated.totalCost;
    const expenses = updated.expenses;
    const promotionalRebates = updated.netSalesBreakdown?.promotionalRebates || 0;
    const shippingCredits = updated.netSalesBreakdown?.shippingCredits || 0;

    updated.grossProfit = totalSales + shippingCredits - promotionalRebates - totalFees - refundAmount - totalCogs;
    updated.netProfit = updated.grossProfit - expenses;
    updated.estPayout = totalSales + shippingCredits - totalFees - refundAmount;
    updated.refundPercent = totalSales > 0 ? (refundAmount / totalSales) * 100 : 0;
    updated.roi = totalCogs > 0 ? ((updated.grossProfit / totalCogs) * 100) : 0;
    updated.margin = totalSales > 0 ? (updated.grossProfit / totalSales) * 100 : 0;
    updated.profitPerUnit = updated.units > 0 ? updated.netProfit / updated.units : 0;

    if (updated.netSalesBreakdown) {
      updated.netSalesBreakdown = {
        ...updated.netSalesBreakdown,
        netSales: totalSales - (updated.netSalesBreakdown.promotionalRebates || 0) - refundAmount,
      };
    }

    return updated;
  }, [computeLiveRefundsForRange]);

  // Parity mode (order-ID-based reconciliation):
  // Sales/Units/Orders/COGS come from purchase-date sales_orders rows.
  // Fees/Refunds come from financial_events_cache for those SAME order_ids (not posted-date window).
  // Used for Yesterday and Custom Range to avoid settlement posting lag drift.
  const fetchParityModeStat = useCallback(async (periodId: string): Promise<PeriodStat | null> => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!periodDef || !range) return null;

    const emptyFeeBreakdown = {
      fbaFulfillmentFee: 0, referralFee: 0, inboundTransportation: 0, variableClosingFee: 0,
      fixedClosingFee: 0, storageFees: 0, removalFees: 0, disposalFees: 0, longTermStorageFees: 0,
      digitalServicesFee: 0, liquidationsBrokerageFee: 0, compensatedClawback: 0, hrrNonApparelRollup: 0,
      reCommerceGradingCharge: 0, fbaCustomerReturnFee: 0, otherFees: 0, amazonOtherFees: 0, inboundDelta: 0,
      freeReplacementRefundItems: 0, liquidationsRevenue: 0, warehouseDamage: 0, warehouseLost: 0,
      reversalReimbursement: 0, otherReimbursements: 0, otherIncome: 0, totalFees: 0, totalCredits: 0,
      netAmazonFees: 0, eventCount: 0, dateRangeUsed: `${range.start} to ${range.end}`,
    };

    let orderRowsRaw: any[] = [];
    try {
      orderRowsRaw = await fetchAllPages<any>(() => {
        let q = supabase
          .from('sales_orders')
          .select('order_id, asin, sku, seller_sku, quantity, sold_price, total_sale_amount, estimated_price, fba_fee, referral_fee, closing_fee, total_fees, total_cost, unit_cost, marketplace, is_cancelled, order_status, order_type')
          .eq('user_id', userId)
          .gte('order_date', range.start)
          .lte('order_date', range.end)
          .order('order_date', { ascending: true });

        if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
          const marketplaceConditions = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
          if (selectedMarketplaces.includes('US')) marketplaceConditions.push('marketplace.is.null');
          q = q.or(marketplaceConditions.join(','));
        }
        return q;
      }, { label: `parity SO ${periodId}` });
    } catch (orderErr) {
      console.error('[fetchParityModeStat] sales_orders query error', orderErr);
      return null;
    }

    const normalizedOrderId = (id: string) => String(id || '').replace(/-REFUND.*$/i, '');
    const isPendingPlaceholderRow = (row: any) => {
      const asin = String(row?.asin || '').trim().toUpperCase();
      const title = String(row?.title || '').trim().toLowerCase();
      return asin === 'PENDING' || title.startsWith('order processing');
    };

    const getLineSales = (row: any) => settledOnlyOrConverted(row);

    const dropReasons = {
      cancelledFlag: 0,
      canceledStatus: 0,
      replacementOrder: 0,
      pendingPlaceholder: 0,
      quantityZeroOrNull: 0,
      missingAsin: 0,
      missingSku: 0,
      missingTotalSaleAmount: 0,
      missingSoldPrice: 0,
      missingEstimatedPrice: 0,
    };

    for (const r of (orderRowsRaw || []) as any[]) {
      const status = String(r.order_status || '').toLowerCase();
      const orderType = String(r.order_type || '').toLowerCase();
      const qty = Number(r.quantity || 0);
      if (r.is_cancelled === true) dropReasons.cancelledFlag += 1;
      if (status === 'canceled' || status === 'cancelled') dropReasons.canceledStatus += 1;
      if (orderType.includes('replacement')) dropReasons.replacementOrder += 1;
      if (isPendingPlaceholderRow(r)) dropReasons.pendingPlaceholder += 1;
      if (qty <= 0) dropReasons.quantityZeroOrNull += 1;
      if (!String(r.asin || '').trim()) dropReasons.missingAsin += 1;
      if (!String(r.seller_sku || r.sku || '').trim()) dropReasons.missingSku += 1;
      if (Math.abs(Number(r.total_sale_amount || 0)) <= 0) dropReasons.missingTotalSaleAmount += 1;
      if (Math.abs(Number(r.sold_price || 0)) <= 0) dropReasons.missingSoldPrice += 1;
      if (Math.abs(Number(r.estimated_price || 0)) <= 0) dropReasons.missingEstimatedPrice += 1;
    }

    const orderRows = (orderRowsRaw || []).filter((r: any) => {
      const cancelled = r.is_cancelled === true;
      const status = String(r.order_status || '').toLowerCase();
      const orderType = String(r.order_type || '').toLowerCase();
      const isReplacement = orderType.includes('replacement');
      const isPlaceholder = isPendingPlaceholderRow(r);
      return !cancelled && status !== 'canceled' && status !== 'cancelled' && !isReplacement && !isPlaceholder;
    });

    // Include ALL non-cancelled orders for units/orders, not just those with prices
    const allOrderIds = Array.from(new Set(orderRows.map((r: any) => normalizedOrderId(r.order_id)).filter(Boolean)));
    const revenueRows = orderRows.filter((r: any) => getLineSales(r) > 0);

    const salesPrincipal = revenueRows.reduce((s: number, r: any) => s + getLineSales(r), 0);
    const units = orderRows.reduce((s: number, r: any) => s + Math.max(1, Number(r.quantity || 0)), 0);
    const orders = allOrderIds.length;
    // COGS: Match the table's priority exactly: created_listings (with composite ASIN:SKU keys) first,
    // then sales_orders.unit_cost, then inventory.cost.
    // Contract A: created_listings.cost = TOTAL, amount = UNIT — derive UNIT cost via helper.
    const [clCostRes, invCostRes] = await Promise.all([
      supabase.from('created_listings').select('asin, sku, cost, units, amount').eq('user_id', userId),
      supabase.from('inventory').select('asin, sku, cost').eq('user_id', userId),
    ]);

    // Build created_listings cost maps matching Sales.tsx exactly
    const clCostMap = new Map<string, number>(); // Keys: ASIN, ASIN:SKU (composite)
    for (const row of (clCostRes.data || []) as any[]) {
      const perUnit = getListingUnitCost(row) ?? 0;
      if (perUnit <= 0) continue;
      // ASIN-only key (first wins, matching Sales.tsx)
      if (row.asin && !clCostMap.has(row.asin)) clCostMap.set(row.asin, perUnit);
      // Composite ASIN:SKU key for multi-SKU precision (matching Sales.tsx)
      if (row.asin && row.sku) {
        const compositeKey = `${row.asin}:${row.sku.toUpperCase()}`;
        if (!clCostMap.has(compositeKey)) clCostMap.set(compositeKey, perUnit);
      }
    }

    // Build inventory cost maps
    const invCostByAsin = new Map<string, number>();
    const invCostBySku = new Map<string, number>();
    for (const row of (invCostRes.data || []) as any[]) {
      const c = Number(row.cost || 0);
      if (c <= 0) continue;
      if (row.asin && !invCostByAsin.has(row.asin)) invCostByAsin.set(row.asin, c);
      if (row.sku && !invCostBySku.has(row.sku)) invCostBySku.set(row.sku, c);
    }

    let cogsTotal = 0;
    for (const r of orderRows) {
      const sku = r.seller_sku || r.sku || '';
      const qty = Math.max(1, Number(r.quantity || 0));
      // Priority 1: Composite ASIN:SKU key in created_listings (matches table's multi-SKU logic)
      const compositeKey = sku ? `${r.asin}:${sku.toUpperCase()}` : '';
      const compositeCost = compositeKey ? (clCostMap.get(compositeKey) || 0) : 0;
      if (compositeCost > 0) {
        cogsTotal += compositeCost * qty;
        continue;
      }
      // Priority 2: ASIN-only in created_listings
      const asinCost = clCostMap.get(r.asin) || 0;
      if (asinCost > 0) {
        cogsTotal += asinCost * qty;
        continue;
      }
      // Priority 3: sales_orders.unit_cost / total_cost (stored at order time)
      const orderTotalCost = Number(r.total_cost || 0);
      if (orderTotalCost > 0) {
        cogsTotal += orderTotalCost;
        continue;
      }
      const orderUnitCost = Number(r.unit_cost || 0);
      if (orderUnitCost > 0) {
        cogsTotal += orderUnitCost * qty;
        continue;
      }
      // Priority 4: inventory cost
      const invCost = invCostBySku.get(sku) || invCostByAsin.get(r.asin) || 0;
      cogsTotal += invCost * qty;
    }

    console.log(
      `[fetchParityModeStat] ${periodId}: order-set truth rows=${orderRows.length}, units=${units}, unique_order_ids=${orders}; ` +
      `dropped_reasons=${JSON.stringify(dropReasons)}`
    );

    // ─── Per-order hybrid fee aggregation ───
    // For each order: use settlement fees if available, otherwise use order-level fees.
    // This avoids the all-or-nothing fallback that underreports fees when only some orders are settled.
    const eventRows: any[] = [];
    const chunkSize = 200;
    for (let i = 0; i < allOrderIds.length; i += chunkSize) {
      const chunk = allOrderIds.slice(i, i + chunkSize);
      const { data: feChunk, error: feErr } = await supabase
        .from('financial_events_cache')
        .select('amazon_order_id, refunds, shipping_credits, gift_wrap_credits, promotional_rebates, referral_fees, fba_fees, variable_closing_fees, fixed_closing_fees, fba_inbound_fees, fba_inbound_convenience_fee, fba_storage_fees, fba_removal_fees, fba_disposal_fees, fba_long_term_storage_fees, fba_customer_return_fees, other_fees, digital_services_fee, compensated_clawback, hrr_non_apparel, re_commerce_grading_charge, liquidations_brokerage_fee, liquidations, warehouse_damage, warehouse_lost, reversal_reimbursement, free_replacement_refund_items, reimbursements, other_income')
        .eq('user_id', userId)
        .in('amazon_order_id', chunk);

      if (feErr) {
        console.error('[fetchParityModeStat] financial_events_cache query error', feErr);
        return null;
      }
      eventRows.push(...(feChunk || []));
    }

    // ─── Supplemental: catch refunds POSTED in this period for orders outside the purchase-date set ───
    // Refunds posted yesterday are typically for orders purchased days/weeks ago.
    // Without this, fetchParityModeStat misses them entirely because the order IDs aren't in allOrderIds.
    const existingOrderIds = new Set(eventRows.map((r: any) => normalizedOrderId(r.amazon_order_id)));
    const postedRefunds = await fetchAllPages<any>(() =>
      supabase
        .from('financial_events_cache')
        .select('amazon_order_id, refunds, shipping_credits, gift_wrap_credits, promotional_rebates, referral_fees, fba_fees, variable_closing_fees, fixed_closing_fees, fba_inbound_fees, fba_inbound_convenience_fee, fba_storage_fees, fba_removal_fees, fba_disposal_fees, fba_long_term_storage_fees, fba_customer_return_fees, other_fees, digital_services_fee, compensated_clawback, hrr_non_apparel, re_commerce_grading_charge, liquidations_brokerage_fee, liquidations, warehouse_damage, warehouse_lost, reversal_reimbursement, free_replacement_refund_items, reimbursements, other_income')
        .eq('user_id', userId)
        .eq('event_type', 'refund')
        .gte('event_date', range.start)
        .lte('event_date', range.end)
        .order('event_date', { ascending: true }),
      { label: `parity posted refunds ${periodId}` },
    );

    if (postedRefunds.length > 0) {
      let supplementCount = 0;
      for (const row of postedRefunds) {
        const oid = normalizedOrderId(row.amazon_order_id);
        // Only add refund events for orders NOT already in the purchase-date set
        if (!existingOrderIds.has(oid)) {
          eventRows.push(row);
          existingOrderIds.add(oid);
          supplementCount++;
        }
      }
      if (supplementCount > 0) {
        console.log(`[fetchParityModeStat] ${periodId}: added ${supplementCount} refund events posted in period for orders outside purchase-date set`);
      }
    }

    // Build a set of settled order IDs and a map of settlement fees per order
    const settledOrderMap = new Map<string, any[]>();
    for (const row of eventRows) {
      const oid = normalizedOrderId(row.amazon_order_id);
      if (!settledOrderMap.has(oid)) settledOrderMap.set(oid, []);
      settledOrderMap.get(oid)!.push(row);
    }

    // Aggregate settlement-level fees from settled orders
    const sumAbs = (key: string) => eventRows.reduce((s: number, r: any) => s + Math.abs(Number(r?.[key] || 0)), 0);

    const refundAmount = sumAbs('refunds');
    const shippingCredits = sumAbs('shipping_credits');
    const giftWrapCredits = sumAbs('gift_wrap_credits');
    const promotionalRebates = sumAbs('promotional_rebates');

    // Settlement-sourced fees (only from settled orders)
    let referralFee = sumAbs('referral_fees');
    let fbaFee = sumAbs('fba_fees');
    let variableClosingFee = sumAbs('variable_closing_fees');
    let fixedClosingFee = sumAbs('fixed_closing_fees');

    // For UNSETTLED orders, supplement with order-level fee estimates from sales_orders
    const unsettledRows = orderRows.filter((r: any) => !settledOrderMap.has(normalizedOrderId(r.order_id)));
    const unsettledFbaFee = unsettledRows.reduce((s: number, r: any) => s + Math.abs(Number(r.fba_fee || 0)), 0);
    const unsettledReferralFee = unsettledRows.reduce((s: number, r: any) => s + Math.abs(Number(r.referral_fee || 0)), 0);
    const unsettledClosingFee = unsettledRows.reduce((s: number, r: any) => s + Math.abs(Number(r.closing_fee || 0)), 0);

    // Add unsettled order fees on top of settlement fees
    referralFee += unsettledReferralFee;
    fbaFee += unsettledFbaFee;
    variableClosingFee += unsettledClosingFee;

    console.log(`[fetchParityModeStat] ${periodId}: ${settledOrderMap.size}/${allOrderIds.length} orders settled, unsettled fee supplement: fba=$${unsettledFbaFee.toFixed(2)} referral=$${unsettledReferralFee.toFixed(2)} closing=$${unsettledClosingFee.toFixed(2)}`);

    const inboundFees = sumAbs('fba_inbound_fees');
    const inboundConvenience = sumAbs('fba_inbound_convenience_fee');
    const storageFees = sumAbs('fba_storage_fees');
    const removalFees = sumAbs('fba_removal_fees');
    const disposalFees = sumAbs('fba_disposal_fees');
    const longTermStorageFees = sumAbs('fba_long_term_storage_fees');
    const fbaCustomerReturnFee = sumAbs('fba_customer_return_fees');
    const amazonOtherFees = sumAbs('other_fees');
    const digitalServicesFee = sumAbs('digital_services_fee');
    const compensatedClawback = sumAbs('compensated_clawback');
    const hrrNonApparelRollup = sumAbs('hrr_non_apparel');
    const reCommerceGradingCharge = sumAbs('re_commerce_grading_charge');
    const liquidationsBrokerageFee = sumAbs('liquidations_brokerage_fee');

    const liquidationsRevenue = sumAbs('liquidations');
    const warehouseDamage = sumAbs('warehouse_damage');
    const warehouseLost = sumAbs('warehouse_lost');
    const reversalReimbursement = sumAbs('reversal_reimbursement');
    const freeReplacementRefundItems = sumAbs('free_replacement_refund_items');
    const otherReimbursements = sumAbs('reimbursements');
    const otherIncome = sumAbs('other_income');

    const totalFeeComponents =
      referralFee + fbaFee + variableClosingFee + fixedClosingFee + inboundFees + inboundConvenience +
      storageFees + removalFees + disposalFees + longTermStorageFees + fbaCustomerReturnFee +
      amazonOtherFees + digitalServicesFee + compensatedClawback + hrrNonApparelRollup +
      reCommerceGradingCharge + liquidationsBrokerageFee;

    const totalCredits =
      liquidationsRevenue + warehouseDamage + warehouseLost + reversalReimbursement +
      freeReplacementRefundItems + otherReimbursements + otherIncome;

    const inboundFeesData = await fetchAllPages<any>(() =>
      supabase
        .from('fba_inbound_fees')
        .select('fee_amount, fee_type')
        .eq('user_id', userId)
        .or(`and(shipment_day.gte.${range.start},shipment_day.lte.${range.end}),and(shipment_day.is.null,posted_date.gte.${range.start},posted_date.lte.${range.end})`)
        .order('posted_date', { ascending: true }),
      { label: `inbound fees ${periodId}` },
    );

    const inboundFromTable = (inboundFeesData || [])
      .filter((f: any) => {
        const type = String(f.fee_type || '').toLowerCase();
        return type.includes('transportation') || type.includes('convenience');
      })
      .reduce((s: number, f: any) => s + Math.abs(Number(f.fee_amount || 0)), 0);

    const inboundFromEvents = inboundFees + inboundConvenience;
    const inboundDelta = Math.max(0, inboundFromTable - inboundFromEvents);
    const netAmazonFees = (totalFeeComponents + inboundDelta) - totalCredits;

    let totalExpenses = 0;
    const { data: expenseData } = await supabase
      .from('expenses')
      .select('amount, frequency, expense_date, end_date')
      .eq('user_id', userId);

    if (expenseData) {
      const rangeStart = new Date(range.start + 'T00:00:00');
      const rangeEnd = new Date(range.end + 'T23:59:59');
      for (const expense of expenseData) {
        const expenseDate = new Date(expense.expense_date + 'T00:00:00');
        const expenseEndDate = expense.end_date ? new Date(expense.end_date + 'T23:59:59') : null;
        if (expense.frequency === 'one_time' && expenseDate >= rangeStart && expenseDate <= rangeEnd) {
          totalExpenses += Number(expense.amount || 0);
        } else if (expense.frequency === 'monthly') {
          const expenseEnd = expenseEndDate || new Date('2099-12-31');
          if (expenseDate <= rangeEnd && expenseEnd >= rangeStart) {
            totalExpenses += Number(expense.amount || 0);
          }
        }
      }
    }

    const missingCostRows = revenueRows.filter((r: any) => Number(r.quantity || 0) > 0 && Number(r.unit_cost || 0) <= 0);
    const missingAsins = Array.from(new Set(missingCostRows.map((r: any) => r.asin).filter(Boolean)));
    const missingSkus = Array.from(new Set(missingCostRows.map((r: any) => (r.seller_sku || r.sku)).filter(Boolean)));

    const [inventoryCostRows, createdListingCostRows] = await Promise.all([
      missingAsins.length || missingSkus.length
        ? supabase.from('inventory').select('asin, sku, cost').eq('user_id', userId)
        : Promise.resolve({ data: [], error: null } as any),
      missingAsins.length || missingSkus.length
        ? supabase.from('created_listings').select('asin, sku, cost').eq('user_id', userId)
        : Promise.resolve({ data: [], error: null } as any),
    ]);

    const costBySku = new Map<string, number>();
    const costByAsin = new Map<string, number>();
    for (const row of [...(inventoryCostRows.data || []), ...(createdListingCostRows.data || [])] as any[]) {
      const c = Number(row.cost || 0);
      if (c > 0) {
        if (row.sku && !costBySku.has(row.sku)) costBySku.set(row.sku, c);
        if (row.asin && !costByAsin.has(row.asin)) costByAsin.set(row.asin, c);
      }
    }

    const cogsSample = missingCostRows.slice(0, 30).map((r: any) => {
      const sku = r.seller_sku || r.sku || '';
      const estimatedUnitCost = Number(costBySku.get(sku) || costByAsin.get(r.asin) || 0);
      return {
        order_id: r.order_id,
        asin: r.asin || '',
        sku,
        qty: Number(r.quantity || 0),
        unit_cost: Number(r.unit_cost || 0),
        estimated_unit_cost: estimatedUnitCost,
      };
    });

    const missingEstimatedCost = cogsSample.reduce((s, r) => s + (r.qty * r.estimated_unit_cost), 0);

    // CANONICAL refund cost. Parity path's eventRows include refund-event rows
    // for both purchase-date orders and supplemental posted refunds, but the
    // select list is fee-side and doesn't include `_refunds`-suffix columns.
    // Fetch the full refund row set separately so the canonical helper has
    // every column it needs. See architecture-audit.md §1.2.
    const canonicalRefunds = await fetchCanonicalRefundsForPeriod(
      userId, range.start, range.end, selectedMarketplaces,
      `parity_mode refunds ${periodId}`,
    );
    const refundCostNet = canonicalRefunds.refundCostNet;

    const grossProfit = salesPrincipal + shippingCredits - promotionalRebates - netAmazonFees - refundCostNet - cogsTotal;
    const netProfit = grossProfit - totalExpenses;
    const estPayout = salesPrincipal + shippingCredits - netAmazonFees - refundCostNet;
    const roi = cogsTotal > 0 ? ((grossProfit / cogsTotal) * 100) : 0;
    const margin = salesPrincipal > 0 ? (grossProfit / salesPrincipal) * 100 : 0;

    warnRefundGrossBranch('parity_mode', periodId, 0); // canonicalized; will not fire
    return {
      id: periodId,
      label: periodDef.label,
      sublabel: range.label,
      dateLabel: range.dateLabel,
      sales: salesPrincipal,
      orders,
      units,
      refunds: canonicalRefunds.refundEventCount,
      refundAmount: refundCostNet,
      refundedReferralFee: canonicalRefunds.referralFeeCreditPositive,
      advCost: 0,
      estPayout,
      grossProfit,
      netProfit,
      fbaFee,
      referralFee,
      closingFee: variableClosingFee + fixedClosingFee,
      totalFees: netAmazonFees,
      uncategorizedFees: 0,
      recordFees: {
        totalFees: netAmazonFees,
        fbaFee,
        referralFee,
        closingFee: variableClosingFee + fixedClosingFee,
      },
      perAsinFees: [],
      debugDirectDbFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0, recordCount: 0, recordsWithFees: 0, estimatedFees: 0, estimatedFba: 0, estimatedReferral: 0, recordsWithEstimates: 0, recordsMissingBoth: 0, missingAsins: [] },
      totalCost: cogsTotal,
      roi,
      margin,
      refundPercent: salesPrincipal > 0 ? (refundCostNet / salesPrincipal) * 100 : 0,
      avgOrderValue: orders > 0 ? salesPrincipal / orders : 0,
      avgUnitPrice: units > 0 ? salesPrincipal / units : 0,
      profitPerUnit: units > 0 ? netProfit / units : 0,
      expenses: totalExpenses,
      inboundFees: Math.max(inboundFromTable, inboundFromEvents),
      inboundFeesCount: (inboundFeesData || []).length,
      cancelledOrders: 0,
      pendingStatusCheck: 0,
      feeBreakdown: {
        ...emptyFeeBreakdown,
        eventCount: eventRows.length,
        fbaFulfillmentFee: fbaFee,
        referralFee,
        inboundTransportation: Math.max(inboundFromTable, inboundFromEvents),
        variableClosingFee,
        fixedClosingFee,
        storageFees,
        removalFees,
        disposalFees,
        longTermStorageFees,
        digitalServicesFee,
        liquidationsBrokerageFee,
        compensatedClawback,
        hrrNonApparelRollup,
        reCommerceGradingCharge,
        fbaCustomerReturnFee,
        otherFees: amazonOtherFees + inboundDelta,
        amazonOtherFees,
        inboundDelta,
        freeReplacementRefundItems,
        liquidationsRevenue,
        warehouseDamage,
        warehouseLost,
        reversalReimbursement,
        otherReimbursements,
        otherIncome,
        totalFees: totalFeeComponents + inboundDelta,
        totalCredits,
        netAmazonFees,
      },
      refundsFromCache: {
        refundedAmount: canonicalRefunds.principalRefunded,
        refundedReferralFee: canonicalRefunds.referralFeeCreditPositive,
        refundedOtherFees: 0,
        refundAdminRetention: canonicalRefunds.refundAdminRetention,
        refundEventCount: canonicalRefunds.refundEventCount,
      },
      netSalesBreakdown: {
        grossSales: salesPrincipal,
        promotionalRebates,
        shippingCredits,
        giftWrapCredits,
        netSales: salesPrincipal - promotionalRebates,
      },
      cogsReconciliation: {
        missingRows: missingCostRows.length,
        missingEstimatedCost,
        sample: cogsSample,
      },
      debug: {
        rowsUsedForPopupFeesCount: eventRows.length,
        sumTotalFees: netAmazonFees,
        sumItemizedFees: totalFeeComponents + inboundDelta,
        difference: netAmazonFees - ((totalFeeComponents + inboundDelta) - totalCredits),
        countTotalFeesNullOrZero: 0,
        mismatchRows: [],
        financialEventsCount: eventRows.length,
        dateRangeWithCutoff: `[${range.start}, ${range.end}] (purchase-date orders + all financial events by order_id) | order_set rows=${orderRows.length}, units=${units}, unique_order_ids=${orders} | dropped=${JSON.stringify(dropReasons)}`,
      },
    };
  }, [dateRanges, selectedMarketplaces, userId]);

  // Fetch a single period's data — hybrid approach:
  // Today: use purchase-date RPC only (settlement hasn't posted yet).
  // Yesterday: parity mode — purchase-date orders + financial events by order_id.
  // Other periods: settlement-based RPC only (fully settled).
  const fetchPeriodStat = useCallback(async (periodId: string): Promise<PeriodStat | null> => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!periodDef || !range) return null;

    if (pressureActive && isQueryCircuitOpen(PERIOD_STATS_QUERY_KEY) && periodId !== 'today') {
      return null;
    }

    try {
      let stat: PeriodStat | null = null;

      // ─── MODE-AWARE ROUTING (must match Live Sales / P&L exactly) ────────────
      // - Reconciled  → settlement-grade (financial_events_cache.event_date) → matches P&L
      // - Estimated   → purchase-grade (sales_orders.order_date)            → matches Live Sales Estimated
      // - Smart       → SO-primary; for fully-settled past periods (this_month,
      //                 last_month, custom older than today) fall back to FEC
      //                 reconciled totals so the numbers match P&L. For today,
      //                 yesterday, and MTD the SO/parity path is canonical.
      // ────────────────────────────────────────────────────────────────────────
      if (periodId === 'today') {
        // Today must mirror Live Sales: purchase-date sales_orders only.
        // FEC/shipped-settled data can lag for hours/days, so never block
        // Today's block on reconciled financial events.
        stat = await fetchSellerboardModeStat(periodId, { skipGraphParity: true });
      } else if (salesMode === 'reconciled') {
        // Always use the same RPC P&L uses
        stat = await fetchHistoricalPeriodStat(periodId);
      } else if (salesMode === 'estimated') {
        // Estimated mode = SO/order-date only, ALWAYS.
        // No FEC parity, no heavy reconciliation — must load fast for live decisions.
        // The fast SO render is canonical here; FEC fee breakdown can enrich in BG.
        stat = await fetchSellerboardModeStat(periodId, { skipGraphParity: true });
      } else {
        // ─── Smart Fallback (default): TRUE PER-DAY ROUTING ───────────────────
        // For each individual day in the window we look at SO and FEC totals
        // side-by-side. If SO covers ≥ 70% of FEC orders for that DAY → keep SO
        // (live, includes today's purchases). Otherwise → swap that ONE DAY for
        // FEC (settled). We then sum every day. The selected period as a whole
        // is NEVER switched wholesale — only the days where SO is incomplete.
        //
        //   • today / yesterday → SO-primary fast path (live windows must never wait on Smart FEC fallback)
        //   • month_to_date / custom / closed → per-day resolver
        // ──────────────────────────────────────────────────────────────────────
        if (periodId === 'today' || periodId === 'yesterday') {
          // Both today and yesterday use the SO-primary fast path with parity skipped.
          // The heavy FEC fee breakdown + parity checks are deferred to background enrichment
          // (or skipped entirely for canonical fast periods) to keep initial render snappy.
          stat = await fetchSellerboardModeStat(periodId, { skipGraphParity: true });
        } else {
          // Smart mode must not wait for the heavy baseline/parity path before the
          // selected block can render. Yesterday was blank because the fetch was
          // stuck in fetchParityModeStat before the verified Smart RPC ever ran.
          const baseline = makeBlankPeriodStat(periodId, periodDef, range);

          try {
            const startTs = `${range.start}T00:00:00.000Z`;
            const [endY, endM, endD] = range.end.split('-').map(Number);
            const endDateObj = new Date(Date.UTC(endY, (endM ?? 1) - 1, (endD ?? 1) + 1));
            const endTs = `${endDateObj.toISOString().slice(0, 10)}T00:00:00.000Z`;

            const [dailyRes, fecFeeBreakdownRes] = await Promise.all([
              supabase.rpc(
                'get_smart_fallback_daily_totals',
                { start_ts: startTs, end_ts: endTs }
              ),
              // FEC component breakdown for the popup (referral / FBA / closing /
              // storage / inbound / removal / disposal / etc). Without this the
              // Smart MTD popup collapses ALL fees into "Other Amazon order fees".
              supabase.rpc('get_authoritative_period_totals', { start_ts: startTs, end_ts: endTs }),
            ]);
            const dailyData = (dailyRes as any).data as Array<{
              day: string;
              so_orders: number; so_units: number; so_sales: number;
              so_refunds: number; so_fees: number; so_cogs: number;
              so_promo_rebates: number;
              fec_orders: number; fec_units: number; fec_sales: number;
              fec_refunds: number; fec_fees: number;
              fec_promo_rebates: number; fec_shipping_credits: number; fec_gift_wrap_credits: number;
            }> | null;
            const dailyErr = (dailyRes as any).error;

            if (dailyErr) throw dailyErr;
            const days = dailyData ?? [];

            // Hydrate baseline.feeBreakdown from FEC RPC so the popup shows
            // itemized fees instead of one collapsed "Other Amazon order fees" row.
            const fbRow = Array.isArray((fecFeeBreakdownRes as any)?.data) && (fecFeeBreakdownRes as any).data.length > 0
              ? (fecFeeBreakdownRes as any).data[0]
              : null;
            if (fbRow && baseline.feeBreakdown) {
              const bfb = baseline.feeBreakdown;
              bfb.referralFee = Number(fbRow.referral_fees_total || 0);
              bfb.fbaFulfillmentFee = Number(fbRow.fba_fees_total || 0);
              bfb.variableClosingFee = Number(fbRow.variable_closing_fees_total || 0);
              bfb.fixedClosingFee = Number(fbRow.fixed_closing_fees_total || 0);
              bfb.storageFees = Number(fbRow.storage_fees_total || 0);
              bfb.removalFees = Number(fbRow.removal_fees_total || 0);
              bfb.disposalFees = Number(fbRow.disposal_fees_total || 0);
              bfb.longTermStorageFees = Number(fbRow.long_term_storage_fees_total || 0);
              bfb.fbaCustomerReturnFee = Number(fbRow.customer_return_fees_total || 0);
              bfb.otherFees = Number(fbRow.other_fees_total || 0);
              bfb.digitalServicesFee = Number(fbRow.digital_services_fee_total || 0);
              bfb.inboundTransportation = Number(fbRow.inbound_fees_total || 0);
              bfb.compensatedClawback = Number(fbRow.compensated_clawback_total || 0);
              bfb.hrrNonApparelRollup = Number(fbRow.hrr_non_apparel_total || 0);
              bfb.reCommerceGradingCharge = Number(fbRow.re_commerce_grading_total || 0);
              bfb.liquidationsBrokerageFee = Number(fbRow.liquidations_brokerage_total || 0);
              bfb.liquidationsRevenue = Number(fbRow.liquidations_total || 0);
              bfb.warehouseDamage = Number(fbRow.warehouse_damage_total || 0);
              bfb.warehouseLost = Number(fbRow.warehouse_lost_total || 0);
              bfb.reversalReimbursement = Number(fbRow.reversal_reimbursement_total || 0);
              bfb.otherIncome = Number(fbRow.other_income_total || 0);
              bfb.freeReplacementRefundItems = Number(fbRow.free_replacement_total || 0);
              bfb.eventCount = Number(fbRow.row_count || 0);
              console.log(`[SmartFallback:per-day] ${periodId}: FEC fee breakdown hydrated for popup — referral=$${bfb.referralFee.toFixed(2)}, fba=$${bfb.fbaFulfillmentFee.toFixed(2)}, storage=$${bfb.storageFees.toFixed(2)}`);
            }


            // Per-day routing: SO unless SO is materially behind FEC for that day.
            // Dual trigger: FEC has ≥ 3 orders AND (order coverage < 70% OR revenue coverage < 70%).
            // Revenue coverage catches the case where SO has matching order counts but
            // is missing high-value orders (e.g. partial sync gaps for big-ticket items).
            const COVERAGE_THRESHOLD = 0.7;
            const FEC_MIN_ORDERS_FOR_FALLBACK = 3;

            const agg = {
              orders: 0, units: 0, sales: 0, refunds: 0, fees: 0, cogs: 0,
              promoRebates: 0, shippingCredits: 0, giftWrapCredits: 0,
              daysSO: 0, daysFEC: 0,
            };
            let soTotalSales = 0;
            let fecTotalSales = 0;
            const dayChoices: Array<{ day: string; pick: 'SO' | 'FEC'; soOrders: number; fecOrders: number }> = [];

            for (const d of days) {
              soTotalSales += Number(d.so_sales || 0);
              fecTotalSales += Number(d.fec_sales || 0);

              const soOrders = Number(d.so_orders || 0);
              const fecOrders = Number(d.fec_orders || 0);
              const soSales = Number(d.so_sales || 0);
              const fecSales = Number(d.fec_sales || 0);
              const orderCoverage = fecOrders > 0 ? soOrders / fecOrders : 1;
              const revenueCoverage = fecSales > 0 ? soSales / fecSales : 1;
              const useFecForDay =
                fecOrders >= FEC_MIN_ORDERS_FOR_FALLBACK &&
                (orderCoverage < COVERAGE_THRESHOLD || revenueCoverage < COVERAGE_THRESHOLD);

              dayChoices.push({ day: d.day, pick: useFecForDay ? 'FEC' : 'SO', soOrders, fecOrders });

              if (useFecForDay) {
                agg.daysFEC += 1;
                agg.orders += fecOrders;
                agg.units  += Number(d.fec_units || 0);
                agg.sales  += Number(d.fec_sales || 0);
                agg.refunds += Number(d.fec_refunds || 0);
                agg.fees   += Number(d.fec_fees || 0);
                agg.promoRebates    += Number(d.fec_promo_rebates || 0);
                agg.shippingCredits += Number(d.fec_shipping_credits || 0);
                agg.giftWrapCredits += Number(d.fec_gift_wrap_credits || 0);
                // FEC has no per-day COGS column; pull from SO if present, else 0.
                agg.cogs += Number(d.so_cogs || 0);
              } else {
                agg.daysSO += 1;
                agg.orders += soOrders;
                agg.units  += Number(d.so_units || 0);
                agg.sales  += Number(d.so_sales || 0);
                agg.refunds += Number(d.so_refunds || 0);
                agg.fees   += Number(d.so_fees || 0);
                agg.cogs   += Number(d.so_cogs || 0);
                // Amazon-deducted promotional rebates captured per-order on SO rows
                // (coupons, lightning deals, auto-promos). Subtract from profit
                // just like FEC promotional_rebates.
                agg.promoRebates += Number(d.so_promo_rebates || 0);
              }
            }

            console.log(
              `[SmartFallback:per-day] ${periodId}: ${days.length} days → ` +
              `${agg.daysSO} SO, ${agg.daysFEC} FEC | ` +
              `Smart sales=$${agg.sales.toFixed(2)} | ` +
              `Estimated(SO total)=$${soTotalSales.toFixed(2)} | ` +
              `Reconciled(FEC total)=$${fecTotalSales.toFixed(2)}`
            );
            if (agg.daysFEC > 0) {
              const fecDays = dayChoices.filter(c => c.pick === 'FEC').slice(0, 10);
              console.log('[SmartFallback:per-day] FEC-fallback days (first 10):',
                fecDays.map(c => `${c.day} (SO ${c.soOrders}/FEC ${c.fecOrders})`).join(', ')
              );
            }

            // Apply per-day aggregates onto baseline (preserves expenses, labels, etc.)
            if (days.length > 0) {
              // Smart mode baseline has expenses=0. For accounting periods (MTD,
              // this_month, last_month, custom) we must fetch indirect expenses
              // from the expenses table so netProfit subtracts them — matches
              // what fetchSellerboardModeStat / fetchHistoricalPeriodStat do.
              let expenses = Number(baseline.expenses || 0);
              const isAccountingPeriod =
                periodId === 'month_to_date' ||
                periodId === 'this_month' ||
                periodId === 'last_month' ||
                periodId === 'custom';
              if (isAccountingPeriod && userId) {
                try {
                  const { data: expenseData } = await supabase
                    .from('expenses')
                    .select('amount, frequency, expense_date, end_date')
                    .eq('user_id', userId);
                  if (expenseData) {
                    const rangeStart = new Date(range.start + 'T00:00:00');
                    const rangeEnd = new Date(range.end + 'T23:59:59');
                    let totalExpenses = 0;
                    for (const e of expenseData) {
                      const eDate = new Date((e as any).expense_date + 'T00:00:00');
                      const eEnd = (e as any).end_date ? new Date((e as any).end_date + 'T23:59:59') : null;
                      if ((e as any).frequency === 'one_time' && eDate >= rangeStart && eDate <= rangeEnd) {
                        totalExpenses += Number((e as any).amount || 0);
                      } else if ((e as any).frequency === 'monthly') {
                        const expEnd = eEnd || new Date('2099-12-31');
                        if (eDate <= rangeEnd && expEnd >= rangeStart) {
                          totalExpenses += Number((e as any).amount || 0);
                        }
                      }
                    }
                    expenses = totalExpenses;
                    console.log(`[SmartFallback:per-day] ${periodId}: indirect expenses=$${expenses.toFixed(2)}`);
                  }
                } catch (expErr) {
                  console.warn(`[SmartFallback:per-day] ${periodId}: failed to fetch expenses`, expErr);
                }
              }
              const grossProfit = agg.sales + agg.shippingCredits - agg.promoRebates - agg.fees - agg.refunds - agg.cogs;
              const netProfit = grossProfit - expenses;
              const estPayout = agg.sales + agg.shippingCredits - agg.fees - agg.refunds;

              // PERF: Reuse fee components already fetched by the fast-first
              // path (baseline.feeBreakdown / baseline.recordFees). Skip the
              // duplicate FEC RPC that was making MTD slow. If detailed FEC is
              // not loaded yet, use order-record itemization for the popup and
              // keep any residual as "Other Amazon order fees" instead of
              // mislabeling the whole total as an FBA fee.
              const baselineFb = baseline.feeBreakdown;
              const baselineHasFec = baselineFb && (
                Number(baselineFb.eventCount || 0) > 0 ||
                Number(baselineFb.referralFee || 0) > 0 ||
                Number(baselineFb.fbaFulfillmentFee || 0) > 0 ||
                Number(baselineFb.storageFees || 0) > 0
              );
              const baselineRecordFees = baseline.recordFees || EMPTY_RECORD_FEES;
              const baselineRecordItemizedFees =
                Number(baselineRecordFees.fbaFee || 0) +
                Number(baselineRecordFees.referralFee || 0) +
                Number(baselineRecordFees.closingFee || 0);

              // P&L itemization contract: keep ALL itemized FEC categories;
              // park any aggregate gap into amazonOtherFees so the popup never
              // shows "everything is FBA fulfillment fee".
              const feeBreakdownSource = baselineHasFec ? 'SmartFallback:FEC' : 'SmartFallback:SO estimated';
              let unknownResidualFee = 0;
              const feeBreakdownForPopup = baselineHasFec
                ? (() => {
                    const fb = { ...baselineFb! };
                    const itemized =
                      Number(fb.fbaFulfillmentFee || 0) + Number(fb.referralFee || 0) +
                      Number(fb.variableClosingFee || 0) + Number(fb.fixedClosingFee || 0) +
                      Number(fb.storageFees || 0) + Number(fb.removalFees || 0) +
                      Number(fb.disposalFees || 0) + Number(fb.longTermStorageFees || 0) +
                      Number(fb.fbaCustomerReturnFee || 0) + Number(fb.digitalServicesFee || 0) +
                      Number(fb.inboundTransportation || 0) + Number(fb.liquidationsBrokerageFee || 0) +
                      Number(fb.compensatedClawback || 0) + Number(fb.hrrNonApparelRollup || 0) +
                      Number(fb.reCommerceGradingCharge || 0) + Number(fb.otherFees || 0) +
                      Number(fb.amazonOtherFees || 0) + Number(fb.inboundDelta || 0);
                    const gap = agg.fees - itemized;
                    unknownResidualFee = Math.max(0, gap);
                    if (gap > 0.5) fb.amazonOtherFees = Number(fb.amazonOtherFees || 0) + gap;
                    fb.totalFees = Math.max(agg.fees, itemized + Math.max(0, gap));
                    fb.netAmazonFees = fb.totalFees - Number(fb.totalCredits || 0);
                    return fb;
                  })()
                : await (async () => {
                    // FEC fee breakdown unavailable. Itemize from sales_orders
                    // per-category (deduped against FEC settled order_ids) so the
                    // popup shows FBA / Referral / Closing breakdown instead of a
                    // single collapsed "Amazon order fees" lump. Any residual
                    // (unknown categories from estimated SO totals) goes to
                    // amazonOtherFees only.
                    let soFba = Number(baselineRecordFees.fbaFee || 0);
                    let soRef = Number(baselineRecordFees.referralFee || 0);
                    let soClo = Number(baselineRecordFees.closingFee || 0);
                    let soTot = soFba + soRef + soClo;

                    if (soTot <= 0 && userId) {
                      try {
                        const soRows = await fetchAllPages<any>(() => {
                          let q = supabase
                            .from('sales_orders')
                            .select('order_id, fba_fee, referral_fee, closing_fee, total_fees, is_cancelled, order_status, order_type, total_sale_amount, sold_price')
                            .eq('user_id', userId)
                            .gte('order_date', range.start)
                            .lte('order_date', range.end)
                            .order('order_date', { ascending: true });
                          if (Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
                            const mktConds = selectedMarketplaces.map((m) => `marketplace.eq.${m}`);
                            if (selectedMarketplaces.includes('US')) mktConds.push('marketplace.is.null');
                            q = q.or(mktConds.join(','));
                          }
                          return q;
                        }, { label: `drill SO ${periodId}` });
                        const valid = (soRows || []).filter((r: any) => {
                          const cancelled = r.is_cancelled === true;
                          const status = String(r.order_status || '').toLowerCase();
                          const orderType = String(r.order_type || '').toLowerCase();
                          const isReplacement = orderType.includes('replacement');
                          const hasSales = Number(r.total_sale_amount || r.sold_price || 0) > 0;
                          return !cancelled && status !== 'canceled' && status !== 'cancelled' && !isReplacement && hasSales;
                        });
                        for (const r of valid) {
                          soFba += Math.abs(Number(r.fba_fee || 0));
                          soRef += Math.abs(Number(r.referral_fee || 0));
                          soClo += Math.abs(Number(r.closing_fee || 0));
                          soTot += Math.abs(Number(r.total_fees || 0));
                        }
                        console.log(`[SmartFallback:per-day] ${periodId}: SO itemization fallback — fba=$${soFba.toFixed(2)} ref=$${soRef.toFixed(2)} clo=$${soClo.toFixed(2)} tot=$${soTot.toFixed(2)}`);
                      } catch (soErr) {
                        console.warn(`[SmartFallback:per-day] ${periodId}: SO itemization fallback failed`, soErr);
                      }
                    }

                    const itemized = soFba + soRef + soClo;
                    // Use agg.fees as the authoritative total (already deduped
                    // by per-day Smart routing). Park any unknown residual into
                    // amazonOtherFees so each labeled category remains intact.
                    const residual = Math.max(0, agg.fees - itemized);
                    unknownResidualFee = residual;
                    return {
                      ...EMPTY_FEE_BREAKDOWN,
                      dateRangeUsed: baselineFb?.dateRangeUsed || `${range.start} to ${range.end}`,
                      fbaFulfillmentFee: soFba,
                      referralFee: soRef,
                      variableClosingFee: soClo,
                      amazonOtherFees: residual,
                      totalFees: agg.fees,
                      netAmazonFees: agg.fees,
                      eventCount: itemized > 0 ? 1 : days.length,
                    };
                  })();

              if (baselineHasFec) {
                console.log(`[SmartFallback:per-day] ${periodId}: reusing FEC components from fast-first (skipped duplicate RPC)`);
              }
              console.log(`[SmartFallback:per-day] ${periodId}: feeBreakdown before render`, {
                feeBreakdownSource,
                unknownResidualFee,
                totalFees: feeBreakdownForPopup.totalFees,
                itemizedFees: getItemizedFeeBreakdownTotal(feeBreakdownForPopup),
                feeBreakdown: feeBreakdownForPopup,
              });

              stat = {
                ...baseline,
                sales: agg.sales,
                orders: agg.orders,
                units: agg.units,
                refundAmount: agg.refunds,
                totalFees: agg.fees,
                totalCost: agg.cogs,
                fbaFee: feeBreakdownForPopup.fbaFulfillmentFee,
                referralFee: feeBreakdownForPopup.referralFee,
                closingFee: feeBreakdownForPopup.variableClosingFee + feeBreakdownForPopup.fixedClosingFee,
                recordFees: {
                  ...baselineRecordFees,
                  totalFees: agg.fees,
                  fbaFee: feeBreakdownForPopup.fbaFulfillmentFee,
                  referralFee: feeBreakdownForPopup.referralFee,
                  closingFee: feeBreakdownForPopup.variableClosingFee + feeBreakdownForPopup.fixedClosingFee,
                },
                feeBreakdownSource,
                unknownResidualFee,
                feeBreakdown: feeBreakdownForPopup,
                grossProfit,
                netProfit,
                estPayout,
                roi: agg.cogs > 0 ? (grossProfit / agg.cogs) * 100 : 0,
                margin: agg.sales > 0 ? (grossProfit / agg.sales) * 100 : 0,
                refundPercent: agg.sales > 0 ? (agg.refunds / agg.sales) * 100 : 0,
                avgOrderValue: agg.orders > 0 ? agg.sales / agg.orders : 0,
                avgUnitPrice: agg.units > 0 ? agg.sales / agg.units : 0,
                profitPerUnit: agg.units > 0 ? netProfit / agg.units : 0,
                expenses,
                netSalesBreakdown: {
                  grossSales: agg.sales,
                  promotionalRebates: agg.promoRebates,
                  shippingCredits: agg.shippingCredits,
                  giftWrapCredits: agg.giftWrapCredits,
                  netSales: agg.sales - agg.promoRebates - agg.refunds,
                },
              };

              // CRITICAL: If Smart used FEC for any day, FEC refunds are already
              // authoritative for those days. Skip the live-refund overlay entirely
              // to prevent double attribution / source mixing across days.
              if (agg.daysFEC > 0) {
                console.log(`[SmartFallback:per-day] ${periodId}: skipping liveRefunds overlay (used FEC for ${agg.daysFEC} day(s) — FEC refunds are authoritative)`);
                recordSuccess(PERIOD_STATS_QUERY_KEY);
                return stat;
              }
            } else {
              throw new Error(`Smart RPC returned no daily rows for ${periodId}`);
            }
          } catch (perDayErr) {
            console.error('[SmartFallback:per-day] resolver failed', perDayErr);
            throw perDayErr;
          }
        }
      }

      if (!stat) return null;

      recordSuccess(PERIOD_STATS_QUERY_KEY);
      // Overlay live refunds from API (includes deferred refunds the RPCs miss).
      // Only reached for: Estimated/Reconciled modes, or Smart with 100% SO days.
      return overlayLiveRefunds(stat, range);
    } catch (error) {
      if (isTimeoutError(error)) {
        recordFailure(PERIOD_STATS_QUERY_KEY);
      }
      throw error;
    }

  }, [
    dateRanges,
    salesMode,
    fetchHistoricalPeriodStat,
    fetchSellerboardModeStat,
    fetchParityModeStat,
    overlayLiveRefunds,
    pressureActive,
    isQueryCircuitOpen,
    recordFailure,
    recordSuccess,
  ]);

  // Re-overlay liveRefunds onto all period stats when liveRefunds data arrives/updates
  // (liveRefunds often load after the initial RPC fetch completes).
  // SKIPS Smart mode entirely — Smart's per-day resolver already routes refunds
  // by source (FEC days use FEC refunds, SO days use SO refunds). Re-overlaying
  // live refunds would mix sources and inflate refund attribution on FEC days.
  useEffect(() => {
    if (!liveRefunds || liveRefunds.length === 0) return;
    if (stats.size === 0) return;
    if (salesMode === 'smart') return;

    setStats(prev => {
      let changed = false;
      const next = new Map(prev);

      for (const [periodId, stat] of prev) {
        if (periodId === 'today' || periodId === 'yesterday' || periodId === 'custom') continue;
        const range = dateRanges[periodId as keyof typeof dateRanges];
        if (!range) continue;

        const updated = overlayLiveRefunds(stat, range);
        if (updated !== stat) {
          traceSummaryWrite('liveRefunds-overlay', periodId, updated);
          next.set(periodId, updated);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [liveRefunds, dateRanges, overlayLiveRefunds, stats.size, salesMode, traceSummaryWrite]);

  const buildEmptyPeriodStat = useCallback((periodId: string): PeriodStat | null => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!periodDef || !range) return null;

    return {
      id: periodId,
      label: periodDef.label,
      sublabel: range.label,
      dateLabel: range.dateLabel,
      sales: 0,
      orders: 0,
      units: 0,
      refunds: 0,
      refundAmount: 0,
      refundedReferralFee: 0,
      advCost: 0,
      estPayout: 0,
      grossProfit: 0,
      netProfit: 0,
      fbaFee: 0,
      referralFee: 0,
      closingFee: 0,
      totalFees: 0,
      uncategorizedFees: 0,
      recordFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0 },
      perAsinFees: [],
      debugDirectDbFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0, recordCount: 0, recordsWithFees: 0, estimatedFees: 0, estimatedFba: 0, estimatedReferral: 0, recordsWithEstimates: 0, recordsMissingBoth: 0, missingAsins: [] },
      totalCost: 0,
      roi: 0,
      margin: 0,
      refundPercent: 0,
      avgOrderValue: 0,
      avgUnitPrice: 0,
      profitPerUnit: 0,
      salesChange: undefined,
      profitChange: undefined,
      expenses: 0,
      inboundFees: 0,
      inboundFeesCount: 0,
      cancelledOrders: 0,
      pendingStatusCheck: 0,
      feeBreakdownSource: 'blank',
      unknownResidualFee: 0,
      feeBreakdown: {
        ...EMPTY_FEE_BREAKDOWN,
        dateRangeUsed: `${range.start} to ${range.end}`,
      },
      refundsFromCache: { ...EMPTY_REFUND_BREAKDOWN },
      debug: {
        rowsUsedForPopupFeesCount: 0,
        sumTotalFees: 0,
        sumItemizedFees: 0,
        difference: 0,
        countTotalFeesNullOrZero: 0,
        mismatchRows: [],
        financialEventsCount: 0,
        dateRangeWithCutoff: `[${range.start}, ${range.end}] (fallback empty)`,
      },
    };
  }, [dateRanges]);

  // Load a single period
  const loadPeriod = useCallback(async (periodId: string) => {
    // Use ref to avoid stale closure on loadingPeriods state
    if (loadingPeriodsRef.current.has(periodId)) return;
    
    loadingPeriodsRef.current.add(periodId);
    setLoadingPeriods(prev => new Set(prev).add(periodId));
    
    try {
      const stat = await fetchPeriodStat(periodId);
      const resolvedStat = stat;
      if (resolvedStat) {
        setStats(prev => {
          const next = new Map(prev);
          traceSummaryWrite('loadPeriod', periodId, resolvedStat);
          next.set(periodId, resolvedStat);
          // STALE-WHILE-REVALIDATE: Update previous stats ref for next refresh
          previousStatsRef.current = new Map(next);
          return next;
        });
        writeStatToCache(periodId, resolvedStat);
        setPeriodErrors(prev => {
          if (!prev.has(periodId)) return prev;
          const next = new Map(prev);
          next.delete(periodId);
          return next;
        });
      } else {
        setPeriodErrors(prev => new Map(prev).set(periodId, `Could not load ${getPeriodDef(periodId)?.label || 'period'} totals.`));
      }
    } catch (err: any) {
      console.error(`[PeriodStatsBlocks] Failed to load ${periodId}:`, err);
      setPeriodErrors(prev => new Map(prev).set(periodId, err?.message || `Could not load ${getPeriodDef(periodId)?.label || 'period'} totals.`));
    } finally {
      loadingPeriodsRef.current.delete(periodId);
      setLoadingPeriods(prev => {
        const next = new Set(prev);
        next.delete(periodId);
        return next;
      });
    }
  }, [fetchPeriodStat]);

  // Calculate comparison percentages when we have both MTD and last_month
  const updateComparisons = useCallback((currentStats: Map<string, PeriodStat>) => {
    const mtd = currentStats.get("month_to_date");
    const lastMonth = currentStats.get("last_month");
    const thisForecast = currentStats.get("this_month");

    if (mtd && lastMonth && lastMonth.sales > 0) {
      const todayDate = new Date(getTodayLocalDate() + "T12:00:00");
      const dayOfMonth = todayDate.getDate();
      const lastMonthProportional = lastMonth.sales * (dayOfMonth / 30);

      if (lastMonthProportional > 0) {
        mtd.salesChange = ((mtd.sales - lastMonthProportional) / lastMonthProportional) * 100;
      }
      if (lastMonth.netProfit !== 0) {
        const lastProfitProportional = lastMonth.netProfit * (dayOfMonth / 30);
        if (lastProfitProportional !== 0) {
          mtd.profitChange = ((mtd.netProfit - lastProfitProportional) / Math.abs(lastProfitProportional)) * 100;
        }
      }
    }

    if (thisForecast && lastMonth && lastMonth.sales > 0) {
      thisForecast.salesChange = ((thisForecast.sales - lastMonth.sales) / lastMonth.sales) * 100;
      if (lastMonth.netProfit !== 0) {
        thisForecast.profitChange = ((thisForecast.netProfit - lastMonth.netProfit) / Math.abs(lastMonth.netProfit)) * 100;
      }
    }
  }, []);

  // Stable reference for buyBoxPricesMap to prevent excessive re-renders
  // Only re-fetch if the count of entries changes significantly
  const buyBoxPricesCount = buyBoxPricesMap.size;
  
  // Build cache key for a period
  // IMPORTANT: Include refreshKey so "Refresh Data" forces new cache entries
  const buildCacheKey = useCallback((periodId: string): PeriodCacheKey | null => {
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!range) return null;
    
    return {
      userId,
      sellerId,
      marketplaceId,
      dateStart: range.start,
      dateEnd: range.end,
      // Cache-bust version tag to avoid serving older cached totals computed with legacy logic
      timezoneCutoff: 'amazon_day_2am|marketplace_fees_v2',
      includeSettled,
      hideDeferred,
      // Include refreshKey so MTD cache invalidates when user clicks Refresh Data
      refreshKey,
    };
  }, [userId, sellerId, marketplaceId, dateRanges, includeSettled, hideDeferred, refreshKey]);
  
  // Convert cache totals to PeriodStat for instant display
  const cacheTotalsToStat = useCallback((periodId: string, cached: PeriodCacheTotals): PeriodStat | null => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!periodDef || !range) return null;
    
    const isForecast = "isForecast" in range && (range as any).isForecast;
    const multiplier = isForecast && "forecastMultiplier" in range ? (range as any).forecastMultiplier : 1;
    
    const sales = cached.sales_total * multiplier;
    const fees = cached.amazon_fees_total * multiplier;
    const cogs = cached.cogs_total * multiplier;
    const refundCost = cached.refund_cost_total * multiplier;
    const grossProfit = cached.gross_profit * multiplier;
    const netProfit = cached.net_profit * multiplier;
    const orders = cached.row_count * (isForecast ? multiplier : 1);
    
    return {
      id: periodId,
      label: periodDef.label,
      sublabel: range.label,
      dateLabel: range.dateLabel,
      sales,
      orders,
      units: orders, // Approximate
      refunds: 0, // Not stored in cache yet
      refundAmount: refundCost, // Approximate
      refundedReferralFee: 0,
      advCost: 0,
      estPayout: sales - fees - refundCost,
      grossProfit,
      netProfit,
      fbaFee: cached.fba_fee_total * multiplier,
      referralFee: cached.referral_fee_total * multiplier,
      closingFee: cached.closing_fee_total * multiplier,
      totalFees: fees,
      uncategorizedFees: 0,
      recordFees: {
        totalFees: cached.amazon_fees_total * multiplier,
        fbaFee: cached.fba_fee_total * multiplier,
        referralFee: cached.referral_fee_total * multiplier,
        closingFee: cached.closing_fee_total * multiplier,
      },
      perAsinFees: [],
      debugDirectDbFees: { totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0, recordCount: 0, recordsWithFees: 0, estimatedFees: 0, estimatedFba: 0, estimatedReferral: 0, recordsWithEstimates: 0, recordsMissingBoth: 0, missingAsins: [] },
      totalCost: cogs,
      roi: cogs > 0 ? (grossProfit / cogs) * 100 : 0,
      margin: sales > 0 ? (grossProfit / sales) * 100 : 0,
      refundPercent: sales > 0 ? (refundCost / sales) * 100 : 0,
      avgOrderValue: orders > 0 ? sales / orders : 0,
      avgUnitPrice: orders > 0 ? sales / orders : 0,
      profitPerUnit: orders > 0 ? netProfit / orders : 0,
      expenses: 0, // Not stored in cache yet
      inboundFees: 0, // Not stored in cache yet
      inboundFeesCount: 0,
      cancelledOrders: 0, // Not stored in cache yet
      pendingStatusCheck: 0, // Not stored in cache yet
      feeBreakdown: {
        fbaFulfillmentFee: 0,
        referralFee: 0,
        inboundTransportation: 0,
        variableClosingFee: 0,
        fixedClosingFee: 0,
        storageFees: 0,
        removalFees: 0,
        disposalFees: 0,
        longTermStorageFees: 0,
        digitalServicesFee: 0,
        liquidationsBrokerageFee: 0,
        compensatedClawback: 0,
        hrrNonApparelRollup: 0,
        reCommerceGradingCharge: 0,
        fbaCustomerReturnFee: 0,
        otherFees: 0,
        amazonOtherFees: 0,
        inboundDelta: 0,
        freeReplacementRefundItems: 0,
        liquidationsRevenue: 0,
        warehouseDamage: 0,
        warehouseLost: 0,
        reversalReimbursement: 0,
        otherReimbursements: 0,
        otherIncome: 0,
        totalFees: 0,
        totalCredits: 0,
        netAmazonFees: 0,
        eventCount: 0,
        dateRangeUsed: '',
      },
      refundsFromCache: {
        refundedAmount: 0,
        refundedReferralFee: 0,
        refundedOtherFees: 0,
        refundEventCount: 0,
      },
      debug: {
        rowsUsedForPopupFeesCount: cached.row_count,
        sumTotalFees: fees,
        sumItemizedFees: fees,
        difference: 0,
        countTotalFeesNullOrZero: 0,
        mismatchRows: [],
        financialEventsCount: 0,
        dateRangeWithCutoff: '',
      },
    };
  }, [dateRanges]);
  
  // Save stat to cache — DISABLED: caching temporarily removed for stability
  const saveStatToCache = useCallback(async (_stat: PeriodStat) => {
    // No-op: caching disabled until totals are stable
  }, []);
  
  // Force refresh handler - STALE-WHILE-REVALIDATE pattern
  const handleForceRefresh = useCallback(async () => {
    // ─── LAZY MODEL: Force Refresh only refetches the SELECTED tab ───
    // Avoids re-running heavy Smart Fallback for hidden periods.
    const allPeriods = ['today', 'yesterday', 'month_to_date', 'this_month', 'last_month', 'custom'];
    const periodToRefresh = allPeriods.includes(selectedPeriod) ? selectedPeriod : 'today';
    if (periodToRefresh === 'custom' && (!customStartDate || !customEndDate)) {
      toast.info('Choose custom dates first');
      return;
    }

    console.log(`[PeriodStatsBlocks] handleForceRefresh — refreshing only "${periodToRefresh}"`);
    setForceRefreshing(true);
    setIsRefreshing(true);
    toast.info(`Refreshing ${getPeriodDef(periodToRefresh)?.label || periodToRefresh}...`);

    const generation = ++fetchGenerationRef.current;

    try {
      // Invalidate cache key for the selected period+mode so SWR can't serve stale.
      const invKey = cacheKeyFor.current(periodToRefresh);
      if (invKey) periodStatsCache.invalidate(invKey);

      loadingPeriodsRef.current.add(periodToRefresh);
      setLoadingPeriods(prev => new Set([...prev, periodToRefresh]));

      const stat = await fetchPeriodStat(periodToRefresh);
      if (fetchGenerationRef.current !== generation) return;

      if (stat) {
        const refreshedStat = { ...stat, id: periodToRefresh };
        setStats(prev => {
          const next = new Map(prev);
          traceSummaryWrite('forceRefresh', periodToRefresh, refreshedStat);
          next.set(periodToRefresh, refreshedStat);
          updateComparisons(next);
          return next;
        });
        writeStatToCache(periodToRefresh, refreshedStat);
        await saveStatToCache(stat);
          previousStatsRef.current = new Map(stats).set(periodToRefresh, refreshedStat);
        toast.success(`${getPeriodDef(periodToRefresh)?.label || periodToRefresh} refreshed`);
      } else {
        toast.error('No data returned for this period');
      }

      onForceRefresh?.();
    } catch (err) {
      console.error('[PeriodStatsBlocks] Error force refreshing:', err);
      toast.error('Failed to refresh totals');
    } finally {
      loadingPeriodsRef.current.delete(periodToRefresh);
      setLoadingPeriods(prev => {
        const next = new Set(prev);
        next.delete(periodToRefresh);
        return next;
      });
      setForceRefreshing(false);
      setIsRefreshing(false);
    }
  }, [fetchPeriodStat, saveStatToCache, updateComparisons, onForceRefresh, selectedPeriod, customStartDate, customEndDate, stats]);

  // Deferred force refresh: triggered by refreshKey change (Hard Refresh button)
  useEffect(() => {
    if (pendingForceRefresh) {
      setPendingForceRefresh(false);
      handleForceRefresh();
    }
  }, [pendingForceRefresh, handleForceRefresh]);

  // Sellerboard-style: ensure Last Month (settled) has the underlying financial_events_cache populated.
  // The normal "Refresh Data" button on the Sales page syncs Orders API data, not settled Financial Events.
  const handleSyncSettledForPeriod = useCallback(async (e: React.MouseEvent, periodId: string) => {
    e.stopPropagation();

    const range = dateRanges[periodId as keyof typeof dateRanges];
    if (!range) return;

    if (settledSyncingPeriod) return;
    setSettledSyncingPeriod(periodId);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Please log in');
        return;
      }

      toast.info(`Syncing settled Amazon data for ${range.label}...`);

      // Clear ONLY the month we are syncing so we can safely backfill it.
      // Use full-day ISO bounds so we delete the same range we resync.
      const startIso = `${range.start}T00:00:00.000Z`;
      const endIso = `${range.end}T23:59:59.999Z`;

      const { error: deleteError } = await supabase
        .from('financial_events_cache')
        .delete()
        .eq('user_id', userId)
        .gte('event_date', startIso)
        .lte('event_date', endIso);

      if (deleteError) throw new Error(deleteError.message);

      const response = await supabase.functions.invoke('fetch-profit-loss', {
        body: {
          startDate: `${range.start}T00:00:00.000Z`,
          endDate: `${range.end}T23:59:59.999Z`,
          forceRefresh: true,
        },
      });

      if (response.error) throw new Error(response.error.message);

      const progressId = (response.data as any)?.progressId as string | undefined;
      if (progressId) {
        // Poll for up to 5 minutes (300 seconds) as large months can take 2-3 minutes to sync
        const startedAt = Date.now();
        const maxWaitMs = 5 * 60 * 1000;
        let lastStatus = '';
        while (Date.now() - startedAt < maxWaitMs) {
          await new Promise(r => setTimeout(r, 3000));
          const { data: progressRow } = await supabase
            .from('pl_sync_progress')
            .select('status, message')
            .eq('id', progressId)
            .maybeSingle();

          lastStatus = (progressRow as any)?.status as string || '';
          const message = (progressRow as any)?.message as string || '';
          console.log(`[Sync Settled] Progress: ${lastStatus} - ${message}`);
          
          if (lastStatus && lastStatus !== 'running' && lastStatus !== 'continue') break;
        }
        console.log(`[Sync Settled] Final status: ${lastStatus}`);
      } else {
        // No progressId means the edge function returned immediately (cache-only or quick sync).
        // Wait a moment for any async writes to complete.
        await new Promise(r => setTimeout(r, 3000));
      }

      // Drop the computed totals cache for this period so we recompute from the newly-filled events.
      const cacheKey = buildCacheKey(periodId);
      if (cacheKey) await invalidateCache([cacheKey]);

      const refreshed = await fetchPeriodStat(periodId);
      if (refreshed) {
        setStats(prev => {
          const next = new Map(prev);
          traceSummaryWrite('settledSync-refresh', periodId, refreshed);
          next.set(periodId, refreshed);
          updateComparisons(next);
          return next;
        });
        writeStatToCache(periodId, refreshed);
        await saveStatToCache(refreshed);
      }

      toast.success('Settled data synced');
    } catch (err: any) {
      console.error('[PeriodStatsBlocks] Settled sync error:', err);
      toast.error(err?.message || 'Failed to sync settled data');
    } finally {
      setSettledSyncingPeriod(null);
    }
  }, [dateRanges, settledSyncingPeriod, userId, buildCacheKey, invalidateCache, fetchPeriodStat, saveStatToCache, updateComparisons]);

  // Full History Sync handler — plan then fire-and-poll each month
  const handleFullHistorySync = useCallback(async (monthKey?: string) => {
    if (historySyncProgress.running) return;
    historySyncAbortRef.current = false;
    
    // If a specific month is provided, sync just that one
    const targetKey = monthKey || `${historySyncSelectedYear}-${String(historySyncSelectedMonth + 1).padStart(2, '0')}`;
    
    setHistorySyncProgress({
      running: true,
      progressId: 'plan',
      currentMonth: 0,
      totalMonths: 1,
      message: `Syncing ${targetKey}...`,
      status: 'running',
    });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Please log in again');
      }

      const headers = { Authorization: `Bearer ${session.access_token}` };

      // Single month execute — fire and poll
      setHistorySyncProgress(prev => ({
        ...prev,
        currentMonth: 1,
        totalMonths: 1,
        message: `Syncing ${targetKey}...`,
        progressId: targetKey,
      }));

      // Fire-and-forget: don't await the response at all.
      // EdgeRuntime.waitUntil holds the HTTP connection open until background
      // work finishes, so both supabase.functions.invoke AND fetch will block.
      // We just fire it and immediately start polling the checkpoint table.
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      fetch(
        `${supabaseUrl}/functions/v1/sync-historical-settled`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': supabaseKey,
          },
          body: JSON.stringify({ months: 1, force: true, mode: 'execute', month_key: targetKey }),
        }
      ).catch(err => console.error('[history-sync] fire-and-forget error:', err));

      // Poll checkpoint + FEC data until done/error (max 5 min)
      // The waitUntil background task may get killed before updating checkpoint,
      // so we also check if financial_events_cache has data for the month as a
      // reliable completion signal.
      const pollStart = Date.now();
      const maxPollMs = 5 * 60 * 1000;
      let finalStatus: string = 'timeout';
      let isFirstPoll = true;
      const [tYear, tMonth] = targetKey.split('-').map(Number);
      const monthStart = `${targetKey}-01`;
      const nextMonth = tMonth === 12
        ? `${tYear + 1}-01-01`
        : `${tYear}-${String(tMonth + 1).padStart(2, '0')}-01`;

      while (Date.now() - pollStart < maxPollMs) {
        if (historySyncAbortRef.current) {
          finalStatus = 'cancelled';
          break;
        }
        if (!isFirstPoll) {
          await new Promise(r => setTimeout(r, 4000));
        }
        isFirstPoll = false;

        if (historySyncAbortRef.current) {
          finalStatus = 'cancelled';
          break;
        }

        // Check 1: checkpoint status
        const { data: cp } = await supabase
          .from('historical_sync_checkpoints')
          .select('status, error_message, updated_at')
          .eq('user_id', session.user.id)
          .eq('sync_type', 'settled')
          .eq('month_key', targetKey)
          .maybeSingle();

        if (cp?.status === 'done') {
          finalStatus = 'done';
          break;
        } else if (cp?.status === 'error') {
          finalStatus = 'error';
          throw new Error(cp.error_message || 'Sync failed');
        }

        // Check 2: if checkpoint is stuck as "running" but FEC data exists,
        // fetch-profit-loss succeeded and waitUntil just got killed.
        // Also handle null checkpoint (RLS issue or row never created)
        if ((!cp || cp?.status === 'running') && Date.now() - pollStart > 15000) {
          const { count } = await supabase
            .from('financial_events_cache')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', session.user.id)
            .gte('event_date', monthStart)
            .lt('event_date', nextMonth);

          if (count && count > 0) {
            // Data exists — mark checkpoint done ourselves
            await supabase
              .from('historical_sync_checkpoints')
              .update({
                status: 'done',
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('user_id', session.user.id)
              .eq('sync_type', 'settled')
              .eq('month_key', targetKey);
            finalStatus = 'done';
            break;
          }
        }
      }

      if (finalStatus === 'done') {
        setHistorySyncProgress(prev => ({
          ...prev,
          running: false,
          status: 'done',
          message: `Successfully synced ${targetKey}`,
        }));
        toast.success(`Synced ${targetKey}`);
        if (onForceRefresh) onForceRefresh();
      } else if (finalStatus === 'cancelled') {
        // User cancelled — state already reset by the cancel button
        return;
      } else {
        // Timeout — but check one more time if FEC data exists (sync may have completed but checkpoint drifted)
        const { count: finalCheck } = await supabase
          .from('financial_events_cache')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', session.user.id)
          .gte('event_date', monthStart)
          .lt('event_date', nextMonth);
        
        if (finalCheck && finalCheck > 0) {
          setHistorySyncProgress(prev => ({
            ...prev,
            running: false,
            status: 'done',
            message: `Successfully synced ${targetKey}`,
          }));
          toast.success(`Synced ${targetKey}`);
          if (onForceRefresh) onForceRefresh();
        } else {
          throw new Error('Sync timed out after 5 minutes');
        }
      }

    } catch (err: any) {
      console.error('[PeriodStatsBlocks] Full history sync error:', err);
      toast.error(err?.message || 'Failed to start history sync');
      setHistorySyncProgress(prev => ({
        ...prev,
        running: false,
        status: 'error',
        message: err?.message || 'Failed to start',
      }));
    }
  }, [historySyncProgress.running, historySyncSelectedMonth, historySyncSelectedYear, onForceRefresh]);

  // Track previous isSyncing value to detect transition from true→false
  const prevIsSyncingRef = useRef(isSyncing);
  
  // Initial load: fetch fresh data from RPC
  useEffect(() => {
    if (!userId) return;

    // Build a filter key to detect when filters change
    const currentFilterKey = `${marketplaceId}|${includeSettled}|${hideDeferred}|${asinSearch || ''}`;
    const filtersChanged = lastFilterKeyRef.current !== currentFilterKey;
    if (filtersChanged) {
      cacheLoadedRef.current = false;
      lastFilterKeyRef.current = currentFilterKey;
    }

    // Increment fetch generation — any in-flight fetches from previous generations are discarded
    const generation = ++fetchGenerationRef.current;

    // ─── FULLY LAZY: only fetch the selected period ───
    const allPeriods = ['today', 'yesterday', 'month_to_date', 'this_month', 'last_month'];
    const periodToLoad = allPeriods.includes(selectedPeriod) ? selectedPeriod : 'today';

    // Watchdog: if the fetch hangs longer than 30s, surface a visible error
    // instead of leaving the user staring at an infinite spinner.
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let softHint: ReturnType<typeof setTimeout> | null = null;

    const loadFresh = async () => {
      // Smart cache: TTL-aware reuse keyed by period+mode+dates+marketplaces.
      // - If a fresh entry exists and Force Refresh wasn't pressed → no fetch.
      // - If a stale entry exists → keep showing it (already hydrated above)
      //   AND fetch quietly in the background ("Updating…" badge).
      const bypassLiveEstimatedCache = salesMode === 'estimated' && (periodToLoad === 'today' || periodToLoad === 'yesterday');
      const cKey = cacheKeyFor.current(periodToLoad);
      const anyCached = cKey && !bypassLiveEstimatedCache ? periodStatsCache.getAny(cKey) : null;
      const cachedHasCollapsedFees = hasCollapsedFeeBreakdown(anyCached?.stat);
      if (cachedHasCollapsedFees) {
        console.warn(`[periodStatsCache] ${periodToLoad}:${salesMode} cached feeBreakdown is collapsed — ignoring cache and fetching itemized categories`);
      }
      if (anyCached && !cachedHasCollapsedFees && !pendingForceRefresh) {
        const cachedStat = { ...anyCached.stat, id: periodToLoad };
        setStats(prev => {
          const next = new Map(prev);
          next.set(periodToLoad, cachedStat);
          previousStatsRef.current = new Map(next);
          return next;
        });
        loadingPeriodsRef.current.delete(periodToLoad);
        setLoadingPeriods(prev => {
          if (!prev.has(periodToLoad)) return prev;
          const next = new Set(prev);
          next.delete(periodToLoad);
          return next;
        });
        setInitialLoadComplete(true);
      }
      const fresh = cKey && !bypassLiveEstimatedCache
        ? periodStatsCache.getFresh(cKey, periodToLoad, salesMode as periodStatsCache.CacheMode)
        : null;
      const freshHasCollapsedFees = hasCollapsedFeeBreakdown(fresh?.stat);
      if (freshHasCollapsedFees) {
        console.warn(`[periodStatsCache] ${periodToLoad}:${salesMode} fresh cache has collapsed feeBreakdown — revalidating`);
      }
      if (fresh && !freshHasCollapsedFees && !filtersChanged && !pendingForceRefresh) {
        console.log(`[periodStatsCache] ${periodToLoad}:${salesMode} fresh cache hit (age ${Math.round((Date.now()-fresh.fetchedAt)/1000)}s) — no fetch`);
        // Ensure stats reflects the cached entry (in case state was wiped).
        setStats(prev => {
          if (prev.get(periodToLoad)) return prev;
          const next = new Map(prev);
          next.set(periodToLoad, { ...fresh.stat, id: periodToLoad });
          return next;
        });
        loadingPeriodsRef.current.delete(periodToLoad);
        setLoadingPeriods(prev => {
          if (!prev.has(periodToLoad)) return prev;
          const next = new Set(prev);
          next.delete(periodToLoad);
          return next;
        });
        setInitialLoadComplete(true);
        return;
      }
      const hasAnyCached = !!anyCached && !cachedHasCollapsedFees && !pendingForceRefresh;
      if (hasAnyCached) {
        // Stale-while-revalidate: cached numbers already on screen, refresh quietly.
        console.log(`[periodStatsCache] ${periodToLoad}:${salesMode} stale → background revalidate`);
        setIsRefreshing(true);
      }

      setInitialLoadComplete(hasAnyCached);

      setPeriodErrors(prev => {
        if (!prev.has(periodToLoad)) return prev;
        const next = new Map(prev);
        next.delete(periodToLoad);
        return next;
      });
      // Only show skeleton when there is no cached stat at all. Stale cache
      // revalidates in the background with the cached block still visible.
      if (!hasAnyCached) {
        loadingPeriodsRef.current = new Set([periodToLoad]);
        setLoadingPeriods(new Set([periodToLoad]));
      }

      const t0 = performance.now();
      console.log(`[SalesReport:perf] fetch ${periodToLoad} started (lazy)`);

      // Per-mode watchdog tuning:
      // - Reconciled  → soft 5s "still loading" hint, hard 45s timeout
      // - Smart MTD/Yesterday → 90s (heavy FEC parity allowed in BG)
      // - everything else → 30s
      const isReconciled = salesMode === 'reconciled' && periodToLoad !== 'today';
      const watchdogMs = isReconciled
        ? 45000
        : (periodToLoad === 'yesterday' || periodToLoad === 'month_to_date')
          ? 90000
          : 30000;

      // Reconciled: after 5s, surface a non-blocking "still loading" hint so the
      // user knows we're working instead of staring at an infinite spinner.
      // (softHint is declared in the outer scope so the cleanup fn can clear it)
      if (isReconciled) {
        softHint = setTimeout(() => {
          if (fetchGenerationRef.current !== generation) return;
          // Only show hint if the period is still loading (no data arrived yet).
          if (!loadingPeriodsRef.current.has(periodToLoad)) return;
          setPeriodErrors(prev => new Map(prev).set(
            periodToLoad,
            `Reconciled (FEC) totals are taking longer than usual. Still loading — no need to refresh.`
          ));
        }, 5000);
      }

      watchdog = setTimeout(() => {
        if (fetchGenerationRef.current !== generation) return;
        console.warn(`[SalesReport:perf] fetch ${periodToLoad} watchdog fired (>${watchdogMs / 1000}s)`);
        setPeriodErrors(prev => new Map(prev).set(
          periodToLoad,
          `Loading ${getPeriodDef(periodToLoad)?.label || periodToLoad} is taking too long. Tap Force Refresh to retry.`
        ));
        loadingPeriodsRef.current.delete(periodToLoad);
        setLoadingPeriods(prev => {
          const next = new Set(prev);
          next.delete(periodToLoad);
          return next;
        });
      }, watchdogMs);

      // Track whether the fast-first SO render succeeded — if it did, we have
      // a usable summary on screen and must NOT surface a Smart-enrich error
      // as "Could not load data" for this period.
      let fastFirstLoaded = false;
      let backgroundRefreshStarted = false;
      try {
        // ─── FAST-FIRST FOR YESTERDAY + MTD (Smart mode) ────────────────────
        // Smart per-day fetch is heavy (SO + FEC + parity). Show the SO-only
        // result immediately, then enrich with Smart in the background.
        const useFastFirst =
          !hasAnyCached &&
          (periodToLoad === 'yesterday' ||
            periodToLoad === 'month_to_date' ||
            periodToLoad === 'custom' ||
            periodToLoad === 'today') &&
            (salesMode === 'smart' || salesMode === 'estimated' || (salesMode === 'reconciled' && periodToLoad === 'today'));
        if (useFastFirst) {
          const tFast = performance.now();
          try {
            const fastStat = await fetchSellerboardModeStat(periodToLoad, { skipGraphParity: true });
            if (fetchGenerationRef.current === generation && fastStat) {
              console.log(`[SalesReport:perf] ${periodToLoad} FAST (SO-only) ready in ${(performance.now() - tFast).toFixed(0)}ms`);
              fastFirstLoaded = true;
              const fastLoadedStat = {
                ...fastStat,
                id: periodToLoad,
                // OPTION 2: dataStage drives the block label.
                // 'fast' = SO/RPC only, Smart enrich still running in background.
                ...(salesMode === 'smart' && (periodToLoad === 'month_to_date' || periodToLoad === 'custom')
                  ? { dataStage: 'fast' as const }
                  : {}),
              };
              setStats(prev => {
                const next = new Map(prev);
                traceSummaryWrite('lazyInitialLoad-fastSO', periodToLoad, fastLoadedStat);
                next.set(periodToLoad, fastLoadedStat);
                previousStatsRef.current = new Map(next);
                updateComparisons(next);
                return next;
              });
              // Only cache fast result when it IS the canonical result (no bg enrich coming).
              if ((fastLoadedStat as any).dataStage !== 'fast') {
                writeStatToCache(periodToLoad, fastLoadedStat);
              }
              // Clear loading flag so the block renders immediately.
              loadingPeriodsRef.current.delete(periodToLoad);
              setLoadingPeriods(prev => {
                if (!prev.has(periodToLoad)) return prev;
                const next = new Set(prev);
                next.delete(periodToLoad);
                return next;
              });
              setInitialLoadComplete(true);
              if (watchdog) { clearTimeout(watchdog); watchdog = null; }
            }
          } catch (fastErr) {
            console.warn(`[SalesReport:perf] ${periodToLoad} fast-first failed, falling back to Smart only`, fastErr);
          }

          // OPTION 2 (MTD + Custom): fast SO is on screen — kick off
          // the heavy Smart enrich in the BACKGROUND so the page never blocks.
          // When it finishes, we patch the block once and label flips to
          // "Smart Fallback — matches Repricer-in-Action".
          // Background enrich: kick off whatever extra data the canonical mode
          // path needs that the fast SO render skipped. The fast SO render NEVER
          // includes FEC fee breakdown — so for any mode that needs the popup
          // breakdown (all modes, all periods) we re-fetch with skipGraphParity=false
          // in the background. Smart MTD/Custom additionally needs the per-day
          // Smart fallback reconciliation, so it goes through fetchPeriodStat.
          const needsBgEnrich =
            (salesMode === 'smart' &&
              (periodToLoad === 'month_to_date' || periodToLoad === 'custom'));
          if (needsBgEnrich && fastFirstLoaded) {
            backgroundRefreshStarted = true;
            const tBg = performance.now();
            // After 5s, flip the label to "Showing fast estimate — Smart update still running"
            // by promoting dataStage to 'fast-stale'. The fast totals stay on screen.
            const staleTimer = setTimeout(() => {
              if (fetchGenerationRef.current !== generation) return;
              setStats(prev => {
                const cur = prev.get(periodToLoad);
                if (!cur || (cur as any).dataStage !== 'fast') return prev;
                const next = new Map(prev);
                next.set(periodToLoad, { ...cur, dataStage: 'fast-stale' as const });
                return next;
              });
            }, 5000);
            (async () => {
              try {
                // BG enrich strategy (FEC fee breakdown is the GOAL):
                // • Always run fetchSellerboardModeStat with skipGraphParity:false
                //   so the FEC component breakdown (referral / FBA / closing /
                //   storage / inbound / removal / disposal / etc) is loaded for
                //   the popup — for Today, Yesterday, MTD, and Custom alike.
                // • For Smart MTD/Custom, ALSO run fetchPeriodStat in parallel
                //   to keep the per-day Smart reconciliation totals (sales /
                //   units / refunds). We then merge: top-level numbers from
                //   the Smart reconcile, fee breakdown from FEC.
                const wantsSmartReconcile =
                  salesMode === 'smart' &&
                  (periodToLoad === 'month_to_date' || periodToLoad === 'custom');

                const [fecStat, smartReconcileStat] = await Promise.all([
                  fetchSellerboardModeStat(periodToLoad, { skipGraphParity: false }),
                  wantsSmartReconcile
                    ? fetchPeriodStat(periodToLoad)
                    : Promise.resolve(null),
                ]);

                clearTimeout(staleTimer);
                if (fetchGenerationRef.current !== generation) return;

                // Pick top-level numbers from Smart reconcile when available;
                // otherwise use the FEC stat. ALWAYS prefer the FEC fee
                // breakdown (it's the itemized one the popup needs).
                const baseStat = smartReconcileStat || fecStat;
                if (!baseStat) return;
                const merged: PeriodStat = {
                  ...baseStat,
                  ...(fecStat?.feeBreakdown
                    ? { feeBreakdown: fecStat.feeBreakdown }
                    : {}),
                  ...(fecStat?.recordFees
                    ? { recordFees: { ...fecStat.recordFees, totalFees: Number(baseStat.totalFees || fecStat.recordFees.totalFees || 0) } }
                    : {}),
                };

                console.log(`[SalesReport:perf] ${periodToLoad} BG-ENRICH (${salesMode}) ready in ${(performance.now() - tBg).toFixed(0)}ms — fec.eventCount=${fecStat?.feeBreakdown?.eventCount ?? 0}`);
                const enrichedStat = {
                  ...merged,
                  id: periodToLoad,
                  dataStage: 'smart' as const,
                };
                setStats(prev => {
                  const next = new Map(prev);
                  traceSummaryWrite('lazyInitialLoad-bgSmartEnrich', periodToLoad, enrichedStat);
                  next.set(periodToLoad, enrichedStat);
                  previousStatsRef.current = new Map(next);
                  updateComparisons(next);
                  return next;
                });
                // Per-day Smart resolver finalize → persist to cache.
                writeStatToCache(periodToLoad, enrichedStat);
              } catch (bgErr) {
                clearTimeout(staleTimer);
                // Background failure is silent — fast SO is already on screen.
                console.warn(`[SalesReport:perf] ${periodToLoad} BG-ENRICH failed (silent, fast SO remains on screen)`, bgErr);
              } finally {
                if (fetchGenerationRef.current === generation) {
                  setIsRefreshing(false);
                }
              }
            })();
            return;
          }

          // Fast-first succeeded and is canonical (today, or estimated MTD) →
          // skip the heavy fetchPeriodStat re-run that would block the UI.
          if (fastFirstLoaded) {
            return;
          }
        }

        const tEnrich = performance.now();
        const stat = await fetchPeriodStat(periodToLoad);
        if (fetchGenerationRef.current !== generation) {
          console.log(`[SalesReport:perf] fetch ${periodToLoad} discarded (stale generation)`);
          return;
        }
        if (stat) {
          if (useFastFirst) {
            console.log(`[SalesReport:perf] ${periodToLoad} ENRICH (Smart) ready in ${(performance.now() - tEnrich).toFixed(0)}ms`);
          }
          console.log(`[SalesReport:key] selected=${selectedPeriod} fetch=${periodToLoad} stat.id=${stat.id} write=${periodToLoad}`);
          setStats(prev => {
            const next = new Map(prev);
            const loadedStat = { ...stat, id: periodToLoad };
            traceSummaryWrite(useFastFirst ? 'lazyInitialLoad-smartEnrich' : 'lazyInitialLoad', periodToLoad, loadedStat);
            // Smart cache: only swap (and persist) if totals actually changed.
            const cKey = cacheKeyFor.current(periodToLoad);
            const existing = prev.get(periodToLoad);
            const totalsChanged = periodStatsCache.totalsDiffer(existing, loadedStat);
            if (cKey && hasAnyCached && existing && !totalsChanged) {
              periodStatsCache.set(cKey, existing);
              return prev;
            }
            if (cKey && totalsChanged) {
              periodStatsCache.set(cKey, loadedStat);
            } else if (cKey && !existing) {
              periodStatsCache.set(cKey, loadedStat);
            }
            next.set(periodToLoad, loadedStat);
            previousStatsRef.current = new Map(next);
            updateComparisons(next);
            return next;
          });
        } else {
          setPeriodErrors(prev => new Map(prev).set(
            periodToLoad,
            `No data returned for ${getPeriodDef(periodToLoad)?.label || 'period'}. Tap Force Refresh to retry.`
          ));
        }
      } catch (err: any) {
        if (fetchGenerationRef.current !== generation) return;
        console.error(`[PeriodStatsBlocks] Error loading ${periodToLoad}:`, err);
        // If fast-first already rendered a usable summary, do not surface the
        // Smart-enrich failure as "Could not load data" — the block has data.
        if (fastFirstLoaded) {
          console.warn(`[PeriodStatsBlocks] ${periodToLoad}: Smart enrich failed but fast-first summary is on screen — suppressing error UI`);
        } else {
          setPeriodErrors(prev => new Map(prev).set(
            periodToLoad,
            err?.message || `Could not load ${getPeriodDef(periodToLoad)?.label || 'period'} totals.`
          ));
        }
      } finally {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (softHint) { clearTimeout(softHint); softHint = null; }
        // If the soft "still loading" hint fired but data did arrive in time,
        // clear it so the user doesn't see a stale "taking longer than usual" msg.
        if (isReconciled) {
          setPeriodErrors(prev => {
            const existing = prev.get(periodToLoad);
            if (!existing || !existing.includes('taking longer than usual')) return prev;
            const next = new Map(prev);
            next.delete(periodToLoad);
            return next;
          });
        }
        // Always clear loading state for this period, regardless of generation,
        // so the spinner never gets stuck.
        loadingPeriodsRef.current.delete(periodToLoad);
        setLoadingPeriods(prev => {
          if (!prev.has(periodToLoad)) return prev;
          const next = new Set(prev);
          next.delete(periodToLoad);
          return next;
        });
        console.log(`[SalesReport:perf] fetch ${periodToLoad} finished in ${(performance.now() - t0).toFixed(0)}ms`);
        setInitialLoadComplete(true);
        if (!backgroundRefreshStarted) setIsRefreshing(false);
      }
    };

    loadFresh();

    return () => {
      if (watchdog) clearTimeout(watchdog);
      if (softHint) clearTimeout(softHint);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, marketplaceId, asinSearch, refreshKey, includeSettled, hideDeferred, selectedPeriod, salesMode]);

  // Background refresh when sync completes (isSyncing goes from true to false)
  useEffect(() => {
    const wassyncing = prevIsSyncingRef.current;
    prevIsSyncingRef.current = isSyncing;
    
    // Only refresh when sync transitions from true → false
    if (!wassyncing || isSyncing) return;
    if (!userId || !initialLoadComplete) return;
    if (pressureActive && isQueryCircuitOpen(PERIOD_STATS_QUERY_KEY)) return;
    
    console.log('[PeriodStatsBlocks] Sync completed, refreshing stats in background');
    
    // New generation for background refresh too
    const generation = ++fetchGenerationRef.current;
    
    const refreshInBackground = async () => {
      // LAZY MODEL: only refresh the currently-visible period after sync.
      const allPeriods = ['today', 'yesterday', 'month_to_date', 'this_month', 'last_month', 'custom'];
      const periodToRefresh = allPeriods.includes(selectedPeriod) ? selectedPeriod : 'today';
      if (periodToRefresh === 'today' || periodToRefresh === 'yesterday' || periodToRefresh === 'month_to_date') return;
      try {
        const stat = await fetchPeriodStat(periodToRefresh);
        if (fetchGenerationRef.current !== generation) return;
        if (stat) {
          const refreshedStat = { ...stat, id: periodToRefresh };
          setStats(prev => {
            const next = new Map(prev);
            traceSummaryWrite('syncComplete-backgroundRefresh', periodToRefresh, refreshedStat);
            next.set(periodToRefresh, refreshedStat);
            updateComparisons(next);
            return next;
          });
          writeStatToCache(periodToRefresh, refreshedStat);
        }
      } catch (err) {
        console.error(`[PeriodStatsBlocks] Background refresh error for ${periodToRefresh}:`, err);
      }
    };
    
    refreshInBackground();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSyncing, pressureActive, isQueryCircuitOpen]);

  // Fetch custom period when custom dates change
  useEffect(() => {
    if (!userId) return;
    if (!customStartDate || !customEndDate) return;
    
    console.log(`[PeriodStatsBlocks] Fetching custom period: ${customStartDate} to ${customEndDate}`);
    
    const fetchCustomPeriod = async () => {
      setLoadingPeriods(prev => new Set([...prev, 'custom']));
      try {
        const stat = await fetchPeriodStat('custom');
        console.log(`[PeriodStatsBlocks] Custom period result:`, stat ? { sales: stat.sales, orders: stat.orders, units: stat.units } : 'null');
        if (stat) {
          const customStat = { ...stat, id: 'custom' as const };
          setStats(prev => {
            const next = new Map(prev);
            next.set('custom', customStat);
            return next;
          });
          writeStatToCache('custom', customStat);
          setPeriodErrors(prev => {
            if (!prev.has('custom')) return prev;
            const next = new Map(prev);
            next.delete('custom');
            return next;
          });
        } else {
          setPeriodErrors(prev => new Map(prev).set('custom', 'Could not load Custom Range totals.'));
        }
      } catch (err: any) {
        console.error('[PeriodStatsBlocks] Error fetching custom period:', err);
        setPeriodErrors(prev => new Map(prev).set('custom', err?.message || 'Could not load Custom Range totals.'));
      } finally {
        setLoadingPeriods(prev => {
          const next = new Set(prev);
          next.delete('custom');
          return next;
        });
      }
    };
    
    fetchCustomPeriod();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, customStartDate, customEndDate, fetchPeriodStat, includeSettled, selectedMarketplaces, asinSearch, hideDeferred]);

  // Buy Box re-fetch effect DISABLED: RPC is now single source of truth for block totals.
  // Buy Box prices don't affect RPC results, so no need to re-fetch periods when they arrive.

  // Sellerboard Mode: refetch Last Month and load comparison data when toggled
  // Sellerboard Mode effect removed - always use live data

  const handleToggleExpand = (e: React.MouseEvent, periodId: string) => {
    e.stopPropagation();
    setExpandedPeriod(expandedPeriod === periodId ? null : periodId);
  };

  const expandedStat = expandedPeriod
    ? stats.get(expandedPeriod) || previousStatsRef.current.get(expandedPeriod)
    : undefined;

  // Block skeleton component
  const BlockSkeleton = ({ periodId }: { periodId: string }) => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];
    
    return (
      <div className="flex-1 min-w-[200px] p-3 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between mb-1">
          <span className="font-semibold text-sm text-foreground">{periodDef?.label}</span>
          <Skeleton className="h-5 w-5" />
        </div>
        <p className="text-xs text-muted-foreground mb-3">{range?.label}</p>
        <div className="space-y-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <div className="pt-2 border-t">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-5 w-20 mt-1" />
          </div>
        </div>
      </div>
    );
  };

  const BlockError = ({ periodId, message }: { periodId: string; message: string }) => {
    const periodDef = getPeriodDef(periodId);
    const range = dateRanges[periodId as keyof typeof dateRanges];

    return (
      <div className="flex-1 min-w-[200px] p-3 rounded-lg border border-destructive/40 bg-destructive/10">
        <div className="flex items-center justify-between mb-1">
          <span className="font-semibold text-sm text-destructive">{periodDef?.label}</span>
          <Info className="h-4 w-4 text-destructive" />
        </div>
        <p className="text-xs text-muted-foreground mb-3">{range?.label}</p>
        <p className="text-sm font-medium text-destructive">Could not load data</p>
        <p className="text-xs text-muted-foreground mt-1">{message}</p>
      </div>
    );
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Period dropdown and Force Refresh button */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4 text-sm">
          {/* Live indicator */}
          <span className="text-foreground font-medium">📊 Live Sales</span>
        </div>
        
        {/* Period dropdown - moved from Filters card */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs">
              <Calendar className="h-3 w-3 mr-1" />
              More Date Options
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 bg-popover z-50">
            <DropdownMenuItem onClick={() => onPeriodSelect('all')}>📊 All (Today + Yesterday + MTD)</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Days</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onPeriodSelect('today')}>Today</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPeriodSelect('yesterday')}>Yesterday</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Months</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onPeriodSelect('month_to_date')}>Month to Date</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPeriodSelect('this_month')}>This Month (Forecast)</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPeriodSelect('last_month')}>Last Month</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        
        <div className="flex items-center gap-2">
          {/* Full History Sync Toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistorySyncExpanded(!historySyncExpanded)}
            disabled={historySyncProgress.running}
            className="text-xs"
            title="Sync settled data for a specific month"
          >
            <History className={cn("h-3 w-3 mr-1", historySyncProgress.running && "animate-pulse")} />
            {historySyncProgress.running ? "Syncing..." : "History Sync"}
          </Button>
          
          <CacheAgeBadge
            cacheKey={cacheKeyFor.current(selectedPeriod)}
            isRefreshing={isRefreshing || forceRefreshing}
            cacheTick={cacheTick}
          />

          <Button
            variant="outline"
            size="sm"
            onClick={handleForceRefresh}
            disabled={forceRefreshing}
            className="text-xs"
          >
            <RefreshCw className={cn("h-3 w-3 mr-1", forceRefreshing && "animate-spin")} />
            {forceRefreshing ? "Refreshing..." : "Force Refresh Totals"}
          </Button>
        </div>
      </div>
      
      {/* Inline History Sync Panel */}
      {historySyncExpanded && (
        <div className="rounded-lg border border-border bg-card p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">History Sync</span>
            </div>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setHistorySyncExpanded(false)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          
          {historySyncProgress.running ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground flex-1">{historySyncProgress.message}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                  onClick={() => {
                    historySyncAbortRef.current = true;
                    setHistorySyncProgress({
                      running: false,
                      progressId: null,
                      currentMonth: 0,
                      totalMonths: 1,
                      message: 'Cancelled',
                      status: 'idle',
                    });
                  }}
                >
                  Cancel
                </Button>
              </div>
              <Progress 
                value={(historySyncProgress.currentMonth / Math.max(historySyncProgress.totalMonths, 1)) * 100} 
                className="h-1.5"
              />
            </div>
          ) : historySyncProgress.status === 'done' ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-green-500">✓</span>
              <span className="text-muted-foreground">{historySyncProgress.message}</span>
            </div>
          ) : historySyncProgress.status === 'error' ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-destructive">✗</span>
              <span className="text-muted-foreground">{historySyncProgress.message}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={historySyncSelectedMonth}
                onChange={(e) => setHistorySyncSelectedMonth(Number(e.target.value))}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i) => (
                  <option key={i} value={i}>{m}</option>
                ))}
              </select>
              <select
                value={historySyncSelectedYear}
                onChange={(e) => setHistorySyncSelectedYear(Number(e.target.value))}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {Array.from({ length: 4 }, (_, i) => new Date().getFullYear() - i).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={() => handleFullHistorySync()}
                className="h-8 text-xs"
              >
                Sync Month
              </Button>
            </div>
          )}
        </div>
      )}
      
      {/* Sellerboard Mode Comparison Banner removed - always use live data */}
      
      <div className="flex flex-wrap gap-3">
        {/* Mobile-friendly: show ONLY the selected period block.
            "All" expands to today + yesterday + month_to_date (legacy multi-block view). */}
        {PERIODS.filter(period => {
          if (period.id === 'all') return false;
          if (selectedPeriod === 'all') {
            return period.id === 'today' || period.id === 'yesterday' || period.id === 'month_to_date';
          }
          // Single-block view: show only the active period
          return period.id === selectedPeriod;
        }).map(period => {
          const stat = stats.get(period.id);
          const range = dateRanges[period.id as keyof typeof dateRanges];
          const blockUsesLiveTableTotals =
            salesMode === 'estimated' &&
            (period.id === 'today' || period.id === 'yesterday') &&
            selectedPeriod === period.id;
          const cachedForRender = !blockUsesLiveTableTotals && cacheKeyFor.current(period.id)
            ? periodStatsCache.getAny(cacheKeyFor.current(period.id)!)
            : null;
          const cachedStat = cachedForRender ? ({ ...cachedForRender.stat, id: period.id } as PeriodStat) : undefined;
          // STALE-WHILE-REVALIDATE: Fall back to previous/cache stats during refresh.
          // This render-time cache read prevents even a one-frame skeleton flash
          // before the period-switch hydration effect runs.
          const previousStat = previousStatsRef.current.get(period.id);
          // Estimated Today/Yesterday must mirror Live Sales: current sales_orders rows,
          // not cached/RPC summaries.
          const tableInstantStat =
            blockUsesLiveTableTotals &&
            tableReady &&
            tablePeriodTotals &&
            range
              ? makeInstantEstimatedStatFromTableTotals(period.id, period, range, tablePeriodTotals)
              : undefined;
          const displayStat = tableInstantStat || (blockUsesLiveTableTotals ? undefined : (stat || previousStat || cachedStat));
          
          const isLoading = loadingPeriods.has(period.id);
          const isSelected = selectedPeriod === period.id || (selectedPeriod === 'all' && (period.id === 'today' || period.id === 'yesterday' || period.id === 'month_to_date'));
          const periodError = periodErrors.get(period.id);
          
          // STALE-WHILE-REVALIDATE: Only show skeleton on truly initial load (no previous data)
          // During refresh, keep showing previous data with a subtle indicator
          const hasPreviousData = !!previousStat || !!cachedStat;
          const showStaleIndicator = isLoading && hasPreviousData;

          // Summary blocks render from period stats only. Records/table totals are table-only state.
          const pinnedToday = false;
          
          // Wait for stat to load - but use previous data if available.
          // For Today, if table isn't ready yet, use pinned authoritative value (no skeleton flicker).
          // If we have an error and no usable stat, ALWAYS show BlockError (do not let
          // a stuck loading flag keep the user on an infinite spinner).
          if (!tableInstantStat && !displayStat && !pinnedToday && periodError) {
            return <BlockError key={period.id} periodId={period.id} message={periodError} />;
          }

          if (!tableInstantStat && (isLoading || !stat) && !displayStat && !pinnedToday) {
            return <BlockSkeleton key={period.id} periodId={period.id} />;
          }

          // Skip rendering if no stat and no pinned Today fallback
          if (!displayStat && !pinnedToday) {
            return <BlockSkeleton key={period.id} periodId={period.id} />;
          }

          const baseStat = displayStat as PeriodStat;
          const effectiveStat: PeriodStat = baseStat;
          
          const periodDateRange = dateRanges[period.id as keyof typeof dateRanges];
          const blockSales = Number(effectiveStat.sales || 0);
          const blockCogs = Number(effectiveStat.totalCost || 0);
          // Live operational periods (Today / Yesterday) must NOT subtract indirect expenses.
          // Indirect expenses only apply to accounting periods (MTD, Custom, Last Month, etc.).
          const isLiveOperationalPeriod = period.id === 'today' || period.id === 'yesterday';
          const blockExpenses = isLiveOperationalPeriod ? 0 : Number(effectiveStat.expenses || 0);

          // Per-block debug — verify each period reads from the same salesMode source.
          // Watch for: sales=$0 with non-zero refunds/fees ⇒ source mixing or missing baseline.
          // Estimated mode mirrors Live Sales: render from the instant table totals
          // as soon as records are available, not from slow reconciliation/FEC paths.
          
          const blockTotals: PeriodTotals = computePeriodTotals({
            periodId: period.id,
            periodStart: periodDateRange?.start || '',
            periodEnd: periodDateRange?.end || '',
            salesPrincipal: blockSales,
            shippingCredits: effectiveStat.netSalesBreakdown?.shippingCredits || 0,
            giftWrapCredits: effectiveStat.netSalesBreakdown?.giftWrapCredits || 0,
            promoRebates: effectiveStat.netSalesBreakdown?.promotionalRebates || 0,
            units: Number(effectiveStat.units || 0),
            orders: Number(effectiveStat.orders || 0),
            refundCount: effectiveStat.refunds,
            amazonFeesNet: getOrderLevelFeesForGrossProfit(
              effectiveStat.feeBreakdown,
              effectiveStat.recordFees,
              Number(effectiveStat.totalFees || 0)
            ),
            feeBreakdown: effectiveStat.feeBreakdown,
            recordFees: effectiveStat.recordFees,
            refundBreakdown: effectiveStat.refundsFromCache || {
              refundedAmount: Number(effectiveStat.refundAmount || 0),
              refundedReferralFee: Number(effectiveStat.refundedReferralFee || 0),
              refundedOtherFees: 0,
              refundEventCount: effectiveStat.refunds,
            },
            cogsTotal: blockCogs,
            expenses: blockExpenses,
            inboundFees: Number(effectiveStat.inboundFees || 0),
          });
          
          const blockOrders = blockTotals.orders;
          const blockUnits = blockTotals.units;
          const blockRefunds = blockTotals.refundCount;
          const blockRefundAmount = blockTotals.refundBreakdown.refundedAmount;
          const blockEstPayout = blockTotals.estPayout;
          const blockTotalFees = effectiveStat.totalFees;
          const salesNotYetCorrected = false;
          const correctedCogs = blockCogs;
          const cogsDelta = 0;

          const blockGrossProfit = blockTotals.grossProfit;
          const blockNetProfit = blockTotals.netProfit;
          const blockFb = blockTotals.feeBreakdown;
          const blockReimbursements = (blockFb?.warehouseLost || 0) + (blockFb?.warehouseDamage || 0)
            + (blockFb?.reversalReimbursement || 0) + (blockFb?.otherReimbursements || 0)
            + (blockFb?.freeReplacementRefundItems || 0) + (blockFb?.liquidationsRevenue || 0)
            + (blockFb?.otherIncome || 0);

          // Debug: warn if raw reimbursement fields exist on the breakdown but rendered total is 0
          // (would indicate a calculation bug between data layer and UI)
          if (blockReimbursements === 0 && blockFb) {
            const rawSum = Math.abs(blockFb.warehouseLost || 0) + Math.abs(blockFb.warehouseDamage || 0)
              + Math.abs(blockFb.reversalReimbursement || 0) + Math.abs(blockFb.otherReimbursements || 0)
              + Math.abs(blockFb.freeReplacementRefundItems || 0) + Math.abs(blockFb.liquidationsRevenue || 0)
              + Math.abs(blockFb.otherIncome || 0);
            if (rawSum > 0) {
              console.warn(`[PeriodBlocks][${period.id}] Reimbursement events exist but not rendered`, blockFb);
            }
          }

          const isProfit = blockNetProfit >= 0;

          return (
            <div 
              key={period.id}
              onClick={() => {
                // Allow clicking any period block to switch the table view
                if (salesNotYetCorrected) return;
                
                if (period.id !== 'custom' && showCustomBlock) {
                  setShowCustomBlock(false);
                  setPendingCustomStart('');
                  setPendingCustomEnd('');
                  if (onCustomStartDateChange && onCustomEndDateChange) {
                    onCustomStartDateChange('');
                    onCustomEndDateChange('');
                  }
                }
                onPeriodSelect(period.id);
              }}
              className={cn(
                "flex-1 min-w-[200px] p-3 rounded-lg border transition-all relative overflow-hidden",
                salesNotYetCorrected
                  ? "cursor-not-allowed animate-[breathing_2s_ease-in-out_infinite]"
                  : "cursor-pointer hover:shadow-md",
                // Always highlight the 3 persistent blocks; other periods only when selected
                (period.id === 'today' || period.id === 'yesterday' || period.id === 'month_to_date' || isSelected)
                  ? "border-primary bg-primary/5 ring-2 ring-primary/20" 
                  : "border-border bg-card hover:border-primary/50"
              )}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-1">
                <span className={cn(
                  "font-semibold text-sm",
                  (period.id === 'today' || period.id === 'yesterday' || period.id === 'month_to_date' || isSelected) ? "text-primary" : "text-foreground"
                )}>
                  {effectiveStat.label}
                </span>
                <div className="flex items-center gap-1">
                  {/* STALE-WHILE-REVALIDATE: Show "Updating..." indicator when refreshing with stale data */}
                  {(showStaleIndicator || (!tableReady && hasPreviousData)) && (
                    <span className="text-[10px] bg-amber-500/20 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded animate-pulse">
                      Updating...
                    </span>
                  )}
                  {/* OPTION 2 data-stage label: shows whether the block is on the
                      fast SO/RPC estimate or the final Smart Fallback (matches
                      Repricer-in-Action graph). Only visible for MTD/Custom
                      in Smart mode. */}
                  {salesMode === 'smart' &&
                    (period.id === 'month_to_date' || period.id === 'custom') &&
                    (effectiveStat as any).dataStage === 'fast' && (
                      <span
                        className="text-[10px] bg-blue-500/15 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded animate-pulse"
                        title="Showing fast SO/RPC totals while Smart Fallback (matches Repricer-in-Action graph) finishes in the background."
                      >
                        Fast estimate — updating to Smart…
                      </span>
                    )}
                  {salesMode === 'smart' &&
                    (period.id === 'month_to_date' || period.id === 'custom') &&
                    (effectiveStat as any).dataStage === 'fast-stale' && (
                      <span
                        className="text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded"
                        title="Smart reconciliation is taking longer than 5s. Fast SO totals stay on screen — Smart will update them when ready."
                      >
                        Showing fast estimate — Smart update still running
                      </span>
                    )}
                  {salesMode === 'smart' &&
                    (period.id === 'month_to_date' || period.id === 'custom') &&
                    (effectiveStat as any).dataStage === 'smart' && (
                      <span
                        className="text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded"
                        title="Smart Fallback complete. These totals match the Repricer-in-Action graph (Order Date for live windows, Settlement Date for fully closed periods)."
                      >
                        Smart Fallback — matches Repricer-in-Action
                      </span>
                    )}
                  {showEstimatedPrices && buyBoxPricesMap.size > 0 && (
                    <span className="text-[10px] bg-blue-500/20 text-blue-500 px-1.5 py-0.5 rounded">
                      Est
                    </span>
                  )}
                  {period.id === 'this_month' && (
                    <span className="text-[10px] bg-blue-500/20 text-blue-500 px-1.5 py-0.5 rounded">
                      Forecast
                    </span>
                  )}
                  
                  {/* Sellerboard Mode indicator removed */}

                  {/* Sync Settled button for Last Month and Custom */}
                  {(period.id === 'last_month' || period.id === 'custom') && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-3 gap-2 text-xs font-medium"
                      onClick={(e) => handleSyncSettledForPeriod(e, period.id)}
                      disabled={settledSyncingPeriod !== null}
                      title={`Sync settled (Sellerboard) data for ${period.id === 'custom' ? 'this date range' : 'this month'}`}
                    >
                      <RefreshCw className={cn("h-4 w-4", settledSyncingPeriod === period.id && "animate-spin")} />
                      {settledSyncingPeriod === period.id ? "Syncing..." : "Sync Settled"}
                    </Button>
                  )}
                  
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={(e) => handleToggleExpand(e, period.id)}
                    disabled={salesNotYetCorrected}
                    title="More details"
                  >
                    <Info className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              
              {/* Date sublabel */}
              <p className="text-xs text-muted-foreground mb-3">{effectiveStat.sublabel}</p>
              
              {/* Summary values are RPC-sourced; table/records loading must not rewrite them. */}
              <>
              {/* Sales - Show both Gross and Net for all periods with netSalesBreakdown (Sellerboard-style) */}
              <div className="mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {effectiveStat.netSalesBreakdown ? 'Gross Sales' : 'Sales'}
                  </span>
                  {effectiveStat.salesChange !== undefined && formatChange(effectiveStat.salesChange)}
                </div>
                <p className="text-lg font-bold text-green-500">{fmtMoney(blockSales)}</p>
              </div>
              
              {/* Net Sales (Sellerboard-style) - For all periods with breakdown data */}
              {/* CRITICAL: Use corrected blockSales for Net Sales calculation */}
              {effectiveStat.netSalesBreakdown && (() => {
                const promoRebates = effectiveStat.netSalesBreakdown.promotionalRebates;
                const correctedBlockNetSales = blockSales - promoRebates;
                
                return (
                <div className="mb-2 bg-muted/30 rounded p-2 -mx-1">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">Net Sales</span>
                    <span className="text-[10px] bg-blue-500/20 text-blue-500 px-1 py-0.5 rounded">SB</span>
                  </div>
                  <p className="text-base font-bold text-green-600">{fmtMoney(correctedBlockNetSales)}</p>
                  <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                    {promoRebates > 0 && (
                      <div className="flex justify-between">
                        <span>Promo Rebates (coupons)</span>
                        <span className="text-red-400">-{fmtMoney(promoRebates)}</span>
                      </div>
                    )}
                    {/* Shipping & Gift Wrap are REVENUE (shown separately for transparency) */}
                    {(effectiveStat.netSalesBreakdown.shippingCredits > 0 || effectiveStat.netSalesBreakdown.giftWrapCredits > 0) && (
                      <div className="mt-1 pt-1 border-t border-muted/50">
                        <div className="text-[9px] text-muted-foreground/70 mb-0.5">Additional Revenue:</div>
                        {effectiveStat.netSalesBreakdown.shippingCredits > 0 && (
                          <div className="flex justify-between">
                            <span>Shipping Paid by Buyer</span>
                            <span className="text-green-400">+{fmtMoney(effectiveStat.netSalesBreakdown.shippingCredits)}</span>
                          </div>
                        )}
                        {effectiveStat.netSalesBreakdown.giftWrapCredits > 0 && (
                          <div className="flex justify-between">
                            <span>Gift Wrap Paid by Buyer</span>
                            <span className="text-green-400">+{fmtMoney(effectiveStat.netSalesBreakdown.giftWrapCredits)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                );
              })()}
              
              {/* Orders / Units - label changes per data-source mode so users know
                  whether they are looking at Orders Placed (purchase date) or
                  Orders Shipped (settlement date). */}
              <div className="flex justify-between text-xs mb-2">
                <span className="text-muted-foreground flex items-center gap-1">
                  {salesMode === 'reconciled'
                    ? 'Orders Shipped / Units'
                    : salesMode === 'estimated'
                      ? 'Orders Placed / Units'
                      : 'Orders / Units'}
                  <span
                    title={
                      salesMode === 'reconciled'
                        ? 'Reconciled mode: Orders counted by shipment/settlement date from Financial Events. Matches Profit & Loss.'
                        : salesMode === 'estimated'
                          ? 'Estimated mode: Orders counted by purchase date from sales_orders. Some Amazon fees and refunds are still being settled and may not yet appear here.'
                          : 'Smart Fallback: Order Date for live windows, Settlement Date for fully closed periods.'
                    }
                    className="text-[9px] text-blue-400"
                  >ⓘ</span>
                </span>
                <span className="font-medium">
                  {Math.round(blockOrders).toLocaleString()} / {Math.round(blockUnits).toLocaleString()}
                </span>
              </div>
              
              {/* Pending enrichment indicator - shows when some orders are awaiting ASIN enrichment */}
              {effectiveStat.pendingEnrichment && effectiveStat.pendingEnrichment.orders > 0 && (
                <div className="flex justify-between text-xs mb-2 bg-amber-500/10 rounded px-1 py-0.5">
                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    ⏳ Pending enrichment
                    <span title="These orders are included in counts but awaiting ASIN data enrichment. Profit calculations exclude them until enriched." className="text-[9px]">ⓘ</span>
                  </span>
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    {effectiveStat.pendingEnrichment.orders.toLocaleString()} / {effectiveStat.pendingEnrichment.units.toLocaleString()}
                  </span>
                </div>
              )}
              
              {/* Cancelled Orders - only show if there are any */}
              {effectiveStat.cancelledOrders > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCancelledOrdersDialog({
                      open: true,
                      periodId: period.id,
                      dateRange: range,
                      periodLabel: effectiveStat.label,
                    });
                  }}
                  className="w-full flex justify-between text-xs mb-2 bg-red-500/10 hover:bg-red-500/20 rounded px-1 py-0.5 transition-colors cursor-pointer"
                >
                  <span className="text-red-600 dark:text-red-400 flex items-center gap-1">
                    ❌ Cancelled
                    <span title="Click to view cancelled orders. These are excluded from all financial calculations." className="text-[9px]">ⓘ</span>
                  </span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    {effectiveStat.cancelledOrders.toLocaleString()}
                  </span>
                </button>
              )}
              
              {/* Pending Status Check - orders awaiting verification from Amazon (CLICKABLE) */}
              {effectiveStat.pendingStatusCheck > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setAwaitingVerificationDialog({
                      open: true,
                      periodId: period.id,
                      dateRange: range,
                      periodLabel: effectiveStat.label,
                    });
                  }}
                  className="w-full flex justify-between text-xs mb-2 bg-blue-500/10 hover:bg-blue-500/20 rounded px-1 py-0.5 transition-colors cursor-pointer"
                >
                  <span className="text-blue-600 dark:text-blue-400 flex items-center gap-1">
                    🔄 Awaiting verification
                    <span title="Click to view orders. These have 'Pending' status and haven't been verified yet. Some may be cancelled." className="text-[9px]">ⓘ</span>
                  </span>
                  <span className="font-medium text-blue-600 dark:text-blue-400">
                    {effectiveStat.pendingStatusCheck.toLocaleString()}
                  </span>
                </button>
              )}
              
              {/* Refunds */}
              <div className="flex justify-between text-xs mb-2">
                <span className="text-muted-foreground">Refunds</span>
                <span className="font-medium text-purple-500">
                  {Math.round(Number.isFinite(blockRefunds) ? blockRefunds : 0)} ({fmtMoney(Number.isFinite(blockRefundAmount) ? blockRefundAmount : 0)})
                  {refundsDelayed && blockRefunds === 0 && blockRefundAmount < 0.01 && (period.id === 'today' || period.id === 'yesterday') && (
                    <span className="ml-1 text-[9px] text-amber-500" title="Refund data is still being fetched from Amazon. This may take a few moments.">⏳ delayed</span>
                  )}
                </span>
              </div>

              {/* Replacement / Free-Shipment COGS — Amazon shipped at $0 revenue, unit cost still deducted from profit */}
              <ReplacementCogsLine
                rangeStart={periodDateRange?.start || ''}
                rangeEnd={periodDateRange?.end || ''}
              />
              
              {/* Adv. Cost */}
              <div className="flex justify-between text-xs mb-2">
                <span className="text-muted-foreground">Adv. cost</span>
                <span className="font-medium">{fmtMoney(effectiveStat.advCost)}</span>
              </div>
              
              {/* Amazon payout (before COGS) */}
              <div
                className="flex justify-between text-xs mb-2"
                title="What Amazon will deposit: Sales − Amazon fees − Refund cost. Does NOT include product cost (COGS) or expenses. Net Profit below is your real profit after COGS."
              >
                <span className="text-muted-foreground">Amazon payout (before COGS)</span>
                <span className="font-medium text-blue-500">{fmtMoney(blockEstPayout)}</span>
              </div>
              
              {/* Reimbursements (Other income — visibility for lost/damaged FBA recoveries) */}
              {blockReimbursements > 0 && (
                <div className="flex justify-between text-xs mb-2" title="Amazon reimbursements (lost/damaged inventory, reversals). Counted as income, not as a fee credit.">
                  <span className="text-muted-foreground">Reimbursements</span>
                  <span className="font-medium text-green-500">+{fmtMoney(blockReimbursements)}</span>
                </div>
              )}

              {/* Gross Profit */}
              <div className="flex justify-between text-xs mb-2">
                <span className="text-muted-foreground">Gross profit</span>
                <span className={cn("font-medium", blockGrossProfit >= 0 ? "text-green-500" : "text-red-500")}>
                  {blockGrossProfit < 0 ? "-" : ""}{fmtMoney(blockGrossProfit)}
                </span>
              </div>
              
              {/* Net Profit */}
              <div className="pt-2 border-t">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {isProfit
                      ? (isLiveOperationalPeriod ? 'Live Net profit' : 'Net profit')
                      : (isLiveOperationalPeriod ? 'Live Net loss' : 'Net loss')}
                  </span>
                  {effectiveStat.profitChange !== undefined && formatChange(effectiveStat.profitChange)}
                </div>
                <p className={cn(
                  "text-base font-bold",
                  isProfit ? "text-green-500" : "text-red-500"
                )}>
                  {isProfit ? "" : "-"}{fmtMoney(blockNetProfit)}
                </p>
                <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                  {isLiveOperationalPeriod
                    ? '📦 Live · excludes indirect expenses'
                    : (['month_to_date', 'custom'].includes(period.id))
                      ? '📦 After indirect expenses'
                      : '📄 Settlement P&L'}
                </p>
                {!['today', 'yesterday', 'month_to_date', 'custom'].includes(period.id) && (
                  <p className="text-[10px] text-muted-foreground/80 leading-tight mt-1">
                    Includes refunds, inbound, storage & reimbursements
                  </p>
                )}
                {isLiveOperationalPeriod && (
                  <p className="text-[10px] text-muted-foreground/70 leading-tight mt-1">
                    Indirect expenses are applied only to MTD and longer accounting periods.
                  </p>
                )}
              </div>
                </>
            </div>
          );
        })}
        
        {/* Custom Range Block - Always visible */}
        {selectedPeriod === 'custom' ? (
          /* When custom is selected, show either the date picker or the stats block */
          !customStartDate || !customEndDate ? (
            <div 
              className={cn(
                "min-w-[200px] p-3 rounded-lg border transition-all",
                "border-primary bg-primary/5 ring-2 ring-primary/20"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm text-foreground">Custom Range</span>
              </div>
              
              <div className="space-y-2 mb-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Start Date</label>
                  <input
                    type="date"
                    value={pendingCustomStart}
                    onChange={(e) => setPendingCustomStart(e.target.value)}
                    className="w-full text-sm px-2 py-1.5 rounded border border-input bg-background"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">End Date</label>
                  <input
                    type="date"
                    value={pendingCustomEnd}
                    onChange={(e) => setPendingCustomEnd(e.target.value)}
                    className="w-full text-sm px-2 py-1.5 rounded border border-input bg-background"
                  />
                </div>
              </div>
              
              <Button
                size="sm"
                disabled={!pendingCustomStart || !pendingCustomEnd}
                onClick={() => {
                  if (pendingCustomStart && pendingCustomEnd && onCustomStartDateChange && onCustomEndDateChange) {
                    onCustomStartDateChange(pendingCustomStart);
                    onCustomEndDateChange(pendingCustomEnd);
                  }
                }}
                className="w-full"
              >
                Apply
              </Button>
            </div>
          ) : (
            /* Custom period stats block when dates are set */
            (() => {
              const stat = stats.get('custom');
              const isLoading = loadingPeriods.has('custom');
              
              if (isLoading) {
                return <BlockSkeleton key="custom" periodId="custom" />;
              }
              
              // Show empty state if no data found
              if (!stat) {
                return (
                  <div 
                    className={cn(
                      "flex-1 min-w-[200px] p-3 rounded-lg border transition-all",
                      "border-primary bg-primary/5 ring-2 ring-primary/20"
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-sm text-primary">Custom Range</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          if (onCustomStartDateChange && onCustomEndDateChange) {
                            onCustomStartDateChange('');
                            onCustomEndDateChange('');
                          }
                        }}
                      >
                        Change Dates
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      {customStartDate} — {customEndDate}
                    </p>
                    <div className="text-center py-4">
                      <p className="text-sm text-muted-foreground">No data found for this period</p>
                      <p className="text-xs text-muted-foreground mt-1">Try syncing settled data first</p>
                    </div>
                  </div>
                );
              }
              
              // ═══ ALL BLOCKS USE RPC DATA (single source of truth) ═══
              const statCogs = Number(stat.totalCost || 0);
              const blockTotals = computePeriodTotals({
                  periodId: 'custom',
                  periodStart: customStartDate,
                  periodEnd: customEndDate,
                  salesPrincipal: stat.sales,
                  shippingCredits: stat.netSalesBreakdown?.shippingCredits || 0,
                  giftWrapCredits: stat.netSalesBreakdown?.giftWrapCredits || 0,
                  promoRebates: stat.netSalesBreakdown?.promotionalRebates || 0,
                  units: stat.units,
                  orders: stat.orders,
                  refundCount: stat.refunds,
                  amazonFeesNet: getOrderLevelFeesForGrossProfit(
                    stat.feeBreakdown,
                    stat.recordFees,
                    Number(stat.totalFees || 0)
                  ),
                  feeBreakdown: stat.feeBreakdown,
                  recordFees: stat.recordFees,
                  refundBreakdown: stat.refundsFromCache || {
                    refundedAmount: stat.refundAmount,
                    refundedReferralFee: stat.refundedReferralFee,
                    refundedOtherFees: 0,
                    refundEventCount: stat.refunds,
                  },
                  cogsTotal: statCogs,
                  expenses: stat.expenses,
                  inboundFees: stat.inboundFees,
                });
              
              const blockSales = blockTotals.salesPrincipal;
              const blockOrders = blockTotals.orders;
              const blockUnits = blockTotals.units;
              const blockRefunds = blockTotals.refundCount;
              const blockRefundAmount = blockTotals.refundBreakdown.refundedAmount;
              const blockEstPayout = blockTotals.estPayout;
              const blockGrossProfit = blockTotals.grossProfit;
              const blockNetProfit = blockTotals.netProfit;
              const blockFb = blockTotals.feeBreakdown;
              const blockReimbursements = (blockFb?.warehouseLost || 0) + (blockFb?.warehouseDamage || 0)
                + (blockFb?.reversalReimbursement || 0) + (blockFb?.otherReimbursements || 0)
                + (blockFb?.freeReplacementRefundItems || 0) + (blockFb?.liquidationsRevenue || 0)
                + (blockFb?.otherIncome || 0);
              const isProfit = blockNetProfit >= 0;
              
              return (
                <div 
                  className={cn(
                    "flex-1 min-w-[200px] p-3 rounded-lg border transition-all",
                    "border-primary bg-primary/5 ring-2 ring-primary/20"
                  )}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm text-primary">
                      {stat.label}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          if (onCustomStartDateChange && onCustomEndDateChange) {
                            onCustomStartDateChange('');
                            onCustomEndDateChange('');
                          }
                        }}
                      >
                        Change Dates
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={(e) => handleToggleExpand(e, 'custom')}
                        title="More details"
                      >
                        <Info className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  {/* Date sublabel */}
                  <p className="text-xs text-muted-foreground mb-3">{stat.sublabel}</p>
                  
                  {/* Sales - Show both Gross and Net for all periods with netSalesBreakdown (Sellerboard-style) */}
                  <div className="mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {stat.netSalesBreakdown ? 'Gross Sales' : 'Sales'}
                      </span>
                    </div>
                    <p className="text-lg font-bold text-green-500">{fmtMoney(blockSales)}</p>
                  </div>
                  
                  {/* Net Sales (Sellerboard-style) - For all periods with breakdown data */}
                  {stat.netSalesBreakdown && (() => {
                    // Calculate Net Sales from corrected Gross Sales (not stale stat value)
                    const correctedNetSales = blockSales - stat.netSalesBreakdown.promotionalRebates;
                    return (
                      <div className="mb-2 bg-muted/30 rounded p-2 -mx-1">
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">Net Sales</span>
                          <span className="text-[10px] bg-blue-500/20 text-blue-500 px-1 py-0.5 rounded">SB</span>
                        </div>
                        <p className="text-base font-bold text-green-600">{fmtMoney(correctedNetSales)}</p>
                        <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                          {stat.netSalesBreakdown.promotionalRebates > 0 && (
                            <div className="flex justify-between">
                              <span>Promo Rebates (coupons)</span>
                              <span className="text-red-400">-{fmtMoney(stat.netSalesBreakdown.promotionalRebates)}</span>
                            </div>
                          )}
                          {/* Shipping & Gift Wrap are REVENUE (shown separately for transparency) */}
                          {(stat.netSalesBreakdown.shippingCredits > 0 || stat.netSalesBreakdown.giftWrapCredits > 0) && (
                            <div className="mt-1 pt-1 border-t border-muted/50">
                              <div className="text-[9px] text-muted-foreground/70 mb-0.5">Additional Revenue:</div>
                              {stat.netSalesBreakdown.shippingCredits > 0 && (
                                <div className="flex justify-between">
                                  <span>Shipping Paid by Buyer</span>
                                  <span className="text-green-400">+{fmtMoney(stat.netSalesBreakdown.shippingCredits)}</span>
                                </div>
                              )}
                              {stat.netSalesBreakdown.giftWrapCredits > 0 && (
                                <div className="flex justify-between">
                                  <span>Gift Wrap Paid by Buyer</span>
                                  <span className="text-green-400">+{fmtMoney(stat.netSalesBreakdown.giftWrapCredits)}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  
                  {/* Orders / Units - with tooltip explaining units source for all periods with netSalesBreakdown */}
                  <div className="flex justify-between text-xs mb-2">
                    <span className="text-muted-foreground flex items-center gap-1">
                      Orders / Units
                      {stat.netSalesBreakdown && (
                        <span title="Units from Financial Events (shipments). Sellerboard uses the same source." className="text-[9px] text-blue-400">ⓘ</span>
                      )}
                    </span>
                    <span className="font-medium">
                      {Math.round(blockOrders).toLocaleString()} / {Math.round(blockUnits).toLocaleString()}
                    </span>
                  </div>
                  
                  {/* Refunds */}
                  <div className="flex justify-between text-xs mb-2">
                    <span className="text-muted-foreground">Refunds</span>
                    <span className="font-medium text-purple-500">
                      {Math.round(Number.isFinite(blockRefunds) ? blockRefunds : 0)} ({fmtMoney(Number.isFinite(blockRefundAmount) ? blockRefundAmount : 0)})
                    </span>
                  </div>

                  {/* Replacement / Free-Shipment COGS */}
                  <ReplacementCogsLine
                    rangeStart={customStartDate}
                    rangeEnd={customEndDate}
                  />
                  
                  {/* Adv. Cost */}
                  <div className="flex justify-between text-xs mb-2">
                    <span className="text-muted-foreground">Adv. cost</span>
                    <span className="font-medium">{fmtMoney(stat.advCost)}</span>
                  </div>
                  
                  {/* Amazon payout (before COGS) */}
                  <div
                    className="flex justify-between text-xs mb-2"
                    title="What Amazon will deposit: Sales − Amazon fees − Refund cost. Does NOT include product cost (COGS) or expenses. Net Profit below is your real profit after COGS."
                  >
                    <span className="text-muted-foreground">Amazon payout (before COGS)</span>
                    <span className="font-medium text-blue-500">{fmtMoney(blockEstPayout)}</span>
                  </div>
                  
                  {/* Reimbursements (Other income) */}
                  {blockReimbursements > 0 && (
                    <div className="flex justify-between text-xs mb-2" title="Amazon reimbursements (lost/damaged inventory, reversals). Counted as income, not as a fee credit.">
                      <span className="text-muted-foreground">Reimbursements</span>
                      <span className="font-medium text-green-500">+{fmtMoney(blockReimbursements)}</span>
                    </div>
                  )}

                  {/* Gross Profit */}
                  <div className="flex justify-between text-xs mb-2">
                    <span className="text-muted-foreground">Gross profit</span>
                    <span className={cn("font-medium", blockGrossProfit >= 0 ? "text-green-500" : "text-red-500")}>
                      {blockGrossProfit < 0 ? "-" : ""}{fmtMoney(blockGrossProfit)}
                    </span>
                  </div>
                  
                  {/* Net Profit */}
                  <div className="pt-2 border-t">
                    <span className="text-xs text-muted-foreground">Net profit</span>
                    <p className={cn(
                      "text-base font-bold",
                      isProfit ? "text-green-500" : "text-red-500"
                    )}>
                      {isProfit ? "" : "-"}{fmtMoney(blockNetProfit)}
                    </p>
                    <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                      📦 Orders profit
                    </p>
                  </div>
                </div>
              );
            })()
          )
        ) : (
          /* When not custom, show the "Click to choose dates" button */
          !showCustomBlock ? (
            <div 
              onClick={() => setShowCustomBlock(true)}
              className={cn(
                "flex-1 min-w-[200px] p-3 rounded-lg border cursor-pointer transition-all hover:shadow-md",
                "border-dashed border-border bg-card hover:border-primary/50",
                "flex flex-col items-center justify-center"
              )}
            >
              <CalendarRange className="h-8 w-8 text-muted-foreground mb-2" />
              <span className="font-semibold text-sm text-foreground">Custom Range</span>
              <span className="text-xs text-muted-foreground">Click to choose dates</span>
            </div>
          ) : (
            <div 
              className={cn(
                "min-w-[200px] p-3 rounded-lg border transition-all",
                "border-primary bg-primary/5"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm text-foreground">Custom Range</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setShowCustomBlock(false);
                    setPendingCustomStart('');
                    setPendingCustomEnd('');
                  }}
                  className="h-6 w-6"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              
              <div className="space-y-2 mb-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Start Date</label>
                  <input
                    type="date"
                    value={pendingCustomStart}
                    onChange={(e) => setPendingCustomStart(e.target.value)}
                    className="w-full text-sm px-2 py-1.5 rounded border border-input bg-background"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">End Date</label>
                  <input
                    type="date"
                    value={pendingCustomEnd}
                    onChange={(e) => setPendingCustomEnd(e.target.value)}
                    className="w-full text-sm px-2 py-1.5 rounded border border-input bg-background"
                  />
                </div>
              </div>
              
              <Button
                size="sm"
                disabled={!pendingCustomStart || !pendingCustomEnd}
                onClick={() => {
                  if (pendingCustomStart && pendingCustomEnd && onCustomStartDateChange && onCustomEndDateChange) {
                    onCustomStartDateChange(pendingCustomStart);
                    onCustomEndDateChange(pendingCustomEnd);
                    onPeriodSelect('custom');
                  }
                }}
                className="w-full"
              >
                Save
              </Button>
            </div>
          )
        )}
      </div>
      
      {/* Detail Dialog */}
      <Dialog open={!!expandedPeriod && !!expandedStat} onOpenChange={(open) => !open && setExpandedPeriod(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          {expandedPeriod && expandedStat && (() => {
            const rawStat = expandedStat;
            const stat: PeriodStat = rawStat;
            
            // ═══════════════════════════════════════════════════════════════
            // POPUP: For the SELECTED period, reuse the SAME blockTotals
            // that the block card uses (derived from tablePeriodTotals).
            // ═══ ALL POPUPS USE RPC DATA (single source of truth) ═══
            const periodDateRange = dateRanges[expandedPeriod as keyof typeof dateRanges];

            const statCogs = Number(stat.totalCost || 0);
            const popupAmazonFeesNet = getOrderLevelFeesForGrossProfit(
              stat.feeBreakdown,
              stat.recordFees,
              Number(stat.totalFees || 0)
            );

            const popupTotals: PeriodTotals = computePeriodTotals({
                periodId: expandedPeriod,
                periodStart: periodDateRange?.start || '',
                periodEnd: periodDateRange?.end || '',
                salesPrincipal: Number(stat.sales || 0),
                shippingCredits: stat.netSalesBreakdown?.shippingCredits || 0,
                giftWrapCredits: stat.netSalesBreakdown?.giftWrapCredits || 0,
                promoRebates: stat.netSalesBreakdown?.promotionalRebates || 0,
                units: Number(stat.units || 0),
                orders: Number(stat.orders || 0),
                refundCount: stat.refunds,
                amazonFeesNet: popupAmazonFeesNet,
                feeBreakdown: stat.feeBreakdown,
                recordFees: stat.recordFees,
                refundBreakdown: stat.refundsFromCache || {
                  refundedAmount: stat.refundAmount,
                  refundedReferralFee: stat.refundedReferralFee,
                  refundedOtherFees: 0,
                  refundEventCount: stat.refunds,
                },
                cogsTotal: statCogs,
                expenses: Number(stat.expenses || 0),
                inboundFees: Number(stat.inboundFees || 0),
              });

            const popupItemizedFees = getItemizedFeeBreakdownTotal(popupTotals.feeBreakdown);
            const popupFeeSource = stat.feeBreakdownSource || ((popupTotals.feeBreakdown?.eventCount || 0) > 0 ? 'FEC' : 'SO / SmartFallback');
            const popupUnknownResidual = Number(stat.unknownResidualFee ?? Math.max(0, Number(popupTotals.feeBreakdown?.totalFees || 0) - popupItemizedFees));
            console.log(`[Popup ${expandedPeriod}] source=RPC, feeBreakdownSource=${popupFeeSource}, unknownResidualFee=${popupUnknownResidual.toFixed(2)}, netProfit=${popupTotals.netProfit.toFixed(2)}, promoRebates=${popupTotals.promoRebates.toFixed(2)}, sales=${popupTotals.salesPrincipal.toFixed(2)}, fees=${popupTotals.amazonFeesNet.toFixed(2)}`);
            console.log(`[Popup ${expandedPeriod}] feeBreakdown before render`, popupTotals.feeBreakdown);
            
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-lg">
                    <span className="w-3 h-3 rounded-full bg-yellow-500"></span>
                    {stat.label} • {stat.dateLabel}
                  </DialogTitle>
                </DialogHeader>
                
                <SellerboardBreakdown
                  data={{ ...stat, expenses: popupTotals.expenses, inboundFees: popupTotals.inboundFees, recordFees: popupTotals.recordFees ?? stat.recordFees, feeBreakdown: popupTotals.feeBreakdown ?? stat.feeBreakdown } as any}
                  salesTotal={popupTotals.salesPrincipal}
                  unitsTotal={popupTotals.units}
                  ordersTotal={popupTotals.orders}
                  cogsTotal={popupTotals.cogsTotal}
                  amazonFeesNetTotal={popupTotals.amazonFeesNet}
                  refundCostTotal={popupTotals.refundCostTotal}
                  grossProfit={popupTotals.grossProfit}
                  netProfit={popupTotals.netProfit}
                  periodId={expandedPeriod}
                  isMarketplaceFiltered={Array.isArray(selectedMarketplaces) && selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4}
                  currencySymbol={cs}
                  className="mt-2"
                />
                
                {/* Reconciliation / Debug Section */}
                <details className="text-xs mt-4 pt-4 border-t border-dashed">
                  <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
                    Reconciliation / Debug
                  </summary>
                  <div className="mt-2 p-3 bg-muted/50 rounded-md space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-muted-foreground">Financial Events Total Fees</p>
                        <p className="font-mono">-{cs}{stat.feeBreakdown.totalFees.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Financial Events Total Credits</p>
                        <p className="font-mono text-green-500">+${stat.feeBreakdown.totalCredits.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground"># Financial events rows</p>
                        <p className="font-mono">{stat.feeBreakdown.eventCount}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground"># Refund events</p>
                        <p className="font-mono">{stat.refundsFromCache?.refundEventCount || 0}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Fee breakdown source</p>
                        <p className="font-mono">{popupFeeSource}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Unknown residual fee</p>
                        <p className="font-mono">{cs}{popupUnknownResidual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-muted-foreground">feeBreakdown object before render</p>
                        <pre className="font-mono text-[10px] whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                          {JSON.stringify(popupTotals.feeBreakdown, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <p className="text-muted-foreground">computePeriodTotals Net Profit</p>
                        <p className="font-mono">${popupTotals.netProfit.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">computePeriodTotals Gross Profit</p>
                        <p className="font-mono">${popupTotals.grossProfit.toFixed(2)}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-muted-foreground">Date range (with cutoff)</p>
                        <p className="font-mono">{stat.debug?.dateRangeWithCutoff ?? '—'}</p>
                      </div>
                      {stat.unattributedSettledFees !== undefined && (
                        <div className="col-span-2">
                          <p className="text-muted-foreground">Unattributed (UNKNOWN) settled fees</p>
                          <p className="font-mono">${stat.unattributedSettledFees.toFixed(2)}</p>
                        </div>
                      )}
                    </div>

                    {stat.cogsReconciliation && (
                      <div className="col-span-2 border-t pt-2">
                        <p className="text-muted-foreground">COGS missing-cost reconciliation</p>
                        <p className="font-mono">Missing rows: {stat.cogsReconciliation.missingRows}</p>
                        <p className="font-mono">Estimated missing $: {stat.cogsReconciliation.missingEstimatedCost.toFixed(2)}</p>
                        {stat.cogsReconciliation.sample.length > 0 && (
                          <p className="font-mono text-[11px] truncate">
                            Sample: {stat.cogsReconciliation.sample.slice(0, 3).map((r) => `${r.order_id} (${r.sku || r.asin}) qty:${r.qty} cost:${r.unit_cost || 0}→${r.estimated_unit_cost || 0}`).join(' | ')}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Marketplace Attribution Debug */}
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground text-[11px]">
                        Marketplace Attribution Stats
                      </summary>
                      <MarketplaceAttributionDebug userId={userId} dateRange={dateRanges[expandedPeriod as keyof typeof dateRanges]} />
                    </details>
                  </div>
                </details>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
      
      {/* Awaiting Verification Dialog */}
      {awaitingVerificationDialog && (
        <AwaitingVerificationDialog
          open={awaitingVerificationDialog.open}
          onOpenChange={(open) => {
            if (!open) setAwaitingVerificationDialog(null);
          }}
          userId={userId}
          dateRange={awaitingVerificationDialog.dateRange}
          periodLabel={awaitingVerificationDialog.periodLabel}
        />
      )}
      
      {cancelledOrdersDialog && (
        <CancelledOrdersDialog
          open={cancelledOrdersDialog.open}
          onOpenChange={(open) => {
            if (!open) setCancelledOrdersDialog(null);
          }}
          userId={userId}
          dateRange={cancelledOrdersDialog.dateRange}
          periodLabel={cancelledOrdersDialog.periodLabel}
        />
      )}
    </div>
  );
}
