import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getInventoryCache, setInventoryCache } from "@/hooks/use-inventory-cache";
import { useAuth } from "@/contexts/AuthContext";
import { triggerAutoOnboard } from "@/lib/autoOnboard";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Helmet } from "react-helmet-async";
import { Calculator, Package, TrendingUp, RefreshCw, Truck, FolderOpen, Trash2, Cloud, Copy, Check, DollarSign, Boxes, FileSpreadsheet, AlertTriangle, Loader2, Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import * as XLSX from "xlsx";
const ActualRoiCalculatorDialog = lazy(() => import("@/components/inventory/ScannerStyleRoiDialog").then(m => ({ default: m.ScannerStyleRoiDialog })));
const ReplenishmentShipmentBuilder = lazy(() => import("@/components/inventory/ReplenishmentShipmentBuilder").then(m => ({ default: m.ReplenishmentShipmentBuilder })));
import { BsrPopover } from "@/components/inventory/BsrPopover";
const MissingValuationDialog = lazy(() => import("@/components/inventory/MissingValuationDialog").then(m => ({ default: m.MissingValuationDialog })));
import { CostSourceBadge } from "@/components/inventory/CostSourceBadge";
import { ApplyToPurchaseButton } from "@/components/inventory/ApplyToPurchaseButton";
import { CreatePurchaseFromCostButton } from "@/components/inventory/CreatePurchaseFromCostButton";

import { useAsinPurchaseRecords } from "@/hooks/use-asin-purchase-records";
import { calculateReplenishQty } from "@/lib/replenishment";
import { usePageFavicon } from "@/hooks/use-page-favicon";
import { useSubscription } from "@/hooks/use-subscription";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShipmentDraft } from "@/types/shipment";
import { SyncReadinessBanner } from "@/components/SyncReadinessBanner";
import { CostOnboardingBanner } from "@/components/inventory/CostOnboardingBanner";
import AutoInventorySyncDebugPanel from "@/components/admin/AutoInventorySyncDebugPanel";
import { cn } from "@/lib/utils";
import {
  getInventoryUnitCost,
  getInventoryTotalValue,
  getListingUnitCost,
  getListingTotalCost,
} from "@/lib/cost-contract";

interface InventoryItem {
  id: string;
  asin: string;
  sku: string;
  fnsku: string | null;
  title: string;
  image_url: string | null;
  price: number | null;
  cost: number | null;
  amount: number | null;
  units: number | null;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  unfulfilled: number | null;
  supplier_links: Array<{ link: string; discount_code: string }>;
  created_at: string;
  updated_at: string;
  unit_cost: number | null;
  fees_json: any;
  sales_30d?: number;
  sales_period_days?: number;
  listing_created_at?: string | null;
  last_inventory_sync_at?: string | null;
  last_summaries_at?: string | null;
  historical_sales?: number;
  historical_days?: number;
  purchase_count?: number; // Number of SKUs/listings for this ASIN
  all_skus?: string[]; // All SKUs for this ASIN
  bsr?: number | null; // Best Seller Rank
  last_bsr_sync_at?: string | null;
  listing_status?: string | null; // ACTIVE, INACTIVE, INCOMPLETE, NOT_FOUND, unknown
  source?: string | null; // amazon_sync (FBA), amazon_sync_fbm (FBM)
  // Phase 7 — Operational Cost Override Layer
  unit_cost_manual?: boolean | null;
  manual_cost_updated_at?: string | null;
  manual_cost_source?: string | null;
  manual_cost_reason?: string | null;
}

const MARKETPLACE_ID_TO_CODE: Record<string, 'US' | 'CA' | 'MX' | 'BR'> = {
  ATVPDKIKX0DER: 'US',
  A2EUQ1WTGCTBG2: 'CA',
  A1AM78C64UM0Y8: 'MX',
  A2Q3Y263D00KWC: 'BR',
};

/**
 * Parse a listing date that may be a bare DATE rather than a timestamp.
 *
 * `listing_created_at` is fed from `created_listings.date_created`, which is a
 * Postgres DATE and arrives as "2026-08-23" with no time and no zone. Passing
 * that to `new Date()` does NOT give local midnight: ECMAScript specifies that
 * date-only ISO forms are parsed as UTC, while date-TIME forms without a zone
 * are parsed as local. So the bare form lands on UTC midnight, and every
 * viewer west of UTC renders the PREVIOUS day.
 *
 *   new Date("2026-08-23").toLocaleDateString()  // "Aug 22" in Pacific
 *
 * Reported 2026-08-28: a listing created on the 23rd displayed as "Aug 22, 26".
 * It affected every created-listing row, silently, for anyone not on UTC or
 * east of it.
 *
 * Appending "T00:00:00" opts into the local-time branch of the same spec, which
 * is what a calendar date from Amazon actually means. Timestamps that already
 * carry a zone are passed through untouched.
 */
function parseListingDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getPhysicalWarehouseUnits(item: Pick<InventoryItem, 'available' | 'reserved' | 'inbound' | 'unfulfilled'>) {
  return (item.available ?? 0) + (item.reserved ?? 0) + (item.inbound ?? 0) + (item.unfulfilled ?? 0);
}

/**
 * Inventory unit-cost reader (Contract A).
 *
 * Manual override (`unit_cost` / `unit_cost_manual`) wins. Otherwise we go
 * through the shared helper so the row is interpreted consistently with the
 * cost contract: inventory.cost = UNIT, inventory.amount = TOTAL value.
 */
function resolveInventoryUnitCost(item: Pick<InventoryItem, 'unit_cost' | 'cost' | 'amount' | 'units'>) {
  if (item.unit_cost !== null && item.unit_cost !== undefined) {
    return Number(item.unit_cost);
  }
  return getInventoryUnitCost({
    cost: item.cost,
    amount: item.amount,
    units: item.units,
  }) ?? 0;
}

/**
 * Resolve cost components from a created_listings row under Contract A.
 *
 * Delegates to the shared cost-contract helpers
 * (`getListingUnitCost` / `getListingTotalCost`).
 *
 *   created_listings.cost   = TOTAL batch cost
 *   created_listings.amount = UNIT cost
 *   created_listings.units  = purchase quantity
 *
 * In inventory the meaning is INVERTED: inventory.cost is per-unit and
 * inventory.amount is the total inventory value.
 */
function resolveCreatedListingCosts(row: { cost?: number | null; amount?: number | null; units?: number | null }) {
  const units = row.units !== null && row.units !== undefined ? Number(row.units) : null;
  const unitCost = getListingUnitCost({ cost: row.cost, amount: row.amount, units: row.units });
  const totalCost = getListingTotalCost({ cost: row.cost, amount: row.amount, units: row.units });
  return { totalCost, unitCost, units };
}

// Slow Selling Detection Algorithm
// Returns attention score (0-100) and flags for why an item needs attention
// Uses ONLY "available" stock (not inbound/reserved) for attention scoring
type SlowSellingResult = {
  availableStock: number;  // Only available stock (not inbound/reserved)
  ads30: number;
  daysOfCover: number | null;
  zeroSalesInStock: boolean;     // Rule A: Has available stock but zero sales
  lowVelocityOverstock: boolean; // Rule B: ADS < 0.1 and DaysOfCover > 120
  decliningVelocity: boolean;    // Rule C: Current velocity < 60% of previous period
  veryHighCover: boolean;        // Rule D: DaysOfCover > 180
  attentionScore: number;
  flags: string[];
};

// Amazon fee estimator: reads cached fees_json when available (either the legacy
// dollar-amount shape — referralFee/fbaFee/variableClosingFee — or the rate-based
// shape — referral_rate/fba_fee_fixed), same formats the repricer's own
// calculateRoiFromPrice reads. When no fee cache exists yet (fees_json null),
// falls back to a flat 15% referral-only estimate — the same fallback the
// repricer uses — so ROI is always computable from price + cost alone and
// never gated behind waiting for a fee-cache backfill or a live API call.
function estimateAmazonFees(feesJson: any, price: number): number {
  if (!feesJson) return price * 0.15;
  const otherFees = Number(
    feesJson.otherFees ?? feesJson.other_fees ?? feesJson.fixedClosingFee ??
    feesJson.fixed_closing_fee ?? feesJson.closingFee ?? feesJson.FixedClosingFee ?? 0
  );
  if (feesJson.referralFee !== undefined || feesJson.fbaFee !== undefined) {
    const referralFee = Number(feesJson.referralFee || 0);
    const fbaFee = Number(feesJson.fbaFee || 0);
    const variableClosingFee = Number(feesJson.variableClosingFee || 0);
    const feesAtPrice = feesJson.price ? Number(feesJson.price) : 0;
    if (feesAtPrice > 0 && Math.abs(feesAtPrice - price) > 0.01) {
      const referralRate = referralFee / feesAtPrice;
      return (price * referralRate) + fbaFee + variableClosingFee + otherFees;
    }
    return referralFee + fbaFee + variableClosingFee + otherFees;
  }
  if (feesJson.referral_rate !== undefined || feesJson.fba_fee_fixed !== undefined) {
    const referralRate = Number(feesJson.referral_rate ?? 0.15);
    const fbaFeeFixed = Number(feesJson.fba_fee_fixed ?? 0);
    const variableClosingFee = Number(feesJson.variable_closing_fee ?? feesJson.variableClosingFee ?? 0);
    return (price * referralRate) + fbaFeeFixed + variableClosingFee + otherFees;
  }
  return price * 0.15;
}

function estimateRoi(price: number | null | undefined, unitCost: number | null | undefined, feesJson: any): number | null {
  if (!price || !unitCost || unitCost <= 0) return null;
  const totalFees = estimateAmazonFees(feesJson, price);
  return ((price - totalFees - unitCost) / unitCost) * 100;
}

function calculateSlowSellingMetrics(item: {
  available?: number | null;
  inbound?: number | null;
  reserved?: number | null;
  sales_30d?: number | null;
  sales_period_days?: number | null;
  historical_sales?: number | null;
  historical_days?: number | null;
}, salesPeriodDays: number): SlowSellingResult {
  // Use ONLY available stock for slow-selling detection
  // Inbound/reserved items are either on the way or already allocated
  const availableStock = item.available ?? 0;
  
  // Calculate ADS for 30-day period
  const sales30d = item.sales_30d ?? 0;
  const periodDays = item.sales_period_days ?? salesPeriodDays;
  let ads30 = 0;
  
  if (sales30d > 0 && periodDays > 0) {
    ads30 = sales30d / periodDays;
  } else if (item.historical_sales && item.historical_days && item.historical_days > 0) {
    // Fallback to historical for arbitrage products
    ads30 = item.historical_sales / item.historical_days;
  }
  
  // Calculate Days of Cover based on available stock only
  const daysOfCover = availableStock > 0 && ads30 > 0 
    ? Math.round(availableStock / Math.max(ads30, 0.01))
    : availableStock > 0 ? Infinity : null;
  
  // Rule A: Zero sales but has available stock
  const zeroSalesInStock = availableStock > 0 && sales30d === 0;
  
  // Rule B: Low velocity overstock (ADS < 0.1 and DaysOfCover > 120)
  const lowVelocityOverstock = ads30 < 0.1 && (daysOfCover ?? 0) > 120 && availableStock > 0;
  
  // Rule C: Declining velocity - would need 60d sales data (not always available)
  // For now, this is disabled since we don't reliably have sales_60d
  const decliningVelocity = false;
  
  // Rule D: Very high cover (> 180 days)
  const veryHighCover = availableStock > 0 && (daysOfCover ?? 0) > 180;
  
  // Calculate attention score
  let score = 0;
  const flags: string[] = [];
  
  if (zeroSalesInStock) {
    score += 50;
    flags.push("Zero sales in past period with available stock");
  }
  if (lowVelocityOverstock) {
    score += 25;
    flags.push("Low velocity (ADS < 0.1) with > 120 days of cover");
  }
  if (decliningVelocity) {
    score += 15;
    flags.push("Sales velocity declining (< 60% of previous period)");
  }
  if (veryHighCover) {
    score += 10;
    flags.push("Very high stock cover (> 180 days)");
  }
  
  return {
    availableStock,
    ads30,
    daysOfCover: daysOfCover === Infinity ? null : daysOfCover,
    zeroSalesInStock,
    lowVelocityOverstock,
    decliningVelocity,
    veryHighCover,
    attentionScore: Math.min(score, 100),
    flags,
  };
}

// Small copy button component for ASIN cells
const CopyAsinButton = ({ asin }: { asin: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(asin);
      setCopied(true);
      toast({
        title: "Copied!",
        description: `${asin} copied to clipboard`,
        duration: 1500,
      });
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast({
        title: "Failed to copy",
        description: "Please try again",
        variant: "destructive",
      });
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`
        w-4 h-4 rounded-sm flex items-center justify-center
        transition-all duration-200 ease-out
        ${copied 
          ? 'bg-green-500 text-white scale-110' 
          : 'bg-primary/10 hover:bg-primary hover:text-primary-foreground hover:scale-110'
        }
        focus:outline-none focus:ring-2 focus:ring-primary/50
        cursor-pointer
      `}
      title="Copy ASIN"
    >
      {copied ? (
        <Check className="w-2.5 h-2.5" />
      ) : (
        <Copy className="w-2.5 h-2.5" />
      )}
    </button>
  );
};

