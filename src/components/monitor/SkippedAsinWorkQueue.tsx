import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages, type QueryBuilderFactory } from "@/lib/sales/paginatedFetch";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Copy, ExternalLink, RefreshCw, ListFilter } from "lucide-react";

import { toast } from "sonner";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";

type SkipCategory =
  | "all"
  | "no_rule"
  | "missing_data"
  | "persistent_empty"
  | "too_small"
  | "profit_guard"
  | "min_max_bound"
  | "oscillation_cooldown"
  | "disabled";

interface SkippedRow {
  id: string;
  asin: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  marketplace: string;
  skipReason: string;
  skipCategory: SkipCategory;
  skipCountToday: number;
  lastChecked: string | null;
  hasRule: boolean;
  hasMinMax: boolean;
  persistentEmpty: boolean;
  isDisabled: boolean;
  suggestedFix: string;
  // Inventory data for filtering
  available: number;
  reserved: number;
  inbound: number;
  listingStatus: string | null;
  source: string | null;
  price: number | null;
  myPrice: number | null;
  cost: number | null;
  offersCount: number | null;
  buyboxPrice: number | null;
  lastRecommendedPrice: number | null;
  ruleName: string | null;
}

const CATEGORY_LABELS: Record<SkipCategory, string> = {
  all: "All",
  no_rule: "No Rule",
  missing_data: "Missing Data",
  persistent_empty: "Persistent Empty",
  too_small: "Too Small",
  profit_guard: "Profit Guard",
  min_max_bound: "Min/Max Bound",
  oscillation_cooldown: "Oscillation / Cooldown",
  disabled: "Disabled",
};

const CATEGORY_COLORS: Record<SkipCategory, string> = {
  all: "",
  no_rule: "bg-red-500/15 text-red-700 border-red-500/30",
  missing_data: "bg-yellow-500/15 text-yellow-700 border-yellow-500/30",
  persistent_empty: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  too_small: "bg-gray-500/15 text-gray-700 border-gray-500/30",
  profit_guard: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  min_max_bound: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  oscillation_cooldown: "bg-purple-500/15 text-purple-700 border-purple-500/30",
  disabled: "bg-muted text-muted-foreground",
};

const FIX_SUGGESTIONS: Record<SkipCategory, string> = {
  all: "",
  no_rule: "Assign a repricer rule",
  missing_data: "Wait for data or recheck",
  persistent_empty: "Deprioritize or disable",
  too_small: "Review min/max bounds",
  profit_guard: "Review cost or lower min price",
  min_max_bound: "Widen min/max range",
  oscillation_cooldown: "Move to safe-mode rule",
  disabled: "Re-enable if needed",
};

