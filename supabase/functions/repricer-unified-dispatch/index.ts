import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkCircuitBreaker } from '../_shared/repricer-hardening.ts';
import { requireInternalOrUser } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Real achievable capacity, now that repricer-sp-api-pricing enforces
// Amazon's true getItemOffersBatch limit (0.1 req/s account-wide, 20
// items/batch) via a cross-invocation DB gate (sp_api_rate_limit_state).
// Theoretical ceiling: (3600s / 10.5s per batch) * 20 items ≈ 6,857/hr.
// effectiveChecksPerHour previously derived from the user-configurable
// sp_api_calls_per_minute_cap setting under a stale "no batching, ~2 raw
// calls per check" model, which yielded ~900/hr -- far below what the
// gate can now reliably sustain. This is decoupled from that setting
// because the gate (not this estimate) is what actually enforces the
// ceiling; ~15% margin below theoretical covers retries/overhead.
const REAL_BATCH_MIN_GAP_MS = 10_500;
const REAL_BATCH_SIZE = 20;
const EFFECTIVE_CHECKS_PER_HOUR = Math.floor((3_600_000 / REAL_BATCH_MIN_GAP_MS) * REAL_BATCH_SIZE * 0.85);

function isLegacyAnonCronCall(req: Request): boolean {
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  return Boolean(anonKey && bearer === anonKey && !req.headers.get('x-internal-secret'));
}

/**
 * UNIFIED DISPATCHER v1
 * 
 * Replaces: repricer-cron-trigger, repricer-priority-cron, repricer-sequential-sweep
 * 
 * ONE BRAIN decides what to check next:
 * 1. Scores ALL eligible ASINs using a weighted priority formula
 * 2. Spends the entire SP-API budget top-to-bottom (no competing paths)
 * 3. Uses existing per-ASIN locks to prevent concurrent processing
 * 4. Writes evaluation acknowledgment after every eval
 * 5. Tracks metrics for observability
 * 
 * Runs every 1 minute via pg_cron.
 * 
 * SCORING FACTORS (higher = check sooner):
 *   +100  starred/turbo (user explicitly wants fast checks)
 *   +80   lost Buy Box with price gap ≥ 5c
 *   +70   active BB alert (fn_detect_bb_drop fired)
 *   +60   BB moved since last ack (material change)
 *   +50   significant price gap (≥10c above BB)
 *   +40   sold today + losing BB
 *   +30   recent competitor price change
 *   +20   sold today (demand signal)
 *   +10   stale check (>60min since last eval)
 *   +5    stale check (>30min)
 *   -50   same no_change reason repeated (ack suppression — reduced for HOT: max 8m, bypass at 10m)
 *   -999  inactive / no stock / no rule / no min price → EXCLUDED
 */

const PAGE_SIZE = 1000;
const RATE_WINDOW_SECONDS = 60;

// ─── SCORING WEIGHTS ─────────────────────────────────────────────────────────

function toCents(val: number | null | undefined): number {
  return Math.round((val ?? 0) * 100);
}

interface ScoredCandidate {
  id: string;
  asin: string;
  sku: string;
  marketplace: string;
  score: number;
  reasons: string[];
  is_priority: boolean;
  is_effective_priority: boolean;
  is_hot: boolean;
  hot_age_min: number;
  last_check_ms: number;
  last_dispatch_ms: number;
  budget_share_pct: number;
}

