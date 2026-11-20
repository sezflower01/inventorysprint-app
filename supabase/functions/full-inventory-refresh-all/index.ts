// Mirrors the mobile/desktop "Manual SP-API Refresh" button, but for EVERY user.
// Uses EdgeRuntime.waitUntil() to survive past the HTTP response.
//
// Triggered by pg_cron every 2h. Auth: x-internal-secret OR service-role bearer.
//
// REWRITTEN 2026-07-31 as a resumable state machine. Two real, live-confirmed
// bugs in the previous version:
//
// 1. Silent-kill risk (same class as sync-fnsku-report, fixed earlier today):
//    the whole users x items loop ran as ONE continuous EdgeRuntime.waitUntil()
//    execution with only console.log "heartbeats" — no durable table at all,
//    so a mid-run kill by the edge runtime's real ~150s ceiling was completely
//    invisible. Fixed the same way: a durable full_inventory_refresh_runs row
//    tracks (user_cursor, item_cursor), every phase checks a wall-clock budget,
//    and self-continues via a retried, non-blocking HTTP call before hitting
//    the real ceiling.
//
// 2. Self-inflicted rate-limit storm: PARALLEL_BATCH was 60 concurrent
//    rescue-inventory-asin calls, but they all share the 'inventory_api'
//    token bucket (2 req/sec, confirmed via migration
//    20260729010000_inventory_orders_rate_limit_buckets.sql). Live-captured
//    proof: a real run against this account's 4,432 items finished in 6
//    seconds with 4,402 failures and only 30 successes. Dropping
//    PARALLEL_BATCH to 3 did NOT change this outcome (re-verified live,
//    same 30/4402 split, same ~10s duration) — the real mechanism is a
//    PLATFORM-level outbound-call quota scoped per execution/trace (error:
//    "Rate limit exceeded for trace <id>. Retry after ~50000ms"), tripped
//    after roughly 30 outbound fetches regardless of concurrency. Once
//    tripped, every further call in that SAME execution instantly fails
//    (0-1ms, no real network round-trip) until the cooldown expires — but a
//    brand-new invocation (new trace) gets its own fresh quota (confirmed:
//    a fresh 30-item test succeeded 100% immediately after an exhausted
//    run). Fixed by detecting this specific rejection and immediately
//    checkpointing + self-continuing to get a fresh trace, instead of
//    burning through the remaining list with instant no-op failures.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const PARALLEL_BATCH = 3; // matches inventory_api's real ~2 req/sec capacity, not 60
const TIME_BUDGET_MS = 100_000; // ~50s safety margin under the confirmed ~150s ceiling
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  supabase: any;
  supabaseUrl: string;
  serviceRoleKey: string;
  internalSecret: string;
  runId: string;
}

async function checkpoint(ctx: Ctx, extra: Record<string, any>) {
  try {
    await ctx.supabase.from('full_inventory_refresh_runs').update({
      last_heartbeat_at: new Date().toISOString(),
      ...extra,
    }).eq('id', ctx.runId);
  } catch (e) {
    console.warn('[full-inventory-refresh-all] checkpoint failed:', e);
  }
}

// Same retry-hardened self-continuation pattern proven in sync-fnsku-report:
// a single failed dispatch would otherwise silently kill the whole chain.
// Even then it's not a silent corpse — a timeout-sweep cron (to add
// alongside this, mirroring fnsku-sync-timeout-sweep) catches anything that
// truly never resumes.
async function selfContinue(ctx: Ctx) {
  const payload = JSON.stringify({ resume: true, runId: ctx.runId });
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(`${ctx.supabaseUrl}/functions/v1/full-inventory-refresh-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.serviceRoleKey}`, 'x-internal-secret': ctx.internalSecret },
        body: payload,
      });
      if (resp.ok) return;
      console.error(`[selfContinue] continuation HTTP ${resp.status} (attempt ${attempt})`);
    } catch (e) {
      console.error(`[selfContinue] dispatch error (attempt ${attempt}):`, e);
    }
    if (attempt < maxAttempts) await sleep(1000 * attempt);
  }
  console.error(`[selfContinue] giving up after ${maxAttempts} attempts for runId=${ctx.runId}`);
}

