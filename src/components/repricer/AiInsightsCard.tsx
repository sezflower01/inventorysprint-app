import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Brain, Shield, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle2, Clock, Zap, Eye, ChevronDown, ChevronUp,
  ShieldCheck, Target, Activity, History, ArrowRight
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { getAiInsightHeadline, insightToneClasses } from "@/lib/aiInsightHeadline";

export interface AiInsightEvent {
  id: string;
  asin: string;
  sku: string;
  marketplace: string;
  event_type: string;
  action_type: string;
  decision_label: string;
  tuning_signal: string;
  current_price: number | null;
  target_price: number | null;
  buy_box_price: number | null;
  lowest_fba_price: number | null;
  next_competitor_price: number | null;
  min_price: number | null;
  max_price: number | null;
  profit_floor: number | null;
  constraints_json: string[];
  engine_mode: string;
  confidence_score: number | null;
  was_bb_owner: boolean;
  was_price_changed: boolean;
  created_at: string;
  title?: string;
  image_url?: string;
  rule_name?: string;
  last_recommendation_reason?: string;
  /** "pro" | "flash" | null — drives the "AI-reviewed by …" badge */
  model_tier?: string | null;
  /** Raw model id (e.g. "gemini-2.5-flash") if available, used for tooltip only */
  model_used?: string | null;
}

interface SignalSummary {
  bb_loss: number;
  raised: number;
  constrained: number;
  winner: number;
}

interface Props {
  event: AiInsightEvent;
  signalSummary?: SignalSummary;
  isAdmin?: boolean;
  /** Most recent event for this ASIN — used to flag superseded historical decisions. */
  latestForAsin?: AiInsightEvent;
}

const eventIcon = (type: string) => {
  switch (type) {
    case "bb_loss": return <TrendingDown className="h-4 w-4 text-red-400" />;
    case "raised": return <TrendingUp className="h-4 w-4 text-green-400" />;
    case "constrained": return <AlertTriangle className="h-4 w-4 text-yellow-400" />;
    case "winner": return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    default: return <Eye className="h-4 w-4 text-muted-foreground" />;
  }
};

const eventLabel = (type: string) => {
  switch (type) {
    case "bb_loss": return "Buy Box Lost";
    case "raised": return "Price Raised";
    case "constrained": return "Constrained";
    case "winner": return "Winning";
    default: return type;
  }
};

const eventColor = (type: string) => {
  switch (type) {
    case "bb_loss": return "bg-red-500/15 text-red-400 border-red-500/30";
    case "raised": return "bg-green-500/15 text-green-400 border-green-500/30";
    case "constrained": return "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
    case "winner": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    default: return "bg-muted text-muted-foreground";
  }
};

