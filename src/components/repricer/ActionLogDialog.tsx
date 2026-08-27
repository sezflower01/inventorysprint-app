import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { RefreshCw, CheckCircle, XCircle, ArrowUp, ArrowDown, Shield, TrendingUp, TrendingDown, AlertTriangle, Clock, PauseCircle, Lightbulb, Wrench, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { translateErrorMessage } from "@/lib/errorTranslator";
import BbStatusBadge from "./BbStatusBadge";
import { format } from "date-fns";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import EvalDiagnosticsPanels from "@/components/repricer/EvalDiagnosticsPanels";
import { logSettingChange } from "@/lib/repricerChangeLog";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface MinPriceSuggestion {
  competitive_price: number;
  suggested_min: number;
  current_min: number | null;
  effective_floor: number | null;
  gap_amount: number | null;
  gap_percent: number | null;
  projected_roi: number | null;
  unit_cost: number | null;
}

interface PriceAction {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  old_price: number | null;
  new_price: number | null;
  old_min_price: number | null;
  new_min_price: number | null;
  old_max_price: number | null;
  new_max_price: number | null;
  action_type: string;
  trigger_source: string;
  reason: string | null;
  intelligence_factors: any | null;
  success: boolean;
  error_message: string | null;
  amazon_response: any | null;
  created_at: string;
  rule_name: string | null;
  min_price_suggestion: MinPriceSuggestion | null;
  reconciliation_status?: string | null;
  reconciliation_reason?: string | null;
  verified_live_price?: number | null;
  verified_at?: string | null;
  intended_price?: number | null;
  recon_root_cause?: string | null;
}

interface ActionLogDialogProps {
  asin: string | null;
  sku: string | null;
  marketplace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overrideStatus?: string | null;
  onMinPriceAccepted?: (asin: string, sku: string | null, newMin: number) => void;
}

// Build a single human-readable explain line from action data
function buildExplainLine(action: PriceAction): string {
  // Priority eval with no price change → simple human message
  if (action.action_type === 'priority_eval') {
    return humanizePriorityEval(action.reason);
  }

  const f = action.intelligence_factors || {};
  const rc = f.reason_codes || {};
  const reason = action.reason || '';
  const parts: string[] = [];

  // Anchor source — from structured fields first, then reason_codes, then parse reason
  const anchorKey = f.anchor_source || rc.anchor_source || f.bb_source;
  const anchorPrice = f.anchor_price;
  if (anchorKey && anchorPrice != null) {
    const label = anchorKey === 'buybox_winner_offer' ? 'Buy Box (winner offer)'
      : anchorKey === 'buybox_summary' ? 'Buy Box (summary)'
      : anchorKey === 'buybox_fallback' ? 'Buy Box (fallback)'
      : anchorKey === 'lowest_eligible' ? 'lowest eligible'
      : anchorKey === 'lowest_fba' ? 'Lowest FBA'
      : anchorKey === 'lowest_fbm' ? 'Lowest FBM'
      : anchorKey === 'lowest_offer' ? 'lowest offer'
      : anchorKey === 'fbm_target' ? 'FBM target'
      : anchorKey;
    parts.push(`Anchored to ${label} $${Number(anchorPrice).toFixed(2)}`);
  } else if (anchorKey) {
    parts.push(`Anchored to ${anchorKey}`);
  } else if (reason) {
    const bbMatch = reason.match(/Buy Box \(\$([\d.]+)\)\s*(?:\[(\w+)\])?/i);
    const lowestMatch = reason.match(/Lowest eligible \(\$([\d.]+)\)/i);
    if (bbMatch) {
      const src = bbMatch[2] || 'unknown';
      parts.push(`Anchored to Buy Box $${bbMatch[1]} (${src === 'winner_offer' ? 'winner offer' : src})`);
    } else if (lowestMatch) {
      parts.push(`Anchored to lowest eligible $${lowestMatch[1]}`);
    }
  }

  // BB confidence
  const bbConf = rc.bb_confidence || f.bb_confidence;
  if (bbConf) parts.push(`BB confidence ${bbConf.toUpperCase()}`);

  // Undercut info from structured fields or reason.
  // Show BOTH the tuned/theoretical value AND the actually-applied $ delta
  // (anchor − final price), since rounding can make them differ.
  const appliedUndercut =
    anchorPrice != null && action.new_price != null
      ? Math.round((Number(anchorPrice) - Number(action.new_price)) * 100) / 100
      : null;
  let tunedUndercut: number | null = null;
  let tunedMultiplier: number | null = null;
  if (f.undercut_effective != null && f.multiplier_used != null) {
    tunedUndercut = Number(f.undercut_effective);
    tunedMultiplier = Number(f.multiplier_used);
  } else {
    const undercutMatch = reason.match(/\$([\d.]+) undercut \(([\d.]+)x\)/);
    if (undercutMatch) {
      tunedUndercut = Number(undercutMatch[1]);
      tunedMultiplier = Number(undercutMatch[2]);
    }
  }
  if (appliedUndercut != null && appliedUndercut >= 0) {
    if (tunedUndercut != null && tunedMultiplier != null) {
      parts.push(
        `undercut $${appliedUndercut.toFixed(2)} applied [tuned $${tunedUndercut.toFixed(2)} @ ${tunedMultiplier.toFixed(2)}x]`
      );
    } else {
      parts.push(`undercut $${appliedUndercut.toFixed(2)} applied`);
    }
  } else if (tunedUndercut != null && tunedMultiplier != null) {
    parts.push(`undercut $${tunedUndercut.toFixed(2)} (${tunedMultiplier.toFixed(2)}x)`);
  }

  // Target prices
  if (f.target_price_pre_guards != null) {
    parts.push(`target $${Number(f.target_price_pre_guards).toFixed(2)}`);
  } else {
    const targetMatch = reason.match(/→ \$([\d.]+)/);
    if (targetMatch) parts.push(`target $${targetMatch[1]}`);
  }

  // Floor info: show the actual effective floor used, clearly labeled
  const guards = f.guards_applied || [];
  const hasMinPriceGuard = Array.isArray(guards) && guards.includes('min_price');
  const hasTargetBelowMin = Array.isArray(guards) && guards.includes('target_below_min_applied_floor');
  const manualMin = action.old_min_price ?? f.min_price ?? null;
  const roiFloorVal = f.floor_price != null ? Number(f.floor_price) : null;

  if ((hasMinPriceGuard || hasTargetBelowMin) && manualMin != null) {
    parts.push(`Manual Min $${Number(manualMin).toFixed(2)}`);
  }
  if (roiFloorVal != null && roiFloorVal > 0) {
    // Only show ROI floor if it's different from manual min (avoids redundancy)
    if (manualMin == null || Math.abs(roiFloorVal - Number(manualMin)) > 0.02) {
      parts.push(`ROI floor $${roiFloorVal.toFixed(2)}`);
    }
  }
  // Don't fall back to regex-extracted "floor" from reason strings — those often contain
  // misleading values like lowestOverallPrice, not the actual pricing floor

  // Offers status
  const offStatus = rc.offers_status;
  if (offStatus && offStatus !== 'ok') parts.push(`offers: ${offStatus}`);

  // Filters
  const filters = rc.filters_applied;
  if (filters && filters.length > 0) parts.push(`filtered: ${filters.join(', ')}`);

  // Smart engine
  const tuning = f.tuning_source;
  if (tuning) parts.push(`engine: ${tuning}`);

  // Result
  if (!action.success) {
    const errType = action.error_message || action.action_type;
    parts.push(`result: FAILED (${errType})`);
  } else if (action.action_type === 'blocked_by_profit_guard') {
    parts.push('result: BLOCKED (profit guard)');
  } else if (action.action_type === 'price_change') {
    const dir = action.new_price != null && action.old_price != null
      ? action.new_price > action.old_price ? 'UP' : action.new_price < action.old_price ? 'DOWN' : 'HOLD'
      : 'CHANGE';
    parts.push(`result: ${dir}`);
  } else if (action.action_type === 'hold') {
    parts.push('result: HOLD (no change needed)');
  } else if (action.action_type === 'minmax_change') {
    parts.push('result: MIN/MAX updated');
  } else {
    parts.push(`result: ${action.action_type}`);
  }

  // Safeguards summary
  const safeguards = extractSafeguards(action.reason, f);
  if (safeguards.length > 0) parts.push(`guards: ${safeguards.join(', ')}`);

  return parts.join(', ') + '.';
}

// Plain-English label for the raw trigger_source value shown on every log entry.
function humanizeTriggerSource(trigger: string | null | undefined): string {
  const labels: Record<string, string> = {
    manual: "Manual edit",
    manual_run_selected: "Manual run",
    rule_change: "Rule/limit update",
    bounds_changed: "Price limits changed",
    priority_cron: "Automatic (priority check)",
    scheduler: "Automatic (scheduled check)",
    priority_eval: "Automatic (priority check)",
  };
  if (!trigger) return "Automatic";
  return labels[trigger] || trigger.replace(/_/g, " ");
}

// Plain-English label for a safeguard code, for use outside the colored badges.
function humanizeSafeguard(code: string): string {
  const labels: Record<string, string> = {
    CLAMPED_MAX: "capped at your max price",
    CLAMPED_MIN: "raised to your min price",
    FINAL_CLAMP_MAX: "capped at your max price",
    FINAL_CLAMP_MIN: "raised to your min price",
    JUMP_LIMITED: "limited to a smaller step to avoid a big jump",
    STEP_LIMITED: "limited to a smaller step",
    COOLDOWN: "held back by a cooldown period",
    SAFETY_ABORT: "stopped by a safety check",
    PROFIT_GUARD: "protected by your profit guard",
  };
  return labels[code] || code.toLowerCase().replace(/_/g, " ");
}

// Plain-English one-line summary of what happened, for regular (non-technical)
// users. This replaces the dense, jargon-heavy buildExplainLine() as the
// default view — the technical trace is still available by switching the
// panel to "Detailed" view.
function buildPlainSummary(action: PriceAction, marketplace: string): string {
  const formatCurrency = (val: number | null) => {
    if (val == null) return "—";
    const config = getMarketplaceConfig(marketplace);
    return `${config.currencySymbol}${val.toFixed(2)}`;
  };

  if (action.action_type === 'priority_eval') {
    return humanizePriorityEval(action.reason);
  }

  const f = action.intelligence_factors || {};
  const safeguards = extractSafeguards(action.reason, f);
  const safeguardSuffix = safeguards.length > 0
    ? ` (${safeguards.map(humanizeSafeguard).join(', ')})`
    : '';

  if (!action.success) {
    return `Update failed${action.error_message ? ` — ${action.error_message}` : ''}.`;
  }

  // Smart Match anchors to Buy Box or Lowest FBA depending on ownership, so
  // its plain-English line should say WHY that anchor was picked, not just
  // which one. Live-verified against real evaluations: downstream guards
  // (min-floor blocks, self-undercut holds, filtered-empty holds) routinely
  // overwrite `reason` with their own message and drop the raw
  // [anchor:smart_recapture — ...] tag the anchor-selection switch writes —
  // so recapture is detected primarily from the structured
  // 'smart_recapture_enforced' guard (present even when the floor blocks the
  // move), with the raw tag only as a fallback. "Already owner" covers every
  // phrasing real holds actually use ("(BB owner)" / "(BB owned)" / "already
  // lowest"), not just the anchor-switch's own wording.
  const isSmartMatch = f.strategy_visibility?.profile_key === 'SMART_MATCH';
  const smartMatchReason = action.reason || '';
  const smartMatchGuards: string[] = f.guards_applied || [];
  const smartMatchIsRecapture = smartMatchGuards.includes('smart_recapture_enforced')
    || /anchor:smart_recapture.*(not lowest|ENFORCED)/i.test(smartMatchReason);
  const smartMatchIsAlreadyOwner = !smartMatchIsRecapture
    && /\(BB owner\)|\(BB owned\)|already lowest|anchor:smart_recapture.*already lowest/i.test(smartMatchReason);

  // Smart Match — outlier protection: the cluster-based anchor override fired,
  // meaning the lowest live offer was judged a likely pricing error and
  // ignored in favor of the real competitive band (see analyzeCompetitorClusters
  // / 'cluster_anchor_override' in repricer-ai-evaluate/index.ts).
  if (isSmartMatch && (f.guards_applied || []).includes('cluster_anchor_override')) {
    const heldPrice = action.new_price ?? action.old_price;
    const outlierPrice = f.price_trace?.lowest_overall ?? null;
    const clusterPrice = f.anchor_price ?? f.price_trace?.final_price ?? null;
    const gapPct = outlierPrice && clusterPrice && outlierPrice > 0
      ? Math.round(((clusterPrice - outlierPrice) / outlierPrice) * 100)
      : null;
    const outlierClause = outlierPrice != null
      ? ` the lowest competitor offer (${formatCurrency(outlierPrice)}) looks like a pricing error${gapPct != null ? ` (${gapPct}% below the next closest seller)` : ''}, so it was ignored.`
      : ` the lowest competitor offer looked like a pricing error, so it was ignored.`;
    return `Price held at ${formatCurrency(heldPrice)} —${outlierClause}`;
  }

  // Plain-English source of the target price (competitor anchor), when relevant.
  const anchorKey = f.anchor_source || f.reason_codes?.anchor_source || f.bb_source;
  const anchorPrice = f.anchor_price;
  let anchorPhrase = '';
  if (anchorKey && anchorPrice != null) {
    const anchorAmount = formatCurrency(Number(anchorPrice));
    const label = String(anchorKey).includes('buybox') ? `the Buy Box price (${anchorAmount})`
      : String(anchorKey).includes('fba') ? `the lowest FBA competitor (${anchorAmount})`
      : String(anchorKey).includes('fbm') ? `the lowest FBM competitor (${anchorAmount})`
      : `the lowest competitor price (${anchorAmount})`;
    anchorPhrase = ` to match ${label}`;
    if (isSmartMatch && smartMatchIsRecapture) {
      anchorPhrase += ` — recapturing the Buy Box, which you didn't currently hold`;
    } else if (isSmartMatch && smartMatchIsAlreadyOwner) {
      anchorPhrase += ` — you already own the Buy Box, no change needed`;
    }
  }

  if (action.action_type === 'minmax_change') {
    const minChanged = action.new_min_price != null && action.old_min_price !== action.new_min_price;
    const maxChanged = action.new_max_price != null && action.old_max_price !== action.new_max_price;
    if (minChanged && maxChanged) {
      return `Price limits updated: Min ${formatCurrency(action.old_min_price)} → ${formatCurrency(action.new_min_price)}, Max ${formatCurrency(action.old_max_price)} → ${formatCurrency(action.new_max_price)}.`;
    }
    if (minChanged) {
      return `Min price limit changed from ${formatCurrency(action.old_min_price)} to ${formatCurrency(action.new_min_price)}.`;
    }
    if (maxChanged) {
      return `Max price limit changed from ${formatCurrency(action.old_max_price)} to ${formatCurrency(action.new_max_price)}.`;
    }
    return `Price limits saved — no change from the current value.`;
  }

  if (action.action_type === 'blocked_by_profit_guard') {
    return `Price change blocked — it would have dropped profit below your safety limit.`;
  }

  if (action.action_type === 'hold') {
    if (isSmartMatch && smartMatchIsAlreadyOwner) {
      return `Checked — you already hold the Buy Box, no change needed.`;
    }
    return `Checked — price is already competitive, no change needed.`;
  }

  if (action.old_price != null && action.new_price != null) {
    if (action.new_price > action.old_price) {
      return `Price raised from ${formatCurrency(action.old_price)} to ${formatCurrency(action.new_price)}${anchorPhrase}${safeguardSuffix}.`;
    }
    if (action.new_price < action.old_price) {
      return `Price lowered from ${formatCurrency(action.old_price)} to ${formatCurrency(action.new_price)}${anchorPhrase}${safeguardSuffix}.`;
    }
    return `Price re-confirmed at ${formatCurrency(action.new_price)}${anchorPhrase}${safeguardSuffix}.`;
  }

  return humanizeTriggerSource(action.trigger_source) + (safeguardSuffix || '.');
}

// Convert priority_eval reason into plain English
export function humanizePriorityEval(reason: string | null): string {
  if (!reason) return '⭐ Priority check — no changes needed.';
  
  const evalMatch = reason.match(/(\d+) evaluated/);
  const skipMatch = reason.match(/(\d+) BB-unchanged skipped/);
  const evaluated = evalMatch ? parseInt(evalMatch[1]) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1]) : 0;
  
  if (evaluated === 0 && skipped > 0) {
    return `⭐ Priority check — Buy Box price unchanged, no action needed.`;
  }
  if (evaluated > 0 && skipped === 0) {
    return `⭐ Priority check — checked ${evaluated} starred item${evaluated > 1 ? 's' : ''}, price is already competitive.`;
  }
  if (evaluated > 0 && skipped > 0) {
    return `⭐ Priority check — ${evaluated} checked, ${skipped} skipped (Buy Box unchanged).`;
  }
  return `⭐ Priority check — no changes needed.`;
}

