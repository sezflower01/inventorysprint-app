import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import {
  acquireLock, releaseLock, releaseAllLocks,
  buildIdempotencyKey, checkIdempotency, markSubmitted,
  checkCircuitBreaker, incrementCircuitBreakerErrors,
  checkWriteBudget, incrementWriteCount,
  detectAnomalies, incrementClampCount, trackBbLossAfterRaise,
  isFatalError,
  type InventoryPressure,
} from '../_shared/repricer-hardening.ts';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';
import { tagUnnecessaryUndercut } from '../_shared/unnecessaryUndercutTagger.ts';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";
import { requireInternalOrUser } from '../_shared/require-internal.ts';
import { MARKETPLACE_META } from '../_shared/marketplace-map.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Repricer Scheduler - Hybrid Monitoring System
 * 
 * This function implements a cost-efficient 24/7 repricing strategy:
 * 1. SP-API checks every 15-30 min (FREE) - monitors your price, Buy Box status
 * 2. Rainforest fetches only when needed - triggered by Buy Box loss or competitor changes
 * 3. Daily credit caps to control costs
 * 
 * Can be triggered by:
 * - Cron job (scheduled: true)
 * - Manual run from UI (user JWT)
 */

interface SchedulerRequest {
  scheduled?: boolean;
  user_id?: string;
  force_rainforest?: boolean;
  force_all?: boolean;
  dry_run?: boolean;
  assignment_ids?: string[];
  is_priority?: boolean;
  marketplace?: string;
  // Manual "Force Smart Raise" — controlled BB-owner profit probe.
  // Bypasses cooldown + bb_owner_protection but still respects min/max/ROI/drop budget.
  force_mode?: 'smart_raise' | null;
}

interface ProcessResult {
  asin: string;
  sku?: string;
  action: 'skipped' | 'checked' | 'evaluated' | 'applied' | 'error';
  reason: string;
  newPrice?: number;
  previousPrice?: number;
  rainforestUsed?: boolean;
  spApiUsed?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const supabase = createClient(supabaseUrl, supabaseKey);

    let userId: string | null = null;
    const body: SchedulerRequest = await req.json().catch(() => ({}));
    const { scheduled, force_rainforest = false, force_all = false, dry_run = false, assignment_ids, is_priority = false, marketplace: requestedMarketplace, force_mode = null } = body;
    const isTargetedCronChainRun = Boolean(scheduled && assignment_ids && assignment_ids.length > 0);

