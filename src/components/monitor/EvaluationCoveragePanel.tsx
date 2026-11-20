import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Activity, Clock, CheckCircle2, AlertTriangle, PauseCircle, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface AssignmentDetail {
  asin: string;
  sku: string;
  last_sp_api_check_at: string | null;
  reason: string;
}

interface TierMetrics {
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  tier1AvgAge: number | null;
  tier1P50Age: number | null;
  tier1P90Age: number | null;
  tier1MaxAge: number | null;
  tier1Over5min: number;
  tier1Over10min: number;
  tier1Over15min: number;
  tier1Over30min: number;
}

interface CoverageData {
  totalActive: number;
  managedActive: number;
  discoveryActive: number;
  checkedToday: number;
  managedCheckedToday: number;
  coveragePercent: number;
  managedCoveragePercent: number;
  pausedCount: number;
  oldestUnchecked: string | null;
  avgCheckAgeMinutes: number | null;
  oldestCheckAgeMinutes: number | null;
  p95CheckAgeMinutes: number | null;
  estimatedCycleMinutes: number | null;
  uncheckableCount: number;
  uncheckableReasons: Record<string, number>;
  uncheckableItems: AssignmentDetail[];
  uncheckedTodayItems: AssignmentDetail[];
  pausedItems: AssignmentDetail[];
  legacyStaleCount: number;
  skippedReasons: Record<string, number>;
  tierMetrics: TierMetrics | null;
}

type DialogType = "uncheckable" | "unchecked" | "paused" | null;

