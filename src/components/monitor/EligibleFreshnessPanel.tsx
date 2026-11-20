import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, RefreshCw, Clock, Zap, Info, Globe, Flag } from "lucide-react";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface HotSubtypes {
  starred: number;
  bbAlert: number;
  losingBbGap: number;
  competitorMoveLosing: number;
}

interface HotBlockedBreakdown {
  throttled: number;
  noData: number;
  dailyCap: number;
  inactive: number;
  bbOwnerStable: number;
  floorHeld: number;
  rotatingBb: number;
  noGap: number;
  other: number;
}

interface MarketMetrics {
  hotP50: number;
  hotP90: number;
  hotP95: number;
  hotMax: number;
  hotSlaBreachCount: number;
  hotCount: number;
  hotEvaluatedButBlockedCount: number;
  hotTrulyStalCount: number;
  hotDispatchableCount: number;
  hotBlockedCount: number;
  hotBlockedBreakdown: HotBlockedBreakdown;
  hotDispatchableP50: number;
  hotDispatchableP90: number;
  hotSubtypes: HotSubtypes;
  warmP50: number;
  warmP90: number;
  warmCount: number;
  eligibleChecked1h: number;
  eligibleChecked24h: number;
  totalEligible: number;
}

export interface HotStaleAsin {
  asin: string;
  ageMin: number;
  lastCheck: string;
  reason: string;
}

interface FreshnessData {
  us: MarketMetrics;
  intl: MarketMetrics;
  combined: MarketMetrics;
  loading: boolean;
  hotStaleAsins: HotStaleAsin[];
}

const EMPTY_SUBTYPES: HotSubtypes = { starred: 0, bbAlert: 0, losingBbGap: 0, competitorMoveLosing: 0 };
const EMPTY_BLOCKED: HotBlockedBreakdown = { throttled: 0, noData: 0, dailyCap: 0, inactive: 0, bbOwnerStable: 0, floorHeld: 0, rotatingBb: 0, noGap: 0, other: 0 };

const EMPTY_METRICS: MarketMetrics = {
  hotP50: 0, hotP90: 0, hotP95: 0, hotMax: 0, hotSlaBreachCount: 0, hotCount: 0,
  hotEvaluatedButBlockedCount: 0, hotTrulyStalCount: 0,
  hotDispatchableCount: 0, hotBlockedCount: 0,
  hotBlockedBreakdown: { ...EMPTY_BLOCKED },
  hotDispatchableP50: 0, hotDispatchableP90: 0,
  hotSubtypes: { ...EMPTY_SUBTYPES },
  warmP50: 0, warmP90: 0, warmCount: 0,
  eligibleChecked1h: 0, eligibleChecked24h: 0, totalEligible: 0,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return Math.round(sorted[Math.min(idx, sorted.length - 1)]);
}

type HotBlockedKind = keyof HotBlockedBreakdown;

