// Auto-lower-min control for the repricer header: one row per rule.
//
// ── PER-RULE SETTINGS (2026-09-18) ──────────────────────────────────────────
// The seller asked for the automation to be switched on INSIDE each rule, with
// a check interval they choose, because the VA does not check daily. Each rule
// now carries (repricer_rules, migrations 20260918070000 / 073000 / 074000):
//   * auto_lower_min_marketplaces     -- where it is on. Covers EVERY enabled
//                                        assignment on the rule, including
//                                        listings added later;
//   * auto_lower_min_interval_minutes -- check every 5..60 minutes;
//   * auto_lower_min_anchor           -- beat the lowest price or the Buy Box;
//   * auto_lower_min_undercut         -- lower by this much (default $0.01);
//   * auto_lower_min_max_drops_per_day-- replaces "5 drops per listing, ever",
//                                        which at a 5-minute interval would be
//                                        spent in 25 minutes and then stick.
// US only for now: the worker (repricer-auto-lower-min) refuses other
// marketplaces, and so does this control.
//
// WHY PER RULE, NOT ONE SWITCH
// The rules mean different things. "Momentum Builder" chases the Buy Box;
// "Equal No minimum Floor" is defined by not having a floor at all, so letting
// something lower its minimum automatically may be flatly wrong. Coverage is a
// decision per strategy, so the control is too.
//
// The per-assignment auto_lower_min_price flag is still written when a rule is
// switched, so older screens that read it stay truthful, but the worker no
// longer reads it: it was set once and never for new listings, so coverage
// decayed silently (206 of 678 on 2026-08-18).
//
// DEFAULT IS OFF, DELIBERATELY
// Automated floor-lowering moves real prices on a multi-tenant platform, so it
// is opt-in rather than something that starts happening to sellers who never
// asked.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, Loader2, ShieldCheck, TrendingDown } from "lucide-react";
import { toast } from "sonner";
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

interface Props {
  userId: string | undefined;
  marketplace: string;
  /** Fired after a successful change so the table can refetch. */
  onChanged?: () => void;
}

/** Marketplaces the worker acts in today. */
const SUPPORTED = ["US"];
const INTERVALS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

type Anchor = "lowest" | "buybox";

interface RuleSettings {
  ruleId: string;
  ruleName: string;
  /** Active assignments on this rule in this marketplace. */
  workable: number;
  on: boolean;
  marketplaces: string[];
  interval: number;
  maxPerDay: number;
  undercut: number;
  anchor: Anchor;
}

type SettingPatch = Partial<{
  auto_lower_min_interval_minutes: number;
  auto_lower_min_max_drops_per_day: number;
  auto_lower_min_undercut: number;
  auto_lower_min_anchor: Anchor;
}>;

