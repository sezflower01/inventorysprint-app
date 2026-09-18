import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Users } from "lucide-react";
import type { MonitorData, QuotaTimeWindow } from "@/hooks/use-monitor-data";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

// Unified command block replaces CommandBar + SmartSummary + StatusStrips
import RepricerCommandBlock, { type FreshnessMetrics } from "./RepricerCommandBlock";
import RepricerHealthScore from "./RepricerHealthScore";

// Action Queue components
import SetupIncompletePanel from "./SetupIncompletePanel";
import StalledAsinsPanel from "./StalledAsinsPanel";
import SkippedAsinWorkQueue from "./SkippedAsinWorkQueue";

// Diagnostics components
import SafeModeRecoveryPanel from "./SafeModeRecoveryPanel";
import RecoveryTrendCards from "./RecoveryTrendCards";
import SafeModePanel from "./SafeModePanel";
import HealthSummaryCards from "./HealthSummaryCards";
import OscillationStatusPanel from "./OscillationStatusPanel";
import BuyBoxWinsPanel from "./BuyBoxWinsPanel";
import EvaluationCoveragePanel from "./EvaluationCoveragePanel";
import ReconciliationDetailPanel from "./ReconciliationDetailPanel";
import DailyChecklist from "./DailyChecklist";
import FeedSubmissionsTable from "./FeedSubmissionsTable";
import MismatchSkusTable from "./MismatchSkusTable";
import EscalationPanel from "./EscalationPanel";
import QuotaHealthPanel from "./QuotaHealthPanel";
import EdgeFunctionDiagnosticsPanel from "./EdgeFunctionDiagnosticsPanel";
import EligibleFreshnessPanel from "./EligibleFreshnessPanel";
import UniverseSegmentationPanel from "./UniverseSegmentationPanel";
import MetricValidationPanel from "./MetricValidationPanel";
import WriteBlockDiagnosticsPanel from "./WriteBlockDiagnosticsPanel";
import CompetitorFilterShadowPanel from "./CompetitorFilterShadowPanel";
import DispatchRecoveryProofPanel from "./DispatchRecoveryProofPanel";
import MonitorActionNeeded from "./MonitorActionNeeded";

interface Props {
  monitorData: MonitorData;
  marketplace: string;
  logLinks: { label: string; fn: string }[];
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-1 mt-6 mb-3">
      {title}
    </h3>
  );
}