// Fetches the repricer's per-ASIN fee cache (real fba_fee_fixed dollar amounts +
// referral_rate, populated by past repricer evaluations — not a live API call here)
// so Inventory Valuation's ROI can use the same real fee data the repricer already
// has, instead of falling back to a flat 15% guess for every ASIN. US-only since
// this page's inventory table is US-only. Paginated to avoid PostgREST's 1000-row cap.
const fetchFeeCacheMap = async (userId: string): Promise<Map<string, { fba_fee_fixed: number; referral_rate: number }>> => {
  const map = new Map<string, { fba_fee_fixed: number; referral_rate: number }>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("asin_fee_cache")
      .select("asin, fba_fee_fixed, referral_rate")
      .eq("user_id", userId)
      .eq("marketplace", "US")
      .range(from, from + pageSize - 1);
    if (error) {
      console.warn("[fetchFeeCacheMap] query failed:", error);
      break;
    }
    for (const row of data || []) {
      if (row.asin) map.set(row.asin, { fba_fee_fixed: Number(row.fba_fee_fixed) || 0, referral_rate: Number(row.referral_rate) || 0.15 });
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return map;
};

// Fetch function extracted for React Query
const fetchInventoryData = async (userId: string, salesPeriodDays: number): Promise<InventoryItem[]> => {
  console.log("Fetching synced inventory with keyset pagination...");

  const batchSize = 1000;
  let allItems: any[] = [];
  let hasMore = true;
  let batchIndex = 0;
  const seenIds = new Set<string>();

  // Keyset cursor (stable even while rows are being inserted during a sync)
  let lastCreatedAt: string | null = null;
  let lastId: string | null = null;

  while (hasMore) {
    console.log(`Fetching inventory batch ${batchIndex + 1} (limit ${batchSize})`);

    let query = supabase
      .from("inventory")
      .select("*")
      .eq("user_id", userId)
      // Stable ordering: created_at then id
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(batchSize);

    // Fetch the next page "after" the last row we saw
    if (lastCreatedAt && lastId) {
      // (created_at < lastCreatedAt) OR (created_at = lastCreatedAt AND id < lastId)
      query = query.or(
        `created_at.lt.${lastCreatedAt},and(created_at.eq.${lastCreatedAt},id.lt.${lastId})`
      );
    }

    const { data, error } = await query;

    if (error) {
      console.error("Fetch error:", error);
      throw error;
    }

    const batchLength = data?.length || 0;
    console.log(`Received batch ${batchIndex + 1} with ${batchLength} records`);

    if (batchLength === 0) {
      hasMore = false;
      break;
    }

    // Safety: de-dupe in case of any edge-case overlap
    const uniqueItems = (data || []).filter((item: any) => {
      if (seenIds.has(item.id)) {
        console.warn(`Duplicate ID found: ${item.id}, skipping`);
        return false;
      }
      seenIds.add(item.id);
      return true;
    });

    allItems = allItems.concat(uniqueItems);

    // Advance cursor using the LAST row in this page (because we're sorting desc)
    const lastRow = data![data!.length - 1];
    lastCreatedAt = lastRow.created_at;
    lastId = lastRow.id;

    if (batchLength < batchSize) {
      hasMore = false;
    } else {
      batchIndex += 1;
      if (batchIndex >= 50) {
        console.warn("Reached maximum batch limit (50). Stopping further fetches.");
        hasMore = false;
      }
    }
  }

  console.log("Total fetched inventory records:", allItems.length);

  // Build cost maps from Created Listings:
  // - Prefer matching by SKU (most accurate)
  // - Fallback to matching by ASIN when SKU isn't available
  const costMapBySku = new Map<
    string,
    {
      unitCost: number | null;
      totalCost: number | null;
      units: number | null;
      fees: any;
      image_url: string | null;
      price: number | null;
      date_created: string | null;
    }
  >();
  const costMapByAsin = new Map<
    string,
    {
      unitCost: number | null;
      totalCost: number | null;
      units: number | null;
      fees: any;
      image_url: string | null;
      price: number | null;
      date_created: string | null;
    }
  >();

  // Same override source P&L's resolve_unit_cost_v1 treats as top-priority
  // (after the sale-time snapshot, which doesn't apply to unsold stock).
  // Wiring it in here too means this page's Unit Cost column / Inventory
  // Valuation Block and P&L agree on one number per ASIN instead of drifting.
  const overridesByAsin = new Map<string, number>();

  try {
    // Paginate created_listings — Supabase defaults to 1000 rows max
    let clData: any[] = [];
    let clFrom = 0;
    const clBatchSize = 1000;
    let hasMoreCl = true;
    while (hasMoreCl) {
      const { data: batch, error: clError } = await supabase
        .from("created_listings")
        .select("asin, sku, cost, amount, units, image_url, price, created_at, date_created")
        .eq('user_id', userId)
        .order("created_at", { ascending: false })
        .range(clFrom, clFrom + clBatchSize - 1);
      if (clError) {
        console.error("Error fetching created listings for cost map:", clError);
        break;
      }
      if (batch) clData = clData.concat(batch);
      if ((batch?.length || 0) < clBatchSize) { hasMoreCl = false; } else { clFrom += clBatchSize; }
    }

    const { data: overrideRows } = await supabase
      .from("asin_cost_overrides")
      .select("asin, unit_cost, effective_from")
      .eq("user_id", userId)
      .order("effective_from", { ascending: true });
    if (overrideRows) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const thisYear = todayStr.slice(0, 4);
      for (const row of overrideRows as { asin: string; unit_cost: number; effective_from: string }[]) {
        if (!row.asin) continue;
        const eff = (row.effective_from || "").slice(0, 10);
        const cost = Number(row.unit_cost);
        // Same calendar year as today only — don't reach back into a prior
        // year's override when nothing exists yet this year.
        if (eff && eff <= todayStr && eff.slice(0, 4) === thisYear && cost > 0) overridesByAsin.set(row.asin, cost);
      }
    }

    if (clData.length > 0) {
      clData?.forEach((clItem: any) => {
        if (!clItem.asin) return;

        const { totalCost, unitCost, units } = resolveCreatedListingCosts(clItem);

        const entry = {
          unitCost,
          totalCost,
          units,
          fees: null,
          image_url: clItem.image_url || null,
          price: clItem.price !== null ? Number(clItem.price) : null,
          date_created: clItem.date_created || clItem.created_at || null,
        };

        // Most accurate: SKU match
        if (clItem.sku) {
          // Keep the most recent entry for the SKU
          if (!costMapBySku.has(clItem.sku)) {
            costMapBySku.set(clItem.sku, entry);
          }
        }

        // Fallback: ASIN match (only if we don't already have a usable unit-cost entry)
        const existingAsin = costMapByAsin.get(clItem.asin);
        if (!existingAsin || (existingAsin.units === null || existingAsin.units <= 0)) {
          costMapByAsin.set(clItem.asin, entry);
        }
      });
    }

    console.log(
      "Cost maps built from Created Listings:",
      "SKU:",
      costMapBySku.size,
      "ASIN:",
      costMapByAsin.size
    );
  } catch (e) {
    console.error("Unexpected error while building cost map from Created Listings:", e);
  }

  // Fetch sales data by ASIN based on selected period - with batching to handle large datasets
  const today = new Date();
  const periodStartDate = new Date();
  periodStartDate.setDate(periodStartDate.getDate() - salesPeriodDays);
  const periodStartStr = periodStartDate.toISOString().split('T')[0];
  
  // Track both units and earliest order date within the period for accurate ADS calculation
  const salesMap = new Map<string, { units: number; earliestOrderDate: string }>();
  const salesBatchSize = 1000;
  let salesFrom = 0;
  let hasMoreSales = true;
  
  while (hasMoreSales) {
    const { data: salesData, error: salesError } = await supabase
      .from('sales_orders')
      .select('asin, quantity, order_date')
      .eq('user_id', userId)
      .gte('order_date', periodStartStr)
      .range(salesFrom, salesFrom + salesBatchSize - 1);
    
    if (salesError) {
      console.error("Error fetching sales batch:", salesError);
      break;
    }
    
    const salesBatchLength = salesData?.length || 0;
    console.log(`Fetched sales batch: ${salesBatchLength} records (from ${salesFrom})`);
    
    salesData?.forEach((sale: any) => {
      if (sale.asin && sale.asin !== 'PENDING') {
        const existing = salesMap.get(sale.asin);
        if (existing) {
          existing.units += (sale.quantity || 1);
          if (sale.order_date < existing.earliestOrderDate) {
            existing.earliestOrderDate = sale.order_date;
          }
        } else {
          salesMap.set(sale.asin, {
            units: sale.quantity || 1,
            earliestOrderDate: sale.order_date
          });
        }
      }
    });
    
    if (salesBatchLength < salesBatchSize) {
      hasMoreSales = false;
    } else {
      salesFrom += salesBatchSize;
    }
  }
  
  // Helper to calculate days since a date
  const getDaysSince = (dateStr: string): number => {
    const date = new Date(dateStr);
    const diffMs = today.getTime() - date.getTime();
    return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  };
  
  console.log(`Fetched ${salesPeriodDays}-day sales for ${salesMap.size} ASINs (total orders processed)`);

  // Fetch ALL historical sales (no date filter) for historical velocity fallback
  const historicalSalesMap = new Map<string, { totalUnits: number; earliestDate: string }>();
  let histSalesFrom = 0;
  let hasMoreHistSales = true;
  
  while (hasMoreHistSales) {
    const { data: histSalesData, error: histSalesError } = await supabase
      .from('sales_orders')
      .select('asin, quantity, order_date')
      .eq('user_id', userId)
      .range(histSalesFrom, histSalesFrom + salesBatchSize - 1);
    
    if (histSalesError) {
      console.error("Error fetching historical sales batch:", histSalesError);
      break;
    }
    
    const histBatchLength = histSalesData?.length || 0;
    
    histSalesData?.forEach((sale: any) => {
      if (sale.asin && sale.asin !== 'PENDING') {
        const current = historicalSalesMap.get(sale.asin);
        if (current) {
          current.totalUnits += (sale.quantity || 1);
          if (sale.order_date < current.earliestDate) {
            current.earliestDate = sale.order_date;
          }
        } else {
          historicalSalesMap.set(sale.asin, {
            totalUnits: sale.quantity || 1,
            earliestDate: sale.order_date,
          });
        }
      }
    });
    
    if (histBatchLength < salesBatchSize) {
      hasMoreHistSales = false;
    } else {
      histSalesFrom += salesBatchSize;
    }
  }

  console.log(`Fetched historical sales for ${historicalSalesMap.size} ASINs`);

  // Build sets of SKUs and ASINs already in inventory
  const inventorySkus = new Set(allItems.map((item: any) => item.sku));
  const inventoryAsins = new Set(allItems.map((item: any) => item.asin));

  // Fetch created_listings to merge items not in synced inventory (paginated)
  let createdListings: any[] = [];
  {
    let clMergeFrom = 0;
    const clMergeBatch = 1000;
    let hasMoreClMerge = true;
    while (hasMoreClMerge) {
      const { data: batch, error: clError2 } = await supabase
        .from("created_listings")
        .select("*")
        .eq('user_id', userId)
        .range(clMergeFrom, clMergeFrom + clMergeBatch - 1);
      if (clError2) {
        console.error("Error fetching created_listings for merge:", clError2);
        break;
      }
      if (batch) createdListings = createdListings.concat(batch);
      if ((batch?.length || 0) < clMergeBatch) { hasMoreClMerge = false; } else { clMergeFrom += clMergeBatch; }
    }
  }

  // Build a map of ASIN -> title/image from sales_orders for fallback
  const productInfoMap = new Map<string, { title: string; image_url: string }>();
  
  // We already fetched historical sales, but need title/image - fetch separately
  let infoFrom = 0;
  let hasMoreInfo = true;
  const infoBatchSize = 1000;
  
  while (hasMoreInfo) {
    const { data: infoData, error: infoError } = await supabase
      .from('sales_orders')
      .select('asin, title, image_url')
      .eq('user_id', userId)
      .not('title', 'is', null)
      .range(infoFrom, infoFrom + infoBatchSize - 1);
    
    if (infoError) {
      console.error("Error fetching product info:", infoError);
      break;
    }
    
    const infoBatchLength = infoData?.length || 0;
    
    infoData?.forEach((sale: any) => {
      if (sale.asin && sale.title && !sale.title.startsWith('[REFUND]')) {
        // Only store if we don't have it yet, or if we have one without image
        const existing = productInfoMap.get(sale.asin);
        if (!existing || (!existing.image_url && sale.image_url)) {
          productInfoMap.set(sale.asin, {
            title: sale.title,
            image_url: sale.image_url || ''
          });
        }
      }
    });
    
    if (infoBatchLength < infoBatchSize) {
      hasMoreInfo = false;
    } else {
      infoFrom += infoBatchSize;
    }
  }
  
  console.log(`Built product info map with ${productInfoMap.size} ASINs`);

  // Only add created_listings items if:
  // 1. The SKU doesn't exist in inventory, AND
  // 2. The ASIN doesn't already exist in inventory (to avoid phantom SKUs)
  // 3. Deduplicate by ASIN: keep only the most recently updated entry per ASIN
  const filteredCreatedListings = (createdListings || []).filter((cl: any) => 
    !inventorySkus.has(cl.sku) && !inventoryAsins.has(cl.asin)
  );
  // Deduplicate created_listings by ASIN — keep only the most recently updated SKU per ASIN
  const latestByAsin = new Map<string, any>();
  for (const cl of filteredCreatedListings) {
    const existing = latestByAsin.get(cl.asin);
    if (!existing || new Date(cl.updated_at) > new Date(existing.updated_at)) {
      latestByAsin.set(cl.asin, cl);
    }
  }
  const createdListingsToAdd = Array.from(latestByAsin.values());
  console.log(`Adding ${createdListingsToAdd.length} items from created_listings not in synced inventory (deduped from ${filteredCreatedListings.length})`);

  // Convert created_listings to inventory format
  // Calculate unit_cost upfront for created_listings items
  // Use product info from sales_orders for missing titles/images
  const createdAsInventory = createdListingsToAdd.map((cl: any) => {
    const { totalCost, unitCost, units } = resolveCreatedListingCosts(cl);
    
    // Get title/image from sales_orders if missing or "Untitled Product"
    const productInfo = productInfoMap.get(cl.asin);
    const needsTitle = !cl.title || cl.title === 'Untitled Product';
    const needsImage = !cl.image_url;
    
    return {
      id: cl.id,
      asin: cl.asin,
      sku: cl.sku,
      fnsku: cl.fnsku || null,
      title: needsTitle && productInfo?.title ? productInfo.title : cl.title,
      image_url: needsImage && productInfo?.image_url ? productInfo.image_url : cl.image_url,
      price: cl.price ? Number(cl.price) : null,
      cost: unitCost, // Store unit cost, not total cost
      amount: totalCost, // Total cost goes to amount
      units: units,
      available: 0, // Not in FBA inventory
      reserved: 0,
      inbound: 0,
      unfulfilled: 0,
      supplier_links: cl.supplier_links || [],
      created_at: cl.created_at,
      updated_at: cl.updated_at,
      fees_json: null,
      listing_created_at: cl.date_created || cl.created_at,
      last_inventory_sync_at: null,
      source: 'created_listing', // Mark source for identification
      unit_cost_manual: false,
    };
  });

  // Combine synced inventory with created listings
  const combinedItems = [...allItems, ...createdAsInventory];

  const formattedData = combinedItems.map(item => {
    const costEntry = costMapBySku.get(item.sku) ?? costMapByAsin.get(item.asin);
    const override = overridesByAsin.get(item.asin);

    let finalUnitCost: number | null;
    if (override !== undefined) {
      finalUnitCost = override;
    } else if (item.unit_cost_manual && item.cost !== null && item.cost !== undefined) {
      // Manually edited → inventory.cost is already per-unit
      finalUnitCost = Number(item.cost);
    } else {
      // Primary: created_listings unit cost (cost/units) matched by SKU then ASIN
      // Fallback: inventory.cost (already per-unit after sync writes it)
      finalUnitCost = costEntry?.unitCost
        ?? (item.cost !== null && item.cost !== undefined ? Number(item.cost) : null);
    }

    // Get recent sales data with actual period tracking
    const recentSalesData = salesMap.get(item.asin);
    const salesUnits = recentSalesData?.units || 0;
    // Calculate actual days in the period based on when first sale occurred
    const actualSalesPeriod = recentSalesData 
      ? Math.min(salesPeriodDays, getDaysSince(recentSalesData.earliestOrderDate))
      : salesPeriodDays;

    const result: InventoryItem = {
      ...item,
      supplier_links: Array.isArray(item.supplier_links)
        ? (item.supplier_links as Array<{ link: string; discount_code: string }>)
        : [],
      amount: costEntry?.totalCost ?? item.amount ?? null,
      units: costEntry?.units ?? item.units ?? null,
      unit_cost: finalUnitCost,
      fees_json: item.fees_json ?? null,
      image_url: costEntry?.image_url || item.image_url || null,
      // Prefer the synced inventory price (fresh from Listings API) over the created listing's original price
      price: item.price ?? costEntry?.price ?? null,
      sales_30d: salesUnits,
      sales_period_days: actualSalesPeriod,
      historical_sales: historicalSalesMap.get(item.asin)?.totalUnits || 0,
      historical_days: historicalSalesMap.get(item.asin) 
        ? getDaysSince(historicalSalesMap.get(item.asin)!.earliestDate) 
        : undefined,
      // Use date_created from created_listings if synced inventory doesn't have it
      listing_created_at: item.listing_created_at || costEntry?.date_created || null,
    } as InventoryItem;

    return result;
  });

  // Group items by ASIN+SKU - only aggregate items with matching SKU
  // This prevents phantom/invalid SKUs from being counted as purchases
  const groupedByAsinSku = new Map<string, InventoryItem>();
  
  formattedData.forEach(item => {
    const key = `${item.asin}::${item.sku}`;
    const existing = groupedByAsinSku.get(key);
    
    if (existing) {
      // Same ASIN+SKU: aggregate quantities (rare but possible from multiple sources)
      existing.available = (existing.available ?? 0) + (item.available ?? 0);
      existing.reserved = (existing.reserved ?? 0) + (item.reserved ?? 0);
      existing.inbound = (existing.inbound ?? 0) + (item.inbound ?? 0);
      existing.unfulfilled = (existing.unfulfilled ?? 0) + (item.unfulfilled ?? 0);
      existing.units = (existing.units ?? 0) + (item.units ?? 0);
      existing.amount = (existing.amount ?? 0) + (item.amount ?? 0);
      existing.purchase_count = (existing.purchase_count ?? 1) + 1;
      
      // Keep the best data (prefer non-null values)
      if (!existing.title || existing.title === 'Untitled Product') {
        existing.title = item.title;
      }
      if (!existing.image_url && item.image_url) {
        existing.image_url = item.image_url;
      }
      if (existing.price === null && item.price !== null) {
        existing.price = item.price;
      }
      if (existing.unit_cost === null && item.unit_cost !== null) {
        existing.unit_cost = item.unit_cost;
      }
      if (!existing.fnsku && item.fnsku) {
        existing.fnsku = item.fnsku;
      }
      // Keep earliest created_at
      if (item.created_at < existing.created_at) {
        existing.created_at = item.created_at;
      }
    } else {
      groupedByAsinSku.set(key, {
        ...item,
        purchase_count: 1,
        all_skus: [item.sku],
      });
    }
  });

  return Array.from(groupedByAsinSku.values());
};

