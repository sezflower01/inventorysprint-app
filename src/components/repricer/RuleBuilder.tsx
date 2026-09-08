import { useState, useEffect } from "react";
import MarketplaceScheduleEditor, { type MarketplaceScheduleMap } from "./MarketplaceScheduleEditor";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { MARKETPLACE_LIST } from "@/lib/marketplaceCurrency";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Edit2, Trash2, Copy, Settings2, Beaker, Sparkles, Star, TrendingUp, Shield, Play, Pause } from "lucide-react";
import AiRuleBuilder, { defaultAiRuleSettings, type AiRuleSettings, SMART_PROFILES, PROFILE_PRESETS } from "./AiRuleBuilder";
import type { SmartProfile } from "./AiRuleBuilder";
import PresetComparisonDialog from "./PresetComparisonDialog";

// Strategy options for standard rules
const STRATEGIES = [
  { value: "MATCH_LOWEST_FBA_MINUS", label: "Match Lowest FBA - Undercut" },
  { value: "MATCH_LOWEST_OVERALL_MINUS", label: "Match Lowest Overall - Undercut" },
  { value: "BEAT_BUYBOX_MINUS", label: "Beat Buy Box - Undercut" },
  { value: "STAY_WITHIN_BUYBOX_RANGE", label: "Match Buy Box Price" },
  { value: "BEAT_SPECIFIC_SELLER_MINUS", label: "Beat Specific Seller(s)" },
];

const BASIC_STRATEGIES = [
  { value: "BASIC_MATCH_BB", label: "⚡ Basic: Match Buy Box" },
  { value: "BASIC_UNDERCUT_BB", label: "⚡ Basic: Undercut Buy Box" },
  { value: "BASIC_MATCH_LOWEST", label: "⚡ Basic: Match Lowest Price" },
  { value: "BASIC_HOLD", label: "⚡ Basic: Hold Current Price" },
];

const FLOOR_SOURCES = [
  { value: "manual", label: "Manual Min Price" },
  { value: "cost_plus", label: "Cost + Min Profit" },
  { value: "roi_based", label: "ROI-Based Floor" },
];

const FULFILLMENT_SCOPES = [
  { value: "FBA", label: "FBA Only" },
  { value: "FBM", label: "FBM Only" },
  { value: "BOTH", label: "Both FBA & FBM" },
];

const CONDITION_SCOPES = [
  { value: "New", label: "New Only" },
  { value: "Used", label: "Used Only" },
  { value: "Any", label: "Any Condition" },
];

const TARGET_ANCHORS = [
  { value: "smart", label: "Smart (recommended)" },
  { value: "smart_recapture", label: "Smart + Lowest FBA Recapture" },
  { value: "buybox", label: "Buy Box" },
  { value: "lowest_fba", label: "Lowest FBA" },
  { value: "lowest_offer", label: "Lowest Offer" },
];

// Sourced from the shared marketplace config (src/lib/marketplaceCurrency)
// instead of a hardcoded 4-item list — otherwise a genuinely authorized
// marketplace outside that fixed set (e.g. UK, DE) would get silently
// dropped by the `visibleMarketplaces` filter below, even though
// `authorizedMarketplaces` correctly detected it from seller_authorizations.
const MARKETPLACES = MARKETPLACE_LIST.map((m) => ({ value: m.id, label: `${m.flag} ${m.name}` }));

const getRuleUndercutMode = (rule: RepricerRule): 'managed' | 'custom' => {
  const storedMode = String(
    (rule.ai_settings as any)?.undercut_mode ?? (rule as any).undercut_mode ?? ""
  ).toLowerCase();

  if (storedMode === 'managed' || storedMode === 'custom') {
    return storedMode;
  }

  const isAiRule =
    rule.rule_type === 'ai' ||
    rule.strategy === 'AI_WIN_SALES_BOOSTER' ||
    Boolean((rule as any).smart_profile);

  return isAiRule ? 'managed' : 'custom';
};

const getRuleUndercutSummary = (rule: RepricerRule) => {
  return getRuleUndercutMode(rule) === 'managed'
    ? '🤖 Managed undercut'
    : `$${Number(rule.undercut_amount ?? 0.01).toFixed(2)} undercut`;
};

const getSuppressedBbUndercutSummary = (rule: RepricerRule) => {
  return rule.suppressed_bb_undercut == null
    ? 'Suppressed BB: not set'
    : `Suppressed BB: $${Number(rule.suppressed_bb_undercut).toFixed(2)}`;
};

export interface RepricerRule {
  id: string;
  name: string;
  is_enabled: boolean;
  is_default?: boolean;
  marketplaces: string[];

  fulfillment_scope: string;
  condition_scope: string;
  strategy: string;
  undercut_amount: number;
  fbm_undercut_amount?: number | null;
  suppressed_bb_undercut?: number | null;
  undercut_mode?: 'managed' | 'custom';
  min_price: number | null;
  min_profit: number | null;
  min_roi: number | null;
  max_price: number | null;
  floor_source: string;
  excluded_sellers: string[];
  target_seller_ids: string[];
  max_change_percent: number | null;
  min_change_threshold: number | null;
  created_at: string;
  updated_at: string;
  ai_settings?: Record<string, any> | null;
  // AI rule fields
  rule_type?: string;
  when_only_seller?: string;
  when_not_buybox_eligible?: string;
  when_buybox_suppressed?: string;
  when_condition_used?: string;
  when_backordered?: string;
  when_below_min_price?: string;
  compete_with_amazon?: boolean;
  compete_with_fba?: boolean;
  compete_with_fbm?: boolean;
  fulfillment_filter?: "FBA" | "FBM" | "BOTH";
  max_step_amount?: number;
  max_step_percent?: number;
  cooldown_minutes?: number;
  use_ai_tuning?: boolean;
  enable_profit_guard?: boolean;
  min_profit_dollars?: number | null;
  min_roi_percent?: number | null;
  min_roi_percent_base?: number | null;
  min_roi_percent_high_risk?: number | null;
  high_risk_seller_count_threshold?: number;
  enable_dynamic_roi?: boolean;
  enable_dynamic_floor_relaxation?: boolean;
  include_fees_in_floor?: boolean;
  block_auto_apply_if_cost_missing?: boolean;
  profit_guard_mode?: 'strict' | 'respect_min_max' | 'off';
  enable_auto_exit_reenter?: boolean;
  reenter_buffer_percent?: number;
  cooldown_minutes_on_floor?: number;
  max_drop_per_run_cents?: number;
  snapshot_ttl_minutes?: number;
  enable_smart_raise?: boolean;
  raise_trigger_percent?: number;
  max_raise_step_dollars?: number;
  max_raise_step_percent?: number;
  only_raise_when_buybox_owner?: boolean;
  skip_lower_when_bb_owner?: boolean;
  enable_monopoly_mode?: boolean;
  monopoly_raise_step_dollars?: number;
  monopoly_raise_step_percent?: number;
  monopoly_cooldown_minutes?: number;
  monopoly_mode_type?: 'conservative' | 'aggressive';
  ignore_fbm_unless_buybox_owner?: boolean;
  fbm_competition_mode?: 'fba_priority' | 'all_sellers' | 'lowest_seller';
  target_anchor?: string;
  marketplace_schedule?: MarketplaceScheduleMap | any;
  enable_auto_floor?: boolean;
  war_protection_minutes?: number;
}

// "Respect minimum ROI" is toggled per marketplace via
// min_roi_enabled_marketplace_overrides; a marketplace without its own entry
// falls back to the legacy global min_roi_enabled boolean. Mirrors
// supabase/functions/_shared/min-roi-enabled.ts (Deno can't share code with
// the frontend bundle, so the same small resolution logic lives here too).
export function resolveRuleMinRoiEnabledForMarketplace(
  rule: { min_roi_enabled?: boolean | null; min_roi_enabled_marketplace_overrides?: Record<string, boolean> | null } | null | undefined,
  marketplace: string,
): boolean {
  if (!rule) return false;
  const overrides = rule.min_roi_enabled_marketplace_overrides;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, marketplace)) {
    return !!overrides[marketplace];
  }
  return rule.min_roi_enabled ?? false;
}

interface RuleBuilderProps {
  onRulesChange?: () => void;
  isAdmin?: boolean;
}