const BLOCKED_ACK_RESULTS = new Set(["no_change", "blocked", "held", "constrained", "already_optimal"]);
const STABLE_NO_ACTION_HINTS = [
  "buy box owner protection",
  "already lowest",
  "already lowest among eligible competitors",
  "at floor",
  "micro-step blocked by floor",
  "within $0.01 of bb",
  "patience hold",
  "already winning",
  "no eligible competitors",
  "no cheaper competitor",
  "holding price",
];
const CONSTRAINED_HINTS = [
  "price change too small",
  "constrained_by",
  "cannot lower further",
  "monopoly mode",
  "buy box suppressed",
  "above bb — not owner",
  "above_bb_not_owner",
  "no_change_streak",
  "war_protection",
  "oscillation",
  "safety_cooldown",
  "condition mismatch",
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function toCents(value: number | null | undefined): number {
  return Math.round((value ?? 0) * 100);
}

function getPositiveGapCents(left: number | null | undefined, right: number | null | undefined): number {
  if (left == null || right == null) return 0;
  const gap = toCents(left) - toCents(right);
  return gap > 0 ? gap : 0;
}

function getHotTraits(a: any, alertedAsins: Set<string>, now: number) {
  const starred = !!a.is_priority;
  const bbAlert = alertedAsins.has(a.asin);
  const bbStatus = normalizeText(a.last_buybox_status);
  const losingBb = !!bbStatus && bbStatus !== "winning" && bbStatus !== "rotating";
  const aboveBbGap = getPositiveGapCents(a.last_applied_price, a.last_buybox_price);
  const recentChangeTs = a.last_price_change_at ? new Date(a.last_price_change_at).getTime() : 0;
  const recentChange = recentChangeTs > now - 15 * 60 * 1000;
  const isHot = starred || bbAlert || (losingBb && aboveBbGap >= 5) || (recentChange && losingBb);

  return { starred, bbAlert, losingBb, aboveBbGap, recentChange, isHot };
}

function getHotBlockedState(a: any): { blocked: boolean; kind: HotBlockedKind | null; label?: string } {
  const skipReason = normalizeText(a.last_skip_reason);
  if (skipReason.includes("throttl") || skipReason.includes("sp_api_throttled")) {
    return { blocked: true, kind: "throttled" };
  }
  if (skipReason.includes("no_offers") || skipReason.includes("empty_offers") || skipReason.includes("no_data")) {
    return { blocked: true, kind: "noData" };
  }
  if (skipReason.includes("daily_check_cap") || skipReason.includes("daily_cap")) {
    return { blocked: true, kind: "dailyCap" };
  }
  if (skipReason.includes("inactive") || skipReason.includes("not_found")) {
    return { blocked: true, kind: "inactive" };
  }

  const ackResult = normalizeText(a.last_ack_result);
  const ackReason = normalizeText(a.last_ack_reason);
  const bbStatus = normalizeText(a.last_buybox_status);
  const withinBbRotationBand =
    a.last_applied_price != null &&
    a.last_buybox_price != null &&
    Math.abs(toCents(a.last_applied_price) - toCents(a.last_buybox_price)) <= 1;
  const stableNoActionByReason = STABLE_NO_ACTION_HINTS.some((hint) => ackReason.includes(hint));
  const stableNoAction =
    ackResult === "no_change" &&
    (bbStatus === "winning" || bbStatus === "rotating" || withinBbRotationBand || stableNoActionByReason);

  if (stableNoAction) {
    // Classify into specific stable sub-bucket
    if (bbStatus === "winning" && (ackReason.includes("already winning") || ackReason.includes("buy box owner protection"))) {
      return { blocked: true, kind: "bbOwnerStable" };
    }
    if (ackReason.includes("at floor") || ackReason.includes("micro-step blocked by floor") || ackReason.includes("already lowest")) {
      return { blocked: true, kind: "floorHeld" };
    }
    if (bbStatus === "rotating" || withinBbRotationBand || ackReason.includes("patience hold") || ackReason.includes("within $0.01")) {
      return { blocked: true, kind: "rotatingBb" };
    }
    if (ackReason.includes("no eligible competitors") || ackReason.includes("no cheaper competitor")) {
      return { blocked: true, kind: "noGap" };
    }
    return { blocked: true, kind: "bbOwnerStable" };
  }

  if (ackResult !== "" && BLOCKED_ACK_RESULTS.has(ackResult)) {
    // Try to classify constrained results into specific buckets
    const isConstrained = CONSTRAINED_HINTS.some((hint) => ackReason.includes(hint));
    if (isConstrained) {
      if (ackReason.includes("at floor") || ackReason.includes("cannot lower further") || ackReason.includes("micro-step blocked by floor") || ackReason.includes("already lowest")) {
        return { blocked: true, kind: "floorHeld" };
      }
      if (ackReason.includes("monopoly mode")) {
        return { blocked: true, kind: "noGap" };
      }
      // price change too small / constrained_by / buy box suppressed = floor/guard held
      return { blocked: true, kind: "floorHeld" };
    }
    // Additional classification for non-constrained blocked states
    if (ackReason.includes("bb_owner_protection") || ackReason.includes("already winning") || ackReason.includes("buy box owner")) {
      return { blocked: true, kind: "bbOwnerStable" };
    }
    if (ackReason.includes("oscillation") || ackReason.includes("cooldown") || ackReason.includes("war_protection") || ackReason.includes("safety_cooldown")) {
      return { blocked: true, kind: "rotatingBb" };
    }
    if (ackReason.includes("no_competitor") || ackReason.includes("zero_offers") || ackReason.includes("solo") || ackReason.includes("only seller")) {
      return { blocked: true, kind: "noGap" };
    }
    if (ackReason.includes("condition") || ackReason.includes("used") || ackReason.includes("holding price")) {
      return { blocked: true, kind: "floorHeld" };
    }
    return { blocked: true, kind: "other", label: ackReason.slice(0, 80) || ackResult };
  }

  return { blocked: false, kind: null };
}

interface ComputeResult {
  metrics: MarketMetrics;
  staleAsins: HotStaleAsin[];
}

function computeMetrics(
  eligible: any[],
  stockMap: Map<string, boolean>,
  alertedAsins: Set<string>,
  soldAsins: Set<string>,
  now: number,
  oneHourAgo: number,
  todayStartMs: number,
  alertCreatedMap?: Map<string, number>,
): ComputeResult {
  const HOT_GRACE_MS = 30 * 60 * 1000; // 30-min grace for newly-HOT items
  const fifteenMinAgo = now - 15 * 60 * 1000;
  const hotAges: number[] = [];
  const warmAges: number[] = [];
  let hotCount = 0, warmCount = 0;
  let checked1h = 0, checked24h = 0;
  let hotEvaluatedButBlockedCount = 0, hotTrulyStalCount = 0;
  const staleAsins: HotStaleAsin[] = [];
  const subtypes: HotSubtypes = { ...EMPTY_SUBTYPES };
  const hotDispatchableAges: number[] = [];
  const hotBlockedBreakdown: HotBlockedBreakdown = { ...EMPTY_BLOCKED };
  let hotBlockedCount = 0;

  for (const a of eligible) {
    // Use the most recent of last_evaluated_at or last_sp_api_check_at
    // The unified dispatch updates last_evaluated_at; the old scheduler updates last_sp_api_check_at
    const evalTs = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
    const spTs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
    const lastCheck = Math.max(evalTs, spTs);
    const ageMin = lastCheck ? (now - lastCheck) / 60000 : 9999;
    if (lastCheck >= oneHourAgo) checked1h++;
    if (lastCheck >= todayStartMs) checked24h++;

    // Tier classification (US with stock + min_price only)
    if (a.marketplace !== "US" || !a.min_price_override || a.min_price_override <= 0) continue;
    if (!(stockMap.get(a.sku) ?? false)) continue;

    const { starred, bbAlert, losingBb, aboveBbGap, recentChange, isHot } = getHotTraits(a, alertedAsins, now);

    if (isHot) {
      hotCount++;
      // Cap age for newly-HOT items so ancient re-entries don't poison percentiles
      const alertTs = alertCreatedMap?.get(a.asin);
      const hotEntryAgeMin = alertTs ? (now - alertTs) / 60000 : ageMin;
      const effectiveAge = Math.min(ageMin, hotEntryAgeMin);
      // Items stale >24h are "abandoned HOT" — exclude from percentile calculations entirely
      const isAbandoned = effectiveAge > 1440;
      if (!isAbandoned) hotAges.push(effectiveAge);

      // Classify HOT as dispatchable vs blocked based on skip results and stable no-action states.
      const blockedState = getHotBlockedState(a);

      if (blockedState.blocked || isAbandoned) {
        hotBlockedCount++;
        if (isAbandoned) hotBlockedBreakdown.other++;
        else if (blockedState.kind) hotBlockedBreakdown[blockedState.kind]++;
      } else {
        hotDispatchableAges.push(effectiveAge);
      }

      // Track subtypes (item can match multiple, counted once per subtype)
      if (starred) subtypes.starred++;
      if (bbAlert) subtypes.bbAlert++;
      if (losingBb && aboveBbGap >= 5) subtypes.losingBbGap++;
      if (!!recentChange && losingBb) subtypes.competitorMoveLosing++;
    }
    else { warmCount++; warmAges.push(ageMin); }
  }

  hotAges.sort((a, b) => a - b);
  warmAges.sort((a, b) => a - b);
  hotDispatchableAges.sort((a, b) => a - b);

  const hotSlaBreachCount = hotAges.filter(a => a > 30).length;

  // Count HOT items >30m that were recently evaluated but blocked (not truly stale)
  for (const a of eligible) {
    const evalTs = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
    const spTs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
    const lastCheck = Math.max(evalTs, spTs);
    const ageMin = lastCheck ? (now - lastCheck) / 60000 : 9999;
    if (ageMin <= 30) continue; // within SLA, skip

    // Determine if HOT
    if (a.marketplace !== "US" || !a.min_price_override || a.min_price_override <= 0) continue;
    if (!(stockMap.get(a.sku) ?? false)) continue;
    const { isHot } = getHotTraits(a, alertedAsins, now);
    if (!isHot) continue;

    // Was recently evaluated but result was blocked/no-change?
    const wasRecentlyEvaluated = evalTs > 0 && (now - evalTs) / 60000 < 60;
    const blockedState = getHotBlockedState(a);
    const blockedResult = blockedState.blocked || BLOCKED_ACK_RESULTS.has(normalizeText(a.last_ack_result));

    if ((wasRecentlyEvaluated && blockedResult) || blockedState.blocked) {
      hotEvaluatedButBlockedCount++;
    } else {
      // Grace period: if the item only recently became HOT (e.g. new BB alert),
      // don't count ancient timestamps as a true scheduler miss.
      const alertTs = alertCreatedMap?.get(a.asin);
      const hotEntryAge = alertTs ? (now - alertTs) : Infinity;
      const isNewlyHot = hotEntryAge < HOT_GRACE_MS;
      const lastCheckTs = Math.max(evalTs, spTs);
      const isAncientReentry = lastCheckTs > 0 && (now - lastCheckTs) > 24 * 60 * 60 * 1000 && isNewlyHot;
      // NEW: Items stale >24h are "abandoned HOT" — the scheduler clearly lost track.
      // These are NOT active scheduler misses; they're stuck entries that need manual review.
      // Only items stale 30m–24h are real operational "truly stale" misses.
      const isAbandonedHot = lastCheckTs > 0 && (now - lastCheckTs) > 24 * 60 * 60 * 1000;

      if (isNewlyHot || isAncientReentry || isAbandonedHot) {
        // Treat as evaluated-but-blocked (grace period or abandoned, not a real active miss)
        hotEvaluatedButBlockedCount++;
      } else {
        hotTrulyStalCount++;
        const lastCheckDate = lastCheckTs > 0 ? new Date(lastCheckTs).toLocaleString() : "Never";
        const reason = a.last_ack_reason || a.last_ack_result || a.last_skip_reason || "No recent evaluation";
        staleAsins.push({ asin: a.asin, ageMin: Math.round(ageMin), lastCheck: lastCheckDate, reason });
      }
    }
  }

  const hotDispatchableCount = hotDispatchableAges.length;

  return {
    metrics: {
      hotP50: percentile(hotAges, 0.5),
      hotP90: percentile(hotAges, 0.9),
      hotP95: percentile(hotAges, 0.95),
      hotMax: hotAges.length > 0 ? Math.round(hotAges[hotAges.length - 1]) : 0,
      hotSlaBreachCount,
      hotCount,
      hotEvaluatedButBlockedCount,
      hotTrulyStalCount,
      hotDispatchableCount,
      hotBlockedCount,
      hotBlockedBreakdown,
      hotDispatchableP50: percentile(hotDispatchableAges, 0.5),
      hotDispatchableP90: percentile(hotDispatchableAges, 0.9),
      hotSubtypes: subtypes,
      warmP50: percentile(warmAges, 0.5),
      warmP90: percentile(warmAges, 0.9),
      warmCount,
      eligibleChecked1h: checked1h,
      eligibleChecked24h: checked24h,
      totalEligible: eligible.length,
    },
    staleAsins,
  };
}

interface EligibleFreshnessPanelProps {
  onMetricsReady?: (metrics: { hotP50: number; hotP90: number; hotCount: number; warmP50: number; warmCount: number; hotSlaBreachCount: number; hotEvaluatedButBlockedCount: number; hotTrulyStalCount: number; hotDispatchableP90: number; hotDispatchableP50: number; hotDispatchableCount: number; hotBlockedCount: number; hotBlockedBreakdown: HotBlockedBreakdown; hotStaleAsins: HotStaleAsin[] }) => void;
}

export default function EligibleFreshnessPanel({ onMetricsReady }: EligibleFreshnessPanelProps = {}) {
  const { user } = useAuth();
  const [data, setData] = useState<FreshnessData>({
    us: EMPTY_METRICS, intl: EMPTY_METRICS, combined: EMPTY_METRICS, loading: true, hotStaleAsins: [],
  });
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState("us");

  const fetchData = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);

    try {
      const PAGE = 1000;
      let allAssignments: any[] = [];
      let page = 0;
      while (true) {
        const { data: rows, error } = await supabase
          .from("repricer_assignments")
          .select("asin, sku, marketplace, status, is_enabled, rule_id, is_priority, last_sp_api_check_at, last_evaluated_at, last_ack_result, last_ack_reason, last_buybox_status, last_applied_price, last_buybox_price, last_price_change_at, min_price_override, last_skip_reason")
          .eq("user_id", user.id)
          .eq("status", "active")
          .eq("is_enabled", true)
          .order("id", { ascending: true })
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (error || !rows || rows.length === 0) break;
        allAssignments = allAssignments.concat(rows);
        if (rows.length < PAGE) break;
        page++;
      }

      const usAsinsWithRule = new Set(
        allAssignments.filter((a: any) => a.marketplace === "US" && a.rule_id).map((a: any) => a.asin)
      );
      const usAsinsAll = new Set(
        allAssignments.filter((a: any) => a.marketplace === "US").map((a: any) => a.asin)
      );
      const hasEffectiveRule = (a: any) =>
        !!a.rule_id || (a.marketplace !== "US" && usAsinsWithRule.has(a.asin));

      const eligible = allAssignments.filter((a: any) => {
        if (!hasEffectiveRule(a)) return false;
        if (a.marketplace !== "US" && !usAsinsAll.has(a.asin)) return false;
        return true;
      });

      const usEligible = eligible.filter((a: any) => a.marketplace === "US");
      const intlEligible = eligible.filter((a: any) => a.marketplace !== "US");

      const { data: invRows } = await supabase
        .from("inventory")
        .select("sku, available, reserved, inbound")
        .eq("user_id", user.id);
      const stockMap = new Map<string, boolean>();
      for (const inv of (invRows || [])) {
        // Match dispatcher eligibility exactly: reserved-only stock is not buyable,
        // so it must not inflate HOT stale metrics.
        stockMap.set(inv.sku, (inv.available || 0) > 0);
      }

      const [alertRes, salesRes] = await Promise.all([
        supabase.from("bb_price_alerts").select("asin, created_at").eq("user_id", user.id).eq("dismissed", false).eq("acted", false),
        supabase.from("asin_sales_daily").select("asin").eq("user_id", user.id).gte("date", new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0]),
      ]);
      const alertedAsins = new Set((alertRes.data || []).map((a: any) => a.asin));
      // Track when each ASIN's earliest active alert was created (HOT entry time)
      const alertCreatedMap = new Map<string, number>();
      for (const al of alertRes.data || []) {
        const ts = new Date((al as any).created_at).getTime();
        const existing = alertCreatedMap.get((al as any).asin);
        if (!existing || ts < existing) alertCreatedMap.set((al as any).asin, ts);
      }
      const soldAsins = new Set((salesRes.data || []).map((s: any) => s.asin));

      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();

      const usResult = computeMetrics(usEligible, stockMap, alertedAsins, soldAsins, now, oneHourAgo, todayStartMs, alertCreatedMap);
      const intlResult = computeMetrics(intlEligible, stockMap, alertedAsins, soldAsins, now, oneHourAgo, todayStartMs, alertCreatedMap);
      const combinedResult = computeMetrics(eligible, stockMap, alertedAsins, soldAsins, now, oneHourAgo, todayStartMs, alertCreatedMap);

      setData({ us: usResult.metrics, intl: intlResult.metrics, combined: combinedResult.metrics, loading: false, hotStaleAsins: usResult.staleAsins });
      onMetricsReady?.({
        hotP50: usResult.metrics.hotP50, hotP90: usResult.metrics.hotP90, hotCount: usResult.metrics.hotCount,
        warmP50: usResult.metrics.warmP50, warmCount: usResult.metrics.warmCount, hotSlaBreachCount: usResult.metrics.hotSlaBreachCount,
        hotEvaluatedButBlockedCount: usResult.metrics.hotEvaluatedButBlockedCount, hotTrulyStalCount: usResult.metrics.hotTrulyStalCount,
        hotDispatchableP90: usResult.metrics.hotDispatchableP90, hotDispatchableP50: usResult.metrics.hotDispatchableP50, hotDispatchableCount: usResult.metrics.hotDispatchableCount, hotBlockedCount: usResult.metrics.hotBlockedCount,
        hotBlockedBreakdown: usResult.metrics.hotBlockedBreakdown,
        hotStaleAsins: usResult.staleAsins,
      });
    } catch (err) {
      console.error("EligibleFreshnessPanel fetch error:", err);
      setData(prev => ({ ...prev, loading: false }));
    } finally {
      setRefreshing(false);
    }
  }, [user, onMetricsReady]);

  useEffect(() => {
    fetchData();
    const __unsub = onMonitorRefresh(fetchData);
    return () => __unsub();
  }, [fetchData]);

  if (data.loading) {
    return (
      <Card className="border-primary/30 bg-background/95 shadow-sm">
        <CardContent className="py-8 flex justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 bg-background/95 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-primary">
          <Activity className="h-5 w-5 text-primary" />
          Eligible Freshness & Rotation
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 w-7 p-0"
            onClick={fetchData}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          HOT / WARM freshness percentiles and rotation velocity — scoped to eligible assignments only
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Market Strategy Banner */}
        <div className="flex flex-wrap gap-3 p-3 rounded-lg border border-primary/20 bg-primary/5">
          <div className="flex items-center gap-2 text-xs font-medium text-primary">
            <Globe className="h-4 w-4" />
            Market Strategy
          </div>
          <div className="flex items-center gap-1.5">
            <Flag className="h-3 w-3 text-primary" />
            <span className="text-xs text-foreground font-medium">🇺🇸 US</span>
            <Badge variant="outline" className="text-[10px] h-5 border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400">Continuous</Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <Flag className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-foreground font-medium">🇨🇦🇲🇽🇧🇷 Intl</span>
            <Badge variant="outline" className="text-[10px] h-5 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">Daily batch (02:00–08:00 CT)</Badge>
          </div>
        </div>

        {/* Segmented Tabs */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full grid grid-cols-3">
            <TabsTrigger value="us" className="text-xs gap-1">
              🇺🇸 US Only
            </TabsTrigger>
            <TabsTrigger value="intl" className="text-xs gap-1">
              🌎 Intl Only
            </TabsTrigger>
            <TabsTrigger value="combined" className="text-xs gap-1">
              All Markets
            </TabsTrigger>
          </TabsList>

          <TabsContent value="us" className="mt-3">
            <MetricsGrid metrics={data.us} marketLabel="US" />
          </TabsContent>
          <TabsContent value="intl" className="mt-3">
            <MetricsGrid metrics={data.intl} marketLabel="Intl" />
          </TabsContent>
          <TabsContent value="combined" className="mt-3">
            <MetricsGrid metrics={data.combined} marketLabel="Combined" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function MetricsGrid({ metrics, marketLabel }: { metrics: MarketMetrics; marketLabel: string }) {
  const items = [
    {
      label: "HOT Freshness p50",
      value: `${metrics.hotP50} min`,
      sub: `${metrics.hotCount} HOT eligible`,
      tooltip: `Median age since last evaluation or SP-API check for HOT-tier eligible ${marketLabel} assignments.`,
      warn: metrics.hotP50 > 15,
      icon: "hot" as const,
    },
    {
      label: "HOT Freshness p90",
      value: `${metrics.hotP90} min`,
      sub: "90th percentile",
      tooltip: `90% of ALL HOT eligible ${marketLabel} assignments (including blocked). See Dispatchable p90 for actionable SLA.`,
      warn: metrics.hotP90 > 60,
      icon: "hot" as const,
    },
    {
      label: "HOT Dispatchable p90",
      value: `${metrics.hotDispatchableP90} min`,
      sub: `${metrics.hotDispatchableCount} dispatchable / ${metrics.hotBlockedCount} blocked`,
      tooltip: `90% of truly dispatchable HOT items (excluding throttled, no-data, inactive) were evaluated within this many minutes. This is your real SLA metric. Target: <30 min.`,
      warn: metrics.hotDispatchableP90 > 30,
      icon: "hot" as const,
    },
    {
      label: "HOT p95 / Max",
      value: `${metrics.hotP95} / ${metrics.hotMax} min`,
      sub: metrics.hotSlaBreachCount > 0
        ? metrics.hotTrulyStalCount > 0
          ? `🔴 ${metrics.hotTrulyStalCount} truly stale (scheduler miss)${metrics.hotEvaluatedButBlockedCount > 0 ? ` · ${metrics.hotEvaluatedButBlockedCount} evaluated but blocked` : ""}`
          : `✅ 0 truly stale · ${metrics.hotEvaluatedButBlockedCount} evaluated but blocked (not a miss)`
        : "All within SLA",
      tooltip: metrics.hotSlaBreachCount > 0
        ? `${metrics.hotSlaBreachCount} HOT items >30m. Truly stale (scheduler missed): ${metrics.hotTrulyStalCount}. Evaluated but blocked by guard/filter: ${metrics.hotEvaluatedButBlockedCount}. Only truly stale items indicate a real problem.`
        : `95th percentile and maximum HOT age. SLA target: no HOT item >30 min.`,
      warn: metrics.hotTrulyStalCount > 0,
      icon: "hot" as const,
    },
    {
      label: "WARM Freshness p50",
      value: `${metrics.warmP50} min`,
      sub: `${metrics.warmCount} WARM eligible`,
      tooltip: `Median age of last SP-API check for WARM-tier eligible ${marketLabel} assignments.`,
      warn: metrics.warmP50 > 120,
      icon: "warm" as const,
    },
    {
      label: "WARM Freshness p90",
      value: `${metrics.warmP90} min`,
      sub: "90th percentile",
      tooltip: `90% of WARM eligible ${marketLabel} assignments were checked within this many minutes.`,
      warn: metrics.warmP90 > 360,
      icon: "warm" as const,
    },
    {
      label: "Eligible Checked (1h)",
      value: `${metrics.eligibleChecked1h}`,
      sub: `of ${metrics.totalEligible} eligible`,
      tooltip: `Unique eligible ${marketLabel} assignments checked in the last hour.`,
      warn: false,
      icon: "activity" as const,
    },
    {
      label: "Eligible Checked (24h)",
      value: `${metrics.eligibleChecked24h}`,
      sub: `${metrics.totalEligible > 0 ? Math.round((metrics.eligibleChecked24h / metrics.totalEligible) * 100) : 0}% of eligible`,
      tooltip: `Unique eligible ${marketLabel} assignments checked today.`,
      warn: marketLabel === "US" && metrics.totalEligible > 0 && (metrics.eligibleChecked24h / metrics.totalEligible) < 0.5,
      icon: "activity" as const,
    },
  ];

  if (metrics.totalEligible === 0) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground">
        No eligible assignments for {marketLabel}
      </div>
    );
  }

  const s = metrics.hotSubtypes;
  const hasSubtypes = metrics.hotCount > 0;
  const b = metrics.hotBlockedBreakdown;
  const hasBlocked = metrics.hotBlockedCount > 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {items.map(m => (
          <Tooltip key={m.label}>
            <TooltipTrigger asChild>
              <div className={`p-3 rounded-lg border cursor-help ${
                m.warn
                  ? "border-amber-500/25 bg-amber-500/5"
                  : "border-primary/15 bg-primary/5"
              }`}>
                <div className="flex items-center gap-1.5 mb-1">
                  {m.icon === "hot" ? (
                    <Zap className="h-3.5 w-3.5 text-red-500" />
                  ) : m.icon === "warm" ? (
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                  ) : (
                    <Activity className="h-3.5 w-3.5 text-primary" />
                  )}
                  <span className="text-xs text-muted-foreground truncate">{m.label}</span>
                  <Info className="h-3 w-3 text-primary/40 shrink-0 ml-auto" />
                </div>
                <div className={`text-lg font-bold ${m.warn ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                  {m.value}
                </div>
                <div className="text-[10px] text-muted-foreground">{m.sub}</div>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs max-w-[260px]">{m.tooltip}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {hasSubtypes && (
        <div className="p-2.5 rounded-lg border border-primary/10 bg-primary/5">
          <div className="text-[10px] font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">HOT Subtype Breakdown</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {s.starred > 0 && <span className="text-foreground">⭐ Starred: <strong>{s.starred}</strong></span>}
            {s.bbAlert > 0 && <span className="text-foreground">🔔 BB Alert: <strong>{s.bbAlert}</strong></span>}
            {s.losingBbGap > 0 && <span className="text-foreground">📉 Losing BB+Gap: <strong>{s.losingBbGap}</strong></span>}
            {s.competitorMoveLosing > 0 && <span className="text-foreground">⚡ Competitor Move: <strong>{s.competitorMoveLosing}</strong></span>}
          </div>
        </div>
      )}

      {hasBlocked && (
        <div className="p-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
          <div className="text-[10px] font-medium text-amber-700 dark:text-amber-400 mb-1.5 uppercase tracking-wider">
            HOT Blocked Breakdown ({metrics.hotBlockedCount} items not dispatchable)
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {b.throttled > 0 && <span className="text-foreground">🚫 SP-API Throttled: <strong>{b.throttled}</strong></span>}
            {b.noData > 0 && <span className="text-foreground">📭 No Offers/Data: <strong>{b.noData}</strong></span>}
            {b.dailyCap > 0 && <span className="text-foreground">⏳ Daily Cap: <strong>{b.dailyCap}</strong></span>}
            {b.inactive > 0 && <span className="text-foreground">💤 Inactive/Not Found: <strong>{b.inactive}</strong></span>}
            {b.bbOwnerStable > 0 && <span className="text-foreground">👑 BB Owner (stable): <strong>{b.bbOwnerStable}</strong></span>}
            {b.floorHeld > 0 && <span className="text-foreground">🛡️ Floor/Lowest Held: <strong>{b.floorHeld}</strong></span>}
            {b.rotatingBb > 0 && <span className="text-foreground">🔄 Rotating BB Hold: <strong>{b.rotatingBb}</strong></span>}
            {b.noGap > 0 && <span className="text-foreground">👁 No Actionable Gap: <strong>{b.noGap}</strong></span>}
            {b.other > 0 && <span className="text-foreground">❓ Other: <strong>{b.other}</strong></span>}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            These items inflate HOT p90 but are not actionable by the scheduler. Dispatchable p90 excludes them.
          </div>
        </div>
      )}
    </div>
  );
}