export default function MonitorTabLayout({ monitorData, marketplace, logLinks }: Props) {
  const { user } = useAuth();
  const [freshnessData, setFreshnessData] = useState<FreshnessMetrics | null>(null);
  const [stalledCount, setStalledCount] = useState(0);
  const [missingMinCount, setMissingMinCount] = useState(0);
  const [floorBlockedManualCount, setFloorBlockedManualCount] = useState(0);
  const [floorBlockedAutoCount, setFloorBlockedAutoCount] = useState(0);
  const [writes24h, setWrites24h] = useState(0);
  const [timeWindow, setTimeWindow] = useState<QuotaTimeWindow>("24h");
  const [activeUserCount, setActiveUserCount] = useState(0);
  const [subscriberDetails, setSubscriberDetails] = useState<Array<{ email: string; status: string; plan: string; repricerOn: boolean; amazonConnected: boolean }>>([]);
  const [showSubscribers, setShowSubscribers] = useState(false);
  const [blockerBuckets, setBlockerBuckets] = useState<{
    profitGuard: number; minFloor: number; noCompetitors: number; deltaTooSmall: number; cooldown: number; bbOwnerHold: number;
  }>({ profitGuard: 0, minFloor: 0, noCompetitors: 0, deltaTooSmall: 0, cooldown: 0, bbOwnerHold: 0 });

  const fetchCounts = useCallback(async () => {
    if (!user) return;
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const [stalledRes, missingMinRes, writesRes, acksRes] = await Promise.all([
        supabase
          .from("repricer_assignments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("status", "active")
          .eq("is_enabled", true)
          .not("last_recommendation_reason", "is", null)
          .ilike("last_recommendation_reason", "%constrained_by%"),
        supabase
          .from("repricer_assignments")
          .select("asin")
          .eq("user_id", user.id)
          .eq("status", "active")
          .eq("is_enabled", true)
          .not("rule_id", "is", null)
          .or("min_price_override.is.null,min_price_override.lte.0")
          .eq("marketplace", "US"),
        supabase
          .from("repricer_eval_acks")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("result", "changed")
          .gte("acked_at", twentyFourHoursAgo),
        supabase
          .from("repricer_eval_acks")
          .select("result, reason, constraint_applied")
          .eq("user_id", user.id)
          .neq("result", "changed")
          .gte("acked_at", twentyFourHoursAgo)
          .limit(2000),
      ]);

      setStalledCount(stalledRes.count || 0);

      // Filter missing-min ASINs: exclude items with zero sellable stock or INACTIVE/NOT_IN_CATALOG listings
      const rawMissingAsins = [...new Set((missingMinRes.data || []).map((r: any) => r.asin))];
      if (rawMissingAsins.length > 0) {
        const { data: invRows } = await supabase
          .from("inventory")
          .select("asin, available, reserved, listing_status")
          .eq("user_id", user.id)
          .in("asin", rawMissingAsins);
        const invMap = new Map((invRows || []).map((r: any) => [r.asin, r]));
        const filteredMissing = rawMissingAsins.filter((asin) => {
          const inv = invMap.get(asin);
          if (!inv) return false; // no inventory record = not actionable
          const sellable = (inv.available || 0) + (inv.reserved || 0);
          if (sellable <= 0) return false;
          const badStatuses = ["INACTIVE", "NOT_IN_CATALOG", "DELETED", "NOT_FOUND"];
          if (badStatuses.includes(inv.listing_status)) return false;
          return true;
        });
        setMissingMinCount(filteredMissing.length);
      } else {
        setMissingMinCount(0);
      }
      setWrites24h(writesRes.count || 0);

      // Classify blocker buckets from eval acks
      const acks = acksRes.data || [];
      const buckets = { profitGuard: 0, minFloor: 0, noCompetitors: 0, deltaTooSmall: 0, cooldown: 0, bbOwnerHold: 0 };
      for (const ack of acks) {
        const r = ((ack as any).reason || "").toLowerCase();
        const c = ((ack as any).constraint_applied || "").toLowerCase();
        if (r.includes("profit guard") || c.includes("profit_guard") || c.includes("roi_guard")) buckets.profitGuard++;
        else if (r.includes("at floor") || r.includes("micro-step blocked by floor") || c.includes("min_price") || c.includes("min bound")) buckets.minFloor++;
        else if (r.includes("no eligible competitors")) buckets.noCompetitors++;
        else if (r.includes("cooldown") || r.includes("monopoly cooldown")) buckets.cooldown++;
        else if (r.includes("buy box owner protection") || r.includes("buy box suppressed")) buckets.bbOwnerHold++;
        else if (r.includes("price change too small") || r.includes("delta too small")) buckets.deltaTooSmall++;
      }
      setBlockerBuckets(buckets);

      // Fetch floor-blocked assignments split by auto-floor status
      // Mirrors repricer-auto-lower-min (2026-09-18): coverage comes from the
      // RULE (auto_lower_min_marketplaces), and the limit is the rule's drops
      // per UTC day plus the 30% total cap -- no longer "5 drops ever" or the
      // per-assignment flag. Keep in step with the worker.
      const { data: floorBlockedRows } = await supabase
        .from("repricer_assignments")
        .select("asin, marketplace, auto_floor_drop_day, auto_floor_drops_on_day, manual_min_price, min_price_override, rule_id")
        .eq("user_id", user.id)
        .eq("is_enabled", true)
        .eq("status", "active")
        .ilike("last_recommendation_reason", "%floor%")
        .limit(500);

      const floorRuleIds = [...new Set((floorBlockedRows || []).map((r) => r.rule_id).filter((id): id is string => !!id))];
      const { data: floorRules } = floorRuleIds.length
        ? await supabase
            .from("repricer_rules")
            .select("id, auto_lower_min_marketplaces, auto_lower_min_max_drops_per_day")
            .in("id", floorRuleIds)
        : { data: [] as Array<{ id: string; auto_lower_min_marketplaces: string[]; auto_lower_min_max_drops_per_day: number }> };
      const floorRuleBy = new Map((floorRules || []).map((r) => [r.id, r]));
      const todayUtc = new Date().toISOString().slice(0, 10);

      let manualNeeded = 0;
      let autoHandling = 0;
      for (const row of floorBlockedRows || []) {
        const rule = row.rule_id ? floorRuleBy.get(row.rule_id) : undefined;
        const autoEnabled = !!rule && (rule.auto_lower_min_marketplaces ?? []).includes(row.marketplace);
        const dropsToday = row.auto_floor_drop_day === todayUtc ? Number(row.auto_floor_drops_on_day || 0) : 0;
        const maxPerDay = Number(rule?.auto_lower_min_max_drops_per_day ?? 3);
        const manualMin = row.manual_min_price;
        const currentMin = row.min_price_override;
        const maxDropPct = 30;
        let totalDropPct = 0;
        if (manualMin != null && manualMin > 0 && currentMin != null) {
          totalDropPct = Math.round(((manualMin - Number(currentMin)) / manualMin) * 100);
        }
        const isExhausted = dropsToday >= maxPerDay || totalDropPct >= maxDropPct;
        if (!autoEnabled || isExhausted) {
          manualNeeded++;
        } else {
          autoHandling++;
        }
      }
      setFloorBlockedManualCount(manualNeeded);
      setFloorBlockedAutoCount(autoHandling);

      // Fetch active subscribers (user_subscriptions + admin overrides)
      const [subRes, overrideRes] = await Promise.all([
        supabase.from("user_subscriptions").select("user_id, status, plan_id").in("status", ["active", "trialing", "past_due"]).limit(500),
        supabase.from("admin_subscription_override").select("user_id, override_enabled, override_plan_id").eq("override_enabled", true).limit(100),
      ]);

      const uniqueMap = new Map<string, { status: string; plan: string }>();
      (subRes.data || []).forEach((r: any) => {
        if (!uniqueMap.has(r.user_id)) {
          uniqueMap.set(r.user_id, { status: r.status, plan: r.plan_id || "unknown" });
        }
      });
      // Add admin overrides that aren't already in subscriptions
      (overrideRes.data || []).forEach((r: any) => {
        if (!uniqueMap.has(r.user_id)) {
          uniqueMap.set(r.user_id, { status: "override", plan: r.override_plan_id || "admin" });
        }
      });

      setActiveUserCount(uniqueMap.size);

      if (uniqueMap.size > 0) {
        const userIds = Array.from(uniqueMap.keys());
        const [profilesRes, settingsRes, syncRes, chatRes, errorRes] = await Promise.all([
          supabase.from("profiles").select("id, email").in("id", userIds),
          supabase.from("repricer_settings").select("user_id, scheduler_enabled").in("user_id", userIds),
          supabase.from("user_sync_status").select("user_id, amazon_connected").in("user_id", userIds),
          supabase.from("chat_sessions").select("user_id, user_email").in("user_id", userIds).not("user_email", "is", null).limit(100),
          supabase.from("error_reports").select("user_id, user_email").in("user_id", userIds).not("user_email", "is", null).limit(100),
        ]);

        const emailMap = new Map<string, string>();
        // Priority 1: profiles
        (profilesRes.data || []).forEach((p: any) => {
          if (p.email) emailMap.set(p.id, p.email);
        });
        // Priority 2: chat sessions (for users without profile)
        (chatRes.data || []).forEach((c: any) => {
          if (c.user_email && !emailMap.has(c.user_id)) emailMap.set(c.user_id, c.user_email);
        });
        // Priority 3: error reports
        (errorRes.data || []).forEach((e: any) => {
          if (e.user_email && !emailMap.has(e.user_id)) emailMap.set(e.user_id, e.user_email);
        });

        const repricerMap = new Map<string, boolean>();
        (settingsRes.data || []).forEach((s: any) => repricerMap.set(s.user_id, s.scheduler_enabled));
        const amazonMap = new Map<string, boolean>();
        (syncRes.data || []).forEach((s: any) => amazonMap.set(s.user_id, s.amazon_connected));

        // For users without profile email, use the current user's email if it's them
        const details = userIds.map(uid => ({
          email: emailMap.get(uid) || (uid === user?.id ? (user?.email || "admin") : uid.slice(0, 8) + "…"),
          status: uniqueMap.get(uid)?.status || "unknown",
          plan: uniqueMap.get(uid)?.plan || "unknown",
          repricerOn: repricerMap.get(uid) ?? false,
          amazonConnected: amazonMap.get(uid) ?? false,
        }));
        setSubscriberDetails(details);
      } else {
        setSubscriberDetails([]);
      }
    } catch (err) {
      console.error("Monitor count fetch error:", err);
    }
  }, [user]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  const notCheckedTodayCount = monitorData.quotaHealth.eligibleAssignments - monitorData.quotaHealth.checkedEligibleToday;

  return (
    <div className="space-y-4">
      {/* ═══ UNIFIED COMMAND BLOCK + ACTIVE USERS ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <RepricerCommandBlock
          data={monitorData}
          freshnessData={freshnessData ?? undefined}
          stalledCount={stalledCount}
          missingMinCount={missingMinCount}
          writes24h={writes24h}
          blockerBuckets={blockerBuckets}
        />

        <Card className="border-border bg-card/80 shadow-sm cursor-pointer" onClick={() => setShowSubscribers(!showSubscribers)}>
          <CardContent className="py-5 px-5 flex flex-col items-center justify-center h-full gap-3">
            <Users className="h-8 w-8 text-primary" />
            <div className="text-center">
              <div className="text-3xl font-bold text-foreground">{activeUserCount}</div>
              <div className="text-xs text-muted-foreground mt-1">Active Subscribers</div>
            </div>
            <Badge variant="outline" className={`text-[10px] ${activeUserCount >= 10 ? "text-red-400 border-red-500/40 bg-red-500/10" : activeUserCount >= 3 ? "text-amber-400 border-amber-500/40 bg-amber-500/10" : "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"}`}>
              {activeUserCount >= 10 ? "🔴 High Capacity" : activeUserCount >= 3 ? "🟠 Growing" : "🟢 Normal"}
            </Badge>
          </CardContent>
        </Card>
      </div>

      {/* ═══ SUBSCRIBER DETAILS (expandable) ═══ */}
      {showSubscribers && subscriberDetails.length > 0 && (
        <Card className="border-border bg-card/80 shadow-sm">
          <CardContent className="py-4 px-4">
            <div className="text-xs font-semibold text-muted-foreground uppercase mb-3">Subscriber Details</div>
            <div className="space-y-2">
              {subscriberDetails.map((sub, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-xs border border-border rounded-md px-3 py-2 bg-background">
                  <span className="font-medium text-foreground min-w-[180px]">{sub.email}</span>
                  <Badge variant="outline" className={`text-[10px] ${sub.status === 'active' ? 'text-emerald-400 border-emerald-500/40' : sub.status === 'trialing' ? 'text-blue-400 border-blue-500/40' : 'text-amber-400 border-amber-500/40'}`}>
                    {sub.status}
                  </Badge>
                  <span className="text-muted-foreground">Plan: <span className="text-foreground font-medium">{sub.plan}</span></span>
                  <Badge variant="outline" className={`text-[10px] ${sub.repricerOn ? 'text-emerald-400 border-emerald-500/40' : 'text-red-400 border-red-500/40'}`}>
                    Repricer: {sub.repricerOn ? 'ON' : 'OFF'}
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] ${sub.amazonConnected ? 'text-emerald-400 border-emerald-500/40' : 'text-red-400 border-red-500/40'}`}>
                    Amazon: {sub.amazonConnected ? 'connected' : 'disconnected'}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ HEALTH SCORE ═══ */}
      <RepricerHealthScore
        data={monitorData}
        freshnessData={freshnessData ?? undefined}
        missingMinCount={missingMinCount}
        writes24h={writes24h}
        blockerBuckets={blockerBuckets}
        quotaTimeWindow={timeWindow}
      />

      {/* ═══ OVERVIEW ═══ */}
      <SectionHeader title="Overview" />

      <MonitorActionNeeded
        data={monitorData}
        freshnessData={freshnessData ?? undefined}
        stalledCount={stalledCount}
        missingMinCount={missingMinCount}
        notCheckedTodayCount={Math.max(0, notCheckedTodayCount)}
        floorBlockedManualCount={floorBlockedManualCount}
        floorBlockedAutoCount={floorBlockedAutoCount}
        timeWindow={timeWindow}
        onTimeWindowChange={setTimeWindow}
        onNavigate={(section) => {
          const el = document.getElementById(`monitor-section-${section}`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onRefresh={() => window.location.reload()}
      />

      <div id="monitor-section-freshness"><EligibleFreshnessPanel onMetricsReady={setFreshnessData} /></div>
      <UniverseSegmentationPanel data={monitorData.quotaHealth} />
      <MetricValidationPanel data={monitorData.quotaHealth} />

      {/* ═══ ACTION QUEUE ═══ */}
      <SectionHeader title="Action Queue" />
      <div id="monitor-section-setup"><SetupIncompletePanel marketplace={marketplace} /></div>
      <div id="monitor-section-stalled"><StalledAsinsPanel /></div>
      <SkippedAsinWorkQueue />

      {/* ═══ DIAGNOSTICS ═══ */}
      <SectionHeader title="Diagnostics" />
      <DispatchRecoveryProofPanel />

      {/* Log Links */}
      <Card className="border-primary/20 bg-background/95 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-primary">
            <ExternalLink className="h-4 w-4 text-primary" />
            Supabase Log Quick Links
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {logLinks.map(({ label, fn }) => (
              <Button
                key={fn}
                variant="outline"
                size="sm"
                className="h-7 gap-1 border-primary/20 bg-primary/5 text-xs hover:bg-primary/10"
                asChild
              >
                <a
                  href={`https://supabase.com/dashboard/project/mstibdszibcheodvnprm/functions/${fn}/logs`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <WriteBlockDiagnosticsPanel />
      <CompetitorFilterShadowPanel />
      <SafeModeRecoveryPanel />
      <RecoveryTrendCards />
      <div id="monitor-section-health"><HealthSummaryCards data={monitorData} /></div>
      <SafeModePanel />
      <OscillationStatusPanel />
      <BuyBoxWinsPanel />
      <div id="monitor-section-coverage"><EvaluationCoveragePanel /></div>
      <ReconciliationDetailPanel />
      <DailyChecklist data={monitorData} />
      <FeedSubmissionsTable />
      <MismatchSkusTable />
      <EscalationPanel data={monitorData} />
      <div id="monitor-section-quota"><QuotaHealthPanel data={monitorData.quotaHealth} /></div>
      <EdgeFunctionDiagnosticsPanel />
    </div>
  );
}
