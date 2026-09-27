import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { computeReplenishmentBreakdown, type ReplenishmentBreakdown } from "@/lib/replenishment";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShoppingCart, ExternalLink, Loader2, Package, Search, RefreshCw, AlertTriangle, Copy } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ReorderPlanningPanel, {
  DEFAULT_REORDER_SETTINGS,
  type ReorderPlanningSettings,
} from "@/components/inventory/ReorderPlanningPanel";
import { calculateEstimatedFeesFromCache } from "@/lib/salesCalculations";
import { getInventoryUnitCostSafe } from "@/lib/cost-contract";

// Deliberately narrower than the canonical public.is_ghost_inventory_row()
// SQL function used elsewhere (active_inventory / active_created_listings):
// that function also treats zero-stock + non-"ACTIVE" listing_status as a
// ghost, which is right for a general inventory view but wrong here -- this
// page's entire purpose is surfacing real items that are *currently out of
// stock* and need restocking, and listing_status isn't reliably kept fresh
// enough to gate that safely. Only exclude rows that are definitively,
// explicitly confirmed dead.
const isHiddenInSyncedInventory = (item: { listing_status?: string | null; sku?: string | null }) => {
  const ls = (item.listing_status || "").toUpperCase();
  return ls === "NOT_IN_CATALOG" || ls === "DELETED" || (item.sku || "").toLowerCase().startsWith("amzn.gr.");
};

interface RoiInfo {
  price: number | null;
  cost: number | null;
  fees: number | null;
  profit: number | null;
  roi: number | null; // percent
  available: boolean;
}

