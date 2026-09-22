import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/sales/paginatedFetch";
import { getBusinessDateISO, SALES_BUSINESS_TZ } from "@/lib/sales/dateRange";
import { getMarketplaceFromId } from "@/lib/marketplaceCurrency";
import { useAuth } from "@/contexts/AuthContext";
import { useSalesSync } from "@/contexts/SalesSyncContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, ShoppingCart, RefreshCw, AlertTriangle, Database, ArrowLeft, Copy, Truck, Search, History, Star } from "lucide-react";
import FbmLabelCostDialog from "@/components/sales/FbmLabelCostDialog";
import BbHistoryDialog from "@/components/sales/BbHistoryDialog";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Area, CartesianGrid, Cell,
} from "recharts";
import Navbar from "@/components/Navbar";
import { getInventoryUnitCost, getListingUnitCost } from "@/lib/cost-contract";
import { buildCogsResolver } from "@/lib/cogs/resolveUnitCost";
import { feeCacheKey, getCachedFeesUsd, getSalesOrderFeesUsd, isFeeCacheMissingForNonUs, type FeeCacheEntry } from "@/lib/sales/feeNormalization";
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
import { computeNetRefundFromFecRows } from "@/lib/sales/refundMath";
import FeeBreakdownSections from "@/components/sales/FeeBreakdownSections";
import PromotionsDeductedSection from "@/components/sales/PromotionsDeductedSection";
import CancelledOrdersSection from "@/components/sales/CancelledOrdersSection";
import RefundsSection from "@/components/sales/RefundsSection";
import { CustomerInsightsCard } from "@/components/customers/CustomerInsightsCard";
import ReplacementCogsSection from "@/components/sales/ReplacementCogsSection";
import ReplacementCogsChip from "@/components/sales/ReplacementCogsChip";
import { fetchPromotionDeductions } from "@/lib/sales/promotionDeductions";


interface SalesRow {
  asin: string;
  title: string | null;
  image_url: string | null;
  units: number;
  revenue: number;
  pendingUnits?: number;
  pendingRevenue?: number; // USD-converted estimated_price sum (display only)
  marketplaces?: string[]; // e.g. ["US", "CA"] — populated from each underlying order row
  latestPurchaseTimestampUtc?: string | null;
  latestPurchaseTimePt?: string | null;
  hasFbmOrder?: boolean; // true if any underlying order row is FBM (fulfillment_channel='MFN')
  /** True when an order in this period has NO fulfillment_channel from Amazon. */
  hasUnknownChannelOrder?: boolean;
  stockFbm?: number;
  stockFba?: number;
}


const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
  UK: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  JP: "JPY", AU: "AUD", IN: "INR", SG: "SGD", AE: "AED",
  SA: "SAR", NL: "EUR", SE: "SEK", PL: "PLN", BE: "EUR", TR: "TRY",
};

const MARKETPLACE_FLAGS: Record<string, string> = {
  US: "🇺🇸", CA: "🇨🇦", MX: "🇲🇽", BR: "🇧🇷",
  UK: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
  JP: "🇯🇵", AU: "🇦🇺", IN: "🇮🇳", SG: "🇸🇬", AE: "🇦🇪",
  SA: "🇸🇦", NL: "🇳🇱", SE: "🇸🇪", PL: "🇵🇱", BE: "🇧🇪", TR: "🇹🇷",
  ALL: "🌐",
};

const inferFinancialEventMarketplace = (
  row: {
    marketplace?: string | null;
    marketplace_id?: string | null;
  },
) => {
  const marketplaceId = String(row.marketplace_id || "").trim();
  if (marketplaceId) return getMarketplaceFromId(marketplaceId);

  const marketplace = String(row.marketplace || "").trim().toUpperCase();
  if (marketplace && marketplace !== "UNKNOWN" && marketplace in MARKETPLACE_CURRENCY) {
    return marketplace;
  }

  return null;
};

const resolveFinancialEventMarketplace = (
  row: {
    marketplace?: string | null;
    marketplace_id?: string | null;
  },
  selectedMarketplace: string,
) => {
  const explicitMarketplace = inferFinancialEventMarketplace(row);

  if (selectedMarketplace === "ALL") {
    return explicitMarketplace || "US";
  }

  if (selectedMarketplace === "US") {
    return explicitMarketplace ? (explicitMarketplace === "US" ? "US" : null) : "US";
  }

  return explicitMarketplace === selectedMarketplace ? selectedMarketplace : null;
};

/* ── helpers ── */
const normalizeOrderId = (orderId: string | null | undefined) =>
  String(orderId || "").trim();

const asinMarketplaceKey = (asin: string | null | undefined, marketplace: string | null | undefined) =>
  `${String(asin || "").trim()}::${String(marketplace || "US").trim().toUpperCase() || "US"}`;

const isFrozenSaleStatus = (row: { order_status?: string | null; status?: string | null }) => {
  const orderStatus = String(row.order_status || "").trim().toLowerCase();
  const status = String(row.status || "").trim().toLowerCase();
  return orderStatus === "shipped" || status === "settled" || status === "shipped";
};

const isPendingPlaceholderRow = (row: { asin?: string | null; title?: string | null }) => {
  const asin = String(row.asin || "").trim().toUpperCase();
  const title = String(row.title || "").trim().toLowerCase();
  return asin === "PENDING" || title.startsWith("order processing");
};

/** Price sources that reflect the actual transaction amount (not current listing price) */
const RELIABLE_PRICE_SOURCES = new Set([
  "orders_api",
  "financial_events",
  "actual",
  "settled",
  "fees_api",
  "order_total_pending",  // pending orders use order-level total — acceptable
]);

const isReliablePriceSource = (priceSource: string | null | undefined): boolean => {
  if (!priceSource) return false;
  return RELIABLE_PRICE_SOURCES.has(priceSource);
};

// CONFIRMED REVENUE ONLY. Per "Confirmed-only Sales Totals" contract:
// estimated_price is NEVER mixed into Gross Sales / Net Sales / P&L / ROI.
// Pending estimates are surfaced separately via getEstimatedPendingRevenueNative.
const getLineRevenue = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  promotion_discount?: number | null;
  promotion_discount_currency?: string | null;
  marketplace?: string | null;
}) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const totalSale = Number(row.total_sale_amount || 0);
  let gross = 0;
  if (totalSale > 0) gross = totalSale;
  else {
    const soldPrice = Number(row.sold_price || 0);
    if (soldPrice > 0) gross = soldPrice * qty;
  }
  if (gross <= 0) return 0;
  // Net Amazon-funded coupon (USD-safe; non-US handled via FEC promo path)
  return Math.max(0, gross - getOrderPromoUsd(row));
};

// Pending-only estimate revenue in NATIVE currency. Caller must FX-convert
// to USD before summing across marketplaces. Returns 0 for confirmed rows
// and for cancelled/cancelled-status rows.
const getEstimatedPendingRevenueNative = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
  is_cancelled?: boolean | null;
  order_status?: string | null;
}) => {
  if (row.is_cancelled === true) return 0;
  const status = String(row.order_status || "").toLowerCase();
  if (status === "canceled" || status === "cancelled") return 0;
  if (Number(row.total_sale_amount || 0) > 0) return 0;
  if (Number(row.sold_price || 0) > 0) return 0;
  const qty = Math.max(1, Number(row.quantity || 0));
  // locked_est_price is a frozen, reliably native-currency snapshot — prefer
  // it over estimated_price, which is native for most price-estimation tiers
  // but genuinely USD when sourced from an inventory-derived snapshot (a
  // historical bug in fetch-live-orders' snapshot-backfill path). Matches
  // getRevenueUsdWithFallback's locked_est_price preference above.
  const locked = Number(row.locked_est_price || 0);
  if (locked > 0) return locked * qty;
  const estimated = Number(row.estimated_price || 0);
  return estimated > 0 ? estimated * qty : 0;
};

const getUnitPriceForAverage = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
}) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const soldPrice = Number(row.sold_price || 0);
  const totalSale = Number(row.total_sale_amount || 0);
  const locked = Number(row.locked_est_price || 0);
  const estimated = Number(row.estimated_price || 0);
  if (totalSale > 0) return totalSale / qty;
  if (soldPrice > 0) return soldPrice;
  if (locked > 0) return locked;
  if (estimated > 0) return estimated;
  return 0;
};

const getRevenueWithAverageFallback = (
  row: {
    quantity?: number | null;
    sold_price?: number | null;
    total_sale_amount?: number | null;
    estimated_price?: number | null;
  },
  avgUnitPrice: number,
) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const explicit = getLineRevenue(row);
  return explicit > 0 ? explicit : avgUnitPrice > 0 ? avgUnitPrice * qty : 0;
};

// Same as Mobile Live Sales: build a USD-safe per-ASIN fallback context.
// Averages are computed in USD (after toUsd) so non-US rows don't poison the
// pool, and missing-price intl rows fall back to a same-ASIN USD unit price
// instead of a global average divided again by FX.
const addDaysISO = (dateStr: string, delta: number) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const isLowConfidencePendingRow = (row: {
  sold_price?: number | null;
  total_sale_amount?: number | null;
  price_source?: string | null;
  price_confidence?: string | null;
}) => {
  if ((row.sold_price || 0) > 0 || (row.total_sale_amount || 0) > 0) return false;
  const ps = String(row.price_source || "").toLowerCase();
  const pc = String(row.price_confidence || "").toUpperCase();
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

const getUnitPriceForAverageStrict = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
}) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const soldPrice = Number(row.sold_price || 0);
  const totalSale = Number(row.total_sale_amount || 0);
  // locked_est_price is a frozen, reliably native-currency snapshot — prefer
  // it over estimated_price, which is native for most tiers but genuinely
  // USD when sourced from an inventory-derived snapshot.
  const locked = Number(row.locked_est_price || 0);
  const estimated = Number(row.estimated_price || 0);
  if (totalSale > 0) return totalSale / qty;
  if (soldPrice > 0) return soldPrice;
  if (locked > 0) return locked;
  if (estimated > 0) return estimated;
  return 0;
};

type FxToUsd = (amount: number, mp: string | null | undefined) => number;

async function buildUsdFallbackContext(opts: {
  userId: string;
  rows: any[];
  toUsd: FxToUsd;
  rangeStart: string;
  rangeEnd: string;
}): Promise<{ getRevenueUsdWithFallback: (row: any, asin: string) => number; getEstimatedPendingUsd: (row: any) => number }> {
  const { userId, rows, toUsd, rangeStart, rangeEnd } = opts;

  const usdUnitPricesForAvg: number[] = [];
  const usdUnitPricesByAsin = new Map<string, number[]>();
  const asinSet = new Set<string>();
  for (const r of rows) {
    const asinKey = String(r.asin || "").trim();
    if (asinKey) asinSet.add(asinKey);
    const confirmedUnitUsd = getConfirmedSalesOrderUnitRevenueUsd(r, toUsd);
    const unitUsd = confirmedUnitUsd > 0
      ? confirmedUnitUsd
      : toUsd(getUnitPriceForAverageStrict(r), r.marketplace);
    if (unitUsd <= 0) continue;
    usdUnitPricesForAvg.push(unitUsd);
    if (asinKey) {
      const bucket = usdUnitPricesByAsin.get(asinKey) || [];
      bucket.push(unitUsd);
      usdUnitPricesByAsin.set(asinKey, bucket);
    }
  }
  const avgUnitPriceUsd = usdUnitPricesForAvg.length > 0
    ? usdUnitPricesForAvg.reduce((s, p) => s + p, 0) / usdUnitPricesForAvg.length
    : 0;
  const asinAvgUsdUnitPrice = new Map<string, number>();
  for (const [asinKey, prices] of usdUnitPricesByAsin) {
    asinAvgUsdUnitPrice.set(asinKey, prices.reduce((s, p) => s + p, 0) / prices.length);
  }

  const historicalUsdUnitByAsin = new Map<string, number>();
  if (asinSet.size > 0) {
    const historyStart = addDaysISO(rangeStart, -90);
    const { data: historyRows } = await supabase
      .from("sales_orders")
        .select("asin, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, marketplace, price_source, price_calc_mode, price_confidence, order_date, updated_at, promotion_discount, promotion_discount_currency")
      .eq("user_id", userId)
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
        if (!asinKey || historicalUsdUnitByAsin.has(asinKey) || isLowConfidencePendingRow(h)) continue;
        const confirmedUnitUsd = getConfirmedSalesOrderUnitRevenueUsd(h, toUsd);
        const unitUsd = confirmedUnitUsd > 0 ? confirmedUnitUsd : toUsd(getUnitPriceForAverageStrict(h), h.marketplace);
        if (unitUsd > 0) historicalUsdUnitByAsin.set(asinKey, unitUsd);
      }
    }
  }

  const inventoryUsdUnitByAsin = new Map<string, number>();
  if (asinSet.size > 0) {
    const { data: listingRows } = await supabase
      .from("created_listings")
      .select("asin, price")
      .eq("user_id", userId)
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
      .eq("user_id", userId)
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

  const snapshotNativeUnitByOrder = new Map<string, number>();
  if (rows.length > 0) {
    const orderIdsForSnapshots = Array.from(
      new Set(rows.map((r: any) => normalizeOrderId(r.order_id)).filter(Boolean)),
    );
    for (let i = 0; i < orderIdsForSnapshots.length; i += 200) {
      const chunk = orderIdsForSnapshots.slice(i, i + 200);
      const { data: snapshotRows } = await supabase
        .from("order_price_snapshots")
        .select("order_id, asin, snapshot_item_price, currency, currency_code, captured_at")
        .eq("user_id", userId)
        .in("order_id", chunk)
        .gt("snapshot_item_price", 0)
        .order("captured_at", { ascending: false });
      for (const snap of (snapshotRows || []) as any[]) {
        const orderId = normalizeOrderId(snap.order_id);
        const asin = String(snap.asin || "").trim();
        const snapshotPrice = Number(snap.snapshot_item_price || 0);
        const snapshotStoredCurrency = String(snap.currency || "").trim().toUpperCase();
        const snapshotMarketCurrency = String(snap.currency_code || "").trim().toUpperCase();
        const key = `${orderId}::${asin}`;
        // Only treat as native when stored value is actually in the marketplace
        // native currency. Skip rows where `currency='USD'` (already converted)
        // to avoid double FX conversion (MXN ~$20 USD → $1.17 bug).
        if (
          orderId &&
          asin &&
          snapshotPrice > 0 &&
          snapshotMarketCurrency &&
          snapshotMarketCurrency !== "USD" &&
          snapshotStoredCurrency === snapshotMarketCurrency &&
          !snapshotNativeUnitByOrder.has(key)
        ) {
          snapshotNativeUnitByOrder.set(key, snapshotPrice);
        }
      }

    }
  }

  const assignmentNativeUnitByAsinSku = new Map<string, number>();
  const assignmentNativeUnitEnabled = new Map<string, number>();
  if (asinSet.size > 0) {
    const { data: assignmentRows } = await supabase
      .from("repricer_assignments")
      .select("asin, sku, marketplace, is_enabled, last_applied_price, last_recommended_price, last_buybox_price, detected_offer_price")
      .eq("user_id", userId)
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
      if (sku) assignmentNativeUnitByAsinSku.set(`${asinMarketplaceKey(item.asin, mp)}::${sku}`, price);
      if (item.is_enabled && !assignmentNativeUnitEnabled.has(asinMarketplaceKey(item.asin, mp))) {
        assignmentNativeUnitEnabled.set(asinMarketplaceKey(item.asin, mp), price);
      }
    }
  }

  const getFallbackUsdUnitPrice = (asin: string) =>
    asinAvgUsdUnitPrice.get(asin) ||
    historicalUsdUnitByAsin.get(asin) ||
    inventoryUsdUnitByAsin.get(asin) ||
    0;


  // Match Mobile Live Sales / Sales Report display totals: confirmed revenue
  // wins, then estimated pending price, then same-ASIN fallback price.
  const getRevenueUsdWithFallback = (row: any, asin: string) => {
    const qty = Math.max(1, Number(row.quantity || 0));
    // Confirmed revenue is normally USD; guard legacy non-US rows where raw
    // ItemPrice was accidentally stored in native currency (MX$1420 => $79.32).
    const confirmedUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    if (confirmedUsd > 0) return confirmedUsd;
    const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
    // Prefer the order's captured estimated_price (native for non-US per the
    // currency contract) — it reflects the actual order price, not the current
    // listing. Only fall back to snapshot/assignment when the row has none.
    const lockedNative = Number(row.locked_est_price || 0) * qty;
    if (lockedNative > 0) return toUsd(lockedNative, row.marketplace);
    const estimatedNative = Number(row.estimated_price || 0) * qty;
    if (estimatedNative > 0) return toUsd(estimatedNative, row.marketplace);
    const snapshotNative = snapshotNativeUnitByOrder.get(`${normalizeOrderId(row.order_id)}::${asin}`) || 0;
    if (snapshotNative > 0) return toUsd(snapshotNative * qty, mp);
    if (!isFrozenSaleStatus(row)) {
      const orderSku = String(row.sku || row.seller_sku || "").trim();
      const assignmentNative = orderSku
        ? assignmentNativeUnitByAsinSku.get(`${asinMarketplaceKey(asin, mp)}::${orderSku}`) || 0
        : assignmentNativeUnitEnabled.get(asinMarketplaceKey(asin, mp)) || 0;
      if (assignmentNative > 0) return toUsd(assignmentNative * qty, mp);
    }
    const fallbackUnitUsd = getFallbackUsdUnitPrice(asin);
    return fallbackUnitUsd > 0 ? fallbackUnitUsd * qty : 0;
  };


  // FX-correct pending-estimate USD revenue for a row (0 if confirmed).
  const getEstimatedPendingUsd = (row: any) => {
    const native = getEstimatedPendingRevenueNative(row);
    return native > 0 ? toUsd(native, row.marketplace) : 0;
  };

  return { getRevenueUsdWithFallback, getEstimatedPendingUsd };
}


