import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkCircuitBreaker } from '../_shared/repricer-hardening.ts';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Repricer Cron Trigger — PARALLEL TIERED SCHEDULING v5
 * 
 * v5 changes: TIGHTENED HOT classification.
 * 
 * HOT now requires COMPOUND urgency (not single weak signals):
 *   - Starred/priority → always HOT
 *   - Active BB alert → always HOT
 *   - Losing BB + meaningful price gap (≥5c) → HOT
 *   - Significant gap alone (≥10c above BB) → HOT
 *   - Losing BB + sold today → HOT
 *   - Recent price change + losing BB → HOT
 * 
 * NO LONGER HOT alone:
 *   - sold_today without competitive pressure → WARM
 *   - recent_price_change without BB loss → WARM
 *   - losing_bb without price gap → WARM
 *   - stale >20m → raised to >45m, stays WARM (not promoted to HOT)
 * 
 * Tier allocation unchanged: T1=6, T2=1, T3=1 chains.
 */

const TIER1_CHAINS = 6;
const TIER2_CHAINS = 2;  // Was 1 — doubled to improve WARM coverage and lower avg eval age
const TIER3_CHAINS = 1;

const PRICE_GAP_THRESHOLD_CENTS = 2; // $0.02 — urgently promote any ASIN above BB

function toCents(val: number | null | undefined): number {
  return Math.round((val ?? 0) * 100);
}

interface TierClassification {
  tier1Ids: string[];
  tier2Ids: string[];
  tier3Ids: string[];
  intlByMarketplace: Record<string, string[]>;
}