    // GUARD: If this is a standalone cron call (no assignment_ids, no force_all, no manual),
    // defer to unified-dispatch which is the sole authority for ASIN selection.
    if (scheduled && !assignment_ids && !force_all) {
      console.log(`[repricer-scheduler] DEPRECATED standalone cron — unified-dispatch is the sole dispatcher. No-op.`);
      return new Response(JSON.stringify({ success: true, skipped: 'deferred_to_unified_dispatch' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (force_all) {
      console.log(`[repricer-scheduler] FORCE ALL mode — bypassing cooldowns and min-change guards`);
    }

    // Auth: Support both JWT and internal cron calls
    let isInternalCronCall = false;
    if (scheduled && body.user_id) {
      // Internal cron job
      userId = body.user_id;
      isInternalCronCall = true;
      console.log(`[repricer-scheduler] Cron mode for user ${userId}`);
    } else {
      // User-initiated call
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      userId = user.id;
      console.log(`[repricer-scheduler] Manual run for user ${userId}`);
    }

    // MODULE ACCESS GUARD: triggering the engine = repricer:run (skip on internal cron path)
    if (!isInternalCronCall) {
      const access = await checkModuleAccess(supabase, userId, 'repricer', 'run');
      if (!access.allowed) {
        console.warn(`[repricer-scheduler] MODULE BLOCKED user=${userId} reason=${access.reason}`);
        return new Response(
          JSON.stringify({ success: false, error: access.reason }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Compute trigger source once for all price_actions in this run
    const triggerSource: string = (() => {
      if (assignment_ids && assignment_ids.length > 0 && !scheduled) return 'manual_run_selected';
      if (is_priority) return 'priority_cron';
      if (scheduled) return 'scheduler';
      return 'manual';
    })();
    console.log(`[repricer-scheduler] Trigger source: ${triggerSource}`);

    // Get user settings
    const { data: settings, error: settingsError } = await supabase
      .from('repricer_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (settingsError) {
      console.error('[repricer-scheduler] Settings error:', settingsError);
      throw new Error('Failed to fetch settings');
    }

    const circuitBreakerState: any = await checkCircuitBreaker(supabase, userId, settings);
    if (circuitBreakerState.triggered || circuitBreakerState.tripped) {
      console.warn(`[repricer-scheduler] Circuit breaker is tripped, skipping run`);
      return new Response(
        JSON.stringify({ success: false, error: 'Circuit breaker tripped', circuitBreaker: circuitBreakerState }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch active assignments for this run
    let assignmentsQuery = supabase
      .from('repricer_assignments')
      .select(`
        id, asin, sku, marketplace, status, item_condition,
        last_sp_api_check_at, next_rainforest_check_at,
        last_buybox_status, last_buybox_price,
        last_applied_price, last_applied_at,
        min_price_override, max_price_override,
        consecutive_profit_guard_hits, last_floor_price_cents,
        last_evaluated_at, rule_id, is_priority, is_manual_priority,
        manual_override_started_at, manual_override_checks,
        anomaly_score, anomaly_flags, recent_prices,
        oscillation_state, oscillation_detected_at,
        oscillation_reaction_count, oscillation_cooldown_until,
        oscillation_last_mode_used, oscillation_last_reason,
        oscillation_count, bb_loss_after_raise_count,
        clamp_count_today, clamp_count_reset_at, last_stable_price,
        eval_mode, active_eval_mode, no_change_streak, basic_rule_id,
        restock_reentry_at,
        repricer_rules!repricer_assignments_rule_id_fkey(*)
      `)
      .eq('user_id', userId)
      // needs_attention is dispatch-eligible (unified-dispatch already treats it
      // that way via .in('status', ['active','needs_attention'])) -- this query
      // used to hardcode 'active' only, so any needs_attention assignment sent
      // here by ID (via assignment_ids) silently matched zero rows and was
      // never evaluated, no matter how many times it got dispatched.
      .in('status', ['active', 'needs_attention'])
      .not('min_price_override', 'is', null)
      .gt('min_price_override', 0)
      // last_sp_api_check_at is NOT unique -- many rows share a check time and
      // the nullsFirst block can be large -- so on its own it cannot order the
      // pages below: a tie spanning a page boundary means some assignments are
      // dispatched twice and others never. id makes the order total while
      // keeping stalest-first as the priority.
      //
      // Applied HERE and not in the loop: assignmentsQuery is a reused builder,
      // so a modifier added inside the loop is appended again every iteration.
      .order('last_sp_api_check_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true });

    // Force-all mode: also require rule_id
    if (force_all) {
      assignmentsQuery = assignmentsQuery
        .not('rule_id', 'is', null);
    }

    if (assignment_ids && assignment_ids.length > 0) {
      assignmentsQuery = assignmentsQuery.in('id', assignment_ids);
    }

    if (requestedMarketplace) {
      assignmentsQuery = assignmentsQuery.eq('marketplace', requestedMarketplace);
    }

    // For force_all, paginate to get all assignments (default Supabase limit is 1000)
    let allAssignments: any[] = [];
    if (force_all && !assignment_ids) {
      const PAGE_SIZE = 1000;
      let page = 0;
      while (true) {
        const { data: pageData, error: pageError } = await assignmentsQuery
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (pageError) {
          console.error('[repricer-scheduler] Paginated fetch error:', pageError);
          throw new Error('Failed to fetch assignments');
        }
        if (!pageData || pageData.length === 0) break;
        allAssignments = allAssignments.concat(pageData);
        if (pageData.length < PAGE_SIZE) break;
        page++;
      }
      console.log(`[repricer-scheduler] Force-all: fetched ${allAssignments.length} eligible assignments (with rules + min_price)`);
    } else {
      const { data: assignments, error: assignmentsError } = await assignmentsQuery;
      if (assignmentsError) {
        console.error('[repricer-scheduler] Assignments fetch error:', assignmentsError);
        throw new Error('Failed to fetch assignments');
      }
      allAssignments = assignments || [];
    }

    // Rule-level pause: the "Active/Paused" toggle in the Rules tab sets
    // repricer_rules.is_enabled, but this join was previously fetched and
    // never checked -- pausing a rule had no actual effect on pricing.
    // Skip any assignment whose rule is paused; assignments with no rule
    // (rule_id null) are unaffected.
    const preRulePauseCount = allAssignments.length;
    allAssignments = allAssignments.filter((a: any) => {
      const rule = a.repricer_rules;
      return !rule || rule.is_enabled !== false;
    });
    const rulePausedSkipped = preRulePauseCount - allAssignments.length;
    if (rulePausedSkipped > 0) {
      console.log(`[repricer-scheduler] Skipped ${rulePausedSkipped} assignments — rule paused`);
    }

    console.log(`[repricer-scheduler] Processing ${allAssignments.length} active assignments`);

    // Get total active assignment count for hybrid threshold (≤1000 = all Smart, >1000 = allow Basic)
    const { count: totalActiveCount } = await supabase
      .from('repricer_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'active');
    const userTotalActive = totalActiveCount ?? allAssignments.length;
    console.log(`[repricer-scheduler] Total active assignments for user: ${userTotalActive}`);

    const results: ProcessResult[] = [];
    let processed = 0;
    let rainforestCreditsUsed = 0;

    // === TIMEOUT GUARD ===
    const EXECUTION_START = Date.now();
    const MAX_EXECUTION_MS = isTargetedCronChainRun ? 95_000 : 140_000;

    const lockOwner = is_priority ? 'priority_cron' : (scheduled ? 'scheduler' : 'manual');
    let skippedCount = 0;

    // ── TIMING INSTRUMENTATION ──
    const timings = {
      batchPrefetchMs: 0,
      perAsinMs: [] as number[],       // per-ASIN total eval time
      dbReadMs: [] as number[],        // per-ASIN DB read operations
      dbWriteMs: [] as number[],       // per-ASIN DB write operations
      evalLogicMs: [] as number[],     // per-ASIN eval + pricing logic
      spApiIndividualMs: [] as number[], // per-ASIN individual SP-API calls (when batch missed)
      settingsFetchMs: 0,
      assignmentsFetchMs: 0,
    };

    // ── BATCH PRE-FETCH: Fetch pricing for all ASINs in one SP-API call ──
    const batchPricingCache = new Map<string, any>();
    let batchFetchUsed = false;
    const batchMarketplace = allAssignments[0]?.marketplace || requestedMarketplace || 'US';

    // Only batch if all assignments share same marketplace (batch API is per-marketplace)
    const allSameMarketplace = allAssignments.every(a => (a.marketplace || 'US') === batchMarketplace);
    
    if (allSameMarketplace && allAssignments.length >= 2 && allAssignments.length <= 20) {
      try {
        const batchItems = allAssignments.map(a => {
          const rule = (a as any).repricer_rules;
          const skuValue = String(a.sku || '');
          const isUsedBySku = skuValue.startsWith('amzn.gr.') || skuValue.toLowerCase().startsWith('used_');
          const isPlainMerchantSku = !!skuValue && !isUsedBySku;
          const storedCondition = a.item_condition;
          const conditionScope = rule?.condition_scope || 'New';
          // SKU identity is authoritative for split New/Used listings on the same ASIN.
          // Plain merchant SKUs like 1066502134 are New; generated amzn.gr.* SKUs are Used.
          const itemCondition = isUsedBySku
            ? 'Used'
            : isPlainMerchantSku
              ? 'New'
              : storedCondition
                ? (storedCondition === 'New' ? 'New' : 'Used')
                : conditionScope === 'Used' ? 'Used' : 'New';
          return { asin: a.asin, sku: a.sku, marketplace: a.marketplace || 'US', item_condition: itemCondition };
        });

        const tBatchStart = Date.now();
        timings.batchPrefetchMs = 0; // will set after
        const batchResp = await fetch(`${supabaseUrl}/functions/v1/repricer-sp-api-pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
          body: JSON.stringify({ batch: true, items: batchItems, user_id: userId, internal: true, marketplace: batchMarketplace }),
        });
        const batchResult = await batchResp.json().catch(() => null);
        const batchMs = Date.now() - tBatchStart;
        timings.batchPrefetchMs = batchMs;
        if (batchResp.ok && batchResult?.success && batchResult?.results) {
          for (const [key, data] of Object.entries(batchResult.results)) {
            if ((data as any).success) {
              // New SKU-keyed format: `${asin}::${sku}`. Fall back to bare ASIN for legacy.
              batchPricingCache.set(key, (data as any).data);
              const asinPart = key.includes('::') ? key.split('::')[0] : key;
              if (!batchPricingCache.has(asinPart)) batchPricingCache.set(asinPart, (data as any).data);
            }
          }
          batchFetchUsed = true;
          console.log(`[repricer-scheduler] BATCH PRE-FETCH: ${batchPricingCache.size}/${batchItems.length} ASINs fetched in ${batchMs}ms (saved ~${batchItems.length - 1} individual calls)`);
        } else {
          console.warn(`[repricer-scheduler] BATCH PRE-FETCH failed (${batchMs}ms), falling back to individual calls: ${batchResult?.error || batchResp.status}`);
        }
      } catch (batchErr: any) {
        console.warn(`[repricer-scheduler] BATCH PRE-FETCH error, falling back to individual calls:`, batchErr?.message);
      }
    }

    // Adaptive pacing: distribute fetch() calls evenly across the available time budget.
    // With batch pre-fetch, individual SP-API calls are skipped, so pacing is mainly for DB + eval work.
    const TARGET_COMPLETION_MS = batchFetchUsed ? 15000 : 20000; // faster target when pre-fetched
    const AVG_WORK_PER_ASSIGNMENT_MS = batchFetchUsed ? 300 : 600; // no SP-API latency when pre-fetched
    let assignmentIndex = 0;
    const totalAssignments = allAssignments.length;

    for (const assignment of allAssignments) {
      const tAsinStart = Date.now();
      if (assignmentIndex > 0) {
        const elapsed = Date.now() - EXECUTION_START;
        const remaining = Math.max(0, TARGET_COMPLETION_MS - elapsed);
        const assignmentsLeft = totalAssignments - assignmentIndex;
        const estimatedWorkLeft = assignmentsLeft * AVG_WORK_PER_ASSIGNMENT_MS;
        const idleTimeLeft = Math.max(0, remaining - estimatedWorkLeft);
        // When batch pre-fetched, no SP-API latency per ASIN — minimize delay (50ms floor)
        // Without batch, keep 200ms floor to avoid API hammering
        const minDelay = batchFetchUsed ? 50 : 200;
        const adaptiveDelay = Math.min(2000, Math.max(minDelay, Math.round(idleTimeLeft / assignmentsLeft)));
        await new Promise(r => setTimeout(r, adaptiveDelay));
      }
      assignmentIndex++;
      // Timeout guard
      if (Date.now() - EXECUTION_START > MAX_EXECUTION_MS) {
        console.warn(`[repricer-scheduler] Execution timeout after ${Date.now() - EXECUTION_START}ms — stopping early`);
        break;
      }

      const { id: assignmentId, asin, sku, marketplace } = assignment;
      const rule = (assignment as any).repricer_rules;

      if (!rule) {
        results.push({ asin, sku, action: 'skipped', reason: 'No rule attached to assignment' });
        skippedCount++;
        continue;
      }

      // SP-API check interval gate
      const lastSpCheck = assignment.last_sp_api_check_at
        ? new Date(assignment.last_sp_api_check_at).getTime()
        : 0;
      const spIntervalMs = (settings?.sp_api_check_interval_minutes || 10) * 60 * 1000;
      const needsSpCheck = (Date.now() - lastSpCheck) >= spIntervalMs;

      if (!needsSpCheck && !force_rainforest && !force_all && !(assignment_ids && assignment_ids.length > 0)) {
        const nextInMin = Math.round((spIntervalMs - (Date.now() - lastSpCheck)) / 60000);
        results.push({ asin, sku, action: 'skipped', reason: `SP-API interval not elapsed (next ~${nextInMin}min)` });
        skippedCount++;
        continue;
      }

      // ── Daily check counter (observability, no cap) ──
      // Writes to repricer_assignment_check_counters, NOT to repricer_assignments.
      //
      // repricer_assignments is in the supabase_realtime publication, and realtime
      // broadcasts on ANY row change regardless of which column moved. This counter
      // is pure telemetry -- nothing in src/ reads it, and the only other references
      // were this function reading its own previous value to increment it -- yet it
      // was firing 295,964 updates per 51h (17.4% of all writes to the hottest table
      // in the database), each one decoded and fanned out to live subscribers.
      // Measured 2026-08-20; see the migration for the full numbers.
      //
      // The RPC does the day-rollover comparison server-side in one statement, so
      // checks_today_count/checks_today_date no longer need to be SELECTed with the
      // assignment either -- this removed them from the query above as well.
      //
      // Still fire-and-forget: a telemetry counter must never delay or fail a
      // repricing decision.
      supabase.rpc('bump_assignment_check_counter', {
        p_assignment_id: assignmentId,
      }).then(() => {});

      const lockAcquired = await acquireLock(supabase, userId, asin, marketplace, lockOwner, 120);
      if (!lockAcquired) {
        results.push({ asin, sku, action: 'skipped', reason: 'Lock unavailable — concurrent run in progress' });
        skippedCount++;
        continue;
      }

      try {
        const idempotencyKey = buildIdempotencyKey(userId, asin, marketplace, 0, 'price_eval');
        // Manual "Run Selected" and force_all bypass idempotency to allow re-evaluation
        const isManualOrForce = triggerSource === 'manual_run_selected' || triggerSource === 'manual' || force_all;
        if (!isManualOrForce) {
          const alreadyDone = await checkIdempotency(supabase, userId, idempotencyKey as any);
          if (alreadyDone) {
            results.push({ asin, sku, action: 'skipped', reason: 'Already evaluated this cycle (idempotency)' });
            skippedCount++;
            continue;
          }
        }

        // Detect item condition: stored on assignment > rule setting > SKU prefix auto-detection
        const skuValue = String(sku || '');
        const isUsedBySku = skuValue.startsWith('amzn.gr.') || skuValue.toLowerCase().startsWith('used_');
        const isPlainMerchantSku = !!skuValue && !isUsedBySku;
        const storedCondition = assignment.item_condition;
        const conditionScope = rule.condition_scope || 'New';
        // SKU identity is authoritative for split New/Used listings on the same ASIN.
        // This prevents a bad stored condition/rule scope from swapping 1066502134 and amzn.gr.*.
        const itemCondition: 'New' | 'Used' = isUsedBySku
          ? 'Used'
          : isPlainMerchantSku
            ? 'New'
            : storedCondition
              ? (storedCondition === 'New' ? 'New' : 'Used')
              : conditionScope === 'Used' ? 'Used' : 'New';

        let spPricing: any = null;
        let spApiSuccess = false;
        let spApiError = 'SP-API pricing fetch failed';

        // Use batch pre-fetched data if available, otherwise fall back to individual call.
        // Look up by SKU-specific key first so different SKUs of the same ASIN
        // (e.g. New vs Used) never share results.
        const cachedPricing =
          batchPricingCache.get(`${asin}::${sku || ''}`) ?? batchPricingCache.get(asin);
        if (cachedPricing) {
          spPricing = cachedPricing;
          spApiSuccess = true;
          console.log(`[repricer-scheduler] ${asin}/${sku || ''}: Using BATCH pre-fetched SP-API data (saved ~600ms)`);
        } else {
          try {
            const tSpStart = Date.now();
            const spResp = await fetch(`${supabaseUrl}/functions/v1/repricer-sp-api-pricing`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
              body: JSON.stringify({ asin, sku, marketplace, user_id: userId, internal: true, item_condition: itemCondition }),
            });
            const spResult = await spResp.json().catch(() => null);
            timings.spApiIndividualMs.push(Date.now() - tSpStart);
            spApiSuccess = spResp.ok && spResult?.success === true;
            if (spApiSuccess) {
              spPricing = spResult.data;
            } else {
              spApiError = spResult?.error || spResult?.reason || `SP-API pricing HTTP ${spResp.status}`;
            }
          } catch (e: any) {
            spApiError = e?.message || 'SP-API pricing fetch failed';
            console.warn(`[repricer-scheduler] SP-API fetch failed for ${asin}/${sku}:`, e);
          }
        }

        if (!spApiSuccess || !spPricing) {
          if (isFatalError(spApiError)) {
            await incrementCircuitBreakerErrors(supabase, userId);
          }
          // Manual force runs (e.g. Force Smart Raise) must always leave an audit trail
          // in the Price Action Log so the user understands why nothing happened.
          if (force_mode) {
            supabase.from('repricer_price_actions').insert({
              user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
              action_type: 'error',
              trigger_source: triggerSource,
              old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
              reason: `Force ${force_mode} aborted: SP-API pricing fetch failed — ${spApiError}`,
              error_type: 'sp_api_pricing_failed',
              success: false, update_method: 'none', rule_name: rule?.name || null,
            }).then(() => {});
          }
          results.push({ asin, sku, action: 'error', reason: spApiError, spApiUsed: true });
          continue;
        }

        // Auto-clear a stale needs_attention label. auto-assign-bulk sets this
        // status when it can't complete activation (missing rule, cost, price,
        // or bounds) and nothing ever re-checks it afterward -- so a listing
        // that gets its rule/bounds filled in later (e.g. via manual edit or
        // Sync Bounds) keeps showing "needs attention" forever even though it's
        // evaluating fine. Reaching this point already proves rule (gate above)
        // and bounds (base query requires min_price_override) are present, and
        // spApiSuccess just confirmed a real, fetchable Amazon price -- the
        // same three conditions auto-assign-bulk's gate required.
        if (assignment.status === 'needs_attention' && assignment.max_price_override != null) {
          supabase.from('repricer_assignments').update({ status: 'active' }).eq('id', assignmentId).then(() => {});
          console.log(`[repricer-scheduler] ${asin}/${marketplace}: needs_attention cleared — rule+bounds+price confirmed present`);
        }

        const buyboxPriceCents = spPricing.buyboxPrice ? Math.round(spPricing.buyboxPrice * 100) : null;
        const lowestFbaPriceCents = spPricing.lowestFbaPrice ? Math.round(spPricing.lowestFbaPrice * 100) : null;
        const lowestFbmPriceCents = spPricing.lowestFbmPrice ? Math.round(spPricing.lowestFbmPrice * 100) : null;
        const isBuyboxWinner = spPricing.isBuyboxOwner ?? false;

        // Keep DB condition aligned to SKU identity. Do not let stale SP-API/listing
        // reads swap New and Used sibling SKUs on the same ASIN.
        if (itemCondition !== assignment.item_condition) {
          console.log(`[repricer-scheduler] ${asin}/${sku || ''}: correcting condition=${itemCondition} (was ${assignment.item_condition || 'null'})`);
          supabase.from('repricer_assignments').update({
            item_condition: itemCondition,
          }).eq('id', assignmentId).then(() => {});
        }
        const spApiMyPriceCents = spPricing.myPrice != null
          ? Math.round(spPricing.myPrice * 100)
          : null;
        const lastAppliedPriceCents = assignment.last_applied_price != null
          ? Math.round(assignment.last_applied_price * 100)
          : null;
        let myCurrentPriceCents = spApiMyPriceCents ?? lastAppliedPriceCents;
        const effectiveFbmCompetitionMode = rule.fbm_competition_mode === 'lowest_seller' ? 'lowest_seller'
          : rule.fbm_competition_mode === 'all_sellers' ? 'all_sellers'
          : rule.fbm_competition_mode === 'fba_priority' ? 'fba_priority'
          : (rule.ignore_fbm_unless_buybox_owner === false ? 'all_sellers' : 'fba_priority');
        const competeWithFbm = effectiveFbmCompetitionMode === 'all_sellers' || effectiveFbmCompetitionMode === 'lowest_seller'
          ? true
          : (rule.compete_with_fbm ?? true);
        const buyboxIsFba = spPricing.buyboxIsFba ?? null;
        const fbaOnlyModeWithFbmBuybox = !competeWithFbm && buyboxIsFba === false;
        const effectiveBuyboxPriceCents = fbaOnlyModeWithFbmBuybox
          ? lowestFbaPriceCents
          : buyboxPriceCents;

        if (fbaOnlyModeWithFbmBuybox) {
          console.log(
            `[repricer-scheduler] ${asin}: FBA-only mode ignoring FBM Buy Box ($${buyboxPriceCents ? (buyboxPriceCents / 100).toFixed(2) : 'n/a'}) and anchoring to Lowest FBA ($${lowestFbaPriceCents ? (lowestFbaPriceCents / 100).toFixed(2) : 'n/a'}) mode=${effectiveFbmCompetitionMode}`
          );
        }

        // ── No BB Progress streak tracking ──
        const wasLosing = assignment.last_buybox_status !== 'winning' && assignment.last_buybox_status !== 'owned';
        const stillLosing = !isBuyboxWinner;
        let noBbProgressBlocked = false;
        
        if (wasLosing && stillLosing && assignment.oscillation_state === 'competing') {
          const newNoBbStreak = (assignment.no_bb_progress_streak || 0) + 1;
          if (newNoBbStreak >= 3) {
            // Enter "no BB progress" cooldown
            const cooldownMs = 12 * 60000; // 12 minutes
            await supabase.from('repricer_assignments').update({
              last_sp_api_check_at: new Date().toISOString(),
              last_buybox_status: 'losing',
              no_bb_progress_streak: 0,
              oscillation_state: 'safety_cooldown',
              oscillation_cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
              oscillation_last_mode_used: assignment.oscillation_last_mode_used || 'aggressive',
              oscillation_last_reason: `no_bb_progress_${newNoBbStreak}_evals`,
            }).eq('id', assignmentId);
            supabase.from('repricer_price_actions').insert({
              user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
              action_type: 'oscillation_guard',
              trigger_source: triggerSource,
              old_price: assignment.last_applied_price ?? null,
              reason: `No BB Progress: ${newNoBbStreak} consecutive evals while losing BB and competing. 12min cooldown.`,
              success: true, update_method: 'none', rule_name: rule?.name || null,
            }).then(() => {});
            console.log(`[streak-guard] ${asin}/${marketplace}: ${newNoBbStreak} evals without BB progress → 12min cooldown`);
            results.push({ asin, sku, action: 'skipped', reason: `No BB Progress suppression: ${newNoBbStreak} evals` });
            noBbProgressBlocked = true;
          } else {
            await supabase.from('repricer_assignments').update({
              last_sp_api_check_at: new Date().toISOString(),
              last_buybox_status: 'losing',
              no_bb_progress_streak: newNoBbStreak,
            }).eq('id', assignmentId);
          }
        } else {
          // Reset streak on BB win or state change
          const bbStatusUpdate: Record<string, any> = {
            last_sp_api_check_at: new Date().toISOString(),
            last_buybox_status: isBuyboxWinner ? 'winning' : 'losing',
            no_bb_progress_streak: isBuyboxWinner ? 0 : (assignment.no_bb_progress_streak || 0),
          };
          // Clear BB loss tracking when we win the Buy Box back
          if (isBuyboxWinner) {
            bbStatusUpdate.buybox_lost_at = null;
            bbStatusUpdate.bb_recovery_escalation = 0;
            bbStatusUpdate.bb_loss_after_raise_count = 0;
          }
          await supabase.from('repricer_assignments').update(bbStatusUpdate).eq('id', assignmentId);
        }

        if (noBbProgressBlocked) {
          continue;
        }

        // ── Competitor Reaction Detection ──
        // Detect BB movement within 2h of a successful user price action
        try {
          const reactionWindowMs = 2 * 60 * 60 * 1000; // 2 hours
          const lastAppliedAt = assignment.last_applied_at ? new Date(assignment.last_applied_at).getTime() : 0;
          const timeSinceAction = Date.now() - lastAppliedAt;
          const freshBb = spPricing.buyboxPrice;

          if (freshBb && lastAppliedAt > 0 && timeSinceAction <= reactionWindowMs) {
            // Get the snapshot that existed BEFORE the user's last price action
            const { data: priorSnap } = await supabase
              .from('repricer_competitor_snapshots')
              .select('buybox_price')
              .eq('user_id', userId)
              .eq('asin', asin)
              .eq('marketplace', marketplace)
              .lt('fetched_at', assignment.last_applied_at)
              .not('buybox_price', 'is', null)
              .order('fetched_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            const priorBb = priorSnap?.buybox_price;
            if (priorBb && Math.abs(freshBb - priorBb) >= 0.01) {
              // BB changed since user's action — log reaction
              const reactionSeconds = Math.round(timeSinceAction / 1000);

              // Deduplicate: check if we already logged this reaction
              const { data: existing } = await supabase
                .from('repricer_reaction_log')
                .select('id')
                .eq('user_id', userId)
                .eq('asin', asin)
                .eq('marketplace', marketplace)
                .gte('detected_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
                .limit(1)
                .maybeSingle();

              if (!existing) {
                await supabase.from('repricer_reaction_log').insert({
                  user_id: userId,
                  asin,
                  marketplace,
                  our_price_change_at: assignment.last_applied_at,
                  our_old_price: assignment.last_applied_price ?? null,
                  our_new_price: assignment.last_applied_price ?? null,
                  competitor_price_before: priorBb,
                  competitor_price_after: freshBb,
                  reaction_time_seconds: reactionSeconds,
                });
                console.log(`[reaction-detect] ${asin}/${marketplace}: BB moved $${priorBb} → $${freshBb} in ${reactionSeconds}s after our action`);
              }
            }
          }
        } catch (reactionErr) {
          // Non-critical — don't block repricing
          console.warn(`[reaction-detect] Error for ${asin}:`, reactionErr);
        }

        const rfData: any = null;
        if (force_rainforest) {
          console.log(`[repricer-scheduler] force_rainforest requested for ${asin}, but legacy Rainforest lane is disabled in this scheduler build`);
        }

        let { data: inv } = await supabase
          .from('inventory')
          .select('cost, min_price, max_price, my_price, price, available, reserved, updated_at, last_price_update_at, last_price_update_status, estimated_age_days, listing_created_at')
          .eq('user_id', userId)
          .eq('asin', asin)
          .eq('sku', sku)
          .maybeSingle();

        // ── FBM FALLBACK: FBM listings live only in `created_listings` and never
        // get an `inventory` row from the Summaries API. Without this, the scheduler
        // hard-skips with "No inventory record" and the AI evaluator never runs,
        // so My Price stays "missing" and no decision is recorded.
        if (!inv) {
          const { data: cl } = await supabase
            .from('created_listings')
            .select('cost, amount, units, price')
            .eq('user_id', userId)
            .eq('asin', asin)
            .eq('sku', sku)
            .maybeSingle();
          if (cl) {
            const fbmPrice = cl.price != null ? Number(cl.price) : null;
            // Cost Contract A: created_listings.cost = TOTAL batch cost; amount = UNIT cost.
            // Floor math expects PER-UNIT cost, so derive it (prefer amount; else cost/units).
            const clUnits = Number(cl.units) || 0;
            const clAmount = cl.amount != null ? Number(cl.amount) : null;
            const clCost = cl.cost != null ? Number(cl.cost) : null;
            let unitCost: number | null = null;
            if (clAmount != null && clAmount >= 0) unitCost = clAmount;
            else if (clCost != null && clCost >= 0 && clUnits > 0) unitCost = clCost / clUnits;
            inv = {
              cost: unitCost,
              min_price: null,
              max_price: null,
              my_price: fbmPrice,
              price: fbmPrice,
              available: cl.units ?? 0,
              reserved: 0,
              updated_at: null,
              last_price_update_at: null,
              last_price_update_status: null,
              estimated_age_days: null,
              listing_created_at: null,
            } as any;
            console.log(`[repricer-scheduler] FBM FALLBACK ${asin}/${sku}: using created_listings (price=$${fbmPrice}, units=${cl.units}, unit_cost=$${unitCost?.toFixed(2) ?? 'null'}, my_price_source=created_listings)`);
          }
        }

        if (!inv) {
          results.push({ asin, sku, action: 'skipped', reason: 'No inventory record — cannot compute floor price' });
          await markSubmitted(supabase, userId, idempotencyKey as any, asin, marketplace, 0);
          continue;
        }

        // update-amazon-price only writes my_price/price back into `inventory`
        // for the US marketplace (non-US submissions are intentionally kept
        // out of that row to avoid cross-marketplace contamination — see
        // update-amazon-price/index.ts). But it bumps last_price_update_at/
        // last_price_update_status='success' for EVERY marketplace. So for
        // non-US, inv.my_price/price is permanently stale while its
        // timestamp keeps looking fresh — trusting it here fed a frozen
        // price into the evaluator on every cycle, which the Universal
        // Floor Guard then "corrected" back down, undoing legitimate raises
        // (observed on B07VSNBTSH/CA: inv.my_price stuck at $16.37 forever
        // while real submitted prices reached $35-40). Non-US must instead
        // check the marketplace-scoped cache that update-amazon-price does
        // keep current: asin_my_price_cache.
        let inventoryLivePriceCents: number | null = null;
        let inventoryPriceUpdateTs = 0;
        let inventoryLiveStatusOk = false;
        if (marketplace === 'US') {
          inventoryLivePriceCents = inv.my_price != null
            ? Math.round(inv.my_price * 100)
            : (inv.price != null ? Math.round(inv.price * 100) : null);
          inventoryPriceUpdateTs = inv.last_price_update_at ? new Date(inv.last_price_update_at).getTime() : 0;
          inventoryLiveStatusOk = inv.last_price_update_status === 'success';
        } else {
          const amazonMarketplaceId = MARKETPLACE_META[marketplace]?.amazonMarketplaceId;
          if (amazonMarketplaceId) {
            const { data: priceCache } = await supabase
              .from('asin_my_price_cache')
              .select('my_price, fetched_at')
              .eq('user_id', userId)
              .eq('asin', asin)
              .eq('marketplace_id', amazonMarketplaceId)
              .eq('seller_sku', sku || '__NO_SKU__')
              .maybeSingle();
            if (priceCache?.my_price != null) {
              inventoryLivePriceCents = Math.round(priceCache.my_price * 100);
              inventoryPriceUpdateTs = priceCache.fetched_at ? new Date(priceCache.fetched_at).getTime() : 0;
              inventoryLiveStatusOk = true;
            }
          }
        }
        const assignmentLastAppliedTs = assignment.last_applied_at ? new Date(assignment.last_applied_at).getTime() : 0;
        const shouldPreferInventoryLivePrice = Boolean(
          inventoryLivePriceCents != null &&
          (spApiMyPriceCents == null || Math.abs(inventoryLivePriceCents - spApiMyPriceCents) >= 1) &&
          inventoryLiveStatusOk &&
          inventoryPriceUpdateTs >= assignmentLastAppliedTs
        );

        if (shouldPreferInventoryLivePrice) {
          console.log(
            `[repricer-scheduler] CURRENT PRICE OVERRIDE ${asin}/${marketplace}: inventory/live $${(inventoryLivePriceCents! / 100).toFixed(2)} replaces SP-API/current $${spApiMyPriceCents != null ? (spApiMyPriceCents / 100).toFixed(2) : 'null'}`
          );
          myCurrentPriceCents = inventoryLivePriceCents;
        }

        // Stock-gated maximize: if available=0 but reserved>0 (FC transfer/processing),
        // don't hard-skip — allow the AI evaluator to run in maximize-only mode.
        // Only truly skip when both available AND reserved are 0.
        const isStockGated = (inv.available ?? 0) <= 0;
        const hasReservedStock = (inv.reserved ?? 0) > 0;

        if (isStockGated && !hasReservedStock) {
          results.push({ asin, sku, action: 'skipped', reason: 'Out of stock (0 available, 0 reserved) — skipping repricing' });
          await markSubmitted(supabase, userId, idempotencyKey as any, asin, marketplace, 0);
          continue;
        }

        if (isStockGated && hasReservedStock) {
          console.log(`[repricer-scheduler] ${asin}/${marketplace}: stock-gated (avail=0, reserved=${inv.reserved}) — will run maximize-only recovery mode`);
        }

        // ── RESTOCK RE-ENTRY: Detect active snap-back flag ──
        const restockReentryAt = assignment.restock_reentry_at ? new Date(assignment.restock_reentry_at) : null;
        const restockReentryActive = Boolean(
          restockReentryAt
          && !isStockGated // Only snap-back when stock is actually available
          && (Date.now() - restockReentryAt.getTime()) < 30 * 60 * 1000 // 30 min expiry
        );
        if (restockReentryActive) {
          console.log(`[repricer-scheduler] ${asin}/${marketplace}: RESTOCK RE-ENTRY ACTIVE (flagged ${Math.round((Date.now() - restockReentryAt!.getTime()) / 1000)}s ago) — will apply snap-back pricing`);
        }
        // Expire stale restock flags silently
        if (restockReentryAt && !restockReentryActive && !isStockGated) {
          console.log(`[repricer-scheduler] ${asin}/${marketplace}: restock_reentry_at expired (${Math.round((Date.now() - restockReentryAt.getTime()) / 60000)}m old) — clearing`);
          supabase.from('repricer_assignments').update({ restock_reentry_at: null }).eq('id', assignmentId).then(() => {});
        }

        const costCents = Math.round((inv.cost || 0) * 100);
        const minOverrideCents = assignment.min_price_override ? Math.round(assignment.min_price_override * 100) : null;
        const maxOverrideCents = assignment.max_price_override ? Math.round(assignment.max_price_override * 100) : null;
        const invMinCents = inv.min_price ? Math.round(inv.min_price * 100) : 0;
        const invMaxCents = inv.max_price ? Math.round(inv.max_price * 100) : 0;

        const minMarginPct = rule.min_margin_percent ?? 0;
        const floorFromCost = costCents > 0 ? Math.round(costCents * (1 + minMarginPct / 100)) : 0;
        // Manual min on repricer_assignments is the user's authoritative Amazon min bound.
        // Do NOT re-raise it from inventory.min_price/cost margin during scheduler submit;
        // that silently restores old floors (ex: user lowers min to $7, scheduler sends $10.70).
        const floorCents = minOverrideCents ?? invMinCents;
        if (minOverrideCents != null && floorFromCost > minOverrideCents) {
          console.log(`[repricer-scheduler] ${asin}/${marketplace}: manual min wins — stored min $${(minOverrideCents/100).toFixed(2)} below cost reference $${(floorFromCost/100).toFixed(2)}; not restoring floor`);
        }
        const ceilingCents = maxOverrideCents ?? invMaxCents ?? 0;

        if (floorCents <= 0) {
          results.push({ asin, sku, action: 'skipped', reason: 'Floor price is zero — check cost and margin settings' });
          continue;
        }

        if (ceilingCents > 0 && floorCents > ceilingCents) {
          results.push({ asin, sku, action: 'skipped', reason: `Floor ($${(floorCents/100).toFixed(2)}) > ceiling ($${(ceilingCents/100).toFixed(2)}) — fix pricing config` });
          continue;
        }

        const strategy = rule.strategy ?? 'match_buybox';
        const isAiWinSalesBooster = strategy === 'AI_WIN_SALES_BOOSTER';
        const competitorCents = rfData?.lowestPrice
          ? Math.round(rfData.lowestPrice * 100)
          : (fbaOnlyModeWithFbmBuybox ? lowestFbaPriceCents : effectiveBuyboxPriceCents);

        // ═══════════════════════════════════════════════════
        // PHASE 2: ADAPTIVE HYBRID — Auto-switch Smart ↔ Basic
        // ═══════════════════════════════════════════════════
        const evalMode = assignment.eval_mode || 'auto';
        let activeEvalMode: 'smart' | 'basic' = assignment.active_eval_mode || 'smart';
        let evalModeSwitched = false;
        let evalModeSwitchReason = '';

        if (evalMode === 'auto') {
          const noChangeStreak = assignment.no_change_streak || 0;

          // ≤1000 ASINs: keep all Smart — catalog is small enough for full AI coverage
          // >1000 ASINs: allow auto-switching to Basic for listings that are already
          // comfortably won and stable — NOT for stuck/losing listings. A listing that's
          // stuck and losing needs Smart's guards and reasoning most; a listing that's
          // been holding the Buy Box unchanged for many cycles has nothing left for
          // Smart to optimize, so "match/hold BB" already captures the achievable value.
          const hybridThreshold = 1000;
          const stableCyclesThreshold = 5;

          // Switch to BASIC when: >1000 ASINs AND currently BB owner AND stable (no_change ≥ 5)
          if (userTotalActive > hybridThreshold && isBuyboxWinner && noChangeStreak >= stableCyclesThreshold && activeEvalMode === 'smart') {
            activeEvalMode = 'basic';
            evalModeSwitched = true;
            evalModeSwitchReason = `Auto→Basic: BB owner stable for ${noChangeStreak} cycles — nothing left to optimize`;
            console.log(`[eval-mode-switch] ${asin}/${marketplace}: ${evalModeSwitchReason}`);
          }
          // Switch back to SMART when: no longer BB owner — needs Smart's help to fight back
          else if (activeEvalMode === 'basic' && !isBuyboxWinner) {
            activeEvalMode = 'smart';
            evalModeSwitched = true;
            evalModeSwitchReason = 'Basic→Smart: Buy Box lost — needs Smart evaluation to recover';
            console.log(`[eval-mode-switch] ${asin}/${marketplace}: ${evalModeSwitchReason}`);
          }

          if (evalModeSwitched) {
            supabase.from('repricer_assignments').update({
              active_eval_mode: activeEvalMode,
              eval_mode_reason: evalModeSwitchReason,
              eval_mode_switched_at: new Date().toISOString(),
            }).eq('id', assignmentId).then(() => {});
            // Log the switch in price_actions for observability
            supabase.from('repricer_price_actions').insert({
              user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
              action_type: 'no_change',
              trigger_source: triggerSource,
              old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
              reason: `[Eval Mode Switch] ${evalModeSwitchReason}`,
              success: true, update_method: 'none', rule_name: rule?.name || null,
            }).then(() => {});
          }
        } else if (evalMode === 'force_smart') {
          activeEvalMode = 'smart';
        } else if (evalMode === 'force_basic') {
          activeEvalMode = 'basic';
        }

        // ═══════════════════════════════════════════════════
        // BASIC MODE EVALUATOR — lightweight, no AI calls
        // ═══════════════════════════════════════════════════
        let targetCents: number | null = null;
        let targetReason: string | null = null;
        let targetIntelligenceFactors: any | null = null;
        let ackConstraintApplied: string | null = null;
        let basicHandled = false;

        if (activeEvalMode === 'basic' && !isAiWinSalesBooster) {
          // Determine basic strategy: from basic_rule_id or default
          let basicStrategy = 'BASIC_MATCH_BB';
          if (assignment.basic_rule_id) {
            const { data: basicRule } = await supabase
              .from('repricer_rules')
              .select('strategy')
              .eq('id', assignment.basic_rule_id)
              .maybeSingle();
            if (basicRule?.strategy) basicStrategy = basicRule.strategy;
          }

          let basicTargetCents: number | null = null;
          let basicReason = '';

          switch (basicStrategy) {
            case 'BASIC_MATCH_BB':
              basicTargetCents = effectiveBuyboxPriceCents ?? null;
              basicReason = `Basic: Match BB ($${basicTargetCents ? (basicTargetCents/100).toFixed(2) : 'n/a'})`;
              break;
            case 'BASIC_UNDERCUT_BB': {
              const undercutCents = effectiveBuyboxPriceCents ? effectiveBuyboxPriceCents - 1 : null;
              basicTargetCents = undercutCents && undercutCents > 0 ? undercutCents : null;
              basicReason = `Basic: Undercut BB by $0.01 ($${basicTargetCents ? (basicTargetCents/100).toFixed(2) : 'n/a'})`;
              break;
            }
            case 'BASIC_MATCH_LOWEST':
              basicTargetCents = competitorCents ?? effectiveBuyboxPriceCents ?? null;
              basicReason = `Basic: Match Lowest ($${basicTargetCents ? (basicTargetCents/100).toFixed(2) : 'n/a'})`;
              break;
            case 'BASIC_HOLD':
              basicTargetCents = myCurrentPriceCents ?? null;
              basicReason = 'Basic: Hold current price';
              break;
            default:
              basicTargetCents = effectiveBuyboxPriceCents ?? null;
              basicReason = `Basic: Match BB (default) ($${basicTargetCents ? (basicTargetCents/100).toFixed(2) : 'n/a'})`;
          }

          if (!basicTargetCents) {
            results.push({ asin, sku, action: 'skipped', reason: `Basic mode: no target price available (strategy: ${basicStrategy})` });
            continue;
          }

          // Clamp to floor/ceiling
          basicTargetCents = Math.max(floorCents, basicTargetCents);
          if (ceilingCents > 0) basicTargetCents = Math.min(ceilingCents, basicTargetCents);

          // Check if change is meaningful
          const basicChangeCents = myCurrentPriceCents != null ? Math.abs(basicTargetCents - myCurrentPriceCents) : Infinity;
          if (basicChangeCents < 1 && !force_all) {
            // No change — increment streak
            const newStreak = (assignment.no_change_streak || 0) + 1;
            supabase.from('repricer_assignments').update({
              no_change_streak: newStreak,
              last_evaluated_at: new Date().toISOString(),
              last_ack_result: 'no_change',
              last_ack_reason: `${basicReason} — no change (streak: ${newStreak})`,
            }).eq('id', assignmentId).then(() => {});
            supabase.from('repricer_eval_acks').upsert({
              user_id: userId, asin, sku: sku || '', marketplace,
              buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
              lowest_fba_price: spPricing?.lowestFbaPrice ?? null,
              my_price: myCurrentPriceCents ? myCurrentPriceCents / 100 : null,
              is_buybox_owner: isBuyboxWinner,
              result: 'no_change', reason: basicReason,
              constraint_applied: `basic_${basicStrategy}`,
              trigger_source: triggerSource,
              acked_at: new Date().toISOString(),
            }, { onConflict: 'user_id,asin,sku,marketplace' }).then(() => {});
            results.push({ asin, sku, action: 'checked', reason: `${basicReason} — no change`, spApiUsed: true });
            processed++;
            basicHandled = true;
          } else {
            // Actual price change — set target and reset streak
            targetCents = basicTargetCents;
            targetReason = `${basicReason} [⚡ Basic mode]`;
            ackConstraintApplied = `basic_${basicStrategy}`;
            supabase.from('repricer_assignments').update({
              no_change_streak: 0,
              last_evaluated_at: new Date().toISOString(),
            }).eq('id', assignmentId).then(() => {});
            console.log(`[basic-eval] ${asin}/${marketplace}: ${basicReason} → $${(basicTargetCents/100).toFixed(2)}`);
          }
        }

        if (basicHandled) continue;

        // Smart evaluation path (skip if basic already resolved)
        if (targetCents == null && isAiWinSalesBooster) {
          let aiEval: any = null;
          try {
            const aiResp = await fetch(`${supabaseUrl}/functions/v1/repricer-ai-evaluate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
              body: JSON.stringify({
                assignmentId,
                asin,
                sku,
                marketplace,
                currentPrice: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : undefined,
                user_id: userId,
                internal: true,
                dry_run: dry_run,
                is_priority: is_priority,
                sp_api_data: spPricing,
                stock_gated_maximize: isStockGated && hasReservedStock,
                restock_reentry: restockReentryActive,
                trigger_source: triggerSource,
                force_mode: force_mode,
              }),
            });

            aiEval = await aiResp.json().catch(() => null);
            if (!aiResp.ok || !aiEval?.success) {
              const aiError = aiEval?.error || `repricer-ai-evaluate HTTP ${aiResp.status}`;
              console.warn(`[repricer-scheduler] AI eval failed for ${asin}/${marketplace}: ${aiError}`);
              if (force_mode) {
                supabase.from('repricer_price_actions').insert({
                  user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                  action_type: 'error', trigger_source: triggerSource,
                  old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
                  reason: `Force ${force_mode} aborted: AI evaluation failed — ${aiError}`,
                  error_type: 'ai_eval_failed',
                  success: false, update_method: 'none', rule_name: rule?.name || null,
                }).then(() => {});
              }
              results.push({ asin, sku, action: 'error', reason: aiError, spApiUsed: true });
              continue;
            }
          } catch (aiErr: any) {
            const aiError = aiErr?.message || 'AI evaluation request failed';
            console.warn(`[repricer-scheduler] AI eval exception for ${asin}/${marketplace}:`, aiErr);
            if (force_mode) {
              supabase.from('repricer_price_actions').insert({
                user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                action_type: 'error', trigger_source: triggerSource,
                old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
                reason: `Force ${force_mode} aborted: AI evaluation exception — ${aiError}`,
                error_type: 'ai_eval_exception',
                success: false, update_method: 'none', rule_name: rule?.name || null,
              }).then(() => {});
            }
            results.push({ asin, sku, action: 'error', reason: aiError, spApiUsed: true });
            continue;
          }

          targetReason = aiEval.reason || 'AI evaluation completed';
          const resolvedTargetReason = targetReason || 'AI evaluation completed';
          targetIntelligenceFactors = aiEval.intelligenceFactors || null;
          const aiGuards = Array.isArray(aiEval.guardsApplied) ? aiEval.guardsApplied.filter(Boolean) : [];
          ackConstraintApplied = aiGuards.length > 0 ? aiGuards.join(',') : null;
          const aiForcedFloorGuard = aiGuards.some((guard: string) =>
            guard === 'universal_floor_guard' ||
            guard === 'universal_floor_recovery' ||
            guard === 'bb_owner_floor_recovery' ||
            guard === 'emergency_floor_guard'
          );

          if (typeof aiEval.recommendedPrice === 'number' && Number.isFinite(aiEval.recommendedPrice)) {
            targetCents = Math.round(aiEval.recommendedPrice * 100);
            if (aiForcedFloorGuard && myCurrentPriceCents != null && targetCents > myCurrentPriceCents) {
              console.warn(`[repricer-scheduler] FLOOR FORCE ACTIVE ${asin}/${marketplace}: current ${(myCurrentPriceCents / 100).toFixed(2)} → target ${(targetCents / 100).toFixed(2)}; downstream ceiling/cooldown guards must not clamp this correction`);
            }

            // ── CUSTOM_PRICE with same price = no_change (e.g., "Not Buy Box eligible - keeping current price") ──
            // Don't submit to Amazon if the evaluator explicitly returned the current price as-is
            if ((aiEval.mode === 'CUSTOM_PRICE' || aiEval.mode === 'SKIP') && myCurrentPriceCents != null && targetCents === myCurrentPriceCents) {
              const keepReason = resolvedTargetReason || 'Keeping current price';
              supabase.from('repricer_eval_acks').upsert({
                user_id: userId, asin, sku: sku || '', marketplace,
                buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
                lowest_fba_price: spPricing?.lowestFbaPrice ?? null,
                lowest_fbm_price: spPricing?.lowestFbmPrice ?? null,
                my_price: myCurrentPriceCents / 100,
                is_buybox_owner: isBuyboxWinner,
                result: 'no_change', reason: keepReason,
                constraint_applied: 'keeping_current',
                recommended_price: targetCents / 100,
                trigger_source: triggerSource,
                acked_at: new Date().toISOString(),
              }, { onConflict: 'user_id,asin,sku,marketplace' }).then(() => {});
              const smartNoChangeStreak = (assignment.no_change_streak || 0) + 1;
              supabase.from('repricer_assignments').update({
                last_ack_result: 'no_change', last_ack_reason: keepReason,
                no_change_streak: smartNoChangeStreak,
              }).eq('id', assignmentId).then(() => {});
              supabase.from('repricer_price_actions').insert({
                user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                action_type: 'no_change',
                trigger_source: triggerSource,
                old_price: myCurrentPriceCents / 100,
                intended_price: targetCents / 100,
                effective_floor_cents: floorCents,
                reason: keepReason,
                success: true, update_method: 'none', rule_name: rule?.name || null,
              }).then(() => {});
              results.push({ asin, sku, action: 'checked', reason: keepReason, spApiUsed: true });
              processed++;
              continue;
            }
          } else {
            if (dry_run) {
              results.push({ asin, sku, action: 'evaluated', reason: `DRY RUN — ${resolvedTargetReason}`, rainforestUsed: false, spApiUsed: true });
              processed++;
              continue;
            }

            const ackResult = aiEval.mode === 'DO_NOT_REPRICE' ? 'blocked' : 'no_change';
            const actionType = 'no_change'; // Profit Guard removed — no blocked_by_profit_guard writes.

            await supabase.from('repricer_eval_acks').upsert({
              user_id: userId,
              asin,
              sku: sku || '',
              marketplace,
              buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
              lowest_fba_price: spPricing?.lowestFbaPrice ?? null,
              lowest_fbm_price: spPricing?.lowestFbmPrice ?? null,
              my_price: myCurrentPriceCents ? myCurrentPriceCents / 100 : null,
              is_buybox_owner: isBuyboxWinner,
              result: ackResult,
              reason: resolvedTargetReason,
              constraint_applied: ackConstraintApplied,
              recommended_price: null,
              applied_price: null,
              trigger_source: triggerSource,
              acked_at: new Date().toISOString(),
            }, { onConflict: 'user_id,asin,sku,marketplace' });

            const smartNoChangeStreak2 = (assignment.no_change_streak || 0) + 1;
            await supabase.from('repricer_assignments').update({
              last_ack_result: ackResult,
              last_ack_reason: resolvedTargetReason.slice(0, 200),
              last_evaluated_at: new Date().toISOString(),
              last_recommended_price: null,
              last_recommendation_reason: resolvedTargetReason,
              no_change_streak: smartNoChangeStreak2,
            }).eq('id', assignmentId);

            await supabase.from('repricer_price_actions').insert({
              user_id: userId,
              assignment_id: assignmentId,
              asin,
              sku,
              marketplace,
              action_type: actionType,
              trigger_source: triggerSource,
              old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
              intended_price: null,
              effective_floor_cents: floorCents,
              reason: resolvedTargetReason,
              intelligence_factors: targetIntelligenceFactors,
              success: true,
              update_method: 'none',
              rule_name: rule?.name || null,
            });

            results.push({ asin, sku, action: 'checked', reason: resolvedTargetReason, spApiUsed: true });
            processed++;
            continue;
          }

          console.log(`[repricer-scheduler] ${asin}/${marketplace}: AI evaluator selected $${(targetCents / 100).toFixed(2)} (${resolvedTargetReason})`);
        } else if (targetCents == null) {
          // Standard rule-based evaluation (only if basic didn't already resolve)
          switch (strategy) {
            case 'match_buybox':
              targetCents = effectiveBuyboxPriceCents;
              break;
            case 'beat_buybox': {
              const beatBy = rule.beat_by_amount_cents ?? 1;
              targetCents = effectiveBuyboxPriceCents ? effectiveBuyboxPriceCents - beatBy : null;
              break;
            }
            case 'beat_lowest': {
              const beatBy = rule.beat_by_amount_cents ?? 1;
              targetCents = competitorCents ? competitorCents - beatBy : null;
              break;
            }
            case 'match_lowest':
              targetCents = competitorCents;
              break;
            case 'fixed_price':
              targetCents = rule.fixed_price_cents ?? floorCents;
              break;
            case 'target_margin': {
              const tgtMargin = rule.target_margin_percent ?? 15;
              targetCents = costCents > 0 ? Math.round(costCents * (1 + tgtMargin / 100)) : null;
              break;
            }
            default:
              targetCents = effectiveBuyboxPriceCents;
          }
        }

        if (!targetCents) {
          results.push({ asin, sku, action: 'skipped', reason: `Cannot compute target price (strategy: ${strategy}, buybox: ${effectiveBuyboxPriceCents ?? 'n/a'}, lowest_fba: ${lowestFbaPriceCents ?? 'n/a'})` });
          continue;
        }

        // Always clamp to Min/Max bounds — except hard floor recovery from AI evaluator.
        // Floor recovery is a safety correction: if price is below effective floor, it must
        // bypass stale max ceilings / step guards that would otherwise keep a loss price live.
        {
          const preClampTarget = targetCents;
          const isAiForcedFloorTarget = isAiWinSalesBooster && ackConstraintApplied?.split(',').some((guard) =>
            guard === 'universal_floor_guard' ||
            guard === 'universal_floor_recovery' ||
            guard === 'bb_owner_floor_recovery' ||
            guard === 'emergency_floor_guard'
          );
          if (floorCents > 0) targetCents = Math.max(floorCents, targetCents);
          if (ceilingCents > 0 && !isAiForcedFloorTarget) targetCents = Math.min(ceilingCents, targetCents);
          if (targetCents !== preClampTarget) {
            await incrementClampCount(supabase, assignmentId);
            console.log(`[repricer-scheduler] ${asin}/${marketplace}: Clamped $${(preClampTarget/100).toFixed(2)} → $${(targetCents/100).toFixed(2)} (floor=$${(floorCents/100).toFixed(2)}, ceiling=$${(ceilingCents/100).toFixed(2)})`);
          } else if (isAiForcedFloorTarget && ceilingCents > 0 && targetCents > ceilingCents) {
            console.warn(`[repricer-scheduler] ${asin}/${marketplace}: Hard floor target $${(targetCents/100).toFixed(2)} bypassed stale ceiling $${(ceilingCents/100).toFixed(2)}`);
          }
        }

        // Declare oscillation variables outside the if block so they're accessible later
        let effectiveOscMode: 'safe' | 'balanced' | 'aggressive' = (rule.oscillation_mode || 'safe') as 'safe' | 'balanced' | 'aggressive';
        let effectiveOscCooldown = rule.oscillation_cooldown_minutes ?? 20;
        let effectiveOscMaxReactions = rule.oscillation_max_reactions ?? 0;
        let effectiveOscBbLossLimit = rule.oscillation_bb_loss_limit ?? 2;

        if (myCurrentPriceCents) {

          // ── ADAPTIVE OSCILLATION: auto-resolve mode from market signals ──
          if (rule.oscillation_mode === 'auto') {
            const aiStyle = (rule.ai_settings?.oscillation_ai_style || 'balanced') as 'conservative' | 'balanced' | 'aggressive';
            // Compute oscillation score from assignment signals
            const recentChanges = assignment.recent_price_changes_count || 0; // changes in last 30 min
            const noChangeStreak = assignment.no_change_streak || 0;
            const bbLossStreak = assignment.bb_loss_streak || 0;
            const oscState = assignment.oscillation_state || 'normal';
            const wasInCooldown = oscState === 'safety_cooldown' || oscState === 'bb_loss_cooldown';
            const bbLossAfterRaise = assignment.bb_loss_after_raise_count || 0;
            const recentPrices: number[] = (assignment.recent_prices || []).slice(-10);

            // ── STABILITY DECAY: Reset stale volatile signals when market is calm ──
            // If last result was no_change/monopoly with no BB losses, the market is calm.
            // Decay bb_loss_streak and bb_loss_after_raise_count so the score naturally drops.
            const lastResult = assignment.last_ack_result || '';
            const isMarketCalm = (lastResult === 'no_change' || lastResult === 'already_optimal' || lastResult === '')
              && bbLossStreak === 0 && recentChanges === 0;
            
            // If market is calm and we still show elevated signals, decay them
            const effectiveBbLossStreak = isMarketCalm ? 0 : bbLossStreak;
            const effectiveBbLossAfterRaise = isMarketCalm ? 0 : bbLossAfterRaise;
            const effectiveRecentChanges = isMarketCalm ? 0 : recentChanges;
            // If in cooldown but market is calm (no activity), don't count cooldown as volatility
            const effectiveWasInCooldown = isMarketCalm ? false : wasInCooldown;

            // If calm, also reset the stale counters in DB so next cycle starts clean
            if (isMarketCalm && (assignment.bb_loss_after_raise_count > 0 || assignment.oscillation_reaction_count > 0)) {
              supabase.from('repricer_assignments').update({
                bb_loss_after_raise_count: 0,
                oscillation_reaction_count: 0,
              }).eq('id', assignmentId).then(() => {});
            }

            // ── EXPANDED SIGNALS ──

            // 1. Price direction reversals (up/down/up = bot war signature)
            let directionReversals = 0;
            if (recentPrices.length >= 3) {
              for (let i = 2; i < recentPrices.length; i++) {
                const prev = recentPrices[i - 1] - recentPrices[i - 2];
                const curr = recentPrices[i] - recentPrices[i - 1];
                if ((prev > 0.005 && curr < -0.005) || (prev < -0.005 && curr > 0.005)) {
                  directionReversals++;
                }
              }
            }

            // 2. BB owner churn — did we lose BB after raising? (strong war signal)
            const bbChurnSignal = effectiveBbLossAfterRaise >= 2;

            // 3. Failed lower detection — recent lowers that didn't win BB
            const recentLowersWithoutWin = !isMarketCalm && (assignment.oscillation_reaction_count || 0) > 2 && !isBuyboxWinner;

            // 4. Lowest FBA movement speed — check if competitor snapshot shows rapid changes
            const competitorActivelyMoving = effectiveBbLossStreak >= 3 && effectiveRecentChanges >= 2;

            // Score: higher = more volatile market
            let oscScore = 0;
            const scoreBreakdown: string[] = [];

            // Market calm shortcut — if truly calm, score stays 0
            if (isMarketCalm) {
              scoreBreakdown.push('calm:0');
            } else {
              // Price change frequency
              if (effectiveRecentChanges >= 6) { oscScore += 3; scoreBreakdown.push(`freq:+3(${effectiveRecentChanges})`); }
              else if (effectiveRecentChanges >= 3) { oscScore += 2; scoreBreakdown.push(`freq:+2(${effectiveRecentChanges})`); }
              else if (effectiveRecentChanges >= 1) { oscScore += 1; scoreBreakdown.push(`freq:+1(${effectiveRecentChanges})`); }

              // BB loss streak
              if (effectiveBbLossStreak >= 4) { oscScore += 3; scoreBreakdown.push(`bbLoss:+3(${effectiveBbLossStreak})`); }
              else if (effectiveBbLossStreak >= 2) { oscScore += 2; scoreBreakdown.push(`bbLoss:+2(${effectiveBbLossStreak})`); }
              else if (effectiveBbLossStreak >= 1) { oscScore += 1; scoreBreakdown.push(`bbLoss:+1(${effectiveBbLossStreak})`); }

              // No-change streak
              if (noChangeStreak >= 5) { oscScore += 1; scoreBreakdown.push(`noChange:+1(${noChangeStreak})`); }

              // Was in cooldown
              if (effectiveWasInCooldown) { oscScore += 1; scoreBreakdown.push('cooldown:+1'); }

              // Direction reversals (strong bot-war signal)
              if (directionReversals >= 3) { oscScore += 3; scoreBreakdown.push(`reversals:+3(${directionReversals})`); }
              else if (directionReversals >= 2) { oscScore += 2; scoreBreakdown.push(`reversals:+2(${directionReversals})`); }
              else if (directionReversals >= 1) { oscScore += 1; scoreBreakdown.push(`reversals:+1(${directionReversals})`); }

              // BB churn after raises
              if (bbChurnSignal) { oscScore += 2; scoreBreakdown.push(`bbChurn:+2(${effectiveBbLossAfterRaise})`); }

              // Failed lowers without BB win
              if (recentLowersWithoutWin) { oscScore += 1; scoreBreakdown.push('failedLowers:+1'); }

              // Competitor actively moving
              if (competitorActivelyMoving) { oscScore += 1; scoreBreakdown.push('compMoving:+1'); }
            }

            // Apply AI style bias
            const styleBias = aiStyle === 'conservative' ? 1 : aiStyle === 'aggressive' ? -1 : 0;
            oscScore += styleBias;
            if (styleBias !== 0) scoreBreakdown.push(`style:${styleBias > 0 ? '+' : ''}${styleBias}`);
            // Ensure score doesn't go negative
            if (oscScore < 0) oscScore = 0;

            // Resolve effective mode
            if (oscScore >= 5) {
              effectiveOscMode = 'safe';
              effectiveOscCooldown = 20;
              effectiveOscMaxReactions = 0;
              effectiveOscBbLossLimit = 1;
            } else if (oscScore >= 3) {
              effectiveOscMode = 'balanced';
              effectiveOscCooldown = 10;
              effectiveOscMaxReactions = 2;
              effectiveOscBbLossLimit = 2;
            } else {
              effectiveOscMode = 'aggressive';
              effectiveOscCooldown = 5;
              effectiveOscMaxReactions = 999;
              effectiveOscBbLossLimit = 3;
            }

            const oscReasonDetail = `auto_score_${oscScore}_${aiStyle}|${scoreBreakdown.join(',')}`;
            console.log(`[adaptive-osc] ${asin}/${marketplace}: score=${oscScore} style=${aiStyle} → ${effectiveOscMode} [${scoreBreakdown.join(', ')}]${isMarketCalm ? ' [CALM]' : ''}`);

            // Persist the resolved mode for UI observability
            supabase.from('repricer_assignments').update({
              oscillation_last_mode_used: effectiveOscMode,
              oscillation_last_reason: oscReasonDetail.slice(0, 200),
            }).eq('id', assignmentId).then(() => {});
          }

          // ─── INVENTORY PRESSURE for oscillation relief ───
          let inventoryPressureData: InventoryPressure | undefined;
          try {
            // Compute days without sale from asin_sales_daily
            const salesCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const { data: recentSales } = await supabase
              .from('asin_sales_daily')
              .select('date, units')
              .eq('user_id', userId)
              .eq('asin', asin)
              .gte('date', salesCutoff)
              .order('date', { ascending: false })
              .limit(30);

            let daysWithoutSale = 0;
            if (recentSales && recentSales.length > 0) {
              const lastSaleRow = recentSales.find((r: any) => (r.units || 0) > 0);
              if (lastSaleRow) {
                daysWithoutSale = Math.floor((Date.now() - new Date(lastSaleRow.date).getTime()) / (24 * 60 * 60 * 1000));
              } else {
                daysWithoutSale = 30; // No sales in 30 days
              }
            } else {
              daysWithoutSale = 30; // No data = assume no sales
            }

            // Compute days of stock
            const totalUnits30d = recentSales?.reduce((s: number, r: any) => s + (r.units || 0), 0) || 0;
            const avgDailySales = totalUnits30d / 30;
            const unitsAvailable = inv?.available ?? 0;
            const daysOfStock = avgDailySales > 0 ? Math.round(unitsAvailable / avgDailySales) : (unitsAvailable > 0 ? 999 : 0);

            // Compute inventory age
            const inventoryAgeDays = inv?.estimated_age_days
              ?? (inv?.listing_created_at
                ? Math.floor((Date.now() - new Date(inv.listing_created_at).getTime()) / (24 * 60 * 60 * 1000))
                : 0);

            inventoryPressureData = {
              daysWithoutSale,
              daysOfStock,
              unitsAvailable,
              inventoryAgeDays,
            };
          } catch (pressureErr) {
            // Non-critical — continue without pressure data
            console.warn(`[repricer-scheduler] inventory pressure calc error for ${asin}:`, pressureErr);
          }

          const oscSettings = {
            oscillation_mode: effectiveOscMode,
            oscillation_cooldown_minutes: effectiveOscCooldown,
            oscillation_max_reactions: effectiveOscMaxReactions,
            oscillation_bb_loss_limit: effectiveOscBbLossLimit,
          };
          const anomaly = await detectAnomalies(
            supabase,
            userId,
            assignmentId,
            assignment,
            targetCents / 100,
            myCurrentPriceCents / 100,
            oscSettings,
            isBuyboxWinner,
            effectiveBuyboxPriceCents != null ? effectiveBuyboxPriceCents / 100 : null,
            isStockGated && hasReservedStock,
            restockReentryActive,
            inventoryPressureData,
            (assignment.market_state as 'calm' | 'active' | 'chaotic' | undefined) || 'calm',
            triggerSource,
          );
          if (anomaly.forceEvalOnly) {
            // ── REPOSITION MODE: bypass oscillation guard when stuck far above floor ──
            // When losing BB and price is significantly above min floor, reposition
            // closer to market instead of fully blocking movement.
            //
            // STRICT MATCH GUARD: When the AI evaluator signaled strict_match_mode
            // (undercut=0 + BB anchor) or pure_bb_lock, reposition must NOT push
            // below the AI's anchor target. Previously this branch silently
            // overrode strict-match $19.00 → floor+5% $18.90, breaking the rule.
            const aiGuardsList = (ackConstraintApplied || '').split(',');
            const strictMatchEnforced = aiGuardsList.some((g) =>
              g === 'strict_match_mode_active'
              || g === 'strict_match_mode_blocked_enhanced_tuning'
              || g === 'pure_bb_lock_engaged'
              || g === 'suppressed_bb_blocked_enhanced_tuning'
            );

            const repositionGapPct = myCurrentPriceCents > 0 ? ((myCurrentPriceCents - floorCents) / myCurrentPriceCents) * 100 : 0;
            const repositionGapAbs = (myCurrentPriceCents - floorCents) / 100; // dollars
            const repositionEligible = !isBuyboxWinner
              && floorCents > 0
              && myCurrentPriceCents > floorCents
              && (repositionGapPct >= 10 || repositionGapAbs >= 3)
              && effectiveBuyboxPriceCents != null
              && effectiveBuyboxPriceCents < myCurrentPriceCents
              && !strictMatchEnforced;

            if (!repositionEligible && strictMatchEnforced) {
              console.log(`[reposition-mode] ${asin}/${marketplace}: BLOCKED — strict_match/pure_bb_lock active (guards=${ackConstraintApplied}). AI anchor target $${(targetCents/100).toFixed(2)} preserved; oscillation guard will hold.`);
            }

            if (repositionEligible) {
              // Reposition to floor + 5% buffer (stay above floor but close to market)
              const bufferPct = 0.05;
              let repositionCents = Math.round(floorCents * (1 + bufferPct));
              // STRICT MATCH FLOOR: never reposition BELOW the AI evaluator's target
              // (e.g. AI said match BB at $19.00 — reposition can't go to $18.90).
              if (isAiWinSalesBooster && targetCents > 0 && repositionCents < targetCents) {
                console.log(`[reposition-mode] ${asin}/${marketplace}: clamping reposition $${(repositionCents/100).toFixed(2)} up to AI anchor target $${(targetCents/100).toFixed(2)} (never reposition below AI anchor)`);
                repositionCents = targetCents;
              }
              // Only reposition if it's meaningfully lower than current price
              if (repositionCents < myCurrentPriceCents - 10) { // at least $0.10 lower
                console.log(`[reposition-mode] ${asin}/${marketplace}: price $${(myCurrentPriceCents/100).toFixed(2)} >> floor $${(floorCents/100).toFixed(2)} (gap ${repositionGapPct.toFixed(1)}%) while losing BB → repositioning to $${(repositionCents/100).toFixed(2)}`);
                targetCents = repositionCents;
                // Log reposition action
                supabase.from('repricer_price_actions').insert({
                  user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                  action_type: 'reposition_mode_active',
                  trigger_source: triggerSource,
                  old_price: myCurrentPriceCents / 100,
                  intended_price: repositionCents / 100,
                  effective_floor_cents: floorCents,
                  reason: `Reposition: price $${(myCurrentPriceCents/100).toFixed(2)} far above floor $${(floorCents/100).toFixed(2)} (${repositionGapPct.toFixed(1)}% gap) while losing BB. Oscillation guard bypassed for safe reposition to $${(repositionCents/100).toFixed(2)} (floor + ${(bufferPct*100).toFixed(0)}%).`,
                  success: true,
                  update_method: 'none',
                  rule_name: rule?.name || null,
                }).then(() => {});
                // Fall through to apply the repositioned price (do NOT continue)
              } else {
                // Too close to floor already, normal guard applies
                supabase.from('repricer_price_actions').insert({
                  user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                  action_type: 'oscillation_guard',
                  trigger_source: triggerSource,
                  old_price: myCurrentPriceCents / 100,
                  intended_price: targetCents / 100,
                  reason: `Guard: ${anomaly.oscillationAction} | mode: ${effectiveOscMode} | flags: ${anomaly.flags.join(',')} | score: ${anomaly.score}`,
                  success: true,
                  update_method: 'none',
                  rule_name: rule?.name || null,
                }).then(() => {});
                results.push({ asin, sku, action: 'skipped', reason: `Guard blocked: ${anomaly.oscillationAction} (score=${anomaly.score}, flags=${anomaly.flags.join(',')})` });
                continue;
              }
            } else {
              // Normal oscillation guard — block the change
              supabase.from('repricer_price_actions').insert({
                user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                action_type: 'oscillation_guard',
                trigger_source: triggerSource,
                old_price: myCurrentPriceCents / 100,
                intended_price: targetCents / 100,
                reason: `Guard: ${anomaly.oscillationAction} | mode: ${effectiveOscMode} | flags: ${anomaly.flags.join(',')} | score: ${anomaly.score}`,
                success: true,
                update_method: 'none',
                rule_name: rule?.name || null,
              }).then(() => {});
              results.push({ asin, sku, action: 'skipped', reason: `Guard blocked: ${anomaly.oscillationAction} (score=${anomaly.score}, flags=${anomaly.flags.join(',')})` });
              continue;
            }
          }
        }

        if (!isAiWinSalesBooster && targetCents <= floorCents && targetCents < (myCurrentPriceCents ?? Infinity)) {
          // ── TARGET BELOW MIN: snap to floor instead of blocking ──
          // If current price is above the floor, move DOWN to the floor
          // instead of doing nothing (the user's floor IS their competitive limit)
          if (myCurrentPriceCents != null && myCurrentPriceCents > floorCents) {
            const floorDeltaCents = myCurrentPriceCents - floorCents;
            // Only snap if the move is meaningful (at least $0.10 drop)
            if (floorDeltaCents >= 10) {
              console.log(`[target-below-min-snap] ${asin}/${marketplace}: target $${(targetCents/100).toFixed(2)} below floor $${(floorCents/100).toFixed(2)}, current $${(myCurrentPriceCents/100).toFixed(2)} → snapping to floor $${(floorCents/100).toFixed(2)}`);
              targetCents = floorCents;
              // Log snap action
              supabase.from('repricer_price_actions').insert({
                user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                action_type: 'target_below_min_applied_floor',
                trigger_source: triggerSource,
                old_price: myCurrentPriceCents / 100,
                intended_price: floorCents / 100,
                effective_floor_cents: floorCents,
                reason: `Target $${(targetCents/100).toFixed(2)} below min floor — snapped price from $${(myCurrentPriceCents/100).toFixed(2)} to floor $${(floorCents/100).toFixed(2)} instead of holding.`,
                success: true,
                update_method: 'none',
                rule_name: rule?.name || null,
              }).then(() => {});
              // Fall through to apply the floor price (do NOT continue)
            } else {
              // Already very close to floor — hold as before
              supabase.from('repricer_eval_acks').upsert({
                user_id: userId, asin, sku: sku || '', marketplace,
                buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
                my_price: myCurrentPriceCents / 100,
                is_buybox_owner: isBuyboxWinner,
                result: 'blocked', reason: 'At floor — holding price',
                constraint_applied: 'floor_hold',
                recommended_price: targetCents / 100,
                trigger_source: triggerSource,
                acked_at: new Date().toISOString(),
              }, { onConflict: 'user_id,asin,sku,marketplace' }).then(() => {});
              supabase.from('repricer_assignments').update({
                last_ack_result: 'blocked', last_ack_reason: 'At floor — holding price',
                no_change_streak: (assignment.no_change_streak || 0) + 1,
              }).eq('id', assignmentId).then(() => {});
              supabase.from('repricer_price_actions').insert({
                user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                action_type: 'no_change',
                trigger_source: triggerSource,
                old_price: myCurrentPriceCents / 100,
                intended_price: targetCents / 100,
                effective_floor_cents: floorCents,
                reason: 'At floor — holding price (within $0.10)',
                success: true, update_method: 'none', rule_name: rule?.name || null,
              }).then(() => {});
              results.push({ asin, sku, action: 'skipped', reason: 'At floor — holding price' });
              continue;
            }
          } else {
            // Already AT or below floor — hold
            supabase.from('repricer_eval_acks').upsert({
              user_id: userId, asin, sku: sku || '', marketplace,
              buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
              my_price: myCurrentPriceCents ? myCurrentPriceCents / 100 : null,
              is_buybox_owner: isBuyboxWinner,
              result: 'blocked', reason: 'At floor — holding price',
              constraint_applied: 'floor_hold',
              recommended_price: targetCents / 100,
              trigger_source: triggerSource,
              acked_at: new Date().toISOString(),
            }, { onConflict: 'user_id,asin,sku,marketplace' }).then(() => {});
            supabase.from('repricer_assignments').update({
              last_ack_result: 'blocked', last_ack_reason: 'At floor — holding price',
              no_change_streak: (assignment.no_change_streak || 0) + 1,
            }).eq('id', assignmentId).then(() => {});
            supabase.from('repricer_price_actions').insert({
              user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
              action_type: 'no_change',
              trigger_source: triggerSource,
              old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
              intended_price: targetCents / 100,
              effective_floor_cents: floorCents,
              reason: 'At floor — holding price',
              success: true, update_method: 'none', rule_name: rule?.name || null,
            }).then(() => {});
            results.push({ asin, sku, action: 'skipped', reason: 'At floor — holding price' });
            continue;
          }
        }

        if (!isAiWinSalesBooster) {
          const minChangeCents = rule.min_price_change_cents ?? 1;
          const changeCents = myCurrentPriceCents != null ? Math.abs(targetCents - myCurrentPriceCents) : Infinity;

          // ── ALREADY OPTIMAL BUT NOT WINNING → stronger undercut ──
          // If we match the BB price but don't own BB, apply $0.02–$0.05 undercut
          if (changeCents === 0 && !isBuyboxWinner && buyboxPriceCents && myCurrentPriceCents) {
            // Scale undercut: $0.02 for items <$15, $0.03 for <$30, $0.05 for >$30
            const undercutAmount = myCurrentPriceCents < 1500 ? 2 : myCurrentPriceCents < 3000 ? 3 : 5;
            const microUndercutCents = myCurrentPriceCents - undercutAmount;
            if (microUndercutCents >= floorCents) {
              console.log(`[micro-undercut] ${asin}/${marketplace}: matching BB at $${(myCurrentPriceCents/100).toFixed(2)} but NOT winning → undercut by $${(undercutAmount/100).toFixed(2)} to $${(microUndercutCents/100).toFixed(2)}`);
              targetCents = microUndercutCents;
            }
          }

          // ── BYPASS delta threshold when LOSING Buy Box ──
          // If we're losing BB, always allow price movement regardless of delta
          const isLosingBb = !isBuyboxWinner;
          const finalChangeCents = myCurrentPriceCents != null ? Math.abs(targetCents - myCurrentPriceCents) : Infinity;
          if (finalChangeCents < minChangeCents && !force_all && !isLosingBb) {
            // Only block delta-too-small when we ALREADY OWN the Buy Box
            const isAlreadyOptimal = isBuyboxWinner && finalChangeCents === 0;
            const ackReason = isAlreadyOptimal
              ? 'Already Optimal (Holding BB)'
              : `Delta too small ($${(finalChangeCents/100).toFixed(2)} < $${(minChangeCents/100).toFixed(2)})`;
            const ackConstraint = isAlreadyOptimal ? 'already_optimal' : 'delta_too_small';

            // ── STREAK SUPPRESSION: Delta Too Small ──
            // If losing BB and getting delta_too_small 3+ times → enter cooldown
            if (!isAlreadyOptimal && !isBuyboxWinner) {
              const newStreak = (assignment.delta_too_small_streak || 0) + 1;
              if (newStreak >= 3) {
                // Enter "no meaningful change" cooldown — 4 min for aggressive, 8 min otherwise
                const resolvedOscMode = rule.oscillation_mode === 'auto' ? (assignment.oscillation_last_mode_used || 'balanced') : (rule.oscillation_mode || 'safe');
                const isAggressive = resolvedOscMode === 'aggressive';
                const cooldownMs = (isAggressive ? 4 : 8) * 60000;
                supabase.from('repricer_assignments').update({
                  delta_too_small_streak: 0,
                  oscillation_state: 'safety_cooldown',
                  oscillation_cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
                  oscillation_last_mode_used: assignment.oscillation_last_mode_used || 'aggressive',
                  oscillation_last_reason: `delta_too_small_streak_${newStreak}`,
                  last_ack_result: 'no_change', last_ack_reason: ackReason,
                }).eq('id', assignmentId).then(() => {});
                supabase.from('repricer_price_actions').insert({
                  user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
                  action_type: 'oscillation_guard',
                  trigger_source: triggerSource,
                  old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
                  intended_price: targetCents / 100,
                  reason: `Streak suppression: ${newStreak} consecutive delta_too_small while losing BB. 8min cooldown.`,
                  success: true, update_method: 'none', rule_name: rule?.name || null,
                }).then(() => {});
                console.log(`[streak-guard] ${asin}/${marketplace}: ${newStreak} consecutive delta_too_small while losing BB → 8min cooldown`);
                results.push({ asin, sku, action: 'skipped', reason: `Streak suppression: delta_too_small x${newStreak}`, spApiUsed: true });
                processed++;
                continue;
              } else {
                supabase.from('repricer_assignments').update({
                  delta_too_small_streak: newStreak,
                }).eq('id', assignmentId).then(() => {});
              }
            } else {
              // Reset streak if winning BB or already optimal
              if ((assignment.delta_too_small_streak || 0) > 0) {
                supabase.from('repricer_assignments').update({ delta_too_small_streak: 0 }).eq('id', assignmentId).then(() => {});
              }
            }

            // ACK: no_change
            supabase.from('repricer_eval_acks').upsert({
              user_id: userId, asin, sku: sku || '', marketplace,
              buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
              lowest_fba_price: spPricing?.lowestFbaPrice ?? null,
              lowest_fbm_price: spPricing?.lowestFbmPrice ?? null,
              my_price: myCurrentPriceCents ? myCurrentPriceCents / 100 : null,
              is_buybox_owner: isBuyboxWinner,
              result: 'no_change', reason: ackReason,
              constraint_applied: ackConstraint,
              recommended_price: targetCents / 100,
              trigger_source: triggerSource,
              acked_at: new Date().toISOString(),
            }, { onConflict: 'user_id,asin,sku,marketplace' }).then(() => {});
            const noChangeUpdate: Record<string, any> = {
              last_ack_result: 'no_change', last_ack_reason: ackReason,
            };
            // Clear restock flag if price is already competitive (no change needed)
            if (restockReentryActive && isAlreadyOptimal) {
              noChangeUpdate.restock_reentry_at = null;
              console.log(`[restock_snapback] ${asin}/${marketplace}: restock_reentry_completed — already competitive, flag cleared`);
            }
            supabase.from('repricer_assignments').update(noChangeUpdate).eq('id', assignmentId).then(() => {});
            // Log to price_actions so health panel counts this eval
            supabase.from('repricer_price_actions').insert({
              user_id: userId, assignment_id: assignmentId, asin, sku, marketplace,
              action_type: 'no_change',
              trigger_source: triggerSource,
              old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
              intended_price: targetCents / 100,
              effective_floor_cents: floorCents,
              reason: ackReason,
              success: true,
              update_method: 'none',
              rule_name: rule?.name || null,
            }).then(() => {});
            results.push({ asin, sku, action: 'checked', reason: ackReason, spApiUsed: true });
            processed++;
            continue;
          }
        }

        if (dry_run) {
          const dryRunReason = isAiWinSalesBooster && targetReason
            ? `DRY RUN — ${targetReason}`
            : `DRY RUN — would set $${(targetCents/100).toFixed(2)} (was $${((myCurrentPriceCents ?? 0)/100).toFixed(2)})`;
          results.push({ asin, sku, action: 'evaluated', reason: dryRunReason, newPrice: targetCents / 100, previousPrice: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : undefined, rainforestUsed: false, spApiUsed: true });
          processed++;
          continue;
        }

        const wb = await checkWriteBudget(supabase, userId, settings);
        if (!wb.allowed) {
          results.push({ asin, sku, action: 'skipped', reason: 'Write budget exhausted this cycle' });
          break;
        }

        let submitSuccess = false;
        let submitError = '';
        try {
          const submitForcedFloor = isAiWinSalesBooster && ackConstraintApplied?.split(',').some((guard) =>
            guard === 'universal_floor_guard' ||
            guard === 'universal_floor_recovery' ||
            guard === 'bb_owner_floor_recovery' ||
            guard === 'emergency_floor_guard'
          );
          const submitMaxCents = submitForcedFloor && ceilingCents > 0 && targetCents > ceilingCents
            ? targetCents
            : ceilingCents;
          const submitResp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
            body: JSON.stringify({
              user_id: userId,
              asin,
              sku,
              marketplace,
              newPrice: targetCents / 100,
              newMinPrice: floorCents / 100,
              newMaxPrice: submitMaxCents > 0 ? submitMaxCents / 100 : undefined,
              updateMinMaxOnly: false,
              internal: true,
              fromScheduler: true,
            }),
          });
          const submitResult = await submitResp.json().catch(() => null);
          submitSuccess = submitResp.ok && submitResult?.success === true;
          if (!submitSuccess) submitError = submitResult?.error ?? `Amazon submit HTTP ${submitResp.status}`;
        } catch (e: any) {
          submitError = e?.message ?? 'Submit exception';
          if (isFatalError(submitError)) {
            await incrementCircuitBreakerErrors(supabase, userId);
          }
        }

        // Phase 1B Self-Learning Proof: tag this change as an "unnecessary
        // undercut" if it satisfies any of the 4 conservative conditions.
        // We only have pre-state context here (the post-state fetch happens
        // later in reconciliation), so the tagger uses inference where needed.
        const undercutTag = submitSuccess
          ? tagUnnecessaryUndercut({
              oldPriceCents: myCurrentPriceCents,
              newPriceCents: targetCents,
              buyboxPriceCents,
              lowestFbaPriceCents,
              isBuyboxOwner: isBuyboxWinner,
              buyboxIsValid: buyboxPriceCents != null ? true : false,
              lowestCompetitorIsFiltered: null, // not surfaced in scheduler today
              isBuyboxOwnerAfterChange: null,
            })
          : { was_unnecessary_undercut: false, primary_reason: null, reasons: [] };

        await supabase.from('repricer_price_actions').insert({
          user_id: userId,
          assignment_id: assignmentId,
          asin,
          sku,
          marketplace,
          action_type: submitSuccess ? 'price_changed' : 'price_change_failed',
          trigger_source: triggerSource,
          old_price: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : null,
          new_price: submitSuccess ? targetCents / 100 : null,
          intended_price: targetCents / 100,
          submitted_price: targetCents / 100,
          effective_floor_cents: floorCents,
          reason: submitSuccess ? (isAiWinSalesBooster ? (targetReason || `Submitted to Amazon via ${strategy} strategy — verifying live offer`) + ` [osc_mode:${effectiveOscMode}]` : `Submitted to Amazon via ${strategy} strategy — verifying live offer [osc_mode:${effectiveOscMode}]`) : `Submit failed: ${submitError}`,
          intelligence_factors: isAiWinSalesBooster ? targetIntelligenceFactors : null,
          success: submitSuccess,
          update_method: 'patch',
          rule_name: rule?.name || null,
          reconciliation_status: submitSuccess ? 'pending' : null,
          was_unnecessary_undercut: undercutTag.was_unnecessary_undercut,
          unnecessary_undercut_reason: undercutTag.primary_reason,
          unnecessary_undercut_reasons: undercutTag.reasons.length > 0 ? undercutTag.reasons : null,
        });

        // ── EVAL ACK: Persist acknowledgment snapshot ──
        const ackResult = submitSuccess ? 'changed' : 'error';
        const ackReason = submitSuccess
          ? (isAiWinSalesBooster
            ? `Submitted to Amazon $${(targetCents/100).toFixed(2)} via ${strategy} — verifying live offer · ${targetReason || 'AI evaluation'}`
            : `Submitted to Amazon $${(targetCents/100).toFixed(2)} via ${strategy} — verifying live offer`)
          : `Submit failed: ${submitError}`;
        try {
          await supabase.from('repricer_eval_acks').upsert({
            user_id: userId,
            asin,
            sku: sku || '',
            marketplace,
            buybox_price: buyboxPriceCents ? buyboxPriceCents / 100 : null,
            lowest_fba_price: spPricing?.lowestFbaPrice ?? null,
            lowest_fbm_price: spPricing?.lowestFbmPrice ?? null,
            my_price: myCurrentPriceCents ? myCurrentPriceCents / 100 : null,
            is_buybox_owner: isBuyboxWinner,
            result: ackResult,
            reason: ackReason,
            constraint_applied: ackConstraintApplied,
            recommended_price: targetCents / 100,
            applied_price: submitSuccess ? targetCents / 100 : null,
            trigger_source: triggerSource,
            acked_at: new Date().toISOString(),
          }, { onConflict: 'user_id,asin,sku,marketplace' });

          // Update assignment ack state
          await supabase.from('repricer_assignments').update({
            last_ack_result: ackResult,
            last_ack_reason: ackReason.slice(0, 200),
          }).eq('id', assignmentId);
        } catch (ackErr) {
          console.warn(`[repricer-scheduler] Ack write failed for ${asin}:`, ackErr);
        }

        if (submitSuccess) {
          // Stamped on every raise regardless of preset -- only presets with
          // post_raise_cooldown_hours set (MOMENTUM_SMART V2) actually read
          // it back to gate further raises.
          const wasRaise = myCurrentPriceCents != null && targetCents > myCurrentPriceCents;
          const successUpdate: Record<string, any> = {
            last_applied_price: targetCents / 100,
            last_applied_at: new Date().toISOString(),
            last_evaluated_at: new Date().toISOString(),
            last_recommended_price: targetCents / 100,
            last_recommendation_reason: isAiWinSalesBooster ? targetReason : null,
            no_change_streak: 0, // Reset streak on successful price change
            ...(wasRaise ? { last_raise_at: new Date().toISOString() } : {}),
          };
          // Clear restock flag on successful snap-back application
          if (restockReentryActive) {
            successUpdate.restock_reentry_at = null;
            console.log(`[restock_snapback] ${asin}/${marketplace}: restock_reentry_completed — flag cleared after successful price change to $${(targetCents/100).toFixed(2)}`);
          }
          // Clear oscillation state on restock re-entry (fresh competitive start)
          if (restockReentryActive) {
            successUpdate.oscillation_state = 'competing';
            successUpdate.oscillation_cooldown_until = null;
            successUpdate.oscillation_reaction_count = 0;
            successUpdate.bb_loss_after_raise_count = 0;
            successUpdate.bb_recovery_escalation = 0;
          }
          await supabase.from('repricer_assignments').update(successUpdate).eq('id', assignmentId);

          await incrementWriteCount(supabase, userId);

          if (
            assignment.last_buybox_status === 'winning' &&
            !isBuyboxWinner &&
            myCurrentPriceCents != null &&
            targetCents > myCurrentPriceCents
          ) {
            await trackBbLossAfterRaise(supabase, assignmentId, true, true);
          }

          const appliedReason = isAiWinSalesBooster && targetReason
            ? `Submitted to Amazon $${(targetCents/100).toFixed(2)} (was $${((myCurrentPriceCents ?? 0)/100).toFixed(2)}) via ${strategy} — verifying live offer · ${targetReason}`
            : `Submitted to Amazon $${(targetCents/100).toFixed(2)} (was $${((myCurrentPriceCents ?? 0)/100).toFixed(2)}) via ${strategy} — verifying live offer`;
          results.push({ asin, sku, action: 'applied', reason: appliedReason, newPrice: targetCents / 100, previousPrice: myCurrentPriceCents != null ? myCurrentPriceCents / 100 : undefined, rainforestUsed: false, spApiUsed: true });
          processed++;
        } else {
          if (isFatalError(submitError)) {
            await incrementCircuitBreakerErrors(supabase, userId);
          }
          // HEALTH SIGNAL: Amazon price update failed (per-ASIN submit)
          await logHealthSignal({
            user_id: userId!, module: 'amazon_api',
            severity: isFatalError(submitError) ? 'critical' : 'warning',
            confidence: 'high',
            pattern: 'amazon_price_update_failed',
            title: 'Amazon price update rejected',
            impact: `Listing ${asin}${sku ? '/' + sku : ''} kept previous price after submit failure.`,
            recommended_fix: 'Check listing eligibility and Amazon Automate Pricing min/max rules.',
            auto_fix_action: 'repricer-reconcile',
            entity: { asin, sku, marketplace, assignment_id: assignmentId },
            function_name: 'repricer-scheduler', source: 'edge_runtime',
            raw_message: submitError,
          });
          results.push({ asin, sku, action: 'error', reason: submitError, spApiUsed: true });
        }
      } catch (assignErr: any) {
        console.error(`[repricer-scheduler] Error processing ${asin}/${sku}:`, assignErr);
        if (isFatalError(assignErr?.message ?? '')) {
          await incrementCircuitBreakerErrors(supabase, userId);
        }
        // HEALTH SIGNAL: repricer evaluation failure (per-ASIN)
        await HealthSignals.repricerEvalFailure(userId!, 'repricer-scheduler', asin, assignErr?.message ?? 'Unknown error');
        results.push({ asin, sku, action: 'error', reason: assignErr?.message ?? 'Unknown error' });
      } finally {
        timings.perAsinMs.push(Date.now() - tAsinStart);
        await releaseLock(supabase, userId, asin, marketplace, lockOwner);
      }
    }

    await releaseAllLocks(supabase, userId, lockOwner);

    const errorCount = results.filter(r => r.action === 'error').length;
    const actualSkippedCount = results.filter(r => r.action === 'skipped').length;
    const errorRate = allAssignments.length ? errorCount / allAssignments.length : 0;
    const isBreakerWarranted = errorRate >= 0.5;

    // Log skip reasons for observability
    const skipReasons = results.filter(r => r.action === 'skipped').map(r => `${r.asin}: ${r.reason}`);
    if (skipReasons.length > 0) {
      console.log(`[repricer-scheduler] Skip details: ${skipReasons.join(' | ')}`);
    }

    console.log(`[repricer-scheduler] Processed ${processed} assignments, ${actualSkippedCount} skipped, ${errorCount} errors (rate: ${errorRate.toFixed(2)})`);

    // ── TIMING METRICS REPORT ──
    const totalRuntimeMs = Date.now() - EXECUTION_START;
    const sortedAsinMs = [...timings.perAsinMs].sort((a, b) => a - b);
    const p50Idx = Math.floor(sortedAsinMs.length * 0.5);
    const p90Idx = Math.floor(sortedAsinMs.length * 0.9);
    const p95Idx = Math.floor(sortedAsinMs.length * 0.95);
    const timeoutHeadroomMs = MAX_EXECUTION_MS - totalRuntimeMs;
    const timeoutHeadroomPct = Math.round((timeoutHeadroomMs / MAX_EXECUTION_MS) * 100);

    const timingMetrics = {
      total_runtime_ms: totalRuntimeMs,
      timeout_limit_ms: MAX_EXECUTION_MS,
      timeout_headroom_ms: timeoutHeadroomMs,
      timeout_headroom_pct: timeoutHeadroomPct,
      batch_prefetch_ms: timings.batchPrefetchMs,
      batch_prefetch_used: batchFetchUsed,
      asins_processed: sortedAsinMs.length,
      per_asin_p50_ms: sortedAsinMs[p50Idx] ?? 0,
      per_asin_p90_ms: sortedAsinMs[p90Idx] ?? 0,
      per_asin_p95_ms: sortedAsinMs[p95Idx] ?? 0,
      per_asin_max_ms: sortedAsinMs[sortedAsinMs.length - 1] ?? 0,
      per_asin_min_ms: sortedAsinMs[0] ?? 0,
      per_asin_avg_ms: sortedAsinMs.length > 0 ? Math.round(sortedAsinMs.reduce((a, b) => a + b, 0) / sortedAsinMs.length) : 0,
      sp_api_individual_calls: timings.spApiIndividualMs.length,
      sp_api_individual_avg_ms: timings.spApiIndividualMs.length > 0
        ? Math.round(timings.spApiIndividualMs.reduce((a, b) => a + b, 0) / timings.spApiIndividualMs.length) : 0,
    };

    console.log(`[repricer-scheduler] ⏱️ TIMING METRICS: runtime=${totalRuntimeMs}ms, headroom=${timeoutHeadroomMs}ms (${timeoutHeadroomPct}%), batch_prefetch=${timings.batchPrefetchMs}ms, per_asin: p50=${sortedAsinMs[p50Idx] ?? 0}ms p90=${sortedAsinMs[p90Idx] ?? 0}ms p95=${sortedAsinMs[p95Idx] ?? 0}ms max=${sortedAsinMs[sortedAsinMs.length - 1] ?? 0}ms avg=${timingMetrics.per_asin_avg_ms}ms, individual_sp_api=${timings.spApiIndividualMs.length} calls avg=${timingMetrics.sp_api_individual_avg_ms}ms`);

    if (isBreakerWarranted) {
      console.warn(`[repricer-scheduler] Error rate ${errorRate.toFixed(2)} exceeds threshold, tripping circuit breaker`);
      await incrementCircuitBreakerErrors(supabase, userId);
    }

    return new Response(
      JSON.stringify({
        success: true, results, processed, skipped: actualSkippedCount, errors: errorCount,
        circuitBreaker: { ...circuitBreakerState, errorRate, isBreakerWarranted },
        timing: timingMetrics,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[repricer-scheduler] Fatal error:', err);
    // HEALTH SIGNAL: top-level fatal — final emission so we never lose runtime failures
    try {
      const body = await req.clone().json().catch(() => ({} as any));
      const fatalUserId = body?.user_id;
      if (fatalUserId) {
        await HealthSignals.repricerEvalFailure(fatalUserId, 'repricer-scheduler', undefined, `Fatal: ${(err as Error).message}`);
      }
    } catch { /* never throw */ }
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
