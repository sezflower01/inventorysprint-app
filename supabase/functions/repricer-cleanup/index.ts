import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { cleanupExpiredHardeningData } from '../_shared/repricer-hardening.ts';
import { requireInternalOrUser } from '../_shared/require-internal.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * repricer-cleanup — Aggressive retention policy for high-IO repricer tables.
 * 
 * Runs on a cron (every 2 hours recommended) to delete stale rows:
 *   - repricer_competitor_snapshots: keep last 24 hours (was 48h)
 *   - repricer_price_actions (skip/no-change): keep last 3 days (was 7d)
 *   - repricer_price_actions (applied/error): keep last 14 days (was 30d)
 *   - bb_price_alerts (dismissed): keep last 3 days (was 7d)
 * 
 * Also enforces absolute row caps to prevent runaway growth.
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const now = new Date();
    const stats: Record<string, number> = {};
    const startTime = Date.now();

    // Helper: batched delete with wall-clock safety (max 20s total for this function)
    async function batchDelete(
      table: string,
      filterFn: (q: any) => any,
      batchSize: number,
      maxBatches: number
    ): Promise<number> {
      let totalDeleted = 0;
      for (let i = 0; i < maxBatches; i++) {
        // Wall-clock safety: stop if we've been running > 20 seconds
        if (Date.now() - startTime > 20000) {
          console.log(`[cleanup] Wall-clock limit reached, stopping ${table} cleanup`);
          break;
        }
        
        const query = supabase.from(table).delete();
        const filtered = filterFn(query);
        const { data, error } = await filtered.limit(batchSize).select('id');

        if (error) {
          console.error(`[cleanup] ${table} delete error:`, (error as Error).message);
          break;
        }
        totalDeleted += data?.length || 0;
        if (!data || data.length < batchSize) break;
      }
      return totalDeleted;
    }

    // ── 1. Clean old competitor snapshots (keep last 24 hours) ──
    const snapshotCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const snapshotsDeleted = await batchDelete(
      'repricer_competitor_snapshots',
      (q) => q.lt('fetched_at', snapshotCutoff),
      500, // smaller batches = less IO pressure
      40   // up to 20K rows per run
    );
    stats.snapshots_deleted = snapshotsDeleted;
    console.log(`[cleanup] Deleted ${snapshotsDeleted} old snapshots (cutoff: ${snapshotCutoff})`);

    // ── 2. Clean old skip/no-change price actions (keep last 3 days) ──
    const skipCutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const skipsDeleted = await batchDelete(
      'repricer_price_actions',
      (q) => q.lt('created_at', skipCutoff).in('action_type', ['skip', 'no_change', 'cooldown', 'skipped']),
      500,
      40
    );
    stats.skip_actions_deleted = skipsDeleted;
    console.log(`[cleanup] Deleted ${skipsDeleted} old skip actions (cutoff: ${skipCutoff})`);

    // ── 3. Clean old applied/error price actions (keep last 14 days) ──
    const appliedCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const appliedDeleted = await batchDelete(
      'repricer_price_actions',
      (q) => q.lt('created_at', appliedCutoff),
      500,
      20
    );
    stats.applied_actions_deleted = appliedDeleted;
    console.log(`[cleanup] Deleted ${appliedDeleted} old applied actions (cutoff: ${appliedCutoff})`);

    // ── 4. Clean old dismissed bb_price_alerts (keep last 3 days) ──
    const alertCutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const alertsDeleted = await batchDelete(
      'bb_price_alerts',
      (q) => q.lt('created_at', alertCutoff).eq('dismissed', true),
      500,
      10
    );
    stats.alerts_deleted = alertsDeleted;
    console.log(`[cleanup] Deleted ${alertsDeleted} old dismissed alerts`);

    // ── 5. Safety cap: if snapshots table > 10K rows, delete oldest beyond cap ──
    const { count: snapshotCount } = await supabase
      .from('repricer_competitor_snapshots')
      .select('id', { count: 'exact', head: true });

    if (snapshotCount && snapshotCount > 10000) {
      const overflow = snapshotCount - 10000;
      console.log(`[cleanup] Snapshot overflow: ${snapshotCount} rows, pruning ${overflow}`);
      // Get the cutoff timestamp for the oldest rows beyond the cap
      const { data: oldest } = await supabase
        .from('repricer_competitor_snapshots')
        .select('fetched_at')
        // Not paging -- this reads ONE row, the (overflow-1)th oldest, to use
        // its fetched_at as a delete cutoff. fetched_at is not unique, so
        // without a tiebreaker "the Nth oldest row" is whichever row Postgres
        // happened to place there, and the cutoff moved between runs. id makes
        // the pick deterministic. The cutoff value itself is unchanged except
        // within a tie.
        .order('fetched_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
        .range(overflow - 1, overflow - 1);

      if (oldest?.[0]?.fetched_at) {
        const capDeleted = await batchDelete(
          'repricer_competitor_snapshots',
          (q) => q.lte('fetched_at', oldest[0].fetched_at),
          500,
          20
        );
        stats.cap_snapshots_deleted = capDeleted;
        console.log(`[cleanup] Cap-pruned ${capDeleted} overflow snapshots`);
      }
    }

    // ── 6. Auto-disable assignments (HARD-TERMINAL ONLY) ──
    // Phase 3A contract: this sweep is the loudest silent-disable writer.
    // It must NOT pause rows that are mid-onboarding, awaiting inbound, or
    // have any reserved/inbound stock. Only flip is_enabled=false when the
    // listing is provably dead (zero across available+reserved+inbound AND
    // Amazon listing is INACTIVE / NOT_FOUND / INCOMPLETE). All other cases
    // belong to richer status states (auto_suspended_inbound_only_inactive,
    // unknown_pending_verification, etc.) and must NOT be disabled here.
    let stuckFixed = 0;
    let inactiveFixed = 0;
    if (Date.now() - startTime < 20000) {
      try {
        let allEnabled: any[] = [];
        let page = 0;
        while (true) {
          const { data: batch } = await supabase
            .from('repricer_assignments')
            .select('id, asin, sku, user_id, marketplace')
            .eq('is_enabled', true)
            .order("id", { ascending: true })
            .range(page * 500, (page + 1) * 500 - 1);
          if (!batch || batch.length === 0) break;
          allEnabled = allEnabled.concat(batch);
          if (batch.length < 500) break;
          page++;
          if (Date.now() - startTime > 15000) break;
        }

        if (allEnabled.length) {
          const userIds = [...new Set(allEnabled.map((a: any) => a.user_id))];

          for (const uid of userIds) {
            if (Date.now() - startTime > 18000) break;
            const userAssignments = allEnabled.filter((a: any) => a.user_id === uid);
            const skus = [...new Set(userAssignments.map((a: any) => a.sku).filter(Boolean))];

            const invMap = new Map<string, { available: number; reserved: number; inbound: number; listing_status: string }>();
            for (let i = 0; i < skus.length; i += 200) {
              const batch = skus.slice(i, i + 200);
              const { data: invData } = await supabase
                .from('inventory')
                .select('sku, available, reserved, inbound, listing_status')
                .eq('user_id', uid)
                .in('sku', batch);
              for (const inv of invData || []) {
                invMap.set(inv.sku, {
                  available: inv.available ?? 0,
                  reserved: inv.reserved ?? 0,
                  inbound: inv.inbound ?? 0,
                  listing_status: (inv.listing_status || '').toUpperCase(),
                });
              }
            }

            const toDisable: string[] = [];
            for (const a of userAssignments) {
              const inv = invMap.get(a.sku);
              // NO inventory row = onboarding race or pending verification.
              // NEVER disable here — let the status helper render "Pending verification".
              if (!inv) continue;

              const totalAll = inv.available + inv.reserved + inv.inbound;
              const isInactiveListing =
                inv.listing_status === 'INACTIVE' ||
                inv.listing_status === 'NOT_FOUND' ||
                inv.listing_status === 'INCOMPLETE';

              // HARD-TERMINAL only: zero everywhere AND listing not active.
              // Inbound>0, reserved>0, or ACTIVE listing → keep enabled.
              if (totalAll === 0 && isInactiveListing) {
                toDisable.push(a.id);
                inactiveFixed++;
              }
            }

            // Batch disable with full audit + fact fields (Phase 3A contract)
            for (let i = 0; i < toDisable.length; i += 50) {
              const chunk = toDisable.slice(i, i + 50);
              await supabase
                .from('repricer_assignments')
                .update({
                  is_enabled: false,
                  manual_paused: false,
                  auto_suspended_reason: 'NO_STOCK',
                  last_disabled_by: 'cleanup',
                  last_disabled_reason: 'repricer-cleanup: hard-terminal (0 stock + listing inactive)',
                  last_disabled_at: new Date().toISOString(),
                })
                .in('id', chunk);
            }
          }
        }
        console.log(`[cleanup] Hard-terminal disabled: ${inactiveFixed} (skipped ${stuckFixed} non-terminal — inbound/reserved present or row missing)`);
      } catch (e: any) {
        console.warn(`[cleanup] Stuck assignment fix failed: ${(e as Error).message}`);
      }
    }
    stats.stuck_assignments_fixed = stuckFixed;
    stats.inactive_listings_fixed = inactiveFixed;


    // ── 7. Clean expired hardening data (locks + idempotency) ──
    const hardeningStats = await cleanupExpiredHardeningData(supabase);
    stats.locks_cleaned = hardeningStats.locks;
    stats.idempotency_cleaned = hardeningStats.idempotency;
    console.log(`[cleanup] Cleaned ${hardeningStats.locks} expired locks, ${hardeningStats.idempotency} expired idempotency keys`);

    // ── 8. Clean old cron.job_run_details (keep last 7 days) ──
    let cronHistoryDeleted = 0;
    if (Date.now() - startTime < 20000) {
      try {
        const cronCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { count } = await supabase.rpc('cleanup_cron_history', { cutoff_ts: cronCutoff });
        cronHistoryDeleted = count || 0;
        stats.cron_history_deleted = cronHistoryDeleted;
        console.log(`[cleanup] Deleted ${cronHistoryDeleted} old cron.job_run_details rows`);
      } catch (e: any) {
        console.warn(`[cleanup] cron history cleanup failed (may need RPC): ${(e as Error).message}`);
      }
    }

    const totalDeleted = snapshotsDeleted + skipsDeleted + appliedDeleted + alertsDeleted + (stats.cap_snapshots_deleted || 0) + hardeningStats.locks + hardeningStats.idempotency + cronHistoryDeleted + stuckFixed;
    const elapsed = Date.now() - startTime;
    console.log(`[cleanup] Total: ${totalDeleted} rows deleted in ${elapsed}ms`);

    return new Response(JSON.stringify({
      success: true,
      totalDeleted,
      stats,
      elapsedMs: elapsed,
      cutoffs: {
        snapshots: snapshotCutoff,
        skipActions: skipCutoff,
        appliedActions: appliedCutoff,
        alerts: alertCutoff,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[cleanup] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