function getLatestTimestamp(...values: Array<string | null | undefined>): string | null {
  const validValues = values.filter((value): value is string => Boolean(value));
  if (validValues.length === 0) return null;

  return validValues.reduce((latest, current) => {
    return new Date(current).getTime() > new Date(latest).getTime() ? current : latest;
  });
}

function humanizeSkipReason(reason: string | null | undefined, details?: string | null): string | null {
  if (!reason) return null;

  if (reason === 'DAILY_CHECK_CAP') {
    const checkedMatch = details?.match(/Checked\s+(\d+)\/(\d+)\s+times today/i);
    if (checkedMatch) {
      return `Checked ${checkedMatch[1]} times today (no cap enforced)`;
    }
    return 'No daily cap — frequency managed by dispatcher';
  }

  if (reason === 'COOLDOWN') {
    return details || 'Cooldown active';
  }

  if (reason === 'THROTTLED_CACHED_EVAL') {
    return 'SP-API throttled — using cached evaluation';
  }

  return details ? `${reason}: ${details}` : reason.replace(/_/g, ' ');
}

// Extract safeguard flags from reason string or intelligence_factors
function extractSafeguards(reason: string | null, factors: any): string[] {
  const safeguards: string[] = [];
  
  if (reason) {
    const reasonLower = reason.toLowerCase();
    if (reasonLower.includes("clamp") || reasonLower.includes("clamped")) {
      if (reasonLower.includes("max")) safeguards.push("CLAMPED_MAX");
      if (reasonLower.includes("min")) safeguards.push("CLAMPED_MIN");
    }
    if (reasonLower.includes("jump limit") || reasonLower.includes("jump_limit")) safeguards.push("JUMP_LIMITED");
    if (reasonLower.includes("step limit") || reasonLower.includes("max step") || reasonLower.includes("max_step")) safeguards.push("STEP_LIMITED");
    if (reasonLower.includes("cooldown")) safeguards.push("COOLDOWN");
    if (reasonLower.includes("abort") || reasonLower.includes("safety")) safeguards.push("SAFETY_ABORT");
    if (reasonLower.includes("profit guard") || reasonLower.includes("profit_guard") || reasonLower.includes("effective floor")) safeguards.push("PROFIT_GUARD");
  }
  
  if (factors) {
    if (factors.guards_applied) safeguards.push(...factors.guards_applied);
    if (factors.finalClampMax || factors.final_clamp_max) safeguards.push("FINAL_CLAMP_MAX");
    if (factors.finalClampMin || factors.final_clamp_min) safeguards.push("FINAL_CLAMP_MIN");
    if (factors.jumpLimited || factors.jump_limited) safeguards.push("JUMP_LIMITED");
    if (factors.stepLimited || factors.step_limited) safeguards.push("STEP_LIMITED");
    if (factors.cooldownApplied || factors.cooldown_applied) safeguards.push("COOLDOWN");
  }
  
  return [...new Set(safeguards)];
}

