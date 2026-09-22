import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/sales/paginatedFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useSalesSync } from "@/contexts/SalesSyncContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { getMarketplaceFromId } from "@/lib/marketplaceCurrency";
import { getBusinessDateISO, SALES_BUSINESS_TZ } from "@/lib/sales/dateRange";
import { getInventoryUnitCost, getListingUnitCost } from "@/lib/cost-contract";
import { buildCogsResolver } from "@/lib/cogs/resolveUnitCost";
import { feeCacheKey, getCachedFeesUsd, getSalesOrderFeeBreakdownUsd, isFeeCacheMissingForNonUs, type FeeCacheEntry } from "@/lib/sales/feeNormalization";
import {
  applyLearnedFeeMultiplier,
  loadLearnedFeeMultipliers,
  loadAsinFeeMultipliers,
  loadLearnedFeeSettings,
  type LearnedFeeMultiplierMap,
  type AsinFeeMultiplierMap,
  type LearnedFeeSettings,
} from "@/lib/sales/learnedFeeMultipliers";
import { getOrderPromoUsd } from "@/lib/salesCalculations";
import { getConfirmedSalesOrderRevenueUsd, getConfirmedSalesOrderUnitRevenueUsd } from "@/lib/sales/currencyConversion";
import { Loader2, RefreshCw, RefreshCcw, RotateCw, ShoppingCart, ArrowLeft, AlertTriangle, Package, LogOut, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Truck, Star, History } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import FbmLabelCostDialog from "@/components/sales/FbmLabelCostDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  loadMobileLiveSalesCache,
  saveMobileLiveSalesCache,
  TODAY_CACHE_MAX_AGE_MS,
} from "@/hooks/use-mobile-live-sales-cache";
import FeeBreakdownSections from "@/components/sales/FeeBreakdownSections";
import PromotionsDeductedSection from "@/components/sales/PromotionsDeductedSection";
import CancelledOrdersSection from "@/components/sales/CancelledOrdersSection";
import ReplacementCogsSection from "@/components/sales/ReplacementCogsSection";
import ReplacementCogsChip from "@/components/sales/ReplacementCogsChip";
import { fetchPromotionDeductions } from "@/lib/sales/promotionDeductions";
import { computeNetRefundFromFecRows } from "@/lib/sales/refundMath";


/* ─────────── helpers (mirrors LiveSales.tsx contracts) ─────────── */

const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
  UK: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  JP: "JPY", AU: "AUD", IN: "INR", SG: "SGD", AE: "AED",
  SA: "SAR", NL: "EUR", SE: "SEK", PL: "PLN", BE: "EUR", TR: "TRY",
};

const LIVE_SALES_TZ = SALES_BUSINESS_TZ;
const getLocalDateStr = (d: Date = new Date()) => getBusinessDateISO(d, LIVE_SALES_TZ);

type MonthPeriod = `month_${"01"|"02"|"03"|"04"|"05"|"06"|"07"|"08"|"09"|"10"|"11"|"12"}`;
type Period = "last_year" | "last_month" | "yesterday" | "today" | "this_week" | "mtd" | "ytd" | "forecast" | MonthPeriod;
const MONTH_PERIODS: MonthPeriod[] = [
  "month_01","month_02","month_03","month_04","month_05","month_06",
  "month_07","month_08","month_09","month_10","month_11","month_12",
];
// YTD intentionally omitted from the mobile selector — it's a heavy live
// aggregate over sales_orders (no summary table yet) and doesn't match the
// "snappy today/period" mobile UX. Type keeps "ytd" so any legacy code paths
// still compile; the selector, prev/next swipe, and saved-period restore all
// derive from PERIOD_ORDER and will silently drop it.
const PERIOD_ORDER: Period[] = ["last_month", "yesterday", "today", "this_week", "mtd", "forecast"];
// Cheap, fast-changing periods get a snappy poll; heavier reconciled
// periods (This Week/MTD/Forecast/Last Month) get a much slower one --
// see the poll effect below for why.
const FAST_POLL_PERIODS: Period[] = ["today", "yesterday"];

const addDaysISO = (dateStr: string, delta: number) => {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return getBusinessDateISO(d, LIVE_SALES_TZ);
};

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const EMPTY_SUMMARY = { units: 0, orders: 0, revenue: 0, fees: 0, cost: 0, profit: 0, roi: 0 };

const EMPTY_ADJUSTMENTS = {
  key: "",
  net: 0,
  extraFees: 0,
  credits: 0,
  events: 0,
  shippingCollected: 0,
  fbmLabelFees: 0,
  loaded: false,
  requestId: "",
};

const EMPTY_PROMOTIONS = {
  key: "",
  total: 0,
  rows: 0,
  loaded: false,
  requestId: "",
};

// Pending-estimate bucket — matches Sales Report's `pendingEstimateRevenue`.
// Pending orders (no confirmed sold_price / total_sale_amount) are NOT in
// `get_fec_daily_shipment_totals`, so reconciled mode misses ~$22k YTD until
// this bucket is added. See .lovable/plan.md (Why mobile YTD net is lower).
const EMPTY_PENDING_EST = {
  key: "",
  revenueUsd: 0,
  cogsUsd: 0,
  orders: 0,
  units: 0,
  loaded: false,
  requestId: "",
};

const roundCents = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

const buildSideTotalsKey = (start: string, end: string, marketplace: string) =>
  `${start}|${end}|${marketplace || "ALL"}`;

// Shifts a YYYY-MM-DD date back exactly one calendar year. Feb 29 clamps to
// Feb 28 when last year wasn't a leap year.
const shiftYearBack = (dateStr: string): string => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const targetYear = y - 1;
  const isLeap = (yr: number) => (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
  const day = m === 2 && d === 29 && !isLeap(targetYear) ? 28 : d;
  return `${targetYear}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

// "Compare to last year" only makes sense for month-shaped periods (the
// current month-to-date, or a specific calendar month) — swaps the range to
// the same month one year earlier so it lines up day-for-day with the
// current-year view it's being compared against.
const getPeriodRange = (period: Period, compareLastYear: boolean = false): { start: string; end: string; label: string } => {
  const today = getLocalDateStr();
  if (compareLastYear && (period === "mtd" || period.startsWith("month_"))) {
    const base = getPeriodRange(period, false);
    const yr = Number(base.start.slice(0, 4)) - 1;
    const label = period === "mtd"
      ? `${MONTH_LABELS[Number(today.slice(5, 7)) - 1]} ${yr} (Last Year MTD)`
      : `${MONTH_LABELS[Number(period.slice(6)) - 1]} ${yr}`;
    return { start: shiftYearBack(base.start), end: shiftYearBack(base.end), label };
  }
  if (period === "today") return { start: today, end: today, label: "Today" };
  if (period === "yesterday") {
    const y = addDaysISO(today, -1);
    return { start: y, end: y, label: "Yesterday" };
  }
  if (period === "this_week") {
    // Rolling last 7 days (including today) — matches Sales Report's 7d window
    // and ensures Week is always distinct from Today, even on Monday.
    const start = addDaysISO(today, -6);
    return { start, end: today, label: "Last 7 Days" };
  }
  if (period === "ytd") {
    const yr = today.slice(0, 4);
    return { start: `${yr}-01-01`, end: today, label: "Year-to-Date" };
  }
  if (period === "last_year") {
    const yr = Number(today.slice(0, 4)) - 1;
    return { start: `${yr}-01-01`, end: `${yr}-12-31`, label: `${yr}` };
  }
  if (period === "last_month") {
    const [yStr, mStr] = today.split("-");
    const y = Number(yStr);
    const m = Number(mStr); // 1-12, current month
    const lmYear = m === 1 ? y - 1 : y;
    const lmMonth = m === 1 ? 12 : m - 1; // 1-12
    const mm = String(lmMonth).padStart(2, "0");
    const lastDay = new Date(lmYear, lmMonth, 0).getDate(); // day 0 of next month
    return {
      start: `${lmYear}-${mm}-01`,
      end: `${lmYear}-${mm}-${String(lastDay).padStart(2, "0")}`,
      label: `${MONTH_LABELS[lmMonth - 1]} ${lmYear}`,
    };
  }
  // Specific month of the current year (month_01..month_12)
  if (period.startsWith("month_")) {
    const mNum = Number(period.slice(6)); // 1-12
    const yr = Number(today.slice(0, 4));
    const mm = String(mNum).padStart(2, "0");
    const lastDay = new Date(yr, mNum, 0).getDate();
    const start = `${yr}-${mm}-01`;
    const fullEnd = `${yr}-${mm}-${String(lastDay).padStart(2, "0")}`;
    // Clamp end to today so current/future months don't query future dates
    const end = fullEnd > today ? today : fullEnd;
    return { start, end, label: `${MONTH_LABELS[mNum - 1]} ${yr}` };
  }
  // mtd & forecast both pull current-month-to-date data
  const start = `${today.slice(0, 7)}-01`;
  if (period === "forecast") return { start, end: today, label: "Month Forecast" };
  return { start, end: today, label: "Month-to-Date" };
};

// Returns multiplier to project MTD totals to a full-month forecast (linear run-rate).
const getForecastFactor = (): { factor: number; dayOfMonth: number; daysInMonth: number } => {
  const today = getLocalDateStr();
  const [y, m, d] = today.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const dayOfMonth = Math.max(1, d);
  return { factor: daysInMonth / dayOfMonth, dayOfMonth, daysInMonth };
};

const normalizeOrderId = (orderId: string | null | undefined) =>
  String(orderId || "").trim();

const asinMarketplaceKey = (asin: string | null | undefined, marketplace: string | null | undefined) =>
  `${String(asin || "").trim()}::${String(marketplace || "US").trim().toUpperCase() || "US"}`;

const isPendingPlaceholderRow = (row: { asin?: string | null; title?: string | null }) => {
  const asin = String(row.asin || "").trim().toUpperCase();
  const title = String(row.title || "").trim().toLowerCase();
  return asin === "PENDING" || title.startsWith("order processing");
};

const isRealAsin = (val: string | null | undefined): boolean => {
  const s = String(val || "").trim();
  return /^B0[A-Z0-9]{8}$/i.test(s);
};

const dedupeDebugRows = <T extends { order_id?: string | null; asin?: string | null; quantity?: number | null; sold_price?: number | null }>(rows: T[]): T[] => {
  const seen = new Set<string>();
  const phase1: T[] = [];
  for (const row of rows) {
    const key = `${normalizeOrderId(row.order_id)}::${String(row.asin || "").trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      phase1.push(row);
    }
  }

  const byOrder = new Map<string, T[]>();
  for (const row of phase1) {
    const oid = normalizeOrderId(row.order_id);
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
        const qtyA = Number(a.quantity || 1), qtyB = Number(b.quantity || 1);
        const priceA = Number(a.sold_price || 0), priceB = Number(b.sold_price || 0);
        if (qtyA !== qtyB) continue;
        if (Math.abs(priceA - priceB) > 1.0) continue;
        const aReal = isRealAsin(a.asin), bReal = isRealAsin(b.asin);
        if (aReal && !bReal) dropSet.add(b);
        else if (bReal && !aReal) dropSet.add(a);
      }
    }
  }

  return phase1.filter(row => !dropSet.has(row));
};

const dedupeSalesRowsForLiveTotals = <T extends { order_id?: string | null; asin?: string | null; title?: string | null; quantity?: number | null; sold_price?: number | null }>(rows: T[]): T[] => {
  // Match Sales Report (source of truth): exclude ALL pending placeholders from totals.
  // Pending rows have no real ASIN → no cost/fees → would inflate revenue & deflate ROI.
  return dedupeDebugRows(rows.filter((row) => !isPendingPlaceholderRow(row)));
};

const applySalesReportMarketplaceFilter = (query: any, selectedMarketplace: string) => {
  if (!selectedMarketplace || selectedMarketplace === "ALL") return query;
  if (selectedMarketplace === "US") {
    return query.or("marketplace.eq.US,marketplace.is.null");
  }
  return query.eq("marketplace", selectedMarketplace);
};


// Strict mode for Live Sales: reject low-confidence hints (Keepa, competitor BB,
// live inventory.price). We only trust CONFIRMED Orders API prices and
// HIGH_CONFIDENCE_PENDING seller-derived estimates (snapshot, repricer log,
// recent sale, listings API, OrderTotal).
const isLowConfidencePending = (row: {
  sold_price?: number | null;
  total_sale_amount?: number | null;
  price_source?: string | null;
  price_confidence?: string | null;
}) => {
  // CONFIRMED Orders API price always wins
  if ((row.sold_price || 0) > 0 || (row.total_sale_amount || 0) > 0) return false;
  const ps = String(row.price_source || "").toLowerCase();
  const pc = String(row.price_confidence || "").toUpperCase();
  // Snapshot prices are seller-derived estimates frozen at order time.
  // The backend snapshot writer now prefers inventory.price over any
  // low-confidence hint, so any snapshot we read is trustworthy enough
  // to count in Live Sales (even if the old confidence tag is HINT).
  if (ps === "snapshot_price" || ps === "snapshot_item_price" || ps.startsWith("seller_derived:snapshot")) return false;
  if (pc === "LOW_CONFIDENCE_HINT") return true;
  return (
    ps.startsWith("hint:") ||
    ps.startsWith("pricing_api_") ||
    ps.startsWith("estimated:keepa") ||
    ps.startsWith("estimated:inventory") ||
    ps.startsWith("estimated:amazon_price") ||
    ps.startsWith("estimated:my_price") ||
    ps.startsWith("estimated:buy_box")
  );
};

const isAwaitingConfirmedPriceRow = (row: { needs_price_enrich?: boolean | null; price_enrich_status?: string | null }) =>
  row.needs_price_enrich === true || String(row.price_enrich_status || "").toLowerCase() === "pending";

const getLineRevenue = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  price_source?: string | null;
  price_confidence?: string | null;
  promotion_discount?: number | null;
  promotion_discount_currency?: string | null;
  marketplace?: string | null;
  needs_price_enrich?: boolean | null;
  price_enrich_status?: string | null;
}) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const totalSale = Number(row.total_sale_amount || 0);
  let gross = 0;
  if (totalSale > 0) gross = totalSale;
  else {
    const soldPrice = Number(row.sold_price || 0);
    if (soldPrice > 0) gross = soldPrice * qty;
    else {
      // Reject low-confidence pending estimates — they would show a competitor's
      // price, not yours. Better to skip than to mislead.
      if (isLowConfidencePending(row)) return 0;
      const estimated = Number(row.estimated_price || 0);
      if (estimated > 0) gross = estimated * qty;
    }
  }
  if (gross <= 0) return 0;
  // Net Amazon-funded coupon (USD-safe; non-US handled via FEC promo path)
  return Math.max(0, gross - getOrderPromoUsd(row));
};

const getUnitPriceForAverage = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  price_source?: string | null;
  price_confidence?: string | null;
}) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const soldPrice = Number(row.sold_price || 0);
  const totalSale = Number(row.total_sale_amount || 0);
  if (totalSale > 0) return totalSale / qty;
  if (soldPrice > 0) return soldPrice;
  if (isLowConfidencePending(row)) return 0;
  const estimated = Number(row.estimated_price || 0);
  if (estimated > 0) return estimated;
  return 0;
};

const getSalesReportUnitPriceForAverage = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
}) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const soldPrice = Number(row.sold_price || 0);
  const totalSale = Number(row.total_sale_amount || 0);
  const lockedEst = Number(row.locked_est_price || 0);
  const estimated = Number(row.estimated_price || 0);
  if (totalSale > 0) return totalSale / qty;
  if (soldPrice > 0) return soldPrice;
  if (lockedEst > 0) return lockedEst;
  if (estimated > 0) return estimated;
  return 0;
};

const getSalesReportRevenueWithAverageFallback = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
}, avgUnitPrice: number) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const totalSale = Number(row.total_sale_amount || 0);
  if (totalSale > 0) return totalSale;
  const soldPrice = Number(row.sold_price || 0);
  if (soldPrice > 0) return soldPrice * qty;
  const estimated = Number(row.estimated_price || 0);
  if (estimated > 0) return estimated * qty;
  return avgUnitPrice > 0 ? avgUnitPrice * qty : 0;
};