const defaultRule: Partial<RepricerRule> = {
  name: "",
  is_enabled: true,
  marketplaces: ["US"],
  fulfillment_scope: "FBA",
  condition_scope: "New",
  strategy: "MATCH_LOWEST_FBA_MINUS",
  undercut_amount: 0.01,
  fbm_undercut_amount: null,
  suppressed_bb_undercut: null,
  min_price: null,
  min_profit: null,
  min_roi: null,
  max_price: null,
  floor_source: "manual",
  excluded_sellers: [],
  target_seller_ids: [],
  max_change_percent: 10,
  min_change_threshold: 0.01,
  rule_type: "standard",
  target_anchor: "smart",
  ignore_fbm_unless_buybox_owner: false,
};

const defaultAiRule: Partial<RepricerRule> = {
  name: "Momentum Builder",
  is_enabled: true,
  marketplaces: ["US"],
  fulfillment_scope: "FBA",
  condition_scope: "New",
  strategy: "AI_WIN_SALES_BOOSTER",
  rule_type: "ai",
  ...defaultAiRuleSettings,
};

export default function RuleBuilder({ onRulesChange, isAdmin }: RuleBuilderProps) {
  const { user } = useAuth();
  const { homeCurrencySymbol, homeMarketplace } = useHomeMarketplace();
  const [rules, setRules] = useState<RepricerRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RepricerRule | null>(null);
  const [formData, setFormData] = useState<Partial<RepricerRule>>(defaultRule);
  const [saving, setSaving] = useState(false);
  const [ruleType, setRuleType] = useState<"standard" | "ai">("standard");
  const [isCustomRule, setIsCustomRule] = useState(false);
  const [authorizedMarketplaces, setAuthorizedMarketplaces] = useState<string[]>(["US"]);
  const [renamingRuleId, setRenamingRuleId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Per-rule counts, resolved in SQL. See get_rule_assignment_counts().
  //
  // An assignment is per (asin, marketplace), so with four marketplaces
  // authorised one ASIN can carry four assignments -- hence both figures:
  // the badge says ASINs because that is what it is labelled.
  type RuleCounts = {
    assignments: number;
    enabled_assignments: number;
    distinct_asins: number;
    enabled_asins: number;
    in_stock_asins: number;
  };
  const [assignmentCounts, setAssignmentCounts] = useState<Record<string, RuleCounts>>({});

  const startRename = (rule: RepricerRule) => {
    setRenamingRuleId(rule.id);
    setRenameValue(rule.name);
  };

  const saveRename = async (ruleId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) { setRenamingRuleId(null); return; }
    try {
      const { error } = await supabase
        .from("repricer_rules")
        .update({ name: trimmed })
        .eq("id", ruleId);
      if (error) throw error;
      setRules(prev => prev.map(r => r.id === ruleId ? { ...r, name: trimmed } : r));
      toast.success("Rule renamed");
    } catch (e: any) {
      toast.error("Rename failed: " + e.message);
    }
    setRenamingRuleId(null);
  };

  // Auto-detect user's authorized marketplaces from seller_authorizations
  useEffect(() => {
    if (!user) return;
    const detectMarketplaces = async () => {
      try {
        const { getMarketplaceFromId } = await import("@/lib/marketplaceCurrency");
        const { data } = await supabase
          .from("seller_authorizations")
          .select("marketplace_id")
          .eq("user_id", user.id);
        if (data && data.length > 0) {
          const mpCodes = [...new Set(data.map((d) => getMarketplaceFromId(d.marketplace_id)))];
          setAuthorizedMarketplaces(mpCodes);
        }
      } catch (e) {
        console.error("Failed to detect marketplaces:", e);
      }
    };
    detectMarketplaces();
  }, [user]);

  // Only marketplaces this account has actually connected — admin or not.
  // A rule assigned to an unconnected marketplace can never have real
  // assignments there, so showing it just invites confusion.
  const visibleMarketplaces = MARKETPLACES.filter((mp) => authorizedMarketplaces.includes(mp.value));

  useEffect(() => {
    if (user) {
      fetchRules();
    }
  }, [user]);

  const fetchRules = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("repricer_rules")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      const fetchedRules = (data as RepricerRule[]) || [];
      setRules(fetchedRules);

      // Counts come from SQL, not from counting fetched rows.
      //
      // This used to select every assignment row and tally them here. PostgREST
      // caps a response at 1,000 rows and truncates SILENTLY, so with 6,214
      // assignments across 17 rules (measured 2026-09-06) the badges were
      // sharing out a truncated 1,000 and all of them were wrong -- Momentum
      // Smart read 54 against a true 254 ASINs. The failure also worsens as the
      // account grows, since more rules divide the same 1,000 rows.
      if (fetchedRules.length > 0) {
        const { data: countRows, error: countErr } = await supabase
          .rpc("get_rule_assignment_counts" as any);
        if (countErr) {
          console.error("Rule assignment counts failed:", countErr);
        } else if (countRows) {
          const counts: Record<string, RuleCounts> = {};
          for (const c of countRows as any[]) {
            if (!c?.rule_id) continue;
            counts[c.rule_id] = {
              assignments: Number(c.assignments) || 0,
              enabled_assignments: Number(c.enabled_assignments) || 0,
              distinct_asins: Number(c.distinct_asins) || 0,
              enabled_asins: Number(c.enabled_asins) || 0,
              in_stock_asins: Number(c.in_stock_asins) || 0,
            };
          }
          setAssignmentCounts(counts);
        }
      }
    } catch (error: any) {
      console.error("Error fetching rules:", error);
      toast.error("Failed to load rules");
    } finally {
      setLoading(false);
    }
  };

  // Copy one rule's Power Hours window onto every other rule.
  //
  // The window lives per rule so different rules CAN differ, but the seller
  // runs one trading pattern across the whole catalogue and asked for them
  // unified. Doing it as an explicit action rather than moving the setting to
  // the account keeps both: one click to make them agree, and the freedom to
  // diverge afterwards.
  //
  // Only the four daypart columns are copied. Nothing else about a rule is
  // touched -- anchors, undercuts and competitor settings stay as they are.
  const applyDaypartToAllRules = async (source: RepricerRule) => {
    const src = source as any;
    if (!src.daypart_enabled || !src.daypart_start || !src.daypart_end
        || src.daypart_undercut_amount == null) {
      toast.error("Set the window on this rule first, then apply it to the others");
      return;
    }
    const others = rules.filter(r => r.id !== source.id);
    if (others.length === 0) { toast.info("No other rules to update"); return; }

    const ok = window.confirm(
      `Apply ${src.daypart_start}–${src.daypart_end} at $${Number(src.daypart_undercut_amount).toFixed(2)} ` +
      `to all ${others.length} other rules?\n\n` +
      `Inside that window every rule will undercut instead of matching. ` +
      `Nothing else about the rules changes, and no rule can price below its min price.`
    );
    if (!ok) return;

    try {
      const { error } = await supabase
        .from("repricer_rules")
        .update({
          daypart_enabled: true,
          daypart_start: src.daypart_start,
          daypart_end: src.daypart_end,
          daypart_undercut_amount: src.daypart_undercut_amount,
        } as any)
        .in("id", others.map(r => r.id));
      if (error) throw error;
      toast.success(`Power Hours applied to ${others.length} rules`);
      await fetchRules();
      onRulesChange?.();
    } catch (e: any) {
      toast.error("Could not apply to all rules: " + e.message);
    }
  };

  const openCreateDialog = (type: "standard" | "ai" = "standard", custom = false) => {
    setEditingRule(null);
    setRuleType(type === "standard" ? "ai" : type); // Custom also uses AI type
    setIsCustomRule(custom);
    const autoMarketplaces = [...authorizedMarketplaces];
    if (custom) {
      const momentumPreset = PROFILE_PRESETS['MOMENTUM_BUILDER'];
      setFormData({ ...defaultAiRule, ...momentumPreset, name: "Custom Rule", smart_profile: 'MOMENTUM_BUILDER', marketplaces: autoMarketplaces } as any);
    } else if (type === "ai") {
      setFormData({ ...defaultAiRule, name: getNextRuleName(defaultAiRule.name!), marketplaces: autoMarketplaces });
    } else {
      setFormData({ ...defaultRule, marketplaces: autoMarketplaces });
    }
    setDialogOpen(true);
  };

  const openEditDialog = (rule: RepricerRule) => {
    setEditingRule(rule);
    setIsCustomRule(false);
    setRuleType(rule.strategy === "AI_WIN_SALES_BOOSTER" ? "ai" : "standard");
    setFormData({
      ...rule,
      undercut_mode: ((rule.ai_settings as any)?.undercut_mode ?? (rule as any).undercut_mode ?? 'managed') as 'managed' | 'custom',
      marketplaces: rule.marketplaces || ["US"],
      ai_settings: {
        ...(rule.ai_settings || {}),
        oscillation_ai_style: (rule.ai_settings as any)?.oscillation_ai_style ?? 'balanced',
      },
      excluded_sellers: rule.excluded_sellers || [],
      target_seller_ids: rule.target_seller_ids || [],
    });
    setDialogOpen(true);
  };

  const duplicateRule = async (rule: RepricerRule) => {
    try {
      const { id, created_at, updated_at, ...ruleData } = rule;
      const newRule = {
        ...ruleData,
        name: getNextRuleName(rule.name),
      };

      const { error } = await supabase.from("repricer_rules").insert(newRule as any);
      if (error) throw error;

      toast.success("Rule duplicated");
      fetchRules();
      onRulesChange?.();
    } catch (error: any) {
      toast.error("Failed to duplicate rule: " + error.message);
    }
  };

  const [deleteConfirmRuleId, setDeleteConfirmRuleId] = useState<string | null>(null);

  const confirmDeleteRule = async () => {
    if (!deleteConfirmRuleId) return;
    try {
      const { error } = await supabase
        .from("repricer_rules")
        .delete()
        .eq("id", deleteConfirmRuleId);

      if (error) throw error;

      toast.success("Rule deleted");
      fetchRules();
      onRulesChange?.();
    } catch (error: any) {
      toast.error("Failed to delete rule: " + error.message);
    } finally {
      setDeleteConfirmRuleId(null);
    }
  };

  const toggleRuleEnabled = async (ruleId: string, enabled: boolean) => {
    try {
      const { error } = await supabase
        .from("repricer_rules")
        .update({ is_enabled: enabled })
        .eq("id", ruleId);

      if (error) throw error;

      setRules((prev) =>
        prev.map((r) => (r.id === ruleId ? { ...r, is_enabled: enabled } : r))
      );
      onRulesChange?.();
    } catch (error: any) {
      toast.error("Failed to update rule: " + error.message);
    }
  };

  const setRuleAsDefault = async (ruleId: string) => {
    try {
      const { error } = await supabase
        .from("repricer_rules")
        .update({ is_default: true } as any)
        .eq("id", ruleId);
      if (error) throw error;
      // DB trigger unsets the previous default automatically — mirror that locally
      setRules((prev) => prev.map((r) => ({ ...r, is_default: r.id === ruleId })));
      toast.success("Default rule updated — new ASINs will be onboarded with this rule");
      onRulesChange?.();
    } catch (error: any) {
      toast.error("Failed to set default rule: " + error.message);
    }
  };


  const saveRule = async () => {
    if (!formData.name?.trim()) {
      toast.error("Rule name is required");
      return;
    }

    if (!user) {
      toast.error("You must be logged in to create rules");
      return;
    }

    try {
      setSaving(true);

      const isAiRule = ruleType === "ai" || formData.strategy === "AI_WIN_SALES_BOOSTER";

      const ruleData: any = {
        user_id: user.id, // Required for RLS policy
        name: formData.name!,
        is_enabled: formData.is_enabled ?? true,
        marketplaces: formData.marketplaces || ["US"],
        fulfillment_scope: (formData.fulfillment_scope || "FBA"),
        condition_scope: (formData.condition_scope || "New"),
        strategy: isAiRule ? "AI_WIN_SALES_BOOSTER" : (formData.strategy || "MATCH_LOWEST_FBA_MINUS"),
        undercut_amount: formData.undercut_amount ?? 0,
        // Second whitelist, same trap. Without these the checkbox would toggle
        // on screen and then vanish on save, which is worse than not working.
        // Normalised to satisfy the CHECK constraints: enabling the window
        // without times or an amount is rejected by the database on purpose.
        daypart_enabled: (formData as any).daypart_enabled === true,
        daypart_start: (formData as any).daypart_start || null,
        daypart_end: (formData as any).daypart_end || null,
        daypart_undercut_amount:
          ((formData as any).daypart_undercut_amount == null
            || (formData as any).daypart_undercut_amount === "")
            ? null
            : Math.max(0, Number((formData as any).daypart_undercut_amount)),
        fbm_undercut_amount: (formData.fbm_undercut_amount == null || (formData.fbm_undercut_amount as any) === "") ? null : Math.max(0, Number(formData.fbm_undercut_amount)),
        suppressed_bb_undercut: (formData.suppressed_bb_undercut == null || (formData.suppressed_bb_undercut as any) === "") ? null : Math.max(0, Number(formData.suppressed_bb_undercut)),
        min_price: formData.min_price,
        min_profit: formData.min_profit,
        min_roi: formData.min_roi,
        max_price: formData.max_price,
        floor_source: (formData.floor_source || "manual"),
        excluded_sellers: formData.excluded_sellers || [],
        target_seller_ids: formData.target_seller_ids || [],
        max_change_percent: formData.max_change_percent,
        min_change_threshold: formData.min_change_threshold,
        rule_type: isAiRule ? "ai" : "standard",
        target_anchor: formData.target_anchor || "smart",
        marketplace_schedule: formData.marketplace_schedule || {},
        ignore_fbm_unless_buybox_owner: formData.ignore_fbm_unless_buybox_owner ?? false,
        fbm_competition_mode: ((formData as any).fbm_competition_mode as 'fba_priority' | 'all_sellers' | 'lowest_seller' | undefined)
          ?? ((formData.ai_settings as any)?.fbm_competition_mode)
          ?? ((formData.ignore_fbm_unless_buybox_owner ?? false) ? 'fba_priority' : 'all_sellers'),
        ai_settings: isAiRule ? { ...(formData.ai_settings || {}), undercut_mode: (formData as any).undercut_mode ?? 'managed' } : (formData.ai_settings || {}),
      };

      // Add AI-specific fields
      if (isAiRule) {
        ruleData.smart_profile = isCustomRule ? 'CUSTOM' : ((formData as any).smart_profile || 'MOMENTUM_BUILDER');
        ruleData.when_only_seller = formData.when_only_seller || "CUSTOM_PRICE";
        ruleData.when_not_buybox_eligible = formData.when_not_buybox_eligible || "CUSTOM_PRICE";
        ruleData.when_buybox_suppressed = formData.when_buybox_suppressed || "AI_REPRICE";
        ruleData.when_condition_used = formData.when_condition_used || "AI_REPRICE";
        ruleData.when_backordered = formData.when_backordered || "MIN_PRICE";
        ruleData.when_below_min_price = formData.when_below_min_price || "MIN_PRICE";
        ruleData.compete_with_amazon = formData.compete_with_amazon ?? true;
        ruleData.compete_with_fba = formData.compete_with_fba ?? true;
        ruleData.compete_with_fbm = formData.compete_with_fbm ?? true;
        ruleData.max_step_amount = formData.max_step_amount || 0.50;
        ruleData.max_step_percent = formData.max_step_percent || 5;
        ruleData.cooldown_minutes = formData.cooldown_minutes || 15;
        ruleData.use_ai_tuning = formData.use_ai_tuning ?? true;
        // Profit Guard fields
        ruleData.min_profit_dollars = formData.min_profit_dollars ?? null;
        ruleData.min_roi_percent = formData.min_roi_percent ?? null;
        ruleData.include_fees_in_floor = formData.include_fees_in_floor ?? true;
        ruleData.block_auto_apply_if_cost_missing = formData.block_auto_apply_if_cost_missing ?? true;
        ruleData.profit_guard_mode = formData.profit_guard_mode ?? 'strict';
        // Snapshot TTL
        ruleData.snapshot_ttl_minutes = formData.snapshot_ttl_minutes ?? 360;
        // Smart Raise fields
        ruleData.enable_smart_raise = formData.enable_smart_raise ?? false;
        ruleData.raise_trigger_percent = formData.raise_trigger_percent ?? 2;
        ruleData.max_raise_step_dollars = formData.max_raise_step_dollars ?? 0.25;
        ruleData.max_raise_step_percent = formData.max_raise_step_percent ?? 2;
        ruleData.only_raise_when_buybox_owner = formData.only_raise_when_buybox_owner ?? true;
        // Monopoly Mode — was collected into formData by AiRuleBuilder (both
        // via smart_profile presets and the user-facing toggle/dropdowns) but
        // never actually written here, so every rule silently kept whatever
        // the enable_monopoly_mode column's DB default was regardless of the
        // selected preset or any manual toggle.
        ruleData.enable_monopoly_mode = (formData as any).enable_monopoly_mode ?? true;
        ruleData.monopoly_mode_type = (formData as any).monopoly_mode_type ?? 'conservative';
        ruleData.monopoly_raise_step_dollars = (formData as any).monopoly_raise_step_dollars ?? 0.10;
        ruleData.monopoly_raise_step_percent = (formData as any).monopoly_raise_step_percent ?? 1;
        ruleData.monopoly_cooldown_minutes = (formData as any).monopoly_cooldown_minutes ?? 60;
        // Competitor Quality Filtering (NEW)
        ruleData.min_seller_rating = (formData as any).min_seller_rating ?? 80;
        ruleData.max_handling_days = (formData as any).max_handling_days ?? 2;
        ruleData.ships_from_filter = (formData as any).ships_from_filter ?? 'ANY';
        ruleData.top_n_competitors = (formData as any).top_n_competitors ?? 8;
        ruleData.competitor_quality_preset = (formData as any).competitor_quality_preset ?? 'balanced';
        // Age Overlay — disabled, force off
        ruleData.age_overlay_enabled = false;
        // Stock-Aware Aggression Overlay
        ruleData.stock_overlay_enabled = (formData as any).stock_overlay_enabled ?? false;
        ruleData.velocity_weight_7d = (formData as any).velocity_weight_7d ?? 0.6;
        ruleData.velocity_weight_30d = (formData as any).velocity_weight_30d ?? 0.4;
        ruleData.stock_threshold_critical = (formData as any).stock_threshold_critical ?? 7;
        ruleData.stock_threshold_low = (formData as any).stock_threshold_low ?? 30;
        ruleData.stock_threshold_healthy_max = (formData as any).stock_threshold_healthy_max ?? 90;
        ruleData.stock_threshold_heavy = (formData as any).stock_threshold_heavy ?? 180;
        ruleData.stock_modifier_critical = (formData as any).stock_modifier_critical ?? 0.75;
        ruleData.stock_modifier_low = (formData as any).stock_modifier_low ?? 0.85;
        ruleData.stock_modifier_normal = (formData as any).stock_modifier_normal ?? 1.0;
        ruleData.stock_modifier_heavy = (formData as any).stock_modifier_heavy ?? 1.10;
        ruleData.stock_modifier_overstock = (formData as any).stock_modifier_overstock ?? 1.30;
        // Oscillation Handling
        ruleData.oscillation_mode = (formData as any).oscillation_mode ?? 'auto';
        ruleData.oscillation_cooldown_minutes = (formData as any).oscillation_cooldown_minutes ?? 20;
        ruleData.oscillation_max_reactions = (formData as any).oscillation_max_reactions ?? 0;
        ruleData.oscillation_bb_loss_limit = (formData as any).oscillation_bb_loss_limit ?? 1;
        // Persist AI style in ai_settings JSONB
        if (ruleData.oscillation_mode === 'auto') {
          ruleData.ai_settings = { ...ruleData.ai_settings, oscillation_ai_style: (formData as any).oscillation_ai_style ?? 'balanced' };
        }
        // Auto Floor (per-rule)
        ruleData.enable_auto_floor = (formData as any).enable_auto_floor ?? true;
        ruleData.war_protection_minutes = (formData as any).war_protection_minutes ?? 30;
        // Min ROI Protection
        ruleData.min_roi_enabled = (formData as any).min_roi_enabled ?? false;
        ruleData.min_roi_enabled_marketplace_overrides = (formData as any).min_roi_enabled_marketplace_overrides ?? {};
        ruleData.min_roi_marketplace_overrides = (formData as any).min_roi_marketplace_overrides ?? {};
        // Strategy Engine — Dynamic Floor Relaxation (Milestone B). Default OFF.
        ruleData.enable_dynamic_floor_relaxation = (formData as any).enable_dynamic_floor_relaxation === true;
      }

      if (editingRule) {
        const { error } = await supabase
          .from("repricer_rules")
          .update(ruleData)
          .eq("id", editingRule.id);

        if (error) throw error;
        toast.success("Rule updated");
      } else {
        const { data: inserted, error } = await supabase.from("repricer_rules").insert(ruleData).select("id").single();

        if (error) throw error;

        // If this is the user's first rule, auto-set it as the default in user_settings
        if (rules.length === 0 && inserted?.id && user) {
          await supabase.from("user_settings").upsert({
            user_id: user.id,
            auto_assign_enabled: true,
            auto_assign_rule_id: inserted.id,
          }, { onConflict: "user_id" });
        }

        toast.success("Rule created");
      }

      setDialogOpen(false);
      fetchRules();
      onRulesChange?.();
    } catch (error: any) {
      toast.error("Failed to save rule: " + error.message);
    } finally {
      setSaving(false);
    }
  };

  const getNextRuleName = (baseName: string) => {
    const existingNames = rules.map(r => r.name);
    if (!existingNames.includes(baseName)) return baseName;
    let i = 1;
    while (existingNames.includes(`${baseName}(${i})`)) i++;
    return `${baseName}(${i})`;
  };

  const getStrategyLabel = (value: string) => {
    if (value === "AI_WIN_SALES_BOOSTER") return "AI Win Sales Booster";
    return STRATEGIES.find((s) => s.value === value)?.label || value;
  };

  const handleAiSettingsChange = (settings: AiRuleSettings) => {
    setFormData((prev) => {
      const updated = { ...prev, ...settings };
      // Auto-name the rule based on the selected profile (only for non-custom, non-edit rules)
      if (settings.smart_profile && !editingRule && !isCustomRule) {
        const profile = SMART_PROFILES.find(p => p.value === settings.smart_profile);
        if (profile) {
          updated.name = getNextRuleName(profile.label);
        }
      }
      return updated;
    });
  };

  const aiRules = rules.filter(r => r.strategy === "AI_WIN_SALES_BOOSTER");
  const standardRules = rules.filter(r => r.strategy !== "AI_WIN_SALES_BOOSTER");

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-lg flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-purple-500" />
          Choose the result you want
        </CardTitle>
        <p className="text-xs text-muted-foreground/70 mb-4">Pick one — you can change it anytime.</p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {SMART_PROFILES.filter(p => !p.advanced && !p.legacy).map((profile) => (
            <button
              key={profile.value}
              onClick={() => {
                const preset = PROFILE_PRESETS[profile.value as SmartProfile] || {};
                const autoMarketplaces = [...authorizedMarketplaces];
                setEditingRule(null);
                setRuleType("ai");
                setIsCustomRule(false);
                setFormData({
                  ...defaultAiRule,
                  ...preset,
                  smart_profile: profile.value,
                  name: getNextRuleName(profile.label),
                  marketplaces: autoMarketplaces,
                } as any);
                setDialogOpen(true);
              }}
              className={`relative p-4 rounded-lg border text-left transition-all cursor-pointer ${
                profile.recommended 
                  ? 'border-primary/50 bg-primary/[0.07] ring-1 ring-primary/15 shadow-[0_0_15px_-3px_hsl(var(--primary)/0.25)] scale-[1.02] hover:border-primary/70 hover:bg-primary/10 hover:shadow-[0_0_20px_-3px_hsl(var(--primary)/0.35)]' 
                  : 'border-border hover:border-primary/40 hover:bg-muted/50'
              }`}
            >
              {profile.recommended && (
                <div className="absolute top-2.5 right-2.5 px-2 py-0.5 bg-primary/90 text-primary-foreground text-[9px] font-semibold rounded-md">
                  ⭐ Recommended
                </div>
              )}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">{profile.icon}</span>
                <span className="font-semibold text-sm">{profile.label}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {profile.safetyScore != null && (
                  <Badge variant="outline" className={`text-[9px] px-1.5 py-0 border-0 ${
                    profile.safetyScore >= 7 ? 'bg-green-600 text-white' :
                    profile.safetyScore >= 5 ? 'bg-amber-600 text-white' :
                    'bg-destructive text-destructive-foreground'
                  }`}>
                    🛡️ Safety: {profile.safetyScore}/10
                  </Badge>
                )}
                {profile.salesImpactLabel && (
                  <Badge variant="outline" className={`text-[9px] px-1.5 py-0 border-0 ${
                    profile.salesImpactLevel === 'strong' ? 'bg-green-600 text-white' :
                    profile.salesImpactLevel === 'balanced' ? 'bg-amber-600 text-white' :
                    profile.salesImpactLevel === 'clearance' ? 'bg-orange-600 text-white' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    ⚡ {profile.salesImpactLabel}
                  </Badge>
                )}
              </div>
              {profile.salesImpactDesc && (
                <p className="text-[10px] text-muted-foreground/80 mb-1.5">{profile.salesImpactDesc}</p>
              )}
              <div className="flex items-center gap-3 mb-1.5">
                <div className="flex items-center gap-1">
                  <TrendingUp className="h-3 w-3 text-green-500" />
                  <div className="flex">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} className={`h-2.5 w-2.5 ${i < profile.salesStars ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground/40'}`} />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Shield className="h-3 w-3 text-blue-500" />
                  <div className="flex">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} className={`h-2.5 w-2.5 ${i < profile.profitStars ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground/40'}`} />
                    ))}
                  </div>
                </div>
              </div>
              {profile.microLabel && (
                <p className="text-[11px] font-medium text-foreground/80 mb-0.5">{profile.microLabel}</p>
              )}
              <p className="text-xs text-muted-foreground mb-1.5 line-clamp-2">{profile.description}</p>
              <p className="text-[10px] text-muted-foreground/70 italic">Best for: {profile.bestFor}</p>
            </button>
          ))}
          {/* Advanced Custom Rule card - admin only */}
          {isAdmin && (
            <button
              onClick={() => openCreateDialog("standard", true)}
              className="relative p-3 rounded-lg border border-dashed border-muted-foreground/30 hover:border-primary/40 hover:bg-muted/50 text-left transition-all flex flex-col items-center justify-center gap-2"
            >
              <Settings2 className="h-6 w-6 text-muted-foreground" />
              <span className="font-medium text-sm text-muted-foreground">⚙️ Advanced Custom</span>
              <p className="text-[10px] text-muted-foreground/70 text-center">Full control over every setting</p>
            </button>
          )}
        </div>
        <div className="mt-3">
          <PresetComparisonDialog />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">
            Loading rules...
          </div>
        ) : rules.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No rules yet. Create your first pricing rule to get started.
          </div>
        ) : (
          <div className="space-y-4">
            {/* AI Rules Section */}
            {aiRules.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  AI-Powered Rules
                </h4>
                <div className="space-y-2">
                  {aiRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between p-4 border rounded-lg bg-gradient-to-r from-purple-500/5 to-blue-500/5 border-purple-500/20 hover:border-purple-500/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Button
                          variant={rule.is_enabled ? "default" : "destructive"}
                          size="sm"
                          onClick={() => toggleRuleEnabled(rule.id, !rule.is_enabled)}
                          className="gap-1"
                        >
                          {rule.is_enabled ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                          {rule.is_enabled ? "Active" : "Paused"}
                        </Button>
                        <div className="p-2 bg-purple-500/10 rounded-lg">
                          <Sparkles className="h-4 w-4 text-purple-500" />
                        </div>
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {renamingRuleId === rule.id ? (
                              <Input
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={() => saveRename(rule.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveRename(rule.id); if (e.key === 'Escape') setRenamingRuleId(null); }}
                                autoFocus
                                className="h-6 text-sm w-40 px-1"
                              />
                            ) : (
                              <span
                                onClick={() => startRename(rule)}
                                className="cursor-pointer hover:underline hover:text-primary transition-colors"
                                title="Click to rename"
                              >
                                {rule.name}
                              </span>
                            )}
                            {(() => {
                              const profile = (rule as any).smart_profile && (rule as any).smart_profile !== 'CUSTOM' ? SMART_PROFILES.find(p => p.value === (rule as any).smart_profile) : null;
                              return profile ? (
                                <Badge variant="secondary" className="bg-purple-500/20 text-purple-700 text-xs">
                                  {profile.icon} {profile.label}
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="bg-gray-500/20 text-gray-600 text-xs">
                                  ⚙️ Custom
                                </Badge>
                              );
                            })()}
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
                            <span>{getRuleUndercutSummary(rule)}</span>
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              {getSuppressedBbUndercutSummary(rule)}
                            </Badge>
                            {(() => {
                              const profile = SMART_PROFILES.find(p => p.value === (rule as any).smart_profile);
                              if (!profile) return null;
                              const safetyColor = (profile.safetyScore ?? 5) >= 7 ? 'text-green-600 bg-green-500/10 border-green-500/20' 
                                : (profile.safetyScore ?? 5) >= 4 ? 'text-yellow-600 bg-yellow-500/10 border-yellow-500/20' 
                                : 'text-red-600 bg-red-500/10 border-red-500/20';
                              const salesColor = profile.salesImpactLevel === 'strong' ? 'text-green-600 bg-green-500/10 border-green-500/20'
                                : profile.salesImpactLevel === 'balanced' ? 'text-blue-600 bg-blue-500/10 border-blue-500/20'
                                : profile.salesImpactLevel === 'clearance' ? 'text-red-600 bg-red-500/10 border-red-500/20'
                                : 'text-yellow-600 bg-yellow-500/10 border-yellow-500/20';
                              return (
                                <>
                                  <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${safetyColor}`}>
                                    🛡️ {profile.safetyScore ?? '?'}/10
                                  </Badge>
                                  {profile.salesImpactLabel && (
                                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${salesColor}`}>
                                      ⚡ {profile.salesImpactLabel}
                                    </Badge>
                                  )}
                                </>
                              );
                            })()}
                            {/* Show behavior mode badge */}
                            {(() => {
                              const oscMode = (rule as any).oscillation_mode || (rule.ai_settings as any)?.oscillation_mode;
                              if (oscMode === 'safe') return <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-green-500/10 text-green-600 border-green-500/20">🕊️ Safe</Badge>;
                              if (oscMode === 'balanced') return <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-blue-500/10 text-blue-600 border-blue-500/20">⚖️ Balanced</Badge>;
                              if (oscMode === 'aggressive') return <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-orange-500/10 text-orange-600 border-orange-500/20">⚔️ Aggressive</Badge>;
                              return null;
                            })()}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {rule.is_default && (
                          <Badge className="text-[10px] bg-amber-500/20 text-amber-700 border-amber-500/40 border">
                            ⭐ Default
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className="text-xs"
                          title={(() => {
                            const c = assignmentCounts[rule.id];
                            if (!c) return "No assignments";
                            // The badge leads with IN-STOCK because that is what
                            // the Repricer grid shows -- it hides rows with no
                            // available stock. Leading with the total made the
                            // card disagree with the screen underneath it by
                            // more than 2x (18 against 8 on this rule), which is
                            // worse than showing no number at all.
                            //
                            // Assignments are per (asin, marketplace), so that
                            // figure is usually a multiple of the ASIN count.
                            return `${c.in_stock_asins} ASINs with available stock — what the grid shows\n`
                                 + `${c.enabled_asins} enabled · ${c.distinct_asins} total ASINs\n`
                                 + `${c.assignments} assignments across marketplaces (${c.enabled_assignments} enabled)`;
                          })()}
                        >
                          {assignmentCounts[rule.id]?.in_stock_asins ?? 0} ASINs
                        </Badge>
                        {(rule as any).daypart_enabled && (
                          <Badge
                            variant="outline"
                            className="text-xs border-amber-500/50 text-amber-600 dark:text-amber-400 cursor-pointer hover:bg-amber-500/10"
                            title={`Power Hours ${(rule as any).daypart_start}–${(rule as any).daypart_end}, undercut $${Number((rule as any).daypart_undercut_amount ?? 0).toFixed(2)}. Click to apply this window to every other rule.`}
                            onClick={(e) => { e.stopPropagation(); applyDaypartToAllRules(rule); }}
                          >
                            ⏰ {(rule as any).daypart_start}–{(rule as any).daypart_end}
                          </Badge>
                        )}
                        <div className="flex gap-1 mr-2">
                          {rule.marketplaces?.map((mp) => (
                            <Badge key={mp} variant="secondary" className="text-xs">
                              {mp}
                            </Badge>
                          ))}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRuleAsDefault(rule.id)}
                          disabled={!!rule.is_default}
                          title={rule.is_default ? "This is the default rule for new ASINs" : "Set as default for new ASINs"}
                          className={rule.is_default ? "text-amber-500" : "text-muted-foreground hover:text-amber-500"}
                        >
                          <Star className={`h-4 w-4 ${rule.is_default ? 'fill-amber-500' : ''}`} />
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(rule)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => duplicateRule(rule)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmRuleId(rule.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Standard Rules Section */}
            {standardRules.length > 0 && (
              <div className="space-y-2">
                {aiRules.length > 0 && (
                  <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2 mt-4">
                    <Settings2 className="h-4 w-4" />
                    Standard Rules
                  </h4>
                )}
                <div className="space-y-2">
                  {standardRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between p-3 border rounded-lg bg-card hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Button
                          variant={rule.is_enabled ? "default" : "destructive"}
                          size="sm"
                          onClick={() => toggleRuleEnabled(rule.id, !rule.is_enabled)}
                          className="gap-1"
                        >
                          {rule.is_enabled ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                          {rule.is_enabled ? "Active" : "Paused"}
                        </Button>
                        <div>
                          <div className="font-medium">
                            {renamingRuleId === rule.id ? (
                              <Input
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={() => saveRename(rule.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveRename(rule.id); if (e.key === 'Escape') setRenamingRuleId(null); }}
                                autoFocus
                                className="h-6 text-sm w-40 px-1"
                              />
                            ) : (
                              <span
                                onClick={() => startRename(rule)}
                                className="cursor-pointer hover:underline hover:text-primary transition-colors"
                                title="Click to rename"
                              >
                                {rule.name}
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                            <span>{getStrategyLabel(rule.strategy)} • {getRuleUndercutSummary(rule)}</span>
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              {getSuppressedBbUndercutSummary(rule)}
                            </Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {rule.is_default && (
                          <Badge className="text-[10px] bg-amber-500/20 text-amber-700 border-amber-500/40 border">
                            ⭐ Default
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className="text-xs"
                          title={(() => {
                            const c = assignmentCounts[rule.id];
                            if (!c) return "No assignments";
                            // The badge leads with IN-STOCK because that is what
                            // the Repricer grid shows -- it hides rows with no
                            // available stock. Leading with the total made the
                            // card disagree with the screen underneath it by
                            // more than 2x (18 against 8 on this rule), which is
                            // worse than showing no number at all.
                            //
                            // Assignments are per (asin, marketplace), so that
                            // figure is usually a multiple of the ASIN count.
                            return `${c.in_stock_asins} ASINs with available stock — what the grid shows\n`
                                 + `${c.enabled_asins} enabled · ${c.distinct_asins} total ASINs\n`
                                 + `${c.assignments} assignments across marketplaces (${c.enabled_assignments} enabled)`;
                          })()}
                        >
                          {assignmentCounts[rule.id]?.in_stock_asins ?? 0} ASINs
                        </Badge>
                        {(rule as any).daypart_enabled && (
                          <Badge
                            variant="outline"
                            className="text-xs border-amber-500/50 text-amber-600 dark:text-amber-400 cursor-pointer hover:bg-amber-500/10"
                            title={`Power Hours ${(rule as any).daypart_start}–${(rule as any).daypart_end}, undercut $${Number((rule as any).daypart_undercut_amount ?? 0).toFixed(2)}. Click to apply this window to every other rule.`}
                            onClick={(e) => { e.stopPropagation(); applyDaypartToAllRules(rule); }}
                          >
                            ⏰ {(rule as any).daypart_start}–{(rule as any).daypart_end}
                          </Badge>
                        )}
                        <div className="flex gap-1 mr-2">
                          {rule.marketplaces?.map((mp) => (
                            <Badge key={mp} variant="secondary" className="text-xs">
                              {mp}
                            </Badge>
                          ))}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRuleAsDefault(rule.id)}
                          disabled={!!rule.is_default}
                          title={rule.is_default ? "This is the default rule for new ASINs" : "Set as default for new ASINs"}
                          className={rule.is_default ? "text-amber-500" : "text-muted-foreground hover:text-amber-500"}
                        >
                          <Star className={`h-4 w-4 ${rule.is_default ? 'fill-amber-500' : ''}`} />
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(rule)}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => duplicateRule(rule)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmRuleId(rule.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Create/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className={ruleType === "ai" ? "max-w-4xl max-h-[90vh] overflow-y-auto" : "max-w-2xl max-h-[90vh] overflow-y-auto"}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {ruleType === "ai" && <Sparkles className="h-5 w-5 text-purple-500" />}
                {editingRule ? "Edit Rule" : isCustomRule ? "Create Custom Rule" : (() => {
                  const profile = SMART_PROFILES.find(p => p.value === (formData as any).smart_profile);
                  return profile ? `Create ${profile.icon} ${profile.label} Rule` : "Create AI Rule";
                })()}
              </DialogTitle>
            </DialogHeader>

            {ruleType === "ai" ? (
              <div className="space-y-4 py-4">
                {/* Rule Name */}
                <div className="grid gap-2">
                  <Label htmlFor="name">Rule Name</Label>
                  {editingRule ? (
                    <p className="text-sm font-medium py-2 px-3 rounded-md bg-muted">{formData.name}</p>
                  ) : isCustomRule ? (
                    <Input
                      id="name"
                      value={formData.name || ""}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      placeholder="e.g., My Custom Strategy"
                    />
                  ) : (
                    <p className="text-sm font-medium py-2 px-3 rounded-md bg-muted">{formData.name}</p>
                  )}
                </div>

                {/* Marketplaces */}
                <div className="grid gap-2">
                  <Label>Marketplaces</Label>
                  <div className="flex gap-2 flex-wrap">
                    {visibleMarketplaces.map((mp) => (
                      <Button
                        key={mp.value}
                        type="button"
                        variant={
                          formData.marketplaces?.includes(mp.value)
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        title={mp.value === homeMarketplace ? "Your primary marketplace" : undefined}
                        className={mp.value === homeMarketplace ? "ring-2 ring-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]" : ""}
                        onClick={() => {
                          const current = formData.marketplaces || [];
                          const updated = current.includes(mp.value)
                            ? current.filter((m) => m !== mp.value)
                            : [...current, mp.value];
                          setFormData({ ...formData, marketplaces: updated });
                        }}
                      >
                        {mp.value === homeMarketplace && <Star className="h-3 w-3 fill-amber-400 text-amber-400 mr-1" />}
                        {mp.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Behavior Mode — Oscillation / Price War Protection */}
                {/* Oscillation Handling is now inside AiRuleBuilder component */}

                {/* Marketplace Scheduling Policy */}
                <MarketplaceScheduleEditor
                  marketplaces={formData.marketplaces || ["US"]}
                  schedule={(formData.marketplace_schedule as MarketplaceScheduleMap) || {}}
                  onChange={(schedule) => setFormData({ ...formData, marketplace_schedule: schedule })}
                />

                {/* AI Rule Builder */}
                <AiRuleBuilder
                  settings={{
                    smart_profile: ((formData as any).smart_profile || 'MOMENTUM_BUILDER') as any,
                    when_only_seller: formData.when_only_seller || "CUSTOM_PRICE",
                    when_not_buybox_eligible: formData.when_not_buybox_eligible || "CUSTOM_PRICE",
                    when_buybox_suppressed: formData.when_buybox_suppressed || "AI_REPRICE",
                    when_condition_used: formData.when_condition_used || "AI_REPRICE",
                    when_backordered: formData.when_backordered || "MIN_PRICE",
                    when_below_min_price: formData.when_below_min_price || "MIN_PRICE",
                    compete_with_amazon: formData.compete_with_amazon ?? true,
                    compete_with_fba: formData.compete_with_fba ?? true,
                    compete_with_fbm: formData.compete_with_fbm ?? false,
                    fulfillment_filter: (formData.fulfillment_filter as "FBA" | "FBM" | "BOTH") ?? "FBA",
                    min_price: formData.min_price ?? null,
                    max_price: formData.max_price ?? null,
                    undercut_amount: formData.undercut_amount ?? 0,
                    // Power Hours must be listed here explicitly. This prop is a
                    // whitelist rebuilt on EVERY render, so a field left out is
                    // read back as undefined -- the checkbox renders unchecked,
                    // snaps back the instant it is clicked, and looks like a dead
                    // control rather than a missing mapping.
                    daypart_enabled: (formData as any).daypart_enabled ?? false,
                    daypart_start: (formData as any).daypart_start ?? null,
                    daypart_end: (formData as any).daypart_end ?? null,
                    daypart_undercut_amount: (formData as any).daypart_undercut_amount ?? null,
                    fbm_undercut_amount: formData.fbm_undercut_amount ?? null,
                    suppressed_bb_undercut: formData.suppressed_bb_undercut ?? null,
                    undercut_mode: ((formData as any).undercut_mode ?? (formData.ai_settings as any)?.undercut_mode ?? 'managed'),
                    max_step_amount: formData.max_step_amount ?? 0.50,
                    max_step_percent: formData.max_step_percent ?? 5,
                    cooldown_minutes: formData.cooldown_minutes ?? 15,
                    use_ai_tuning: formData.use_ai_tuning ?? true,
                    // Profit Guard settings
                    enable_profit_guard: formData.enable_profit_guard ?? true,
                    profit_guard_mode: formData.profit_guard_mode ?? 'strict',
                    min_profit_dollars: formData.min_profit_dollars ?? null,
                    min_roi_percent: formData.min_roi_percent ?? null,
                    min_roi_percent_base: formData.min_roi_percent_base ?? 20,
                    min_roi_percent_high_risk: formData.min_roi_percent_high_risk ?? 35,
                    high_risk_seller_count_threshold: formData.high_risk_seller_count_threshold ?? 8,
                    enable_dynamic_roi: formData.enable_dynamic_roi ?? true,
                    include_fees_in_floor: formData.include_fees_in_floor ?? true,
                    block_auto_apply_if_cost_missing: formData.block_auto_apply_if_cost_missing ?? true,
                    // Auto-Exit/Reenter settings
                    enable_auto_exit_reenter: formData.enable_auto_exit_reenter ?? true,
                    reenter_buffer_percent: formData.reenter_buffer_percent ?? 2,
                    cooldown_minutes_on_floor: formData.cooldown_minutes_on_floor ?? 360,
                    max_drop_per_run_cents: formData.max_drop_per_run_cents ?? 30,
                    snapshot_ttl_minutes: formData.snapshot_ttl_minutes ?? 360,
                    // Smart Raise settings
                    enable_smart_raise: formData.enable_smart_raise ?? true,
                    raise_trigger_percent: formData.raise_trigger_percent ?? 2,
                    max_raise_step_dollars: formData.max_raise_step_dollars ?? 0.25,
                    max_raise_step_percent: formData.max_raise_step_percent ?? 2,
                    only_raise_when_buybox_owner: formData.only_raise_when_buybox_owner ?? true,
                    // Buy Box Owner Protection
                    skip_lower_when_bb_owner: formData.skip_lower_when_bb_owner ?? true,
                    // Monopoly Mode
                    enable_monopoly_mode: formData.enable_monopoly_mode ?? true,
                    monopoly_raise_step_dollars: formData.monopoly_raise_step_dollars ?? 0.10,
                    monopoly_raise_step_percent: formData.monopoly_raise_step_percent ?? 1,
                    monopoly_cooldown_minutes: formData.monopoly_cooldown_minutes ?? 60,
                    monopoly_mode_type: (formData.monopoly_mode_type as 'conservative' | 'aggressive') ?? 'conservative',
                     // FBM Handling
                     ignore_fbm_unless_buybox_owner: formData.ignore_fbm_unless_buybox_owner ?? true,
                     fbm_competition_mode: ((formData as any).fbm_competition_mode
                       ?? (formData.ai_settings as any)?.fbm_competition_mode
                       ?? ((formData.ignore_fbm_unless_buybox_owner ?? false) ? 'fba_priority' : 'all_sellers')) as 'fba_priority' | 'all_sellers' | 'lowest_seller',
                    target_anchor: ((formData as any).target_anchor || 'smart') as 'buybox' | 'lowest_fba' | 'lowest_offer' | 'smart' | 'smart_recapture',
                    // Competitor Quality Filtering (NEW)
                    min_seller_rating: (formData as any).min_seller_rating ?? 80,
                    max_handling_days: (formData as any).max_handling_days ?? 2,
                    ships_from_filter: ((formData as any).ships_from_filter || 'ANY') as 'US_ONLY' | 'DOMESTIC' | 'ANY',
                    top_n_competitors: (formData as any).top_n_competitors ?? 8,
                    competitor_quality_preset: ((formData as any).competitor_quality_preset || 'balanced') as 'conservative' | 'balanced' | 'aggressive' | 'custom',
                    // Stock-Aware Aggression Overlay
                    // Stock-Aware Aggression Overlay
                    stock_overlay_enabled: (formData as any).stock_overlay_enabled ?? false,
                    velocity_weight_7d: (formData as any).velocity_weight_7d ?? 0.6,
                    velocity_weight_30d: (formData as any).velocity_weight_30d ?? 0.4,
                    stock_threshold_critical: (formData as any).stock_threshold_critical ?? 7,
                    stock_threshold_low: (formData as any).stock_threshold_low ?? 30,
                    stock_threshold_healthy_max: (formData as any).stock_threshold_healthy_max ?? 90,
                    stock_threshold_heavy: (formData as any).stock_threshold_heavy ?? 180,
                    stock_modifier_critical: (formData as any).stock_modifier_critical ?? 0.75,
                    stock_modifier_low: (formData as any).stock_modifier_low ?? 0.85,
                    stock_modifier_normal: (formData as any).stock_modifier_normal ?? 1.0,
                    stock_modifier_heavy: (formData as any).stock_modifier_heavy ?? 1.10,
                    stock_modifier_overstock: (formData as any).stock_modifier_overstock ?? 1.30,
                    // Oscillation Handling
                    oscillation_mode: ((formData as any).oscillation_mode || 'auto') as 'auto' | 'safe' | 'balanced' | 'aggressive',
                    oscillation_ai_style: ((formData as any).oscillation_ai_style ?? (formData.ai_settings as any)?.oscillation_ai_style ?? 'balanced') as 'conservative' | 'balanced' | 'aggressive',
                    oscillation_cooldown_minutes: (formData as any).oscillation_cooldown_minutes ?? 20,
                    oscillation_max_reactions: (formData as any).oscillation_max_reactions ?? 0,
                    oscillation_bb_loss_limit: (formData as any).oscillation_bb_loss_limit ?? 1,
                    // Auto Floor (per-rule)
                    enable_auto_floor: (formData as any).enable_auto_floor ?? true,
                    war_protection_minutes: (formData as any).war_protection_minutes ?? 30,
                    // Min ROI Protection
                    min_roi_enabled: (formData as any).min_roi_enabled ?? false,
                    min_roi_enabled_marketplace_overrides: (formData as any).min_roi_enabled_marketplace_overrides ?? {},
                    min_roi_marketplace_overrides: (formData as any).min_roi_marketplace_overrides ?? {},
                    enable_dynamic_floor_relaxation: (formData as any).enable_dynamic_floor_relaxation === true,
                   }}
                   onChange={handleAiSettingsChange}
                   hideProfileSelector={isCustomRule || (!editingRule && !isCustomRule)}
                   ruleId={editingRule?.id ?? null}
                   isCustomRule={isCustomRule}
                 />
              </div>
            ) : (
              <div className="grid gap-4 py-4">
                {/* Standard Rule Form */}
                {/* Rule Name */}
                <div className="grid gap-2">
                  <Label htmlFor="name">Rule Name</Label>
                  {editingRule ? (
                    <p className="text-sm font-medium py-2 px-3 rounded-md bg-muted">{formData.name}</p>
                  ) : (
                    <Input
                      id="name"
                      value={formData.name || ""}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      placeholder="e.g., Aggressive FBA Undercut"
                    />
                  )}
                </div>

                {/* Strategy */}
                <div className="grid gap-2">
                  <Label>Pricing Strategy</Label>
                  <Select
                    value={formData.strategy}
                    onValueChange={(val) =>
                      setFormData({ ...formData, strategy: val })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STRATEGIES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                      <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground border-t mt-1 pt-1">
                        Basic Rules (fast, low compute)
                      </div>
                      {BASIC_STRATEGIES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Undercut Amount (FBA) */}
                <div className="grid gap-2">
                  <Label htmlFor="undercut">FBA Undercut Amount ({homeCurrencySymbol})</Label>
                  <p className="text-xs text-muted-foreground">
                    Applied when your listing is <strong>FBA</strong>. Used to undercut FBA competitors / Buy Box.
                  </p>
                  <Input
                    id="undercut"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.undercut_amount ?? 0.01}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        undercut_amount: isNaN(parseFloat(e.target.value)) ? 0 : parseFloat(e.target.value),
                      })
                    }
                  />
                </div>

                {/* FBM Undercut Amount */}
                <div className="grid gap-2">
                  <Label htmlFor="fbm-undercut">FBM Undercut Amount ({homeCurrencySymbol})</Label>
                  <p className="text-xs text-muted-foreground">
                    Applied only when your listing is <strong>FBM</strong> and competing against the lowest FBM seller. Leave blank to reuse the FBA undercut. Enter <code>0.00</code> to match the lowest FBM exactly.
                  </p>
                  <Input
                    id="fbm-undercut"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="(uses FBA undercut)"
                    value={formData.fbm_undercut_amount ?? ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        fbm_undercut_amount: e.target.value === "" ? null : (isNaN(parseFloat(e.target.value)) ? null : parseFloat(e.target.value)),
                      })
                    }
                  />
                </div>

                {/* FBM Competition Mode */}
                <div className="grid gap-2 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5">
                  <Label htmlFor="fbm-competition-mode" className="font-medium">FBM Competition Mode</Label>
                  <p className="text-xs text-muted-foreground">
                    Controls how an <strong>FBM</strong> listing competes with other FBM sellers.
                  </p>
                  <Select
                    value={
                      (formData as any).fbm_competition_mode
                        ?? (formData.ignore_fbm_unless_buybox_owner ? 'fba_priority' : 'all_sellers')
                    }
                    onValueChange={(v) => {
                      const mode = v as 'fba_priority' | 'all_sellers' | 'lowest_seller';
                      const isFbaPriority = mode === 'fba_priority';
                      setFormData({
                        ...formData,
                        fbm_competition_mode: mode,
                        ignore_fbm_unless_buybox_owner: isFbaPriority,
                      } as any);
                    }}
                  >
                    <SelectTrigger id="fbm-competition-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fba_priority">🛡️ FBA Priority — Ignore FBM unless they own Buy Box</SelectItem>
                      <SelectItem value="all_sellers">⚡ All Sellers (Aggressive) — Treat FBM same as FBA</SelectItem>
                      <SelectItem value="lowest_seller">🥊 Lowest Seller — Always chase the cheapest seller (no BB requirement)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* Suppressed Buy Box Undercut — REQUIRED, no default */}
                <div className="grid gap-2 p-3 rounded-lg border-2 border-blue-500/40 bg-blue-950/30">
                  <Label htmlFor="suppressed-bb-undercut" className="font-bold flex items-center gap-2">
                    🚫 Suppressed Buy Box Undercut ({homeCurrencySymbol}) <span className="text-xs font-normal text-amber-400">— required</span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When the Amazon Buy Box is <strong>suppressed</strong>, undercut the lowest valid competitor by this amount. <strong>You decide</strong> — there is no default. Enter <code>0.00</code> to match exactly.
                  </p>
                  <Input
                    id="suppressed-bb-undercut"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Enter amount (e.g. 0.01 or 0.00)"
                    value={formData.suppressed_bb_undercut == null ? "" : formData.suppressed_bb_undercut}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") {
                        setFormData({ ...formData, suppressed_bb_undercut: null });
                        return;
                      }
                      const v = parseFloat(raw);
                      setFormData({
                        ...formData,
                        suppressed_bb_undercut: isNaN(v) ? null : Math.max(0, v),
                      });
                    }}
                  />
                  {(formData.suppressed_bb_undercut == null) && (
                    <p className="text-xs text-amber-400">⚠️ Required — suppressed-BB pricing will be skipped until you set a value.</p>
                  )}
                </div>

                {/* Marketplaces */}
                <div className="grid gap-2">
                  <Label>Marketplaces</Label>
                  <div className="flex gap-2 flex-wrap">
                    {visibleMarketplaces.map((mp) => (
                      <Button
                        key={mp.value}
                        type="button"
                        variant={
                          formData.marketplaces?.includes(mp.value)
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        title={mp.value === homeMarketplace ? "Your primary marketplace" : undefined}
                        className={mp.value === homeMarketplace ? "ring-2 ring-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]" : ""}
                        onClick={() => {
                          const current = formData.marketplaces || [];
                          const updated = current.includes(mp.value)
                            ? current.filter((m) => m !== mp.value)
                            : [...current, mp.value];
                          setFormData({ ...formData, marketplaces: updated });
                        }}
                      >
                        {mp.value === homeMarketplace && <Star className="h-3 w-3 fill-amber-400 text-amber-400 mr-1" />}
                        {mp.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Marketplace Scheduling Policy */}
                <MarketplaceScheduleEditor
                  marketplaces={formData.marketplaces || ["US"]}
                  schedule={(formData.marketplace_schedule as MarketplaceScheduleMap) || {}}
                  onChange={(schedule) => setFormData({ ...formData, marketplace_schedule: schedule })}
                />

                <div className="grid grid-cols-2 gap-4">
                  {/* Fulfillment Scope */}
                  <div className="grid gap-2">
                    <Label>Fulfillment Scope</Label>
                    <Select
                      value={formData.fulfillment_scope}
                      onValueChange={(val) =>
                        setFormData({ ...formData, fulfillment_scope: val })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FULFILLMENT_SCOPES.map((f) => (
                          <SelectItem key={f.value} value={f.value}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Condition Scope */}
                  <div className="grid gap-2">
                    <Label>Condition Scope</Label>
                    <Select
                      value={formData.condition_scope}
                      onValueChange={(val) =>
                        setFormData({ ...formData, condition_scope: val })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CONDITION_SCOPES.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                </div>

                {/* Target Anchor */}
                <div className="grid gap-2">
                  <Label>Target Price Anchor</Label>
                  <Select
                    value={formData.target_anchor || "smart"}
                    onValueChange={(val) =>
                      setFormData({ ...formData, target_anchor: val })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TARGET_ANCHORS.map((a) => (
                        <SelectItem key={a.value} value={a.value}>
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {formData.target_anchor === "buybox" && "Anchor to Buy Box price — best for profit margin"}
                    {formData.target_anchor === "smart_recapture" && "Smart when you're lowest; switches to Lowest FBA when a cheaper FBA competitor exists — best for recapture"}
                    {formData.target_anchor === "lowest_fba" && "Anchor to lowest FBA offer — ignores FBM sellers"}
                    {formData.target_anchor === "lowest_offer" && "Anchor to absolute lowest offer — most aggressive"}
                    {(!formData.target_anchor || formData.target_anchor === "smart") && "Auto: Buy Box when available, falls back to Lowest FBA"}
                  </p>
                </div>
                </div>

                {/* Price Limits */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="minPrice">Min Price ({homeCurrencySymbol})</Label>
                    <Input
                      id="minPrice"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.min_price ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          min_price: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        })
                      }
                      placeholder="Floor price"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="maxPrice">Max Price ({homeCurrencySymbol})</Label>
                    <Input
                      id="maxPrice"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.max_price ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          max_price: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        })
                      }
                      placeholder="Ceiling price"
                    />
                  </div>
                </div>

                {/* Floor Source */}
                <div className="grid gap-2">
                  <Label>Floor Source</Label>
                  <Select
                    value={formData.floor_source}
                    onValueChange={(val) =>
                      setFormData({ ...formData, floor_source: val })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FLOOR_SOURCES.map((f) => (
                        <SelectItem key={f.value} value={f.value}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Min Profit (if cost_plus) */}
                {formData.floor_source === "cost_plus" && (
                  <div className="grid gap-2">
                    <Label htmlFor="minProfit">Min Profit ({homeCurrencySymbol})</Label>
                    <Input
                      id="minProfit"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.min_profit ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          min_profit: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        })
                      }
                      placeholder="Minimum profit above cost"
                    />
                  </div>
                )}

                {/* Min ROI (if roi_based) */}
                {formData.floor_source === "roi_based" && (
                  <div className="grid gap-2">
                    <Label htmlFor="minRoi">Min ROI (%)</Label>
                    <Input
                      id="minRoi"
                      type="number"
                      step="1"
                      min="0"
                      value={formData.min_roi ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          min_roi: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        })
                      }
                      placeholder="e.g., 30 for 30% ROI"
                    />
                  </div>
                )}

                {/* Safety Limits */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="maxChange">Max Change Per Update (%)</Label>
                    <Input
                      id="maxChange"
                      type="number"
                      step="1"
                      min="1"
                      max="100"
                      value={formData.max_change_percent ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          max_change_percent: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        })
                      }
                      placeholder="e.g., 10"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="minThreshold">Min Change Threshold ({homeCurrencySymbol})</Label>
                    <Input
                      id="minThreshold"
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.min_change_threshold ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          min_change_threshold: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        })
                      }
                      placeholder="e.g., 0.01"
                    />
                  </div>
                </div>

                {/* Target Sellers (for BEAT_SPECIFIC_SELLER strategy) */}
                {formData.strategy === "BEAT_SPECIFIC_SELLER_MINUS" && (
                  <div className="grid gap-2">
                    <Label htmlFor="targetSellers">Target Seller IDs (comma-separated)</Label>
                    <Input
                      id="targetSellers"
                      value={formData.target_seller_ids?.join(", ") || ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          target_seller_ids: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="e.g., A123ABC, B456DEF"
                    />
                  </div>
                )}

                {/* Excluded Sellers */}
                <div className="grid gap-2">
                  <Label htmlFor="excludedSellers">
                    Excluded Seller IDs (comma-separated)
                  </Label>
                  <Input
                    id="excludedSellers"
                    value={formData.excluded_sellers?.join(", ") || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        excluded_sellers: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="Seller IDs to ignore"
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={saveRule} disabled={saving} className="gap-1">
                <Play className="h-4 w-4" />
                {saving ? "Saving..." : editingRule ? "Update & Run" : "Create & Run"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>

      <AlertDialog open={!!deleteConfirmRuleId} onOpenChange={(open) => !open && setDeleteConfirmRuleId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rule</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this rule? This action cannot be undone. Any assignments using this rule will be unlinked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteRule} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