export default function SyncedInventory() {
  const { user } = useAuth();
  usePageFavicon("I");
  const { isAdmin } = useSubscription();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 768) ? 20 : 50);
  const [sortBy, setSortBy] = useState<'available' | 'roi' | 'replenish' | 'created' | 'sales' | 'bsr' | 'status' | 'valueStock' | 'daysOfCover' | 'attentionScore' | 'ads' | 'unitCost' | 'lastSynced' | 'unfulfilled' | null>('valueStock');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [stockFilter, setStockFilter] = useState<'all' | 'in-stock' | 'out-of-stock' | 'needs-replenish' | 'slow-selling' | 'preserved'>('all');
  const [showGhostsOnly, setShowGhostsOnly] = useState(false);
  const [fulfillmentFilter, setFulfillmentFilter] = useState<'all' | 'fba' | 'fbm'>('all');
  const [createdAgeFilter, setCreatedAgeFilter] = useState<'all' | 'recent' | '1m' | '2m' | '3m' | '4m' | '5m' | '6m' | '9m' | '12m' | '18m' | '24m'>('1m'); // Default applies only to slow-selling mode
  const [salesPeriodDays, setSalesPeriodDays] = useState(30);
  const [replenishCoverageMonths, setReplenishCoverageMonths] = useState(1); // 1, 2, or 3 months coverage
  const [roiDialogOpen, setRoiDialogOpen] = useState(false);
  const [selectedRoiItem, setSelectedRoiItem] = useState<InventoryItem | null>(null);
  const [fixingCosts, setFixingCosts] = useState(false);
  const [fixProgress, setFixProgress] = useState({ done: 0, total: 0 });
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [fetchingImages, setFetchingImages] = useState(false);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });

  // Inline unit cost editing
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [editingCostValue, setEditingCostValue] = useState<string>("");
  const [editingCostReason, setEditingCostReason] = useState<string>("");
  // Phase 7: filter to show only items with a manual cost override
  const [showOverriddenOnly, setShowOverriddenOnly] = useState<boolean>(false);
  
  // Inventory freshness is driven entirely by the automatic cron/queue
  // pipeline (full-inventory-refresh-2h -> inventory_refresh_queue ->
  // inventory-refresh-worker-1m) plus sync-inventory-report-4h. All manual
  // refresh buttons/handlers (Quick Sync, Manual SP-API Refresh,
  // AdminRefreshControl, FBM Sync, Recover Suspicious Zeros, Assign Missing,
  // Rescue MISMATCH, Clean Ghost Listings, Live Verify) were removed
  // 2026-07-31 — they were already hidden from the UI and unused; automation
  // is confirmed working without any manual/admin intervention.


  // Replenishment shipment builder state
  const [shipmentBuilderOpen, setShipmentBuilderOpen] = useState(false);
  const [selectedForShipment, setSelectedForShipment] = useState<Map<string, { item: InventoryItem; qtyToShip: number }>>(new Map());
  const [loadDraftDialogOpen, setLoadDraftDialogOpen] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<ShipmentDraft[]>([]);
  const [draftToLoad, setDraftToLoad] = useState<ShipmentDraft | null>(null);
  
  // Missing Valuation dialog state
  const [missingValuationOpen, setMissingValuationOpen] = useState(false);

  // Load saved drafts from localStorage
  const loadSavedDrafts = useCallback(() => {
    try {
      const stored = localStorage.getItem('replenishment-drafts');
      if (stored) {
        setSavedDrafts(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Error loading drafts:", e);
    }
  }, []);

  const deleteDraft = (draftId: string) => {
    const updated = savedDrafts.filter(d => d.id !== draftId);
    localStorage.setItem('replenishment-drafts', JSON.stringify(updated));
    setSavedDrafts(updated);
    toast({ title: "Draft deleted" });
  };

  const handleLoadDraft = (draft: ShipmentDraft) => {
    setDraftToLoad(draft);
    setLoadDraftDialogOpen(false);
    setShipmentBuilderOpen(true);
  };

  // Refresh Prices - fetch fresh listing prices from Amazon Listings API for selected rows
  // SKU-FIRST PRICING: Extract both ASIN and SKU from the selection keys
  // This now also updates pending sales_orders after refreshing inventory prices
  const handleRefreshPrices = async () => {
    const selectedKeys = Array.from(selectedForShipment.keys()).filter(Boolean);
    if (selectedKeys.length === 0) {
      toast({
        variant: "destructive",
        title: "Select at least 1 item",
        description: "Use the checkbox on the left, then click Refresh Selected Prices.",
      });
      return;
    }

    const MAX_REFRESH = 10;
    if (selectedKeys.length > MAX_REFRESH) {
      toast({
        variant: "destructive",
        title: `Too many selected (${selectedKeys.length})`,
        description: `Please refresh ${MAX_REFRESH} items or fewer at a time to avoid Amazon rate limits.`,
      });
      return;
    }

    // SKU-FIRST PRICING: Parse keys to extract ASINs (and optionally SKUs)
    // Keys are in format "asin::sku" or just "asin"
    const selectedAsins = selectedKeys.map(key => {
      const parts = key.split('::');
      return parts[0]; // Return the ASIN part
    }).filter(Boolean);
    
    // Deduplicate ASINs (in case same ASIN appears with different SKUs)
    const uniqueAsins = [...new Set(selectedAsins)];

    setRefreshingPrices(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ variant: "destructive", title: "Please log in first" });
        return;
      }

      // Step 1: Refresh inventory prices from Amazon
      const priceResponse = await supabase.functions.invoke("backfill-my-price-cache", {
        body: { asins: uniqueAsins },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (priceResponse.error) throw new Error(priceResponse.error.message);

      const priceResult = priceResponse.data;

      // Check for specific authorization error - preflight detected 403
      if (priceResult?.authorizationRequired) {
        toast({
          variant: "destructive",
          title: "Missing Product Listing Permission",
          description: "Your Amazon app doesn't have the Product Listing role enabled. Go to Seller Central → Developer Console → [Your App] → Roles → enable 'Product Listing', then reconnect your account on the Grant Us Access page.",
          duration: 15000,
        });
        setRefreshingPrices(false);
        return;
      }

      // Step 2: Update pending sales_orders with fresh prices (fix for B requirement)
      // Call sync-sales-orders with enrich_by_asin for each ASIN
      let ordersUpdated = 0;
      for (const asin of uniqueAsins) {
        try {
          const syncResponse = await supabase.functions.invoke("sync-sales-orders", {
            body: { 
              target_asin: asin,
              enrich_by_asin: true,
            },
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          
          if (syncResponse.data?.ordersUpdated) {
            ordersUpdated += syncResponse.data.ordersUpdated;
          }
        } catch (syncErr) {
          console.error(`Error syncing orders for ASIN ${asin}:`, syncErr);
          // Continue with other ASINs
        }
      }

      // Step 3: Backfill any missing snapshots for these ASINs
      try {
        await supabase.functions.invoke("backfill-order-snapshots", {
          body: { asins: uniqueAsins },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
      } catch (snapshotErr) {
        console.error("Snapshot backfill error:", snapshotErr);
        // Non-fatal, continue
      }

      if ((priceResult?.updated ?? 0) === 0 && ordersUpdated === 0) {
        toast({
          title: "No updates needed",
          description: "All selected items already have fresh prices.",
        });
      } else {
        toast({
          title: "Prices refreshed",
          description: `Updated ${priceResult?.updated || 0} inventory item(s)${ordersUpdated > 0 ? ` and ${ordersUpdated} pending order(s)` : ''}.`,
        });
        fetchInventory();
      }
    } catch (error: any) {
      console.error("Price refresh error:", error);
      toast({
        variant: "destructive",
        title: "Price refresh failed",
        description: error?.message || "Failed to refresh prices from Amazon",
      });
    } finally {
      setRefreshingPrices(false);
    }
  };

  // Fetch missing images from SP-API Catalog endpoint
  const handleFetchMissingImages = async () => {
    if (!user) return;
    
    const missingImageItems = sortedInventory.filter(item => !item.image_url);
    if (missingImageItems.length === 0) {
      toast({ title: "All images present", description: "No missing images found." });
      return;
    }

    // Deduplicate ASINs
    const uniqueAsins = [...new Set(missingImageItems.map(i => i.asin))];
    const totalAsins = uniqueAsins.length;

    setFetchingImages(true);
    setImageProgress({ done: 0, total: totalAsins });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ variant: "destructive", title: "Please log in first" });
        return;
      }

      let successCount = 0;
      let errorCount = 0;

      // Process in small batches to avoid rate limits
      for (let i = 0; i < uniqueAsins.length; i++) {
        const asin = uniqueAsins[i];
        setImageProgress({ done: i + 1, total: totalAsins });

        try {
          const { data, error } = await supabase.functions.invoke('fetch-listing-snapshot', {
            body: { asin, marketplaceId: 'ATVPDKIKX0DER' },
            headers: { Authorization: `Bearer ${session.access_token}` },
          });

          if (error) {
            const msg = error.message || "";
            if (msg.includes("429") || msg.includes("QUOTA_EXCEEDED")) {
              toast({
                variant: "destructive",
                title: "Rate limit reached",
                description: `Fetched ${successCount} images before hitting Amazon rate limit. Try again later for the rest.`,
              });
              break;
            }
            errorCount++;
            continue;
          }

          const imageUrl = data?.imageUrl;
          if (imageUrl) {
            // Update the inventory table directly
            await supabase
              .from('inventory')
              .update({ image_url: imageUrl })
              .eq('user_id', user.id)
              .eq('asin', asin);
            successCount++;
          }
        } catch (err) {
          errorCount++;
          console.error(`Error fetching image for ${asin}:`, err);
        }

        // Small delay between calls to avoid rate limiting
        if (i < uniqueAsins.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      toast({
        title: "Image fetch complete",
        description: `Updated ${successCount} images${errorCount > 0 ? `, ${errorCount} failed` : ''}.`,
      });

      // Refresh inventory data
      queryClient.invalidateQueries({ queryKey: ['synced-inventory'] });
    } catch (err) {
      console.error("Fetch missing images error:", err);
      toast({ variant: "destructive", title: "Error fetching images" });
    } finally {
      setFetchingImages(false);
    }
  };


  const handleExportValuationToExcel = () => {
    if (inventory.length === 0) {
      toast({
        variant: "destructive",
        title: "No inventory to export",
        description: "Please sync your inventory first.",
      });
      return;
    }

    // Helper to build sheet data
    const buildSheetData = (items: InventoryItem[]) => {
      const filteredItems = items;

      const totals = filteredItems.reduce((acc, item) => {
        const unitCost = resolveInventoryUnitCost(item);
        const available = item.available || 0;
        const reserved = item.reserved || 0;
        const inbound = item.inbound || 0;
        const unfulfilled = item.unfulfilled || 0;
        const totalQty = available + reserved + inbound + unfulfilled;
        
        return {
          available: acc.available + available,
          reserved: acc.reserved + reserved,
          inbound: acc.inbound + inbound,
          unfulfilled: acc.unfulfilled + unfulfilled,
          sum: acc.sum + (unitCost * totalQty),
        };
      }, { available: 0, reserved: 0, inbound: 0, unfulfilled: 0, sum: 0 });

      const totalsValue = { availableVal: 0, reservedVal: 0, inboundVal: 0, unfulfilledVal: 0 };

      const rows: any[][] = [
        ['ASIN', 'SKU', 'Title', 'Available', 'Reserved', 'Inbound', 'Unfulfilled', 'Unit Cost', 'Available $', 'Reserved $', 'Inbound $', 'Unfulfilled $', 'Total $'],
      ];

      filteredItems.forEach((item) => {
        const unitCost = resolveInventoryUnitCost(item);
        const available = item.available || 0;
        const reserved = item.reserved || 0;
        const inbound = item.inbound || 0;
        const unfulfilled = item.unfulfilled || 0;
        const availableVal = unitCost * available;
        const reservedVal = unitCost * reserved;
        const inboundVal = unitCost * inbound;
        const unfulfilledVal = unitCost * unfulfilled;
        const totalVal = availableVal + reservedVal + inboundVal + unfulfilledVal;

        totalsValue.availableVal += availableVal;
        totalsValue.reservedVal += reservedVal;
        totalsValue.inboundVal += inboundVal;
        totalsValue.unfulfilledVal += unfulfilledVal;
        
        rows.push([
          item.asin,
          item.sku,
          item.title || '',
          available,
          reserved,
          inbound,
          unfulfilled,
          Math.round(unitCost * 100) / 100,
          Math.round(availableVal * 100) / 100,
          Math.round(reservedVal * 100) / 100,
          Math.round(inboundVal * 100) / 100,
          Math.round(unfulfilledVal * 100) / 100,
          Math.round(totalVal * 100) / 100,
        ]);
      });

      rows.push([]);
      rows.push([
        '', '', 'TOTAL',
        totals.available, totals.reserved, totals.inbound, totals.unfulfilled, '',
        Math.round(totalsValue.availableVal * 100) / 100,
        Math.round(totalsValue.reservedVal * 100) / 100,
        Math.round(totalsValue.inboundVal * 100) / 100,
        Math.round(totalsValue.unfulfilledVal * 100) / 100,
        Math.round(totals.sum * 100) / 100,
      ]);

      return { rows, count: filteredItems.length };
    };

    // Separate FBA and FBM inventory
    const fbaItems = inventory.filter(
      item => !item.source || item.source === 'amazon_sync' || item.source === 'live_api'
    );
    const fbmItems = inventory.filter(item => item.source === 'amazon_sync_fbm');

    const fbaData = buildSheetData(fbaItems);
    const fbmData = buildSheetData(fbmItems);

    // Create workbook with sheets
    const wb = XLSX.utils.book_new();
    const colWidths = [
      { wch: 12 },  // ASIN
      { wch: 20 },  // SKU
      { wch: 50 },  // Title
      { wch: 12 },  // Available
      { wch: 12 },  // Reserved
      { wch: 12 },  // Inbound
      { wch: 12 },  // Unfulfilled
      { wch: 12 },  // Unit Cost
      { wch: 14 },  // Available $
      { wch: 14 },  // Reserved $
      { wch: 14 },  // Inbound $
      { wch: 14 },  // Unfulfilled $
      { wch: 14 },  // Total $
    ];

    // FBA sheet
    const fbaWs = XLSX.utils.aoa_to_sheet(fbaData.rows);
    fbaWs['!cols'] = colWidths;
    XLSX.utils.book_append_sheet(wb, fbaWs, 'FBA Inventory');

    // FBM sheet (only if there are FBM items)
    if (fbmData.count > 0) {
      const fbmWs = XLSX.utils.aoa_to_sheet(fbmData.rows);
      fbmWs['!cols'] = colWidths;
      XLSX.utils.book_append_sheet(wb, fbmWs, 'FBM Inventory');
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `inventory_${dateStr}.xlsx`;

    XLSX.writeFile(wb, filename);

    toast({
      title: "Export successful",
      description: `Exported ${fbaData.count} FBA + ${fbmData.count} FBM items to ${filename}`,
    });
  };

  const handleExportStockValuation = () => {
    const itemsWithStock = inventory.filter(item => {
      return getPhysicalWarehouseUnits(item) > 0;
    });

    if (itemsWithStock.length === 0) {
      toast({
        variant: "destructive",
        title: "No items with stock",
        description: "No items have available, reserved, or inbound units.",
      });
      return;
    }

    const totals = { available: 0, reserved: 0, inbound: 0, availableVal: 0, reservedVal: 0, inboundVal: 0 };
    let totalUnfulfilled = 0;
    let totalUnfulfilledVal = 0;

    const rows: any[][] = [
      ['ASIN', 'SKU', 'Title', 'Unit Cost', 'Available', 'Available $', 'Reserved', 'Reserved $', 'Inbound', 'Inbound $', 'Unfulfilled', 'Unfulfilled $', 'Total Units', 'Total $'],
    ];

    itemsWithStock.forEach((item) => {
      const unitCost = resolveInventoryUnitCost(item);
      const available = item.available || 0;
      const reserved = item.reserved || 0;
      const inbound = item.inbound || 0;
      const unfulfilled = item.unfulfilled || 0;
      const availableVal = unitCost * available;
      const reservedVal = unitCost * reserved;
      const inboundVal = unitCost * inbound;
      const unfulfilledVal = unitCost * unfulfilled;
      const totalUnits = available + reserved + inbound + unfulfilled;
      const totalVal = availableVal + reservedVal + inboundVal + unfulfilledVal;

      totals.available += available;
      totals.reserved += reserved;
      totals.inbound += inbound;
      totals.availableVal += availableVal;
      totals.reservedVal += reservedVal;
      totals.inboundVal += inboundVal;
      totalUnfulfilled += unfulfilled;
      totalUnfulfilledVal += unfulfilledVal;

      rows.push([
        item.asin,
        item.sku,
        item.title || '',
        Math.round(unitCost * 100) / 100,
        available,
        Math.round(availableVal * 100) / 100,
        reserved,
        Math.round(reservedVal * 100) / 100,
        inbound,
        Math.round(inboundVal * 100) / 100,
        unfulfilled,
        Math.round(unfulfilledVal * 100) / 100,
        totalUnits,
        Math.round(totalVal * 100) / 100,
      ]);
    });

    rows.push([]);
    rows.push([
      '', '', 'TOTAL', '',
      totals.available,
      Math.round(totals.availableVal * 100) / 100,
      totals.reserved,
      Math.round(totals.reservedVal * 100) / 100,
      totals.inbound,
      Math.round(totals.inboundVal * 100) / 100,
      totalUnfulfilled,
      Math.round(totalUnfulfilledVal * 100) / 100,
      totals.available + totals.reserved + totals.inbound + totalUnfulfilled,
      Math.round((totals.availableVal + totals.reservedVal + totals.inboundVal + totalUnfulfilledVal) * 100) / 100,
    ]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [
      { wch: 12 }, { wch: 20 }, { wch: 50 }, { wch: 12 },
      { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
      { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
      { wch: 12 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Valuation');

    const dateStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `stock_valuation_${dateStr}.xlsx`);

    toast({
      title: "Stock valuation exported",
      description: `Exported ${itemsWithStock.length} items with stock to Excel.`,
    });
  };

  // Get the most recent sync time from inventory
  const getLastSyncTime = (): string | null => {
    const withSync = inventory.filter(i => i.last_inventory_sync_at);
    if (withSync.length === 0) return null;
    const sorted = withSync.sort((a, b) => 
      new Date(b.last_inventory_sync_at!).getTime() - new Date(a.last_inventory_sync_at!).getTime()
    );
    return sorted[0].last_inventory_sync_at!;
  };

  const formatSyncTime = (isoTime: string | null): string => {
    if (!isoTime) return "Never";
    const date = new Date(isoTime);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  const getSyncFreshness = (isoTime: string | null): { label: string; className: string } => {
    if (!isoTime) return { label: 'Stale', className: 'text-destructive' };
    const diffHours = (Date.now() - new Date(isoTime).getTime()) / 3600000;
    if (diffHours <= 6) return { label: 'Fresh', className: 'text-emerald-600' };
    if (diffHours <= 24) return { label: 'Aging', className: 'text-amber-600' };
    return { label: 'Stale', className: 'text-destructive' };
  };

  // IndexedDB cache: load cached data as placeholder while Supabase fetches
  const [idbPlaceholder, setIdbPlaceholder] = useState<any[] | undefined>(undefined);
  const idbLoadedRef = useRef(false);

  useEffect(() => {
    if (!user || idbLoadedRef.current) return;
    idbLoadedRef.current = true;
    getInventoryCache(user.id).then(cached => {
      if (cached?.data) {
        console.log(`[IDB Cache] Loaded ${cached.data.length} items (age: ${Math.round((Date.now() - cached.timestamp) / 60000)}m)`);
        setIdbPlaceholder(cached.data);
      }
    });
  }, [user]);

  const { data: inventory = [], isLoading: loading, isPlaceholderData: isShowingCachedData, refetch: fetchInventory } = useQuery({
    queryKey: ['synced-inventory', user?.id, salesPeriodDays],
    queryFn: async () => {
      const result = await fetchInventoryData(user!.id, salesPeriodDays);
      // Persist to IndexedDB after successful fetch
      setInventoryCache(user!.id, result);
      return result;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes - shows instantly on revisit
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    placeholderData: idbPlaceholder, // Show cached data instantly while fetching
  });

  // Repricer's real per-ASIN fee cache (see fetchFeeCacheMap) — used as the ROI
  // column's fee source when inventory.fees_json isn't populated, before falling
  // back to the flat 15% estimate.
  const { data: feeCacheByAsin = new Map<string, { fba_fee_fixed: number; referral_rate: number }>() } = useQuery({
    queryKey: ['asin-fee-cache-map', user?.id],
    queryFn: () => fetchFeeCacheMap(user!.id),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Resolves the best available fee source for ROI math: inventory.fees_json
  // first (rarely populated on this account), then the repricer's asin_fee_cache
  // (real per-ASIN data), else null — estimateAmazonFees/estimateRoi fall back to
  // a flat 15% estimate only when this returns null.
  const resolveFees = (item: { asin: string; fees_json: any }) =>
    item.fees_json || feeCacheByAsin.get(item.asin) || null;

  // Phase 7+ — track which displayed ASINs have a Created Listing so the cost
  // badge can show "Manual / No Purchase Record" and the
  // "Create purchase record" CTA only appears when no record exists.
  const { hasPurchaseRecord } = useAsinPurchaseRecords(
    (inventory as any[])?.map((i: any) => i.asin).filter(Boolean) as string[],
  );

  const saveUnitCost = async (itemId: string) => {
    if (!user || !editingCostValue.trim()) {
      setEditingCostId(null);
      setEditingCostValue("");
      return;
    }
    
    const newCost = parseFloat(editingCostValue);
    if (isNaN(newCost) || newCost < 0) {
      toast({
        variant: "destructive",
        title: "Invalid cost",
        description: "Please enter a valid positive number",
      });
      return;
    }
    
    try {
      const nowIso = new Date().toISOString();
      const trimmedReason = editingCostReason.trim();
      const reasonToSave = trimmedReason ? trimmedReason.slice(0, 200) : null;

      // Phase 7+ — classify source so the cost badge can show
      // "Manual / No Purchase Record" when no Created Listing exists yet.
      const editedItem = (inventory as any[]).find((inv: any) => inv.id === itemId);
      let manualSource: 'user' | 'manual_no_purchase_record' = 'user';
      if (editedItem?.asin) {
        try {
          const { count } = await supabase
            .from('created_listings')
            .select('id', { count: 'exact', head: true })
            .eq('asin', editedItem.asin);
          if ((count ?? 0) === 0) manualSource = 'manual_no_purchase_record';
        } catch {
          /* non-fatal */
        }
      }

      const { error } = await supabase
        .from('inventory')
        .update({ 
          cost: newCost, 
          unit_cost_manual: true,
          manual_cost_updated_at: nowIso,
          manual_cost_source: manualSource,
          manual_cost_reason: reasonToSave,
          updated_at: nowIso
        })
        .eq('id', itemId)
        .eq('user_id', user.id);
      
      if (error) throw error;
      
      // Optimistic UI update — reflect new cost immediately without waiting for refetch
      queryClient.setQueryData(['synced-inventory', user.id, salesPeriodDays], (old: InventoryItem[] | undefined) => {
        if (!old) return old;
        return old.map((item: InventoryItem) =>
          item.id === itemId
            ? { ...item, unit_cost: newCost, cost: newCost, unit_cost_manual: true, manual_cost_updated_at: nowIso, manual_cost_source: manualSource, manual_cost_reason: reasonToSave }
            : item
        );
      });

      toast({
        title: "Unit cost saved",
        description: `Updated to $${newCost.toFixed(2)}`,
      });
      
      // Background refetch to sync any derived fields
      fetchInventory();

      // Trigger auto-onboarding in background
      const item = inventory.find((i: any) => i.id === itemId);
      if (item?.asin && item?.sku) {
        triggerAutoOnboard(item.asin, item.sku);
      }
      
    } catch (error: any) {
      console.error("Error saving unit cost:", error);
      toast({
        variant: "destructive",
        title: "Failed to save",
        description: error?.message || "Could not update unit cost",
      });
    } finally {
      setEditingCostId(null);
      setEditingCostValue("");
      setEditingCostReason("");
    }
  };

  // Fix all unit costs by syncing the interpreted created_listings unit cost back into inventory
  const handleFixAllUnitCosts = async () => {
    if (!user) return;
    
    setFixingCosts(true);
    setFixProgress({ done: 0, total: 0 });
    
    try {
      // Step 1: Fetch ALL created_listings with batching (Supabase has 1000 row limit)
      const unitCostBySku = new Map<string, number>();
      const unitCostByAsin = new Map<string, number>();
      
      let listingsFrom = 0;
      const listingsBatchSize = 1000;
      let hasMoreListings = true;
      
      while (hasMoreListings) {
        const { data: listingsBatch, error: listingsError } = await supabase
          .from('created_listings')
          .select('sku, asin, cost, amount, units')
          .eq('user_id', user.id)
          .range(listingsFrom, listingsFrom + listingsBatchSize - 1);
        
        if (listingsError) throw listingsError;
        
        const batchLen = listingsBatch?.length || 0;
        
        listingsBatch?.forEach((cl: any) => {
          const { unitCost } = resolveCreatedListingCosts(cl);

          if (unitCost !== null && unitCost !== undefined) {
            if (cl.sku) {
              unitCostBySku.set(cl.sku, unitCost);
            }
            if (cl.asin && !unitCostByAsin.has(cl.asin)) {
              unitCostByAsin.set(cl.asin, unitCost);
            }
          }
        });
        
        if (batchLen < listingsBatchSize) {
          hasMoreListings = false;
        } else {
          listingsFrom += listingsBatchSize;
        }
      }
      
      console.log(`Built unit cost maps: ${unitCostBySku.size} SKUs, ${unitCostByAsin.size} ASINs`);
      
      // Step 2: Fetch ALL inventory items with batching
      const updates: { id: string; cost: number }[] = [];
      let invFrom = 0;
      const invBatchSize = 1000;
      let hasMoreInv = true;
      
      while (hasMoreInv) {
        const { data: invBatch, error: invError } = await supabase
          .from('inventory')
          .select('id, sku, asin, cost')
          .eq('user_id', user.id)
          .range(invFrom, invFrom + invBatchSize - 1);
        
        if (invError) throw invError;
        
        const invBatchLen = invBatch?.length || 0;
        
        invBatch?.forEach((item: any) => {
          // Try SKU match first, then ASIN fallback
          const correctUnitCost = unitCostBySku.get(item.sku) ?? unitCostByAsin.get(item.asin);
          
          if (correctUnitCost !== undefined) {
            const currentCost = item.cost ? Number(item.cost) : null;
            // Update if different (with small tolerance) OR if currently null
            if (currentCost === null || Math.abs(currentCost - correctUnitCost) > 0.01) {
              updates.push({ id: item.id, cost: correctUnitCost });
            }
          }
        });
        
        if (invBatchLen < invBatchSize) {
          hasMoreInv = false;
        } else {
          invFrom += invBatchSize;
        }
      }
      
      console.log(`Found ${updates.length} items to update`);
      setFixProgress({ done: 0, total: updates.length });
      
      if (updates.length === 0) {
        toast({
          title: "All unit costs are correct",
          description: "No updates needed.",
        });
        setFixingCosts(false);
        return;
      }
      
      // Step 4: Update in batches
      const batchSize = 50;
      let completed = 0;
      
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        
        // Update each item in the batch
        await Promise.all(
          batch.map(async (update) => {
            const { error } = await supabase
              .from('inventory')
                .update({ cost: update.cost, unit_cost_manual: false })
              .eq('id', update.id);
            
            if (error) {
              console.error(`Failed to update ${update.id}:`, error);
            }
          })
        );
        
        completed += batch.length;
        setFixProgress({ done: completed, total: updates.length });
      }
      
      toast({
        title: "Unit costs updated",
        description: `Fixed ${updates.length} items with correct unit costs.`,
      });
      
      // Refresh inventory data
      fetchInventory();
      
    } catch (error: any) {
      console.error("Error fixing unit costs:", error);
      toast({
        variant: "destructive",
        title: "Failed to fix unit costs",
        description: error?.message ?? "An error occurred.",
      });
    } finally {
      setFixingCosts(false);
    }
  };

  // Helper to calculate replenish qty for filtering/sorting
  // Uses actual sales period (based on earliest sale within window) for accurate ADS
  // Falls back to historical sales velocity when no recent sales
  // Returns 0 for used/renewed products (amzn.gr.* SKUs) since they come from returns
  const getReplenishQty = (item: InventoryItem): number => {
    // Used products from Amazon returns shouldn't have replenish forecast
    if (item.sku?.startsWith('amzn.gr.')) {
      return 0;
    }
    return calculateReplenishQty({
      salesUnits: item.sales_30d ?? 0,
      salesPeriodDays: item.sales_period_days ?? salesPeriodDays,
      available: item.available ?? 0,
      inbound: item.inbound ?? 0,
      reserved: item.reserved ?? 0,
      coverageDays: replenishCoverageMonths * 30, // 30, 60, or 90 days based on user selection
      historicalSalesUnits: item.historical_sales,
      historicalDays: item.historical_days,
    });
  };

  // Replenishment selection handlers
  const handleToggleSelect = (item: InventoryItem) => {
    setSelectedForShipment(prev => {
      const next = new Map(prev);
      if (next.has(item.asin)) {
        next.delete(item.asin);
      } else {
        const suggestedQty = getReplenishQty(item);
        next.set(item.asin, { item, qtyToShip: suggestedQty > 0 ? suggestedQty : 1 });
      }
      return next;
    });
  };

  const handleUpdateShipmentQty = (asin: string, qty: number) => {
    setSelectedForShipment(prev => {
      const next = new Map(prev);
      const entry = next.get(asin);
      if (entry) {
        next.set(asin, { ...entry, qtyToShip: qty });
      }
      return next;
    });
  };

  const handleRemoveFromShipment = (asin: string) => {
    setSelectedForShipment(prev => {
      const next = new Map(prev);
      next.delete(asin);
      return next;
    });
  };

  const shipmentItems = Array.from(selectedForShipment.values()).map(entry => ({
    asin: entry.item.asin,
    sku: entry.item.sku,
    fnsku: entry.item.fnsku,
    title: entry.item.title,
    image_url: entry.item.image_url,
    qtyToShip: entry.qtyToShip,
    suggestedQty: getReplenishQty(entry.item),
    requiresExpirationDate: (entry.item as any).requires_expiration ?? false,
  }));

  // Ghost/deleted listings: hidden by default, shown when "Show Ghost ASINs" toggle is ON
  const visibleInventory = inventory.filter((item) => {
    const ls = (item.listing_status || '').toUpperCase();
    const isGhost = ls === 'NOT_IN_CATALOG' || ls === 'DELETED' || (item.sku || '').toLowerCase().startsWith('amzn.gr.');
    return showGhostsOnly ? isGhost : !isGhost;
  });

  const filteredInventory = visibleInventory.filter((item) => {
    const trimmedSearch = searchTerm.trim().toLowerCase();
    const matchesSearch =
      item.asin.toLowerCase().includes(trimmedSearch) ||
      item.sku.toLowerCase().includes(trimmedSearch) ||
      item.title.toLowerCase().includes(trimmedSearch);
    
    let matchesStock = true;
    if (stockFilter === 'in-stock') {
      matchesStock = getPhysicalWarehouseUnits(item) > 0;
    } else if (stockFilter === 'out-of-stock') {
      matchesStock = getPhysicalWarehouseUnits(item) === 0;
    } else if (stockFilter === 'needs-replenish') {
      matchesStock = getReplenishQty(item) > 0;
    } else if (stockFilter === 'slow-selling') {
      // Slow selling filter: attention score >= 25 and has available stock
      const metrics = calculateSlowSellingMetrics(item, salesPeriodDays);
      matchesStock = metrics.attentionScore >= 25 && metrics.availableStock > 0;
      
      // Apply created age filter for slow-selling items
      if (matchesStock && createdAgeFilter !== 'all') {
        const createdDate = parseListingDate(item.listing_created_at);
        if (!createdDate) {
          // If no created date, INCLUDE the item - it's existing inventory that needs attention
          // Only exclude from "recent" filter since we can't confirm it's recent
          if (createdAgeFilter === 'recent') {
            matchesStock = false;
          }
          // For "Over X months" filters, include items without dates (assume old enough)
        } else {
          const now = new Date();
          const ageInDays = Math.floor((now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
          const ageInMonths = ageInDays / 30;
          
          if (createdAgeFilter === 'recent') {
            // Less than 1 month old
            matchesStock = ageInMonths < 1;
          } else {
            // "Over X months" filters
            const monthsRequired = {
              '1m': 1,
              '2m': 2,
              '3m': 3,
              '4m': 4,
              '5m': 5,
              '6m': 6,
              '9m': 9,
              '12m': 12,
              '18m': 18,
              '24m': 24,
            }[createdAgeFilter] || 1;
            matchesStock = ageInMonths >= monthsRequired;
          }
        }
      }
    } else if (stockFilter === 'preserved') {
      matchesStock = item.source === 'preserved_db' || item.source === 'history_restore' || item.listing_status === 'MISMATCH' || item.listing_status === 'STRANDED';
    }
    
    
    // Fulfillment filter (FBA vs FBM)
    let matchesFulfillment = true;
    if (fulfillmentFilter === 'fba') {
      matchesFulfillment = !item.source || item.source === 'amazon_sync' || item.source === 'live_api';
    } else if (fulfillmentFilter === 'fbm') {
      matchesFulfillment = item.source === 'amazon_sync_fbm';
    }
    
    // Phase 7: optionally restrict to rows with a manual cost override
    const matchesOverride = !showOverriddenOnly || item.unit_cost_manual === true;

    return matchesSearch && matchesStock && matchesFulfillment && matchesOverride;
  });

  // Apply sorting
  const sortedInventory = [...filteredInventory].sort((a, b) => {
    if (!sortBy) return 0;
    
    if (sortBy === 'available') {
      const aVal = a.available ?? 0;
      const bVal = b.available ?? 0;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'replenish') {
      const aVal = getReplenishQty(a);
      const bVal = getReplenishQty(b);
      // Primary sort by replenish value, secondary by ASIN for consistent ordering
      const diff = sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      if (diff !== 0) return diff;
      return a.asin.localeCompare(b.asin);
    }
    if (sortBy === 'created') {
      const aDate = parseListingDate(a.listing_created_at)?.getTime() ?? 0;
      const bDate = parseListingDate(b.listing_created_at)?.getTime() ?? 0;
      return sortDirection === 'asc' ? aDate - bDate : bDate - aDate;
    }
    if (sortBy === 'roi') {
      const aRoi = estimateRoi(a.price, a.unit_cost, resolveFees(a)) ?? -Infinity;
      const bRoi = estimateRoi(b.price, b.unit_cost, resolveFees(b)) ?? -Infinity;
      return sortDirection === 'asc' ? aRoi - bRoi : bRoi - aRoi;
    }
    if (sortBy === 'sales') {
      const aVal = a.sales_30d ?? 0;
      const bVal = b.sales_30d ?? 0;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'bsr') {
      // Treat null/undefined BSR as very high (low rank = high sales)
      const aVal = a.bsr ?? Infinity;
      const bVal = b.bsr ?? Infinity;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'valueStock') {
      const aTotal = (a.available ?? 0) + (a.reserved ?? 0) + (a.inbound ?? 0);
      const bTotal = (b.available ?? 0) + (b.reserved ?? 0) + (b.inbound ?? 0);
      const aValue = (a.unit_cost ?? 0) * aTotal;
      const bValue = (b.unit_cost ?? 0) * bTotal;
      return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
    }
    if (sortBy === 'ads') {
      const getAds = (item: InventoryItem) => {
        const salesUnits = item.sales_30d ?? 0;
        const periodDays = item.sales_period_days ?? salesPeriodDays;
        if (salesUnits > 0 && periodDays > 0) return salesUnits / periodDays;
        if (item.historical_sales && item.historical_days && item.historical_days > 0) {
          return item.historical_sales / item.historical_days;
        }
        return 0;
      };
      const aVal = getAds(a);
      const bVal = getAds(b);
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'daysOfCover') {
      const aMetrics = calculateSlowSellingMetrics(a, salesPeriodDays);
      const bMetrics = calculateSlowSellingMetrics(b, salesPeriodDays);
      // Treat null as very high (infinity) for sorting - these are items with no sales
      const aVal = aMetrics.daysOfCover ?? 99999;
      const bVal = bMetrics.daysOfCover ?? 99999;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'attentionScore') {
      const aMetrics = calculateSlowSellingMetrics(a, salesPeriodDays);
      const bMetrics = calculateSlowSellingMetrics(b, salesPeriodDays);
      return sortDirection === 'asc' 
        ? aMetrics.attentionScore - bMetrics.attentionScore 
        : bMetrics.attentionScore - aMetrics.attentionScore;
    }
    if (sortBy === 'unitCost') {
      // Treat null/0 as special - ascending puts empty first, descending puts empty last
      const aVal = a.unit_cost ?? 0;
      const bVal = b.unit_cost ?? 0;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'unfulfilled') {
      const aVal = a.unfulfilled ?? 0;
      const bVal = b.unfulfilled ?? 0;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }
    if (sortBy === 'lastSynced') {
      const aDate = (a.last_summaries_at || a.last_inventory_sync_at) ? new Date((a.last_summaries_at || a.last_inventory_sync_at)!).getTime() : 0;
      const bDate = (b.last_summaries_at || b.last_inventory_sync_at) ? new Date((b.last_summaries_at || b.last_inventory_sync_at)!).getTime() : 0;
      return sortDirection === 'asc' ? aDate - bDate : bDate - aDate;
    }
    return 0;
  });

  // Pagination calculations
  const totalPages = Math.ceil(sortedInventory.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedInventory = sortedInventory.slice(startIndex, endIndex);

  const handleSortByAvailable = () => {
    if (sortBy === 'available') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('available');
      setSortDirection('desc');
    }
  };

  const handleSortByRoi = () => {
    if (sortBy === 'roi') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('roi');
      setSortDirection('desc');
    }
  };

  const handleSortByReplenish = () => {
    if (sortBy === 'replenish') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('replenish');
      setSortDirection('desc');
    }
  };

  const handleSortByCreated = () => {
    if (sortBy === 'created') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('created');
      setSortDirection('desc');
    }
  };

  const handleSortBySales = () => {
    if (sortBy === 'sales') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('sales');
      setSortDirection('desc');
    }
  };

  const handleSortByBsr = () => {
    if (sortBy === 'bsr') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('bsr');
      setSortDirection('asc'); // Lower BSR = better, so ascending is "best first"
    }
  };

  const handleSortByValueStock = () => {
    if (sortBy === 'valueStock') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('valueStock');
      setSortDirection('desc');
    }
  };

  const handleSortByAds = () => {
    if (sortBy === 'ads') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('ads');
      setSortDirection('desc');
    }
  };

  const handleSortByDaysOfCover = () => {
    if (sortBy === 'daysOfCover') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('daysOfCover');
      setSortDirection('desc'); // Higher days of cover = worse, so descending shows worst first
    }
  };

  const handleSortByAttentionScore = () => {
    if (sortBy === 'attentionScore') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('attentionScore');
      setSortDirection('desc'); // Higher attention score = worse, so descending shows worst first
    }
  };

  const handleSortByUnitCost = () => {
    if (sortBy === 'unitCost') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('unitCost');
      setSortDirection('asc'); // Ascending shows empty/zero first (to find missing costs)
    }
  };

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, itemsPerPage, stockFilter, fulfillmentFilter, createdAgeFilter, showOverriddenOnly, showGhostsOnly]);

  return (
    <>
      <Helmet>
        <title>Inventory - InventorySprint</title>
        <meta
          name="description"
          content="View your synced Amazon FBA inventory with ASIN, SKU, FNSKU tracking and supplier information"
        />
      </Helmet>
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
        {/* Animated gradient orbs */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
        <Navbar />
        <main className="flex-1 px-2 py-8 pt-24 relative z-10">
          <SyncReadinessBanner module="inventory" />
          {/* Auto Inventory Sync — Cron Status panel hidden 2026-07-16 per cleanup
              request. Component still defined/imported — just re-add
              <AutoInventorySyncDebugPanel /> here if needed again. */}
          {(() => {
            const missingItems = inventory.filter(item => {
              const totalQty = (item.available || 0) + (item.reserved || 0) + (item.inbound || 0);
              return totalQty > 0 && (!item.unit_cost || item.unit_cost <= 0);
            });
            const missingUnits = missingItems.reduce((sum, item) =>
              sum + (item.available || 0) + (item.reserved || 0) + (item.inbound || 0), 0);
            return (
              <CostOnboardingBanner
                missingCostCount={missingItems.length}
                missingUnitsCount={missingUnits}
                onAddCostClick={() => setMissingValuationOpen(true)}
              />
            );
          })()}
          <div className="max-w-full">
            <div className="flex justify-between items-center mb-6 px-2">
              <div className="flex items-center gap-4">
                <h1 className="text-3xl font-bold text-white">
                  Inventory
                </h1>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Quick Sync, Manual SP-API Refresh, AdminRefreshControl, FBM Sync,
                      Recover Suspicious Zeros, Assign Missing, Rescue MISMATCH, Clean
                      Ghost Listings, and Live Verify removed 2026-07-31 — all of these
                      were already hidden from the UI since 2026-07-15/16 once the cron
                      system (full-inventory-refresh-2h, sync-inventory-report-4h,
                      inventory-refresh-worker-1m) was confirmed working reliably without
                      any manual/admin intervention. Show Ghost ASINs is kept per explicit
                      request. */}
                  <div className="flex flex-col text-xs text-muted-foreground">
                    <span>Last synced: {formatSyncTime(getLastSyncTime())}</span>
                    <span className={cn("text-[10px] font-medium", getSyncFreshness(getLastSyncTime()).className)}>
                      Freshness: {getSyncFreshness(getLastSyncTime()).label}
                    </span>
                  </div>
                  {isAdmin && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            onClick={() => setShowGhostsOnly((v) => !v)}
                            size="lg"
                            className={cn(
                              "gap-2 font-bold text-base shadow-lg border-2",
                              showGhostsOnly
                                ? "bg-green-700 hover:bg-green-800 text-white border-green-900"
                                : "bg-green-500 hover:bg-green-600 text-white border-green-700"
                            )}
                          >
                            <Trash2 className="h-5 w-5" />
                            {showGhostsOnly ? "👻 Showing Ghost ASINs (Click to hide)" : "👻 Show Ghost ASINs"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs">
                          <p className="text-sm">
                            <strong>Show Ghost ASINs:</strong> View soft-deleted / NOT_IN_CATALOG / amzn.gr.* rows with their deletion reason and timestamp. These are normally hidden from inventory views.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>

              {/* Inventory Valuation Block - uses filteredInventory to respect fulfillment/stock/status filters */}
              {(() => {
                // Calculate totals for each category based on filtered inventory
                // This ensures valuation updates when FBA/FBM filter changes
                const totals = filteredInventory.reduce((acc, item) => {
                  const unitCost = resolveInventoryUnitCost(item);
                  const available = item.available || 0;
                  const reserved = item.reserved || 0;
                  const inbound = item.inbound || 0;
                  const unfulfilled = item.unfulfilled || 0;
                  const totalQty = available + reserved + inbound + unfulfilled;

                  // Projected Sale/Profit/ROI: dollar totals — price × qty (revenue),
                  // revenue minus Amazon fees (cached fees_json when available, else a
                  // flat 15% referral-only estimate — see estimateAmazonFees) minus cost,
                  // summed across every item with stock (Available+Reserved+Inbound+
                  // Unfulfilled > 0) AND a known unit cost. Sale must use the SAME item
                  // population as Profit/ROI — an item with a price but no cost data
                  // would otherwise inflate Sale while being silently excluded from
                  // Profit/ROI, making Sale minus Profit not equal the real cost basis.
                  // ROI is dollar-weighted (total profit / total cost) rather than a
                  // plain per-item average, so its sign always matches Profit's sign.
                  let itemRevenue = 0;
                  let itemFees = 0;
                  let itemRoiCost = 0;
                  let hasCachedFees = false;
                  if (item.price && unitCost > 0 && totalQty > 0) {
                    const fees = resolveFees(item);
                    itemRevenue = item.price * totalQty;
                    itemFees = estimateAmazonFees(fees, item.price) * totalQty;
                    itemRoiCost = unitCost * totalQty;
                    hasCachedFees = !!fees;
                  }

                  return {
                    availableUnits: acc.availableUnits + available,
                    availableValue: acc.availableValue + (unitCost * available),
                    reservedUnits: acc.reservedUnits + reserved,
                    reservedValue: acc.reservedValue + (unitCost * reserved),
                    inboundUnits: acc.inboundUnits + inbound,
                    inboundValue: acc.inboundValue + (unitCost * inbound),
                    unfulfilledUnits: acc.unfulfilledUnits + unfulfilled,
                    unfulfilledValue: acc.unfulfilledValue + (unitCost * unfulfilled),
                    roiRevenue: acc.roiRevenue + itemRevenue,
                    roiFees: acc.roiFees + itemFees,
                    roiCost: acc.roiCost + itemRoiCost,
                    roiItems: acc.roiItems + (itemRoiCost > 0 ? 1 : 0),
                    roiItemsWithCachedFees: acc.roiItemsWithCachedFees + (hasCachedFees ? 1 : 0),
                  };
                }, {
                  availableUnits: 0, availableValue: 0, reservedUnits: 0, reservedValue: 0, inboundUnits: 0, inboundValue: 0, unfulfilledUnits: 0, unfulfilledValue: 0,
                  roiRevenue: 0, roiFees: 0, roiCost: 0, roiItems: 0, roiItemsWithCachedFees: 0,
                });

                const totalUnits = totals.availableUnits + totals.reservedUnits + totals.inboundUnits + totals.unfulfilledUnits;
                const totalValue = totals.availableValue + totals.reservedValue + totals.inboundValue + totals.unfulfilledValue;

                // Sale is the same revenue base ROI/Profit use (items with price + known
                // cost) — keeping those figures reconcilable by hand: Profit = Sale -
                // Fees - Cost, and Profit / Cost = ROI.
                const projectedSale = totals.roiRevenue;
                const projectedProfit = totals.roiItems > 0
                  ? totals.roiRevenue - totals.roiFees - totals.roiCost
                  : null;
                // Investment = Total Valuation (same cost × qty basis, no price required)
                // rather than the price-gated roiCost — so Investment always matches the
                // Total Valuation figure above, even when a few items have cost/stock but
                // no live price yet. That means for accounts with such items, Investment
                // can be a little larger than "Fees + Cost" implied by Sale/Profit alone —
                // matching Total Valuation was the explicit tradeoff requested.
                const projectedInvestment = totalValue > 0 ? totalValue : null;
                const projectedRoi = totals.roiCost > 0
                  ? ((totals.roiRevenue - totals.roiFees - totals.roiCost) / totals.roiCost) * 100
                  : null;
                // Margin = Profit / Sale (as opposed to ROI = Profit / Cost) — same
                // dollar-weighted profit, different denominator.
                const projectedMargin = projectedProfit != null && projectedSale > 0
                  ? (projectedProfit / projectedSale) * 100
                  : null;
                const roiEstimatedItems = totals.roiItems - totals.roiItemsWithCachedFees;
                
                 return (
                   <>
                   {/* Mobile-only TV-style valuation card */}
                   <div className="md:hidden relative group">
                     <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500/40 via-primary/40 to-blue-500/40 rounded-2xl blur opacity-50" />
                     <div className="relative bg-gradient-to-br from-slate-900 via-slate-950 to-black border border-emerald-500/20 rounded-2xl p-4 shadow-2xl overflow-hidden">
                       {/* TV-style scanline overlay */}
                       <div
                         className="pointer-events-none absolute inset-0 opacity-[0.06]"
                         style={{
                           backgroundImage: 'repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 3px)',
                         }}
                       />
                       <div className="relative">
                         {/* Hero total */}
                         <div className="flex items-center gap-3 pb-3 border-b border-white/10">
                           <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/30 to-primary/30 flex items-center justify-center shadow-inner">
                             <DollarSign className="w-5 h-5 text-emerald-400" />
                           </div>
                           <div className="flex flex-col flex-1 min-w-0">
                             <span className="text-[10px] font-semibold text-emerald-400/80 uppercase tracking-[0.15em]">
                               Total Valuation
                             </span>
                             <span className="text-2xl font-bold tabular-nums text-white leading-tight drop-shadow-[0_0_8px_rgba(16,185,129,0.4)]">
                               ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                             </span>
                             <span className="text-[10px] text-white/60 tabular-nums">
                               {totalUnits.toLocaleString()} total units
                             </span>
                           </div>
                         </div>
                         {/* Breakdown grid */}
                         <div className="grid grid-cols-3 gap-2 pt-3">
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                             <div className="flex items-center gap-1">
                               <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                               <span className="text-[9px] font-medium text-emerald-300 uppercase tracking-wide">Available</span>
                             </div>
                             <span className="text-sm font-bold text-white tabular-nums mt-0.5">
                               ${totals.availableValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                             </span>
                             <span className="text-[9px] text-white/50 tabular-nums">
                               {totals.availableUnits.toLocaleString()} units
                             </span>
                           </div>
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                             <div className="flex items-center gap-1">
                               <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                               <span className="text-[9px] font-medium text-amber-300 uppercase tracking-wide">Reserved</span>
                             </div>
                             <span className="text-sm font-bold text-white tabular-nums mt-0.5">
                               ${totals.reservedValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                             </span>
                             <span className="text-[9px] text-white/50 tabular-nums">
                               {totals.reservedUnits.toLocaleString()} units
                             </span>
                           </div>
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                             <div className="flex items-center gap-1">
                               <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                               <span className="text-[9px] font-medium text-blue-300 uppercase tracking-wide">Inbound</span>
                             </div>
                             <span className="text-sm font-bold text-white tabular-nums mt-0.5">
                               ${totals.inboundValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                             </span>
                             <span className="text-[9px] text-white/50 tabular-nums">
                               {totals.inboundUnits.toLocaleString()} units
                             </span>
                           </div>
                         </div>
                         {/* Projected Sale, Profit, ROI & Margin — if all current stock sold at today's live price */}
                         <div className="grid grid-cols-2 gap-2 pt-2 mt-2 border-t border-white/10">
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-white/5 border border-white/10">
                             <span className="text-[9px] font-medium text-white/60 uppercase tracking-wide">Projected Sale</span>
                             {isShowingCachedData ? (
                               <Skeleton className="h-5 w-20 mt-0.5 bg-white/10" />
                             ) : (
                               <span className="text-sm font-bold text-white tabular-nums mt-0.5">
                                 ${projectedSale.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                               </span>
                             )}
                             <span className="text-[7px] text-white/40 leading-tight text-center mt-0.5">
                               at today's price
                             </span>
                           </div>
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-white/5 border border-white/10">
                             <span className="text-[9px] font-medium text-white/60 uppercase tracking-wide">Investment</span>
                             {isShowingCachedData ? (
                               <Skeleton className="h-5 w-20 mt-0.5 bg-white/10" />
                             ) : (
                               <span className="text-sm font-bold text-white tabular-nums mt-0.5">
                                 {projectedInvestment != null ? `$${projectedInvestment.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                               </span>
                             )}
                             <span className="text-[7px] text-white/40 leading-tight text-center mt-0.5">
                               = Total Valuation
                             </span>
                           </div>
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-white/5 border border-white/10">
                             <span className="text-[9px] font-medium text-white/60 uppercase tracking-wide">Projected Profit</span>
                             {isShowingCachedData ? (
                               <Skeleton className="h-5 w-20 mt-0.5 bg-white/10" />
                             ) : (
                               <span className={cn(
                                 "text-sm font-bold tabular-nums mt-0.5",
                                 projectedProfit != null && projectedProfit >= 0 ? "text-emerald-400" : projectedProfit != null ? "text-red-400" : "text-white"
                               )}>
                                 {projectedProfit != null ? `$${projectedProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                               </span>
                             )}
                             <span className="text-[7px] text-white/40 leading-tight text-center mt-0.5">
                               {roiEstimatedItems > 0 ? `${totals.roiItemsWithCachedFees}/${totals.roiItems} actual fees` : 'actual fees'}
                             </span>
                           </div>
                           <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-white/5 border border-white/10">
                             <span className="text-[9px] font-medium text-white/60 uppercase tracking-wide">Projected ROI</span>
                             {isShowingCachedData ? (
                               <Skeleton className="h-5 w-12 mt-0.5 bg-white/10" />
                             ) : (
                               <span className={cn(
                                 "text-sm font-bold tabular-nums mt-0.5",
                                 projectedRoi != null && projectedRoi >= 30 ? "text-emerald-400" : projectedRoi != null && projectedRoi < 0 ? "text-red-400" : "text-white"
                               )}>
                                 {projectedRoi != null ? `${projectedRoi.toFixed(0)}%` : '—'}
                               </span>
                             )}
                             <span className="text-[7px] text-white/40 leading-tight text-center mt-0.5">
                               {roiEstimatedItems > 0 ? `${totals.roiItemsWithCachedFees}/${totals.roiItems} actual fees` : 'actual fees'}
                             </span>
                           </div>
                           <div className="col-span-2 flex flex-col items-center px-2 py-2 rounded-lg bg-white/5 border border-white/10">
                             <span className="text-[9px] font-medium text-white/60 uppercase tracking-wide">Projected Margin</span>
                             {isShowingCachedData ? (
                               <Skeleton className="h-5 w-12 mt-0.5 bg-white/10" />
                             ) : (
                               <span className={cn(
                                 "text-sm font-bold tabular-nums mt-0.5",
                                 projectedMargin != null && projectedMargin >= 0 ? "text-emerald-400" : projectedMargin != null ? "text-red-400" : "text-white"
                               )}>
                                 {projectedMargin != null ? `${projectedMargin.toFixed(0)}%` : '—'}
                               </span>
                             )}
                             <span className="text-[7px] text-white/40 leading-tight text-center mt-0.5">
                               Profit ÷ Sale
                             </span>
                           </div>
                         </div>
                       </div>
                     </div>
                   </div>

                   <div className="relative group hidden md:block">
                     <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500/40 via-primary/40 to-blue-500/40 rounded-2xl blur opacity-40 group-hover:opacity-60 transition duration-500" />
                     <div className="relative bg-card border border-border/50 rounded-2xl px-5 py-4 shadow-xl backdrop-blur-sm">
                       <div className="flex items-center gap-5">
                        {/* Total Value Section */}
                        <div className="flex items-center gap-3">
                          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500/20 to-primary/20 flex items-center justify-center shadow-inner">
                            <DollarSign className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                          </div>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                Total Valuation
                              </span>
                              {isShowingCachedData && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
                                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                  Updating…
                                </span>
                              )}
                            </div>
                            <span className={`text-xl font-bold tabular-nums leading-tight transition-opacity duration-300 ${isShowingCachedData ? 'text-muted-foreground/70' : 'text-foreground'}`}>
                              ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {totalUnits.toLocaleString()} total units
                            </span>
                          </div>
                        </div>
                        
                        {/* Divider */}
                        <div className="w-px h-14 bg-gradient-to-b from-transparent via-border to-transparent" />
                        
                        {/* Available */}
                        <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Available</span>
                          </div>
                          <span className="text-base font-bold text-foreground tabular-nums">
                            ${totals.availableValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {totals.availableUnits.toLocaleString()} units
                          </span>
                        </div>
                        
                        {/* Reserved */}
                        <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-amber-500/5 border border-amber-500/10">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-amber-500" />
                            <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide">Reserved</span>
                          </div>
                          <span className="text-base font-bold text-foreground tabular-nums">
                            ${totals.reservedValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {totals.reservedUnits.toLocaleString()} units
                          </span>
                        </div>
                        
                        {/* Inbound */}
                        <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-blue-500/5 border border-blue-500/10">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wide">Inbound</span>
                          </div>
                          <span className="text-base font-bold text-foreground tabular-nums">
                            ${totals.inboundValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {totals.inboundUnits.toLocaleString()} units
                          </span>
                        </div>
                        
                        {/* Divider */}
                        <div className="w-px h-14 bg-gradient-to-b from-transparent via-border to-transparent" />
                        
                        {/* Export Excel, Stock Valuation, Refresh Selected Prices buttons,
                            and the row-selection checkbox column all hidden 2026-07-16 per
                            cleanup requests — handlers (handleExportValuationToExcel,
                            handleExportStockValuation, handleRefreshPrices) and state
                            (selectedForShipment, handleToggleSelect) still defined in this
                            file if needed again. */}




                        
                        {/* Missing Valuation Button - shows count of items with qty but no cost */}
                        {(() => {
                          const missingCostItems = filteredInventory.filter(item => {
                            const totalQty = (item.available || 0) + (item.reserved || 0) + (item.inbound || 0);
                            return totalQty > 0 && (!item.unit_cost || item.unit_cost <= 0);
                          });
                          
                          if (missingCostItems.length === 0) return null;
                          
                          const missingUnits = missingCostItems.reduce((sum, item) => 
                            sum + (item.available || 0) + (item.reserved || 0) + (item.inbound || 0), 0);
                          
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    onClick={() => setMissingValuationOpen(true)}
                                    variant="outline"
                                    size="sm"
                                    className="gap-2 border-amber-500/50 hover:bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                  >
                                    <AlertTriangle className="h-4 w-4" />
                                    {missingCostItems.length} Missing Costs ({missingUnits} units)
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Items with inventory but no unit cost set. Click to view and fix.</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          );
                        })()}
                      </div>

                      {/* Projected Sale, Profit & ROI — if all current stock (Available +
                          Reserved + Inbound + Unfulfilled) sold at today's live price.
                          Profit/ROI use cached Amazon fees (fees_json) when available, else
                          a flat 15% referral-only estimate (see estimateAmazonFees) — same
                          fallback the repricer uses, so they're never gated behind a fee
                          cache. Projected Sale is price × qty only, no fee assumption. */}
                      <div className="mt-4 pt-4 border-t border-border/50 flex items-center gap-6 flex-wrap">
                        <div className="flex flex-col">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Projected Sale
                          </span>
                          {isShowingCachedData ? (
                            <Skeleton className="h-7 w-28 mt-0.5" />
                          ) : (
                            <span className="text-lg font-bold tabular-nums text-foreground">
                              ${projectedSale.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            If all current stock sold at today's price
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Investment
                          </span>
                          {isShowingCachedData ? (
                            <Skeleton className="h-7 w-28 mt-0.5" />
                          ) : (
                            <span className="text-lg font-bold tabular-nums text-foreground">
                              {projectedInvestment != null ? `$${projectedInvestment.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            Your cost basis (matches Total Valuation)
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Projected Profit
                          </span>
                          {isShowingCachedData ? (
                            <Skeleton className="h-7 w-28 mt-0.5" />
                          ) : (
                            <span className={cn(
                              "text-lg font-bold tabular-nums",
                              projectedProfit != null && projectedProfit >= 0 ? "text-green-500" : projectedProfit != null ? "text-red-500" : "text-foreground"
                            )}>
                              {projectedProfit != null ? `$${projectedProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {roiEstimatedItems > 0
                              ? `Sale minus fees and cost (${totals.roiItemsWithCachedFees} of ${totals.roiItems} use actual fees)`
                              : 'Sale minus fees and cost'}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Projected ROI
                          </span>
                          {isShowingCachedData ? (
                            <Skeleton className="h-7 w-16 mt-0.5" />
                          ) : (
                            <span className={cn(
                              "text-lg font-bold tabular-nums",
                              projectedRoi != null && projectedRoi >= 30 ? "text-green-500" : projectedRoi != null && projectedRoi < 0 ? "text-red-500" : "text-foreground"
                            )}>
                              {projectedRoi != null ? `${projectedRoi.toFixed(0)}%` : '—'}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {roiEstimatedItems > 0
                              ? `${totals.roiItemsWithCachedFees} of ${totals.roiItems} items use actual fees, rest estimated at 15%`
                              : 'Based on cached Amazon fees'}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Projected Margin
                          </span>
                          {isShowingCachedData ? (
                            <Skeleton className="h-7 w-16 mt-0.5" />
                          ) : (
                            <span className={cn(
                              "text-lg font-bold tabular-nums",
                              projectedMargin != null && projectedMargin >= 0 ? "text-green-500" : projectedMargin != null ? "text-red-500" : "text-foreground"
                            )}>
                              {projectedMargin != null ? `${projectedMargin.toFixed(0)}%` : '—'}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            Profit ÷ Sale (vs ROI = Profit ÷ Cost)
                          </span>
                        </div>
                      </div>
                    </div>
                   </div>
                   </>
                 );
               })()}
              
              {/* Refresh Selected Prices button moved inline with Export/Valuation row above */}

            </div>

            <div className="rounded-2xl bg-card/60 backdrop-blur-sm border border-border p-4 mb-6">
              <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                <div className="flex flex-col gap-2 flex-1 min-w-[200px] max-w-[500px]">
                  <Input
                    placeholder="Search by ASIN, SKU, or Title..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onPaste={(e) => {
                      e.preventDefault();
                      const pasted = e.clipboardData.getData('text').trim();
                      setSearchTerm(pasted);
                    }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground font-medium"
                  />
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  {/* Sales Period dropdown and its adjacent Refresh button hidden
                      2026-07-16 per cleanup request — salesPeriodDays stays at its
                      default (30) and still drives the query; setSalesPeriodDays
                      and fetchInventory are still defined if this needs to come back. */}
                  {/* Stock dropdown (All Products / In Stock Only / Out of Stock /
                      Needs Replenishment / Slow Selling / Preserved-MISMATCH) hidden
                      2026-07-16 per cleanup request — stockFilter stays at its default
                      ('all') and still drives filteredInventory; setStockFilter is
                      still defined if this needs to come back. */}
                  {stockFilter === 'slow-selling' && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-foreground font-medium">Age:</span>
                      <select
                        value={createdAgeFilter}
                        onChange={(e) => setCreatedAgeFilter(e.target.value as any)}
                        className="border border-white/30 rounded px-3 py-2 text-sm bg-white/80 text-foreground font-medium"
                        title="Filter by how long ago the listing was created"
                      >
                        <option value="all">All Ages</option>
                        <option value="recent">Recent (&lt; 1 month)</option>
                        <option value="1m">Over 1 month</option>
                        <option value="2m">Over 2 months</option>
                        <option value="3m">Over 3 months</option>
                        <option value="4m">Over 4 months</option>
                        <option value="5m">Over 5 months</option>
                        <option value="6m">Over 6 months</option>
                        <option value="9m">Over 9 months</option>
                        <option value="12m">Over 1 year</option>
                        <option value="18m">Over 18 months</option>
                        <option value="24m">Over 2 years</option>
                      </select>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-foreground font-medium">Fulfillment:</span>
                    <select
                      value={fulfillmentFilter}
                      onChange={(e) => setFulfillmentFilter(e.target.value as 'all' | 'fba' | 'fbm')}
                      className="border border-white/30 rounded px-3 py-2 text-sm bg-white/80 text-foreground font-medium"
                    >
                      <option value="all">All (FBA + FBM)</option>
                      <option value="fba">FBA Only</option>
                      <option value="fbm">FBM Only</option>
                    </select>
                  </div>
                  {/* Restock (1/2/3 months) dropdown hidden 2026-07-16 per cleanup
                      request — replenishCoverageMonths stays at its default (1) and
                      still drives coverageDays; setReplenishCoverageMonths is still
                      defined if this needs to come back. */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-foreground font-medium">Show:</span>
                    <select
                      value={itemsPerPage}
                      onChange={(e) => setItemsPerPage(Number(e.target.value))}
                      className="border border-white/30 rounded px-3 py-2 text-sm bg-white/80 text-foreground font-medium"
                    >
                      <option value={50}>50 records</option>
                      <option value={250}>250 records</option>
                    </select>
                  </div>
                  {/* Fetch Missing Images, Fix All Unit Costs (2026-07-16), and Load
                      Draft / Create Shipment (2026-07-16) all hidden per cleanup
                      requests — handlers (handleFetchMissingImages,
                      handleFixAllUnitCosts, loadSavedDrafts) and state
                      (setLoadDraftDialogOpen, setShipmentBuilderOpen, setDraftToLoad)
                      still defined in this file if needed again. */}
                </div>
              </div>
            </div>

            {loading ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">Loading inventory...</p>
              </div>
            ) : sortedInventory.length === 0 ? (
              <Card className="p-12 text-center">
                <p className="text-muted-foreground mb-4">
                  {searchTerm
                    ? "No items match your search"
                    : "No inventory items yet"}
                </p>
              </Card>
            ) : (
              <>
                <div className="mb-4 text-xs text-muted-foreground">
                  Showing {startIndex + 1}-{Math.min(endIndex, sortedInventory.length)} of {sortedInventory.length} items
                </div>
                {/* Mobile-only lightweight card list (avoids rendering the heavy 15-col table on phones) */}
                <div className="md:hidden space-y-2 mb-4">
                  {paginatedInventory.map((item) => {
                    const physical = (item.available ?? 0) + (item.reserved ?? 0);
                    const totalUnits = physical + (item.inbound ?? 0);
                    const valueStock = (item.unit_cost ?? 0) * totalUnits;
                    const roi = estimateRoi(item.price, item.unit_cost, resolveFees(item));
                    return (
                      <div key={item.id} className="rounded-lg border border-border bg-card p-3 flex gap-3">
                        {item.image_url ? (
                          <img src={item.image_url} alt={item.title} loading="lazy" className="min-w-12 min-h-12 w-12 h-12 object-cover rounded" />
                        ) : (
                          <div className="min-w-12 min-h-12 w-12 h-12 rounded bg-muted flex items-center justify-center">
                            <Package className="w-5 h-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs text-primary truncate">{item.asin}</span>
                            <span className="text-sm font-semibold">{item.price ? `$${item.price.toFixed(2)}` : '—'}</span>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{item.title}</p>
                          <div className="grid grid-cols-4 gap-1 mt-2 text-[11px]">
                            <div><span className="text-muted-foreground">Avail </span><span className="font-medium">{item.available ?? 0}</span></div>
                            <div><span className="text-muted-foreground">Resv </span><span className="font-medium">{item.reserved ?? 0}</span></div>
                            <div><span className="text-muted-foreground">Inb </span><span className="font-medium">{item.inbound ?? 0}</span></div>
                            <div><span className="text-muted-foreground">ROI </span><span className={cn("font-semibold", roi != null && roi >= 30 ? "text-green-500" : roi != null && roi < 0 ? "text-red-500" : "")}>{roi != null ? `${roi.toFixed(0)}%` : '—'}</span></div>
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-1">Stock value: ${valueStock.toFixed(2)}</div>
                        </div>
                      </div>
                    );
                  })}
                  {paginatedInventory.length === 0 && (
                    <div className="text-center text-sm text-muted-foreground py-8">No items found.</div>
                  )}
                </div>

                <div className="hidden md:block overflow-x-auto border border-border rounded-lg bg-background max-h-[70vh] overflow-y-auto">
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 z-20 border-b-2 border-border bg-muted">
                      <tr className="text-xs">
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Image</th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">ASIN</th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">SKU</th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Title</th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Price</th>
                        <th 
                          className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                          onClick={handleSortByUnitCost}
                          title="Click to sort - ascending groups empty costs at top"
                        >
                          Unit Cost {sortBy === 'unitCost' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                        <th 
                          className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                          onClick={handleSortByValueStock}
                        >
                          Value Stock {sortBy === 'valueStock' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                        <th 
                          className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                          onClick={handleSortByRoi}
                        >
                          ROI {sortBy === 'roi' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                        <th 
                          className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                          onClick={handleSortByAvailable}
                        >
                          Available {sortBy === 'available' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Reserved</th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Inbound</th>
                        <th
                          className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                          onClick={() => {
                            if (sortBy === 'unfulfilled') {
                              setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                            } else {
                              setSortBy('unfulfilled');
                              setSortDirection('desc');
                            }
                          }}
                        >
                          Unfulfilled {sortBy === 'unfulfilled' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                        {/* 30d Sales, ADS, Days Cover, Replenish columns hidden */}
                        {stockFilter === 'slow-selling' && (
                          <th 
                            className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                            onClick={handleSortByAttentionScore}
                            title="Attention Score (0-100) - higher means needs more attention"
                          >
                            <span className="flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3 text-amber-500" />
                              Score {sortBy === 'attentionScore' && (sortDirection === 'asc' ? '↑' : '↓')}
                            </span>
                          </th>
                        )}
                        {/* BSR column hidden */}
                        <th 
                          className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                          onClick={handleSortByCreated}
                        >
                          Created {sortBy === 'created' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                        <th className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:text-primary" onClick={() => {
                          if (sortBy === 'lastSynced') {
                            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                          } else {
                            setSortBy('lastSynced');
                            setSortDirection('desc');
                          }
                        }}>
                          Last Synced {sortBy === 'lastSynced' && (sortDirection === 'asc' ? '↑' : '↓')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedInventory.map((item, idx) => {
                        // Actual ROI from live price/cost, using cached Amazon fees when
                        // available or a flat 15% referral-only estimate otherwise (see
                        // estimateRoi) — never requires a live API call to display.
                        const roi = estimateRoi(item.price, item.unit_cost, resolveFees(item));

                        return (
                          <tr key={item.id} className={`border-b border-border hover:bg-muted/50 transition-colors ${idx % 2 === 0 ? 'bg-background' : 'bg-muted/30'}`}>
                            <td className="px-1 py-2">
                              {item.image_url ? (
                                <img
                                  src={item.image_url}
                                  alt={item.title}
                                  className="w-12 h-12 object-cover rounded"
                                />
                              ) : (
                                <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-[10px] text-muted-foreground">
                                  No Image
                                </div>
                              )}
                            </td>
                            <td className="px-1 py-2 font-mono text-xs">
                              <div className="relative group inline-flex items-center gap-1">
                                <CopyAsinButton asin={item.asin} />
                                <a
                                  href={`https://www.amazon.com/dp/${item.asin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  {item.asin}
                                </a>
                              </div>
                            </td>
                            <td className="px-1 py-2 text-xs text-center font-mono text-muted-foreground">
                              {item.sku}
                            </td>
                            <td className="px-1 py-2 max-w-[200px] truncate text-xs">{item.title}</td>
                            <td className="px-1 py-2 text-xs">
                              {item.price ? `$${item.price.toFixed(2)}` : '—'}
                            </td>
                            <td className="px-1 py-2 text-xs">
                              {editingCostId === item.id ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-muted-foreground">$</span>
                                    <Input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={editingCostValue}
                                      onChange={(e) => setEditingCostValue(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          saveUnitCost(item.id);
                                        } else if (e.key === 'Escape') {
                                          setEditingCostId(null);
                                          setEditingCostValue("");
                                          setEditingCostReason("");
                                        }
                                      }}
                                      className="w-16 h-6 text-xs px-1"
                                      autoFocus
                                    />
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-1.5 text-[10px]"
                                      onClick={() => saveUnitCost(item.id)}
                                    >
                                      Save
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-1.5 text-[10px]"
                                      onClick={() => {
                                        setEditingCostId(null);
                                        setEditingCostValue("");
                                        setEditingCostReason("");
                                      }}
                                    >
                                      ✕
                                    </Button>
                                  </div>
                                  <Input
                                    type="text"
                                    placeholder="Reason (optional)"
                                    maxLength={200}
                                    value={editingCostReason}
                                    onChange={(e) => setEditingCostReason(e.target.value)}
                                    className="h-6 text-[10px] px-1"
                                  />
                                  {parseFloat(editingCostValue) > 0 && (
                                    <ApplyToPurchaseButton
                                      asin={item.asin}
                                      unitCost={parseFloat(editingCostValue)}
                                      inventoryId={item.id}
                                      size="sm"
                                      variant="ghost"
                                      className="h-5 px-1 text-[10px]"
                                      onApplied={() => fetchInventory()}
                                    />
                                  )}
                                </div>
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex items-center gap-1">
                                    {hasPurchaseRecord(item.asin) ? (
                                      <span
                                        className="px-1 py-0.5 rounded text-left min-w-[40px] cursor-not-allowed"
                                        title="Unit cost is sourced from your Product Library purchase record and is read-only here. Edit it in Product Library."
                                      >
                                        {item.unit_cost || item.unit_cost === 0
                                          ? `$${item.unit_cost.toFixed(2)}`
                                          : <span className="text-muted-foreground italic">—</span>}
                                      </span>
                                    ) : (
                                      <button
                                        onClick={() => {
                                          setEditingCostId(item.id);
                                          setEditingCostValue(item.unit_cost?.toString() ?? "");
                                          setEditingCostReason(item.manual_cost_reason ?? "");
                                        }}
                                        className="hover:bg-muted px-1 py-0.5 rounded cursor-pointer text-left min-w-[40px]"
                                        title="No purchase record in Product Library — click to set unit cost manually"
                                      >
                                        {item.unit_cost || item.unit_cost === 0
                                          ? `$${item.unit_cost.toFixed(2)}`
                                          : <span className="text-muted-foreground italic">Click to add</span>}
                                      </button>
                                    )}
                                    {/* Hidden 2026-07-15: user wants the Unit Cost column's
                                        "From Purchase"/"Overridden" tooltip badge removed
                                        entirely. CostSourceBadge is still used elsewhere
                                        (ReplenishmentOrderPanel, Inventory.tsx) so the
                                        component itself is untouched — just not rendered here. */}
                                    {/* <CostSourceBadge
                                      row={item}
                                      compact
                                      hasPurchaseRecord={hasPurchaseRecord(item.asin)}
                                    /> */}
                                  </div>
                                  {item.unit_cost_manual &&
                                    item.unit_cost &&
                                    item.unit_cost > 0 &&
                                    !hasPurchaseRecord(item.asin) && (
                                      <CreatePurchaseFromCostButton
                                        asin={item.asin}
                                        sku={item.sku}
                                        title={item.title}
                                        unitCost={item.unit_cost}
                                        defaultUnits={
                                          (item.available ?? 0) +
                                          (item.reserved ?? 0) +
                                          (item.inbound ?? 0)
                                        }
                                        imageUrl={item.image_url}
                                        size="sm"
                                        variant="ghost"
                                        className="h-5 px-1 text-[10px] text-sky-600 hover:text-sky-700 dark:text-sky-400"
                                        onCreated={() => fetchInventory()}
                                      />
                                    )}
                                </div>
                              )}
                            </td>
                            <td className="px-1 py-2 text-xs">
                              {(() => {
                                // Contract A: inventory.amount = TOTAL inventory value (cost * units).
                                // For Value Stock we always recompute from the resolved unit cost
                                // (which already respects unit_cost_manual) and physical warehouse
                                // qty so the displayed total reflects current stock, not stale amount.
                                const totalQty = getPhysicalWarehouseUnits(item);
                                const unit = resolveInventoryUnitCost(item);
                                const valueStock = getInventoryTotalValue({
                                  cost: unit > 0 ? unit : null,
                                  amount: null,
                                  units: totalQty,
                                }) ?? 0;
                                return valueStock > 0
                                  ? `$${valueStock.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : '—';
                              })()}
                            </td>
                            <td className="px-1 py-2 text-xs">
                              {roi != null ? (
                                <button
                                  onClick={() => {
                                    setSelectedRoiItem(item);
                                    setRoiDialogOpen(true);
                                  }}
                                  className={cn(
                                    "font-semibold hover:underline",
                                    roi >= 30 ? "text-green-500" : roi < 0 ? "text-red-500" : ""
                                  )}
                                  title={
                                    resolveFees(item)
                                      ? "Actual ROI using cached Amazon fees — click to open calculator"
                                      : "Estimated ROI (no cached Amazon fees yet — assumes a flat 15% referral fee). Click to open the calculator for exact fees."
                                  }
                                >
                                  {resolveFees(item) ? '' : '~'}{roi.toFixed(0)}%
                                </button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 gap-1"
                                  onClick={() => {
                                    setSelectedRoiItem(item);
                                    setRoiDialogOpen(true);
                                  }}
                                  title="No cost set yet — open the calculator to enter cost and check ROI"
                                >
                                  <Calculator className="h-3 w-3" />
                                </Button>
                              )}
                            </td>
                            <td className="px-1 py-2 text-center text-xs">{item.available ?? 0}</td>
                            <td className="px-1 py-2 text-center text-xs">{item.reserved ?? 0}</td>
                            <td className="px-1 py-2 text-center text-xs">{item.inbound ?? 0}</td>
                            <td className="px-1 py-2 text-center text-xs">{item.unfulfilled ?? 0}</td>
                            {/* 30d Sales, ADS, Days Cover, Replenish cells hidden */}
                            {/* Attention Score Column - Only shown when slow-selling filter active */}
                            {stockFilter === 'slow-selling' && (
                              <td className="px-1 py-2 text-center text-xs">
                                {(() => {
                                  const metrics = calculateSlowSellingMetrics(item, salesPeriodDays);
                                  if (metrics.attentionScore === 0) {
                                    return <span className="text-muted-foreground">—</span>;
                                  }
                                  // Color coding based on severity
                                  const scoreClass = metrics.attentionScore >= 50 
                                    ? "text-red-600 dark:text-red-400 bg-red-500/20"
                                    : metrics.attentionScore >= 25 
                                      ? "text-amber-600 dark:text-amber-400 bg-amber-500/20"
                                      : "text-muted-foreground";
                                  
                                  return (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium ${scoreClass}`}>
                                            <AlertTriangle className="h-3 w-3" />
                                            {metrics.attentionScore}
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent side="left" className="max-w-xs">
                                          <div className="space-y-1">
                                            <p className="font-semibold text-amber-500">Why this item needs attention:</p>
                                            <ul className="text-xs space-y-1">
                                              {metrics.flags.map((flag, idx) => (
                                                <li key={idx} className="flex items-start gap-1">
                                                  <span className="text-amber-500">•</span>
                                                  <span>{flag}</span>
                                                </li>
                                              ))}
                                            </ul>
                                            <div className="pt-2 border-t mt-2 text-xs text-muted-foreground">
                                              <p>Available: {metrics.availableStock} units</p>
                                              <p>ADS: {metrics.ads30.toFixed(2)}/day</p>
                                              <p>Days Cover: {metrics.daysOfCover ?? '∞'}</p>
                                            </div>
                                          </div>
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  );
                                })()}
                              </td>
                            )}
                            {/* BSR cell hidden */}
                            <td className="px-1 py-2 text-center text-xs">
                              {parseListingDate(item.listing_created_at)
                                ? parseListingDate(item.listing_created_at)!.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                                : <span className="text-muted-foreground">—</span>
                              }
                            </td>
                            <td className="px-1 py-2 text-center text-xs">
                              {(() => {
                                const stockTs = item.last_summaries_at || item.last_inventory_sync_at;
                                if (!stockTs) return <span className="text-muted-foreground">—</span>;
                                const fresh = getSyncFreshness(stockTs);
                                const dotColor = fresh.label === 'Fresh' ? 'bg-emerald-500' : fresh.label === 'Aging' ? 'bg-amber-500' : 'bg-destructive';
                                return (
                                  <div
                                    className="inline-flex items-center gap-1.5"
                                    title={`Stock synced: ${new Date(stockTs).toLocaleString()}${item.last_summaries_at ? ' (Summaries API)' : ' (Report)'}`}
                                  >
                                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                    <span>{formatSyncTime(stockTs)}</span>
                                  </div>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                
                {/* Pagination Controls */}
                <div className="mt-6 flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                  >
                    Previous
                  </Button>
                  
                  <div className="flex items-center gap-2 mx-4">
                    <span className="text-sm text-white font-medium">
                      Page {currentPage} of {totalPages} ({sortedInventory.length} total items)
                    </span>
                  </div>
                  
                  <Button
                    variant="outline"
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </div>
        </main>
        <Footer />
      </div>
      
      {/* Lazy-loaded heavy dialogs (mount only when opened to keep initial mobile bundle small) */}
      <Suspense fallback={null}>
        {selectedRoiItem && roiDialogOpen && (
          <ActualRoiCalculatorDialog
            open={roiDialogOpen}
            onOpenChange={setRoiDialogOpen}
            asin={selectedRoiItem.asin}
            unitCost={selectedRoiItem.unit_cost}
            productTitle={selectedRoiItem.title}
            imageUrl={selectedRoiItem.image_url}
            currentPrice={selectedRoiItem.price}
            skipKeepa
          />
        )}

        {shipmentBuilderOpen && (
          <ReplenishmentShipmentBuilder
            open={shipmentBuilderOpen}
            onOpenChange={setShipmentBuilderOpen}
            items={shipmentItems}
            onUpdateQty={handleUpdateShipmentQty}
            onRemoveItem={handleRemoveFromShipment}
            initialDraft={draftToLoad}
          />
        )}
      </Suspense>

      {/* Load Draft Dialog */}
      <Dialog open={loadDraftDialogOpen} onOpenChange={setLoadDraftDialogOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Load Saved Draft</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {savedDrafts.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No saved drafts</p>
            ) : (
              savedDrafts.map((draft) => (
                <Card key={draft.id} className="p-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{draft.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {draft.products.length} products • Step: {draft.step} • {new Date(draft.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleLoadDraft(draft)}
                    >
                      Load
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteDraft(draft.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Missing Valuation Dialog (lazy + mount on open) */}
      <Suspense fallback={null}>
        {missingValuationOpen && (
          <MissingValuationDialog
            open={missingValuationOpen}
            onOpenChange={setMissingValuationOpen}
            items={filteredInventory
              .filter(item => {
                const totalQty = (item.available || 0) + (item.reserved || 0) + (item.inbound || 0);
                return totalQty > 0 && (!item.unit_cost || item.unit_cost <= 0);
              })
              .map(item => ({
                id: item.id,
                asin: item.asin,
                sku: item.sku,
                title: item.title,
                totalQty: (item.available || 0) + (item.reserved || 0) + (item.inbound || 0),
                available: item.available || 0,
                reserved: item.reserved || 0,
                inbound: item.inbound || 0,
                unitCost: item.unit_cost,
                costSource: item.unit_cost ? 'inventory' : 'missing',
                price: item.price,
              }))}
            onCostSaved={fetchInventory}
          />
        )}
      </Suspense>

    </>
  );
}
