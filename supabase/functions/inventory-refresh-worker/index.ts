// Drains the inventory_refresh_queue and invokes rescue-inventory-asin per item.
// Replaces the prior 4k-simultaneous pg_net fan-out which was timing out at 5s.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { readRescueOutcome, type RescueOutcome } from './rescue-outcome.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

// 30, not 60, because 30 is the platform's per-invocation outbound-fetch
// ceiling -- not a guess. Measured 2026-08-20 across 25 consecutive runs, every
// one identical: processed=60, success=30, errors=30. Distinct success values
// across all 25 runs: [30].
//
// The failures were NOT SP-API errors. The queue recorded
//   "fetch: Rate limit exceeded for trace <id>. Retry after 55756ms."
// which is Supabase's own outbound-call quota (the same limit documented in
// prewarm-pl-resume-sweep). Those calls never reached Amazon, so they never
// appeared in the SP-API dashboard either -- worth remembering before
// attributing any error rate there to this worker.
//
// Claiming 60 to complete 30 meant half of every batch was dequeued, failed,
// and had to be swept back by full-inv-refresh-timeout-sweep before it could be
// retried -- so the queue drained at half speed while looking busy.
const DEFAULT_BATCH = 30;
const CONCURRENCY = 4;
const PER_ITEM_TIMEOUT_MS = 25_000;

// WHY this reads the response body and not just res.ok.
//
// rescue-inventory-asin returns 200 both when it writes stock and when it
// deliberately declines to -- a tombstoned row, no exact seller-SKU match, a
// non-US marketplace, a suspicious unconfirmed zero. It already tells us which,
// in `skipped_update_reason`. This worker used to ignore the body entirely, so
// every decline was recorded as 'success'.
//
// Cost of that: B00LFXMBKI sat at available=0 from 2026-09-03 to 2026-10-20
// while selling 52 units, and the queue showed an unbroken run of green
// 3-hourly successes the whole time. Amazon said 145 units. Nothing was
// broken enough to look at, which is exactly the problem -- a queue that
// cannot say "I chose not to write this" cannot be trusted to mean stock is
// current. Treat a parse failure as a plain success, not a skip, so a response
// shape change degrades to the old behaviour instead of flooding skips.
async function callRescue(item: { user_id: string; asin: string; sku: string; marketplace: string }): Promise<RescueOutcome> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_ITEM_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/rescue-inventory-asin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE}`,
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        user_id: item.user_id,
        asin: item.asin,
        sku: item.sku,
        marketplace: item.marketplace,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return readRescueOutcome(res.status, text);
  } catch (e: any) {
    return { kind: 'failed' as const, error: `fetch: ${e?.message || String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: allow service-role bearer or matching internal secret
  const auth = req.headers.get('authorization') || '';
  const internal = req.headers.get('x-internal-secret') || '';
  const ok =
    auth.includes(SERVICE_ROLE) ||
    auth.includes(Deno.env.get('SUPABASE_ANON_KEY') || '') ||
    (INTERNAL_SECRET && internal === INTERNAL_SECRET);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let batchSize = DEFAULT_BATCH;
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (typeof body?.batch_size === 'number') batchSize = Math.max(1, Math.min(100, body.batch_size));
  } catch { /* ignore */ }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // DB throttle guard — this job fires every minute; back off instead of
  // piling onto an already-loaded database.
  try {
    const { data: throttleState } = await supa.rpc('should_throttle_now');
    if (throttleState === 'skip' || throttleState === 'throttle') {
      console.log(`[inventory-refresh-worker] DB_THROTTLE — skipping run (${throttleState})`);
      return new Response(JSON.stringify({ message: 'Throttled — DB under load', throttled: throttleState }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    console.warn('[inventory-refresh-worker] should_throttle_now check failed (non-fatal):', (e as Error).message);
  }

  const { withCronLock } = await import('../_shared/cron-lock.ts');
  const outcome = await withCronLock(supa as any, 'inventory-refresh-worker-1m', 110, async () => {
    const { data: claimed, error: claimErr } = await supa.rpc('dequeue_inventory_refresh', { p_limit: batchSize });
    if (claimErr) throw new Error(`dequeue failed: ${claimErr.message}`);

    const items = (claimed || []) as any[];
    if (items.length === 0) {
      return { items_processed: 0, detail: { processed: 0, success: 0, errors: 0, skipped: 0, drained: true } };
    }

    let success = 0, errors = 0, skipped = 0;
    const skippedReasons: Record<string, number> = {};
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const idx = cursor++;
        const it = items[idx];
        const r = await callRescue(it);
        if (r.kind === 'declined') {
          // Terminal, like success -- the decision was correct and there is
          // nothing to retry -- but it must NOT read as "stock refreshed".
          skipped++;
          skippedReasons[r.reason] = (skippedReasons[r.reason] || 0) + 1;
          const { error: skipErr } = await supa.rpc('mark_inventory_refresh_skipped', {
            p_id: it.id, p_reason: r.reason,
          });
          if (skipErr) {
            // Never lose the row to a missing/renamed RPC: fall back to the
            // old behaviour rather than leaving it claimed forever.
            console.error(`[inventory-refresh-worker] mark_skipped failed (${skipErr.message}) — falling back to success for ${it.asin}`);
            await supa.rpc('mark_inventory_refresh_success', { p_id: it.id });
          }
        } else if (r.kind === 'written') {
          success++;
          await supa.rpc('mark_inventory_refresh_success', { p_id: it.id });
        } else {
          errors++;
          await supa.rpc('mark_inventory_refresh_error', { p_id: it.id, p_error: r.error });
        }
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker());
    await Promise.all(workers);

    if (skipped > 0) {
      console.log(
        `[inventory-refresh-worker] ${skipped}/${items.length} DECLINED (not failures, not writes): ` +
        Object.entries(skippedReasons).map(([k, v]) => `${k}=${v}`).join(' '),
      );
    }

    return {
      items_processed: items.length,
      detail: {
        processed: items.length, success, errors, skipped,
        skipped_reasons: skippedReasons,
        drained: items.length < batchSize,
      },
    };
  });

  return new Response(JSON.stringify({ ...outcome }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
