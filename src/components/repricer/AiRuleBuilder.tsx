import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Sparkles, Zap, TrendingUp, Shield, Info, Star, DollarSign, ArrowUp, Eye, EyeOff, AlertTriangle, Play, Loader2, Lock } from "lucide-react";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { toast } from "sonner";

// Behavior-by-scenario (when_only_seller, when_buybox_suppressed, etc.) used to
// be user-configurable here, but every existing rule uses the same recommended
// values (CUSTOM_PRICE / AI_REPRICE / MIN_PRICE per scenario — verified across
// all rules) and the dropdowns were already admin-only and disabled, so the
// section was removed. The recommended values are still saved for every rule
// via the hardcoded fallbacks in RuleBuilder.tsx's save logic.

export type SmartProfile = 'VELOCITY_DOMINATOR' | 'MOMENTUM_BUILDER' | 'PROFIT_EXTRACTOR' | 'MATCH_BUYBOX' | 'MATCH_LOWEST' | 'SMART_MATCH' | 'MOMENTUM_SMART';

// Profiles hidden by default (advanced/high-risk) — unlockable via toggle
const ADVANCED_PROFILES: SmartProfile[] = ['VELOCITY_DOMINATOR'];
const DEFAULT_PROFILES: SmartProfile[] = ['MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR', 'MATCH_BUYBOX', 'MATCH_LOWEST', 'SMART_MATCH', 'MOMENTUM_SMART'];

// Behavior metrics per profile for the summary card
const PROFILE_BEHAVIOR: Record<SmartProfile, { salesSpeed: number; marginProtection: number; raiseAggression: number; bbDefense: number; riskLevel: number; tags: string[] }> = {
  VELOCITY_DOMINATOR: { salesSpeed: 5, marginProtection: 1, raiseAggression: 0, bbDefense: 0, riskLevel: 9, tags: ['Clearance', 'Rank building', 'Cash flow'] },
  MOMENTUM_BUILDER: { salesSpeed: 4, marginProtection: 3, raiseAggression: 3, bbDefense: 3, riskLevel: 4, tags: ['OA / Arbitrage', 'Competitive wholesale', 'Growth phase'] },
  PROFIT_EXTRACTOR: { salesSpeed: 2, marginProtection: 5, raiseAggression: 5, bbDefense: 3, riskLevel: 8, tags: ['Private label', 'Low competition', 'Ceiling discovery'] },
  MATCH_BUYBOX: { salesSpeed: 3, marginProtection: 4, raiseAggression: 0, bbDefense: 3, riskLevel: 2, tags: ['Predictable pricing', 'No undercutting', 'Buy Box parity'] },
  MATCH_LOWEST: { salesSpeed: 4, marginProtection: 3, raiseAggression: 0, bbDefense: 3, riskLevel: 3, tags: ['Predictable pricing', 'No undercutting', 'Lowest-offer parity'] },
  SMART_MATCH: { salesSpeed: 4, marginProtection: 4, raiseAggression: 0, bbDefense: 4, riskLevel: 2, tags: ['Predictable pricing', 'No undercutting', 'Buy Box recapture'] },
  // Fast defense (8min baseline) like Smart Match, opportunistic raise like
  // Momentum Builder gated to only fire on market-confirmed moves — bbDefense
  // and raiseAggression both sit a notch above Smart Match's pure-defense 4/0.
  MOMENTUM_SMART: { salesSpeed: 4, marginProtection: 4, raiseAggression: 2, bbDefense: 5, riskLevel: 3, tags: ['Contested + occasionally uncontested', 'Hybrid strategy', 'Adaptive'] },
};

export const SMART_PROFILES: { value: SmartProfile; label: string; description: string; bestFor: string; salesStars: number; profitStars: number; icon: string; recommended?: boolean; advanced?: boolean; badge?: string; badgeColor?: string; microLabel?: string; keyDiff?: string; legacy?: boolean; safetyScore?: number; salesImpactLabel?: string; salesImpactDesc?: string; salesImpactLevel?: 'strong' | 'balanced' | 'lower' | 'clearance'; undercutNote?: string }[] = [
  { value: 'VELOCITY_DOMINATOR', label: 'Aggressive Capture', description: 'Win more often with lower profit per sale.', bestFor: 'Heavy competition & fast-moving items', salesStars: 5, profitStars: 1, icon: '🚀', safetyScore: 3, salesImpactLabel: 'Strong Sales', salesImpactDesc: 'Wins the Buy Box often, but may reduce profit', salesImpactLevel: 'strong', microLabel: 'Get more sales fast' },
  // salesStars/profitStars corrected from 4/2 — the old numbers made this look
  // more sales-leaning than profit-leaning, which contradicted its own "protecting
  // your margins" description and didn't sit as a real midpoint between Aggressive
  // Capture (5/1) and Profit Extractor (1/5). It never undercuts (same $0.00 floor
  // as the three Match presets) and raises fairly aggressively (1.5% trigger, $1.00
  // step) — 3 sales / 4 profit reflects that correctly.
  { value: 'MOMENTUM_BUILDER', label: 'Momentum Builder', description: 'Stay competitive while protecting your margins.', bestFor: 'Arbitrage, wholesale, most products', salesStars: 3, profitStars: 4, icon: '📈', safetyScore: 7, salesImpactLabel: 'Strong Sales', salesImpactDesc: 'Wins the Buy Box often while keeping strong sales volume', salesImpactLevel: 'strong', microLabel: 'Best balance of sales and profit',
    undercutNote: '$0.00 only applies to lowering your price — it never undercuts. See Raise Trigger below for how this preset actively moves your price up when you’re winning.' },
  { value: 'PROFIT_EXTRACTOR', label: 'Profit Extractor', description: 'Raises prices to capture more profit, but may reduce sales.', bestFor: 'Private label & exclusive products', salesStars: 1, profitStars: 5, icon: '🏆', safetyScore: 7, salesImpactLabel: 'Lower Sales', salesImpactDesc: 'May lose Buy Box and reduce sales if prices increase', salesImpactLevel: 'lower', microLabel: 'Maximize profit when competition is low',
    undercutNote: '$0.00 only applies to lowering your price — it never undercuts. See Raise Trigger below: this preset raises the most aggressively of all six presets when conditions allow.' },
  { value: 'MATCH_BUYBOX', label: 'Match Buy Box', description: 'Sets your price exactly at the Buy Box price — never below it, never above it.', bestFor: 'When you just want price parity, not a price war', salesStars: 3, profitStars: 4, icon: '🎯', safetyScore: 8, salesImpactLabel: 'Balanced Sales', salesImpactDesc: 'Matches the Buy Box exactly — competitive without racing to the bottom', salesImpactLevel: 'balanced', microLabel: 'Match the Buy Box, nothing more' },
  { value: 'MATCH_LOWEST', label: 'Match Lowest', description: 'Sets your price exactly at the lowest competitor offer — never below it, never above it.', bestFor: 'Staying at parity with the cheapest seller without undercutting', salesStars: 4, profitStars: 3, icon: '⚖️', safetyScore: 7, salesImpactLabel: 'Strong Sales', salesImpactDesc: 'Tracks the lowest offer exactly — stays competitive without a price war', salesImpactLevel: 'strong', microLabel: 'Match the lowest price, nothing more' },
  // profitStars corrected from 4 — Smart Match behaves like Match Buy Box (profit 4)
  // when it already holds the Buy Box, but drops to matching Lowest FBA (profit 3,
  // same margin tradeoff as Match Lowest) whenever it's recapturing. 3 reflects the
  // blended reality rather than only the best-case half of its behavior.
  { value: 'SMART_MATCH', label: 'Smart Match', description: 'Matches the Buy Box when you already have it, switches to matching the lowest FBA seller when you don’t — never undercuts either way.', bestFor: 'When you want the right anchor picked for you, without chasing a price war', salesStars: 4, profitStars: 3, icon: '🧭', safetyScore: 8, salesImpactLabel: 'Balanced Sales', salesImpactDesc: 'Recaptures the Buy Box when you lose it, holds position when you already have it', salesImpactLevel: 'balanced', microLabel: 'Match whichever price is right, automatically' },
  // Hybrid: Smart Match's fast, asymmetric defense (react in ~8min while
  // losing the Buy Box, ~20min while holding it — no reason to disturb a
  // profitable position) plus Momentum Builder's opportunistic raise, but
  // gated so a raise only fires when the competitor floor confirms the
  // market actually moved, not just the Buy Box price drifting alone.
  { value: 'MOMENTUM_SMART', label: 'Momentum Smart', description: 'Defends the Buy Box fast like Smart Match, raises price only when competitors confirm the move like Momentum Builder.', bestFor: 'Listings that swing between contested and uncontested — one rule for both', salesStars: 4, profitStars: 4, icon: '⚡', safetyScore: 8, salesImpactLabel: 'Strong Sales', salesImpactDesc: 'Fast Buy Box recovery when contested, cautious margin capture when the market gives room', salesImpactLevel: 'strong', microLabel: 'Defend aggressively, raise cautiously',
    undercutNote: '$0.00 — never undercuts. Reacts in ~8 min while losing the Buy Box, ~20 min while holding it, and only raises price when the competitor floor rose too, not just the Buy Box price.' },
];

// Profile key → UI label mapping (canonical source of truth)
export const PROFILE_KEY_TO_LABEL: Record<string, string> = {
  VELOCITY_DOMINATOR: 'Aggressive Capture',
  MOMENTUM_BUILDER: 'Momentum Builder',
  PROFIT_EXTRACTOR: 'Profit Extractor',
  MATCH_BUYBOX: 'Match Buy Box',
  MATCH_LOWEST: 'Match Lowest',
  SMART_MATCH: 'Smart Match',
  MOMENTUM_SMART: 'Momentum Smart',
};