/** Fetch all rows, bypassing the 1000-row default limit */
async function fetchAllPaged(
  buildQuery: (from: number, to: number) => any
): Promise<any[]> {
  const PAGE = 1000;
  let all: any[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await buildQuery(offset, offset + PAGE - 1);
    if (error) throw error;
    if (data && data.length > 0) {
      all = all.concat(data);
      offset += PAGE;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }
  return all;
}

interface ReplenishItem {
  asin: string;
  title: string;
  image_url: string | null;
  supplierLinks: Array<{ link: string; discount_code: string }>;
  available: number;
  inbound: number;
  reserved: number;
  sales7d: number;
  sales30d: number;
  sales90d: number;
  breakdown: ReplenishmentBreakdown;
  roi: RoiInfo;
}

const RISK_BADGE: Record<ReplenishmentBreakdown["riskLevel"], string> = {
  critical: "bg-destructive text-destructive-foreground",
  high:     "bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30",
  medium:   "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30",
  low:      "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30",
  unknown:  "bg-muted text-muted-foreground border border-border",
};

export default function NeedBuyAgain() {
  const { user } = useAuth();
  const userId = user?.id;
  const [items, setItems] = useState<ReplenishItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [settings, setSettings] = useState<ReorderPlanningSettings>(DEFAULT_REORDER_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [reorderStatusFilter, setReorderStatusFilter] = useState<"all" | "now" | "soon" | "low">("all");
  const [minRoiFilter, setMinRoiFilter] = useState<"all" | "0" | "10" | "20" | "30" | "50">("all");
  const [hideNegativeRoi, setHideNegativeRoi] = useState(false);
  const [imagesEnriching, setImagesEnriching] = useState(false);
  const imageEnrichAttemptedRef = useRef(false);

  // Load saved settings (or fall back to defaults)
  useEffect(() => {
    if (!userId) return;
    (async () => {
      const { data } = await supabase
        .from("reorder_planning_settings")
        .select("coverage_days, supplier_lead_time_days, prep_days, shipping_to_amazon_days, amazon_receiving_days, safety_percent")
        .eq("user_id", userId)
        .maybeSingle();
      if (data) setSettings(data as ReorderPlanningSettings);
      setSettingsLoaded(true);
    })();
  }, [userId]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    let result = items;
    if (reorderStatusFilter !== "all") {
      result = result.filter((item) => {
        const r = item.breakdown.riskLevel;
        if (reorderStatusFilter === "now") return r === "critical";
        if (reorderStatusFilter === "soon") return r === "high" || r === "medium";
        if (reorderStatusFilter === "low") return r === "low";
        return true;
      });
    }
    if (hideNegativeRoi) {
      result = result.filter((item) => item.roi.roi === null || item.roi.roi >= 0);
    }
    if (minRoiFilter !== "all") {
      const threshold = parseFloat(minRoiFilter);
      result = result.filter((item) => item.roi.roi !== null && item.roi.roi >= threshold);
    }
    if (q) {
      // Support comma/space/newline separated ASIN lists for bulk filtering
      const tokens = q.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
      if (tokens.length > 1) {
        const set = new Set(tokens);
        result = result.filter((item) => set.has(item.asin.toUpperCase()));
      } else {
        result = result.filter(
          (item) =>
            item.asin.toUpperCase().includes(q) ||
            item.title.toUpperCase().includes(q)
        );
      }
    }
    return result;
  }, [items, searchQuery, reorderStatusFilter, minRoiFilter, hideNegativeRoi]);

  const fetchReplenishData = async (overrideSettings?: ReorderPlanningSettings) => {
    if (!userId) return;
    const cfg = overrideSettings ?? settings;

    setLoading(true);
    try {
      const today = new Date();
      const periodStartDate = new Date();
      periodStartDate.setDate(periodStartDate.getDate() - 30);
      const periodStartStr = periodStartDate.toISOString().split("T")[0];

      const [inventoryData, recentSalesData, historicalSalesData, listingsData, feeCacheData, shipmentsData, shipmentItemsData] = await Promise.all([
        fetchAllPaged((from, to) =>
          supabase.from("inventory")
            .select("asin, title, image_url, available, inbound, reserved, sku, amazon_price, my_price, price, cost, amount, units, listing_status")
            .eq("user_id", userId)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("sales_orders")
            .select("asin, quantity, order_date")
            .eq("user_id", userId)
            .gte("order_date", periodStartStr)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("sales_orders")
            .select("asin, quantity, order_date")
            .eq("user_id", userId)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          // Deliberately reads created_listings directly instead of the
          // active_created_listings view. That view's ghost check also
          // excludes rows whose linked inventory shows zero stock with a
          // non-"ACTIVE" status (confirmed: 6,253 of 8,446 created_listings
          // rows excluded for this account, 74%) -- correct for most
          // consumers, but wrong here: this page's supplier-link/image/cost
          // fallback data must survive for exactly the currently-out-of-
          // stock items it exists to surface (e.g. every "Wilson" SKU was
          // silently dropped this way). Only the validation-status gate is
          // applied; isHiddenInSyncedInventory below still excludes
          // genuinely dead rows from the final result.
          supabase.from("created_listings")
            .select("asin, sku, title, supplier_links, image_url, amount, cost, units, updated_at, validation_status")
            .or("validation_status.is.null,validation_status.eq.ACTIVE")
            .eq("user_id", userId)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("asin_fee_cache")
            .select("asin, marketplace, fba_fee_fixed, referral_rate, is_media")
            .eq("user_id", userId)
            .eq("marketplace", "US")
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("fba_shipments")
            .select("shipment_id, received_date")
            .eq("user_id", userId)
            .not("received_date", "is", null)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("fba_shipment_items")
            .select("shipment_id, asin, quantity_received")
            .eq("user_id", userId)
            .gt("quantity_received", 0)
            .range(from, to)
        ),
      ]);

      // Most recent FBA received_date per ASIN, used to judge whether current
      // Reserved units are likely still checking in from a recent shipment
      // (see reservedFreshDays in computeReplenishmentBreakdown) or long
      // enough since any receiving that they're more likely already sold.
      const receivedDateByShipment = new Map<string, string>();
      for (const s of shipmentsData) {
        if (s.shipment_id && s.received_date) receivedDateByShipment.set(s.shipment_id, s.received_date);
      }
      const lastReceivedByAsin = new Map<string, string>();
      for (const si of shipmentItemsData) {
        if (!si.asin) continue;
        const receivedDate = receivedDateByShipment.get(si.shipment_id);
        if (!receivedDate) continue;
        const existing = lastReceivedByAsin.get(si.asin);
        if (!existing || receivedDate > existing) lastReceivedByAsin.set(si.asin, receivedDate);
      }

      // Build fee cache map (ASIN -> FeeCache)
      const feeCacheMap = new Map<string, { fbaFeeFixed: number; referralRate: number; isMedia: boolean }>();
      for (const f of feeCacheData) {
        if (!f.asin) continue;
        feeCacheMap.set(f.asin, {
          fbaFeeFixed: Number(f.fba_fee_fixed) || 0,
          referralRate: Number(f.referral_rate) || 0,
          isMedia: !!f.is_media,
        });
      }

      /**
       * COG ON RECORD FIRST (2026-09-27).
       *
       * This page showed "Cost: $589.10" against a $26.00 sale price and an
       * ROI of -97%, because inventory.cost holds what a BATCH cost, not what
       * one unit cost. Reported on B09SYRPK9K.
       *
       * Every other surface — repricer, Inventory Valuation, Shipment Builder
       * — reads the seller's single COG per ASIN through asin_cog_for_repricer,
       * which already drops flagged and placeholder costs. Reading anything
       * else here is how two pages end up quoting different costs for the same
       * product.
       *
       * Paged deliberately: PostgREST caps a response at 1,000 rows whatever
       * .limit() says, and a short read here silently prices stock from the
       * wrong source rather than failing.
       */
      const cogMap = new Map<string, number>();
      {
        const PAGE = 1000;
        for (let from = 0; from < 50 * PAGE; from += PAGE) {
          const { data: cogRows, error: cogErr } = await supabase
            .from("asin_cog_for_repricer")
            .select("asin, unit_cost")
            .eq("user_id", user.id)
            .not("unit_cost", "is", null)
            .range(from, from + PAGE - 1);
          if (cogErr) { console.warn("[NeedBuyAgain] COG read failed:", cogErr.message); break; }
          if (!cogRows) break;
          for (const row of cogRows as { asin: string; unit_cost: number }[]) {
            const c = Number(row.unit_cost);
            if (row.asin && Number.isFinite(c) && c > 0 && !cogMap.has(row.asin)) cogMap.set(row.asin, c);
          }
          if (cogRows.length < PAGE) break;
        }
      }

      // Build cost map from created_listings (Contract A: amount = unit, cost/units = derived)
      // Pick most recently updated entry per ASIN.
      const listingCostMap = new Map<string, number>();
      const sortedListings = [...listingsData].sort((a, b) => {
        const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return bt - at;
      });
      for (const row of sortedListings) {
        if (!row.asin || listingCostMap.has(row.asin)) continue;
        let unitCost = 0;
        if (row.amount != null && Number(row.amount) >= 0) {
          unitCost = Number(row.amount);
        } else if (Number(row.cost) > 0 && Number(row.units) > 0) {
          unitCost = Number(row.cost) / Number(row.units);
        }
        if (unitCost > 0) listingCostMap.set(row.asin, unitCost);
      }

      const getDaysSince = (dateStr: string) => {
        const date = new Date(dateStr);
        const diffMs = today.getTime() - date.getTime();
        return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      };

      const recentSalesMap = new Map<string, { units: number; earliestOrderDate: string }>();
      for (const row of recentSalesData) {
        if (!row.asin || row.asin === "PENDING") continue;
        const qty = row.quantity || 1;
        const existing = recentSalesMap.get(row.asin);
        if (existing) {
          existing.units += qty;
          if (row.order_date < existing.earliestOrderDate) existing.earliestOrderDate = row.order_date;
        } else {
          recentSalesMap.set(row.asin, { units: qty, earliestOrderDate: row.order_date });
        }
      }

      const historicalSalesMap = new Map<string, { totalUnits: number; earliestDate: string }>();
      const salesBuckets = new Map<string, { d7: number; d30: number; d90: number }>();
      const now7 = new Date(); now7.setDate(now7.getDate() - 7);
      const now30 = new Date(); now30.setDate(now30.getDate() - 30);
      const now90 = new Date(); now90.setDate(now90.getDate() - 90);
      const cutoff7 = now7.toISOString().split("T")[0];
      const cutoff30 = now30.toISOString().split("T")[0];
      const cutoff90 = now90.toISOString().split("T")[0];

      for (const row of historicalSalesData) {
        if (!row.asin || row.asin === "PENDING") continue;
        const qty = row.quantity || 1;
        const existing = historicalSalesMap.get(row.asin);
        if (existing) {
          existing.totalUnits += qty;
          if (row.order_date < existing.earliestDate) existing.earliestDate = row.order_date;
        } else {
          historicalSalesMap.set(row.asin, { totalUnits: qty, earliestDate: row.order_date });
        }

        if (!salesBuckets.has(row.asin)) salesBuckets.set(row.asin, { d7: 0, d30: 0, d90: 0 });
        const b = salesBuckets.get(row.asin)!;
        if (row.order_date >= cutoff7) b.d7 += qty;
        if (row.order_date >= cutoff30) b.d30 += qty;
        if (row.order_date >= cutoff90) b.d90 += qty;
      }

      const supplierMap = new Map<string, Array<{ link: string; discount_code: string }>>();
      const listingImageMap = new Map<string, string>();
      for (const row of listingsData) {
        if (row.supplier_links && Array.isArray(row.supplier_links) && row.supplier_links.length > 0) {
          if (!supplierMap.has(row.asin)) {
            supplierMap.set(row.asin, row.supplier_links as Array<{ link: string; discount_code: string }>);
          }
        }
        if (row.image_url && !listingImageMap.has(row.asin)) {
          listingImageMap.set(row.asin, row.image_url);
        }
      }

      const inventorySkus = new Set(inventoryData.map((item) => item.sku).filter(Boolean));
      const inventoryAsins = new Set(inventoryData.map((item) => item.asin).filter(Boolean));

      // Inventory price/cost maps (per ASIN). Prefer amazon_price > my_price > price.
      const inventoryPriceMap = new Map<string, number>();
      const inventoryCostMap = new Map<string, number>();
      for (const item of inventoryData) {
        if (!item.asin) continue;
        const p = Number(item.amazon_price) > 0
          ? Number(item.amazon_price)
          : Number(item.my_price) > 0
          ? Number(item.my_price)
          : Number(item.price) > 0
          ? Number(item.price)
          : 0;
        if (p > 0) {
          const prev = inventoryPriceMap.get(item.asin) ?? 0;
          if (p > prev) inventoryPriceMap.set(item.asin, p);
        }
        // inventory.cost is NOT reliably a unit cost: created_listings and
        // inventory disagree about whether cost or amount is the total, which
        // is why $589.10 (a batch) was shown against a $26.00 sale price.
        // getInventoryUnitCostSafe is the shared arbiter -- it cross-checks
        // cost against amount x units and returns null rather than guessing
        // when the two cannot both be true.
        const c = getInventoryUnitCostSafe({ cost: item.cost, amount: item.amount, units: item.units }) ?? 0;
        if (c > 0 && !inventoryCostMap.has(item.asin)) inventoryCostMap.set(item.asin, c);
      }

      const createdListingsToAdd = listingsData.filter((listing) =>
        listing.asin && !inventoryAsins.has(listing.asin) && !inventorySkus.has(listing.sku)
      );

      const combinedItems = [
        ...inventoryData.map((item) => ({
          asin: item.asin,
          sku: item.sku,
          listing_status: item.listing_status,
          title: item.title,
          image_url: item.image_url || listingImageMap.get(item.asin) || null,
          available: item.available ?? 0,
          inbound: item.inbound ?? 0,
          reserved: item.reserved ?? 0,
          supplierLinks: supplierMap.get(item.asin) || [],
        })),
        ...createdListingsToAdd.map((item) => ({
          asin: item.asin,
          sku: item.sku,
          listing_status: null,
          title: item.title,
          image_url: item.image_url || listingImageMap.get(item.asin) || null,
          available: 0,
          inbound: 0,
          reserved: 0,
          supplierLinks: supplierMap.get(item.asin) || [],
        })),
      ];

      const groupedItems = new Map<string, typeof combinedItems[number]>();
      for (const item of combinedItems) {
        const key = item.asin;
        const existing = groupedItems.get(key);
        if (existing) {
          existing.available += item.available;
          existing.inbound += item.inbound;
          existing.reserved += item.reserved;
          if ((!existing.title || existing.title === "Untitled Product") && item.title) existing.title = item.title;
          if (!existing.image_url && item.image_url) existing.image_url = item.image_url;
          if (existing.supplierLinks.length === 0 && item.supplierLinks.length > 0) {
            existing.supplierLinks = item.supplierLinks;
          }
        } else {
          groupedItems.set(key, { ...item });
        }
      }

      const replenishItems: ReplenishItem[] = [];
      for (const item of groupedItems.values()) {
        if (isHiddenInSyncedInventory(item)) continue;

        const recentSales = recentSalesMap.get(item.asin);
        const actualSalesPeriod = recentSales
          ? Math.min(30, getDaysSince(recentSales.earliestOrderDate))
          : 30;
        const historicalSales = historicalSalesMap.get(item.asin);
        const lastReceived = lastReceivedByAsin.get(item.asin);

        const breakdown = computeReplenishmentBreakdown({
          salesUnits: recentSales?.units ?? 0,
          salesPeriodDays: actualSalesPeriod,
          available: item.available,
          inbound: item.inbound,
          reserved: item.reserved,
          coverageDays: cfg.coverage_days,
          safetyPercent: (cfg.safety_percent || 0) / 100,
          supplierLeadTimeDays: cfg.supplier_lead_time_days,
          prepDays: cfg.prep_days,
          shippingToAmazonDays: cfg.shipping_to_amazon_days,
          amazonReceivingDays: cfg.amazon_receiving_days,
          daysSinceLastReceived: lastReceived ? getDaysSince(lastReceived) : null,
          historicalSalesUnits: historicalSales?.totalUnits,
          historicalDays: historicalSales ? getDaysSince(historicalSales.earliestDate) : undefined,
        });

        if (breakdown.replenishQty > 0 || breakdown.riskLevel === "critical") {
          const bucket = salesBuckets.get(item.asin);

          // Compute ROI from current Amazon price, fee cache, and unit cost
          const price = inventoryPriceMap.get(item.asin) ?? null;
          // COG on record wins, then the purchase record, then inventory --
          // the same order the repricer and Inventory Valuation use.
          const cost = cogMap.get(item.asin)
            ?? listingCostMap.get(item.asin)
            ?? inventoryCostMap.get(item.asin)
            ?? null;
          const feeCache = feeCacheMap.get(item.asin) ?? null;
          let roiInfo: RoiInfo;
          if (price && price > 0 && cost && cost > 0 && feeCache) {
            const fees = calculateEstimatedFeesFromCache(price, 1, feeCache);
            if (fees) {
              const profit = price - fees.totalFees - cost;
              const roi = (profit / cost) * 100;
              roiInfo = {
                price, cost, fees: fees.totalFees, profit,
                roi: Math.round(roi * 10) / 10,
                available: true,
              };
            } else {
              roiInfo = { price, cost, fees: null, profit: null, roi: null, available: false };
            }
          } else {
            roiInfo = { price, cost, fees: null, profit: null, roi: null, available: false };
          }

          replenishItems.push({
            asin: item.asin,
            title: item.title,
            image_url: item.image_url,
            supplierLinks: item.supplierLinks,
            available: item.available,
            inbound: item.inbound,
            reserved: item.reserved,
            sales7d: bucket?.d7 ?? 0,
            sales30d: bucket?.d30 ?? 0,
            sales90d: bucket?.d90 ?? 0,
            breakdown,
            roi: roiInfo,
          });
        }
      }

      // Critical first, then by buy quantity desc
      const riskOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
      replenishItems.sort((a, b) => {
        const r = riskOrder[a.breakdown.riskLevel] - riskOrder[b.breakdown.riskLevel];
        if (r !== 0) return r;
        return b.breakdown.replenishQty - a.breakdown.replenishQty;
      });
      setItems(replenishItems);
      setLastFetchedAt(new Date());
    } catch (err) {
      console.error("Failed to fetch replenish data:", err);
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch once settings are loaded
  useEffect(() => {
    if (userId && settingsLoaded && items.length === 0 && !lastFetchedAt) {
      fetchReplenishData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, settingsLoaded]);

  // Every ASIN shown here should have a real product image, not the generic
  // package-icon placeholder. Once the list loads, quietly fetch any missing
  // images from Amazon's catalog for exactly the ASINs on screen (bounded to
  // this list, not an account-wide scan) and refresh in place. Runs once per
  // successful load -- the refetch below re-populates `items`, which would
  // otherwise re-trigger this effect in a loop.
  useEffect(() => {
    if (!lastFetchedAt || imageEnrichAttemptedRef.current || items.length === 0) return;
    const missingImageAsins = [...new Set(items.filter((i) => !i.image_url).map((i) => i.asin))];
    if (missingImageAsins.length === 0) return;
    imageEnrichAttemptedRef.current = true;
    (async () => {
      setImagesEnriching(true);
      try {
        const { data, error } = await supabase.functions.invoke("enrich-missing-titles", {
          body: { asins: missingImageAsins },
        });
        if (error) throw error;
        if ((data as any)?.enriched > 0) {
          await fetchReplenishData();
        }
      } catch (err) {
        console.error("Failed to enrich missing images:", err);
      } finally {
        setImagesEnriching(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFetchedAt]);

  const handleSettingsChange = (next: ReorderPlanningSettings) => {
    setSettings(next);
    fetchReplenishData(next);
  };

  const extractDomain = (url: string) => {
    try { return new URL(url).hostname.replace("www.", ""); }
    catch { return url.slice(0, 30); }
  };

  return (
    <>
      <Helmet>
        <title>Need to Buy Again | Repricer</title>
      </Helmet>
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 container max-w-6xl mx-auto py-8 px-4">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <ShoppingCart className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Need to Buy Again</h1>
              {!loading && (
                <span className="text-sm font-normal text-muted-foreground">
                  ({items.length} items)
                </span>
              )}
              {imagesEnriching && (
                <span className="text-xs font-normal text-muted-foreground inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Fetching missing images…
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {lastFetchedAt && (
                <span className="text-xs text-muted-foreground">
                  Last refreshed: {lastFetchedAt.toLocaleTimeString()}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchReplenishData()}
                disabled={loading}
                className="gap-1.5"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh Data
              </Button>
            </div>
          </div>

          {userId && (
            <ReorderPlanningPanel userId={userId} value={settings} onChange={handleSettingsChange} />
          )}

          {!loading && items.length > 0 && (
            <div className="flex flex-col sm:flex-row gap-2 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by ASIN/title — or paste multiple ASINs (comma, space, or newline separated)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={reorderStatusFilter} onValueChange={(v) => setReorderStatusFilter(v as typeof reorderStatusFilter)}>
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue placeholder="Reorder Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="now">Order Now (Critical)</SelectItem>
                  <SelectItem value="soon">Order Soon (High + Medium)</SelectItem>
                  <SelectItem value="low">Low Priority</SelectItem>
                </SelectContent>
              </Select>
              <Select value={minRoiFilter} onValueChange={(v) => setMinRoiFilter(v as typeof minRoiFilter)}>
                <SelectTrigger className="w-full sm:w-[160px]">
                  <SelectValue placeholder="Min ROI" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any ROI</SelectItem>
                  <SelectItem value="0">ROI ≥ 0%</SelectItem>
                  <SelectItem value="10">ROI ≥ 10%</SelectItem>
                  <SelectItem value="20">ROI ≥ 20%</SelectItem>
                  <SelectItem value="30">ROI ≥ 30%</SelectItem>
                  <SelectItem value="50">ROI ≥ 50%</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-xs text-muted-foreground select-none px-2 border border-border/60 rounded-md cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideNegativeRoi}
                  onChange={(e) => setHideNegativeRoi(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Hide negative ROI
              </label>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="ml-3 text-muted-foreground">Calculating replenishment...</span>
            </div>
          ) : items.length === 0 && !lastFetchedAt ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Package className="h-12 w-12 mb-3 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground mb-4">Click below to calculate which products need restocking</p>
              <Button onClick={() => fetchReplenishData()} className="gap-2">
                <ShoppingCart className="h-4 w-4" />
                Calculate Replenishment
              </Button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Package className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">{searchQuery ? "No items match your search" : "All products are sufficiently stocked!"}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item, index) => {
                const b = item.breakdown;
                const dus = b.daysUntilStockout;
                const dusLabel = dus === null ? "—" : `${Math.max(0, Math.round(dus))}d`;
                return (
                  <div
                    key={`${item.asin}-${index}`}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border/60 bg-card/50 hover:bg-accent/30 transition-colors"
                  >
                    <div className="w-14 h-14 flex-shrink-0 rounded-md overflow-hidden bg-muted/30 flex items-center justify-center">
                      {item.image_url ? (
                        <img src={item.image_url} alt={item.title} className="w-full h-full object-contain" loading="lazy" />
                      ) : (
                        <Package className="h-6 w-6 text-muted-foreground/40" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" title={item.title}>{item.title}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                        <span className="inline-flex items-center gap-1">
                          <a
                            href={`https://www.amazon.com/dp/${item.asin}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-mono text-primary hover:underline"
                          >
                            {item.asin}
                          </a>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.asin);
                              toast.success(`Copied ${item.asin}`);
                            }}
                            className="inline-flex items-center justify-center rounded p-0.5 hover:bg-muted transition-colors"
                            title="Copy ASIN"
                          >
                            <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                          </button>
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Stock:{" "}
                          <span className="text-sm font-bold tabular-nums text-foreground">{item.available}</span> avail /{" "}
                          <span className="text-sm font-bold tabular-nums text-foreground">{item.inbound}</span> inbound /{" "}
                          <span className="text-sm font-bold tabular-nums text-foreground">{item.reserved}</span> reserved
                          {b.reservedExcluded && (
                            <span
                              className="ml-1 text-amber-600 dark:text-amber-400"
                              title="No shipment received in over 7 days — Reserved is treated as already sold to a customer, not counted toward future stock coverage."
                            >
                              (treated as sold)
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Sales:{" "}
                          <span className="text-sm font-bold tabular-nums text-foreground">{item.sales7d}</span><span className="text-[11px] text-muted-foreground">·7d</span>{" "}
                          <span className="text-sm font-bold tabular-nums text-foreground">{item.sales30d}</span><span className="text-[11px] text-muted-foreground">·30d</span>{" "}
                          <span className="text-sm font-bold tabular-nums text-foreground">{item.sales90d}</span><span className="text-[11px] text-muted-foreground">·90d</span>
                        </span>
                      </div>

                      {/* Lead-time aware metrics */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2">
                        <Metric label="Days until stockout" value={dusLabel}
                          highlight={b.riskLevel === 'critical' || b.riskLevel === 'high'} />
                        <Metric label="Lead time" value={`${b.totalLeadTimeDays}d`} />
                        <Metric label="Coverage" value={`${(b.planningDays - b.totalLeadTimeDays)}d`} />
                        <Metric label="ADS" value={b.ads.toFixed(2)} />
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${RISK_BADGE[b.riskLevel]}`}>
                          {b.riskLevel === 'critical' && <AlertTriangle className="h-3 w-3" />}
                          {b.riskLabel}
                        </span>
                      </div>

                      {/* ROI metrics */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2">
                        {item.roi.available && item.roi.roi !== null ? (
                          <>
                            <Metric label="Price" value={`$${item.roi.price!.toFixed(2)}`} />
                            <Metric label="Cost" value={`$${item.roi.cost!.toFixed(2)}`} />
                            <Metric label="Fees" value={`$${item.roi.fees!.toFixed(2)}`} />
                            <Metric
                              label="Profit/u"
                              value={`$${item.roi.profit!.toFixed(2)}`}
                              highlight={item.roi.profit! < 0}
                            />
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums ${
                              item.roi.roi < 0
                                ? 'bg-destructive/15 text-destructive border border-destructive/30'
                                : item.roi.roi < 10
                                ? 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30'
                                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                            }`}>
                              ROI {item.roi.roi.toFixed(1)}%
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground/70 italic">
                            ROI unavailable {item.roi.cost == null ? '(no cost)' : item.roi.price == null ? '(no Amazon price)' : '(no fee data)'}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Supplier:</span>
                        {item.supplierLinks.length > 0 ? (
                          item.supplierLinks.map((sl, idx) => (
                            <a
                              key={idx}
                              href={sl.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                            >
                              {extractDomain(sl.link)}
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground/60 italic">No supplier link</span>
                        )}
                      </div>
                    </div>

                    <div className="flex-shrink-0 text-center">
                      <div className={`font-bold text-lg px-3 py-1 rounded-lg min-w-[60px] ${
                        b.riskLevel === 'critical'
                          ? 'bg-destructive/15 text-destructive'
                          : 'bg-primary/10 text-primary'
                      }`}>
                        {b.replenishQty}
                      </div>
                      <span className="text-[10px] text-muted-foreground">to order</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
        <Footer />
      </div>
    </>
  );
}

/**
 * Label quiet, number loud (2026-09-27).
 *
 * Every figure on this card was 11px in the same weight as its label, so the
 * numbers a reorder decision rests on — days of stock, cost, profit — read as
 * body text. The label is the part you already know; the value is the part you
 * are scanning for, so it gets the size (14px), the weight (bold) and
 * tabular-nums, which keeps columns of digits aligned across rows.
 */
function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[11px] text-muted-foreground">{label}:</span>
      <span className={`text-sm font-bold tabular-nums ${highlight ? 'text-destructive' : 'text-foreground'}`}>{value}</span>
    </span>
  );
}
