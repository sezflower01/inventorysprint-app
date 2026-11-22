import { useState, useCallback, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertTriangle, Copy, Sparkles, Brain, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { buildNarrative } from "@/lib/repricerReasonTranslator";
import { formatPrice } from "@/lib/marketplaceCurrency";
import { classifyAction, categorizeActions, selectDiverseBatch } from "@/lib/smartEngineClassifier";
import { format } from "date-fns";
import SmartEngineReviewCard from "./SmartEngineReviewCard";
import SmartEngineBatchHistory from "./SmartEngineBatchHistory";
import SmartEngineFilters, { type FilterType, type SortType } from "./SmartEngineFilters";

export interface ReviewAsin {
  asin: string;
  sku: string | null;
  marketplace: string;
  category: "bb_loss" | "raised" | "constrained" | "floor_hit" | "winner";
  currentPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  bbPrice: number | null;
  lowestFba: number | null;
  nextCompetitor: number | null;
  bbOwner: boolean;
  imageUrl: string | null;
  title: string | null;
  lastAction: any | null;
  recentActions: any[];
  judgment: "correct" | "contextual_correct" | "needs_review";
  judgmentReason: string;
  explanation: string;
  tuningSignals: string[];
  blockers: string[];
  aiJudgment?: string;
  aiReasoning?: string;
  aiSuggestion?: string;
  aiConfidence?: string;
  activityEvent?: any;
}

interface BatchSummary {
  total: number;
  optimal: number;
  review: number;
  generatedAt: string;
  topIssue: string | null;
  aiPowered: boolean;
}

type AiStatus = "idle" | "queued" | "running" | "complete" | "failed";

export default function SmartEngineReview() {
  const { user } = useAuth();
  const [batch, setBatch] = useState<ReviewAsin[]>([]);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>("idle");
  const [recentBatches, setRecentBatches] = useState<any[]>([]);
  const [loadingBatchId, setLoadingBatchId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeSort, setActiveSort] = useState<SortType>("importance");

  // Load recent batch history
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("smart_engine_review_batches")
        .select("id, created_at, asin_count, optimal_count, review_needed_count, top_signal, trigger_type")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);
      setRecentBatches(data || []);
    })();
  }, [user?.id, summary]);

  const loadBatchDetails = useCallback(async (batchId: string, batchMeta: any) => {
    if (!user?.id) return;
    setLoadingBatchId(batchId);
    try {
      const { data: items, error } = await supabase
        .from("smart_engine_review_items")
        .select("*")
        .eq("batch_id", batchId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      if (!items || items.length === 0) {
        toast.info("No detailed items saved for this batch");
        setLoadingBatchId(null);
        return;
      }

      const asinKeys = items.map((i: any) => i.asin);
      const { data: invData } = await supabase
        .from("inventory")
        .select("asin, my_price, min_price, max_price, image_url, title, sku")
        .in("asin", asinKeys);

      // Real Gemini output for this batch lives in `smart_engine_ai_reviews`,
      // written by smart-engine-ai-review (manual "Generate Batch") and
      // smart-engine-auto-review (the 8am/12pm cron) alike -- but that table
      // has no batch_id back to smart_engine_review_batches (it FKs to its
      // own smart_engine_ai_review_batches instead). Both writers insert the
      // AI rows within the same request as the review-batch row, so matching
      // by (asin, marketplace) + nearest created_at within a generous window
      // reliably recovers the right row without a schema change.
      const batchTime = new Date(batchMeta.created_at).getTime();
      const windowStart = new Date(batchTime - 10 * 60_000).toISOString();
      const windowEnd = new Date(batchTime + 10 * 60_000).toISOString();
      const { data: aiRows } = await supabase
        .from("smart_engine_ai_reviews")
        .select("asin, marketplace, ai_judgment, ai_reasoning_summary, ai_tuning_suggestion, ai_confidence, created_at")
        .eq("user_id", user.id)
        .in("asin", asinKeys)
        .gte("created_at", windowStart)
        .lte("created_at", windowEnd);

      const aiMap = new Map<string, { row: NonNullable<typeof aiRows>[number]; dist: number }>();
      for (const row of aiRows || []) {
        const key = `${row.asin}::${row.marketplace}`;
        const dist = Math.abs(new Date(row.created_at).getTime() - batchTime);
        const existing = aiMap.get(key);
        if (!existing || dist < existing.dist) aiMap.set(key, { row, dist });
      }

      const reviewItems: ReviewAsin[] = items.map((item: any) => {
        const inv = invData?.find(i => i.asin === item.asin) || {} as any;
        const ai = aiMap.get(`${item.asin}::${item.marketplace}`)?.row;
        return {
          asin: item.asin,
          sku: item.sku || inv.sku || null,
          marketplace: item.marketplace,
          category: item.decision_type || "constrained",
          currentPrice: item.current_price ?? inv.my_price ?? null,
          minPrice: item.min_price ?? inv.min_price ?? null,
          maxPrice: item.max_price ?? inv.max_price ?? null,
          bbPrice: item.buy_box_price ?? null,
          lowestFba: item.lowest_fba_price ?? null,
          nextCompetitor: item.next_competitor_price ?? null,
          bbOwner: item.bb_owner ?? false,
          imageUrl: inv.image_url || null,
          title: inv.title || item.asin,
          lastAction: null,
          recentActions: [],
          judgment: item.judgment || "correct",
          judgmentReason: item.judgment_reason || "",
          explanation: item.judgment_reason || "Loaded from batch history",
          tuningSignals: item.tuning_signals || [],
          blockers: [],
          aiJudgment: ai?.ai_judgment ?? undefined,
          aiReasoning: ai?.ai_reasoning_summary ?? undefined,
          aiSuggestion: ai?.ai_tuning_suggestion ?? undefined,
          aiConfidence: ai?.ai_confidence ?? undefined,
        };
      });

      setBatch(reviewItems);
      setSummary({
        total: batchMeta.asin_count || reviewItems.length,
        optimal: batchMeta.optimal_count || 0,
        review: batchMeta.review_needed_count || 0,
        generatedAt: batchMeta.created_at,
        topIssue: batchMeta.top_signal,
        aiPowered: aiMap.size > 0,
      });
      setAiStatus("complete");
    } catch (err: any) {
      toast.error("Failed to load batch: " + err.message);
    } finally {
      setLoadingBatchId(null);
    }
  }, [user?.id]);

  // AI analysis
  const runAiAnalysis = useCallback(async (items: ReviewAsin[]) => {
    if (!user?.id || items.length === 0) return;
    setAiStatus("running");
    try {
      const cases = items.map(r => r.activityEvent).filter(Boolean);
      const { data, error } = await supabase.functions.invoke("smart-engine-ai-review", {
        body: { cases },
      });
      if (error) {
        setAiStatus("failed");
        toast.error("AI analysis failed: " + error.message);
        return;
      }
      const analyses = data?.analyses || [];
      setBatch(prev => prev.map(item => {
        const ai = analyses.find((a: any) => a.asin === item.asin);
        return ai ? { ...item, aiJudgment: ai.judgment, aiReasoning: ai.reasoning, aiSuggestion: ai.suggestion, aiConfidence: ai.confidence } : item;
      }));
      setSummary(prev => prev ? { ...prev, aiPowered: true } : prev);
      setAiStatus("complete");
      toast.success(`AI analyzed ${analyses.length} cases`);
    } catch {
      setAiStatus("failed");
      toast.error("AI analysis failed");
    }
  }, [user?.id]);

  const generateBatch = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setAiStatus("idle");

    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: actions } = await supabase
        .from("repricer_price_actions")
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500);

      if (!actions || actions.length === 0) {
        toast.error("No recent price actions to analyze");
        setLoading(false);
        return;
      }

      // Categorize and select diverse batch
      const pools = categorizeActions(actions);
      const selected = selectDiverseBatch(pools);

      if (selected.length === 0) {
        toast.error("Not enough data to generate a review batch");
        setLoading(false);
        return;
      }

      // Parallel fetches for enrichment
      const asinKeys = selected.map(s => s.action.asin);
      const [invResult, actionsResult] = await Promise.all([
        supabase.from("inventory").select("asin, my_price, min_price, max_price, image_url, title, sku").in("asin", asinKeys),
        supabase.from("repricer_price_actions").select("*").in("asin", asinKeys).gte("created_at", since).order("created_at", { ascending: false }).limit(50),
      ]);

      const invData = invResult.data;
      const allRecentActions = actionsResult.data;

      // Build review items using classifier
      const reviewItems: ReviewAsin[] = selected.map(({ action: s, category: cat }) => {
        const inv = invData?.find(i => i.asin === s.asin) || {} as any;
        const intel = (s.intelligence_factors as Record<string, any>) || {};
        const trace = intel?.price_trace || {};
        const posProof = intel?.position_proof || {};
        const recentForAsin = (allRecentActions || []).filter((a: any) => a.asin === s.asin).slice(0, 5);
        const delta = (s.new_price ?? 0) - (s.old_price ?? 0);

        const classification = classifyAction(s, inv, recentForAsin);

        const explanation = buildNarrative({
          action_type: s.action_type,
          reason: s.reason,
          old_price: s.old_price,
          new_price: s.new_price,
          intended_price: s.intended_price,
          success: s.success,
          error_message: s.error_message,
          intelligence_factors: s.intelligence_factors,
          rule_name: s.rule_name,
          overlay_tag: s.overlay_tag,
          old_min_price: s.old_min_price,
          old_max_price: s.old_max_price,
          effective_floor_cents: s.effective_floor_cents,
        });

        return {
          asin: s.asin,
          sku: s.sku || inv.sku || null,
          marketplace: s.marketplace || "US",
          category: classification.category,
          currentPrice: s.new_price ?? inv.my_price,
          minPrice: s.old_min_price ?? inv.min_price,
          maxPrice: s.old_max_price ?? inv.max_price,
          bbPrice: trace.buybox_price ?? null,
          lowestFba: trace.lowest_fba ?? null,
          nextCompetitor: posProof.next_competitor_price ?? null,
          bbOwner: posProof.buy_box_owner_is_me ?? false,
          imageUrl: inv.image_url ?? null,
          title: inv.title ?? s.asin,
          lastAction: s,
          recentActions: recentForAsin,
          judgment: classification.judgment,
          judgmentReason: classification.judgmentReason,
          explanation,
          tuningSignals: classification.tuningSignals,
          blockers: classification.blockers,
          activityEvent: {
            asin: s.asin,
            sku: s.sku || inv.sku,
            marketplace: s.marketplace || "US",
            event_type: classification.category,
            action_type: s.action_type,
            decision_label: classification.judgmentReason,
            tuning_signal: classification.tuningSignals[0] || null,
            current_price: s.new_price ?? inv.my_price,
            target_price: s.intended_price,
            buy_box_price: trace.buybox_price,
            lowest_fba_price: trace.lowest_fba,
            next_competitor_price: posProof.next_competitor_price,
            min_price: s.old_min_price ?? inv.min_price,
            max_price: s.old_max_price ?? inv.max_price,
            profit_floor: trace.profit_guard?.floor,
            constraints_json: intel?.guards_applied || [],
            engine_mode: intel?.eval_mode || s.action_type,
            was_price_changed: Math.abs(delta) > 0.005,
            was_bb_owner: posProof.buy_box_owner_is_me ?? false,
          },
        };
      });

      const optimalCount = reviewItems.filter(r => r.judgment === "correct" || r.judgment === "contextual_correct").length;
      const reviewCount = reviewItems.filter(r => r.judgment === "needs_review").length;
      const allSignals = reviewItems.flatMap(r => r.tuningSignals);
      const signalCounts = allSignals.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {} as Record<string, number>);
      const topIssue = Object.entries(signalCounts).filter(([s]) => !s.includes("No issues")).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      setBatch(reviewItems);
      const newSummary: BatchSummary = {
        total: reviewItems.length,
        optimal: optimalCount,
        review: reviewCount,
        generatedAt: new Date().toISOString(),
        topIssue,
        aiPowered: false,
      };
      setSummary(newSummary);

      // Persist batch + events
      try {
        const { data: batchRow } = await supabase.from("smart_engine_review_batches").insert({
          user_id: user.id,
          asin_count: reviewItems.length,
          optimal_count: optimalCount,
          review_needed_count: reviewCount,
          top_signal: topIssue,
          trigger_type: "manual",
        }).select("id").single();

        if (batchRow?.id) {
          const itemRows = reviewItems.map(r => ({
            batch_id: batchRow.id, user_id: user.id, asin: r.asin, sku: r.sku, marketplace: r.marketplace,
            decision_type: r.category, judgment: r.judgment, judgment_reason: r.judgmentReason,
            tuning_signals: r.tuningSignals, current_price: r.currentPrice, buy_box_price: r.bbPrice,
            lowest_fba_price: r.lowestFba, next_competitor_price: r.nextCompetitor,
            min_price: r.minPrice, max_price: r.maxPrice, bb_owner: r.bbOwner,
          }));
          await supabase.from("smart_engine_review_items").insert(itemRows);
        }

        // Activity events with dedup
        const activityRows = reviewItems.filter(r => r.activityEvent).map(r => ({ ...r.activityEvent, user_id: user.id, snapshot_json: {} }));
        if (activityRows.length > 0) {
          const dedupeWindow = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          const asinList = activityRows.map(r => r.asin);
          const { data: recentEvents } = await supabase
            .from("smart_engine_activity_events")
            .select("asin, tuning_signal")
            .eq("user_id", user.id)
            .in("asin", asinList)
            .gte("created_at", dedupeWindow);
          const recentKeys = new Set((recentEvents || []).map(e => `${e.asin}::${e.tuning_signal}`));
          const dedupedRows = activityRows.filter(r => !recentKeys.has(`${r.asin}::${r.tuning_signal}`));
          if (dedupedRows.length > 0) {
            await supabase.from("smart_engine_activity_events").insert(dedupedRows);
          }
        }
      } catch (persistErr) {
        console.warn("Failed to persist review batch:", persistErr);
      }

      // Auto-trigger AI analysis
      setAiStatus("queued");
      setLoading(false);
      // Small delay then auto-run AI
      setTimeout(() => runAiAnalysis(reviewItems), 500);
    } catch (err) {
      console.error("Review batch error:", err);
      toast.error("Failed to generate review batch");
      setLoading(false);
    }
  }, [user?.id, runAiAnalysis]);

  const copyAnalysis = useCallback(() => {
    if (!batch.length) return;
    const text = batch.map(r => {
      const mp = r.marketplace;
      let t = `ASIN: ${r.asin} (${mp})\nCategory: ${r.category}\nJudgment: ${r.judgment}\nPrice: ${formatPrice(r.currentPrice, mp)} | BB: ${formatPrice(r.bbPrice, mp)}\nExplanation: ${r.explanation}\nSignals: ${r.tuningSignals.join("; ")}`;
      if (r.aiJudgment) {
        t += `\n🤖 AI: ${r.aiJudgment} — ${r.aiReasoning}`;
        if (r.aiSuggestion && r.aiSuggestion !== "No change needed.") t += `\n💡 Suggestion: ${r.aiSuggestion}`;
      }
      return t + "\n";
    }).join("\n---\n\n");
    navigator.clipboard.writeText(text);
    toast.success("Analysis copied to clipboard");
  }, [batch]);

  // Filter + sort with memoization
  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { total: batch.length };
    for (const item of batch) {
      counts[item.category] = (counts[item.category] || 0) + 1;
    }
    counts.needs_review = batch.filter(i => i.judgment === "needs_review").length;
    counts.profit_extract = batch.filter(i => {
      const reason = i.lastAction?.reason || "";
      const guards: string[] = (i.lastAction?.intelligence_factors as any)?.guards_applied || [];
      const allTags = [reason, ...guards].join(",").toLowerCase();
      return allTags.includes("profit_extraction") || allTags.includes("raise_offset") || allTags.includes("smart_raise") || allTags.includes("profit_max");
    }).length;
    return counts;
  }, [batch]);

  const filteredBatch = useMemo(() => {
    let items = batch;
    if (activeFilter === "needs_review") {
      items = items.filter(i => i.judgment === "needs_review");
    } else if (activeFilter === "profit_extract") {
      items = items.filter(i => {
        const reason = i.lastAction?.reason || "";
        const guards: string[] = (i.lastAction?.intelligence_factors as any)?.guards_applied || [];
        const allTags = [reason, ...guards].join(",").toLowerCase();
        return allTags.includes("profit_extraction") || allTags.includes("raise_offset") || allTags.includes("smart_raise") || allTags.includes("profit_max");
      });
    } else if (activeFilter !== "all") {
      items = items.filter(i => i.category === activeFilter);
    }

    const sorted = [...items];
    switch (activeSort) {
      case "needs_review":
        sorted.sort((a, b) => (a.judgment === "needs_review" ? -1 : 1) - (b.judgment === "needs_review" ? -1 : 1));
        break;
      case "price_gap":
        sorted.sort((a, b) => {
          const gapA = a.nextCompetitor != null && a.currentPrice != null ? Math.abs(a.nextCompetitor - a.currentPrice) : 0;
          const gapB = b.nextCompetitor != null && b.currentPrice != null ? Math.abs(b.nextCompetitor - b.currentPrice) : 0;
          return gapB - gapA;
        });
        break;
      case "recent":
        sorted.sort((a, b) => {
          const tA = a.lastAction?.created_at || "";
          const tB = b.lastAction?.created_at || "";
          return tB.localeCompare(tA);
        });
        break;
      case "importance":
      default:
        sorted.sort((a, b) => {
          const priority: Record<string, number> = { needs_review: 0, bb_loss: 1, floor_hit: 2, constrained: 3, raised: 4, winner: 5 };
          const jPri: Record<string, number> = { needs_review: 0, contextual_correct: 1, correct: 2 };
          const ap = (jPri[a.judgment] ?? 2) * 10 + (priority[a.category] ?? 5);
          const bp = (jPri[b.judgment] ?? 2) * 10 + (priority[b.category] ?? 5);
          return ap - bp;
        });
        break;
    }
    return sorted;
  }, [batch, activeFilter, activeSort]);

  const aiStatusLabel = () => {
    switch (aiStatus) {
      case "queued": return <Badge variant="secondary" className="text-[10px]">⏳ AI Queued</Badge>;
      case "running": return <Badge className="text-[10px] bg-primary/10 text-primary"><Loader2 className="h-3 w-3 animate-spin mr-1" /> AI Running</Badge>;
      case "complete": return <Badge className="text-[10px] bg-green-500/10 text-green-700 dark:text-green-400"><Brain className="h-3 w-3 mr-1" /> AI Done ✓</Badge>;
      case "failed": return (
        <Button variant="destructive" size="sm" className="h-6 text-[10px]" onClick={() => runAiAnalysis(batch)}>
          AI Failed — Retry
        </Button>
      );
      default: return null;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Smart Engine Review
          </h2>
          <p className="text-sm text-muted-foreground">
            Auto-select ASINs by significance, analyze decisions, and get AI-powered insights
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {batch.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={copyAnalysis}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy Analysis
              </Button>
              {aiStatusLabel()}
            </>
          )}
          <Button onClick={generateBatch} disabled={loading} size="sm">
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            {batch.length > 0 ? "New Batch" : "Generate Batch"}
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      {summary && (
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4 text-sm">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setBatch([]); setSummary(null); setAiStatus("idle"); }}>
                  ← Back to batches
                </Button>
                <span className="font-medium">{summary.total} ASINs reviewed</span>
                <span className="flex items-center gap-1 text-green-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {summary.optimal} optimal
                </span>
                {summary.review > 0 && (
                  <span className="flex items-center gap-1 text-red-500">
                    <AlertTriangle className="h-3.5 w-3.5" /> {summary.review} need review
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                Generated: {format(new Date(summary.generatedAt), "PPp")}
              </span>
            </div>
            {summary.topIssue && (
              <p className="text-xs text-muted-foreground mt-2">
                Top signal: <span className="font-medium text-foreground">{summary.topIssue}</span>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters + Sort */}
      {batch.length > 0 && (
        <SmartEngineFilters
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          activeSort={activeSort}
          onSortChange={setActiveSort}
          counts={filterCounts}
        />
      )}

      {/* Empty state.
          The previous copy promised "automated batches run at 8:00 AM and
          8:00 PM UTC daily". That promise is NOT made here any more: the two
          pg_cron jobs send a hardcoded anon JWT that requireInternalOrUser
          rejects, so whether they have run at all since the guard landed on
          2026-07-09 is unresolved. Until it is, this says only what is
          certainly true -- the on-demand path works. */}
      {!loading && batch.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-muted-foreground">Click “Generate Batch” to analyze the most significant ASINs from recent activity</p>
          </CardContent>
        </Card>
      )}

      {/* Batch History */}
      {batch.length === 0 && (
        <SmartEngineBatchHistory
          batches={recentBatches}
          loadingBatchId={loadingBatchId}
          onLoadBatch={loadBatchDetails}
        />
      )}

      {/* ASIN Cards */}
      <div className="space-y-4">
        {filteredBatch.map((item) => (
          <SmartEngineReviewCard key={`${item.asin}-${item.marketplace}`} item={item} />
        ))}
      </div>
    </div>
  );
}