export default function EvaluationCoveragePanel() {
  const { user } = useAuth();
  const [data, setData] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [dialogType, setDialogType] = useState<DialogType>(null);

  const fetchCoverage = async () => {
    if (!user) return;
    setLoading(true);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      // Helper: paginate large tables
      async function fetchAllAssignments() {
        const PAGE = 1000;
        let all: any[] = [];
        let page = 0;
        while (true) {
          const { data, error } = await supabase
            .from("repricer_assignments")
            .select("id, asin, sku, status, last_sp_api_check_at, paused_reason, is_enabled, rule_id, marketplace, is_priority")
            .eq("user_id", user!.id)
            .order("id", { ascending: true })
            .range(page * PAGE, (page + 1) * PAGE - 1);
          if (error || !data || data.length === 0) break;
          all = all.concat(data);
          if (data.length < PAGE) break;
          page++;
        }
        return all;
      }

      const [assignmentsAll, skipsRes, inventoryRes, alertsRes, salesRes] = await Promise.all([
        fetchAllAssignments(),
        supabase
          .from("repricer_price_actions")
          .select("action_type, reason")
          .eq("action_type", "no_change")
          .gte("created_at", todayISO),
        supabase
          .from("inventory")
          .select("sku, listing_status, available, reserved, inbound")
          .eq("user_id", user.id),
        supabase
          .from("bb_price_alerts")
          .select("asin")
          .eq("user_id", user.id)
          .eq("dismissed", false)
          .gte("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
        supabase
          .from("asin_sales_daily")
          .select("asin")
          .eq("user_id", user.id)
          .gte("date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0])
          .gt("units", 0),
      ]);

      const assignments = assignmentsAll;
      const skips = skipsRes.data || [];

      // Build a set of SKUs with INACTIVE/NOT_FOUND listing status
      const inventoryItems = inventoryRes.data || [];
      const inactiveSkus = new Set(
        inventoryItems
          .filter((i) => i.listing_status === "INACTIVE" || i.listing_status === "NOT_FOUND")
          .map((i) => i.sku)
      );

      const active = assignments.filter((a) => a.status === "active" && !inactiveSkus.has(a.sku));
      const paused = assignments.filter((a) => a.status === "paused_profit_guard" || a.status === "paused");

      // Build US rule inheritance set
      const usAsinsWithRule = new Set(
        active.filter((a) => a.marketplace === "US" && a.rule_id).map((a) => a.asin)
      );
      // Also track which ASINs have a US assignment at all (even without rule)
      const usAsins = new Set(
        active.filter((a) => a.marketplace === "US").map((a) => a.asin)
      );
      const hasEffectiveRule = (a: any) =>
        !!a.rule_id || (a.marketplace !== "US" && usAsinsWithRule.has(a.asin));

      // Detect uncheckable active assignments
      const uncheckableReasons: Record<string, number> = {};
      const uncheckableItems: AssignmentDetail[] = [];
      active.forEach((a) => {
        const reasons: string[] = [];
        if (!a.is_enabled) reasons.push("disabled");
        if (!hasEffectiveRule(a)) {
          // Distinguish: intl item with no US sibling vs genuinely missing rule
          const isIntl = a.marketplace && a.marketplace !== "US";
          const hasUsSibling = isIntl && usAsins.has(a.asin);
          if (isIntl && !hasUsSibling) {
            reasons.push("no_us_listing");
          } else {
            reasons.push("no_rule");
          }
        }
        if (!a.sku) reasons.push("missing_sku");
        if (!a.marketplace) reasons.push("missing_marketplace");
        if (reasons.length > 0) {
          uncheckableItems.push({ asin: a.asin, sku: a.sku || "—", last_sp_api_check_at: a.last_sp_api_check_at, reason: reasons.join(", ") });
        }
        reasons.forEach((r) => { uncheckableReasons[r] = (uncheckableReasons[r] || 0) + 1; });
      });
      const uncheckableCount = uncheckableItems.length;

      // Legacy stale: active assignments with last_sp_api_check_at > 7 days old
      const legacyStaleCount = active.filter(
        (a) => a.last_sp_api_check_at && new Date(a.last_sp_api_check_at) < new Date(sevenDaysAgo)
      ).length;

      const checkedToday = active.filter(
        (a) => a.last_sp_api_check_at && new Date(a.last_sp_api_check_at) >= todayStart
      ).length;

      const coveragePercent = active.length > 0 ? Math.round((checkedToday / active.length) * 100) : 0;

      // Exclude uncheckable items from unchecked list (they're shown separately)
      const uncheckableAsins = new Set(uncheckableItems.map((u) => u.asin));
      const unchecked = active
        .filter((a) => !uncheckableAsins.has(a.asin) && (!a.last_sp_api_check_at || new Date(a.last_sp_api_check_at) < todayStart))
        .sort((a, b) => {
          const aTime = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
          const bTime = b.last_sp_api_check_at ? new Date(b.last_sp_api_check_at).getTime() : 0;
          return aTime - bTime;
        });

      const uncheckedTodayItems: AssignmentDetail[] = unchecked.map((a) => ({
        asin: a.asin,
        sku: a.sku || "—",
        last_sp_api_check_at: a.last_sp_api_check_at,
        reason: !a.last_sp_api_check_at ? "Never checked" : "Not checked today",
      }));

      const pausedItems: AssignmentDetail[] = paused.map((a) => ({
        asin: a.asin,
        sku: a.sku || "—",
        last_sp_api_check_at: a.last_sp_api_check_at,
        reason: a.paused_reason || a.status,
      }));

      const oldestUnchecked = unchecked[0]?.last_sp_api_check_at || null;

      // Age metrics for ACTIVE assignments only
      const checkedItems = active.filter((a) => a.last_sp_api_check_at);
      const ages = checkedItems.map((a) => (Date.now() - new Date(a.last_sp_api_check_at!).getTime()) / 60000);
      ages.sort((a, b) => a - b);

      const avgAge = ages.length > 0 ? ages.reduce((s, v) => s + v, 0) / ages.length : null;
      const oldestAge = ages.length > 0 ? ages[ages.length - 1] : null;
      const p95Age = ages.length >= 2 ? ages[Math.floor(ages.length * 0.95)] : oldestAge;

      const batchSize = 15; // ~15 dispatches per minute cycle (30 API calls / 2 per ASIN)
      const intervalMinutes = 1; // cron runs every minute
      const estimatedCycle = active.length > 0 ? Math.ceil(active.length / batchSize) * intervalMinutes : null;

      const skippedReasons: Record<string, number> = {};
      skips.forEach((s: any) => {
        const reason = s.reason || "unknown";
        let key = "other";
        if (/quota/i.test(reason)) key = "quota";
        else if (/stale|snapshot/i.test(reason)) key = "stale_data";
        else if (/missing|no.*data/i.test(reason)) key = "missing_data";
        else if (/error|failed/i.test(reason)) key = "error";
        else if (/paused|blocked/i.test(reason)) key = "blocked";
        skippedReasons[key] = (skippedReasons[key] || 0) + 1;
      });

      // ── Tier classification for metrics ──
      const alertedAsins = new Set((alertsRes.data || []).map((a: any) => a.asin));
      const sellingAsins = new Set((salesRes.data || []).map((s: any) => s.asin));
      const stockMap = new Map<string, boolean>();
      for (const inv of inventoryItems) {
        const hasStock = (inv.available || 0) > 0 || (inv.reserved || 0) > 0;
        stockMap.set(inv.sku, hasStock);
      }

      const usActive = active.filter((a) => a.marketplace === "US");
      const tier1Items: typeof usActive = [];
      const tier2Items: typeof usActive = [];
      const tier3Items: typeof usActive = [];

      // Fetch assignments with pricing fields for accurate tier classification
      const { data: pricingAssignments } = await supabase
        .from("repricer_assignments")
        .select("asin, last_buybox_status, last_applied_price, last_buybox_price, last_price_change_at")
        .eq("user_id", user.id)
        .in("status", ["active"]);

      const pricingMap = new Map<string, any>();
      for (const pa of pricingAssignments || []) {
        pricingMap.set(pa.asin, pa);
      }

      const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
      const todayStr = new Date().toISOString().split("T")[0];

      // Fetch today's sales for "sold_today" signal (not just 7d)
      const { data: todaySalesData } = await supabase
        .from("asin_sales_daily")
        .select("asin")
        .eq("user_id", user.id)
        .eq("date", todayStr)
        .gt("units", 0);
      const soldTodayAsins = new Set((todaySalesData || []).map((s: any) => s.asin));

      for (const a of active) {
        if (a.marketplace !== "US") {
          tier3Items.push(a);
          continue;
        }
        const hasStock = stockMap.get(a.sku) ?? false;
        if (!hasStock) {
          tier3Items.push(a);
          continue;
        }
        // Match cron-trigger HOT classification exactly
        const pa = pricingMap.get(a.asin);
        const isLosingBb = pa?.last_buybox_status && pa.last_buybox_status !== "winning";
        const priceGap = pa?.last_applied_price && pa?.last_buybox_price
          ? Math.abs(Math.round((pa.last_applied_price) * 100) - Math.round((pa.last_buybox_price) * 100))
          : 0;
        const hasPriceGap = priceGap >= 5; // $0.05
        const recentPriceChange = pa?.last_price_change_at
          ? new Date(pa.last_price_change_at).getTime() > fifteenMinAgo
          : false;
        const soldToday = soldTodayAsins.has(a.asin);
        const isStarred = a.is_priority;
        const hasBbAlert = alertedAsins.has(a.asin);

        const isUrgent = isLosingBb || hasPriceGap || recentPriceChange || soldToday || isStarred || hasBbAlert;
        if (isUrgent) {
          tier1Items.push(a);
        } else {
          tier2Items.push(a);
        }
      }

      // Tier 1 age metrics
      const tier1Ages = tier1Items
        .filter((a) => a.last_sp_api_check_at)
        .map((a) => (Date.now() - new Date(a.last_sp_api_check_at!).getTime()) / 60000)
        .sort((a, b) => a - b);

      const tier1AvgAge = tier1Ages.length > 0 ? tier1Ages.reduce((s, v) => s + v, 0) / tier1Ages.length : null;
      const tier1P50 = tier1Ages.length > 0 ? tier1Ages[Math.floor(tier1Ages.length * 0.5)] : null;
      const tier1P90 = tier1Ages.length > 0 ? tier1Ages[Math.floor(tier1Ages.length * 0.9)] : null;
      const tier1Max = tier1Ages.length > 0 ? tier1Ages[tier1Ages.length - 1] : null;

      const tierMetrics: TierMetrics = {
        tier1Count: tier1Items.length,
        tier2Count: tier2Items.length,
        tier3Count: tier3Items.length,
        tier1AvgAge: tier1AvgAge != null ? Math.round(tier1AvgAge) : null,
        tier1P50Age: tier1P50 != null ? Math.round(tier1P50) : null,
        tier1P90Age: tier1P90 != null ? Math.round(tier1P90) : null,
        tier1MaxAge: tier1Max != null ? Math.round(tier1Max) : null,
        tier1Over5min: tier1Ages.filter((a) => a > 5).length,
        tier1Over10min: tier1Ages.filter((a) => a > 10).length,
        tier1Over15min: tier1Ages.filter((a) => a > 15).length,
        tier1Over30min: tier1Ages.filter((a) => a > 30).length,
      };

      // Managed = has effective rule; Discovery = no rule & no US sibling (intl orphan)
      const managed = active.filter((a) => hasEffectiveRule(a));
      const discovery = active.filter((a) => !hasEffectiveRule(a));
      const managedChecked = managed.filter(
        (a) => a.last_sp_api_check_at && new Date(a.last_sp_api_check_at) >= todayStart
      ).length;
      const managedCoveragePct = managed.length > 0 ? Math.round((managedChecked / managed.length) * 100) : 0;

      setData({
        totalActive: active.length,
        managedActive: managed.length,
        discoveryActive: discovery.length,
        checkedToday,
        managedCheckedToday: managedChecked,
        coveragePercent,
        managedCoveragePercent: managedCoveragePct,
        pausedCount: paused.length,
        oldestUnchecked,
        avgCheckAgeMinutes: avgAge != null ? Math.round(avgAge) : null,
        oldestCheckAgeMinutes: oldestAge != null ? Math.round(oldestAge) : null,
        p95CheckAgeMinutes: p95Age != null ? Math.round(p95Age) : null,
        estimatedCycleMinutes: estimatedCycle,
        uncheckableCount,
        uncheckableReasons,
        uncheckableItems,
        uncheckedTodayItems,
        pausedItems,
        legacyStaleCount,
        skippedReasons,
        tierMetrics,
      });
    } catch (err) {
      console.error("Coverage fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCleanupLegacy = async () => {
    if (!user) return;
    setCleaning(true);
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      // Set stale timestamps to NULL so they get priority (NULLS FIRST in scheduler)
      const { error, count } = await supabase
        .from("repricer_assignments")
        .update({ last_sp_api_check_at: null })
        .eq("user_id", user.id)
        .in("status", ["active"])
        .lt("last_sp_api_check_at", sevenDaysAgo);

      if (error) throw error;
      toast.success(`Reset ${count ?? 0} legacy timestamps — they'll get priority in the next cycle`);
      fetchCoverage();
    } catch (err) {
      console.error("Cleanup error:", err);
      toast.error("Failed to cleanup legacy timestamps");
    } finally {
      setCleaning(false);
    }
  };

  useEffect(() => {
    fetchCoverage();
    const __unsub = onMonitorRefresh(fetchCoverage);
    return () => __unsub();
  }, [user]);

  if (loading || !data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">Loading coverage data...</CardContent>
      </Card>
    );
  }

  const totalSkips = Object.values(data.skippedReasons).reduce((a, b) => a + b, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Evaluation Coverage
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchCoverage}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Main coverage bar — ELIGIBLE universe (rule + min_price + active + enabled) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium">
              🎯 Eligible Coverage (today): {data.managedCheckedToday} / {data.managedActive}
              <span className="text-[10px] text-muted-foreground ml-1 font-normal">(rule + min_price + active + enabled)</span>
            </span>
            <span className="text-sm font-bold text-primary">{data.managedCoveragePercent}%</span>
          </div>
          <Progress value={data.managedCoveragePercent} className="h-3" />
        </div>

        {/* Raw coverage bar — all active assignments */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground">
              Total Active (today): {data.checkedToday} / {data.totalActive} <span className="text-[10px]">(all active assignments incl. disabled & no-rule)</span>
              {data.discoveryActive > 0 && (
                <span className="ml-1 text-muted-foreground/60">
                  ({data.discoveryActive} discovery/orphan intl)
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{data.coveragePercent}%</span>
          </div>
          <Progress value={data.coveragePercent} className="h-2" />
        </div>

        {/* Tier Distribution */}
        {data.tierMetrics && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium flex items-center gap-1.5">
              🎯 Priority Tiers
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded border bg-red-500/10 p-2 text-center">
                <div className="text-xs text-muted-foreground">T1 HOT</div>
                <div className="text-lg font-bold">{data.tierMetrics.tier1Count}</div>
                <div className="text-[10px] text-muted-foreground">in-stock + urgency</div>
              </div>
              <div className="rounded border bg-yellow-500/10 p-2 text-center">
                <div className="text-xs text-muted-foreground">T2 WARM</div>
                <div className="text-lg font-bold">{data.tierMetrics.tier2Count}</div>
                <div className="text-[10px] text-muted-foreground">in-stock, stable</div>
              </div>
              <div className="rounded border bg-blue-500/10 p-2 text-center">
                <div className="text-xs text-muted-foreground">T3 COLD</div>
                <div className="text-lg font-bold">{data.tierMetrics.tier3Count}</div>
                <div className="text-[10px] text-muted-foreground">no stock / intl</div>
              </div>
            </div>
            {/* T1 freshness metrics */}
            {data.tierMetrics.tier1Count > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Tier 1 Check Freshness</div>
                <div className="grid grid-cols-4 gap-1.5 text-xs">
                  <div className="rounded border p-1.5 text-center">
                    <div className="text-muted-foreground">p50</div>
                    <div className="font-bold">{data.tierMetrics.tier1P50Age ?? "—"}m</div>
                  </div>
                  <div className="rounded border p-1.5 text-center">
                    <div className="text-muted-foreground">p90</div>
                    <div className="font-bold">{data.tierMetrics.tier1P90Age ?? "—"}m</div>
                  </div>
                  <div className="rounded border p-1.5 text-center">
                    <div className="text-muted-foreground">max</div>
                    <div className="font-bold">{data.tierMetrics.tier1MaxAge ?? "—"}m</div>
                  </div>
                  <div className="rounded border p-1.5 text-center">
                    <div className="text-muted-foreground">avg</div>
                    <div className="font-bold">{data.tierMetrics.tier1AvgAge ?? "—"}m</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[10px]">&gt;5m: {data.tierMetrics.tier1Over5min}</Badge>
                  <Badge variant="outline" className="text-[10px]">&gt;10m: {data.tierMetrics.tier1Over10min}</Badge>
                  <Badge variant="outline" className="text-[10px]">&gt;15m: {data.tierMetrics.tier1Over15min}</Badge>
                  <Badge variant={data.tierMetrics.tier1Over30min > 0 ? "destructive" : "outline"} className="text-[10px]">
                    &gt;30m: {data.tierMetrics.tier1Over30min}
                  </Badge>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Evaluated Today
            </div>
            <div className="text-xl font-bold">{data.checkedToday}</div>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Clock className="h-3.5 w-3.5" />
              Avg Check Age
            </div>
            <div className="text-xl font-bold">
              {data.avgCheckAgeMinutes != null ? `${data.avgCheckAgeMinutes}m` : "—"}
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              Oldest Check Age
            </div>
            <div className="text-xl font-bold">
              {data.oldestCheckAgeMinutes != null ? `${data.oldestCheckAgeMinutes}m` : "—"}
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Activity className="h-3.5 w-3.5" />
              P95 Check Age
            </div>
            <div className="text-xl font-bold">
              {data.p95CheckAgeMinutes != null ? `${data.p95CheckAgeMinutes}m` : "—"}
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Clock className="h-3.5 w-3.5" />
              Est. Full Cycle
            </div>
            <div className="text-xl font-bold">
              {data.estimatedCycleMinutes != null ? `${data.estimatedCycleMinutes}m` : "—"}
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <PauseCircle className="h-3.5 w-3.5" />
              Paused
            </div>
            <div
              className={`text-xl font-bold ${data.pausedCount > 0 ? "cursor-pointer underline decoration-dotted" : ""}`}
              onClick={() => data.pausedCount > 0 && setDialogType("paused")}
            >
              {data.pausedCount}
            </div>
          </div>
        </div>

        {/* Uncheckable active assignments — clickable */}
        {data.uncheckableCount > 0 && (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 cursor-pointer hover:bg-destructive/10 transition-colors"
            onClick={() => setDialogType("uncheckable")}
          >
            <div className="text-sm font-medium text-destructive mb-1.5">
              ⚠ {data.uncheckableCount} Active but Not Checkable — click to view
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.uncheckableReasons).map(([key, count]) => (
                <Badge key={key} variant="outline" className="text-xs border-destructive/30">
                  {key.replace(/_/g, " ")}: {count}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Not checked today — clickable */}
        {data.uncheckedTodayItems.length > 0 && (
          <div
            className="rounded-lg border border-muted-foreground/20 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={() => setDialogType("unchecked")}
          >
            <div className="text-sm font-medium text-muted-foreground">
              🔍 {data.uncheckedTodayItems.length} Not Checked Today — click to view
            </div>
          </div>
        )}

        {/* Legacy stale cleanup */}
        {data.legacyStaleCount > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <div className="text-sm">
              <span className="font-medium text-destructive">
                {data.legacyStaleCount} assignments
              </span>
              <span className="text-muted-foreground"> with check timestamps older than 7 days (poisoning averages)</span>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleCleanupLegacy} 
              disabled={cleaning}
              className="shrink-0 ml-2"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {cleaning ? "Cleaning..." : "Reset Legacy"}
            </Button>
          </div>
        )}

        {/* Skip breakdown — from evaluated actions, NOT unchecked assignments */}
        {totalSkips > 0 && (
          <div className="rounded-lg border p-3 space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              📊 Today's Evaluation Skip Reasons ({totalSkips} no-change actions)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.skippedReasons).map(([key, count]) => (
                <Badge key={key} variant="outline" className="text-xs">
                  {key.replace(/_/g, " ")}: {count}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Oldest unchecked */}
        {data.oldestUnchecked && (
          <div className="text-xs text-muted-foreground">
            Oldest unchecked: {formatDistanceToNow(new Date(data.oldestUnchecked), { addSuffix: true })}
          </div>
        )}
      </CardContent>

      {/* Detail Dialog */}
      <Dialog open={dialogType !== null} onOpenChange={(open) => !open && setDialogType(null)}>
        <DialogContent className="max-w-2xl max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialogType === "uncheckable" && `Active but Not Checkable (${data.uncheckableItems.length})`}
              {dialogType === "unchecked" && `Not Checked Today (${data.uncheckedTodayItems.length})`}
              {dialogType === "paused" && `Paused Assignments (${data.pausedItems.length})`}
            </DialogTitle>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ASIN</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Last Checked</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(dialogType === "uncheckable" ? data.uncheckableItems :
                dialogType === "unchecked" ? data.uncheckedTodayItems :
                dialogType === "paused" ? data.pausedItems : []
              ).map((item, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{item.asin}</TableCell>
                  <TableCell className="font-mono text-xs">{item.sku}</TableCell>
                  <TableCell className="text-xs">
                    {item.last_sp_api_check_at
                      ? formatDistanceToNow(new Date(item.last_sp_api_check_at), { addSuffix: true })
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-xs">{item.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
