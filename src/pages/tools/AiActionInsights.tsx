import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Brain, Search, Filter, RefreshCw, Shield, TrendingDown, TrendingUp,
  AlertTriangle, CheckCircle2, Sparkles, Eye, Zap
} from "lucide-react";
import { toast } from "sonner";
import AiInsightsCard, { type AiInsightEvent } from "@/components/repricer/AiInsightsCard";
import AiInsightsLiveState, {
  type LiveAiSchedulerState,
  type LiveAiStateItem,
} from "@/components/repricer/AiInsightsLiveState";
import { subDays } from "date-fns";

export default function AiActionInsights() {
  const { user } = useAuth();
  const [events, setEvents] = useState<AiInsightEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [aiReviewedOnly, setAiReviewedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<"recent" | "ai_first">("recent");
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [signalMap, setSignalMap] = useState<Record<string, { bb_loss: number; raised: number; constrained: number; winner: number }>>({});
  const [liveStateItems, setLiveStateItems] = useState<LiveAiStateItem[]>([]);
  const [schedulerState, setSchedulerState] = useState<LiveAiSchedulerState | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);
  // Cooldown: prevent abuse / runaway LLM cost. 5-minute window per browser session.
  const REVIEW_COOLDOWN_MS = 5 * 60 * 1000;
  const [lastReviewAt, setLastReviewAt] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem("ai_review_last_run_at");
      return raw ? Number(raw) : null;
    } catch { return null; }
  });
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  // Tick the cooldown countdown every second so the button label updates live.
  useEffect(() => {
    if (!lastReviewAt) { setCooldownRemaining(0); return; }
    const tick = () => {
      const remaining = Math.max(0, REVIEW_COOLDOWN_MS - (Date.now() - lastReviewAt));
      setCooldownRemaining(remaining);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [lastReviewAt]);

  // Check admin
  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  const fetchData = useCallback(async (isBackground = false) => {
    if (!user) return;
    if (!isBackground) setLoading(true);
    try {
      const since7d = subDays(new Date(), 7).toISOString();
      const since14d = subDays(new Date(), 14).toISOString();

      // Fetch:
      //  - per-decision real-time log (repricer_ai_decisions): authoritative decision feed
      //  - aggregated signals (smart_engine_activity_events): used for 7d signal counts
      //  - live assignment snapshot + recent actions for the live state header
      //  - recent Gemini reviews (smart_engine_ai_reviews): used to upgrade the
      //    "Pricing engine decision" badge to "AI-observed by Gemini …" when a
      //    fresh review exists for the same ASIN.
      const sinceReviews = subDays(new Date(), 2).toISOString(); // 48h freshness window
      const [decisionsRes, signalsRes, liveAssignmentsRes, recentActionsRes, schedulerRes, reviewsRes] = await Promise.all([
        supabase
          .from("repricer_ai_decisions")
          .select("*")
          .eq("user_id", user.id)
          .gte("created_at", since14d)
          .order("created_at", { ascending: false })
          .limit(500),
        supabase
          .from("smart_engine_activity_events")
          .select("asin, event_type")
          .eq("user_id", user.id)
          .gte("created_at", since7d)
          .limit(1000),
        supabase
          .from("repricer_assignments")
          .select("asin, last_evaluated_at, last_applied_price, last_recommended_price, last_buybox_price, last_recommendation_reason, last_trigger_source")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .not("last_evaluated_at", "is", null)
          .order("last_evaluated_at", { ascending: false })
          .limit(6),
        supabase
          .from("repricer_price_actions")
          .select("asin, action_type, created_at, new_price, old_price, trigger_source")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("live_verify_schedule")
          .select("is_enabled, is_running, last_run_at, next_run_at")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("smart_engine_ai_reviews")
          .select("asin, model_tier, model_used, created_at")
          .eq("user_id", user.id)
          .gte("created_at", sinceReviews)
          .not("model_tier", "is", null)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);

      // Build per-ASIN "most recent fresh Gemini review" map.
      // Used to upgrade the engine badge to "AI-observed by Gemini 2.5 …".
      // Only the latest review wins (rows are already ordered DESC).
      const reviewMap: Record<string, { model_tier: string | null; model_used: string | null; reviewed_at: string }> = {};
      (reviewsRes.data || []).forEach((r: any) => {
        if (!r.asin) return;
        if (reviewMap[r.asin]) return; // keep newest
        reviewMap[r.asin] = {
          model_tier: r.model_tier,
          model_used: r.model_used,
          reviewed_at: r.created_at,
        };
      });

      // Build per-ASIN signal map (from aggregator — used for sparkline summaries)
      const sMap: Record<string, { bb_loss: number; raised: number; constrained: number; winner: number }> = {};
      (signalsRes.data || []).forEach((s: any) => {
        if (!sMap[s.asin]) sMap[s.asin] = { bb_loss: 0, raised: 0, constrained: 0, winner: 0 };
        const t = s.event_type as keyof typeof sMap[string];
        if (t in sMap[s.asin]) sMap[s.asin][t]++;
      });
      setSignalMap(sMap);

      // Map a repricer_ai_decisions row → AiInsightEvent shape used by the cards.
      // We derive event_type / action_type from mode + price_delta so the existing
      // card UI works unchanged.
      const mapDecisionToEvent = (d: any): AiInsightEvent => {
        const priceChanged = d.new_price != null && d.price_delta != null && Math.abs(d.price_delta) > 0.001;
        const wentDown = (d.price_delta ?? 0) < -0.001;
        const wentUp = (d.price_delta ?? 0) > 0.001;
        const bbOwner = d.buybox_price != null && d.current_price != null && Math.abs(d.buybox_price - d.current_price) < 0.02;

        // Derive event_type bucket
        let event_type = "evaluated";
        if (d.cooldown_applied || d.max_step_applied || d.min_price_clamped) event_type = "constrained";
        else if (wentUp) event_type = "raised";
        else if (wentDown && !bbOwner) event_type = "bb_loss";
        else if (bbOwner) event_type = "winner";
        else if (!priceChanged) event_type = "bb_loss"; // HOLD with no BB ownership

        const action_type = priceChanged ? "price_changed" : "no_change";

        // Build constraints array from boolean guards
        const constraints: string[] = [];
        if (d.cooldown_applied) constraints.push("cooldown");
        if (d.max_step_applied) constraints.push("max_step");
        if (d.min_price_clamped) constraints.push("min_price");

        return {
          id: d.id,
          created_at: d.created_at,
          user_id: d.user_id,
          asin: d.asin,
          sku: d.sku,
          marketplace: d.marketplace,
          event_type,
          action_type,
          decision_label: d.reason || d.mode || "",
          tuning_signal: d.mode || "",
          current_price: d.current_price,
          target_price: d.new_price,
          buy_box_price: d.buybox_price,
          lowest_fba_price: d.lowest_fba_price,
          next_competitor_price: d.lowest_overall_price,
          min_price: d.min_price_used,
          max_price: d.max_price_used,
          profit_floor: d.min_price_used,
          constraints_json: constraints,
          engine_mode: d.mode || "",
          confidence_score: d.ai_aggressiveness,
          was_price_changed: priceChanged,
          was_bb_owner: bbOwner,
          snapshot_json: null,
          model_tier: d.model_tier ?? null,
          model_used: d.model_used ?? null,
        } as AiInsightEvent;
      };

      const rawEvents: AiInsightEvent[] = (decisionsRes.data || []).map(mapDecisionToEvent);
      const liveAssignments = (liveAssignmentsRes.data || []) as any[];
      const recentActions = (recentActionsRes.data || []) as any[];

      // Enrich with assignment data (title, image, rule name, reason)
      const asins = [...new Set([...rawEvents.map(e => e.asin), ...liveAssignments.map(a => a.asin)])];
      let assignmentMap: Record<string, any> = {};
      const activeAsinSet = new Set<string>();
      const tombstonedAsinSet = new Set<string>();

      if (asins.length > 0) {
        // Only consider ENABLED assignments — disabled/deleted ones must NOT appear in AI Insights
        const { data: assignments } = await supabase
          .from("repricer_assignments")
          .select("asin, rule_id, last_recommendation_reason, is_enabled")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .in("asin", asins.slice(0, 100));

        (assignments || []).forEach(a => activeAsinSet.add(a.asin));

        const { data: invItems } = await supabase
          .from("inventory")
          .select("asin, title, image_url, listing_status")
          .eq("user_id", user.id)
          .in("asin", asins.slice(0, 100));

        // Tombstoned listings (deleted/not-in-catalog) → ghost ASINs, exclude from insights
        (invItems || []).forEach(i => {
          if (i.listing_status === "NOT_IN_CATALOG" || i.listing_status === "DELETED") {
            tombstonedAsinSet.add(i.asin);
          }
        });

        const ruleIds = [...new Set((assignments || []).map(r => r.rule_id).filter(Boolean))];
        let ruleNameMap: Record<string, string> = {};
        if (ruleIds.length > 0) {
          const { data: rules } = await supabase
            .from("repricer_rules")
            .select("id, name")
            .in("id", ruleIds);
          (rules || []).forEach(r => { ruleNameMap[r.id] = r.name; });
        }

        (assignments || []).forEach(a => {
          assignmentMap[a.asin] = {
            ...assignmentMap[a.asin],
            last_recommendation_reason: a.last_recommendation_reason,
            rule_name: a.rule_id ? ruleNameMap[a.rule_id] : undefined,
          };
        });
        (invItems || []).forEach(i => {
          assignmentMap[i.asin] = { ...assignmentMap[i.asin], title: i.title, image_url: i.image_url };
        });
      }

      // Drop ghost ASINs: no longer in active assignments, OR tombstoned in inventory
      const filteredRawEvents = rawEvents.filter(e =>
        activeAsinSet.has(e.asin) && !tombstonedAsinSet.has(e.asin)
      );

      const enriched: AiInsightEvent[] = filteredRawEvents.map(e => {
        const review = reviewMap[e.asin];
        return {
          ...e,
          title: assignmentMap[e.asin]?.title,
          image_url: assignmentMap[e.asin]?.image_url,
          rule_name: assignmentMap[e.asin]?.rule_name,
          last_recommendation_reason: assignmentMap[e.asin]?.last_recommendation_reason,
          // Upgrade badge: attach Gemini tier only when a fresh review exists for this ASIN.
          // Falls back to whatever was on the decision row (currently always null).
          model_tier: review?.model_tier ?? e.model_tier ?? null,
          model_used: review?.model_used ?? e.model_used ?? null,
        };
      });

      setEvents((prev) => {
        if (prev.length === enriched.length && prev.length > 0) {
          const sameIds = prev.every((p, i) => p.id === enriched[i].id);
          if (sameIds) return prev; // no change → skip re-render
        }
        return enriched;
      });
      setSchedulerState((schedulerRes.data as LiveAiSchedulerState | null) ?? null);

      const latestEventMap: Record<string, AiInsightEvent> = {};
      enriched.forEach((event) => {
        if (!latestEventMap[event.asin]) latestEventMap[event.asin] = event;
      });

      const latestActionMap: Record<string, any> = {};
      recentActions.forEach((action) => {
        if (!latestActionMap[action.asin]) latestActionMap[action.asin] = action;
      });

      const liveItems: LiveAiStateItem[] = liveAssignments.map((assignment) => {
        const latestEvent = latestEventMap[assignment.asin];
        const latestAction = latestActionMap[assignment.asin];
        const review = reviewMap[assignment.asin];
        const actionPrice = latestAction?.new_price ?? latestAction?.old_price ?? null;
        const eventPrice = latestEvent?.target_price ?? latestEvent?.current_price ?? null;
        const label = latestAction
          ? latestAction.action_type === "price_changed"
            ? `Price changed to $${Number(latestAction.new_price ?? actionPrice ?? 0).toFixed(2)}`
            : latestAction.action_type === "no_change"
              ? "Held current price after latest evaluation"
              : latestAction.action_type?.replace(/_/g, " ")
          : assignment.last_recommendation_reason || latestEvent?.decision_label || null;

        return {
          asin: assignment.asin,
          title: assignmentMap[assignment.asin]?.title,
          image_url: assignmentMap[assignment.asin]?.image_url,
          event_type: latestEvent?.event_type,
          current_price: assignment.last_applied_price ?? latestEvent?.current_price ?? actionPrice,
          recommended_price: assignment.last_recommended_price ?? eventPrice,
          buy_box_price: assignment.last_buybox_price ?? latestEvent?.buy_box_price,
          last_evaluated_at: assignment.last_evaluated_at,
          last_action_at: latestAction?.created_at ?? latestEvent?.created_at ?? assignment.last_evaluated_at,
          last_action_type: latestAction?.action_type ?? latestEvent?.action_type,
          last_action_label: label,
          trigger_source: latestAction?.trigger_source ?? assignment.last_trigger_source,
          model_tier: review?.model_tier ?? latestEvent?.model_tier ?? null,
          model_used: review?.model_used ?? latestEvent?.model_used ?? null,
          reviewed_at: review?.reviewed_at ?? null,
        };
      });

      setLiveStateItems(liveItems);
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      console.error("AI Insights fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Manually trigger a Gemini review batch (Phase 2 router) for the ASINs
  // currently visible in the AI Insights feed. Passing `target_asins` makes
  // the edge function review exactly those ASINs (built from their newest
  // repricer_ai_decisions rows) instead of sampling a background pool — so
  // the Gemini badges show up on the cards the user is actually looking at.
  const triggerAiReview = useCallback(async () => {
    if (!user) return;
    if (cooldownRemaining > 0) return;

    // Build the targeted ASIN list from what the user can actually see:
    // 1. The Live AI State strip at the top (~6 cards)
    // 2. The most recent decisions in the feed (events are sorted DESC)
    // Deduped, capped at 25 to stay within the function's batch budget.
    const visibleAsins = Array.from(
      new Set<string>([
        ...liveStateItems.map((i) => i.asin),
        ...events.slice(0, 20).map((e) => e.asin),
      ]),
    ).filter(Boolean).slice(0, 25);

    if (visibleAsins.length === 0) {
      toast.info("No ASINs visible to review yet — wait for the feed to load.");
      return;
    }

    setReviewRunning(true);
    const t = toast.loading(`Reviewing ${visibleAsins.length} visible ASIN${visibleAsins.length === 1 ? "" : "s"} with Gemini…`);
    try {
      const { data, error } = await supabase.functions.invoke("smart-engine-auto-review", {
        body: {
          user_id: user.id,
          target_asins: visibleAsins,
        },
      });
      if (error) throw error;
      const batches = Number((data as any)?.batches ?? 0);
      const targeted = Number((data as any)?.target_asin_count ?? visibleAsins.length);
      const stamp = Date.now();
      setLastReviewAt(stamp);
      try { localStorage.setItem("ai_review_last_run_at", String(stamp)); } catch { /* ignore */ }
      if (batches > 0) {
        toast.success("AI review complete — insights updated", {
          id: t,
          description: `Gemini reviewed ${targeted} visible ASIN${targeted === 1 ? "" : "s"}. Badges will appear on the matching cards.`,
        });
      } else {
        toast.success("No fresh decisions found for visible ASINs", {
          id: t,
          description: "These ASINs have no recent engine decisions to review yet — try again after the next evaluation.",
        });
      }
      // Pull the freshly written reviews into the feed.
      await fetchData();
    } catch (err: any) {
      toast.error("AI review failed", {
        id: t,
        description: err?.message ?? "Please try again in a moment.",
      });
    } finally {
      setReviewRunning(false);
    }
  }, [user, cooldownRemaining, fetchData, liveStateItems, events]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      fetchData(true); // silent background refresh — no spinner, no flicker
    }, 15000);

    return () => window.clearInterval(interval);
  }, [fetchData]);

  const filtered = useMemo(() => {
    const base = events.filter(e => {
      if (filterType !== "all" && e.event_type !== filterType) return false;
      if (aiReviewedOnly && !e.model_tier) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        return e.asin.toLowerCase().includes(s) || (e.title || "").toLowerCase().includes(s) || (e.sku || "").toLowerCase().includes(s);
      }
      return true;
    });
    if (sortMode === "ai_first") {
      // Stable sort: AI-observed first (Pro before Flash), preserves recent order otherwise.
      const tierRank = (t?: string | null) => (t === "pro" ? 2 : t === "flash" ? 1 : 0);
      return [...base].sort((a, b) => tierRank(b.model_tier) - tierRank(a.model_tier));
    }
    return base;
  }, [events, filterType, searchTerm, aiReviewedOnly, sortMode]);

  // Count of unique ASINs that have a Gemini review attached.
  const aiReviewedCount = useMemo(() => {
    const reviewed = new Set<string>();
    const all = new Set<string>();
    for (const e of events) {
      all.add(e.asin);
      if (e.model_tier) reviewed.add(e.asin);
    }
    return { reviewed: reviewed.size, total: all.size };
  }, [events]);

  // Map each ASIN to its most recent event (events are already sorted DESC by created_at).
  const latestByAsin = useMemo(() => {
    const m: Record<string, AiInsightEvent> = {};
    for (const ev of events) {
      if (!m[ev.asin]) m[ev.asin] = ev;
    }
    return m;
  }, [events]);

  // Summary stats
  const stats = useMemo(() => {
    const total = events.length;
    const bb_loss = events.filter(e => e.event_type === "bb_loss").length;
    const raised = events.filter(e => e.event_type === "raised").length;
    const constrained = events.filter(e => e.event_type === "constrained").length;
    const winner = events.filter(e => e.event_type === "winner").length;
    const priceChanges = events.filter(e => e.was_price_changed && e.action_type === "price_changed").length;
    return { total, bb_loss, raised, constrained, winner, priceChanges };
  }, [events]);

  const content = (
    <>
      {/* Hero header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Brain className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Repricer Action Log</h1>
            <p className="text-sm text-muted-foreground">
              Every price decision your repricer made, and the rule that produced it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Badge variant="outline" className="text-[10px] gap-1 border-border/60 text-muted-foreground">
            <Shield className="h-3 w-3" /> Rules-driven pricing
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            All pricing decisions are made by the deterministic repricer. AI notes below are observations only — they do not change repricer decisions today.
          </span>
        </div>
      </div>

      {/* Stats summary */}
      <div className="mb-4">
        <AiInsightsLiveState
          items={liveStateItems}
          scheduler={schedulerState}
          lastUpdatedAt={lastUpdatedAt}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        {[
          { label: "Total Events", value: stats.total, icon: Eye, color: "" },
          { label: "BB Lost", value: stats.bb_loss, icon: TrendingDown, color: "text-red-400" },
          { label: "Raised", value: stats.raised, icon: TrendingUp, color: "text-green-400" },
          { label: "Constrained", value: stats.constrained, icon: AlertTriangle, color: "text-yellow-400" },
          { label: "Winners", value: stats.winner, icon: CheckCircle2, color: "text-emerald-400" },
          { label: "Price Changes", value: stats.priceChanges, icon: Sparkles, color: "text-blue-400" },
        ].map(s => (
          <Card key={s.label} className="border-border/30">
            <CardContent className="p-3 flex items-center gap-2">
              <s.icon className={`h-4 w-4 ${s.color || "text-muted-foreground"}`} />
              <div>
                <p className="text-lg font-bold">{s.value}</p>
                <p className="text-[10px] text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters + actions */}
      <div className="flex flex-col sm:flex-row gap-2 mb-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search ASIN, title, or SKU..."
            className="pl-9 h-9 text-sm"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-[160px] h-9 text-sm">
            <Filter className="h-3 w-3 mr-1" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Events</SelectItem>
            <SelectItem value="bb_loss">BB Lost</SelectItem>
            <SelectItem value="raised">Raised</SelectItem>
            <SelectItem value="constrained">Constrained</SelectItem>
            <SelectItem value="winner">Winners</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortMode} onValueChange={(v) => setSortMode(v as "recent" | "ai_first")}>
          <SelectTrigger className="w-[180px] h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Sort: Most recent</SelectItem>
            <SelectItem value="ai_first">Sort: AI-observed first</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={aiReviewedOnly ? "default" : "outline"}
          size="sm"
          className="h-9 gap-1.5"
          onClick={() => setAiReviewedOnly((v) => !v)}
          title="Show only ASINs that received an AI observation note"
        >
          <Brain className="h-3.5 w-3.5" />
          AI-Observed only
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => fetchData()}
          disabled={loading}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <Button
          variant="default"
          size="lg"
          className="h-11 px-5 text-base font-semibold shadow-md"
          onClick={triggerAiReview}
          disabled={reviewRunning || cooldownRemaining > 0 || !user}
          title={
            cooldownRemaining > 0
              ? `Cooldown: ${Math.ceil(cooldownRemaining / 1000)}s remaining`
              : "Run a Gemini observation pass over recent decisions (does not change any prices)"
          }
        >
          {reviewRunning ? (
            <RefreshCw className="h-5 w-5 mr-2 animate-spin" />
          ) : (
            <Zap className="h-5 w-5 mr-2" />
          )}
          {reviewRunning
            ? "Observing with Gemini…"
            : cooldownRemaining > 0
              ? `Run AI Observation Now (${Math.ceil(cooldownRemaining / 1000)}s)`
              : "Run AI Observation Now"}
        </Button>
      </div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <p className="text-xs text-muted-foreground">
          Gemini Flash reads recent decisions and writes an observation note. Gemini Pro is used for deeper analysis. These notes do not influence pricing — the deterministic repricer keeps full control. Limited to once every 5 minutes.
        </p>
        <Badge
          variant="outline"
          className="text-[11px] gap-1 border-primary/30 text-primary cursor-pointer hover:bg-primary/10"
          onClick={() => setAiReviewedOnly((v) => !v)}
          title="Click to toggle AI-Observed only filter"
        >
          <Brain className="h-3 w-3" />
          {aiReviewedCount.reviewed} / {aiReviewedCount.total} with AI observation
        </Badge>
      </div>

      {/* Event cards */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-border/30">
          <CardContent className="p-8 text-center">
            <Brain className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No AI events found for the selected filters. Events are generated as the repricer evaluates ASINs.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(e => (
            <AiInsightsCard
              key={e.id}
              event={e}
              signalSummary={signalMap[e.asin]}
              isAdmin={!!isAdmin}
              latestForAsin={latestByAsin[e.asin]}
            />
          ))}
          {filtered.length >= 500 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              Showing latest 500 events (14 days)
            </p>
          )}
        </div>
      )}
    </>
  );

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
          <h1 className="text-2xl font-bold text-foreground">Access Restricted</h1>
          <p className="text-muted-foreground">You need the <strong>admin</strong> role to view this page.</p>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>AI Action Insights | InventorySprint</title>
        <meta name="description" content="See exactly how your repricer AI makes decisions — transparent reasoning for every ASIN." />
      </Helmet>
      <div className="min-h-screen bg-background flex flex-col">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-6 max-w-5xl">
          {content}
        </main>
        <Footer />
      </div>
    </>
  );
}