const formatBusinessTimePt = (purchaseTs: string | null | undefined) => {
  const tsStr = String(purchaseTs || "").trim();
  if (!tsStr) return null;
  const tsDate = new Date(tsStr);
  if (Number.isNaN(tsDate.getTime())) return null;
  return tsDate.toLocaleString("en-US", {
    timeZone: LIVE_SALES_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

interface AsinRow {
  asin: string;
  title: string | null;
  image_url: string | null;
  units: number;
  pendingUnits?: number;
  orders: number;
  revenue: number;
  fees: number;
  /** Raw SP-API / cache fee estimate before learned pending-fee projection. */
  rawFees?: number;
  learnedFeesApplied?: boolean;
  learnedFeeMultiplier?: number | null;
  learnedFeeConfidence?: string | null;
  /** USD breakdown — sums of per-row referral/fba/closing fees actually
   *  stored on sales_orders. Used instead of a 15%-of-revenue approximation
   *  in the record-detail view so BR/MX/CA fulfilment fees match reality. */
  referralFees?: number;
  fbaFees?: number;
  closingFees?: number;
  cost: number;
  profit: number;
  roi: number | null;
  latestPurchaseTimePt?: string | null;
  stockFba?: number;
  stockFbm?: number;
  hasFbmOrder?: boolean;
  /** True when an order in this period has NO fulfillment_channel from Amazon. */
  hasUnknownChannelOrder?: boolean;
  marketplaces?: string[];
  orderIds?: string[];
  /** True when ≥1 non-US row had no stored fees AND no asin_fee_cache entry. */
  feesMissing?: boolean;
  /** Marketplaces (e.g. ["CA","MX"]) with missing fee cache for this ASIN. */
  feesMissingMarketplaces?: string[];
}


/* ─────────── record detail view ─────────── */

const RecordDetail = ({
  row,
  currencySymbol,
  homeRate = 1,
  onBack,
  rangeStart,
  rangeEnd,
}: {
  row: AsinRow;
  currencySymbol: string;
  /** USD -> seller's home currency multiplier (1 for USD sellers, the
   * default — row fields below are USD-denominated). */
  homeRate?: number;
  onBack: () => void;
  rangeStart: string;
  rangeEnd: string;
}) => {
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const cur = currencySymbol;
  const fmt = (n: number) => `${n < 0 ? "-" : ""}${cur}${Math.abs(n).toFixed(2)}`;
  const revenue = row.revenue * homeRate;
  const fees = row.fees * homeRate;
  const rawFees = Math.max(0, (row.rawFees ?? row.fees) * homeRate);
  const learnedFeeTitle = row.learnedFeesApplied
    ? `Learned pending estimate based on settled history. Raw SP-API estimate: ${fmt(rawFees)}. Final fees update after settlement.`
    : undefined;
  const cost = row.cost * homeRate;
  const grossProfit = row.profit * homeRate;
  const netProfit = grossProfit;
  const payout = revenue - fees;
  // Prefer actual stored per-row breakdown when present (real referral_fee/
  // fba_fee from Fees API or settlement). Falls back to a 15% approximation
  // only when neither component was captured — historically this approximation
  // mis-attributed fees on BR/MX (e.g. true FBA $2.13 → "1.62" displayed).
  const storedReferral = Math.max(0, (row.referralFees || 0) * homeRate);
  const storedFba = Math.max(0, (row.fbaFees || 0) * homeRate);
  const haveStoredSplit = storedReferral > 0 || storedFba > 0;
  const referralFee = haveStoredSplit ? storedReferral : Math.min(fees, revenue * 0.15);
  const fbaFee = haveStoredSplit ? storedFba : Math.max(0, fees - referralFee);

  const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  const roi = row.roi;

  const Section = ({
    label,
    value,
    children,
    valueClass = "text-white",
    expandable = true,
  }: {
    label: string;
    value: string;
    children?: React.ReactNode;
    valueClass?: string;
    expandable?: boolean;
  }) => {
    const [open, setOpen] = useState(true);
    const hasChildren = !!children;
    return (
      <div className="border-b border-white/10 py-3">
        <button
          type="button"
          onClick={() => hasChildren && expandable && setOpen((o) => !o)}
          className="w-full flex items-center justify-between text-left"
        >
          <span className="text-base font-bold text-white flex items-center gap-1.5">
            {hasChildren && expandable && (
              <span className="text-white/90 text-sm w-3 inline-block">{open ? "−" : "+"}</span>
            )}
            {!hasChildren && <span className="w-3 inline-block" />}
            {label}
          </span>
          <span className={`text-base font-extrabold tabular-nums ${valueClass}`}>{value}</span>
        </button>
        {hasChildren && open && (
          <div className="pl-4 mt-2 space-y-1.5">{children}</div>
        )}
      </div>
    );
  };

  const SubRow = ({ label, value, valueClass = "text-white" }: { label: string; value: string; valueClass?: string }) => (
    <div className="flex items-center justify-between text-sm">
      <span className="text-white font-medium">{label}</span>
      <span className={`font-bold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );

  return (
    <main className="px-4 pb-24 pt-4 max-w-md mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-white hover:text-white/80 mb-4 text-sm font-bold"
      >
        <ArrowLeft className="h-5 w-5" />
        Back to records
      </button>

      {/* Product header */}
      <div className="flex items-start gap-3 mb-5">
        <div className="h-16 w-16 min-w-16 rounded-lg overflow-hidden bg-white/10 border border-white/10 shrink-0 flex items-center justify-center">
          {row.image_url ? (
            <img src={row.image_url} alt={row.title || row.asin} className="h-full w-full object-cover" />
          ) : (
            <Package className="h-6 w-6 text-white/70" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={`https://www.amazon.com/dp/${row.asin}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-base font-bold tracking-wider text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline active:underline font-mono uppercase"
              aria-label={`Open ${row.asin} on Amazon`}
            >
              {row.asin}
            </a>
            {(row.marketplaces && row.marketplaces.length > 0 ? row.marketplaces : ["US"]).map((m) => (
              <span
                key={m}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide bg-white/10 text-white border border-white/20"
              >
                {m}
              </span>
            ))}
          </div>
          <p className="text-sm font-semibold text-white leading-snug mt-1">{row.title || "—"}</p>
        </div>
      </div>

      {/* FBM shipping label cost — visible directly inside FBM records. */}
      {(row.hasFbmOrder || ((row.stockFbm ?? 0) > 0 && row.hasUnknownChannelOrder)) && (
        <button
          type="button"
          onClick={() => setLabelDialogOpen(true)}
          className="w-full mb-5 flex items-center justify-center gap-2 rounded-lg border border-amber-300/60 bg-amber-400/20 hover:bg-amber-400/30 text-amber-100 text-sm font-extrabold py-3 shadow-lg shadow-amber-950/20"
        >
          <Truck className="h-4 w-4" />
          Sync FBM Label Cost Now
        </button>
      )}

      <FbmLabelCostDialog
        open={labelDialogOpen}
        onOpenChange={setLabelDialogOpen}
        asin={row.asin}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
      />


      {/* Sections */}
      <div>
        <Section label="Sales" value={fmt(revenue)} valueClass="text-emerald-300">
          <SubRow label="Organic" value={fmt(revenue)} />
          <SubRow label="Sponsored Products (same day)" value={fmt(0)} />
          <SubRow label="Sponsored Display (same day)" value={fmt(0)} />
          <SubRow label="Direct sales" value={fmt(revenue)} />
          <SubRow label="Subscription sales (est.)" value={fmt(0)} />
        </Section>

        <Section label="Units" value={String(row.units)}>
          <SubRow label="Organic" value={String(row.units)} />
          <SubRow label="Sponsored Products (same day)" value="0" />
          <SubRow label="Sponsored Display (same day)" value="0" />
          <SubRow label="Direct units" value={String(row.units)} />
          <SubRow label="Subscription units (est.)" value="0" />
        </Section>

        <Section label="Refunds" value="0" expandable={false} />
        <Section label="Promo" value={fmt(0)} expandable={false} />

        <Section label="Advertising cost" value={fmt(0)} valueClass="text-amber-300">
          <SubRow label="Sponsored Products" value={fmt(0)} />
          <SubRow label="Sponsored Brands Video" value={fmt(0)} />
          <SubRow label="Sponsored Display" value={fmt(0)} />
          <SubRow label="Sponsored Brands" value={fmt(0)} />
        </Section>

        <Section label="Refund cost" value={fmt(0)} expandable={false} />

        <Section label="Amazon fees" value={`-${fmt(fees).replace("-", "")}`} valueClass="text-amber-300">
          {row.learnedFeesApplied && (
            <SubRow label="Raw SP-API estimate" value={`-${fmt(rawFees).replace("-", "")}`} valueClass="text-white/80" />
          )}
          {row.learnedFeesApplied && (
            <SubRow label="Learned pending estimate" value={`-${fmt(fees).replace("-", "")}`} valueClass="text-amber-200" />
          )}
          <SubRow label="FBA per unit fulfilment fee" value={`-${fmt(fbaFee).replace("-", "")}`} valueClass="text-amber-200" />
          <SubRow label="Referral fee" value={`-${fmt(referralFee).replace("-", "")}`} valueClass="text-amber-200" />
          {learnedFeeTitle && <div className="text-[11px] leading-snug text-white/65">{learnedFeeTitle}</div>}
        </Section>

        <Section label="Cost of goods" value={`-${fmt(cost).replace("-", "")}`} valueClass="text-blue-300" expandable={false} />

        <Section
          label="Gross profit"
          value={fmt(grossProfit)}
          valueClass={grossProfit >= 0 ? "text-emerald-300" : "text-red-300"}
          expandable={false}
        />
        <Section label="Indirect expenses" value={fmt(0)} expandable={false} />
        <Section
          label="Net profit"
          value={fmt(netProfit)}
          valueClass={netProfit >= 0 ? "text-emerald-300" : "text-red-300"}
          expandable={false}
        />
        <Section label="Estimated payout" value={fmt(payout)} valueClass="text-white" expandable={false} />
        <Section label="Real ACOS" value="0.00%" expandable={false} />
        <Section label="% Refunds" value="0.00%" expandable={false} />
        <Section label="Sellable returns" value="0.00%" expandable={false} />
        <Section
          label="Margin"
          value={`${margin.toFixed(2)}%`}
          valueClass={margin >= 0 ? "text-emerald-300" : "text-red-300"}
          expandable={false}
        />
        <Section
          label="ROI"
          value={roi !== null ? `${roi.toFixed(2)}%` : "—"}
          valueClass={roi !== null && roi >= 0 ? "text-emerald-300" : "text-red-300"}
          expandable={false}
        />
        <Section label="Active subscriptions (SnS)" value="0" expandable={false} />

        <Section label="Sessions" value="0">
          <SubRow label="Browser sessions" value="0" />
          <SubRow label="Mobile app sessions" value="0" />
        </Section>

        <Section label="Unit session percentage" value="0.00%" expandable={false} />
      </div>
    </main>
  );
};

/* ─────────── component ─────────── */

const MobileLiveSales = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { startBackgroundSync, syncState, isSyncing } = useSalesSync();
  const { homeMarketplace, homeCurrency, homeCurrencySymbol } = useHomeMarketplace();
  const [rows, setRows] = useState<AsinRow[]>([]);
  const [todaySummary, setTodaySummary] = useState({ units: 0, orders: 0, revenue: 0, fees: 0, cost: 0, profit: 0, roi: 0 });
  const [todayRefunds, setTodayRefunds] = useState({ amount: 0, count: 0 });
  // Settlement-level adjustments from financial_events_cache (mirrors LiveSales.tsx).
  // Excludes per-order referral/FBA/closing fees already in sales_orders.
  const [periodAdjustments, setPeriodAdjustments] = useState(EMPTY_ADJUSTMENTS);
  const [periodPromotions, setPeriodPromotions] = useState(EMPTY_PROMOTIONS);
  // Pending-estimate revenue + COGS for the SELECTED period — only used in
  // reconciled mode (settled FEC totals exclude pending orders). Mirrors
  // Sales Report's `pendingEstimateRevenue` so YTD net profit matches.
  const [periodPendingEst, setPeriodPendingEst] = useState(EMPTY_PENDING_EST);
  const [profitTraceSnapshot, setProfitTraceSnapshot] = useState<any>(null);
  // Coverage of financial_events_cache for the selected period — drives the
  // "Settlement data incomplete" amber banner on past-month tabs.
  const [fecCoverage, setFecCoverage] = useState<{ rows: number; loaded: boolean }>({ rows: 0, loaded: false });

  const [refundRecords, setRefundRecords] = useState<Array<{
    id: string;
    order_id: string | null;
    asin: string | null;
    title: string | null;
    image_url: string | null;
    marketplace: string | null;
    quantity: number;
    amount: number;
    order_date: string | null;
  }>>([]);
  const [refundsOpen, setRefundsOpen] = useState(false);
  const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);
  const [shippingCreditOpen, setShippingCreditOpen] = useState(false);
  const [shippingCreditOrders, setShippingCreditOrders] = useState<Array<{ order_id: string; asin: string | null; title: string | null; marketplace: string | null; order_date: string | null; quantity: number; shipping_price: number }>>([]);
  const [shippingCreditLoading, setShippingCreditLoading] = useState(false);
  const [resyncingRefunds, setResyncingRefunds] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);
  // fetchToday() can take a couple seconds (several sequential queries +
  // client-side computation), so showing a skeleton the instant
  // revalidating flips true made it flash almost continuously every poll
  // cycle. Only reveal the skeleton if a fetch is still running after 400ms
  // -- quick refreshes (the common case) update seamlessly with no flash;
  // only genuinely slow ones show the placeholder.
  const [showRevalidatingSkeleton, setShowRevalidatingSkeleton] = useState(false);
  useEffect(() => {
    if (!revalidating) {
      setShowRevalidatingSkeleton(false);
      return;
    }
    const t = setTimeout(() => setShowRevalidatingSkeleton(true), 400);
    return () => clearTimeout(t);
  }, [revalidating]);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fxRates, setFxRates] = useState<Record<string, number>>({ USD: 1 });
  // All revenue/fee/cost/profit figures throughout this page are computed in
  // USD internally (cross-marketplace accounting stays USD, unchanged) —
  // homeRate converts to the seller's home currency only at display time.
  // For a USD home currency (fxRates.USD is always 1), this is a no-op:
  // byte-identical to current behavior for every existing US-primary account.
  const homeRate = fxRates[homeCurrency] ?? 1;
  const [isAmazonConnected, setIsAmazonConnected] = useState<boolean | null>(null);
  const [connectedMarketplaces, setConnectedMarketplaces] = useState<string[]>([]);
  const [nowLabel, setNowLabel] = useState<string>("");
  const [sortKey, setSortKey] = useState<"units" | "revenue" | "profit" | "none">("none");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<AsinRow | null>(null);
  const [labelRow, setLabelRow] = useState<AsinRow | null>(null);
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>("ALL");
  const toggleSort = (key: "units" | "revenue" | "profit") => {
    if (sortKey !== key) { setSortKey(key); setSortDir("desc"); }
    else if (sortDir === "desc") setSortDir("asc");
    else { setSortKey("none"); setSortDir("desc"); }
  };
  const sortIndicator = (key: "units" | "revenue" | "profit") => sortKey !== key ? "↕" : sortDir === "desc" ? "↓" : "↑";
  
  const [period, setPeriod] = useState<Period>(() => {
    if (typeof window === "undefined") return "today";
    const saved = localStorage.getItem("lov.mobileLiveSales.period") as Period | null;
    return saved && PERIOD_ORDER.includes(saved) ? saved : "today";
  });
  // "vs Last Year" only applies to month-shaped periods (MTD / a specific
  // month) — cleared whenever the user switches to a period it can't apply to.
  const [compareLastYear, setCompareLastYear] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("lov.mobileLiveSales.compareLastYear") === "1";
  });
  const canCompareLastYear = period === "mtd" || period.startsWith("month_");
  const periodInfo = getPeriodRange(period, compareLastYear && canCompareLastYear);
  const sideTotalsKey = buildSideTotalsKey(periodInfo.start, periodInfo.end, marketplaceFilter || "ALL");

  useEffect(() => {
    try { localStorage.setItem("lov.mobileLiveSales.period", period); } catch {}
    if (!canCompareLastYear && compareLastYear) setCompareLastYear(false);
  }, [period, canCompareLastYear, compareLastYear]);

  useEffect(() => {
    try { localStorage.setItem("lov.mobileLiveSales.compareLastYear", compareLastYear ? "1" : "0"); } catch {}
  }, [compareLastYear]);

  // Sales mode is locked to 'smart' on Mobile Live Sales — the Smart/Estimated
  // toggle is hidden and Reconciled lives only in the P&L report. State stays
  // typed with all three values so downstream branches still typecheck, but
  // any previously persisted preference is coerced back to "smart".
  const [salesMode, setSalesMode] = useState<"smart" | "estimated" | "reconciled">("smart");

  useEffect(() => {
    try { localStorage.setItem("lov.mobileLiveSales.salesMode", salesMode); } catch {}
  }, [salesMode]);

  const fetchIdRef = useRef(0);
  // True for the whole lifetime of any in-flight fetchToday() call, reset
  // unconditionally when it finishes (unlike isStale()-gated loading/
  // revalidating resets below, which intentionally skip resetting when a
  // newer call has superseded an older one). Lets the 5s poll skip a tick
  // if the previous one hasn't finished yet, instead of overlapping and
  // leaving revalidating stuck true forever (every completing call finding
  // itself "stale" relative to the next one that already started).
  const fetchInFlightRef = useRef(false);
  /** When the page last re-read on being shown again; throttles that re-read. */
  const lastShownReadRef = useRef(0);
  const latestReconciledRequestIdRef = useRef("");
  const lastProfitRenderRef = useRef<any>(null);
  const lastSyncKickRef = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const hasDataRef = useRef(false);
  const todayRefundsRef = useRef(todayRefunds);
  useEffect(() => { todayRefundsRef.current = todayRefunds; }, [todayRefunds]);

  const fetchPromotionTotalsForRange = useCallback(async (
    rangeStart: string,
    rangeEnd: string,
    key: string,
    requestId: string,
  ) => {
    if (!user?.id) return { ...EMPTY_PROMOTIONS, key, loaded: true, requestId };
    const promo = await fetchPromotionDeductions({
      userId: user.id,
      rangeStart,
      rangeEnd,
      marketplace: marketplaceFilter || "ALL",
      // Mobile Live Sales: order-date attribution so the "Promotions
      // Deducted" line reflects orders purchased in this period.
      attributionMode: "order_date",
    });
    return { key, total: promo.totalUsd || 0, rows: promo.rows.length, loaded: true, requestId };
  }, [user?.id, marketplaceFilter]);

  const fetchAdjustmentTotalsForRange = useCallback(async (
    rangeStart: string,
    rangeEnd: string,
    key: string,
    requestId: string,
  ) => {
    if (!user?.id) return { ...EMPTY_ADJUSTMENTS, key, loaded: true, requestId };
    // NOTE: `fbm_shipping_label_fee` is intentionally EXCLUDED — per-order
    // FBM label cost comes from sales_orders.shipping_label_fee via
    // getSalesOrderFeesUsd. Counting it here too would double-count.
    const EXTRA_FEE_COLS = [
      "fba_inbound_fees","fba_inbound_convenience_fee","fba_storage_fees",
      "fba_long_term_storage_fees","fba_removal_fees","fba_disposal_fees",
      "fba_customer_return_fees","digital_services_fee","liquidations_brokerage_fee",
      "re_commerce_grading_charge","compensated_clawback","hrr_non_apparel",
      "restocking_fee","shipping_chargeback","other_fees",
    ];
    const CREDIT_COLS = [
      "reimbursements","liquidations","warehouse_lost","warehouse_damage",
      "reversal_reimbursement","free_replacement_refund_items","other_income",
    ];
    const INFO_LABEL_COLS = ["fbm_shipping_label_fee"];
    const SELECT = ["marketplace", ...EXTRA_FEE_COLS, ...CREDIT_COLS, ...INFO_LABEL_COLS].join(",");
    const PAGE = 1000;
    let extraFees = 0, credits = 0, events = 0, fbmLabelFees = 0;
    for (let from = 0; ; from += PAGE) {
      let q = supabase
        .from("financial_events_cache")
        .select(SELECT)
        .eq("user_id", user.id)
        .gte("event_date", rangeStart)
        .lte("event_date", rangeEnd)
        .range(from, from + PAGE - 1);
      if (marketplaceFilter && marketplaceFilter !== "ALL") {
        if (marketplaceFilter === "US") q = q.or("marketplace.eq.US,marketplace.is.null,marketplace.eq.UNKNOWN");
        else q = q.eq("marketplace", marketplaceFilter);
      }
      const { data, error } = await q;
      if (error || !data || data.length === 0) break;
      for (const r of data as any[]) {
        for (const k of EXTRA_FEE_COLS) extraFees += Math.abs(Number(r[k] || 0));
        for (const k of CREDIT_COLS) credits += Number(r[k] || 0);
        fbmLabelFees += Math.abs(Number(r.fbm_shipping_label_fee || 0));
        events++;
      }
      if (data.length < PAGE) break;
    }

    let shippingCollected = 0;
    try {
      let soIdsQ = supabase
        .from("sales_orders")
        .select("order_id")
        .eq("user_id", user.id)
        .gte("order_date", rangeStart)
        .lte("order_date", rangeEnd);
      if (marketplaceFilter && marketplaceFilter !== "ALL") {
        if (marketplaceFilter === "US") soIdsQ = soIdsQ.or("marketplace.eq.US,marketplace.is.null");
        else soIdsQ = soIdsQ.eq("marketplace", marketplaceFilter);
      }
      const orderIds = new Set<string>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await soIdsQ.range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const r of data as any[]) if (r?.order_id) orderIds.add(String(r.order_id));
        if (data.length < PAGE) break;
      }
      const ids = Array.from(orderIds);
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { data: fecShip } = await supabase
          .from("financial_events_cache")
          .select("shipping_credits, shipping_credit_refunds")
          .eq("user_id", user.id)
          .in("amazon_order_id", slice);
        for (const r of (fecShip as any[]) || []) {
          shippingCollected += Number(r.shipping_credits || 0) + Number(r.shipping_credit_refunds || 0);
        }
      }
    } catch (e) {
      console.warn("[MobileLiveSales] shippingCollected (order-date) fetch failed:", e);
    }

    return { key, net: credits - extraFees, extraFees, credits, events, shippingCollected, fbmLabelFees, loaded: true, requestId };
  }, [user?.id, marketplaceFilter]);

  // Pending-estimate bucket for the SELECTED period — used in reconciled mode
  // because `get_fec_daily_shipment_totals` excludes orders that haven't
  // settled yet. Mirrors LiveSales' `pendingEstimateRevenue` aggregator.
  // FX-converted to USD, only counts rows with confirmed price missing and a
  // positive `estimated_price` (matches `getEstimatedPendingRevenueNative`).
  const fetchPendingEstTotalsForRange = useCallback(async (
    rangeStart: string,
    rangeEnd: string,
    key: string,
    requestId: string,
    toUsd: (amount: number, mp: string | null | undefined) => number,
  ) => {
    if (!user?.id) return { ...EMPTY_PENDING_EST, key, loaded: true, requestId };
    let revenueUsd = 0;
    let cogsUsd = 0;
    let units = 0;
    const orderIds = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      let q = supabase
        .from("sales_orders")
        .select("order_id,quantity,sold_price,total_sale_amount,estimated_price,unit_cost_at_sale,marketplace,is_cancelled,is_replacement,order_status,order_type")
        .eq("user_id", user.id)
        .gte("order_date", rangeStart)
        .lte("order_date", rangeEnd)
        .gt("estimated_price", 0)
        .or("sold_price.is.null,sold_price.eq.0")
        .or("total_sale_amount.is.null,total_sale_amount.eq.0")
        .range(from, from + PAGE - 1);
      if (marketplaceFilter && marketplaceFilter !== "ALL") {
        if (marketplaceFilter === "US") q = q.or("marketplace.eq.US,marketplace.is.null");
        else q = q.eq("marketplace", marketplaceFilter);
      }
      const { data, error } = await q;
      if (error || !data || data.length === 0) break;
      for (const r of data as any[]) {
        if (r.is_cancelled === true) continue;
        const status = String(r.order_status || "").toLowerCase();
        if (status === "canceled" || status === "cancelled") continue;
        if ((r as any).is_replacement === true) continue;
        const qty = Math.max(1, Number(r.quantity || 0));
        const native = Number(r.estimated_price || 0) * qty;
        if (native <= 0) continue;
        revenueUsd += toUsd(native, r.marketplace);
        const cost = Number(r.unit_cost_at_sale || 0) * qty;
        if (cost > 0) cogsUsd += cost; // unit_cost_at_sale is already USD-locked
        units += qty;
        if (r.order_id) orderIds.add(String(r.order_id));
      }
      if (data.length < PAGE) break;
    }
    return {
      key,
      revenueUsd: Math.round(revenueUsd * 100) / 100,
      cogsUsd: Math.round(cogsUsd * 100) / 100,
      orders: orderIds.size,
      units,
      loaded: true,
      requestId,
    };
  }, [user?.id, marketplaceFilter]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const run = async () => {
      try {
        const { start: rangeStart, end: rangeEnd } = getPeriodRange(period, compareLastYear && canCompareLastYear);
        const key = buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL");
        const requestId = `promo-${Date.now().toString(36)}`;
        if (salesMode === "reconciled") return;
        const promo = await fetchPromotionTotalsForRange(rangeStart, rangeEnd, key, requestId);
        if (!cancelled) setPeriodPromotions(promo);
      } catch (e) {
        if (!cancelled) console.warn("[MobileLiveSales] promotion deductions fetch failed:", e);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [user?.id, period, compareLastYear, canCompareLastYear, marketplaceFilter, salesMode, fetchPromotionTotalsForRange]);

  // FX rates
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("fx_rates").select("quote, rate");
      if (data) {
        const map: Record<string, number> = { USD: 1 };
        for (const r of data) map[r.quote] = Number(r.rate) || 1;
        setFxRates(map);
      }
    })();
  }, []);

  // Settlement-level adjustments (FEC) for the SELECTED period — mirrors
  // LiveSales.tsx. Excludes per-order referral / FBA / variable+fixed closing
  // fees (already in sales_orders) to avoid double-counting.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const run = async () => {
      try {
        const { start: rangeStart, end: rangeEnd } = getPeriodRange(period, compareLastYear && canCompareLastYear);
        const key = buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL");
        const requestId = `adj-${Date.now().toString(36)}`;
        if (salesMode === "reconciled") return;
        const adjustments = await fetchAdjustmentTotalsForRange(rangeStart, rangeEnd, key, requestId);
        if (cancelled) return;
        setPeriodAdjustments(adjustments);
      } catch (e) {
        if (!cancelled) console.warn("[MobileLiveSales] periodAdjustments fetch failed:", e);
      }
    };
    run();
    // CPU-pressure control: periodic 120s auto-refresh removed.
    return () => { cancelled = true; };
  }, [user?.id, period, compareLastYear, canCompareLastYear, marketplaceFilter, salesMode, fetchAdjustmentTotalsForRange]);

  // FEC coverage probe — how many financial_events_cache rows exist for the
  // selected period. Drives the amber "Settlement data incomplete" banner.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { start: rangeStart, end: rangeEnd } = getPeriodRange(period, compareLastYear && canCompareLastYear);
        let q = supabase
          .from("financial_events_cache")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("event_date", rangeStart)
          .lte("event_date", rangeEnd);
        if (marketplaceFilter && marketplaceFilter !== "ALL") {
          if (marketplaceFilter === "US") q = q.or("marketplace.eq.US,marketplace.is.null");
          else q = q.eq("marketplace", marketplaceFilter);
        }
        const { count } = await q;
        if (!cancelled) setFecCoverage({ rows: count ?? 0, loaded: true });
      } catch {
        if (!cancelled) setFecCoverage({ rows: 0, loaded: true });
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, period, compareLastYear, canCompareLastYear, marketplaceFilter]);



  // Connection check
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("seller_authorizations")
        .select("marketplace_id")
        .eq("user_id", user.id);
      setIsAmazonConnected(!!(data && data.length > 0));
      setConnectedMarketplaces([...new Set((data || []).map((d) => getMarketplaceFromId(d.marketplace_id)))]);
    })();
  }, [user?.id]);

  // Build a unique cache key per period. Forecast shares the MTD cache because
  // it derives from the same row set (linear projection in the render layer).
  const cacheKeyForPeriod = useCallback((p: Period, compareYr: boolean = false): string => {
    const applyCompare = compareYr && (p === "mtd" || p.startsWith("month_"));
    const info = getPeriodRange(p, applyCompare);
    // v19: invalidate cached rows computed before the snapshot
    // currency-tagging fix (USD-tagged inventory snapshots were previously
    // read as native currency and double-FX-converted, e.g. MX$19 -> $1.09).
    const V = `v19-${marketplaceFilter}-${salesMode}${applyCompare ? "-cmpLY" : ""}`;

    if (p === "today") return `${info.start}-${V}`;
    if (p === "yesterday") return `yesterday-${info.start}-${V}`;
    if (p === "this_week") return `week-${info.start}-${V}`;
    if (p === "ytd") return `ytd-${info.start.slice(0, 4)}-${V}`;
    if (p === "last_month") return `lastmonth-${info.start.slice(0, 7)}-${V}`;
    if (p === "last_year") return `lastyear-${info.start.slice(0, 4)}-${V}`;
    if (p.startsWith("month_")) return `month-${info.start.slice(0, 7)}-${V}`;
    // mtd & forecast → same key (same underlying data)
    return `mtd-${info.start.slice(0, 7)}-${V}`;
  }, [marketplaceFilter, salesMode]);

  useEffect(() => {
    if (!user?.id) return;
    // "Today" is where a Pending order's price can still transition from
    // estimate to confirmed, so its cached cold-open paint gets a much
    // shorter max age than settled historical periods.
    const snap = loadMobileLiveSalesCache(
      user.id,
      cacheKeyForPeriod(period, compareLastYear),
      period === "today" ? TODAY_CACHE_MAX_AGE_MS : undefined,
    );
    const cacheHasContent =
      !!snap && ((snap.rows && snap.rows.length > 0) || snap.todaySummary.units > 0 || snap.todaySummary.revenue > 0);
    // Reconciled YTD takes minutes on first fetch. If any prior snapshot exists
    // for this period (even with incomplete side-loads), paint it immediately and
    // let the live fetch revalidate. Avoids the 5-minute skeleton.
    if (snap && cacheHasContent) {
      setRows(snap.rows as AsinRow[]);
      setTodaySummary(snap.todaySummary);
      setTodayRefunds(snap.todayRefunds);
      if (snap.periodAdjustments) setPeriodAdjustments(snap.periodAdjustments);
      if (snap.periodPromotions) setPeriodPromotions(snap.periodPromotions);
      if ((snap as any).periodPendingEst) setPeriodPendingEst((snap as any).periodPendingEst);
      if (snap.profitTrace) {
        setProfitTraceSnapshot(snap.profitTrace);
        if (snap.profitTrace.requestId) latestReconciledRequestIdRef.current = snap.profitTrace.requestId;
      }
      hasDataRef.current = true;
      setLoading(false);
      setRevalidating(true);
    } else {
      // No cache for this period — clear stale display while we fetch.
      hasDataRef.current = false;
      setRows([]);
      setTodaySummary(EMPTY_SUMMARY);
      setTodayRefunds({ amount: 0, count: 0 });
      setPeriodAdjustments(EMPTY_ADJUSTMENTS);
      setPeriodPromotions(EMPTY_PROMOTIONS);
      setPeriodPendingEst(EMPTY_PENDING_EST);
      setProfitTraceSnapshot(null);
      setLoading(true);
    }
    setCacheHydrated(true);
  }, [user?.id, period, cacheKeyForPeriod, salesMode, compareLastYear]);



  // Local wall-clock label (business-day cutoff stays PT — only the on-screen
  // clock follows the viewer's device timezone so it matches their watch).
  useEffect(() => {
    const update = () => {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      }).formatToParts(new Date());
      const time = parts.filter(p => p.type !== "timeZoneName").map(p => p.value).join("");
      const tz = parts.find(p => p.type === "timeZoneName")?.value || "";
      setNowLabel(`${time} ${tz}`.trim());
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);



  const fetchToday = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!user?.id || isAmazonConnected === null) return;
    const myFetchId = ++fetchIdRef.current;
    const isStale = () => fetchIdRef.current !== myFetchId;
    fetchInFlightRef.current = true;
    // SWR: if we already have data on screen (cache hydrated or prior fetch),
    // revalidate silently instead of blanking the UI with a full-screen loader.
    // Fully silent (background poll) calls skip this entirely -- no skeleton,
    // no loading indicator, just a quiet data update. The skeleton is
    // reserved for deliberate actions: first load, manual Refresh, and
    // switching periods (Today/Yesterday/MTD/YTD).
    if (!silent) {
      if (hasDataRef.current) setRevalidating(true);
      else setLoading(true);
    }
    setError(null);

    try {
      const applyCompareLY = compareLastYear && (period === "mtd" || period.startsWith("month_"));
      const { start: rangeStart, end: rangeEnd } = getPeriodRange(period, applyCompareLY);
      const toUsd = (amount: number, mp: string | null | undefined) => {
        const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
        if (currency === "USD") return amount;
        const rate = fxRates[currency];
        return rate && rate > 0 ? amount / rate : amount;
      };
      let nextPeriodAdjustments: typeof EMPTY_ADJUSTMENTS | null = null;
      let nextPeriodPromotions: typeof EMPTY_PROMOTIONS | null = null;
      let nextPeriodPendingEst: typeof EMPTY_PENDING_EST | null = null;
      let nextProfitTraceSnapshot: any = null;

      // Refunds posted in this period — NET impact from financial_events_cache (matches desktop Live Sales).
      // Excludes pass-through tax. Applies Amazon's refund admin retention = min($5.00, 20% × referral fee).
      let nextRefundRecords: typeof refundRecords = [];
      let nextRefundSummary = { amount: 0, count: 0 };
      try {
        const fecRefunds = await fetchAllPages<any>(() => {
          let q = supabase
            .from("financial_events_cache")
            .select("amazon_order_id, asin, marketplace, event_date, refunds, promotional_rebate_refunds, shipping_credit_refunds, shipping_chargeback_refund, gift_wrap_credit_refunds, referral_fees, fba_fees, fba_customer_return_fees, restocking_fee, other_fees, digital_services_fee, reversal_reimbursement")
            .eq("user_id", user.id)
            .eq("event_type", "refund")
            .gte("event_date", rangeStart)
            .lte("event_date", rangeEnd)
            .order("event_date", { ascending: false });
          if (marketplaceFilter && marketplaceFilter !== "ALL") {
            if (marketplaceFilter === "US") q = q.or("marketplace.eq.US,marketplace.is.null");
            else q = q.eq("marketplace", marketplaceFilter);
          }
          return q;
        }, { label: "MobileLiveSales FEC refunds" });

        if (isStale()) return;

        let totalNetUsd = 0;
        const orderSet = new Set<string>();
        const perOrderNet: Record<string, { net: number; mkt: string | null; date: string | null; asin: string | null }> = {};

        for (const r of (fecRefunds || []) as any[]) {
          // CANONICAL NET refund cost via shared helper, applied per-row to
          // preserve per-order USD attribution. See src/lib/sales/refundMath.ts
          // and architecture-audit.md §1.2.
          //
          // refundCostNet is ALREADY in USD — computeNetRefundFromFecRows
          // operates on financial_events_cache columns (refunds, referral_fees,
          // etc.), which the ingestion sync converts to USD before writing.
          // Passing it through toUsd() here divided it by the marketplace FX
          // rate a SECOND time (e.g. MX $8.52 real refund -> $0.49 displayed —
          // confirmed live against order 701-0390947-3179428, MX$164.18).
          const rowCanon = computeNetRefundFromFecRows([r], 'full');
          const usd = rowCanon.refundCostNet;
          totalNetUsd += usd;
          if (r.amazon_order_id) {
            orderSet.add(r.amazon_order_id);
            const prev = perOrderNet[r.amazon_order_id];
            perOrderNet[r.amazon_order_id] = {
              net: (prev?.net || 0) + usd,
              mkt: prev?.mkt || r.marketplace,
              date: prev?.date || r.event_date,
              asin: prev?.asin || r.asin,
            };
          }
        }

        // Enrich with product info from sales_orders for the drawer
        const orderIds = Array.from(orderSet);
        const enrich: Record<string, { asin: string | null; title: string | null; image_url: string | null; quantity: number | null }> = {};
        if (orderIds.length > 0) {
          const { data: so } = await supabase
            .from("sales_orders")
            .select("order_id, asin, title, image_url, quantity")
            .eq("user_id", user.id)
            .in("order_id", orderIds)
            .not("asin", "in", "(PENDING,UNKNOWN)");
          (so || []).forEach((row: any) => {
            if (!enrich[row.order_id] && row.asin) {
              enrich[row.order_id] = { asin: row.asin, title: row.title, image_url: row.image_url, quantity: row.quantity };
            }
          });
        }

        nextRefundRecords = orderIds.map((oid, i) => {
          const p = perOrderNet[oid];
          const e = enrich[oid];
          return {
            id: `fec-${oid}-${i}`,
            order_id: oid,
            asin: e?.asin || p?.asin || null,
            title: e?.title || null,
            image_url: e?.image_url || null,
            marketplace: p?.mkt || null,
            quantity: e?.quantity || 1,
            amount: Math.max(0, Math.round((p?.net || 0) * 100) / 100),
            order_date: p?.date || null,
          };
        }).filter(r => r.amount > 0);

        nextRefundSummary = {
          amount: Math.max(0, Math.round(totalNetUsd * 100) / 100),
          count: nextRefundRecords.length,
        };
      } catch (e) {
        console.warn("[MobileLiveSales] refunds fetch failed", e);
      }


      const todayData: any[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        if (isStale()) return;
        let salesOrdersQuery = supabase
          .from("sales_orders")
            .select(
              "id, order_id, asin, sku, seller_sku, title, image_url, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, order_date, purchase_timestamp_utc, is_cancelled, is_replacement, order_status, order_type, marketplace, fulfillment_channel, referral_fee, fba_fee, closing_fee, total_fees, fees_source, unit_cost, unit_cost_at_sale, cost_source_at_sale, cost_locked, total_cost, price_source, price_calc_mode, price_confidence, needs_price_enrich, price_enrich_status, shipping_label_fee, promotion_discount, promotion_discount_currency",
            )
          .eq("user_id", user.id)
          .gte("order_date", rangeStart)
          .lte("order_date", rangeEnd)
          .not("order_id", "like", "%-REFUND")
          // Stable pagination is mandatory for large YTD ranges. Ordering only by
          // purchase_timestamp_utc is non-unique and PostgREST can skip/duplicate
          // rows between pages, which made mobile fees/COGS/revenue drift from Sales Report.
          .order("order_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        salesOrdersQuery = applySalesReportMarketplaceFilter(salesOrdersQuery, marketplaceFilter);
        const { data: page, error: pageErr } = await salesOrdersQuery;
        if (pageErr) throw pageErr;
        if (!page || page.length === 0) break;
        todayData.push(...page);
        if (page.length < PAGE) break;
      }

      const valid = todayData.filter((row: any) => {
        if (row.is_cancelled === true) return false;
        const status = String(row.order_status || "").toLowerCase();
        if (status === "canceled" || status === "cancelled") return false;
        if (row.is_replacement === true) return false;
        return true;
      });

      const deduped = dedupeSalesRowsForLiveTotals(valid);

      const usdUnitPricesForAvg: number[] = [];
      const usdUnitPricesByAsin = new Map<string, number[]>();
      for (const r of deduped as any[]) {
        const confirmedUnitUsd = getConfirmedSalesOrderUnitRevenueUsd(r, toUsd);
        const unitUsd = confirmedUnitUsd > 0
          ? confirmedUnitUsd
          : toUsd(getSalesReportUnitPriceForAverage(r), r.marketplace);
        if (unitUsd <= 0) continue;
        usdUnitPricesForAvg.push(unitUsd);
        const asinKey = String(r.asin || "").trim();
        if (asinKey) {
          const bucket = usdUnitPricesByAsin.get(asinKey) || [];
          bucket.push(unitUsd);
          usdUnitPricesByAsin.set(asinKey, bucket);
        }
      }
      const avgUnitPriceUsd = usdUnitPricesForAvg.length > 0 ? usdUnitPricesForAvg.reduce((s, p) => s + p, 0) / usdUnitPricesForAvg.length : 0;
      const asinAvgUsdUnitPrice = new Map<string, number>();
      for (const [asinKey, prices] of usdUnitPricesByAsin) {
        asinAvgUsdUnitPrice.set(asinKey, prices.reduce((s, p) => s + p, 0) / prices.length);
      }

      // Unified COGS resolver — single source of truth (matches SQL
      // resolve_unit_cost_v1 / get_cogs_for_range used by P&L).
      const cogsResolver = await buildCogsResolver(
        user.id,
        deduped.map((r: any) => ({
          asin: String(r.asin || "").trim(),
          sku: String(r.sku || r.seller_sku || "").trim(),
        })),
      );

      const asinSet = new Set<string>();
      for (const r of deduped) {
        const asin = String(r.asin || "").trim();
        if (asin) asinSet.add(asin);
      }

      // ── Same-ASIN recent price fallback for pending intl rows that have no price yet ──
      // The fallback is stored in USD so MX/CA/BR missing-price rows don't get divided by FX twice.
      const historicalUsdUnitByAsin = new Map<string, number>();
      if (asinSet.size > 0) {
        const historyStart = addDaysISO(rangeStart, -90);
        const { data: historyRows } = await supabase
          .from("sales_orders")
            .select("asin, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, marketplace, price_source, price_calc_mode, price_confidence, order_date, updated_at, promotion_discount, promotion_discount_currency")
          .eq("user_id", user.id)
          .in("asin", Array.from(asinSet))
          .gte("order_date", historyStart)
          .lte("order_date", rangeEnd)
          .not("order_id", "like", "%-REFUND")
          .or("sold_price.gt.0,total_sale_amount.gt.0,estimated_price.gt.0")
          .order("order_date", { ascending: false })
          .order("updated_at", { ascending: false })
          .limit(500);
        if (historyRows) {
          for (const h of historyRows as any[]) {
            const asinKey = String(h.asin || "").trim();
            if (!asinKey || historicalUsdUnitByAsin.has(asinKey) || isLowConfidencePending(h)) continue;
            const confirmedUnitUsd = getConfirmedSalesOrderUnitRevenueUsd(h, toUsd);
            const unitUsd = confirmedUnitUsd > 0 ? confirmedUnitUsd : toUsd(getSalesReportUnitPriceForAverage(h), h.marketplace);
            if (unitUsd > 0) historicalUsdUnitByAsin.set(asinKey, unitUsd);
          }
        }
      }

      const inventoryUsdUnitByAsin = new Map<string, number>();
      if (asinSet.size > 0) {
        const { data: listingRows } = await supabase
          .from("created_listings")
          .select("asin, price")
          .eq("user_id", user.id)
          .in("asin", Array.from(asinSet))
          .gt("price", 0)
          .order("created_at", { ascending: false })
          .limit(500);
        if (listingRows) {
          for (const item of listingRows as any[]) {
            const asinKey = String(item.asin || "").trim();
            const priceUsd = Number(item.price || 0);
            if (asinKey && priceUsd > 0 && !inventoryUsdUnitByAsin.has(asinKey)) {
              inventoryUsdUnitByAsin.set(asinKey, priceUsd);
            }
          }
        }

        const { data: invRows } = await supabase
          .from("inventory")
          .select("asin, price, my_price, amazon_price")
          .eq("user_id", user.id)
          .in("asin", Array.from(asinSet))
          .order("updated_at", { ascending: false })
          .limit(500);
        if (invRows) {
          for (const item of invRows as any[]) {
            const asinKey = String(item.asin || "").trim();
            const priceUsd = Number(item.price || item.my_price || item.amazon_price || 0);
            if (asinKey && priceUsd > 0 && !inventoryUsdUnitByAsin.has(asinKey)) {
              inventoryUsdUnitByAsin.set(asinKey, priceUsd);
            }
          }
        }
      }

      const getFallbackUsdUnitPrice = (asin: string) =>
        asinAvgUsdUnitPrice.get(asin) ||
        historicalUsdUnitByAsin.get(asin) ||
        inventoryUsdUnitByAsin.get(asin) ||
        0;

      const getRevenueUsdWithFallback = (row: any, asin: string) => {
        const qty = Math.max(1, Number(row.quantity || 0));
        const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
        // Confirmed revenue is normally USD; guard legacy non-US rows where raw
        // ItemPrice was accidentally stored in native currency (MX$1420 => $79.32).
        const confirmedUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
        if (confirmedUsd > 0) return confirmedUsd;
        const nativeEstimate = getMarketplaceNativeEstimate(row, asin);
        if (nativeEstimate > 0) return toUsd(nativeEstimate * qty, mp);
        // No zero-guard for pending rows: show per-ASIN USD average as last
        // resort so the BB-fallback estimate is visible while we await ItemPrice.
        const fallbackUnitUsd = getFallbackUsdUnitPrice(asin);
        return fallbackUnitUsd > 0 ? fallbackUnitUsd * qty : 0;
      };


      const snapshotNativeUnitByOrder = new Map<string, number>();
      if (deduped.length > 0) {
        const orderMarketplaceMap = new Map<string, string>();
        for (const r of deduped as any[]) {
          const oid = normalizeOrderId(r.order_id);
          if (oid && !orderMarketplaceMap.has(oid)) {
            orderMarketplaceMap.set(oid, String(r.marketplace || "US").trim().toUpperCase() || "US");
          }
        }
        const orderIdsForSnapshots = Array.from(orderMarketplaceMap.keys());
        for (let i = 0; i < orderIdsForSnapshots.length; i += 200) {
          const chunk = orderIdsForSnapshots.slice(i, i + 200);
          const { data: snapshotRows } = await supabase
            .from("order_price_snapshots")
            .select("order_id, asin, snapshot_item_price, currency, currency_code, captured_at")
            .eq("user_id", user.id)
            .in("order_id", chunk)
            .gt("snapshot_item_price", 0)
            .order("captured_at", { ascending: false });
          for (const snap of (snapshotRows || []) as any[]) {
            const orderId = normalizeOrderId(snap.order_id);
            const asin = String(snap.asin || "").trim();
            if (!orderId || !asin) continue;
            const key = `${orderId}::${asin}`;
            if (snapshotNativeUnitByOrder.has(key)) continue;
            const snapshotPrice = Number(snap.snapshot_item_price || 0);
            const snapshotMarketCurrency = String(snap.currency_code || snap.currency || "").trim().toUpperCase();
            if (snapshotPrice <= 0) continue;
            const mp = orderMarketplaceMap.get(orderId) || "US";
            // currency_code is the ACTUAL currency the stored number is in
            // (accurate as of the snapshot-capture currency fix — see
            // fetch-live-orders/index.ts SNAPSHOT_CAPTURE_CURRENCY_FIX).
            // Only treat snapshotPrice as native when that currency really is
            // the marketplace's native currency. A 'USD'-tagged snapshot for
            // a non-US marketplace is an inventory-sourced value, NOT a
            // native price — storing it here as "native" caused it to be
            // divided by the FX rate a second time downstream (e.g. MX$19
            // read as native MXN -> $1.09 instead of $19). Skip those and
            // let the locked_est_price/estimated_price fallback chain in
            // getMarketplaceNativeEstimate() handle them instead.
            const isUsdTaggedNonUs = snapshotMarketCurrency === "USD" && mp !== "US";
            if (!isUsdTaggedNonUs) {
              snapshotNativeUnitByOrder.set(key, snapshotPrice);
            }
          }

        }
      }

      // Map keyed by asin|marketplace|sku (exact match) AND asin|marketplace
      // (enabled fallback). Multiple assignments can exist per ASIN (one per
      // SKU) — picking blindly returns stale disabled rows for other SKUs.
      const assignmentNativeUnitByAsinSku = new Map<string, number>();
      const assignmentNativeUnitEnabled = new Map<string, number>();
      if (asinSet.size > 0) {
        const { data: assignmentRows } = await supabase
          .from("repricer_assignments")
          .select("asin, sku, marketplace, is_enabled, last_applied_price, last_recommended_price, last_buybox_price, detected_offer_price")
          .eq("user_id", user.id)
          .in("asin", Array.from(asinSet));
        for (const item of (assignmentRows || []) as any[]) {
          const mp = String(item.marketplace || "US").trim().toUpperCase() || "US";
          const price =
            Number(item.last_applied_price || 0) ||
            Number(item.last_recommended_price || 0) ||
            Number(item.detected_offer_price || 0) ||
            Number(item.last_buybox_price || 0) ||
            0;
          if (price <= 0) continue;
          const sku = String(item.sku || "").trim();
          if (sku) {
            assignmentNativeUnitByAsinSku.set(`${asinMarketplaceKey(item.asin, mp)}::${sku}`, price);
          }
          if (item.is_enabled && !assignmentNativeUnitEnabled.has(asinMarketplaceKey(item.asin, mp))) {
            assignmentNativeUnitEnabled.set(asinMarketplaceKey(item.asin, mp), price);
          }
        }
      }

      const feeByAsin = new Map<string, FeeCacheEntry>();
      if (asinSet.size > 0) {
        const { data: feeRows } = await supabase
          .from("asin_fee_cache")
          .select("asin, marketplace, fba_fee_fixed, referral_rate, is_media")
          .eq("user_id", user.id)
          .in("asin", Array.from(asinSet));
        for (const f of (feeRows || []) as any[]) {
          const key = feeCacheKey(f.asin, f.marketplace);
          if (f.asin && !feeByAsin.has(key)) {
            feeByAsin.set(key, {
              fba: Number(f.fba_fee_fixed) || 0,
              refRate: Number(f.referral_rate) || 0.15,
              isMedia: Boolean(f.is_media),
              // asin_fee_cache.fba_fee_fixed is stored in USD (writer contract,
              // post-2026-06-20 backfill currency fix). Do NOT re-convert via FX.
              marketplaceNativeFixedFee: false,
            });

          }
        }
      }

      // Phase 2: learned international fee multipliers (CA/MX/BR pending only).
      // Mirrors LiveSales.tsx. Confirmed/settled rows are never touched — the
      // helper guards on price_confidence + sold_price + total_sale_amount.
      // See mem://features/sales/learned-intl-fee-multipliers-v1.
      const learnedFeeSettings: LearnedFeeSettings = await loadLearnedFeeSettings(supabase, user.id);
      const learnedFeeMultipliers: LearnedFeeMultiplierMap = await loadLearnedFeeMultipliers(supabase, user.id);
      const asinFeeMultipliers: AsinFeeMultiplierMap = await loadAsinFeeMultipliers(supabase, user.id);

      const getMarketplaceNativeEstimate = (row: any, asin: string) => {
        const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
        // Historical sale price lock wins before any live repricer read. Once an
        // order has a snapshot / locked estimate / stored estimate, the displayed
        // sale price must not move when repricer_assignments.last_applied_price changes.
        const snapshot = snapshotNativeUnitByOrder.get(`${normalizeOrderId(row.order_id)}::${asin}`);
        if (snapshot && snapshot > 0) return snapshot;
        const lockedEstimate = Number(row.locked_est_price || 0);
        if (lockedEstimate > 0) return lockedEstimate;
        const storedEstimate = Number(row.estimated_price || 0);
        if (storedEstimate > 0) return storedEstimate;

        // Last resort for genuinely unpriced same-day pending rows only: read the
        // current repricer price by exact ASIN+marketplace+SKU, never arbitrary ASIN.
        const orderSku = String(row.sku || row.seller_sku || "").trim();
        if (orderSku) {
          const bySku = assignmentNativeUnitByAsinSku.get(`${asinMarketplaceKey(asin, mp)}::${orderSku}`);
          if (bySku && bySku > 0) return bySku;
        }
        const enabled = assignmentNativeUnitEnabled.get(asinMarketplaceKey(asin, mp));
        if (enabled && enabled > 0) return enabled;
        return 0;
      };


      const asinMap = new Map<string, AsinRow & { _orderIds: Set<string>; _marketplaces: Set<string> }>();
      let totalUnits = 0;
      let totalRevenue = 0;
      let totalFees = 0;
      let totalCost = 0;
      const allOrderIds = new Set<string>();
      // Per-day estimated totals — used by Reconciled mode to supplement unsettled days
      // (today / very recent) where FEC settlement data has not yet posted.
      const estByDay = new Map<string, { units: number; revenue: number; fees: number; cost: number }>();

      // ASINs with at least one order still order_status="Pending" whose price
      // resolved via the locked_est_price/estimated_price fallback tier rather
      // than a confirmed source (total_sale_amount/sold_price). These orders can
      // still transition to a confirmed price at any time, so their row is a
      // snapshot-caching risk: excluded from the persisted localStorage cache
      // below (never from the live on-screen state) so a cold-open paint can
      // never show a stale pre-confirmation number after it has settled.
      const riskyAsins = new Set<string>();

      for (const row of deduped) {
        const asin = (row.asin || "").trim();
        if (!asin) continue;
        const qty = Math.max(1, Number(row.quantity || 0));
        const lineRevenue = getRevenueUsdWithFallback(row, asin);
        const pendingUnits = lineRevenue <= 0 ? qty : 0;
        const isConfirmedRevenue = getConfirmedSalesOrderRevenueUsd(row, toUsd) > 0;
        if (String((row as any).order_status || "").trim() === "Pending" && !isConfirmedRevenue) {
          riskyAsins.add(asin);
        }

        const feeBasisUsd = lineRevenue > 0 ? lineRevenue : 0;

        const feeBreak = getSalesOrderFeeBreakdownUsd(row as any, feeBasisUsd, toUsd);
        let feesUsd = feeBreak.total;
        let rawFeesUsd = feeBreak.total;
        let referralUsd = feeBreak.referral;
        let fbaUsd = feeBreak.fba + feeBreak.label; // include FBM shipping label with FBA bucket
        let feeCacheMissingNonUs = false;
        if (feesUsd <= 0 && feeBasisUsd > 0) {
          const cached = feeByAsin.get(feeCacheKey(asin, row.marketplace));
          if (cached) {
            feesUsd = getCachedFeesUsd(cached, feeBasisUsd, qty, row.marketplace, toUsd);
            rawFeesUsd = feesUsd;
            referralUsd = feeBasisUsd * (cached.refRate > 0 ? cached.refRate : 0.15);
            fbaUsd = Math.max(0, feesUsd - referralUsd);
          } else if (isFeeCacheMissingForNonUs({
            marketplace: row.marketplace,
            storedFeeTotalUsd: feeBreak.total,
            hasCacheEntry: false,
            revenueUsd: feeBasisUsd,
          })) {
            feeCacheMissingNonUs = true;
          }
        }
        const closingUsd = feeBreak.closing;

        // Learned multiplier (pending CA/MX/BR only — guarded inside helper).
        // Scale every fee bucket proportionally so the detail breakdown sums
        // to the adjusted total. Raw SP-API estimate stays untouched on
        // sales_orders; this only affects on-screen pending estimates.
        const learnedFee = applyLearnedFeeMultiplier({
          row: row as any,
          rawFeesUsd: feesUsd,
          settings: learnedFeeSettings,
          multipliers: learnedFeeMultipliers,
          asinMultipliers: asinFeeMultipliers,
        });
        if (learnedFee.applied && learnedFee.multiplier && learnedFee.multiplier > 0) {
          const m = learnedFee.multiplier;
          feesUsd = learnedFee.feesUsd;
          referralUsd = referralUsd * m;
          fbaUsd = fbaUsd * m;
        }




        // Unified COGS resolver — locked sale-time snapshot wins, then
        // date-aware purchases/listings, then low-confidence current inventory.
        const sku = String((row as any).sku || (row as any).seller_sku || "").trim();
        const { unitCost } = cogsResolver.resolve({
          asin,
          sku,
          order_date: (row as any).order_date || null,
          unit_cost: Number((row as any).unit_cost) || 0,
          unit_cost_at_sale: Number((row as any).unit_cost_at_sale) || 0,
          cost_source_at_sale: (row as any).cost_source_at_sale || null,
          cost_locked: (row as any).cost_locked === true,
        });
        const lineCost = unitCost * qty;

        totalUnits += qty;
        totalRevenue += lineRevenue;
        totalFees += feesUsd;
        totalCost += lineCost;

        // Track per-day estimated totals for Reconciled-mode unsettled supplement.
        const _day = String((row as any).order_date || "").slice(0, 10);
        if (_day) {
          const b = estByDay.get(_day) || { units: 0, revenue: 0, fees: 0, cost: 0 };
          b.units += qty;
          b.revenue += lineRevenue;
          b.fees += feesUsd;
          b.cost += lineCost;
          estByDay.set(_day, b);
        }

        const oid = normalizeOrderId(row.order_id);
        if (oid) allOrderIds.add(oid);

        const purchaseTimePt = formatBusinessTimePt(row.purchase_timestamp_utc);
        const mkt = String((row as any).marketplace || "").trim().toUpperCase() || "US";
        const channelRaw = String((row as any).fulfillment_channel || "").trim().toUpperCase();
        const isFbmOrder = channelRaw === "MFN";
        // Amazon does not always give us a channel (13,142 of 2026's orders
        // have none). Unknown is not FBA, so those must still be able to
        // carry a label cost -- see the button condition below.
        const channelUnknown = channelRaw === "";
        const existing = asinMap.get(asin);
        if (existing) {
          existing.units += qty;
          existing.pendingUnits = (existing.pendingUnits || 0) + pendingUnits;
          existing.revenue += lineRevenue;
          existing.fees += feesUsd;
          existing.rawFees = (existing.rawFees || 0) + rawFeesUsd;
          existing.learnedFeesApplied = Boolean(existing.learnedFeesApplied || learnedFee.applied);
          if (learnedFee.applied) {
            existing.learnedFeeMultiplier = learnedFee.multiplier;
            existing.learnedFeeConfidence = learnedFee.confidence;
          }
          existing.referralFees = (existing.referralFees || 0) + referralUsd;
          existing.fbaFees = (existing.fbaFees || 0) + fbaUsd;
          existing.closingFees = (existing.closingFees || 0) + closingUsd;
          existing.cost += lineCost;
          if (oid) existing._orderIds.add(oid);
          existing._marketplaces.add(mkt);
          if (isFbmOrder) existing.hasFbmOrder = true;
          if (channelUnknown) existing.hasUnknownChannelOrder = true;
          if (feeCacheMissingNonUs) {
            existing.feesMissing = true;
            const set = new Set(existing.feesMissingMarketplaces || []);
            set.add(mkt);
            existing.feesMissingMarketplaces = Array.from(set);
          }
          if (!existing.title && row.title) existing.title = row.title;
          if (!existing.image_url && row.image_url) existing.image_url = row.image_url;
          if (purchaseTimePt && !existing.latestPurchaseTimePt) {
            existing.latestPurchaseTimePt = purchaseTimePt;
          }
        } else {
          const set = new Set<string>();
          if (oid) set.add(oid);
          asinMap.set(asin, {
            asin,
            title: row.title || null,
            image_url: row.image_url || null,
            units: qty,
            pendingUnits,
            orders: 0,
            revenue: lineRevenue,
            fees: feesUsd,
            rawFees: rawFeesUsd,
            learnedFeesApplied: learnedFee.applied,
            learnedFeeMultiplier: learnedFee.multiplier,
            learnedFeeConfidence: learnedFee.confidence,
            referralFees: referralUsd,
            fbaFees: fbaUsd,
            closingFees: closingUsd,
            cost: lineCost,
            profit: 0,
            roi: null,
            latestPurchaseTimePt: purchaseTimePt,
            hasFbmOrder: isFbmOrder,
            hasUnknownChannelOrder: channelUnknown,
            feesMissing: feeCacheMissingNonUs || undefined,
            feesMissingMarketplaces: feeCacheMissingNonUs ? [mkt] : undefined,
            _orderIds: set,
            _marketplaces: new Set([mkt]),
          });
        }
      }

      // Enrich missing images from inventory
      const missing = Array.from(asinMap.values()).filter(r => !r.image_url).map(r => r.asin);
      if (missing.length > 0) {
        const { data: invImages } = await supabase
          .from("inventory")
          .select("asin, image_url")
          .eq("user_id", user.id)
          .in("asin", missing)
          .not("image_url", "is", null);
        if (invImages) {
          for (const inv of invImages) {
            const e = asinMap.get(inv.asin);
            if (e && !e.image_url && inv.image_url) e.image_url = inv.image_url;
          }
        }
      }

      // Fetch on-hand stock per ASIN (FBA = inventory rows from amazon_sync/live_api;
      // FBM = source='amazon_sync_fbm'). Mirrors how FBA Shipment Builder reads stock.
      const stockByAsin = new Map<string, { fba: number; fbm: number }>();
      const asinsForStock = Array.from(asinMap.keys());
      if (asinsForStock.length > 0) {
        const { data: stockRows } = await supabase
          .from("inventory")
          .select("asin, available, source, listing_status")
          .eq("user_id", user.id)
          .in("asin", asinsForStock);
        if (stockRows) {
          for (const s of stockRows as any[]) {
            const ls = String(s.listing_status || "").toUpperCase();
            if (ls === "NOT_IN_CATALOG" || ls === "DELETED") continue;
            const avail = Math.max(0, Number(s.available) || 0);
            const cur = stockByAsin.get(s.asin) || { fba: 0, fbm: 0 };
            if (s.source === "amazon_sync_fbm") cur.fbm += avail;
            else cur.fba += avail;
            stockByAsin.set(s.asin, cur);
          }
        }
      }

      const finalRows: AsinRow[] = Array.from(asinMap.values())
        .map(r => {
          const profit = r.revenue - r.fees - r.cost;
          // Hide ROI for rows missing a non-US fee cache — profit is unreliable.
          const roi = r.feesMissing ? null : (r.cost > 0 ? (profit / r.cost) * 100 : null);
          const stock = stockByAsin.get(r.asin);
          return { ...r, orders: r._orderIds.size, profit, roi, stockFba: stock?.fba ?? 0, stockFbm: stock?.fbm ?? 0, marketplaces: Array.from(r._marketplaces), orderIds: Array.from(r._orderIds) };
        })
        .sort((a, b) => b.profit - a.profit);

      // ── Desktop-parity totals recompute ──
      // The per-ASIN table above uses the aggressive Phase 1+2 dedup
      // (`dedupeSalesRowsForLiveTotals`) to avoid showing the same item twice
      // in the breakdown. Desktop Sales Report's fees/cost effect, however,
      // dedups only on the simple `(order_id, asin)` key — so legitimate
      // multi-item orders that share an order_id remain counted. Without this
      // parity pass, Mobile dropped ~rows from fees+cost and showed an
      // inflated Net Profit (~$495 higher than Sales Report on MTD).
      // We rebuild the headline totals here using the simpler dedup so
      // Net Profit / Fees / Cost / Revenue match Sales Report to the cent.
      let parityFees = 0;
      let parityCost = 0;
      let parityRevenue = 0;
      let parityUnits = 0;
      const paritySeen = new Set<string>();
      const parityOrderIds = new Set<string>();
      for (const row of valid as any[]) {
        const asin = String(row.asin || "").trim();
        if (!asin) continue;
        const key = `${normalizeOrderId(row.order_id)}::${asin}`;
        if (paritySeen.has(key)) continue;
        paritySeen.add(key);
        const qty = Math.max(1, Number(row.quantity || 0));
        const lineRev = getRevenueUsdWithFallback(row, asin);
        const feeBasisUsd = lineRev > 0 ? lineRev : 0;
        const fb = getSalesOrderFeeBreakdownUsd(row as any, feeBasisUsd, toUsd);
        let feesUsd = fb.total;
        if (feesUsd <= 0 && feeBasisUsd > 0) {
          const cached = feeByAsin.get(feeCacheKey(asin, row.marketplace));
          if (cached) feesUsd = getCachedFeesUsd(cached, feeBasisUsd, qty, row.marketplace, toUsd);
        }
        const learned = applyLearnedFeeMultiplier({
          row: row as any,
          rawFeesUsd: feesUsd,
          settings: learnedFeeSettings,
          multipliers: learnedFeeMultipliers,
          asinMultipliers: asinFeeMultipliers,
        });
        feesUsd = learned.feesUsd;
        const sku = String((row as any).sku || (row as any).seller_sku || "").trim();
        const { unitCost } = cogsResolver.resolve({
          asin,
          sku,
          order_date: (row as any).order_date || null,
          unit_cost: Number((row as any).unit_cost) || 0,
          unit_cost_at_sale: Number((row as any).unit_cost_at_sale) || 0,
          cost_source_at_sale: (row as any).cost_source_at_sale || null,
          cost_locked: (row as any).cost_locked === true,
        });
        parityFees += feesUsd;
        parityCost += unitCost * qty;
        parityRevenue += lineRev;
        parityUnits += qty;
        const oid = normalizeOrderId(row.order_id);
        if (oid) parityOrderIds.add(oid);
      }
      const totalProfit = parityRevenue - parityFees - parityCost;
      const totalRoi = parityCost > 0 ? (totalProfit / parityCost) * 100 : 0;

      if (isStale()) return;
      let nextSummary = {
        units: parityUnits,
        orders: parityOrderIds.size,
        revenue: Math.round(parityRevenue * 100) / 100,
        fees: Math.round(parityFees * 100) / 100,
        cost: Math.round(parityCost * 100) / 100,
        profit: Math.round(totalProfit * 100) / 100,
        roi: Math.round(totalRoi * 10) / 10,
      };

      // ── Authoritative sales/units — match the row table exactly ──
      // Estimated and Smart both keep the parity totals computed above
      // (parityRevenue/parityUnits/parityFees/parityCost -- the same
      // SO-based source that builds finalRows/asinMap), so the header can
      // never diverge from the sum of the visible row profits. Smart mode
      // previously swapped the header's revenue/units for a separate
      // FEC-blended per-day calculation (smartRevenue/smartUnits) while the
      // table rows stayed SO-based -- the same class of bug fixed on
      // desktop LiveSales.tsx this morning, except unconditional here since
      // Mobile has no mode toggle and is locked to "smart".
      // Reconciled remains its own explicit FEC/settlement-grade view below
      // (matches P&L) and is unaffected by this change.
      try {
        if (salesMode === "reconciled") {
          // Reconciled = FEC settlement-grade totals (matches Sales Report Reconciled / P&L).
          // Revenue + units from get_fec_daily_shipment_totals; fees from get_authoritative_period_totals.
          let recUnits = 0;
          let recRevenue = 0;
          let recFees = 0;
          let recRefunds = 0;
          const reqId = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          latestReconciledRequestIdRef.current = reqId;
          const t0 = performance.now();
          try {
            // get_authoritative_period_totals casts timestamps to DATE and treats
            // the end date as exclusive. Passing today's 23:59 still becomes
            // today::date, so same-day windows returned zero fees/refunds.
            const authEndExclusive = addDaysISO(rangeEnd, 1);
            console.log(`[ProfitTrace ${reqId}] reconciled REQUEST`, {
              ts: new Date().toISOString(),
              period,
              range: { start: rangeStart, end: rangeEnd, authEndExclusive },
              marketplace: marketplaceFilter || "ALL",
              rpcs: ["get_fec_daily_shipment_totals", "get_authoritative_period_totals"],
              sideLoads: ["adjustments", "promotions", "pendingEst"],
            });
            const rangeKey = buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL");
            const [fecAggRes, authRes, adjustmentsRes, promotionsRes, pendingEstRes] = await Promise.all([
              (supabase as any).rpc("get_fec_daily_shipment_totals", {
                p_start: rangeStart,
                p_end: rangeEnd,
                p_marketplace: marketplaceFilter && marketplaceFilter !== "ALL" ? marketplaceFilter : null,
              }),
              (supabase as any).rpc("get_authoritative_period_totals", {
                start_ts: `${rangeStart}T00:00:00.000Z`,
                end_ts: `${authEndExclusive}T00:00:00.000Z`,
              }),
              fetchAdjustmentTotalsForRange(rangeStart, rangeEnd, rangeKey, reqId),
              fetchPromotionTotalsForRange(rangeStart, rangeEnd, rangeKey, reqId),
              fetchPendingEstTotalsForRange(rangeStart, rangeEnd, rangeKey, reqId, toUsd),
            ]);
            if (isStale()) {
              console.log(`[ProfitTrace ${reqId}] DISCARDED (stale) after ${(performance.now() - t0).toFixed(0)}ms`);
              return;
            }
            nextPeriodAdjustments = adjustmentsRes;
            nextPeriodPromotions = promotionsRes;
            nextPeriodPendingEst = pendingEstRes;
            const fecAgg = fecAggRes?.data;
            if (Array.isArray(fecAgg)) {
              for (const r of fecAgg as any[]) {
                recUnits += Number(r.units || 0);
                recRevenue += toUsd(Math.abs(Number(r.sales || 0)), r.marketplace);
              }
            }
            const authRow = Array.isArray(authRes?.data) && authRes.data.length > 0 ? authRes.data[0] : null;
            if (authRow) {
              // Sum the major Amazon fee buckets reported by the RPC.
              recFees =
                Number(authRow.referral_fees_total || 0) +
                Number(authRow.fba_fees_total || 0) +
                Number(authRow.variable_closing_fees_total || 0) +
                Number(authRow.fixed_closing_fees_total || 0) +
                Number(authRow.storage_fees_total || 0) +
                Number(authRow.long_term_storage_fees_total || 0) +
                Number(authRow.removal_fees_total || 0) +
                Number(authRow.disposal_fees_total || 0) +
                Number(authRow.customer_return_fees_total || 0) +
                Number(authRow.digital_services_fee_total || 0) +
                Number(authRow.inbound_fees_total || 0) +
                Number(authRow.other_fees_total || 0);
              recRefunds = Number(authRow.refunds_total || 0);
            }
          } catch (e: any) {
            console.warn("[MobileLiveSales] reconciled RPC exception:", e?.message || e);
          }
          // Pending-estimate revenue/COGS are tracked separately for the
          // "Pending Est." chip and ProfitTrace, but they MUST NOT inflate the
          // headline Revenue/Cost/Units shown on the period card — those have
          // to match Sales Report exactly (settled-only for the chosen range).
          const pendingRevUsd = nextPeriodPendingEst?.revenueUsd || 0;
          const pendingCogsUsd = nextPeriodPendingEst?.cogsUsd || 0;
          const profit = recRevenue - recRefunds - recFees - nextSummary.cost;
          const roi = nextSummary.cost > 0 ? (profit / nextSummary.cost) * 100 : 0;
          nextSummary = {
            ...nextSummary,
            units: Math.round(recUnits),
            revenue: Math.round(recRevenue * 100) / 100,
            fees: Math.round(recFees * 100) / 100,
            cost: Math.round(nextSummary.cost * 100) / 100,
            profit: Math.round(profit * 100) / 100,
            roi: Math.round(roi * 10) / 10,
          };

          nextProfitTraceSnapshot = {
            requestId: reqId,
            sideTotalsKey: buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL"),
            period,
            range: { start: rangeStart, end: rangeEnd },
            summary: {
              settledRevenue: roundCents(recRevenue),
              pendingRevenue: roundCents(pendingRevUsd),
              fees: roundCents(recFees),
              settledCost: roundCents(nextSummary.cost - pendingCogsUsd),
              pendingCost: roundCents(pendingCogsUsd),
              profitBase: roundCents(profit),
            },
            refundsDeduct: roundCents(nextRefundSummary.amount),
            adjustments: nextPeriodAdjustments,
            promotions: nextPeriodPromotions,
            pendingEst: nextPeriodPendingEst,
            finalProfit: roundCents(profit - nextRefundSummary.amount + (nextPeriodAdjustments?.net || 0) - (nextPeriodPromotions?.total || 0)),
          };
          console.log(`[ProfitTrace ${reqId}] reconciled RESPONSE`, {
            ts: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - t0),
            settledRevenue: Math.round(recRevenue * 100) / 100,
            pendingRevenue: Math.round(pendingRevUsd * 100) / 100,
            fees: Math.round(recFees * 100) / 100,
            refunds: Math.round(recRefunds * 100) / 100,
            settledCost: Math.round((nextSummary.cost - pendingCogsUsd) * 100) / 100,
            pendingCost: Math.round(pendingCogsUsd * 100) / 100,
            units: Math.round(recUnits),
            profitBeforeSideloads: Math.round(profit * 100) / 100,
            adjustments: nextPeriodAdjustments,
            promotions: nextPeriodPromotions,
            pendingEst: nextPeriodPendingEst,
            finalProfit: nextProfitTraceSnapshot.finalProfit,
          });
        }
      } catch (e: any) {
        console.warn("[MobileLiveSales] totals RPC exception:", e?.message || e);
      }

      // Guard the final commit: a newer fetch (period / filter / salesMode
      // change, or a background revalidate) may have started while we were
      // awaiting RPCs. Committing stale results here is what caused MTD
      // numbers to flash between values on refresh.
      if (isStale()) {
        console.log("[MobileLiveSales] stale fetch — discarding results, not committing to state/cache");
        return;
      }
      setRows(finalRows);
      setTodaySummary(nextSummary);
      setRefundRecords(nextRefundRecords);
      setTodayRefunds(nextRefundSummary);
      if (salesMode === "reconciled") {
        setPeriodAdjustments(nextPeriodAdjustments || { ...EMPTY_ADJUSTMENTS, key: buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL"), loaded: true, requestId: latestReconciledRequestIdRef.current });
        setPeriodPromotions(nextPeriodPromotions || { ...EMPTY_PROMOTIONS, key: buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL"), loaded: true, requestId: latestReconciledRequestIdRef.current });
        setPeriodPendingEst(nextPeriodPendingEst || { ...EMPTY_PENDING_EST, key: buildSideTotalsKey(rangeStart, rangeEnd, marketplaceFilter || "ALL"), loaded: true, requestId: latestReconciledRequestIdRef.current });
        setProfitTraceSnapshot(nextProfitTraceSnapshot);
      }
      hasDataRef.current = finalRows.length > 0 || nextSummary.units > 0 || nextSummary.revenue > 0;
      // Persist snapshot for instant paint on next cold open / tab resume --
      // but never persist a row whose price could still transition (see
      // riskyAsins above). Omitting it here just means that ASIN repaints
      // from a fresh fetch next time instead of an instantly-stale cache hit;
      // it's still shown live on THIS load via setRows(finalRows) above.
      const cacheableRows = riskyAsins.size > 0
        ? finalRows.filter((r) => !riskyAsins.has(r.asin))
        : finalRows;
      saveMobileLiveSalesCache(user.id, cacheKeyForPeriod(period, compareLastYear), {
        rows: cacheableRows,
        todaySummary: nextSummary,
        todayRefunds: nextRefundSummary,
        periodAdjustments: salesMode === "reconciled" ? (nextPeriodAdjustments || undefined) : undefined,
        periodPromotions: salesMode === "reconciled" ? (nextPeriodPromotions || undefined) : undefined,
        periodPendingEst: salesMode === "reconciled" ? (nextPeriodPendingEst || undefined) : undefined,
        profitTrace: salesMode === "reconciled" ? nextProfitTraceSnapshot : undefined,
      } as any);
    } catch (err: any) {
      console.error("[MobileLiveSales] Error:", err);
      if (!isStale()) setError(err?.message || `Failed to load ${period} sales`);
    } finally {
      if (!isStale()) {
        setLoading(false);
        setRevalidating(false);
      }
      fetchInFlightRef.current = false;
    }
  }, [user?.id, isAmazonConnected, fxRates, period, compareLastYear, cacheKeyForPeriod, salesMode, marketplaceFilter, fetchAdjustmentTotalsForRange, fetchPromotionTotalsForRange, fetchPendingEstTotalsForRange]);

  const refreshLiveSales = useCallback(async (force = false) => {
    await fetchToday();
    const now = Date.now();
    if (force || now - lastSyncKickRef.current > 55_000) {
      lastSyncKickRef.current = now;
      void startBackgroundSync({ force: true, silent: true }).catch((err) => {
        console.warn("[MobileLiveSales] Background sales sync failed:", err);
      });
    }
  }, [fetchToday, startBackgroundSync]);

  useEffect(() => {
    // First paint: fetch DB immediately (fast) AND kick Amazon background sync
    // in parallel (non-blocking) so fresh orders show up shortly after the
    // cached/DB paint. Not awaiting keeps the UI snappy.
    void fetchToday();
    if (user?.id) {
      lastSyncKickRef.current = Date.now();
      void startBackgroundSync({ force: true, silent: true }).catch((err) => {
        console.warn("[MobileLiveSales] Initial background sales sync failed:", err);
      });
    }
    // CPU-pressure control: 60s periodic auto-refresh removed. Users tap
    // Refresh for fresh data; tab/window resume no longer triggers a sync.
  }, [fetchToday, user?.id, startBackgroundSync]);

  useEffect(() => { void fetchToday(); }, [fetchToday, syncState.syncVersion]);

  useEffect(() => {
    if (!selected) return;
    const freshSelected = rows.find((r) => r.asin === selected.asin);
    if (freshSelected && freshSelected !== selected) setSelected(freshSelected);
  }, [rows, selected?.asin]);

  // CPU-pressure control: switching back to the tab no longer triggers the
  // heavy Amazon sales SYNC; the user taps Refresh for that. Returning to the
  // page does trigger one cheap database re-read (see the visibility effect
  // below the ticker), because the orders are already synced server-side.

  // Local-only ticker: re-reads already-synced Supabase tables on a
  // period-aware cadence so numbers update without a manual tap, without
  // adding extra Amazon API calls (silent fetches never touch the actual
  // sync). Today/Yesterday are cheap and change fast (intraday orders), so
  // they get a snappy 5s poll. This Week/MTD/Forecast/Last Month involve
  // much heavier reconciled calculations (MTD/YTD can take minutes on a
  // cold cache) -- polling those every 5s would be wasteful and pile up
  // expensive queries, so they get a much slower 60s cadence instead.
  // Paused while the tab/app is backgrounded to respect the CPU-pressure
  // intent that removed the old periodic sync entirely.
  useEffect(() => {
    if (!user?.id) return;
    const intervalMs = FAST_POLL_PERIODS.includes(period) ? 5000 : 60000;
    const tick = () => {
      if (document.visibilityState === "visible" && !fetchInFlightRef.current) void fetchToday({ silent: true });
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [user?.id, fetchToday, period]);

  // Catch up the moment the page is shown again (2026-09-21).
  //
  // A phone freezes a backgrounded or screen-off page, so the ticker above
  // stops and the totals sit at whatever they were when the seller left. On
  // return nothing re-read until the next tick -- up to 60s on This Week / MTD
  // -- which read as "totals only move when I open the page". The orders were
  // never late: measured the same day, sync-sales-orders ran 288 times in 24h
  // with no failures and wrote each order 3-5 minutes after it was placed,
  // around the clock.
  //
  // This is a single silent DATABASE re-read, not the Amazon sync that the
  // CPU-pressure change removed from focus/visibility -- that stays removed.
  // Skipped if a read finished in the last 10s, so switching apps back and
  // forth cannot stack reads.
  useEffect(() => {
    if (!user?.id) return;
    const onShow = () => {
      if (document.visibilityState !== "visible" || fetchInFlightRef.current) return;
      if (Date.now() - lastShownReadRef.current < 10_000) return;
      lastShownReadRef.current = Date.now();
      void fetchToday({ silent: true });
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pageshow", onShow);
    };
  }, [user?.id, fetchToday]);

  const activeMarketplaces = useMemo(() => {
    // Only marketplaces this account has actually connected — not a
    // hardcoded NA seed, so an unconnected marketplace never shows a button
    // that just filters to permanently-empty data.
    const set = new Set<string>(connectedMarketplaces);
    const order = ["US", "CA", "BR", "MX"];
    const arr = Array.from(set);
    arr.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return arr;
  }, [connectedMarketplaces]);

  const activeRows = useMemo(() => {
    if (marketplaceFilter === "ALL") return rows;
    return rows.filter(r => (r.marketplaces || []).includes(marketplaceFilter));
  }, [rows, marketplaceFilter]);

  const activeSummary = useMemo(() => {
    // Rows and summary are fetched with the same Sales Report marketplace filter.
    // Use the fetched summary directly so Smart Fallback FEC replacements remain included.
    return todaySummary;
  }, [todaySummary]);

  const displayAdjustments = periodAdjustments.key === sideTotalsKey
    ? periodAdjustments
    : { ...EMPTY_ADJUSTMENTS, key: sideTotalsKey };
  const displayPromotions = periodPromotions.key === sideTotalsKey
    ? periodPromotions
    : { ...EMPTY_PROMOTIONS, key: sideTotalsKey };
  const displayPendingEst = periodPendingEst.key === sideTotalsKey
    ? periodPendingEst
    : { ...EMPTY_PENDING_EST, key: sideTotalsKey };

  // Sideloads (adjustments + promotions) load in separate effects and arrive
  // AFTER the main revenue/fees/cost fetch. While they are still pending for
  // the current period, the headline Net Profit is inflated (no promo/adj
  // deductions, no shipping-credit). Gate the headline until both attach and
  // are marked loaded for this exact sideTotalsKey.
  const sideloadsReady =
    periodAdjustments.key === sideTotalsKey &&
    periodPromotions.key === sideTotalsKey &&
    Boolean(periodAdjustments.loaded) &&
    Boolean(periodPromotions.loaded);

  // ProfitTrace: log every render-input change for reconciled mode so we can
  // see exactly which payload combination produced the on-screen Net Profit.
  useEffect(() => {
    if (salesMode !== "reconciled") return;
    const refundsDeduct = todayRefunds.amount;
    const adjNet = displayAdjustments.net;
    const promoDeduct = displayPromotions.total;
    const profitNet = activeSummary.profit - refundsDeduct + adjNet - promoDeduct;
    const currentRender = {
      ts: new Date().toISOString(),
      requestId: profitTraceSnapshot?.requestId || latestReconciledRequestIdRef.current || "unknown",
      period,
      sideTotalsKey,
      adjustmentsAttached: periodAdjustments.key === sideTotalsKey,
      promotionsAttached: periodPromotions.key === sideTotalsKey,
      adjustmentsLoaded: Boolean(displayAdjustments.loaded),
      promotionsLoaded: Boolean(displayPromotions.loaded),
      adjustmentRequestId: displayAdjustments.requestId,
      promotionRequestId: displayPromotions.requestId,
      expensesAttached: true,
      expenses: 0,
      shippingLabels: displayAdjustments.fbmLabelFees,
      summary: {
        revenue: activeSummary.revenue,
        fees: activeSummary.fees,
        cost: activeSummary.cost,
        profitBase: activeSummary.profit,
      },
      refundsDeduct,
      adjNet,
      promoDeduct,
      profitNet: Math.round(profitNet * 100) / 100,
    };
    console.log(`[ProfitTrace RENDER]`, currentRender);
    if (lastProfitRenderRef.current && lastProfitRenderRef.current.profitNet !== currentRender.profitNet) {
      console.log(`[ProfitTrace RENDER_DELTA]`, {
        previous: lastProfitRenderRef.current,
        current: currentRender,
      });
    }
    lastProfitRenderRef.current = currentRender;
  }, [salesMode, period, sideTotalsKey, activeSummary, todayRefunds.amount, displayAdjustments.net, displayPromotions.total, displayAdjustments.loaded, displayPromotions.loaded, displayAdjustments.requestId, displayPromotions.requestId, displayAdjustments.fbmLabelFees, periodAdjustments.key, periodPromotions.key, profitTraceSnapshot]);

  return (
    <div className="min-h-screen bg-[#0f1c3f] text-white">
      <Helmet>
        <title>Live Sales — Today</title>
        <meta name="description" content="Live today's Amazon sales — per-ASIN breakdown with image, title and amount." />
      </Helmet>

      {/* Top bar */}
      <header className="sticky top-0 z-20 backdrop-blur bg-[#0f1c3f]/85 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-white hover:bg-white/10 shrink-0"
          onClick={() => navigate("/tools")}
          aria-label="Back to tools"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <h1 className="text-base font-semibold truncate">Live Sales</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9 text-white hover:bg-white/10"
          onClick={() => void refreshLiveSales(true)}
          disabled={loading || isSyncing}
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading || isSyncing ? "animate-spin" : ""}`} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-white hover:bg-white/10"
          onClick={() => window.location.reload()}
          aria-label="Hard refresh page"
          title="Hard refresh page"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-red-300 hover:text-red-200 hover:bg-red-500/10"
          onClick={async () => {
            await supabase.auth.signOut();
            navigate("/login");
          }}
          aria-label="Log out"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </header>

      {selected ? (
        <RecordDetail
          row={selected}
          currencySymbol={homeCurrencySymbol}
          homeRate={homeRate}
          onBack={() => setSelected(null)}
          rangeStart={periodInfo.start}
          rangeEnd={periodInfo.end}
        />
      ) : (
      <main
        className="px-4 pb-24 pt-5 max-w-md mx-auto touch-pan-y select-none"
        onTouchStart={(e) => {
          const t = e.touches[0];
          touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
        }}
        onTouchEnd={(e) => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          if (!start) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          const dt = Date.now() - start.t;
          if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.3 || dt > 600) return;
          // Swipe LEFT (dx<0) → next period (today → yesterday → mtd)
          // Swipe RIGHT (dx>0) → previous period
          const idx = PERIOD_ORDER.indexOf(period);
          if (dx < 0 && idx < PERIOD_ORDER.length - 1) setPeriod(PERIOD_ORDER[idx + 1]);
          else if (dx > 0 && idx > 0) setPeriod(PERIOD_ORDER[idx - 1]);
        }}
      >
        {/* Sales mode toggle hidden on Mobile Live Sales — locked to Smart Fallback.
            State + logic paths for "estimated" / "reconciled" remain intact so
            desktop and any legacy callers continue to work. */}

        <div className="mb-4 flex items-center justify-between gap-0.5 rounded-xl bg-white/[0.04] border border-white/10 p-1">
          <button
            onClick={() => {
              const idx = PERIOD_ORDER.indexOf(period);
              if (idx > 0) setPeriod(PERIOD_ORDER[idx - 1]);
            }}
            disabled={PERIOD_ORDER.indexOf(period) === 0}
            className="shrink-0 h-8 w-6 flex items-center justify-center rounded-lg text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Previous period"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto scrollbar-hide">
            {PERIOD_ORDER.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`shrink-0 px-1.5 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-tight transition-colors whitespace-nowrap ${
                  period === p
                    ? "bg-blue-500 text-white"
                    : "text-white hover:bg-white/10"
                }`}
              >
                {p === "today" ? "Today"
                  : p === "yesterday" ? "Yesterday"
                  : p === "this_week" ? "Week"
                  : p === "mtd" ? "MTD"
                  : p === "ytd" ? "YTD"
                  : p === "last_month" ? "Last Mo"
                  : p === "last_year" ? "Last Yr"
                  : p === "forecast" ? "Forecast"
                  : MONTH_LABELS[Number(p.slice(6)) - 1]}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              const idx = PERIOD_ORDER.indexOf(period);
              if (idx < PERIOD_ORDER.length - 1) setPeriod(PERIOD_ORDER[idx + 1]);
            }}
            disabled={PERIOD_ORDER.indexOf(period) === PERIOD_ORDER.length - 1}
            className="shrink-0 h-8 w-6 flex items-center justify-center rounded-lg text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Next period"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Year-over-year compare — only meaningful for month-shaped periods
            (MTD / a specific month), since it swaps the range to the same
            month one year earlier. */}
        {canCompareLastYear && (
          <button
            type="button"
            onClick={() => setCompareLastYear((v) => !v)}
            className={`mb-3 w-full flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider border transition-colors ${
              compareLastYear
                ? "bg-amber-500/20 text-amber-300 border-amber-400/50"
                : "bg-white/[0.04] text-white/70 border-white/10 hover:bg-white/10"
            }`}
          >
            <History className="h-3 w-3" />
            {compareLastYear ? `Showing ${periodInfo.label} — tap to view this year` : "Compare vs Last Year"}
          </button>
        )}

        {/* Marketplace filter */}
        {activeMarketplaces.length >= 1 && (
          <div className="mb-3 flex items-center gap-2">
            <button
              onClick={() => setMarketplaceFilter("ALL")}
              className={`flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-colors ${
                marketplaceFilter === "ALL"
                  ? "bg-blue-500 text-white border-blue-400"
                  : "bg-white/5 text-white border-white/15 hover:bg-white/10"
              }`}
            >
              All
            </button>
            {activeMarketplaces.map((m) => (
              <button
                key={m}
                onClick={() => setMarketplaceFilter(m)}
                title={m === homeMarketplace ? "Your primary marketplace" : undefined}
                className={`relative flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-colors ${
                  marketplaceFilter === m
                    ? "bg-blue-500 text-white border-blue-400"
                    : "bg-white/5 text-white border-white/15 hover:bg-white/10"
                } ${m === homeMarketplace ? "ring-2 ring-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]" : ""}`}
              >
                {m}
                {m === homeMarketplace && <Star className="h-2 w-2 fill-amber-400 text-amber-400 absolute -top-1 -right-1" />}
              </button>
            ))}
          </div>
        )}

        {/* Hero stat */}
        <section className="rounded-2xl bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent border border-emerald-400/20 p-5 shadow-lg shadow-emerald-500/5">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
              <span className={`h-1.5 w-1.5 rounded-full ${period === "today" ? "bg-emerald-400 animate-pulse" : "bg-white/40"}`} />
              {period === "today" ? "Live" : periodInfo.label}
            </span>
            <span className="text-xs font-semibold text-white">
              {period === "today" ? nowLabel : `${periodInfo.start}${periodInfo.start !== periodInfo.end ? ` → ${periodInfo.end}` : ""}`}
            </span>
          </div>
          {loading && rows.length === 0 ? (
            <Skeleton className="h-10 w-40 bg-white/10" />
          ) : (() => {
            const isForecast = period === "forecast";
            const fc = isForecast ? getForecastFactor() : { factor: 1, dayOfMonth: 0, daysInMonth: 0 };
            const refundsDeduct = todayRefunds.amount;
            const adjNet = displayAdjustments.net;
            const promoDeduct = displayPromotions.total;
            const profitNet = (activeSummary.profit - refundsDeduct + adjNet - promoDeduct) * fc.factor;
            const roiNet = activeSummary.cost > 0
              ? ((activeSummary.profit - refundsDeduct + adjNet - promoDeduct) / activeSummary.cost) * 100
              : 0;
            const disp = {
              profit: profitNet * homeRate,
              revenue: activeSummary.revenue * fc.factor * homeRate,
              fees: activeSummary.fees * fc.factor * homeRate,
              cost: activeSummary.cost * fc.factor * homeRate,
              refunds: refundsDeduct * fc.factor * homeRate,
              promotions: promoDeduct * fc.factor * homeRate,
              adjustments: adjNet * fc.factor * homeRate,
              units: Math.round(activeSummary.units * fc.factor),
              orders: Math.round(activeSummary.orders * fc.factor),
              roi: roiNet,
            };
            return (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-sm uppercase tracking-wider font-bold text-white">Net Profit</div>
                  {sideloadsReady && !showRevalidatingSkeleton ? (
                    <>
                      <div className={`text-3xl font-extrabold tabular-nums tracking-tight leading-tight ${disp.profit >= 0 ? "text-white" : "text-rose-300"}`}>
                        {disp.profit < 0 ? "−" : ""}{homeCurrencySymbol}{Math.abs(disp.profit).toFixed(2)}
                      </div>
                      <div
                        className="mt-1 text-lg font-bold text-emerald-300 tabular-nums cursor-help"
                        title={"Order-level ROI: revenue − promotions − (referral + FBA + closing fees) − COGS − refunds + settlement adjustments.\n\nFor non-US marketplaces (MX/CA/BR) this is an ESTIMATE while orders are pending — it does NOT yet include Remote Fulfillment cross-border fees, FX drift, storage, long-term storage, returns, or reimbursements. Those settle 5–14 days later and can materially reduce true ROI. Use a higher Min ROI floor on intl marketplaces as a buffer."}
                      >
                        ROI {disp.roi.toFixed(1)}%
                      </div>
                    </>
                  ) : sideloadsReady ? (
                    <>
                      <Skeleton className="h-9 w-28 bg-white/10" />
                      <Skeleton className="mt-1.5 h-5 w-16 bg-white/10" />
                    </>
                  ) : (
                    <>
                      <div className="text-3xl font-extrabold tabular-nums tracking-tight leading-tight text-white/40 animate-pulse">
                        {homeCurrencySymbol}— · —
                      </div>
                      <div className="mt-1 text-[11px] font-semibold text-amber-300/90 uppercase tracking-wider">
                        Loading promotions & adjustments…
                      </div>
                    </>
                  )}
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-bold text-white">{periodInfo.label} Sales</div>
                  {showRevalidatingSkeleton ? (
                    <Skeleton className="h-7 w-24 bg-white/10" />
                  ) : (
                    <div
                      className="text-2xl font-extrabold tabular-nums tracking-tight text-white leading-tight"
                      title="Total Sales = item price + buyer-paid shipping (already included)."
                    >
                      {homeCurrencySymbol}{disp.revenue.toFixed(2)}
                    </div>
                  )}
                  {displayAdjustments.shippingCollected > 0 && (
                    <button
                      type="button"
                      onClick={async () => {
                        const next = !shippingCreditOpen;
                        setShippingCreditOpen(next);
                        if (next && shippingCreditOrders.length === 0 && user?.id) {
                          setShippingCreditLoading(true);
                          try {
                            const { start, end } = getPeriodRange(period, compareLastYear && canCompareLastYear);
                            // ORDER-DATE attribution: pull ALL sales_orders in
                            // this period (paginated, no 1000-row cap), then
                            // fetch FEC shipping_credits joined by
                            // amazon_order_id. Each row is dated to the
                            // order's purchase date (not settlement-posted),
                            // so the drilldown matches the aggregate total.
                            const PAGE = 1000;
                            const soMeta = new Map<string, { asin: string | null; title: string | null; quantity: number; marketplace: string | null; order_date: string | null }>();
                            for (let from = 0; ; from += PAGE) {
                              let soQ = supabase
                                .from("sales_orders")
                                .select("order_id, asin, title, quantity, marketplace, order_date")
                                .eq("user_id", user.id)
                                .gte("order_date", start)
                                .lte("order_date", end);
                              if (marketplaceFilter && marketplaceFilter !== "ALL") {
                                if (marketplaceFilter === "US") soQ = soQ.or("marketplace.eq.US,marketplace.is.null");
                                else soQ = soQ.eq("marketplace", marketplaceFilter);
                              }
                              const { data: soRows, error: soErr } = await soQ.range(from, from + PAGE - 1);
                              if (soErr) { console.warn("[ShipDrilldown] SO page error", soErr); break; }
                              if (!soRows || soRows.length === 0) break;
                              for (const s of soRows as any[]) {
                                const oid = String(s.order_id || "");
                                if (!oid || soMeta.has(oid)) continue;
                                soMeta.set(oid, {
                                  asin: s.asin || null,
                                  title: s.title || null,
                                  quantity: s.quantity || 1,
                                  marketplace: s.marketplace || null,
                                  order_date: s.order_date || null,
                                });
                              }
                              if (soRows.length < PAGE) break;
                            }
                            const ids = Array.from(soMeta.keys());
                            const byOrder = new Map<string, { order_id: string; shipping_price: number }>();
                            const CHUNK = 150;
                            for (let i = 0; i < ids.length; i += CHUNK) {
                              const slice = ids.slice(i, i + CHUNK);
                              const { data: fecRows, error: fecErr } = await supabase
                                .from("financial_events_cache")
                                .select("amazon_order_id, shipping_credits, shipping_credit_refunds")
                                .eq("user_id", user.id)
                                .in("amazon_order_id", slice);
                              if (fecErr) { console.warn("[ShipDrilldown] FEC chunk error", fecErr); continue; }
                              for (const r of (fecRows as any[]) || []) {
                                const oid = String(r.amazon_order_id || "");
                                if (!oid) continue;
                                const ship = Number(r.shipping_credits || 0) + Number(r.shipping_credit_refunds || 0);
                                if (ship === 0) continue;
                                const existing = byOrder.get(oid);
                                if (existing) existing.shipping_price += ship;
                                else byOrder.set(oid, { order_id: oid, shipping_price: ship });
                              }
                            }
                            const merged = Array.from(byOrder.values())
                              .filter((o) => o.shipping_price !== 0)
                              .map((o) => {
                                const meta = soMeta.get(o.order_id);
                                return {
                                  order_id: o.order_id,
                                  asin: meta?.asin || null,
                                  title: meta?.title || null,
                                  marketplace: meta?.marketplace || null,
                                  order_date: meta?.order_date || null,
                                  quantity: meta?.quantity || 1,
                                  shipping_price: o.shipping_price,
                                };
                              })
                              .sort((a, b) => b.shipping_price - a.shipping_price);
                            console.info(`[ShipDrilldown] period=${period} SOids=${ids.length} matched=${merged.length} total=${merged.reduce((s,o)=>s+o.shipping_price,0).toFixed(2)}`);
                            setShippingCreditOrders(merged);
                          } catch (e) {
                            console.warn("[ShipDrilldown] failed", e);
                          } finally {
                            setShippingCreditLoading(false);
                          }
                        }
                      }}
                      className="mt-0.5 text-[11px] font-semibold text-sky-300 tabular-nums underline decoration-dotted underline-offset-2"
                      title="Buyer-paid shipping (already included in Total Sales). Tap to see which orders paid shipping."
                    >
                      incl. shipping from buyer +{homeCurrencySymbol}{displayAdjustments.shippingCollected.toFixed(2)}
                      <span className="ml-1 opacity-70">{shippingCreditOpen ? "▴" : "▾"}</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-x-4 gap-y-1 text-base font-bold tabular-nums flex-wrap">
                <span
                  className="text-amber-300"
                  title={displayAdjustments.fbmLabelFees > 0
                    ? `Per-order Amazon fees (referral + FBA + closing + FBM shipping labels).\n\nFBM shipping labels for this period: −${homeCurrencySymbol}${displayAdjustments.fbmLabelFees.toFixed(2)} (included in this total).`
                    : "Per-order Amazon fees (referral + FBA + closing fees)."}
                >Fees −{homeCurrencySymbol}{disp.fees.toFixed(2)}</span>
                <span className="text-blue-300">COGS −{homeCurrencySymbol}{disp.cost.toFixed(2)}</span>
                {disp.refunds > 0 && (
                  <span className="text-rose-300">Refunds −{homeCurrencySymbol}{disp.refunds.toFixed(2)}</span>
                )}
                {salesMode === "reconciled" && displayPendingEst.revenueUsd > 0 && (
                  <span
                    className="text-muted-foreground italic"
                    title={`Pending order estimates (${displayPendingEst.orders} orders, ${displayPendingEst.units} units) — not yet settled in FEC. Already added into Revenue and Net Profit so this period matches Sales Report.`}
                  >
                    Pending Est. ~{homeCurrencySymbol}{(displayPendingEst.revenueUsd * homeRate).toFixed(2)}
                  </span>
                )}
                {disp.promotions > 0 && (
                  <span
                    className="text-rose-300"
                    title={`Promotions deducted from profit via shared Promotions Deducted calculation (${displayPromotions.rows} rows).`}
                  >
                    Promotions −{homeCurrencySymbol}{disp.promotions.toFixed(2)}
                  </span>
                )}
                {displayAdjustments.events > 0 && (
                  <button
                    type="button"
                    onClick={() => setAdjustmentsOpen((v) => !v)}
                    className={`${disp.adjustments >= 0 ? "text-emerald-300" : "text-rose-300"} underline decoration-dotted underline-offset-2`}
                    title={`Non-order settlement corrections only (${displayAdjustments.events} events): reimbursements, reversals, liquidation, lost/damaged inventory, storage, removals, inbound, other fees.\n\nBuyer shipping credit is already in Revenue. FBM label fees and per-order referral/FBA/closing fees are already in Fees. Tap to see the breakdown.`}
                  >
                    Adjustments {disp.adjustments >= 0 ? "+" : "−"}{homeCurrencySymbol}{Math.abs(disp.adjustments).toFixed(2)}
                    <span className="ml-1 text-xs opacity-70">{adjustmentsOpen ? "▴" : "▾"}</span>
                  </button>
                )}
                <ReplacementCogsChip
                  variant="chip"
                  rangeStart={periodInfo.start}
                  rangeEnd={periodInfo.end}
                  marketplace={marketplaceFilter || "ALL"}
                  colorClass="text-rose-300"
                  currencySymbol={homeCurrencySymbol}
                  homeRate={homeRate}
                />
              </div>

              {shippingCreditOpen && (
                <div className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-xs tabular-nums">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold uppercase tracking-wider text-sky-200">
                      Buyer-paid shipping · orders
                    </span>
                    <span className="font-bold text-sky-200">
                      +{homeCurrencySymbol}{displayAdjustments.shippingCollected.toFixed(2)}
                    </span>
                  </div>
                  {shippingCreditLoading ? (
                    <div className="text-white/60">Loading orders…</div>
                  ) : shippingCreditOrders.length === 0 ? (
                    <div className="text-white/60">
                      No orders with buyer-paid shipping found in <code>sales_orders</code> for this period. The total above comes from Amazon settlement (<code>financial_events_cache.shipping_credits</code>) and may include shipping for orders not yet ingested per-order.
                    </div>
                  ) : (
                    <div className="max-h-80 overflow-y-auto divide-y divide-white/10">
                      {shippingCreditOrders.map((o) => (
                        <div key={o.order_id} className="flex items-center justify-between py-1.5 gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-white/90">{o.title || o.asin || o.order_id}</div>
                            <div className="text-[10px] text-white/50">
                              {o.order_id && o.order_id !== "(unknown)" ? (
                                <a
                                  href={`https://sellercentral.amazon.com/orders-v3/order/${o.order_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-sky-300 underline decoration-dotted underline-offset-2 hover:text-sky-200"
                                >
                                  {o.order_id}
                                </a>
                              ) : (
                                o.order_id
                              )} · {o.asin || "—"} · {o.marketplace || "US"} · {o.order_date?.slice(0, 10) || ""} · qty {o.quantity}
                            </div>
                          </div>
                          <div className="font-semibold text-sky-200">+{homeCurrencySymbol}{Number(o.shipping_price || 0).toFixed(2)}</div>
                        </div>
                      ))}
                      <div className="pt-2 text-[10px] text-white/50">
                        Showing {shippingCreditOrders.length} orders. Totals may differ slightly from the settlement number when shipping credits from past orders settle in this period.
                      </div>
                    </div>
                  )}
                </div>
              )}



              {adjustmentsOpen && displayAdjustments.events > 0 && (
                <div className="mt-2 rounded-md border border-white/10 bg-white/5 p-3 text-xs tabular-nums">
                  <div className="mb-1 font-semibold uppercase tracking-wider text-white/80">
                    Adjustments breakdown ({displayAdjustments.events} events)
                  </div>
                  <div className="flex justify-between text-emerald-300">
                    <span>Credits (reimbursements, reversals, liquidation, lost/damaged, other income)</span>
                    <span>+{homeCurrencySymbol}{(displayAdjustments.credits * fc.factor).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-rose-300">
                    <span>Extra adjustment fees (storage, removal, inbound, disposal, other)</span>
                    <span>−{homeCurrencySymbol}{(displayAdjustments.extraFees * fc.factor).toFixed(2)}</span>
                  </div>
                  <div className="mt-1 flex justify-between border-t border-white/10 pt-1 font-semibold text-white">
                    <span>Net Adjustments</span>
                    <span className={disp.adjustments >= 0 ? "text-emerald-300" : "text-rose-300"}>
                      {disp.adjustments >= 0 ? "+" : "−"}{homeCurrencySymbol}{Math.abs(disp.adjustments).toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-2 text-[11px] leading-snug text-white/60">
                    Buyer shipping credit is already in Revenue. FBM label fees and per-order referral/FBA/closing fees are already in Fees. They are intentionally excluded here to avoid double-counting.
                  </div>
                </div>
              )}

              {(() => {
                const payout = disp.revenue - disp.fees - disp.refunds;
                const refundPct = disp.revenue > 0 ? (disp.refunds / disp.revenue) * 100 : 0;
                return (
                  <>
                    <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 flex items-center justify-between">
                      <div>
                        <div className="text-[11px] uppercase tracking-wider font-bold text-emerald-200/90">Est. Amazon Payout</div>
                        <div className="text-[10px] text-emerald-200/60 font-medium">Sales − Fees − Refunds</div>
                      </div>
                      {showRevalidatingSkeleton ? (
                        <Skeleton className="h-7 w-20 bg-white/10" />
                      ) : (
                        <div className={`text-2xl font-extrabold tabular-nums tracking-tight ${payout >= 0 ? "text-emerald-200" : "text-rose-300"}`}>
                          {payout < 0 ? "−" : ""}{homeCurrencySymbol}{Math.abs(payout).toFixed(2)}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 flex items-center justify-between">
                      <div>
                        <div className="text-[11px] uppercase tracking-wider font-bold text-rose-200/90">Refund %</div>
                        <div className="text-[10px] text-rose-200/60 font-medium">Refunds ÷ Revenue (gross sales incl. shipping)</div>
                      </div>
                      {showRevalidatingSkeleton ? (
                        <Skeleton className="h-7 w-16 bg-white/10" />
                      ) : (
                        <div className={`text-2xl font-extrabold tabular-nums tracking-tight ${refundPct >= 5 ? "text-rose-300" : refundPct >= 2 ? "text-amber-200" : "text-rose-200"}`}>
                          {refundPct.toFixed(2)}%
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}

              {showRevalidatingSkeleton ? (
                <Skeleton className="mt-2 h-5 w-40 bg-white/10" />
              ) : (
                <div className="mt-2 text-sm font-semibold text-white tabular-nums">
                  {disp.units} unit{disp.units === 1 ? "" : "s"} · {disp.orders} order{disp.orders === 1 ? "" : "s"} · PT
                </div>
              )}
              {isForecast && (
                <div className="mt-3 text-[11px] font-semibold text-emerald-200/80 leading-snug">
                  Projected from day {fc.dayOfMonth} of {fc.daysInMonth} · run-rate ×{fc.factor.toFixed(2)}.
                  Actual MTD: {homeCurrencySymbol}{(activeSummary.revenue * homeRate).toFixed(2)} sales · {homeCurrencySymbol}{(activeSummary.profit * homeRate).toFixed(2)} profit.
                </div>
              )}
            </>
            );
          })()}
        </section>

        {/* FEC coverage warning — past-month tabs with no settlement data synced.
            Settlement always lags for today/this_week/mtd/forecast so we
            suppress the banner there. */}
        {(() => {
          const isSettlementLagPeriod =
            period === "today" || period === "this_week" ||
            period === "mtd" || period === "forecast";
          const isPastMonthTab =
            period === "last_month" || period.startsWith("month_") || period === "ytd";
          if (!isPastMonthTab || isSettlementLagPeriod) return null;
          if (!fecCoverage.loaded || fecCoverage.rows > 0) return null;
          return (
            <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-200">
              <span className="font-bold">⚠ Settlement data for {periodInfo.label} is incomplete.</span>{" "}
              ROI may exclude refunds, storage, removals, reimbursements, and promotional rebates.
              Per-order Amazon fees and COGS are still applied.
            </div>
          );
        })()}

        {/* Refunds — deducted from Net Profit above. Tap to expand records. */}

        {todayRefunds.amount > 0 && (
          <div className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/10 overflow-hidden">
            <button
              type="button"
              onClick={() => setRefundsOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex h-2 w-2 rounded-full bg-rose-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-rose-300">
                    {periodInfo.label} Refunds ({todayRefunds.count})
                  </div>
                  <div className="text-[10px] text-rose-200/70 leading-tight">
                    Deducted from Net Profit · tap to {refundsOpen ? "hide" : "view"}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 flex items-center gap-2">
                <div>
                  <div className="text-base font-extrabold tabular-nums text-rose-200">
                    −{homeCurrencySymbol}{(todayRefunds.amount * homeRate).toFixed(2)}
                  </div>
                </div>
                {refundsOpen ? <ChevronUp className="h-4 w-4 text-rose-200" /> : <ChevronDown className="h-4 w-4 text-rose-200" />}
              </div>
            </button>
            {refundsOpen && (
              <>
                {refundRecords.length > 0 && (
                  <ul className="divide-y divide-rose-400/15 border-t border-rose-400/15 bg-rose-950/20">
                    {refundRecords.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                        {r.image_url ? (
                          <img src={r.image_url} alt="" className="h-10 w-10 min-w-10 rounded object-cover bg-white/5" />
                        ) : (
                          <div className="h-10 w-10 min-w-10 rounded bg-white/5" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-white truncate">{r.title || r.asin}</div>
                          <div className="text-[10px] text-white/60 truncate">
                            {r.order_date} · {r.asin} · {r.marketplace || "US"} · qty {r.quantity}
                          </div>
                          {(() => {
                            const cleanOid = (r.order_id || "").replace(/-REFUND$/, "");
                            if (!cleanOid) return null;
                            return (
                              <a
                                href={`https://sellercentral.amazon.com/orders-v3/order/${cleanOid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[10px] font-mono text-rose-200 hover:text-rose-100 underline underline-offset-2 truncate block"
                                title={`Open ${cleanOid} in Seller Central`}
                              >
                                {cleanOid}
                              </a>
                            );
                          })()}
                        </div>
                        <div className="text-sm font-bold tabular-nums text-rose-300 shrink-0">
                          −{homeCurrencySymbol}{(r.amount * homeRate).toFixed(2)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-rose-400/15 bg-rose-950/30">
                  <span className="text-[10px] text-rose-200/70 leading-tight">
                    Missing a refund? Re-sync this period from Finances API.
                  </span>
                  <button
                    type="button"
                    disabled={resyncingRefunds}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!user?.id) return;
                      setResyncingRefunds(true);
                      try {
                        const { start, end } = getPeriodRange(period, compareLastYear && canCompareLastYear);
                        toast({ title: "Re-syncing refunds…", description: `${start} → ${end}. This takes 1–3 minutes.` });
                        const { error } = await supabase.functions.invoke("sync-sales-orders", {
                          body: {
                            sync_refunds_only: true,
                            custom_start_date: start,
                            custom_end_date: end,
                            track_progress: false,
                          },
                        });
                        if (error) throw error;
                        toast({ title: "Refund re-sync started", description: "Refresh Live Sales in ~2 minutes to see backfilled refunds." });
                      } catch (err: any) {
                        toast({ title: "Re-sync failed", description: err?.message || "Unknown error", variant: "destructive" });
                      } finally {
                        setResyncingRefunds(false);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/40 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 disabled:opacity-60 shrink-0"
                  >
                    {resyncingRefunds ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
                    {resyncingRefunds ? "Syncing…" : "Re-sync refunds"}
                  </button>
                </div>
              </>
            )}

          </div>
        )}


        {/* Connection / error states */}
        {isAmazonConnected === false && (
          <div className="mt-6 flex flex-col items-center text-center gap-3 py-10 rounded-2xl border border-white/10 bg-white/[0.03]">
            <AlertTriangle className="h-8 w-8 text-amber-400/80" />
            <p className="text-sm font-semibold">No Amazon Marketplaces Connected</p>
            <p className="text-xs text-white/90 max-w-xs">
              Connect your Amazon account to view live sales.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-6 px-4 py-3 rounded-xl border border-red-400/30 bg-red-500/10 text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* Today's per-ASIN list */}
        <section className="mt-6">
          <div className="flex items-baseline justify-between mb-3 px-1">
            <h2 className="text-base uppercase tracking-wider font-bold text-white">{periodInfo.label} Sales</h2>
            <span className="text-sm font-bold text-white tabular-nums">{activeRows.length} ASIN{activeRows.length === 1 ? "" : "s"}</span>
          </div>

          {loading && rows.length === 0 ? (
            <div className="space-y-2.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/5">
                  <Skeleton className="h-12 w-12 rounded-lg bg-white/10 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-3/4 bg-white/10" />
                    <Skeleton className="h-3 w-1/2 bg-white/10" />
                  </div>
                  <Skeleton className="h-5 w-14 bg-white/10" />
                </div>
              ))}
            </div>
          ) : activeRows.length === 0 && isAmazonConnected !== false ? (
            <div className="flex flex-col items-center text-center gap-2 py-12 rounded-2xl border border-white/10 bg-white/[0.03]">
              <ShoppingCart className="h-8 w-8 text-white/70" />
              <p className="text-sm font-medium text-white">No sales for {periodInfo.label.toLowerCase()}</p>
              <p className="text-xs text-white/80">New orders will appear here automatically.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-end gap-2 text-sm font-bold mb-2">
                <span className="text-white">Sort:</span>
                <button onClick={() => toggleSort("units")} className={`px-2.5 py-1 rounded border ${sortKey === "units" ? "bg-blue-500 border-blue-400 text-white" : "border-white/30 text-white"}`}>Units {sortIndicator("units")}</button>
                <button onClick={() => toggleSort("revenue")} className={`px-2.5 py-1 rounded border ${sortKey === "revenue" ? "bg-blue-500 border-blue-400 text-white" : "border-white/30 text-white"}`}>Rev {sortIndicator("revenue")}</button>
                <button onClick={() => toggleSort("profit")} className={`px-2.5 py-1 rounded border ${sortKey === "profit" ? "bg-blue-500 border-blue-400 text-white" : "border-white/30 text-white"}`}>Profit {sortIndicator("profit")}</button>
              </div>
              <ul className="space-y-2.5">
                {(sortKey === "none" ? activeRows : [...activeRows].sort((a, b) => {
                  const av = sortKey === "units" ? a.units : sortKey === "revenue" ? a.revenue : a.profit;
                  const bv = sortKey === "units" ? b.units : sortKey === "revenue" ? b.revenue : b.profit;
                  return sortDir === "asc" ? av - bv : bv - av;
                })).map((r) => (
                <li
                  key={r.asin}
                  onClick={() => setSelected(r)}
                  className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/10 hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors cursor-pointer"
                >
                  <div className="h-12 w-12 min-w-12 rounded-lg overflow-hidden bg-white/10 border border-white/10 shrink-0 flex items-center justify-center">
                    {r.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.image_url}
                        alt={r.title || r.asin}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Package className="h-5 w-5 text-white/70" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-blue-300/90 flex-wrap">
                      <a
                        href={`https://www.amazon.com/dp/${r.asin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-sm font-bold tracking-wider uppercase text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline active:underline"
                        aria-label={`Open ${r.asin} on Amazon`}
                      >
                        {r.asin}
                      </a>
                      {(r.marketplaces && r.marketplaces.length > 0 ? r.marketplaces : ["US"]).map((m) => (
                        <span
                          key={m}
                          className="inline-flex shrink-0 items-center rounded border border-white/25 bg-white/10 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-white"
                        >
                          {m}
                        </span>
                      ))}
                      {r.latestPurchaseTimePt && (
                        <span className="text-white/70 text-[10px] uppercase tracking-wider">· {r.latestPurchaseTimePt}</span>
                      )}
                      {r.orderIds && r.orderIds.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-mono">
                          <span className="text-white/50">·</span>
                          <a
                            href={`https://sellercentral.amazon.com/orders-v3/order/${r.orderIds[0]}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center rounded border border-blue-400/50 bg-blue-500/20 px-1.5 py-0.5 text-blue-200 hover:bg-blue-500/30 hover:text-white"
                            aria-label={`Open order ${r.orderIds[0]} in Seller Central`}
                            title={r.orderIds[0]}
                          >
                            {r.orderIds[0]}
                          </a>
                          {r.orderIds.length > 1 && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center rounded border border-amber-400/60 bg-amber-500/25 px-2 py-0.5 text-[11px] font-bold text-amber-100 hover:bg-amber-500/40 hover:text-white"
                                  aria-label={`Show ${r.orderIds.length - 1} more orders`}
                                >
                                  +{r.orderIds.length - 1} more
                                </button>
                              </PopoverTrigger>
                              <PopoverContent
                                align="start"
                                className="w-72 p-2 bg-[#0f1c3f] border-white/20 z-50"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="text-[10px] uppercase tracking-wider text-white/60 px-1 pb-1">
                                  {r.orderIds.length} orders
                                </div>
                                <div className="max-h-64 overflow-y-auto flex flex-col">
                                  {r.orderIds.map((oid) => (
                                    <a
                                      key={oid}
                                      href={`https://sellercentral.amazon.com/orders-v3/order/${oid}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="font-mono text-[12px] text-blue-300 hover:text-blue-200 hover:bg-white/5 rounded px-2 py-1.5 truncate"
                                      title={oid}
                                    >
                                      {oid}
                                    </a>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-white leading-snug line-clamp-2 mt-0.5">
                      {r.title || "—"}
                    </p>
                    <div className="text-xs font-semibold text-white mt-0.5 tabular-nums flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span>{r.units} unit{r.units === 1 ? "" : "s"} · {r.orders} order{r.orders === 1 ? "" : "s"}</span>
                      {(r.pendingUnits ?? 0) > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/30 text-amber-300 text-[10px] font-bold uppercase tracking-wider">
                          Pending price
                        </span>
                      )}
                      {(r.stockFba ?? 0) > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-[10px] font-bold uppercase tracking-wider">
                          FBA {r.stockFba}
                        </span>
                      )}
                      {(r.hasFbmOrder || ((r.stockFbm ?? 0) > 0 && r.hasUnknownChannelOrder)) && (
                        <>
                          <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/30 text-amber-300 text-[10px] font-bold uppercase tracking-wider">
                            FBM{(r.stockFbm ?? 0) > 0 ? ` ${r.stockFbm}` : " Order"}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setLabelRow(r);
                            }}
                            className="inline-flex items-center gap-1 rounded border border-amber-300/60 bg-amber-400/25 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-100 shadow-sm hover:bg-amber-400/35 active:bg-amber-400/45"
                            aria-label={`Sync FBM label cost for ${r.asin}`}
                          >
                            <Truck className="h-3 w-3" />
                            Label Cost
                          </button>
                        </>
                      )}
                      {(r.stockFba ?? 0) === 0 && (r.stockFbm ?? 0) === 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/15 text-white/80 text-[10px] font-bold uppercase tracking-wider">
                          Out
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0 min-w-[96px]">
                    <div className={`text-lg font-extrabold tabular-nums leading-tight ${r.profit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {r.profit >= 0 ? "" : "-"}{homeCurrencySymbol}{Math.abs(r.profit * homeRate).toFixed(2)}
                    </div>
                    {(() => {
                      const mkts = (r.marketplaces || []) as string[];
                      const isIntl = mkts.some((m) => m && m.toUpperCase() !== "US");
                      const label = isIntl ? "Order ROI" : "ROI";
                      const tip = isIntl
                        ? "Order ROI for non-US marketplace — excludes Remote Fulfillment cross-border, FX, storage, long-term storage, returns. Settles 5–14 days later."
                        : undefined;
                      return (
                        <div
                          className={`text-sm font-bold tabular-nums leading-tight ${r.roi !== null && r.roi >= 0 ? "text-emerald-300" : r.roi !== null ? "text-red-300" : "text-white/70"} ${tip ? "cursor-help" : ""}`}
                          title={tip}
                        >
                          {r.feesMissing
                            ? "ROI unavailable"
                            : (r.roi !== null ? `${label} ${r.roi.toFixed(1)}%${isIntl ? " ·est" : ""}` : "no cost")}
                        </div>
                      );
                    })()}
                    <div className="mt-1 text-sm font-semibold tabular-nums text-white leading-tight">
                      {(r.pendingUnits ?? 0) > 0 && r.revenue <= 0 ? "Sales pending" : `Sales ${homeCurrencySymbol}${(r.revenue * homeRate).toFixed(2)}`}
                    </div>
                    <div
                      className="text-sm font-bold tabular-nums text-amber-300 leading-tight"
                      title={r.feesMissing
                        ? `Missing ${(r.feesMissingMarketplaces || []).join("/")} fee cache — fees not estimated. Profit/ROI hidden.`
                        : r.learnedFeesApplied
                          ? `Learned pending estimate based on settled history. Raw SP-API estimate: ${homeCurrencySymbol}${((r.rawFees || 0) * homeRate).toFixed(2)}. Final fees update after settlement.`
                          : undefined}
                    >
                      {r.feesMissing
                        ? `Fees ⚠ Missing ${(r.feesMissingMarketplaces || []).join("/")} cache`
                        : `Fees −${homeCurrencySymbol}${((r.fees || 0) * homeRate).toFixed(2)}`}
                    </div>
                    <div className="text-sm font-bold tabular-nums text-blue-300 leading-tight">
                      COGS {homeCurrencySymbol}{(r.cost * homeRate).toFixed(2)}
                    </div>
                  </div>
                </li>
              ))}
              </ul>
            </>
          )}
        </section>
        {loading && rows.length > 0 && (
          <div className="flex items-center justify-center gap-2 mt-4 text-xs text-white/80">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing…
          </div>
        )}
        {isAmazonConnected && (
          <div className="mt-4 space-y-3">
            <CancelledOrdersSection
              rangeStart={periodInfo.start}
              rangeEnd={periodInfo.end}
              label={periodInfo.label}
              dark
            />
            <PromotionsDeductedSection
              rangeStart={periodInfo.start}
              rangeEnd={periodInfo.end}
              label={periodInfo.label}
              marketplace={marketplaceFilter}
              dark
              currencySymbol={homeCurrencySymbol}
              homeRate={homeRate}
            />
            <ReplacementCogsSection
              rangeStart={periodInfo.start}
              rangeEnd={periodInfo.end}
              label={periodInfo.label}
              marketplace={marketplaceFilter}
              dark
              currencySymbol={homeCurrencySymbol}
              homeRate={homeRate}
            />
            <FeeBreakdownSections
              rangeStart={periodInfo.start}
              rangeEnd={periodInfo.end}
              label={periodInfo.label}
              dark
            />
          </div>
        )}

      </main>
      )}
      {labelRow && (
        <FbmLabelCostDialog
          open={!!labelRow}
          onOpenChange={(open) => !open && setLabelRow(null)}
          asin={labelRow.asin}
          rangeStart={periodInfo.start}
          rangeEnd={periodInfo.end}
          onUpdated={() => void refreshLiveSales(true)}
        />
      )}
    </div>
  );
};

export default MobileLiveSales;