// Safeguard badge component
export function SafeguardBadge({ type }: { type: string }) {
  const config: Record<string, { label: string; className: string; icon: React.ReactNode; description: string }> = {
    CLAMPED_MAX: { 
      label: "Clamped Max", 
      className: "bg-orange-500 text-white", 
      icon: <TrendingDown className="h-3 w-3" />,
      description: "Price was reduced to stay within max price limit"
    },
    CLAMPED_MIN: { 
      label: "Clamped Min", 
      className: "bg-blue-500 text-white", 
      icon: <TrendingUp className="h-3 w-3" />,
      description: "Price was raised to stay above min price limit"
    },
    FINAL_CLAMP_MAX: { 
      label: "Final Clamp Max", 
      className: "bg-orange-600 text-white", 
      icon: <Shield className="h-3 w-3" />,
      description: "Final safety clamp enforced max price limit"
    },
    FINAL_CLAMP_MIN: { 
      label: "Final Clamp Min", 
      className: "bg-blue-600 text-white", 
      icon: <Shield className="h-3 w-3" />,
      description: "Final safety clamp enforced min price limit"
    },
    JUMP_LIMITED: { 
      label: "Jump Limited", 
      className: "bg-purple-500 text-white", 
      icon: <AlertTriangle className="h-3 w-3" />,
      description: "Price jump exceeded 10% or $2 limit"
    },
    STEP_LIMITED: { 
      label: "Step Limited", 
      className: "bg-indigo-500 text-white", 
      icon: <AlertTriangle className="h-3 w-3" />,
      description: "Max step per adjustment was applied"
    },
    COOLDOWN: { 
      label: "Cooldown", 
      className: "bg-gray-500 text-white", 
      icon: <RefreshCw className="h-3 w-3" />,
      description: "Price change was delayed due to cooldown period"
    },
    SAFETY_ABORT: { 
      label: "Aborted", 
      className: "bg-red-600 text-white", 
      icon: <XCircle className="h-3 w-3" />,
      description: "Price change was aborted due to safety violation"
    },
    PROFIT_GUARD: { 
      label: "Profit Guard", 
      className: "bg-yellow-600 text-white", 
      icon: <Shield className="h-3 w-3" />,
      description: "Profit guard prevented price going below ROI threshold"
    },
    MIN_PRICE_SUGGESTION: {
      label: "💡 Lower Min?",
      className: "bg-amber-500 text-white",
      icon: <Lightbulb className="h-3 w-3" />,
      description: "Min price is above competitive market price — consider lowering"
    },
  };
  
  const cfg = config[type] || { label: type, className: "bg-gray-400 text-white", icon: null, description: type };
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge className={`text-xs px-1.5 py-0.5 flex items-center gap-1 ${cfg.className}`}>
            {cfg.icon}
            {cfg.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p>{cfg.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// === Change Readiness Panel ===
function ChangeReadinessPanel({ diagnostics, lastRecommendationReason, assignmentStatus, latestAction, marketplace, recentActions }: {
  diagnostics: any;
  lastRecommendationReason: string | null;
  assignmentStatus: string | null;
  latestAction: PriceAction | undefined;
  marketplace: string;
  recentActions?: PriceAction[];
}) {
  // Currency-safe symbol for inline price displays in this panel
  const cs = getMarketplaceConfig(marketplace || 'US').currencySymbol;
  const dataSource = diagnostics.lastDataSource;
  const skipReason = diagnostics.lastSkipReason;
  const skipDetails = diagnostics.lastSkipDetails || '';
  const reason = lastRecommendationReason || '';

  // 1. Market data ready?
  const marketDataReady = dataSource === 'sp_api' || dataSource === 'cache' || dataSource === 'keepa';
  const marketDataBlocker = !marketDataReady
    ? (skipDetails.includes('Keepa:') 
        ? `SP-API throttled → Cache stale → Keepa: ${skipDetails.match(/Keepa:\s*(.+?)$/)?.[1]?.trim() || 'unavailable'}`
        : skipReason || 'All data sources unavailable')
    : null;

  // Pre-compute: did any recent action (within last 10 min) succeed?
  // Match any action_type as long as the price actually moved (covers manual_run_selected, applied, etc.)
  const recentSuccessfulChange = (recentActions || [latestAction]).find(a =>
    a?.new_price != null && a?.old_price != null
    && Math.abs(a.new_price - a.old_price) >= 0.005
    && a?.created_at
    && (Date.now() - new Date(a.created_at).getTime()) < 10 * 60 * 1000
  );
  // Also detect success from live price vs last-applied mismatch (action row may not exist yet)
  const livePriceChanged = diagnostics.myPrice != null 
    && diagnostics.lastAppliedPrice != null 
    && Math.abs(diagnostics.myPrice - diagnostics.lastAppliedPrice) > 0.02;
  const latestWasSuccessfulChange = Boolean(recentSuccessfulChange) || livePriceChanged;

  // 2. Target valid? (not blocked by guards)
  // If latest action was a successful price_change, target was valid by definition
  const isBlocked = !latestWasSuccessfulChange && (
    reason.toLowerCase().includes('profit guard') 
    || reason.toLowerCase().includes('blocked')
    || latestAction?.action_type === 'blocked_by_profit_guard'
  );
  const isClamped = reason.toLowerCase().includes('clamped') || reason.toLowerCase().includes('clamp');
  const targetValid = marketDataReady && !isBlocked;
  const targetBlocker = isBlocked 
    ? (reason.toLowerCase().includes('profit guard') ? 'Profit guard floor' : 'Guard blocked')
    : isClamped ? 'Target clamped to bound' : null;

  // 3. Delta >= minimum change?
  // Use ACTUAL current price vs effective target (after floor clamp), not just latest action's old/new
  const myCurrentPrice = diagnostics.myPrice ?? latestAction?.old_price ?? null;
  const effectiveTarget = latestAction?.intelligence_factors?.effective_target ?? latestAction?.new_price ?? null;
  const isLosingBb = diagnostics.latestAckIsBbOwner === false || diagnostics.buyboxStatus === 'losing';
  
   let deltaOk: boolean;
   let deltaBlocker: string | null = null;

   // Detect oscillation guard pause (intentional safety pause after BB loss)
   const latestActionReason = (latestAction?.reason || '').toLowerCase();
   const combinedReason = `${reason.toLowerCase()} ${latestActionReason}`;
   const isOscillationPaused = combinedReason.includes('oscillation')
     || combinedReason.includes('oscillation_guard')
     || combinedReason.includes('oscillation_paused');

   // Detect intentional HOLD decisions (not a failure — the system chose to hold)
   const isIntentionalHold = isOscillationPaused
     || reason.toLowerCase().includes('holding')
     || reason.toLowerCase().includes('protection')
     || reason.toLowerCase().includes('profit zone')
     || reason.toLowerCase().includes('already optimal');

   if (latestWasSuccessfulChange) {
     deltaOk = true;
   } else if (isIntentionalHold) {
     deltaOk = true; // HOLD is a valid decision, not a blocker
   } else if (isLosingBb && myCurrentPrice != null && effectiveTarget != null && Math.abs(myCurrentPrice - effectiveTarget) >= 0.01) {
     deltaOk = true;
   } else if (myCurrentPrice != null && effectiveTarget != null) {
     deltaOk = Math.abs(myCurrentPrice - effectiveTarget) >= 0.01;
   } else {
     deltaOk = latestAction?.action_type === 'price_change' 
       || (latestAction?.new_price != null && latestAction?.old_price != null && Math.abs(latestAction.new_price - latestAction.old_price) >= 0.01);
   }
  
  if (!deltaOk && marketDataReady && targetValid) {
    if (isOscillationPaused) {
      deltaBlocker = 'Oscillation guard paused after Buy Box loss';
    } else if (myCurrentPrice != null && effectiveTarget != null && Math.abs(myCurrentPrice - effectiveTarget) >= 0.01) {
      // Real movement available but engine chose to hold — surface engine reason rather than generic "too small"
      deltaBlocker = latestAction?.reason
        ? `Engine held: ${latestAction.reason.split('|')[0].trim()}`
        : 'Engine held position (delta available but not applied)';
    } else {
      deltaBlocker = 'Price change too small or same';
    }
  }

  // 4. Writable now?
  const listingActive = !diagnostics.listingStatus?.includes('INACTIVE');
  const statusOk = !assignmentStatus || assignmentStatus === 'active';
  const writableNow = listingActive && statusOk;
  const writableBlocker = !listingActive ? 'Listing INACTIVE' 
    : !statusOk ? `Assignment ${assignmentStatus}` : null;

  // Overall
  const allGreen = marketDataReady && targetValid && !isBlocked && deltaOk && writableNow;
  const primaryBlocker = marketDataBlocker || targetBlocker || deltaBlocker || writableBlocker;

  // Floor enforcement transparency
  const minFloor = diagnostics.minPriceOverride;
  const rawTarget = effectiveTarget;
  const floorApplied = minFloor != null && rawTarget != null && rawTarget < minFloor;
  const clampedTarget = floorApplied ? minFloor : rawTarget;

  // === Pricing Mode badge (Profit / Competitive / Sales Boost) ===
  const roiFloorNum = (() => {
    const f = latestAction?.intelligence_factors as any;
    const v = f?.floor_price ?? f?.roi_floor ?? null;
    return v != null ? Number(v) : null;
  })();
  const effectivePrice = myCurrentPrice ?? effectiveTarget ?? null;
  const hasManualMin = minFloor != null && Number(minFloor) > 0;
  const belowRoi = roiFloorNum != null && roiFloorNum > 0
    && effectivePrice != null && effectivePrice < roiFloorNum - 0.005;
  const aboveRoiComfort = roiFloorNum != null && effectivePrice != null
    && effectivePrice >= roiFloorNum * 1.05;
  let pricingMode: { label: string; color: string; tip: string } | null = null;
  if (effectivePrice != null && roiFloorNum != null && roiFloorNum > 0) {
    if (belowRoi) {
      pricingMode = {
        label: hasManualMin ? '🔴 Sales Boost (below ROI)' : '🔴 Sales Boost — no min floor set',
        color: 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-300',
        tip: hasManualMin
          ? `Price ${cs}${effectivePrice.toFixed(2)} is below ROI floor ${cs}${roiFloorNum.toFixed(2)}. Manual min override allowed it.`
          : `No minimum floor set on this rule — engine matched the market at ${cs}${effectivePrice.toFixed(2)}, below ROI floor ${cs}${roiFloorNum.toFixed(2)}. Set a min floor to prevent below-ROI matches.`,
      };
    } else if (aboveRoiComfort) {
      pricingMode = {
        label: '🟢 Profit Mode',
        color: 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950/30 dark:border-green-800 dark:text-green-300',
        tip: `Price ${cs}${effectivePrice.toFixed(2)} is comfortably above ROI floor ${cs}${roiFloorNum.toFixed(2)}.`,
      };
    } else {
      pricingMode = {
        label: '🟡 Competitive Mode',
        color: 'border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300',
        tip: `Price ${cs}${effectivePrice.toFixed(2)} is near ROI floor ${cs}${roiFloorNum.toFixed(2)} — competing tightly.`,
      };
    }
  }

  // Hypothetical target when skipped
  const suppressedLowestMatch = reason.match(/Buy Box suppressed - lowering toward lowest (FBA )?\(\$([\d.]+)\)/i);
  const hypotheticalTarget = !marketDataReady
    ? suppressedLowestMatch
      ? `If data arrives, target would anchor to lowest ${suppressedLowestMatch[1] ? 'FBA ' : ''}$${Number(suppressedLowestMatch[2]).toFixed(2)}`
      : diagnostics.lastBuyboxPrice != null
        ? `If data arrives, target would anchor to BB $${Number(diagnostics.lastBuyboxPrice).toFixed(2)}`
        : null
    : null;

  const Check = ({ ok, label, blocker }: { ok: boolean; label: string; blocker: string | null }) => (
    <div className="flex items-center gap-2">
      <span className={`text-sm font-medium ${ok ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
        {ok ? '✅' : '❌'} {label}: {ok ? 'yes' : 'no'}
      </span>
      {blocker && <span className="text-xs text-muted-foreground">— {blocker}</span>}
    </div>
  );

  return (
    <div className={`p-3 rounded-lg border mb-3 text-xs ${allGreen || isIntentionalHold ? 'border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-800' : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800'}`}>
      <div className="font-semibold text-sm mb-2 text-foreground flex items-center gap-2 flex-wrap">
        <span>
          {allGreen ? '✅ Change Readiness: READY' : latestWasSuccessfulChange ? '✅ Price Updated Successfully' : isIntentionalHold ? '✅ Holding — Profit Zone' : '⚠️ Change Readiness'}
        </span>
        {pricingMode && (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${pricingMode.color}`}
            title={pricingMode.tip}
          >
            {pricingMode.label}
          </span>
        )}
      </div>
      {pricingMode && belowRoi && (
        <div className="mb-2 text-[11px] text-red-600 dark:text-red-400">
          ⚠️ {pricingMode.tip}
        </div>
      )}
      {recentSuccessfulChange && recentSuccessfulChange !== latestAction && (
        <div className="text-xs text-green-600 dark:text-green-400 mb-2">
          ✅ Price changed {cs}{recentSuccessfulChange.old_price?.toFixed(2)} → {cs}{recentSuccessfulChange.new_price?.toFixed(2)} (latest eval is a subsequent check)
        </div>
      )}
      {!recentSuccessfulChange && livePriceChanged && (
        <div className="text-xs text-green-600 dark:text-green-400 mb-2">
          ✅ Price moved {cs}{diagnostics.lastAppliedPrice?.toFixed(2)} → {cs}{diagnostics.myPrice?.toFixed(2)} (write pending confirmation)
        </div>
      )}
      <div className="space-y-1">
        <Check ok={marketDataReady} label="Market data ready" blocker={marketDataBlocker} />
        <Check ok={targetValid && !isBlocked} label="Target valid" blocker={targetBlocker} />
        {isIntentionalHold ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-green-600 dark:text-green-400">
              ✅ Decision: holding position
            </span>
          </div>
        ) : (
          <Check ok={deltaOk || !marketDataReady} label="Delta ≥ min change" blocker={deltaBlocker} />
        )}
        {isLosingBb && deltaOk && myCurrentPrice != null && effectiveTarget != null && Math.abs(myCurrentPrice - effectiveTarget) >= 0.01 && (
          <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 ml-6">
            ↳ BB-losing bypass active — delta threshold waived
          </div>
        )}
        <Check ok={writableNow} label="Writable now" blocker={writableBlocker} />
      </div>
      {/* Floor enforcement transparency */}
      {floorApplied && clampedTarget != null && (
        <div className="mt-2 pt-2 border-t border-border text-xs">
          <span className="font-semibold text-foreground">Floor enforcement: </span>
          <span className="text-amber-600 dark:text-amber-400">
            Raw target ${rawTarget?.toFixed(2)} → clamped to floor ${clampedTarget.toFixed(2)}
          </span>
        </div>
      )}
      {primaryBlocker && !allGreen && (
        <div className="mt-2 pt-2 border-t border-border">
          <span className="font-semibold text-foreground">Primary blocker: </span>
          <span className="text-foreground">{primaryBlocker}</span>
        </div>
      )}
      {hypotheticalTarget && (
        <div className="mt-1 text-muted-foreground italic">{hypotheticalTarget}</div>
      )}
    </div>
  );
}

export default function ActionLogDialog({ asin, sku, marketplace, open, onOpenChange, overrideStatus, onMinPriceAccepted }: ActionLogDialogProps) {
  const { user } = useAuth();
  const [priceActions, setPriceActions] = useState<PriceAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreActions, setHasMoreActions] = useState(false);
  const ACTION_LOG_PAGE_SIZE = 50;
  const [simpleView, setSimpleView] = useState(() => {
    try {
      const v = localStorage.getItem("actionLog.simpleView");
      if (v != null) return v === "true";
    } catch { /* ignore */ }
    return true;
  });
  const toggleSimpleView = (next: boolean) => {
    setSimpleView(next);
    try { localStorage.setItem("actionLog.simpleView", String(next)); } catch { /* ignore */ }
  };
  const [activeRuleName, setActiveRuleName] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [localResumed, setLocalResumed] = useState(false);
  const [acceptingMin, setAcceptingMin] = useState<string | null>(null);
  const [reconcilingSku, setReconcilingSku] = useState(false);
  const [forcingRaise, setForcingRaise] = useState(false);

  const handleForceSmartRaise = async () => {
    if (!asin || !user) return;
    const confirmed = window.confirm(
      `Force Smart Raise will bypass cooldown and BB-owner hold to raise this ASIN toward the filtered competitor anchor in a small controlled step (≤ $0.20, ≤ 25% of gap).\n\nROI floor, manual min/max, and Amazon min/max are still respected. If the Buy Box is lost on the next evaluation, future force raises will be blocked.\n\nContinue?`
    );
    if (!confirmed) return;
    setForcingRaise(true);
    try {
      const normalizedSku = sku?.trim() || null;
      let lookup = supabase
        .from("repricer_assignments")
        .select("id")
        .eq("user_id", user.id)
        .eq("marketplace", marketplace);
      lookup = normalizedSku ? lookup.eq("sku", normalizedSku) : lookup.eq("asin", asin);
      const { data: aRow, error: lookupErr } = await lookup
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (!aRow?.id) throw new Error("Assignment not found for this ASIN/SKU");

      const { data, error } = await supabase.functions.invoke('repricer-scheduler', {
        body: {
          dry_run: false,
          assignment_ids: [aRow.id],
          marketplace,
          force_mode: 'smart_raise',
        },
      });
      if (error) throw error;
      const summary = data?.summary ?? { evaluated: 0, applied: 0 };
      if (summary.applied > 0) {
        toast.success(`Force Smart Raise applied — ${summary.applied} price update sent`);
      } else {
        toast.info(`Force Smart Raise evaluated — no raise (likely already at anchor, max, or BB-loss guard active). Check the Action Log for the reason.`);
      }
      setTimeout(() => fetchData(), 1500);
    } catch (e: any) {
      toast.error(`Force Smart Raise failed: ${e?.message || e}`);
    } finally {
      setForcingRaise(false);
    }
  };

  const handleReconcileSku = async () => {
    if (!asin || !user) return;
    setReconcilingSku(true);
    try {
      const { data, error } = await supabase.functions.invoke('reconcile-asin-skus', {
        body: { asin, marketplace },
      });
      if (error) throw error;
      const r = data?.results?.[0];
      if (!r) throw new Error('No result returned');
      if (r.status === 'reconciled') {
        toast.success(`SKU reconciled to "${r.realSku}" — repricer will use the real Amazon SKU on next cycle.`);
      } else if (r.status === 'no_amazon_listing') {
        toast.error('No Amazon listing found for this ASIN under your seller account.');
      } else if (r.status === 'ambiguous') {
        toast.error(`Multiple Amazon SKUs found (${(r.realSkus || []).join(', ')}). Manual mapping required.`);
      } else {
        toast.error(r.message || 'Reconcile failed');
      }
    } catch (e: any) {
      toast.error(`Reconcile failed: ${e?.message || e}`);
    } finally {
      setReconcilingSku(false);
    }
  };
  
  const [lastEvaluatedAt, setLastEvaluatedAt] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [lastRecommendationReason, setLastRecommendationReason] = useState<string | null>(null);
  const [assignmentStatus, setAssignmentStatus] = useState<string | null>(null);
  const [needsAttentionReason, setNeedsAttentionReason] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<{
    isPriority?: boolean;
    lastSkipReason?: string | null;
    lastSkipLane?: string | null;
    lastSkipDetails?: string | null;
    lastEvalAttempt?: string | null;
    assignmentUpdatedAt?: string | null;
    lastDispatchAt?: string | null;
    minFetchInterval?: number | null;
    lastAppliedPrice?: number | null;
    lastBuyboxPrice?: number | null;
    aboveBbGap?: number | null;
    effectivePriority?: boolean;
    effectiveFetchInterval?: number | null;
    forceEvalUsed?: boolean;
    oscillationState?: string | null;
    oscillationCooldownUntil?: string | null;
    dispatchReason?: string | null;
    // Listing & monopoly diagnostics
    listingStatus?: string | null;
    listingStatusSource?: string | null;
    listingStatusUpdatedAt?: string | null;
    consecutiveZeroOffers?: number | null;
    buyboxStatus?: string | null;
    buyboxSellerId?: string | null;
    buyboxLostAt?: string | null;
    lastSnapshotOffers?: number | null;
    lastSnapshotAt?: string | null;
    // Trigger source & data source timeline
    lastTriggerSource?: string | null;
    lastDataSource?: string | null;
    lastThrottleAt?: string | null;
    // Current price & bounds for transparency
    myPrice?: number | null;
    minPriceOverride?: number | null;
    maxPriceOverride?: number | null;
    // Snapshot market data
    snapshotBuyboxPrice?: number | null;
    snapshotLowestFba?: number | null;
    snapshotLowestFbm?: number | null;
    snapshotLowestOverall?: number | null;
    snapshotBuyboxIsFba?: boolean | null;
    // Latest eval ack context
    latestAckAt?: string | null;
    latestAckResult?: string | null;
    latestAckReason?: string | null;
    latestAckConstraint?: string | null;
    latestAckIsBbOwner?: boolean | null;
    latestAckLowestFba?: number | null;
    latestAckBuyboxPrice?: number | null;
    hasSellableStock?: boolean;
    inventoryAvailable?: number;
    inventoryReserved?: number;
  }>({});
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const handleAcceptMinSuggestion = async (suggestion: MinPriceSuggestion) => {
    if (!asin || !user) return;
    setAcceptingMin(asin);

    const previousActions = [...priceActions];
    const normalizedSku = sku?.trim() || null;
    const newMin = Number(suggestion.suggested_min);
    let oldMin = suggestion.current_min;

    try {
      // Resolve exact assignment first so updates are deterministic
      let assignmentLookupQuery = supabase
        .from("repricer_assignments")
        .select("id, min_price_override")
        .eq("user_id", user.id)
        .eq("marketplace", marketplace);

      assignmentLookupQuery = normalizedSku
        ? assignmentLookupQuery.eq("sku", normalizedSku)
        : assignmentLookupQuery.eq("asin", asin);

      const { data: assignmentRow, error: assignmentLookupError } = await assignmentLookupQuery
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (assignmentLookupError) throw assignmentLookupError;
      if (!assignmentRow?.id) throw new Error("No assignment found for this ASIN/SKU");

      if (assignmentRow.min_price_override != null) {
        oldMin = Number(assignmentRow.min_price_override);
      }

      if (oldMin != null && newMin >= Number(oldMin)) {
        throw new Error("Suggestions can only lower the minimum price");
      }

      // Optimistic UI update: clear suggestion card immediately
      setPriceActions((prev) =>
        prev.map((a) => {
          if (a.asin !== asin || (normalizedSku && a.sku !== normalizedSku)) return a;
          const updated = { ...a };
          if (updated.old_min_price === oldMin || updated.old_min_price === suggestion.current_min) {
            updated.new_min_price = newMin;
          }
          if (updated.min_price_suggestion?.suggested_min === newMin) {
            updated.min_price_suggestion = null;
          }
          return updated;
        })
      );

      const { error: assignErr } = await supabase
        .from("repricer_assignments")
        .update({
          min_price_override: newMin,
          updated_at: new Date().toISOString(),
        })
        .eq("id", assignmentRow.id)
        .eq("user_id", user.id);

      if (assignErr) throw assignErr;

      // Also update inventory min_price for US marketplace
      if (marketplace === "US") {
        let inventoryUpdateQuery = supabase
          .from("inventory")
          .update({ min_price: newMin })
          .eq("user_id", user.id);

        inventoryUpdateQuery = normalizedSku
          ? inventoryUpdateQuery.eq("sku", normalizedSku)
          : inventoryUpdateQuery.eq("asin", asin);

        const { error: invErr } = await inventoryUpdateQuery;
        if (invErr) throw invErr;
      }

      const acceptReason = `Accepted smart suggestion (gap: $${suggestion.gap_amount?.toFixed(2)}, ${suggestion.gap_percent?.toFixed(1)}%)`;

      // Persist an action-log entry so the accepted value remains after refresh/reopen
      const { error: actionErr } = await supabase
        .from("repricer_price_actions")
        .insert({
          user_id: user.id,
          assignment_id: assignmentRow.id,
          asin,
          sku: normalizedSku,
          marketplace,
          old_min_price: oldMin,
          new_min_price: newMin,
          action_type: "minmax_change",
          trigger_source: "ui",
          reason: acceptReason,
          success: true,
          min_price_suggestion: null,
        });
      if (actionErr) throw actionErr;

      // Log in settings history too
      await logSettingChange({
        asin,
        sku: normalizedSku || undefined,
        marketplace,
        fieldChanged: "min_price",
        oldValue: oldMin,
        newValue: newMin,
        reason: acceptReason,
        source: "ui",
      });

      toast.success(`Min price lowered to $${newMin.toFixed(2)}`, {
        description: `Was $${(oldMin || 0).toFixed(2)} — gap was $${(suggestion.gap_amount || 0).toFixed(2)}`,
      });

      // Notify parent so the table row shows green "ready to save" state
      onMinPriceAccepted?.(asin, normalizedSku, newMin);

      // Keep dialog open and refresh from DB so values don't appear to revert
      await fetchData();
    } catch (err: any) {
      // Rollback on failure
      setPriceActions(previousActions);
      toast.error("Failed to update min price: " + err.message);
    } finally {
      setAcceptingMin(null);
    }
  };

  // Initial fetch + audit log on open
  useEffect(() => {
    if (open && asin && user) {
      setLocalResumed(false);
      fetchData();
      logSettingChange({
        asin,
        sku: sku || undefined,
        marketplace,
        fieldChanged: "action_log_viewed",
        oldValue: null,
        newValue: null,
        reason: "User opened Price Action Log",
        source: "ui",
      });
    }
  }, [open, asin, sku, marketplace, user]);

  // Poll while open, rather than subscribing to repricer_assignments.
  //
  // -- WHY THIS IS NOT REALTIME ANY MORE ---------------------------------
  //
  // This was a `postgres_changes` UPDATE subscription on
  // repricer_assignments. Unlike the padlock sync in AssignmentsTable, it is
  // NOT the case that this dialog wanted only a few columns: fetchData() reads
  // last_evaluated_at, last_sp_api_check_at, last_skip_reason, last_skip_lane,
  // last_throttle_at and friends, which is exactly the machine bookkeeping
  // that repricer-scheduler writes ~9.2 times a second. This dialog genuinely
  // wanted those events.
  //
  // It just did not want them at that price. repricer_assignments has left the
  // supabase_realtime publication (see
  // 20260827120002_assignments_leave_realtime_publication.sql) because
  // broadcasting a 185-column row on every bookkeeping write was ~93% of all
  // Realtime work on the account. Keeping ONE dialog live is not worth
  // reinstating that, and routing the same writes through a trigger instead
  // would just move 9.2 inserts/second into realtime.messages -- worse, not
  // better, since that is a real table write rather than a WAL decode.
  //
  // A dialog that is open on one ASIN, in front of a human who is watching it,
  // is the textbook case for polling: the work is bounded by how long someone
  // stares at it, and it costs one indexed lookup every 15s instead of a
  // fleet-wide fan-out. The old subscription also had no `user_id` in its
  // filter (it leaned entirely on RLS), so this is marginally tighter as well.
  //
  // 15s was chosen against the repricer's own cadence: min_fetch_interval is
  // measured in minutes, so a faster poll cannot surface anything new and a
  // slower one would feel stale while a price action is landing.
  useEffect(() => {
    if (!open || !asin || !user) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      // document.hidden: a backgrounded tab with the dialog left open should
      // not keep querying. Reopening or refocusing picks it straight back up.
      if (cancelled || document.hidden) return;
      fetchData();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, asin, sku, marketplace, user]);

  const handleResume = async () => {
    if (!asin || !user) return;
    setResuming(true);
    try {
      let q = supabase
        .from("repricer_assignments")
        .update({ status: "active", consecutive_failures: 0, last_recommendation_reason: null })
        .eq("asin", asin)
        .eq("marketplace", marketplace);
      if (sku) q = q.eq("sku", sku);
      const { error } = await q;
      if (error) throw error;
      setLocalResumed(true);
      setAssignmentStatus("active");
    } catch (err: any) {
      console.error("Failed to resume:", err);
    } finally {
      setResuming(false);
    }
  };
  
  const fetchData = async () => {
    if (!asin || !user) return;
    
    setLoading(true);
    try {
      // Fetch price actions + assignment timing/status + inventory cost + latest snapshot + latest ack + marketplace-specific my_price in parallel
      // CRITICAL: For non-US marketplaces, my_price MUST come from asin_my_price_cache (in marketplace currency).
      // The inventory.my_price column is US-only and would cause currency mix-up (e.g. showing $14.69 USD as MX$14.69).
      const isUsMarket = !marketplace || marketplace === 'US';
      const mktIdMap: Record<string, string> = {
        US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
      };
      const targetMarketplaceId = mktIdMap[marketplace || 'US'];

      const [actionsRes, assignmentRes, inventoryRes, latestSnapshotRes, latestAckRes, marketplacePriceRes, createdListingRes] = await Promise.all([
        // Query by user_id + asin + marketplace (NOT sku) so SKU reconciliation
        // doesn't hide historical action rows stamped with prior synthetic SKUs.
        // The (user, asin, marketplace) tuple is the stable listing identity.
        supabase
          .from("repricer_price_actions")
          .select("*")
          .eq("user_id", user.id)
          .eq("asin", asin)
          .eq("marketplace", marketplace)
          .order("created_at", { ascending: false })
          .limit(50),
        (() => {
          let q = supabase
            .from("repricer_assignments")
            .select("last_evaluated_at, last_sp_api_check_at, last_recommendation_reason, status, fulfillment_type, is_priority, last_skip_reason, last_skip_lane, last_skip_details, last_evaluation_attempt_at, min_fetch_interval_minutes, last_applied_price, last_buybox_price, consecutive_zero_offers, last_buybox_status, buybox_lost_at, last_trigger_source, last_data_source, last_throttle_at, min_price_override, max_price_override, updated_at, rule_id, oscillation_state, oscillation_cooldown_until, dispatch_reason, last_error_message")
            .eq("asin", asin)
            .eq("marketplace", marketplace);
          if (sku) q = q.eq("sku", sku);
          return q.maybeSingle();
        })(),
        (() => {
          let q = supabase
            .from("inventory")
            .select("cost, fees_json, image_url, listing_status, last_inventory_sync_at, my_price, price")
            .eq("user_id", user.id);
          if (sku) q = q.eq("sku", sku);
          else q = q.eq("asin", asin);
          return q.maybeSingle();
        })(),
        supabase
          .from("repricer_competitor_snapshots")
          .select("lowest_fba_price, lowest_fbm_price, lowest_overall_price, buybox_price, fetched_at, offers_count, buybox_seller_id, buybox_is_fba")
          .eq("user_id", user.id)
          .eq("asin", asin)
          .eq("marketplace", marketplace)
          .order("fetched_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Latest eval ack for fresh market data
        (() => {
          let q = supabase
            .from("repricer_eval_acks")
            .select("buybox_price, result, reason, constraint_applied, is_buybox_owner, acked_at, my_price, lowest_fba_price, sku")
            .eq("user_id", user.id)
            .eq("asin", asin)
            .eq("marketplace", marketplace);
          if (sku) q = q.eq("sku", sku);
          return q.order("acked_at", { ascending: false }).limit(1).maybeSingle();
        })(),
        // Marketplace-specific my_price (in marketplace currency) — required for non-US
        (() => {
          if (!targetMarketplaceId || !sku) {
            return Promise.resolve({ data: null, error: null }) as any;
          }
          return supabase
            .from("asin_my_price_cache")
            .select("my_price, updated_at")
            .eq("user_id", user.id)
            .eq("asin", asin)
            .eq("seller_sku", sku)
            .eq("marketplace_id", targetMarketplaceId)
            .maybeSingle();
        })(),
        // FBM fallback: created_listings price for ASINs without an inventory row
        (() => {
          let q = supabase
            .from("created_listings")
            .select("price, updated_at, sku")
            .eq("user_id", user.id)
            .eq("asin", asin);
          if (sku) q = q.eq("sku", sku);
          return q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
        })(),
      ]);
      
      if (actionsRes.error) throw actionsRes.error;
      
      const rawActions = (actionsRes.data || []) as unknown as PriceAction[];
      setHasMoreActions(rawActions.length === ACTION_LOG_PAGE_SIZE);
      const currentRuleId = assignmentRes.data?.rule_id;
      
      // Resolve current rule name from the assignment's rule_id so log always shows the live name
      let currentRuleName: string | null = null;
      if (currentRuleId) {
        const { data: ruleData } = await supabase
          .from("repricer_rules")
          .select("name")
          .eq("id", currentRuleId)
          .maybeSingle();
        currentRuleName = ruleData?.name ?? null;
      }
      setActiveRuleName(currentRuleName);
      
      // Override rule_name on all actions with the current rule name
      const actions = currentRuleName
        ? rawActions.map(a => ({ ...a, rule_name: currentRuleName }))
        : rawActions;
      
      const latestLowestFba = latestSnapshotRes.data?.lowest_fba_price;
      const fulfillmentType = assignmentRes.data?.fulfillment_type;
      const shouldForceFbaBenchmark = fulfillmentType === "FBA" && latestLowestFba != null && latestLowestFba > 0;

      const normalizedActions = shouldForceFbaBenchmark
        ? actions.map((action) => {
            const suggestion = action.min_price_suggestion;
            if (!suggestion) return action;

            const competitivePrice = Math.round(Number(latestLowestFba) * 100) / 100;
            const hasCurrentMin = suggestion.current_min != null && suggestion.current_min > 0;
            const gapAmount = hasCurrentMin
              ? Math.max(0, Number(suggestion.current_min) - competitivePrice)
              : suggestion.gap_amount;
            const gapPercent = hasCurrentMin
              ? (gapAmount / Number(suggestion.current_min)) * 100
              : suggestion.gap_percent;

            const normalizedGap = gapAmount != null ? Math.round(Number(gapAmount) * 100) / 100 : null;
            const normalizedSuggestedMin = (() => {
              if (!hasCurrentMin) return suggestion.suggested_min;

              const currentMin = Number(suggestion.current_min);
              const effectiveFloor = suggestion.effective_floor != null ? Number(suggestion.effective_floor) : 0;

              // In FBA mode, keep suggestion anchored to lowest FBA (slightly below by $0.01, rounded to $0.05)
              const targetBelowCompetitive = Math.max(0, competitivePrice - 0.01);
              const roundedTarget = Math.floor(targetBelowCompetitive * 20) / 20;
              const candidate = Math.round(Math.max(roundedTarget, effectiveFloor) * 100) / 100;

              return candidate > 0 && candidate < currentMin ? candidate : suggestion.suggested_min;
            })();

            const shouldSuppressSuggestion =
              (normalizedGap != null && normalizedGap <= 0) ||
              (normalizedSuggestedMin != null && hasCurrentMin && normalizedSuggestedMin >= Number(suggestion.current_min));

            return {
              ...action,
              min_price_suggestion: shouldSuppressSuggestion
                ? null
                : {
                    ...suggestion,
                    competitive_price: competitivePrice,
                    suggested_min: normalizedSuggestedMin,
                    gap_amount: normalizedGap,
                    gap_percent: gapPercent != null ? Math.round(Number(gapPercent) * 10) / 10 : null,
                  },
            };
          })
        : actions;

      const latestWithSuggestion = normalizedActions[0]?.min_price_suggestion?.suggested_min != null
        ? normalizedActions[0]
        : null;

      const baseActions = latestWithSuggestion
        ? normalizedActions.map((action) =>
            action.id === latestWithSuggestion.id && action.min_price_suggestion
              ? {
                  ...action,
                  min_price_suggestion: {
                    ...action.min_price_suggestion,
                    projected_roi: null,
                  },
                }
              : action
          )
        : normalizedActions;

      setPriceActions(baseActions);
      
      // Async: recompute projected ROI for the latest suggestion using calculate-roi-range
      // This keeps Smart Suggestion ROI aligned with the same MIN ROI engine used in the table.

      if (latestWithSuggestion?.min_price_suggestion?.suggested_min != null) {
        const inv = inventoryRes.data;
        const unitCost = latestWithSuggestion.min_price_suggestion.unit_cost
          || (inv?.cost && inv.cost > 0 ? inv.cost : 0);

        if (unitCost > 0) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
              const suggestedMin = latestWithSuggestion.min_price_suggestion.suggested_min;
              const { data: roiRangeData, error: roiRangeError } = await supabase.functions.invoke("calculate-roi-range", {
                body: {
                  asin,
                  sku: sku || undefined,
                  marketplace: marketplace || "US",
                  min_price: suggestedMin,
                  max_price: suggestedMin,
                  cost: unitCost,
                },
                headers: { Authorization: `Bearer ${session.access_token}` },
              });

              if (roiRangeError) throw roiRangeError;

              if (roiRangeData?.throttled) {
                console.info("[ActionLogDialog] Smart Suggestion ROI temporarily unavailable — Fees API throttled.");
              } else if (roiRangeData?.roi_at_min != null) {
                const syncedRoi = Math.round(Number(roiRangeData.roi_at_min) * 10) / 10;
                setPriceActions(
                  baseActions.map((action) =>
                    action.id === latestWithSuggestion.id && action.min_price_suggestion
                      ? {
                          ...action,
                          min_price_suggestion: {
                            ...action.min_price_suggestion,
                            projected_roi: syncedRoi,
                            unit_cost: Math.round(unitCost * 100) / 100,
                          },
                        }
                      : action
                  )
                );
              }
            }
          } catch (e) {
            console.warn("Failed to sync Smart Suggestion ROI with ROI Range:", e);
          }
        }
      }
      
      // Check inventory stock for this SKU
      let hasSellableStock = true;
      let inventoryAvailable = 0;
      let inventoryReserved = 0;
      if (sku) {
        const { data: invData } = await supabase
          .from("inventory")
          .select("available, reserved, listing_status")
          .eq("user_id", user.id)
          .eq("sku", sku)
          .maybeSingle();
        if (invData) {
          inventoryAvailable = invData.available ?? 0;
          inventoryReserved = invData.reserved ?? 0;
          const ls = (invData.listing_status || '').toUpperCase();
          hasSellableStock = inventoryAvailable > 0 && ls !== 'INACTIVE' && ls !== 'NOT_FOUND';
        }
      }

      if (assignmentRes.data) {
        setLastEvaluatedAt(assignmentRes.data.last_evaluated_at);
        setLastCheckedAt(assignmentRes.data.last_sp_api_check_at ?? assignmentRes.data.last_evaluated_at);
        setLastRecommendationReason(assignmentRes.data.last_recommendation_reason);
        setAssignmentStatus(assignmentRes.data.status);
        setNeedsAttentionReason(assignmentRes.data.last_error_message ?? null);

        const baseInterval = assignmentRes.data.min_fetch_interval_minutes ?? 60;
        const lastAppliedPrice = assignmentRes.data.last_applied_price != null ? Number(assignmentRes.data.last_applied_price) : null;
        const lastBuyboxPrice = assignmentRes.data.last_buybox_price != null ? Number(assignmentRes.data.last_buybox_price) : null;
        const aboveBbGap = (lastAppliedPrice != null && lastBuyboxPrice != null) ? (lastAppliedPrice - lastBuyboxPrice) : null;
        const aboveBb = aboveBbGap != null && aboveBbGap >= 0.02;
        const lastTriggerPriority = assignmentRes.data.last_trigger_source === 'priority_cron';
        const lanePriority = assignmentRes.data.last_skip_lane === 'priority_cron';
        // Override: items with no sellable stock are NOT effectively priority
        const effectivePriority = hasSellableStock && Boolean(assignmentRes.data.is_priority || lanePriority || lastTriggerPriority || aboveBb);
        const effectiveFetchInterval = assignmentRes.data.is_priority || lanePriority || lastTriggerPriority
          ? Math.min(baseInterval, 2)
          : aboveBb
            ? Math.min(baseInterval, 5)
            : baseInterval;
        const forceEvalUsed = assignmentRes.data.last_skip_reason === 'THROTTLED_CACHED_EVAL'
          || (assignmentRes.data.last_skip_details?.includes('cached fallback') ?? false);

        // Compute ack-based freshness before building diagnostics
        const ackData = latestAckRes?.data;
        const snapshotAtMs = latestSnapshotRes.data?.fetched_at ? new Date(latestSnapshotRes.data.fetched_at).getTime() : 0;
        const ackAtMs = ackData?.acked_at ? new Date(ackData.acked_at).getTime() : 0;
        const ackBbFresher = ackAtMs > snapshotAtMs && ackData?.buybox_price != null;

        setDiagnostics({
          isPriority: assignmentRes.data.is_priority,
          lastSkipReason: assignmentRes.data.last_skip_reason,
          lastSkipLane: assignmentRes.data.last_skip_lane,
          lastSkipDetails: assignmentRes.data.last_skip_details,
          lastEvalAttempt: assignmentRes.data.last_evaluation_attempt_at,
          assignmentUpdatedAt: assignmentRes.data.updated_at,
          lastDispatchAt: (assignmentRes.data as any).last_dispatch_at ?? null,
          minFetchInterval: assignmentRes.data.min_fetch_interval_minutes,
          lastAppliedPrice,
          lastBuyboxPrice,
          aboveBbGap,
          effectivePriority,
          effectiveFetchInterval,
          forceEvalUsed,
          oscillationState: (assignmentRes.data as any).oscillation_state ?? null,
          oscillationCooldownUntil: (assignmentRes.data as any).oscillation_cooldown_until ?? null,
          dispatchReason: (assignmentRes.data as any).dispatch_reason ?? null,
          // Listing status diagnostics
          listingStatus: inventoryRes.data?.listing_status ?? null,
          listingStatusSource: inventoryRes.data?.listing_status?.includes('INACTIVE') 
            ? ((assignmentRes.data.consecutive_zero_offers ?? 0) >= 3 ? 'auto-detected (zero-offers)' : 'inventory sync')
            : (inventoryRes.data?.listing_status === 'ACTIVE' && (assignmentRes.data.consecutive_zero_offers ?? 0) === 0 
              ? 'verified active (fresh snapshot)' 
              : 'inventory sync'),
          listingStatusUpdatedAt: inventoryRes.data?.last_inventory_sync_at ?? null,
          consecutiveZeroOffers: assignmentRes.data.consecutive_zero_offers ?? 0,
          // Monopoly/buybox diagnostics
          buyboxStatus: assignmentRes.data.last_buybox_status ?? null,
          buyboxSellerId: latestSnapshotRes.data?.buybox_seller_id ?? null,
          buyboxLostAt: assignmentRes.data.buybox_lost_at ?? null,
          lastSnapshotOffers: latestSnapshotRes.data?.offers_count ?? null,
          lastSnapshotAt: latestSnapshotRes.data?.fetched_at ?? null,
          // Trigger source & data source timeline
          lastTriggerSource: assignmentRes.data.last_trigger_source ?? null,
          lastDataSource: assignmentRes.data.last_data_source ?? null,
          lastThrottleAt: assignmentRes.data.last_throttle_at ?? null,
          // Current price & bounds
          // CURRENCY-SAFE my_price: For non-US, ALWAYS use marketplace-specific cache (in MXN/CAD/BRL).
          // The inventory.my_price column is US-only and would mix currencies (e.g. show $14.69 USD as MX$14.69).
          // Fall back to assignment.last_applied_price (already in marketplace currency) if cache missing.
          myPrice: isUsMarket
            ? (inventoryRes.data?.my_price != null
                ? Number(inventoryRes.data.my_price)
                : (inventoryRes.data?.price != null
                    ? Number(inventoryRes.data.price)
                    : (createdListingRes?.data?.price != null ? Number(createdListingRes.data.price) : null)))
            : (marketplacePriceRes?.data?.my_price != null
                ? Number(marketplacePriceRes.data.my_price)
                : (lastAppliedPrice ?? null)),
          minPriceOverride: assignmentRes.data.min_price_override != null ? Number(assignmentRes.data.min_price_override) : null,
          maxPriceOverride: assignmentRes.data.max_price_override != null ? Number(assignmentRes.data.max_price_override) : null,
          // Snapshot market data — prefer ack buybox if fresher than snapshot
          snapshotBuyboxPrice: ackBbFresher ? Number(ackData!.buybox_price) : (latestSnapshotRes.data?.buybox_price != null ? Number(latestSnapshotRes.data.buybox_price) : null),
          snapshotLowestFba: latestSnapshotRes.data?.lowest_fba_price != null ? Number(latestSnapshotRes.data.lowest_fba_price) : null,
          snapshotLowestFbm: latestSnapshotRes.data?.lowest_fbm_price != null ? Number(latestSnapshotRes.data.lowest_fbm_price) : null,
          snapshotLowestOverall: latestSnapshotRes.data?.lowest_overall_price != null ? Number(latestSnapshotRes.data.lowest_overall_price) : null,
          snapshotBuyboxIsFba: latestSnapshotRes.data?.buybox_is_fba ?? null,
          // Ack context for freshness display
          latestAckAt: ackData?.acked_at ?? null,
          latestAckResult: ackData?.result ?? null,
          latestAckReason: ackData?.reason ?? null,
          latestAckConstraint: ackData?.constraint_applied ?? null,
          latestAckIsBbOwner: ackData?.is_buybox_owner ?? null,
          latestAckLowestFba: ackData?.lowest_fba_price != null ? Number(ackData.lowest_fba_price) : null,
          latestAckBuyboxPrice: ackData?.buybox_price != null ? Number(ackData.buybox_price) : null,
          // Sellable stock diagnostics
          hasSellableStock,
          inventoryAvailable,
          inventoryReserved,
        });
      }
      
      setImageUrl(inventoryRes.data?.image_url ?? null);

    } catch (error) {
      console.error("Error fetching action log:", error);
    } finally {
      setLoading(false);
    }
  };

  // Fetches the next page of older history rows and appends them, so the full
  // history is reachable by scrolling/clicking "Load more" rather than being
  // capped at the initial 50.
  const loadMoreActions = async () => {
    if (!asin || !user || loadingMore) return;
    setLoadingMore(true);
    try {
      const { data, error } = await supabase
        .from("repricer_price_actions")
        .select("*")
        .eq("user_id", user.id)
        .eq("asin", asin)
        .eq("marketplace", marketplace)
        .order("created_at", { ascending: false })
        .range(priceActions.length, priceActions.length + ACTION_LOG_PAGE_SIZE - 1);
      if (error) throw error;
      const more = ((data || []) as unknown as PriceAction[]).map((a) =>
        activeRuleName ? { ...a, rule_name: activeRuleName } : a
      );
      setPriceActions((prev) => [...prev, ...more]);
      setHasMoreActions(more.length === ACTION_LOG_PAGE_SIZE);
    } catch (error) {
      console.error("Error loading more action log history:", error);
    } finally {
      setLoadingMore(false);
    }
  };

  const formatCurrency = (val: number | null) => {
    if (val == null) return "—";
    const config = getMarketplaceConfig(marketplace);
    return `${config.currencySymbol}${val.toFixed(2)}`;
  };

  const latestAction = priceActions[0];
  const hasLatestSuggestion = Boolean(latestAction?.min_price_suggestion?.suggested_min);
  const latestActionAt = latestAction?.created_at ?? null;
  const fetchIntervalMinutes = diagnostics.effectiveFetchInterval ?? diagnostics.minFetchInterval ?? 60;
  const latestTouchAt = getLatestTimestamp(
    diagnostics.lastEvalAttempt,
    lastCheckedAt,
    diagnostics.lastSnapshotAt,
    latestActionAt,
    diagnostics.latestAckAt,
  );
  // Uses last_dispatch_at (touched only by the actual scheduler/dispatcher)
  // rather than the row's generic updated_at, which also gets bumped by
  // manual UI edits (e.g. a min/max change) and would otherwise be
  // misread as "the priority scheduler just ran."
  const schedulerHeartbeatAt = diagnostics.lastDispatchAt &&
    (!lastCheckedAt || new Date(diagnostics.lastDispatchAt).getTime() > new Date(lastCheckedAt).getTime())
      ? diagnostics.lastDispatchAt
      : null;
  const isPriorityHeartbeatNewer = Boolean(
    diagnostics.effectivePriority &&
      schedulerHeartbeatAt &&
      (!lastCheckedAt || new Date(schedulerHeartbeatAt).getTime() > new Date(lastCheckedAt).getTime() + 30_000)
  );
  // Always use the most recent timestamp (includes ack) for headline
  const headlineTimestamp = isPriorityHeartbeatNewer ? schedulerHeartbeatAt : latestTouchAt;
  const headlineLabel = isPriorityHeartbeatNewer ? "Last priority cycle:" : "Last checked:";
  const nextEligibleFetchAt = lastCheckedAt
    ? new Date(new Date(lastCheckedAt).getTime() + fetchIntervalMinutes * 60 * 1000).toISOString()
    : null;
  const nextEligibleFetchInMinutes = nextEligibleFetchAt
    ? Math.max(0, Math.ceil((new Date(nextEligibleFetchAt).getTime() - Date.now()) / 60000))
    : null;
  const hasFreshActionContext = Boolean(
    latestActionAt &&
      latestTouchAt &&
      new Date(latestTouchAt).getTime() - new Date(latestActionAt).getTime() <= 10 * 60 * 1000
  );
  const statusSummary = (() => {
    const skipSummary = humanizeSkipReason(diagnostics.lastSkipReason, diagnostics.lastSkipDetails);
    
    // If lastRecommendationReason is a stale "Cooldown" message but the latest action
    // has a more specific reason (e.g. "At floor — holding price"), prefer the action's reason
    const isStaleCooldown = lastRecommendationReason?.startsWith('Cooldown:');
    const latestActionReason = latestAction?.reason;
    
    if (isStaleCooldown && latestActionReason) {
      // Map action_type to a clear human-readable status
      if (latestAction?.action_type === 'blocked_by_profit_guard') {
        return `⛔ Blocked by profit floor — ${latestActionReason}`;
      }
      return latestActionReason;
    }
    
    // Detect "holding at floor" scenario: price is already at or near the min floor,
    // and the system reports delta too small or no_change with a floor clamp
    const myPrice = diagnostics.myPrice;
    const minFloor = diagnostics.minPriceOverride;
    const rawReason = lastRecommendationReason || latestActionReason || '';
    const isClampedByFloor = rawReason.toLowerCase().includes('clamped') && rawReason.toLowerCase().includes('floor');
    const isDeltaTooSmall = rawReason.toLowerCase().includes('price change too small') || rawReason.toLowerCase().includes('delta');
    const isAtFloor = myPrice != null && minFloor != null && Math.abs(myPrice - minFloor) < 0.02;

    // Distinguish ROI / profit-protection floor from the user-configured Min Floor
    const ifAny: any = latestAction?.intelligence_factors || {};
    const floorSource: string | undefined = ifAny.effective_floor_source || ifAny.effectiveFloorSource;
    const isRoiBlocked =
      floorSource === 'roi_profit' ||
      /roi protection floor|profit (?:floor|protection)/i.test(rawReason);
    if (isRoiBlocked) {
      const eff = ifAny.effective_profit_floor ?? ifAny.effectiveProfitFloor ?? ifAny.effective_floor ?? null;
      const userMin = ifAny.user_min_floor ?? ifAny.userMinFloor ?? minFloor ?? null;
      return `🛡️ Holding — ROI / profit protection floor ${eff != null ? formatCurrency(eff) : ''} blocked the move (your configured Min Floor is ${userMin != null ? formatCurrency(userMin) : '—'}, but profit protection enforces a higher floor).`;
    }

    if (isAtFloor && (isClampedByFloor || isDeltaTooSmall)) {
      return `✅ Holding at floor — price is already at ${formatCurrency(myPrice)}, which is your Min Floor. Market is lower but the floor prevents further drops.`;
    }
    
    // Fall back to the most recent action's reason before declaring "no decision"
    if (!lastRecommendationReason) {
      if (latestActionReason) {
        if (latestAction?.action_type === 'price_change' && latestAction?.new_price != null) {
          return `✅ Price updated to ${formatCurrency(latestAction.new_price)} — ${latestActionReason}`;
        }
        return latestActionReason;
      }
      return skipSummary || "— No decision recorded yet";
    }
    if (!latestTouchAt || !latestActionAt) return lastRecommendationReason;

    return new Date(latestTouchAt).getTime() - new Date(latestActionAt).getTime() > 10 * 60 * 1000
      ? (skipSummary || lastRecommendationReason)
      : lastRecommendationReason;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[1400px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            {imageUrl && (
              <img src={imageUrl} alt={asin || ""} className="h-8 w-8 rounded object-contain border border-border bg-muted" />
            )}
            <span>Price Action Log</span>
            <Badge variant={hasLatestSuggestion ? "default" : "secondary"}>
              {loading ? "Suggestion: checking..." : hasLatestSuggestion ? "Suggestion: available" : "No suggested minimum"}
            </Badge>
            <Badge variant="outline" className="font-mono">{asin}</Badge>
            <Badge variant="secondary">{marketplace}</Badge>
            <Button variant="ghost" size="sm" onClick={fetchData} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReconcileSku}
              disabled={reconcilingSku || !asin}
              title="Look up the real Amazon SKU for this ASIN and rewrite the local SKU. Use when My Price shows 'missing' or pushes to Amazon fail with 'Inventory item not found'."
            >
              {reconcilingSku ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <Wrench className="h-4 w-4 mr-1" />}
              Reconcile SKU
            </Button>
            {(() => {
              // Accept any owner-equivalent BB state. 'winning' and 'owned' both mean we have the BB.
              // Also accept the evaluator-ack flag (is_buybox_owner) as authoritative when present.
              const bbStatusLc = (diagnostics.buyboxStatus || '').toLowerCase();
              const statusSaysOwned = bbStatusLc === 'owned' || bbStatusLc === 'winning' || bbStatusLc === 'buybox_owner';
              const ackSaysOwned = diagnostics.latestAckIsBbOwner === true;
              const ackSaysLost = diagnostics.latestAckIsBbOwner === false;
              const isBbOwner = (statusSaysOwned || ackSaysOwned) && !ackSaysLost;
              const my = diagnostics.myPrice ?? null;
              const f = hasFreshActionContext ? (latestAction?.intelligence_factors || {}) : {};
              const pp: any = f.position_proof || {};

              // Resolve the filtered external-competitor anchor (excludes self when possible).
              // Priority: latest action's position_proof → evaluator ack → snapshot fallback.
              const fromPosProof = pp.lowest_price_filtered ?? null;
              const fromAck = diagnostics.latestAckLowestFba ?? null;
              const fromSnap = diagnostics.snapshotLowestFba ?? null;
              const filteredCandidate: number | null =
                fromPosProof != null ? Number(fromPosProof)
                : fromAck != null ? Number(fromAck)
                : fromSnap != null ? Number(fromSnap)
                : null;
              const filteredSource =
                fromPosProof != null ? 'position_proof'
                : fromAck != null ? 'evaluator_ack'
                : fromSnap != null ? 'snapshot'
                : 'none';

              // If the filtered low equals my price (±$0.01), it's almost certainly my own offer.
              // In that case there is no external competitor below me — treat as "no lower FBA"
              // and use the next-best signal (ack or snapshot) only as informational.
              const isSelfAtFilteredLow = filteredCandidate != null && my != null
                && Math.abs(filteredCandidate - my) <= 0.01;
              const externalAnchor = isSelfAtFilteredLow ? null : filteredCandidate;
              const anchorAbove = my != null && externalAnchor != null && externalAnchor > my + 0.01;

              const amILowestFiltered = hasFreshActionContext ? pp.am_i_lowest_filtered : null;
              // Lower-external-competitor check: prefer position_proof's authoritative flag;
              // otherwise infer from externalAnchor (self already excluded above).
              const lowerExternalExists =
                amILowestFiltered === true ? false
                : amILowestFiltered === false ? true
                : (externalAnchor != null && my != null ? externalAnchor < my - 0.005 : false);
              const noLowerFba = !lowerExternalExists;

              // Suppressed/stale/unknown BB: if I am the lowest filtered offer and no lower external
              // competitor exists, allow the probe even without confirmed BB ownership.
              const iAmLowestFiltered = amILowestFiltered === true
                || (amILowestFiltered == null && noLowerFba && externalAnchor != null && my != null && my <= externalAnchor + 0.005);
              const bbOwnerOrLowest = isBbOwner || iAmLowestFiltered;
              const probeMode = isBbOwner ? 'bb_owner' : iAmLowestFiltered ? 'suppressed_or_stale_bb' : 'none';

              const eligible = bbOwnerOrLowest && anchorAbove && noLowerFba;

              const disabledReason = !bbOwnerOrLowest
                ? "You don't own the Buy Box, and you're not the lowest filtered offer either"
                : !anchorAbove
                  ? (isSelfAtFilteredLow
                      ? `Filtered low ($${filteredCandidate?.toFixed(2)}) appears to be your own offer — no external competitor above to climb toward`
                      : externalAnchor == null
                        ? "No filtered competitor anchor available"
                        : `Filtered anchor $${externalAnchor.toFixed(2)} is not above your current price $${my?.toFixed(2)}`)
                  : !noLowerFba
                    ? "A lower eligible FBA competitor exists — would risk losing BB"
                    : null;

              const probeLabel = probeMode === 'bb_owner'
                ? 'Force Smart Raise'
                : 'Force Smart Raise (suppressed/unknown BB profit probe)';
              const titleText = eligible
                ? `${probeLabel}: bypass cooldown + BB-owner hold; raise toward $${externalAnchor!.toFixed(2)} in a controlled step (≤ $0.20, ≤ 25% of gap). Respects ROI, min, max, Amazon bounds.`
                : (disabledReason || 'Not eligible');

              const Row = ({ k, v }: { k: string; v: any }) => (
                <div className="flex items-center justify-between gap-3 text-xs py-0.5 border-b border-border/40 last:border-0">
                  <span className="text-muted-foreground font-mono">{k}</span>
                  <span className={`font-mono font-medium ${
                    v === true ? 'text-green-600 dark:text-green-400'
                    : v === false ? 'text-red-600 dark:text-red-400'
                    : 'text-foreground'
                  }`}>
                    {v === null || v === undefined ? '—' : typeof v === 'boolean' ? String(v) : String(v)}
                  </span>
                </div>
              );

              return (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleForceSmartRaise}
                    disabled={forcingRaise || !asin || !eligible}
                    title={titleText}
                  >
                    {forcingRaise ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <TrendingUp className="h-4 w-4 mr-1" />}
                    Force Smart Raise
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Why is this enabled/disabled?">
                        <Info className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-96">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold mb-2">
                          Force Smart Raise — eligibility
                          <Badge variant={eligible ? 'default' : 'secondary'} className="ml-2">
                            {eligible ? 'ALLOWED' : 'BLOCKED'}
                          </Badge>
                        </div>
                        <Row k="owns_buy_box" v={isBbOwner} />
                        <Row k="buybox_status_raw" v={diagnostics.buyboxStatus ?? null} />
                        <Row k="ack_is_buybox_owner" v={diagnostics.latestAckIsBbOwner} />
                        <Row k="i_am_lowest_filtered" v={iAmLowestFiltered} />
                        <Row k="probe_mode" v={probeMode} />
                        <Row k="current_price" v={my != null ? `$${my.toFixed(2)}` : null} />
                        <Row k="filtered_anchor" v={externalAnchor != null ? `$${externalAnchor.toFixed(2)}` : null} />
                        <Row k="filtered_anchor_source" v={filteredSource} />
                        <Row k="filtered_anchor_raw_value" v={filteredCandidate != null ? `$${filteredCandidate.toFixed(2)}` : null} />
                        <Row k="self_offer_excluded" v={isSelfAtFilteredLow} />
                        <Row k="filtered_anchor_above_current" v={anchorAbove} />
                        <Row k="am_i_lowest_filtered_pp" v={amILowestFiltered} />
                        <Row k="lower_eligible_external_competitor_exists" v={lowerExternalExists} />
                        <Row k="has_fresh_action_context" v={hasFreshActionContext} />
                        <Row k="force_raise_allowed" v={eligible} />
                        {disabledReason && (
                          <div className="text-xs text-red-600 dark:text-red-400 pt-2 mt-2 border-t border-border/40">
                            <span className="font-semibold">disabled_reason:</span> {disabledReason}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground pt-2 mt-2 border-t border-border/40">
                          Cooldown and BB-owner hold are intentionally NOT gating this button — Force Smart Raise bypasses both server-side (final ROI/min/max/Amazon/BB-loss guards still apply).
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              );
            })()}
          </DialogTitle>
        </DialogHeader>
        
        {/* Status Warning Banner */}
        {(() => {
          const effectiveStatus = localResumed ? 'active' : (overrideStatus ?? assignmentStatus);
          if (!effectiveStatus || effectiveStatus === 'active') return null;
          return (
          <div className="flex items-center justify-between p-3 rounded-lg border border-destructive/50 bg-destructive/10 mb-2">
            <div className="flex items-center gap-2">
              <PauseCircle className="h-4 w-4 text-destructive shrink-0" />
              <div className="text-sm">
                <span className="font-medium text-destructive">
                  {effectiveStatus === 'paused_profit_guard'
                    ? 'Paused by Profit Guard'
                    : effectiveStatus === 'paused'
                      ? 'Manually Paused'
                      : effectiveStatus === 'needs_attention'
                        ? 'Needs Attention'
                        : `Status: ${effectiveStatus}`}
                </span>
                <span className="text-muted-foreground ml-1">
                  {effectiveStatus === 'paused_profit_guard'
                    ? '— The market price is below your cost floor.'
                    : effectiveStatus === 'needs_attention'
                      ? `— ${needsAttentionReason || 'Setup was incomplete when this listing was added (missing rule, cost, price, or bounds).'} It's still checked normally and clears itself automatically once resolved — or click Resume to force it now.`
                      : '— The scheduler is not actively checking this item.'}
                </span>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={handleResume} disabled={resuming}>
              {resuming ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : null}
              Resume
            </Button>
          </div>
          );
        })()}

        {/* ═══ SPLIT LAYOUT: Diagnostics left, Action Log right ═══ */}
        <div className="flex gap-4 min-h-0 flex-1 overflow-hidden">
        {/* LEFT PANEL — Diagnostics */}
        <div className="w-1/2 min-w-0 overflow-y-auto pr-2 space-y-4">
        <div className="p-3 rounded-lg border bg-muted/50 space-y-2">
          {/* Row 1: Timing & Decision */}
          <div className="text-sm">
            <div className="flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">{headlineLabel} </span>
              <span className="font-medium text-foreground">
                {headlineTimestamp
                  ? format(new Date(headlineTimestamp), "MMM d, yyyy 'at' HH:mm:ss")
                  : "—"}
              </span>
            </div>
            {/* Enhanced decision line: anchor source + market context */}
            <div className="mt-0.5 text-xs pl-[22px] space-y-0.5">
              <div className="text-muted-foreground">
                {statusSummary}
              </div>
              {(() => {
                if (!hasFreshActionContext) {
                  const liveBuybox = diagnostics.snapshotBuyboxPrice ?? diagnostics.lastBuyboxPrice;
                  const liveLowestFba = diagnostics.snapshotLowestFba;
                  const liveMyPrice = diagnostics.myPrice;
                  const liveParts: string[] = [];

                  if (liveBuybox != null) {
                    liveParts.push(`Live Buy Box ${formatCurrency(liveBuybox)}`);
                  }
                  if (liveLowestFba != null && liveMyPrice != null) {
                    liveParts.push(
                      liveLowestFba < liveMyPrice
                        ? `lower FBA competitor at ${formatCurrency(liveLowestFba)}`
                        : 'no lower FBA competitor'
                    );
                  }

                  return liveParts.length > 0 ? (
                    <div className="text-foreground/70 font-medium">
                      ↳ {liveParts.join(' · ')}
                    </div>
                  ) : null;
                }

                const f = latestAction?.intelligence_factors || {};
                const pt = f.price_trace || {};
                const pp = f.position_proof || {};
                const anchorSrc = pt.anchor_source || f.anchor_source || '';
                const anchorLabel = anchorSrc === 'buybox_winner_offer' ? 'Buy Box (winner)'
                  : anchorSrc === 'buybox_summary' ? 'Buy Box (summary)'
                  : anchorSrc === 'buybox_fallback' ? 'Buy Box (fallback)'
                  : anchorSrc === 'lowest_eligible' ? 'Lowest eligible'
                  : anchorSrc === 'lowest_fba' ? 'Lowest FBA'
                  : anchorSrc === 'lowest_fbm' ? 'Lowest FBM'
                  : anchorSrc === 'lowest_offer' ? 'Lowest offer'
                  : anchorSrc === 'fbm_target' ? 'FBM target'
                  : anchorSrc || null;
                const isLowestFbmAnchor = anchorSrc === 'lowest_fbm' || anchorSrc === 'fbm_target';
                const lowestFbmAnchorPrice = f.lowest_fbm_anchor_price ?? pt.lowest_fbm ?? null;
                const bbPrice = pt.buybox_price ?? diagnostics.snapshotBuyboxPrice ?? diagnostics.lastBuyboxPrice;
                const lowestFiltered = pp.lowest_price_filtered;
                const myPrice = diagnostics.myPrice ?? pt.current_price;
                const hasLowerCompetitor = lowestFiltered != null && myPrice != null && lowestFiltered < myPrice;
                const clampedBy = pt.clamped_by;
                
                if (!anchorLabel && !hasLowerCompetitor && !clampedBy) return null;
                
                const parts: string[] = [];
                if (anchorLabel) {
                  const anchorPrice = isLowestFbmAnchor
                    ? (lowestFbmAnchorPrice ?? f.anchor_price ?? bbPrice)
                    : (f.anchor_price ?? pt.buybox_price ?? bbPrice);
                  parts.push(`Anchor: ${anchorLabel}${anchorPrice != null ? ` ${formatCurrency(anchorPrice)}` : ''}`);
                }
                if (hasLowerCompetitor) {
                  parts.push(`lower competitor at ${formatCurrency(lowestFiltered)}`);
                } else if (lowestFiltered != null && myPrice != null) {
                  parts.push(`no lower competitor`);
                }
                if (clampedBy) {
                  parts.push(`⚠️ clamped by ${clampedBy}`);
                }
                
                return parts.length > 0 ? (
                  <div className="text-foreground/70 font-medium">
                    ↳ {parts.join(' · ')}
                  </div>
                ) : null;
              })()}
            </div>
            {isPriorityHeartbeatNewer && lastCheckedAt && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Live market fetch: {format(new Date(lastCheckedAt), "MMM d, HH:mm:ss")}
              </div>
            )}
            {!isPriorityHeartbeatNewer && lastCheckedAt && diagnostics.lastEvalAttempt && lastCheckedAt !== diagnostics.lastEvalAttempt && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Latest fetch: {format(new Date(lastCheckedAt), "MMM d, HH:mm:ss")}
              </div>
            )}
            {/* Show latest ack result when it's more recent than last price action */}
            {diagnostics.latestAckAt && (!latestActionAt || new Date(diagnostics.latestAckAt).getTime() > new Date(latestActionAt).getTime()) && diagnostics.latestAckResult && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Latest eval: {diagnostics.latestAckResult === 'no_change' ? '⏸️' : diagnostics.latestAckResult === 'blocked' ? '🚫' : diagnostics.latestAckResult === 'changed' ? '📤' : '✅'}{' '}
                {diagnostics.latestAckReason || diagnostics.latestAckResult}
                {diagnostics.latestAckAt && ` — ${format(new Date(diagnostics.latestAckAt), "MMM d, HH:mm:ss")}`}
              </div>
            )}
            {/* Verification stage for the latest successful submit — distinguishes "submitted" from "live-verified" on Amazon */}
            {(() => {
              const la = latestAction;
              if (!la || !la.success) return null;
              if (la.action_type !== 'price_change' && la.action_type !== 'price_changed' && la.action_type !== 'price_and_minmax_change') return null;
              const status = la.reconciliation_status;
              if (!status) return null;
              const intended = la.intended_price ?? la.new_price;
              const live = la.verified_live_price;
              const myLive = diagnostics.myPrice;
              const verifiedAt = la.verified_at ? format(new Date(la.verified_at), "MMM d, HH:mm:ss") : null;
              let icon = '🟡', label = '';
              if (status === 'pending' || status === 'recheck') {
                icon = '🟡';
                label = `Submitted to Amazon ${formatCurrency(intended ?? null)} — verifying live offer${myLive != null ? ` (live still ${formatCurrency(myLive)})` : ''}`;
              } else if (status === 'matched') {
                icon = '✅';
                label = `Live price verified at ${formatCurrency(live ?? intended ?? null)}${verifiedAt ? ` · ${verifiedAt}` : ''}`;
              } else if (status === 'mismatch') {
                const cause = (la as any).recon_root_cause as string | null;
                if (cause === 'AMAZON_MIN_PRICE_BLOCK' || cause === 'AMAZON_MAX_PRICE_BLOCK') {
                  const which = cause === 'AMAZON_MIN_PRICE_BLOCK' ? 'minimum' : 'maximum';
                  return (
                    <div className="text-xs pl-[22px] mt-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 p-2">
                      ⚠️ Amazon pricing rules blocked the submitted target.
                      <div className="mt-1 text-[11px] opacity-90">
                        Your repricer submitted <b>{formatCurrency(intended ?? null)}</b> but Amazon Seller Central's Automate Pricing {which} clamped the live price to <b>{formatCurrency(live ?? null)}</b>.
                        Update the Amazon-side {which} price in Seller Central (or use Push Bounds to Amazon) so the repricer's target can take effect.
                      </div>
                    </div>
                  );
                }
                icon = '⚠️';
                label = `Price update not yet verified on Amazon — Amazon shows ${formatCurrency(live ?? null)} vs intended ${formatCurrency(intended ?? null)}${verifiedAt ? ` · ${verifiedAt}` : ''}`;
              } else if (status === 'pending_timeout') {
                icon = '⚠️';
                label = `Verification timeout — Amazon never reflected ${formatCurrency(intended ?? null)}${live != null ? ` (live: ${formatCurrency(live)})` : ''}`;
              } else if (status === 'failed') {
                icon = '⚠️';
                label = `Verification failed: ${la.reconciliation_reason || 'unknown'}`;
              } else if (status === 'non_reconcilable') {
                icon = 'ℹ️';
                label = `Reconciliation skipped — ${la.reconciliation_reason || 'non-reconcilable variant'}`;
              } else {
                return null;
              }
              return (
                <div className="text-xs text-muted-foreground pl-[22px]">
                  Verification: {icon} {label}
                </div>
              );
            })()}
            {schedulerHeartbeatAt && !isPriorityHeartbeatNewer && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Scheduler activity: {format(new Date(schedulerHeartbeatAt), "MMM d, HH:mm:ss")}
              </div>
            )}
            {isPriorityHeartbeatNewer && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Priority lane is active — this ASIN is being touched every 1–2 minutes, but the latest cycle reused market data because Buy Box was unchanged.
              </div>
            )}
            {!hasFreshActionContext && latestActionAt && latestTouchAt && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Live snapshot is newer than the last logged price action below.
              </div>
            )}
            {nextEligibleFetchAt && !diagnostics.effectivePriority && fetchIntervalMinutes > 2 && nextEligibleFetchInMinutes && nextEligibleFetchInMinutes > 0 && (
              <div className="text-xs text-muted-foreground pl-[22px]">
                Normal rotation — next live fetch is eligible around {format(new Date(nextEligibleFetchAt), "HH:mm:ss")} (~{nextEligibleFetchInMinutes} min). 2-minute checks only apply to priority/starred items.
              </div>
            )}
            {nextEligibleFetchAt && diagnostics.effectivePriority && !isPriorityHeartbeatNewer && nextEligibleFetchInMinutes && nextEligibleFetchInMinutes > 0 && (() => {
              const cdUntil = diagnostics.oscillationCooldownUntil ? new Date(diagnostics.oscillationCooldownUntil).getTime() : 0;
              const cdMsLeft = cdUntil - Date.now();
              const inRecoveryWatch = cdMsLeft > 0 && cdMsLeft <= 5 * 60 * 1000;
              const recentlyCleared = cdUntil > 0 && cdMsLeft <= 0 && cdMsLeft >= -10 * 60 * 1000
                && (diagnostics.oscillationState || '').toLowerCase().includes('cooldown');
              if (inRecoveryWatch) {
                const minsLeft = Math.max(1, Math.ceil(cdMsLeft / 60000));
                return (
                  <div className="text-xs text-orange-600 dark:text-orange-400 pl-[22px]">
                    🟠 Oscillation Recovery Watch — rechecking for safe Buy Box capture (cooldown clears in ~{minsLeft} min; price holds steady until then).
                  </div>
                );
              }
              if (recentlyCleared) {
                return (
                  <div className="text-xs text-orange-600 dark:text-orange-400 pl-[22px]">
                    🟠 Oscillation Recovery Watch — cooldown just cleared, engine is re-evaluating for a safe Buy Box capture.
                  </div>
                );
              }
              return (
                <div className="text-xs text-muted-foreground pl-[22px]">
                  HOT lane active — this ASIN is being revisited on accelerated rotation; next eligible fetch is around {format(new Date(nextEligibleFetchAt), "HH:mm:ss")} (~{nextEligibleFetchInMinutes} min).
                </div>
              );
            })()}
            {diagnostics.hasSellableStock === false && (
              <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/30 rounded px-3 py-1.5 mt-1">
                <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
                <span className="text-xs text-yellow-600 font-medium">
                  {(diagnostics.inventoryReserved ?? 0) > 0 
                    ? `Reserved-stock mode active (available: ${diagnostics.inventoryAvailable ?? 0}, reserved: ${diagnostics.inventoryReserved}) — repricer can still evaluate and raise using reserved-stock recovery logic.`
                    : `No sellable inventory (available: ${diagnostics.inventoryAvailable ?? 0}) — repricer will skip evaluation for this ASIN.`
                  }
                </span>
              </div>
            )}
          </div>

          {/* Row 2: Pricing Context — always visible */}
          {(() => {
             // Detect my current price with explicit source priority:
             // 1) live SP-API offers snapshot (diagnostics.myPrice — already resolves self offer when available)
             // 2) latest successful action's new_price (any action_type, as long as a real price was written)
             // 3) lastAppliedPrice cached on the assignment row
             const actionNewPrice = (latestAction?.new_price != null && Number.isFinite(Number(latestAction.new_price)))
               ? Number(latestAction.new_price)
               : null;
             const fallbackMyPrice = diagnostics.myPrice
               ?? actionNewPrice
               ?? diagnostics.lastAppliedPrice
               ?? null;
             const detectedSource: 'live_offer' | 'latest_action' | 'listing_cache' | 'missing' =
               diagnostics.myPrice != null
                 ? 'live_offer'
                 : actionNewPrice != null
                   ? 'latest_action'
                   : diagnostics.lastAppliedPrice != null
                     ? 'listing_cache'
                     : 'missing';
             const myPriceFromAction = detectedSource === 'latest_action';
             const myPriceFromCache = detectedSource === 'listing_cache';
            return (
              <div className="grid grid-cols-4 gap-2 text-xs border-t border-border/50 pt-2">
                 <div>
                   <span className="text-muted-foreground block">My Price</span>
                   <span className="font-semibold text-foreground">{formatCurrency(fallbackMyPrice)}</span>
                    {myPriceFromAction && (
                      <span className="text-[10px] text-muted-foreground block">(from latest action)</span>
                    )}
                    {myPriceFromCache && (
                      <span className="text-[10px] text-muted-foreground block">(from listing cache)</span>
                    )}
                    <span className="text-[10px] text-muted-foreground/70 block">source: {detectedSource}</span>
                    {(myPriceFromAction || myPriceFromCache) && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 block mt-1 leading-tight">
                        ⚠️ Price from {myPriceFromAction ? 'latest action' : 'listing cache'} — live offer not confirmed. Run Now to refresh.
                      </span>
                    )}
                  </div>
                <div>
                  <span className="text-muted-foreground block">Last Applied</span>
                  <span className="font-semibold text-foreground">{formatCurrency(diagnostics.lastAppliedPrice ?? null)}</span>
                  {diagnostics.myPrice != null && diagnostics.lastAppliedPrice != null && Math.abs(diagnostics.myPrice - diagnostics.lastAppliedPrice) > 0.02 && (
                    <span className="text-[10px] text-muted-foreground block">
                      (by repricer — manual eval trigger)
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground block">Min Floor</span>
                  <span className="font-semibold text-foreground">{formatCurrency(diagnostics.minPriceOverride ?? null)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Max Ceiling</span>
                  <span className="font-semibold text-foreground">{formatCurrency(diagnostics.maxPriceOverride ?? null)}</span>
                </div>
              </div>
            );
          })()}

          {/* Row 2b: Floor Breakdown — show when ROI floor data available */}
          {(() => {
            const f = hasFreshActionContext ? (latestAction?.intelligence_factors || {}) : {};
            const sg = f.safeguards || {};
            const roiFloor = sg.roi_floor;
            const staticMin = sg.static_min ?? sg.min_price;
            const effFloor = sg.effective_floor;
            const roiSource = sg.roi_floor_source;
            const targetRoi = sg.target_roi_percent;
            const dynamicEnabled = sg.dynamic_roi_enabled;

            if (!dynamicEnabled && !roiFloor) return null;

            return (
              <div className="grid grid-cols-4 gap-2 text-xs border-t border-border/30 pt-1.5">
                <div>
                  <span className="text-muted-foreground block">Static Min</span>
                  <span className="font-semibold text-foreground">{formatCurrency(staticMin ?? null)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">ROI Floor</span>
                  <span className={`font-semibold ${roiFloor && roiFloor > (staticMin || 0) ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                    {roiFloor ? formatCurrency(roiFloor) : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Effective Floor</span>
                  <span className="font-semibold text-foreground">{formatCurrency(effFloor ?? null)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">ROI Source</span>
                  <span className={`font-semibold text-xs ${roiSource === 'cached_fees' ? 'text-green-600 dark:text-green-400' : roiSource === 'fallback_static' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                    {roiSource === 'cached_fees' ? `✅ Cached (${targetRoi}%)` : roiSource === 'fallback_static' ? '⚠️ Fallback' : dynamicEnabled ? '— No cost' : '— Off'}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Row 3: Market Context — always visible */}
          {(() => {
            const snapshotAt = diagnostics.lastSnapshotAt;
            const snapshotAgeMin = snapshotAt ? Math.round((Date.now() - new Date(snapshotAt).getTime()) / 60000) : null;
            const snapshotFreshnessLabel = snapshotAt
              ? snapshotAgeMin! < 1 ? 'just now'
                : snapshotAgeMin! < 60 ? `${snapshotAgeMin}m ago`
                : snapshotAgeMin! < 1440 ? `${Math.round(snapshotAgeMin! / 60)}h ago`
                : `${Math.round(snapshotAgeMin! / 1440)}d ago`
              : null;
            const isStale = snapshotAgeMin != null && snapshotAgeMin > 120;
            // If a recent action carries position_proof / price_trace, treat as having data
            const actionHasMarketData = hasFreshActionContext && !!(
              latestAction?.intelligence_factors?.position_proof ||
              latestAction?.intelligence_factors?.price_trace
            );
            const hasNoSnapshot = !snapshotAt && !actionHasMarketData;
            const usingActionFallback = !snapshotAt && actionHasMarketData;

            return (
              <>
                {/* Snapshot freshness indicator */}
                <div className="flex items-center gap-1.5 text-[10px] border-t border-border/50 pt-2 pb-0.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${hasNoSnapshot ? 'bg-orange-400' : isStale ? 'bg-yellow-400' : 'bg-green-400'}`} />
                  <span className="text-muted-foreground">
                    {hasNoSnapshot
                      ? '⚠️ No market snapshot yet — data below will populate after first evaluation'
                      : usingActionFallback
                        ? `Market data from latest action${latestActionAt ? ` — ${format(new Date(latestActionAt), "MMM d, HH:mm:ss")}` : ''}`
                        : `Snapshot: ${snapshotFreshnessLabel}${isStale ? ' — may be outdated' : ''}`}
                  </span>
                </div>
                {(() => {
                  // Source-aware market values: prefer fresh action / ack over snapshot.
                  // Each tile carries a source label so users can see whether the figure came
                  // from the live SP-API fetch, the evaluator ack, or a (possibly stale) snapshot.
                  const f2 = hasFreshActionContext ? (latestAction?.intelligence_factors || {}) : {};
                  const pt = f2.price_trace || {};
                  const pp = f2.position_proof || {};
                  const actionAtMs = hasFreshActionContext && latestActionAt ? new Date(latestActionAt).getTime() : 0;
                  const ackAtMs = diagnostics.latestAckAt ? new Date(diagnostics.latestAckAt).getTime() : 0;
                  const snapAtMs = snapshotAt ? new Date(snapshotAt).getTime() : 0;

                  const evaluatorAnchorPrice = pt.buybox_price ?? null;
                  const evaluatorAnchorSource: string | null = pt.anchor_source || f2.anchor_source || null;

                  type Resolved = { value: number | null; source: string; ts: number | null; stale: boolean };
                  const resolve = (
                    actionVal: number | null | undefined,
                    ackVal: number | null | undefined,
                    snapVal: number | null | undefined,
                  ): Resolved => {
                    const candidates: { value: number; source: string; ts: number }[] = [];
                    if (actionVal != null && actionAtMs) candidates.push({ value: Number(actionVal), source: 'live action', ts: actionAtMs });
                    if (ackVal != null && ackAtMs) candidates.push({ value: Number(ackVal), source: 'evaluator ack', ts: ackAtMs });
                    if (snapVal != null && snapAtMs) candidates.push({ value: Number(snapVal), source: 'snapshot', ts: snapAtMs });
                    if (candidates.length === 0) return { value: null, source: '—', ts: null, stale: false };
                    candidates.sort((a, b) => b.ts - a.ts);
                    const top = candidates[0];
                    const ageMin = (Date.now() - top.ts) / 60000;
                    return { value: top.value, source: top.source, ts: top.ts, stale: ageMin > 120 };
                  };

                  const buybox = resolve(pt.buybox_price, diagnostics.latestAckBuyboxPrice, diagnostics.snapshotBuyboxPrice ?? diagnostics.lastBuyboxPrice ?? null);
                  const lowestFba = resolve(pp.lowest_price_filtered ?? pt.lowest_fba ?? null, diagnostics.latestAckLowestFba, diagnostics.snapshotLowestFba ?? null);
                  const lowestOverall = resolve(pp.lowest_price_raw ?? null, null, diagnostics.snapshotLowestOverall ?? null);

                  // Divergence warning: header lowest_fba differs >5% from evaluator anchor
                  const divergenceWarning = (() => {
                    if (evaluatorAnchorPrice == null || lowestFba.value == null) return null;
                    const delta = Math.abs(Number(evaluatorAnchorPrice) - Number(lowestFba.value));
                    const pct = Number(evaluatorAnchorPrice) > 0 ? delta / Number(evaluatorAnchorPrice) : 0;
                    if (pct < 0.05 || delta < 0.05) return null;
                    return `Header market value differs from evaluator source (anchor ${evaluatorAnchorSource || 'evaluator'} ${formatCurrency(evaluatorAnchorPrice)} vs Lowest FBA ${formatCurrency(lowestFba.value)} from ${lowestFba.source}${lowestFba.stale ? ', stale' : ''}).`;
                  })();

                  const fmtAge = (ts: number | null) => {
                    if (!ts) return '';
                    const m = Math.round((Date.now() - ts) / 60000);
                    if (m < 1) return 'just now';
                    if (m < 60) return `${m}m ago`;
                    if (m < 1440) return `${Math.round(m / 60)}h ago`;
                    return `${Math.round(m / 1440)}d ago`;
                  };

                  const Tile = ({ label, r, extra }: { label: string; r: Resolved; extra?: React.ReactNode }) => (
                    <div>
                      <span className="text-muted-foreground block">{label}</span>
                      <span className={`font-semibold ${r.stale ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                        {r.value != null ? formatCurrency(r.value) : '—'}
                        {r.stale && r.value != null ? ' ⚠️' : ''}
                      </span>
                      {extra}
                      {r.value != null && (
                        <span className="block text-[10px] text-muted-foreground/80">
                          {r.source}{r.ts ? ` · ${fmtAge(r.ts)}` : ''}
                        </span>
                      )}
                    </div>
                  );

                  return (
                    <>
                      {divergenceWarning && (
                        <div className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded px-2 py-1 mb-1">
                          ⚠️ {divergenceWarning}
                        </div>
                      )}
                      <div className="grid grid-cols-4 gap-2 text-xs">
                        <Tile label="Buy Box" r={buybox} />
                        <div>
                          <span className="text-muted-foreground block">BB Status</span>
                          <BbStatusBadge
                            rawStatus={diagnostics.buyboxStatus}
                            myPrice={diagnostics.myPrice ?? diagnostics.lastAppliedPrice}
                            buyboxPrice={buybox.value}
                          />
                        </div>
                        <Tile label="Lowest FBA" r={lowestFba} />
                        <Tile label="Lowest Overall (all)" r={lowestOverall} />
                      </div>
                    </>
                  );
                })()}
              </>
            );
          })()}

          {/* Row 4: Position & Intelligence — from latest action's intelligence_factors */}
          {(() => {
            const f = hasFreshActionContext ? (latestAction?.intelligence_factors || {}) : {};
            const pp = f.position_proof || {};
            const lowestRaw = hasFreshActionContext ? pp.lowest_price_raw ?? null : diagnostics.snapshotLowestOverall ?? null;
            const lowestFiltered = hasFreshActionContext ? pp.lowest_price_filtered ?? null : diagnostics.snapshotLowestFba ?? null;
            const amILowestRaw = hasFreshActionContext
              ? pp.am_i_lowest_raw
              : (diagnostics.myPrice != null && lowestRaw != null ? diagnostics.myPrice <= lowestRaw + 0.009 : null);
            const amILowestFiltered = hasFreshActionContext
              ? pp.am_i_lowest_filtered
              : (diagnostics.myPrice != null && lowestFiltered != null ? diagnostics.myPrice <= lowestFiltered + 0.009 : null);
            const isPriceCluster = hasFreshActionContext ? pp.is_price_cluster : null;
            
            return (
              <div className="grid grid-cols-4 gap-2 text-xs border-t border-border/50 pt-2">
                <div>
                  <span className="text-muted-foreground block">Lowest Raw</span>
                  <span className="font-semibold text-foreground">{formatCurrency(lowestRaw)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Lowest Filtered</span>
                  <span className="font-semibold text-foreground">{formatCurrency(lowestFiltered)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Am I Lowest?</span>
                  <span className="font-semibold text-foreground">
                    {amILowestRaw != null ? (amILowestRaw ? '✅ Raw' : '❌ Raw') : '—'}
                    {amILowestFiltered != null && (
                      <> / {amILowestFiltered ? '✅ Filt' : '❌ Filt'}</>
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Price Cluster?</span>
                  <span className="font-semibold text-foreground">
                    {isPriceCluster != null ? (isPriceCluster ? '⚠️ Yes' : 'No') : '—'}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Row 5: Blocker & Safeguard — always visible */}
          {(() => {
            const f = hasFreshActionContext ? (latestAction?.intelligence_factors || {}) : {};
            const pp = f.position_proof || {};
            const pt = f.price_trace || {};
            const blocker = hasFreshActionContext ? pp.blocker : null;
            const liveLowestFba = diagnostics.snapshotLowestFba ?? null;
            const liveLowestFiltered = pp.lowest_price_filtered ?? null;
            const liveRaiseAnchor = liveLowestFiltered ?? liveLowestFba;
            const liveGap = diagnostics.myPrice != null && liveRaiseAnchor != null ? liveRaiseAnchor - diagnostics.myPrice : null;
            // backend gap = my_price - blocker.price → positive means blocker is BELOW (true blocker), negative means competitor is ABOVE (raise headroom)
            const blockerText = (() => {
              if (blocker) {
                const gapNum = blocker.gap != null ? Number(blocker.gap) : null;
                const isAbove = gapNum != null && gapNum < -0.005;
                const label = isAbove ? 'Next higher competitor' : 'Blocker (lower)';
                const gapStr = gapNum != null
                  ? ` (gap ${isAbove ? '+' : '-'}$${Math.abs(gapNum).toFixed(2)})`
                  : '';
                return `${label} · ${blocker.channel || '?'} @ ${formatCurrency(blocker.price ?? null)}${gapStr}`;
              }
              if (liveRaiseAnchor != null && diagnostics.myPrice != null && liveRaiseAnchor > diagnostics.myPrice + 0.01) {
                return `Next higher competitor · FBA @ ${formatCurrency(liveRaiseAnchor)}${liveGap != null ? ` (gap +$${liveGap.toFixed(2)})` : ''}`;
              }
              return '— None';
            })();
            const safeguardText = hasFreshActionContext
              ? (pt.clamped_by
                  ? `⚠️ Clamped: ${pt.clamped_by}`
                  : (lastRecommendationReason?.includes('Safeguard') ? '⚠️ Safeguard active' : '✅ None'))
              : '— Live snapshot only';
            
            return (
              <div className="grid grid-cols-2 gap-2 text-xs border-t border-border/50 pt-2">
                <div>
                  <span className="text-muted-foreground block">Next Competitor / Blocker</span>
                  <span className="font-semibold text-foreground">{blockerText}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Safeguard</span>
                  <span className="font-semibold text-foreground">{safeguardText}</span>
                </div>
              </div>
            );
          })()}

          {/* Status badge inline */}
          <div className="flex items-center gap-2 border-t border-border/50 pt-2">
            {(() => {
              const ds = diagnostics.lastDataSource;
              const isSuccess = ds === 'sp_api' || ds === 'cache' || ds === 'keepa';
              const isSkipped = ds === 'throttled';
              const statusLabel = isSuccess ? 'SUCCESS ✅' : isSkipped ? 'SKIPPED ⏭️' : ds?.toUpperCase() || '—';
              return (
                <span className="text-xs">
                  <span className="text-muted-foreground">Status: </span>
                  <span className="font-semibold text-foreground">{statusLabel}</span>
                </span>
              );
            })()}
          </div>
        </div>

        {/* Change Readiness Panel */}
        {diagnostics.lastDataSource && (
          <ChangeReadinessPanel
            diagnostics={diagnostics}
            lastRecommendationReason={lastRecommendationReason}
            assignmentStatus={localResumed ? 'active' : (overrideStatus ?? assignmentStatus)}
            latestAction={latestAction}
            marketplace={marketplace}
            recentActions={priceActions.slice(0, 10)}
          />
        )}

        {/* Position Proof moved to per-action structured diagnostics below */}

        {(diagnostics.isPriority || diagnostics.lastSkipReason || diagnostics.lastEvalAttempt) && (
          <div className="space-y-3 mb-4">
            {/* SECTION 1: Current Evaluation Result */}
            {(diagnostics.lastTriggerSource || diagnostics.lastDataSource) && (
              <div className="p-3 rounded-lg border bg-muted/30 text-xs space-y-1.5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-foreground text-sm">Current Evaluation</span>
                  {diagnostics.lastEvalAttempt && (
                    <span className="text-muted-foreground">@ {format(new Date(diagnostics.lastEvalAttempt), "HH:mm:ss")}</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {diagnostics.lastTriggerSource && (
                    <div>
                      <span className="text-muted-foreground">Trigger:</span>
                      <Badge variant="outline" className="text-xs py-0 ml-1">
                        {diagnostics.lastTriggerSource === 'manual_run_selected' ? '🖱️ manual_run_selected'
                          : diagnostics.lastTriggerSource === 'priority_cron' ? '⭐ priority_cron'
                          : diagnostics.lastTriggerSource === 'scheduler' ? '⏰ scheduler'
                          : diagnostics.lastTriggerSource}
                      </Badge>
                    </div>
                  )}
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-muted-foreground">Queue priority:</span>
                    {(() => {
                      const basePriority = diagnostics.isPriority ? "⭐ Priority" : "Normal";
                      const wasElevated = !diagnostics.isPriority && diagnostics.lastTriggerSource === 'priority_cron';
                      const effectiveLabel = diagnostics.isPriority || diagnostics.lastTriggerSource === 'priority_cron'
                        ? "⭐ Priority"
                        : (diagnostics.aboveBbGap != null && diagnostics.aboveBbGap >= 0.02)
                          ? `🔥 HOT (Above BB +$${diagnostics.aboveBbGap.toFixed(2)})`
                          : "Normal";
                      return wasElevated ? (
                        <>
                          <Badge variant="secondary" className="text-xs py-0">{basePriority}</Badge>
                          <span className="text-muted-foreground">→</span>
                          <Badge variant="default" className="text-xs py-0">{effectiveLabel}</Badge>
                          <span className="text-[10px] text-muted-foreground">(elevated)</span>
                        </>
                      ) : (
                        <Badge variant={diagnostics.effectivePriority ? "default" : "secondary"} className="text-xs py-0">
                          {effectiveLabel}
                        </Badge>
                      );
                    })()}
                  </div>
                </div>

                {/* Fetch chain — always show for current eval */}
                {diagnostics.lastDataSource && (
                  <div className="space-y-0.5 pt-1 border-t border-border mt-1">
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Primary fetch:</span>
                      <Badge 
                        variant={diagnostics.lastDataSource === 'sp_api' ? "secondary" : "destructive"} 
                        className="text-xs py-0"
                      >
                        {diagnostics.lastDataSource === 'sp_api' ? '✅ SP-API success'
                          : diagnostics.lastDataSource === 'throttled' ? '❌ SP-API throttled'
                          : diagnostics.lastDataSource === 'cache' ? '❌ SP-API throttled'
                          : diagnostics.lastDataSource === 'keepa' ? '❌ SP-API throttled'
                          : '⚠️ SP-API ' + diagnostics.lastDataSource}
                      </Badge>
                    </div>
                    {/* Fallback chain (only when SP-API failed) */}
                    {diagnostics.lastDataSource !== 'sp_api' && (
                      <div className="space-y-0.5">
                        {diagnostics.lastDataSource === 'throttled' && diagnostics.lastSkipDetails ? (
                          <>
                            {diagnostics.lastSkipDetails.includes('Cache:') && (
                              <div className="flex items-center gap-1">
                                <span className="text-muted-foreground">Cache fallback:</span>
                                <Badge variant="destructive" className="text-xs py-0">
                                  ❌ {diagnostics.lastSkipDetails.match(/Cache:\s*([^|]+)/)?.[1]?.trim() || 'unavailable'}
                                </Badge>
                              </div>
                            )}
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Keepa fallback:</span>
                              <Badge variant="destructive" className="text-xs py-0">
                                ❌ {(() => {
                                  const keepaMatch = diagnostics.lastSkipDetails?.match(/Keepa:\s*(.+?)$/)?.[1]?.trim();
                                  const rainforestMatch = diagnostics.lastSkipDetails?.match(/Rainforest:?\s*(.+?)$/)?.[1]?.trim();
                                  const raw = keepaMatch || rainforestMatch || 'not triggered';
                                  return raw.replace(/Rainforest/gi, 'Keepa (legacy)');
                                })()}
                              </Badge>
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Fallback:</span>
                            <Badge 
                              variant={diagnostics.lastDataSource === 'keepa' ? "default" : diagnostics.lastDataSource === 'cache' ? "secondary" : "destructive"}
                              className="text-xs py-0"
                            >
                              {diagnostics.lastDataSource === 'keepa' ? '🔑 Keepa used'
                                : diagnostics.lastDataSource === 'cache' ? '💾 Cache used'
                                : '⚠️ No reliable data'}
                            </Badge>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Decision source:</span>
                      <Badge variant="outline" className="text-xs py-0">
                        {diagnostics.lastDataSource === 'sp_api' ? '📡 SP-API'
                          : diagnostics.lastDataSource === 'cache' ? '💾 Cache'
                          : diagnostics.lastDataSource === 'keepa' ? '🔑 Keepa'
                          : diagnostics.lastDataSource === 'throttled' ? '⚠️ None (skipped)'
                          : diagnostics.lastDataSource}
                      </Badge>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* SECTION 2: Operational Details */}
            <div className="p-3 rounded-lg border bg-muted/30 text-xs">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div>
                  <span className="text-muted-foreground">Fetch interval:</span>
                  <span className="font-medium text-foreground ml-1">{diagnostics.effectiveFetchInterval ?? diagnostics.minFetchInterval ?? 60}min</span>
                </div>
                {lastCheckedAt && (
                  <div>
                    <span className="text-muted-foreground">Last fetch age:</span>
                    <span className="font-medium text-foreground ml-1">
                      {Math.round((Date.now() - new Date(lastCheckedAt).getTime()) / 60000)}min ago
                    </span>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Force-eval from cache:</span>
                  <span className="font-medium text-foreground ml-1">{diagnostics.forceEvalUsed ? 'Yes' : 'No'}</span>
                </div>
                {diagnostics.lastThrottleAt && (
                  <div>
                    <span className="text-muted-foreground">Last throttled:</span>
                    <span className="font-medium text-foreground ml-1">
                      {format(new Date(diagnostics.lastThrottleAt), "MMM d, HH:mm:ss")}
                    </span>
                    <span className="text-muted-foreground ml-1">
                      ({Math.round((Date.now() - new Date(diagnostics.lastThrottleAt).getTime()) / 60000)}min ago)
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* SECTION 3: Previous Skip History (only show if there was a skip AND current eval was successful) */}
            {diagnostics.lastSkipReason && diagnostics.lastDataSource !== 'throttled' && (
              <details className="p-3 rounded-lg border bg-muted/20 text-xs">
                <summary className="cursor-pointer text-muted-foreground font-medium flex items-center gap-1">
                  <span>📜 Previous skip history</span>
                  {diagnostics.lastEvalAttempt && (
                    <span className="text-[10px]">@ {format(new Date(diagnostics.lastEvalAttempt), "HH:mm:ss")}</span>
                  )}
                </summary>
                <div className="mt-2 space-y-0.5">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Skip source:</span>
                    <Badge variant="outline" className="text-xs py-0">{diagnostics.lastSkipLane || "—"}</Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Skip reason:</span>
                    <span className="font-medium text-foreground">{diagnostics.lastSkipReason}</span>
                  </div>
                  {diagnostics.lastSkipDetails && (
                    <div className="text-muted-foreground text-[10px]">
                      — {diagnostics.lastSkipDetails.replace(/Rainforest/g, 'Keepa (legacy: Rainforest)')}
                    </div>
                  )}
                </div>
              </details>
            )}

            {/* SECTION 3b: Skip details as primary (when current eval IS skipped) */}
            {diagnostics.lastSkipReason && diagnostics.lastDataSource === 'throttled' && (
              <div className="p-3 rounded-lg border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 dark:border-yellow-800 text-xs space-y-0.5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-foreground text-sm">Skip Details</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">Skip source:</span>
                  <Badge variant="outline" className="text-xs py-0">{diagnostics.lastSkipLane || "—"}</Badge>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">Skip reason:</span>
                  <span className="font-medium text-foreground">{diagnostics.lastSkipReason}</span>
                </div>
                {diagnostics.lastSkipDetails && (
                  <div className="text-muted-foreground text-[10px]">
                    — {diagnostics.lastSkipDetails.replace(/Rainforest/g, 'Keepa (legacy: Rainforest)')}
                  </div>
                )}
              </div>
            )}

            {/* SECTION 4: Listing & Buy Box diagnostics */}
            {(diagnostics.listingStatus || diagnostics.consecutiveZeroOffers || diagnostics.buyboxStatus) && (
              <div className="p-3 rounded-lg border bg-muted/30 text-xs">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {diagnostics.listingStatus && (
                    <div>
                      <span className="text-muted-foreground">Listing status:</span>
                      <Badge variant={diagnostics.listingStatus.includes('INACTIVE') ? "destructive" : "secondary"} className="text-xs py-0 ml-1">
                        {diagnostics.listingStatus}
                      </Badge>
                    </div>
                  )}
                  {diagnostics.listingStatusSource && (
                    <div>
                      <span className="text-muted-foreground">Status source:</span>
                      <span className="font-medium text-foreground ml-1">{diagnostics.listingStatusSource}</span>
                    </div>
                  )}
                  {diagnostics.listingStatusUpdatedAt && (
                    <div>
                      <span className="text-muted-foreground">Status last synced:</span>
                      <span className="font-medium text-foreground ml-1">{format(new Date(diagnostics.listingStatusUpdatedAt), "MMM d, HH:mm:ss")}</span>
                    </div>
                  )}
                  {(diagnostics.consecutiveZeroOffers ?? 0) > 0 ? (
                    <div>
                      <span className="text-muted-foreground">Verified zero-offers:</span>
                      <span className="font-medium text-destructive ml-1">{diagnostics.consecutiveZeroOffers}/5</span>
                      <span className="text-xs text-muted-foreground ml-1">(throttled responses excluded)</span>
                    </div>
                  ) : diagnostics.listingStatus === 'ACTIVE' ? (
                    <div>
                      <span className="text-muted-foreground">Zero-offer count:</span>
                      <span className="font-medium text-green-600 ml-1">0/5 ✓</span>
                    </div>
                  ) : null}
                  {diagnostics.buyboxStatus && (
                    <div>
                      <span className="text-muted-foreground">BB status:</span>
                      <Badge variant={diagnostics.buyboxStatus === 'owned' ? "default" : "outline"} className="text-xs py-0 ml-1">
                        {diagnostics.buyboxStatus}
                      </Badge>
                    </div>
                  )}
                  {diagnostics.buyboxSellerId && (
                    <div>
                      <span className="text-muted-foreground">BB seller:</span>
                      <span className="font-mono font-medium text-foreground ml-1 text-[10px]">{diagnostics.buyboxSellerId}</span>
                    </div>
                  )}
                  {diagnostics.lastSnapshotOffers != null && (
                    <div>
                      <span className="text-muted-foreground">Latest snapshot:</span>
                      <span className="font-medium text-foreground ml-1">
                        {diagnostics.lastSnapshotOffers} offers
                        {diagnostics.lastSnapshotAt && ` @ ${format(new Date(diagnostics.lastSnapshotAt), "HH:mm:ss")}`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        </div>{/* END LEFT PANEL */}

        {/* RIGHT PANEL — Action Log */}
        <div className="w-1/2 min-w-0 flex flex-col">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-muted-foreground">Action Log</h3>
            {activeRuleName && (
              <Badge className="bg-emerald-500/90 hover:bg-emerald-500 text-white border-0 text-xs font-bold px-2.5 py-0.5 shadow-sm shadow-emerald-500/25">
                🎯 {activeRuleName}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="action-log-simple-toggle" className="text-xs text-muted-foreground cursor-pointer">
              {simpleView ? "Simple" : "Detailed"}
            </Label>
            <Switch
              id="action-log-simple-toggle"
              checked={!simpleView}
              onCheckedChange={(checked) => toggleSimpleView(!checked)}
            />
          </div>
        </div>
        <ScrollArea className="flex-1 pr-4">
          {loading && priceActions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : priceActions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No price actions recorded for this ASIN</div>
          ) : (
            <div className="space-y-3">
              {priceActions.map((action) => {
                const safeguards = extractSafeguards(action.reason, action.intelligence_factors);
                
                return (
                  <div 
                    key={action.id} 
                    className={`p-3 rounded-lg border ${
                      !action.success 
                        ? "bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800" 
                        : "bg-muted/30"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(action.created_at), "MMM d, yyyy HH:mm:ss")}
                        </span>
                        <Badge variant={action.success ? "default" : "destructive"}>
                          {action.success ? <CheckCircle className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                          {action.success ? "Applied" : "Failed"}
                        </Badge>
                        <Badge variant="outline" className="text-xs">{humanizeTriggerSource(action.trigger_source)}</Badge>
                        {action.rule_name && (
                          <Badge variant="secondary" className="text-xs">{action.rule_name}</Badge>
                        )}
                        {/* Smart Match indicator — always visible (not gated to Detailed view) so it's
                            scannable at a glance which anchor-decided rows used the AI's own judgment
                            call, without needing to open the technical trace. */}
                        {action.intelligence_factors?.strategy_visibility?.profile_key === 'SMART_MATCH' && (
                          <Badge variant="outline" className="text-xs border-teal-500/40 text-teal-400 bg-teal-500/10">
                            🧭 Smart Match
                          </Badge>
                        )}
                        {/* Strategy Visibility — shows if strategy or override drove the decision (technical; Detailed view only) */}
                        {!simpleView && (() => {
                          const sv = action.intelligence_factors?.strategy_visibility;
                          if (!sv) return null;
                          return (
                            <>
                              <Badge variant="outline" className={`text-xs ${sv.strategy_influenced ? 'border-green-500/50 text-green-400' : 'border-amber-500/50 text-amber-400'}`}>
                                {sv.strategy_influenced ? '✔ Strategy' : `⚡ ${sv.dominant_layer}`}
                              </Badge>
                              {sv.profile_label && (
                                <Badge variant="outline" className="text-xs border-purple-500/30 text-purple-400">
                                  {sv.profile_label}
                                </Badge>
                              )}
                            </>
                          );
                        })()}
                        {/* Fulfillment Visibility — shows FBM vs FBA path (technical; Detailed view only) */}
                        {!simpleView && (() => {
                          const fv = action.intelligence_factors?.fulfillment_visibility;
                          if (!fv || fv.my_offer_type === 'unknown') return null;
                          const pathColors: Record<string, string> = {
                            'fba_vs_fba': 'border-blue-500/30 text-blue-400',
                            'fbm_vs_fba': 'border-orange-500/30 text-orange-400',
                            'fbm_vs_fbm': 'border-cyan-500/30 text-cyan-400',
                            'mixed_market': 'border-yellow-500/30 text-yellow-400',
                          };
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className={`text-xs ${pathColors[fv.fulfillment_mode_path] || 'border-muted-foreground/30 text-muted-foreground'}`}>
                                    {fv.my_offer_type === 'FBM' ? '📦 FBM' : '🏭 FBA'} → {fv.buybox_offer_type}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-xs">
                                  <div className="text-xs space-y-1">
                                    <div><strong>Path:</strong> {fv.fulfillment_mode_path}</div>
                                    <div><strong>My offer:</strong> {fv.my_offer_type}</div>
                                    <div><strong>BB holder:</strong> {fv.buybox_offer_type}</div>
                                    <div><strong>Anchor:</strong> {fv.anchor_offer_type}</div>
                                     {fv.fbm_adjustment_applied && (
                                       <div><strong>FBM adjustments:</strong> {fv.fbm_adjustment_reason}</div>
                                     )}
                                     {fv.would_fba_have_done && fv.would_fba_have_done !== 'same_as_fbm' && (
                                       <div className="border-t border-muted-foreground/20 pt-1 mt-1">
                                         <strong>If FBA:</strong> {fv.would_fba_have_done.replace(/_/g, ' ')}
                                       </div>
                                     )}
                                   </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        {safeguards.map((sg, idx) => (
                          <SafeguardBadge key={idx} type={sg} />
                        ))}
                      </div>
                    </div>
                    
                    {/* Plain-English summary — always shown, this is the primary explanation for regular users */}
                    <div className="text-sm text-foreground bg-muted/50 rounded px-2 py-1 mb-2">
                      {buildPlainSummary(action, marketplace)}
                    </div>

                    {/* Technical trace — raw guard codes, anchor/undercut math (Detailed view only) */}
                    {!simpleView && (
                      <div className="text-sm italic text-muted-foreground bg-muted/50 rounded px-2 py-1 mb-2 font-mono">
                        {buildExplainLine(action)}
                      </div>
                    )}

                    {/* Hide Price/Min/Max grid for priority_eval with no changes */}
                    {action.action_type !== 'priority_eval' && (
                    <div className="grid grid-cols-3 gap-4 text-sm mb-2">
                      <div>
                        <span className="text-muted-foreground">Price:</span>
                        <div className="flex items-center gap-1">
                          <span>{formatCurrency(action.old_price)}</span>
                          {action.new_price != null && action.old_price != null && (
                            <>
                              <span>→</span>
                              <span className={action.new_price > action.old_price ? "text-green-600" : action.new_price < action.old_price ? "text-red-600" : ""}>
                                {formatCurrency(action.new_price)}
                              </span>
                              {action.new_price > action.old_price ? (
                                <ArrowUp className="h-3 w-3 text-green-600" />
                              ) : action.new_price < action.old_price ? (
                                <ArrowDown className="h-3 w-3 text-red-600" />
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Min:</span>
                        <div>
                          {action.new_min_price != null ? (
                            <span>{formatCurrency(action.old_min_price)} → {formatCurrency(action.new_min_price)}</span>
                          ) : (
                            <span>{formatCurrency(action.old_min_price)}</span>
                          )}
                        </div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Max:</span>
                        <div>
                          {action.new_max_price != null ? (
                            <span>{formatCurrency(action.old_max_price)} → {formatCurrency(action.new_max_price)}</span>
                          ) : (
                            <span>{formatCurrency(action.old_max_price)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    )}
                    
                    {/* Raw reason text — this is the same jargon buildPlainSummary already translates above, so only show it in Detailed view */}
                    {!simpleView && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Reason:</span>
                        <p className="text-foreground">
                          {action.action_type === 'priority_eval'
                            ? humanizePriorityEval(action.reason)
                            : (action.reason || "—")}
                        </p>
                      </div>
                    )}

                    {/* Structured Reason Codes (Detailed view only) */}
                    {!simpleView && action.intelligence_factors?.reason_codes && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <Badge variant="outline" className="text-xs font-mono">
                          anchor: {action.intelligence_factors.reason_codes.anchor_source}
                        </Badge>
                        <Badge variant={
                          action.intelligence_factors.reason_codes.offers_status === 'ok' ? 'default' :
                          action.intelligence_factors.reason_codes.offers_status === 'quota_exceeded' ? 'destructive' :
                          'secondary'
                        } className="text-xs font-mono">
                          offers: {action.intelligence_factors.reason_codes.offers_status}
                        </Badge>
                        <Badge variant="outline" className={`text-xs font-mono ${
                          action.intelligence_factors.reason_codes.bb_confidence === 'high' ? 'border-green-500 text-green-700 dark:text-green-400' :
                          action.intelligence_factors.reason_codes.bb_confidence === 'medium' ? 'border-yellow-500 text-yellow-700 dark:text-yellow-400' :
                          'border-red-500 text-red-700 dark:text-red-400'
                        }`}>
                          bb: {action.intelligence_factors.reason_codes.bb_confidence}
                        </Badge>
                        {(action.intelligence_factors.reason_codes.filters_applied || []).map((f: string, idx: number) => (
                          <Badge key={idx} variant="secondary" className="text-xs font-mono">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    )}
                    
                    {action.error_message && (
                      <div className="text-sm mt-2 text-destructive">
                        <span className="font-medium">Error:</span> {translateErrorMessage(action.error_message)}
                      </div>
                    )}

                    {/* Smart Min Price Suggestion Card */}
                    {action.min_price_suggestion && action.min_price_suggestion.suggested_min ? (
                      action.id === latestAction?.id ? (
                        <div className="mt-2 p-3 rounded-lg border border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2">
                              <Lightbulb className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                              <div className="text-sm">
                                <p className="font-medium text-amber-800 dark:text-amber-300">
                                  💡 Smart Suggestion: {action.min_price_suggestion.current_min ? 'Lower Min Price' : 'Set Min Price'}
                                </p>
                                {action.min_price_suggestion.current_min ? (
                                  <p className="text-muted-foreground mt-0.5">
                                    Your min <span className="font-mono font-medium">{formatCurrency(action.min_price_suggestion.current_min)}</span> is{' '}
                                    <span className="font-medium text-amber-700 dark:text-amber-400">
                                      ${(action.min_price_suggestion.gap_amount || 0).toFixed(2)} ({(action.min_price_suggestion.gap_percent || 0).toFixed(1)}%)
                                    </span>{' '}
                                    above the competitive price <span className="font-mono">{formatCurrency(action.min_price_suggestion.competitive_price)}</span>.
                                  </p>
                                ) : (
                                  <p className="text-muted-foreground mt-0.5">
                                    No min price set. The effective floor{' '}
                                    <span className="font-mono font-medium">{formatCurrency(action.min_price_suggestion.effective_floor)}</span>{' '}
                                    is blocking a lower competitive price of{' '}
                                    <span className="font-mono">{formatCurrency(action.min_price_suggestion.competitive_price)}</span>.
                                    Setting a min will give the repricer more room.
                                  </p>
                                )}
                                <p className="text-muted-foreground text-xs mt-1">
                                  Suggested {action.min_price_suggestion.current_min ? 'new' : ''} min: <span className="font-mono font-bold">{formatCurrency(action.min_price_suggestion.suggested_min)}</span>
                                  {action.min_price_suggestion.projected_roi != null && (
                                    <span className={`ml-2 font-medium ${action.min_price_suggestion.projected_roi >= 0 ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
                                      (ROI: {action.min_price_suggestion.projected_roi.toFixed(1)}%
                                      {action.min_price_suggestion.unit_cost != null && (
                                        <span className="text-muted-foreground font-normal"> · cost {formatCurrency(action.min_price_suggestion.unit_cost)}</span>
                                      )}
                                      )
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="shrink-0 border-amber-500 text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-950"
                              onClick={() => handleAcceptMinSuggestion(action.min_price_suggestion!)}
                              disabled={acceptingMin === action.asin}
                            >
                              {acceptingMin === action.asin ? (
                                <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                              ) : null}
                              Accept
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 p-2 rounded-lg border border-muted bg-muted/30 flex items-center gap-2">
                          <Lightbulb className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-xs text-muted-foreground">Historical suggestion superseded by a newer evaluation — only the latest run can be accepted.</span>
                        </div>
                      )
                    ) : (
                      <div className="mt-2 p-2 rounded-lg border border-muted bg-muted/30 flex items-center gap-2">
                        <Lightbulb className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-xs text-muted-foreground">No suggested minimum — price is within competitive range or no floor constraint detected.</span>
                      </div>
                    )}
                    
                    {!simpleView && action.intelligence_factors && Object.keys(action.intelligence_factors).length > 0 && (
                      <EvalDiagnosticsPanels factors={action.intelligence_factors} marketplace={marketplace} livePrice={diagnostics.myPrice ?? null} />
                    )}
                  </div>
                );
              })}
              {hasMoreActions && (
                <div className="flex justify-center pt-1 pb-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={loadingMore}
                    onClick={loadMoreActions}
                  >
                    {loadingMore ? "Loading…" : "Load more history"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
        </div>{/* END RIGHT PANEL */}
        </div>{/* END SPLIT LAYOUT */}
      </DialogContent>
    </Dialog>
  );
}