// Profile preset configurations - these override specific settings
export const PROFILE_PRESETS: Record<SmartProfile, Partial<AiRuleSettings>> = {
  VELOCITY_DOMINATOR: {
    undercut_amount: 0.02,
    enable_smart_raise: true,        // ← Was false. Limited raise to recover margin after winning.
    // Matches Momentum Builder — Smart Price Protection is now uniform
    // across all profiles (every real rule already converged on these
    // values in practice, and the UI no longer exposes them per-profile).
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 5,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    raise_trigger_percent: 3,        // ← Modest raise trigger (was never used before)
    max_raise_step_dollars: 0.30,    // ← Small raise caps to keep it aggressive-first
    max_raise_step_percent: 2,
    // Chase the absolute cheapest offer (FBA + FBM) — matches this profile's
    // whole purpose of maximizing Buy Box wins over margin per sale.
    target_anchor: 'lowest_offer',
  },
  MOMENTUM_BUILDER: {
    // 0.00 — undercut_amount is now the sole source of truth for undercutting
    // behavior (Strict Match Mode was removed as a separate flag). Zero means
    // "match exactly, never undercut," which is Momentum Builder's intended
    // identity, expressed directly through this number.
    undercut_amount: 0.00,
    enable_smart_raise: true,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 1.00,
    max_raise_step_percent: 5,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 15,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    // Hold position when already lowest, switch to chasing the lowest FBA
    // seller when undercut — the balanced/recapture behavior this profile
    // is built around.
    target_anchor: 'smart_recapture',
  },
  PROFIT_EXTRACTOR: {
    // 0.00 — same reasoning as Momentum Builder: match exactly via the
    // undercut number itself, no separate mode flag needed.
    undercut_amount: 0.00,
    enable_smart_raise: true,
    raise_trigger_percent: 1,
    max_raise_step_dollars: 1.50,
    max_raise_step_percent: 6,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'aggressive',
    monopoly_cooldown_minutes: 45,
    use_ai_tuning: true,
    cooldown_minutes: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    // Anchor to Buy Box price — no reason to chase the cheapest offer when
    // the goal is capturing margin in a low-competition category.
    target_anchor: 'buybox',
  },
  // Pure "match, never chase" presets — no monopoly mode, no opportunistic
  // smart-raise, no extended cooldown (unlike Profit Extractor, which shares
  // the same undercut_amount=0 identity but bundles those extras on top).
  // undercut_amount=0 alone already puts these in the engine's matchExactly
  // path, which settles cleanly at the anchor in both directions without
  // fighting the cooldown guards that only throttle undercut_amount>0 rules.
  MATCH_BUYBOX: {
    undercut_amount: 0.00,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    // Anchor to Buy Box price specifically — never the wider lowest-offer field.
    target_anchor: 'buybox',
  },
  MATCH_LOWEST: {
    undercut_amount: 0.00,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    // Anchor to the absolute cheapest eligible offer (FBA + FBM), not just BB.
    target_anchor: 'lowest_offer',
  },
  // SMART_MATCH: same pure "match, never chase" identity as MATCH_BUYBOX/
  // MATCH_LOWEST (no monopoly mode, no opportunistic smart-raise), but with
  // target_anchor='smart_recapture' instead of a fixed anchor — hold at Buy
  // Box when already the BB owner or already lowest, switch to matching
  // Lowest FBA when losing the Buy Box. This is the same anchor Momentum
  // Builder uses, minus the raise/monopoly behavior layered on top there.
  SMART_MATCH: {
    undercut_amount: 0.00,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    target_anchor: 'smart_recapture',
  },
  // MOMENTUM_SMART: hybrid of MOMENTUM_BUILDER (raise intelligence) and
  // SMART_MATCH (fast, low-risk recovery). Deliberately asymmetric, not a
  // single interpolated cooldown — fast (8min baseline) while losing the
  // Buy Box, slow (20min) while holding it. require_market_supported_raise
  // gates the raise: only fires when the competitor floor, not just the Buy
  // Box price, also rose. Kept in exact sync with the backend copy in
  // repricer-ai-evaluate/_presets.ts (both written together, unlike the
  // other presets here which have historically drifted from their backend
  // counterparts — see that file's header comment).
  // V2: tightened after real Rule Performance data (5/43 raises lost BB vs
  // Momentum Builder's 0/175 over the same window) — see backend _presets.ts
  // for the full writeup, kept in sync here deliberately.
  MOMENTUM_SMART: {
    undercut_amount: 0.00,
    enable_smart_raise: true,
    require_market_supported_raise: true,
    min_floor_support_ratio: 0.5,
    post_raise_cooldown_hours: 2,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 0.75,
    max_raise_step_percent: 4,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    cooldown_minutes_losing_bb: 8,
    cooldown_minutes_winning_bb: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
    target_anchor: 'smart_recapture',
  },
};

export interface AiRuleSettings {
  // Smart Engine Profile
  smart_profile: SmartProfile;
  // Scenario behaviors
  when_only_seller: string;
  when_not_buybox_eligible: string;
  when_buybox_suppressed: string;
  when_condition_used: string;
  when_backordered: string;
  when_below_min_price: string;
  // Competition settings
  compete_with_amazon: boolean;
  compete_with_fba: boolean;
  compete_with_fbm: boolean;
  fulfillment_filter: "FBA" | "FBM" | "BOTH"; // New dropdown field
  // Price limits
  min_price: number | null;
  max_price: number | null;
  undercut_amount: number;
  fbm_undercut_amount?: number | null;
  suppressed_bb_undercut: number | null;
  undercut_mode: 'managed' | 'custom';
  // Safety guards
  max_step_amount: number;
  max_step_percent: number;
  cooldown_minutes: number;
  // MOMENTUM_SMART asymmetric cooldown — optional, only set by that preset.
  // undefined/null means "use cooldown_minutes for every tier" (every other
  // preset's existing behavior, unchanged).
  cooldown_minutes_losing_bb?: number | null;
  cooldown_minutes_winning_bb?: number | null;
  require_market_supported_raise?: boolean;
  min_floor_support_ratio?: number | null;
  post_raise_cooldown_hours?: number | null;
  // AI tuning
  use_ai_tuning: boolean;
  // Profit Guard settings
  enable_profit_guard: boolean;
  min_profit_dollars: number | null;
  min_roi_percent: number | null;
  min_roi_percent_base: number | null;
  min_roi_percent_high_risk: number | null;
  high_risk_seller_count_threshold: number;
  enable_dynamic_roi: boolean;
  include_fees_in_floor: boolean;
  block_auto_apply_if_cost_missing: boolean;
  profit_guard_mode: 'strict' | 'respect_min_max' | 'off';
  // Auto-Exit/Reenter settings
  enable_auto_exit_reenter: boolean;
  reenter_buffer_percent: number;
  cooldown_minutes_on_floor: number;
  max_drop_per_run_cents: number;
  // Snapshot TTL (cost control)
  snapshot_ttl_minutes: number;
  // Smart Raise settings
  enable_smart_raise: boolean;
  raise_trigger_percent: number;
  max_raise_step_dollars: number;
  max_raise_step_percent: number;
  only_raise_when_buybox_owner: boolean;
  // Buy Box Owner Protection
  skip_lower_when_bb_owner: boolean;
  // Monopoly Mode - proactive price raising when only FBA
  enable_monopoly_mode: boolean;
  monopoly_raise_step_dollars: number;
  monopoly_raise_step_percent: number;
  monopoly_cooldown_minutes: number;
  monopoly_mode_type: 'conservative' | 'aggressive';
  // FBM Handling
  ignore_fbm_unless_buybox_owner: boolean;
  fbm_competition_mode?: 'fba_priority' | 'all_sellers' | 'lowest_seller';
  // Target Price Anchor
  target_anchor: 'buybox' | 'lowest_fba' | 'lowest_offer' | 'smart' | 'smart_recapture';
  // Competitor Quality Filtering (NEW - beats BQool)
  min_seller_rating: number;
  max_handling_days: number;
  ships_from_filter: 'US_ONLY' | 'DOMESTIC' | 'ANY';
  top_n_competitors: number;
  competitor_quality_preset: 'conservative' | 'balanced' | 'aggressive' | 'custom';
  // Stock-Aware Aggression Overlay
  stock_overlay_enabled: boolean;
  velocity_weight_7d: number;
  velocity_weight_30d: number;
  stock_threshold_critical: number;
  stock_threshold_low: number;
  stock_threshold_healthy_max: number;
  stock_threshold_heavy: number;
  stock_modifier_critical: number;
  stock_modifier_low: number;
  stock_modifier_normal: number;
  stock_modifier_heavy: number;
  stock_modifier_overstock: number;
  // Oscillation Handling
  oscillation_mode: 'auto' | 'safe' | 'balanced' | 'aggressive';
  oscillation_ai_style?: 'conservative' | 'balanced' | 'aggressive';
  oscillation_cooldown_minutes: number;
  oscillation_max_reactions: number;
  oscillation_bb_loss_limit: number;
  // Auto Floor (per-rule)
  enable_auto_floor: boolean;
  // Price War Protection — delay auto-floor activation
  war_protection_minutes: number;
  // Min ROI Protection — optional user-facing ROI floor.
  // min_roi_enabled is the legacy global on/off switch, kept only as a
  // fallback for marketplaces that don't yet have their own entry in
  // min_roi_enabled_marketplace_overrides (per-marketplace on/off).
  min_roi_enabled: boolean;
  min_roi_enabled_marketplace_overrides: Record<string, boolean>;
  min_roi_marketplace_overrides: Record<string, number>;
  // Strategy Engine — Dynamic Floor Relaxation (Milestone B). Default OFF.
  enable_dynamic_floor_relaxation?: boolean;
}

interface AiRuleBuilderProps {
  settings: AiRuleSettings;
  onChange: (settings: AiRuleSettings) => void;
  hideProfileSelector?: boolean;
  ruleId?: string | null;
  isCustomRule?: boolean;
}