async function classifyAssignments(
  supabase: any,
  userId: string,
): Promise<TierClassification> {
  const t0 = Date.now();

  // CRITICAL: Supabase default limit is 1000 rows. Must paginate to get all assignments.
  // Step 1: Fetch assignments WITH explicit rule_id
  let assignments: any[] = [];
  let fetchError: any = null;
  const PAGE_SIZE = 1000;
  let page = 0;
  
  while (true) {
    const { data: batch, error } = await supabase
      .from('repricer_assignments')
      .select('id, asin, sku, is_priority, last_sp_api_check_at, last_buybox_price, last_applied_price, last_buybox_status, buybox_lost_at, last_price_change_at, marketplace, min_price_override, rule_id')
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .not('rule_id', 'is', null)
      .not('min_price_override', 'is', null)
      .gt('min_price_override', 0)
      .in('status', ['active', 'needs_attention'])
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    
    if (error) { fetchError = error; break; }
    if (!batch || batch.length === 0) break;
    assignments = assignments.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  // Step 2: Fetch international assignments WITHOUT rule_id that can inherit from US
  const usAsinsWithRule = new Set(assignments.filter((a: any) => a.marketplace === 'US').map((a: any) => a.asin));
  
  if (usAsinsWithRule.size > 0) {
    let intlPage = 0;
    let intlAssignments: any[] = [];
    while (true) {
      const { data: batch, error } = await supabase
        .from('repricer_assignments')
        .select('id, asin, sku, is_priority, last_sp_api_check_at, last_buybox_price, last_applied_price, last_buybox_status, buybox_lost_at, last_price_change_at, marketplace, min_price_override, rule_id')
        .eq('user_id', userId)
        .eq('is_enabled', true)
        .is('rule_id', null)
        .not('min_price_override', 'is', null)
        .gt('min_price_override', 0)
        .in('marketplace', ['CA', 'MX', 'BR'])
        .in('status', ['active', 'needs_attention'])
        .order("id", { ascending: true })
        .range(intlPage * PAGE_SIZE, (intlPage + 1) * PAGE_SIZE - 1);
      
      if (error) { console.error('[cron-trigger] intl inheritance fetch error:', error); break; }
      if (!batch || batch.length === 0) break;
      intlAssignments = intlAssignments.concat(batch);
      if (batch.length < PAGE_SIZE) break;
      intlPage++;
    }
    // Only include international items whose US sibling has a rule
    const inherited = intlAssignments.filter((a: any) => usAsinsWithRule.has(a.asin));
    if (inherited.length > 0) {
      console.log(`[cron-trigger] Rule inheritance: ${inherited.length} intl assignments inherit US rules`);
      assignments = assignments.concat(inherited);
    }
  }

  const tAssignments = Date.now();

  if (fetchError || assignments.length === 0) {
    console.error(`[cron-trigger] Classification query error:`, fetchError);
    return { tier1Ids: [], tier2Ids: [], tier3Ids: [], intlByMarketplace: {} };
  }

  // ── SETUP-INCOMPLETE FILTER: Skip ASINs without Min price to avoid wasted evaluations ──
  const totalBeforeFilter = assignments.length;
  const setupIncomplete = assignments.filter((a: any) => !a.min_price_override || a.min_price_override <= 0);
  assignments = assignments.filter((a: any) => a.min_price_override && a.min_price_override > 0);
  
  if (setupIncomplete.length > 0) {
    console.log(`[classifyAssignments] Setup-incomplete filter: ${setupIncomplete.length}/${totalBeforeFilter} assignments skipped (missing min_price). ${assignments.length} eligible for evaluation.`);
  }

  const usAssignments = assignments.filter((a: any) => a.marketplace === 'US');
  const intlAssignments = assignments.filter((a: any) => a.marketplace !== 'US');

  const usSkus = [...new Set(usAssignments.map((a: any) => a.sku).filter(Boolean))];

  let stockMap: Map<string, boolean> = new Map();
  let listingStatusMap: Map<string, string> = new Map();
  let inventoryRowCount = 0;
  if (usSkus.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < usSkus.length; i += BATCH) {
      const batch = usSkus.slice(i, i + BATCH);
      const { data: invData } = await supabase
        .from('inventory')
        .select('sku, available, reserved, inbound, listing_status')
        .eq('user_id', userId)
        .in('sku', batch);

      for (const inv of invData || []) {
        inventoryRowCount++;
        // Stock check: available > 0 OR reserved > 0 (pre-position pricing for FC transfers)
        const hasStock = (inv.available || 0) > 0 || (inv.reserved || 0) > 0;
        stockMap.set(inv.sku, hasStock);
        if (inv.listing_status) listingStatusMap.set(inv.sku, inv.listing_status);
      }
    }
  }

  const tInventory = Date.now();

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: recentAlerts } = await supabase
    .from('bb_price_alerts')
    .select('asin')
    .eq('user_id', userId)
    .eq('dismissed', false)
    .gte('created_at', twoHoursAgo);

  const alertedAsins = new Set((recentAlerts || []).map((a: any) => a.asin));
  const tAlerts = Date.now();

  const todayStr = new Date().toISOString().split('T')[0];
  const { data: todaySales } = await supabase
    .from('asin_sales_daily')
    .select('asin')
    .eq('user_id', userId)
    .eq('date', todayStr)
    .gt('units', 0);

  const soldTodayAsins = new Set((todaySales || []).map((s: any) => s.asin));
  const tSales = Date.now();

  const fifteenMinAgo = Date.now() - 15 * 60 * 1000;

  const tier1Ids: string[] = [];
  const tier2Ids: string[] = [];
  const tier3Ids: string[] = [];
  const hotReasons: Record<string, string[]> = {};

  // v5: Stale thresholds — promote stale items for coverage
  // Raised back from 30/45 to 60/120 to prevent flooding HOT tier with items that
  // just got heartbeated (which now correctly updates last_sp_api_check_at)
  const WARM_STALE_THRESHOLD = 60;
  const COLD_STALE_THRESHOLD = 120;
  const nowMs = Date.now();
  const stalePromotionIds: { id: string; from: string }[] = [];

  // v5: Significant price gap thresholds (tightened from 2c / 5c)
  const SIGNIFICANT_GAP_CENTS = 10; // $0.10 — truly meaningful price gap for standalone HOT
  const MODERATE_GAP_CENTS = 5;     // $0.05 — meaningful combined with another signal

  for (const a of usAssignments) {
    const hasStock = stockMap.get(a.sku) ?? false;
    const ls = (listingStatusMap.get(a.sku) || '').toUpperCase();
    const isInactive = ls === 'INACTIVE' || ls === 'NOT_FOUND' || ls === 'INCOMPLETE';
    const lastCheckMs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
    const checkAgeMinutes = lastCheckMs > 0 ? (nowMs - lastCheckMs) / 60000 : Infinity;

    // Skip inactive or no-stock listings entirely — never dispatch them through cron tiers
    if (isInactive || !hasStock) {
      continue;
    }

    // ── v5: COLLECT SIGNALS first, then apply COMPOUND scoring ──
    // Instead of "any signal = HOT", require strong signals or signal combinations.
    const signals = {
      losingBb: !!(a.last_buybox_status && a.last_buybox_status !== 'winning'),
      aboveBbGap: 0 as number,       // positive cents above BB
      priceGap: 0 as number,         // absolute cents gap
      recentPriceChange: false,
      soldToday: soldTodayAsins.has(a.asin),
      starred: !!a.is_priority,
      bbAlert: alertedAsins.has(a.asin),
    };

    if (a.last_applied_price && a.last_buybox_price) {
      const myPrice = toCents(a.last_applied_price);
      const bbPrice = toCents(a.last_buybox_price);
      const gap = myPrice - bbPrice;
      if (gap > 0) signals.aboveBbGap = gap;
      signals.priceGap = Math.abs(gap);
    }

    if (a.last_price_change_at) {
      const changeTime = new Date(a.last_price_change_at).getTime();
      if (changeTime > fifteenMinAgo) {
        signals.recentPriceChange = true;
      }
    }

    // ── v5: COMPOUND HOT QUALIFICATION ──
    // An ASIN is HOT only if it meets STRONG urgency criteria.
    // Single weak signals (sold_today alone, stale alone, recent_price_change alone) → WARM.
    const hotQualifyReasons: string[] = [];

    // ALWAYS HOT: Explicitly starred by user
    if (signals.starred) {
      hotQualifyReasons.push('starred');
    }

    // ALWAYS HOT: Active Buy Box price alert (recent drop detected)
    if (signals.bbAlert) {
      hotQualifyReasons.push('bb_alert');
    }

    // HOT: Losing BB + meaningful price gap (≥ 5c above BB)
    if (signals.losingBb && signals.aboveBbGap >= MODERATE_GAP_CENTS) {
      hotQualifyReasons.push(`losing_bb_above_${signals.aboveBbGap}c`);
    }

    // HOT: Significant price gap alone (≥ 10c above BB) — clearly mispriced
    if (signals.aboveBbGap >= SIGNIFICANT_GAP_CENTS && !hotQualifyReasons.some(r => r.startsWith('losing_bb'))) {
      hotQualifyReasons.push(`above_bb_${signals.aboveBbGap}c`);
    }

    // HOT: Losing BB + sold today (active competition + real demand)
    if (signals.losingBb && signals.soldToday && !hotQualifyReasons.some(r => r.startsWith('losing_bb'))) {
      hotQualifyReasons.push('losing_bb_sold_today');
    }

    // HOT: Recent price change + losing BB (competitor just moved)
    if (signals.recentPriceChange && signals.losingBb && !hotQualifyReasons.some(r => r.startsWith('losing_bb'))) {
      hotQualifyReasons.push('competitor_moved_losing_bb');
    }

    // ── WARM signals (not HOT alone, but tracked for diagnostics) ──
    const warmReasons: string[] = [];
    if (signals.losingBb && hotQualifyReasons.length === 0) {
      warmReasons.push('losing_bb_no_gap'); // Losing BB but price is close — not urgent
    }
    if (signals.soldToday && !signals.losingBb) {
      warmReasons.push('sold_today_only'); // Sales without competitive pressure
    }
    if (signals.recentPriceChange && !signals.losingBb) {
      warmReasons.push('recent_change_only'); // Price changed but not losing BB
    }
    if (signals.priceGap >= MODERATE_GAP_CENTS && signals.aboveBbGap < MODERATE_GAP_CENTS) {
      warmReasons.push(`price_gap_${signals.priceGap}c`); // Below BB gap (we're cheaper)
    }

    if (hotQualifyReasons.length > 0) {
      tier1Ids.push(a.id);
      hotReasons[a.id] = hotQualifyReasons;
    } else {
      // v5: Stale promotion requires a longer threshold (45m instead of 20m)
      if (checkAgeMinutes > WARM_STALE_THRESHOLD) {
        // Stale items go to WARM, not HOT — they aren't truly urgent
        tier2Ids.push(a.id);
        stalePromotionIds.push({ id: a.id, from: 'WARM' });
      } else {
        tier2Ids.push(a.id);
      }
    }
  }

  // === 2B: STARVATION PROTECTION — Force-promote ASINs not evaluated in 6+ hours ===
  // Lowered from 12h→6h to reduce avg eval age (was 34.5h) and raise eligible coverage toward 70%+
  const STARVATION_THRESHOLD_HOURS = 6;
  const starvationCutoff = nowMs - STARVATION_THRESHOLD_HOURS * 60 * 60 * 1000;
  let starvationPromoted = 0;
  
  // Check WARM tier for starved ASINs and promote to HOT
  const starvationMoveIds: string[] = [];
  for (const id of tier2Ids) {
    const a = usAssignments.find(x => x.id === id);
    if (!a) continue;
    const lastCheckMs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
    if (lastCheckMs > 0 && lastCheckMs < starvationCutoff) {
      starvationMoveIds.push(id);
    } else if (lastCheckMs === 0) {
      // Never checked — definitely starved
      starvationMoveIds.push(id);
    }
  }
  
  // Move starved IDs from tier2 to tier1
  for (const id of starvationMoveIds) {
    const idx = tier2Ids.indexOf(id);
    if (idx !== -1) {
      tier2Ids.splice(idx, 1);
      tier1Ids.push(id);
      hotReasons[id] = ['starvation_12h'];
      starvationPromoted++;
    }
  }
  
  if (starvationPromoted > 0) {
    console.log(`[classifyAssignments] STARVATION PROTECTION: Promoted ${starvationPromoted} ASINs from WARM→HOT (not evaluated in ${STARVATION_THRESHOLD_HOURS}h)`);
  }

  // ── HOT POOL CAP: Limit to top 100 to prevent stale HOT buildup ──
  const HOT_POOL_CAP = 100;
  if (tier1Ids.length > HOT_POOL_CAP) {
    const demoted = tier1Ids.splice(HOT_POOL_CAP);
    tier2Ids.unshift(...demoted); // Demoted HOT → WARM (front of WARM queue)
    console.log(`[classifyAssignments] HOT POOL CAP: Demoted ${demoted.length} HOT→WARM (cap=${HOT_POOL_CAP})`);
  }

  // Group international assignments by marketplace — DO NOT add to tier3
  // They are dispatched separately with correct marketplace context.
  // Adding them to tier3 would double-dispatch them as US (wrong marketplace).
  const intlByMarketplace: Record<string, string[]> = {};
  for (const a of intlAssignments) {
    if (!intlByMarketplace[a.marketplace]) intlByMarketplace[a.marketplace] = [];
    intlByMarketplace[a.marketplace].push(a.id);
  }

  const tEnd = Date.now();

  const reasonCounts: Record<string, number> = {};
  for (const reasons of Object.values(hotReasons)) {
    for (const r of reasons) {
      const key = r.startsWith('price_gap_') ? 'price_gap' : r.startsWith('stale_warm_') ? 'stale_warm_promoted' : r;
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  }

  console.log(`[classifyAssignments] total_ms=${tEnd - t0} assignments=${assignments.length} hot=${tier1Ids.length} warm=${tier2Ids.length} cold=${tier3Ids.length} inventory_rows=${inventoryRowCount} bb_alerts=${alertedAsins.size} today_sales=${soldTodayAsins.size} | query_ms: assignments=${tAssignments - t0} inventory=${tInventory - tAssignments} alerts=${tAlerts - tInventory} sales=${tSales - tAlerts} classify=${tEnd - tSales}`);
  if (Object.keys(reasonCounts).length > 0) {
    console.log(`[classifyAssignments] HOT reasons: ${JSON.stringify(reasonCounts)}`);
  }

  // Record stale promotions (batch update instead of individual)
  if (stalePromotionIds.length > 0) {
    const nowISO = new Date().toISOString();
    const ids = stalePromotionIds.map(s => s.id);
    await supabase.from('repricer_assignments').update({
      stale_promoted_at: nowISO,
      stale_promotion_evaluated: false,
    }).in('id', ids);
    console.log(`[classifyAssignments] Stale promotions: ${stalePromotionIds.length} (${stalePromotionIds.filter(s => s.from === 'WARM').length} WARM→HOT, ${stalePromotionIds.filter(s => s.from === 'COLD').length} COLD→WARM)`);
  }

  return { tier1Ids, tier2Ids, tier3Ids, intlByMarketplace };
}