/** Structured decision breakdown */
function getDecisionBreakdown(e: AiInsightEvent) {
  const constraints = e.constraints_json || [];
  const hasFloorConstraint = constraints.some(c => c.includes("min_price") || c.includes("effective_floor"));
  const hasCluster = constraints.some(c => c.includes("cluster"));
  const hasRecovery = constraints.some(c => c.startsWith("underpriced_recovery"));
  const hasSevereRecovery = constraints.includes("underpriced_recovery_severe");
  const hasAnomaly = constraints.includes("data_low_confidence") || constraints.includes("market_inconsistent");
  const gap = e.buy_box_price && e.current_price ? Math.abs(e.current_price - e.buy_box_price) : null;

  // Build a "proof" line surfacing actual floor/ROI numbers when available.
  const proofParts: string[] = [];
  if (e.min_price != null) proofParts.push(`Min price: $${e.min_price.toFixed(2)}`);
  if (e.profit_floor != null) proofParts.push(`ROI floor: $${e.profit_floor.toFixed(2)}`);
  if (e.current_price != null && e.profit_floor != null && e.profit_floor > 0) {
    const gapToFloor = ((e.current_price - e.profit_floor) / e.profit_floor) * 100;
    proofParts.push(`Current vs floor: ${gapToFloor >= 0 ? "+" : ""}${gapToFloor.toFixed(1)}%`);
  }
  const proof = proofParts.length ? proofParts.join(" · ") : null;

  // ── Underpriced recovery (NEW) ──
  if (hasRecovery) {
    const situation = e.buy_box_price && e.current_price && e.buy_box_price > e.current_price
      ? `You're underpriced — market at $${e.buy_box_price.toFixed(2)}, you're at $${e.current_price.toFixed(2)}`
      : "You're priced significantly below the market cluster";
    const decision = `RAISE_TO_MARKET → $${(e.target_price || e.current_price || 0).toFixed(2)}${hasSevereRecovery ? " (severe gap, fast cadence)" : ""}`;
    const reasoning = `AI detected your price is ${hasSevereRecovery ? "severely" : "meaningfully"} below the competitive cluster. Stepping price UP toward market to recover lost margin while staying within your floor.`;
    const outcome = { icon: "check" as const, text: hasSevereRecovery ? "Margin recovery (fast)" : "Margin recovery", color: "text-emerald-400" };
    return { situation, decision, reasoning, outcome, proof };
  }

  // ── Anomaly ──
  if (hasAnomaly && (e.event_type === "constrained" || e.event_type === "bb_loss")) {
    const situation = "Market data looks inconsistent — possible stale prices, FBM/used mismatch, or suppressed BB";
    const decision = "HOLD — Data low confidence";
    const reasoning = "The AI detected a market anomaly (target unrealistic, huge spread, or no Buy Box with high prices). Holding to avoid acting on bad data.";
    const outcome = { icon: "alert" as const, text: "Anomaly detected", color: "text-yellow-400" };
    return { situation, decision, reasoning, outcome, proof };
  }

  if (e.event_type === "bb_loss") {
    const situation = gap && e.buy_box_price && e.current_price && e.buy_box_price < e.current_price
      ? `Competitor undercut by $${gap.toFixed(2)} — Buy Box now at $${e.buy_box_price.toFixed(2)}`
      : "Buy Box ownership was lost to a competitor";

    const decision = hasFloorConstraint
      ? "HOLD — AI chose to protect your profit margin"
      : e.action_type === "no_change"
        ? "HOLD — No safe price move within current bounds"
        : "RECAPTURE — AI adjusted price to compete";

    const reasoning = hasFloorConstraint
      ? `Dropping price would breach your floor. ${proof ?? "Min price / ROI floor protection active."}`
      : e.action_type === "no_change"
        ? "All available price moves would breach safety guardrails. The AI is holding position until market conditions improve."
        : "AI found a competitive price point that maintains profitability while improving Buy Box chances.";

    const outcome = hasFloorConstraint
      ? { icon: "shield" as const, text: "Profit protected", color: "text-blue-400" }
      : e.action_type === "no_change"
        ? { icon: "alert" as const, text: "Market too aggressive", color: "text-yellow-400" }
        : { icon: "check" as const, text: "Competitive move applied", color: "text-emerald-400" };

    return { situation, decision, reasoning, outcome, proof };
  }

  if (e.event_type === "raised") {
    const situation = e.was_bb_owner
      ? "You own the Buy Box — safe window to increase margin"
      : "Competitive position allows margin extraction";

    const newPriceStr = `$${(e.target_price || e.current_price || 0).toFixed(2)}`;
    const fromStr = e.current_price != null && e.target_price != null && e.target_price !== e.current_price
      ? ` (from $${e.current_price.toFixed(2)})`
      : "";
    const decision = `RAISE → ${newPriceStr}${fromStr}`;

    let reasoning = "AI increased price to extract additional profit while maintaining competitive position.";
    if (e.was_bb_owner) reasoning += " As Buy Box owner, raising price is low-risk — the AI targets the next competitor ceiling.";
    if (hasCluster) reasoning += " A price cluster was detected nearby — the raise was limited to stay within the competitive rotation group.";

    const outcome = { icon: "check" as const, text: "Margin optimized", color: "text-emerald-400" };
    return { situation, decision, reasoning, outcome, proof };
  }

  if (e.event_type === "constrained") {
    const situation = "AI identified a better price but safety rules blocked the change";
    const decision = "BLOCKED — Safety guardrails enforced";

    const constraintNames = constraints.slice(0, 4).map(c => {
      if (c.includes("data_low_confidence")) return "⚠️ unrealistic target rejected";
      if (c.includes("market_inconsistent")) return "⚠️ market data inconsistent (likely stale or FBM/used mismatch)";
      if (c.includes("min_price") || c.includes("effective_floor") || c.includes("universal_floor")) return "minimum price floor";
      if (c.includes("roi") || c.includes("profit")) return "ROI protection";
      if (c.includes("oscillation")) return "oscillation guard";
      if (c.includes("cluster")) return "cluster protection";
      if (c.includes("max_price")) return "maximum price cap";
      if (c.includes("cooldown")) return "cooldown active";
      if (c.includes("above_bb_not_owner")) return "overpriced vs Buy Box (will undercut next cycle)";
      return c.replace(/_/g, " ");
    });

    const reasoning = constraintNames.length
      ? `Blocked by: ${constraintNames.join(", ")}. ${proof ?? "Your safety settings are working correctly."}`
      : "Safety guardrails prevented the price change. Your protection settings are active and working as designed.";

    const outcome = { icon: "shield" as const, text: "Safety enforced", color: "text-yellow-400" };
    return { situation, decision, reasoning, outcome, proof };
  }

  // winner — split copy depending on whether the AI actually moved price this cycle
  if (e.was_price_changed && e.target_price != null && e.current_price != null) {
    const wentUp = e.target_price > e.current_price;
    const situation = e.was_bb_owner
      ? "You own the Buy Box — AI fine-tuned price to optimize margin"
      : "Strong competitive position — AI fine-tuned price";
    const decision = wentUp
      ? `RAISE → $${e.target_price.toFixed(2)} (from $${e.current_price.toFixed(2)})`
      : `MICRO-ADJUST → $${e.target_price.toFixed(2)} (from $${e.current_price.toFixed(2)})`;
    const reasoning = wentUp
      ? "AI nudged price up to extract additional margin while keeping you in the winning position. Low risk because you already control the Buy Box."
      : "AI made a small downward adjustment to stay defensively positioned and protect Buy Box ownership against nearby competitors.";
    const outcome = { icon: "check" as const, text: wentUp ? "Margin optimized" : "Position defended", color: "text-emerald-400" };
    return { situation, decision, reasoning, outcome, proof };
  }

  const situation = "ASIN is performing optimally — no adjustment needed";
  const decision = "MONITOR — Optimal position maintained";
  const reasoning = "The AI confirmed this ASIN is well-positioned. No price changes are necessary. The engine continues to monitor for market shifts and will react instantly if conditions change.";
  const outcome = { icon: "check" as const, text: "Stable & optimized", color: "text-emerald-400" };
  return { situation, decision, reasoning, outcome, proof };
}