export const defaultAiRuleSettings: AiRuleSettings = {
  smart_profile: 'MOMENTUM_BUILDER',
  when_only_seller: "CUSTOM_PRICE",
  when_not_buybox_eligible: "CUSTOM_PRICE",
  when_buybox_suppressed: "AI_REPRICE",
  when_condition_used: "AI_REPRICE",
  when_backordered: "MIN_PRICE",
  when_below_min_price: "MIN_PRICE",
  compete_with_amazon: false,
  compete_with_fba: true,
  compete_with_fbm: false,
  fulfillment_filter: "FBA", // Default to FBA
  min_price: null,
  max_price: null,
  // 0.00 — matches the default smart_profile (Momentum Builder): match
  // exactly, never undercut, expressed via the number itself.
  undercut_amount: 0.00,
  fbm_undercut_amount: null,
  suppressed_bb_undercut: null,
  undercut_mode: 'managed',
  max_step_amount: 0.50,
  max_step_percent: 5,
  cooldown_minutes: 15,
  use_ai_tuning: true,
  // Profit Guard defaults — always enabled, Respect Min/Max
  enable_profit_guard: true,
  min_profit_dollars: null,
  min_roi_percent: null,
  min_roi_percent_base: 20,
  min_roi_percent_high_risk: 35,
  high_risk_seller_count_threshold: 8,
  enable_dynamic_roi: false,
  include_fees_in_floor: true,
  block_auto_apply_if_cost_missing: true,
  profit_guard_mode: 'respect_min_max',
  // Auto-Exit/Reenter defaults — OFF (tied to Profit Guard)
  enable_auto_exit_reenter: false,
  reenter_buffer_percent: 2,
  cooldown_minutes_on_floor: 360, // 6 hours
  max_drop_per_run_cents: 30, // $0.30
  // Snapshot TTL default (6 hours = 360 min)
  snapshot_ttl_minutes: 360,
  // Smart Raise defaults
  enable_smart_raise: true,
  raise_trigger_percent: 2,
  max_raise_step_dollars: 0.25,
  max_raise_step_percent: 2,
  only_raise_when_buybox_owner: true,
  // Buy Box Owner Protection - ON by default to preserve margin
  skip_lower_when_bb_owner: true,
  // Monopoly Mode - proactive price raising when only FBA
  enable_monopoly_mode: true, // ON by default - profit-seeking automation
  monopoly_raise_step_dollars: 0.10,
  monopoly_raise_step_percent: 1,
  monopoly_cooldown_minutes: 60, // 1 hour between raises
  monopoly_mode_type: 'conservative', // Start conservative
  // FBM Handling - FBA Priority by default (ignore FBM unless they own the Buy Box)
  ignore_fbm_unless_buybox_owner: true,
  fbm_competition_mode: 'fba_priority',
  // Target Price Anchor
  target_anchor: 'smart_recapture' as const, // Smart + Lowest FBA Recapture by default
  // Competitor Quality Filtering - clean inputs, eliminate noise (beats BQool)
  min_seller_rating: 80, // Ignore sellers with <80% rating
  max_handling_days: 2, // Ignore slow shippers (>2 days)
  ships_from_filter: 'ANY', // US_ONLY, DOMESTIC, or ANY
  top_n_competitors: 8, // Only consider top 8 competitors (like BQool)
  competitor_quality_preset: 'balanced',
  // Stock-Aware Aggression Overlay — OFF by default
  stock_overlay_enabled: true,
  velocity_weight_7d: 0.6,
  velocity_weight_30d: 0.4,
  stock_threshold_critical: 7,
  stock_threshold_low: 30,
  stock_threshold_healthy_max: 90,
  stock_threshold_heavy: 180,
  stock_modifier_critical: 0.75,
  stock_modifier_low: 0.85,
  stock_modifier_normal: 1.0,
  stock_modifier_heavy: 1.10,
  stock_modifier_overstock: 1.30,
  // Oscillation Handling — Auto (AI) by default
  oscillation_mode: 'auto',
  oscillation_ai_style: 'balanced',
  oscillation_cooldown_minutes: 20,
  oscillation_max_reactions: 0,
  oscillation_bb_loss_limit: 1,
  // Auto Floor — ON by default
  enable_auto_floor: true,
  // Price War Protection — 30 min delay by default
  war_protection_minutes: 30,
  // Min ROI Protection — OFF by default
  min_roi_enabled: false,
  min_roi_enabled_marketplace_overrides: {},
  min_roi_marketplace_overrides: {},
};