/**
 * Fire a scheduler chain as a non-blocking HTTP call.
 * Returns a promise that resolves with the result.
 */
function fireSchedulerChain(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  assignmentIds: string[],
  marketplace: string,
  label: string,
  isPriorityChain: boolean = false,
): Promise<{ label: string; processed: number; error?: string }> {
  return fetch(`${supabaseUrl}/functions/v1/repricer-scheduler`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      scheduled: true,
      user_id: userId,
      assignment_ids: assignmentIds,
      marketplace,
      is_priority: isPriorityChain,
    }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return { label, processed: 0, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
      }
      const data = await r.json().catch(() => ({}));
      return { label, processed: data?.summary?.total || 0 };
    })
    .catch((e) => {
      return { label, processed: 0, error: (e as Error).message };
    });
}

/**
 * Dispatch all chains for a tier as parallel non-blocking fetches.
 * Returns a list of promises (one per chain).
 */
function dispatchTierParallel(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  tierIds: string[],
  tierLabel: string,
  maxChains: number,
  marketplace: string = 'US',
  isPriorityChain: boolean = false,
): Promise<{ label: string; processed: number; error?: string }>[] {
  if (tierIds.length === 0) return [];

  const promises: Promise<{ label: string; processed: number; error?: string }>[] = [];
  const batchSize = Math.ceil(tierIds.length / maxChains);

  for (let i = 0; i < maxChains; i++) {
    const start = i * batchSize;
    if (start >= tierIds.length) break;
    const batchIds = tierIds.slice(start, start + batchSize);
    const label = `${tierLabel}_chain${i + 1}`;
    promises.push(fireSchedulerChain(supabaseUrl, serviceKey, userId, batchIds, marketplace, label, isPriorityChain));
  }

  return promises;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = requireInternalCall(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    const body = await req.json().catch(() => ({}));
    
    const isInternalCall = authHeader?.includes(internalSecret || 'no-secret-configured');
    const isCronCall = body.time !== undefined;
    
    if (!isInternalCall && !isCronCall) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('[cron-trigger] Starting PARALLEL TIERED cron v5 at:', new Date().toISOString());

    const { data: enabledSettings, error: settingsError } = await supabase
      .from('repricer_settings')
      .select('user_id, continuous_mode, scheduler_status, safe_mode_active, safe_mode_reason, safe_mode_auto_resume_at, circuit_breaker_error_count, circuit_breaker_window_start, sp_api_calls_per_minute_cap')
      .eq('scheduler_enabled', true);

    if (settingsError) {
      throw new Error('Failed to fetch enabled schedulers');
    }

    if (!enabledSettings || enabledSettings.length === 0) {
      return new Response(JSON.stringify({
        success: true, message: 'No users with scheduler enabled', processed: 0
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const results: any[] = [];

    for (const setting of enabledSettings) {
      const userId = setting.user_id;
      const startTime = Date.now();

      try {
        // === ADMIN BYPASS — admins skip all subscription checks ===
        const { data: adminRole } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', userId)
          .eq('role', 'admin')
          .maybeSingle();

        if (!adminRole) {
          // === SUBSCRIPTION GUARD (non-admin users only) ===
          const { data: subRow } = await supabase
            .from('user_subscriptions')
            .select('status, cancel_at_period_end, current_period_end, trial_end_date')
            .eq('user_id', userId)
            .maybeSingle();

          const subStatus = subRow?.status ?? 'none';

          // Block expired/cancelled subscriptions
          if (subStatus === 'expired' || subStatus === 'cancelled' || subStatus === 'canceled') {
            console.log(`[cron-trigger] Skipping user ${userId} — subscription ${subStatus}`);
            await supabase.from('repricer_settings').update({ scheduler_enabled: false, queue_paused: true, queue_pause_reason: 'subscription_expired' }).eq('user_id', userId);
            results.push({ userId, skipped: true, reason: `subscription_${subStatus}` });
            continue;
          }

          // Check trial expiry
          if (subStatus === 'trial' && subRow?.trial_end_date) {
            const trialEnd = new Date(subRow.trial_end_date);
            if (trialEnd <= new Date()) {
              console.log(`[cron-trigger] Skipping user ${userId} — trial expired at ${subRow.trial_end_date}`);
              await supabase.from('repricer_settings').update({ scheduler_enabled: false, queue_paused: true, queue_pause_reason: 'trial_expired' }).eq('user_id', userId);
              await supabase.from('user_subscriptions').update({ status: 'expired' }).eq('user_id', userId);
              results.push({ userId, skipped: true, reason: 'trial_expired' });
              continue;
            }
          }

          // Also check if cancel_at_period_end and period has passed
          if (subRow?.cancel_at_period_end && subRow?.current_period_end) {
            const periodEnd = new Date(subRow.current_period_end);
            if (periodEnd <= new Date()) {
              console.log(`[cron-trigger] Skipping user ${userId} — subscription period ended`);
              await supabase.from('repricer_settings').update({ scheduler_enabled: false, queue_paused: true, queue_pause_reason: 'subscription_expired' }).eq('user_id', userId);
              await supabase.from('user_subscriptions').update({ status: 'expired' }).eq('user_id', userId);
              results.push({ userId, skipped: true, reason: 'period_ended' });
              continue;
            }
          }
        } else {
          console.log(`[cron-trigger] Admin bypass for user ${userId}`);
        }

        // Also check Amazon auth is active
        const { count: activeAuthCount } = await supabase
          .from('seller_authorizations')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('is_active', true);

        if (!activeAuthCount || activeAuthCount === 0) {
          console.log(`[cron-trigger] Skipping user ${userId} — no active Amazon authorization`);
          results.push({ userId, skipped: true, reason: 'no_active_auth' });
          continue;
        }

        // === CIRCUIT BREAKER CHECK ===
        const cbCheck = await checkCircuitBreaker(supabase, userId, setting);
        if (cbCheck.triggered) {
          console.log(`[cron-trigger] Skipping ${userId} — safe mode: ${cbCheck.reason}`);
          results.push({ user_id: userId, success: true, skipped: 'safe_mode', reason: cbCheck.reason });
          continue;
        }

        // ── PHASE 0a: Auto-clear expired oscillation states ──
        // Oscillation states with expired cooldowns should reset so ASINs can reprice again
        try {
          const { data: clearedOsc } = await supabase
            .from('repricer_assignments')
            .update({
              oscillation_state: null,
              oscillation_cooldown_until: null,
              oscillation_reaction_count: 0,
            })
            .eq('user_id', userId)
            .in('oscillation_state', ['blocked', 'bb_loss_cooldown', 'competing', 'safety_cooldown'])
            .lt('oscillation_cooldown_until', new Date().toISOString())
            .select('id');
          
          if (clearedOsc && clearedOsc.length > 0) {
            console.log(`[cron-trigger] Auto-cleared ${clearedOsc.length} expired oscillation states for ${userId}`);
          }
        } catch (oscErr) {
          console.warn(`[cron-trigger] Oscillation cleanup error:`, oscErr);
        }

        // ── PHASE 0b: Fire reconciliation (awaited separately, not blocking tiers) ──
        const reconcilePromise = fetch(`${supabaseUrl}/functions/v1/repricer-reconcile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ user_id: userId }),
        })
          .then(async (r) => {
            try {
              const d = await r.json();
              console.log(`[cron-trigger] Reconciliation for ${userId}: status=${r.status} matched=${d.matched || 0}, mismatched=${d.mismatched || 0}, failed=${d.failed || 0}, timed_out=${d.timed_out || 0}`);
              return d;
            } catch (_) {
              console.warn(`[cron-trigger] Reconciliation response parse error for ${userId}, status=${r.status}`);
              return null;
            }
          })
          .catch((e) => {
            console.warn(`[cron-trigger] Reconciliation fetch failed for ${userId}:`, (e as Error).message);
            return null;
          });

        // ── PHASE 1: Classify assignments into tiers ──
        const { tier1Ids, tier2Ids, tier3Ids, intlByMarketplace } = await classifyAssignments(supabase, userId);

        // ── PHASE 2: Fire ALL tiers in PARALLEL ──
        // THROUGHPUT CAP: Only dispatch what we can realistically process.
        // With ~20 SP-API calls/min and 2-min cycle, budget ≈ 40 calls.
        // Split: HOT gets 60%, WARM 30%, COLD 10%.
        const SP_API_BUDGET = (setting as any)?.sp_api_calls_per_minute_cap || 20;
        const CYCLE_BUDGET = SP_API_BUDGET * 2; // 2-minute cron cycle
        // Reduced HOT from 60%→55%, increased WARM from 25%→30% to improve coverage
        const HOT_BUDGET = Math.ceil(CYCLE_BUDGET * 0.55);
        const WARM_BUDGET = Math.ceil(CYCLE_BUDGET * 0.30);
        const COLD_BUDGET = Math.max(4, CYCLE_BUDGET - HOT_BUDGET - WARM_BUDGET);

        // Trim each tier to its budget. Surplus stays for next cycle.
        const dispatchedT1 = tier1Ids.slice(0, HOT_BUDGET);
        const dispatchedT2 = tier2Ids.slice(0, WARM_BUDGET);
        const dispatchedT3 = tier3Ids.slice(0, COLD_BUDGET);

        if (tier1Ids.length > HOT_BUDGET) {
          console.log(`[cron-trigger] HOT capped: dispatching ${dispatchedT1.length}/${tier1Ids.length} (budget=${HOT_BUDGET})`);
        }

        const allChainPromises: Promise<{ label: string; processed: number; error?: string }>[] = [
          ...dispatchTierParallel(supabaseUrl, supabaseKey, userId, dispatchedT1, 'T1_HOT', Math.min(TIER1_CHAINS, dispatchedT1.length), 'US', true),
          ...dispatchTierParallel(supabaseUrl, supabaseKey, userId, dispatchedT2, 'T2_WARM', Math.min(TIER2_CHAINS, dispatchedT2.length), 'US', false),
          ...dispatchTierParallel(supabaseUrl, supabaseKey, userId, dispatchedT3, 'T3_COLD', Math.min(TIER3_CHAINS, dispatchedT3.length), 'US', false),
        ];

        // Fire international markets
        for (const [mkt, ids] of Object.entries(intlByMarketplace)) {
          if (ids.length > 0) {
            allChainPromises.push(
              fireSchedulerChain(supabaseUrl, supabaseKey, userId, ids.slice(0, 6), mkt, `INTL_${mkt}`, false)
            );
          }
        }

        // ── Wait with partial result collection (no more discarding on timeout) ──
        const TIMEOUT_MS = 110_000;
        
        // Wrap each promise to self-resolve into a collected array
        const wrappedPromises = allChainPromises.map(p =>
          p.then(r => ({ ...r, settled: true as const }))
           .catch(e => ({ label: 'unknown', processed: 0, error: (e as Error).message, settled: true as const }))
        );
        
        // Collect results as they arrive
        const collectedResults: { label: string; processed: number; error?: string }[] = [];
        let allDone = false;
        
        const collectPromise = Promise.all(wrappedPromises).then(results => {
          allDone = true;
          for (const r of results) collectedResults.push(r);
        });
        
        // Race: either all finish or we timeout
        await Promise.race([
          collectPromise,
          new Promise<void>(resolve => setTimeout(() => {
            if (!allDone) {
              // Snapshot whatever has resolved so far
              console.warn(`[cron-trigger] ${userId} chains timed out after ${TIMEOUT_MS}ms — collecting partial results`);
            }
            resolve();
          }, TIMEOUT_MS)),
        ]);

        // Also await reconciliation (it runs in parallel with everything)
        await reconcilePromise;

        // ── Collect results (works for both complete and partial) ──
        let t1Processed = 0, t2Processed = 0, t3Processed = 0;
        const intlResults: Record<string, number> = {};
        let chainErrors = 0;

        for (const r of collectedResults) {
          if (r.error) {
            console.warn(`[cron-trigger] ${r.label} error: ${r.error}`);
            chainErrors++;
          }
          if (r.label.startsWith('T1_HOT')) t1Processed += r.processed;
          else if (r.label.startsWith('T2_WARM')) t2Processed += r.processed;
          else if (r.label.startsWith('T3_COLD')) t3Processed += r.processed;
          else if (r.label.startsWith('INTL_')) {
            const mkt = r.label.replace('INTL_', '');
            intlResults[mkt] = r.processed;
          }
          if (r.processed > 0) {
            console.log(`[cron-trigger] ${r.label}: ${r.processed} processed`);
          }
        }

        // ── Update lane usage ──
        try {
          const todayStr = new Date().toISOString().split('T')[0];
          const { data: usageRow } = await supabase
            .from('repricer_settings')
            .select('sp_api_lane_usage, sp_api_lane_usage_date')
            .eq('user_id', userId)
            .maybeSingle();
          
          let usage = (usageRow?.sp_api_lane_usage_date === todayStr && usageRow?.sp_api_lane_usage)
            ? { ...usageRow.sp_api_lane_usage as Record<string, number> }
            : { cron_hot: 0, cron_warm: 0, cron_cold: 0, sweep: 0, manual: 0, priority: 0 };
          
          usage.cron_hot = (usage.cron_hot || 0) + t1Processed;
          usage.cron_warm = (usage.cron_warm || 0) + t2Processed;
          usage.cron_cold = (usage.cron_cold || 0) + t3Processed;
          
          await supabase.from('repricer_settings').update({
            sp_api_lane_usage: usage,
            sp_api_lane_usage_date: todayStr,
          }).eq('user_id', userId);
        } catch (e) {
          console.warn('[cron-trigger] Lane usage update error:', e);
        }

        const elapsed = Date.now() - startTime;
        const timedOut = !allDone;
        results.push({
          user_id: userId,
          success: true,
          tier1: { count: tier1Ids.length, dispatched: dispatchedT1.length, processed: t1Processed },
          tier2: { count: tier2Ids.length, dispatched: dispatchedT2.length, processed: t2Processed },
          tier3: { count: tier3Ids.length, dispatched: dispatchedT3.length, processed: t3Processed },
          intl: intlResults,
          chain_errors: chainErrors,
          elapsed_ms: elapsed,
          timedOut,
        });

        console.log(`[cron-trigger] ${userId} done in ${elapsed}ms: T1=${t1Processed}/${dispatchedT1.length}(of ${tier1Ids.length}), T2=${t2Processed}/${dispatchedT2.length}(of ${tier2Ids.length}), T3=${t3Processed}/${dispatchedT3.length}(of ${tier3Ids.length}), errors=${chainErrors}${timedOut ? ' (PARTIAL)' : ''}`);
      } catch (userError: any) {
        console.error(`[cron-trigger] Exception for ${userId}:`, userError);
        results.push({ user_id: userId, success: false, error: userError.message });
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const totalProcessed = results
      .filter(r => r.success)
      .reduce((sum, r) => sum + (r.tier1?.processed || 0) + (r.tier2?.processed || 0) + (r.tier3?.processed || 0), 0);

    console.log(`[cron-trigger] PARALLEL cron v5 complete: ${totalProcessed} total processed across ${results.length} users`);

    return new Response(JSON.stringify({
      success: true,
      totalProcessed,
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[cron-trigger] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Cron trigger failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