function confidenceLabel(score: number | null): { label: string; color: string } {
  if (!score || score <= 0) return { label: "N/A", color: "text-muted-foreground" };
  if (score >= 75) return { label: "High", color: "text-emerald-400" };
  if (score >= 50) return { label: "Medium", color: "text-yellow-400" };
  return { label: "Low", color: "text-red-400" };
}

const OutcomeIcon = ({ type }: { type: "shield" | "check" | "alert" }) => {
  switch (type) {
    case "shield": return <ShieldCheck className="h-3.5 w-3.5" />;
    case "check": return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "alert": return <AlertTriangle className="h-3.5 w-3.5" />;
  }
};

export default function AiInsightsCard({ event: e, signalSummary, isAdmin, latestForAsin }: Props) {
  const [expanded, setExpanded] = useState(false);
  const conf = confidenceLabel(e.confidence_score);
  const breakdown = getDecisionBreakdown(e);

  // ── Supersession detection ──
  // A historical HOLD/CONSTRAINED is "superseded" if a newer event for the same ASIN
  // (a) exists, (b) is meaningfully newer (>30s), and (c) actually changed price OR
  // produced a different decision class (raised / winner / price_changed).
  const isSuperseded = (() => {
    if (!latestForAsin || latestForAsin.id === e.id) return false;
    const tNew = new Date(latestForAsin.created_at).getTime();
    const tOld = new Date(e.created_at).getTime();
    if (tNew - tOld < 30_000) return false;
    const wasHoldOrBlocked =
      e.action_type === "no_change" ||
      e.event_type === "constrained" ||
      (e.event_type === "bb_loss" && !e.was_price_changed);
    const newerActed =
      latestForAsin.was_price_changed ||
      latestForAsin.action_type === "price_changed" ||
      latestForAsin.event_type === "raised" ||
      latestForAsin.event_type === "winner";
    return wasHoldOrBlocked && newerActed;
  })();

  const decisionAge = (() => {
    try { return formatDistanceToNow(new Date(e.created_at), { addSuffix: true }); }
    catch { return null; }
  })();

  const safetyChecks = [
    { label: "ROI Floor", ok: !e.constraints_json?.some(c => c.includes("roi") || c.includes("profit_guard")), detail: e.profit_floor ? `$${e.profit_floor.toFixed(2)}` : undefined },
    { label: "Min Price", ok: !e.constraints_json?.some(c => c === "min_price" || c === "effective_floor"), detail: e.min_price ? `$${e.min_price.toFixed(2)}` : undefined },
    { label: "Max Price", ok: true, detail: e.max_price ? `$${e.max_price.toFixed(2)}` : undefined },
    { label: "Oscillation Guard", ok: !e.constraints_json?.some(c => c.includes("oscillation")) },
  ];

  return (
    <Card className={cn(
      "border-border/40 bg-card/80 backdrop-blur-sm hover:border-border/60 transition-colors",
      isSuperseded && "opacity-80"
    )}>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {e.image_url && (
              <img src={e.image_url} alt="" className="w-10 h-10 rounded object-cover border border-border/30 flex-shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold text-foreground">{e.asin}</span>
                <Badge className={cn("text-[10px] px-1.5 py-0 border", eventColor(e.event_type))}>
                  {eventIcon(e.event_type)}
                  <span className="ml-1">{eventLabel(e.event_type)}</span>
                </Badge>
                {e.was_price_changed && e.action_type === "price_changed" && (
                  <Badge className="text-[10px] px-1.5 py-0 bg-blue-500/15 text-blue-400 border-blue-500/30">
                    Price Changed
                  </Badge>
                )}
                {isSuperseded && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 gap-1 border-amber-500/40 text-amber-400 bg-amber-500/10"
                    title="A newer evaluation has replaced this decision"
                  >
                    <History className="h-3 w-3" />
                    Superseded
                  </Badge>
                )}
              </div>
              {e.title && (
                <p className="text-xs text-muted-foreground truncate max-w-[400px] mt-0.5">{e.title}</p>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground" title={new Date(e.created_at).toLocaleString()}>
                Decision · {new Date(e.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <button onClick={() => setExpanded(!expanded)} className="p-1 rounded hover:bg-muted/50 transition-colors">
                {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
            </div>
            {decisionAge && (
              <span className="text-[10px] text-muted-foreground/70">{decisionAge}</span>
            )}
          </div>
        </div>

        {/* Superseded banner — surfaces the newer action so users don't think AI was wrong */}
        {isSuperseded && latestForAsin && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-center gap-2 text-xs">
            <History className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
            <span className="text-muted-foreground">This decision was replaced by a newer evaluation</span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-foreground">
              {latestForAsin.was_price_changed && latestForAsin.target_price != null
                ? `Price changed to $${latestForAsin.target_price.toFixed(2)}`
                : eventLabel(latestForAsin.event_type)}
            </span>
            <span className="text-muted-foreground ml-auto">
              {new Date(latestForAsin.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        )}

        {/* Market Situation */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="bg-muted/30 rounded p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Your Price</p>
            <p className="text-sm font-semibold">{e.current_price ? `$${e.current_price.toFixed(2)}` : "—"}</p>
          </div>
          <div className="bg-muted/30 rounded p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Buy Box</p>
            <p className="text-sm font-semibold">{e.buy_box_price ? `$${e.buy_box_price.toFixed(2)}` : "—"}</p>
          </div>
          <div className="bg-muted/30 rounded p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Lowest FBA</p>
            <p className="text-sm font-semibold">{e.lowest_fba_price ? `$${e.lowest_fba_price.toFixed(2)}` : "—"}</p>
          </div>
          <div className="bg-muted/30 rounded p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {e.target_price && e.target_price !== e.current_price ? "Target" : "Status"}
            </p>
            <p className="text-sm font-semibold">
              {e.target_price && e.target_price !== e.current_price
                ? `$${e.target_price.toFixed(2)}`
                : e.was_bb_owner ? "🏆 BB Owner" : "🔄 Competing"}
            </p>
          </div>
        </div>

        {/* BIG AI INSIGHT — deterministic, human-first headline */}
        {(() => {
          const h = getAiInsightHeadline({
            event_type: e.event_type,
            action_type: e.action_type,
            was_bb_owner: e.was_bb_owner,
            was_price_changed: e.was_price_changed,
            current_price: e.current_price,
            target_price: e.target_price,
            buy_box_price: e.buy_box_price,
            constraints_json: e.constraints_json,
          });
          const tone = insightToneClasses[h.tone];
          // Row badge — reflects reality:
          //   - Every price decision is made by the deterministic repricer engine.
          //   - Gemini writes a separate observation note on some rows; that
          //     note does NOT alter the decision that already executed.
          //   - tier 'pro'   → "AI observation (Gemini Pro)"  (violet)
          //   - tier 'flash' → "AI observation (Gemini Flash)" (primary)
          //   - otherwise    → "Repricer decision"                (neutral)
          const tier = (e.model_tier || "").toLowerCase();
          const isPro = tier === "pro";
          const isFlash = tier === "flash";
          const isAiReviewed = isPro || isFlash;
          const modelLabel = isPro
            ? "AI observation (Gemini Pro)"
            : isFlash
              ? "AI observation (Gemini Flash)"
              : "Repricer decision";
          const modelBadgeClass = isPro
            ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
            : isFlash
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border/60 bg-muted/40 text-muted-foreground";
          const modelTooltip = isAiReviewed
            ? "The deterministic repricer made this decision using its rules. Gemini added an observation note about it separately — this note did not affect the decision."
            : "The deterministic repricer made this decision using its rules. No AI observation was written for this row.";
          return (
            <div
              className={cn(
                "rounded-lg border px-4 py-3 flex items-start gap-3",
                tone.box,
              )}
              role="status"
              aria-label="AI insight"
            >
              <span className="text-2xl leading-none mt-0.5" aria-hidden>{h.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-base sm:text-lg font-semibold leading-snug", tone.text)}>
                  {h.text}
                </p>
                {h.subtext && (
                  <p className="text-xs text-muted-foreground mt-1">{h.subtext}</p>
                )}
                <div className="mt-2">
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] gap-1 font-medium", modelBadgeClass)}
                    title={modelTooltip}
                  >
                    <Brain className="h-3 w-3" />
                    {modelLabel}
                  </Badge>
                </div>
              </div>
            </div>
          );
        })()}

        {/* AI Decision Breakdown — structured */}
        <div className="bg-primary/5 border border-primary/10 rounded-lg p-3 space-y-2.5">
          {/* Situation Detected */}
          <div className="flex items-start gap-2">
            <Target className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Situation Detected</p>
              <p className="text-xs text-foreground">{breakdown.situation}</p>
            </div>
          </div>

          {/* Decision */}
          <div className="flex items-start gap-2">
            <Activity className="h-3.5 w-3.5 text-primary mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Decision</p>
              <p className="text-xs font-semibold text-primary">{breakdown.decision}</p>
            </div>
          </div>

          {/* Why this is correct */}
          <div className="flex items-start gap-2">
            <Brain className="h-3.5 w-3.5 text-primary mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Why This Is Correct</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{breakdown.reasoning}</p>
            </div>
          </div>

          {/* Outcome Insight */}
          <div className={cn("flex items-center gap-2 pt-1.5 border-t border-primary/10", breakdown.outcome.color)}>
            <OutcomeIcon type={breakdown.outcome.icon} />
            <span className="text-xs font-medium">{breakdown.outcome.text}</span>
          </div>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="space-y-3 pt-1 border-t border-border/30">
            {/* Safety Checks */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <Shield className="h-3 w-3" /> Safety Checks
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {safetyChecks.map(sc => (
                  <div key={sc.label} className={cn(
                    "flex items-center gap-1.5 rounded px-2 py-1 text-[11px]",
                    sc.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                  )}>
                    {sc.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                    <span>{sc.label}</span>
                    {sc.detail && <span className="text-muted-foreground ml-auto">{sc.detail}</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Learning Signals */}
            {signalSummary && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  <Zap className="h-3 w-3" /> Learning Signals (7d)
                </p>
                <div className="flex gap-3 flex-wrap">
                  {signalSummary.bb_loss > 0 && <span className="text-xs text-red-400">BB Lost: {signalSummary.bb_loss}×</span>}
                  {signalSummary.raised > 0 && <span className="text-xs text-green-400">Raised: {signalSummary.raised}×</span>}
                  {signalSummary.constrained > 0 && <span className="text-xs text-yellow-400">Constrained: {signalSummary.constrained}×</span>}
                  {signalSummary.winner > 0 && <span className="text-xs text-emerald-400">Winner: {signalSummary.winner}×</span>}
                  {!signalSummary.bb_loss && !signalSummary.raised && !signalSummary.constrained && !signalSummary.winner && (
                    <span className="text-xs text-muted-foreground">No signals yet</span>
                  )}
                </div>
              </div>
            )}

            {/* Engine Constraints */}
            {e.constraints_json?.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Engine Constraints Applied
                </p>
                <div className="flex flex-wrap gap-1">
                  {e.constraints_json.map((c, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] font-mono bg-muted/20">
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* AI Confidence & metadata */}
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Brain className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground">AI Confidence:</span>
                <span className={cn("text-xs font-semibold", conf.color)}>{conf.label}</span>
              </div>
              {e.rule_name && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Rule:</span>
                  <span className="text-xs font-medium">{e.rule_name}</span>
                </div>
              )}
              {e.engine_mode && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Mode:</span>
                  <span className="text-xs font-mono">{e.engine_mode}</span>
                </div>
              )}
            </div>

            {/* Admin-only */}
            {isAdmin && e.last_recommendation_reason && (
              <div className="bg-muted/20 rounded p-2">
                <p className="text-[10px] text-muted-foreground mb-1">Raw Engine Reason (Admin)</p>
                <p className="text-[11px] font-mono text-muted-foreground break-all">{e.last_recommendation_reason}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