// Amazon's order_date and event_date are already bucketed by Amazon's business day
// (2 AM PT cutoff). We use them as-is — no additional offset needed.
// The 2 AM cutoff is Amazon's internal logic; by the time data is in our DB,
// the dates already reflect the correct business day.
const LIVE_SALES_TZ = SALES_BUSINESS_TZ;

const getLocalDateStr = (d: Date = new Date()) => getBusinessDateISO(d, LIVE_SALES_TZ);

const formatBusinessTimePt = (purchaseTs: string | null | undefined) => {
  const tsStr = String(purchaseTs || "").trim();
  if (!tsStr) return null;
  const tsDate = new Date(tsStr);
  if (Number.isNaN(tsDate.getTime())) return null;
  return tsDate.toLocaleString("en-US", {
    timeZone: LIVE_SALES_TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
};

const getRowBusinessDate = (
  purchaseTs: string | null | undefined,
  orderDate: string | null | undefined,
) => {
  // order_date is the authoritative Amazon business day (already reflects
  // Amazon's 2 AM PT cutoff). purchase_timestamp_utc is actually the SYNC
  // time, not the real purchase time, so we must NOT use it for bucketing.
  const d = String(orderDate || "").trim().slice(0, 10);
  return d.length >= 10 ? d : "";
};

const isRowWithinWindow = (
  purchaseTs: string | null | undefined,
  orderDate: string | null | undefined,
  rangeStartDate: string,
) => {
  const now = new Date();
  const todayStr = getLocalDateStr(now);
  const rowDateStr = getRowBusinessDate(purchaseTs, orderDate);
  if (!rowDateStr) return false;
  return rowDateStr >= rangeStartDate && rowDateStr <= todayStr;
};

const isRealAsin = (val: string | null | undefined): boolean => {
  const s = String(val || "").trim();
  return /^B0[A-Z0-9]{8}$/i.test(s);
};

/**
 * Deduplicate rows where the same order_id appears twice with different asin values
 * (one being the real ASIN, the other being a SKU/ISBN). This is a data-quality issue
 * where the sync pipeline stores the same order-item twice with different identifiers.
 *
 * Phase 1: Remove exact (order_id + asin) duplicates.
 * Phase 2: For remaining same-order pairs with matching qty & close price, only drop
 *          the row that clearly looks like a SKU/ISBN when paired with a real ASIN.
 *          If both identifiers look real, keep both to avoid undercounting legitimate
 *          multi-item orders that share the same order_id.
 */
const dedupeDebugRows = <T extends { order_id?: string | null; asin?: string | null; quantity?: number | null; sold_price?: number | null }>(rows: T[]): T[] => {
  // Phase 1: standard exact-key dedup
  const seen = new Set<string>();
  const phase1: T[] = [];
  for (const row of rows) {
    const key = `${normalizeOrderId(row.order_id)}::${String(row.asin || "").trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      phase1.push(row);
    }
  }

  // Phase 2: detect ASIN/SKU duplicate pairs within same order_id
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
    // Compare every pair in the group
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const qtyA = Number(a.quantity || 1), qtyB = Number(b.quantity || 1);
        const priceA = Number(a.sold_price || 0), priceB = Number(b.sold_price || 0);
        if (qtyA !== qtyB) continue;
        if (Math.abs(priceA - priceB) > 1.0) continue;
        // Same qty, close price — only drop when one side is clearly a non-ASIN duplicate
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
  // They surface separately via the "Pending Enrichment" indicator.
  return dedupeDebugRows(rows.filter((row) => !isPendingPlaceholderRow(row)));
};


/* ── page component ── */
export type TimeRangeKey = "today" | "yesterday" | "week" | "month" | "last_month" | "year";
// Cheap, fast-changing ranges get a snappy background poll; heavier
// reconciled ranges (Week/Month/Last Month/Year) get a much slower one --
// see the poll effect further down for why.
const FAST_POLL_RANGES: TimeRangeKey[] = ["today", "yesterday"];
export type LiveSalesPeriod = {
  timeRange: TimeRangeKey;
  rangeStart: string;
  rangeEnd: string;
  label: string;
};

const MONTH_LABELS_LS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Shared time-range resolver — keep all timeRange branches identical.
function resolveTimeRange(timeRange: TimeRangeKey): { rangeStart: string; rangeEnd: string; label: string } {
  const todayStr = getLocalDateStr(new Date());
  const [ptYear, ptMonth] = todayStr.split("-").map(Number);
  if (timeRange === "today") return { rangeStart: todayStr, rangeEnd: todayStr, label: "Today" };
  if (timeRange === "yesterday") {
    const y = new Date(); y.setDate(y.getDate() - 1);
    const ys = getLocalDateStr(y);
    return { rangeStart: ys, rangeEnd: ys, label: "Yesterday" };
  }
  if (timeRange === "week") {
    const w = new Date(); w.setDate(w.getDate() - 6);
    return { rangeStart: getLocalDateStr(w), rangeEnd: todayStr, label: "This Week" };
  }
  if (timeRange === "year") {
    return { rangeStart: `${ptYear}-01-01`, rangeEnd: todayStr, label: "This Year" };
  }
  if (timeRange === "last_month") {
    const lmYear = ptMonth === 1 ? ptYear - 1 : ptYear;
    const lmMonth = ptMonth === 1 ? 12 : ptMonth - 1;
    const mm = String(lmMonth).padStart(2, "0");
    const lastDay = new Date(lmYear, lmMonth, 0).getDate();
    return {
      rangeStart: `${lmYear}-${mm}-01`,
      rangeEnd: `${lmYear}-${mm}-${String(lastDay).padStart(2, "0")}`,
      label: `${MONTH_LABELS_LS[lmMonth - 1]} ${lmYear}`,
    };
  }
  return {
    rangeStart: `${ptYear}-${String(ptMonth).padStart(2, "0")}-01`,
    rangeEnd: todayStr,
    label: "This Month",
  };
}

const LiveSales = ({
  title = "InventorySprint Repricer in Action",
  onPeriodChange,
}: {
  title?: string;
  onPeriodChange?: (p: LiveSalesPeriod) => void;
} = {}) => {
  const navigate = useNavigate();
  const { user, session } = useAuth();
  const { homeMarketplace, homeCurrency, homeCurrencySymbol } = useHomeMarketplace();
  const { startBackgroundSync, syncState, isSyncing } = useSalesSync();
  const [selectedMarketplace, setSelectedMarketplace] = useState<string>("ALL");
  const [availableMarketplaces, setAvailableMarketplaces] = useState<string[]>([]);
  const [isAmazonConnected, setIsAmazonConnected] = useState<boolean | null>(null);
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [dailySales, setDailySales] = useState<{ day: string; label: string; units: number; revenue: number; source?: "sales_orders" | "fec_fallback" | "fec" | "sales_orders_live" }[]>([]);
  const [monthSummary, setMonthSummary] = useState<{ units: number; revenue: number } | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("today");

  // Compute current period (rangeStart / rangeEnd / label) and emit to parent
  const [currentPeriod, setCurrentPeriod] = useState<LiveSalesPeriod | null>(null);
  useEffect(() => {
    const { rangeStart, rangeEnd, label } = resolveTimeRange(timeRange);
    const period: LiveSalesPeriod = { timeRange, rangeStart, rangeEnd, label };
    setCurrentPeriod(period);
    if (onPeriodChange) onPeriodChange(period);
  }, [timeRange, onPeriodChange]);

  const [chartMode, setChartMode] = useState<"order_date" | "shipped" | "smart">(() => {
    try { return (localStorage.getItem("livesales.chartMode") as any) || "smart"; } catch { return "smart"; }
  });
  const [loading, setLoading] = useState(false);
  const [isSwitchingRange, setIsSwitchingRange] = useState(false);
  const [todaySummary, setTodaySummary] = useState({ units: 0, revenue: 0 });
  // Pending non-confirmed estimate revenue (USD, FX-converted). Kept fully
  // separate from todaySummary.revenue so it never affects Gross/Net/P&L/ROI.
  const [pendingEstimateRevenue, setPendingEstimateRevenue] = useState({ usd: 0, orders: 0, units: 0 });
  const [fbmLabelAsin, setFbmLabelAsin] = useState<string | null>(null);
  const [bbHistoryTarget, setBbHistoryTarget] = useState<{ asin: string; marketplace: string; ts: string | null } | null>(null);
  const isSalesReport = title === "Sales Report";
  const [todayRefunds, setTodayRefunds] = useState({ count: 0, amount: 0 });
  const [periodFeesCost, setPeriodFeesCost] = useState({ fees: 0, cost: 0 });
  const [feesCostByAsin, setFeesCostByAsin] = useState<Record<string, { fees: number; cost: number; feesMissing?: boolean; missingMarkets?: string[] }>>({});
  // Settlement-level adjustments from financial_events_cache that are NOT part
  // of per-order fees already in sales_orders (referral / FBA / variable+fixed
  // closing). Includes storage, removals, inbound transport, reimbursements,
  // warehouse lost/damage, etc. Signed net value: positive = net credit (adds
  // to profit), negative = net extra cost.
  const [periodAdjustments, setPeriodAdjustments] = useState({ net: 0, extraFees: 0, credits: 0, events: 0 });
  const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);
  const [periodPromotions, setPeriodPromotions] = useState({ total: 0, rows: 0 });
  // FEC row coverage for the selected period — drives the amber
  // "Settlement data incomplete" banner on past periods.
  const [fecCoverage, setFecCoverage] = useState<{ rows: number; rangeEnd: string; loaded: boolean }>({ rows: 0, rangeEnd: "", loaded: false });
  const [fxRates, setFxRates] = useState<Record<string, number>>({ USD: 1 });
  // USD -> seller's home currency multiplier, applied only at display
  // boundaries below (internal state stays USD). No-op (1) for USD sellers.
  const homeRate = fxRates[homeCurrency] ?? 1;
  // Chart display data — dailySales.revenue is USD internally; homeRate
  // converts only at this display boundary (no-op for USD sellers). Keeps
  // dailySales itself untouched for day/source lookups used elsewhere.
  const chartData = useMemo(
    () => dailySales.map((d) => ({ ...d, revenue: d.revenue * homeRate })),
    [dailySales, homeRate],
  );

  // True once fetchSales has successfully painted data at least once --
  // gates whether a subsequent non-silent call shows the SWR "revalidating"
  // skeleton (data already on screen) vs. the full first-load spinner.
  const hasDataRef = useRef(false);
  // True for the whole lifetime of any in-flight fetchSales() call, reset
  // unconditionally on completion (unlike the isStale()-gated resets used
  // elsewhere, which intentionally skip resetting when a newer call has
  // superseded an older one). Lets the background poll skip a tick if the
  // previous fetch hasn't finished yet, instead of overlapping.
  const fetchInFlightRef = useRef(false);
  const [revalidating, setRevalidating] = useState(false);
  // fetchSales can take a while (multiple paginated queries + heavy
  // per-row COGS/fee computation), so only reveal a skeleton if a
  // revalidating fetch is still running after 400ms -- quick refreshes
  // update seamlessly with no flash; only genuinely slow ones show it.
  const [showRevalidatingSkeleton, setShowRevalidatingSkeleton] = useState(false);
  useEffect(() => {
    if (!revalidating) {
      setShowRevalidatingSkeleton(false);
      return;
    }
    const t = setTimeout(() => setShowRevalidatingSkeleton(true), 400);
    return () => clearTimeout(t);
  }, [revalidating]);
  // Bumped by the background poll to re-trigger the refunds/adjustments/
  // fecCoverage/feesCost/promotions effects below on the same cadence,
  // without touching their internals.
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const run = async () => {
      try {
        const { rangeStart, rangeEnd } = resolveTimeRange(timeRange);
        const promo = await fetchPromotionDeductions({
          userId: user.id,
          rangeStart,
          rangeEnd,
          marketplace: selectedMarketplace || "ALL",
        });
        if (!cancelled) setPeriodPromotions({ total: promo.totalUsd || 0, rows: promo.rows.length });
      } catch (e) {
        if (!cancelled) console.warn("[LiveSales] promotion deductions fetch failed:", e);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [user?.id, selectedMarketplace, timeRange, pollTick]);

  // Fetch refunds for the SELECTED period (deducted from revenue display)
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const run = async () => {
      const { rangeStart, rangeEnd } = resolveTimeRange(timeRange);
      // Net refund impact from financial_events_cache (matches Seller Central):
      // sum of all amounts where positive = seller paid, negative = seller credit.
      const data = await fetchAllPages<any>(() => {
        let q = supabase
          .from("financial_events_cache")
          .select("refunds, promotional_rebate_refunds, marketplace_facilitator_tax_refunds, sales_tax_refunds, shipping_credit_refunds, shipping_chargeback_refund, gift_wrap_credit_refunds, referral_fees, fba_fees, fba_customer_return_fees, restocking_fee, other_fees, digital_services_fee, reversal_reimbursement, marketplace, amazon_order_id")
          .eq("user_id", user.id)
          .eq("event_type", "refund")
          .gte("event_date", rangeStart)
          .lte("event_date", rangeEnd)
          .order("event_date", { ascending: true });
        if (selectedMarketplace && selectedMarketplace !== "ALL") {
          if (selectedMarketplace === "US") q = q.or("marketplace.eq.US,marketplace.is.null");
          else q = q.eq("marketplace", selectedMarketplace);
        }
        return q;
      }, { label: "LiveSales FEC refunds" });
      if (cancelled || !data) return;
      // CANONICAL NET refund cost via shared helper (full 12-col mode).
      // See src/lib/sales/refundMath.ts and architecture-audit.md §1.2.
      const canon = computeNetRefundFromFecRows(data as any[], 'full');
      setTodayRefunds({ count: canon.refundEventCount, amount: canon.refundCostNet });
    };
    run();
    // Background poll (below) bumps pollTick to re-run this on the same
    // cadence as fetchSales, in addition to mount/filter-change/manual Refresh.
    return () => { cancelled = true; };
  }, [user?.id, selectedMarketplace, timeRange, pollTick]);

  // Settlement-level adjustments (FEC) for the SELECTED period — EXCLUDES the
  // four per-order fee columns already aggregated in sales_orders to avoid
  // double-counting: referral_fees, fba_fees, variable_closing_fees,
  // fixed_closing_fees. Adds storage/removal/inbound/etc as extra fees and
  // reimbursements/warehouse credits as income.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const run = async () => {
      try {
        const { rangeStart, rangeEnd } = resolveTimeRange(timeRange);
        // NOTE: `fbm_shipping_label_fee` is intentionally EXCLUDED here — the
        // per-order FBM label cost is now sourced from sales_orders.shipping_label_fee
        // (Buy Shipping rate / Finances / Settlement / Manual) and rolled into
        // per-row fees by getSalesOrderFeesUsd. Adding it here too would double-count.
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
        const SELECT = ["marketplace", ...EXTRA_FEE_COLS, ...CREDIT_COLS].join(",");
        const PAGE = 1000;
        let extraFees = 0, credits = 0, events = 0;
        for (let from = 0; ; from += PAGE) {
          let q = supabase
            .from("financial_events_cache")
            .select(SELECT)
            .eq("user_id", user.id)
            .gte("event_date", rangeStart)
            .lte("event_date", rangeEnd)
            .range(from, from + PAGE - 1);
          if (selectedMarketplace && selectedMarketplace !== "ALL") {
            // Settlement credits (warehouse_lost/damage, reimbursements, other_income) and
            // settlement-level fees (storage/removal/inbound/etc) are written with
            // marketplace='UNKNOWN' because settlement files don't tag a marketplace per
            // line. For US-home sellers, treat UNKNOWN as US so these credits show up on
            // the US tab — otherwise they only appear under ALL.
            if (selectedMarketplace === "US") q = q.or("marketplace.eq.US,marketplace.is.null,marketplace.eq.UNKNOWN");
            else q = q.eq("marketplace", selectedMarketplace);
          }
          const { data, error } = await q;
          if (error || !data || data.length === 0) break;
          for (const r of data as any[]) {
            for (const k of EXTRA_FEE_COLS) extraFees += Math.abs(Number(r[k] || 0));
            for (const k of CREDIT_COLS) credits += Number(r[k] || 0);
            events++;
          }
          if (data.length < PAGE) break;
        }
        if (cancelled) return;
        setPeriodAdjustments({ net: credits - extraFees, extraFees, credits, events });
      } catch (e) {
        if (!cancelled) console.warn("[LiveSales] periodAdjustments fetch failed:", e);
      }
    };
    run();
    // Background poll (below) bumps pollTick to re-run this on the same
    // cadence as fetchSales, in addition to mount/filter-change/manual Refresh.
    return () => { cancelled = true; };
  }, [user?.id, selectedMarketplace, timeRange, pollTick]);


  // FEC coverage probe for the selected period.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { rangeStart, rangeEnd } = resolveTimeRange(timeRange);
        let q = supabase
          .from("financial_events_cache")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("event_date", rangeStart)
          .lte("event_date", rangeEnd);
        if (selectedMarketplace && selectedMarketplace !== "ALL") {
          if (selectedMarketplace === "US") q = q.or("marketplace.eq.US,marketplace.is.null");
          else q = q.eq("marketplace", selectedMarketplace);
        }
        const { count } = await q;
        if (!cancelled) setFecCoverage({ rows: count ?? 0, rangeEnd, loaded: true });
      } catch {
        if (!cancelled) setFecCoverage({ rows: 0, rangeEnd: "", loaded: true });
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, selectedMarketplace, timeRange, pollTick]);


  // Fetch Amazon fees + cost of goods for the SELECTED period (mirrors MobileLiveSales logic)
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const run = async () => {
      try {
        const { rangeStart, rangeEnd } = resolveTimeRange(timeRange);

        const toUsd = (amount: number, mp: string | null | undefined) => {
          const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
          if (currency === "USD") return amount;
          const rate = fxRates[currency];
          return rate && rate > 0 ? amount / rate : amount;
        };

        const rows: any[] = [];
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          let q = supabase
            .from("sales_orders")
            .select("id, order_id, asin, sku, seller_sku, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, marketplace, status, is_cancelled, order_status, order_type, order_date, price_source, price_calc_mode, referral_fee, fba_fee, closing_fee, total_fees, fees_source, unit_cost, unit_cost_at_sale, cost_source_at_sale, cost_locked, total_cost, shipping_label_fee, fulfillment_channel, promotion_discount, promotion_discount_currency")
            .eq("user_id", user.id)
            .gte("order_date", rangeStart)
            .lte("order_date", rangeEnd)
            .not("order_id", "like", "%-REFUND")
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (selectedMarketplace && selectedMarketplace !== "ALL") {
            if (selectedMarketplace === "US") q = q.or("marketplace.eq.US,marketplace.is.null");
            else q = q.eq("marketplace", selectedMarketplace);
          }
          const { data: page, error } = await q;
          if (error || !page || page.length === 0) break;
          rows.push(...page);
          if (page.length < PAGE) break;
        }
        if (cancelled) return;

        const valid = rows.filter((r: any) => {
          if (r.is_cancelled === true) return false;
          const s = String(r.order_status || "").toLowerCase();
          if (s === "canceled" || s === "cancelled") return false;
          const t = String(r.order_type || "").toLowerCase();
          if (t.includes("replacement")) return false;
          return true;
        });
        const seenKeys = new Set<string>();
        const deduped = valid.filter((row: any) => {
          const key = `${String(row.order_id || "").trim()}::${String(row.asin || "").trim()}`;
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });

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

        // Fee fallback from asin_fee_cache
        const feeByAsin = new Map<string, FeeCacheEntry>();
        if (asinSet.size > 0) {
          const { data: feeRows } = await supabase
            .from("asin_fee_cache")
            .select("asin, marketplace, fba_fee_fixed, referral_rate, is_media")
            .eq("user_id", user.id)
            .in("asin", Array.from(asinSet));
          if (feeRows) {
            for (const f of feeRows as any[]) {
              const key = feeCacheKey(f.asin, f.marketplace);
              if (f.asin && !feeByAsin.has(key)) {
                feeByAsin.set(key, {
                  fba: Number(f.fba_fee_fixed) || 0,
                  refRate: Number(f.referral_rate) || 0.15,
                  isMedia: Boolean(f.is_media),
                  // asin_fee_cache.fba_fee_fixed is stored in USD (writer
                  // contract, post-2026-06-20 backfill currency fix). Do NOT
                  // re-convert via FX.
                  marketplaceNativeFixedFee: false,
                });

              }
            }
          }
        }

        // Phase 2: learned international fee multipliers (CA/MX/BR pending only).
        // Settled FEC + confirmed orders are NEVER touched. The raw SP-API
        // estimate remains stored on sales_orders. See
        // mem://features/sales/learned-intl-fee-multipliers-v1.
        const learnedFeeSettings: LearnedFeeSettings = await loadLearnedFeeSettings(supabase, user.id);
        const learnedFeeMultipliers: LearnedFeeMultiplierMap = await loadLearnedFeeMultipliers(supabase, user.id);
        const asinFeeMultipliers: AsinFeeMultiplierMap = await loadAsinFeeMultipliers(supabase, user.id);

        const { getRevenueUsdWithFallback } = await buildUsdFallbackContext({
          userId: user.id,
          rows: deduped,
          toUsd,
          rangeStart,
          rangeEnd,
        });

        let totalFees = 0;
        let totalCost = 0;
        const perAsin: Record<string, { fees: number; cost: number; feesMissing?: boolean; missingMarkets?: string[] }> = {};
        for (const row of deduped) {
          const asin = String(row.asin || "").trim();
          const sku = String((row as any).sku || (row as any).seller_sku || "").trim();
          const qty = Math.max(1, Number(row.quantity || 0));
          // Confirmed-only for fee/cost contribution. Estimates never affect ROI.
          // Includes a guard for legacy non-US native ItemPrice rows.
          const rawRevenueUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);


          // Mirror MobileLiveSales: use estimate basis for pending rows so
          // stored per-order fee columns (referral/fba/closing/label) are still
          // applied, and fall back to cached fee profile when the row has none.
          const feeBasisUsd = rawRevenueUsd > 0
            ? rawRevenueUsd
            : getRevenueUsdWithFallback(row, asin);

          let feesUsd = getSalesOrderFeesUsd(row as any, feeBasisUsd, toUsd);
          let feeCacheMissingNonUs = false;
          if (feesUsd <= 0 && feeBasisUsd > 0) {
            const f = feeByAsin.get(feeCacheKey(asin, row.marketplace));
            if (f) {
              feesUsd = getCachedFeesUsd(f, feeBasisUsd, qty, row.marketplace, toUsd);
            } else if (isFeeCacheMissingForNonUs({
              marketplace: row.marketplace,
              storedFeeTotalUsd: feesUsd,
              hasCacheEntry: false,
              revenueUsd: feeBasisUsd,
            })) {
              feeCacheMissingNonUs = true;
            }
          }
          // Learned multiplier (pending CA/MX/BR only — guarded inside helper).
          const learnedFee = applyLearnedFeeMultiplier({
            row: row as any,
            rawFeesUsd: feesUsd,
            settings: learnedFeeSettings,
            multipliers: learnedFeeMultipliers,
            asinMultipliers: asinFeeMultipliers,
          });
          feesUsd = learnedFee.feesUsd;

          // Unified COGS resolver — locked sale-time snapshot wins, then
          // date-aware purchases/listings, then low-confidence current inventory.
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

          totalFees += feesUsd;
          totalCost += lineCost;
          if (asin) {
            const cur = perAsin[asin] || { fees: 0, cost: 0 };
            cur.fees += feesUsd;
            cur.cost += lineCost;
            if (feeCacheMissingNonUs) {
              cur.feesMissing = true;
              const mp = String(row.marketplace || "").trim().toUpperCase();
              const set = new Set(cur.missingMarkets || []);
              if (mp) set.add(mp);
              cur.missingMarkets = Array.from(set);
            }
            perAsin[asin] = cur;
          }
        }


        if (cancelled) return;
        setPeriodFeesCost({
          fees: Math.round(totalFees * 100) / 100,
          cost: Math.round(totalCost * 100) / 100,
        });
        setFeesCostByAsin(perAsin);
      } catch (e: any) {
        console.warn("[LiveSales] fees/cost effect error:", e?.message || e);
      }
    };
    run();
    // Background poll (below) bumps pollTick to re-run this on the same
    // cadence as fetchSales, in addition to mount/filter-change/manual Refresh.
    return () => { cancelled = true; };
  }, [user?.id, selectedMarketplace, timeRange, fxRates, pollTick]);

  const [chartSource, setChartSource] = useState<"sales_orders" | "reconciled" | "error" | null>(null);
  
  const [reconciling, setReconciling] = useState(false);
  const [reconReport, setReconReport] = useState<any>(null);
  const [todayRevenueReady, setTodayRevenueReady] = useState(false);
  const [todayRevenueStatus, setTodayRevenueStatus] = useState<"idle" | "preparing" | "ready" | "timeout">("idle");
  const { toast } = useToast();
  const latestFetchIdRef = useRef(0);
  const enrichmentRunIdRef = useRef(0);
  const todayRevenuePrepPromiseRef = useRef<Promise<void> | null>(null);
  const lastTodayRevenuePrepAtRef = useRef(0);
  const [debugDay, setDebugDay] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"units" | "revenue" | "none">("none");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const toggleSort = (key: "units" | "revenue") => {
    if (sortKey !== key) { setSortKey(key); setSortDir("desc"); }
    else if (sortDir === "desc") setSortDir("asc");
    else { setSortKey("none"); setSortDir("desc"); }
  };
  const sortIndicator = (key: "units" | "revenue") => sortKey !== key ? "↕" : sortDir === "desc" ? "↓" : "↑";
  const [debugRows, setDebugRows] = useState<any[]>([]);
  const [debugFilterStrict, setDebugFilterStrict] = useState(false);
  const chartRowsByDayRef = useRef<Map<string, any[]>>(new Map());

  // Lightweight: refresh ONLY Today Units / Today Revenue (no chart, no month, no images).
  // Used after backfill-order-snapshots completes so the KPI updates fast without re-running the full pipeline.
  const fetchTodaySummaryOnly = useCallback(async () => {
    if (!user?.id) return;
    // GUARD: todaySummary is shared with the period KPI card (week/month/year).
    // If the user is viewing a wider range, overwriting it with today-only totals
    // causes the visible "This Year Revenue" to collapse to today's $ mid-refresh,
    // then jump back when fetchSales() completes. Only run this fast path when
    // the displayed period is actually "today".
    if (timeRange !== "today") return;
    try {
      const todayStr = getLocalDateStr(new Date());
      const toUsd = (amount: number, mp: string | null | undefined) => {
        const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
        if (currency === "USD") return amount;
        const rate = fxRates[currency];
        return rate && rate > 0 ? amount / rate : amount;
      };

      const rows: any[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        let q = supabase
          .from("sales_orders")
            .select("id, order_id, asin, sku, seller_sku, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, order_date, status, is_cancelled, order_status, order_type, marketplace, price_source, price_calc_mode, needs_price_enrich, promotion_discount, promotion_discount_currency")
          .eq("user_id", user.id)
          .gte("order_date", todayStr)
          .lte("order_date", todayStr)
          .not("order_id", "like", "%-REFUND")
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);

        if (selectedMarketplace && selectedMarketplace !== "ALL") {
          if (selectedMarketplace === "US") {
            q = q.or("marketplace.eq.US,marketplace.is.null");
          } else {
            q = q.eq("marketplace", selectedMarketplace);
          }
        }

        const { data: page, error } = await q;
        if (error) { console.warn("[LiveSales] fetchTodaySummaryOnly error:", error.message); return; }
        if (!page || page.length === 0) break;
        rows.push(...page);
        if (page.length < PAGE) break;
      }

      const valid = rows.filter((r: any) => {
        if (r.is_cancelled === true) return false;
        const s = String(r.order_status || "").toLowerCase();
        if (s === "canceled" || s === "cancelled") return false;
        const t = String(r.order_type || "").toLowerCase();
        if (t.includes("replacement")) return false;
        return true;
      });

      const deduped = dedupeSalesRowsForLiveTotals(valid);

      const { getRevenueUsdWithFallback, getEstimatedPendingUsd } = await buildUsdFallbackContext({
        userId: user.id,
        rows: deduped,
        toUsd,
        rangeStart: todayStr,
        rangeEnd: todayStr,
      });

      let totalUnits = 0;
      let totalRevenue = 0;
      let pendingUsd = 0;
      let pendingOrders = 0;
      let pendingUnits = 0;
      const pendingOrderIds = new Set<string>();
      for (const r of deduped) {
        const qty = Math.max(1, Number(r.quantity || 0));
        const asin = String((r as any).asin || "").trim();
        totalUnits += qty;
        totalRevenue += getRevenueUsdWithFallback(r, asin);
        const estUsd = getEstimatedPendingUsd(r);
        if (estUsd > 0) {
          pendingUsd += estUsd;
          pendingUnits += qty;
          const oid = String((r as any).order_id || "");
          if (oid && !pendingOrderIds.has(oid)) { pendingOrderIds.add(oid); pendingOrders += 1; }
        }
      }


      setTodaySummary({ units: totalUnits, revenue: Math.round(totalRevenue * 100) / 100 });
      setPendingEstimateRevenue({ usd: Math.round(pendingUsd * 100) / 100, orders: pendingOrders, units: pendingUnits });
    } catch (e: any) {
      console.warn("[LiveSales] fetchTodaySummaryOnly exception:", e?.message || e);
    }
  }, [user?.id, selectedMarketplace, fxRates, timeRange]);

  const prepareTodayRevenue = useCallback(async (force = false) => {
    if (!user?.id || !session?.access_token) {
      setTodayRevenueReady(true);
      setTodayRevenueStatus("ready");
      return;
    }

    if (todayRevenuePrepPromiseRef.current) {
      return todayRevenuePrepPromiseRef.current;
    }

    const now = Date.now();
    if (!force && todayRevenueReady && now - lastTodayRevenuePrepAtRef.current < 15000) {
      return;
    }

    const todayStr = getLocalDateStr(new Date());

    const runId = ++enrichmentRunIdRef.current;
    setTodayRevenueReady(false);
    setTodayRevenueStatus("preparing");

    const timeoutId = window.setTimeout(() => {
      if (enrichmentRunIdRef.current !== runId) return;
      // Even on timeout, refresh KPI from whatever is in DB now.
      void fetchTodaySummaryOnly();
      setTodayRevenueReady(true);
      setTodayRevenueStatus("timeout");
    }, 3000);

    // Fire-and-forget the heavier Orders API sync — it must NOT gate the Today KPI.
    try {
      void startBackgroundSync({ force, silent: true }).catch(() => {});
    } catch { /* ignore */ }

    const prepPromise = (async () => {
      try {
        await supabase.functions.invoke("backfill-order-snapshots", {
          body: {
            limit: 250,
            start_date: todayStr,
            end_date: todayStr,
          },
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).catch(() => {});
        // Refresh ONLY the Today KPI — do not re-run the full chart/month pipeline.
        await fetchTodaySummaryOnly();
      } finally {
        window.clearTimeout(timeoutId);
        lastTodayRevenuePrepAtRef.current = Date.now();
        todayRevenuePrepPromiseRef.current = null;
        if (enrichmentRunIdRef.current === runId) {
          setTodayRevenueReady(true);
          setTodayRevenueStatus("ready");
        }
      }
    })();

    todayRevenuePrepPromiseRef.current = prepPromise;
    return prepPromise;
  }, [user?.id, session?.access_token, startBackgroundSync, todayRevenueReady, fetchTodaySummaryOnly]);

  const runReconciliation = useCallback(async (dryRun = true) => {
    if (!user?.id) return;
    setReconciling(true);
    setReconReport(null);
    try {
      const { data, error } = await supabase.functions.invoke("reconcile-sales-prices", {
        body: { dryRun },
      });
      if (error) throw error;
      setReconReport(data);
      toast({
        title: dryRun ? "Dry Run Complete" : "Reconciliation Complete",
        description: dryRun
          ? `Would correct ${data?.summary?.corrected || 0} rows. Run again with Apply to commit.`
          : `Applied ${data?.summary?.applied || 0} corrections.`,
      });
      if (!dryRun) {
        // Refresh chart after applying
        setTimeout(() => fetchSales(), 2000);
      }
    } catch (err: any) {
      console.error("[Reconciliation] Error:", err);
      toast({ title: "Reconciliation Failed", description: err.message, variant: "destructive" });
    } finally {
      setReconciling(false);
    }
  }, [user?.id, toast]);

  useEffect(() => {
    const fetchFx = async () => {
      const { data } = await supabase.from("fx_rates").select("quote, rate");
      if (data) {
        const map: Record<string, number> = { USD: 1 };
        for (const r of data) map[r.quote] = Number(r.rate) || 1;
        setFxRates(map);
      }
    };
    fetchFx();
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    const detectMarketplaces = async () => {
      const { data } = await supabase
        .from("seller_authorizations")
        .select("marketplace_id")
        .eq("user_id", user.id);
      if (data && data.length > 0) {
        setIsAmazonConnected(true);
        const codes = [...new Set(data.map((r: any) => getMarketplaceFromId(r.marketplace_id)).filter(Boolean))];
        codes.sort((a, b) => (a === "US" ? -1 : b === "US" ? 1 : a.localeCompare(b)));
        if (codes.length > 1) codes.unshift("ALL");
        setAvailableMarketplaces(codes);
        setSelectedMarketplace((prev) => {
          // Preserve the user's current selection whenever it's still valid.
          // Previously this forced US → ALL on (re)mount when the seller had
          // multiple marketplaces, which made the marketplace toggle appear
          // broken (clicking "US" snapped back to "ALL" and the totals never
          // dropped to US-only numbers).
          if (codes.includes(prev)) return prev;
          return codes.includes("ALL") ? "ALL" : (codes[0] || "US");
        });
      } else {
        setIsAmazonConnected(false);
        setAvailableMarketplaces([]);
      }
    };
    detectMarketplaces();
  }, [user?.id]);

  const fetchSales = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!user?.id || isAmazonConnected === null) return;
    const fetchId = ++latestFetchIdRef.current;
    const isStale = () => latestFetchIdRef.current !== fetchId;
    fetchInFlightRef.current = true;
    // Fully silent (background poll) calls skip loading/revalidating
    // entirely -- no skeleton, just a quiet data update. The skeleton is
    // reserved for deliberate actions: first load, manual Refresh, and
    // switching time ranges.
    if (!silent) {
      if (hasDataRef.current) setRevalidating(true);
      else setLoading(true);
    }
    chartRowsByDayRef.current = new Map();
    try {
      const todayStr = getLocalDateStr(new Date());
      const { rangeStart, rangeEnd } = resolveTimeRange(timeRange);

      const toUsd = (amount: number, mp: string | null | undefined) => {
        const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
        if (currency === "USD") return amount;
        const rate = fxRates[currency];
        return rate && rate > 0 ? amount / rate : amount;
      };

      // ── 1. Chart data: SO-primary (order_date), FEC as gap-filler only ──
      const chartDataMap = new Map<string, { units: number; revenue: number; source: string }>();

      // 1a. Fetch SO (primary source for chart — order_date based)
      const seenSalesOrderRowIds = new Set<string>();
      const allChartRows: Array<{
        id: string;
        order_id: string;
        asin: string;
        quantity: number;
        sold_price: number;
        total_sale_amount: number;
        estimated_price: number;
        locked_est_price?: number | null;
        marketplace: string | null;
        purchase_timestamp_utc: string | null;
        order_date: string;
        is_cancelled: boolean | null;
        order_status: string | null;
        order_type: string | null;
        price_source?: string | null;
        needs_price_enrich?: boolean | null;
        price_enrich_status?: string | null;
      }> = [];
      {
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          if (isStale()) return;
          let q = supabase
            .from("sales_orders")
            .select("id, order_date, purchase_timestamp_utc, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, marketplace, status, is_cancelled, order_status, order_type, order_id, asin, sku, seller_sku, price_source, price_calc_mode, needs_price_enrich, price_enrich_status, promotion_discount, promotion_discount_currency")
            .eq("user_id", user.id)
            .gte("order_date", rangeStart)
            .lte("order_date", rangeEnd)
            .not("order_id", "like", "%-REFUND")
            .order("order_date", { ascending: true })
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);

          if (selectedMarketplace && selectedMarketplace !== "ALL") {
            if (selectedMarketplace === "US") {
              q = q.or("marketplace.eq.US,marketplace.is.null");
            } else {
              q = q.eq("marketplace", selectedMarketplace);
            }
          }

          const { data: page, error: pageErr } = await q;
          if (isStale()) return;
          if (pageErr) throw pageErr;
          if (!page || page.length === 0) break;

          for (const row of page) {
            if (seenSalesOrderRowIds.has(row.id)) continue;
            seenSalesOrderRowIds.add(row.id);
            if (row.is_cancelled === true) continue;
            const status = String(row.order_status || "").toLowerCase();
            if (status === "canceled" || status === "cancelled") continue;
            if (!status && !String(row.order_date || "").trim()) continue;
            const orderType = String(row.order_type || "").toLowerCase();
            if (orderType.includes("replacement")) continue;
            allChartRows.push(row as any);
          }

          if (page.length < PAGE) break;
        }
      }

      // Deduplicate SO rows for debug log
      {
        const resolvedOrderIds = new Set(
          allChartRows
            .filter((r) => !isPendingPlaceholderRow(r))
            .map((r: any) => normalizeOrderId(r.order_id))
            .filter(Boolean)
        );
        const dedupedChartRows = dedupeDebugRows(
          allChartRows.filter((row) => {
            if (!isPendingPlaceholderRow(row)) return true;
            const oid = normalizeOrderId((row as any).order_id);
            return oid && !resolvedOrderIds.has(oid);
          })
        );

        // Store SO rows by day — used for BOTH chart AND debug log
        for (const row of dedupedChartRows) {
          const dateStr = getRowBusinessDate(row.purchase_timestamp_utc, row.order_date);
          if (!dateStr || dateStr < rangeStart || dateStr > rangeEnd) continue;
          if (!chartRowsByDayRef.current.has(dateStr)) chartRowsByDayRef.current.set(dateStr, []);
          chartRowsByDayRef.current.get(dateStr)!.push(row);
        }

        // Dedupe within each day
        for (const [day, rows] of chartRowsByDayRef.current.entries()) {
          chartRowsByDayRef.current.set(day, dedupeDebugRows(rows));
        }
      }

      // 1b. Build chart from SO rows for ALL days (unified with top KPI)
      {
        // Build USD-safe fallback once across the full chart window so non-US
        // rows don't pollute per-day native averages.
        const allDayRows: any[] = [];
        for (const rows of chartRowsByDayRef.current.values()) allDayRows.push(...rows);
        const { getRevenueUsdWithFallback: chartRevenueUsd } = await buildUsdFallbackContext({
          userId: user.id,
          rows: allDayRows,
          toUsd,
          rangeStart,
          rangeEnd,
        });

        for (const [day, rows] of chartRowsByDayRef.current) {
          const totals = rows.reduce(
            (acc, row) => {
              acc.units += Math.max(1, Number(row.quantity || 0));
              const asin = String((row as any).asin || "").trim();
              acc.revenue += chartRevenueUsd(row, asin);
              return acc;
            },
            { units: 0, revenue: 0 },
          );
          chartDataMap.set(day, {
            units: totals.units,
            revenue: totals.revenue,
            source: day === todayStr ? "sales_orders_live" : "sales_orders",
          });
        }
      }


      const { units: totalRangeUnits, revenue: totalRangeRevenue } = Array.from(chartDataMap.values()).reduce(
        (acc, entry) => {
          acc.units += entry.units;
          acc.revenue += entry.revenue;
          return acc;
        },
        { units: 0, revenue: 0 },
      );

      // ── 1c. Optional FEC fallback (Smart Fallback or Shipped/Settled mode) ──
      // Pull pre-aggregated daily shipped/settled totals from a SQL function so
      // we don't have to page through up to 500k rows on the client. UI-only —
      // we never write anything back to sales_orders.
      type FecBucket = { units: number; revenue: number };
      const fecMap = new Map<string, FecBucket>();
      if (chartMode !== "order_date") {
        try {
          if (isStale()) return;
          const rpcMarketplace = selectedMarketplace && selectedMarketplace !== "ALL"
            ? selectedMarketplace
            : null;
          const { data: fecAgg, error: fecErr } = await (supabase as any).rpc(
            "get_fec_daily_shipment_totals",
            {
              p_start: rangeStart,
              p_end: rangeEnd,
              p_marketplace: rpcMarketplace,
            },
          );
          if (isStale()) return;
          if (fecErr) {
            console.warn("[LiveSales] FEC daily-totals RPC error:", fecErr.message);
          } else if (Array.isArray(fecAgg)) {
            for (const r of fecAgg as any[]) {
              const day = String(r.event_day || "").slice(0, 10);
              if (!day) continue;
              const bucket = fecMap.get(day) || { units: 0, revenue: 0 };
              bucket.units += Number(r.units || 0);
              bucket.revenue += toUsd(Math.abs(Number(r.sales || 0)), r.marketplace);
              fecMap.set(day, bucket);
            }
          }
        } catch (e: any) {
          console.warn("[LiveSales] FEC fallback exception:", e?.message || e);
        }
      }


      // Build chart array (apply chartMode)
      const shouldHoldChartRevenue = todayRevenueStatus === "preparing" && timeRange === "today" && todaySummary.revenue <= 0;
      const dailyArr: { day: string; label: string; units: number; revenue: number; source: "sales_orders" | "fec_fallback" | "fec" | "sales_orders_live" }[] = [];
      let fallbackUnits = 0;
      let fallbackRevenue = 0;
      let soOnlyUnits = 0;
      let soOnlyRevenue = 0;
      for (
        let cursor = new Date(`${rangeStart}T12:00:00`);
        getLocalDateStr(cursor) <= rangeEnd;
        cursor.setDate(cursor.getDate() + 1)
      ) {
        const day = getLocalDateStr(cursor);
        const so = chartDataMap.get(day);
        const fec = fecMap.get(day);
        const soUnits = so ? Math.max(0, Number(so.units || 0)) : 0;
        const soRevenue = so ? Number(so.revenue || 0) : 0;

        let useUnits = soUnits;
        let useRevenue = soRevenue;
        let source: "sales_orders" | "fec_fallback" | "fec" | "sales_orders_live" =
          (so?.source as any) || "sales_orders";

        if (chartMode === "shipped") {
          // Always use FEC
          useUnits = fec?.units ?? 0;
          useRevenue = fec?.revenue ?? 0;
          source = "fec";
        } else if (chartMode === "smart") {
          // Smart Fallback (display-only). Use FEC when:
          //  (a) SO has zero units on that day, OR
          //  (b) SO has zero revenue but FEC has revenue (placement rows missing prices), OR
          //  (c) FEC revenue is materially larger than SO revenue (≥ 1.5×) AND
          //      FEC units are also larger — indicates SO is missing rows for that day.
          // We never overwrite today's live SO data with FEC.
          const fecUnits = fec?.units ?? 0;
          const fecRevenue = fec?.revenue ?? 0;
          const isToday = day === todayStr;
          const soDayMissing = soUnits === 0 && fecUnits > 0;
          const soPriceless = soRevenue <= 0 && fecRevenue > 0 && fecUnits > 0;
          const fecMateriallyLarger =
            !isToday &&
            fecRevenue >= 1.5 * Math.max(soRevenue, 0.01) &&
            fecUnits >= soUnits &&
            fecRevenue - soRevenue >= 5; // ignore rounding noise
          if (soDayMissing || soPriceless || fecMateriallyLarger) {
            useUnits = fecUnits;
            useRevenue = fecRevenue;
            source = "fec_fallback";
            fallbackUnits += useUnits;
            fallbackRevenue += useRevenue;
          } else {
            soOnlyUnits += soUnits;
            soOnlyRevenue += soRevenue;
          }
        } else {
          soOnlyUnits += soUnits;
          soOnlyRevenue += soRevenue;
        }

        const safeUnits = Math.max(0, Number(useUnits || 0));
        dailyArr.push({
          day,
          label: new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          units: safeUnits,
          revenue: shouldHoldChartRevenue && day === todayStr ? 0 : safeUnits > 0 ? Math.round(useRevenue * 100) / 100 : 0,
          source,
        });
      }

      // Recompute summary based on what's actually plotted (so the KPI matches the chart)
      const plottedTotals = dailyArr.reduce(
        (acc, d) => { acc.units += d.units; acc.revenue += d.revenue; return acc; },
        { units: 0, revenue: 0 },
      );

      if (isStale()) return;
      setMonthSummary({
        units: chartMode === "order_date" ? totalRangeUnits : plottedTotals.units,
        revenue: chartMode === "order_date"
          ? Math.round(totalRangeRevenue * 100) / 100
          : Math.round(plottedTotals.revenue * 100) / 100,
      });
      setDailySales(dailyArr);
      setChartSource("sales_orders");
      if (debugDay) {
        setDebugRows(dedupeDebugRows(chartRowsByDayRef.current.get(debugDay) || []));
      }

      // ── 2. Product breakdown: fetch the full selected period so KPIs match fees/cost/refunds ──
      const breakdownStart = rangeStart;
      const breakdownEnd = rangeEnd;
      const todayData: any[] = [];
      {
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          if (isStale()) return;
          let q = supabase
            .from("sales_orders")
            .select("id, order_id, asin, title, image_url, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, order_date, purchase_timestamp_utc, status, is_cancelled, order_status, order_type, marketplace, fulfillment_channel, price_source, price_calc_mode, needs_price_enrich, promotion_discount, promotion_discount_currency")
            .eq("user_id", user.id)
            .gte("order_date", breakdownStart)
            .lte("order_date", breakdownEnd)
            .not("order_id", "like", "%-REFUND")
            .order("order_date", { ascending: true })
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);

          if (selectedMarketplace && selectedMarketplace !== "ALL") {
            if (selectedMarketplace === "US") {
              q = q.or("marketplace.eq.US,marketplace.is.null");
            } else {
              q = q.eq("marketplace", selectedMarketplace);
            }
          }

          const { data: page, error: pageErr } = await q;
          if (isStale()) return;
          if (pageErr) throw pageErr;
          if (!page || page.length === 0) break;
          todayData.push(...page);
          if (page.length < PAGE) break;
        }
      }

      const validToday = todayData.filter((row: any) => {
        if (row.is_cancelled === true) return false;
        const status = String(row.order_status || "").toLowerCase();
        if (status === "canceled" || status === "cancelled") return false;
        const orderType = String(row.order_type || "").toLowerCase();
        if (orderType.includes("replacement")) return false;
        return true;
      });

      const dedupedToday = dedupeSalesRowsForLiveTotals(validToday);

      console.debug("[LiveSales] Today breakdown rows:", dedupedToday.length, "for", breakdownStart);

      const { getRevenueUsdWithFallback: breakdownRevenueUsd, getEstimatedPendingUsd: breakdownPendingUsd } = await buildUsdFallbackContext({
        userId: user.id,
        rows: dedupedToday,
        toUsd,
        rangeStart: breakdownStart,
        rangeEnd: breakdownEnd,
      });

      const asinMap = new Map<string, SalesRow>();
      let totalUnits = 0;
      let totalRevenue = 0;
      let pendingUsdSum = 0;
      let pendingUnitsSum = 0;
      const pendingOrderIdSet = new Set<string>();

      for (const row of dedupedToday) {
        const placeholder = isPendingPlaceholderRow(row);
        const asin = placeholder
          ? `PENDING::${normalizeOrderId((row as any).order_id) || Math.random()}`
          : (row.asin || "").trim();
        if (!asin) continue;

        const qty = Math.max(1, Number(row.quantity || 0));
        const lineRevenue = breakdownRevenueUsd(row, (row.asin || "").trim());
        const pendingUnits = lineRevenue <= 0 ? qty : 0;

        if (lineRevenue <= 0) {
          console.warn("[LiveSales] Zero revenue row", {
            order_id: (row as any).order_id,
            asin: row.asin,
            sold_price: row.sold_price,
            total_sale_amount: row.total_sale_amount,
            estimated_price: row.estimated_price,
            qty,
          });
        }

        totalUnits += qty;
        totalRevenue += lineRevenue;
        const _estUsd = breakdownPendingUsd(row);
        if (_estUsd > 0) {
          pendingUsdSum += _estUsd;
          pendingUnitsSum += qty;
          const _oid = String((row as any).order_id || "");
          if (_oid) pendingOrderIdSet.add(_oid);
        }


        const purchaseTimePt = formatBusinessTimePt((row as any).purchase_timestamp_utc);
        const rowMarketplace = inferFinancialEventMarketplace(row as any) || "US";
        const channelRaw = String((row as any).fulfillment_channel || "").trim().toUpperCase();
        const isFbmOrder = channelRaw === "MFN";
        // Amazon does not always give us a channel (13,142 of 2026's orders
        // have none). Unknown is not FBA, so those must still be able to
        // carry a label cost -- see the button condition below.
        const channelUnknown = channelRaw === "";
        const existing = asinMap.get(asin);
        if (existing) {
          existing.units += qty;
          existing.revenue += lineRevenue;
          existing.pendingUnits = (existing.pendingUnits || 0) + pendingUnits;
          existing.pendingRevenue = (existing.pendingRevenue || 0) + _estUsd;
          if (isFbmOrder) existing.hasFbmOrder = true;
          if (channelUnknown) existing.hasUnknownChannelOrder = true;
          if (!existing.title && row.title) existing.title = row.title;
          if (!existing.image_url && row.image_url) existing.image_url = row.image_url;
          if (rowMarketplace && !existing.marketplaces!.includes(rowMarketplace)) {
            existing.marketplaces!.push(rowMarketplace);
          }
          if (purchaseTimePt && (!existing.latestPurchaseTimestampUtc || new Date(String((row as any).purchase_timestamp_utc)).getTime() > new Date(String(existing.latestPurchaseTimestampUtc)).getTime())) {
            existing.latestPurchaseTimestampUtc = (row as any).purchase_timestamp_utc || null;
            existing.latestPurchaseTimePt = purchaseTimePt;
          }
        } else {
          asinMap.set(asin, {
            asin: placeholder ? "PENDING" : asin,
            title: row.title || (placeholder ? "Pending Order" : null),
            image_url: row.image_url || null,
            units: qty,
            revenue: lineRevenue,
            pendingUnits,
            pendingRevenue: _estUsd,
            marketplaces: rowMarketplace ? [rowMarketplace] : [],
            latestPurchaseTimestampUtc: (row as any).purchase_timestamp_utc || null,
            latestPurchaseTimePt: purchaseTimePt,
            hasFbmOrder: isFbmOrder,
            hasUnknownChannelOrder: channelUnknown,
          });
        }

      }

      // Enrich missing images from inventory table
      const missingImageAsins = Array.from(asinMap.values())
        .filter(r => !r.image_url && r.asin !== "PENDING")
        .map(r => r.asin);
      if (missingImageAsins.length > 0) {
        const { data: invImages } = await supabase
          .from("inventory")
          .select("asin, image_url")
          .eq("user_id", user.id)
          .in("asin", missingImageAsins)
          .not("image_url", "is", null);
        if (isStale()) return;
        if (invImages) {
          for (const inv of invImages) {
            const entry = asinMap.get(inv.asin);
            if (entry && !entry.image_url && inv.image_url) {
              entry.image_url = inv.image_url;
            }
          }
        }
      }

      // Match mobile Live Sales: FBM inventory rows also expose the label-cost button.
      const stockByAsin = new Map<string, { fba: number; fbm: number }>();
      const asinsForStock = Array.from(asinMap.values()).map(r => r.asin).filter(asin => asin && asin !== "PENDING");
      if (asinsForStock.length > 0) {
        const { data: stockRows } = await supabase
          .from("inventory")
          .select("asin, available, source, listing_status")
          .eq("user_id", user.id)
          .in("asin", asinsForStock);
        if (isStale()) return;
        if (stockRows) {
          for (const s of stockRows as any[]) {
            const asin = String(s.asin || "").trim();
            if (!asin) continue;
            const ls = String(s.listing_status || "").toUpperCase();
            if (ls === "NOT_IN_CATALOG" || ls === "DELETED") continue;
            const avail = Math.max(0, Number(s.available) || 0);
            const cur = stockByAsin.get(asin) || { fba: 0, fbm: 0 };
            if (s.source === "amazon_sync_fbm") cur.fbm += avail;
            else cur.fba += avail;
            stockByAsin.set(asin, cur);
          }
        }
      }

      for (const row of asinMap.values()) {
        const stock = stockByAsin.get(row.asin);
        row.stockFba = stock?.fba ?? 0;
        row.stockFbm = stock?.fbm ?? 0;
      }

      if (isStale()) return;
      // "Smart Fallback" and "Estimated (Order Date)" are both operational,
      // order-placed views: their KPI cards must be derived from the SAME
      // rows the user sees in the table below (asinMap/rows), never from a
      // different data source. Smart Fallback previously swapped the header
      // for the FEC-blended per-day chart totals (`plotted`) on ANY day it
      // used FEC fallback, while the table rows stayed SO-based -- so Net
      // Profit could never equal the sum of the visible row profits. Per its
      // tooltip ("falls back... on days with missing or priceless placement
      // rows. Display only"), Smart is only supposed to patch chart gaps,
      // not become a different accounting basis for the summary tiles.
      //
      // "Reconciled (Shipped/Settled)" is intentionally a different
      // accounting basis -- its tooltip promises "Matches P&L exactly" --
      // so its header is SUPPOSED to diverge from the SO-based row table.
      // dailyArr is 100% FEC-sourced for every day when chartMode==="shipped"
      // (see the chartMode==="shipped" branch above), so summing it gives
      // the correct settlement-authoritative total.
      if (chartMode === "shipped") {
        const plotted = dailyArr.reduce(
          (acc, d) => { acc.units += d.units; acc.revenue += d.revenue; return acc; },
          { units: 0, revenue: 0 },
        );
        setTodaySummary({ units: plotted.units, revenue: Math.round(plotted.revenue * 100) / 100 });
      } else {
        setTodaySummary({ units: totalUnits, revenue: Math.round(totalRevenue * 100) / 100 });
      }
      setPendingEstimateRevenue({
        usd: Math.round(pendingUsdSum * 100) / 100,
        orders: pendingOrderIdSet.size,
        units: pendingUnitsSum,
      });
      setRows(Array.from(asinMap.values()).sort((a, b) => b.revenue - a.revenue));
      hasDataRef.current = true;
    } catch (err: any) {
      console.error("[LiveSales] Error:", err);
      if (!isStale()) setChartSource("error");
    } finally {
      if (!isStale()) {
        setLoading(false);
        setRevalidating(false);
        setIsSwitchingRange(false);
      }
      fetchInFlightRef.current = false;
    }
  }, [user?.id, selectedMarketplace, fxRates, isAmazonConnected, timeRange, todayRevenueStatus, chartMode, todaySummary.revenue]);

  const refreshLiveSales = useCallback(
    async (force = false) => {
      if (!user?.id) return;
      if (force) void prepareTodayRevenue(true);
      await fetchSales();
      void startBackgroundSync({ force: false, silent: true }).catch(() => {});
    },
    [user?.id, startBackgroundSync, fetchSales, prepareTodayRevenue],
  );

  useEffect(() => { fetchSales(); }, [fetchSales, syncState.syncVersion]);

  useEffect(() => {
    if (!user?.id) return;
    void prepareTodayRevenue();
  }, [user?.id, selectedMarketplace, timeRange, prepareTodayRevenue]);

  useEffect(() => {
    if (!user?.id) return;
    void refreshLiveSales(false);
    // CPU-pressure control: 60s periodic refresh removed. Users click Refresh
    // for fresh data; opening N tabs no longer multiplies Supabase load.
  }, [user?.id, refreshLiveSales]);

  // Local-only ticker: silently re-reads already-synced Supabase tables on a
  // range-aware cadence so numbers update without a manual tap, without
  // adding extra Amazon API calls (silent fetches never touch the actual
  // sync). Today/Yesterday are cheap and change fast (intraday orders), so
  // they get a snappy 5s poll. Week/Month/Last Month/Year involve much
  // heavier reconciled calculations (COGS/fee resolution across many rows),
  // so they get a much slower 60s cadence instead. Bumping pollTick also
  // re-runs the refunds/adjustments/fecCoverage/feesCost/promotions effects
  // above on the same cadence. Paused while the tab is backgrounded.
  useEffect(() => {
    if (!user?.id) return;
    const intervalMs = FAST_POLL_RANGES.includes(timeRange) ? 5000 : 60000;
    const tick = () => {
      if (document.visibilityState === "visible" && !fetchInFlightRef.current) {
        void fetchSales({ silent: true });
        setPollTick((t) => t + 1);
      }
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [user?.id, fetchSales, timeRange]);

  const hasChartData = dailySales.length > 0;
  const shouldHoldRevenue = todayRevenueStatus === "preparing" && timeRange === "today" && todaySummary.revenue <= 0;
  const periodLabel = resolveTimeRange(timeRange).label;
  const periodLabelLower = periodLabel.toLowerCase();

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 pt-24 pb-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-full"
            onClick={() => navigate('/tools/repricer')}
            aria-label="Back to Repricer"
            title="Back to Repricer"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-xl bg-emerald-500/10 shrink-0">
              <ShoppingCart className="h-6 w-6 text-emerald-500" />
            </div>
            <h1 className="text-2xl font-bold text-foreground leading-tight">{title}</h1>
          </div>
        </div>

        {/* Not connected */}
        {isAmazonConnected === false && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 rounded-xl border border-border bg-card">
            <AlertTriangle className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-lg font-semibold text-foreground">No Amazon Marketplaces Connected</p>
            <p className="text-sm text-muted-foreground text-center max-w-md">
              Connect your Amazon account to view live sales data.
            </p>
          </div>
        )}

        {isAmazonConnected !== false && (
          <>
            {/* Controls bar */}
            <div className="flex flex-wrap items-center gap-3 p-4 mb-4 rounded-xl border border-border bg-card">
              {availableMarketplaces.length > 1 && (
                <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5 shadow-sm">
                  {availableMarketplaces.map((mp) => (
                    <button
                      key={mp}
                      onClick={() => setSelectedMarketplace(mp)}
                      title={mp === homeMarketplace ? "Your primary marketplace" : undefined}
                      className={`relative px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                        selectedMarketplace === mp
                          ? "bg-primary text-primary-foreground shadow-md"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      } ${mp === homeMarketplace ? "ring-2 ring-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]" : ""}`}
                    >
                      {MARKETPLACE_FLAGS[mp] || "🏳️"} {mp}
                      {mp === homeMarketplace && <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400 absolute -top-1.5 -right-1.5" />}
                    </button>
                  ))}
                </div>
              )}

              {/* Time range toggle */}
              <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5 shadow-sm">
                {([["today", "Today"], ["yesterday", "Yesterday"], ["week", "This Week"], ["month", "This Month"], ["last_month", "Last Month"], ["year", "This Year"]] as const).map(([val, lbl]) => (
                  <button
                    key={val}
                    onClick={() => { setIsSwitchingRange(true); setTimeRange(val); }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                      timeRange === val
                        ? "bg-primary text-primary-foreground shadow-md"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {/* Chart-source toggle — mirrors P&L Reconciled / Estimated wording */}
              <div
                className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5 shadow-sm"
                title="How to count sales on each day — display only, does not affect repricer or velocity logic"
              >
                {([
                  ["smart", "Smart Fallback", "Default. Uses Order Date (sales_orders); falls back to Shipped/Settled (financial_events_cache) on days with missing or priceless placement rows. Display only."],
                  ["order_date", "Estimated (Order Date)", "Operational view — counts orders by placement date from sales_orders. Best for demand & velocity."],
                  ["shipped", "Reconciled (Shipped/Settled)", "Accounting view — counts revenue by shipment/settlement date from financial_events_cache. Matches P&L exactly."],
                ] as const).map(([val, lbl, tip]) => (
                  <button
                    key={val}
                    title={tip}
                    onClick={() => {
                      setIsSwitchingRange(true);
                      setChartMode(val);
                      try { localStorage.setItem("livesales.chartMode", val); } catch { /* ignore */ }
                    }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                      chartMode === val
                        ? "bg-primary text-primary-foreground shadow-md"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-4 ml-auto">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col items-end">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Units</span>
                      {loading && (
                        <span className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        </span>
                      )}
                    </div>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-10" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${loading ? 'text-muted-foreground/70' : 'text-foreground'}`}>{todaySummary.units}</span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Revenue</span>
                    {shouldHoldRevenue ? (
                      <div className="flex flex-col items-end gap-1">
                        <Skeleton className="h-6 w-24" />
                        <span className="text-[10px] text-muted-foreground">Updating {periodLabelLower}&apos;s revenue…</span>
                      </div>
                    ) : showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-24" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${loading ? 'text-emerald-600/50' : 'text-emerald-600'}`}>{homeCurrencySymbol}{(todaySummary.revenue * homeRate).toFixed(2)}</span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div
                    className="flex flex-col items-end cursor-help"
                    title={`Estimated Pending Sales — non-US (CA/MX/BR) and other orders awaiting Orders API ItemPrice or FEC settlement. FX-converted to ${homeCurrencySymbol} for display. INFORMATIONAL ONLY — excluded from Confirmed Sales, Net Profit, ROI, and P&L.`}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      {periodLabel} Pending Est.{pendingEstimateRevenue.orders > 0 ? ` (${pendingEstimateRevenue.orders})` : ""}
                    </span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-20" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${pendingEstimateRevenue.usd > 0 ? 'text-muted-foreground italic' : 'text-muted-foreground'}`}>
                        ~{homeCurrencySymbol}{(pendingEstimateRevenue.usd * homeRate).toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      {periodLabel} Refunds{todayRefunds.count > 0 ? ` (${todayRefunds.count})` : ""}
                    </span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-16" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${todayRefunds.amount > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {todayRefunds.amount > 0 ? '−' : ''}{homeCurrencySymbol}{(todayRefunds.amount * homeRate).toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Amazon Fees</span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-16" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${periodFeesCost.fees > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                        {periodFeesCost.fees > 0 ? '−' : ''}{homeCurrencySymbol}{(periodFeesCost.fees * homeRate).toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Cost</span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-16" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${periodFeesCost.cost > 0 ? 'text-blue-400' : 'text-muted-foreground'}`}>
                        {periodFeesCost.cost > 0 ? '−' : ''}{homeCurrencySymbol}{(periodFeesCost.cost * homeRate).toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <button
                    type="button"
                    onClick={() => setAdjustmentsOpen((v) => !v)}
                    className="flex flex-col items-end hover:opacity-80"
                    title={`Non-order settlement corrections only (${periodAdjustments.events} events): reimbursements, reversals, liquidation, lost/damaged inventory, storage, removals, inbound, other fees.\n\nBuyer shipping credit is already in Revenue. FBM label fees and per-order referral/FBA/closing fees are already in Fees. Click to see the breakdown.`}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      {periodLabel} Adjustments <span className="opacity-70">{adjustmentsOpen ? "▴" : "▾"}</span>
                    </span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-16" />
                    ) : (() => {
                      const v = periodAdjustments.net;
                      const cls = v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-emerald-600' : 'text-destructive';
                      const sign = v > 0 ? '+' : v < 0 ? '−' : '';
                      return (
                        <span className={`text-lg font-bold tabular-nums leading-tight underline decoration-dotted underline-offset-2 ${cls}`}>
                          {sign}{homeCurrencySymbol}{Math.abs(v * homeRate).toFixed(2)}
                        </span>
                      );
                    })()}
                  </button>

                  {currentPeriod && (
                    <ReplacementCogsChip
                      variant="column"
                      withLeftDivider
                      label={`${periodLabel} Replacement / Free Ship.`}
                      rangeStart={currentPeriod.rangeStart}
                      rangeEnd={currentPeriod.rangeEnd}
                      marketplace={selectedMarketplace || "ALL"}
                      currencySymbol={homeCurrencySymbol}
                      homeRate={homeRate}
                    />
                  )}
                  <div className="w-px h-8 bg-border" />
                  <div
                    className="flex flex-col items-end"
                    title={`Promotions deducted from profit via shared Promotions Deducted calculation (${periodPromotions.rows} rows).`}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Promotions</span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-16" />
                    ) : (
                      <span className={`text-lg font-bold tabular-nums leading-tight ${periodPromotions.total > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {periodPromotions.total > 0 ? '−' : ''}{homeCurrencySymbol}{(periodPromotions.total * homeRate).toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Net Profit</span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-16" />
                    ) : (() => {
                      const net = todaySummary.revenue - todayRefunds.amount - periodFeesCost.fees - periodFeesCost.cost + periodAdjustments.net - periodPromotions.total;
                      return (
                        <span className={`text-lg font-bold tabular-nums leading-tight ${net >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                          {net < 0 ? '−' : ''}{homeCurrencySymbol}{Math.abs(net * homeRate).toFixed(2)}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="w-px h-8 bg-border" />
                  <div
                    className="flex flex-col items-end cursor-help"
                    title={"Order-level ROI: revenue − promotions − (referral + FBA + closing fees) − COGS − refunds + settlement adjustments.\n\nFor non-US marketplaces (MX/CA/BR) this is an ESTIMATE while orders are pending — it does NOT yet include Remote Fulfillment cross-border fees, FX drift, storage, long-term storage, returns, or reimbursements. Those settle 5–14 days later and can materially reduce true ROI."}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{periodLabel} Order ROI</span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-6 w-12" />
                    ) : (() => {
                      const net = todaySummary.revenue - todayRefunds.amount - periodFeesCost.fees - periodFeesCost.cost + periodAdjustments.net - periodPromotions.total;
                      const roi = periodFeesCost.cost > 0 ? (net / periodFeesCost.cost) * 100 : null;
                      const cls = roi === null ? 'text-muted-foreground' : roi >= 0 ? 'text-emerald-600' : 'text-destructive';
                      return (
                        <span className={`text-lg font-bold tabular-nums leading-tight ${cls}`}>
                          {roi === null ? '—' : `${roi.toFixed(1)}%`}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() => void refreshLiveSales(true)}
                  disabled={loading || isSyncing}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading || isSyncing ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>


            {adjustmentsOpen && periodAdjustments.events > 0 && (
              <div className="mb-3 rounded-lg border border-border bg-muted/40 p-3 text-xs tabular-nums">
                <div className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
                  Adjustments breakdown ({periodAdjustments.events} events)
                </div>
                <div className="flex justify-between text-emerald-600">
                  <span>Credits (reimbursements, reversals, liquidation, lost/damaged, other income)</span>
                  <span>+{homeCurrencySymbol}{(periodAdjustments.credits * homeRate).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-destructive">
                  <span>Extra adjustment fees (storage, removal, inbound, disposal, other)</span>
                  <span>−{homeCurrencySymbol}{(periodAdjustments.extraFees * homeRate).toFixed(2)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
                  <span>Net Adjustments</span>
                  <span className={periodAdjustments.net >= 0 ? "text-emerald-600" : "text-destructive"}>
                    {periodAdjustments.net >= 0 ? "+" : "−"}{homeCurrencySymbol}{Math.abs(periodAdjustments.net * homeRate).toFixed(2)}
                  </span>
                </div>
                <div className="mt-2 text-[11px] leading-snug text-muted-foreground">
                  Buyer shipping credit is already in Revenue. FBM label fees and per-order referral/FBA/closing fees are already in Fees. They are intentionally excluded here to avoid double-counting.
                </div>
              </div>
            )}


            {/* FEC coverage warning — past period whose settlement events
                were never synced. Suppressed while period end is within the
                last 7 days (settlement always lags Amazon by 5–14 days). */}
            {(() => {
              if (!fecCoverage.loaded || fecCoverage.rows > 0) return null;
              const today = new Date().toISOString().slice(0, 10);
              const lagCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
              if (!fecCoverage.rangeEnd || fecCoverage.rangeEnd >= lagCutoff) return null;
              return (
                <div className="mb-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-900 dark:text-amber-200">
                  <span className="font-bold">⚠ Settlement data for this period is incomplete.</span>{" "}
                  ROI may exclude refunds, storage, removals, reimbursements, and promotional rebates. Per-order Amazon fees and COGS are still applied.
                </div>
              );
            })()}



            {/* Admin: Price Reconciliation */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <Database className="h-4 w-4 text-amber-600 shrink-0" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Data Reconciliation</span> — Fix historical prices using settled financial data
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void runReconciliation(true)}
                  disabled={reconciling}
                >
                  {reconciling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  Dry Run
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    if (confirm("This will update historical prices in the database. Continue?")) {
                      void runReconciliation(false);
                    }
                  }}
                  disabled={reconciling}
                >
                  Apply Fix
                </Button>
              </div>
              {reconReport && (
                <div className="w-full mt-2 p-2 rounded-lg bg-background border border-border text-xs font-mono text-muted-foreground overflow-auto max-h-48">
                  <pre>{JSON.stringify(reconReport.summary || reconReport, null, 2)}</pre>
                </div>
              )}
            </div>

            {/* Month summary + business day cutoff */}
            {monthSummary && (
              <div className="flex items-center justify-between px-4 py-3 mb-4 rounded-xl bg-card border border-border">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-muted-foreground">📅 {periodLabel}</span>
                  <span className="text-[10px] text-muted-foreground/70">
                    Business day: 2:00 AM – 1:59 AM PT ({new Date().toLocaleString("en-US", { timeZone: LIVE_SALES_TZ, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })})
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">Units</span>
                    {showRevalidatingSkeleton ? (
                      <Skeleton className="h-5 w-10" />
                    ) : (
                      <span className="text-base font-bold text-foreground tabular-nums">{monthSummary.units}</span>
                    )}
                  </div>
                  <div className="w-px h-5 bg-border" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">Revenue</span>
                    {shouldHoldRevenue ? (
                      <Skeleton className="h-5 w-20" />
                    ) : showRevalidatingSkeleton ? (
                      <Skeleton className="h-5 w-20" />
                    ) : (
                      <span className="text-base font-bold text-emerald-600 tabular-nums">{homeCurrencySymbol}{(monthSummary.revenue * homeRate).toFixed(2)}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Data source banner — adapts to active chart mode */}
            {(() => {
              const fallbackDayCount = dailySales.filter((d) => d.source === "fec_fallback").length;
              if (chartMode === "shipped") {
                return (
                  <div className="flex items-start gap-2.5 px-4 py-3 mb-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                    <ShoppingCart className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                    <div className="text-xs text-muted-foreground leading-relaxed">
                      <span className="font-semibold text-foreground">Shipped / settled on this date</span> — accounting view, sourced from <code className="text-[10px] bg-muted px-1 rounded">financial_events_cache.event_date</code>. Matches your Amazon payouts and the P&amp;L dashboard.
                      <span className="block mt-1 text-muted-foreground/85">
                        Switch to <strong>Estimated (Order Date)</strong> for the operational placement view, or <strong>Smart Fallback</strong> to combine both.
                      </span>
                    </div>
                  </div>
                );
              }
              if (chartMode === "smart") {
                return (
                  <div className="flex items-start gap-2.5 px-4 py-3 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                    <ShoppingCart className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                    <div className="text-xs text-muted-foreground leading-relaxed">
                      <span className="font-semibold text-foreground">Smart Fallback</span> — uses <code className="text-[10px] bg-muted px-1 rounded">sales_orders.order_date</code> by default, and falls back to <code className="text-[10px] bg-muted px-1 rounded">financial_events_cache</code> on days where Amazon's Orders API returned no placement rows, where placement rows exist but have no price, or where shipped/settled revenue is materially larger than recorded order revenue. Display-only — repricer, reorder velocity, and inventory logic still use raw order data.
                      <span className="block mt-1 text-muted-foreground/85">
                        {fallbackDayCount > 0 ? (
                          <><strong className="text-amber-700 dark:text-amber-400">{fallbackDayCount} day{fallbackDayCount === 1 ? "" : "s"}</strong> in this window are estimated from shipped/settled financial events (highlighted in amber on the chart). P&amp;L is unchanged.</>
                        ) : (
                          <>No fallback days needed in this window — every day has order placement rows.</>
                        )}
                      </span>
                    </div>
                  </div>
                );
              }
              return (
                <div className="flex items-start gap-2.5 px-4 py-3 mb-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
                  <ShoppingCart className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    <span className="font-semibold text-foreground">Orders placed on this date</span> — operational view, sourced from <code className="text-[10px] bg-muted px-1 rounded">sales_orders.order_date</code>. Counts when the customer <em>placed</em> the order, not when it shipped.
                    <span className="block mt-1 text-muted-foreground/85">
                      Looking for <strong>shipped/settled</strong> revenue (matches Amazon payouts)? Switch the toggle above to <strong>Reconciled (Shipped/Settled)</strong> or <strong>Smart Fallback</strong>, or open <strong>Profit &amp; Loss</strong>.
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Chart */}
            <div className="rounded-xl border border-border bg-card p-4 mb-6 relative">
              {shouldHoldRevenue && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/75 backdrop-blur-[1px]">
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm font-medium text-muted-foreground">Updating today&apos;s revenue…</span>
                  </div>
                </div>
              )}
              {isSwitchingRange && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/80 backdrop-blur-sm">
                  <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-muted border border-border shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm font-medium text-muted-foreground">Updating…</span>
                  </div>
                </div>
              )}
              {chartSource === "error" ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                    <h3 className="text-sm font-bold text-destructive">Chart Unavailable</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">Financial settlement data failed to load. Try refreshing.</p>
                </div>
              ) : hasChartData ? (
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ left: 4, right: 4, top: 4, bottom: 4 }} onClick={(e: any) => {
                        if (e?.activePayload?.[0]?.payload?.day) {
                          const day = e.activePayload[0].payload.day;
                          setDebugDay(day);
                          setDebugRows(dedupeDebugRows(chartRowsByDayRef.current.get(day) || []));
                        }
                      }} style={{ cursor: 'pointer' }}>
                      <defs>
                        <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                       <XAxis
                         dataKey="label"
                         tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                         {...(timeRange === "year" ? {
                           ticks: dailySales
                             .filter((d) => {
                               const dt = new Date(`${d.day}T12:00:00`);
                               return dt.getDate() <= 7;
                             })
                             .map((d) => d.label),
                           tickFormatter: (label: string) => {
                             const match = dailySales.find((d) => d.label === label);
                             if (!match) return label;
                             return new Date(`${match.day}T12:00:00`).toLocaleDateString("en-US", { month: "short" });
                           },
                         } : {})}
                       />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => `${homeCurrencySymbol}${v}`} width={60} />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                        }}
                        labelFormatter={(label) => {
                          const match = dailySales.find((d) => d.label === label);
                          if (!match) return label;
                          const tag =
                            match.source === "fec_fallback"
                              ? " · Estimated from shipped/settled financial events"
                              : match.source === "fec"
                              ? " · Shipped/settled (financial events)"
                              : "";
                          return `${label} (${match.day} · 2:00 AM – 1:59 AM PT)${tag}`;
                        }}
                        formatter={(value: number, name: string) => [
                          name === "revenue" ? `${homeCurrencySymbol}${value.toFixed(2)}` : value,
                          name === "revenue" ? "Revenue" : "Units",
                        ]}
                      />
                      <Area type="monotone" dataKey="revenue" stroke="hsl(142, 76%, 36%)" fill="url(#revGradient)" strokeWidth={2} />
                      <Bar
                        dataKey="units"
                        opacity={0.75}
                        radius={[3, 3, 0, 0]}
                        barSize={20}
                        cursor="pointer"
                        onClick={(data: any) => {
                          if (data?.day) {
                            setDebugDay(data.day);
                            setDebugRows(dedupeDebugRows(chartRowsByDayRef.current.get(data.day) || []));
                          }
                        }}
                      >
                        {chartData.map((d, idx) => (
                          <Cell
                            key={`cell-${idx}`}
                            fill={
                              d.source === "fec_fallback"
                                ? "hsl(38, 92%, 50%)"
                                : d.source === "fec"
                                ? "hsl(142, 76%, 36%)"
                                : "hsl(221, 83%, 53%)"
                            }
                          />
                        ))}
                      </Bar>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : !loading ? (
                <div className="text-center text-muted-foreground text-sm py-10">No chart data available</div>
              ) : (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            {/* Debug: Day Order Inspector */}
            <Dialog open={!!debugDay} onOpenChange={(open) => { if (!open) setDebugDay(null); }}>
              <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
                <DialogHeader>
                  <DialogTitle className="text-sm">
                    🔍 Orders for {debugDay}
                  </DialogTitle>
                </DialogHeader>
                {(() => {
                  const AUTHORITATIVE_SOURCES = new Set(["reconciled_fec", "financial_events", "orders_api", "orders_itemprice", "actual", "settled", "fees_api"]);
                  const filteredRows = debugFilterStrict
                    ? debugRows.filter(r => {
                        const status = String(r.order_status || "").trim();
                        const src = String((r as any).price_source || "").trim();
                        return status === "Shipped" && AUTHORITATIVE_SOURCES.has(src);
                      })
                    : debugRows;
                  const uniqueOrders = new Set(filteredRows.map((r: any) => r.order_id)).size;
                  const totalUnits = filteredRows.reduce((s: number, r: any) => s + Math.max(1, Number(r.quantity || 0)), 0);
                  const toUsdDebug = (amount: number, mp: string | null | undefined) => {
                    const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
                    if (currency === "USD") return amount;
                    const rate = fxRates[currency];
                    return rate && rate > 0 ? amount / rate : amount;
                  };
                  const debugPricesForAvg = filteredRows.map((r: any) => getUnitPriceForAverage(r)).filter((p: number) => p > 0);
                  const debugAvgUnitPrice = debugPricesForAvg.length > 0
                    ? debugPricesForAvg.reduce((sum: number, price: number) => sum + price, 0) / debugPricesForAvg.length
                    : 0;
                  const totalRevenue = filteredRows.reduce((s: number, r: any) => s + toUsdDebug(getRevenueWithAverageFallback(r, debugAvgUnitPrice), r.marketplace), 0);
                  // Show the chart value alongside SO debug rows
                  const chartEntry = dailySales.find(d => d.day === debugDay);
                  const chartRevenue = chartEntry?.revenue ?? 0;
                  const chartUnits = chartEntry?.units ?? 0;
                  return (
                    <>
                      <div className="text-[11px] text-muted-foreground mb-1">
                        <span className="font-semibold text-foreground">📊 Chart (SO):</span> {chartUnits} units · ${chartRevenue.toFixed(2)} revenue
                        <span className="mx-2">|</span>
                        <span className="text-muted-foreground">📋 SO rows: {filteredRows.length} items · {uniqueOrders} orders · {totalUnits} units · ${totalRevenue.toFixed(2)}</span>
                        {debugFilterStrict && <span className="ml-2 text-yellow-500 font-medium">(strict filter)</span>}
                      </div>
                      <div className="flex flex-wrap gap-1 mb-2">
                        {dailySales.map(d => (
                          <button
                            key={d.day}
                            onClick={() => {
                              setDebugDay(d.day);
                              setDebugRows(dedupeDebugRows(chartRowsByDayRef.current.get(d.day) || []));
                            }}
                            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                              d.day === debugDay ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent text-muted-foreground"
                            }`}
                          >
                            {d.label} ({d.units})
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground">{filteredRows.length} rows shown</span>
                          <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
                            <input
                              type="checkbox"
                              checked={debugFilterStrict}
                              onChange={(e) => setDebugFilterStrict(e.target.checked)}
                              className="w-3 h-3"
                            />
                            Strict filter (Shipped + authoritative only)
                          </label>
                        </div>
                        <button
                          className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-accent text-muted-foreground"
                          onClick={() => {
                            const lines = filteredRows.map((r: any) => {
                              const mp = String(r.marketplace || "US").trim();
                              const currency = MARKETPLACE_CURRENCY[mp] || "USD";
                              const rate = currency === "USD" ? 1 : (fxRates[currency] || 0);
                              const soldUsd = Number(r.sold_price || 0);
                              const nativeSale = currency === "USD" ? "" : (rate > 0 ? `${currency} ${(soldUsd * rate).toFixed(2)} @ ${rate.toFixed(4)}` : "");
                              const feesUsd = Number(r.total_fees || 0);
                              const nativeFees = currency === "USD" ? "" : (rate > 0 ? `${currency} ${(feesUsd * rate).toFixed(2)}` : "");
                              return [r.order_id, r.asin, r.seller_sku || "", r.title || "", mp, r.quantity, soldUsd.toFixed(2), nativeSale, feesUsd.toFixed(2), nativeFees, (r as any).price_source || "", r.order_status || "", r.order_type || ""].join("\t");
                            });
                            navigator.clipboard.writeText("Order ID\tASIN\tSKU\tTitle\tMP\tQty\tSold $\tNative Sale\tFees $\tNative Fees\tSource\tStatus\tType\n" + lines.join("\n"));
                          }}
                        >
                          📋 Copy All
                        </button>
                      </div>
                      <div className="flex-1 min-h-0 max-h-[calc(90vh-220px)] overflow-auto rounded-md border border-border">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 bg-card z-10">
                            <tr className="border-b border-border">
                              <th className="text-left p-1 font-semibold">Order ID</th>
                              <th className="text-left p-1 font-semibold">ASIN</th>
                              <th className="text-left p-1 font-semibold">SKU</th>
                              <th className="text-left p-1 font-semibold">Title</th>
                              <th className="text-left p-1 font-semibold">MP</th>
                              <th className="text-right p-1 font-semibold">Qty</th>
                              <th className="text-right p-1 font-semibold" title="USD-converted sale price · native amount + FX rate shown beneath for non-US marketplaces">Sold $ (native)</th>
                              <th className="text-right p-1 font-semibold" title="USD-converted total fees · native amount shown beneath for non-US marketplaces">Fees $ (native)</th>
                              <th className="text-left p-1 font-semibold">Source</th>
                              <th className="text-left p-1 font-semibold">Status</th>
                              <th className="text-left p-1 font-semibold">Type</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredRows.map((r: any, i: number) => {
                              const asinVal = String(r.asin || "");
                              const looksLikeAsin = /^B[0-9A-Z]{9}$/.test(asinVal) || /^\d{10,13}$/.test(asinVal);
                              const mp = String(r.marketplace || "US").trim();
                              const currency = MARKETPLACE_CURRENCY[mp] || "USD";
                              const fxRate = currency === "USD" ? 1 : (fxRates[currency] || 0);
                              const soldUsd = Number(r.sold_price || 0);
                              const feesUsd = Number(r.total_fees || 0);
                              const isNonUsdWithFx = currency !== "USD" && fxRate > 0;
                              const nativeSaleAmount = isNonUsdWithFx ? soldUsd * fxRate : 0;
                              const nativeFeesAmount = isNonUsdWithFx ? feesUsd * fxRate : 0;
                              return (
                                <tr key={i} className={`border-b border-border/50 ${!looksLikeAsin ? "bg-yellow-500/10" : ""}`}>
                                  <td className="p-1 font-mono truncate max-w-[130px]" title={r.order_id}>{String(r.order_id || "").slice(-12)}</td>
                                  <td className="p-1 font-mono truncate max-w-[100px]" title={asinVal}>
                                    {asinVal}
                                    {!looksLikeAsin && <span className="ml-1 text-yellow-500" title="Looks like SKU, not ASIN">⚠️</span>}
                                  </td>
                                  <td className="p-1 font-mono truncate max-w-[100px]" title={r.seller_sku || ""}>{r.seller_sku || "—"}</td>
                                  <td className="p-1 truncate max-w-[150px]" title={r.title || ""}>{r.title || "—"}</td>
                                  <td className="p-1">
                                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                                      {MARKETPLACE_FLAGS[mp] || "🏳️"} {mp}
                                    </span>
                                  </td>
                                  <td className="p-1 text-right tabular-nums">{r.quantity}</td>
                                  <td className="p-1 text-right tabular-nums">
                                    <div>${soldUsd.toFixed(2)}</div>
                                    {isNonUsdWithFx ? (
                                      <div
                                        className="text-[10px] text-muted-foreground/80"
                                        title={`Native marketplace amount · FX rate USD→${currency} = ${fxRate.toFixed(4)} (live fx_rates)`}
                                      >
                                        {currency} {nativeSaleAmount.toFixed(2)} <span className="opacity-70">@ {fxRate.toFixed(4)}</span>
                                      </div>
                                    ) : currency !== "USD" ? (
                                      <div className="text-[10px] text-amber-500" title="No FX rate available in fx_rates table for this marketplace currency">
                                        {currency} — (no fx)
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className="p-1 text-right tabular-nums">
                                    <div className={feesUsd > 0 ? "" : "text-muted-foreground"}>
                                      {feesUsd > 0 ? `−$${feesUsd.toFixed(2)}` : "—"}
                                    </div>
                                    {feesUsd > 0 && isNonUsdWithFx ? (
                                      <div
                                        className="text-[10px] text-muted-foreground/80"
                                        title={`Native marketplace fee equivalent at FX rate USD→${currency} = ${fxRate.toFixed(4)}`}
                                      >
                                        {currency} {nativeFeesAmount.toFixed(2)}
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className="p-1">{(r as any).price_source || "—"}</td>
                                  <td className="p-1">{r.order_status || <span className="text-yellow-500">—</span>}</td>
                                  <td className="p-1">{r.order_type || "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>

                      </div>
                    </>
                  );
                })()}
              </DialogContent>
            </Dialog>

            {/* Selling Today */}
            <div className="rounded-xl border border-border bg-card">
              <div className="px-4 py-3 border-b border-border flex items-baseline justify-between">
                <h2 className="text-lg font-bold text-foreground">🛒 {timeRange === "today" ? "Selling Today" : timeRange === "yesterday" ? "Sold Yesterday" : timeRange === "week" ? "Selling This Week" : timeRange === "last_month" ? `Sold ${periodLabel}` : timeRange === "year" ? "Sold This Year" : "Sold This Month"}</h2>
                <span className="text-[10px] text-muted-foreground/70">
                  Business date: {getLocalDateStr()} · Now in PT: {new Date().toLocaleString("en-US", { timeZone: LIVE_SALES_TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
                </span>
              </div>
              {rows.length === 0 && !loading ? (
                <div className="text-center text-muted-foreground text-sm py-10">No sales yet today</div>
              ) : loading && rows.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  <div className="px-4 py-2 border-b border-border flex items-center justify-between gap-2 text-[11px] flex-wrap">
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px] gap-1"
                        onClick={async () => {
                          const sorted = sortKey === "none" ? rows : [...rows].sort((a, b) => {
                            const av = sortKey === "units" ? a.units : a.revenue;
                            const bv = sortKey === "units" ? b.units : b.revenue;
                            return sortDir === "asc" ? av - bv : bv - av;
                          });
                          const asins = Array.from(new Set(sorted.map(r => String(r.asin || "").trim()).filter(a => a && a !== "PENDING")));
                          if (asins.length === 0) {
                            toast({ title: "No ASINs to copy" });
                            return;
                          }
                          try {
                            await navigator.clipboard.writeText(asins.join(", "));
                            toast({ title: `Copied ${asins.length} ASIN${asins.length === 1 ? "" : "s"}`, description: "Paste into Need to Buy Again search to filter today's sales." });
                          } catch {
                            toast({ title: "Copy failed", variant: "destructive" });
                          }
                        }}
                      >
                        <Copy className="h-3 w-3" /> Copy ASINs
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px] gap-1"
                        onClick={async () => {
                          const asins = Array.from(new Set(rows.map(r => String(r.asin || "").trim()).filter(a => a && a !== "PENDING")));
                          if (asins.length === 0) {
                            toast({ title: "No ASINs to send" });
                            return;
                          }
                          try {
                            await navigator.clipboard.writeText(asins.join(", "));
                          } catch {}
                          toast({ title: `Sent ${asins.length} ASINs`, description: "Opening Need to Buy Again — paste into search." });
                          navigate("/tools/need-buy-again");
                        }}
                      >
                        <ShoppingCart className="h-3 w-3" /> Check in Need to Buy Again
                      </Button>
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search ASIN or title…"
                          className="h-7 pl-7 pr-2 text-[11px] rounded border border-border bg-background w-56 focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                      {searchQuery.trim() && (() => {
                        const q = searchQuery.trim().toLowerCase();
                        const count = rows.filter(r =>
                          String(r.asin || "").toLowerCase().includes(q) ||
                          String(r.title || "").toLowerCase().includes(q)
                        ).length;
                        return (
                          <span className={`px-2 py-1 rounded text-[11px] font-semibold border ${count > 0 ? "bg-sky-400/20 text-sky-600 border-sky-400/40" : "bg-muted text-muted-foreground border-border"}`}>
                            {count} match{count === 1 ? "" : "es"}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Sort:</span>
                      <button
                        onClick={() => toggleSort("units")}
                        className={`px-2 py-1 rounded border ${sortKey === "units" ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
                      >
                        Units {sortIndicator("units")}
                      </button>
                      <button
                        onClick={() => toggleSort("revenue")}
                        className={`px-2 py-1 rounded border ${sortKey === "revenue" ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
                      >
                        Revenue {sortIndicator("revenue")}
                      </button>
                    </div>
                  </div>
                  <div className="divide-y divide-border">
                    {(sortKey === "none" ? rows : [...rows].sort((a, b) => {
                      const av = sortKey === "units" ? a.units : a.revenue;
                      const bv = sortKey === "units" ? b.units : b.revenue;
                      return sortDir === "asc" ? av - bv : bv - av;
                    })).map((row, i) => {
                      const q = searchQuery.trim().toLowerCase();
                      const isMatch = q.length > 0 && (
                        String(row.asin || "").toLowerCase().includes(q) ||
                        String(row.title || "").toLowerCase().includes(q)
                      );
                      return (
                    <div key={row.asin + i} className={`flex items-center gap-4 px-4 py-3 transition-colors ${isMatch ? "bg-sky-400/30 hover:bg-sky-400/40 ring-1 ring-sky-400/60" : "hover:bg-muted/30"}`}>
                      {/* Image */}
                      <div className="w-12 h-12 rounded-lg border border-border bg-muted/30 flex-shrink-0 overflow-hidden">
                        {row.image_url ? (
                          <img src={row.image_url} alt={row.title || row.asin} className="w-full h-full object-contain" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">N/A</div>
                        )}
                      </div>
                      {/* Title + ASIN + Marketplaces */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{row.title || "Unknown Product"}</p>
                        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                          {(() => {
                            const domainMap: Record<string, string> = { US: "com", CA: "ca", MX: "com.mx", BR: "com.br", UK: "co.uk", DE: "de", FR: "fr", IT: "it", ES: "es", JP: "co.jp", AU: "com.au" };
                            const primaryMp = (row.marketplaces || [])[0] || "US";
                            const tld = domainMap[primaryMp] || "com";
                            return (
                              <a
                                href={`https://www.amazon.${tld}/dp/${row.asin}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs text-muted-foreground hover:text-primary hover:underline transition-colors"
                                title={`Open ${row.asin} on Amazon`}
                              >
                                {row.asin}
                              </a>
                            );
                          })()}
                          {(row.marketplaces || []).map((mp) => {
                            const flag = mp === "US" ? "🇺🇸" : mp === "CA" ? "🇨🇦" : mp === "MX" ? "🇲🇽" : mp === "BR" ? "🇧🇷" : mp === "UK" ? "🇬🇧" : mp === "DE" ? "🇩🇪" : mp === "FR" ? "🇫🇷" : mp === "IT" ? "🇮🇹" : mp === "ES" ? "🇪🇸" : mp === "JP" ? "🇯🇵" : mp === "AU" ? "🇦🇺" : "🏳️";
                            return (
                              <span key={mp} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                                <span>{flag}</span><span>{mp}</span>
                              </span>
                            );
                          })}
                        </div>
                        {row.latestPurchaseTimePt && (
                          <p className="text-[10px] text-muted-foreground/80">Time: {row.latestPurchaseTimePt} PT</p>
                        )}
                      </div>

                      {/* Units */}
                      <div className="text-center flex-shrink-0 w-16">
                        <p className="text-sm font-bold text-foreground tabular-nums">{row.units}</p>
                        <p className="text-[10px] uppercase text-muted-foreground">{(row.pendingUnits || 0) > 0 ? 'pending' : 'units'}</p>
                      </div>
                      {/* Revenue */}
                      <div className="text-right flex-shrink-0 w-24">
                        {(() => {
                          const isPending = (row.pendingUnits || 0) > 0 && row.revenue <= 0;
                          const estUsd = Number(row.pendingRevenue || 0);
                          if (isPending && estUsd > 0) {
                            return (
                              <>
                                <p className="text-sm font-bold tabular-nums text-amber-500">
                                  ~{homeCurrencySymbol}{(estUsd * homeRate).toFixed(2)}
                                </p>
                                <p className="text-[10px] uppercase text-muted-foreground">pending est.</p>
                              </>
                            );
                          }
                          if (isPending) {
                            return (
                              <>
                                <p className="text-sm font-bold tabular-nums text-amber-500">Pending</p>
                                <p className="text-[10px] uppercase text-muted-foreground">awaiting price</p>
                              </>
                            );
                          }
                          return (
                            <>
                              <p className="text-sm font-bold tabular-nums text-emerald-600">
                                {homeCurrencySymbol}{(row.revenue * homeRate).toFixed(2)}
                              </p>
                              <p className="text-[10px] uppercase text-muted-foreground">revenue</p>
                            </>
                          );
                        })()}
                      </div>
                      {/* Fees */}
                      {(() => {
                        const fc = feesCostByAsin[row.asin] || { fees: 0, cost: 0 } as { fees: number; cost: number; feesMissing?: boolean; missingMarkets?: string[] };
                        const feesMissing = !!fc.feesMissing;
                        const profit = feesMissing ? null : row.revenue - fc.fees - fc.cost;
                        const roi = feesMissing ? null : (fc.cost > 0 && profit !== null ? (profit / fc.cost) * 100 : null);
                        const missingLabel = (fc.missingMarkets || []).join("/");
                        return (
                          <>
                            <div className="text-right flex-shrink-0 w-24">
                              {feesMissing ? (
                                <p className="text-sm font-bold tabular-nums text-amber-500" title={`Missing ${missingLabel} fee cache — fees not estimated. Profit/ROI hidden until cache populates.`}>
                                  ⚠ {missingLabel}
                                </p>
                              ) : (
                                <p className={`text-sm font-bold tabular-nums ${fc.fees > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                                  {fc.fees > 0 ? '−' : ''}{homeCurrencySymbol}{(fc.fees * homeRate).toFixed(2)}
                                </p>
                              )}
                              <p className="text-[10px] uppercase text-muted-foreground">{feesMissing ? 'fee cache' : 'fees'}</p>
                            </div>
                            <div className="text-right flex-shrink-0 w-24">
                              <p className={`text-sm font-bold tabular-nums ${fc.cost > 0 ? 'text-blue-400' : 'text-muted-foreground'}`}>
                                {fc.cost > 0 ? '−' : ''}{homeCurrencySymbol}{(fc.cost * homeRate).toFixed(2)}
                              </p>
                              <p className="text-[10px] uppercase text-muted-foreground">cogs</p>
                            </div>
                            <div className="text-right flex-shrink-0 w-24">
                              {profit === null ? (
                                <p className="text-sm font-bold tabular-nums text-muted-foreground" title="Hidden: missing non-US fee cache">—</p>
                              ) : (
                                <p className={`text-sm font-bold tabular-nums ${profit >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                                  {profit < 0 ? '−' : ''}{homeCurrencySymbol}{Math.abs(profit * homeRate).toFixed(2)}
                                </p>
                              )}
                              <p className="text-[10px] uppercase text-muted-foreground">profit</p>
                            </div>
                            <div className="text-right flex-shrink-0 w-20">
                              <p className={`text-sm font-bold tabular-nums ${roi !== null && roi >= 0 ? 'text-emerald-500' : roi !== null ? 'text-destructive' : 'text-muted-foreground'}`}>
                                {roi !== null ? `${roi.toFixed(1)}%` : '—'}
                              </p>
                              <p className="text-[10px] uppercase text-muted-foreground">{roi !== null ? 'roi' : (feesMissing ? 'no cache' : 'no cost')}</p>
                            </div>
                          </>
                        );
                      })()}
                      {(row.hasFbmOrder || ((row.stockFbm ?? 0) > 0 && row.hasUnknownChannelOrder)) && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setFbmLabelAsin(row.asin); }}
                          title="FBM shipping label cost (sync from Amazon Buy Shipping or enter manually)"
                          className="flex-shrink-0 h-8 px-2.5 rounded-md border border-primary/40 bg-primary/10 hover:bg-primary/20 flex items-center gap-1.5 text-primary text-[11px] font-semibold transition-colors"
                          aria-label="FBM shipping label cost"
                        >
                          <Truck className="h-3.5 w-3.5" />
                          FBM Label
                        </button>
                      )}
                      {isSalesReport && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const mp = (row.marketplaces || [])[0] || "US";
                            setBbHistoryTarget({ asin: row.asin, marketplace: mp, ts: row.latestPurchaseTimestampUtc ?? null });
                          }}
                          title="Closest BB at Order Discovery. Amazon reveals orders 60–120 min after purchase; this is the nearest observable Buy Box. When qualified (Pedu-owned, fulfillment match, within ±2h, price > 0), it is promoted into the pending estimate as 'Estimated from Closest BB' and is replaced automatically once the real Amazon/FEC price arrives."
                          className="flex-shrink-0 h-8 px-2.5 rounded-md border border-border bg-muted/40 hover:bg-muted flex items-center gap-1.5 text-foreground text-[11px] font-semibold transition-colors"
                          aria-label="Closest Buy Box at order discovery"
                        >
                           <History className="h-3.5 w-3.5" />
                           BB @ discovery
                        </button>
                      )}
                    </div>
                    );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {currentPeriod && (
        <div className="max-w-7xl mx-auto px-3 sm:px-6 pb-8 space-y-4">
          <CustomerInsightsCard
            startDate={new Date(currentPeriod.rangeStart + "T00:00:00").toISOString()}
            endDate={new Date(currentPeriod.rangeEnd + "T23:59:59").toISOString()}
          />
          <RefundsSection
            rangeStart={currentPeriod.rangeStart}
            rangeEnd={currentPeriod.rangeEnd}
            label={currentPeriod.label}
          />
          <CancelledOrdersSection
            rangeStart={currentPeriod.rangeStart}
            rangeEnd={currentPeriod.rangeEnd}
            label={currentPeriod.label}
          />
          <PromotionsDeductedSection
            rangeStart={currentPeriod.rangeStart}
            rangeEnd={currentPeriod.rangeEnd}
            label={currentPeriod.label}
            marketplace={selectedMarketplace}
            currencySymbol={homeCurrencySymbol}
            homeRate={homeRate}
          />
          <ReplacementCogsSection
            rangeStart={currentPeriod.rangeStart}
            rangeEnd={currentPeriod.rangeEnd}
            label={currentPeriod.label}
            marketplace={selectedMarketplace}
            currencySymbol={homeCurrencySymbol}
            homeRate={homeRate}
          />
          <FeeBreakdownSections
            rangeStart={currentPeriod.rangeStart}
            rangeEnd={currentPeriod.rangeEnd}
            label={currentPeriod.label}
          />
        </div>
      )}
      {fbmLabelAsin && currentPeriod && (
        <FbmLabelCostDialog
          open={!!fbmLabelAsin}
          onOpenChange={(v) => { if (!v) setFbmLabelAsin(null); }}
          asin={fbmLabelAsin}
          rangeStart={currentPeriod.rangeStart}
          rangeEnd={currentPeriod.rangeEnd}
        />
      )}
      {bbHistoryTarget && user && (
        <BbHistoryDialog
          open={!!bbHistoryTarget}
          onOpenChange={(v) => { if (!v) setBbHistoryTarget(null); }}
          userId={user.id}
          asin={bbHistoryTarget.asin}
          marketplace={bbHistoryTarget.marketplace}
          referenceTimestampUtc={bbHistoryTarget.ts}
        />
      )}
    </div>
  );
};

export default LiveSales;