async function runFromCursor(ctx: Ctx) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    while (true) {
      const { data: run } = await ctx.supabase.from('full_inventory_refresh_runs').select('*').eq('id', ctx.runId).single();
      if (!run) return;
      if (run.status !== 'in_progress') return; // already completed/failed/timed_out — stop

      const userIds: string[] = run.user_ids || [];
      if (run.user_cursor >= userIds.length) {
        await ctx.supabase.from('full_inventory_refresh_runs').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        }).eq('id', ctx.runId);
        console.log(`[full-inventory-refresh-all] ${ctx.runId} FINISHED users=${userIds.length} checked=${run.grand_checked} ok=${run.grand_ok} err=${run.grand_err}`);
        return;
      }

      const userId = userIds[run.user_cursor];

      // Fetch this user's items fresh each time we start them (cheap,
      // paginated) rather than persisting the whole list — avoids a huge
      // jsonb blob and picks up any inventory changes since the run started.
      const rows: any[] = [];
      {
        let from = 0;
        const PAGE = 1000;
        for (let i = 0; i < 200; i++) {
          const { data, error } = await ctx.supabase
            .from('inventory')
            .select('asin, sku, listing_status, source')
            .eq('user_id', userId)
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (error) { console.error(`[${ctx.runId}] ${userId} inventory query error: ${error.message}`); break; }
          if (!data || data.length === 0) break;
          rows.push(...data);
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }

      const seen = new Set<string>();
      const items = rows.filter((r: any) => {
        const status = String(r.listing_status || '').toUpperCase();
        if (r.source === 'created_listing' || status === 'DELETED' || !r.asin || !r.sku) return false;
        const k = `${r.asin}::${r.sku}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (run.item_cursor === 0) {
        console.log(`[${ctx.runId}] user=${userId} items=${items.length} (raw_rows=${rows.length})`);
        await checkpoint(ctx, { current_user_item_count: items.length });
      }

      let checked = run.item_cursor;
      let ok = 0, err = 0; // per-invocation counters; grand totals accumulate via DB

      for (let i = run.item_cursor; i < items.length; i += PARALLEL_BATCH) {
        if (Date.now() >= deadline) {
          await checkpoint(ctx, { item_cursor: checked, grand_checked: run.grand_checked + (checked - run.item_cursor), grand_ok: run.grand_ok + ok, grand_err: run.grand_err + err });
          await selfContinue(ctx);
          return;
        }

        // Touch the heartbeat before each wave so the external resume-sweep
        // never mistakes an unusually long healthy streak (e.g. if the
        // platform's per-trace quota were ever higher than the ~30 calls
        // observed today) for a stall — same class of false-positive-resume
        // race confirmed live in prewarm-profit-loss-all.
        await checkpoint(ctx, {});

        const wave = items.slice(i, i + PARALLEL_BATCH);
        const results = await Promise.allSettled(wave.map((item) =>
          fetch(`${ctx.supabaseUrl}/functions/v1/rescue-inventory-asin`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ctx.serviceRoleKey}`,
              'x-internal-secret': ctx.internalSecret,
            },
            body: JSON.stringify({ asin: item.asin, sku: item.sku, user_id: userId }),
          }).then(async (resp) => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await resp.json().catch(() => ({}));
            return true;
          })
        ));

        // The platform's per-execution outbound-call quota trips after ~30
        // fetches (see header comment) — once it does, every remaining call
        // in THIS execution instantly fails with no real retry value. Bail
        // out at the first sign of it rather than burning through the rest
        // of the list as no-op failures: checkpoint at the start of this
        // (unretried) wave and self-continue immediately to get a fresh
        // execution/trace with its own quota.
        const rateLimited = results.some((r) =>
          r.status === 'rejected' && /rate limit exceeded/i.test(String((r as any).reason?.message || r.reason)),
        );
        if (rateLimited) {
          await checkpoint(ctx, {
            item_cursor: checked,
            grand_checked: run.grand_checked + (checked - run.item_cursor),
            grand_ok: run.grand_ok + ok,
            grand_err: run.grand_err + err,
          });
          await selfContinue(ctx);
          return;
        }

        checked += wave.length;
        for (const r of results) (r.status === 'fulfilled' ? ok++ : err++);
      }

      // This user's items are exhausted — advance to the next user.
      const newGrandChecked = run.grand_checked + (checked - run.item_cursor);
      const newGrandOk = run.grand_ok + ok;
      const newGrandErr = run.grand_err + err;
      console.log(`[${ctx.runId}] user=${userId} DONE checked=${checked} ok=${ok} err=${err}`);
      await checkpoint(ctx, {
        user_cursor: run.user_cursor + 1,
        item_cursor: 0,
        current_user_item_count: null,
        grand_checked: newGrandChecked, grand_ok: newGrandOk, grand_err: newGrandErr,
      });
      // Loop continues to the next user within the same invocation if budget remains.
    }
  } catch (err: any) {
    console.error('[full-inventory-refresh-all] fatal:', err);
    await ctx.supabase.from('full_inventory_refresh_runs').update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: err?.message || String(err),
    }).eq('id', ctx.runId);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const auth = req.headers.get('authorization') || '';
  const okSecret = internalSecret && providedSecret && providedSecret === internalSecret;
  const okBearer = serviceRoleKey && auth === `Bearer ${serviceRoleKey}`;
  if (!okSecret && !okBearer) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: any = {};
  try { body = await req.json(); } catch {}

  // ---- Resume path ----
  if (body.resume === true && body.runId) {
    const { data: run } = await supabase.from('full_inventory_refresh_runs').select('id, status').eq('id', body.runId).maybeSingle();
    if (!run || run.status !== 'in_progress') {
      return new Response(JSON.stringify({ ok: false, reason: 'not_resumable' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const ctx: Ctx = { supabase, supabaseUrl, serviceRoleKey, internalSecret, runId: body.runId };
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(runFromCursor(ctx));
    return new Response(JSON.stringify({ ok: true, resumed: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // ---- Fresh start ----
  const onlyUserId: string | null = body?.user_id || null;
  const runTag = `run_${Date.now().toString(36)}`;

  let userIds: string[] = [];
  if (onlyUserId) {
    userIds = [onlyUserId];
  } else {
    const seen = new Set<string>();
    let from = 0;
    const PAGE = 1000;
    for (let i = 0; i < 200; i++) {
      const { data, error } = await supabase.from('repricer_assignments').select('user_id').eq('is_enabled', true)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) { console.error(`[${runTag}] users query error: ${error.message}`); break; }
      if (!data || data.length === 0) break;
      for (const r of data) if (r.user_id) seen.add(r.user_id);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    userIds = Array.from(seen);
  }
  console.log(`[full-inventory-refresh-all] ${runTag} START scope=${onlyUserId ? 'single_user:' + onlyUserId : 'all_users'} users=${userIds.length}`);

  const { data: runRow, error: insErr } = await supabase.from('full_inventory_refresh_runs').insert({
    run_tag: runTag,
    scope: onlyUserId ? `single_user:${onlyUserId}` : 'all_users',
    user_ids: userIds,
    last_heartbeat_at: new Date().toISOString(),
  }).select().single();

  if (insErr || !runRow) {
    return new Response(JSON.stringify({ ok: false, error: insErr?.message || 'Failed to create run row' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const ctx: Ctx = { supabase, supabaseUrl, serviceRoleKey, internalSecret, runId: runRow.id };
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(runFromCursor(ctx));

  return new Response(JSON.stringify({ ok: true, accepted: true, runId: runRow.id, scope: onlyUserId ? 'single_user' : 'all_users', userCount: userIds.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 202,
  });
});