function classifySkip(
  assignment: any,
  skipActionsMap: Map<string, { count: number; reasons: string[] }>,
  usRuleMap?: Map<string, boolean>
): { category: SkipCategory; reason: string } {
  const key = `${assignment.asin}_${(assignment.marketplace || "US").toUpperCase()}`;
  const isEnabled = assignment.is_enabled !== false;
  // Inherit rule from US if this is a non-US North American marketplace
  const hasOwnRule = !!assignment.rule_id;
  const mp = (assignment.marketplace || "US").toUpperCase();
  const inheritsFromUS = !hasOwnRule && ["CA", "MX", "BR"].includes(mp) && usRuleMap?.get(assignment.asin);
  const hasRule = hasOwnRule || !!inheritsFromUS;
  const reason = assignment.last_recommendation_reason || "";
  const skipReason = assignment.last_skip_reason || "";
  const reasonLower = reason.toLowerCase();
  const skipLower = skipReason.toLowerCase();
  const combined = `${reasonLower} ${skipLower}`;
  const skipInfo = skipActionsMap.get(key);

  if (!isEnabled) return { category: "disabled", reason: "Disabled" };
  if (!hasRule) return { category: "no_rule", reason: "No rule assigned" };

  // Check persistent empty first
  if ((assignment.consecutive_zero_offers ?? 0) >= 5)
    return { category: "persistent_empty", reason: "Persistent empty snapshot" };
  if (combined.includes("persistent_empty") || combined.includes("persistent empty"))
    return { category: "persistent_empty", reason: "Persistent empty snapshot" };

  // Profit guard / floor constraints
  if (combined.includes("profit_guard") || combined.includes("effective_floor") || combined.includes("already at or near floor"))
    return { category: "profit_guard", reason: "Profit guard block" };

  // Min/max bounds
  if (combined.includes("min_price") || combined.includes("max_price") || combined.includes("clamp") || combined.includes("final_clamp") || combined.includes("requires_min"))
    return { category: "min_max_bound", reason: "Min/max bound clamped" };

  // Oscillation / cooldown
  if (combined.includes("oscillat") || combined.includes("cooldown"))
    return { category: "oscillation_cooldown", reason: "Oscillation / cooldown" };

  // Missing data / empty snapshots
  if (combined.includes("empty") || combined.includes("no_market_data") || combined.includes("missing") || combined.includes("no_offer") || combined.includes("no_snapshot") || combined.includes("throttl") || combined.includes("stale"))
    return { category: "missing_data", reason: "Missing market data" };

  // Too small
  if (combined.includes("too small") || combined.includes("delta"))
    return { category: "too_small", reason: "Price change too small" };

  // BB owner / suppressed / safety
  if (combined.includes("bb_owner") || combined.includes("owner protection"))
    return { category: "too_small", reason: "BB owner — no change needed" };
  if (combined.includes("suppressed") || combined.includes("safety_abort") || combined.includes("blocked"))
    return { category: "profit_guard", reason: "Safety block" };

  // Constrained_by tag (catch-all for constraint reasons)
  if (combined.includes("constrained_by"))
    return { category: "min_max_bound", reason: "Constrained by guard" };

  // Check from price_actions skip reasons
  if (skipInfo && skipInfo.reasons.length > 0) {
    const actionCombined = skipInfo.reasons.join(" ").toLowerCase();
    if (actionCombined.includes("no_rule")) return { category: "no_rule", reason: "No rule assigned" };
    if (actionCombined.includes("empty") || actionCombined.includes("missing") || actionCombined.includes("no_market"))
      return { category: "missing_data", reason: "Missing market data" };
    if (actionCombined.includes("guard") || actionCombined.includes("profit"))
      return { category: "profit_guard", reason: "Profit guard block" };
    if (actionCombined.includes("blocked"))
      return { category: "profit_guard", reason: "Blocked by guard" };
  }

  // If last_skip_reason is set but didn't match above
  if (skipReason) return { category: "missing_data", reason: skipReason };

  // Default: if last_recommendation_reason is empty but assignment is active with rule, it's probably fine
  if (!reason && hasRule && isEnabled) return { category: "missing_data", reason: "No evaluation data yet" };

  return { category: "missing_data", reason: reason || "Unknown skip reason" };
}

// Module-level cache survives tab switches within the SPA session
const _cache: {
  rows: SkippedRow[];
  filter: SkipCategory;
  mpFilter: string;
  fulfillmentFilter: "ALL" | "FBA" | "FBM";
  stockFilter: "ALL" | "IN_STOCK" | "OUT_OF_STOCK";
  priceFilter: "ALL" | "HAS_PRICE" | "NO_PRICE";
  offerFilter: "ALL" | "HAS_OFFERS" | "NO_OFFERS";
} = {
  rows: [],
  filter: "all",
  mpFilter: "US",
  fulfillmentFilter: "FBA",
  stockFilter: "IN_STOCK",
  priceFilter: "HAS_PRICE",
  offerFilter: "HAS_OFFERS",
};