export default function AutoLowerMinToggle({ userId, marketplace, onChanged }: Props) {
  const [rules, setRules] = useState<RuleSettings[] | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ rule: RuleSettings; enable: boolean } | null>(null);
  // Text drafts for the two number boxes, keyed by rule id.
  const [drafts, setDrafts] = useState<Record<string, { maxPerDay?: string; undercut?: string }>>({});
  const supported = SUPPORTED.includes(marketplace);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      // Aggregated client-side: PostgREST has no GROUP BY. Paginated because
      // it silently caps any response at 1,000 rows.
      const tally = new Map<string, number>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("repricer_assignments")
          .select("rule_id")
          .eq("user_id", userId)
          .eq("marketplace", marketplace)
          .eq("is_enabled", true)
          .eq("status", "active")
          .not("rule_id", "is", null)
          .order("id")
          .range(from, from + 999);
        if (error) throw error;
        for (const r of data ?? []) {
          const id = (r as { rule_id: string }).rule_id;
          tally.set(id, (tally.get(id) ?? 0) + 1);
        }
        if (!data || data.length < 1000) break;
      }
      if (tally.size === 0) {
        setRules([]);
        return;
      }

      const { data: ruleRows, error: rErr } = await supabase
        .from("repricer_rules")
        .select("id, name, auto_lower_min_marketplaces, auto_lower_min_interval_minutes, auto_lower_min_max_drops_per_day, auto_lower_min_undercut, auto_lower_min_anchor")
        .in("id", [...tally.keys()]);
      if (rErr) throw rErr;

      setRules(
        (ruleRows ?? [])
          .map((r) => {
            const marketplaces = (r.auto_lower_min_marketplaces ?? []) as string[];
            return {
              ruleId: r.id as string,
              ruleName: (r.name as string) ?? "Unnamed rule",
              workable: tally.get(r.id as string) ?? 0,
              on: marketplaces.includes(marketplace),
              marketplaces,
              interval: Number(r.auto_lower_min_interval_minutes ?? 60),
              maxPerDay: Number(r.auto_lower_min_max_drops_per_day ?? 3),
              undercut: Number(r.auto_lower_min_undercut ?? 0.01),
              anchor: (r.auto_lower_min_anchor === "buybox" ? "buybox" : "lowest") as Anchor,
            };
          })
          .sort((a, b) => b.workable - a.workable),
      );
    } catch (e) {
      console.warn("[auto-lower-min] settings load failed:", e);
      setRules([]);
    }
  }, [userId, marketplace]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const workable = (rules ?? []).reduce((n, r) => n + r.workable, 0);
    const automated = (rules ?? []).reduce((n, r) => n + (r.on ? r.workable : 0), 0);
    return { workable, automated };
  }, [rules]);

  const apply = async (rule: RuleSettings, enable: boolean) => {
    if (!userId || !supported) return;
    setBusyRuleId(rule.ruleId);
    try {
      const next = enable
        ? Array.from(new Set([...rule.marketplaces, marketplace]))
        : rule.marketplaces.filter((m) => m !== marketplace);
      const { error } = await supabase
        .from("repricer_rules")
        .update({ auto_lower_min_marketplaces: next })
        .eq("id", rule.ruleId)
        .eq("user_id", userId);
      if (error) throw error;

      // Keep the legacy per-assignment flag in step for screens that still read it.
      await supabase
        .from("repricer_assignments")
        .update({ auto_lower_min_price: enable })
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("rule_id", rule.ruleId);

      toast.success(
        enable
          ? `Auto-lower minimum on for ${rule.ruleName} — checks every ${rule.interval} min`
          : `Auto-lower minimum off for ${rule.ruleName}`,
      );
      await load();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Could not update ${rule.ruleName}: ${msg}`);
    } finally {
      setBusyRuleId(null);
      setPending(null);
    }
  };

  const saveSetting = async (rule: RuleSettings, patch: SettingPatch, label: string) => {
    if (!userId) return;
    setBusyRuleId(rule.ruleId);
    try {
      const { error } = await supabase
        .from("repricer_rules")
        .update(patch)
        .eq("id", rule.ruleId)
        .eq("user_id", userId);
      if (error) throw error;
      toast.success(`${rule.ruleName}: ${label}`);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Could not save ${rule.ruleName}: ${msg}`);
    } finally {
      setBusyRuleId(null);
    }
  };

  const commitMaxPerDay = (rule: RuleSettings) => {
    const raw = drafts[rule.ruleId]?.maxPerDay;
    if (raw === undefined) return;
    const n = Math.round(Number(raw));
    setDrafts((d) => ({ ...d, [rule.ruleId]: { ...d[rule.ruleId], maxPerDay: undefined } }));
    if (!Number.isFinite(n) || n < 1 || n > 20) {
      toast.error("Max drops per day must be a whole number from 1 to 20.");
      return;
    }
    if (n !== rule.maxPerDay) void saveSetting(rule, { auto_lower_min_max_drops_per_day: n }, `max ${n} drops per day`);
  };

  const commitUndercut = (rule: RuleSettings) => {
    const raw = drafts[rule.ruleId]?.undercut;
    if (raw === undefined) return;
    const n = Math.round(Number(raw) * 100) / 100;
    setDrafts((d) => ({ ...d, [rule.ruleId]: { ...d[rule.ruleId], undercut: undefined } }));
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      toast.error("Lower by must be between $0.00 and $10.00.");
      return;
    }
    if (n !== rule.undercut) void saveSetting(rule, { auto_lower_min_undercut: n }, `lower by $${n.toFixed(2)}`);
  };

  if (!rules || rules.length === 0) return null;

  const { workable, automated } = totals;
  const partial = automated > 0 && automated < workable;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-auto py-1.5 px-3 gap-2 shrink-0 bg-card/50 backdrop-blur-sm"
          >
            <TrendingDown className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="flex flex-col items-start leading-tight">
              <span className="text-xs font-medium whitespace-nowrap">Auto-lower min</span>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {supported ? `${automated} of ${workable} listings` : "US only for now"}
              </span>
            </span>
            {supported && partial && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-amber-500/40 text-amber-500">
                Partial
              </Badge>
            )}
            {supported && automated === 0 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-muted-foreground">Off</Badge>
            )}
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-[400px] max-w-[calc(100vw-2rem)] p-0">
          <div className="px-3 py-2.5 border-b border-border">
            <p className="text-sm font-medium">Automatic minimum lowering</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {supported
                ? "Per rule: when to check, what to beat, and by how much. Applies to every listing in the rule, including new ones."
                : `Not available for ${marketplace} yet — US only for now.`}
            </p>
          </div>

          <ScrollArea className="max-h-[420px]">
            <div className="p-1.5 space-y-1">
              {rules.map((rule) => {
                const busy = busyRuleId === rule.ruleId;
                const draft = drafts[rule.ruleId] ?? {};
                return (
                  <div key={rule.ruleId} className="rounded-md px-2 py-2 hover:bg-muted/60">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{rule.ruleName}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {rule.workable} listing{rule.workable === 1 ? "" : "s"}
                          {rule.on ? ` · every ${rule.interval} min` : " · off"}
                        </p>
                      </div>
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <Switch
                          checked={rule.on}
                          disabled={!supported}
                          onCheckedChange={(next) => setPending({ rule, enable: next })}
                          aria-label={`Automatic minimum lowering for ${rule.ruleName}`}
                        />
                      )}
                    </div>

                    {rule.on && supported && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                          Check every
                          <Select
                            value={String(rule.interval)}
                            disabled={busy}
                            onValueChange={(v) =>
                              void saveSetting(rule, { auto_lower_min_interval_minutes: Number(v) }, `checks every ${v} min`)}
                          >
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {INTERVALS.map((m) => (
                                <SelectItem key={m} value={String(m)} className="text-xs">{m} minutes</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                          Beat
                          <Select
                            value={rule.anchor}
                            disabled={busy}
                            onValueChange={(v) =>
                              void saveSetting(rule, { auto_lower_min_anchor: v as Anchor }, v === "buybox" ? "beats the Buy Box price" : "beats the lowest price")}
                          >
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="lowest" className="text-xs">Lowest price</SelectItem>
                              <SelectItem value="buybox" className="text-xs">Buy Box price</SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                          Lower by ($)
                          <Input
                            type="number" inputMode="decimal" min={0} max={10} step={0.01}
                            className="h-7 text-xs tabular-nums"
                            disabled={busy}
                            value={draft.undercut ?? rule.undercut.toFixed(2)}
                            onChange={(e) => setDrafts((d) => ({ ...d, [rule.ruleId]: { ...d[rule.ruleId], undercut: e.target.value } }))}
                            onBlur={() => commitUndercut(rule)}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                          Max drops per day
                          <Input
                            type="number" inputMode="numeric" min={1} max={20} step={1}
                            className="h-7 text-xs tabular-nums"
                            disabled={busy}
                            value={draft.maxPerDay ?? String(rule.maxPerDay)}
                            onChange={(e) => setDrafts((d) => ({ ...d, [rule.ruleId]: { ...d[rule.ruleId], maxPerDay: e.target.value } }))}
                            onBlur={() => commitMaxPerDay(rule)}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          />
                        </label>
                        {rule.interval < 15 && (
                          <p className="col-span-2 text-[10px] text-amber-600 dark:text-amber-400">
                            Competitor prices refresh about every 20 minutes, so checking this often mostly re-reads the same prices.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          <div className="px-3 py-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Never below break-even at your COG, never more than 30% under your starting floor or 30% in one
              step, and no more than each rule's drops per day. Listings already winning the Buy Box or the
              lowest price are left alone. The new minimum is sent to Amazon together with the next price, so
              the listing stays active.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              {pending?.enable ? "Turn on" : "Turn off"} for {pending?.rule.ruleName}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {pending?.enable ? (
                  <>
                    <p>
                      The repricer may lower the minimum price on all <strong>{pending.rule.workable}</strong>{" "}
                      {marketplace} listing{pending.rule.workable === 1 ? "" : "s"} using{" "}
                      <strong>{pending.rule.ruleName}</strong> — and on listings added to it later — checking every{" "}
                      <strong>{pending.rule.interval} minutes</strong> and aiming{" "}
                      <strong>${pending.rule.undercut.toFixed(2)}</strong> below the{" "}
                      {pending.rule.anchor === "buybox" ? "Buy Box price" : "lowest price"}.
                    </p>
                    <p className="text-muted-foreground">
                      Each change stays bounded: never below break-even at your COG, never more than 30% under the
                      starting floor or 30% in one step, and at most <strong>{pending.rule.maxPerDay}</strong> drop
                      {pending.rule.maxPerDay === 1 ? "" : "s"} per listing per day. You can change these after
                      turning it on.
                    </p>
                  </>
                ) : (
                  <p>
                    Minimum prices on listings using <strong>{pending?.rule.ruleName}</strong> will stop adjusting
                    automatically. Prices already lowered stay where they are — turning this off does not put them back.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busyRuleId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busyRuleId}
              onClick={() => pending && void apply(pending.rule, pending.enable)}
            >
              {pending?.enable ? "Turn on" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
