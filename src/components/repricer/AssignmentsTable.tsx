import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { triggerAutoOnboard } from "@/lib/autoOnboard";
import { useAuth } from "@/contexts/AuthContext";
import { useSalesSync } from "@/contexts/SalesSyncContext";
import { useRepricerCache } from "@/hooks/use-repricer-cache";
import { useSubscription } from "@/hooks/use-subscription";
import { withTimeout } from "@/hooks/use-db-pressure";
import { deriveAssignmentStatus, isManuallyPaused } from "@/lib/repricer/assignmentStatus";
import { getListingUnitCost } from "@/lib/cost-contract";
import { calcRoiAtPrice, getOtherFixedFees } from "@/lib/roiCalc";
import { useAsinPurchaseRecords } from "@/hooks/use-asin-purchase-records";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import AutoLowerMinToggle from "./AutoLowerMinToggle";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { toast } from "sonner";
import { setAppBusy } from "@/lib/appBusy";
import {
  RefreshCw,
  Search,
  Package,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Play,
  Pause,
  Truck,
  Store,
  ChevronLeft,
  ChevronRight,
  Zap,
  Copy,
  Globe,
  History,
  RotateCcw,
  AlertTriangle,
  PauseCircle,
  PlayCircle,
  Star,
  Users,
  Lightbulb,
  Ban,
  Brain,
  CheckSquare,
  Check,
  Settings2,
  DollarSign,
  Loader2,
  Trash2,
  Lock,
  Unlock,
  TrendingUp,
} from "lucide-react";
import type { RepricerRule } from "./RuleBuilder";
import { resolveRuleMinRoiEnabledForMarketplace } from "./RuleBuilder";
import { getMarketplaceConfig, formatPrice, MARKETPLACE_LIST } from "@/lib/marketplaceCurrency";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import ActionLogDialog, { SafeguardBadge } from "./ActionLogDialog";
import { calculateReplenishQty } from "@/lib/replenishment";
import { logSettingChange } from "@/lib/repricerChangeLog";

import SuggestionReviewPanel from "./SuggestionReviewPanel";
import SmartSuggestionBanner, { detectSuggestion } from "./SmartSuggestionBanner";
import { type EvalMode, type ActiveEvalMode } from "./EvalModeBadge";
import ListingVerificationDialog from "./ListingVerificationDialog";
import LiveSalesPopup from "./LiveSalesPopup";
import { MinMaxPriceCells } from "./MinMaxPriceCells";
import { evaluateSellability } from "@/lib/marketplace/isSellable";

interface InventoryWithAssignment {
  id: string;
  asin: string;
  sku: string;
  title: string;
  image_url: string | null;
  price: number | null;
  my_price: number | null;
  cost: number | null;
  // When the user clicks "Actual ROI" in non-US marketplaces, we store a converted cost
  // so the Cost column can display the local-currency value.
  cost_converted?: number | null;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  unfulfilled: number | null;
  listing_status: string | null;
  intl_listing_status: string | null;
  marketplace_sellable?: boolean | null;
  listing_created_at: string | null;
  source: string | null;
  fees_json: Record<string, unknown> | null;
  // Inventory min/max prices (from Amazon or manually set)
  inv_min_price: number | null;
  inv_max_price: number | null;
  // Assignment data (if exists)
  assignment_id: string | null;
  rule_id: string | null;
  saved_rule_id: string | null; // tracks the last-saved rule_id for filtering
  rule_name: string | null;
  is_enabled: boolean;
  auto_apply_enabled: boolean;
  min_price_override: number | null;
  max_price_override: number | null;
  min_roi_override: number | null;
  rule_min_roi_percent: number | null;
  rule_min_roi_enabled: boolean;
  rule_min_roi_marketplace_overrides: Record<string, number>;
  last_evaluated_at: string | null;
  last_applied_price: number | null;
  last_recommended_price: number | null;
  last_recommendation_reason: string | null;
  marketplace: string;
  // Production-readiness: Error tracking fields
  status: 'active' | 'paused';
  last_error_type: string | null;
  last_error_message: string | null;
  consecutive_failures: number;
  paused_at: string | null;
  pause_reason: string | null;
  // Global pause/audit fields (see src/lib/repricer/assignmentStatus.ts)
  manual_paused: boolean;
  last_disabled_by: string | null;
  last_disabled_reason: string | null;
  last_disabled_at: string | null;
  has_matching_inventory: boolean;
  amazon_min_price: number | null;
  amazon_max_price: number | null;
  amazon_bounds_synced_at: string | null;
  // Snapshot data
  buybox_price: number | null;
  buybox_seller_id: string | null;
  buybox_is_fba: boolean | null;
  lowest_fba_price: number | null;
  lowest_overall_price: number | null;
  offers_count: number | null;
  snapshot_fetched_at: string | null;
  // SP-API-verified buy box ownership from the assignment's own live check
  last_buybox_status: string | null;
  // Computed fields
  amazon_fees: number | null;
  bb_percentage: number | null;
  position: number | null;
  units_sold_7d: number | null;
  units_sold_30d: number | null;
  units_sold_today: number | null;
  actual_roi: number | null;
  buybox_roi: number | null;
  // Profit Guard floor
  cost_floor: number | null;
  // ROI Range (cached)
  roi_at_min_percent: number | null;
  roi_at_max_percent: number | null;
  roi_range_updated_at: string | null;
  // Replenishment data (historical sales for ADS fallback)
  historical_sales: number | null;
  historical_days: number | null;
  fulfillment_type: 'FBA' | 'FBM';
  item_condition: string | null;
  first_received_at: string | null;
  expiration_date: string | null;
  is_priority: boolean;
  is_manual_priority: boolean;
  manual_override_active: boolean;
  manual_override_checks: number;
  manual_min_price: number | null;
  assignment_created_at: string | null;
  auto_activated_at: string | null;
  auto_activated_reason: string | null;
  buybox_lost_at: string | null;
  is_restricted: boolean;
  eval_mode: EvalMode;
  active_eval_mode: ActiveEvalMode;
  eval_mode_reason: string | null;
  // Oscillation state
  rule_oscillation_mode: string | null;
  oscillation_last_mode_used: string | null;
  oscillation_last_reason: string | null;
  oscillation_state: string | null;
  oscillation_count: number;
  oscillation_reaction_count: number;
  oscillation_cooldown_until: string | null;
}

type SortKey = "available" | "title" | "asin" | "sku" | "price" | "buybox_price" | "recommended" | "cost" | "min_price" | "age" | "units_sold_today" | "replenish" | "newest";
type SortDir = "asc" | "desc";

// Normalize identifiers so searches like "B00...", ":B00...", or "B00...\n" still match.
// - Uppercase
// - Strip non-alphanumeric characters
const normalizeIdentifier = (value?: string | null) =>
  (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

interface AssignmentsTableProps {
  rules: RepricerRule[];
  marketplace?: string; // Selected marketplace filter
  onMarketplaceChange?: (marketplace: string) => void;
  isAdmin?: boolean;
  initialSearchTerm?: string; // One-time deep-link search (e.g. from a Buy Box alert)
}

// Helper: paginate supabase queries — prevents silent 1000-row truncation
const fetchAllPaged = async (baseQuery: () => any, pageSize = 1000): Promise<any[]> => {
  let from = 0;
  const all: any[] = [];
  let pages = 0;
  while (true) {
    const { data, error } = await baseQuery()
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    pages++;
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  if (pages === 1 && all.length === pageSize) {
    console.warn(`[fetchAllPaged] Query returned exactly ${pageSize} rows on first page — possible silent truncation. Total: ${all.length}`);
  }
  return all;
};

// Data fetching function — Phase 1: core data only (fast)
async function fetchRepricerData(userId: string, targetMarketplace: string): Promise<InventoryWithAssignment[]> {
  const inventorySelect =
    "id, asin, sku, title, image_url, price, my_price, cost, available, reserved, inbound, unfulfilled, listing_status, listing_created_at, source, fees_json, min_price, max_price, first_received_at, expiration_date";

  // PARALLEL: fetch inventory + assignments at the same time
  const [inventoryData, assignmentsData] = await Promise.all([
    fetchAllPaged(() => supabase.from("inventory").select(inventorySelect).eq("user_id", userId)),
    fetchAllPaged(() => supabase.from("repricer_assignments").select("*").eq("user_id", userId).eq("marketplace", targetMarketplace)),
  ]);

  console.log(`[Repricer] ${targetMarketplace}: fetched ${assignmentsData.length} assignments, ${inventoryData.length} inventory items`);

  // Create assignment maps. The DB now allows one repricer row per (user, sku, marketplace),
  // so different SKUs on the same ASIN (e.g. New vs Used) keep independent repricer state.
  // - assignmentsBySku: precise per-SKU lookup
  // - assignmentsByAsin: fallback for legacy rows that have no specific SKU match
  const assignmentsBySku: Record<string, any> = {};
  const assignmentsByAsin: Record<string, any> = {};
  for (const a of assignmentsData || []) {
    if (a.asin && a.sku) {
      assignmentsBySku[`${a.asin}-${a.sku}-${a.marketplace}`] = a;
    }
    if (a.asin && !assignmentsByAsin[`${a.asin}-${a.marketplace}`]) {
      assignmentsByAsin[`${a.asin}-${a.marketplace}`] = a;
    }
  }

  // Rules, snapshots, marketplace prices, FX rate, fee cache, and
  // created_listings enrichment are five independent steps -- each only
  // needs assignmentsData/asins, already available at this point -- but were
  // previously awaited one after another, turning what should be a handful
  // of concurrent round trips into a long sequential waterfall on every load
  // AND every marketplace switch (this same function runs for both). Run
  // them all concurrently via Promise.all below; each is defined as its own
  // async function first so the logic inside is unchanged from before.
  const ruleIds = [...new Set((assignmentsData || []).map(a => a.rule_id).filter(Boolean))];
  const asins = [...new Set((inventoryData || []).map(i => i.asin))];

  // Helper: batch .in() queries to avoid URL length limits with large inventories (3000+ ASINs).
  // Batches run concurrently too -- each targets a disjoint ASIN slice, so
  // there's no shared state to race on.
  const BATCH_IN_SIZE = 500;
  const batchInQuery = async (
    table: string,
    selectCols: string,
    inColumn: string,
    inValues: string[],
    extraFilters?: (q: any) => any
  ): Promise<any[]> => {
    const batches: string[][] = [];
    for (let i = 0; i < inValues.length; i += BATCH_IN_SIZE) {
      batches.push(inValues.slice(i, i + BATCH_IN_SIZE));
    }
    const results = await Promise.all(batches.map(async (batch) => {
      let q = (supabase as any).from(table).select(selectCols).in(inColumn, batch);
      if (extraFilters) q = extraFilters(q);
      const { data } = await q;
      return data || [];
    }));
    return results.flat();
  };

  const fetchRulesMap = async (): Promise<Record<string, any>> => {
    if (ruleIds.length === 0) return {};
    const { data: rulesData } = await supabase
      .from("repricer_rules")
      .select("*")
      .in("id", ruleIds);
    return (rulesData || []).reduce((acc: any, r: any) => ({ ...acc, [r.id]: r }), {});
  };

  const fetchSnapshotsMap = async (): Promise<Record<string, any>> => {
    const snapshotsMap: Record<string, any> = {};
    if (asins.length === 0) return snapshotsMap;
    try {
      // Six hours: long enough that an ASIN skipped for a cycle or two still
      // has a snapshot, short enough that the scan stays small. The
      // hasSnapshotSignal fallback below only walks rows already fetched, so
      // it is unaffected.
      const SNAPSHOT_WINDOW_HOURS = 6;
      const snapshotWindowStart = new Date(
        Date.now() - SNAPSHOT_WINDOW_HOURS * 60 * 60 * 1000,
      ).toISOString();

      const snapshotsData = await batchInQuery(
        "repricer_competitor_snapshots",
        "asin, marketplace, buybox_price, buybox_seller_id, buybox_is_fba, lowest_fba_price, lowest_overall_price, offers_count, fetched_at",
        "asin",
        asins,
        // SNAPSHOT_WINDOW_HOURS is what makes this query survivable; the limit
        // is now just a backstop.
        //
        // This is a time-series table the repricer appends to every cycle, and
        // the previous version asked for the newest 5000 rows across ALL of a
        // user's history for 500 ASINs. Measured 2026-08-23: 64,421 rows
        // scanned and 65,937 buffers to return 5000, which exceeded the
        // statement timeout on a cold cache.
        //
        // The window is not a reduction in coverage -- it is an increase.
        // Sorting a user's entire snapshot history and taking 5000 returned
        // roughly the last TWO hours, and silently dropped any ASIN whose
        // snapshots fell outside that cut. Six hours yields ~2010 rows here,
        // comfortably under the limit, so nothing is truncated and every ASIN
        // with a recent snapshot is represented.
        //
        //   rows scanned   64,421 -> 2,010
        //   buffers        65,937 -> 3,876
        //   execution      timeout -> 47ms
        // .eq("user_id", userId) is NOT redundant with RLS, and leaving it out
        // was timing this query out in production.
        //
        // RLS scopes the rows either way, but the predicate it injects is not
        // something the planner can use as an index condition here, so without
        // an explicit user_id the 46 MB idx_competitor_snapshots_user_asin_sku_marketplace
        // and idx_repricer_snapshots_user_fetched -- both of which lead with
        // user_id -- were unusable, and this fell back to a scan over a table
        // the repricer appends to every cycle.
        //
        // This runs every 30 seconds while the page is open (see the refresh
        // interval below), i.e. 120 times an hour, so once the table grew past
        // the tipping point it produced a steady stream of
        // "canceling statement due to statement timeout" in the Postgres log.
        // Measured 2026-08-23 on the same user and marketplace: without the
        // filter it exceeded the statement timeout; with it, 9.7ms using
        // idx_repricer_snapshots_user_fetched.
        //
        // Every other batchInQuery in this file already passes user_id. This
        // one was the exception.
        (q: any) => q
          .eq("user_id", userId)
          .eq("marketplace", targetMarketplace)
          .gte("fetched_at", snapshotWindowStart)
          .order("fetched_at", { ascending: false })
          .limit(5000)
      );

      const hasSnapshotSignal = (snap: any) =>
        snap?.buybox_price != null ||
        snap?.lowest_fba_price != null ||
        snap?.lowest_overall_price != null ||
        (snap?.offers_count ?? 0) > 0;

      for (const s of snapshotsData || []) {
        const key = `${s.asin}-${s.marketplace}`;
        const existing = snapshotsMap[key];

        if (!existing) {
          // Start with the newest snapshot (query is DESC by fetched_at)
          snapshotsMap[key] = s;
          continue;
        }

        // If newest snapshot looks throttled/empty, fall back to the first older
        // snapshot that has real market signal (prices or offers > 0).
        if (!hasSnapshotSignal(existing) && hasSnapshotSignal(s)) {
          snapshotsMap[key] = s;
        }
      }
    } catch (e) {
      console.error("[Repricer] Non-critical: snapshots fetch failed:", e);
    }
    return snapshotsMap;
  };

  // Fetch marketplace-specific prices from asin_my_price_cache for non-US markets
  const marketplaceConfig = getMarketplaceConfig(targetMarketplace);

  const fetchMarketplacePricesMap = async (): Promise<Record<string, number | null>> => {
    const marketplacePricesMap: Record<string, number | null> = {};
    if (targetMarketplace === "US" || asins.length === 0) return marketplacePricesMap;
    // Keyed by asin|sku, NOT asin alone — an ASIN can have more than one SKU
    // mapped to it in the same marketplace (e.g. an old/replaced listing kept
    // disabled alongside the active one). Keying by asin only meant whichever
    // row loaded last silently overwrote the other's price in this map, so a
    // disabled SKU's stale price could display under the active SKU's row
    // (and vice versa) even though their min/max bounds were correct.
    const priceData = await batchInQuery(
      "asin_my_price_cache",
      "asin, seller_sku, my_price",
      "asin",
      asins,
      (q: any) => q.eq("user_id", userId).eq("marketplace_id", marketplaceConfig.marketplaceId)
    );

    for (const p of priceData || []) {
      marketplacePricesMap[`${p.asin}|${p.seller_sku}`] = p.my_price;
    }
    return marketplacePricesMap;
  };

  // Fetch FX rate for non-US marketplaces so cost can be displayed in local currency on load
  const fetchFxRate = async (): Promise<number | null> => {
    if (targetMarketplace === "US") return null;
    const fallbackRates: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0, GBP: 0.79, EUR: 0.92 };
    try {
      const { data: fxData } = await supabase.functions.invoke("get-fx-rates", {
        body: { quote: marketplaceConfig.currency },
      });
      if (fxData?.rate?.rate) {
        return Number(fxData.rate.rate);
      }
      return fallbackRates[marketplaceConfig.currency] || null;
    } catch {
      return fallbackRates[marketplaceConfig.currency] || null;
    }
  };

  // Fetch asin_fee_cache to get accurate FBA fees when fees_json is missing or incomplete
  const fetchFeeCacheMap = async (): Promise<Record<string, any>> => {
    const feeCacheMap: Record<string, any> = {};
    if (asins.length === 0) return feeCacheMap;
    try {
      const feeCacheData = await batchInQuery(
        "asin_fee_cache",
        "asin, referral_rate, fba_fee_fixed, is_media, fee_source",
        "asin",
        asins,
        (q: any) => q.eq("user_id", userId).eq("marketplace", targetMarketplace === "US" ? "US" : targetMarketplace)
      );
      for (const fc of feeCacheData || []) {
        feeCacheMap[fc.asin] = fc;
      }
    } catch (e) {
      console.error("[Repricer] Non-critical: asin_fee_cache fetch failed:", e);
    }
    return feeCacheMap;
  };

  // ============================================================
  // Phase 1 enrichment from created_listings:
  // The repricer must read COG (and product image) from the user's
  // own Created Listings whenever the inventory row is missing them.
  // This runs once per load, keyed by ASIN, so newly-stocked items
  // never appear as "no COG / no image" if the listing exists.
  // ============================================================
  const fetchCreatedListingMap = async (): Promise<Record<string, { unitCost: number | null; image_url: string | null; title: string | null; price: number | null }>> => {
    const createdListingMap: Record<string, { unitCost: number | null; image_url: string | null; title: string | null; price: number | null }> = {};
    if (asins.length === 0) return createdListingMap;
    try {
      // Paginated fetch, NOT batchInQuery — this project's PostgREST "Max Rows"
      // setting silently clamps ANY query (regardless of client-side .limit())
      // to 1000 rows, so a single request per 500-ASIN batch can never be made
      // to return more than that. With repeat-purchase ASINs averaging ~1.9
      // created_listings rows each, some 500-ASIN batches genuinely exceed 1000
      // total rows, and whichever ASINs land past the cutoff quietly lose their
      // COG/image enrichment (confirmed live: ASIN B0H1NKJP1X's batch alone
      // produced 1000+ rows and its row never made it into createdListingMap).
      // Paginating with .range() inside each batch — same pattern as
      // fetchAllPaged above — guarantees completeness regardless of the
      // project's row cap or how the table grows. Batches run concurrently
      // (disjoint ASIN slices); only pages *within* one batch stay sequential,
      // since each page's existence depends on whether the previous was full.
      const CL_PAGE_SIZE = 1000;
      const clBatches: string[][] = [];
      for (let i = 0; i < asins.length; i += BATCH_IN_SIZE) {
        clBatches.push(asins.slice(i, i + BATCH_IN_SIZE));
      }
      const clBatchResults = await Promise.all(clBatches.map(async (batch) => {
        const rows: any[] = [];
        let clFrom = 0;
        while (true) {
          const { data: clPage, error: clPageErr } = await supabase
            .from("created_listings")
            .select("asin, cost, units, amount, image_url, title, price, date_created, created_at, id")
            .eq("user_id", userId)
            .in("asin", batch)
            .order("id", { ascending: true })
            .range(clFrom, clFrom + CL_PAGE_SIZE - 1);
          if (clPageErr) break;
          const page = clPage || [];
          rows.push(...page);
          if (page.length < CL_PAGE_SIZE) break;
          clFrom += CL_PAGE_SIZE;
        }
        return rows;
      }));
      const clRows = clBatchResults.flat();
      // Group by ASIN, then pick the NEWEST row (mirrors resolveUnitCost.pickNewestListing:
      // date_created DESC NULLS LAST, created_at DESC, id DESC). This guarantees the
      // most-recently-created listing wins for COG (and image/title/price fallbacks),
      // matching the Create Extension behaviour the user requested.
      const grouped: Record<string, any[]> = {};
      for (const cl of clRows || []) {
        if (!cl.asin) continue;
        (grouped[cl.asin] ||= []).push(cl);
      }
      const sortNewestFirst = (a: any, b: any) => {
        const ad = a.date_created || "";
        const bd = b.date_created || "";
        if (ad !== bd) {
          if (!ad) return 1;
          if (!bd) return -1;
          return String(bd).localeCompare(String(ad));
        }
        const ac = a.created_at || "";
        const bc = b.created_at || "";
        if (ac !== bc) return String(bc).localeCompare(String(ac));
        return String(b.id || "").localeCompare(String(a.id || ""));
      };
      for (const asin of Object.keys(grouped)) {
        const sorted = grouped[asin].slice().sort(sortNewestFirst);
        // Newest row with a positive unit cost wins for COG specifically
        let unitCost: number | null = null;
        for (const row of sorted) {
          const u = getListingUnitCost({ cost: row.cost, units: row.units, amount: row.amount });
          if (u != null && u > 0) { unitCost = u; break; }
        }
        // For image/title/price, take newest non-empty value
        const newest = sorted[0];
        let image_url: string | null = null;
        let title: string | null = null;
        let price: number | null = null;
        for (const row of sorted) {
          if (!image_url && row.image_url) image_url = row.image_url;
          if (!title && row.title) title = row.title;
          if (price == null && row.price != null && Number(row.price) > 0) price = Number(row.price);
          if (image_url && title && price != null) break;
        }
        createdListingMap[asin] = { unitCost, image_url, title, price };
        void newest;
      }
    } catch (e) {
      console.error("[Repricer] Non-critical: created_listings COG/image enrichment failed:", e);
    }
    return createdListingMap;
  };

  const [rulesMap, snapshotsMap, marketplacePricesMap, initialFxRate, feeCacheMap, createdListingMap] = await Promise.all([
    fetchRulesMap(),
    fetchSnapshotsMap(),
    fetchMarketplacePricesMap(),
    fetchFxRate(),
    fetchFeeCacheMap(),
    fetchCreatedListingMap(),
  ]);

  // ============================================================
  // Sales data is deferred to Phase 2 (fetchSalesEnrichment)
  // to show the table instantly. Initialize with zeros.
  // ============================================================
  const salesTodayMap: Record<string, number> = {};
  const sales7Map: Record<string, number> = {};
  const salesMap: Record<string, number> = {};
  const historicalSalesMap: Record<string, { totalUnits: number; earliestDate: string }> = {};
  const titleImageMap: Record<string, { title?: string; image_url?: string }> = {};

  // Combine data with target marketplace
  const combined: InventoryWithAssignment[] = (inventoryData || []).map(inv => {
    // Enrich title/image from fallback sources, with created_listings as a
    // first-class fallback for both image and (further down) COG.
    const clEnrich = createdListingMap[inv.asin];
    const enrichment = titleImageMap[inv.asin];
    const enrichedTitle = (!inv.title || inv.title === '' || inv.title.toLowerCase().includes('unknown') || inv.title.toLowerCase().includes('untitled'))
      ? (clEnrich?.title || enrichment?.title || inv.title)
      : inv.title;
    const enrichedImage = inv.image_url || clEnrich?.image_url || enrichment?.image_url || null;
    // Prefer the assignment that matches this exact SKU; fall back to ASIN-level only if none.
    // BOTH lookups are scoped to targetMarketplace via map key construction.
    let assignment =
      assignmentsBySku[`${inv.asin}-${inv.sku}-${targetMarketplace}`] ??
      assignmentsByAsin[`${inv.asin}-${targetMarketplace}`];

    // HARD MARKETPLACE GUARD — even though map keys include marketplace,
    // assert defensively so cross-marketplace contamination cannot drive
    // min/max, ROI%, "Min > price" diagnostics, or status badges.
    if (assignment && (assignment as any).marketplace !== targetMarketplace) {
      console.warn(
        `[Marketplace Guard] dropping assignment ${(assignment as any).id} ` +
        `(mkt=${(assignment as any).marketplace}) for ${inv.asin}/${inv.sku} ` +
        `because target=${targetMarketplace}`
      );
      assignment = undefined;
    }

    // For international marketplaces, fall back to the US assignment for rule filtering
    // so items with a US rule don't falsely appear as "No Rule"
    const usAssignment = targetMarketplace !== "US"
      ? (assignmentsBySku[`${inv.asin}-${inv.sku}-US`] ?? assignmentsByAsin[`${inv.asin}-US`])
      : null;
    const snapshot = snapshotsMap[`${inv.asin}-${targetMarketplace}`];
    const rule = assignment?.rule_id ? rulesMap[assignment.rule_id] : null;

    // ── TRACE LOG (contamination audit) — B01JIA5DOK only ──
    if (inv.asin === 'B01JIA5DOK') {
      const allAsgnForAsin = Object.entries(assignmentsBySku)
        .filter(([k]) => k.startsWith('B01JIA5DOK-'))
        .map(([k, a]: any) => ({
          key: k,
          marketplace: a?.marketplace,
          sku: a?.sku,
          min: a?.min_price_override,
          max: a?.max_price_override,
          roi_at_min: a?.roi_at_min_percent,
          roi_at_max: a?.roi_at_max_percent,
        }));
      console.log('[TRACE B01JIA5DOK]', {
        target_marketplace: targetMarketplace,
        inv_sku: inv.sku,
        inv_cost: inv.cost,
        inv_price: inv.price,
        inv_my_price: inv.my_price,
        'inv_min_price(US-only-fallback)': (inv as any).min_price,
        'inv_max_price(US-only-fallback)': (inv as any).max_price,
        picked_assignment_marketplace: (assignment as any)?.marketplace,
        picked_assignment_sku: assignment?.sku,
        picked_min: assignment?.min_price_override,
        picked_max: assignment?.max_price_override,
        picked_roi_at_min_pct: assignment?.roi_at_min_percent,
        picked_roi_at_max_pct: assignment?.roi_at_max_percent,
        fx_rate: initialFxRate,
        ALL_ASGN_ROWS_FOR_ASIN: allAsgnForAsin,
      });
    }

    // Calculate Amazon fees from fees_json, enriched with asin_fee_cache
    // Priority: legacy dollar amounts > asin_fee_cache > rate-based defaults
    const feeCache = feeCacheMap[inv.asin];
    let effectiveFeesJson = inv.fees_json as any;

    // Enrich fees_json with marketplace-specific asin_fee_cache data when available.
    // For international markets, the inventory row often carries US fee JSON, so
    // prefer the CA/MX/BR cache to prevent ROI-at-Min from using US fees/currency.
    if (feeCache && feeCache.fba_fee_fixed > 0) {
      if (targetMarketplace !== "US") {
        effectiveFeesJson = {
          referral_rate: feeCache.referral_rate ?? 0.15,
          fba_fee_fixed: feeCache.fba_fee_fixed,
          fee_source: feeCache.fee_source || 'asin_fee_cache',
          marketplace: targetMarketplace,
        };
      } else if (!effectiveFeesJson) {
        effectiveFeesJson = {
          referral_rate: feeCache.referral_rate ?? 0.15,
          fba_fee_fixed: feeCache.fba_fee_fixed,
          fee_source: feeCache.fee_source || 'asin_fee_cache',
          marketplace: targetMarketplace,
        };
      } else if (effectiveFeesJson.referral_rate !== undefined || effectiveFeesJson.fba_fee_fixed !== undefined) {
        // Rate-based format — enrich with fee cache if fba_fee_fixed is missing/zero
        if (!effectiveFeesJson.fba_fee_fixed || effectiveFeesJson.fba_fee_fixed <= 0) {
          effectiveFeesJson = { ...effectiveFeesJson, fba_fee_fixed: feeCache.fba_fee_fixed, marketplace: targetMarketplace };
        }
        if (feeCache.referral_rate && feeCache.referral_rate > 0) {
          effectiveFeesJson = { ...effectiveFeesJson, referral_rate: feeCache.referral_rate, marketplace: targetMarketplace };
        }
      }
      // Legacy format with dollar amounts — don't override, those are more accurate
    }

    let amazonFees: number | null = null;
    if (effectiveFeesJson) {
      const fees = effectiveFeesJson;
      // Check for new format (referral_rate + fba_fee_fixed from asin_fee_cache)
      if (fees.referral_rate !== undefined || fees.fba_fee_fixed !== undefined) {
        const referralRate = fees.referral_rate ?? 0.15;
        const fbaFeeFixed = fees.fba_fee_fixed ?? 0;
        const priceForCalc = inv.my_price ?? inv.price ?? 0;
        amazonFees = (priceForCalc * referralRate) + fbaFeeFixed;
      } else {
        // Legacy format (referralFee, fbaFee as dollar amounts)
        amazonFees = (fees.referralFee || 0) + (fees.fbaFee || 0) + (fees.variableClosingFee || fees.closingFee || 0);
      }
    }

    // For non-US marketplaces, use marketplace-specific price from cache
    // For US, use inventory.my_price or inventory.price
    let displayPrice: number | null = null;
    let displayMyPrice: number | null = null;
    
    if (targetMarketplace === "US") {
      // For newly inbound listings, inventory.price/my_price are often null
      // until SP-API fills them. Fall back only to seller-owned sources:
      // assignment.last_applied_price, then created_listings.price.
      const assignmentPrice = (assignment?.last_applied_price != null && Number(assignment.last_applied_price) > 0)
        ? Number(assignment.last_applied_price)
        : null;
      const activationPriceUnavailable = String((assignment as any)?.last_disabled_reason || '').toLowerCase().includes('price_unavailable');
      const clFallback = activationPriceUnavailable ? null : (clEnrich?.price ?? null);
      displayPrice = inv.price ?? assignmentPrice ?? clFallback;
      displayMyPrice = inv.my_price ?? assignmentPrice ?? clFallback;
    } else {
      // Use cached marketplace price if available
      const assignmentPrice = (assignment?.last_applied_price != null && Number(assignment.last_applied_price) > 0)
        ? Number(assignment.last_applied_price)
        : null;
      const cachedPrice = marketplacePricesMap[`${inv.asin}|${inv.sku}`];
      displayPrice = cachedPrice ?? assignmentPrice ?? null;
      displayMyPrice = cachedPrice ?? assignmentPrice ?? null;
    }

    return {
      id: inv.id,
      asin: inv.asin,
      sku: inv.sku,
      title: enrichedTitle,
      image_url: enrichedImage,
      price: displayPrice,
      my_price: displayMyPrice,
      // COG resolution: NEWEST created_listings row wins (mirrors Live Sales /
      // resolveUnitCost). Inventory.cost is only used when no created_listings
      // unit cost is available. This guarantees a freshly-recorded purchase
      // cost shows up immediately in the repricer instead of the stale
      // inventory value.
      cost: (clEnrich?.unitCost != null && clEnrich.unitCost > 0)
        ? clEnrich.unitCost
        : ((inv.cost != null && inv.cost > 0) ? inv.cost : null),
      cost_converted: (() => {
        const effectiveCost = (clEnrich?.unitCost != null && clEnrich.unitCost > 0)
          ? clEnrich.unitCost
          : ((inv.cost != null && inv.cost > 0) ? inv.cost : null);
        return (targetMarketplace !== "US" && effectiveCost != null && initialFxRate != null)
          ? effectiveCost * initialFxRate
          : null;
      })(),
      // NA FBA shares a unified inventory pool – always show US qty
      available: inv.available,
      reserved: inv.reserved,
      inbound: inv.inbound,
      unfulfilled: inv.unfulfilled ?? null,
      listing_status: inv.listing_status,
      listing_created_at: inv.listing_created_at,
      source: inv.source,
      fees_json: effectiveFeesJson as Record<string, unknown> | null,
      // Only use inventory min/max for US; they are US-specific values
      inv_min_price: targetMarketplace === "US" ? ((inv as any).min_price ?? null) : null,
      inv_max_price: targetMarketplace === "US" ? ((inv as any).max_price ?? null) : null,
      assignment_id: assignment?.id || null,
      rule_id: assignment?.rule_id || null,
      saved_rule_id: assignment?.rule_id || usAssignment?.rule_id || null,
      rule_name: rule?.name || (usAssignment?.rule_id ? rulesMap[usAssignment.rule_id]?.name || null : null),
      is_enabled: assignment?.rule_id ? (assignment?.is_enabled ?? true) : false, // Default paused when no rule assigned
      auto_apply_enabled: true, // Always enabled - switches removed from UI
      manual_min_price: assignment?.manual_min_price ?? null,
      assignment_created_at: assignment?.created_at || null,
      auto_activated_at: (assignment as any)?.auto_activated_at || null,
      auto_activated_reason: (assignment as any)?.auto_activated_reason || null,
      buybox_lost_at: assignment?.buybox_lost_at || null,
      min_price_override: assignment?.min_price_override || null,
      max_price_override: assignment?.max_price_override || null,
      min_roi_override: assignment?.min_roi_override ?? null,
      rule_min_roi_percent: rule?.min_roi_percent ?? null,
      rule_min_roi_enabled: resolveRuleMinRoiEnabledForMarketplace(rule as any, targetMarketplace),
      rule_min_roi_marketplace_overrides: rule?.min_roi_marketplace_overrides ?? {},
      last_evaluated_at: assignment?.last_evaluated_at || null,
      last_applied_price: assignment?.last_applied_price || null,
      last_recommended_price: assignment?.last_recommended_price || null,
      last_recommendation_reason: assignment?.last_recommendation_reason || null,
      marketplace: targetMarketplace,
      // Production-readiness: Error tracking
      status: assignment?.status || 'active',
      last_error_type: assignment?.last_error_type || null,
      last_error_message: assignment?.last_error_message || null,
      consecutive_failures: assignment?.consecutive_failures || 0,
      paused_at: assignment?.paused_at || null,
      pause_reason: assignment?.pause_reason || null,
      manual_paused: !!(assignment as any)?.manual_paused,
      last_disabled_by: (assignment as any)?.last_disabled_by || null,
      last_disabled_reason: (assignment as any)?.last_disabled_reason || null,
      last_disabled_at: (assignment as any)?.last_disabled_at || null,
      // Inventory is matched to assignment via (user_id, marketplace, asin, sku) upstream.
      // If we have a real inventory row id, it's a true match.
      has_matching_inventory: !!inv.id,
      amazon_min_price: assignment?.amazon_min_price || null,
      amazon_max_price: assignment?.amazon_max_price || null,
      amazon_bounds_synced_at: assignment?.amazon_bounds_synced_at || null,
      // Snapshot data
      buybox_price: snapshot?.buybox_price || null,
      buybox_seller_id: snapshot?.buybox_seller_id || null,
      // ?? not || -- buybox_is_fba is a boolean, and a legitimate `false`
      // (FBM buy box winner) must not be treated as "missing" and coerced
      // to null (which would make useRepricerCache's merge logic fall back
      // to a stale cached `true` from before the buy box flipped to FBM).
      buybox_is_fba: snapshot?.buybox_is_fba ?? null,
      lowest_fba_price: snapshot?.lowest_fba_price || null,
      lowest_overall_price: snapshot?.lowest_overall_price || null,
      offers_count: snapshot?.offers_count ?? null,
      snapshot_fetched_at: snapshot?.fetched_at || null,
      last_buybox_status: assignment?.last_buybox_status || null,
      amazon_fees: amazonFees,
      bb_percentage: null,
      position: null,
      units_sold_7d: sales7Map[inv.asin] ?? null,
      units_sold_30d: salesMap[inv.asin] ?? null,
      units_sold_today: salesTodayMap[normalizeIdentifier(inv.asin)] || 0,
      actual_roi: null,
      buybox_roi: null,
      cost_floor: (() => {
        const guardMode = rule?.profit_guard_mode || 'strict';
        if (guardMode === 'strict') {
          return assignment?.last_floor_price_cents ? assignment.last_floor_price_cents / 100 : null;
        }
        // In respect_min_max or off mode, effective floor is just the min price
        // IMPORTANT: Only use inventory min_price for US; non-US must use assignment override only
        const minP = assignment?.min_price_override ?? (targetMarketplace === "US" ? inv.min_price : null);
        return minP != null ? Number(minP) : null;
      })(),
      // ROI Range — ALWAYS recompute client-side from current cost+fees+min/max when
      // possible (cached roi_at_min_percent/roi_at_max_percent can be stale after
      // cost/fee updates). Uses the same created_listings-first cost as the COG
      // column so the displayed ROI matches the displayed COG.
      roi_at_min_percent: (() => {
        const effCost = (clEnrich?.unitCost != null && clEnrich.unitCost > 0)
          ? clEnrich.unitCost
          : ((inv.cost != null && inv.cost > 0) ? inv.cost : null);
        const mp = assignment?.min_price_override ?? (targetMarketplace === "US" ? inv.min_price : null);
        const live = mp != null ? calcRoiAtPrice(effCost, effectiveFeesJson, Number(mp), initialFxRate ?? 1, targetMarketplace) : null;
        return live ?? assignment?.roi_at_min_percent ?? null;
      })(),
      roi_at_max_percent: (() => {
        const effCost = (clEnrich?.unitCost != null && clEnrich.unitCost > 0)
          ? clEnrich.unitCost
          : ((inv.cost != null && inv.cost > 0) ? inv.cost : null);
        const mp = assignment?.max_price_override ?? (targetMarketplace === "US" ? inv.max_price : null);
        const live = mp != null ? calcRoiAtPrice(effCost, effectiveFeesJson, Number(mp), initialFxRate ?? 1, targetMarketplace) : null;
        return live ?? assignment?.roi_at_max_percent ?? null;
      })(),
      roi_range_updated_at: assignment?.roi_range_updated_at || null,
      // Replenishment historical data
      historical_sales: historicalSalesMap[inv.asin]?.totalUnits ?? null,
      historical_days: null, // populated by deferred sales enrichment
      // Fulfillment type: HARD FBA evidence overrides any stored assignment value
      // (FBM merchant-listings sync can incorrectly tag an assignment as FBM even
      // when the same SKU is actually FBA). Hard FBA evidence:
      //   1. FNSKU present — FBM listings NEVER have an FNSKU (sync-fbm-cleanup
      //      always writes fnsku: null). An FNSKU is uniquely issued by FBA.
      //   2. FBA quantity > 0 (available/reserved/inbound) — only FBA rows carry
      //      these counters; amazon_sync_fbm only sets `available`.
      //   3. Inventory source is amazon_sync / FBA Reports.
      // Mirrors how Live Sales trusts Orders-API FulfillmentChannel (AFN/MFN).
      fulfillment_type: (() => {
        const src = (inv.source || '').toLowerCase();
        const hasFnsku = !!(inv.fnsku && String(inv.fnsku).trim().length > 0);
        const fbaQty = (Number(inv.available) || 0) + (Number(inv.reserved) || 0) + (Number(inv.inbound) || 0);
        const reservedOrInbound = (Number(inv.reserved) || 0) + (Number(inv.inbound) || 0);
        const srcSaysFba = src === 'amazon_sync' || (src.includes('fba') && !src.includes('fbm'));
        const srcSaysFbm = src === 'amazon_sync_fbm' || (src.includes('fbm') && !src.includes('fba'));
        // Hard FBA evidence — overrides any stored FBM tag from merchant-listings sync
        const hardFba = hasFnsku || reservedOrInbound > 0 || srcSaysFba;
        if (hardFba) return 'FBA';
        // Hard FBM evidence — overrides any stored FBA tag from a stale/wrong assignment.
        // Mirrors how Live Sales trusts Orders-API FulfillmentChannel=MFN regardless of
        // any other guess. amazon_sync_fbm only writes merchant offers; combined with
        // no FNSKU and zero FBA reserved/inbound, this is authoritative MFN.
        const hardFbm = srcSaysFbm && !hasFnsku && reservedOrInbound === 0;
        if (hardFbm) return 'FBM';
        if (assignment?.fulfillment_type) return assignment.fulfillment_type;
        if (src.includes('fbm')) return 'FBM';
        const bbIsFba = snapshot?.buybox_is_fba === true;
        return (fbaQty > 0 || bbIsFba) ? 'FBA' : 'FBM';
      })(),

      item_condition: (inv.sku?.startsWith('amzn.gr.') || inv.sku?.toLowerCase?.().startsWith('used_')) ? 'Used' : 'New',
      first_received_at: inv.first_received_at || null,
      expiration_date: inv.expiration_date || null,
      is_priority: assignment?.is_priority || false,
      is_manual_priority: assignment?.is_manual_priority || false,
      manual_override_active: !!(assignment?.manual_override_started_at && (assignment?.manual_override_checks ?? 0) > 0),
      manual_override_checks: assignment?.manual_override_checks ?? 0,
      is_restricted: assignment?.is_restricted ?? false,
      intl_listing_status: assignment?.intl_listing_status || null,
      marketplace_sellable: (assignment as any)?.marketplace_sellable ?? null,
      // Amazon-blocked listing — surfaced as "Blocked — not buyable on Amazon".
      is_listing_inactive_not_buyable: (assignment as any)?.is_listing_inactive_not_buyable ?? null,
      listing_inactive_reason_code: (assignment as any)?.listing_inactive_reason_code ?? null,
      listing_inactive_reason_message: (assignment as any)?.listing_inactive_reason_message ?? null,
      eval_mode: (assignment?.eval_mode as EvalMode) || 'auto',
      active_eval_mode: (assignment?.active_eval_mode as ActiveEvalMode) || 'smart',
      eval_mode_reason: assignment?.eval_mode_reason || null,
      rule_oscillation_mode: (rule as any)?.oscillation_mode || (usAssignment?.rule_id ? (rulesMap[usAssignment.rule_id] as any)?.oscillation_mode || null : null),
      oscillation_last_mode_used: assignment?.oscillation_last_mode_used || null,
      oscillation_last_reason: assignment?.oscillation_last_reason || null,
      oscillation_state: assignment?.oscillation_state || null,
      oscillation_count: assignment?.oscillation_count ?? 0,
      oscillation_reaction_count: assignment?.oscillation_reaction_count ?? 0,
      oscillation_cooldown_until: assignment?.oscillation_cooldown_until || null,
    };
  });

  // === QTY DIAGNOSTICS for affected ASINs ===
  const diagAsins = ["0439635713", "B003Y8YB1Y"];
  for (const item of combined) {
    if (diagAsins.includes(item.asin)) {
      console.log(`[QTY_DIAG] ${item.asin} (SKU: ${item.sku}): available=${item.available}, reserved=${item.reserved}, inbound=${item.inbound}, unfulfilled=${item.unfulfilled}, listing_status=${item.listing_status}, sellableQty=${(item.available ?? 0) + (item.reserved ?? 0)}`);
    }
  }

  // === FBM ORPHAN INJECTION (US only) ===
  // FBM listings created via our tool live in `created_listings` but never
  // enter the `inventory` table (Summaries API only writes FBA). Their
  // repricer assignments exist but won't render because we only iterate
  // over inventory rows. Inject synthesized rows from created_listings for
  // any assignment that wasn't matched above.
  if (targetMarketplace === "US" && (assignmentsData?.length ?? 0) > 0) {
    const matchedAssignmentIds = new Set(combined.map(c => c.assignment_id).filter(Boolean));
    const orphanAssignments = (assignmentsData || []).filter(a => a.id && !matchedAssignmentIds.has(a.id));
    if (orphanAssignments.length > 0) {
      const orphanSkus = [...new Set(orphanAssignments.map(a => a.sku).filter(Boolean))];
      const createdRows = await batchInQuery(
        "created_listings",
        "asin, sku, title, image_url, price, cost, units",
        "sku",
        orphanSkus,
        (q: any) => q.eq("user_id", userId),
      );
      const createdBySku: Record<string, any> = {};
      for (const r of createdRows) createdBySku[r.sku] = r;

      let injected = 0;
      for (const a of orphanAssignments) {
        const cl = createdBySku[a.sku];
        if (!cl || cl.asin !== a.asin) continue;
        // SAFETY: Only inject orphan rows for assignments that are genuinely FBM.
        // Never fabricate FBM rows for FBA assignments — that violates SP-API
        // inventory truth and creates phantom listings (e.g. B003CJ927I bug).
        if ((a.fulfillment_type || '').toUpperCase() !== 'FBM') continue;
        const rule = a.rule_id ? rulesMap[a.rule_id] : null;
        const units = Number(cl.units) || 0;
        const totalCost = Number(cl.cost) || 0;
        const perUnitCost = units > 0 ? totalCost / units : totalCost;
        combined.push({
          id: `fbm-orphan-${a.id}`,
          asin: a.asin,
          sku: a.sku,
          title: cl.title || null,
          image_url: cl.image_url || null,
          price: Number(cl.price) || a.last_applied_price || null,
          my_price: Number(cl.price) || a.last_applied_price || null,
          cost: perUnitCost || null,
          cost_converted: null,
          available: 0,
          reserved: 0,
          inbound: 0,
          unfulfilled: null,
          listing_status: 'INACTIVE',
          listing_created_at: null,
          source: 'created_listings_fbm',
          fees_json: null,
          inv_min_price: null,
          inv_max_price: null,
          assignment_id: a.id,
          rule_id: a.rule_id || null,
          saved_rule_id: a.rule_id || null,
          rule_name: rule?.name || null,
          is_enabled: a.rule_id ? (a.is_enabled ?? true) : false,
          auto_apply_enabled: true,
          manual_min_price: a.manual_min_price ?? null,
          assignment_created_at: a.created_at || null,
          auto_activated_at: (a as any).auto_activated_at || null,
          auto_activated_reason: (a as any).auto_activated_reason || null,
          buybox_lost_at: a.buybox_lost_at || null,
          min_price_override: a.min_price_override || null,
          max_price_override: a.max_price_override || null,
          min_roi_override: a.min_roi_override ?? null,
          rule_min_roi_percent: rule?.min_roi_percent ?? null,
          rule_min_roi_enabled: resolveRuleMinRoiEnabledForMarketplace(rule as any, targetMarketplace),
          rule_min_roi_marketplace_overrides: rule?.min_roi_marketplace_overrides ?? {},
          last_evaluated_at: a.last_evaluated_at || null,
          last_applied_price: a.last_applied_price || null,
          last_recommended_price: a.last_recommended_price || null,
          last_recommendation_reason: a.last_recommendation_reason || null,
          marketplace: targetMarketplace,
          status: a.status || 'active',
          last_error_type: a.last_error_type || null,
          last_error_message: a.last_error_message || null,
          consecutive_failures: a.consecutive_failures || 0,
          paused_at: a.paused_at || null,
          pause_reason: a.pause_reason || null,
          manual_paused: !!a.manual_paused,
          last_disabled_by: a.last_disabled_by || null,
          last_disabled_reason: a.last_disabled_reason || null,
          last_disabled_at: a.last_disabled_at || null,
          // Orphan FBM injected row — no real inventory match exists.
          has_matching_inventory: false,
          amazon_min_price: a.amazon_min_price || null,
          amazon_max_price: a.amazon_max_price || null,
          amazon_bounds_synced_at: a.amazon_bounds_synced_at || null,
          buybox_price: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.buybox_price || null,
          buybox_seller_id: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.buybox_seller_id || null,
          // ?? not || -- a legitimate `false` (FBM buy box winner) must not
          // be coerced to null, see the matching comment above.
          buybox_is_fba: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.buybox_is_fba ?? null,
          lowest_fba_price: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.lowest_fba_price || null,
          lowest_overall_price: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.lowest_overall_price || null,
          offers_count: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.offers_count ?? null,
          snapshot_fetched_at: snapshotsMap[`${a.asin}-${targetMarketplace}`]?.fetched_at || null,
          last_buybox_status: a.last_buybox_status || null,
          amazon_fees: null,
          bb_percentage: null,
          position: null,
          units_sold_7d: null,
          units_sold_30d: null,
          units_sold_today: 0,
          actual_roi: null,
          buybox_roi: null,
          cost_floor: a.min_price_override != null ? Number(a.min_price_override) : null,
          roi_at_min_percent: a.roi_at_min_percent ?? null,
          roi_at_max_percent: a.roi_at_max_percent ?? null,
          roi_range_updated_at: a.roi_range_updated_at || null,
          historical_sales: null,
          historical_days: null,
          fulfillment_type: 'FBM',
          item_condition: 'New',
          first_received_at: null,
          expiration_date: null,
          is_priority: a.is_priority || false,
          is_manual_priority: a.is_manual_priority || false,
          manual_override_active: !!(a.manual_override_started_at && (a.manual_override_checks ?? 0) > 0),
          manual_override_checks: a.manual_override_checks ?? 0,
          is_restricted: a.is_restricted ?? false,
          intl_listing_status: a.intl_listing_status || null,
          marketplace_sellable: (a as any).marketplace_sellable ?? null,
          eval_mode: (a.eval_mode as EvalMode) || 'auto',
          active_eval_mode: (a.active_eval_mode as ActiveEvalMode) || 'smart',
          eval_mode_reason: a.eval_mode_reason || null,
          rule_oscillation_mode: (rule as any)?.oscillation_mode || null,
          oscillation_last_mode_used: a.oscillation_last_mode_used || null,
          oscillation_last_reason: a.oscillation_last_reason || null,
          oscillation_state: a.oscillation_state || null,
          oscillation_count: a.oscillation_count ?? 0,
          oscillation_reaction_count: a.oscillation_reaction_count ?? 0,
          oscillation_cooldown_until: a.oscillation_cooldown_until || null,
        } as InventoryWithAssignment);
        injected++;
      }
      if (injected > 0) {
        console.log(`[Repricer] FBM orphan injection: added ${injected} rows from created_listings (e.g. B0FK2YGWR2)`);
      }
    }
  }

  const available = combined.filter(item => {
    // Exclude ghost/deleted/inactive listings from the assignments table
    // INACTIVE/INCOMPLETE/SUPPRESSED listings are not sellable — hide across all marketplaces.
    const ls = (item.listing_status || '').toUpperCase();
    if (ls === 'NOT_IN_CATALOG' || ls === 'DELETED') return false;
    if (ls === 'INACTIVE' || ls.includes('INACTIVE') || ls === 'INCOMPLETE' || ls === 'SUPPRESSED') return false;
    // For non-US marketplaces, also drop rows where the marketplace-specific status is inactive
    const intlLs = (item.intl_listing_status || '').toUpperCase();
    if (targetMarketplace !== 'US' && (intlLs.includes('INACTIVE') || intlLs === 'INCOMPLETE' || intlLs === 'SUPPRESSED' || intlLs === 'NOT_FOUND')) return false;

    // Keep assigned or stocked listings visible even when cost is missing so users can
    // diagnose/fix the cost instead of the row disappearing from the repricer.
    const hasRepricerPresence = !!item.assignment_id || ((item.available ?? 0) + (item.reserved ?? 0) > 0);
    if ((item.cost == null || item.cost <= 0) && !hasRepricerPresence) return false;

    if (item.lowest_overall_price == null && item.buybox_price == null && item.snapshot_fetched_at != null) {
      // Has a snapshot but no prices — keep if it has an assignment OR physical stock
      // (SP-API may have been throttled, not truly unavailable)
      if (item.assignment_id) return true;
      if ((item.available ?? 0) + (item.reserved ?? 0) + (item.inbound ?? 0) > 0) return true;
      return false; // confirmed unavailable and no stock
    }
    return true;
  });

  // For non-US marketplaces, only show items that have evidence of being
  // active/sellable in that region (cached price, existing assignment, or configured bounds/rule)
  // AND that pass the centralized sellability check (BUYABLE + no restriction/approval gate).
  // This prevents showing remote-fulfillment DISCOVERABLE-only ASINs, restricted, approval-required,
  // and unknown-status listings as fake "Paused" rows.
  if (targetMarketplace !== "US") {
    let withPrice = 0, withAssignment = 0, withConfig = 0;
    const filtered = available.filter(item => {
      if (marketplacePricesMap[`${item.asin}|${item.sku}`] != null) { withPrice++; return true; }
      if (item.assignment_id) { withAssignment++; return true; }
      if (item.rule_id || item.min_price_override || item.max_price_override) { withConfig++; return true; }
      return false;
    });

    const intlMktConfig = getMarketplaceConfig(targetMarketplace);
    const intlMktId = intlMktConfig?.marketplaceId;

    // 1) Fast persisted column (set by background validator). If set to false → hide immediately.
    //    `marketplace_sellable` is hydrated onto items from repricer_assignments.
    //    Items where it is null/undefined fall through to the live evaluation below.
    let preFiltered = filtered.filter((it: any) => it.marketplace_sellable !== false);

    // 2) Load eligibility cache once for restriction backstop.
    const eligibilityMap = new Map<string, { eligible: boolean | null; blocking_issues: any[] | null }>();
    const checkedAsins = new Set<string>();
    if (intlMktId) {
      const asinList = [...new Set(preFiltered.map(i => i.asin).filter(Boolean))];
      for (let i = 0; i < asinList.length; i += 200) {
        const chunk = asinList.slice(i, i + 200);
        const { data: cacheRows } = await supabase
          .from("fba_eligibility_cache")
          .select("asin, eligible, blocking_issues")
          .eq("user_id", userId)
          .eq("marketplace_id", intlMktId)
          .in("asin", chunk);
        for (const row of (cacheRows || []) as any[]) {
          checkedAsins.add(row.asin);
          eligibilityMap.set(row.asin, {
            eligible: row.eligible,
            blocking_issues: row.blocking_issues,
          });
        }
      }
    }

    // 3) Centralized sellability evaluation per-row.
    let hiddenNotBuyable = 0, hiddenUnknown = 0, hiddenRestricted = 0, hiddenApproval = 0;
    const finalFiltered = preFiltered.filter((item) => {
      const r = evaluateSellability({
        marketplace: targetMarketplace,
        intl_listing_status: item.intl_listing_status,
        eligibility: eligibilityMap.get(item.asin) ?? null,
      });
      if (r.sellable) return true;
      if (r.reason === "not_buyable") hiddenNotBuyable++;
      else if (r.reason === "status_unknown") hiddenUnknown++;
      else if (r.reason === "restricted") hiddenRestricted++;
      else if (r.reason === "approval_required") hiddenApproval++;
      return false;
    });

    // 4) Background: enqueue unresolved ASINs for backend validation so the
    //    persisted column + eligibility cache fill in for next refresh. Best-effort, no await.
    if (intlMktId) {
      const unresolvedAsins = preFiltered
        .filter((it) => !checkedAsins.has(it.asin))
        .map((it) => it.asin)
        .slice(0, 50);
      if (unresolvedAsins.length > 0) {
        void supabase.functions
          .invoke("validate-marketplace-sellability", {
            body: { marketplace: targetMarketplace, asins: unresolvedAsins },
          })
          .catch(() => {});
      }
    }

    console.log(
      `[Repricer] ${targetMarketplace} filter: ${combined.length} total → ${available.length} after availability → ${filtered.length} candidate → ${finalFiltered.length} shown ` +
      `(hiddenNotBuyable=${hiddenNotBuyable}, hiddenUnknown=${hiddenUnknown}, hiddenRestricted=${hiddenRestricted}, hiddenApproval=${hiddenApproval}, byPrice=${withPrice}, byAssignment=${withAssignment}, byConfig=${withConfig})`
    );
    return finalFiltered;
  }

  return available;
}

// Phase 2: Deferred sales + enrichment data (loaded after table is visible)
async function fetchSalesEnrichment(userId: string, targetMarketplace: string): Promise<{
  salesTodayMap: Record<string, number>;
  sales7Map: Record<string, number>;
  salesMap: Record<string, number>;
  historicalSalesMap: Record<string, { totalUnits: number; earliestDate: string }>;
  titleImageMap: Record<string, { title?: string; image_url?: string }>;
}> {
  const AMAZON_BUSINESS_TZ = "America/Los_Angeles";
  const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: AMAZON_BUSINESS_TZ });
  const addDaysISO = (dateISO: string, delta: number): string => {
    const d = new Date(dateISO + "T12:00:00");
    d.setDate(d.getDate() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const sevenDaysAgoPT = addDaysISO(todayPT, -7);
  const thirtyDaysAgoPT = addDaysISO(todayPT, -30);

  type SalesRow = { asin: string; quantity: number | null };
  const fetchAllSalesRows = async (builderBase: any): Promise<SalesRow[]> => {
    const pageSize = 1000;
    let from = 0;
    const all: SalesRow[] = [];
    while (true) {
      const { data, error } = await builderBase.order("id", { ascending: true }).range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data || []) as Array<{ id: string; asin: string; quantity: number | null }>;
      all.push(...rows.map(r => ({ asin: (r.asin || "").trim(), quantity: r.quantity })));
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return all;
  };

  type HistoricalRow = { asin: string; quantity: number | null; order_date: string };
  const fetchAllHistoricalRows = async (builderBase: any): Promise<HistoricalRow[]> => {
    const pageSize = 1000;
    let from = 0;
    const all: HistoricalRow[] = [];
    while (true) {
      const { data, error } = await builderBase.order("id", { ascending: true }).range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data || []) as Array<{ id: string; asin: string; quantity: number | null; order_date: string }>;
      all.push(...rows.map(r => ({ asin: (r.asin || "").trim(), quantity: r.quantity, order_date: r.order_date })));
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return all;
  };

  const fetchTodaySales = async (): Promise<SalesRow[]> => {
    const [rollupRes, ordersRes] = await Promise.all([
      supabase.from("asin_sales_daily").select("asin, units").eq("user_id", userId).eq("date", todayPT),
      fetchAllSalesRows(
        supabase.from("sales_orders").select("id, asin, quantity").eq("user_id", userId).eq("order_date", todayPT).neq("asin", "PENDING").not("order_id", "like", "%-REFUND")
      ),
    ]);
    const merged: Record<string, number> = {};
    if (!rollupRes.error && rollupRes.data) {
      for (const r of rollupRes.data) {
        const asin = normalizeIdentifier(r.asin);
        if (asin) merged[asin] = Math.max(merged[asin] || 0, r.units || 0);
      }
    }
    const ordersAgg: Record<string, number> = {};
    for (const r of ordersRes) {
      const asin = normalizeIdentifier(r.asin);
      if (!asin) continue;
      ordersAgg[asin] = (ordersAgg[asin] || 0) + (r.quantity || 1);
    }
    for (const [asin, qty] of Object.entries(ordersAgg)) {
      merged[asin] = Math.max(merged[asin] || 0, qty);
    }
    return Object.entries(merged).map(([asin, quantity]) => ({ asin, quantity }));
  };

  const [todayRows, last7Rows, last30Rows, allHistoricalRows] = await Promise.all([
    fetchTodaySales(),
    fetchAllSalesRows(
      supabase
        .from("sales_orders")
        .select("id, asin, quantity")
        .eq("user_id", userId)
        .gte("order_date", sevenDaysAgoPT)
        .neq("asin", "PENDING")
        .not("order_id", "like", "%-REFUND")
    ),
    fetchAllSalesRows(
      supabase
        .from("sales_orders")
        .select("id, asin, quantity")
        .eq("user_id", userId)
        .gte("order_date", thirtyDaysAgoPT)
        .neq("asin", "PENDING")
        .not("order_id", "like", "%-REFUND")
    ),
    fetchAllHistoricalRows(supabase.from("sales_orders").select("id, asin, quantity, order_date").eq("user_id", userId)),
  ]);

  const salesTodayMap: Record<string, number> = {};
  for (const r of todayRows) {
    const asin = normalizeIdentifier(r.asin);
    if (asin) salesTodayMap[asin] = (salesTodayMap[asin] || 0) + (r.quantity || 1);
  }
  const sales7Map: Record<string, number> = {};
  for (const r of last7Rows) {
    const asin = normalizeIdentifier(r.asin);
    if (asin) sales7Map[asin] = (sales7Map[asin] || 0) + (r.quantity || 1);
  }
  const salesMap: Record<string, number> = {};
  for (const r of last30Rows) {
    const asin = normalizeIdentifier(r.asin);
    if (asin) salesMap[asin] = (salesMap[asin] || 0) + (r.quantity || 1);
  }

  const historicalSalesMap: Record<string, { totalUnits: number; earliestDate: string }> = {};
  
  for (const r of allHistoricalRows) {
    if (!r.asin || r.asin === "PENDING") continue;
    const qty = r.quantity || 1;
    const existing = historicalSalesMap[r.asin];
    if (existing) {
      existing.totalUnits += qty;
      if (r.order_date < existing.earliestDate) existing.earliestDate = r.order_date;
    } else {
      historicalSalesMap[r.asin] = { totalUnits: qty, earliestDate: r.order_date };
    }
  }

  // Title/image enrichment from created_listings and sales_orders as fallback
  const titleImageMap: Record<string, { title?: string; image_url?: string }> = {};
  try {
    const clData = await fetchAllPaged(() =>
      supabase.from("created_listings").select("id, asin, title, image_url").eq("user_id", userId)
    );
    for (const cl of clData) {
      if (!cl.asin) continue;
      const existing = titleImageMap[cl.asin];
      titleImageMap[cl.asin] = {
        title: existing?.title || cl.title || undefined,
        image_url: existing?.image_url || cl.image_url || undefined,
      };
    }
  } catch { /* ignore */ }

  try {
    const soData = await fetchAllPaged(() =>
      supabase.from("sales_orders").select("id, asin, title, image_url").eq("user_id", userId).not("image_url", "is", null)
    );
    for (const so of soData) {
      if (!so.asin || so.asin === "PENDING") continue;
      const existing = titleImageMap[so.asin];
      titleImageMap[so.asin] = {
        title: existing?.title || so.title || undefined,
        image_url: existing?.image_url || so.image_url || undefined,
      };
    }
  } catch { /* ignore */ }

  console.log(`[Repricer] Sales enrichment done: today=${Object.keys(salesTodayMap).length}, 7d=${Object.keys(sales7Map).length}, 30d=${Object.keys(salesMap).length}, historical=${Object.keys(historicalSalesMap).length} ASINs`);

  return { salesTodayMap, sales7Map, salesMap, historicalSalesMap, titleImageMap };
}
// Module-level cache for filter/sort state so it survives tab switches
const _assignmentsFilterCache = {
  searchTerm: "",
  sortKey: "newest" as SortKey,
  sortDir: "desc" as SortDir,
  fulfillmentFilter: "ALL" as "ALL" | "FBA" | "FBM",
  stockFilter: "ALL" as "ALL" | "AVAILABLE" | "RESERVED_INBOUND" | "IN_STOCK" | "OUT_OF_STOCK" | "MANUAL_STAR",
  priceFilter: "HAS_PRICE" as "ALL" | "HAS_PRICE" | "NO_PRICE",
  ruleFilter: "ALL",
   suggestionFilter: "ALL" as "ALL" | "blocked_by_min" | "blocked_needs_you" | "no_sales_30d" | "blocked_review_soon" | "blocked_auto" | "bb_suppressed" | "profit_guard_block" | "HAS_ANY" | "NONE",
   restrictedFilter: "HIDE" as "HIDE" | "SHOW" | "ONLY",
  offerFilter: "HAS_OFFERS" as "ALL" | "HAS_OFFERS" | "NO_OFFERS",
  roiMin: "" as string,
  roiMax: "" as string,
  currentPage: 1,
  pageSize: 50 as 50 | 250,
};

export default function AssignmentsTable({ rules, marketplace = "US", onMarketplaceChange, isAdmin = false, initialSearchTerm }: AssignmentsTableProps) {
  const { user, loading: authLoading } = useAuth();
  const { syncState: globalSyncState } = useSalesSync();
  const { effectivePlan, activeListings } = useSubscription();
  const { homeMarketplace } = useHomeMarketplace();
  const planLimit = effectivePlan?.listing_limit ?? 1000;
  const marketplaceConfig = getMarketplaceConfig(marketplace);

  // Dynamic marketplace detection from seller_authorizations
  // NA marketplaces (US, CA, MX, BR) share the same seller account, so if any NA market
  // is authorized, all NA markets are eligible. Same logic for EU.
  const [eligibleMarketplaces, setEligibleMarketplaces] = useState<string[]>(["US"]);
  useEffect(() => {
    if (!user?.id) return;
    const detect = async () => {
      try {
        const { getMarketplaceFromId, NA_MARKETPLACES, EU_MARKETPLACES } = await import("@/lib/marketplaceCurrency");
        const { data } = await supabase
          .from("seller_authorizations")
          .select("marketplace_id")
          .eq("user_id", user.id);

        if (data && data.length > 0) {
          const directCodes = [...new Set(data.map((d: any) => getMarketplaceFromId(d.marketplace_id)))];
          // Expand: if any NA market found, include all NA markets
          const hasNA = directCodes.some(c => NA_MARKETPLACES.includes(c));
          const hasEU = directCodes.some(c => EU_MARKETPLACES.includes(c));
          const expanded = new Set(directCodes);
          if (hasNA) NA_MARKETPLACES.forEach(m => expanded.add(m));
          if (hasEU) EU_MARKETPLACES.forEach(m => expanded.add(m));
          setEligibleMarketplaces([...expanded]);
        }
      } catch (e) {
        console.error("Failed to detect eligible marketplaces:", e);
      }
    };
    detect();
  }, [user?.id]);

  // Rule name sync effect moved below cachedItems declaration

  // Non-admin users see all NA marketplaces they're SP-API-authorized for
  // (US + Remote Fulfillment: CA/MX/BR). Non-NA marketplaces remain admin-only
  // until the multi-currency expansion project ships — see
  // .lovable/future-currency-unification.md.
  const visibleMarketplaces = useMemo(
    () => {
      const eligible = MARKETPLACE_LIST.filter((mp) => eligibleMarketplaces.includes(mp.id));
      if (!isAdmin) {
        const NA_ALLOWED = ["US", "CA", "MX", "BR"];
        const naEligible = eligible.filter((mp) => NA_ALLOWED.includes(mp.id));
        if (naEligible.length > 0) return naEligible;
        // Fallback: if user has no NA authorizations, show home marketplace only
        const homeEntry = eligible.find((mp) => mp.id === homeMarketplace);
        return homeEntry ? [homeEntry] : eligible.length > 0 ? [eligible[0]] : [];
      }
      return eligible;
    },
    [eligibleMarketplaces, isAdmin, homeMarketplace]
  );
  // Use caching hook for data persistence
  const fetchFn = useCallback(async () => {
    if (!user?.id) return [];
    return fetchRepricerData(user.id, marketplace);
  }, [user?.id, marketplace]);

  const {
    data: cachedItems,
    loading,
    isRefreshing,
    settled: marketplaceSettled,
    refresh: fetchData,
    updateData: setItemsCache,
  } = useRepricerCache<InventoryWithAssignment[]>(fetchFn, user?.id, marketplace);

  const items = cachedItems || [];
  // Phase 7+ parity with SyncedInventory: when a Created Listing (purchase record)
  // exists for an ASIN, the unit cost is sourced from Product Library and must be
  // read-only here. Only ASINs without a purchase record allow inline cost editing.
  const { hasPurchaseRecord } = useAsinPurchaseRecords(
    items.map((i) => i.asin).filter(Boolean) as string[],
  );
  const [salesMetricsReady, setSalesMetricsReady] = useState(false);

  useEffect(() => {
    setSalesMetricsReady(false);
  }, [user?.id, marketplace]);


  // Live Sales Popup
  const [liveSalesOpen, setLiveSalesOpen] = useState(false);

  const salesEnrichmentDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user?.id || !cachedItems || cachedItems.length === 0) return;
    const key = `${user.id}_${marketplace}`;
    if (salesEnrichmentDoneRef.current === key) return; // already enriched for this marketplace
    salesEnrichmentDoneRef.current = key;

    let cancelled = false;
    fetchSalesEnrichment(user.id, marketplace).then(enrichment => {
      if (cancelled) return;
      const getDaysSince = (dateStr: string): number => {
        const diffMs = Date.now() - new Date(dateStr).getTime();
        return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      };
      setItemsCache(prev => {
        if (!prev) return prev;
        return (prev as InventoryWithAssignment[]).map(item => {
          const normAsin = normalizeIdentifier(item.asin);
          const hist = enrichment.historicalSalesMap[item.asin];
          const titleEnrich = enrichment.titleImageMap[item.asin];
          const needsTitleEnrich = !item.title || item.title === '' || item.title.toLowerCase().includes('unknown') || item.title.toLowerCase().includes('untitled');
          return {
            ...item,
            units_sold_today: enrichment.salesTodayMap[normAsin] ?? 0,
            units_sold_7d: enrichment.sales7Map[normAsin] ?? 0,
            units_sold_30d: enrichment.salesMap[normAsin] ?? 0,
            historical_sales: hist?.totalUnits ?? item.historical_sales ?? null,
            historical_days: hist ? getDaysSince(hist.earliestDate) : item.historical_days ?? null,
            title: needsTitleEnrich && titleEnrich?.title ? titleEnrich.title : item.title,
            image_url: item.image_url || titleEnrich?.image_url || null,
          };
        });
      });
      setSalesMetricsReady(true);
    }).catch(e => console.error("[Repricer] Sales enrichment failed:", e));

    return () => { cancelled = true; };
  }, [user?.id, marketplace, cachedItems, setItemsCache]);
  
  // Wrapper to update items in cache
  const setItems = useCallback((newItems: InventoryWithAssignment[] | ((prev: InventoryWithAssignment[]) => InventoryWithAssignment[])) => {
    if (typeof newItems === "function") {
      setItemsCache(prev => newItems(prev || []));
    } else {
      setItemsCache(() => newItems);
    }
  }, [setItemsCache]);

  // Sync rule names when rules prop changes OR when cached items load (e.g. after tab switch)
  useEffect(() => {
    if (!rules || rules.length === 0 || !cachedItems || cachedItems.length === 0) return;
    const ruleNameMap = new Map(rules.map(r => [r.id, r.name]));
    setItems(prev => {
      let changed = false;
      const updated = prev.map(i => {
        if (!i.rule_id) return i;
        const newName = ruleNameMap.get(i.rule_id);
        if (newName && newName !== i.rule_name) {
          changed = true;
          return { ...i, rule_name: newName };
        }
        return i;
      });
      return changed ? updated : prev;
    });
  }, [rules, cachedItems]);

  const [searchTerm, setSearchTerm] = useState(_assignmentsFilterCache.searchTerm);

  // One-time deep-link search (e.g. from a Buy Box alert's "Fix Price Now"
  // button) — applies once per incoming value, then never overrides the
  // user's own subsequent edits to the search box.
  const appliedInitialSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialSearchTerm) return;
    if (appliedInitialSearchRef.current === initialSearchTerm) return;
    appliedInitialSearchRef.current = initialSearchTerm;
    setSearchTerm(initialSearchTerm);
  }, [initialSearchTerm]);

  const [liveTodayUnitsByAsin, setLiveTodayUnitsByAsin] = useState<Record<string, number>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncingMinMax, setSyncingMinMax] = useState<Set<string>>(new Set());
  const [raisingToRoi, setRaisingToRoi] = useState<Set<string>>(new Set());

  const raiseToTargetRoi = async (item: any, targetRoi: number) => {
    if (!item?.asin || !item?.rule_id || !marketplace) return;
    setRaisingToRoi(prev => { const next = new Set(prev); next.add(item.id); return next; });
    const tid = toast.loading(`Recalculating Min for ${item.asin} @ ${targetRoi}% ROI…`);
    try {
      const { data, error } = await supabase.functions.invoke('apply-min-roi', {
        body: {
          rule_id: item.rule_id,
          marketplace,
          min_roi_percent: Number(targetRoi),
          asins: [item.asin],
        },
      });
      if (error) throw error;
      const result = ((data?.results || []) as any[]).find(r => r?.asin === item.asin) ?? (data?.results || [])[0];
      const newMin = Number(result?.new_min);
      const canStagePrice = Number.isFinite(newMin) && newMin > 0 && !['no_cost_data', 'live_roi_floor_failed', 'db_error'].includes(result?.reason);
      if (canStagePrice) {
        const stagedPrice = newMin.toFixed(2);
        capturePendingSnapshot(item);
        // Always copy the effective Min into Set Price, even when Min was already matching.
        setEditingNewPrice(prev => ({ ...prev, [item.id]: stagedPrice }));
        setPendingNewPrice(prev => ({ ...prev, [item.id]: newMin }));
        setPendingChanges(prev => new Set(prev).add(item.id));
        setItems(prev => prev.map(i => i.id === item.id ? {
          ...i,
          min_price_override: newMin,
          roi_at_min_percent: Number.isFinite(Number(result?.actual_roi)) ? Number(result.actual_roi) : i.roi_at_min_percent,
          ...(result?.new_max != null ? { max_price_override: Number(result.new_max) } : {}),
        } : i));
      }
      if (data?.updated > 0) {
        toast.success(
          `Min set to $${newMin.toFixed(2)} — copied into Set Price, press toggle to push`,
          { id: tid }
        );
        // Intentionally NO fetchData() here — local state was already updated optimistically
        // above (min_price_override, roi_at_min_percent, max_price_override). A refetch would
        // blank the entire table to "Loading inventory…" which is jarring for one-row edits.
      } else if (canStagePrice) {
        toast.success(
          `Min already set to $${newMin.toFixed(2)} — copied into Set Price, press toggle to push`,
          { id: tid }
        );
      } else {
        const reason = result?.reason ?? 'already_matching';
        const friendly: Record<string, string> = {
          no_cost_data: `${item.asin}: No unit cost recorded for SKU ${item.sku ?? ''} — set a cost first, ROI cannot be computed`,
          live_roi_floor_failed: `${item.asin}: Could not compute live ROI floor (missing fees/cost data)`,
          db_error: `${item.asin}: Database error while saving new Min`,
        };
        const msg = friendly[reason] ?? `${item.asin}: ${reason}`;
        if (reason === 'already_matching') {
          toast.info(msg, { id: tid });
        } else {
          toast.error(msg, { id: tid, duration: 8000 });
        }
      }
    } catch (e: any) {
      toast.error(`Raise failed: ${e?.message ?? 'unknown error'}`, { id: tid });
    } finally {
      setRaisingToRoi(prev => { const next = new Set(prev); next.delete(item.id); return next; });
    }
  };

  const [runningSelected, setRunningSelected] = useState(false);
  const [runningStaleInStock, setRunningStaleInStock] = useState(false);
  const [runningBulkDisable, setRunningBulkDisable] = useState(false);
  const [bulkRuleId, setBulkRuleId] = useState<string>("");
  const [bulkApplying, setBulkApplying] = useState(false);
  const [savingAll, setSavingAll] = useState(false);

  // Inline editing state
  const [editingMinPrice, setEditingMinPrice] = useState<Record<string, string>>({});
  const [editingMaxPrice, setEditingMaxPrice] = useState<Record<string, string>>({});
  const [editingMinRoi, setEditingMinRoi] = useState<Record<string, string>>({});
  const [editingNewPrice, setEditingNewPrice] = useState<Record<string, string>>({});
  const [editingCost, setEditingCost] = useState<Record<string, string>>({});
  const [savingCost, setSavingCost] = useState<Set<string>>(new Set());
  
  // Track new price values to push to Amazon
  const [pendingNewPrice, setPendingNewPrice] = useState<Record<string, number | null>>({});
  
  // Track pending changes per item (for Save button activation)
  const [pendingChanges, setPendingChanges] = useState<Set<string>>(new Set());
  // Track items that need eval after rule change (shows green triangle)
  const [needsEval, setNeedsEval] = useState<Set<string>>(new Set());
  // Post-save grace window: rows whose min/max override was just written from
  // the client. Guards refreshPricesAndAssignments against briefly overwriting
  // the just-saved value with a stale read (Supabase pooler read-after-write
  // race, ~1s window; the inventory realtime UPDATE debounces a refetch that
  // otherwise clobbers the fresh value and produces a visible flicker
  // "new → old → new" when the user presses the green Save toggle).
  const JUST_SAVED_OVERRIDE_GRACE_MS = 5000;
  const justSavedOverrideAtRef = useRef<Record<string, number>>({});
  const pendingStateSnapshotRef = useRef<Record<string, {
    min_price_override: number | null;
    inv_min_price: number | null;
    max_price_override: number | null;
    inv_max_price: number | null;
    min_roi_override: number | null;
    pending_new_price: number | null;
    rule_id: string | null;
    is_enabled: boolean;
  }>>({});

  const normalizePendingValue = (value: number | null | undefined) => {
    if (value == null) return null;
    const num = Number(value);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
  };

  const capturePendingSnapshot = (item: InventoryWithAssignment) => {
    if (pendingStateSnapshotRef.current[item.id]) return;
    pendingStateSnapshotRef.current[item.id] = {
      min_price_override: item.min_price_override,
      inv_min_price: item.inv_min_price,
      max_price_override: item.max_price_override,
      inv_max_price: item.inv_max_price,
      min_roi_override: item.min_roi_override,
      pending_new_price: normalizePendingValue(pendingNewPrice[item.id]),
      rule_id: item.rule_id,
      is_enabled: item.is_enabled,
    };
  };

  const clearPendingSnapshot = (itemId: string) => {
    delete pendingStateSnapshotRef.current[itemId];
  };

  const hasReturnedToPendingSnapshot = (
    item: InventoryWithAssignment,
    overrides?: Partial<InventoryWithAssignment>,
    nextPendingNewPrice?: number | null,
    useProvidedPendingNewPrice = false,
  ) => {
    const snapshot = pendingStateSnapshotRef.current[item.id];
    if (!snapshot) return false;

    const nextItem = { ...item, ...overrides };
    const nextEffectiveMin = normalizePendingValue(nextItem.min_price_override ?? nextItem.inv_min_price);
    const nextEffectiveMax = normalizePendingValue(nextItem.max_price_override ?? nextItem.inv_max_price);
    const snapshotEffectiveMin = normalizePendingValue(snapshot.min_price_override ?? snapshot.inv_min_price);
    const snapshotEffectiveMax = normalizePendingValue(snapshot.max_price_override ?? snapshot.inv_max_price);
    const effectivePendingNewPrice = useProvidedPendingNewPrice
      ? normalizePendingValue(nextPendingNewPrice)
      : normalizePendingValue(nextPendingNewPrice ?? pendingNewPrice[item.id]);

    return (
      nextEffectiveMin === snapshotEffectiveMin &&
      nextEffectiveMax === snapshotEffectiveMax &&
      normalizePendingValue(nextItem.min_roi_override) === normalizePendingValue(snapshot.min_roi_override) &&
      effectivePendingNewPrice === normalizePendingValue(snapshot.pending_new_price) &&
      nextItem.rule_id === snapshot.rule_id &&
      nextItem.is_enabled === snapshot.is_enabled
    );
  };
  
  // Track items currently fetching prices
  const [fetchingPrice, setFetchingPrice] = useState<Set<string>>(new Set());
  
  // Track items currently calculating ROI
  const [fetchingRoi, setFetchingRoi] = useState<Set<string>>(new Set());
  
  // Track items currently calculating Buy Box ROI
  const [fetchingBbRoi, setFetchingBbRoi] = useState<Set<string>>(new Set());

  // Track items currently syncing Min<->ROI
  const [syncingMinRoi, setSyncingMinRoi] = useState<Set<string>>(new Set());
  
  // Track items currently calculating ROI Range
  const [fetchingRoiRange, setFetchingRoiRange] = useState<Set<string>>(new Set());
  
  // Action log dialog state
  const [actionLogOpen, setActionLogOpen] = useState(false);
  const [suggestionPanelOpen, setSuggestionPanelOpen] = useState(false);
  const [actionLogAsin, setActionLogAsin] = useState<string | null>(null);
  const [actionLogSku, setActionLogSku] = useState<string | null>(null);
  const [actionLogStatus, setActionLogStatus] = useState<string | null>(null);
  const [actionLogItemId, setActionLogItemId] = useState<string | null>(null);
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [verifyItem, setVerifyItem] = useState<InventoryWithAssignment | null>(null);
  
  // Track items being reset
  const [resettingPrice, setResettingPrice] = useState<Set<string>>(new Set());
  
  // Track items syncing bounds from Amazon
  const [syncingBounds, setSyncingBounds] = useState<Set<string>>(new Set());
  
  // Track items being resumed (unpaused)
  const [resumingItem, setResumingItem] = useState<Set<string>>(new Set());

  // Cached FX rate for the current marketplace (fetched once on marketplace change)
  const [cachedFxRate, setCachedFxRate] = useState<number>(1);

  // Fetch FX rate when marketplace changes
  useEffect(() => {
    if (marketplace === "US" || !marketplace) {
      setCachedFxRate(1);
      return;
    }
    const mpConfig = getMarketplaceConfig(marketplace);
    const fetchRate = async () => {
      try {
        const { data: fxRow } = await supabase
          .from("fx_rates")
          .select("rate")
          .eq("base", "USD")
          .eq("quote", mpConfig.currency)
          .order("as_of", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (fxRow?.rate) {
          setCachedFxRate(Number(fxRow.rate));
        } else {
          // Fallback if no DB rate
          const fallback: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0, GBP: 0.79, EUR: 0.92 };
          setCachedFxRate(fallback[mpConfig.currency] || 1);
        }
      } catch {
        const fallback: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0, GBP: 0.79, EUR: 0.92 };
        setCachedFxRate(fallback[mpConfig.currency] || 1);
      }
    };
    fetchRate();
  }, [marketplace]);

  // Stable refs for polling callbacks — prevents dependency cascade
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Tracks the CURRENT marketplace synchronously, so an in-flight background
  // refresh started for the marketplace the user just left can detect it's
  // now stale and discard its result instead of overwriting the new
  // marketplace's price with the old marketplace's value (see
  // refreshPricesAndAssignments / fetchPriceForItem below).
  const marketplaceRef = useRef(marketplace);
  marketplaceRef.current = marketplace;
  const editingMinPriceRef = useRef(editingMinPrice);
  editingMinPriceRef.current = editingMinPrice;
  const editingMaxPriceRef = useRef(editingMaxPrice);
  editingMaxPriceRef.current = editingMaxPrice;
  // Track unsaved staged changes so the background poll never reverts a row
  // the user has edited locally but not yet clicked Save on.
  const pendingChangesRef = useRef(pendingChanges);
  pendingChangesRef.current = pendingChanges;

  // ============================================================
  // LIVE SALES POLLING — refresh Sold Today / 7d / 30d every 2 minutes
  // Lightweight: only queries asin_sales_daily + sales_orders counts,
  // then merges into existing items state without a full table reload.
  // ============================================================
  const salesPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!user?.id || items.length === 0) return;

    const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
    const AMAZON_TZ = "America/Los_Angeles";

    const pollSales = async () => {
      try {
        const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: AMAZON_TZ });
        const addDays = (iso: string, d: number) => {
          const dt = new Date(iso + "T12:00:00");
          dt.setDate(dt.getDate() + d);
          return dt.toISOString().slice(0, 10);
        };
        const sevenAgo = addDays(todayStr, -7);
        const thirtyAgo = addDays(todayStr, -30);
        const uid = user.id;

        // Fetch today (rollup + orders), 7d, 30d in parallel
        const [todayRollupRes, todayOrdersRes, d7Res, d30Res] = await Promise.all([
          supabase
            .from("asin_sales_daily")
            .select("asin, units")
            .eq("user_id", uid)
            .eq("date", todayStr),
          supabase
            .from("sales_orders")
            .select("asin, quantity")
            .eq("user_id", uid)
            .eq("order_date", todayStr)
            .neq("asin", "PENDING")
            .not("order_id", "like", "%-REFUND")
            .limit(5000),
          supabase
            .from("sales_orders")
            .select("asin, quantity")
            .eq("user_id", uid)
            .gte("order_date", sevenAgo)
            .neq("asin", "PENDING")
            .not("order_id", "like", "%-REFUND")
            .limit(5000),
          supabase
            .from("sales_orders")
            .select("asin, quantity")
            .eq("user_id", uid)
            .gte("order_date", thirtyAgo)
            .neq("asin", "PENDING")
            .not("order_id", "like", "%-REFUND")
            .limit(10000),
        ]);

        // Merge rollup + orders for today — take max per ASIN
        const todayMap: Record<string, number> = {};
        for (const r of (todayRollupRes.data || [])) {
          const a = normalizeIdentifier(r.asin);
          if (a) todayMap[a] = Math.max(todayMap[a] || 0, r.units || 0);
        }
        const ordersAgg: Record<string, number> = {};
        for (const r of (todayOrdersRes.data || [])) {
          const a = normalizeIdentifier((r as any).asin);
          if (a) ordersAgg[a] = (ordersAgg[a] || 0) + ((r as any).quantity || 1);
        }
        for (const [a, qty] of Object.entries(ordersAgg)) {
          todayMap[a] = Math.max(todayMap[a] || 0, qty);
        }

        const totalTodayUnits = Object.values(todayMap).reduce((a, b) => a + b, 0);
        setLiveTodayUnitsByAsin(todayMap);
        setSalesMetricsReady(true);
        console.log(`[Repricer LiveSales] Poll complete: rollup=${todayRollupRes.data?.length || 0} ASINs, orders=${todayOrdersRes.data?.length || 0} rows, merged=${Object.keys(todayMap).length} ASINs, totalUnits=${totalTodayUnits}, visiblePositive=${items.filter(i => (todayMap[normalizeIdentifier(i.asin)] || 0) > 0).length}`);

        const d7Map: Record<string, number> = {};
        for (const r of d7Res.data || []) {
          const a = normalizeIdentifier((r as any).asin);
          if (a) d7Map[a] = (d7Map[a] || 0) + ((r as any).quantity || 1);
        }

        const d30Map: Record<string, number> = {};
        for (const r of d30Res.data || []) {
          const a = normalizeIdentifier((r as any).asin);
          if (a) d30Map[a] = (d30Map[a] || 0) + ((r as any).quantity || 1);
        }

        // Merge into items — ALWAYS apply fresh sales values.
        // IDB cache zeroes out today/7d/30d on load, so the poll is the
        // authoritative source for these fields.
        setItems(prev => {
          let changed = false;
          const updated = prev.map(item => {
            const normalizedAsin = normalizeIdentifier(item.asin);
            const newToday = todayMap[normalizedAsin] || 0;
            const new7d = d7Map[normalizedAsin] || 0;
            const new30d = d30Map[normalizedAsin] || 0;
            if (
              item.units_sold_today === newToday &&
              item.units_sold_7d === new7d &&
              item.units_sold_30d === new30d
            ) {
              return item;
            }
            changed = true;
            return { ...item, units_sold_today: newToday, units_sold_7d: new7d, units_sold_30d: new30d };
          });
          if (changed) {
            console.log(`[Repricer LiveSales] Applied: Today=${totalTodayUnits} units across ${Object.keys(todayMap).length} ASINs`);
            // Diagnostic: log one sample ASIN for end-to-end tracing
            const sampleAsin = Object.keys(todayMap)[0];
            if (sampleAsin) {
              const before = prev.find(i => i.asin === sampleAsin);
              const after = updated.find(i => i.asin === sampleAsin);
              console.log(`[Repricer LiveSales] Sample ${sampleAsin}: before=${before?.units_sold_today} → after=${after?.units_sold_today}`);
            }
          }
          return changed ? updated : prev;
        });
      } catch (err) {
        console.warn("[Repricer LiveSales] Poll failed:", err);
      }
    };

    // Run immediately on mount/marketplace change, then every 2 minutes
    pollSales();
    salesPollRef.current = setInterval(pollSales, POLL_INTERVAL_MS);

    return () => {
      if (salesPollRef.current) {
        clearInterval(salesPollRef.current);
        salesPollRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, marketplace, items.length > 0]);

  // ============================================================
  // LIGHTWEIGHT PRICE + ASSIGNMENT REFRESH
  // Polls inventory price + stock fields and assignment fields so the table
  // stays fresh after repricer writes and inventory syncs without a full reload.
  // Realtime handles instant updates when available; polling is the fallback.
  // ============================================================
  const refreshPricesAndAssignments = useCallback(async () => {
    const currentItems = itemsRef.current;
    if (!user?.id || currentItems.length === 0) return;
    try {
      const targetMp = marketplace || "US";
      const mpConfig = getMarketplaceConfig(targetMp);

      const skus = [...new Set(currentItems.map(i => i.sku).filter(Boolean))];
      const BATCH = 500;
      const priceMap: Record<string, number | null> = {};
      const stockMap: Record<string, {
        available: number | null;
        reserved: number | null;
        inbound: number | null;
        unfulfilled: number | null;
        listing_status: string | null;
      }> = {};

      // Stock always comes from inventory (shared source of truth for qty/status).
      // For US, this also gives us the live price fields.
      for (let i = 0; i < skus.length; i += BATCH) {
        const batch = skus.slice(i, i + BATCH);
        const { data } = await supabase
          .from("inventory")
          .select("sku, my_price, price, available, reserved, inbound, unfulfilled, listing_status")
          .eq("user_id", user.id)
          .in("sku", batch);
        for (const row of data || []) {
          stockMap[row.sku] = {
            available: row.available ?? null,
            reserved: row.reserved ?? null,
            inbound: row.inbound ?? null,
            unfulfilled: row.unfulfilled ?? null,
            listing_status: row.listing_status ?? null,
          };
          if (targetMp === "US") {
            priceMap[row.sku] = row.my_price ?? row.price;
          }
        }
      }

      if (targetMp !== "US") {
        // For non-US, price still comes from marketplace cache.
        // Matched by (asin, sku) together — an ASIN can have more than one
        // SKU in the same marketplace (e.g. an old/disabled listing kept
        // alongside the active one). Matching by asin alone let a disabled
        // SKU's stale cached price silently overwrite the active SKU's
        // priceMap entry (and vice versa), even though min/max stayed correct.
        const asins = [...new Set(currentItems.map(i => i.asin))];
        for (let i = 0; i < asins.length; i += BATCH) {
          const batch = asins.slice(i, i + BATCH);
          const { data } = await supabase
            .from("asin_my_price_cache")
            .select("asin, seller_sku, my_price")
            .eq("user_id", user.id)
            .eq("marketplace_id", mpConfig.marketplaceId)
            .in("asin", batch);
          for (const row of data || []) {
            for (const item of currentItems) {
              if (item.asin === row.asin && item.sku === (row as any).seller_sku) {
                priceMap[item.sku] = row.my_price;
              }
            }
          }
        }
      }

      const assignmentMap: Record<string, any> = {};
      const assignmentIds = currentItems.map(i => i.assignment_id).filter(Boolean) as string[];
      const refreshMp = marketplace || "US";
      for (let i = 0; i < assignmentIds.length; i += BATCH) {
        const batch = assignmentIds.slice(i, i + BATCH);
        const { data } = await supabase
          .from("repricer_assignments")
          .select("id, sku, marketplace, last_recommended_price, last_recommendation_reason, last_evaluated_at, status, last_error_type, last_error_message, consecutive_failures, min_price_override, max_price_override, manual_min_price")
          .in("id", batch)
          .eq("marketplace", refreshMp); // Marketplace guard — never accept another mkt's row
        for (const row of data || []) {
          assignmentMap[row.id] = row;
        }
      }

      // Marketplace guard: if the user switched tabs while these awaits were
      // in flight, this whole result is for the marketplace they just left.
      // Discard it entirely rather than let its (marketplace-agnostic,
      // sku-keyed) price map land on top of the new marketplace's rows —
      // that's what produced the "min > price" flash: min/max are keyed by
      // assignment_id (marketplace-specific, so a stale batch is a no-op),
      // but price was keyed by sku (shared across marketplaces), so a stale
      // batch could silently overwrite the new marketplace's price.
      if (marketplaceRef.current !== targetMp) return;

      const currentEditingMin = editingMinPriceRef.current;
      const currentEditingMax = editingMaxPriceRef.current;

      setItems(prev => {
        let changed = false;
        const updated = prev.map(item => {
          const newPrice = priceMap[item.sku];
          const stockUpdate = stockMap[item.sku];
          const assignUpdate = item.assignment_id ? assignmentMap[item.assignment_id] : null;

          const updatedMyPrice = newPrice !== undefined ? newPrice : item.my_price;
          const updatedPrice = newPrice !== undefined ? newPrice : item.price;
          const updatedAvailable = stockUpdate ? stockUpdate.available : item.available;
          const updatedReserved = stockUpdate ? stockUpdate.reserved : item.reserved;
          const updatedInbound = stockUpdate ? stockUpdate.inbound : item.inbound;
          const updatedUnfulfilled = stockUpdate ? stockUpdate.unfulfilled : item.unfulfilled;
          const updatedListingStatus = stockUpdate ? stockUpdate.listing_status : item.listing_status;

          // A row is "locally edited" if its input is currently focused/typed in,
          // OR if it has unsaved staged changes (blur clears the editing string but
          // the user still hasn't clicked Save — we must not let polling revert it),
          // OR if it was JUST SAVED from this client within the grace window (guards
          // against a stale post-write read overwriting the fresh override — the
          // "new → old → new" flicker on the green Save toggle).
          const isPendingUnsaved = pendingChangesRef.current.has(item.id);
          const savedAt = justSavedOverrideAtRef.current[item.id];
          const inSaveGrace = savedAt != null && (Date.now() - savedAt) < JUST_SAVED_OVERRIDE_GRACE_MS;
          if (savedAt != null && !inSaveGrace) {
            // Grace window expired — clear the stamp so the map doesn't grow unbounded.
            delete justSavedOverrideAtRef.current[item.id];
          }
          const hasLocalMinEdit = isPendingUnsaved || inSaveGrace || (currentEditingMin[item.id] !== undefined && currentEditingMin[item.id] !== "");
          const hasLocalMaxEdit = isPendingUnsaved || inSaveGrace || (currentEditingMax[item.id] !== undefined && currentEditingMax[item.id] !== "");

          const priceChanged = updatedMyPrice !== item.my_price || updatedPrice !== item.price;
          const stockChanged =
            updatedAvailable !== item.available ||
            updatedReserved !== item.reserved ||
            updatedInbound !== item.inbound ||
            updatedUnfulfilled !== item.unfulfilled ||
            updatedListingStatus !== item.listing_status;
          const assignChanged = !!assignUpdate && (
            assignUpdate.last_recommended_price !== item.last_recommended_price ||
            assignUpdate.last_evaluated_at !== item.last_evaluated_at ||
            assignUpdate.status !== item.status ||
            (!hasLocalMinEdit && assignUpdate.min_price_override !== item.min_price_override) ||
            (!hasLocalMaxEdit && assignUpdate.max_price_override !== item.max_price_override) ||
            assignUpdate.manual_min_price !== item.manual_min_price
          );

          if (!priceChanged && !stockChanged && !assignChanged) return item;

          changed = true;
          return {
            ...item,
            my_price: updatedMyPrice,
            price: updatedPrice,
            available: updatedAvailable,
            reserved: updatedReserved,
            inbound: updatedInbound,
            unfulfilled: updatedUnfulfilled,
            listing_status: updatedListingStatus,
            ...(assignUpdate ? {
              last_recommended_price: assignUpdate.last_recommended_price ?? item.last_recommended_price,
              last_recommendation_reason: assignUpdate.last_recommendation_reason ?? item.last_recommendation_reason,
              last_evaluated_at: assignUpdate.last_evaluated_at ?? item.last_evaluated_at,
              status: assignUpdate.status ?? item.status,
              last_error_type: assignUpdate.last_error_type,
              last_error_message: assignUpdate.last_error_message,
              consecutive_failures: assignUpdate.consecutive_failures ?? 0,
              min_price_override: hasLocalMinEdit ? item.min_price_override : (assignUpdate.min_price_override ?? item.min_price_override),
              max_price_override: hasLocalMaxEdit ? item.max_price_override : (assignUpdate.max_price_override ?? item.max_price_override),
              manual_min_price: assignUpdate.manual_min_price ?? item.manual_min_price,
            } : {}),
          };
        });

        if (changed) {
          const priceChanges = updated.filter((u, idx) => u.my_price !== prev[idx]?.my_price || u.price !== prev[idx]?.price).length;
          const stockChanges = updated.filter((u, idx) =>
            u.available !== prev[idx]?.available ||
            u.reserved !== prev[idx]?.reserved ||
            u.inbound !== prev[idx]?.inbound ||
            u.unfulfilled !== prev[idx]?.unfulfilled ||
            u.listing_status !== prev[idx]?.listing_status
          ).length;
          console.log(`[Repricer LiveRefresh] Applied: ${priceChanges} price updates, ${stockChanges} stock updates`);
        }

        return changed ? updated : prev;
      });
    } catch (err) {
      console.warn("[Repricer LiveRefresh] Poll failed:", err);
    }
  }, [user?.id, marketplace, setItems]);

  const inventoryRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime qty/status updates for rows already visible in the repricer table.
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`repricer-inventory-live-${user.id}-${marketplace || "US"}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "inventory",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const nextRow = payload.new as {
            sku?: string;
            available?: number | null;
            reserved?: number | null;
            inbound?: number | null;
            unfulfilled?: number | null;
            listing_status?: string | null;
          };

          if (!nextRow?.sku) return;

          setItems(prev => {
            let changed = false;
            const updated = prev.map(item => {
              if (item.sku !== nextRow.sku) return item;

              const nextAvailable = nextRow.available ?? null;
              const nextReserved = nextRow.reserved ?? null;
              const nextInbound = nextRow.inbound ?? null;
              const nextUnfulfilled = nextRow.unfulfilled ?? null;
              const nextListingStatus = nextRow.listing_status ?? null;

              if (
                item.available === nextAvailable &&
                item.reserved === nextReserved &&
                item.inbound === nextInbound &&
                item.unfulfilled === nextUnfulfilled &&
                item.listing_status === nextListingStatus
              ) {
                return item;
              }

              changed = true;
              return {
                ...item,
                available: nextAvailable,
                reserved: nextReserved,
                inbound: nextInbound,
                unfulfilled: nextUnfulfilled,
                listing_status: nextListingStatus,
              };
            });
            return changed ? updated : prev;
          });

          if (inventoryRefreshDebounceRef.current) {
            clearTimeout(inventoryRefreshDebounceRef.current);
          }
          inventoryRefreshDebounceRef.current = setTimeout(() => {
            void refreshPricesAndAssignments();
          }, 1000);
        }
      )
      .subscribe();

    return () => {
      if (inventoryRefreshDebounceRef.current) {
        clearTimeout(inventoryRefreshDebounceRef.current);
        inventoryRefreshDebounceRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [user?.id, marketplace, setItems, refreshPricesAndAssignments]);

  // Poll price + stock as a fallback in case Realtime is delayed/unavailable.
  const pricePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef(refreshPricesAndAssignments);
  refreshRef.current = refreshPricesAndAssignments;
  const hasItems = items.length > 0;
  useEffect(() => {
    if (!user?.id || !hasItems) return;

    pricePollRef.current = setInterval(() => refreshRef.current(), 30 * 1000);

    return () => {
      if (pricePollRef.current) {
        clearInterval(pricePollRef.current);
        pricePollRef.current = null;
      }
    };
  }, [user?.id, hasItems]);

  // Publish the SAME busy signal the 15-minute refresh already defers on, so
  // AppVersionGate can see it from the app root. These fetches write price,
  // cost and ROI back into local state; a reload mid-flight discards them.
  useEffect(() => {
    const busy =
      fetchingPrice.size > 0 ||
      fetchingRoi.size > 0 ||
      fetchingBbRoi.size > 0 ||
      fetchingRoiRange.size > 0;
    setAppBusy("repricer:price-fetch", busy);
    return () => setAppBusy("repricer:price-fetch", false);
  }, [fetchingPrice.size, fetchingRoi.size, fetchingBbRoi.size, fetchingRoiRange.size]);

  // Hard refresh full repricer dataset every 15 minutes (no manual browser refresh needed)
  // IMPORTANT: Skip background refreshes while price fetches are active to prevent
  // overwriting local state changes (min/max, ROI, price) with stale DB data.
  useEffect(() => {
    if (!user?.id) return;

    const HARD_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
    const intervalId = setInterval(() => {
      if (fetchingPrice.size > 0 || fetchingRoi.size > 0 || fetchingBbRoi.size > 0 || fetchingRoiRange.size > 0) {
        console.log(`[Repricer] 15-min refresh DEFERRED — ${fetchingPrice.size} price fetches in progress`);
        return;
      }
      console.log(`[Repricer] 15-min hard refresh triggered for ${marketplace}`);
      fetchData();
    }, HARD_REFRESH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [user?.id, marketplace, fetchData, fetchingPrice.size, fetchingRoi.size, fetchingBbRoi.size, fetchingRoiRange.size]);

  // Immediately hard refresh when global background sales sync completes
  useEffect(() => {
    if (!user?.id) return;
    if (globalSyncState.status !== "success" || !globalSyncState.lastSyncAt) return;
    // Defer if price fetches are active
    if (fetchingPrice.size > 0 || fetchingRoi.size > 0) {
      console.log("[Repricer] Sales sync refresh DEFERRED — price fetches in progress");
      return;
    }

    console.log("[Repricer] Global sales sync completed — forcing repricer data refresh");
    fetchData();
  }, [user?.id, globalSyncState.status, globalSyncState.lastSyncAt, fetchData, fetchingPrice.size, fetchingRoi.size]);

  // Auto-fetch competitive data for items missing Low/BB snapshot data
  // This ensures the unavailability filter works accurately
  const [autoFetchingSnapshots, setAutoFetchingSnapshots] = useState(false);
  const autoFetchedRef = useRef<Set<string>>(new Set());
  
  // Reset auto-fetch tracking when marketplace changes
  useEffect(() => { autoFetchedRef.current.clear(); }, [marketplace]);

  // Helper: detect quota/rate-limit errors from SP-API responses
  const isRateLimitError = (compError: any, compData: any): boolean => {
    if (compError) {
      const errMsg = compError?.message || '';
      const errContext = (compError as any)?.context;
      const contextStatus = errContext?.status ?? errContext?.statusCode;
      if (contextStatus === 429 || errMsg.includes('429') || errMsg.includes('exceeded your quota') || errMsg.includes('QuotaExceeded')) return true;
    }
    if (compData?.success === false && typeof compData?.error === 'string' && compData.error.includes('exceeded your quota')) return true;
    return false;
  };

  // Auto-fetch for CURRENT marketplace items missing snapshots
  useEffect(() => {
    if (!user?.id || loading || items.length === 0 || autoFetchingSnapshots) return;

    const missingSnapshotItems = items.filter(
      i => i.lowest_overall_price == null && i.buybox_price == null && !i.snapshot_fetched_at
        && !autoFetchedRef.current.has(`${i.asin}_${marketplace}`)
        // Skip INACTIVE listings with zero stock — they produce empty snapshots
        && !(i.listing_status === 'INACTIVE' && (i.available ?? 0) === 0 && (i.reserved ?? 0) === 0 && (i.inbound ?? 0) === 0)
    );

    if (missingSnapshotItems.length === 0) return;

    const batch = missingSnapshotItems.slice(0, 3);
    console.log(`[Repricer] Auto-fetching competitive data for ${batch.length} items missing snapshots (${missingSnapshotItems.length} total)`);

    const fetchMissing = async () => {
      setAutoFetchingSnapshots(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        for (const item of batch) {
          autoFetchedRef.current.add(`${item.asin}_${marketplace}`);
        }

        let hitRateLimit = false;
        for (const item of batch) {
          if (hitRateLimit) break;
          try {
            const spResult = await invokeEdgeFunction({
              functionName: "repricer-sp-api-pricing",
              body: { asin: item.asin, sku: item.sku, marketplace },
              headers: { Authorization: `Bearer ${session.access_token}` },
              context: { asin: item.asin, sku: item.sku },
            });
            const compData = spResult.ok ? spResult.data : null;
            const compError = spResult.ok ? null : new Error(spResult.errorMessage || "SP-API error");

            if (isRateLimitError(compError, compData)) {
              console.warn('[Repricer] Auto-fetch hit rate limit, pausing for 60s');
              hitRateLimit = true;
              for (const b of batch) {
                autoFetchedRef.current.delete(`${b.asin}_${marketplace}`);
              }
              break;
            }

            if (compError) {
              console.warn(`[Repricer] Auto-fetch error for ${item.asin}:`, compError?.message);
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }

            if (compData?.success && compData.data) {
              const cd = compData.data;

              // Guard: Don't persist empty snapshots (no pricing data = waste)
              const hasUsableData = cd.buyboxPrice != null || cd.lowestFbaPrice != null || cd.lowestOverallPrice != null || cd.lowestFbmPrice != null;
              if (hasUsableData) {
                await supabase.from("repricer_competitor_snapshots").insert({
                  user_id: user.id,
                  asin: item.asin,
                  marketplace,
                  buybox_price: cd.buyboxPrice,
                  buybox_seller_id: cd.buyboxSellerId,
                  buybox_is_fba: cd.buyboxIsFba,
                  lowest_fba_price: cd.lowestFbaPrice,
                  lowest_overall_price: cd.lowestOverallPrice || cd.lowestFbmPrice,
                  offers_count: cd.totalOfferCount,
                  fetched_at: new Date().toISOString(),
                  source: "sp-api-auto",
                });
              }

              setItems(prev => prev.map(i => {
                if (i.asin !== item.asin || i.marketplace !== marketplace) return i;
                return {
                  ...i,
                  buybox_price: cd.buyboxPrice,
                  buybox_seller_id: cd.buyboxSellerId,
                  buybox_is_fba: cd.buyboxIsFba,
                  lowest_fba_price: cd.lowestFbaPrice,
                  lowest_overall_price: cd.lowestOverallPrice || cd.lowestFbmPrice,
                  // Protect against SP-API returning 0 offers due to throttling
                  offers_count: cd.totalOfferCount > 0
                    ? cd.totalOfferCount
                    : (i.offers_count != null && i.offers_count > 0 ? i.offers_count : (cd.totalOfferCount ?? 0)),
                  snapshot_fetched_at: new Date().toISOString(),
                };
              }));
            } else if (!compError && compData?.success && !compData.data) {
              setItems(prev => prev.map(i => {
                if (i.asin !== item.asin || i.marketplace !== marketplace) return i;
                return { ...i, snapshot_fetched_at: new Date().toISOString() };
              }));
            }

            await new Promise(r => setTimeout(r, 2000));
          } catch (err) {
            console.error(`[Repricer] Auto-fetch failed for ${item.asin}:`, err);
          }
        }
        
        if (hitRateLimit) {
          await new Promise(r => setTimeout(r, 60_000));
        }
      } finally {
        setAutoFetchingSnapshots(false);
      }
    };

    fetchMissing();
  }, [user?.id, loading, items.length, marketplace, autoFetchingSnapshots]);

  // Background auto-fetch for OTHER marketplaces (runs once per page load)
  // Queries repricer_assignments for all marketplaces, finds ASINs with no recent snapshot, and fetches them
  const otherMpFetchedRef = useRef(false);
  
  useEffect(() => {
    if (!user?.id || loading || otherMpFetchedRef.current) return;
    otherMpFetchedRef.current = true;
    
    const ALL_MARKETPLACES = ["US", "CA", "MX", "BR"];
    const otherMarketplaces = ALL_MARKETPLACES.filter(mp => mp !== marketplace);
    if (otherMarketplaces.length === 0) return;

    const fetchOtherMpSnapshots = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // Get all assignments across other marketplaces
      const { data: otherAssignments } = await supabase
        .from("repricer_assignments")
        .select("asin, sku, marketplace")
        .eq("user_id", user.id)
        .in("marketplace", otherMarketplaces)
        .eq("is_enabled", true);

      if (!otherAssignments || otherAssignments.length === 0) return;

      // Get existing snapshots (within last 2 hours) for these ASINs
      const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const otherAsins = [...new Set(otherAssignments.map(a => a.asin))];
      
      const { data: existingSnapshots } = await supabase
        .from("repricer_competitor_snapshots")
        .select("asin, marketplace")
        .eq("user_id", user.id)
        .in("asin", otherAsins.slice(0, 500))
        .in("marketplace", otherMarketplaces)
        .gte("fetched_at", cutoff);

      const snapshotSet = new Set((existingSnapshots || []).map(s => `${s.asin}_${s.marketplace}`));
      
      // Find assignments missing snapshots
      const missing = otherAssignments.filter(a => !snapshotSet.has(`${a.asin}_${a.marketplace}`));
      if (missing.length === 0) return;

      console.log(`[Repricer] Background multi-marketplace auto-fetch: ${missing.length} items across ${otherMarketplaces.join(", ")}`);

      // Fetch max 6 items total across all other marketplaces (conservative to avoid 429s)
      const batchSize = 6;
      const batchItems = missing.slice(0, batchSize);

      for (const item of batchItems) {
        try {
          const spResult = await invokeEdgeFunction({
            functionName: "repricer-sp-api-pricing",
            body: { asin: item.asin, sku: item.sku, marketplace: item.marketplace },
            headers: { Authorization: `Bearer ${session.access_token}` },
            context: { asin: item.asin, sku: item.sku },
          });
          const compData = spResult.ok ? spResult.data : null;
          const compError = spResult.ok ? null : new Error(spResult.errorMessage || "SP-API error");

          if (isRateLimitError(compError, compData)) {
            console.warn('[Repricer] Multi-marketplace auto-fetch hit rate limit, stopping');
            break;
          }

          if (compError) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          if (compData?.success && compData.data) {
            const cd = compData.data;
            // Guard: Don't persist empty snapshots for intl markets
            const hasUsableData = cd.buyboxPrice != null || cd.lowestFbaPrice != null || cd.lowestOverallPrice != null || cd.lowestFbmPrice != null;
            if (hasUsableData) {
              await supabase.from("repricer_competitor_snapshots").insert({
                user_id: user.id,
                asin: item.asin,
                marketplace: item.marketplace,
                buybox_price: cd.buyboxPrice,
                buybox_seller_id: cd.buyboxSellerId,
                buybox_is_fba: cd.buyboxIsFba,
                lowest_fba_price: cd.lowestFbaPrice,
                lowest_overall_price: cd.lowestOverallPrice || cd.lowestFbmPrice,
                offers_count: cd.totalOfferCount,
                fetched_at: new Date().toISOString(),
                source: "sp-api-auto-intl",
              });
            }
          }

          // 3s delay between cross-marketplace fetches (more conservative)
          await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
          console.error(`[Repricer] Multi-mp auto-fetch failed for ${item.asin}/${item.marketplace}:`, err);
        }
      }
    };

    // Delay start by 10s to let current marketplace auto-fetch run first
    const timer = setTimeout(fetchOtherMpSnapshots, 10_000);
    return () => clearTimeout(timer);
  }, [user?.id, loading, marketplace]);
  
  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>(_assignmentsFilterCache.sortKey);
  
  // Fulfillment filter
  const [fulfillmentFilter, setFulfillmentFilter] = useState<"ALL" | "FBA" | "FBM">(_assignmentsFilterCache.fulfillmentFilter);
  
  // Stock status filter
  const [stockFilter, setStockFilter] = useState<"ALL" | "AVAILABLE" | "RESERVED_INBOUND" | "IN_STOCK" | "OUT_OF_STOCK" | "MANUAL_STAR">(_assignmentsFilterCache.stockFilter);
  
  // Price filter
  const [priceFilter, setPriceFilter] = useState<"ALL" | "HAS_PRICE" | "NO_PRICE">(_assignmentsFilterCache.priceFilter);
  
  // Rule name filter
  const [ruleFilter, setRuleFilter] = useState<string>(_assignmentsFilterCache.ruleFilter);
  
  // Restricted filter
  const [restrictedFilter, setRestrictedFilter] = useState<"HIDE" | "SHOW" | "ONLY">(_assignmentsFilterCache.restrictedFilter);
  
  // Suggestion type filter
  const [suggestionFilter, setSuggestionFilter] = useState<"ALL" | "blocked_by_min" | "blocked_needs_you" | "no_sales_30d" | "blocked_review_soon" | "blocked_auto" | "bb_suppressed" | "profit_guard_block" | "HAS_ANY" | "NONE">(_assignmentsFilterCache.suggestionFilter);

  // Stickiness: when filtering by a "blocked/review" chip, keep rows that just
  // transitioned out of the chip visible for 60s so users don't think the UI
  // is malfunctioning after they edit min price / ROI.
  const SUGGESTION_STICKY_MS = 60_000;
  const stickyKeepRef = useRef<Map<string, number>>(new Map());
  const [stickyTick, setStickyTick] = useState(0);
  useEffect(() => {
    if (suggestionFilter === "ALL") return;
    const t = setInterval(() => setStickyTick(x => x + 1), 15_000);
    return () => clearInterval(t);
  }, [suggestionFilter]);
  // Reset sticky cache when the chip changes (different chip = different set)
  useEffect(() => {
    stickyKeepRef.current.clear();
  }, [suggestionFilter]);
  const isSalesFilterActive = suggestionFilter === "blocked_needs_you" || suggestionFilter === "no_sales_30d";
  const salesMetricsHydrated = useMemo(() => {
    if (items.length === 0) return false;
    return items.some(item => item.units_sold_7d !== null && item.units_sold_7d !== undefined);
  }, [items]);
  const salesFilterPending = isSalesFilterActive && items.length > 0 && (!salesMetricsReady || !salesMetricsHydrated);
  
  
  // ROI range filter
  const [roiMin, setRoiMin] = useState<string>(_assignmentsFilterCache.roiMin);
  const [roiMax, setRoiMax] = useState<string>(_assignmentsFilterCache.roiMax);
  
  // Offer count filter
  const [offerFilter, setOfferFilter] = useState<"ALL" | "HAS_OFFERS" | "NO_OFFERS">(_assignmentsFilterCache.offerFilter);
  
  // "Show Hidden" mode: invert all filters to show only excluded items
  const [showHiddenOnly, setShowHiddenOnly] = useState(false);

  // US marketplace defaults to showing only items with available > 0 (hides
  // reserved/inbound-only rows with zero sellable stock). "Expand" reveals
  // everything, matching the prior default behavior. Always starts collapsed
  // on load — intentionally not persisted.
  const [showZeroAvailable, setShowZeroAvailable] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportData, setReportData] = useState<null | {
    total: number;
    buyable: number;
    notFound: number;
    unknown: number;
    other: number;
    lastChecked: string | null;
    neverChecked: number;
    recentRemoved: Array<{ asin: string; sku: string; reason: string | null; at: string | null }>;
  }>(null);

  const loadVerificationReport = async () => {
    const uid = user?.id;
    if (marketplace === "US" || !uid) return;
    setReportLoading(true);
    try {
      const [totalRes, buyableRes, notFoundRes, unknownRes, neverRes, lastRes, recentRes] = await Promise.all([
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true })
          .eq("user_id", uid).eq("marketplace", marketplace),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true })
          .eq("user_id", uid).eq("marketplace", marketplace)
          .ilike("intl_listing_status", "%BUYABLE%"),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true })
          .eq("user_id", uid).eq("marketplace", marketplace)
          .eq("intl_listing_status", "NOT_FOUND"),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true })
          .eq("user_id", uid).eq("marketplace", marketplace)
          .or("intl_listing_status.is.null,intl_listing_status.eq."),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true })
          .eq("user_id", uid).eq("marketplace", marketplace)
          .is("marketplace_checked_at", null),
        supabase.from("repricer_assignments").select("marketplace_checked_at")
          .eq("user_id", uid).eq("marketplace", marketplace)
          .order("marketplace_checked_at", { ascending: false, nullsFirst: false }).limit(1),
        supabase.from("repricer_assignments")
          .select("asin, sku, marketplace_sellability_reason, marketplace_checked_at")
          .eq("user_id", uid).eq("marketplace", marketplace)
          .eq("intl_listing_status", "NOT_FOUND")
          .order("marketplace_checked_at", { ascending: false, nullsFirst: false }).limit(20),
      ]);

      const total = totalRes.count ?? 0;
      const buyable = buyableRes.count ?? 0;
      const notFound = notFoundRes.count ?? 0;
      const unknown = unknownRes.count ?? 0;
      const other = Math.max(total - buyable - notFound - unknown, 0);
      const lastChecked = (lastRes.data as any[])?.[0]?.marketplace_checked_at ?? null;

      setReportData({
        total, buyable, notFound, unknown, other, lastChecked,
        neverChecked: neverRes.count ?? 0,
        recentRemoved: ((recentRes.data as any[]) || []).map((r) => ({
          asin: r.asin, sku: r.sku,
          reason: r.marketplace_sellability_reason ?? null,
          at: r.marketplace_checked_at ?? null,
        })),
      });
    } catch (err: any) {
      console.error("[loadVerificationReport] failed", err);
      toast.error("Failed to load verification report", { description: err?.message });
    } finally {
      setReportLoading(false);
    }
  };

  const openVerificationReport = () => {
    setReportOpen(true);
    void loadVerificationReport();
  };

  const [sortDir, setSortDir] = useState<SortDir>(_assignmentsFilterCache.sortDir);
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(_assignmentsFilterCache.currentPage);
  const [pageSize, setPageSize] = useState<50 | 250>(_assignmentsFilterCache.pageSize);

  const isExactIdentifierSearch = useMemo(() => {
    const raw = searchTerm.trim();
    if (!raw) return false;

    const normalized = normalizeIdentifier(raw);
    const tokenCount = raw.split(/[,\n\s]+/).filter(Boolean).length;
    return tokenCount === 1 && normalized.length >= 8;
  }, [searchTerm]);

  // Sync filter state to module-level cache
  useEffect(() => {
    _assignmentsFilterCache.searchTerm = searchTerm;
    _assignmentsFilterCache.sortKey = sortKey;
    _assignmentsFilterCache.sortDir = sortDir;
    _assignmentsFilterCache.fulfillmentFilter = fulfillmentFilter;
    _assignmentsFilterCache.stockFilter = stockFilter;
    _assignmentsFilterCache.priceFilter = priceFilter;
    _assignmentsFilterCache.ruleFilter = ruleFilter;
    _assignmentsFilterCache.suggestionFilter = suggestionFilter;
    _assignmentsFilterCache.restrictedFilter = restrictedFilter;
    _assignmentsFilterCache.offerFilter = offerFilter;
    _assignmentsFilterCache.roiMin = roiMin;
    _assignmentsFilterCache.roiMax = roiMax;
    _assignmentsFilterCache.currentPage = currentPage;
    _assignmentsFilterCache.pageSize = pageSize;
  }, [searchTerm, sortKey, sortDir, fulfillmentFilter, stockFilter, priceFilter, ruleFilter, suggestionFilter, restrictedFilter, offerFilter, roiMin, roiMax, currentPage, pageSize]);
  
  // Dual scrollbar refs
  const topScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [tableWidth, setTableWidth] = useState(0);
  const scrollSyncSourceRef = useRef<"top" | "table" | null>(null);

  // Sync scroll between top scrollbar and actual table scroll container
  const handleTopScroll = () => {
    if (!topScrollRef.current || !tableScrollRef.current) return;
    if (scrollSyncSourceRef.current === "table") return;

    scrollSyncSourceRef.current = "top";
    tableScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    requestAnimationFrame(() => {
      if (scrollSyncSourceRef.current === "top") scrollSyncSourceRef.current = null;
    });
  };

  useEffect(() => {
    const tableScroller = tableScrollRef.current;
    if (!tableScroller) return;

    const handleTableScroll = () => {
      if (!topScrollRef.current || !tableScrollRef.current) return;
      if (scrollSyncSourceRef.current === "top") return;

      scrollSyncSourceRef.current = "table";
      topScrollRef.current.scrollLeft = tableScrollRef.current.scrollLeft;
      requestAnimationFrame(() => {
        if (scrollSyncSourceRef.current === "table") scrollSyncSourceRef.current = null;
      });
    };

    tableScroller.addEventListener("scroll", handleTableScroll, { passive: true });
    return () => {
      tableScroller.removeEventListener("scroll", handleTableScroll);
    };
  }, []);

  // Update table width for top scrollbar
  useEffect(() => {
    const tableScroller = tableScrollRef.current;
    if (!tableScroller) return;

    const updateWidth = () => {
      setTableWidth(tableScroller.scrollWidth);
      if (topScrollRef.current) {
        topScrollRef.current.scrollLeft = tableScroller.scrollLeft;
      }
    };

    updateWidth();

    // Track dynamic layout changes (column toggles, font load, viewport changes)
    const ro = new ResizeObserver(updateWidth);
    ro.observe(tableScroller);

    window.addEventListener("resize", updateWidth);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, [items, loading, currentPage, pageSize]);

  const hasActiveFilters = fulfillmentFilter !== "ALL" || stockFilter !== "ALL" || priceFilter !== "ALL" || ruleFilter !== "ALL" || suggestionFilter !== "ALL" || restrictedFilter !== "HIDE" || offerFilter !== "ALL" || roiMin !== "" || roiMax !== "";

  // Sorted and filtered items
  const { sortedItems, hiddenByFilters, hiddenItemIds, hiddenZeroAvailableCount } = useMemo(() => {
    const qRaw = searchTerm.trim();

    // Support multi-ASIN search: split by comma, newline, or whitespace when input looks like a list
    const hasMultiple = /[,\n]/.test(qRaw);
    const searchTokens = hasMultiple
      ? qRaw.split(/[,\n\s]+/).map(t => normalizeIdentifier(t)).filter(t => t.length > 0)
      : [];
    const qId = normalizeIdentifier(qRaw);

    const sortList = (list: InventoryWithAssignment[]) => [...list].sort((a, b) => {
      let aVal: any, bVal: any;
      
      switch (sortKey) {
        case "available":
          aVal = (a.available ?? 0) + (a.reserved ?? 0);
          bVal = (b.available ?? 0) + (b.reserved ?? 0);
          break;
        case "title":
          aVal = a.title?.toLowerCase() || "";
          bVal = b.title?.toLowerCase() || "";
          break;
        case "asin":
          aVal = a.asin;
          bVal = b.asin;
          break;
        case "sku":
          aVal = a.sku || "";
          bVal = b.sku || "";
          break;
        case "price":
          aVal = a.my_price ?? a.price ?? 0;
          bVal = b.my_price ?? b.price ?? 0;
          break;
        case "buybox_price":
          aVal = a.buybox_price ?? 0;
          bVal = b.buybox_price ?? 0;
          break;
        case "recommended":
          aVal = a.last_recommended_price ?? 0;
          bVal = b.last_recommended_price ?? 0;
          break;
        case "cost":
          aVal = a.cost ?? 0;
          bVal = b.cost ?? 0;
          break;
        case "min_price":
          aVal = a.min_price_override ?? a.inv_min_price ?? 0;
          bVal = b.min_price_override ?? b.inv_min_price ?? 0;
          break;
        case "age":
          aVal = a.listing_created_at ? Date.now() - new Date(a.listing_created_at).getTime() : 0;
          bVal = b.listing_created_at ? Date.now() - new Date(b.listing_created_at).getTime() : 0;
          break;
        case "units_sold_today":
          aVal = liveTodayUnitsByAsin[normalizeIdentifier(a.asin)] ?? a.units_sold_today ?? 0;
          bVal = liveTodayUnitsByAsin[normalizeIdentifier(b.asin)] ?? b.units_sold_today ?? 0;
          break;
        case "replenish":
          aVal = calculateReplenishQty({
            salesUnits: a.units_sold_30d ?? 0, salesPeriodDays: 30,
            available: a.available ?? 0, inbound: a.inbound ?? 0, reserved: a.reserved ?? 0,
            historicalSalesUnits: a.historical_sales ?? undefined, historicalDays: a.historical_days ?? undefined,
          });
          bVal = calculateReplenishQty({
            salesUnits: b.units_sold_30d ?? 0, salesPeriodDays: 30,
            available: b.available ?? 0, inbound: b.inbound ?? 0, reserved: b.reserved ?? 0,
            historicalSalesUnits: b.historical_sales ?? undefined, historicalDays: b.historical_days ?? undefined,
          });
          break;
        case "newest":
          aVal = a.assignment_created_at ? new Date(a.assignment_created_at).getTime() : 0;
          bVal = b.assignment_created_at ? new Date(b.assignment_created_at).getTime() : 0;
          break;
        default:
          aVal = a.available ?? 0;
          bVal = b.available ?? 0;
      }

      if (typeof aVal === "string") {
        return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    });

    const visibleItems: InventoryWithAssignment[] = [];
    const hiddenItems: InventoryWithAssignment[] = [];
    let hiddenZeroAvailableCount = 0;

    // US marketplace default: only items with available > 0 count as eligible,
    // hiding reserved/inbound-only rows with nothing sellable right now.
    // "Expand" (showZeroAvailable) restores the prior any-stock behavior.
    // Non-US marketplaces are unaffected — available is a shared physical
    // stock count, not scoped per marketplace, but the collapse was requested
    // specifically for the US view.
    const zeroAvailableCollapsed = marketplace === "US" && !showZeroAvailable;

    items.forEach(i => {
      const exactIdentifierMatch =
        qId.length > 0 &&
        (normalizeIdentifier(i.asin) === qId || normalizeIdentifier(i.sku) === qId);

        // Exact ASIN/SKU searches should surface the row even if sticky table filters
        // (offers, rule, price, stock, etc.) would otherwise hide it.
        // Stock-based visibility: show if any available/reserved/inbound stock exists.
      if (isExactIdentifierSearch && exactIdentifierMatch) {
        const isRepriceEligible = zeroAvailableCollapsed
          ? (i.available ?? 0) > 0
          : (i.available ?? 0) > 0 || (i.reserved ?? 0) > 0 || (i.inbound ?? 0) > 0;
        if (!isRepriceEligible) {
          if (zeroAvailableCollapsed && ((i.reserved ?? 0) > 0 || (i.inbound ?? 0) > 0)) hiddenZeroAvailableCount++;
          return;
        }
        const lsEarly = (i.listing_status || "").toUpperCase();
        if (lsEarly === "INACTIVE" || lsEarly === "NOT_FOUND" || lsEarly.includes("INACTIVE")) return;
        if (marketplace !== "US" && i.intl_listing_status) {
          const intlLsEarly = i.intl_listing_status.toUpperCase();
          if (intlLsEarly === "NOT_FOUND" || intlLsEarly === "UNKNOWN" || intlLsEarly.includes("INACTIVE")) return;
        }
        visibleItems.push(i);
        return;
      }

      // Text search filter
      let matchesSearch: boolean;
      if (qRaw.length === 0) {
        matchesSearch = true;
      } else if (searchTokens.length > 1) {
        // Multi-ASIN mode: match if ASIN or SKU matches ANY token
        const normAsin = normalizeIdentifier(i.asin);
        const normSku = normalizeIdentifier(i.sku);
        matchesSearch = searchTokens.some(token => normAsin.includes(token) || normSku.includes(token));
      } else {
        matchesSearch =
          // Identifier matching (ASIN/SKU) uses normalized search
          (qId.length > 0 &&
            (normalizeIdentifier(i.asin).includes(qId) ||
              normalizeIdentifier(i.sku).includes(qId))) ||
          // Title matching stays "human" (keeps spaces)
          (i.title?.toLowerCase().includes(qRaw.toLowerCase()) ?? false);
      }

      if (!matchesSearch) return;

      // Repricer visibility: include available, reserved, and inbound stock by default,
      // unless zero-available items are collapsed (see zeroAvailableCollapsed above).
      const isRepriceEligible = zeroAvailableCollapsed
        ? (i.available ?? 0) > 0
        : (i.available ?? 0) > 0 || (i.reserved ?? 0) > 0 || (i.inbound ?? 0) > 0;
      if (!isRepriceEligible) {
        if (zeroAvailableCollapsed && ((i.reserved ?? 0) > 0 || (i.inbound ?? 0) > 0)) hiddenZeroAvailableCount++;
        return;
      }


      // Apply dropdown filters — in "showHiddenOnly" mode we invert: keep items
      // that would normally be EXCLUDED by the active filters.
      const passesDropdownFilters = (() => {
        // Sales-based filters (no_sales_7d / no_sales_30d) are primary filters —
        // bypass price, offers, and stock defaults so they surface ALL matching items
        const isSalesFilter = isSalesFilterActive;

        // Fulfillment filter — use the authoritative computed fulfillment_type
        // (respects assignment override + FNSKU/FBA-qty/source/BB detection),
        // not a raw source-string check which mis-classifies FBM rows whose
        // source is null or "amazon_sync".
        if (fulfillmentFilter !== "ALL") {
          if (i.fulfillment_type !== fulfillmentFilter) return false;
        }
        
        // Stock status filter
        if (stockFilter !== "ALL" && !isSalesFilter) {
          const avail = i.available ?? 0;
          const reserved = i.reserved ?? 0;
          const inbound = i.inbound ?? 0;
          const isInactive = i.listing_status?.includes("INACTIVE");
          const totalStock = avail + reserved + inbound;
          
          if (stockFilter === "AVAILABLE" && avail <= 0) return false;
          if (stockFilter === "RESERVED_INBOUND" && (reserved + inbound) <= 0) return false;
          if (stockFilter === "IN_STOCK" && totalStock <= 0) return false;
          if (stockFilter === "OUT_OF_STOCK" && totalStock > 0) return false;
          if (stockFilter === "MANUAL_STAR" && !i.is_manual_priority) return false;
          
        }
        
        // Price filter
        if (priceFilter !== "ALL" && !isSalesFilter) {
          const hasPrice = (i.my_price != null && i.my_price > 0) || (i.price != null && i.price > 0) || (i.buybox_price != null && i.buybox_price > 0);
          if (priceFilter === "HAS_PRICE" && !hasPrice) return false;
          if (priceFilter === "NO_PRICE" && hasPrice) return false;
        }
        
        // Rule filter
        if (ruleFilter !== "ALL") {
          if (ruleFilter === "NO_RULE") {
            if (i.saved_rule_id) return false;
          } else {
            if (i.saved_rule_id !== ruleFilter) return false;
          }
        }
        
        
        
        // Suggestion type filter (with 60s stickiness so rows don't vanish
        // the instant a user edits min/ROI and the row transitions to healthy)
        if (suggestionFilter !== "ALL") {
          const matches = (() => {
            const sug = detectSuggestion(i as any, rules);
            if (suggestionFilter === "HAS_ANY") return !!sug;
            if (suggestionFilter === "NONE") return !sug;
            if (suggestionFilter === "blocked_needs_you") {
              const sales7d = i.units_sold_7d;
              if (sales7d === null || sales7d === undefined) return false;
              return sales7d === 0;
            }
            if (suggestionFilter === "no_sales_30d") {
              const sales30d = i.units_sold_30d;
              if (sales30d === null || sales30d === undefined) return false;
              return sales30d === 0;
            }
            if (suggestionFilter === "blocked_review_soon") {
              const reason = String(i.last_recommendation_reason || "").toLowerCase();
              const currentPrice = Number(i.my_price ?? i.price ?? 0);
              const minPrice = i.min_price_override ?? i.inv_min_price;
              const looksBlockedByFloor =
                reason.includes("profit guard") ||
                reason.includes("profit_guard") ||
                reason.includes("roi guard") ||
                reason.includes("constrained_by") ||
                reason.includes("clamped") ||
                reason.includes("holding at floor") ||
                reason.includes("floor prevents") ||
                reason.includes("clamped to min") ||
                reason.includes("effective_floor") ||
                (minPrice != null && currentPrice > 0 && Math.abs(currentPrice - Number(minPrice)) < 0.02);
              if (!looksBlockedByFloor) return false;
              const sales7d = i.units_sold_7d;
              if (sales7d === null || sales7d === undefined) return false;
              const hasStock = (i.available ?? 0) + (i.reserved ?? 0) > 0;
              const noSalesLastWeek = sales7d === 0 && hasStock;
              const targetPrice = i.buybox_price ?? i.lowest_fba_price ?? i.lowest_overall_price ?? null;
              const competitiveEvidence = targetPrice != null && currentPrice > 0 && currentPrice > targetPrice + 0.05;
              const needsYouNow = noSalesLastWeek && competitiveEvidence;
              return !needsYouNow;
            }
            return !!sug && sug.type === suggestionFilter;
          })();

          const stickyKey = `${suggestionFilter}:${i.id}`;
          const now = Date.now();
          if (matches) {
            stickyKeepRef.current.set(stickyKey, now + SUGGESTION_STICKY_MS);
          } else {
            const exp = stickyKeepRef.current.get(stickyKey);
            if (!exp || exp <= now) {
              if (exp) stickyKeepRef.current.delete(stickyKey);
              return false;
            }
          }
        }
        
        
        
        if (offerFilter !== "ALL" && !isSalesFilter) {
          const offers = i.offers_count;
          if (offerFilter === "HAS_OFFERS" && (offers === 0)) return false;
          if (offerFilter === "NO_OFFERS" && (offers == null || offers > 0)) return false;
        }
        
        // ROI range filter
        if (roiMin !== "" || roiMax !== "") {
          const roi = i.min_roi_override;
          if (roi == null) return false;
          if (roiMin !== "" && roi < parseFloat(roiMin)) return false;
          if (roiMax !== "" && roi > parseFloat(roiMax)) return false;
        }
        
        // Restricted filter (default HIDE = hide restricted items)
        if (restrictedFilter === "HIDE" && i.is_restricted) return false;
        if (restrictedFilter === "ONLY" && !i.is_restricted) return false;
        // "SHOW" = show all, no filtering
        
        return true;
      })();

      // In "show hidden" mode, invert: show items that FAIL the filters
      if (passesDropdownFilters) visibleItems.push(i);
      else hiddenItems.push(i);
    });

    // Pin incomplete inbound activations first, then newly auto-activated rows,
    // so inbound rows waiting on rule/bounds cannot get buried below stable rows.
    const pinNewInbound = (list: InventoryWithAssignment[]) => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const pinnedActivated: InventoryWithAssignment[] = [];
      const pinnedPending: InventoryWithAssignment[] = [];
      const rest: InventoryWithAssignment[] = [];
      for (const it of list) {
        const ts = it.auto_activated_at ? new Date(it.auto_activated_at).getTime() : 0;
        const inbound = Number((it as any).inbound) || 0;
        const hasRule = !!it.rule_id;
        const hasBounds = it.min_price_override != null && it.max_price_override != null;
        const isIncompleteInbound = inbound > 0 && (!hasRule || !it.is_enabled || !hasBounds);
        if (isIncompleteInbound) {
          // Inbound awaiting atomic activation — keep it at the top until complete.
          pinnedPending.push(it);
        } else if (ts > cutoff) {
          pinnedActivated.push(it);
        } else {
          rest.push(it);
        }
      }
      pinnedActivated.sort((a, b) =>
        new Date(b.auto_activated_at || 0).getTime() - new Date(a.auto_activated_at || 0).getTime()
      );
      pinnedPending.sort((a, b) =>
        (Number((b as any).inbound) || 0) - (Number((a as any).inbound) || 0)
      );
      return [...pinnedPending, ...pinnedActivated, ...rest];
    };

    const sortedVisible = pinNewInbound(sortList(visibleItems));
    const sortedHidden = pinNewInbound(sortList(hiddenItems));
    const mergedItems = showHiddenOnly
      ? sortedHidden
      : sortedVisible;

    return {
      sortedItems: mergedItems,
      hiddenByFilters: hasActiveFilters ? hiddenItems.length : 0,
      hiddenItemIds: new Set(hiddenItems.map(item => item.id)),
      hiddenZeroAvailableCount,
    };
  }, [items, searchTerm, sortKey, sortDir, fulfillmentFilter, stockFilter, priceFilter, ruleFilter, suggestionFilter, restrictedFilter, offerFilter, roiMin, roiMax, liveTodayUnitsByAsin, isExactIdentifierSearch, showHiddenOnly, showZeroAvailable, rules, marketplace, hasActiveFilters, stickyTick]);

  const resetAllFilters = useCallback(() => {
    setFulfillmentFilter("ALL");
    setStockFilter("ALL");
    setPriceFilter("ALL");
    setRuleFilter("ALL");
    setSuggestionFilter("ALL");
    setOfferFilter("ALL");
    setRestrictedFilter("HIDE");
    setRoiMin("");
    setRoiMax("");
  }, []);

  // Paginated items
  const totalPages = Math.ceil(sortedItems.length / pageSize);
  const newestAutoActivationKey = useMemo(() => {
    const recent = sortedItems.find((item) => {
      const ts = item.auto_activated_at ? new Date(item.auto_activated_at).getTime() : 0;
      return ts > Date.now() - 24 * 60 * 60 * 1000;
    });
    return recent?.auto_activated_at || null;
  }, [sortedItems]);

  // Snap to page 1 ONLY when a new auto-activation key appears.
  // Do NOT include currentPage in deps — otherwise every Next-page click
  // re-runs this effect and immediately bounces back to page 1.
  const lastAutoActivationKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      newestAutoActivationKey &&
      newestAutoActivationKey !== lastAutoActivationKeyRef.current
    ) {
      lastAutoActivationKeyRef.current = newestAutoActivationKey;
      setCurrentPage(1);
    }
  }, [newestAutoActivationKey]);

  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, currentPage, pageSize]);

  const marketplaceActiveAsinCount = useMemo(
    () => new Set(
      items
        .filter(i => (i.available ?? 0) > 0 || (i.reserved ?? 0) > 0)
        .map(i => normalizeIdentifier(i.asin))
        .filter(Boolean)
    ).size,
    [items]
  );

  // Counts per chip — computed over reprice-eligible items, ignoring suggestionFilter
  // so totals stay stable while the user clicks between chips.
  const chipCounts = useMemo(() => {
    const counts = {
      ALL: 0,
      blocked_review_soon: 0,
      blocked_by_min: 0,
      profit_guard_block: 0,
      bb_suppressed: 0,
      blocked_auto: 0,
      NONE: 0,
      no_sales_30d: 0,
      HAS_ANY: 0,
      blocked_needs_you: 0,
    };
    for (const i of items) {
      const eligible = (i.available ?? 0) > 0 || (i.reserved ?? 0) > 0;
      if (!eligible) continue;
      counts.ALL += 1;

      const sales7d = i.units_sold_7d;
      if (sales7d === 0) counts.blocked_needs_you += 1;
      const sales30d = i.units_sold_30d;
      if (sales30d === 0) counts.no_sales_30d += 1;

      const sug = detectSuggestion(i as any, rules) as { type: string } | null;
      if (sug) {
        counts.HAS_ANY += 1;
        const t = sug.type;
        if (t === "blocked_by_min") counts.blocked_by_min += 1;
        else if (t === "profit_guard_block") counts.profit_guard_block += 1;
        else if (t === "bb_suppressed") counts.bb_suppressed += 1;
        else if (t === "blocked_auto") counts.blocked_auto += 1;
      } else {
        counts.NONE += 1;
      }

      // Review Soon — mirror the filter logic
      const reason = String(i.last_recommendation_reason || "").toLowerCase();
      const currentPrice = Number(i.my_price ?? i.price ?? 0);
      const minPrice = i.min_price_override ?? i.inv_min_price;
      const looksBlockedByFloor =
        reason.includes("profit guard") ||
        reason.includes("profit_guard") ||
        reason.includes("roi guard") ||
        reason.includes("constrained_by") ||
        reason.includes("clamped") ||
        reason.includes("holding at floor") ||
        reason.includes("floor prevents") ||
        reason.includes("clamped to min") ||
        reason.includes("effective_floor") ||
        (minPrice != null && currentPrice > 0 && Math.abs(currentPrice - Number(minPrice)) < 0.02);
      if (looksBlockedByFloor && sales7d === 0) {
        const hasStock = (i.available ?? 0) + (i.reserved ?? 0) > 0;
        const targetPrice = i.buybox_price ?? i.lowest_fba_price ?? i.lowest_overall_price ?? null;
        const competitiveEvidence = targetPrice != null && currentPrice > 0 && currentPrice > targetPrice + 0.05;
        if (hasStock && competitiveEvidence) counts.blocked_review_soon += 1;
      }
    }
    return counts;
  }, [items, rules]);

  // Reset to first page when filter or pageSize changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, pageSize, fulfillmentFilter, stockFilter, priceFilter, ruleFilter, suggestionFilter, offerFilter, roiMin, roiMax, showHiddenOnly]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-50" />;
    return sortDir === "asc" 
      ? <ArrowUp className="h-3 w-3 ml-1" /> 
      : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  // Save cost and propagate to inventory + created_listings
  const handleCostSave = async (item: InventoryWithAssignment) => {
    const val = editingCost[item.id];
    if (val === undefined) return;
    
    const newCost = parseFloat(val);
    if (isNaN(newCost) || newCost < 0) {
      toast.error("Invalid cost value");
      setEditingCost(prev => { const n = { ...prev }; delete n[item.id]; return n; });
      return;
    }

    // Parity with Synced Inventory: if a Created Listing (purchase record)
    // exists for this ASIN, the unit cost is owned by Product Library and
    // cannot be edited here.
    if (hasPurchaseRecord(item.asin)) {
      toast.error("Cost is read-only — edit it in Product Library (purchase record exists).");
      setEditingCost(prev => { const n = { ...prev }; delete n[item.id]; return n; });
      return;
    }

    setSavingCost(prev => new Set(prev).add(item.id));
    try {
      // 1) Update inventory table
      const { error: invErr } = await supabase
        .from("inventory")
        .update({ cost: newCost, unit_cost_manual: true, updated_at: new Date().toISOString() })
        .eq("id", item.id)
        .eq("user_id", user!.id);
      if (invErr) throw invErr;

      // 2) Update created_listings (match by user_id + sku, then fallback to asin)
      const { data: clBySku } = await supabase
        .from("created_listings")
        .select("id, units")
        .eq("user_id", user!.id)
        .eq("sku", item.sku)
        .limit(1)
        .maybeSingle();

      const clRow = clBySku || (await (async () => {
        const { data } = await supabase
          .from("created_listings")
          .select("id, units")
          .eq("user_id", user!.id)
          .eq("asin", item.asin)
          .limit(1)
          .maybeSingle();
        return data;
      })());

      if (clRow) {
        const totalCost = newCost;
        await supabase
          .from("created_listings")
          .update({ cost: totalCost, amount: totalCost, updated_at: new Date().toISOString() })
          .eq("id", clRow.id);
      }

      if (item.asin && item.sku) {
        triggerAutoOnboard(item.asin, item.sku, marketplace || "US");
      }

      // Update local state
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, cost: newCost, cost_converted: null } : i));
      toast.success(`Cost updated to USD $${newCost.toFixed(2)}`);
    } catch (err: any) {
      console.error("Error saving cost:", err);
      toast.error("Failed to save cost: " + (err.message || "Unknown error"));
    } finally {
      setSavingCost(prev => { const n = new Set(prev); n.delete(item.id); return n; });
      setEditingCost(prev => { const n = { ...prev }; delete n[item.id]; return n; });
    }
  };

  const ensureAssignment = async (item: InventoryWithAssignment): Promise<string | null> => {
    const targetMp = marketplace || "US";

    // Reuse cached assignment only if it matches the exact SKU + marketplace.
    // Otherwise different SKUs of the same ASIN (e.g. New vs Used) would share state.
    if (item.assignment_id) {
      const { data: existing } = await (supabase as any)
        .from("repricer_assignments")
        .select("id, marketplace, sku")
        .eq("id", item.assignment_id)
        .single();

      if (existing && existing.marketplace === targetMp && existing.sku === item.sku) {
        return item.assignment_id;
      }
      // Mismatch — fall through and resolve the correct row.
    }

    try {
      // Look up assignment for this exact SKU + marketplace first.
      const { data: existingForSku } = await (supabase as any)
        .from("repricer_assignments")
        .select("id")
        .eq("user_id", user?.id)
        .eq("asin", item.asin)
        .eq("sku", item.sku)
        .eq("marketplace", targetMp)
        .maybeSingle();

      if (existingForSku) {
        setItems(prev =>
          prev.map(i => i.id === item.id ? { ...i, assignment_id: existingForSku.id } : i)
        );
        return existingForSku.id;
      }

      // PLAN LIMIT ENFORCEMENT
      if (planLimit > 0) {
        const { count } = await (supabase as any)
          .from("repricer_assignments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user?.id)
          .eq("is_enabled", true);
        if ((count ?? 0) >= planLimit) {
          toast.error(`Plan limit reached (${planLimit.toLocaleString()} active listings). Upgrade to add more.`);
          return null;
        }
      }

      const isFba = item.source?.includes("fba") || item.source === "amazon_sync";
      const skuValue = String(item.sku || "");
      const isUsedSku = skuValue.startsWith('amzn.gr.') || skuValue.toLowerCase().startsWith('used_');
      const inferredCondition = isUsedSku ? 'Used' : 'New';

      const { data, error } = await (supabase as any)
        .from("repricer_assignments")
        .upsert({
          user_id: user?.id,
          asin: item.asin,
          sku: item.sku,
          marketplace: targetMp,
          is_enabled: true,
          auto_apply_enabled: true,
          fulfillment_type: isFba ? 'FBA' : 'FBM',
          item_condition: inferredCondition,
        }, { onConflict: "user_id,sku,marketplace" })
        .select("id")
        .single();

      if (error) throw error;
      // Only patch the row that owns this SKU — don't overwrite siblings.
      setItems(prev =>
        prev.map(i => i.id === item.id ? { ...i, assignment_id: data.id } : i)
      );
      return data.id;
    } catch (error: any) {
      console.error("[ensureAssignment] Failed:", error?.message || error, { asin: item.asin, sku: item.sku, marketplace: marketplace || "US" });
      toast.error(`Failed to create assignment: ${error?.message || "Unknown error"}`);
      return null;
    }
  };

  const getRuleStatePatch = (ruleId: string | null): Partial<InventoryWithAssignment> => {
    const targetRule = ruleId ? rules.find(r => r.id === ruleId) : null;
    const ruleMinRoiEnabled = resolveRuleMinRoiEnabledForMarketplace(targetRule as any, marketplace);

    return {
      rule_id: ruleId,
      rule_name: targetRule?.name || null,
      rule_min_roi_enabled: ruleMinRoiEnabled,
      rule_min_roi_percent: targetRule?.min_roi_percent ?? null,
      rule_min_roi_marketplace_overrides: (targetRule as any)?.min_roi_marketplace_overrides ?? {},
      rule_oscillation_mode: (targetRule as any)?.oscillation_mode || null,
      ...(ruleMinRoiEnabled ? {} : { min_roi_override: null }),
    };
  };

  const assignRule = async (item: InventoryWithAssignment, ruleId: string | null, markPendingOnly = false) => {
    // SAFEGUARD: Never allow setting rule_id to null — use the dropdown without "None"
    if (!ruleId || ruleId === "none") {
      console.warn("[assignRule] Blocked attempt to set rule_id to null for", item.asin);
      return;
    }
    const rulePatch = getRuleStatePatch(ruleId);

    // Capture BEFORE this call touches anything: if the row already had an
    // unrelated unsaved edit pending (e.g. the user just lowered Min and
    // hasn't clicked Save yet), we must not clear that flag just because the
    // rule assignment itself auto-saved — otherwise the next background poll
    // (refreshPricesAndAssignments) sees hasLocalMinEdit=false and overwrites
    // the staged Min with the still-old value from the DB.
    const hadUnrelatedPendingEdit = pendingChanges.has(item.id);

    // If markPendingOnly, just track the change without saving
    if (markPendingOnly) {
      capturePendingSnapshot(item);
      setPendingChanges(prev => new Set(prev).add(item.id));
      setNeedsEval(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      if (!rulePatch.rule_min_roi_enabled) {
        setEditingMinRoi(prev => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      }
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, ...rulePatch } : i)));
      return;
    }
    
    try {
      const assignmentId = await ensureAssignment(item);
      if (!assignmentId) return;

      // NOTE: Do NOT delete sibling rows for the same ASIN — different SKUs
      // (e.g. New vs Used) intentionally have separate assignment rows now.

      const updatePayload: Record<string, any> = { rule_id: ruleId };
      const { error } = await supabase
        .from("repricer_assignments")
        .update(updatePayload)
        .eq("id", assignmentId);

      if (error) throw error;

      // Auto-fill min/max if rule assigned and min is missing
      if (ruleId !== "none" && !item.min_price_override) {
        try {
          const { data: session } = await supabase.auth.getSession();
          if (session?.session?.access_token) {
            await supabase.functions.invoke("backfill-repricer-min-max", {
              body: { dryRun: false, marketplace: marketplace || "US" },
            });
          }
        } catch (fillErr) {
          console.warn("Auto-fill min/max after rule assignment failed:", fillErr);
        }
      }

      setItems(prev =>
        prev.map(i =>
          i.id === item.id
            ? {
                ...i,
                assignment_id: assignmentId,
                saved_rule_id: ruleId,
                ...rulePatch,
              }
            : i
        )
      );
      
      // Clear pending change after successful save — but only if nothing else
      // (e.g. an unsaved Min/Max edit) was already relying on that flag.
      if (!hadUnrelatedPendingEdit) {
        clearPendingSnapshot(item.id);
        setPendingChanges(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
      // Rule change saved — user must manually trigger eval via the toggle/button
    } catch (error: any) {
      toast.error("Failed to assign rule");
    }
  };

  const bulkAssignRule = async () => {
    console.log("[bulkAssignRule] click", {
      selectedCount: selectedIds.size,
      bulkRuleId,
      marketplace,
      userId: user?.id,
    });

    if (!user?.id) {
      toast.error("Not signed in");
      return;
    }
    if (selectedIds.size === 0) {
      toast.error("Select items first");
      return;
    }

    const targetRuleId = bulkRuleId;
    if (!targetRuleId) {
      toast.error("Pick a rule from the dropdown first");
      return;
    }
    const selectedItems = items.filter(i => selectedIds.has(i.id));
    const totalCount = selectedItems.length;
    if (totalCount === 0) {
      toast.error("Selected items not found in the current view");
      return;
    }

    setBulkApplying(true);
    const applyToastId = toast.loading(`Applying rule to ${totalCount} items...`);
    try {
      const targetMp = marketplace || "US";
      const BATCH_SIZE = 200;

      // Step 1: Build upsert payload, deduped by (sku, marketplace).
      // The active unique constraint is now (user_id, sku, marketplace), so each
      // SKU on the same ASIN keeps its own row (e.g. New vs Used variants).
      const seenSku = new Set<string>();
      const upsertRows: Array<Record<string, any>> = [];
      const skippedNoAsin: string[] = [];
      const skippedNoSku: string[] = [];
      for (const item of selectedItems) {
        if (!item.asin) {
          skippedNoAsin.push(item.sku || item.id);
          continue;
        }
        if (!item.sku) {
          skippedNoSku.push(item.asin);
          continue;
        }
        const key = `${item.sku}|${targetMp}`;
        if (seenSku.has(key)) continue;
        seenSku.add(key);
        const isFba = item.source?.includes("fba") || item.source === "amazon_sync";
        upsertRows.push({
          user_id: user.id,
          asin: item.asin,
          sku: item.sku,
          marketplace: targetMp,
          is_enabled: true,
          auto_apply_enabled: true,
          fulfillment_type: isFba ? 'FBA' : 'FBM',
          item_condition: item.item_condition
            || (item.sku?.startsWith('amzn.gr.') || item.sku?.toLowerCase?.().startsWith('used_') ? 'Used' : 'New'),
          rule_id: targetRuleId,
        });
      }
      console.log("[bulkAssignRule] upserting", upsertRows.length, "rows (deduped by sku)", { skippedNoAsin: skippedNoAsin.length, skippedNoSku: skippedNoSku.length });
      if (upsertRows.length === 0) {
        toast.error(
          skippedNoAsin.length > 0
            ? `Cannot apply rule: ${skippedNoAsin.length} selected item(s) have no ASIN yet. Sync inventory first.`
            : "No applicable items in selection",
          { id: applyToastId }
        );
        return;
      }

      let upsertFailed = false;
      let lastUpsertError: any = null;
      for (let i = 0; i < upsertRows.length; i += BATCH_SIZE) {
        const batch = upsertRows.slice(i, i + BATCH_SIZE);
        const { error: upsertErr } = await (supabase as any)
          .from("repricer_assignments")
          .upsert(batch, { onConflict: "user_id,sku,marketplace", ignoreDuplicates: false });
        if (upsertErr) {
          console.error("[bulkAssignRule] upsert batch failed", upsertErr);
          upsertFailed = true;
          lastUpsertError = upsertErr;
          // Don't throw — fall through to step 2 so existing rows still get updated
          break;
        }
      }

      // Step 2: Always run the rule_id update as a safety net
      // (covers rows that already existed and rows where upsert was skipped).
      const targetRule = rules.find(r => r.id === targetRuleId) || null;
      const allAsins = [...new Set(selectedItems.map(i => i.asin).filter(Boolean))];
      let updatedAny = false;
      for (let i = 0; i < allAsins.length; i += BATCH_SIZE) {
        const asinBatch = allAsins.slice(i, i + BATCH_SIZE);
        const { data: updatedRows, error: updateErr } = await supabase
          .from("repricer_assignments")
          .update({ rule_id: targetRuleId })
          .eq("user_id", user.id)
          .eq("marketplace", targetMp)
          .in("asin", asinBatch)
          .select("id");
        if (updateErr) {
          console.error("[bulkAssignRule] update batch failed", updateErr);
          throw updateErr;
        }
        if (updatedRows && updatedRows.length > 0) updatedAny = true;
      }

      if (!updatedAny && upsertFailed) {
        const msg = lastUpsertError?.message || lastUpsertError?.details || "unknown error";
        toast.error(`Could not assign rule: ${msg}`, { id: applyToastId });
        return;
      }

      // Step 3: Update local state in one pass
      const ruleName = targetRule?.name || null;
      setItemsCache((prev) => {
        if (!prev) return prev;
        return prev.map(i =>
          selectedIds.has(i.id)
            ? { ...i, rule_id: targetRuleId, saved_rule_id: targetRuleId, rule_name: ruleName }
            : i
        );
      });
      setItems((prev) =>
        prev.map(i =>
          selectedIds.has(i.id)
            ? { ...i, rule_id: targetRuleId, saved_rule_id: targetRuleId, rule_name: ruleName }
            : i
        )
      );

      // Auto-fill min/max for items that got a rule but have no min
      const missingMinCount = selectedItems.filter(i => !i.min_price_override).length;
      if (missingMinCount > 0) {
        toast.loading(`Auto-filling min/max for ${missingMinCount} items...`, { id: applyToastId });
        try {
          await supabase.functions.invoke("backfill-repricer-min-max", {
            body: { dryRun: false, marketplace: targetMp },
          });
        } catch (fillErr) {
          console.warn("Auto-fill min/max after bulk rule assignment failed:", fillErr);
        }
      }

      toast.success(`Updated ${totalCount} items → ${targetRule?.name ?? "rule"}`, { id: applyToastId });
      setSelectedIds(new Set());
      setBulkRuleId("");
    } catch (error: any) {
      console.error("[bulkAssignRule] fatal error:", error);
      toast.error("Failed to assign rules: " + (error.message || "Unknown error"), { id: applyToastId });
    } finally {
      setBulkApplying(false);
    }
  };

  const selectAll = () => {
    if (selectedIds.size === sortedItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedItems.map(i => i.id)));
    }
  };

  const updateMinMaxPrice = async (item: InventoryWithAssignment, field: "min_price_override" | "max_price_override" | "min_roi_override", value: number | null, markPendingOnly = false) => {
    // If markPendingOnly, just track the change without saving to DB
    if (markPendingOnly) {
      setPendingChanges(prev => new Set(prev).add(item.id));
      setItems(prev =>
        prev.map(i => (i.id === item.id ? { ...i, [field]: value } : i))
      );
      return;
    }
    
    try {
      const assignmentId = await ensureAssignment(item);
      if (!assignmentId) return;
      
      const isMinField = field === "min_price_override";
      const isMaxField = field === "max_price_override";
      const shouldSyncInventoryBounds = marketplace === "US" && !!user?.id && !!item.sku && (isMinField || isMaxField);

      // Build update payload — also resume if paused by profit guard
      const updatePayload: Record<string, any> = { [field]: value };

      // Manual-Min-Only contract: a manual Min save from the UI is the user's
      // authoritative floor. Persist it to `manual_min_price` as well so downstream
      // sweeps (apply-min-roi, ROI recomputation, bounds sync) can't silently
      // snap the floor back to a stale value the user changed months ago.
      if (isMinField) {
        updatePayload.manual_min_price = value;
      }

      const wasPaused = (item.status as string) === "paused_profit_guard";
      if (wasPaused) {
        updatePayload.status = "active";
        updatePayload.consecutive_failures = 0;
        updatePayload.last_recommendation_reason = null;
      }

      const assignmentUpdatePromise = supabase
        .from("repricer_assignments")
        .update(updatePayload)
        .eq("id", assignmentId);

      const inventoryUpdatePromise = shouldSyncInventoryBounds
        ? supabase
            .from("inventory")
            .update(isMinField ? { min_price: value } : { max_price: value })
            .eq("user_id", user.id)
            .eq("asin", item.asin)
            .eq("sku", item.sku)
        : Promise.resolve({ error: null });

      const [assignmentResult, inventoryResult] = await Promise.all([
        assignmentUpdatePromise,
        inventoryUpdatePromise,
      ]);

      if (assignmentResult.error) throw assignmentResult.error;
      if (inventoryResult.error) throw inventoryResult.error;

      setItems(prev =>
        prev.map(i => (i.id === item.id ? { 
          ...i, 
          [field]: value, 
          assignment_id: assignmentId,
          ...(isMinField ? {
            manual_min_price: i.manual_min_price,
            inv_min_price: shouldSyncInventoryBounds ? value : i.inv_min_price,
          } : {}),
          ...(isMaxField ? {
            inv_max_price: shouldSyncInventoryBounds ? value : i.inv_max_price,
          } : {}),
          ...(wasPaused ? { status: "active" } : {}),
        } : i))
      );
      
      // Clear pending change after successful save
      clearPendingSnapshot(item.id);
      setPendingChanges(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      
      // Show brief success feedback
      const fieldName = field === "min_price_override" ? "Min price" : field === "max_price_override" ? "Max price" : "Min ROI";
      toast.success(`${fieldName} saved`, { duration: 1500 });
      
      // Log the change
      logSettingChange({
        asin: item.asin,
        sku: item.sku,
        marketplace,
        fieldChanged: field,
        oldValue: item[field] as number | null,
        newValue: value,
        source: "ui",
      });
    } catch (error: any) {
      console.error("Failed to update:", error);
      toast.error("Failed to update " + (field === "min_roi_override" ? "ROI" : "price"));
    }
  };

  // Fetch price AND competitive data for a single item from Amazon via SP-API
  const fetchPriceForItem = async (item: InventoryWithAssignment) => {
    if (!user?.id) return;
    // Same-marketplace guard as refreshPricesAndAssignments: item.id is the
    // shared inventory row id across marketplaces, so if the user switches
    // tabs while this fetch is in flight, its result belongs to the
    // marketplace they just left and must not overwrite the new tab's price.
    const targetMp = marketplace;

    try {
      setFetchingPrice(prev => new Set(prev).add(item.id));
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      
      // Fetch both Your Price (capture-asin-price) AND Competitive Pricing (repricer-sp-api-pricing) in parallel
      const [priceResult, competitiveResult] = await Promise.all([
        invokeEdgeFunction({
          functionName: "capture-asin-price",
          body: { asin: item.asin, sku: item.sku, marketplace },
          headers: { Authorization: `Bearer ${session.access_token}` },
          context: { asin: item.asin, sku: item.sku },
        }).then(r => ({ data: r.ok ? r.data : null, error: r.ok ? null : new Error(r.errorMessage || "") })),
        invokeEdgeFunction({
          functionName: "repricer-sp-api-pricing",
          body: { asin: item.asin, sku: item.sku, marketplace },
          headers: { Authorization: `Bearer ${session.access_token}` },
          context: { asin: item.asin, sku: item.sku },
        }).then(r => ({ data: r.ok ? r.data : null, error: r.ok ? null : new Error(r.errorMessage || "") })),
      ]);
      
      const { data: priceData, error: priceError } = priceResult;
      const { data: compData, error: compError } = competitiveResult;
      
      // Handle authorization errors from Your Price fetch
      if (priceData?.authorizationRequired) {
        toast.error(priceData.error || "Amazon authorization required", { 
          duration: 6000,
          description: "Please reconnect via Grant Us Access page" 
        });
        return;
      }
      
      // Process Your Price result
      let fetchedPrice: number | null = null;
      if (!priceError && priceData?.success && priceData.data?.listing_price != null) {
        const parsedPrice = Number(priceData.data.listing_price);
        // Guard against transient SP-API zeros/invalid values that can hide rows under "Has Price".
        if (Number.isFinite(parsedPrice) && parsedPrice > 0) {
          fetchedPrice = parsedPrice;
        }
      }
      
      // Process Competitive Pricing result and store snapshot
      let competitiveData: any = null;
      if (!compError && compData?.success && compData.data) {
        competitiveData = compData.data;
        
        // Store snapshot in repricer_competitor_snapshots table
        // IMPORTANT: This table is designed to keep a time-series of snapshots.
        // There is no unique constraint on (user_id, asin, marketplace), so upsert would fail.
        const { error: snapshotInsertError } = await supabase
          .from("repricer_competitor_snapshots")
          .insert({
            user_id: user.id,
            asin: item.asin,
            marketplace,
            buybox_price: competitiveData.buyboxPrice,
            buybox_seller_id: competitiveData.buyboxSellerId,
            buybox_is_fba: competitiveData.buyboxIsFba,
            lowest_fba_price: competitiveData.lowestFbaPrice,
            lowest_overall_price:
              competitiveData.lowestOverallPrice || competitiveData.lowestFbmPrice,
            offers_count: competitiveData.totalOfferCount,
            fetched_at: new Date().toISOString(),
            source: "sp-api",
          });

        if (snapshotInsertError) {
          console.error("Failed to insert competitor snapshot:", snapshotInsertError);
        }
      }
      
      // Discard if the user switched marketplace tabs while this was in flight.
      if (marketplaceRef.current !== targetMp) return;

      // Update local state with all fetched data
      setItems(prev =>
        prev.map(i => {
          if (i.id !== item.id) return i;

          const updates: Partial<InventoryWithAssignment> = {};
          
          if (fetchedPrice !== null) {
            // Always log retrieve_price action, even if price unchanged
            const oldPrice = i.my_price ?? i.price ?? null;
            logSettingChange({
              asin: item.asin,
              sku: item.sku,
              marketplace,
              fieldChanged: "my_price",
              oldValue: oldPrice,
              newValue: fetchedPrice,
              reason: oldPrice === fetchedPrice ? "Retrieved – no change" : "Retrieved from Amazon SP-API",
              source: "retrieve_price",
            });
            updates.price = fetchedPrice;
            updates.my_price = fetchedPrice;
          }

          if (competitiveData) {
            updates.buybox_price = competitiveData.buyboxPrice;
            updates.buybox_seller_id = competitiveData.buyboxSellerId;
            updates.buybox_is_fba = competitiveData.buyboxIsFba;
            updates.lowest_fba_price = competitiveData.lowestFbaPrice;
            updates.lowest_overall_price = competitiveData.lowestOverallPrice || competitiveData.lowestFbmPrice;
            // Only update offers_count when we have a positive signal.
            // Keep previous value on 0/empty responses to avoid rows disappearing under "Has Offers"
            // after manual refreshes when SP-API returns transient empty snapshots.
            if (competitiveData.totalOfferCount > 0) {
              updates.offers_count = competitiveData.totalOfferCount;
            }
            updates.snapshot_fetched_at = new Date().toISOString();
          }
          
          return { ...i, ...updates };
        })
      );
      
      // Show success message with fetched data
      const currencySymbol = marketplaceConfig.currencySymbol;
      const messages: string[] = [];
      
      if (fetchedPrice !== null) {
        messages.push(`Your: ${currencySymbol}${fetchedPrice.toFixed(2)}`);
      }
      if (competitiveData?.buyboxPrice) {
        messages.push(`BB: ${currencySymbol}${competitiveData.buyboxPrice.toFixed(2)}`);
      }
      if (competitiveData?.lowestFbaPrice) {
        messages.push(`Low: ${currencySymbol}${competitiveData.lowestFbaPrice.toFixed(2)}`);
      }
      if (competitiveData?.totalOfferCount) {
        messages.push(`${competitiveData.totalOfferCount} offers`);
      }
      
      // Determine what to show
      const hasCompetitiveData = competitiveData && (competitiveData.buyboxPrice || competitiveData.lowestFbaPrice || competitiveData.totalOfferCount);
      const listingNotFound = priceData?.message?.includes("inactive") || priceData?.error?.includes("404");
      
      if (messages.length > 0) {
        // We have some data to show
        if (fetchedPrice === null && listingNotFound) {
          // Show competitive data but note that listing doesn't exist
          toast.info(`No listing in ${marketplace} | ${messages.join(" | ")}`, { duration: 5000 });
        } else {
          toast.success(messages.join(" | "), { duration: 4000 });
        }
      } else if (listingNotFound && !hasCompetitiveData) {
        // No listing and no competitive data - product doesn't exist in this marketplace
        toast.info(`Product not listed in ${marketplace} marketplace`, { duration: 5000 });
      } else if (priceData?.error && !priceData.error.includes("404")) {
        toast.error(priceData.error, { duration: 5000 });
      } else if (priceData?.message) {
        toast.info(priceData.message);
      } else {
        toast.error("Could not fetch pricing data");
      }

      // After fetching price, automatically trigger Actual ROI calculation
      // Use the updated item with the freshly fetched price
      const updatedItem = { ...item };
      if (fetchedPrice !== null) {
        updatedItem.my_price = fetchedPrice;
        updatedItem.price = fetchedPrice;
      }
      if (competitiveData) {
        updatedItem.buybox_price = competitiveData.buyboxPrice;
        updatedItem.lowest_fba_price = competitiveData.lowestFbaPrice;
        updatedItem.lowest_overall_price = competitiveData.lowestOverallPrice || competitiveData.lowestFbmPrice;
      }

      // ===== AUTO-POPULATE MIN / MAX when not already set =====
      // Min = MAX(cost × 2.5, lowestFBA × 0.95) — accounts for ~40% Amazon fees
      // Max = BuyBox × 1.30 (30% above BB)
      const hasMinSet = (item.min_price_override ?? item.inv_min_price) != null;
      const hasMaxSet = (item.max_price_override ?? item.inv_max_price) != null;

      if (!hasMinSet || !hasMaxSet) {
        const usdCost = item.cost ?? 0;
        const yourPrice = updatedItem.my_price ?? updatedItem.price ?? 0;
        const bbPrice = updatedItem.buybox_price ?? 0;
        const lowestFba = updatedItem.lowest_fba_price ?? 0;

        let autoMin: number | null = null;
        let autoMax: number | null = null;

        if (!hasMinSet && yourPrice > 0) {
          // Simple: set min to 5% below current price
          autoMin = Math.round(yourPrice * 0.95 * 100) / 100;
        }

        if (!hasMaxSet) {
          // 30% above Buy Box price
          const bbMax = bbPrice > 0 ? Math.round(bbPrice * 1.30 * 100) / 100 : 0;
          // Fallback: 30% above your price if no BB
          const priceMax = yourPrice > 0 ? Math.round(yourPrice * 1.30 * 100) / 100 : 0;
          autoMax = Math.max(bbMax, priceMax) || null;
        }

        if (autoMin != null || autoMax != null) {
          // Ensure min < max
          if (autoMin != null && autoMax != null && autoMin >= autoMax) {
            autoMax = Math.round((autoMin * 1.20) * 100) / 100;
          }

          // Update local state
          setItems(prev =>
            prev.map(i => {
              if (i.id !== item.id) return i;
              return {
                ...i,
                min_price_override: autoMin ?? i.min_price_override,
                max_price_override: autoMax ?? i.max_price_override,
              };
            })
          );
          // Also update updatedItem for downstream ROI calcs
          if (autoMin != null) updatedItem.min_price_override = autoMin;
          if (autoMax != null) updatedItem.max_price_override = autoMax;

          // Persist to repricer_assignments (source of truth for all marketplaces).
          // Previously only wrote to `inventory.min_price/max_price`, which the UI
          // treats as US-only fallback — non-US rows (CA/MX/BR) would flash the value
          // then revert on the next refresh because assignment.min_price_override was
          // still null. Ensure/create an assignment and persist there.
          try {
            const assignmentId = await ensureAssignment(item);
            if (assignmentId) {
              const assignUpdate: Record<string, any> = {};
              if (autoMin != null) {
                assignUpdate.min_price_override = autoMin;
                assignUpdate.manual_min_price = autoMin;
              }
              if (autoMax != null) {
                assignUpdate.max_price_override = autoMax;
              }
              const { error: assignErr } = await supabase
                .from("repricer_assignments")
                .update(assignUpdate)
                .eq("id", assignmentId);
              if (assignErr) throw assignErr;

              // Sync inventory bounds only for US (legacy fallback path).
              if (marketplace === "US") {
                const invUpdate: Record<string, number> = {};
                if (autoMin != null) invUpdate.min_price = autoMin;
                if (autoMax != null) invUpdate.max_price = autoMax;
                await supabase
                  .from("inventory")
                  .update(invUpdate)
                  .eq("id", item.id)
                  .eq("user_id", user.id);
              }

              // Update local state with assignment_id so subsequent edits target the right row.
              setItems(prev =>
                prev.map(i => (i.id === item.id ? { ...i, assignment_id: assignmentId } : i))
              );

              const mktCfg = getMarketplaceConfig(marketplace);
              toast.success(
                `Auto-set ${autoMin != null ? `Min: ${mktCfg.currencySymbol}${autoMin.toFixed(2)}` : ""}${autoMin != null && autoMax != null ? " / " : ""}${autoMax != null ? `Max: ${mktCfg.currencySymbol}${autoMax.toFixed(2)}` : ""}`,
                { duration: 4000 }
              );
            } else {
              // No assignment could be created — leave values in local state and mark pending
              setPendingChanges(prev => new Set(prev).add(item.id));
              toast.warning("Auto-fill applied locally — save to persist", { duration: 4000 });
            }
          } catch (persistErr: any) {
            console.error("Auto-fill persist error:", persistErr);
            setPendingChanges(prev => new Set(prev).add(item.id));
            toast.error("Auto-fill values shown but failed to save — press Save");
          }
        }
      }
      // ===== END AUTO-POPULATE =====

      calculateActualRoi(updatedItem);

      // Also trigger Buy Box ROI calculation automatically
      calculateBuyBoxRoi(updatedItem);

      // Also trigger ROI Range (Min/Max ROI%) calculation automatically
      calculateRoiRange(updatedItem);
    } catch (error: any) {
      console.error("Fetch price error:", error);
      toast.error(error.message || "Failed to fetch price");
    } finally {
      setFetchingPrice(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Calculate Actual ROI for an item using the calculate-roi edge function (same as ROI Calculator)
  // This calls Amazon SP-API for LIVE accurate fees
  const calculateActualRoi = async (item: InventoryWithAssignment) => {
    if (!user) return;
    
    setFetchingRoi(prev => new Set(prev).add(item.id));
    
    try {
      let currentPrice = item.my_price ?? item.price;
      const usdCost = item.cost; // Cost is always stored in USD
      
      // If we don't have cost, show error and clear loading state
      if (!usdCost || usdCost <= 0) {
        toast.error("Missing cost - add unit cost in Inventory or Created Listings");
        setFetchingRoi(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        return;
      }
      
      // If we don't have price, try to use amazon_price or last_applied_price as fallback
      if (!currentPrice || currentPrice <= 0) {
        const fallbackPrice = (item as any).amazon_price ?? (item as any).last_applied_price;
        if (fallbackPrice && fallbackPrice > 0) {
          currentPrice = fallbackPrice;
        } else {
          toast.error("Missing price — fetch price first or wait for price sync");
          setFetchingRoi(prev => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
          return;
        }
      }
      
      // Get the marketplace config for currency info
      const marketplaceConfig = getMarketplaceConfig(marketplace);
      const isNonUs = marketplace !== "US";
      let fxRate = 1;
      let convertedCost = usdCost;
      
      // For non-US marketplaces, fetch FX rate and convert cost
      if (isNonUs) {
        try {
          const { data: fxData } = await supabase.functions.invoke("get-fx-rates", {
            body: { quote: marketplaceConfig.currency }
          });

          if (fxData?.rate?.rate) {
            fxRate = Number(fxData.rate.rate);
            convertedCost = usdCost * fxRate; // Convert USD cost to local currency
          } else {
            // Use approximate fallback rates
            const fallbackRates: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0 };
            fxRate = fallbackRates[marketplaceConfig.currency] || 1;
            convertedCost = usdCost * fxRate;
          }
        } catch (fxErr) {
          console.error("FX rate fetch error:", fxErr);
          // Use approximate fallback rates
          const fallbackRates: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0 };
          fxRate = fallbackRates[marketplaceConfig.currency] || 1;
          convertedCost = usdCost * fxRate;
        }
      }
      
      // Call the calculate-roi edge function with the USER'S LISTING PRICE
      // This fetches LIVE accurate fees from Amazon SP-API based on the user's price
      // We pass the price parameter so fees are calculated for the user's listing price, NOT the Buy Box
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      
      const roiResult = await invokeEdgeFunction({
        functionName: "calculate-roi",
        body: { asin: item.asin, cost: usdCost, price: currentPrice, marketplace: marketplace || "US" },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin: item.asin },
      });
      const data = roiResult.data;
      const error = roiResult.ok ? null : new Error(roiResult.errorMessage || "");

      if (error) {
        const msg = error.message || "";
        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          throw new Error("Amazon SP-API quota exceeded. Please try again later.");
        }
        throw new Error(msg || "Failed to calculate ROI");
      }
      
      // NOTE: calculate-roi already handles FX + marketplace currencies server-side.
      // It returns price/fees/profit/roi in the marketplace's native currency.
      let roi: number;
      let profit: number;
      let fees: number;
      
      if (data?.calculation) {
        const calc = data.calculation;
        fees = calc.totalFees;
        profit = calc.profit;
        roi = calc.roi;
      } else {
        throw new Error("No calculation returned from API");
      }
      
      const syncedRoi = Math.round(roi * 10) / 10;
      const assignmentId = item.assignment_id || await ensureAssignment(item);

      if (assignmentId) {
        // Save actual ROI as display-only field, but do NOT set min_roi_override
        // min_roi_override is the user's intentional override of the rule's ROI target
        // Setting it to the actual ROI would suppress the rule's configured floor
        const { error: saveRoiError } = await supabase
          .from("repricer_assignments")
          .update({ min_roi_override: null })
          .eq("id", assignmentId);

        if (saveRoiError) throw saveRoiError;
      }

      // Keep the Min ROI column exactly synced with the live ROI button result
      // and persist it so the same value remains after refresh
      setItems(prev =>
        prev.map(i =>
          i.id === item.id
            ? {
                ...i,
                assignment_id: assignmentId ?? i.assignment_id,
                actual_roi: syncedRoi,
                min_roi_override: null, // Clear override so rule's ROI target takes effect
                // Do NOT overwrite roi_at_min_percent here — that field tracks ROI at the min price,
                // not actual ROI at current price. calculateRoiRange handles it separately.
                // Store converted cost so the Cost column can display local currency after fetch
                cost_converted: isNonUs ? convertedCost : null,
              }
            : i
        )
      );
      
      const roiDisplay = roi >= 0 ? `+${roi.toFixed(1)}%` : `${roi.toFixed(1)}%`;
      const currencySymbol = marketplaceConfig.currencySymbol;
      const profitDisplay = ` | Profit: ${currencySymbol}${profit.toFixed(2)} | Fees: ${currencySymbol}${fees.toFixed(2)}`;
      const costNote = isNonUs ? ` | Cost: ${currencySymbol}${convertedCost.toFixed(2)}` : "";
      
      toast.success(`ROI: ${roiDisplay}${profitDisplay}${costNote} (Live API)`, { duration: 5000 });
      
    } catch (error: any) {
      console.error("Calculate ROI error:", error);
      toast.error(error.message || "Failed to calculate ROI");
    } finally {
      setFetchingRoi(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Calculate Buy Box ROI for an item using the calculate-roi edge function
  // This uses the Buy Box price instead of the user's price
  const calculateBuyBoxRoi = async (item: InventoryWithAssignment) => {
    if (!user) return;
    
    setFetchingBbRoi(prev => new Set(prev).add(item.id));
    
    try {
      const buyboxPrice = item.buybox_price;
      const usdCost = item.cost; // Cost is always stored in USD
      
      // If we don't have cost, show error and clear loading state
      if (!usdCost || usdCost <= 0) {
        toast.error("Missing cost - add unit cost in Inventory or Created Listings");
        setFetchingBbRoi(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        return;
      }
      
      // If we don't have Buy Box price, show error and clear loading state
      if (!buyboxPrice || buyboxPrice <= 0) {
        toast.error("Missing Buy Box price - fetch price data first");
        setFetchingBbRoi(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        return;
      }
      
      // Get the marketplace config for currency info
      const marketplaceConfig = getMarketplaceConfig(marketplace);
      const isNonUs = marketplace !== "US";
      let fxRate = 1;
      let convertedCost = usdCost;
      
      // For non-US marketplaces, fetch FX rate and convert cost
      if (isNonUs) {
        try {
          const { data: fxData } = await supabase.functions.invoke("get-fx-rates", {
            body: { quote: marketplaceConfig.currency }
          });

          if (fxData?.rate?.rate) {
            fxRate = Number(fxData.rate.rate);
            convertedCost = usdCost * fxRate; // Convert USD cost to local currency
          } else {
            // Use approximate fallback rates
            const fallbackRates: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0 };
            fxRate = fallbackRates[marketplaceConfig.currency] || 1;
            convertedCost = usdCost * fxRate;
          }
        } catch (fxErr) {
          console.error("FX rate fetch error:", fxErr);
          // Use approximate fallback rates
          const fallbackRates: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0 };
          fxRate = fallbackRates[marketplaceConfig.currency] || 1;
          convertedCost = usdCost * fxRate;
        }
      }
      
      // Call the calculate-roi edge function WITHOUT price override
      // This uses the BUY BOX PRICE from Amazon SP-API (not the user's listing price)
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      
      // Pass buyboxPrice as price override so fees are calculated for the BB price specifically
      const roiResult = await invokeEdgeFunction({
        functionName: "calculate-roi",
        body: { asin: item.asin, cost: usdCost, price: buyboxPrice, marketplace: marketplace || "US" },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin: item.asin },
      });
      const data = roiResult.data;
      const error = roiResult.ok ? null : new Error(roiResult.errorMessage || "");

      if (error) {
        const msg = error.message || "";
        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          throw new Error("Amazon SP-API quota exceeded. Please try again later.");
        }
        throw new Error(msg || "Failed to calculate Buy Box ROI");
      }
      
      // NOTE: calculate-roi already handles FX + marketplace currencies server-side.
      // It returns price/fees/profit/roi in the marketplace's native currency.
      let roi: number;
      let profit: number;
      let fees: number;
      
      if (data?.calculation) {
        const calc = data.calculation;
        fees = calc.totalFees;
        profit = calc.profit;
        roi = calc.roi;
      } else {
        throw new Error("No calculation returned from API");
      }
      
      // Update local state with calculated Buy Box ROI
      setItems(prev =>
        prev.map(i =>
          i.id === item.id
            ? {
                ...i,
                buybox_roi: Math.round(roi * 10) / 10,
                // Also update converted cost if not already set
                cost_converted: i.cost_converted ?? (isNonUs ? convertedCost : null),
              }
            : i
        )
      );
      
      const roiDisplay = roi >= 0 ? `+${roi.toFixed(1)}%` : `${roi.toFixed(1)}%`;
      const currencySymbol = marketplaceConfig.currencySymbol;
      const profitDisplay = ` | Profit: ${currencySymbol}${profit.toFixed(2)} | Fees: ${currencySymbol}${fees.toFixed(2)}`;
      const bbPriceNote = ` | BB: ${currencySymbol}${buyboxPrice.toFixed(2)}`;
      
      toast.success(`BB ROI: ${roiDisplay}${profitDisplay}${bbPriceNote} (Live API)`, { duration: 5000 });
      
    } catch (error: any) {
      console.error("Calculate Buy Box ROI error:", error);
      toast.error(error.message || "Failed to calculate Buy Box ROI");
    } finally {
      setFetchingBbRoi(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Calculate ROI Range for Min/Max prices
  const calculateRoiRange = async (item: InventoryWithAssignment) => {
    if (!user) return;
    
    setFetchingRoiRange(prev => new Set(prev).add(item.id));
    
    try {
      const minPrice = item.min_price_override ?? item.inv_min_price;
      const maxPrice = item.max_price_override ?? item.inv_max_price;
      const cost = item.cost;
      
      if (!cost || cost <= 0) {
        toast.error("Missing cost - add unit cost in Inventory or Created Listings");
        setFetchingRoiRange(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        return;
      }
      
      if (!minPrice || !maxPrice) {
        toast.error("Set both Min and Max prices first");
        setFetchingRoiRange(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const rangeResult = await invokeEdgeFunction({
        functionName: "calculate-roi-range",
        body: {
          asin: item.asin,
          sku: item.sku,
          marketplace,
          min_price: minPrice,
          max_price: maxPrice,
          cost,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin: item.asin, sku: item.sku },
      });
      const data = rangeResult.data;
      const error = rangeResult.ok ? null : new Error(rangeResult.errorMessage || "");

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      // Fees API quota exhausted — show a soft notice instead of an error toast.
      if (data.throttled) {
        toast.info(data.message || "ROI temporarily unavailable — Amazon Fees API is rate-limited. Will retry shortly.", { duration: 5000 });
        return;
      }

      // Update local state with the calculated ROI range values only.
      // IMPORTANT: do NOT overwrite min_roi_override here — that field is the saved target/override ROI,
      // while roi_at_min_percent is the calculated achieved ROI at the current min price.
      setItems(prev =>
        prev.map(i =>
          i.id === item.id
            ? {
                ...i,
                roi_at_min_percent: data.roi_at_min,
                roi_at_max_percent: data.roi_at_max,
                roi_range_updated_at: new Date().toISOString(),
              }
            : i
        )
      );

      const minRoiDisplay = data.roi_at_min !== null 
        ? (data.roi_at_min >= 0 ? `${data.roi_at_min.toFixed(1)}%` : `${data.roi_at_min.toFixed(1)}% (Loss)`)
        : "N/A";
      const maxRoiDisplay = data.roi_at_max !== null 
        ? (data.roi_at_max >= 0 ? `${data.roi_at_max.toFixed(1)}%` : `${data.roi_at_max.toFixed(1)}% (Loss)`)
        : "N/A";
      
      toast.success(`ROI Range: Min ${minRoiDisplay} → Max ${maxRoiDisplay}`, { duration: 5000 });
      
    } catch (error: any) {
      console.error("Calculate ROI Range error:", error);
      // Suppress the generic supabase "non-2xx" toast — that path is now handled
      // server-side by returning a 200 with { throttled:true }. Anything that
      // still reaches here is a real failure worth surfacing.
      const msg = error?.message || "";
      if (/non-2xx/i.test(msg)) {
        toast.info("ROI temporarily unavailable — Amazon Fees API is rate-limited. Will retry shortly.", { duration: 5000 });
      } else {
        toast.error(msg || "Failed to calculate ROI range");
      }
    } finally {
      setFetchingRoiRange(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // ============================================================
  // BIDIRECTIONAL SYNC: Min Price <-> Min ROI%
  // When Min Price changes, calculate and update Min ROI%
  // When Min ROI% changes, calculate and update Min Price
  // ============================================================

  /**
   * Calculate ROI% from a given price using cached fees
   * Returns null if calculation is not possible (missing cost or fees)
   */
  const calculateRoiFromPrice = (item: InventoryWithAssignment, price: number): number | null =>
    calcRoiAtPrice(item.cost, item.fees_json, price, cachedFxRate, marketplace);

  /**
   * Calculate required price to achieve a target ROI%
   * Formula: price = (cost * (1 + ROI/100) + fixedFees) / (1 - referralRate)
   * Returns null if calculation is not possible
   */
  const calculatePriceFromRoi = (item: InventoryWithAssignment, targetRoi: number): number | null => {
    const usdCost = item.cost;
    if (!usdCost || usdCost <= 0) return null;

    const feesJson = item.fees_json as any;
    let localCost = usdCost;
    let referralRate = 0.15;
    let fixedFees = 0;

    if (feesJson) {
      // Legacy format: derive rate from dollar amounts
      if (feesJson.referralFee !== undefined || feesJson.fbaFee !== undefined) {
        const origReferralFee = Number(feesJson.referralFee || 0);
        let fbaFee = Number(feesJson.fbaFee || 0);
        let variableClosingFee = Number(feesJson.variableClosingFee || 0);
        let otherFees = getOtherFixedFees(feesJson);
        const feeMarketplace = String(feesJson.marketplace || "US").toUpperCase();
        if (marketplace !== "US" && cachedFxRate > 1 && feeMarketplace === "US") {
          localCost = usdCost * cachedFxRate;
          fbaFee *= cachedFxRate;
          variableClosingFee *= cachedFxRate;
          otherFees *= cachedFxRate;
        }
        const feesAtPrice = feesJson.price ? Number(feesJson.price) : 0;
        referralRate = feesAtPrice > 0 ? origReferralFee / feesAtPrice : 0.15;
        fixedFees = fbaFee + variableClosingFee + otherFees;
      }
      // New format: rate-based
      else if (feesJson.referral_rate !== undefined || feesJson.fba_fee_fixed !== undefined) {
        referralRate = Number(feesJson.referral_rate ?? 0.15);
        let fbaFeeFixed = Number(feesJson.fba_fee_fixed ?? 0);
        let localVariableClosingFee = Number(feesJson.variable_closing_fee ?? feesJson.variableClosingFee ?? 0);
        let localOtherFees = getOtherFixedFees(feesJson);

        if (marketplace !== "US" && cachedFxRate > 1) {
          localCost = usdCost * cachedFxRate;
          const feeMarketplace = feesJson.marketplace || "US";
          if (feeMarketplace === "US") {
            fbaFeeFixed = fbaFeeFixed * cachedFxRate;
            localVariableClosingFee = localVariableClosingFee * cachedFxRate;
            localOtherFees = localOtherFees * cachedFxRate;
          }
        }
        fixedFees = fbaFeeFixed + localVariableClosingFee + localOtherFees;
      }
    }

    if (marketplace !== "US" && cachedFxRate > 1 && localCost === usdCost) {
      localCost = usdCost * cachedFxRate;
    }

    if (referralRate >= 1) return null;

    const requiredProfit = localCost * (targetRoi / 100);
    const price = (localCost + requiredProfit + fixedFees) / (1 - referralRate);
    return Math.ceil(price * 100) / 100;
  };

  /**
   * Fetch ROI for an entered price via the SAME `calculate-roi` edge function the
   * Product Analyzer / ROI Calculator uses. Guarantees the ROI shown under the
   * Min/Max inputs matches the analyzer exactly (live SP-API fees), bypassing
   * any stale `learned_history` rows in asin_fee_cache that would otherwise skew
   * the local estimate.
   */
  const fetchLiveRoiForPrice = async (
    item: InventoryWithAssignment,
    price: number,
    field: "min" | "max",
  ): Promise<void> => {
    if (!user) return;
    const usdCost = item.cost;
    if (!usdCost || usdCost <= 0 || !price || price <= 0) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const result = await invokeEdgeFunction({
        functionName: "calculate-roi",
        body: { asin: item.asin, cost: usdCost, price, marketplace: marketplace || "US" },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin: item.asin },
      });
      if (!result.ok) return;
      const calc = (result.data as any)?.calculation;
      if (!calc || typeof calc.roi !== "number") return;
      const liveRoi = Math.round(calc.roi * 10) / 10;
      setItems(prev =>
        prev.map(i => {
          if (i.id !== item.id) return i;
          return field === "min"
            ? { ...i, roi_at_min_percent: liveRoi }
            : { ...i, roi_at_max_percent: liveRoi };
        }),
      );
    } catch (err) {
      console.warn("[Repricer] fetchLiveRoiForPrice failed:", err);
    }
  };

  /**
   * Handle Min Price blur - update Min ROI% based on the new price.
   * Uses optimistic UI with rollback if the save fails.
   */
  const handleMinPriceBlur = (item: InventoryWithAssignment, value: string) => {
    const raw = value.trim();
    const parsed = raw === "" ? null : Number(raw);

    if (raw !== "" && (!Number.isFinite(parsed) || Number(parsed) < 0)) {
      toast.error("Invalid Min price");
      setEditingMinPrice(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    const numVal = parsed === null ? null : Math.round(Number(parsed) * 100) / 100;
    const previous = items.find(i => i.id === item.id) ?? item;
    const snapshot = pendingStateSnapshotRef.current[item.id];
    const snapshotEffectiveMin = snapshot
      ? normalizePendingValue(snapshot.min_price_override ?? snapshot.inv_min_price)
      : null;
    const isRevertingToSnapshot = snapshot && normalizePendingValue(numVal) === snapshotEffectiveMin;

    let calculatedRoi: number | null = null;
    if (numVal !== null && numVal > 0) {
      calculatedRoi = calculateRoiFromPrice(previous, numVal);
    }

    // Min ROI validation: warn if the new min price falls below the rule's ROI floor.
    // Re-derive from the live rules list (not the cached previous.rule_min_roi_enabled
    // field) so a stale cached assignments snapshot can never show this warning after
    // the marketplace's Respect-Min-ROI toggle has been turned off.
    const liveRuleForRoiCheck = rules.find(r => r.id === (previous.rule_id || previous.saved_rule_id));
    const roiEnabledForThisMarketplace = resolveRuleMinRoiEnabledForMarketplace(liveRuleForRoiCheck as any, marketplace);
    if (!isRevertingToSnapshot && numVal !== null && numVal > 0 && roiEnabledForThisMarketplace && calculatedRoi !== null) {
      const effectiveTargetRoi = (liveRuleForRoiCheck as any)?.min_roi_marketplace_overrides?.[marketplace]
        ?? (liveRuleForRoiCheck as any)?.min_roi_percent
        ?? 30;
      if (calculatedRoi < effectiveTargetRoi) {
        const roiFloorPrice = calculatePriceFromRoi(previous, effectiveTargetRoi);
        toast.warning(
          `⚠️ Min price $${numVal.toFixed(2)} gives ${calculatedRoi.toFixed(1)}% ROI — below your rule's ${effectiveTargetRoi}% minimum.${roiFloorPrice ? ` Min ROI floor price: $${roiFloorPrice.toFixed(2)}` : ''}`,
          { duration: 8000 }
        );
      }
    }

    const nextMinOverride = isRevertingToSnapshot ? snapshot.min_price_override : numVal;
    const nextMinRoi = isRevertingToSnapshot
      ? snapshot.min_roi_override
      : previous.min_roi_override;
    const nextRoiAtMin = isRevertingToSnapshot
      ? previous.roi_at_min_percent
      : (calculatedRoi !== null ? calculatedRoi : (nextMinOverride === null ? null : previous.roi_at_min_percent));

    // Price shift on min increase: if new min > old min, shift current price up by the delta
    const oldMin = previous.min_price_override ?? previous.inv_min_price;
    const currentPrice = previous.my_price ?? previous.price;
    let shiftedPrice: number | null = null;
    if (!isRevertingToSnapshot && numVal !== null && oldMin !== null && numVal > oldMin && currentPrice !== null) {
      const delta = numVal - oldMin;
      let candidate = currentPrice + delta;
      const maxPrice = previous.max_price_override ?? previous.inv_max_price;
      if (maxPrice != null && candidate > Number(maxPrice)) candidate = Number(maxPrice);
      if (candidate < numVal) candidate = numVal;
      candidate = Math.round(candidate * 100) / 100;
      if (candidate !== currentPrice) {
        shiftedPrice = candidate;
      }
    }

    const nextPendingPrice = isRevertingToSnapshot
      ? (snapshot?.pending_new_price ?? null)
      : shiftedPrice;

    // Local-only update (no DB save — user must click green toggle to persist)
    setItems(prev =>
      prev.map(i => {
        if (i.id !== item.id) return i;
        return {
          ...i,
          min_price_override: nextMinOverride,
          roi_at_min_percent: nextRoiAtMin,
          status: (i.status as string) === "paused_profit_guard" ? "active" : i.status,
          inv_min_price: marketplace === "US" && nextMinOverride === null ? null : i.inv_min_price,
          min_roi_override: nextMinRoi,
        };
      })
    );

    if (isRevertingToSnapshot) {
      setPendingNewPrice(prev => {
        const next = { ...prev };
        if (snapshot?.pending_new_price == null) delete next[item.id];
        else next[item.id] = snapshot.pending_new_price;
        return next;
      });
      setEditingNewPrice(prev => {
        const next = { ...prev };
        if (snapshot?.pending_new_price == null) delete next[item.id];
        else next[item.id] = snapshot.pending_new_price.toString();
        return next;
      });
    } else if (shiftedPrice !== null) {
      setPendingNewPrice(prev => ({ ...prev, [item.id]: shiftedPrice }));
      setEditingNewPrice(prev => ({ ...prev, [item.id]: shiftedPrice.toString() }));
      toast.info(`Min raised → Price auto-shifted to ${shiftedPrice.toFixed(2)}. Click Save to apply.`, { duration: 5000 });
    }

    const revertedRow = hasReturnedToPendingSnapshot(
      previous,
      {
        min_price_override: nextMinOverride,
        min_roi_override: nextMinRoi,
        status: (previous.status as string) === "paused_profit_guard" ? "active" : previous.status,
      },
      nextPendingPrice,
    );

    if (revertedRow) {
      setPendingChanges(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      clearPendingSnapshot(item.id);
    } else {
      setPendingChanges(prev => new Set(prev).add(item.id));
    }

    // IMPORTANT: changing Min Price recalculates achieved ROI-at-min only.
    // It must NEVER stage a write into min_roi_override, which is the saved
    // target override consumed by the repricer backend.
    setEditingMinRoi(prev => {
      if (prev[item.id] === undefined) return prev;
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    setEditingMinPrice(prev => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    // Sync ROI display with the Product Analyzer / ROI Calculator (live SP-API fees).
    if (numVal !== null && numVal > 0) {
      void fetchLiveRoiForPrice(previous, numVal, "min");
    }
  };

  /**
   * Handle Max Price blur with optimistic UI + rollback on failure.
   */
  const handleMaxPriceBlur = (item: InventoryWithAssignment, value: string) => {
    const raw = value.trim();
    const parsed = raw === "" ? null : Number(raw);

    if (raw !== "" && (!Number.isFinite(parsed) || Number(parsed) < 0)) {
      toast.error("Invalid Max price");
      setEditingMaxPrice(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    const numVal = parsed === null ? null : Math.round(Number(parsed) * 100) / 100;
    const previous = items.find(i => i.id === item.id) ?? item;

    // Calculate ROI at the new max price
    let calculatedMaxRoi: number | null = null;
    if (numVal !== null && numVal > 0) {
      calculatedMaxRoi = calculateRoiFromPrice(previous, numVal);
    }

    // Local-only update (no DB save — user must click green toggle to persist)
    setItems(prev =>
      prev.map(i =>
        i.id === item.id
          ? {
              ...i,
              max_price_override: numVal,
              roi_at_max_percent: calculatedMaxRoi !== null ? calculatedMaxRoi : (numVal === null ? null : i.roi_at_max_percent),
              status: (i.status as string) === "paused_profit_guard" ? "active" : i.status,
              inv_max_price: marketplace === "US" && numVal === null ? null : i.inv_max_price,
            }
          : i
      )
    );

    // Check if reverted to original
    const reverted = hasReturnedToPendingSnapshot(
      previous,
      {
        max_price_override: numVal,
        status: (previous.status as string) === "paused_profit_guard" ? "active" : previous.status,
      },
    );

    if (reverted) {
      setPendingChanges(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      clearPendingSnapshot(item.id);
    } else {
      setPendingChanges(prev => new Set(prev).add(item.id));
    }

    setEditingMaxPrice(prev => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    // Sync ROI display with the Product Analyzer / ROI Calculator (live SP-API fees).
    if (numVal !== null && numVal > 0) {
      void fetchLiveRoiForPrice(previous, numVal, "max");
    }
  };

  /**
   * Handle Min ROI% blur - update Min Price based on the target ROI
   * Also auto-persists the override to the DB so it survives marketplace switches.
   */
  const handleMinRoiBlur = (item: InventoryWithAssignment, value: string) => {
    const numVal = value ? parseFloat(value) : null;
    
    // Calculate price before updating state
    let calculatedPrice: number | null = null;
    if (numVal !== null) {
      calculatedPrice = calculatePriceFromRoi(item, numVal);
    }
    
    // Local-only update (no DB save — user must click green toggle to persist)
    setItems(prev =>
      prev.map(i => {
        if (i.id !== item.id) return i;
        let updatedItem = { ...i, min_roi_override: numVal };
        if (calculatedPrice !== null) {
          updatedItem.min_price_override = calculatedPrice;
          setEditingMinPrice(prev => ({ ...prev, [item.id]: calculatedPrice!.toString() }));
        }
        return updatedItem;
      })
    );

    // Mark as pending so green toggle appears
    setPendingChanges(prev => new Set(prev).add(item.id));
    
    // Clear editing state
    setEditingMinRoi(prev => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
  };

  const toggleItemEnabled = async (item: InventoryWithAssignment, enabled: boolean) => {
    try {
      // CRITICAL: Use ensureAssignment to get the correct marketplace-specific assignment
      // item.assignment_id could be stale/wrong marketplace
      const correctAssignmentId = await ensureAssignment(item);
      if (!correctAssignmentId) return;
      const nowIso = new Date().toISOString();
      const payload: Record<string, unknown> = enabled
        ? {
            is_enabled: true,
            manual_paused: false,
            last_enabled_by: "user",
            last_enabled_at: nowIso,
            // Clear stale disable audit so status recomputes to Active
            last_disabled_by: null,
            last_disabled_reason: null,
            last_disabled_at: null,
          }
        : {
            is_enabled: false,
            manual_paused: true,
            last_disabled_by: "user",
            last_disabled_reason: "Manual pause from repricer table",
            last_disabled_at: nowIso,
          };
      const { error } = await supabase
        .from("repricer_assignments")
        .update(payload)
        .eq("id", correctAssignmentId);
      if (error) throw error;
      setItems(prev => prev.map(i => i.id === item.id ? {
        ...i,
        is_enabled: enabled,
        manual_paused: !enabled,
        last_disabled_by: enabled ? null : "user",
        last_disabled_reason: enabled ? null : "Manual pause from repricer table",
        last_disabled_at: enabled ? null : nowIso,
      } : i));
      toast.success(enabled ? "ASIN resumed" : "ASIN paused", { duration: 1500 });
    } catch (err: any) {
      toast.error("Failed to update: " + err.message);
    }
  };

  // =====================================================================
  // Stable ref-mirrors + useCallback handlers for <MinMaxPriceCells>.
  //
  // Path A of the repricer input-lag fix. State (editingMinPrice /
  // editingMaxPrice / pendingChanges) stays in this parent component so
  // cross-cell live validation, live ROI-at-min, per-row Save indicator,
  // and the async polling loop that reads editingMin/MaxPriceRef around
  // line ~2246 all keep working exactly as before. The perf win comes
  // from these callbacks being stable references passed into a
  // React.memo'd cell — non-editing rows short-circuit their re-render
  // instead of all N rows rebuilding on every keystroke.
  //
  // The callbacks read the latest handlers / capturePendingSnapshot via
  // ref-mirrors so they never need to be re-created and never go stale.
  // =====================================================================
  const capturePendingSnapshotRef = useRef(capturePendingSnapshot);
  capturePendingSnapshotRef.current = capturePendingSnapshot;
  const handleMinPriceBlurRef = useRef(handleMinPriceBlur);
  handleMinPriceBlurRef.current = handleMinPriceBlur;
  const handleMaxPriceBlurRef = useRef(handleMaxPriceBlur);
  handleMaxPriceBlurRef.current = handleMaxPriceBlur;

  const handleMinCellChange = useCallback((id: string, value: string) => {
    const item = itemsRef.current.find(i => i.id === id);
    if (item) capturePendingSnapshotRef.current(item);
    setEditingMinPrice(prev => ({ ...prev, [id]: value }));
    // #3 guard: skip Set churn when id is already present (huge win on hot path).
    setPendingChanges(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const handleMaxCellChange = useCallback((id: string, value: string) => {
    const item = itemsRef.current.find(i => i.id === id);
    if (item) capturePendingSnapshotRef.current(item);
    setEditingMaxPrice(prev => ({ ...prev, [id]: value }));
    setPendingChanges(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const handleMinCellFocus = useCallback((id: string) => {
    setEditingMinPrice(prev => {
      if (prev[id] !== undefined) return prev;
      const item = itemsRef.current.find(i => i.id === id);
      if (!item) return prev;
      return { ...prev, [id]: (item.min_price_override ?? item.inv_min_price)?.toString() ?? "" };
    });
  }, []);

  const handleMaxCellFocus = useCallback((id: string) => {
    setEditingMaxPrice(prev => {
      if (prev[id] !== undefined) return prev;
      const item = itemsRef.current.find(i => i.id === id);
      if (!item) return prev;
      return { ...prev, [id]: (item.max_price_override ?? item.inv_max_price)?.toString() ?? "" };
    });
  }, []);

  const handleMinCellBlur = useCallback((id: string) => {
    const val = editingMinPriceRef.current[id];
    if (val === undefined) return;
    const item = itemsRef.current.find(i => i.id === id);
    if (item) handleMinPriceBlurRef.current(item, val);
  }, []);

  const handleMaxCellBlur = useCallback((id: string) => {
    const val = editingMaxPriceRef.current[id];
    if (val === undefined) return;
    const item = itemsRef.current.find(i => i.id === id);
    if (item) handleMaxPriceBlurRef.current(item, val);
  }, []);

  const handleMinCellEscape = useCallback((id: string) => {
    setEditingMinPrice(prev => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const handleMaxCellEscape = useCallback((id: string) => {
    setEditingMaxPrice(prev => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);



  const syncChangesToAmazon = async (item: InventoryWithAssignment) => {
    const currentItem = items.find(i => i.id === item.id) ?? item;

    const parseLiveNumber = (raw?: string) => {
      if (raw === undefined) return undefined;
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return NaN;
      return Math.round(parsed * 100) / 100;
    };

    const liveMin = parseLiveNumber(editingMinPrice[item.id]);
    const liveMax = parseLiveNumber(editingMaxPrice[item.id]);
    const liveMinRoi = parseLiveNumber(editingMinRoi[item.id]);
    const liveNewPrice = parseLiveNumber(editingNewPrice[item.id]);

    if (liveMin !== undefined && typeof liveMin === "number" && Number.isNaN(liveMin)) {
      toast.error("Invalid Min price");
      return false;
    }
    if (liveMax !== undefined && typeof liveMax === "number" && Number.isNaN(liveMax)) {
      toast.error("Invalid Max price");
      return false;
    }
    if (liveMinRoi !== undefined && typeof liveMinRoi === "number" && Number.isNaN(liveMinRoi)) {
      toast.error("Invalid Min ROI");
      return false;
    }
    if (liveNewPrice !== undefined && typeof liveNewPrice === "number" && Number.isNaN(liveNewPrice)) {
      toast.error("Invalid New price");
      return false;
    }

    const minPrice = liveMin !== undefined
      ? liveMin
      : (currentItem.min_price_override ?? currentItem.inv_min_price);
    const maxPrice = liveMax !== undefined
      ? liveMax
      : (currentItem.max_price_override ?? currentItem.inv_max_price);
    const newPrice = liveNewPrice !== undefined
      ? liveNewPrice
      : pendingNewPrice[currentItem.id];
    const hasNewPrice = newPrice != null;

    // Track whether Min/Max actually changed (vs just being re-saved at the
    // same value) so a Set-Price-only save never triggers a bounds check,
    // and a bounds-only save never triggers a full competitive re-evaluation.
    const previousMin = currentItem.min_price_override ?? currentItem.inv_min_price ?? null;
    const previousMax = currentItem.max_price_override ?? currentItem.inv_max_price ?? null;
    const minChanged = liveMin !== undefined && liveMin !== previousMin;
    const maxChanged = liveMax !== undefined && liveMax !== previousMax;
    const boundsChanged = minChanged || maxChanged;

    const ruleChanged = currentItem.rule_id !== currentItem.saved_rule_id;
    const liveRuleForSave = rules.find(r => r.id === (currentItem.rule_id || currentItem.saved_rule_id));
    const liveRoiEnabledForSave = resolveRuleMinRoiEnabledForMarketplace(liveRuleForSave as any, marketplace);
    const shouldClearMinRoiOverride = ruleChanged && !liveRoiEnabledForSave && liveMinRoi === undefined;

    const minRoi = shouldClearMinRoiOverride
      ? null
      : liveMinRoi !== undefined
      ? liveMinRoi
      : currentItem.min_roi_override;

    if (minPrice == null || maxPrice == null) {
      toast.error("Both Min and Max prices are required before saving");
      return false;
    }

    if (minPrice <= 0 || maxPrice <= 0) {
      toast.error("Min and Max prices must be greater than 0");
      return false;
    }

    if (minPrice > maxPrice) {
      toast.error("Min price must be less than or equal to Max price");
      return false;
    }

    // Only validate ROI floor when the user actually edited the Min input.
    // When Min was set authoritatively by the backend (e.g. via the "Raise to ROI"
    // button → apply-min-roi), trust it — local fee math can drift slightly and
    // would otherwise silently block the save with a toast.
    if (liveRoiEnabledForSave && minPrice > 0 && liveMin !== undefined) {
      const roiAtMin = calculateRoiFromPrice(currentItem, minPrice);
      const effectiveTargetRoi = (liveRuleForSave as any)?.min_roi_marketplace_overrides?.[marketplace]
        ?? (liveRuleForSave as any)?.min_roi_percent
        ?? 30;

      if (roiAtMin === null) {
        // Cost data missing — can't calculate ROI locally. Allow save; the backend
        // engine (repricer-ai-evaluate) will enforce the authoritative ROI floor.
        console.warn(`[ROI Guard] Can't calculate ROI for ${currentItem.asin} — missing cost. Backend will enforce.`);
      } else if (roiAtMin < effectiveTargetRoi - 0.5) {
        // 0.5% tolerance for fee-rounding drift between client and backend.
        const roiFloorPrice = calculatePriceFromRoi(currentItem, effectiveTargetRoi);
        toast.error(
          `Min price $${minPrice.toFixed(2)} gives ${roiAtMin.toFixed(1)}% ROI — below your rule's ${effectiveTargetRoi}% minimum.${roiFloorPrice ? ` Set min to at least $${roiFloorPrice.toFixed(2)}` : ""}`,
          { duration: 8000 }
        );
        return false;
      }
    }

    const nextItem: InventoryWithAssignment = {
      ...currentItem,
      min_price_override: liveMin !== undefined ? liveMin : currentItem.min_price_override,
      max_price_override: liveMax !== undefined ? liveMax : currentItem.max_price_override,
      min_roi_override: minRoi,
    };

    try {
      setSyncingMinMax(prev => new Set(prev).add(currentItem.id));

      const assignmentId = await ensureAssignment(nextItem);
      if (!assignmentId) throw new Error("Failed to create assignment");

      const updatePayload: Record<string, any> = {
        min_price_override: nextItem.min_price_override,
        max_price_override: nextItem.max_price_override,
      };
      if (liveMinRoi !== undefined || shouldClearMinRoiOverride) {
        updatePayload.min_roi_override = nextItem.min_roi_override;
      }
      if (nextItem.rule_id !== undefined) updatePayload.rule_id = nextItem.rule_id;
      // Saving Min/Max/ROI/rule is a UI edit only. Do not write `is_enabled` here:
      // no-rule rows are represented locally as disabled, and sending that local
      // false value silently pauses/rejects the assignment. Pause/resume is handled
      // only by toggleItemEnabled(), which stamps the required audit fields.

      const wasPaused = (nextItem.status as string) === "paused_profit_guard";
      if (wasPaused) {
        updatePayload.status = "active";
        updatePayload.consecutive_failures = 0;
        updatePayload.last_recommendation_reason = null;
      }

      const { error: dbError } = await supabase
        .from("repricer_assignments")
        .update(updatePayload)
        .eq("id", assignmentId);

      if (dbError) throw dbError;

      // NOTE: Do NOT delete sibling rows for the same ASIN — different SKUs
      // (e.g. New vs Used) intentionally have separate assignment rows now.

      if (marketplace === "US") {
        await Promise.all([
          supabase.from("inventory").update({ min_price: nextItem.min_price_override }).eq("id", currentItem.id),
          supabase.from("inventory").update({ max_price: nextItem.max_price_override }).eq("id", currentItem.id),
        ]);
      }

      setItems(prev =>
        prev.map(i =>
          i.id === currentItem.id
            ? {
                ...i,
                min_price_override: nextItem.min_price_override,
                max_price_override: nextItem.max_price_override,
                min_roi_override: nextItem.min_roi_override,
                saved_rule_id: i.rule_id,
                ...(wasPaused ? { status: "active" } : {}),
                ...(hasNewPrice && newPrice != null ? { my_price: newPrice, price: newPrice } : {}),
              }
            : i
        )
      );

      // Open post-save grace window so background refetches (realtime-triggered
      // and 30s poll) can't overwrite this row's just-saved override with a
      // stale read for the next few seconds. See JUST_SAVED_OVERRIDE_GRACE_MS.
      justSavedOverrideAtRef.current[currentItem.id] = Date.now();

      setEditingMinPrice(prev => {
        const next = { ...prev };
        delete next[currentItem.id];
        return next;
      });
      setEditingMaxPrice(prev => {
        const next = { ...prev };
        delete next[currentItem.id];
        return next;
      });
      setEditingMinRoi(prev => {
        const next = { ...prev };
        delete next[currentItem.id];
        return next;
      });
      setEditingNewPrice(prev => {
        const next = { ...prev };
        delete next[currentItem.id];
        return next;
      });
      setPendingNewPrice(prev => {
        const next = { ...prev };
        if (hasNewPrice && newPrice != null) next[currentItem.id] = newPrice;
        else delete next[currentItem.id];
        return next;
      });

      clearPendingSnapshot(currentItem.id);
      setPendingChanges(prev => {
        const next = new Set(prev);
        next.delete(currentItem.id);
        return next;
      });

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      try {
        const syncResult = await invokeEdgeFunction({
          functionName: "update-amazon-price",
          body: {
            asin: currentItem.asin,
            sku: currentItem.sku,
            newPrice: hasNewPrice ? newPrice ?? undefined : undefined,
            newMinPrice: minPrice,
            newMaxPrice: maxPrice,
            previousMinPrice: currentItem.min_price_override ?? null,
            previousMaxPrice: currentItem.max_price_override ?? null,
            marketplace: marketplace || "US",
            updateMinMaxOnly: !hasNewPrice,
          },
          headers: { Authorization: `Bearer ${session.access_token}` },
          context: { asin: currentItem.asin, sku: currentItem.sku },
        });

        if (!syncResult.ok) throw new Error(syncResult.errorMessage || "Amazon sync failed");
        toast.success(hasNewPrice ? "Price updated on Amazon" : "Changes saved to Amazon");
      } catch (amazonErr: any) {
        console.error("Amazon sync failed (DB saved):", amazonErr);
        toast.warning("Saved to DB but Amazon sync failed: " + (amazonErr.message || "Unknown error"), { duration: 6000 });
      }

      // Always recalculate ROI at Min/Max after a save. The user expects the
      // "ROI at Min" display under the Min input to refresh whenever they press
      // the heartbeat/save toggle — including the case where Min was staged by
      // the green ▲ Raise-to-ROI button (which writes min_price_override
      // directly without touching editingMinPrice, so liveMin would be undefined).
      {
        const updatedItem = items.find(i => i.id === currentItem.id) ?? nextItem;
        calculateRoiRange(updatedItem);
      }

      // Set Price is a standalone submission — it must not chain into a
      // competitive Momentum Builder re-evaluation. Only Min/Max bound
      // changes get a follow-up check, and that check only clamps the price
      // to the new bound if it's actually violated — it never runs the full
      // competitive anchor/undercut logic. See bounds-changed investigation.
      if (assignmentId && boundsChanged) {
        void checkBoundsViolation({
          assignmentId,
          asin: nextItem.asin,
          sku: nextItem.sku,
          minPrice: nextItem.min_price_override,
          maxPrice: nextItem.max_price_override,
          minChanged,
          maxChanged,
          previousMin,
          previousMax,
          // If a new price was submitted in this same save, validate THAT
          // entered price against the new bounds. Otherwise validate the
          // item's existing known live price.
          referencePrice: hasNewPrice ? (newPrice as number) : (currentItem.my_price ?? currentItem.price ?? null),
        });

        // Targeted instant re-check: only when this row's PRE-save reason
        // shows it was being actively held back by a floor (the engine's own
        // wording: "Competitive target $X blocked by <floor> $Y — holding
        // current price"). A bounds edit that loosens/tightens a floor that
        // wasn't blocking anything doesn't get one — avoids firing an extra
        // SP-API evaluation on every routine Min/Max edit. This is a normal
        // (non-forced) single-assignment eval via repricer-scheduler, same
        // mechanism "Force Smart Raise" uses, just without bypassing guards.
        const wasBlockedByFloor = /blocked by .* floor .* — holding current price/i.test(
          currentItem.last_recommendation_reason || ""
        );
        if (wasBlockedByFloor) {
          supabase.functions.invoke('repricer-scheduler', {
            body: { assignment_ids: [assignmentId], marketplace, dry_run: false },
          }).catch((e: any) => console.warn(`[instant re-eval] failed for ${nextItem.asin}:`, e?.message || e));
        }
      }

      return true;
    } catch (error: any) {
      toast.error("Sync failed: " + error.message);
      return false;
    } finally {
      setSyncingMinMax(prev => {
        const next = new Set(prev);
        next.delete(currentItem.id);
        return next;
      });
    }
  };

  // Bounds-changed follow-up: fires only when Min/Max actually changed on a
  // save. It does NOT run the competitive Momentum Builder evaluation — it
  // only checks whether the reference price (the just-submitted Set Price,
  // or the item's existing live price if only bounds changed) now violates
  // the newly saved bound, and if so submits a direct clamp to that bound.
  // If the reference price is already within bounds, this is a no-op.
  const checkBoundsViolation = async (args: {
    assignmentId: string;
    asin: string;
    sku: string;
    minPrice: number | null | undefined;
    maxPrice: number | null | undefined;
    minChanged: boolean;
    maxChanged: boolean;
    previousMin: number | null;
    previousMax: number | null;
    referencePrice: number | null;
  }) => {
    const { asin, sku, minPrice, maxPrice, minChanged, maxChanged, previousMin, previousMax, referencePrice } = args;
    if (referencePrice == null || !Number.isFinite(referencePrice)) return;

    let clampedPrice: number | null = null;
    let boundaryNote = "";
    if (minPrice != null && referencePrice < minPrice - 0.004) {
      clampedPrice = minPrice;
      boundaryNote = `min ${previousMin ?? "—"} → ${minPrice}`;
    } else if (maxPrice != null && referencePrice > maxPrice + 0.004) {
      clampedPrice = maxPrice;
      boundaryNote = `max ${previousMax ?? "—"} → ${maxPrice}`;
    }

    if (clampedPrice == null) return; // reference price already within the new bounds — nothing to do

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const changedWhich = minChanged && maxChanged ? "min+max" : minChanged ? "min" : "max";
      const result = await invokeEdgeFunction({
        functionName: "update-amazon-price",
        body: {
          asin,
          sku,
          newPrice: clampedPrice,
          newMinPrice: minPrice,
          newMaxPrice: maxPrice,
          previousMinPrice: previousMin,
          previousMaxPrice: previousMax,
          marketplace: marketplace || "US",
          triggerSource: "bounds_changed",
          reason: `Bounds changed (${changedWhich}): ${boundaryNote} — live price ${referencePrice.toFixed(2)} violated new bound, clamped to ${clampedPrice.toFixed(2)}`,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin, sku, source: "bounds_changed" },
      });

      if (result.ok) {
        toast.info(`${asin}: price clamped to ${clampedPrice.toFixed(2)} — outside newly saved bounds`, { duration: 5000 });
        setItems(prev => prev.map(i => (i.asin === asin && i.sku === sku ? { ...i, my_price: clampedPrice as number, price: clampedPrice as number } : i)));
      }
    } catch (error: any) {
      console.error("[checkBoundsViolation] clamp failed:", error);
    }
  };

  const runStaleInStock = async () => {
    try {
      setRunningStaleInStock(true);
      toast.info("Finding stale in-stock ASINs...");

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const { data: inStockItems } = await supabase
        .from("inventory")
        .select("asin, sku")
        .gt("available", 0)
        .neq("listing_status", "INACTIVE");

      if (!inStockItems || inStockItems.length === 0) {
        toast.warning("No in-stock items found");
        return;
      }

      const inStockKeys = new Set(inStockItems.map(i => `${i.asin}:${i.sku}`));

      const { data: staleAssignments } = await supabase
        .from("repricer_assignments")
        .select("id, asin, sku, last_sp_api_check_at")
        .eq("is_enabled", true)
        .not("rule_id", "is", null)
        .or(`last_sp_api_check_at.is.null,last_sp_api_check_at.lt.${twoHoursAgo}`)
        .limit(2000);

      if (!staleAssignments || staleAssignments.length === 0) {
        toast.success("All in-stock ASINs are fresh — nothing to refresh!");
        return;
      }

      const staleInStock = staleAssignments.filter(a => inStockKeys.has(`${a.asin}:${a.sku}`));

      if (staleInStock.length === 0) {
        toast.success("All in-stock ASINs are already up to date!");
        return;
      }

      toast.info(`Refreshing ${staleInStock.length} stale in-stock ASINs...`, { duration: 10000 });

      const BATCH = 50;
      let totalEvaluated = 0;
      let totalApplied = 0;
      for (let i = 0; i < staleInStock.length; i += BATCH) {
        const batch = staleInStock.slice(i, i + BATCH).map(a => a.id);
        const result = await invokeEdgeFunction({
          functionName: "repricer-scheduler",
          body: { dry_run: false, assignment_ids: batch, force_all: true },
          maxRetries: 1,
          context: { source: "stale_in_stock_refresh" },
        });
        if (result.ok && result.data?.summary) {
          totalEvaluated += result.data.summary.evaluated || 0;
          totalApplied += result.data.summary.applied || 0;
        }
      }

      toast.success(
        `Stale refresh done: ${totalEvaluated} evaluated, ${totalApplied} price changes from ${staleInStock.length} ASINs`,
        { duration: 8000 }
      );
    } catch (error: any) {
      toast.error("Stale refresh failed: " + error.message);
    } finally {
      setRunningStaleInStock(false);
    }
  };

  const runBulkDisableZeroStock = async () => {
    if (!confirm("This will disable repricing for all ASINs with 0 sellable inventory. Continue?")) return;
    try {
      setRunningBulkDisable(true);
      toast.info("Finding zero-stock ASINs...");

      // Get all in-stock ASINs from inventory
      const { data: inStockItems } = await supabase
        .from("inventory")
        .select("asin, sku")
        .gt("available", 0);

      const inStockKeys = new Set((inStockItems || []).map(i => `${i.asin}:${i.sku}`));

      // Get all enabled assignments
      let allEnabled: any[] = [];
      let page = 0;
      const PAGE_SIZE = 1000;
      while (true) {
        const { data: batch } = await supabase
          .from("repricer_assignments")
          .select("id, asin, sku")
          .eq("is_enabled", true)
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (!batch || batch.length === 0) break;
        allEnabled = allEnabled.concat(batch);
        if (batch.length < PAGE_SIZE) break;
        page++;
      }

      const zeroStockIds = allEnabled
        .filter(a => !inStockKeys.has(`${a.asin}:${a.sku}`))
        .map(a => a.id);

      if (zeroStockIds.length === 0) {
        toast.success("No zero-stock ASINs to disable!");
        return;
      }

      toast.info(`Disabling ${zeroStockIds.length} zero-stock ASINs...`, { duration: 15000 });

      // Batch update in chunks of 200
      const CHUNK = 200;
      let disabled = 0;
      const nowIso = new Date().toISOString();
      for (let i = 0; i < zeroStockIds.length; i += CHUNK) {
        const chunk = zeroStockIds.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("repricer_assignments")
          .update({
            is_enabled: false,
            manual_paused: false,
            last_disabled_by: "system",
            last_disabled_reason: "Bulk disable: zero stock",
            last_disabled_at: nowIso,
          })
          .in("id", chunk);
        if (!error) disabled += chunk.length;
      }

      toast.success(`Disabled ${disabled} zero-stock ASINs. Active queue reduced to ~${allEnabled.length - disabled} items.`, { duration: 10000 });

      // Refresh the table
      window.location.reload();
    } catch (error: any) {
      toast.error("Bulk disable failed: " + error.message);
    } finally {
      setRunningBulkDisable(false);
    }
  };




  // ── Bulk: Lower Min to Suggested ──
  const bulkLowerMinToSuggested = async () => {
    if (selectedIds.size === 0) return;
    const selected = items.filter(i => selectedIds.has(i.id) && i.assignment_id);
    const actionable = selected
      .map(i => {
        const lowestComp = i.lowest_fba_price ?? i.lowest_overall_price;
        if (lowestComp == null) return null;
        const sugMin = Math.max(Math.round((lowestComp - 0.02) * 100) / 100, 0.99);
        const currentMin = i.min_price_override ?? i.inv_min_price;
        if (currentMin != null && sugMin >= Number(currentMin)) return null;
        return { item: i, sugMin, oldMin: currentMin };
      })
      .filter(Boolean) as { item: InventoryWithAssignment; sugMin: number; oldMin: number | null }[];

    if (actionable.length === 0) {
      toast.info("No items have a suggested lower min");
      return;
    }

    const confirmed = window.confirm(
      `Lower min price for ${actionable.length} item(s)?\n\n` +
      actionable.slice(0, 5).map(a =>
        `${a.item.asin}: ${a.oldMin != null ? formatPrice(Number(a.oldMin), marketplace || "US") : "—"} → ${formatPrice(a.sugMin, marketplace || "US")}`
      ).join("\n") +
      (actionable.length > 5 ? `\n...and ${actionable.length - 5} more` : "")
    );
    if (!confirmed) return;

    setSavingAll(true);
    try {
      const CHUNK = 200;
      for (let i = 0; i < actionable.length; i += CHUNK) {
        const batch = actionable.slice(i, i + CHUNK);
        await Promise.all(batch.map(a =>
          supabase
            .from("repricer_assignments")
            .update({ min_price_override: a.sugMin, updated_at: new Date().toISOString() })
            .eq("id", a.item.assignment_id!)
        ));
        if ((marketplace || "US") === "US") {
          await Promise.all(batch.map(a =>
            supabase
              .from("inventory")
              .update({ min_price: a.sugMin })
              .eq("user_id", user!.id)
              .eq("sku", a.item.sku)
          ));
        }
      }
      setItems(prev => prev.map(i => {
        const match = actionable.find(a => a.item.id === i.id);
        return match ? { ...i, min_price_override: match.sugMin } : i;
      }));
      toast.success(`Min lowered for ${actionable.length} items`);
    } catch (e: any) {
      toast.error("Failed: " + e.message);
    } finally {
      setSavingAll(false);
    }
  };



  const runSelectedScheduler = async () => {
    if (selectedIds.size === 0) {
      toast.error("Select items first");
      return;
    }

    try {
      // Warn on large selections
      if (selectedIds.size > 50) {
        const confirmed = window.confirm(
          `⚠️ You selected ${selectedIds.size} items.\n\nLarge manual runs share the same Amazon SP-API budget as automated repricing (cron/turbo). This may delay automated checks and increase throttling risk.\n\nContinue anyway?`
        );
        if (!confirmed) {
          return;
        }
      }

      setRunningSelected(true);
      toast.info("Resolving marketplace-correct assignments...");

      // CRITICAL FIX: Resolve each selected item through ensureAssignment()
      // to get the correct marketplace-specific assignment ID.
      // item.assignment_id could be stale/wrong marketplace (e.g., US when viewing BR).
      const allSelected = items.filter(i => selectedIds.has(i.id));
      const lockedSkipped = allSelected.filter(i => isItemLocked(i)).length;
      const selectedItems = allSelected.filter(i => !isItemLocked(i));
      if (lockedSkipped > 0) {
        toast.info(`Skipping ${lockedSkipped} locked item${lockedSkipped === 1 ? "" : "s"} (manual eval disabled while locked)`);
      }
      if (selectedItems.length === 0) {
        toast.error("All selected items are locked — unlock to manually evaluate");
        setRunningSelected(false);
        return;
      }
      const ensuredIds = await Promise.all(
        selectedItems.map(i => ensureAssignment(i))
      );
      const selectedAssignmentIds = Array.from(
        new Set(ensuredIds.filter((id): id is string => id !== null))
      );

      if (selectedAssignmentIds.length === 0) {
        toast.error("No assigned items selected — assign a rule first");
        setRunningSelected(false);
        return;
      }

      toast.info(`Running scheduler for ${selectedAssignmentIds.length} selected items...`);

      // Add a client-side timeout to prevent infinite hang
      const TIMEOUT_MS = 90_000; // 90 seconds (edge function wall clock is ~60s)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out — the scheduler may still be processing in the background. Check the Activity Log for results.")), TIMEOUT_MS)
      );

      const resultPromise = invokeEdgeFunction({
        functionName: "repricer-scheduler",
        body: { dry_run: false, assignment_ids: selectedAssignmentIds, marketplace: marketplace || "US" },
        maxRetries: 1,
        context: { source: "manual_run_selected", count: String(selectedAssignmentIds.length) },
      });

      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (!result.ok) {
        const msg = result.errorCategory === "auth_error"
          ? "Authentication failed — please refresh the page"
          : `Run Selected failed (${result.httpStatus || "unknown"}): ${result.errorMessage}`;
        toast.error(msg, { description: result.errorBody?.code || result.errorCategory });
        return;
      }

      const summary = result.data?.summary ?? { evaluated: 0, applied: 0 };
      toast.success(
        `Selected run complete: ${summary.evaluated} evaluated, ${summary.applied} applied`,
        { duration: 6000 }
      );

      setSelectedIds(new Set());

      // Refresh prices for affected items after a short delay to let DB settle
      if (summary.applied > 0) {
        setTimeout(() => {
          refreshPricesAndAssignments();
        }, 2000);
      }
    } catch (error: any) {
      toast.error(error.message || "Run Selected failed");
    } finally {
      setRunningSelected(false);
    }
  };

  // Run a single item (same as Run Selected but for one ASIN)
  const [runningSingleItem, setRunningSingleItem] = useState<Set<string>>(new Set());
  
  const runSingleItem = async (item: InventoryWithAssignment) => {
    if (!item.rule_id) {
      toast.error("Assign a rule first");
      return;
    }

    // Check for unsaved local min/max edits and save them to DB first
    const liveMinStr = editingMinPrice[item.id];
    const liveMaxStr = editingMaxPrice[item.id];
    const hasUnsavedMin = liveMinStr !== undefined && liveMinStr !== "";
    const hasUnsavedMax = liveMaxStr !== undefined && liveMaxStr !== "";

    if (hasUnsavedMin || hasUnsavedMax) {
      const saved = await syncChangesToAmazon(item);
      if (!saved) {
        return; // syncChangesToAmazon already showed the error toast
      }
      // syncChangesToAmazon auto-triggers runSingleItem with the updated item after a delay.
      // Return here to avoid a double-eval race where this call uses stale in-memory data.
      return;
    }

    const minPrice = hasUnsavedMin
      ? Number(liveMinStr)
      : (item.min_price_override ?? item.inv_min_price);
    if (minPrice == null || (typeof minPrice === "number" && isNaN(minPrice))) {
      toast.error("Set a Min price first");
      return;
    }

    // Safety timeout to ensure toggle always unsticks
    const safetyTimer = setTimeout(() => {
      setRunningSingleItem(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }, 100_000);

    try {
      setRunningSingleItem(prev => new Set(prev).add(item.id));

      const assignmentId = await ensureAssignment(item);
      if (!assignmentId) {
        toast.error("Could not resolve assignment");
        return;
      }

      const TIMEOUT_MS = 90_000;
      let timedOut = false;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => { timedOut = true; reject(new Error("TIMEOUT")); }, TIMEOUT_MS)
      );

      const resultPromise = invokeEdgeFunction({
        functionName: "repricer-scheduler",
        body: { dry_run: false, assignment_ids: [assignmentId], marketplace: marketplace || "US" },
        maxRetries: 1,
        context: { source: "manual_run_single", asin: item.asin },
      });

      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (!result.ok) {
        toast.error(`Run failed: ${result.errorMessage}`);
        return;
      }

      const summary = result.data?.summary ?? { evaluated: 0, applied: 0 };
      toast.success(
        `${item.asin}: ${summary.applied > 0 ? `Price updated` : `Evaluated (no change)`}`,
        { duration: 4000 }
      );

      // Refresh prices after a short delay
      if (summary.applied > 0) {
        setTimeout(() => refreshPricesAndAssignments(), 2000);
      }
    } catch (error: any) {
      if (error.message === "TIMEOUT") {
        toast.info(
          `${item.asin}: Request submitted — processing may still continue. Check Activity Log for final result.`,
          { duration: 8000 }
        );
      } else {
        toast.error(error.message || "Run failed");
      }
    } finally {
      clearTimeout(safetyTimer);
      setRunningSingleItem(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Sync International — manually sync selected ASINs to CA/MX/BR
  const [syncingIntl, setSyncingIntl] = useState(false);
  const syncSelectedInternational = async () => {
    if (selectedIds.size === 0) return;
    if (marketplace !== "US") {
      toast.error("Sync International only works from the US marketplace view");
      return;
    }
    setSyncingIntl(true);
    let successCount = 0;
    let errorCount = 0;
    try {
      const selectedItems = items.filter(item => selectedIds.has(item.id));
      for (const item of selectedItems) {
        try {
          const result = await invokeEdgeFunction({
            functionName: "sync-intl-asin",
            body: { asin: item.asin, sku: item.sku },
            maxRetries: 1,
          });
          if (result.ok) {
            const results = result.data?.results || {};
            const synced = Object.values(results).filter((r: any) => r.status === 'synced').length;
            successCount += synced > 0 ? 1 : 0;
          } else {
            errorCount++;
          }
        } catch {
          errorCount++;
        }
      }
      if (successCount > 0) {
        toast.success(`Synced ${successCount} ASIN(s) to international marketplaces`);
      }
      if (errorCount > 0) {
        toast.error(`${errorCount} ASIN(s) failed to sync`);
      }
    } finally {
      setSyncingIntl(false);
    }
  };

  const getStatusBadge = (item: InventoryWithAssignment) => {
    const status = item.listing_status?.toUpperCase() || "UNKNOWN";
    switch (status) {
      case "ACTIVE":
      case "BUYABLE":
        return <Badge variant="default" className="bg-green-500 text-xs">Active</Badge>;
      case "INACTIVE":
        return <Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-700">Inactive</Badge>;
      case "INCOMPLETE":
        return <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-700">Incomplete</Badge>;
      case "DISCOVERABLE":
        return <Badge variant="outline" className="text-xs bg-blue-100 text-blue-700">Discoverable</Badge>;
      case "NOT_FOUND":
        return <Badge variant="destructive" className="text-xs">Not Found</Badge>;
      default:
        return <Badge variant="outline" className="text-xs text-muted-foreground">Unknown</Badge>;
    }
  };

  const getInventoryAge = (createdAt: string | null) => {
    if (!createdAt) return "—";
    const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  };

  // Lock / unlock a record — UI-ONLY edit lock. Does NOT pause the repricer
  // (price must keep moving). When locked, this client prevents the user from
  // editing Min / Max / My Price and from triggering manual evaluations on this
  // row. Persisted on `repricer_assignments.ui_edit_locked` so it survives
  // reloads AND syncs across browsers / devices.
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  // Hydrate locked set from DB whenever items load for this marketplace.
  useEffect(() => {
    const assignmentIds = items.map(i => i.assignment_id).filter(Boolean) as string[];
    if (assignmentIds.length === 0) { setLockedIds(new Set()); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await (supabase as any)
        .from("repricer_assignments")
        .select("id, ui_edit_locked")
        .in("id", assignmentIds)
        .eq("ui_edit_locked", true);
      if (cancelled || error) return;
      setLockedIds(new Set((data || []).map((r: any) => r.id)));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, marketplace]);

  // Realtime sync: padlock (ui_edit_locked) across tabs/computers for this user.
  // Lightweight: filter by user_id, react only when ui_edit_locked changed,
  // patch only the affected assignment id in the local Set — never refetch.
  useEffect(() => {
    if (!user?.id) return;
    const ch = (supabase as any)
      .channel(`assignments-lock-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "repricer_assignments",
          filter: `user_id=eq.${user.id}`,
        },
        (payload: any) => {
          const row = payload?.new;
          if (!row?.id) return;
          const id = row.id as string;

          // 1) Padlock sync
          const nextLocked = !!row.ui_edit_locked;
          setLockedIds(prev => {
            const has = prev.has(id);
            if (has === nextLocked) return prev;
            const next = new Set(prev);
            if (nextLocked) next.add(id); else next.delete(id);
            return next;
          });

          // 2) Cross-computer min/max sync. Patch local items when another
          // browser saves min_price_override / max_price_override / manual_min_price
          // for this user. Respects the just-saved grace window so the sending
          // computer never overwrites its own fresh value with an echo.
          const nextMin = row.min_price_override;
          const nextMax = row.max_price_override;
          const nextManualMin = row.manual_min_price;
          setItems(prev => {
            let changed = false;
            const updated = prev.map(item => {
              if (item.assignment_id !== id) return item;
              const savedAt = justSavedOverrideAtRef.current?.[item.id];
              const inGrace = savedAt != null && (Date.now() - savedAt) < JUST_SAVED_OVERRIDE_GRACE_MS;
              if (inGrace) return item;
              const patch: any = {};
              if (nextMin !== undefined && item.min_price_override !== nextMin) {
                patch.min_price_override = nextMin;
              }
              if (nextMax !== undefined && item.max_price_override !== nextMax) {
                patch.max_price_override = nextMax;
              }
              if (nextManualMin !== undefined && (item as any).manual_min_price !== nextManualMin) {
                patch.manual_min_price = nextManualMin;
              }
              if (Object.keys(patch).length === 0) return item;
              changed = true;
              return { ...item, ...patch };
            });
            return changed ? updated : prev;
          });
        }
      )
      .subscribe();
    return () => { (supabase as any).removeChannel(ch); };
  }, [user?.id]);


  const isItemLocked = (item: InventoryWithAssignment) =>
    !!item.assignment_id && lockedIds.has(item.assignment_id);

  const toggleLock = async (item: InventoryWithAssignment) => {
    if (!item.assignment_id) {
      toast.error("Cannot lock — no assignment exists for this row");
      return;
    }
    const id = item.assignment_id;
    const locking = !lockedIds.has(id);
    // Require unlock code when unlocking
    if (!locking) {
      const code = window.prompt("Enter unlock code to unlock this record:");
      if (code === null) return; // cancelled
      if (code.trim() !== "1365") {
        toast.error("Incorrect unlock code");
        return;
      }
    }
    // Optimistic UI
    const next = new Set(lockedIds);
    if (locking) next.add(id); else next.delete(id);
    setLockedIds(next);
    const { error } = await (supabase as any)
      .from("repricer_assignments")
      .update({ ui_edit_locked: locking })
      .eq("id", id);
    if (error) {
      // Revert on failure
      const revert = new Set(lockedIds);
      setLockedIds(revert);
      toast.error("Failed to update lock: " + error.message);
      return;
    }
    toast.success(locking
      ? "Record locked — edits & manual eval disabled (repricer still running)"
      : "Record unlocked");
  };




  // Open action log dialog for an item
  const openActionLog = (item: InventoryWithAssignment) => {
    setActionLogAsin(item.asin);
    setActionLogSku(item.sku);
    setActionLogStatus(item.status as string);
    setActionLogItemId(item.id);
    setActionLogOpen(true);
  };

  const openListingVerification = (item: InventoryWithAssignment) => {
    setVerifyItem(item);
    setVerifyDialogOpen(true);
  };

  // Mark a non-US listing as removed from Seller Central for THIS marketplace only.
  // Sets intl_listing_status='NOT_FOUND' + marketplace_sellable=false so the existing
  // sellability filter (AssignmentsTable.tsx ~1029) hides the row in this tab.
  // US row is untouched. Reversible: a future SP-API existence check or re-onboarding
  // can flip it back when Amazon confirms the listing exists again.
  const removeFromMarketplace = async (item: InventoryWithAssignment) => {
    if (marketplace === "US") return;
    const ok = window.confirm(
      `Remove "${item.asin}" / "${item.sku}" from the ${marketplace} repricer?\n\n` +
      `Use this when you have deleted the listing in Amazon Seller Central ${marketplace}.\n\n` +
      `• Hides it from the ${marketplace} tab only — US/other marketplaces stay untouched.\n` +
      `• Stops repricing for ${marketplace}.\n` +
      `• Reversible if the listing comes back.`
    );
    if (!ok) return;
    try {
      const { error } = await supabase
        .from("repricer_assignments")
        .update({
          intl_listing_status: "NOT_FOUND",
          marketplace_sellable: false,
          marketplace_sellability_reason: "deleted_from_seller_central",
          marketplace_checked_at: new Date().toISOString(),
          is_enabled: false,
          manual_paused: true,
          last_disabled_by: user?.id ?? null,
          last_disabled_reason: `User removed ${marketplace} listing (deleted in Seller Central)`,
          last_disabled_at: new Date().toISOString(),
        })
        .eq("user_id", user?.id)
        .eq("marketplace", marketplace)
        .eq("asin", item.asin)
        .eq("sku", item.sku);
      if (error) throw error;

      // Remove from local state so the row disappears immediately
      setItems(prev => prev.filter(i => !(i.asin === item.asin && i.sku === item.sku && i.marketplace === marketplace)));

      toast.success(`Removed from ${marketplace}`, {
        description: `${item.asin} hidden from the ${marketplace} repricer. US not affected.`,
      });
    } catch (err: any) {
      console.error("[removeFromMarketplace] failed:", err);
      toast.error("Failed to remove", {
        description: err?.message ?? "Please try again.",
      });
    }
  };



  const handleMinPriceAccepted = useCallback((acceptedAsin: string, acceptedSku: string | null, newMin: number) => {
    const normalizedAcceptedSku = normalizeIdentifier(acceptedSku);
    const normalizedAcceptedAsin = normalizeIdentifier(acceptedAsin);

    // IMPORTANT: Move setPendingChanges and setEditingMinPrice INSIDE the
    // setItems updater. In React 18 the updater callback runs during render,
    // NOT synchronously when setItems() is called. Previously matchedIds was
    // populated inside the callback but checked outside — always empty.
    setItems((prev) => {
      const matchedIds: string[] = [];
      const updated = prev.map((item) => {
        const matchById = actionLogItemId && item.id === actionLogItemId;
        const matchBySku = normalizedAcceptedSku && normalizeIdentifier(item.sku) === normalizedAcceptedSku;
        const matchByAsin = normalizedAcceptedAsin && normalizeIdentifier(item.asin) === normalizedAcceptedAsin;
        const matches = matchById || matchBySku || matchByAsin;

        if (!matches) return item;
        matchedIds.push(item.id);
        return { ...item, min_price_override: newMin };
      });

      if (matchedIds.length > 0) {
        // Schedule these inside the updater so they fire after matchedIds is populated
        setPendingChanges((prev) => {
          const next = new Set(prev);
          matchedIds.forEach((id) => next.add(id));
          return next;
        });

        setEditingMinPrice((prev) => {
          const next = { ...prev };
          matchedIds.forEach((id) => {
            delete next[id];
          });
          return next;
        });
      }

      return updated;
    });
  }, [actionLogItemId, setItems]);

  // Reset price to max (recovery action)
  const resetToMaxPrice = async (item: InventoryWithAssignment) => {
    const maxPrice = item.max_price_override ?? item.inv_max_price;
    if (!maxPrice) {
      toast.error("No max price set for this item");
      return;
    }

    setResettingPrice(prev => new Set(prev).add(item.id));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const marketplaceConfig = getMarketplaceConfig(marketplace);

      const resetResult = await invokeEdgeFunction({
        functionName: "update-amazon-price",
        body: {
          sku: item.sku,
          asin: item.asin,
          newPrice: maxPrice,
          newMinPrice: item.min_price_override ?? item.inv_min_price,
          newMaxPrice: maxPrice,
          marketplace: marketplace || "US",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin: item.asin, sku: item.sku },
      });

      if (!resetResult.ok) throw new Error(resetResult.errorMessage || "Reset failed");
      const data = resetResult.data;

      if (data?.success) {
        toast.success(`Price reset to max: ${marketplaceConfig.currencySymbol}${maxPrice.toFixed(2)}`);
        // Update local state
        setItems(prev =>
          prev.map(i => (i.id === item.id ? { ...i, my_price: maxPrice, price: maxPrice } : i))
        );
      } else {
        throw new Error(data?.message || data?.error || "Reset failed");
      }
    } catch (error: any) {
      toast.error("Reset failed: " + error.message);
    } finally {
      setResettingPrice(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Reset price to min (recovery action)
  const resetToMinPrice = async (item: InventoryWithAssignment) => {
    const minPrice = item.min_price_override ?? item.inv_min_price;
    if (!minPrice) {
      toast.error("No min price set for this item");
      return;
    }

    setResettingPrice(prev => new Set(prev).add(item.id));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const marketplaceConfig = getMarketplaceConfig(marketplace);

      const resetMinResult = await invokeEdgeFunction({
        functionName: "update-amazon-price",
        body: {
          sku: item.sku,
          asin: item.asin,
          newPrice: minPrice,
          newMinPrice: minPrice,
          newMaxPrice: item.max_price_override ?? item.inv_max_price,
          marketplace: marketplace || "US",
          reason: "Manual reset to min price (recovery)",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
        context: { asin: item.asin, sku: item.sku },
      });

      if (!resetMinResult.ok) throw new Error(resetMinResult.errorMessage || "Reset failed");
      const data = resetMinResult.data;

      if (data?.success) {
        toast.success(`Price reset to min: ${marketplaceConfig.currencySymbol}${minPrice.toFixed(2)}`);
        // Update local state
        setItems(prev =>
          prev.map(i => (i.id === item.id ? { ...i, my_price: minPrice, price: minPrice } : i))
        );
      } else {
        throw new Error(data?.message || data?.error || "Reset failed");
      }
    } catch (error: any) {
      toast.error("Reset failed: " + error.message);
    } finally {
      setResettingPrice(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Sync min/max bounds from Amazon (one-click fix for min/max mismatch)
  const syncBoundsFromAmazon = async (item: InventoryWithAssignment) => {
    setSyncingBounds(prev => new Set(prev).add(item.id));

    try {
      // CRITICAL: Use ensureAssignment for marketplace-correct assignment
      const correctAssignmentId = await ensureAssignment(item);
      if (!correctAssignmentId) {
        toast.error("No assignment found for this item");
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data, error } = await supabase.functions.invoke("sync-amazon-bounds", {
        body: {
          assignmentId: correctAssignmentId,
          sku: item.sku,
          marketplace: marketplace || "US",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) throw error;

      if (data?.success) {
        toast.success(`Bounds synced: Min $${data.amazonMinPrice?.toFixed(2) ?? '—'}, Max $${data.amazonMaxPrice?.toFixed(2) ?? '—'}`);
        // Update local state with synced bounds
        setItems(prev =>
          prev.map(i => (i.id === item.id ? { 
            ...i, 
            min_price_override: data.amazonMinPrice,
            max_price_override: data.amazonMaxPrice,
            amazon_min_price: data.amazonMinPrice,
            amazon_max_price: data.amazonMaxPrice,
            amazon_bounds_synced_at: data.syncedAt,
            my_price: data.currentPrice ?? i.my_price,
            status: 'active' as const,
            last_error_type: null,
            last_error_message: null,
            consecutive_failures: 0,
          } : i))
        );
      } else {
        throw new Error(data?.error || "Sync failed");
      }
    } catch (error: any) {
      toast.error("Sync failed: " + error.message);
    } finally {
      setSyncingBounds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Resume a paused assignment
  const resumeAssignment = async (item: InventoryWithAssignment) => {
    setResumingItem(prev => new Set(prev).add(item.id));

    try {
      // CRITICAL: Use ensureAssignment to get marketplace-correct assignment
      const correctAssignmentId = await ensureAssignment(item);
      if (!correctAssignmentId) {
        toast.error("No assignment found for this item");
        return;
      }

      // Update assignment status to active
      const { error } = await supabase
        .from("repricer_assignments")
        .update({
          status: 'active',
          consecutive_failures: 0,
          last_error_type: null,
          last_error_message: null,
          paused_at: null,
          pause_reason: null,
        })
        .eq("id", correctAssignmentId);

      if (error) throw error;

      toast.success("Assignment resumed");
      // Update local state
      setItems(prev =>
        prev.map(i => (i.id === item.id ? { 
          ...i, 
          status: 'active' as const,
          consecutive_failures: 0,
          last_error_type: null,
          last_error_message: null,
          paused_at: null,
          pause_reason: null,
        } : i))
      );
    } catch (error: any) {
      toast.error("Resume failed: " + error.message);
    } finally {
      setResumingItem(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Priority star toggle — scales with plan tier (see subscription_plans.priority_star_cap).
  // Cadence is governed by repricer-unified-dispatch's per-ASIN hourly eval cap, not a
  // separate cron: starred items are bucketed as HOT (6-8 evals/hr vs 3/hr) and score +100,
  // so they're checked ~2x more often and land at the front of the HOT queue — there's no
  // "every ~1 minute" guarantee (repricer-priority-cron, which promised that, was dead code
  // with no live pg_cron schedule and has been removed).
  const MAX_PRIORITY = effectivePlan?.priority_star_cap ?? 5;
  const [priorityCount, setPriorityCount] = useState(0);

  // Fetch true priority count from DB (not just visible rows).
  // is_enabled=true alone isn't enough -- a starred assignment can stay
  // is_enabled=true even after its listing goes to zero stock / inactive on
  // Amazon, silently occupying a star slot forever. Cross-check real stock
  // the same way repricer-auto-turbo does for its own rotation pool.
  useEffect(() => {
    const fetchPriorityCount = async () => {
      if (!user?.id) return;
      const { data: rows } = await supabase
        .from('repricer_assignments')
        .select('sku')
        .eq('user_id', user.id)
        .eq('is_priority', true)
        .eq('is_enabled', true);
      const skus = [...new Set((rows || []).map(r => r.sku).filter(Boolean))];
      if (skus.length === 0) { setPriorityCount(0); return; }
      const { data: stockItems } = await supabase
        .from('inventory')
        .select('sku, available')
        .eq('user_id', user.id)
        .in('sku', skus);
      const inStock = new Set((stockItems || []).filter(i => (i.available ?? 0) > 0).map(i => i.sku));
      setPriorityCount((rows || []).filter(r => r.sku && inStock.has(r.sku)).length);
    };
    fetchPriorityCount();
  }, [user?.id, items]);

  const togglePriority = async (item: InventoryWithAssignment) => {
    const newValue = !item.is_priority;
    
    // Enforce cap
    if (newValue && priorityCount >= MAX_PRIORITY) {
      toast.error(`Priority limit reached (${MAX_PRIORITY}). Unstar another ASIN first.`);
      return;
    }

    try {
      const assignmentId = item.assignment_id || await ensureAssignment(item);
      if (!assignmentId) return;

      // First update DB, then verify it stuck
      const { error, data: updatedRows } = await supabase
        .from("repricer_assignments")
        .update({ 
          is_priority: newValue,
          is_manual_priority: newValue,
        })
        .eq("id", assignmentId)
        .select("id, is_priority, is_manual_priority");

      if (error) throw error;
      
      console.log(`[togglePriority] Updated assignment ${assignmentId}: is_priority=${newValue}, is_manual_priority=${newValue}`, updatedRows);

      setItems(prev =>
        prev.map(i => (i.id === item.id ? { ...i, is_priority: newValue, is_manual_priority: newValue, assignment_id: assignmentId } : i))
      );
      toast.success(newValue ? "⭐ Manually added to priority queue (protected from auto-rotation)" : "Removed from priority queue");
    } catch (error: any) {
      toast.error("Failed to update priority: " + error.message);
    }
  };


  const getErrorBadge = (item: InventoryWithAssignment) => {
    const s = deriveAssignmentStatus({
      is_enabled: item.is_enabled,
      rule_id: item.rule_id,
      manual_paused: item.manual_paused,
      last_disabled_by: item.last_disabled_by,
      last_disabled_reason: item.last_disabled_reason,
      last_disabled_at: item.last_disabled_at,
      has_matching_inventory: item.has_matching_inventory,
      inventory_terminal:
        ((item.available ?? 0) + (item.reserved ?? 0) + (item.inbound ?? 0) <= 0) &&
        (item.listing_status || "").toUpperCase() !== "ACTIVE",
      // Phase 1: pass new fact fields when present on the row
      amazon_listing_state: (item as any).amazon_listing_state ?? null,
      // Amazon-blocked listing. Detected server-side since 2026-08 but never
      // rendered until now, so a blocked ASIN displayed as Active.
      is_listing_inactive_not_buyable: (item as any).is_listing_inactive_not_buyable ?? null,
      listing_inactive_reason_code: (item as any).listing_inactive_reason_code ?? null,
      listing_inactive_reason_message: (item as any).listing_inactive_reason_message ?? null,
      available: item.available,
      reserved: item.reserved,
      inbound: item.inbound,
      inventory_confidence: (item as any).inventory_confidence ?? null,
      intl_qty_confidence: (item as any).intl_qty_confidence ?? null,
      marketplace_sellable: (item as any).marketplace_sellable ?? null,
      auto_suspended_reason: (item as any).auto_suspended_reason ?? null,
      status_legacy: item.status,
      last_error_type: item.last_error_type,
      consecutive_failures: item.consecutive_failures,
    });

    if (s.kind === "active") {
      if (item.consecutive_failures > 0 && item.consecutive_failures < 5) {
        return (
          <Badge variant="secondary" className="text-[10px] h-5" title={`${item.consecutive_failures} recent failure${item.consecutive_failures > 1 ? "s" : ""}`}>
            {item.consecutive_failures} fail{item.consecutive_failures > 1 ? "s" : ""}
          </Badge>
        );
      }
      return null;
    }
    // Only show a status badge for true manual pauses. Everything else (auto-disabled,
    // needs review, pending verification, etc.) is suppressed per user request — the
    // toggle state itself communicates enabled/disabled.
    if (s.kind !== "manually_paused") return null;
    return (
      <Badge variant="outline" className="text-[10px] h-5 flex items-center gap-1 border-destructive text-destructive bg-destructive/10" title={s.tooltip}>
        <PauseCircle className="h-3 w-3" />
        {s.label}
      </Badge>
    );
  };


  return (
    <>
    <Card className="bg-[hsl(220,65%,18%)] text-white border-white/10">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-nowrap overflow-x-auto">
          <CardTitle className="text-lg flex items-center gap-2 shrink-0">
            <Package className="h-5 w-5" />
            Repricer{isAdmin ? ` (${chipCounts.ALL} Managed ASINs)` : ''}
          </CardTitle>

          {/* Auto-lower-min coverage. Opt-in per seller (the column defaults to
              false) and shows the automated/workable ratio, because coverage
              decays silently as new listings are added — nothing sets the flag
              on them. */}
          <AutoLowerMinToggle
            userId={user?.id}
            marketplace={marketplace}
            onChanged={() => void fetchData()}
          />

          {visibleMarketplaces.length >= 1 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card/50 backdrop-blur-sm p-1.5 shadow-sm">
              {visibleMarketplaces.map((mp) => {
                const isActive = marketplace === mp.id;
                const isPrimary = mp.id === homeMarketplace;
                return (
                  <button
                    key={mp.id}
                    onClick={() => onMarketplaceChange?.(mp.id)}
                    title={isPrimary ? "Your primary marketplace" : undefined}
                    className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-all duration-200 cursor-pointer whitespace-nowrap ${
                      isActive
                        ? "bg-primary text-primary-foreground border-primary shadow-md scale-[1.02]"
                        : "bg-muted/50 text-muted-foreground border-transparent hover:bg-muted hover:border-border hover:scale-[1.02]"
                    } ${isPrimary ? "ring-2 ring-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]" : ""}`}
                  >
                    {isActive && <Check className="h-3 w-3" />}
                    <span>{mp.flag}</span>
                    <span>{mp.id}</span>
                    {isPrimary && <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400 absolute -top-1.5 -right-1.5" />}
                  </button>
                );
              })}
              {/* Onboarding hint: shown when the user hasn't authorized the full NA set.
                  Prevents "the feature is broken" tickets from users who simply haven't
                  OAuth-connected CA/MX/BR under Amazon Connection yet. */}
              {!isAdmin && visibleMarketplaces.length < 4 && (
                <a
                  href="/tools/amazon-connection"
                  className="ml-1 flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors whitespace-nowrap"
                  title="Connect Amazon Canada, Mexico, or Brazil to enable Remote Fulfillment here"
                >
                  <span>+</span>
                  <span>Add marketplace</span>
                </a>
              )}
            </div>
          )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
           {/* Alerts Filter — admin only — grouped by intent */}
           {isAdmin && (() => {
             const allChip = { value: "ALL", label: "All", color: "bg-muted text-muted-foreground border-transparent", activeColor: "bg-primary text-primary-foreground shadow-md", icon: null as React.ReactNode };
              const operationalIssues = [
                { value: "blocked_by_min", label: "All Blocked", color: "bg-red-950/60 text-red-300 border-destructive/30", activeColor: "bg-destructive text-white shadow-md shadow-destructive/25", icon: <span className="h-2 w-2 rounded-full bg-current" /> },
                { value: "bb_suppressed", label: "BB Suppressed", color: "bg-blue-950/60 text-blue-300 border-blue-500/30", activeColor: "bg-blue-500 text-white shadow-md shadow-blue-500/25", icon: <span className="h-2 w-2 rounded-full bg-current" /> },
              ] as const;
              const automationStates = [
                { value: "NONE", label: "Healthy", color: "bg-emerald-950/60 text-emerald-300 border-emerald-500/30", activeColor: "bg-emerald-500 text-white shadow-md shadow-emerald-500/25", icon: <span className="h-2 w-2 rounded-full bg-current" /> },
              ] as const;
              const analytics = [
                { value: "no_sales_30d", label: "🟠 No Sales 30d", color: "bg-orange-950/60 text-orange-300 border-orange-500/30", activeColor: "bg-orange-500 text-white shadow-md shadow-orange-500/25", icon: <span className="h-2 w-2 rounded-full bg-current" /> },
              ] as const;
              const advanced = [
                { value: "HAS_ANY", label: "Has Alert", color: "bg-amber-950/60 text-amber-300 border-amber-500/30", activeColor: "bg-amber-500 text-white shadow-md shadow-amber-500/25", icon: <AlertTriangle className="h-3 w-3" /> },
                { value: "blocked_needs_you", label: "0 Sales (7d)", color: "bg-slate-900/70 text-slate-300 border-slate-600/40", activeColor: "bg-foreground text-background shadow-md", icon: <span className="h-2 w-2 rounded-full bg-current" /> },
              ] as const;

             const renderChip = (opt: { value: string; label: string; color: string; activeColor: string; icon: React.ReactNode }) => {
               const count = (chipCounts as any)[opt.value] ?? 0;
               const isActive = suggestionFilter === opt.value;
               const isPriority = opt.value === "bb_suppressed";
               const dim = !isActive && count === 0;
               return (
                 <button
                   key={opt.value}
                   onClick={() => setSuggestionFilter(opt.value as any)}
                   disabled={count === 0 && opt.value !== "ALL"}
                   className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-all duration-200 whitespace-nowrap ${
                     isActive
                       ? opt.activeColor + " border-transparent scale-[1.02]"
                       : opt.color + (dim ? " opacity-40 cursor-not-allowed" : " cursor-pointer hover:scale-[1.02] hover:shadow-sm")
                   } ${isPriority && count > 0 && !isActive ? "ring-1 ring-current/30" : ""}`}
                 >
                   {isActive && <Check className="h-3 w-3 shrink-0" />}
                   {!isActive && opt.icon}
                   {opt.label}
                 </button>
               );
             };

             const renderGroup = (label: string, chips: readonly { value: string; label: string; color: string; activeColor: string; icon: React.ReactNode }[]) => (
               <div className="flex items-center gap-1.5">
                 {label && <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mr-1">{label}</span>}
                 {chips.map(renderChip)}
               </div>
             );

             return (
               <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/50 backdrop-blur-sm p-2 shadow-sm">
                 {renderChip(allChip)}
                 <div className="h-6 w-px bg-border/60" />
                 {renderGroup("", operationalIssues)}
                 <div className="h-6 w-px bg-border/60" />
                 {renderGroup("", automationStates)}
                 <div className="h-6 w-px bg-border/60" />
                 {renderGroup("", analytics)}
                 <div className="h-6 w-px bg-border/60" />
                 {renderGroup("", advanced)}
               </div>
             );
           })()}

          {isAdmin && (<>
          {/* Fulfillment Filter */}
          <Select
            value={fulfillmentFilter}
            onValueChange={(v: "ALL" | "FBA" | "FBM") => setFulfillmentFilter(v)}
          >
            <SelectTrigger className="w-[100px] h-8">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent className="bg-popover border border-border z-50">
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="FBA">
                <span className="flex items-center gap-2">
                  <Truck className="h-3 w-3 text-orange-600" />
                  FBA
                </span>
              </SelectItem>
              <SelectItem value="FBM">
                <span className="flex items-center gap-2">
                  <Store className="h-3 w-3 text-blue-600" />
                  FBM
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Stock Status Filter — locked to "All Active Repricer Assignments".
              The Available / Reserved+Inbound / Out of Stock sub-filters and the
              old in-dropdown Manual option were confusing tucked into a dropdown
              most users never touched; Manual now has its own dedicated toggle
              button below instead. */}
          <div className="w-[230px] h-9 flex items-center px-3 rounded-md border border-input bg-background text-sm text-muted-foreground">
            All Active Repricer Assignments
          </div>

          {false && (<>
          {/* Price filter */}
          <Select
            value={priceFilter}
            onValueChange={(v: "ALL" | "HAS_PRICE" | "NO_PRICE") => setPriceFilter(v)}
          >
            <SelectTrigger className="w-[120px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Prices</SelectItem>
              <SelectItem value="HAS_PRICE">Has Price</SelectItem>
              <SelectItem value="NO_PRICE">No Price</SelectItem>
            </SelectContent>
          </Select>
          
          </>)}

          {false && (<>

          {/* Offer count filter */}
          <Select
            value={offerFilter}
            onValueChange={(v: "ALL" | "HAS_OFFERS" | "NO_OFFERS") => setOfferFilter(v)}
          >
            <SelectTrigger className="w-[130px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Offers</SelectItem>
              <SelectItem value="HAS_OFFERS">
                <span className="flex items-center gap-2">
                  <Users className="h-3 w-3 text-green-600" />
                  Has Offers
                </span>
              </SelectItem>
              <SelectItem value="NO_OFFERS">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-3 w-3 text-red-600" />
                  No Offers
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Restricted Filter */}
          <Select
            value={restrictedFilter}
            onValueChange={(v: "HIDE" | "SHOW" | "ONLY") => setRestrictedFilter(v)}
          >
            <SelectTrigger className="w-[140px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-popover border border-border z-50">
              <SelectItem value="HIDE">
                <span className="flex items-center gap-2">
                  <Ban className="h-3 w-3 text-muted-foreground" />
                  Hide Restricted
                </span>
              </SelectItem>
              <SelectItem value="SHOW">
                <span className="flex items-center gap-2">
                  <Globe className="h-3 w-3 text-muted-foreground" />
                  Show All
                </span>
              </SelectItem>
              <SelectItem value="ONLY">
                <span className="flex items-center gap-2">
                  <Ban className="h-3 w-3 text-red-600" />
                  Restricted Only
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          </>)}

          {false && (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              placeholder="Min ROI%"
              value={roiMin}
              onChange={(e) => setRoiMin(e.target.value)}
              className="w-[90px] h-8 text-xs"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="number"
              placeholder="Max ROI%"
              value={roiMax}
              onChange={(e) => setRoiMax(e.target.value)}
              className="w-[90px] h-8 text-xs"
            />
          </div>
          )}
          </>)}
          </div>
        </div>
        {false && isAdmin && hasActiveFilters && (
          <div className="flex items-center gap-1">
            <Button
              variant={showHiddenOnly ? "default" : "ghost"}
              size="sm"
              onClick={() => setShowHiddenOnly(prev => !prev)}
              className={`text-xs h-8 ${showHiddenOnly ? "" : "text-muted-foreground hover:text-foreground"}`}
            >
              {showHiddenOnly ? (
                <>
                  <Ban className="h-3 w-3 mr-1" />
                  Showing {sortedItems.length} Filtered
                </>
              ) : (
                <>
                  <Ban className="h-3 w-3 mr-1" />
                  {hiddenByFilters} Merged
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { resetAllFilters(); setShowHiddenOnly(false); }}
              className="text-xs text-muted-foreground hover:text-foreground h-8 px-2"
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap">
          {isAdmin && (
          <>
          {/* Suggestion Decisions hidden — Auto Floor permanently disabled */}
          {/* Force Re-evaluate All hidden — automated dispatch (unified-dispatch/priority-cron) confirmed healthy, manual full-catalog re-evaluation no longer needed */}
          {/* Run Now hidden — same automated dispatch already covers this; unbounded manual trigger was a pre-automation safety net */}
          {false && selectedIds.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={runSelectedScheduler}
              disabled={runningSelected}
            >
              {runningSelected ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
              Run Selected ({selectedIds.size})
            </Button>
          )}
          {false && selectedIds.size > 0 && marketplace === "US" && (
            <Button
              variant="outline"
              size="sm"
              onClick={syncSelectedInternational}
              disabled={syncingIntl}
              title="Sync selected ASINs to CA, MX, BR marketplaces"
            >
              {syncingIntl ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Globe className="h-4 w-4 mr-2" />}
              Sync Intl ({selectedIds.size})
            </Button>
          )}
          {/* Run All hidden — handler (saveAllRepricing) was a non-functional stub that only showed a fake success toast, never actually did anything */}
          </>
          )}
          
          {marketplace !== "US" && isAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={openVerificationReport}
                title={`Show ${marketplace} verification report (counts + recently removed)`}
              >
                {marketplace} Report
              </Button>
            </>
          )}
          <Dialog open={reportOpen} onOpenChange={setReportOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{marketplace} Verification Report</DialogTitle>
                <DialogDescription>
                  Status of {marketplace} assignment rows from the last verification sweep.
                </DialogDescription>
              </DialogHeader>
              {reportLoading || !reportData ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <RefreshCw className="h-4 w-4 animate-spin inline-block mr-2" />
                  Loading…
                </div>
              ) : (
                <div className="space-y-4 text-sm">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Total rows</div>
                      <div className="text-lg font-semibold">{reportData.total}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Confirmed BUYABLE</div>
                      <div className="text-lg font-semibold text-green-600">{reportData.buyable}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Not found / removed</div>
                      <div className="text-lg font-semibold text-red-600">{reportData.notFound}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Status unknown</div>
                      <div className="text-lg font-semibold text-amber-600">{reportData.unknown}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Other status</div>
                      <div className="text-lg font-semibold">{reportData.other}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Never checked</div>
                      <div className="text-lg font-semibold">{reportData.neverChecked}</div>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Last verification: {reportData.lastChecked ? new Date(reportData.lastChecked).toLocaleString() : "never"}
                  </div>
                  <div>
                    <div className="text-xs font-medium mb-2">Last 20 removed ASINs</div>
                    {reportData.recentRemoved.length === 0 ? (
                      <div className="text-xs text-muted-foreground">None.</div>
                    ) : (
                      <div className="max-h-64 overflow-auto rounded-md border">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/50">
                            <tr>
                              <th className="text-left p-2">ASIN</th>
                              <th className="text-left p-2">SKU</th>
                              <th className="text-left p-2">Reason</th>
                              <th className="text-left p-2">When</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportData.recentRemoved.map((r, i) => (
                              <tr key={i} className="border-t">
                                <td className="p-2 font-mono">{r.asin}</td>
                                <td className="p-2 font-mono truncate max-w-[140px]">{r.sku}</td>
                                <td className="p-2 truncate max-w-[200px]" title={r.reason || ""}>{r.reason || "—"}</td>
                                <td className="p-2 whitespace-nowrap">{r.at ? new Date(r.at).toLocaleString() : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={loadVerificationReport} disabled={reportLoading}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${reportLoading ? "animate-spin" : ""}`} /> Refresh
                </Button>
                <Button size="sm" onClick={() => setReportOpen(false)}>Close</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {isAdmin && (
            <Button variant="outline" size="sm" onClick={fetchData} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {/* Priority Queue Status — admin only */}
        {isAdmin && priorityCount > 0 && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 text-sm">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
            <span className="font-medium">Priority Queue:</span>
            <span className="text-muted-foreground">
              Starred: {priorityCount}/{MAX_PRIORITY} · Checked more often, ahead of the queue
            </span>
          </div>
        )}

        {/* Search and Bulk Actions */}
        <div className="flex flex-wrap gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-[500px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search ASIN, SKU, Title..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onPaste={e => {
                e.preventDefault();
                const pasted = e.clipboardData.getData('text').trim();
                setSearchTerm(pasted);
              }}
              className="pl-10"
            />
          </div>
          {marketplace === "US" && (
            <Button
              variant={showZeroAvailable ? "default" : "outline"}
              size="sm"
              onClick={() => setShowZeroAvailable(prev => !prev)}
              className="text-xs h-9"
              title={showZeroAvailable ? "Hide items with 0 available again" : "Show items with reserved/inbound stock but 0 available right now"}
            >
              {showZeroAvailable
                ? "Collapse"
                : `Expand${hiddenZeroAvailableCount > 0 ? ` (${hiddenZeroAvailableCount})` : ""}`}
            </Button>
          )}
          {isAdmin && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={stockFilter === "MANUAL_STAR" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setStockFilter(prev => prev === "MANUAL_STAR" ? "ALL" : "MANUAL_STAR")}
                    className="text-xs h-9 gap-1.5"
                  >
                    <Star className={`h-3.5 w-3.5 ${stockFilter === "MANUAL_STAR" ? "fill-current" : "fill-orange-400 text-orange-400"}`} />
                    Priority
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px]">
                  <p className="font-medium mb-1">
                    {stockFilter === "MANUAL_STAR" ? "Showing only starred ASINs" : "Filter to your starred ASINs"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Starring (⭐) an ASIN manually pins it to the Priority Queue — up to {MAX_PRIORITY} at a time. Starred ASINs are checked more often than the normal rotation and go to the front of the queue, and stay protected from the repricer's automatic rotation.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Select value={ruleFilter} onValueChange={setRuleFilter}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="All Rules" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Rules</SelectItem>
              {rules.map(r => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedIds.size > 0 && (
            <div className="flex gap-2 items-center">
              <span className="text-sm text-muted-foreground">
                {selectedIds.size} selected
              </span>
              <Select value={bulkRuleId} onValueChange={setBulkRuleId}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Assign rule..." />
                </SelectTrigger>
                <SelectContent>
                  {rules.map(r => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" type="button" disabled={!bulkRuleId || bulkApplying} onClick={bulkAssignRule} className="gap-1.5 min-w-[90px]">
                {bulkApplying ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying...</>
                ) : (
                  "Apply"
                )}
              </Button>
              {false && <Button size="sm" variant="outline" onClick={async () => {
                const selected = items.filter(i => selectedIds.has(i.id) && i.assignment_id);
                if (selected.length === 0) { toast.error("No assignments selected"); return; }
                const ids = selected.map(i => i.assignment_id!);
                const { error } = await (supabase as any).from("repricer_assignments").update({ is_restricted: true }).in("id", ids);
                if (error) { toast.error("Failed to mark restricted"); return; }
                setItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, is_restricted: true } : i));
                toast.success(`${selected.length} items marked as restricted in ${marketplace}`);
                setSelectedIds(new Set());
              }} className="text-xs gap-1 border-red-400 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30">
                <Ban className="h-3 w-3" />
                Mark Restricted (Manual)
              </Button>}
              {false && <Button size="sm" variant="outline" onClick={async () => {
                const selected = items.filter(i => selectedIds.has(i.id) && i.assignment_id && i.is_restricted);
                if (selected.length === 0) { toast.error("No restricted assignments selected"); return; }
                const ids = selected.map(i => i.assignment_id!);
                const { error } = await (supabase as any).from("repricer_assignments").update({ is_restricted: false }).in("id", ids);
                if (error) { toast.error("Failed to unrestrict"); return; }
                setItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, is_restricted: false } : i));
                toast.success(`${selected.length} items unrestricted in ${marketplace}`);
                setSelectedIds(new Set());
              }} className="text-xs gap-1">
                <Globe className="h-3 w-3" />
                Unrestrict
              </Button>}
              {/* Bulk Eval Mode (admin only) */}
              {false && isAdmin && (
              <>
              <Button size="sm" variant="outline" onClick={async () => {
                const selected = items.filter(i => selectedIds.has(i.id) && i.assignment_id);
                if (selected.length === 0) { toast.error("No assignments selected"); return; }
                const ids = selected.map(i => i.assignment_id!);
                const { error } = await (supabase as any).from("repricer_assignments").update({ eval_mode: 'force_smart', active_eval_mode: 'smart', eval_mode_reason: 'bulk_force_smart', eval_mode_switched_at: new Date().toISOString() }).in("id", ids);
                if (error) { toast.error("Failed to update"); return; }
                setItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, eval_mode: 'force_smart' as EvalMode, active_eval_mode: 'smart' as ActiveEvalMode } : i));
                toast.success(`${selected.length} items set to Force Smart`);
                setSelectedIds(new Set());
              }} className="text-xs gap-1 border-violet-400 text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/30">
                <Brain className="h-3 w-3" />
                Force Smart
              </Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const selected = items.filter(i => selectedIds.has(i.id) && i.assignment_id);
                if (selected.length === 0) { toast.error("No assignments selected"); return; }
                const ids = selected.map(i => i.assignment_id!);
                const { error } = await (supabase as any).from("repricer_assignments").update({ eval_mode: 'force_basic', active_eval_mode: 'basic', eval_mode_reason: 'bulk_force_basic', eval_mode_switched_at: new Date().toISOString() }).in("id", ids);
                if (error) { toast.error("Failed to update"); return; }
                setItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, eval_mode: 'force_basic' as EvalMode, active_eval_mode: 'basic' as ActiveEvalMode } : i));
                toast.success(`${selected.length} items set to Force Basic`);
                setSelectedIds(new Set());
              }} className="text-xs gap-1 border-amber-400 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30">
                <Zap className="h-3 w-3" />
                Force Basic
              </Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const selected = items.filter(i => selectedIds.has(i.id) && i.assignment_id);
                if (selected.length === 0) { toast.error("No assignments selected"); return; }
                const ids = selected.map(i => i.assignment_id!);
                const { error } = await (supabase as any).from("repricer_assignments").update({ eval_mode: 'auto', eval_mode_reason: 'bulk_reset_auto', eval_mode_switched_at: new Date().toISOString() }).in("id", ids);
                if (error) { toast.error("Failed to update"); return; }
                setItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, eval_mode: 'auto' as EvalMode } : i));
                toast.success(`${selected.length} items set to Auto mode`);
                setSelectedIds(new Set());
              }} className="text-xs gap-1">
                <Settings2 className="h-3 w-3" />
                Auto Mode
              </Button>
              </>
              )}
            </div>
          )}
        </div>

        {/* ── Alert Filter Intervention Banner ── */}
        {suggestionFilter !== "ALL" && (
          <div className={`rounded-lg border px-4 py-3 mb-3 ${
                (suggestionFilter === "blocked_by_min" || suggestionFilter === "blocked_needs_you") ? "bg-destructive/5 border-destructive/30" :
                suggestionFilter === "no_sales_30d" ? "bg-orange-500/5 border-orange-500/30" :
            suggestionFilter === "blocked_review_soon" ? "bg-amber-500/5 border-amber-500/30" :
            suggestionFilter === "blocked_auto" ? "bg-muted/30 border-border" :
            suggestionFilter === "bb_suppressed" ? "bg-blue-500/5 border-blue-500/30" :
            suggestionFilter === "profit_guard_block" ? "bg-amber-500/5 border-amber-500/30" :
            suggestionFilter === "HAS_ANY" ? "bg-amber-500/5 border-amber-500/30" :
            "bg-emerald-500/5 border-emerald-500/30"
          }`}>
            <div className="flex items-start gap-3">
              <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${
                (suggestionFilter === "blocked_by_min" || suggestionFilter === "blocked_needs_you") ? "text-destructive" :
                suggestionFilter === "no_sales_30d" ? "text-orange-500" :
                suggestionFilter === "blocked_review_soon" ? "text-amber-500" :
                suggestionFilter === "blocked_auto" ? "text-muted-foreground" :
                suggestionFilter === "bb_suppressed" ? "text-blue-500" :
                suggestionFilter === "profit_guard_block" ? "text-amber-500" :
                suggestionFilter === "HAS_ANY" ? "text-amber-500" :
                "text-emerald-500"
              }`} />
              <div className="flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {suggestionFilter === "blocked_needs_you" && (salesFilterPending ? "Checking sales from the last 7 days..." : `${sortedItems.length} items with 0 sales in the last 7 days (raw metric)`)}
                  {suggestionFilter === "no_sales_30d" && (salesFilterPending ? "Checking sales from the last 30 days..." : `${sortedItems.length} items with zero sales in the last 30 days`)}
                  {suggestionFilter === "blocked_review_soon" && `${sortedItems.length} items blocked but still selling or no competitive pressure`}
                  {suggestionFilter === "blocked_auto" && `${sortedItems.length} items blocked — auto-floor is handling it`}
                  {suggestionFilter === "blocked_by_min" && `${sortedItems.length} items blocked by min price`}
                  {suggestionFilter === "bb_suppressed" && `${sortedItems.length} items with Buy Box suppressed`}
                  {suggestionFilter === "profit_guard_block" && `${sortedItems.length} items blocked by profit protection`}
                  {suggestionFilter === "HAS_ANY" && `${sortedItems.length} items need attention`}
                  {suggestionFilter === "NONE" && `${sortedItems.length} items running smoothly — no alerts`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {suggestionFilter === "blocked_needs_you" && (salesFilterPending ? "Waiting for live sales history so rows do not flash in and out." : "Raw analytics filter: any listing with 0 sales in the last 7 days. Includes seasonal, slow movers, and high-ticket items — not necessarily a problem. Use Review Soon for actionable issues.")}
                  {suggestionFilter === "no_sales_30d" && (salesFilterPending ? "Waiting for live sales history so rows do not flash in and out." : "These listings had no sales at all in the past 30 days. Consider lowering prices, adjusting your strategy, or removing them.")}
                  {suggestionFilter === "blocked_review_soon" && "Blocked by min/ROI but either still selling or no clear competitive pressure. Monitor these — they may need attention later."}
                  {suggestionFilter === "blocked_auto" && "Auto-floor is active or waiting. The system will lower the min automatically — no action needed from you right now."}
                  {suggestionFilter === "blocked_by_min" && "Auto-lowering stops after 5 drops, 30% total drop, or when no competitor data is available. Select items below to manually intervene."}
                  {suggestionFilter === "bb_suppressed" && "No active Buy Box on these listings. The system competes on lowest price. Consider lowering your min or adjusting your rule."}
                  {suggestionFilter === "profit_guard_block" && "Your profit rules are preventing price drops. The system is protecting your margins."}
                  {suggestionFilter === "HAS_ANY" && "These items have alerts that may need your review. Select items and use bulk actions to resolve."}
                  {suggestionFilter === "NONE" && "These items are repricing normally with no issues detected."}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Pagination Controls - Top */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {isAdmin && (
              <span className="text-sm text-muted-foreground">
                Showing {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, sortedItems.length)} of {sortedItems.length}
              </span>
            )}
            <Select value={pageSize.toString()} onValueChange={(val) => setPageSize(parseInt(val) as 50 | 250)}>
              <SelectTrigger className="w-[100px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50 / page</SelectItem>
                <SelectItem value="250">250 / page</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          {totalPages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="h-8 px-2"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                </PaginationItem>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <PaginationItem key={pageNum}>
                      <PaginationLink
                        onClick={() => setCurrentPage(pageNum)}
                        isActive={currentPage === pageNum}
                        className="cursor-pointer"
                      >
                        {pageNum}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="h-8 px-2"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>

        {/* Table */}
        <div className="relative">
        {loading || salesFilterPending || (isRefreshing && items.length === 0) || (isRefreshing && ruleFilter !== "ALL") ? (
          <div className="text-center py-8 text-muted-foreground">
            {salesFilterPending ? "Loading sales data..." : isRefreshing && ruleFilter !== "ALL" ? "Refreshing data…" : "Loading inventory..."}
          </div>
        ) : sortedItems.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {searchTerm || hasActiveFilters ? "No listings match the current filters." : "No inventory items found. Sync your inventory first."}
          </div>
        ) : (
          <div className="border border-white/10 rounded-lg bg-shipment-surface">
            {/* Top horizontal scrollbar */}
            <div
              ref={topScrollRef}
              onScroll={handleTopScroll}
              className="overflow-x-auto border-b border-white/10 bg-shipment-elevated"
              // Make the scrollbar easier to grab + keep gutter visible on overlay-scrollbar OSes
              style={{ overflowY: "hidden", height: "18px", scrollbarGutter: "stable" } as React.CSSProperties}
            >
              <div style={{ width: tableWidth > 0 ? tableWidth : "100%", height: 1 }} />
            </div>
            
            {/* Table container */}
             <div className="rounded-lg overflow-hidden">
              <Table
                containerRef={tableScrollRef}
                containerClassName="overflow-x-auto bg-shipment-row rounded-lg"
              >
                  <TableHeader className="sticky top-0 z-20 border-b border-white/10 bg-shipment-elevated">
                    <TableRow className="text-xs text-white hover:bg-shipment-elevated [&_th]:text-white [&_th]:font-semibold">
                      <TableHead className="w-10 sticky left-0 bg-shipment-elevated z-10 text-white">
                        <Checkbox
                          checked={selectedIds.size === paginatedItems.length && paginatedItems.length > 0}
                          onCheckedChange={selectAll}
                        />
                      </TableHead>
                      {isAdmin && (
                      <TableHead className="w-8 px-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help flex items-center justify-center">
                                <Star className="h-3.5 w-3.5" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Priority Queue — starred ASINs are checked more often and ahead of the queue (max {MAX_PRIORITY})</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableHead>
                      )}
                      {isAdmin && (
                      <TableHead className="text-center min-w-[40px] px-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">Actions</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>View log, reset price, and recovery actions</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableHead>
                      )}
                      <TableHead className="w-8 text-center">Save</TableHead>
                      <TableHead className="w-14 px-1 text-center">Img</TableHead>
                      <TableHead className="min-w-[180px] text-center">
                        <button className="flex items-center justify-center w-full hover:text-foreground" onClick={() => toggleSort("title")}>
                          Title / ASIN<SortIcon column="title" />
                        </button>
                      </TableHead>
                      <TableHead className="min-w-[80px] text-center">
                        <button className="flex items-center justify-center w-full hover:text-foreground" onClick={() => toggleSort("sku")}>
                          SKU<SortIcon column="sku" />
                        </button>
                      </TableHead>
                      <TableHead className="text-center min-w-[35px] px-1">
                        <button className="flex items-center justify-center hover:text-foreground" onClick={() => toggleSort("available")}>
                          Qty<SortIcon column="available" />
                        </button>
                      </TableHead>
                      <TableHead className="text-center min-w-[50px] px-1">
                        <button className="flex items-center justify-center hover:text-foreground mx-auto" onClick={() => toggleSort("cost")}>
                          Cost<SortIcon column="cost" />
                        </button>
                      </TableHead>
                      <TableHead className="text-center min-w-[55px] px-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button className="flex items-center justify-center hover:text-foreground mx-auto cursor-help" onClick={() => toggleSort("min_price")}>
                                Min<SortIcon column="min_price" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Minimum price. ROI shown below after calculation.</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableHead>
                      {/* Min ROI% column header removed — duplicate of ROI at Min under Min Price */}
                      <TableHead className="text-center min-w-[55px] px-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">Max</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Maximum price. ROI shown below after calculation.</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableHead>
                      <TableHead className="text-center min-w-[70px] px-1">
                        <button className="flex items-center justify-center hover:text-foreground mx-auto" onClick={() => toggleSort("price")}>
                          Price<SortIcon column="price" />
                        </button>
                      </TableHead>
                      <TableHead className="text-center min-w-[60px] px-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">Set</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Manually set price. Click Save to push to Amazon.</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableHead>
                      <TableHead className="min-w-[100px] px-1 text-center">Rule</TableHead>
                      <TableHead className="text-center min-w-[60px] px-1">Lowest</TableHead>
                      <TableHead className="text-center min-w-[60px] px-1">
                        <button className="flex items-center justify-center hover:text-foreground mx-auto" onClick={() => toggleSort("buybox_price")}>
                          BB<SortIcon column="buybox_price" />
                        </button>
                      </TableHead>
                      <TableHead className="text-center min-w-[35px] px-1">Offers</TableHead>
                      {/* Today / 7d / 30d columns hidden — data still fetched & used by Replenish calc */}
                      {/* Replenish column hidden — available in Inventory page */}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedItems.map((item, index) => {
                      const currentPrice = item.my_price ?? item.price;
                      const totalQty = (item.available ?? 0) + (item.reserved ?? 0);
                      const isHiddenRow = hiddenItemIds.has(item.id) && !showHiddenOnly;
                      const rowTone = index % 2 === 0 ? 'bg-shipment-row' : 'bg-shipment-row-alt';

                      return (
                        <TableRow 
                          key={item.id} 
                          className={`text-xs border-b border-white/[0.06] hover:!bg-shipment-row-hover transition-colors duration-200 text-white ${rowTone} ${isHiddenRow ? 'opacity-70' : ''}`}
                        >
                          {/* Checkbox */}
                          <TableCell className={`sticky left-0 z-10 ${rowTone}`}>
                            <Checkbox
                              checked={selectedIds.has(item.id)}
                              onCheckedChange={checked => {
                                setSelectedIds(prev => {
                                  const next = new Set(prev);
                                  if (checked) next.add(item.id);
                                  else next.delete(item.id);
                                  return next;
                                });
                              }}
                            />
                          </TableCell>

                          {/* Save Button - first action column */}

                          {/* Priority Star — admin only */}
                          {isAdmin && (
                          <TableCell className="text-center px-1">
                            <div className="flex flex-col items-center gap-0.5">
                              <button
                                onClick={() => togglePriority(item)}
                                className="hover:scale-110 transition-transform"
                                title={item.is_manual_priority
                                  ? "Priority star — click to remove"
                                  : item.is_priority
                                    ? "Auto-turbo star"
                                    : `Add to priority queue (${priorityCount}/${MAX_PRIORITY})`}
                              >
                                <Star
                                  className={`h-4 w-4 ${
                                    item.is_manual_priority
                                      ? "fill-orange-400 text-orange-400"
                                      : item.is_priority
                                        ? "fill-yellow-400 text-yellow-400"
                                        : "text-muted-foreground/40 hover:text-yellow-300"
                                  }`}
                                />
                              </button>
                              {item.is_manual_priority && (
                                <span className="text-[9px] font-semibold text-orange-500 leading-none">Priority</span>
                              )}
                              {item.manual_override_active && item.buybox_price && item.price > item.buybox_price * 1.005 && (
                                <Badge variant="destructive" className="text-[8px] px-1 py-0 h-3.5 leading-none animate-pulse">
                                  TURBO OVERRIDE ({item.manual_override_checks})
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          )}

                          {/* Actions - Log only (admin) */}
                          {isAdmin && (
                          <TableCell className="text-center">
                            <div className="flex items-center justify-center gap-1">
                              {/* View Log Button */}
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-muted-foreground hover:text-primary"
                                      onClick={() => openListingVerification(item)}
                                    >
                                      <Search className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Verify live Amazon listing status</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>

                              {/* Lock / Unlock — fully disables evaluator changes for this row */}
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className={`h-6 w-6 ${isItemLocked(item) ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground hover:text-amber-500"}`}
                                      onClick={() => toggleLock(item)}
                                    >
                                      {isItemLocked(item) ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>{isItemLocked(item)
                                      ? "Locked — Min/Max/Set Price edits and manual eval are disabled. Repricer keeps running. Click to unlock."
                                      : "Lock edits — prevents you from changing Min/Max/Set Price or manual eval. Repricer keeps running normally."}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>

                              {/* Raise Min to target ROI — shown whenever rule has a target ROI for this marketplace */}
                              {(() => {
                                const targetRoi = (item.rule_min_roi_marketplace_overrides?.[marketplace as string] as number | undefined)
                                  ?? item.rule_min_roi_percent
                                  ?? null;
                                if (targetRoi == null || targetRoi <= 0) return null;
                                if (!item.rule_id) return null;
                                const isRaising = raisingToRoi.has(item.id);
                                const currentRoi = currentPrice != null ? calculateRoiFromPrice(item, Number(currentPrice)) : null;
                                const belowTarget = currentRoi != null && currentRoi < targetRoi;
                                const tooltip = currentRoi == null
                                  ? `Raise Min Price to hit ${targetRoi}% ROI (current ROI unknown)`
                                  : belowTarget
                                    ? `Raise Min Price to hit ${targetRoi}% ROI (current ${currentRoi.toFixed(1)}%)`
                                    : `Recalc Min for ${targetRoi}% ROI (current ${currentRoi.toFixed(1)}% already at/above target)`;
                                return (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className={`h-6 w-6 ${belowTarget ? 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10' : 'text-muted-foreground hover:text-emerald-600'}`}
                                          disabled={isRaising}
                                          onClick={() => raiseToTargetRoi(item, targetRoi)}
                                        >
                                          {isRaising ? <Loader2 className="h-3 w-3 animate-spin" /> : <TrendingUp className="h-3 w-3" />}
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>{tooltip}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                );
                              })()}





                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-muted-foreground hover:text-primary"
                                      onClick={() => openActionLog(item)}
                                    >
                                      <History className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>View price action log</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>

                              {/* Remove-from-marketplace (non-US only) — for listings deleted in Seller Central */}
                              {marketplace !== "US" && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                        onClick={() => removeFromMarketplace(item)}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Remove from {marketplace} (listing deleted in Seller Central)</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}


                              {/* Status badge */}
                              {getErrorBadge(item)}
                            </div>
                          </TableCell>
                          )}
                          <TableCell>
                            {(() => {
                              const snapshot = pendingStateSnapshotRef.current[item.id];
                              const liveMinText = editingMinPrice[item.id];
                              const liveMaxText = editingMaxPrice[item.id];
                              const liveNewPriceText = editingNewPrice[item.id];
                              const currentMinValue = item.min_price_override ?? item.inv_min_price;
                              const currentMaxValue = item.max_price_override ?? item.inv_max_price;
                              const liveMinChanged = liveMinText !== undefined && normalizePendingValue(liveMinText === "" ? null : Number(liveMinText)) !== normalizePendingValue(currentMinValue);
                              const liveMaxChanged = liveMaxText !== undefined && normalizePendingValue(liveMaxText === "" ? null : Number(liveMaxText)) !== normalizePendingValue(currentMaxValue);
                              const liveNewPriceChanged = liveNewPriceText !== undefined && liveNewPriceText.trim() !== "";
                              // Deliberately NOT using pendingChanges.has(item.id) here: that flag is
                              // set on first keystroke and only cleared at blur time, so retyping the
                              // exact original value while still focused kept the green Save button
                              // showing until the user clicked away. The live* comparisons below and
                              // the snapshot check already reactively reflect "is there a real
                              // difference from the original right now" on every keystroke.
                              const hasPendingChanges = liveMinChanged || liveMaxChanged || liveNewPriceChanged || (!!snapshot && !hasReturnedToPendingSnapshot(item));
                              const hasNeedsEval = needsEval.has(item.id);
                              const hasMinMax = (item.min_price_override ?? item.inv_min_price) != null || (item.max_price_override ?? item.inv_max_price) != null;
                              const hasNewPrice = pendingNewPrice[item.id] != null;
                              const curMin = item.min_price_override ?? item.inv_min_price;
                              const curMax = item.max_price_override ?? item.inv_max_price;
                              const hasMinMaxConflict = curMin != null && curMax != null && Number(curMin) > Number(curMax);
                              const newP = pendingNewPrice[item.id];
                              const newPriceOutOfBounds = newP != null && ((curMin != null && newP < Number(curMin)) || (curMax != null && newP > Number(curMax)));
                              const hasValidationError = hasMinMaxConflict || newPriceOutOfBounds;
                              const canSave = (hasMinMax || hasNewPrice) && !hasValidationError;
                              const hasRule = !!item.rule_id;
                              // Only treat the row as "paused" in the action button when the
                              // user manually paused. System-disabled / no-rule / no-inventory rows
                              // get their own dedicated status badge instead.
                              const isPaused = !item.is_enabled && isManuallyPaused({
                                is_enabled: item.is_enabled,
                                rule_id: item.rule_id,
                                manual_paused: item.manual_paused,
                                last_disabled_by: item.last_disabled_by,
                              });
                              const isSyncing = syncingMinMax.has(item.id);
                              const hasBothMinMax = curMin != null && curMax != null;

                              let buttonAction: () => void;
                              let title: string;
                              let className = "h-7 w-7 transition-colors ";
                              let forceDisabled = false;

                              if (!hasBothMinMax || !hasRule) {
                                buttonAction = () => {};
                                title = [!hasRule && "Assign a rule", curMin == null && "Set Min price", curMax == null && "Set Max price"].filter(Boolean).join(", ");
                                className += "border-destructive bg-destructive/10 text-destructive cursor-not-allowed opacity-70";
                                forceDisabled = true;
                              } else if (isPaused) {
                                buttonAction = async () => {
                                  if (hasPendingChanges) {
                                    if (!canSave) {
                                      toast.error("Fix validation errors before resuming");
                                      return;
                                    }
                                    const saved = await syncChangesToAmazon(item);
                                    if (!saved) return;
                                  }
                                  setNeedsEval(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                                  toggleItemEnabled(item, true);
                                };
                                title = hasPendingChanges ? "Resume & save changes" : "Rule paused – click to resume";
                                className += "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30";
                              } else if (hasPendingChanges && canSave) {
                                buttonAction = () => syncChangesToAmazon(item);
                                title = hasRule ? "Save changes to Amazon" : "Save min/max changes";
                                className += "border-green-500 bg-green-50 text-green-600 hover:bg-green-100 hover:text-green-700 dark:bg-green-950 dark:text-green-400 dark:hover:bg-green-900";
                              } else if (hasNeedsEval && hasRule && hasBothMinMax) {
                                buttonAction = async () => {
                                  setNeedsEval(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                                  await runSingleItem(item);
                                };
                                title = "Rule changed — click to evaluate now";
                                className += "border-green-500 bg-green-50 text-green-600 hover:bg-green-100 hover:text-green-700 dark:bg-green-950 dark:text-green-400 dark:hover:bg-green-900";
                              } else {
                                if (isAdmin) {
                                  buttonAction = async () => {
                                    if (hasRule && (item.min_price_override ?? item.inv_min_price) != null) {
                                      await runSingleItem(item);
                                    } else {
                                      toggleItemEnabled(item, false);
                                    }
                                  };
                                  title = hasRule ? "Live — click to run evaluation now" : "Select a rule first";
                                  className += "border-green-500/40 bg-green-500/10 hover:bg-green-500/20 dark:bg-green-500/15 dark:hover:bg-green-500/25";
                                } else {
                                  buttonAction = () => {};
                                  title = "Live — automatic evaluation active";
                                  className += "border-green-500/40 bg-green-500/10 cursor-default dark:bg-green-500/15";
                                  forceDisabled = false;
                                }
                              }

                              return (
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className={className}
                                  onClick={buttonAction}
                                  disabled={forceDisabled || isSyncing || runningSingleItem.has(item.id) || (!hasRule && !isPaused)}
                                  title={title}
                                >
                                  {isSyncing || runningSingleItem.has(item.id) ? (
                                    <RefreshCw className="h-3 w-3 animate-spin" />
                                  ) : (!hasBothMinMax || !hasRule || isPaused) ? (
                                    <Pause className="h-3 w-3" />
                                  ) : (hasPendingChanges && canSave) || hasNeedsEval ? (
                                    <Play className="h-3 w-3" />
                                  ) : (
                                    <span className="relative flex h-3 w-3">
                                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-40" />
                                      <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                                    </span>
                                  )}
                                </Button>
                              );
                            })()}
                          </TableCell>


                          {/* Product Image */}
                          <TableCell className="px-1 min-w-[52px]">
                            {item.image_url ? (
                              <img
                                src={item.image_url}
                                alt={item.title}
                                className="w-12 h-12 min-w-[48px] min-h-[48px] object-cover rounded"
                                onError={(e) => {
                                  const target = e.currentTarget;
                                  target.style.display = 'none';
                                  const placeholder = target.nextElementSibling as HTMLElement;
                                  if (placeholder) placeholder.style.display = 'flex';
                                }}
                              />
                            ) : null}
                            <div className={`w-12 h-12 bg-muted rounded flex items-center justify-center text-[10px] text-muted-foreground ${item.image_url ? 'hidden' : ''}`}>
                              No Image
                            </div>
                          </TableCell>

                          {/* Title / Fulfillment / ASIN */}
                          <TableCell>
                            <div className="space-y-1">
                              <div className="truncate max-w-[180px] font-medium text-xs" title={item.title}>
                                {item.title || "—"}
                              </div>
                              <div className="flex items-center gap-2">
                                <a
                                  href={`https://www.${marketplaceConfig.domain}/dp/${item.asin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono text-primary hover:underline text-xs"
                                >
                                  {item.asin}
                                </a>
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="h-5 w-5 hover:bg-primary hover:text-primary-foreground transition-colors"
                                  onClick={() => {
                                    navigator.clipboard.writeText(item.asin);
                                    toast.success("ASIN copied!");
                                  }}
                                  title="Copy ASIN"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                              <SmartSuggestionBanner
                                item={item}
                                rules={rules}
                                marketplace={marketplace}
                                onItemUpdate={(itemId, updates) => {
                                  setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...updates } : i));
                                }}
                                onAssignRule={(suggestionItem, ruleId) => {
                                  assignRule(suggestionItem as any, ruleId);
                                }}
                              />
                            </div>
                          </TableCell>

                          {/* SKU */}
                          <TableCell>
                            <div className="flex items-center gap-1 flex-wrap">
                              {/* New-inbound pin: highlights rows auto-activated in last 24h */}
                              {false && item.auto_activated_at && (Date.now() - new Date(item.auto_activated_at).getTime()) < 24 * 60 * 60 * 1000 && (
                                <span
                                  className="inline-flex items-center gap-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                  title={`Auto-activated ${new Date(item.auto_activated_at).toLocaleString()} — reason: ${item.auto_activated_reason || 'inbound'}`}
                                >
                                  🆕 New inbound
                                </span>
                              )}
                              <span className="font-mono text-xs truncate max-w-[80px]" title={item.sku}>
                                {item.sku || "—"}
                              </span>
                              {item.sku && (
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="h-5 w-5 shrink-0 hover:bg-primary hover:text-primary-foreground transition-colors"
                                  onClick={() => {
                                    navigator.clipboard.writeText(item.sku);
                                    toast.success("SKU copied!");
                                  }}
                                  title="Copy SKU"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              )}
                              <Badge 
                                variant="outline" 
                                className={`text-[9px] px-1 py-0 shrink-0 ${
                                  item.fulfillment_type === 'FBM' 
                                    ? 'border-orange-500 text-orange-600 dark:text-orange-400' 
                                    : 'border-blue-500 text-blue-600 dark:text-blue-400'
                                }`}
                                title={`${item.fulfillment_type} (auto-detected from inventory)`}
                              >
                                {item.fulfillment_type}
                              </Badge>
                              {(() => {
                                const cond = item.item_condition || 'New';
                                const isNonNew = cond !== 'New';
                                return (
                                  <Badge 
                                    variant="outline" 
                                    className={`text-[9px] px-1 py-0 shrink-0 ${
                                      isNonNew 
                                        ? 'border-amber-500 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30' 
                                        : 'border-muted-foreground/30 text-muted-foreground'
                                    }`}
                                    title={`Competing in ${cond} market — only ${cond} offers are used for pricing`}
                                  >
                                    {isNonNew ? `⚡ ${cond}` : cond}
                                  </Badge>
                                );
                              })()}
                              {/* Restricted badge - clickable toggle */}
                              {item.is_restricted && (
                                <Badge 
                                  variant="outline" 
                                  className="text-[9px] px-1 py-0 shrink-0 border-red-500 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 cursor-pointer"
                                  onClick={async () => {
                                    try {
                                      const assignmentId = await ensureAssignment(item);
                                      if (!assignmentId) return;
                                      const { error } = await (supabase as any)
                                        .from("repricer_assignments")
                                        .update({ is_restricted: false })
                                        .eq("id", assignmentId);
                                      if (error) throw error;
                                      setItems(prev => prev.map(i => 
                                        i.id === item.id ? { ...i, is_restricted: false } : i
                                      ));
                                      toast.success(`Unrestricted in ${marketplace}`);
                                    } catch {
                                      toast.error("Failed to update");
                                    }
                                  }}
                                  title={`Manually restricted in ${marketplace} — click to unrestrict. This is a manual flag, not auto-detected from Amazon.`}
                                >
                                   🚫 Manual Restriction
                                 </Badge>
                               )}
                            </div>
                          </TableCell>

                          {/* Qty */}
                          <TableCell className="text-center">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="cursor-help">
                                    {item.listing_status?.includes("INACTIVE") ? (
                                      <span className="text-destructive font-mono text-[10px] font-semibold">INACTIVE</span>
                                    ) : (item.available ?? 0) === 0 && totalQty === 0 ? (
                                      <span className="text-destructive/80 font-mono text-[10px] font-semibold">NO STOCK</span>
                                    ) : (item.available ?? 0) === 0 && (item.reserved ?? 0) > 0 ? (
                                      <div>
                                        <span className="text-warning font-mono text-[10px] font-semibold">0 SELLABLE</span>
                                        <div className="text-muted-foreground text-[10px]">{item.reserved} res</div>
                                      </div>
                                    ) : (
                                      <span className={`font-mono ${totalQty > 0 ? "text-foreground" : "text-muted-foreground"}`}>
                                        {totalQty}
                                      </span>
                                    )}
                                    {(item.inbound ?? 0) > 0 && (
                                      <div className="text-muted-foreground text-[10px]">+{item.inbound} inb</div>
                                    )}
                                    {(item.unfulfilled ?? 0) > 0 && (
                                      <div className="text-destructive/70 text-[10px]">{item.unfulfilled} unf</div>
                                    )}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="left" className="text-xs space-y-1">
                                  <div className="font-semibold mb-1">Inventory Breakdown</div>
                                  <div>Available: <span className="font-mono">{item.available ?? 0}</span></div>
                                  <div>Reserved: <span className="font-mono">{item.reserved ?? 0}</span></div>
                                  <div>Inbound: <span className="font-mono">{item.inbound ?? 0}</span></div>
                                  <div>Unfulfillable: <span className="font-mono">{item.unfulfilled ?? 0}</span></div>
                                  <div className="border-t border-border pt-1 mt-1">
                                    Sellable (Avail+Res): <span className="font-mono font-bold">{totalQty}</span>
                                    {(item.available ?? 0) === 0 && (item.reserved ?? 0) > 0 && (
                                      <div className="text-yellow-500 text-[10px] mt-0.5">📈 Pre-position pricing — repricer will raise price for when reserved units become available.</div>
                                    )}
                                  </div>
                                  {item.listing_status && (
                                    <div className="border-t border-border pt-1 mt-1">
                                      Status: <span className={item.listing_status.includes("INACTIVE") ? "text-destructive font-semibold" : ""}>{item.listing_status}</span>
                                    </div>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>

                          {/* Cost (editable only when no Created Listing purchase record exists) */}
                          <TableCell className="text-right font-mono">
                            {(() => {
                              const locked = hasPurchaseRecord(item.asin);
                              const mktConfig = getMarketplaceConfig(marketplace);
                              const isNonUs = marketplace !== "US";
                              const formatCost = () => {
                                if (item.cost == null) return null;
                                if (isNonUs && item.cost_converted != null) {
                                  return `${mktConfig.currencySymbol}${Number(item.cost_converted).toFixed(2)}`;
                                }
                                return `$${Number(item.cost).toFixed(2)}`;
                              };

                              if (locked) {
                                return (
                                  <span
                                    className="px-1 py-0.5 rounded text-right cursor-not-allowed text-muted-foreground"
                                    title="Unit cost is sourced from your Product Library purchase record and is read-only here. Edit it in Product Library."
                                  >
                                    {item.cost != null
                                      ? formatCost()
                                      : <span className="italic">—</span>}
                                  </span>
                                );
                              }

                              if (editingCost[item.id] !== undefined) {
                                return (
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-7 w-[70px] text-xs text-right bg-shipment-control text-white border-white/20 placeholder:text-white/40"
                                    value={editingCost[item.id]}
                                    onChange={e => setEditingCost(prev => ({ ...prev, [item.id]: e.target.value }))}
                                    onKeyDown={e => {
                                      if (e.key === "Enter") handleCostSave(item);
                                      if (e.key === "Escape") setEditingCost(prev => { const n = { ...prev }; delete n[item.id]; return n; });
                                    }}
                                    onBlur={() => handleCostSave(item)}
                                    autoFocus
                                    disabled={savingCost.has(item.id)}
                                  />
                                );
                              }

                              if (item.cost != null) {
                                return (
                                  <span
                                    className="cursor-pointer hover:underline"
                                    onClick={() => {
                                      const currentCost = Number(item.cost).toFixed(2);
                                      setEditingCost(prev => ({ ...prev, [item.id]: currentCost }));
                                    }}
                                    title="No purchase record in Product Library — click to edit cost"
                                  >
                                    {formatCost()}
                                  </span>
                                );
                              }

                              return (
                                <button
                                  onClick={() => setEditingCost(prev => ({ ...prev, [item.id]: "" }))}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold
                                    bg-primary/10 text-primary border border-primary/30
                                    hover:bg-primary/20 hover:border-primary/50 hover:shadow-[0_0_12px_hsl(var(--primary)/0.25)]
                                    transition-all duration-200 animate-pulse hover:animate-none"
                                  title="Enter cost to activate repricing"
                                >
                                  <DollarSign className="h-3 w-3" />
                                  Set Cost
                                </button>
                              );
                            })()}
                          </TableCell>


                          {/*
                            Min + Max price cells — memoized as <MinMaxPriceCells>
                            (Path A of the input-lag fix). Parent state
                            (editingMinPrice/editingMaxPrice/pendingChanges) is
                            preserved for cross-cell live validation, live ROI,
                            per-row Save indicator, and the async polling loop
                            that reads editingMin/MaxPriceRef. The perf win:
                            non-editing rows now short-circuit their re-render
                            on every keystroke because callbacks are stable and
                            props are primitives.

                            The old inline auto-floor tooltip branch was dead
                            code (isAutoFloorActive was hardcoded to false —
                            AUTO_FLOOR_LOWERED is permanently disabled per
                            core memory), so it is intentionally not carried
                            over.
                          */}
                          <MinMaxPriceCells
                            itemId={item.id}
                            disabled={syncingMinMax.has(item.id) || isItemLocked(item)}
                            minOverride={item.min_price_override ?? null}
                            invMin={item.inv_min_price ?? null}
                            maxOverride={item.max_price_override ?? null}
                            invMax={item.inv_max_price ?? null}
                            currentPrice={(() => {
                              const p = item.my_price ?? item.price;
                              return p == null ? null : Number(p);
                            })()}
                            roiAtMinPercent={item.roi_at_min_percent ?? null}
                            roiAtMaxPercent={item.roi_at_max_percent ?? null}
                            cost={item.cost ?? null}
                            feesJson={item.fees_json ?? null}
                            fxRate={cachedFxRate}
                            marketplace={marketplace}
                            editingMin={editingMinPrice[item.id]}
                            editingMax={editingMaxPrice[item.id]}
                            onMinChange={handleMinCellChange}
                            onMaxChange={handleMaxCellChange}
                            onMinFocus={handleMinCellFocus}
                            onMaxFocus={handleMaxCellFocus}
                            onMinBlur={handleMinCellBlur}
                            onMaxBlur={handleMaxCellBlur}
                            onMinEscape={handleMinCellEscape}
                            onMaxEscape={handleMaxCellEscape}
                          />



                          {/* Your Price - native currency + Fetch button */}
                          <TableCell className="text-right font-mono">
                            <div className="flex items-center justify-end gap-1">
                              <div>
                                {currentPrice != null ? formatPrice(Number(currentPrice), marketplace) : "—"}
                              </div>
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-muted-foreground hover:text-primary"
                                      onClick={() => fetchPriceForItem(item)}
                                      disabled={fetchingPrice.has(item.id)}
                                    >
                                      <RefreshCw className={`h-3 w-3 ${fetchingPrice.has(item.id) ? "animate-spin" : ""}`} />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Fetch current price from Amazon</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                            {item.last_recommended_price != null && currentPrice != null && (
                              <div className={`text-[10px] ${
                                item.last_recommended_price < currentPrice ? "text-red-500" :
                                item.last_recommended_price > currentPrice ? "text-green-500" : "text-muted-foreground"
                              }`}>
                                → {formatPrice(Number(item.last_recommended_price), marketplace)}
                              </div>
                            )}
                            {/* ROI at current price — computed instantly from cached fees, same as Min/Max/Low, no API call */}
                            {(() => {
                              const roiHere = currentPrice != null ? calculateRoiFromPrice(item, Number(currentPrice)) : null;
                              return (
                                <div className={`text-[10px] font-mono text-right ${
                                  roiHere != null
                                    ? roiHere >= 0
                                      ? "text-green-600 dark:text-green-400"
                                      : "text-red-600 dark:text-red-400"
                                    : "text-muted-foreground"
                                }`}>
                                  {roiHere != null ? `${roiHere >= 0 ? "+" : ""}${roiHere.toFixed(1)}%` : "—"}
                                </div>
                              );
                            })()}
                          </TableCell>

                          {/* Set Price - manual price input. Read-only by default (the AI is
                              actively deciding this price every evaluation cycle) — it only
                              unlocks while a "cooling down" banner is showing (SmartSuggestionBanner's
                              own copy already promises "type your desired price and push it now" for
                              all three of its cooldown variants, so this mirrors all three):
                              oscillation cooldown by live timestamp, oscillation guard by reason-text
                              fallback (older rows without the timestamp populated), and the routine
                              between-moves cooldown. A manual Lock always takes precedence. */}
                          <TableCell className="text-right pr-4">
                            {(() => {
                              const reasonText = String(item.last_recommendation_reason || "").toLowerCase();
                              const oscillationTimestampActive = !!(item.oscillation_cooldown_until && new Date(item.oscillation_cooldown_until) > new Date());
                              const oscillationReasonFallback = reasonText.includes("guard:") && reasonText.includes("oscillation");
                              const routineCooldown = reasonText.includes("cooldown");
                              const cooldownBannerActive = oscillationTimestampActive || oscillationReasonFallback || routineCooldown;
                              const setPriceDisabled = syncingMinMax.has(item.id) || isItemLocked(item) || !cooldownBannerActive;
                              return (
                            <div className="flex flex-col items-end gap-0.5">
                              <Input
                                type="number"
                                step="0.01"
                                className={`h-7 w-[105px] text-xs text-right bg-shipment-control text-white border-white/20 placeholder:text-white/40 focus:ring-2 focus:ring-primary ${
                                  setPriceDisabled ? "opacity-50 cursor-not-allowed " : ""
                                }${
                                  (() => {
                                    const newP = pendingNewPrice[item.id];
                                    if (newP == null) return "";
                                    const minVal = item.min_price_override ?? item.inv_min_price;
                                    const maxVal = item.max_price_override ?? item.inv_max_price;
                                    if ((minVal != null && newP < Number(minVal)) || (maxVal != null && newP > Number(maxVal))) return "border-destructive";
                                    return "";
                                  })()
                                }`}
                                disabled={setPriceDisabled}
                                title={
                                  isItemLocked(item)
                                    ? "Locked — click the lock icon to unlock"
                                    : !cooldownBannerActive
                                    ? "AI-managed — unlocks for manual entry while a cooldown banner is showing"
                                    : "AI has paused (cooldown) — you may set a price manually"
                                }
                                value={editingNewPrice[item.id] ?? ""}
                                onChange={e => {
                                  capturePendingSnapshot(item);
                                  setEditingNewPrice(prev => ({ ...prev, [item.id]: e.target.value }));
                                  setPendingChanges(prev => (prev.has(item.id) ? prev : new Set(prev).add(item.id)));
                                  const numVal = e.target.value ? parseFloat(e.target.value) : null;
                                  setPendingNewPrice(prev => ({ ...prev, [item.id]: numVal }));
                                }}
                                onFocus={() => {
                                  if (editingNewPrice[item.id] === undefined) {
                                    setEditingNewPrice(prev => ({ ...prev, [item.id]: "" }));
                                  }
                                }}
                                onBlur={() => {
                                  const val = editingNewPrice[item.id];
                                  if (!val) {
                                    // Cleared — check if reverted to original
                                    setEditingNewPrice(prev => {
                                      const next = { ...prev };
                                      delete next[item.id];
                                      return next;
                                    });
                                    setPendingNewPrice(prev => {
                                      const next = { ...prev };
                                      delete next[item.id];
                                      return next;
                                    });
                                    const reverted = hasReturnedToPendingSnapshot(item, {}, null, true);
                                    if (reverted) {
                                      setPendingChanges(prev => {
                                        const next = new Set(prev);
                                        next.delete(item.id);
                                        return next;
                                      });
                                      clearPendingSnapshot(item.id);
                                    }
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.currentTarget.blur();
                                  }
                                }}
                                placeholder={marketplaceConfig.currencySymbol}
                              />
                              {/* Validation message for new price outside bounds */}
                              {(() => {
                                const newP = pendingNewPrice[item.id];
                                if (newP == null) return null;
                                const minVal = item.min_price_override ?? item.inv_min_price;
                                const maxVal = item.max_price_override ?? item.inv_max_price;
                                if (minVal != null && newP < Number(minVal)) {
                                  return <span className="text-[9px] text-destructive font-medium">Below min!</span>;
                                }
                                if (maxVal != null && newP > Number(maxVal)) {
                                  return <span className="text-[9px] text-destructive font-medium">Above max!</span>;
                                }
                                return null;
                              })()}
                              {cooldownBannerActive && !isItemLocked(item) && (
                                <span className="text-[9px] text-amber-500">⏳ Cooldown — you may intervene</span>
                              )}
                            </div>
                              );
                            })()}
                          </TableCell>

                          {/* Rule */}
                          <TableCell>
                            <Select
                              value={item.rule_id || ""}
                              onValueChange={val => {
                                if (val) assignRule(item, val);
                              }}
                            >
                              <SelectTrigger className={`h-7 text-xs w-[100px] ${!item.rule_id ? 'border-destructive/60 text-destructive' : ''}`}>
                                <SelectValue placeholder="No rule" />
                              </SelectTrigger>
                              <SelectContent>
                                {rules.map(r => (
                                  <SelectItem key={r.id} value={r.id}>
                                    {r.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {/* Oscillation status - admin only */}
                            {isAdmin && (() => {
                              const resolvedMode = item.rule_oscillation_mode === 'auto'
                                ? (item.oscillation_last_mode_used || 'aggressive')
                                : (item.rule_oscillation_mode || null);
                              const label = resolvedMode === 'safe'
                                ? '🔴 War'
                                : resolvedMode === 'balanced'
                                  ? '🟡 Volatile'
                                  : '🟢 Stable';
                              const colorCls = resolvedMode === 'safe'
                                ? 'bg-destructive/15 text-destructive'
                                : resolvedMode === 'balanced'
                                  ? 'bg-muted text-foreground'
                                  : 'bg-secondary text-secondary-foreground';
                              const title = item.rule_oscillation_mode === 'auto'
                                ? `AI Oscillation: ${item.oscillation_last_mode_used || 'not scored yet'}`
                                : `Manual Oscillation: ${item.rule_oscillation_mode || 'aggressive'}`;
                              const detail = item.rule_oscillation_mode === 'auto'
                                ? (item.oscillation_last_reason || 'Awaiting first evaluation cycle')
                                : 'Using the rule\'s fixed oscillation mode, not AI state';
                              const cooldownActive = item.oscillation_cooldown_until && new Date(item.oscillation_cooldown_until) > new Date();
                              return (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={`inline-block mt-0.5 text-[9px] font-medium px-1 py-0 rounded ${colorCls}`}>
                                        {label}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      <p className="text-xs font-semibold mb-1">{title}</p>
                                      <p className="text-xs text-muted-foreground break-all">{detail}</p>
                                      {item.rule_oscillation_mode === 'auto' && (
                                        <div className="text-xs mt-1 space-y-0.5 border-t border-border pt-1">
                                          <p>Oscillations: {item.oscillation_count} | Reactions: {item.oscillation_reaction_count}</p>
                                          {item.oscillation_state && item.oscillation_state !== 'normal' && (
                                            <p>State: {item.oscillation_state}</p>
                                          )}
                                          {cooldownActive && (
                                            <p className="text-amber-500">⏳ Cooldown active</p>
                                          )}
                                        </div>
                                      )}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              );
                            })()}
                          </TableCell>


                          {/* Low Price - native currency (FBA lowest for FBA items, overall for FBM) */}
                          <TableCell className="text-right font-mono">
                            {(() => {
                              const lowPrice = item.fulfillment_type === 'FBA' && item.lowest_fba_price != null
                                ? item.lowest_fba_price
                                : item.lowest_overall_price;
                              const lowRoi = lowPrice != null ? calculateRoiFromPrice(item, Number(lowPrice)) : null;
                              const myPrice = item.my_price ?? item.price;
                              // Same "YOU" treatment as the BB column: our own current price
                              // matches the observed lowest, so we're (tied for) the lowest offer.
                              const isLowestMine = lowPrice != null && myPrice != null && Math.abs(Number(myPrice) - Number(lowPrice)) < 0.005;
                              return (
                                <>
                                  <div className="flex items-center justify-end gap-1">
                                    {isLowestMine && (
                                      <Badge
                                        variant="outline"
                                        className="text-[9px] px-1 py-0 h-4 border-0"
                                        style={{ backgroundColor: 'rgba(79,70,229,0.25)', color: '#4F46E5' }}
                                      >
                                        YOU
                                      </Badge>
                                    )}
                                    <span>{lowPrice != null ? formatPrice(Number(lowPrice), marketplace) : "—"}</span>
                                  </div>
                                  <div className={`text-[10px] font-mono ${
                                    lowRoi != null
                                      ? lowRoi >= 0
                                        ? "text-green-600 dark:text-green-400"
                                        : "text-red-600 dark:text-red-400"
                                      : "text-muted-foreground"
                                  }`}>
                                    {lowRoi != null ? `${lowRoi >= 0 ? "+" : ""}${lowRoi.toFixed(1)}%` : "—"}
                                  </div>
                                </>
                              );
                            })()}
                          </TableCell>

                          {/* Buy Box - native currency */}
                          <TableCell className="text-right font-mono">
                            {item.buybox_price != null ? (
                              <div className="font-medium text-primary">{formatPrice(Number(item.buybox_price), marketplace)}</div>
                            ) : "—"}
                            {/* BB Owner fulfillment (FBA/FBM/—) — merged in from its own column.
                                "YOU" badge (matches the extension analyser's own-offer tag,
                                same indigo styling) when this assignment's own SP-API check
                                confirmed we're the buy box winner. */}
                            <div className="flex items-center justify-end gap-1 mt-0.5">
                              {(item.last_buybox_status === 'winning' || item.last_buybox_status === 'owned') && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1 py-0 h-4 border-0"
                                  style={{ backgroundColor: 'rgba(79,70,229,0.25)', color: '#4F46E5' }}
                                >
                                  YOU
                                </Badge>
                              )}
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger>
                                    {item.buybox_seller_id ? (
                                      item.buybox_is_fba ? (
                                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-green-100 text-green-700">FBA</Badge>
                                      ) : (
                                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-muted">FBM</Badge>
                                      )
                                    ) : (
                                      <span className="text-muted-foreground text-[10px]">—</span>
                                    )}
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {item.buybox_seller_id || "No Buy Box data"}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                            {/* ROI at Buy Box price — computed instantly from cached fees, same as Min/Max/Low, no API call */}
                            {(() => {
                              const bbRoiHere = item.buybox_price != null ? calculateRoiFromPrice(item, Number(item.buybox_price)) : null;
                              return (
                                <div className={`text-[10px] font-mono ${
                                  bbRoiHere != null
                                    ? bbRoiHere >= 0
                                      ? "text-green-600 dark:text-green-400"
                                      : "text-red-600 dark:text-red-400"
                                    : "text-muted-foreground"
                                }`}>
                                  {bbRoiHere != null ? `${bbRoiHere >= 0 ? "+" : ""}${bbRoiHere.toFixed(1)}%` : "—"}
                                </div>
                              );
                            })()}
                          </TableCell>

                          {/* Offers */}
                          <TableCell className="text-center">
                            {item.offers_count != null ? item.offers_count : "—"}
                          </TableCell>

                          {/* Today / 7d / 30d cells hidden — data still in memory for Replenish & sorting */}

                          {/* Replenish cell hidden — available in Inventory page */}

                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
        )}

        {/* Marketplace settling overlay — blurs the (possibly still-converting)
            numbers underneath instead of letting min/max/price settle into place
            individually and visibly mismatch each other for a moment. Clears the
            instant this marketplace's data is confirmed fresh. Always names the
            marketplace being loaded (not "switching") since this shows on a
            same-marketplace refresh too, not just an actual tab switch. */}
        {!marketplaceSettled && !loading && items.length > 0 && (
          <div className="absolute inset-0 z-30 flex items-start justify-center pt-10 backdrop-blur-sm bg-shipment-surface/40 rounded-lg pointer-events-none">
            <div className="flex items-center gap-2 rounded-full bg-shipment-elevated/90 border border-white/10 px-4 py-2 text-xs text-white shadow-lg">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Loading {marketplace || "US"} Marketplace…
            </div>
          </div>
        )}
        </div>

        {/* Pagination Controls - Bottom */}
        {!loading && sortedItems.length > 0 && totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
            </div>
            
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="h-8 px-2"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                </PaginationItem>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <PaginationItem key={pageNum}>
                      <PaginationLink
                        onClick={() => setCurrentPage(pageNum)}
                        isActive={currentPage === pageNum}
                        className="cursor-pointer"
                      >
                        {pageNum}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="h-8 px-2"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
      </CardContent>

      {/* Action Log Dialog */}
      <ActionLogDialog
        asin={actionLogAsin}
        sku={actionLogSku}
        marketplace={marketplace}
        open={actionLogOpen}
        onOpenChange={(open) => {
          setActionLogOpen(open);
          if (!open) setActionLogItemId(null);
        }}
        overrideStatus={actionLogStatus}
        onMinPriceAccepted={handleMinPriceAccepted}
      />

      <ListingVerificationDialog
        item={verifyItem}
        open={verifyDialogOpen}
        onOpenChange={(open) => {
          setVerifyDialogOpen(open);
          if (!open) setVerifyItem(null);
        }}
        onGhostRemoved={() => {
          // Remove the ghost item from local state immediately
          if (verifyItem) {
            setItems(prev => prev.filter(i => !(i.asin === verifyItem.asin && i.sku === verifyItem.sku)));
          }
        }}
      />

      {/* Suggestion Review Panel */}
      <SuggestionReviewPanel
        open={suggestionPanelOpen}
        onOpenChange={setSuggestionPanelOpen}
        marketplace={marketplace}
        onMinPriceAccepted={handleMinPriceAccepted}
      />
      <LiveSalesPopup
        open={liveSalesOpen}
        onOpenChange={setLiveSalesOpen}
        marketplace="ALL"
      />
    </Card>
    </>
  );
}