export default function SkippedAsinWorkQueue() {
  const { user } = useAuth();
  const [rows, setRows] = useState<SkippedRow[]>(_cache.rows);
  const [loading, setLoading] = useState(!_cache.rows.length);
  const [filter, setFilter] = useState<SkipCategory>(_cache.filter);
  const [mpFilter, setMpFilter] = useState(_cache.mpFilter);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fulfillmentFilter, setFulfillmentFilter] = useState<"ALL" | "FBA" | "FBM">(_cache.fulfillmentFilter);
  const [stockFilter, setStockFilter] = useState<"ALL" | "IN_STOCK" | "OUT_OF_STOCK">(_cache.stockFilter);
  const [priceFilter, setPriceFilter] = useState<"ALL" | "HAS_PRICE" | "NO_PRICE">(_cache.priceFilter);
  const [offerFilter, setOfferFilter] = useState<"ALL" | "HAS_OFFERS" | "NO_OFFERS">(_cache.offerFilter);

  // Sync to module-level cache on every change
  useEffect(() => {
    _cache.rows = rows;
    _cache.filter = filter;
    _cache.mpFilter = mpFilter;
    _cache.fulfillmentFilter = fulfillmentFilter;
    _cache.stockFilter = stockFilter;
    _cache.priceFilter = priceFilter;
    _cache.offerFilter = offerFilter;
  }, [rows, filter, mpFilter, fulfillmentFilter, stockFilter, priceFilter, offerFilter]);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    try {
      // The third copy of this loop in the codebase, now retired in favour of
      // @/lib/sales/paginatedFetch. This copy already threw on a page error --
      // the right call, and the reason the shared helper gained
      // throwOnIncomplete rather than this one being downgraded to a silent
      // partial result. It paged an UNORDERED query, though, which the shared
      // helper fixes by applying an `id` tiebreaker itself, and it now also
      // retries a transient page failure once before giving up.
      const paged = (buildQuery: QueryBuilderFactory) =>
        fetchAllPages(buildQuery, { throwOnIncomplete: true, label: "SkippedAsinWorkQueue" });

      const [assignmentsRaw, actions, inventoryRaw, rulesRes] = await Promise.all([
        paged(() =>
          supabase
            .from("repricer_assignments")
            .select("id, asin, sku, marketplace, status, is_enabled, rule_id, min_price_override, max_price_override, amazon_min_price, amazon_max_price, last_sp_api_check_at, last_evaluated_at, last_recommendation_reason, last_skip_reason, consecutive_zero_offers, updated_at, last_recommended_price, last_buybox_price")
            .eq("user_id", user.id)
            .eq("status", "active")
        ),
        paged(() =>
          supabase
            .from("repricer_price_actions")
            .select("asin, marketplace, action_type, reason, error_type, error_message, intelligence_factors, created_at")
            .eq("user_id", user.id)
            .gte("created_at", todayISO)
            .in("action_type", [
              "no_change",
              "eval_error",
              "blocked_by_profit_guard",
              "anomaly_eval_only",
              "skipped",
              "blocked",
              "no_data",
              "throttled",
              "empty_snapshot",
            ])
        ),
        paged(() =>
          supabase
            .from("inventory")
            .select("asin, sku, title, image_url, available, reserved, inbound, listing_status, source, price, my_price, cost")
            .eq("user_id", user.id)
        ),
        supabase
          .from("repricer_rules")
          .select("id, name")
          .eq("user_id", user.id),
      ]);

      // Build rule name lookup
      const ruleNameMap = new Map<string, string>();
      for (const r of rulesRes.data || []) {
        ruleNameMap.set(r.id, r.name);
      }

      // Build inventory lookup by asin (use first match per asin)
      const inventoryMap = new Map<string, any>();
      for (const inv of inventoryRaw) {
        if (!inventoryMap.has(inv.asin)) {
          inventoryMap.set(inv.asin, inv);
        }
      }

      // Deduplicate active assignments per ASIN+marketplace, preferring rows with rules and newer updates
      const assignmentMap = new Map<string, any>();
      for (const a of assignmentsRaw) {
        const key = `${a.asin}_${(a.marketplace || "US").toUpperCase()}`;
        const existing = assignmentMap.get(key);
        if (!existing) {
          assignmentMap.set(key, a);
          continue;
        }

        const existingHasRule = !!existing.rule_id;
        const currentHasRule = !!a.rule_id;
        const existingUpdated = new Date(existing.updated_at || existing.last_evaluated_at || 0).getTime();
        const currentUpdated = new Date(a.updated_at || a.last_evaluated_at || 0).getTime();

        if ((currentHasRule && !existingHasRule) || (currentHasRule === existingHasRule && currentUpdated > existingUpdated)) {
          assignmentMap.set(key, a);
        }
      }

      const assignments = Array.from(assignmentMap.values()) as any[];

      // Latest snapshot lookup (offers + buybox) per ASIN+marketplace
      const snapshotsMap = new Map<string, { offersCount: number | null; buyboxPrice: number | null; fetchedAt: string | null }>();
      const asins = Array.from(new Set(assignments.map((a) => a.asin).filter(Boolean)));
      const batchSize = 500;

      for (let i = 0; i < asins.length; i += batchSize) {
        const batch = asins.slice(i, i + batchSize);
        const { data: snapshots, error: snapshotsError } = await supabase
          .from("repricer_competitor_snapshots")
          .select("asin, marketplace, offers_count, buybox_price, fetched_at")
          .eq("user_id", user.id)
          .in("asin", batch)
          .order("fetched_at", { ascending: false })
          .limit(5000);

        if (snapshotsError) throw snapshotsError;

        for (const s of snapshots || []) {
          const key = `${s.asin}_${(s.marketplace || "US").toUpperCase()}`;
          const existing = snapshotsMap.get(key);
          const currentTs = new Date(s.fetched_at || 0).getTime();
          const existingTs = new Date(existing?.fetchedAt || 0).getTime();

          if (!existing || currentTs > existingTs) {
            snapshotsMap.set(key, {
              offersCount: s.offers_count ?? null,
              buyboxPrice: s.buybox_price ?? null,
              fetchedAt: s.fetched_at ?? null,
            });
          }
        }
      }

      console.log(
        `[SkippedAsinWorkQueue] Assignments: ${assignments.length}/${assignmentsRaw.length} deduped, Actions today: ${actions.length}`
      );

      // Build US rule map for inheritance: asin -> has rule in US
      const usRuleMap = new Map<string, boolean>();
      for (const a of assignments) {
        if ((a.marketplace || "US").toUpperCase() === "US" && !!a.rule_id) {
          usRuleMap.set(a.asin, true);
        }
      }

      // Build skip actions map: asin_marketplace -> { count, reasons }
      const skipMap = new Map<string, { count: number; reasons: string[] }>();
      for (const a of actions) {
        const key = `${a.asin}_${(a.marketplace || "US").toUpperCase()}`;
        const entry = skipMap.get(key) || { count: 0, reasons: [] };
        entry.count++;
        const reason = a.error_message || a.reason || a.error_type || a.action_type || "";
        if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason);
        skipMap.set(key, entry);
      }

      // Classify ALL active assignments (no pre-filtering — let UI filters handle visibility)
      const skipped: SkippedRow[] = [];
      for (const a of assignments) {
        const normalizedMp = (a.marketplace || "US").toUpperCase();
        const key = `${a.asin}_${normalizedMp}`;
        const skipInfo = skipMap.get(key);
        const snapshot = snapshotsMap.get(key);
        const { category, reason } = classifySkip(a, skipMap, usRuleMap);

        const isDisabled = a.is_enabled === false;
        const hasOwnRule = !!a.rule_id;
        const inheritsRule = !hasOwnRule && ["CA", "MX", "BR"].includes(normalizedMp) && usRuleMap.get(a.asin);
        const persistentEmpty = (a.consecutive_zero_offers ?? 0) >= 5;

        const inv = inventoryMap.get(a.asin);
        skipped.push({
          id: a.id,
          asin: a.asin,
          sku: a.sku || "",
          title: inv?.title || "",
          imageUrl: inv?.image_url || null,
          marketplace: normalizedMp,
          skipReason: reason,
          skipCategory: category,
          skipCountToday: skipInfo?.count || 0,
          lastChecked: a.last_sp_api_check_at || a.last_evaluated_at || null,
          hasRule: hasOwnRule || !!inheritsRule,
          hasMinMax:
            (a.min_price_override != null && a.max_price_override != null) ||
            (a.amazon_min_price != null && a.amazon_max_price != null),
          persistentEmpty,
          isDisabled,
          suggestedFix: FIX_SUGGESTIONS[category] || "",
          available: inv?.available ?? 0,
          reserved: inv?.reserved ?? 0,
          inbound: inv?.inbound ?? 0,
          listingStatus: inv?.listing_status || null,
          source: inv?.source || null,
          price: inv?.price ?? null,
          myPrice: inv?.my_price ?? null,
          cost: inv?.cost ?? null,
          offersCount: snapshot?.offersCount ?? null,
          buyboxPrice: snapshot?.buyboxPrice ?? a.last_buybox_price ?? null,
          lastRecommendedPrice: a.last_recommended_price ?? null,
          ruleName: a.rule_id ? (ruleNameMap.get(a.rule_id) || null) : null,
        });
      }

      // Sort: highest skip count first, then by category severity
      const categoryOrder: SkipCategory[] = ["no_rule", "persistent_empty", "profit_guard", "min_max_bound", "oscillation_cooldown", "missing_data", "too_small", "disabled"];
      skipped.sort((a, b) => {
        const ai = categoryOrder.indexOf(a.skipCategory);
        const bi = categoryOrder.indexOf(b.skipCategory);
        if (ai !== bi) return ai - bi;
        return b.skipCountToday - a.skipCountToday;
      });

      setRows(skipped);
    } catch (err) {
      console.error("SkippedAsinWorkQueue fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  // Only auto-fetch if no cached data; otherwise user can manually refresh
  useEffect(() => { if (!_cache.rows.length) fetchData(); }, [user]);

  // Unique marketplaces for dropdown
  const marketplaces = useMemo(() => {
    const mps = new Set(rows.map((r) => r.marketplace));
    return ["all", ...Array.from(mps).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    let result = rows;
    if (mpFilter !== "all") result = result.filter((r) => r.marketplace === mpFilter);
    if (filter !== "all") result = result.filter((r) => r.skipCategory === filter);
    // Fulfillment filter
    if (fulfillmentFilter !== "ALL") {
      result = result.filter((r) => {
        const isFba = r.source?.includes("fba") || r.source === "amazon_sync";
        return fulfillmentFilter === "FBA" ? isFba : !isFba;
      });
    }
    // Stock filter
    if (stockFilter !== "ALL") {
      result = result.filter((r) => {
        const total = r.available + r.reserved + r.inbound;
        const isInactive = r.listingStatus?.includes("INACTIVE");
        if (stockFilter === "IN_STOCK") return total > 0 && !isInactive;
        if (stockFilter === "OUT_OF_STOCK") return total <= 0 || !!isInactive;
        return true;
      });
    }
    // Price filter
    if (priceFilter !== "ALL") {
      result = result.filter((r) => {
        const hasPrice = (r.myPrice != null && r.myPrice > 0) || (r.price != null && r.price > 0);
        return priceFilter === "HAS_PRICE" ? hasPrice : !hasPrice;
      });
    }
    // Offer filter
    if (offerFilter !== "ALL") {
      result = result.filter((r) => {
        if (offerFilter === "HAS_OFFERS") return (r.offersCount ?? 0) > 0;
        return r.offersCount === 0 || r.offersCount == null;
      });
    }
    return result;
  }, [rows, filter, mpFilter, fulfillmentFilter, stockFilter, priceFilter, offerFilter]);

  // Category counts for summary (respects all filters except category filter itself)
  const categoryCounts = useMemo(() => {
    let base = rows;
    if (mpFilter !== "all") base = base.filter((r) => r.marketplace === mpFilter);
    if (fulfillmentFilter !== "ALL") {
      base = base.filter((r) => {
        const isFba = r.source?.includes("fba") || r.source === "amazon_sync";
        return fulfillmentFilter === "FBA" ? isFba : !isFba;
      });
    }
    if (stockFilter !== "ALL") {
      base = base.filter((r) => {
        const total = r.available + r.reserved + r.inbound;
        const isInactive = r.listingStatus?.includes("INACTIVE");
        if (stockFilter === "IN_STOCK") return total > 0 && !isInactive;
        return total <= 0 || !!isInactive;
      });
    }
    if (priceFilter !== "ALL") {
      base = base.filter((r) => {
        const hasPrice = (r.myPrice != null && r.myPrice > 0) || (r.price != null && r.price > 0);
        return priceFilter === "HAS_PRICE" ? hasPrice : !hasPrice;
      });
    }
    if (offerFilter !== "ALL") {
      base = base.filter((r) => {
        if (offerFilter === "HAS_OFFERS") return (r.offersCount ?? 0) > 0;
        return r.offersCount === 0 || r.offersCount == null;
      });
    }
    const counts: Record<string, number> = {};
    for (const r of base) {
      counts[r.skipCategory] = (counts[r.skipCategory] || 0) + 1;
    }
    return counts;
  }, [rows, mpFilter, fulfillmentFilter, stockFilter, priceFilter, offerFilter]);

  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const getSelectedRows = () => filtered.filter((r) => selected.has(r.id));
  const getVisibleRows = () => (selected.size > 0 ? getSelectedRows() : filtered);

  const copyAsins = () => {
    const items = getVisibleRows();
    const text = [...new Set(items.map((r) => r.asin))].join(", ");
    navigator.clipboard.writeText(text);
    toast.success(`${items.length} ASINs copied`);
  };

  const copyAsinMarketplace = () => {
    const items = getVisibleRows();
    const text = items.map((r) => `${r.asin}\t${r.marketplace}`).join("\n");
    navigator.clipboard.writeText(text);
    toast.success(`${items.length} ASIN+MP copied`);
  };

  const copyAsinReason = () => {
    const items = getVisibleRows();
    const text = items.map((r) => `${r.asin}\t${r.marketplace}\t${r.skipReason}`).join("\n");
    navigator.clipboard.writeText(text);
    toast.success(`${items.length} ASIN+reason copied`);
  };

  return (
    <Card className="border-2 border-blue-500/30">
      <CardHeader className="flex flex-row items-center justify-between pb-2 bg-blue-500/5 rounded-t-lg">
        <CardTitle className="text-lg flex items-center gap-2">
          <ListFilter className="h-5 w-5 text-blue-500" />
          Skipped ASIN Work Queue
          <Badge className="bg-blue-500 text-white text-[10px] ml-1">NEW</Badge>
          <Badge variant="secondary" className="ml-1">{filtered.length}</Badge>
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={fulfillmentFilter} onValueChange={(v) => setFulfillmentFilter(v as any)}>
            <SelectTrigger className="w-[80px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="FBA">FBA</SelectItem>
              <SelectItem value="FBM">FBM</SelectItem>
            </SelectContent>
          </Select>
          <Select value={stockFilter} onValueChange={(v) => setStockFilter(v as any)}>
            <SelectTrigger className="w-[100px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Stock</SelectItem>
              <SelectItem value="IN_STOCK">In Stock</SelectItem>
              <SelectItem value="OUT_OF_STOCK">Out of Stock</SelectItem>
            </SelectContent>
          </Select>
          <Select value={priceFilter} onValueChange={(v) => setPriceFilter(v as any)}>
            <SelectTrigger className="w-[100px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Prices</SelectItem>
              <SelectItem value="HAS_PRICE">Has Price</SelectItem>
              <SelectItem value="NO_PRICE">No Price</SelectItem>
            </SelectContent>
          </Select>
          <Select value={offerFilter} onValueChange={(v) => setOfferFilter(v as any)}>
            <SelectTrigger className="w-[110px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Offers</SelectItem>
              <SelectItem value="HAS_OFFERS">Has Offers</SelectItem>
              <SelectItem value="NO_OFFERS">No Offers</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mpFilter} onValueChange={setMpFilter}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue placeholder="Marketplace" />
            </SelectTrigger>
            <SelectContent>
              {marketplaces.map((mp) => (
                <SelectItem key={mp} value={mp}>
                  {mp === "all" ? "All Markets" : mp}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Category summary badges */}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(CATEGORY_LABELS) as SkipCategory[]).map((cat) => {
            const count = cat === "all"
              ? Object.values(categoryCounts).reduce((s, n) => s + n, 0)
              : (categoryCounts[cat] || 0);
            return (
              <Badge
                key={cat}
                variant="outline"
                className={`cursor-pointer text-xs transition-all ${
                  filter === cat ? "ring-2 ring-primary ring-offset-1" : ""
                } ${CATEGORY_COLORS[cat]}`}
                onClick={() => setFilter(cat)}
              >
                {CATEGORY_LABELS[cat]}: {count}
              </Badge>
            );
          })}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={copyAsins} disabled={filtered.length === 0}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy ASINs
          </Button>
          <Button size="sm" variant="outline" onClick={copyAsinMarketplace} disabled={filtered.length === 0}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            ASIN + MP
          </Button>
          <Button size="sm" variant="outline" onClick={copyAsinReason} disabled={filtered.length === 0}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            ASIN + Reason
          </Button>
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground self-center ml-2">
              {selected.size} selected
            </span>
          )}
        </div>

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading skipped ASINs...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {filter === "all" ? "No skipped ASINs found — all assignments evaluating normally" : `No ASINs in "${CATEGORY_LABELS[filter]}" category`}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                  </TableHead>
                  <TableHead className="w-10"></TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>MP</TableHead>
                  <TableHead className="text-right">Avail</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">BB</TableHead>
                  <TableHead className="text-right">Offers</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Skip Reason</TableHead>
                  <TableHead className="text-right">Skips</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Fix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, 200).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.id)}
                        onCheckedChange={() => toggleOne(r.id)}
                      />
                    </TableCell>
                    <TableCell className="w-10">
                      {r.imageUrl ? (
                        <img src={r.imageUrl} alt="" className="w-8 h-8 object-contain rounded" />
                      ) : (
                        <div className="w-8 h-8 bg-muted rounded" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <a
                        href={`https://www.${getMarketplaceConfig(r.marketplace).domain}/dp/${r.asin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {r.asin}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell className="text-xs truncate max-w-[150px]" title={r.title}>
                      {r.title || "—"}
                    </TableCell>
                    <TableCell className="text-xs truncate max-w-[100px]" title={r.sku}>
                      {r.sku || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{r.marketplace}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.available + r.reserved + r.inbound > 0
                        ? `${r.available}/${r.reserved}/${r.inbound}`
                        : "0"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.myPrice != null && r.myPrice > 0
                        ? `$${r.myPrice.toFixed(2)}`
                        : r.price != null && r.price > 0
                        ? `$${r.price.toFixed(2)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.cost != null && r.cost > 0 ? `$${r.cost.toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.buyboxPrice != null ? `$${r.buyboxPrice.toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.offersCount != null ? r.offersCount : "—"}
                    </TableCell>
                    <TableCell className="text-xs truncate max-w-[100px]" title={r.ruleName || ""}>
                      {r.ruleName || <span className="text-destructive">None</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${CATEGORY_COLORS[r.skipCategory]}`}>
                        {r.skipReason}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.skipCountToday > 0 ? r.skipCountToday : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {!r.hasRule && (
                          <Badge variant="outline" className="text-[10px] bg-destructive/15 text-destructive border-destructive/30">
                            No Rule
                          </Badge>
                        )}
                        {!r.hasMinMax && r.hasRule && (
                          <Badge variant="outline" className="text-[10px] bg-yellow-500/15 text-yellow-700 border-yellow-500/30">
                            No Min/Max
                          </Badge>
                        )}
                        {r.persistentEmpty && (
                          <Badge variant="outline" className="text-[10px] bg-orange-500/15 text-orange-700 border-orange-500/30">
                            Empty ∞
                          </Badge>
                        )}
                        {r.isDisabled && (
                          <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">
                            Disabled
                          </Badge>
                        )}
                        {r.hasRule && r.hasMinMax && !r.persistentEmpty && !r.isDisabled && (
                          <span className="text-[10px] text-muted-foreground">OK</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground italic">
                      {r.suggestedFix}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {filtered.length > 200 && (
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Showing 200 of {filtered.length} — use filters to narrow down
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