interface DispatchMetrics {
  total_eligible: number;
  total_dispatched: number;
  total_evaluated: number;
  total_applied: number;
  total_skipped: number;
  total_errors: number;
  duplicate_selections: number;
  duplicate_evals_within_5min: number;
  inactive_filtered: number;
  scoring_ms: number;
  dispatch_ms: number;
  total_ms: number;
  sp_api_calls_used: number;
  sp_api_budget_cap: number;
  top_reasons: Record<string, number>;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (isLegacyAnonCronCall(req)) {
    console.log('[unified-dispatch] Legacy anon cron call ignored; v2 internal cron handles this job.');
    return new Response(JSON.stringify({ success: true, ignored_legacy_anon_cron: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  const t0 = Date.now();

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // DB throttle guard — this dispatcher runs on 2 shards every 3 minutes,
    // each doing a per-user multi-query loop; back off instead of piling
    // onto an already-loaded database.
    try {
      const { data: throttleState } = await supabase.rpc('should_throttle_now');
      if (throttleState === 'skip' || throttleState === 'throttle') {
        console.log(`[unified-dispatch] DB_THROTTLE — skipping run (${throttleState})`);
        return new Response(JSON.stringify({ message: 'Throttled — DB under load', throttled: throttleState }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      console.warn('[unified-dispatch] should_throttle_now check failed (non-fatal):', (e as Error).message);
    }

    // ── PARALLEL DISPATCH: Determine worker shard from request body ──
    let workerShard = 'A';
    try {
      const body = await req.clone().json();
      if (body?.worker_shard) workerShard = body.worker_shard;
    } catch { /* default to A */ }

    console.log(`[unified-dispatch][Worker-${workerShard}] Starting cycle at:`, new Date().toISOString());

    // ── Get users assigned to THIS worker shard ──
    const { data: enabledSettings, error: settingsError } = await supabase
      .from('repricer_settings')
      .select('user_id, scheduler_enabled, queue_paused, safe_mode_active, safe_mode_reason, safe_mode_auto_resume_at, circuit_breaker_error_count, circuit_breaker_window_start, sp_api_calls_this_window, sp_api_window_start, sp_api_calls_per_minute_cap, primary_marketplace, schedule_timezone, dispatch_worker_shard')
      .eq('scheduler_enabled', true)
      .eq('dispatch_worker_shard', workerShard);

    if (settingsError || !enabledSettings?.length) {
      console.log(`[unified-dispatch][Worker-${workerShard}] No enabled users for shard — idle`);
      return new Response(JSON.stringify({ success: true, idle: true, worker: workerShard }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const allResults: any[] = [];

    for (const setting of enabledSettings) {
      const result = await processUser(supabase, supabaseUrl, supabaseKey, setting, workerShard);
      allResults.push(result);
    }

    const totalMs = Date.now() - t0;
    // Log skip reasons for short cycles so we can distinguish overlap/budget/idle
    const skipReasons = allResults
      .filter((r: any) => r.skipped)
      .map((r: any) => `${r.user_id?.slice(0,8)}:${r.skipped}`);
    if (skipReasons.length > 0) {
      console.log(`[unified-dispatch] SKIP_REASONS: ${skipReasons.join(', ')}`);
    }
    console.log(`[unified-dispatch][Worker-${workerShard}] Cycle complete in ${totalMs}ms, ${allResults.length} users`);

    return new Response(JSON.stringify({ success: true, worker: workerShard, results: allResults, total_ms: totalMs }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[unified-dispatch] Fatal error:', error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ─── PROCESS ONE USER ────────────────────────────────────────────────────────

async function processUser(
  supabase: any,
  supabaseUrl: string,
  supabaseKey: string,
  setting: any,
  workerShard: string = 'A',
): Promise<any> {
  const userId = setting.user_id;
  const t0 = Date.now();

  // Skip paused / safe mode
  if (setting.queue_paused) {
    console.log(`[unified-dispatch] ${userId}: SKIP — queue_paused`);
    return { user_id: userId, skipped: 'queue_paused' };
  }

  const cbCheck = await checkCircuitBreaker(supabase, userId, setting);
  if (cbCheck.triggered) {
    return { user_id: userId, skipped: 'safe_mode', reason: cbCheck.reason };
  }

  // ── Rate budget ──
  const windowStart = setting.sp_api_window_start ? new Date(setting.sp_api_window_start).getTime() : 0;
  const windowAge = (Date.now() - windowStart) / 1000;
  let callsThisWindow = setting.sp_api_calls_this_window || 0;
  // Default matches EFFECTIVE_CHECKS_PER_HOUR (the gate-verified real ceiling),
  // not the old stale 30/min value -- that number directly caps how many
  // items maxDispatch (below) selects per cycle, and with ~1700+ eligible
  // candidates competing, 30/min meant most items simply never got a turn
  // regardless of how much real Amazon throughput was available.
  const cap = setting.sp_api_calls_per_minute_cap || Math.round(EFFECTIVE_CHECKS_PER_HOUR / 60);

  if (windowAge >= RATE_WINDOW_SECONDS) {
    callsThisWindow = 0;
    await supabase.from('repricer_settings').update({
      sp_api_calls_this_window: 0,
      sp_api_window_start: new Date().toISOString(),
    }).eq('user_id', userId);
  }

  const budgetRemaining = cap - callsThisWindow;
  // FIX #4: Instead of fully skipping when budget exhausted, allow partial dispatch
  // with a micro-batch of 2-3 items if window is >40s old (staggered dispatch)
  if (budgetRemaining < 2) {
    if (windowAge >= 40) {
      // Window almost expired — allow a micro-batch of 2 items to avoid 60s dead window
      console.log(`[unified-dispatch] ${userId}: PARTIAL_DISPATCH — budget low (${callsThisWindow}/${cap}) but window_age=${Math.round(windowAge)}s, allowing micro-batch`);
      // Reset window early to avoid double-counting
      await supabase.from('repricer_settings').update({
        sp_api_calls_this_window: 0,
        sp_api_window_start: new Date().toISOString(),
      }).eq('user_id', userId);
      // Allow through with a tiny budget of 3
    } else {
      console.log(`[unified-dispatch] ${userId}: SKIP — rate_budget_exhausted (${callsThisWindow}/${cap}, window_age=${Math.round(windowAge)}s)`);
      return { user_id: userId, skipped: 'rate_budget_exhausted', budget: `${callsThisWindow}/${cap}` };
    }
  }
  const effectiveBudget = budgetRemaining < 2 ? 3 : budgetRemaining;

  // ── PHASE 1: Score all eligible candidates ──
  const tScoreStart = Date.now();
  const { candidates, metrics: scoreMetrics, staleInventoryItems } = await scoreAllCandidates(supabase, userId, setting.primary_marketplace || 'US', setting.schedule_timezone || 'America/Chicago', cap);
  const tScoreEnd = Date.now();

  // ── PHASE 1.5: Stale inventory refresh — DISABLED ──
  // Permanently disabled: SP-API Summaries returns intermittent false-zeros
  // that were corrupting inventory (mass 0/0 writes). Until a hardened
  // double-confirmation guard is in place across ALL writers, no background
  // process may write to inventory. Manual sync only.
  if (staleInventoryItems.length > 0) {
    console.log(`[unified-dispatch] ${userId}: STALE_INVENTORY_REFRESH_DISABLED — ${staleInventoryItems.length} items would have been refreshed (skipped to prevent false-zero corruption)`);
  }

  if (candidates.length === 0) {
    return { user_id: userId, skipped: 'no_candidates', scoring_ms: tScoreEnd - tScoreStart };
  }

  // ── PHASE 2: Dispatch with INDEPENDENT marketplace budgets ──
  // Primary and intl markets get separate budgets so intl never starves US.
  // Each ASIN costs ~2 SP-API calls (price check + potential patch)
  // Most evals are SKIPs (no price patch) = 1 SP-API call, not 2.
  // With batch SP-API pricing, the pricing call is amortized across the batch (~0.05 per ASIN).
  // Only the price update call (if needed) costs 1 API call. ~30-40% of evals result in a change.
  // Average cost with batch: ~0.45 calls/ASIN. Use 1.0 for safety margin.
  // Without batch: ~1.4 calls/ASIN. Use 1.5 for safety margin.
  const COST_PER_ASIN = 1.0;
  const maxDispatch = Math.min(candidates.length, Math.floor(effectiveBudget / COST_PER_ASIN));

  // Split candidates by marketplace role
  const primaryMkt = setting.primary_marketplace || 'US';
  const primaryCandidates = candidates.filter(c => c.marketplace === primaryMkt);
  const nonPrimaryCandidates = candidates.filter(c => c.marketplace !== primaryMkt);

  // INDEPENDENT BUDGETS: Primary gets proportional share, intl gets proportional share
  // Scale intl slots based on proportion of eligible candidates (min 5, max 50% of budget)
  const intlRatio = candidates.length > 0 ? nonPrimaryCandidates.length / candidates.length : 0;
  const INTL_BONUS_SLOTS = Math.max(setting.intl_dispatch_slots ?? 5, Math.min(Math.floor(maxDispatch * intlRatio), Math.floor(maxDispatch * 0.5)));
  const intlSlots = Math.min(nonPrimaryCandidates.length, INTL_BONUS_SLOTS);

  // ── BUDGET-SHARE WEIGHTED INTL ALLOCATION ──
  // budget_share_pct was stored on each rule's marketplace schedule but never
  // read anywhere — intl marketplaces competed for intlSlots purely by score,
  // so a user setting e.g. "BR: 15%, CA: 5%, MX: 5%" saw no actual difference.
  // Split intlSlots proportionally by each marketplace's configured share
  // (averaged across its candidates, since different rules can set different
  // shares for the same marketplace), then fill each marketplace's allotment
  // with its own top-scored candidates.
  const intlByMarketplace = new Map<string, ScoredCandidate[]>();
  for (const c of nonPrimaryCandidates) {
    if (!intlByMarketplace.has(c.marketplace)) intlByMarketplace.set(c.marketplace, []);
    intlByMarketplace.get(c.marketplace)!.push(c);
  }
  const mktAvgShare = new Map<string, number>();
  for (const [mkt, mktCandidates] of intlByMarketplace.entries()) {
    const avg = mktCandidates.reduce((sum, c) => sum + (c.budget_share_pct || 5), 0) / mktCandidates.length;
    mktAvgShare.set(mkt, avg);
  }
  const totalIntlShare = [...mktAvgShare.values()].reduce((s, v) => s + v, 0) || 1;
  const weightedIntlCandidates: ScoredCandidate[] = [];
  for (const [mkt, mktCandidates] of intlByMarketplace.entries()) {
    const allotment = Math.min(mktCandidates.length, Math.max(1, Math.round(intlSlots * (mktAvgShare.get(mkt)! / totalIntlShare))));
    weightedIntlCandidates.push(...mktCandidates.slice(0, allotment));
  }
  weightedIntlCandidates.sort((a, b) => b.score - a.score);
  const intlSelection = weightedIntlCandidates.slice(0, intlSlots);

  // ── HOT POOL CAP: Only top 150 HOT items by score ──
  const HOT_POOL_CAP = 150;
  // ── WARM/DIVERSITY GUARANTEE: At least 50% of primary slots go to non-HOT ──
  const WARM_GUARANTEE_PCT = 0.50;

  const primaryHot = primaryCandidates.filter(c => c.is_hot);
  const primaryWarm = primaryCandidates.filter(c => !c.is_hot);
  const cappedHot = primaryHot.slice(0, HOT_POOL_CAP);
  const isOverCapacity = scoreMetrics.capacityUtilRatio > 1 || scoreMetrics.capBlockedCount >= 100;
  const isSeverelyOverCapacity = scoreMetrics.capacityUtilRatio > 1.1 || scoreMetrics.capBlockedCount >= 180;
  if (primaryHot.length > HOT_POOL_CAP) {
    // Recovery-mode detection below must see the FULL hot backlog, not just
    // the top-150 slice that fit in the cap — otherwise items ranked >150
    // (real, e.g. losing-BB items) are invisible to the SLA/backlog alarms
    // and never trigger the budget-boost/warm-suppression escalation meant
    // to rescue exactly this situation.
    const excludedHot = primaryHot.slice(HOT_POOL_CAP);
    const oldestExcludedAge = Math.round(Math.max(...excludedHot.map(c => c.hot_age_min)));
    const excludedStale60m = excludedHot.filter(c => c.hot_age_min >= 60).length;
    console.log(`[unified-dispatch] ${userId}: HOT POOL CAP: ${primaryHot.length} HOT items, ${excludedHot.length} excluded from ${HOT_POOL_CAP}-slot cap (oldest_excluded_age=${oldestExcludedAge}m, excluded_60m+=${excludedStale60m})`);
  }

  // ── RECOVERY MODE DETECTION ──
  // Sourced from the FULL hot set (primaryHot), not cappedHot — a genuinely
  // stale item ranked outside the top 150 is still part of the real backlog
  // and must still be able to trigger recovery mode / budget expansion.
  // (cappedHot itself remains the actual per-cycle selection pool below —
  // this only widens what counts toward detecting how bad things are.)
  const staleHot15m = primaryHot.filter(c => c.hot_age_min >= 15);
  const severelyStarvedHot = primaryHot.filter(c => c.hot_age_min >= 30);
  const criticallyStarvedHot = primaryHot.filter(c => c.hot_age_min >= 60);
  const backlogHot = primaryHot.filter(c => c.hot_age_min >= 10);

  // Recovery mode triggers when significant stale pressure exists
  const isRecoveryMode = criticallyStarvedHot.length >= 1 || severelyStarvedHot.length >= 3 || staleHot15m.length >= 5;
  const isCriticalRecovery = criticallyStarvedHot.length >= 3 || severelyStarvedHot.length >= 5;

  // ── RECOVERY MODE: reallocate the EXISTING budget, don't exceed it ──
  // Previously this added 25-50% MORE slots on top of maxDispatch (itself
  // already the sp_api_calls_per_minute_cap-derived ceiling), i.e. recovery
  // mode deliberately dispatched more items than the configured SP-API budget
  // allows. Confirmed live: this pushed sp_api_calls_this_window to 137
  // against a cap of 97. Since every other repricer background job (this
  // function's own next cycle, and previously repricer-priority-cron) reads
  // that same counter to decide its own remaining budget, the overshoot then
  // made subsequent cycles see negative/low headroom and skip or
  // under-dispatch -- turning "drain the backlog faster" into a bursty
  // overspend-then-starve pattern instead of steady throughput.
  // Recovery mode still gets a real lever without exceeding the cap:
  // effectiveWarmPct below aggressively reallocates the existing budget
  // toward HOT items (down to 0% WARM in critical recovery).
  const primarySlots = Math.min(primaryCandidates.length, maxDispatch);
  if (isCriticalRecovery) {
    console.log(`[unified-dispatch] ${userId}: CRITICAL RECOVERY MODE — reallocating budget to HOT (no longer exceeding sp_api_calls_per_minute_cap)`);
  } else if (isRecoveryMode) {
    console.log(`[unified-dispatch] ${userId}: RECOVERY MODE — reallocating budget to HOT (no longer exceeding sp_api_calls_per_minute_cap)`);
  }

  // ── ADAPTIVE WARM GUARANTEE ──
  // During recovery, aggressively reduce WARM slots to drain HOT backlog
  const rawEffectiveWarmPct = isCriticalRecovery
    ? 0           // CRITICAL: All budget to HOT
    : criticallyStarvedHot.length >= 1
    ? 0           // EMERGENCY: ANY HOT item >1h stale → 0% WARM
    : isRecoveryMode
    ? 0.05        // RECOVERY: near-zero WARM (1 slot max)
    : severelyStarvedHot.length >= 1
    ? 0           // ANY HOT item >30m stale → 0% WARM — SLA breach
    : staleHot15m.length >= 3
    ? 0.05        // WARNING: 3+ HOT items >15m → near-zero WARM
    : staleHot15m.length >= 1
    ? 0.10        // ALERT: ANY HOT item >15m → reduce WARM to 10%
    : isSeverelyOverCapacity && cappedHot.length > 0
    ? 0.10
    : isOverCapacity && cappedHot.length > 0
    ? 0.15
    : WARM_GUARANTEE_PCT;
  // ── ABSOLUTE WARM FLOOR ──
  // On any account whose real HOT backlog structurally exceeds the 150-slot
  // cap (e.g. losing-BB items alone > 150 — trivially true at scale, since
  // ALL losing-BB items count as HOT), the tripwires above are satisfied
  // almost permanently, so "recovery mode" — designed as a temporary
  // emergency response — becomes the permanent steady state and WARM gets
  // 0% forever. Confirmed live: ~1,300 HOT items vs a 150-slot cap left
  // only ~33% of assignments checked at all in a 2-hour window, with just
  // 14 new ones rotating in between hour 1 and hour 2. A small guaranteed
  // floor keeps genuine emergencies prioritized (92% of budget still goes
  // to HOT) while ensuring the rest of the catalog is never fully starved.
  const ABSOLUTE_MIN_WARM_PCT = 0.08;
  const effectiveWarmPct = Math.max(ABSOLUTE_MIN_WARM_PCT, rawEffectiveWarmPct);
  const warmMinSlots = Math.ceil(primarySlots * effectiveWarmPct);
  const hotMaxSlots = primarySlots - warmMinSlots;

  if (isRecoveryMode || staleHot15m.length > 0 || severelyStarvedHot.length > 0) {
    console.log(`[unified-dispatch] ${userId}: HOT SLA ENFORCEMENT — ${criticallyStarvedHot.length} critical (60m+), ${severelyStarvedHot.length} severe (30m+), ${staleHot15m.length} warning (15m+), backlog=${backlogHot.length}, recovery=${isRecoveryMode ? (isCriticalRecovery ? 'CRITICAL' : 'ACTIVE') : 'OFF'}, WARM=${Math.round(effectiveWarmPct * 100)}% (${warmMinSlots} slots), total_primary=${primarySlots}`);
  }
  if (isOverCapacity) {
    console.log(`[unified-dispatch] ${userId}: OVERCAPACITY MODE — utilization=${Math.round(scoreMetrics.capacityUtilRatio * 100)}%, cap_blocked=${scoreMetrics.capBlockedCount}, warm_guarantee=${Math.round(effectiveWarmPct * 100)}%`);
  }

  // ── AGE-BASED ORDERING OVERRIDE ──
  // During recovery: pure oldest-first ordering (ignore score/fairness)
  // Normal mode: fairness-first with SLA breach priority
  const sortHotForRecovery = (items: ScoredCandidate[]) => [...items].sort((a, b) => {
    // RECOVERY MODE: Pure oldest-first — drain the backlog as fast as possible
    // No fairness rotation, no score consideration — just age
    return b.hot_age_min - a.hot_age_min || b.score - a.score;
  });

  const sortHotFairness = (items: ScoredCandidate[]) => [...items].sort((a, b) => {
    // SLA-BREACHED items (20m+ stale) ALWAYS come first
    const aSlaBreach = a.hot_age_min >= 20;
    const bSlaBreach = b.hot_age_min >= 20;
    if (aSlaBreach !== bSlaBreach) return aSlaBreach ? -1 : 1;
    if (aSlaBreach && bSlaBreach) return b.hot_age_min - a.hot_age_min;
    // Normal fairness for non-breach items
    const aNd = a.last_dispatch_ms === 0;
    const bNd = b.last_dispatch_ms === 0;
    if (aNd !== bNd) return aNd ? -1 : 1;
    if (a.last_dispatch_ms !== b.last_dispatch_ms) return a.last_dispatch_ms - b.last_dispatch_ms;
    if (b.hot_age_min !== a.hot_age_min) return b.hot_age_min - a.hot_age_min;
    if (a.last_check_ms !== b.last_check_ms) return a.last_check_ms - b.last_check_ms;
    if (b.score !== a.score) return b.score - a.score;
    return a.asin.localeCompare(b.asin);
  });

  // Choose sorting strategy based on recovery mode
  const hotSorter = isRecoveryMode ? sortHotForRecovery : sortHotFairness;

  // HOT SLA breaches get absolute priority — critically starved first
  const hotCritical = cappedHot.filter(c => c.hot_age_min >= 60);
  const hotBreach = cappedHot.filter(c => c.hot_age_min >= 20 && c.hot_age_min < 60);
  const hotNormal = cappedHot.filter(c => c.hot_age_min < 20);
  const selectedHot = [
    ...hotSorter(hotCritical),
    ...hotSorter(hotBreach),
    ...(isRecoveryMode ? sortHotForRecovery(hotNormal) : sortHotFairness(hotNormal)),
  ].slice(0, hotMaxSlots);
  const remainingSlots = primarySlots - selectedHot.length;
  // Under overload, WARM is a HARD CAP (max), not just a floor
  const warmMaxSlots = (isOverCapacity && cappedHot.length > 0)
    ? Math.min(warmMinSlots, remainingSlots)
    : Math.max(warmMinSlots, remainingSlots);
  const selectedWarm = primaryWarm.slice(0, warmMaxSlots);

  // ── HOT SLA HARD GUARANTEE ──
  // Any HOT item stale ≥25 min is FORCIBLY included regardless of slot budget.
  const HOT_HARD_RECHECK_MIN = isRecoveryMode ? 20 : 25; // Lower threshold during recovery
  const forcedHotAsins = new Set<string>();
  const forcedHot: ScoredCandidate[] = [];
  for (const c of cappedHot) {
    if (c.hot_age_min >= HOT_HARD_RECHECK_MIN) {
      const key = `${c.asin}:${c.marketplace}`;
      if (!forcedHotAsins.has(key)) {
        forcedHotAsins.add(key);
        forcedHot.push(c);
      }
    }
  }
  // Remove forced items from selectedHot to avoid duplicates
  const selectedHotFiltered = selectedHot.filter(c => !forcedHotAsins.has(`${c.asin}:${c.marketplace}`));

  if (forcedHot.length > 0) {
    console.log(`[unified-dispatch] ${userId}: HOT HARD GUARANTEE — force-dispatching ${forcedHot.length} items stale ≥${HOT_HARD_RECHECK_MIN}m: ${forcedHot.map(c => `${c.asin}(${Math.round(c.hot_age_min)}m)`).join(', ')}`);
  }

  // ── ANTI-STARVATION SLOT GUARANTEE ──
  // Reserve at least 10% of primary slots (min 2) for items stale 60min+
  // This ensures daily coverage even when HOT items dominate the queue
  const staleGuaranteeSlots = Math.max(2, Math.ceil(primarySlots * 0.10));
  // Build a pre-set of already-selected ASINs to avoid duplicates
  const alreadySelectedAsins = new Set<string>();
  for (const c of [...forcedHot, ...selectedHotFiltered, ...selectedWarm]) {
    alreadySelectedAsins.add(`${c.asin}:${c.marketplace}`);
  }
  const staleWarmItems = primaryWarm
    // last_check_ms === 0 means NEVER checked — that's more deserving of a
    // guaranteed slot than "checked once, now 60m+ stale," not less, but the
    // old check (`> 0`) excluded it entirely.
    .filter(c => !alreadySelectedAsins.has(`${c.asin}:${c.marketplace}`) && (c.last_check_ms === 0 || (Date.now() - c.last_check_ms) / 60000 >= 60))
    .slice(0, staleGuaranteeSlots);
  if (staleWarmItems.length > 0) {
    console.log(`[unified-dispatch] ${userId}: STALE GUARANTEE — reserving ${staleWarmItems.length}/${staleGuaranteeSlots} slots for items stale 60m+`);
  }

  const toDispatch = [
    ...forcedHot,           // ALWAYS first — hard SLA guarantee
    ...selectedHotFiltered, // remaining HOT by score/age
    ...selectedWarm,
    ...staleWarmItems,      // anti-starvation guarantee
    ...intlSelection,       // budget-share-weighted across intl marketplaces
  ];

  // Deduplicate: ensure no ASIN appears twice
  const seenAsins = new Set<string>();
  const dedupedDispatch: ScoredCandidate[] = [];
  let duplicateSelections = 0;
  for (const c of toDispatch) {
    const key = `${c.asin}:${c.marketplace}`;
    if (seenAsins.has(key)) {
      duplicateSelections++;
      continue;
    }
    seenAsins.add(key);
    dedupedDispatch.push(c);
  }

  const primaryDispatched = dedupedDispatch.filter(d => d.marketplace === primaryMkt).length;
  const intlDispatched = dedupedDispatch.length - primaryDispatched;
  const hotDispatched = dedupedDispatch.filter(d => d.is_hot).length;
  const warmDispatched = primaryDispatched - hotDispatched;
  console.log(`[unified-dispatch] ${userId}: dispatching ${dedupedDispatch.length} — primary=${primaryDispatched} (HOT=${hotDispatched}, WARM=${warmDispatched}), intl=${intlDispatched}`);

  console.log(`[unified-dispatch] ${userId}: ${candidates.length} eligible, dispatching ${dedupedDispatch.length} (budget=${budgetRemaining}, duplicates_removed=${duplicateSelections})`);

  // Log top 5 reasons
  const reasonCounts: Record<string, number> = {};
  for (const c of dedupedDispatch) {
    for (const r of c.reasons) {
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
  }

  // ── PHASE 3: Group by marketplace, then split into batches of ≤10 ──
  // Batch size increased from 10→20 to match SP-API batch pricing (getItemOffersBatch supports 20 ASINs/call)
  // This means the scheduler can fetch pricing for the entire batch in ONE SP-API call instead of 10-20 individual calls
  const BATCH_SIZE = 20;
  const BATCH_GAP_MS = 500;
  const tDispatchStart = Date.now();
  const marketplaceGroups = new Map<string, ScoredCandidate[]>();
  for (const c of dedupedDispatch) {
    const m = c.marketplace || 'US';
    if (!marketplaceGroups.has(m)) marketplaceGroups.set(m, []);
    marketplaceGroups.get(m)!.push(c);
  }

  let totalEvaluated = 0;
  let totalApplied = 0;
  let totalErrors = 0;

  // Build all batches first
  interface SchedulerBatch {
    marketplace: string;
    assignmentIds: string[];
    isPriority: boolean;
    batchIndex: number;
  }
  const allBatches: SchedulerBatch[] = [];

  for (const [mkt, group] of marketplaceGroups.entries()) {
    const isPriority = group.some(g => g.is_effective_priority);

    // Fire-and-forget dispatch metadata update (don't await)
    const now = new Date().toISOString();
    const updatePromises = group.map(item =>
      supabase.from('repricer_assignments').update({
        dispatch_score: item.score,
        dispatch_reason: item.reasons.slice(0, 3).join(', '),
        last_dispatch_at: now,
      }).eq('id', item.id)
    );
    Promise.all(updatePromises).catch(() => {});

    // Split into batches of BATCH_SIZE
    const ids = group.map(g => g.id);
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      allBatches.push({
        marketplace: mkt,
        assignmentIds: ids.slice(i, i + BATCH_SIZE),
        isPriority,
        batchIndex: allBatches.length,
      });
    }
  }

  console.log(`[unified-dispatch] ${userId}: ${allBatches.length} scheduler batches (${allBatches.map(b => `${b.marketplace}:${b.assignmentIds.length}`).join(', ')})`);

  // FIX #1: Dispatch cross-marketplace batches in parallel, same-marketplace sequential
  // Group batches by marketplace for parallel dispatch
  const batchesByMkt = new Map<string, SchedulerBatch[]>();
  for (const batch of allBatches) {
    if (!batchesByMkt.has(batch.marketplace)) batchesByMkt.set(batch.marketplace, []);
    batchesByMkt.get(batch.marketplace)!.push(batch);
  }

  async function dispatchBatchSequentially(batches: SchedulerBatch[]): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (i > 0) await new Promise(r => setTimeout(r, BATCH_GAP_MS));
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/repricer-scheduler`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            scheduled: true,
            user_id: userId,
            assignment_ids: batch.assignmentIds,
            marketplace: batch.marketplace,
            is_priority: batch.isPriority,
          }),
        });
        const data = await r.json().catch(() => ({}));
        results.push({ marketplace: batch.marketplace, count: batch.assignmentIds.length, batch: batch.batchIndex, ...data });
      } catch (e: any) {
        results.push({ marketplace: batch.marketplace, count: batch.assignmentIds.length, batch: batch.batchIndex, error: (e as Error).message });
      }
    }
    return results;
  }

  // Dispatch all marketplaces in parallel, sequential within each marketplace
  const parallelResults = await Promise.all(
    Array.from(batchesByMkt.values()).map(batches => dispatchBatchSequentially(batches))
  );
  const dispatchResults = parallelResults.flat();

  for (const dr of dispatchResults) {
    if (dr.summary) {
      totalEvaluated += dr.summary.evaluated || 0;
      totalApplied += dr.summary.applied || 0;
      totalErrors += dr.summary.errors || 0;
    } else if (dr.error) {
      totalErrors += dr.count || 0;
    }
  }

  const tDispatchEnd = Date.now();

  // ── PHASE 4: Write acknowledgments for dispatched ASINs ──
  // The scheduler itself will write price_actions, but we write acks here
  // to track what the dispatcher selected and why.
  // Actual eval acks are written by the scheduler after evaluation.

  // ── PHASE 5: Record metrics ──
  const metrics: DispatchMetrics = {
    total_eligible: candidates.length,
    total_dispatched: dedupedDispatch.length,
    total_evaluated: totalEvaluated,
    total_applied: totalApplied,
    total_skipped: candidates.length - dedupedDispatch.length,
    total_errors: totalErrors,
    duplicate_selections: duplicateSelections,
    duplicate_evals_within_5min: 0, // computed below
    inactive_filtered: scoreMetrics.inactiveFiltered,
    scoring_ms: tScoreEnd - tScoreStart,
    dispatch_ms: tDispatchEnd - tDispatchStart,
    total_ms: Date.now() - t0,
    sp_api_calls_used: Math.ceil(dedupedDispatch.length * COST_PER_ASIN), // estimated avg
    sp_api_budget_cap: cap,
    top_reasons: reasonCounts,
  };

  // Check for duplicate evals within 5 minutes (from eval_acks)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const dispatchedAsins = dedupedDispatch.map(d => d.asin);
  if (dispatchedAsins.length > 0) {
    const { count } = await supabase
      .from('repricer_eval_acks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('asin', dispatchedAsins.slice(0, 200))
      .gte('acked_at', fiveMinAgo);
    metrics.duplicate_evals_within_5min = count || 0;
  }

  // Save metrics with worker identification
  await supabase.from('repricer_dispatch_metrics').insert({
    user_id: userId,
    cycle_started_at: new Date(t0).toISOString(),
    cycle_ended_at: new Date().toISOString(),
    ...metrics,
    budget_utilization_pct: cap > 0 ? Math.round((metrics.sp_api_calls_used / cap) * 100) : 0,
    worker_id: workerShard,
  });

  // Update rate window
  await supabase.from('repricer_settings').update({
    sp_api_calls_this_window: callsThisWindow + metrics.sp_api_calls_used,
  }).eq('user_id', userId);

  // Update lane usage
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const { data: usageRow } = await supabase
      .from('repricer_settings')
      .select('sp_api_lane_usage, sp_api_lane_usage_date')
      .eq('user_id', userId)
      .maybeSingle();

    let usage = (usageRow?.sp_api_lane_usage_date === todayStr && usageRow?.sp_api_lane_usage)
      ? { ...usageRow.sp_api_lane_usage as Record<string, number> }
      : { unified: 0, manual: 0 };
    usage.unified = (usage.unified || 0) + dedupedDispatch.length;

    await supabase.from('repricer_settings').update({
      sp_api_lane_usage: usage,
      sp_api_lane_usage_date: todayStr,
    }).eq('user_id', userId);
  } catch (e) {
    console.warn('[unified-dispatch] Lane usage update error:', e);
  }

  console.log(`[unified-dispatch][Worker-${workerShard}] ${userId}: dispatched=${dedupedDispatch.length}, evaluated=${totalEvaluated}, applied=${totalApplied}, errors=${totalErrors}, scoring=${tScoreEnd - tScoreStart}ms, dispatch=${tDispatchEnd - tDispatchStart}ms, total=${Date.now() - t0}ms`);

  return {
    user_id: userId,
    worker: workerShard,
    metrics,
    dispatch_results: dispatchResults,
  };
}

// ─── SCORE ALL CANDIDATES ────────────────────────────────────────────────────

async function scoreAllCandidates(
  supabase: any,
  userId: string,
  primaryMarketplace: string,
  scheduleTimezone: string = 'America/Chicago',
  cap: number = 30,
): Promise<{ candidates: ScoredCandidate[]; metrics: { inactiveFiltered: number; mktScheduleSkipped: number; capacityUtilRatio: number; capBlockedCount: number }; staleInventoryItems: Array<{ sku: string; asin: string; marketplace: string }> }> {

  // ── Fetch marketplace schedules + enabled state from rules ──
  const { data: rulesData } = await supabase
    .from('repricer_rules')
    .select('id, marketplace_schedule, is_enabled')
    .eq('user_id', userId);

  const ruleScheduleMap = new Map<string, Record<string, any>>();
  const disabledRuleIds = new Set<string>();
  for (const rule of rulesData || []) {
    if (rule.marketplace_schedule) {
      ruleScheduleMap.set(rule.id, rule.marketplace_schedule);
    }
    if (rule.is_enabled === false) {
      disabledRuleIds.add(rule.id);
    }
  }

  // Fetch ALL enabled assignments (paginated)
  let assignments: any[] = [];
  let page = 0;
  while (true) {
    const { data: batch, error } = await supabase
      .from('repricer_assignments')
      .select('id, asin, sku, marketplace, is_priority, is_manual_priority, rule_id, status, min_price_override, last_sp_api_check_at, last_buybox_price, last_applied_price, last_buybox_status, buybox_lost_at, last_price_change_at, last_evaluated_at, last_ack_result, last_ack_reason, last_priority_check_at, last_dispatch_at, dispatch_reason, oscillation_state, oscillation_cooldown_until, consecutive_zero_offers, is_restricted, intl_listing_status, is_listing_inactive_not_buyable')
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .in('status', ['active', 'needs_attention'])
      .not('min_price_override', 'is', null)
      .gt('min_price_override', 0)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) { console.error('[unified-dispatch] fetch error:', error); break; }
    if (!batch || batch.length === 0) break;
    assignments = assignments.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  if (assignments.length === 0) {
    return { candidates: [], metrics: { inactiveFiltered: 0, mktScheduleSkipped: 0, capacityUtilRatio: 0, capBlockedCount: 0 }, staleInventoryItems: [] };
  }

  // ── Filter: must have rule + min_price, skip restricted ──
  // Filter: must have rule + min_price, skip restricted, skip intl with NULL or non-active status
  const withRule = assignments.filter((a: any) => {
    if (!a.rule_id || !a.min_price_override || a.min_price_override <= 0) return false;
    if (disabledRuleIds.has(a.rule_id)) return false;
    if (a.is_restricted) return false;
    // ⚠️ NOT BUYABLE = DO NOT REPRICE, in ANY marketplace.
    //
    // is_listing_inactive_not_buyable is set by the listing-existence checks
    // (verify-intl-listings-existence, pricing-suppression-core) when SP-API
    // reports the offer deleted, not-in-catalog, or discoverable-only. Until
    // now the ONLY thing that acted on it was auto-assign-bulk, which disables
    // such assignments — but nothing schedules auto-assign-bulk for US
    // (cron has only auto-assign-bulk-intl-sweep-6h, jobid 145). So a US
    // assignment could be flagged not-buyable and keep repricing forever.
    //
    // Observed 2026-08-25 on B0FTMPT33K, blocked by Amazon pending a
    // counterfeit appeal. Both SKUs were flagged not-buyable days earlier
    // (08-20 and 08-22). 8GJ-WKC-BHJC happened to be disabled; 1O8-J3N-VB3V was
    // still enabled and was evaluated at 2026-08-26 01:09 — the repricer
    // working a listing Amazon had blocked.
    //
    // Note the intl_listing_status check below only covers non-US marketplaces,
    // so US had no listing-state gate at all. This one is deliberately
    // marketplace-agnostic.
    //
    // Deliberately NOT filtering on is_pricing_suppression: a price-related
    // suppression (e.g. code 18555, "price higher than expected") is often
    // CLEARED by repricing down, so skipping those would prevent the fix.
    // "Not buyable" is different — there is no price that makes a deleted or
    // blocked listing sellable.
    if (a.is_listing_inactive_not_buyable === true) return false;
    // For international markets: only exclude confirmed-bad statuses; NULL = unverified = allow
    if (a.marketplace !== 'US' && a.intl_listing_status) {
      const ils = typeof a.intl_listing_status === 'string' ? a.intl_listing_status.toUpperCase() : JSON.stringify(a.intl_listing_status).toUpperCase();
      if (ils === 'NOT_FOUND' || ils === 'UNKNOWN' || ils.includes('INACTIVE')) return false;
    }
    return true;
  });
  const noRule = assignments.length - withRule.length;
  const restrictedCount = assignments.filter((a: any) => a.is_restricted).length;
  const rulePausedCount = assignments.filter((a: any) => a.rule_id && disabledRuleIds.has(a.rule_id)).length;
  if (noRule > 0) {
    console.log(`[unified-dispatch] ${userId}: ${noRule} assignments skipped (no rule or min_price or restricted), restricted=${restrictedCount}, rule_paused=${rulePausedCount}`);
  }
  const effectiveChecksPerHour = EFFECTIVE_CHECKS_PER_HOUR;
  const capacityRatio = withRule.length / Math.max(effectiveChecksPerHour, 1);
  const overCapacity = capacityRatio > 1;
  const severeOverCapacity = capacityRatio > 1.1;

  // ── Filter: stock + listing status + detect stale inventory ──
  const skus = [...new Set(withRule.map((a: any) => a.sku).filter(Boolean))];
  const stockMap = new Map<string, boolean>();
  const listingStatusMap = new Map<string, string>();
  let inactiveFiltered = 0;
  const STALE_INV_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
  const MAX_STALE_ITEMS = 3;

  // Build SKU→assignment lookup for stale detection (includes priority signals)
  const skuToAssignment = new Map<string, { asin: string; marketplace: string; is_priority: boolean; is_manual_priority: boolean; buybox_lost_at: string | null; last_price_change_at: string | null }>();
  for (const a of withRule) {
    if (a.sku && !skuToAssignment.has(a.sku)) {
      skuToAssignment.set(a.sku, {
        asin: a.asin,
        marketplace: a.marketplace,
        is_priority: a.is_priority,
        is_manual_priority: a.is_manual_priority,
        buybox_lost_at: a.buybox_lost_at || null,
        last_price_change_at: a.last_price_change_at || null,
      });
    }
  }

  // Collect ALL stale candidates first, then sort by priority
  type StaleCandidate = { sku: string; asin: string; marketplace: string; priorityScore: number };
  const allStaleCandidates: StaleCandidate[] = [];
  // Track stale ASINs so we can fetch their sales data in one query
  const staleAsinSet = new Set<string>();

  if (skus.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < skus.length; i += BATCH) {
      const batch = skus.slice(i, i + BATCH);
      const { data: invData } = await supabase
        .from('inventory')
        .select('sku, available, reserved, inbound, listing_status, last_inventory_sync_at')
        .eq('user_id', userId)
        .in('sku', batch);

      for (const inv of invData || []) {
        // Stock check: available > 0 OR reserved > 0 (pre-position pricing for FC transfers)
        const hasStock = (inv.available || 0) > 0 || (inv.reserved || 0) > 0;
        stockMap.set(inv.sku, hasStock);
        if (inv.listing_status) listingStatusMap.set(inv.sku, inv.listing_status);

        // Stale detection: only for items WITH stock that are actively repriced
        if (hasStock) {
          const syncAge = inv.last_inventory_sync_at
            ? Date.now() - new Date(inv.last_inventory_sync_at).getTime()
            : Infinity;
          if (syncAge > STALE_INV_THRESHOLD_MS) {
            const assignment = skuToAssignment.get(inv.sku);
            if (assignment) {
              staleAsinSet.add(assignment.asin);
              // Initial scoring without sales — sales boost added below
              let pScore = 0;
              if (assignment.is_priority || assignment.is_manual_priority) pScore += 50;
              if (assignment.buybox_lost_at) {
                const lostAge = Date.now() - new Date(assignment.buybox_lost_at).getTime();
                if (lostAge < 2 * 60 * 60 * 1000) pScore += 40;
              }
              if (assignment.last_price_change_at) {
                const changeAge = Date.now() - new Date(assignment.last_price_change_at).getTime();
                if (changeAge < 2 * 60 * 60 * 1000) pScore += 30;
              }
              const totalStock = (inv.available || 0) + (inv.reserved || 0) + (inv.inbound || 0);
              if (totalStock >= 20) pScore += 10;
              else if (totalStock >= 5) pScore += 5;

              allStaleCandidates.push({
                sku: inv.sku,
                asin: assignment.asin,
                marketplace: assignment.marketplace,
                priorityScore: pScore,
              });
            }
          }
        }
      }
    }

    // ── FBM FALLBACK: Orphan SKUs missing from `inventory` (FBM listings created
    // via our tool live only in `created_listings` — Summaries API only writes
    // FBA rows). Without this, FBM assignments like B0FK2YGWR2 get filtered as
    // "no stock" and never evaluated.
    const orphanSkus = skus.filter((s) => !stockMap.has(s));
    for (let i = 0; i < orphanSkus.length; i += BATCH) {
      const batch = orphanSkus.slice(i, i + BATCH);
      const { data: clData } = await supabase
        .from('created_listings')
        .select('sku, units')
        .eq('user_id', userId)
        .in('sku', batch);
      for (const cl of clData || []) {
        const hasStock = (cl.units || 0) > 0;
        stockMap.set(cl.sku, hasStock);
        listingStatusMap.set(cl.sku, 'ACTIVE');
      }
    }
    if (orphanSkus.length > 0) {
      const fbmRecovered = orphanSkus.filter((s) => stockMap.get(s)).length;
      if (fbmRecovered > 0) {
        console.log(`[unified-dispatch] ${userId}: FBM orphan recovery: ${fbmRecovered}/${orphanSkus.length} SKUs from created_listings`);
      }
    }
  }

  // ── Sales-based boost: fetch recent sales for stale ASINs ──
  // Recent sellers get priority over dormant high-stock items
  if (allStaleCandidates.length > 0 && staleAsinSet.size > 0) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const todayDate = new Date().toISOString().slice(0, 10);
    const staleAsins = Array.from(staleAsinSet).slice(0, 200); // cap query size

    const { data: recentSales } = await supabase
      .from('asin_sales_daily')
      .select('asin, date, units')
      .eq('user_id', userId)
      .in('asin', staleAsins)
      .gte('date', threeDaysAgo)
      .gt('units', 0);

    // Build per-ASIN sales summary
    const salesByAsin = new Map<string, { todayUnits: number; recentUnits: number; days: number }>();
    for (const row of recentSales || []) {
      const entry = salesByAsin.get(row.asin) || { todayUnits: 0, recentUnits: 0, days: 0 };
      const units = row.units || 0;
      entry.recentUnits += units;
      entry.days++;
      if (row.date === todayDate) entry.todayUnits += units;
      salesByAsin.set(row.asin, entry);
    }

    // Apply sales boosts to stale candidates
    for (const candidate of allStaleCandidates) {
      const sales = salesByAsin.get(candidate.asin);
      if (!sales) continue;

      // Sold today → highest urgency (+35)
      if (sales.todayUnits > 0) candidate.priorityScore += 35;
      // Sold in last 3 days → strong signal (+20)
      else if (sales.recentUnits > 0) candidate.priorityScore += 20;

      // Fast movers: >3 units in 3 days → extra boost (+15)
      if (sales.recentUnits >= 3) candidate.priorityScore += 15;
    }
  }

  // Sort by priority and take top N
  allStaleCandidates.sort((a, b) => b.priorityScore - a.priorityScore);
  const staleInventoryItems = allStaleCandidates.slice(0, MAX_STALE_ITEMS).map(({ sku, asin, marketplace }) => ({ sku, asin, marketplace }));
  if (allStaleCandidates.length > 0) {
    console.log(`[unified-dispatch] ${userId}: STALE_CANDIDATES total=${allStaleCandidates.length}, top3: ${allStaleCandidates.slice(0, 3).map(c => `${c.asin}(p=${c.priorityScore})`).join(', ')}`);
  }

  // ── Fetch signals: BB alerts, today's sales, hourly eval counts ──
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const todayStr = new Date().toISOString().split('T')[0];

  const fifteenMinAgoISO = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [alertsResult, freshAlertsResult, salesResult, hourlyActionsResult, learningSignalsResult] = await Promise.all([
    // Standard alerts for primary marketplace scoring (2h window)
    supabase
      .from('bb_price_alerts')
      .select('asin, marketplace')
      .eq('user_id', userId)
      .eq('dismissed', false)
      .gte('created_at', twoHoursAgo),
    // Fresh alerts only — for maintenance marketplace exceptions (15min window)
    supabase
      .from('bb_price_alerts')
      .select('asin, marketplace')
      .eq('user_id', userId)
      .eq('dismissed', false)
      .gte('created_at', fifteenMinAgoISO),
    supabase
      .from('asin_sales_daily')
      .select('asin, marketplace')
      .eq('user_id', userId)
      .eq('date', todayStr)
      .gt('units', 0),
    // Per-ASIN eval counts in the last hour (for over-processing cap)
    supabase
      .from('repricer_price_actions')
      .select('asin, marketplace')
      .eq('user_id', userId)
      .gte('created_at', oneHourAgo),
    // ── PHASE 1 BRIDGE: per-ASIN learning signals (7d window) ──
    // Aggregates recent Smart Engine activity events to boost/reduce dispatch priority
    supabase
      .from('smart_engine_activity_events')
      .select('asin, marketplace, event_type, action_type')
      .eq('user_id', userId)
      .gte('created_at', sevenDaysAgo),
  ]);

  const alertedAsins = new Set((alertsResult.data || []).map((a: any) => a.asin));
  // For maintenance marketplace exceptions: only fresh alerts (last 15min) AND marketplace-specific
  const freshAlertedAsinsByMkt = new Map<string, Set<string>>();
  for (const a of freshAlertsResult.data || []) {
    const mkt = a.marketplace || 'US';
    if (!freshAlertedAsinsByMkt.has(mkt)) freshAlertedAsinsByMkt.set(mkt, new Set());
    freshAlertedAsinsByMkt.get(mkt)!.add(a.asin);
  }
  // Sales are also marketplace-specific for exception purposes
  const soldTodayAsinsByMkt = new Map<string, Set<string>>();
  for (const s of salesResult.data || []) {
    const mkt = s.marketplace || 'US';
    if (!soldTodayAsinsByMkt.has(mkt)) soldTodayAsinsByMkt.set(mkt, new Set());
    soldTodayAsinsByMkt.get(mkt)!.add(s.asin);
  }
  const soldTodayAsins = new Set((salesResult.data || []).map((s: any) => s.asin));

  // Build per-ASIN:marketplace hourly eval count map
  const hourlyEvalCounts = new Map<string, number>();
  for (const row of hourlyActionsResult.data || []) {
    const key = `${row.asin}:${row.marketplace || 'US'}`;
    hourlyEvalCounts.set(key, (hourlyEvalCounts.get(key) || 0) + 1);
  }

  // ── PHASE 1 BRIDGE: Build per-ASIN learning priority map ──
  // Aggregates 7d learning signals into a priority score modifier per ASIN
  // bb_loss events → boost priority (unresolved competitive pressure)
  // constrained events → moderate boost (engine struggling)
  // raised events → slight boost (active optimization)
  // winner/stable events → reduce priority (healthy, no urgency)
  const learningPriorityMap = new Map<string, { boost: number; reason: string }>();
  const learningEvents = learningSignalsResult.data || [];
  if (learningEvents.length > 0) {
    const asinCounts = new Map<string, { bb_loss: number; constrained: number; raised: number; winner: number; blocked: number }>();
    for (const evt of learningEvents) {
      const key = `${evt.asin}:${evt.marketplace || 'US'}`;
      if (!asinCounts.has(key)) asinCounts.set(key, { bb_loss: 0, constrained: 0, raised: 0, winner: 0, blocked: 0 });
      const c = asinCounts.get(key)!;
      if (evt.event_type === 'bb_loss') c.bb_loss++;
      else if (evt.event_type === 'constrained') c.constrained++;
      else if (evt.event_type === 'raised') c.raised++;
      else if (evt.event_type === 'winner') c.winner++;
      if (evt.action_type === 'blocked') c.blocked++;
    }
    for (const [key, c] of asinCounts) {
      let boost = 0;
      const reasons: string[] = [];
      // Repeated BB losses = high-priority signal (needs faster attention)
      if (c.bb_loss >= 5) { boost += 40; reasons.push(`learn_bb_loss_${c.bb_loss}`); }
      else if (c.bb_loss >= 2) { boost += 20; reasons.push(`learn_bb_loss_${c.bb_loss}`); }
      // Repeated constrained = struggling ASIN
      if (c.constrained >= 3) { boost += 15; reasons.push(`learn_constrained_${c.constrained}`); }
      // Repeated blocked by profit guard = deprioritize (can't act anyway)
      if (c.blocked >= 3) { boost -= 15; reasons.push(`learn_blocked_${c.blocked}`); }
      // Stable winner = reduce urgency (save cycles for others)
      if (c.winner >= 2 && c.bb_loss === 0) { boost -= 20; reasons.push(`learn_stable_winner_${c.winner}`); }
      // Active raising = moderate engagement
      if (c.raised >= 3 && c.bb_loss === 0) { boost -= 10; reasons.push(`learn_raising_ok_${c.raised}`); }

      if (boost !== 0) {
        learningPriorityMap.set(key, { boost, reason: reasons.join(',') });
      }
    }
    if (learningPriorityMap.size > 0) {
      const topEntries = [...learningPriorityMap.entries()].sort((a, b) => Math.abs(b[1].boost) - Math.abs(a[1].boost)).slice(0, 5);
      console.log(`[unified-dispatch] ${userId}: LEARNING_BRIDGE ${learningPriorityMap.size} ASINs scored, top5: ${topEntries.map(([k, v]) => `${k}(${v.boost > 0 ? '+' : ''}${v.boost})`).join(', ')}`);
    }
  }

  // ── FREQUENCY CAPS (sliding 60-min window) ──
  // Non-HOT: max 3/hr — ensures fair rotation across full catalog
  const CAP_NON_HOT = 3;
  // HOT (losing BB, starred, alerts, recent moves): max 6/hr — aggressive reaction
  const CAP_HOT = 6;
  // HOT UNRESOLVED (still losing BB or above BB): max 8/hr — fastest non-manual cadence
  const CAP_HOT_UNRESOLVED = 8;
  // Absolute hard cap: 10/hr — NO exceptions (manual/turbo bypass separately)
  const HARD_CAP = 10;
  let capBlockedCount = 0;

  // ── Fetch latest eval acks (for suppression logic) ──
  const { data: recentAcks } = await supabase
    .from('repricer_eval_acks')
    .select('asin, marketplace, result, reason, acked_at, buybox_price, constraint_applied, is_buybox_owner')
    .eq('user_id', userId);

  const ackMap = new Map<string, any>();
  for (const ack of recentAcks || []) {
    ackMap.set(`${ack.asin}:${ack.marketplace}`, ack);
  }

  // ── Helper: check if current time (in user's timezone) is within a marketplace schedule window ──
  const userTimezone = scheduleTimezone || 'America/Chicago';
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: userTimezone }));
  const nowCTHour = nowLocal.getHours();
  const nowCTMinute = nowLocal.getMinutes();
  let mktScheduleSkipped = 0;

  function isInScheduleWindow(startStr: string, endStr: string): boolean {
    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);
    const startTotal = startH * 60 + (startM || 0);
    const endTotal = endH * 60 + (endM || 0);
    const nowTotal = nowCTHour * 60 + nowCTMinute;
    if (startTotal <= endTotal) {
      return nowTotal >= startTotal && nowTotal < endTotal;
    }
    return nowTotal >= startTotal || nowTotal < endTotal;
  }

  // Default for any intl marketplace without an explicit schedule config on
  // its rule. Was 'maintenance' (a narrow 2-6am window only) — but customers
  // pay for international marketplace coverage, and real usage shows primary
  // typically uses well under half of the real account-wide Amazon throughput
  // ceiling, leaving substantial idle headroom. 'secondary' makes intl
  // eligible all day (no window gate), still deliberately scored lower than
  // primary so it only draws from that idle headroom rather than competing
  // head-on. schedule_window_* / cadence_minutes are unused by 'secondary'
  // (kept only in case a rule's role is ever changed back to 'maintenance').
  const DEFAULT_INTL_WINDOW = { role: 'secondary', schedule_window_start: '02:00', schedule_window_end: '06:00', cadence_minutes: 60, exception_triggers: { starred: true, lost_buybox: true, recent_sale: true } };

  function getMarketplaceRole(mkt: string, ruleId: string | null): string {
    if (mkt === primaryMarketplace) return 'primary';
    if (!ruleId) return 'maintenance';
    const schedule = ruleScheduleMap.get(ruleId);
    // If no explicit schedule config for this international marketplace,
    // default to 'maintenance' with a 02:00–06:00 window instead of running 24/7
    if (!schedule || !schedule[mkt]) return 'maintenance';
    return schedule[mkt].role || 'maintenance';
  }

  function getScheduleConfig(mkt: string, ruleId: string | null): any | null {
    if (mkt === primaryMarketplace) return null; // primary always runs
    if (!ruleId) return DEFAULT_INTL_WINDOW;
    const schedule = ruleScheduleMap.get(ruleId);
    if (!schedule || !schedule[mkt]) return DEFAULT_INTL_WINDOW;
    return schedule[mkt];
  }

  // ── Score each assignment ──
  const nowMs = Date.now();
  const fifteenMinAgo = nowMs - 15 * 60 * 1000;
  const rawCandidates: ScoredCandidate[] = [];
  let noCompSuppressCount = 0;
  let noCompSuppressLogged = 0;

  for (const a of withRule) {
    const ls = (listingStatusMap.get(a.sku) || '').toUpperCase();
    const isInactive = ls === 'INACTIVE' || ls === 'NOT_FOUND' || ls === 'INCOMPLETE';
    const hasStock = stockMap.get(a.sku) ?? false;
    // MISMATCH/STRANDED items bypass stock filter — they have real stock but API reports zero
    const isPreservedStatus = ls === 'MISMATCH' || ls === 'STRANDED';

    if (isInactive) {
      inactiveFiltered++;
      continue;
    }
    if (!hasStock && !isPreservedStatus) {
      inactiveFiltered++;
      continue;
    }

    const mktRole = getMarketplaceRole(a.marketplace, a.rule_id);
    const mktConfig = getScheduleConfig(a.marketplace, a.rule_id);
    const lastCheckMs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
    const checkAgeMinutes = lastCheckMs > 0 ? (nowMs - lastCheckMs) / 60000 : Infinity;

    if (mktRole === 'maintenance') {
      if (!mktConfig) {
        mktScheduleSkipped++;
        continue;
      }

      const windowStart = mktConfig?.schedule_window_start || '02:00';
      const windowEnd = mktConfig?.schedule_window_end || '04:00';
      const inWindow = isInScheduleWindow(windowStart, windowEnd);

      if (!inWindow) {
        const hasExceptions = mktConfig?.exception_triggers;
        const isStarred = !!a.is_priority;
        // Use marketplace-specific fresh alerts (15min) for maintenance exceptions
        // to prevent persistent BB loss states from bypassing schedule windows all day
        const mktFreshAlerts = freshAlertedAsinsByMkt.get(a.marketplace || 'US');
        const hasFreshAlert = mktFreshAlerts ? mktFreshAlerts.has(a.asin) : false;
        const mktSales = soldTodayAsinsByMkt.get(a.marketplace || 'US');
        const hasSoldInMkt = mktSales ? mktSales.has(a.asin) : false;

        let exceptionAllowed = false;
        if (hasExceptions) {
          if (hasExceptions.starred && isStarred) exceptionAllowed = true;
          // Only fresh (last 15min) marketplace-specific BB alerts can wake maintenance items
          if (hasExceptions.lost_buybox && hasFreshAlert) exceptionAllowed = true;
          // Only sales in the same marketplace can wake maintenance items
          if (hasExceptions.recent_sale && hasSoldInMkt) exceptionAllowed = true;
          if (hasExceptions.large_gap) {
            const gapCents = (a.last_applied_price && a.last_buybox_price)
              ? toCents(a.last_applied_price) - toCents(a.last_buybox_price) : 0;
            if (gapCents >= 10) exceptionAllowed = true;
          }
        }

        if (!exceptionAllowed) {
          mktScheduleSkipped++;
          continue;
        }
      } else {
        // CADENCE GATE: cadence_minutes was stored on the rule's marketplace
        // schedule but never enforced anywhere — in-window maintenance items
        // were re-evaluated every dispatch cycle (bounded only by the generic
        // hourly caps below), ignoring whatever recheck interval the user
        // actually configured. Never-checked items (checkAgeMinutes=Infinity)
        // always pass straight through.
        const cadenceMinutes = Number(mktConfig?.cadence_minutes) || 60;
        if (checkAgeMinutes < cadenceMinutes) {
          mktScheduleSkipped++;
          continue;
        }
      }
    }

    let score = 0;
    const reasons: string[] = [];
    const cooldownUntilMs = a.oscillation_cooldown_until ? new Date(a.oscillation_cooldown_until).getTime() : 0;
    const timedCooldownState = typeof a.oscillation_state === 'string'
      && (a.oscillation_state.includes('cooldown') || a.oscillation_state === 'blocked');
    const cooldownActive = timedCooldownState && cooldownUntilMs > nowMs;
    const cooldownExpired = timedCooldownState && cooldownUntilMs > 0 && cooldownUntilMs <= nowMs;
    // Oscillation Recovery Watch: cooldown still active but expiring within 5 min — poll faster
    const cooldownExpiringSoon = cooldownActive && (cooldownUntilMs - nowMs) <= 5 * 60 * 1000;

    const isStarred = !!a.is_priority;
    const hasBbAlert = alertedAsins.has(a.asin);
    const soldToday = soldTodayAsins.has(a.asin);
    const losingBb = a.last_buybox_status && a.last_buybox_status !== 'winning';
    let aboveBbCents = 0;
    if (a.last_applied_price && a.last_buybox_price) {
      aboveBbCents = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
    }

    // ── Per-ASIN hourly eval cap: prevent HOT monopolization ──
    const evalKey = `${a.asin}:${a.marketplace || 'US'}`;
    const hourlyCount = hourlyEvalCounts.get(evalKey) || 0;

    // Determine if this ASIN qualifies as HOT for cap purposes
    const isHotForCap = isStarred || hasBbAlert || losingBb || (a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo);

    // UNRESOLVED HOT: still losing BB or meaningfully above BB — needs fastest cadence
    const isUnresolvedHot = isHotForCap && (losingBb || aboveBbCents >= 5);

    // HOT SLA OVERRIDE: Items stale >10min bypass tiered caps (still respect hard cap)
    const hotSlaOverride = isHotForCap && checkAgeMinutes >= 10;

    // HARD CAP: absolute ceiling per hour
    const effectiveHardCap = hotSlaOverride ? HARD_CAP + 2 : HARD_CAP;
    if (hourlyCount >= effectiveHardCap) {
      capBlockedCount++;
      continue;
    }

    // TIERED CAPS: non-HOT = 2/hr, HOT = 6/hr, HOT unresolved = 8/hr, SLA breach = bypass
    if (!hotSlaOverride) {
      const applicableCap = isUnresolvedHot ? CAP_HOT_UNRESOLVED : isHotForCap ? CAP_HOT : CAP_NON_HOT;
      if (hourlyCount >= applicableCap) {
        capBlockedCount++;
        continue;
      }
    }

    const recentCompetitorMove = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;

    // ── HOT PERSISTENCE: Keep items HOT after no_change until resolved ──
    // Root cause fix: items enter HOT due to transient triggers (recentCompetitorMove fades
    // after 15min, BB alerts age out). After no_change, the trigger fades and the item silently
    // drops to WARM with much weaker scoring -> causes 60m+ stale HOT items.
    // Fix: if dispatched as HOT within 60min and last result was no_change, stay HOT.
    const dispatchReason = a.dispatch_reason || '';
    const lastDispatchMsForPersist = a.last_dispatch_at ? new Date(a.last_dispatch_at).getTime() : 0;
    const dispatchedAsHotRecently = lastDispatchMsForPersist > 0
      && (nowMs - lastDispatchMsForPersist) < 60 * 60 * 1000
      && (dispatchReason.includes('bb_alert') || dispatchReason.includes('losing_bb')
        || dispatchReason.includes('starred') || dispatchReason.includes('cooldown_expired') || dispatchReason.includes('oscillation_recovery') || dispatchReason.includes('cooldown_expiring')
        || dispatchReason.includes('recent_competitor_move') || dispatchReason.includes('hot_persistence'));
    const lastAckForPersist = ackMap.get(`${a.asin}:${a.marketplace}`);
    const hotPersistence = dispatchedAsHotRecently
      && lastAckForPersist?.result === 'no_change'
      && checkAgeMinutes >= 3; // Only persist after ack suppression window passes

    // ALL losing-BB items are HOT — ensures faster rotation for competitive recapture
    const isHot = isStarred || hasBbAlert || cooldownExpired || cooldownExpiringSoon || losingBb || !!recentCompetitorMove || hotPersistence;

    // ── STARVATION PROMOTION: ASINs not checked in 60+ min get boosted into competitive range ──
    const isStarving = checkAgeMinutes >= 60 && !isHot;
    if (isStarving) {
      // BUG FIX: this was computed but never actually added to the score —
      // the "boosted into competitive range" the comment above promises
      // never happened. Combined with maintenance-role marketplaces (BR/CA/MX)
      // already starting at score -= 30, long-neglected assignments there
      // could sit unevaluated indefinitely (confirmed live: an assignment
      // with last_evaluated_at = null, never checked even once).
      score += 50;
      reasons.push('starvation_promoted');
    }

    // Price currently below its own effective floor (min_price_override) —
    // an active configuration violation (selling below the seller's
    // configured minimum/ROI floor), not just routine staleness. The AI
    // evaluation engine's "Universal Floor Recovery" / "BB Owner Floor
    // Recovery" logic already knows how to fix this the moment it actually
    // runs — but dispatch scoring had no signal for it at all, so a
    // floor-violating item in a maintenance-role marketplace could be
    // starved out by routine competitive scoring on primary-market items.
    const belowMinFloor = a.min_price_override != null && a.last_applied_price != null
      && Number(a.last_applied_price) < Number(a.min_price_override) - 0.005;
    if (belowMinFloor) {
      score += 90;
      reasons.push('below_min_floor');
    }

    if (mktRole === 'primary') {
      score += 20;
      reasons.push('primary_mkt');
    } else if (mktRole === 'secondary') {
      score -= 10;
      reasons.push('secondary_mkt');
    } else if (mktRole === 'maintenance') {
      score -= 30;
      reasons.push('maintenance_mkt_exception');
    }

    if (a.is_priority) {
      score += 100;
      reasons.push('starred');
    }

    if (hasBbAlert) {
      score += 70;
      reasons.push('bb_alert');
    }

    if (cooldownExpired) {
      score += 120;
      reasons.push('oscillation_recovery_cleared');
    } else if (cooldownExpiringSoon) {
      // Mild positive boost — pre-position for the moment cooldown clears so we don't miss the window.
      // NOTE: evaluator still blocks any price LOWERING during active cooldown; this only enables faster monitoring.
      score += 15;
      reasons.push('cooldown_expiring_recovery');
    } else if (cooldownActive && !isStarred && !hasBbAlert) {
      score -= 35;
      reasons.push('cooldown_active');
    }

    if (losingBb && aboveBbCents >= 5) {
      score += 80;
      reasons.push(`losing_bb_gap_${aboveBbCents}c`);
    } else if (aboveBbCents >= 10) {
      score += 50;
      reasons.push(`above_bb_${aboveBbCents}c`);
    } else if (losingBb && soldToday) {
      score += 55;
      reasons.push('losing_bb_sold_today');
    } else if (losingBb) {
      // Aggressive: all losing-BB items get strong priority to convert Competing→Winning
      score += 50;
      reasons.push('losing_bb');
    }

    if (recentCompetitorMove) {
      score += 30;
      reasons.push('recent_competitor_move');
    }

    // HOT PERSISTENCE BOOST: items kept HOT by persistence get a strong score
    if (hotPersistence && !recentCompetitorMove && !hasBbAlert && !losingBb && !isStarred && !cooldownExpired) {
      score += 60;
      reasons.push('hot_persistence');
    }

    // ── PHASE 1 BRIDGE: Apply learning signal priority adjustment ──
    const learningKey = `${a.asin}:${a.marketplace}`;
    const learningEntry = learningPriorityMap.get(learningKey);
    if (learningEntry) {
      score += learningEntry.boost;
      reasons.push(learningEntry.reason);
    }

    if (soldToday && !reasons.includes('losing_bb_sold_today')) {
      score += 20;
      reasons.push('sold_today');
    }

    // isVeryStale now triggers at 30m for HOT items (SLA boundary) and 60m for WARM
    const isVeryStale = isHot ? checkAgeMinutes >= 10 : checkAgeMinutes >= 60;

    if (isHot) {
      if (checkAgeMinutes >= 120) {
        score += 600 + Math.min(checkAgeMinutes * 5, 500);
        reasons.push(`hot_critical_starved_${Math.round(checkAgeMinutes)}m`);
      } else if (checkAgeMinutes >= 60) {
        score += 400 + Math.min(checkAgeMinutes * 4, 300);
        reasons.push(`hot_severe_stale_${Math.round(checkAgeMinutes)}m`);
      } else if (checkAgeMinutes >= 30) {
        score += 300 + Math.min(checkAgeMinutes * 4, 200);
        reasons.push(`hot_sla_breach_${Math.round(checkAgeMinutes)}m`);
      } else if (checkAgeMinutes >= 15) {
        score += 200 + Math.round(checkAgeMinutes * 3);
        reasons.push(`hot_sla_warning_${Math.round(checkAgeMinutes)}m`);
      } else if (checkAgeMinutes >= 8) {
        score += 80 + Math.round(checkAgeMinutes * 2);
        reasons.push(`hot_aging_${Math.round(checkAgeMinutes)}m`);
      }
    } else {
      // ── STARVATION-BOOSTED SCORING: unchecked ASINs get aggressive priority ──
      if (checkAgeMinutes >= 720) {
        score += 400;
        reasons.push('stale_12h_rotation');
      } else if (checkAgeMinutes >= 360) {
        score += 300;
        reasons.push('stale_6h');
      } else if (checkAgeMinutes >= 240) {
        score += 250;
        reasons.push('stale_4h');
      } else if (checkAgeMinutes >= 120) {
        score += 200;
        reasons.push('stale_2h_starving');
      } else if (checkAgeMinutes >= 60) {
        // KEY CHANGE: Starving ASINs (60min+) now score 150 instead of 80
        // This puts them competitive with HOT items, ensuring rotation fairness
        score += 150;
        reasons.push('stale_1h_starving');
      } else if (checkAgeMinutes >= 30) {
        score += 50;
        reasons.push('stale_30m');
      } else if (checkAgeMinutes >= 15) {
        score += 15;
        reasons.push('stale_15m');
      }
    }

    if (lastCheckMs === 0) {
      score += 50;
      reasons.push('never_checked');
      if (overCapacity) {
        score += 60;
        reasons.push('overcapacity_never_checked_boost');
      }
    }

    if (isHot) {
      const hotRecencyThreshold = losingBb ? 2 : 4;
      if (checkAgeMinutes < hotRecencyThreshold) {
        score -= losingBb ? 30 : 60;
        reasons.push(`hot_checked_<${hotRecencyThreshold}m`);
      } else if (checkAgeMinutes < 8) {
        score -= 15;
        reasons.push('hot_checked_<8m');
      }
    } else {
      if (checkAgeMinutes < 5) {
        score -= 80;
        reasons.push('checked_<5m');
      } else if (checkAgeMinutes < 10) {
        score -= 50;
        reasons.push('checked_<10m');
      } else if (checkAgeMinutes < 20) {
        score -= 25;
        reasons.push('checked_<20m');
      }
    }

    const ackKey = `${a.asin}:${a.marketplace}`;
    const lastAck = ackMap.get(ackKey);
    if (lastAck) {
      const ackAge = (nowMs - new Date(lastAck.acked_at).getTime()) / 60000;
      const bbUnchanged = a.last_buybox_price !== null
        && lastAck.buybox_price !== null
        && Math.abs(toCents(a.last_buybox_price) - toCents(lastAck.buybox_price)) < 1;

      const cooldownMultiplier = isHot ? 0.3 : 1;
      const maxSuppression = isHot ? 8 : Infinity;
      // HOT items stale 8m+ bypass ALL ack suppression — prevents drift to 30m+
      // UNRESOLVED HOT items (losing BB / above BB) bypass at 5m — they need fastest cadence
      const bypassAckSuppression = cooldownExpired
        || (cooldownExpiringSoon && checkAgeMinutes >= 2) // Oscillation Recovery Watch: 2-min recheck
        || (isUnresolvedHot && checkAgeMinutes >= 5)
        || (isHot && checkAgeMinutes >= 8);

      // ── MAX STALENESS OVERRIDE: Any ASIN stale ≥60min bypasses ack suppression ──
      // This is the KEY rotation fairness fix: prevents WARM/COLD items from being
      // indefinitely suppressed by no_change/blocked/no_competitors acks.
      // Without this, items can go 11+ hours without evaluation.
      const staleOverride = checkAgeMinutes >= 60;

      if (!bypassAckSuppression && !staleOverride && lastAck.result === 'no_change' && bbUnchanged && !isVeryStale) {
        const constraint = lastAck.constraint_applied || '';
        let cooldownMin = 15;
        if (constraint === 'already_optimal' && lastAck.is_buybox_owner) cooldownMin = 25;
        else if (constraint === 'delta_too_small') cooldownMin = 10;
        else if (constraint === 'self_undercut_guard' || constraint === 'competitive_micro_step') cooldownMin = 6;

        // UNRESOLVED HOT: still losing BB or above BB → max 2min suppression
        if (isUnresolvedHot) cooldownMin = Math.min(cooldownMin, 2);
        // Losing BB items get much shorter suppression (max 3min) — faster recapture
        else if (losingBb) cooldownMin = Math.min(cooldownMin, 3);
        // HOT items (not just losing BB) get capped suppression — prevent stale drift
        else if (isHot) cooldownMin = Math.min(cooldownMin, 5);

        cooldownMin = Math.min(cooldownMin * cooldownMultiplier, maxSuppression);

        if (ackAge < cooldownMin) {
          continue;
        }
      }

      if (!bypassAckSuppression && !staleOverride && lastAck.result === 'blocked' && bbUnchanged && !isVeryStale) {
        const constraint = lastAck.constraint_applied || '';
        let cooldownMin = 20;
        if (constraint === 'no_competitors') {
          // ── DYNAMIC CAPACITY-AWARE BACKOFF for no_competitors ──
          const effectiveChecksPerHour = EFFECTIVE_CHECKS_PER_HOUR;
          const capacityRatio = withRule.length / Math.max(effectiveChecksPerHour, 1);
          const baseBackoff = Math.max(30, Math.min(90, Math.round(capacityRatio * 60)));
          const mktFactor = a.marketplace === primaryMarketplace ? 1.0 : 1.3;
          const streak = a.consecutive_zero_offers || 0;
          const streakMultiplier = streak <= 1 ? 1.0 : streak === 2 ? 1.5 : streak === 3 ? 2.0 : 3.0;
          cooldownMin = Math.max(15, Math.min(120, Math.round(baseBackoff * mktFactor * streakMultiplier)));

          // HOT SLA OVERRIDE: HOT items stale >15m bypass no_competitors suppression
          if (isHot && checkAgeMinutes >= 15) {
            if (noCompSuppressLogged < 3) {
              console.log(`[no_comp_backoff] ${a.asin}/${a.marketplace}: HOT SLA OVERRIDE — bypassing no_comp cooldown (age=${Math.round(ackAge)}m, stale=${Math.round(checkAgeMinutes)}m)`);
            }
            // Don't suppress — let it through
          } else if (ackAge < cooldownMin) {
            if (!noCompSuppressLogged) { noCompSuppressLogged = 0; }
            if (noCompSuppressLogged < 3) {
              console.log(`[no_comp_backoff] ${a.asin}/${a.marketplace}: suppressed (age=${Math.round(ackAge)}m < cooldown=${cooldownMin}m, base=${baseBackoff}, mkt=${mktFactor}, streak=${streak}×${streakMultiplier}, ratio=${capacityRatio.toFixed(2)})`);
            }
            noCompSuppressLogged++;
            noCompSuppressCount++;
            continue;
          }
        } else if (constraint === 'floor_hold') cooldownMin = losingBb ? 5 : 45;
        // profit_guard cooldown intentionally removed — Profit Guard no longer fires.
        else if (constraint === 'oscillation' || constraint === 'safety_cooldown') cooldownMin = losingBb ? 15 : 45;
        else if (constraint === 'cooldown') cooldownMin = losingBb ? 8 : 20;

        // no_competitors already handled above with its own continue
        if (constraint !== 'no_competitors') {
          cooldownMin = Math.min(cooldownMin * cooldownMultiplier, maxSuppression);

          if (ackAge < cooldownMin) {
            continue;
          }
        }
      }

      if (lastAck.result === 'error' && ackAge < 5) {
        score -= 30;
        reasons.push('recent_error');
      }
    }

    for (const [key, ack] of ackMap.entries()) {
      if (key.startsWith(`${a.asin}:`) && key !== ackKey) {
        const otherAckAge = (nowMs - new Date(ack.acked_at).getTime()) / 60000;
        if (otherAckAge < 5) {
          score -= 20;
          reasons.push('cross_mkt_recent');
          break;
        }
      }
    }

    if (overCapacity && !isHot && checkAgeMinutes >= 60 && hourlyCount === 0) {
      score += 50; // Increased from 35 — stronger unique bias under overload
      reasons.push('overcapacity_stale_unique_boost');
    }

    // FIX #5: NO-COMP BACKLOG LANE — HARD EXCLUDE long-streak items (not just score penalty)
    // Items with 10+ consecutive zero-offer cycles are fully excluded from dispatch
    // Items with 5+ get harsh penalties that effectively suppress them
    const noCompStreak = a.consecutive_zero_offers || 0;
    if (noCompStreak >= 10 && !isHot) {
      // HARD EXCLUDE: 10+ consecutive no-comp = stop wasting API calls
      noCompSuppressCount++;
      continue;
    }
    if (noCompStreak >= 3 && !isHot) {
      const noCompPenalty = noCompStreak >= 5
        ? severeOverCapacity ? 350 : overCapacity ? 250 : 100
        : severeOverCapacity
        ? Math.min(220, noCompStreak * (a.marketplace === primaryMarketplace ? 12 : 16))
        : overCapacity
        ? Math.min(160, noCompStreak * (a.marketplace === primaryMarketplace ? 8 : 12))
        : 0;
      if (noCompPenalty > 0) {
        score -= noCompPenalty;
        reasons.push(`no_comp_backlog_${noCompStreak}x_-${noCompPenalty}`);
      }
    }

    // FIX #3: ANTI-REPEAT — much stronger penalties under overload
    // Under severe overload, hard-exclude repeats with 2+ evals/hr (unless HOT SLA breach)
    if (hourlyCount >= 1) {
      const urgentHot = isHot && checkAgeMinutes >= 20;
      if (severeOverCapacity && hourlyCount >= 2 && !urgentHot) {
        // HARD EXCLUDE: 2+ repeats under severe overload → skip entirely
        capBlockedCount++;
        continue;
      }
      const penaltyBase = urgentHot
        ? 25
        : severeOverCapacity
        ? 120 // increased from 90
        : overCapacity
        ? 90 // increased from 70
        : 40;
      const penalty = hourlyCount * penaltyBase;
      score -= penalty;
      reasons.push(`repeat_penalty_${hourlyCount}x_-${penalty}`);
    }

    rawCandidates.push({
      id: a.id,
      asin: a.asin,
      sku: a.sku,
      marketplace: a.marketplace,
      score: Math.max(0, score),
      reasons,
      is_priority: !!a.is_priority,
      is_effective_priority: isHot,
      is_hot: isHot,
      hot_age_min: isHot ? checkAgeMinutes : 0,
      last_check_ms: lastCheckMs,
      last_dispatch_ms: a.last_dispatch_at ? new Date(a.last_dispatch_at).getTime() : 0,
      budget_share_pct: Number(mktConfig?.budget_share_pct) || (mktRole === 'primary' ? 100 : 5),
    });
  }

  // Sort by score descending, then collapse duplicate ASIN/marketplace rows BEFORE slot allocation.
  // This prevents duplicate assignment rows from consuming HOT budget and starving other ASINs.
  rawCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.last_check_ms !== b.last_check_ms) {
      const aSortable = a.last_check_ms || 0;
      const bSortable = b.last_check_ms || 0;
      return aSortable - bSortable;
    }
    return a.asin.localeCompare(b.asin);
  });

  const duplicateKeyCounts = new Map<string, number>();
  for (const candidate of rawCandidates) {
    const key = `${candidate.asin}:${candidate.marketplace}`;
    duplicateKeyCounts.set(key, (duplicateKeyCounts.get(key) || 0) + 1);
  }

  const candidates: ScoredCandidate[] = [];
  const seenKeys = new Set<string>();
  let duplicateRowsCollapsed = 0;
  for (const candidate of rawCandidates) {
    const key = `${candidate.asin}:${candidate.marketplace}`;
    if (seenKeys.has(key)) {
      duplicateRowsCollapsed++;
      continue;
    }
    seenKeys.add(key);
    candidates.push(candidate);
  }

  // ── CAPACITY OBSERVABILITY ──
  const capacityUtil = withRule.length / Math.max(effectiveChecksPerHour, 1);
  const noCompetitorCount = withRule.filter((a: any) => (a.consecutive_zero_offers || 0) > 0).length;
  const noCompStreakAvg = noCompetitorCount > 0
    ? Math.round(withRule.filter((a: any) => (a.consecutive_zero_offers || 0) > 0).reduce((sum: number, a: any) => sum + (a.consecutive_zero_offers || 0), 0) / noCompetitorCount * 10) / 10
    : 0;
  const topStreakAsins = withRule
    .filter((a: any) => (a.consecutive_zero_offers || 0) >= 3)
    .sort((a: any, b: any) => (b.consecutive_zero_offers || 0) - (a.consecutive_zero_offers || 0))
    .slice(0, 5)
    .map((a: any) => `${a.asin}/${a.marketplace}(×${a.consecutive_zero_offers})`);
  const primaryCount = withRule.filter((a: any) => a.marketplace === primaryMarketplace).length;
  const intlCount = withRule.length - primaryCount;

  // Fairness observability — with HOT severity tiers
  const warmStarvingCount = candidates.filter(c => !c.is_hot && c.reasons.some(r => r.includes('starving'))).length;
  const hotCount = candidates.filter(c => c.is_hot).length;
  const warmCount = candidates.length - hotCount;
  const repeatCandidates = candidates.filter(c => c.reasons.some(r => r.startsWith('repeat_penalty'))).length;
  const uniqueCandidates = candidates.length - repeatCandidates;
  const topDuplicateKeys = [...duplicateKeyCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `${key}(×${count})`);

  // HOT severity tiers for observability
  const hotCandidates = candidates.filter(c => c.is_hot);
  const hotTier20m = hotCandidates.filter(c => c.hot_age_min >= 20 && c.hot_age_min < 60).length;
  const hotTier60m = hotCandidates.filter(c => c.hot_age_min >= 60 && c.hot_age_min < 120).length;
  const hotTier120m = hotCandidates.filter(c => c.hot_age_min >= 120).length;
  const hotHealthy = hotCandidates.filter(c => c.hot_age_min < 20).length;

  // Stale override observability — how many items were rescued by the 60m override
  const staleOverrideCount = candidates.filter(c => !c.is_hot && c.reasons.some(r => r.includes('stale_1h') || r.includes('stale_2h') || r.includes('stale_4h') || r.includes('stale_6h') || r.includes('stale_12h'))).length;

  console.log(`[unified-dispatch] ${userId}: CAPACITY eligible=${withRule.length} (primary=${primaryCount}, intl=${intlCount}), cap=${cap}/min, eff_checks/hr=${effectiveChecksPerHour}, utilization=${(capacityUtil * 100).toFixed(0)}%`);
  console.log(`[unified-dispatch] ${userId}: FAIRNESS hot=${hotCount}, warm=${warmCount}, warm_starving_60m+=${warmStarvingCount}, stale_override_rescued=${staleOverrideCount}, overload=${overCapacity ? 'yes' : 'no'}, cap_blocked=${capBlockedCount}`);
  console.log(`[unified-dispatch] ${userId}: HOT_TIERS total=${hotCount}, healthy_<20m=${hotHealthy}, breach_20m+=${hotTier20m}, severe_60m+=${hotTier60m}, critical_120m+=${hotTier120m}`);
  console.log(`[unified-dispatch] ${userId}: ROTATION unique_candidates=${uniqueCandidates}, repeat_candidates=${repeatCandidates}, cap_blocked=${capBlockedCount}`);
  if (duplicateRowsCollapsed > 0) {
    console.log(`[unified-dispatch] ${userId}: DUPLICATES collapsed=${duplicateRowsCollapsed}, keys=${topDuplicateKeys.join(', ')}`);
  }
  console.log(`[unified-dispatch] ${userId}: NO_COMP no_comp_asins=${noCompetitorCount}, avg_streak=${noCompStreakAvg}, suppressed_this_cycle=${noCompSuppressCount}${topStreakAsins.length > 0 ? ', top_streaks=' + topStreakAsins.join(', ') : ''}`);
  console.log(`[unified-dispatch] ${userId}: scored ${candidates.length} candidates (mkt_schedule_skipped=${mktScheduleSkipped}), top5: ${candidates.slice(0, 5).map(c => `${c.asin}(${c.score}:${c.marketplace})`).join(', ')}`);

  return { candidates, metrics: { inactiveFiltered, mktScheduleSkipped, capacityUtilRatio: capacityUtil, capBlockedCount }, staleInventoryItems };
}