// A setting the active smart_profile controls directly — shown as a locked,
// read-only value instead of a live control, since editing it while a named
// preset is active has no effect (the preset silently re-applies its own
// value on every evaluation). Only visible when smart_profile !== CUSTOM.
function LockedSetting({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-dashed border-muted-foreground/30">
      <div className="space-y-0.5">
        <p className="text-sm font-medium flex items-center gap-1.5 text-muted-foreground">
          <Lock className="h-3 w-3" />
          {label}
        </p>
        {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
      </div>
      <span className="text-sm font-medium text-muted-foreground">{value}</span>
    </div>
  );
}

export default function AiRuleBuilder({ settings, onChange, hideProfileSelector, ruleId, isCustomRule }: AiRuleBuilderProps) {
  const { homeCurrencySymbol } = useHomeMarketplace();
  // Custom rules start fully expanded — "full control over every setting"
  // is the whole point, so there's no reason to make an admin click
  // "Show Advanced Settings" first. The 3 Smart Profiles still default
  // collapsed, unaffected by this.
  const [advancedMode, setAdvancedMode] = useState(!!isCustomRule);
  const [isAdmin, setIsAdmin] = useState(false);
  const [connectedMarketplaces, setConnectedMarketplaces] = useState<string[]>(["US"]);
  const [applyingMarketplace, setApplyingMarketplace] = useState<string | null>(null);
  const [showAdvancedStrategies, setShowAdvancedStrategies] = useState(() => {
    try { return localStorage.getItem('repricer_advanced_strategies') === 'true'; } catch { return false; }
  });
  const [showAdvancedWarning, setShowAdvancedWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      // Fetch admin role and connected marketplaces in parallel
      const [roleRes, authRes] = await Promise.all([
        supabase.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle(),
        supabase.from('seller_authorizations').select('marketplace_id').eq('user_id', user.id),
      ]);
      if (cancelled) return;
      setIsAdmin(!!roleRes.data);
      if (authRes.data && authRes.data.length > 0) {
        const { getMarketplaceFromId, NA_MARKETPLACES } = await import("@/lib/marketplaceCurrency");
        const directCodes = [...new Set(authRes.data.map((d: any) => getMarketplaceFromId(d.marketplace_id)))];
        const hasNA = directCodes.some(c => NA_MARKETPLACES.includes(c));
        const expanded = hasNA ? [...new Set([...directCodes, ...NA_MARKETPLACES])] : directCodes;
        const ordered = ["US", "CA", "MX", "BR"].filter(mp => expanded.includes(mp));
        if (!cancelled) setConnectedMarketplaces(ordered.length > 0 ? ordered : ["US"]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleApplyMinRoi = useCallback(async (marketplace: string) => {
    if (!ruleId) {
      toast.error("Save the rule first before applying ROI");
      return;
    }
    const roiValue = settings.min_roi_marketplace_overrides?.[marketplace];
    if (roiValue == null) {
      toast.error(`Set a ROI % for ${marketplace} first`);
      return;
    }
    setApplyingMarketplace(marketplace);
    try {
      const { data, error } = await supabase.functions.invoke('apply-min-roi', {
        body: { rule_id: ruleId, marketplace, min_roi_percent: roiValue },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const protectedCount = (data.results || []).filter((r: any) => r.reason === 'manual_floor_protected').length;
      const skipMsg = data.skipped > 0 ? `, ${data.skipped} skipped` : '';
      const protectMsg = protectedCount > 0 ? ` (${protectedCount} kept manual min)` : '';
      toast.success(`${marketplace}: Updated ${data.updated} assignments${skipMsg}${protectMsg}`);
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setApplyingMarketplace(null);
    }
  }, [ruleId, settings.min_roi_marketplace_overrides]);

  const updateSetting = <K extends keyof AiRuleSettings>(
    key: K,
    value: AiRuleSettings[K]
  ) => {
    onChange({ ...settings, [key]: value });
  };

  // "Respect minimum ROI" is now toggled per marketplace. A marketplace with
  // no explicit entry yet falls back to the legacy global min_roi_enabled,
  // so existing rules keep working exactly as before until touched here.
  const isRoiEnabledForMarketplace = (mp: string): boolean => {
    const overrides = settings.min_roi_enabled_marketplace_overrides || {};
    if (Object.prototype.hasOwnProperty.call(overrides, mp)) return overrides[mp];
    return settings.min_roi_enabled ?? false;
  };

  const setRoiEnabledForMarketplace = (mp: string, enabled: boolean) => {
    const overrides = { ...(settings.min_roi_enabled_marketplace_overrides || {}), [mp]: enabled };
    onChange({ ...settings, min_roi_enabled_marketplace_overrides: overrides });
  };

  const handleProfileChange = (profileValue: SmartProfile) => {
    const preset = PROFILE_PRESETS[profileValue];
    onChange({ ...settings, ...preset, smart_profile: profileValue });
  };

  const handleToggleAdvancedStrategies = (enabled: boolean) => {
    if (enabled) {
      setShowAdvancedWarning(true);
    } else {
      setShowAdvancedStrategies(false);
      localStorage.setItem('repricer_advanced_strategies', 'false');
      // If current profile is advanced, switch to Momentum Builder
      if (ADVANCED_PROFILES.includes(settings.smart_profile)) {
        handleProfileChange('MOMENTUM_BUILDER');
      }
    }
  };

  const confirmAdvancedStrategies = () => {
    setShowAdvancedStrategies(true);
    localStorage.setItem('repricer_advanced_strategies', 'true');
    setShowAdvancedWarning(false);
  };

  // Filter visible profiles: show default + advanced if enabled + always show current if it's advanced (legacy)
  const visibleProfiles = SMART_PROFILES.filter(p => {
    // Never show legacy profiles in the selector (they are deprecated)
    if (p.legacy) {
      // Exception: show if currently selected (existing rule)
      return settings.smart_profile === p.value;
    }
    if (DEFAULT_PROFILES.includes(p.value)) return true;
    if (showAdvancedStrategies) return true;
    // Legacy: show if currently selected (existing rule)
    if (settings.smart_profile === p.value) return true;
    return false;
  });

  const isLegacyProfile = ADVANCED_PROFILES.includes(settings.smart_profile) && !showAdvancedStrategies;

  const activeProfile = SMART_PROFILES.find(p => p.value === settings.smart_profile) || SMART_PROFILES.find(p => p.value === 'MOMENTUM_BUILDER')!;

  // When a named profile is active, it silently re-applies all of its own
  // field values on every evaluation (see repricer-ai-evaluate/_presets.ts) —
  // so these fields are locked/read-only here rather than live-editable.
  // Only CUSTOM rules (no preset) actually respect manual edits to them.
  //
  // Also locked for non-admins even when smart_profile IS 'CUSTOM': the
  // "Advanced Custom" creation entry point is admin-only (RuleBuilder.tsx's
  // picker grid), but the Edit button on an existing rule has no such check —
  // a regular user opening a Custom rule an admin created earlier would
  // otherwise get full editing on these core-identity fields, defeating the
  // point of gating Custom Rule creation at all.
  const isPresetActive = settings.smart_profile !== 'CUSTOM' || !isAdmin;

  return (
    <div className="space-y-6">
      {/* Advanced Mode Toggle — admin only */}
      {!hideProfileSelector && isAdmin && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdvancedMode(!advancedMode)}
            className="text-xs text-muted-foreground hover:text-foreground gap-1.5"
          >
            {advancedMode ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {advancedMode ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
          </Button>
        </div>
      )}
      {/* Advanced Strategies Warning Dialog */}
      {!hideProfileSelector && showAdvancedWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h3 className="font-semibold text-lg">Enable Advanced Strategies?</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              You are enabling advanced strategies that can increase risk (price wars, margin loss). These profiles are designed for experienced users who understand the trade-offs.
            </p>
            <ul className="text-sm text-muted-foreground mb-4 space-y-1">
              <li className="flex items-center gap-2">🚀 <strong>Aggressive Capture</strong> — No raises, no BB protection, fast margin erosion</li>
              <li className="flex items-center gap-2">💰 <strong>Margin Protection</strong> — Very slow reactions, may lose BB in fast markets</li>
            </ul>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowAdvancedWarning(false)}>Cancel</Button>
              <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white" onClick={confirmAdvancedStrategies}>Enable Advanced</Button>
            </div>
          </div>
        </div>
      )}



      {advancedMode && !hideProfileSelector && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" />
              {activeProfile.icon} {activeProfile.label} — Preset Settings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const preset = PROFILE_PRESETS[settings.smart_profile];
              if (!preset) return null;
              const rows: { label: string; value: string }[] = [
                { label: 'Undercut', value: settings.undercut_mode === 'managed' ? '🤖 Managed' : `$${(preset.undercut_amount ?? 0.01).toFixed(2)}` },
                { label: 'Compete With', value: (preset.fulfillment_filter ?? settings.fulfillment_filter ?? 'FBA') === 'BOTH' ? 'FBA + FBM' : (preset.fulfillment_filter ?? settings.fulfillment_filter ?? 'FBA') },
                { label: 'Ignore FBM unless BB owner', value: preset.ignore_fbm_unless_buybox_owner !== undefined ? (preset.ignore_fbm_unless_buybox_owner ? 'Yes' : 'No') : (settings.ignore_fbm_unless_buybox_owner ? 'Yes' : 'No') },
                { label: 'Smart Raise', value: preset.enable_smart_raise ? `ON (trigger ${preset.raise_trigger_percent ?? settings.raise_trigger_percent}%)` : 'OFF' },
                { label: 'Max Raise Step', value: `$${(preset.max_raise_step_dollars ?? settings.max_raise_step_dollars).toFixed(2)} / ${preset.max_raise_step_percent ?? settings.max_raise_step_percent}%` },
                { label: 'Only Raise when BB Owner', value: (preset.only_raise_when_buybox_owner ?? settings.only_raise_when_buybox_owner) ? 'Yes' : 'No' },
                { label: 'Skip Lower when BB Owner', value: (preset.skip_lower_when_bb_owner ?? settings.skip_lower_when_bb_owner) ? 'Yes' : 'No' },
                { label: 'Monopoly Mode', value: preset.enable_monopoly_mode ? `ON — ${preset.monopoly_mode_type ?? 'conservative'}` : 'OFF' },
                { label: 'Monopoly Cooldown', value: `${preset.monopoly_cooldown_minutes ?? settings.monopoly_cooldown_minutes} min` },
                { label: 'Cooldown', value: `${preset.cooldown_minutes ?? settings.cooldown_minutes} min` },
                { label: 'Stock Overlay', value: (preset.stock_overlay_enabled ?? settings.stock_overlay_enabled) ? 'ON' : 'OFF' },
              ];
              return (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
                  {rows.map((r) => (
                    <div key={r.label} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="font-medium text-foreground">{r.value}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Dynamic Rule Header based on profile */}
      {!hideProfileSelector && (
      <div className="flex items-center gap-3 p-4 bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-lg border border-purple-500/20">
        <div className="p-2 bg-purple-500/20 rounded-lg">
          <span className="text-xl">{activeProfile.icon}</span>
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            Smart Engine: {activeProfile.label}
          </h3>
          <p className="text-sm text-muted-foreground">
            {activeProfile.description}
          </p>
          {activeProfile.undercutNote && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              ℹ️ {activeProfile.undercutNote}
            </p>
          )}
        </div>
        {activeProfile.salesStars > 0 && (
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-1">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <span>Sales</span>
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className={`h-3 w-3 ${i < activeProfile.salesStars ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Shield className="h-4 w-4 text-blue-500" />
              <span>Profit</span>
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className={`h-3 w-3 ${i < activeProfile.profitStars ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Profile Risk Warnings */}
      {settings.smart_profile === 'VELOCITY_DOMINATOR' && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-orange-500/30 bg-orange-500/5 text-sm">
          <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-medium text-orange-600">Margin Erosion Warning:</span>{' '}
            <span className="text-muted-foreground">This profile aggressively lowers prices with no raise mechanism. Prices will trend toward your floor. Best for short-term clearance — not recommended as a permanent strategy.</span>
          </div>
        </div>
      )}
      {settings.smart_profile === 'PROFIT_EXTRACTOR' && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-medium text-amber-600">Competitive Listing Warning:</span>{' '}
            <span className="text-muted-foreground">This profile aggressively raises prices and never undercuts. Only use on listings you control (PL, low-competition). On competitive listings, you risk losing Buy Box permanently.</span>
          </div>
        </div>
      )}

      {/* Competition & FBM Settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-500" />
            Competition
          </CardTitle>
          <CardDescription>
            Select which seller types to compete against and how to handle FBM sellers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Buy Box Winners to Compete Against */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Buy Box Winners to Compete Against</Label>
            <div className="flex flex-wrap gap-6 items-center">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="compete-amazon"
                  checked={settings.compete_with_amazon}
                  onCheckedChange={(checked) =>
                    updateSetting("compete_with_amazon", checked === true)
                  }
                />
                <Label htmlFor="compete-amazon" className="flex items-center gap-2 cursor-pointer">
                  <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-500/20">
                    Amazon
                  </Badge>
                </Label>
              </div>
              
               {/* Compete With Dropdown */}
               <div className="flex items-center gap-2">
                <Label className="text-sm text-muted-foreground">Compete with:</Label>
                <Badge variant="outline" className={`text-xs ${
                  (settings.fulfillment_filter || "FBA") === "BOTH" 
                    ? "bg-purple-500/10 text-purple-600 border-purple-500/20" 
                    : "bg-blue-500/10 text-blue-600 border-blue-500/20"
                }`}>
                  {(settings.fulfillment_filter || "FBA") === "BOTH" ? "FBA + FBM" : "FBA"}
                </Badge>
               </div>
             </div>
           </div>

          <div className="border-t border-border" />

          {/* FBM Handling Strategy */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">FBM Competition Mode</Label>
            <Select
              value={
                (settings as any).fbm_competition_mode
                  ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")
              }
              onValueChange={(v) => {
                const mode = v as 'fba_priority' | 'all_sellers' | 'lowest_seller';
                const isFbaPriority = mode === 'fba_priority';
                onChange({
                  ...settings,
                  fbm_competition_mode: mode,
                  // Keep legacy boolean in sync as a fallback for older code paths
                  ignore_fbm_unless_buybox_owner: isFbaPriority,
                  compete_with_fba: true,
                  compete_with_fbm: !isFbaPriority,
                  fulfillment_filter: isFbaPriority ? "FBA" : "BOTH",
                } as any);
              }}
              disabled
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fba_priority">
                  🛡️ FBA Priority — Ignore FBM Unless They Own Buy Box
                </SelectItem>
                <SelectItem value="all_sellers">
                  ⚡ All Sellers (Aggressive) — Treat FBM Same as FBA
                </SelectItem>
                <SelectItem value="lowest_seller">
                  🥊 Lowest Seller — Always chase the cheapest seller (no BB requirement)
                </SelectItem>
              </SelectContent>
            </Select>
            <div className="p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
              {(settings as any).fbm_competition_mode === 'lowest_seller' ? (
                <p className="text-xs text-muted-foreground">
                  🥊 <strong>Lowest Seller:</strong> For an FBM listing, always anchor to the lowest external FBM seller (even if they don't own the Buy Box) and undercut using <strong>FBM Undercut</strong>. While a lower FBM seller exists, the engine will not smart-raise, will not run eligible-gap recovery, and will not fall back to the FBA Buy Box.
                </p>
              ) : settings.ignore_fbm_unless_buybox_owner ? (
                <p className="text-xs text-muted-foreground">
                  💡 <strong>FBA Priority:</strong> Amazon rarely gives Buy Box to FBM just for having a lower price.
                  FBM must have significantly better metrics + shipping to win. You won't get dragged
                  into a price war with FBM sellers who can't actually take the Buy Box from you.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  ⚡ <strong>All Sellers:</strong> FBM sellers are treated as real competitors — same as FBA.
                  The engine will undercut FBM prices using the same logic. Use this when you want maximum
                  sales velocity or when FBM sellers are winning Buy Box in your category.
                  Min price, profit guard, and max step still apply.
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* FBA wants to compete with FBM */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">FBA Seller: Compete Against FBM</Label>
            <div className="flex items-start gap-3 p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
              <Checkbox
                id="fba-compete-with-fbm"
                checked={
                  ((settings as any).fbm_competition_mode
                    ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")) !== "fba_priority"
                }
                onCheckedChange={(checked) => {
                  const wantsFbm = checked === true;
                  // Turning this ON moves to "lowest_seller" (compete with FBM, but not
                  // maximum-aggressive) rather than jumping straight to "all_sellers" —
                  // that value is also what the "FBM Seller: Compete Against All" checkbox
                  // below checks for, so setting it here made checking this one also show
                  // that one as checked. "All Sellers" is now reached only by explicitly
                  // turning that checkbox on too.
                  const mode: 'fba_priority' | 'lowest_seller' = wantsFbm ? 'lowest_seller' : 'fba_priority';
                  onChange({
                    ...settings,
                    fbm_competition_mode: mode,
                    ignore_fbm_unless_buybox_owner: !wantsFbm,
                    compete_with_fba: true,
                    compete_with_fbm: wantsFbm,
                    fulfillment_filter: wantsFbm ? "BOTH" : "FBA",
                  } as any);
                }}
              />
              <Label htmlFor="fba-compete-with-fbm" className="cursor-pointer text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Yes — as an FBA seller, compete with FBM too.</span>
                <br />
                Enabling this treats FBM offers as real competitors. Check <strong>FBM Seller: Compete Against All</strong> below too if you want maximum-aggressive All Sellers mode.
                Leave off to keep <strong>FBA Priority</strong> — ignoring FBM unless they own the Buy Box.
              </Label>
            </div>
          </div>

          <div className="border-t border-border" />

          {/* FBM seller competes against all */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">FBM Seller: Compete Against All</Label>
            <div className="flex items-start gap-3 p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
              <Checkbox
                id="fbm-compete-against-all"
                checked={
                  ((settings as any).fbm_competition_mode
                    ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")) === "all_sellers"
                }
                onCheckedChange={(checked) => {
                  const wantsAll = checked === true;
                  const mode: 'all_sellers' | 'lowest_seller' = wantsAll ? 'all_sellers' : 'lowest_seller';
                  onChange({
                    ...settings,
                    fbm_competition_mode: mode,
                    ignore_fbm_unless_buybox_owner: false,
                    compete_with_fba: true,
                    compete_with_fbm: true,
                    fulfillment_filter: "BOTH",
                    fbm_competes_against_all: wantsAll,
                  } as any);
                }}
              />
              <Label htmlFor="fbm-compete-against-all" className="cursor-pointer text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Yes — as an FBM seller, compete against all sellers (FBA + FBM).</span>
                <br />
                Enabling this treats every FBA and FBM offer as a real competitor for your FBM listings.
                Leave off to only compete against other FBM sellers.
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Undercut — fully AI-managed for all profiles; no manual number to set. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Undercut</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="space-y-2">
              <LockedSetting
                label="Undercut"
                value="AI-Managed"
                hint="The engine adjusts the actual amount in real time based on competition, oscillation level, and market pressure — there's no fixed number to set."
              />

              {/* Suppressed Buy Box Undercut — the one undercut value that's still manual, since there's no sensible default */}
              <div className="space-y-2 mt-4 p-4 rounded-lg border-2 border-blue-500/40 bg-blue-950/30">
                <Label htmlFor="suppressed-bb-undercut-main" className="text-sm font-bold flex items-center gap-2">
                  🚫 Suppressed Buy Box Undercut ({homeCurrencySymbol}) <span className="text-xs font-normal text-amber-400">— required</span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  When the Amazon Buy Box is <strong>suppressed</strong> (no Featured Offer), undercut the lowest valid competitor by this amount. <strong>You decide</strong> — there is no default. Enter <code>0.00</code> to match exactly.
                </p>
                <Input
                  id="suppressed-bb-undercut-main"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Enter amount (e.g. 0.01 or 0.00)"
                  value={settings.suppressed_bb_undercut == null ? "" : settings.suppressed_bb_undercut}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      updateSetting("suppressed_bb_undercut" as any, null as any);
                      return;
                    }
                    const v = parseFloat(raw);
                    updateSetting("suppressed_bb_undercut", isNaN(v) ? (null as any) : Math.max(0, v));
                  }}
                />
                {(settings.suppressed_bb_undercut == null || (settings.suppressed_bb_undercut as any) === "") && (
                  <p className="text-xs text-amber-400">⚠️ Required — suppressed-BB pricing will be skipped until you set a value.</p>
                )}
              </div>

              {/* Power Hours — a daily window where this rule undercuts
                  instead of matching.

                  Times are stored on the rule and edited here, so the hours can
                  change without a deploy. <input type="time"> gives the native
                  clock picker on every platform, including the phone. */}
              <div className="space-y-3 mt-4 p-4 rounded-lg border-2 border-amber-500/40 bg-amber-950/20">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="daypart-enabled"
                    checked={(settings as any).daypart_enabled === true}
                    onCheckedChange={(checked) => {
                      const on = checked === true;
                      // Seed sensible values so enabling it is never a silent
                      // no-op -- the DB constraint rejects enabled-without-values.
                      onChange({
                        ...settings,
                        daypart_enabled: on,
                        daypart_start: (settings as any).daypart_start ?? "06:00",
                        daypart_end: (settings as any).daypart_end ?? "12:00",
                        daypart_undercut_amount:
                          (settings as any).daypart_undercut_amount ?? 0.01,
                      } as any);
                    }}
                  />
                  <Label htmlFor="daypart-enabled" className="cursor-pointer text-xs text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">
                      ⏰ Power Hours — undercut instead of matching, during set hours
                    </span>
                    <br />
                    Inside the window this rule aims at the <strong>same competitor</strong> it
                    always does and simply lands the amount below it. Outside the window
                    nothing changes. It can never price below your min price.
                  </Label>
                </div>

                {(settings as any).daypart_enabled === true && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                    <div className="space-y-1">
                      <Label htmlFor="daypart-start" className="text-xs font-semibold">From</Label>
                      <Input
                        id="daypart-start"
                        type="time"
                        value={(settings as any).daypart_start ?? "06:00"}
                        onChange={(e) => updateSetting("daypart_start" as any, e.target.value as any)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="daypart-end" className="text-xs font-semibold">To</Label>
                      <Input
                        id="daypart-end"
                        type="time"
                        value={(settings as any).daypart_end ?? "12:00"}
                        onChange={(e) => updateSetting("daypart_end" as any, e.target.value as any)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="daypart-undercut" className="text-xs font-semibold">
                        Undercut ({homeCurrencySymbol})
                      </Label>
                      <Input
                        id="daypart-undercut"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.01"
                        value={(settings as any).daypart_undercut_amount ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === "") { updateSetting("daypart_undercut_amount" as any, null as any); return; }
                          const v = parseFloat(raw);
                          updateSetting("daypart_undercut_amount" as any, isNaN(v) ? (null as any) : Math.max(0, v));
                        }}
                      />
                    </div>
                  </div>
                )}

                {(settings as any).daypart_enabled === true && (
                  <p className="text-xs text-muted-foreground">
                    Times use your account timezone (Repricer Settings → schedule timezone),
                    not UTC. The end time is exclusive, so 06:00–12:00 runs until 11:59.
                    Setting <em>To</em> earlier than <em>From</em> makes the window cross midnight.
                  </p>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Min/Max prices are set per-assignment in the Assignments tab
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Smart Profit Guard — admin only */}
      {advancedMode && (<Card className="border-green-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-green-500" />
            Smart Profit Guard
            <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 text-xs">
              No Human Required
            </Badge>
          </CardTitle>
          <CardDescription>
            Your Min/Max prices are the absolute floor and ceiling — the repricer will never go outside them
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 p-3 bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-lg border border-green-500/20">
            <Badge className="bg-green-600 text-white text-xs">Active</Badge>
            <p className="text-sm text-muted-foreground">
              Min/Max prices set per-assignment are always enforced as hard limits
            </p>
          </div>

          {advancedMode && (<>
            {/* Dynamic ROI — admin only */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div>
                <p className="font-medium text-sm">Enable Dynamic ROI</p>
                <p className="text-xs text-muted-foreground">
                  Use higher ROI floor when many sellers are competing
                </p>
              </div>
              <Switch
                checked={settings.enable_dynamic_roi}
                onCheckedChange={(checked) => updateSetting("enable_dynamic_roi", checked)}
              />
            </div>

            {settings.enable_dynamic_roi && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-green-500/30">
                <div className="space-y-2">
                  <Label htmlFor="min-roi-high-risk">High-Risk Min ROI (%)</Label>
                  <Input
                    id="min-roi-high-risk"
                    type="number"
                    step="1"
                    min="0"
                    max="500"
                    value={settings.min_roi_percent_high_risk ?? ""}
                    onChange={(e) =>
                      updateSetting("min_roi_percent_high_risk", e.target.value ? parseFloat(e.target.value) : null)
                    }
                    placeholder="e.g. 35"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="high-risk-threshold">High-Risk Seller Threshold</Label>
                  <Input
                    id="high-risk-threshold"
                    type="number"
                    step="1"
                    min="2"
                    max="50"
                    value={settings.high_risk_seller_count_threshold}
                    onChange={(e) =>
                      updateSetting("high_risk_seller_count_threshold", parseInt(e.target.value) || 8)
                    }
                  />
                </div>
              </div>
            )}

            {/* Auto-Exit/Reenter — admin only */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div>
                <p className="font-medium text-sm flex items-center gap-2">
                  Auto-Exit & Auto-Reenter
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs">
                    Zero Human
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  Pause when below floor, auto-resume when market recovers
                </p>
              </div>
              <Switch
                checked={settings.enable_auto_exit_reenter}
                onCheckedChange={(checked) => updateSetting("enable_auto_exit_reenter", checked)}
              />
            </div>

            {settings.enable_auto_exit_reenter && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-blue-500/30">
                <div className="space-y-2">
                  <Label htmlFor="reenter-buffer">Re-entry Buffer (%)</Label>
                  <Input
                    id="reenter-buffer"
                    type="number"
                    step="0.5"
                    min="0"
                    max="20"
                    value={settings.reenter_buffer_percent}
                    onChange={(e) =>
                      updateSetting("reenter_buffer_percent", parseFloat(e.target.value) || 2)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="floor-cooldown">Floor Recheck (minutes)</Label>
                  <Select
                    value={String(settings.cooldown_minutes_on_floor)}
                    onValueChange={(v) => updateSetting("cooldown_minutes_on_floor", parseInt(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="60">1 hour</SelectItem>
                      <SelectItem value="120">2 hours</SelectItem>
                      <SelectItem value="240">4 hours</SelectItem>
                      <SelectItem value="360">6 hours (default)</SelectItem>
                      <SelectItem value="720">12 hours</SelectItem>
                      <SelectItem value="1440">24 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Other toggles — admin only */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">Include Fees in Floor Calculation</p>
                  <p className="text-xs text-muted-foreground">
                    Add estimated FBA + referral fees when calculating profit floor
                  </p>
                </div>
                <Switch
                  checked={settings.include_fees_in_floor}
                  onCheckedChange={(checked) => updateSetting("include_fees_in_floor", checked)}
                />
              </div>
              
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">Block Auto-Apply if Cost Missing</p>
                  <p className="text-xs text-muted-foreground">
                    Prevent automatic price changes when unit cost is unknown
                  </p>
                </div>
                <Switch
                  checked={settings.block_auto_apply_if_cost_missing}
                  onCheckedChange={(checked) => updateSetting("block_auto_apply_if_cost_missing", checked)}
                />
              </div>
            </div>
          </>)}
        </CardContent>
      </Card>)}

      {/* Min ROI Protection — visible to ALL users */}
      <Card className="border-amber-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-amber-500" />
            Min ROI Protection
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-xs">
              Optional
            </Badge>
          </CardTitle>
          <CardDescription>
            Set a minimum ROI % floor — the repricer will never price below this threshold and will raise your price if it's already too low
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Min ROI % per Marketplace</Label>
              <p className="text-xs text-muted-foreground">
                ROI = (Price - Cost - Fees) / Cost. Each marketplace has its own switch — turn it on to set a minimum ROI floor for that marketplace only.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {connectedMarketplaces.map((mp) => {
                const roiEnabled = isRoiEnabledForMarketplace(mp);
                return (
                  <div key={mp} className="p-3 bg-muted/50 rounded-lg space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm">{mp} — Respect minimum ROI for your price?</p>
                      <Switch
                        checked={roiEnabled}
                        onCheckedChange={(checked) => setRoiEnabledForMarketplace(mp, checked)}
                      />
                    </div>
                    {roiEnabled && (
                      <div className="space-y-1">
                        <Label htmlFor={`roi-${mp}`} className="text-xs text-muted-foreground">{mp} ROI %</Label>
                        <div className="flex gap-1">
                          <Input
                            id={`roi-${mp}`}
                            type="number"
                            step="1"
                            min="0"
                            max="500"
                            value={settings.min_roi_marketplace_overrides?.[mp] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value ? parseFloat(e.target.value) : undefined;
                              const overrides = { ...settings.min_roi_marketplace_overrides };
                              if (val !== undefined) {
                                overrides[mp] = val;
                              } else {
                                delete overrides[mp];
                              }
                              // Use a single onChange call to avoid the second call overwriting the first
                              const updated: Partial<AiRuleSettings> = { min_roi_marketplace_overrides: overrides };
                              if (mp === "US") {
                                updated.min_roi_percent = val ?? null;
                              }
                              onChange({ ...settings, ...updated });
                            }}
                            placeholder="e.g. 30"
                            className="flex-1"
                          />
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  className="h-9 w-9 shrink-0"
                                  disabled={!ruleId || !settings.min_roi_marketplace_overrides?.[mp] || applyingMarketplace === mp}
                                  onClick={() => handleApplyMinRoi(mp)}
                                >
                                  {applyingMarketplace === mp ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Apply {mp} ROI to all assignments now</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">ROI will not lower prices below your manual minimum.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </CardContent>
      </Card>

      {/* Strategy Engine — Dynamic Floor Relaxation (Milestone B) */}
      {advancedMode && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Strategy Engine — Dynamic Floor Relaxation
            </CardTitle>
            <CardDescription>
              Lets the engine soften your minimum-price floor for slow-moving or aged stock,
              based on the listing's current commercial state. The hard floors
              (your ROI floor and the platform $5 minimum) are <strong>always preserved</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="space-y-1 pr-4">
                <p className="font-medium text-sm">Allow strategy-driven floor softening?</p>
                <p className="text-xs text-muted-foreground">
                  When ON: aged (5%), velocity-boost (7%), liquidation (8%), and clearance (15%)
                  states may soften the floor. Profit Max / Buy Box Defense / Recovery never relax it.
                  When OFF: behavior is unchanged from before — the floor is fixed.
                </p>
              </div>
              <Switch
                checked={settings.enable_dynamic_floor_relaxation === true}
                onCheckedChange={(checked) => updateSetting("enable_dynamic_floor_relaxation" as any, checked)}
              />
            </div>
          </CardContent>
        </Card>
      )}
      {advancedMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Safety Guards
          </CardTitle>
          <CardDescription>
            Prevent drastic price changes and control update frequency
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="max-step-amount">Max Change Per Step ({homeCurrencySymbol})</Label>
              <Input
                id="max-step-amount"
                type="number"
                step="0.10"
                min="0.10"
                value={settings.max_step_amount}
                onChange={(e) =>
                  updateSetting("max_step_amount", parseFloat(e.target.value) || 0.50)
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max-step-percent">Max Change Per Step (%)</Label>
              <Input
                id="max-step-percent"
                type="number"
                step="1"
                min="1"
                max="50"
                value={settings.max_step_percent}
                onChange={(e) =>
                  updateSetting("max_step_percent", parseFloat(e.target.value) || 5)
                }
              />
            </div>
            <div className="space-y-2">
              {isPresetActive ? (
                <LockedSetting label="Cooldown" value={`${settings.cooldown_minutes} min`} />
              ) : (
                <>
                  <Label htmlFor="cooldown">Cooldown (minutes)</Label>
                  <Input
                    id="cooldown"
                    type="number"
                    step="1"
                    min="0"
                    value={settings.cooldown_minutes}
                    onChange={(e) =>
                      updateSetting("cooldown_minutes", parseInt(e.target.value) || 15)
                    }
                  />
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Buy Box Owner Protection + Smart Raise — hidden from the regular flow:
          every real rule already converges on Don't Lower/Smart Raise/Monopoly
          Mode all being ON, so these are now hardcoded defaults and only
          reachable here via Advanced Settings for anyone who wants to diverge. */}
      {advancedMode && (
      <Card className="border-emerald-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowUp className="h-4 w-4 text-emerald-500" />
            Smart Price Protection
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-xs">
              Maximize Profit
            </Badge>
          </CardTitle>
          <CardDescription>
            Protect your margin when you own the Buy Box & raise prices when the market goes up
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isPresetActive ? (
            <div className="space-y-3">
              <LockedSetting label="Don't Lower When You Own Buy Box" value={settings.skip_lower_when_bb_owner ? "ON" : "OFF"} />
              <LockedSetting label="Smart Raise" value={settings.enable_smart_raise ? "ON" : "OFF"} />
              {settings.enable_smart_raise && (
                <>
                  <LockedSetting label="Raise Trigger" value={`${settings.raise_trigger_percent}%`} hint="Minimum Buy Box price increase to trigger a raise" />
                  <LockedSetting label="Max Raise Per Step" value={`${homeCurrencySymbol}${settings.max_raise_step_dollars} / ${settings.max_raise_step_percent}%`} />
                  <LockedSetting label="Only Raise When You Own Buy Box" value={settings.only_raise_when_buybox_owner ? "ON" : "OFF"} />
                </>
              )}
            </div>
          ) : (
          <>
          {/* Don't Lower When BB Owner - NEW PRIMARY TOGGLE */}
          <div className="flex items-center justify-between p-3 bg-gradient-to-r from-emerald-500/10 to-green-500/10 rounded-lg border border-emerald-500/20">
            <div>
              <p className="font-medium flex items-center gap-2">
                Don't Lower When You Own Buy Box
                <Badge className="bg-emerald-600 text-white text-xs">Recommended</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                Keep your price when you're already winning — only lower after losing Buy Box
              </p>
            </div>
            <Switch
              checked={settings.skip_lower_when_bb_owner}
              onCheckedChange={(checked) => updateSetting("skip_lower_when_bb_owner", checked)}
            />
          </div>

          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div>
              <p className="font-medium">Enable Smart Raise</p>
              <p className="text-sm text-muted-foreground">
                Raise prices when Buy Box / market prices increase
              </p>
            </div>
            <Switch
              checked={settings.enable_smart_raise}
              onCheckedChange={(checked) => updateSetting("enable_smart_raise", checked)}
            />
          </div>

          {settings.enable_smart_raise && advancedMode && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="raise-trigger" className="flex items-center gap-1">
                    Raise Trigger (%)
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Minimum % increase in Buy Box price to trigger a raise (default 2%)
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                  <Input
                    id="raise-trigger"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="20"
                    value={settings.raise_trigger_percent}
                    onChange={(e) =>
                      updateSetting("raise_trigger_percent", parseFloat(e.target.value) || 2)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max-raise-dollars">Max Raise Per Step ({homeCurrencySymbol})</Label>
                  <Input
                    id="max-raise-dollars"
                    type="number"
                    step="0.05"
                    min="0.05"
                    value={settings.max_raise_step_dollars}
                    onChange={(e) =>
                      updateSetting("max_raise_step_dollars", parseFloat(e.target.value) || 0.25)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max-raise-percent">Max Raise Per Step (%)</Label>
                  <Input
                    id="max-raise-percent"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="20"
                    value={settings.max_raise_step_percent}
                    onChange={(e) =>
                      updateSetting("max_raise_step_percent", parseFloat(e.target.value) || 2)
                    }
                  />
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">Only Raise When You Own Buy Box</p>
                  <p className="text-xs text-muted-foreground">
                    Safer: only raise prices when you're already winning (recommended)
                  </p>
                </div>
                <Switch
                  checked={settings.only_raise_when_buybox_owner}
                  onCheckedChange={(checked) => updateSetting("only_raise_when_buybox_owner", checked)}
                />
              </div>

              <div className="p-3 border rounded-lg border-emerald-500/30 bg-emerald-500/5">
                <p className="text-xs text-muted-foreground">
                  💡 <strong>How it works:</strong> When Buy Box price rises by ≥{settings.raise_trigger_percent}%,
                  the repricer raises your price toward the new market level (up to ${settings.max_raise_step_dollars} or {settings.max_raise_step_percent}% per step).
                  This maximizes profit when competitors raise prices or leave the market.
                </p>
              </div>
            </>
          )}
          </>
          )}
        </CardContent>
      </Card>
      )}

      {/* Monopoly Mode - Proactive Price Raising — hidden from the regular
          flow for the same reason as Smart Price Protection above; still
          reachable via Advanced Settings. */}
      {advancedMode && (
      <Card className="border-yellow-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-yellow-500" />
            Monopoly Mode
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20 text-xs">
              Profit Maximizer
            </Badge>
          </CardTitle>
          <CardDescription>
            When you're the only FBA seller, proactively raise prices to find your profit ceiling
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isPresetActive ? (
            <LockedSetting label="Enable Monopoly Mode" value={settings.enable_monopoly_mode ? "ON" : "OFF"} />
          ) : (
          <div className="flex items-center justify-between p-3 bg-gradient-to-r from-yellow-500/10 to-orange-500/10 rounded-lg border border-yellow-500/20">
            <div>
              <p className="font-medium flex items-center gap-2">
                Enable Monopoly Mode
                <Badge className="bg-yellow-600 text-white text-xs">Recommended</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                When you're the only FBA + own Buy Box → raise prices incrementally to maximize profit
              </p>
            </div>
            <Switch
              checked={settings.enable_monopoly_mode}
              onCheckedChange={(checked) => updateSetting("enable_monopoly_mode", checked)}
            />
          </div>
          )}

          {settings.enable_monopoly_mode && advancedMode && (
            <>
              {isPresetActive ? (
                <LockedSetting label="Monopoly Strategy" value={settings.monopoly_mode_type === 'aggressive' ? '🚀 Aggressive' : '🐢 Conservative'} />
              ) : (
              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  Monopoly Strategy
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="h-3 w-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        Conservative: Small, safe steps. Protects sales velocity.
                        Aggressive: Larger steps to find ceiling faster.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <Select
                  value={settings.monopoly_mode_type}
                  onValueChange={(v: 'conservative' | 'aggressive') => updateSetting("monopoly_mode_type", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conservative">
                      🐢 Conservative - Slow & safe (recommended for fast movers)
                    </SelectItem>
                    <SelectItem value="aggressive">
                      🚀 Aggressive - Find ceiling faster (for slow/high-ROI items)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Raise Step $ / % are not part of any preset — always user-controlled */}
                <div className="space-y-2">
                  <Label htmlFor="monopoly-raise-dollars" className="flex items-center gap-1">
                    Raise Step ({homeCurrencySymbol})
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          How much to raise per cycle in monopoly mode
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                  <Input
                    id="monopoly-raise-dollars"
                    type="number"
                    step="0.05"
                    min="0.01"
                    value={settings.monopoly_raise_step_dollars}
                    onChange={(e) =>
                      updateSetting("monopoly_raise_step_dollars", parseFloat(e.target.value) || 0.10)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="monopoly-raise-percent" className="flex items-center gap-1">
                    Raise Step (%)
                  </Label>
                  <Input
                    id="monopoly-raise-percent"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="10"
                    value={settings.monopoly_raise_step_percent}
                    onChange={(e) =>
                      updateSetting("monopoly_raise_step_percent", parseFloat(e.target.value) || 1)
                    }
                  />
                </div>
                <div className="space-y-2">
                  {isPresetActive ? (
                    <LockedSetting label="Cooldown" value={`${settings.monopoly_cooldown_minutes} min`} />
                  ) : (
                    <>
                      <Label htmlFor="monopoly-cooldown" className="flex items-center gap-1">
                        Cooldown (minutes)
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger>
                              <Info className="h-3 w-3 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Wait time between raises (default 60 min = 1 hour)
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </Label>
                      <Select
                        value={String(settings.monopoly_cooldown_minutes)}
                        onValueChange={(v) => updateSetting("monopoly_cooldown_minutes", parseInt(v))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="30">30 minutes</SelectItem>
                          <SelectItem value="60">1 hour (recommended)</SelectItem>
                          <SelectItem value="120">2 hours</SelectItem>
                          <SelectItem value="240">4 hours</SelectItem>
                          <SelectItem value="360">6 hours</SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  )}
                </div>
              </div>

              <div className="p-3 border rounded-lg border-yellow-500/30 bg-yellow-500/5">
                <p className="text-xs text-muted-foreground">
                  💡 <strong>How it works:</strong> When you're the only FBA seller and own the Buy Box,
                  the repricer raises your price by ${settings.monopoly_raise_step_dollars} (or {settings.monopoly_raise_step_percent}%) every {settings.monopoly_cooldown_minutes} minutes.
                  It stops when hitting your Max Price or if you lose the Buy Box/another FBA appears.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      )}

      {/* Target Price Anchor — Admin + Advanced only. Each profile now sets its
          own fitting anchor (Aggressive Capture: lowest offer, Momentum
          Builder: smart recapture, Profit Extractor: Buy Box), so this no
          longer needs to be a routine per-rule decision. */}
      {isAdmin && advancedMode && <Card className="border-cyan-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-cyan-500" />
            Target Price Anchor
          </CardTitle>
          <CardDescription>
            Choose which competitor price the engine anchors to when calculating your target price
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select
            value={settings.target_anchor || "smart"}
            onValueChange={(val) => updateSetting("target_anchor", val as AiRuleSettings['target_anchor'])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">Smart (recommended)</SelectItem>
              <SelectItem value="smart_recapture">Smart + Lowest FBA Recapture</SelectItem>
              <SelectItem value="buybox">Buy Box</SelectItem>
              <SelectItem value="lowest_fba">Lowest FBA</SelectItem>
              <SelectItem value="lowest_offer">Lowest Offer</SelectItem>
            </SelectContent>
          </Select>
          <div className="p-3 border rounded-lg border-cyan-500/30 bg-cyan-500/5">
            <p className="text-xs text-muted-foreground">
              {settings.target_anchor === "buybox" && "💰 Anchor to Buy Box price — best for profit margin. Won't chase lower prices unnecessarily."}
              {settings.target_anchor === "smart_recapture" && "🎯 Smart when you're already lowest; switches to Lowest FBA when a cheaper FBA competitor exists. Best for ASINs where you keep losing to lower FBA sellers."}
              {settings.target_anchor === "lowest_fba" && "📦 Anchor to lowest FBA offer — ignores FBM sellers completely. Good for FBA-focused competition."}
              {settings.target_anchor === "lowest_offer" && "⚡ Anchor to absolute lowest offer (FBA + FBM) — most aggressive. May reduce margins."}
              {(!settings.target_anchor || settings.target_anchor === "smart") && "🧠 Smart: Uses Buy Box when available and reliable, falls back to Lowest FBA. This is what top repricers use."}
            </p>
          </div>
        </CardContent>
      </Card>}


      {/* Competitor Quality Filtering - Advanced only */}
      {advancedMode && (
      <Card className="border-green-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-green-500" />
            Competitor Quality Filter
            <Badge className="bg-green-600 text-white text-xs">NEW</Badge>
          </CardTitle>
          <CardDescription>
            Filter out low-quality competitors before pricing - this is what makes us better than BQool
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preset Selector */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              Quality Preset
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Quickly set all quality filters to recommended levels
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </Label>
            <Select
              value={settings.competitor_quality_preset}
              onValueChange={(v: 'conservative' | 'balanced' | 'aggressive' | 'custom') => {
                updateSetting("competitor_quality_preset", v);
                // Apply preset values
                if (v === 'conservative') {
                  updateSetting("min_seller_rating", 90);
                  updateSetting("max_handling_days", 1);
                } else if (v === 'balanced') {
                  updateSetting("min_seller_rating", 80);
                  updateSetting("max_handling_days", 2);
                } else if (v === 'aggressive') {
                  updateSetting("min_seller_rating", 70);
                  updateSetting("max_handling_days", 3);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">🛡️ Conservative (≥90% rating, ≤1 day handling)</SelectItem>
                <SelectItem value="balanced">⚖️ Balanced (≥80% rating, ≤2 days handling)</SelectItem>
                <SelectItem value="aggressive">⚡ Aggressive (≥70% rating, ≤3 days handling)</SelectItem>
                <SelectItem value="custom">🔧 Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Min Seller Rating */}
            <div className="space-y-2">
              <Label htmlFor="min-seller-rating" className="flex items-center gap-1">
                Min Rating %
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Ignore sellers below this positive feedback percentage
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="min-seller-rating"
                type="number"
                min="0"
                max="100"
                value={settings.min_seller_rating}
                onChange={(e) => {
                  updateSetting("min_seller_rating", parseInt(e.target.value) || 0);
                  updateSetting("competitor_quality_preset", "custom");
                }}
              />
            </div>

            {/* Max Handling Days */}
            <div className="space-y-2">
              <Label htmlFor="max-handling-days" className="flex items-center gap-1">
                Max Handling Days
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Ignore sellers with longer handling times
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="max-handling-days"
                type="number"
                min="0"
                max="14"
                value={settings.max_handling_days}
                onChange={(e) => {
                  updateSetting("max_handling_days", parseInt(e.target.value) || 0);
                  updateSetting("competitor_quality_preset", "custom");
                }}
              />
            </div>

            {/* Ships From Filter */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                Ships From
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Filter by seller location
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Select
                value={settings.ships_from_filter}
                onValueChange={(v: 'US_ONLY' | 'DOMESTIC' | 'ANY') => 
                  updateSetting("ships_from_filter", v)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANY">Any Location</SelectItem>
                  <SelectItem value="DOMESTIC">Domestic Only</SelectItem>
                  <SelectItem value="US_ONLY">US Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Top N Competitors */}
            <div className="space-y-2">
              <Label htmlFor="top-n-competitors" className="flex items-center gap-1">
                Top N Limit
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Only consider top N competitors by price (0 = no limit)
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="top-n-competitors"
                type="number"
                min="0"
                max="50"
                value={settings.top_n_competitors}
                onChange={(e) =>
                  updateSetting("top_n_competitors", parseInt(e.target.value) || 0)
                }
              />
            </div>
          </div>
          
          <div className="p-3 border rounded-lg border-green-500/30 bg-green-500/5">
            <p className="text-xs text-muted-foreground">
              💡 <strong>Why this matters:</strong> BQool filters by seller quality (rating, handling time, ships-from) before pricing.
              This prevents chasing low-quality sellers who don't pose a real Buy Box threat. 
              With {settings.competitor_quality_preset} preset: ignoring sellers with {"<"}{settings.min_seller_rating}% rating or {">"}{settings.max_handling_days} day handling.
            </p>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Smart Engine Toggle - Advanced only */}
      {advancedMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-green-500" />
            Smart Engine
          </CardTitle>
          <CardDescription>
            Deterministic intelligence engine that adjusts aggressiveness based on market signals — zero AI cost
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isPresetActive ? (
            <LockedSetting
              label="Smart Repricing Engine"
              value={settings.use_ai_tuning ? "ON" : "OFF"}
              hint="Analyzes sales velocity, Buy Box win rate, urgency & competition to tune undercut — $0 per evaluation"
            />
          ) : (
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div>
              <p className="font-medium">Enable Smart Repricing Engine</p>
              <p className="text-sm text-muted-foreground">
                Analyzes sales velocity, Buy Box win rate, urgency &amp; competition to tune undercut (0.5x – 1.5x) — $0 per evaluation
              </p>
            </div>
            <Switch
              checked={settings.use_ai_tuning}
              onCheckedChange={(checked) => updateSetting("use_ai_tuning", checked)}
            />
          </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Oscillation Handling — Admin + Advanced only. Every rule with real
          live assignments already runs Intelligent Mode + Balanced style
          (verified against actual account data — the 2 rules that differed
          had zero active assignments and were leftover test/copy rules), so
          this is no longer a routine per-rule decision. */}
      {isAdmin && advancedMode && <Card className="border-orange-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-orange-500" />
            Oscillation Handling
            <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-500/20 text-xs">
              Price War Protection
            </Badge>
          </CardTitle>
          <CardDescription>
            Choose how the repricer behaves when the market is unstable (multiple bots fighting).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* AI vs Manual toggle */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {settings.oscillation_mode === 'auto' ? '🧠 Intelligent Mode' : '⚙️ Manual Mode'}
              </span>
              <span className="text-xs text-muted-foreground">
                {settings.oscillation_mode === 'auto' 
                  ? 'Automatically adapts to market conditions' 
                  : 'You control oscillation behavior'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Manual</Label>
              <Switch
                checked={settings.oscillation_mode === 'auto'}
                onCheckedChange={(checked) => {
                  if (checked) {
                    onChange({
                      ...settings,
                      oscillation_mode: 'auto',
                      oscillation_ai_style: settings.oscillation_ai_style || 'balanced',
                    });
                  } else {
                    onChange({
                      ...settings,
                      oscillation_mode: 'safe',
                      oscillation_cooldown_minutes: 20,
                      oscillation_max_reactions: 0,
                      oscillation_bb_loss_limit: 1,
                    });
                  }
                }}
              />
              <Label className="text-xs text-muted-foreground">Intelligent</Label>
            </div>
          </div>

          {/* AI Mode content */}
          {settings.oscillation_mode === 'auto' && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20">
                <p className="text-sm text-foreground">
                  🧠 <strong>Adaptive Intelligence</strong> — The repricer reads live market signals and automatically switches behavior per ASIN:
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div className="flex items-center gap-1.5 p-1.5 rounded bg-green-500/10 border border-green-500/20">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span><strong>Stable</strong> — Competes normally</span>
                  </div>
                  <div className="flex items-center gap-1.5 p-1.5 rounded bg-yellow-500/10 border border-yellow-500/20">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span><strong>Volatile</strong> — Limited reactions</span>
                  </div>
                  <div className="flex items-center gap-1.5 p-1.5 rounded bg-red-500/10 border border-red-500/20">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <span><strong>Price War</strong> — Protects floor</span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">AI Style Preference</Label>
                <Select
                  value={settings.oscillation_ai_style || 'balanced'}
                  onValueChange={(val) => onChange({ ...settings, oscillation_ai_style: val as 'conservative' | 'balanced' | 'aggressive' })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conservative">
                      <div className="flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-green-500" />
                        🛡️ Conservative — Protect profit more
                      </div>
                    </SelectItem>
                    <SelectItem value="balanced">
                      <div className="flex items-center gap-2">
                        <Zap className="h-3.5 w-3.5 text-yellow-500" />
                        ⚖️ Balanced — Default
                      </div>
                    </SelectItem>
                    <SelectItem value="aggressive">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-3.5 w-3.5 text-red-500" />
                        ⚡ Aggressive — Maximize Buy Box wins
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Influences how quickly the AI switches to defensive or aggressive behavior. The AI still decides per-ASIN based on live signals.
                </p>
              </div>
            </div>
          )}

          {/* Manual Mode content */}
          {settings.oscillation_mode !== 'auto' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Oscillation Mode</Label>
              <Select
                value={settings.oscillation_mode}
                onValueChange={(val) => {
                  const mode = val as 'safe' | 'balanced' | 'aggressive';
                  const defaults: Record<string, { cooldown: number; maxReactions: number; bbLossLimit: number }> = {
                    safe: { cooldown: 20, maxReactions: 0, bbLossLimit: 1 },
                    balanced: { cooldown: 10, maxReactions: 2, bbLossLimit: 2 },
                    aggressive: { cooldown: 5, maxReactions: 999, bbLossLimit: 3 },
                  };
                  const d = defaults[mode];
                  onChange({
                    ...settings,
                    oscillation_mode: mode,
                    oscillation_cooldown_minutes: d.cooldown,
                    oscillation_max_reactions: d.maxReactions,
                    oscillation_bb_loss_limit: d.bbLossLimit,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="safe">
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5 text-green-500" />
                      Avoid Price Wars (Safe)
                    </div>
                  </SelectItem>
                  <SelectItem value="balanced">
                    <div className="flex items-center gap-2">
                      <Zap className="h-3.5 w-3.5 text-yellow-500" />
                      Limited Reaction (Balanced)
                    </div>
                  </SelectItem>
                  <SelectItem value="aggressive">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 text-red-500" />
                      Continue Competing (Aggressive)
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>

              {settings.oscillation_mode === 'safe' && (
                <p className="text-xs text-muted-foreground">
                  🛡️ When price instability is detected, the repricer will <strong>hold your price</strong> and wait for the market to stabilize. Safest option — protects margin from price wars.
                </p>
              )}
              {settings.oscillation_mode === 'balanced' && (
                <p className="text-xs text-muted-foreground">
                  ⚖️ The repricer will make a <strong>limited number of reactions</strong> during unstable markets, then enter a cooldown. Good balance between competitiveness and safety.
                </p>
              )}
              {settings.oscillation_mode === 'aggressive' && (
                <p className="text-xs text-muted-foreground">
                  ⚡ The repricer will <strong>keep competing</strong> even during price oscillation. Still respects min price, profit guard, and max step. Only pauses after repeated Buy Box losses after raises.
                </p>
              )}

              {/* Advanced oscillation settings */}
              {advancedMode && (
                <div className="space-y-4 pt-2 border-t">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs flex items-center gap-1">
                              Cooldown (min) <Info className="h-3 w-3" />
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent>How long to pause repricing after oscillation is detected or reaction limit is reached</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Input
                        type="number"
                        min={0}
                        value={settings.oscillation_cooldown_minutes}
                        onChange={(e) => updateSetting('oscillation_cooldown_minutes', parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs flex items-center gap-1">
                              Max Reactions <Info className="h-3 w-3" />
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent>Maximum price changes allowed during an oscillation window before entering cooldown (0 = no reactions in safe mode)</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Input
                        type="number"
                        min={0}
                        value={settings.oscillation_max_reactions}
                        onChange={(e) => updateSetting('oscillation_max_reactions', parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs flex items-center gap-1">
                              BB Loss Limit <Info className="h-3 w-3" />
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent>After this many Buy Box losses following raises, enter cooldown even in aggressive mode</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Input
                        type="number"
                        min={1}
                        value={settings.oscillation_bb_loss_limit}
                        onChange={(e) => updateSetting('oscillation_bb_loss_limit', parseInt(e.target.value) || 1)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>}
    </div>
  );
}
