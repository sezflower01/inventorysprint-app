// Weekly FBA shipment catch-up: the ONLY scheduled writer of shipment history.
//
// ── WHY THIS FUNCTION EXISTS AGAIN ────────────────────────────────────────
//
// Reported 2026-11-17: /tools/unshipped-purchases showed "Shipped —" for every
// October purchase, because the newest shipment on record was dated
// 2026-10-01 and the most recent row had been first synced 2026-10-02. Six
// weeks of shipments had never been ingested, and the only scheduled job that
// ingests them -- catchup-fba-shipments-weekly -- had been failing every run
// since 2026-09-01, reporting success the whole time.
//
// ── THE TWO DEFECTS IT WAS FAILING ON ─────────────────────────────────────
//
// 20260704022227 pointed the weekly cron STRAIGHT AT sync-fba-shipments,
// fanning out one POST per user with { user_id, lookbackDays: 540,
// headersOnly: true }. That worked.
//
// 20260901160000 then repaired that job's 401 (it was missing the gateway
// bearer) and in doing so replaced the whole command, dropping the body down
// to { triggered_by: ... }. Two independent breaks resulted:
//
//   1. sync-fba-shipments REQUIRES body.user_id on the internal-secret path
//      ("user_id required when using internal-secret auth") and returns 500.
//      A 401 was traded for a 500.
//
//   2. The bearer it added is the LEGACY anon JWT, hardcoded into cron.job.
//      20260901180000 and 20260911041000 established that the project has
//      since rotated API keys, that the legacy token is what the platform
//      refuses as UNAUTHORIZED_LEGACY_JWT on any function keeping
//      verify_jwt = true, and that sync-fba-shipments is exactly such a
//      function (config.toml declares verify_jwt = true, because the browser
//      calls it). So the call never reached the function at all.
//
// Either defect alone stops the job dead. pg_cron records SUCCESS for any
// completed POST regardless of the response, so neither was visible.
//
// ── WHY THE CRON NOW TALKS TO THIS WRAPPER INSTEAD ────────────────────────
//
// Any cron that calls sync-fba-shipments directly must carry a valid JWT for
// the gateway, which means a JWT stored in cron.job -- and a stored JWT is
// precisely what rotated out from under this job, job 78, and the four
// repricer jobs. The durable shape is: cron sends ONLY the vault secret to a
// verify_jwt = false wrapper, and the wrapper calls the guarded function with
// the SERVICE-ROLE KEY FROM ITS OWN ENVIRONMENT, which is re-read from the
// deployment on every cold start and therefore cannot go stale.
// See CLAUDE.md, "The same trap applies one call deeper".
//
// ── WHY TWO PASSES, IN THIS ORDER ─────────────────────────────────────────
//
// These mirror the two buttons on /tools/shipment-tracking that are known to
// work, rather than inventing a third calling convention:
//
//   RECENT (no body -> lookbackDays 60, headersOnly false) == the "Sync"
//     button. Pulls shipment ITEMS and runs PHASE 1.5, the v2024-03-20
//     Inbound API discovery, which is the ONLY path on which "Send to Amazon"
//     shipments appear at all.
//   WIDE (lookbackDays 540, headersOnly true) == "Sync Missing (18mo)".
//     Headers only: cheap, and restores how far coverage reaches.
//
// RECENT RUNS FIRST, and that order is load-bearing. The unshipped-purchases
// page decides "Amazon received nothing" vs "we have no record of this
// period" from the HEADER dates (src/lib/shipmentCoverage.ts). A wide
// headers-only pass therefore moves coverage forward over October WITHOUT
// pulling the items the Shipped/Received columns are computed from -- so if
// the wrapper only got halfway through, running WIDE first would leave the
// page confidently reporting 0 units received on shipments it had never
// fetched the lines for. That is a false supplier shortfall, which is the
// expensive direction to be wrong in. Losing the wide pass to a timeout only
// costs the page some honesty about 2021-2025.
//
// A 13-month window WITH items is what hit HTTP 546 WORKER_RESOURCE_LIMIT and
// got this wrapper abandoned in July (20260704022227). It is not attempted
// here: the wide pass is headers-only, and the item-bearing pass is 60 days.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { withCronLock } from "../_shared/cron-lock.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

/** The two calls, in the order they must run. See the header comment. */
const PASSES: Array<{ name: string; body: Record<string, unknown> }> = [
  // Items + v2024 discovery. The valuable one.
  { name: 'recent', body: {} },
  // Coverage only.
  { name: 'wide', body: { lookbackDays: 540, headersOnly: true } },
];

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    if (!internalSecret || !expectedSecret || internalSecret !== expectedSecret) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: auths, error: authErr } = await supabase
      .from('seller_authorizations')
      .select('user_id');
    if (authErr) throw authErr;

    const userIds = Array.from(
      new Set((auths ?? []).map((a: { user_id: string | null }) => a.user_id).filter(Boolean)),
    ) as string[];

    type UserOutcome = {
      user_id: string;
      ok: boolean;
      passes: Record<string, { ok: boolean; shipments?: number; items?: number; error?: string }>;
    };
    const results: UserOutcome[] = [];

    // 1500s TTL: comfortably longer than one run, short enough that a worker
    // killed mid-run does not block next week's.
    const lock = await withCronLock(supabase, 'catchup-fba-shipments-weekly', 1500, async () => {
      for (const userId of userIds) {
        const passes: UserOutcome['passes'] = {};

        for (const pass of PASSES) {
          try {
            const resp = await fetch(`${supabaseUrl}/functions/v1/sync-fba-shipments`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // Service-role key from THIS function's environment. Satisfies
                // the gateway's verify_jwt = true, and is never a stale copy
                // the way a JWT pasted into cron.job was.
                'Authorization': `Bearer ${serviceKey}`,
                'apikey': serviceKey,
                // ...and this is what sync-fba-shipments' own guard reads.
                'x-internal-secret': expectedSecret,
                // user_id is MANDATORY on that guard's path. Omitting it is
                // defect 1 above.
              },
              body: JSON.stringify({ user_id: userId, ...pass.body }),
            });

            const text = await resp.text();
            let payload: Record<string, unknown> | null = null;
            try { payload = JSON.parse(text); } catch { payload = null; }

            if (!resp.ok) {
              passes[pass.name] = { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
            } else {
              passes[pass.name] = {
                ok: true,
                shipments: Number(payload?.shipmentCount ?? payload?.shipmentsFound ?? 0),
                items: Number(payload?.itemsUpserted ?? payload?.itemCount ?? 0),
              };
            }
          } catch (e) {
            passes[pass.name] = { ok: false, error: (e as Error)?.message ?? String(e) };
          }

          // Breather for SP-API between passes.
          await new Promise((r) => setTimeout(r, 2000));
        }

        // A user counts as OK only if the ITEM-BEARING pass worked. The wide
        // pass failing costs coverage breadth; the recent pass failing is what
        // leaves the discrepancies page blind, so it is the one that decides.
        results.push({ user_id: userId, ok: passes.recent?.ok === true, passes });

        await new Promise((r) => setTimeout(r, 1500));
      }

      return {
        items_processed: results.reduce(
          (s, r) => s + (r.passes.recent?.items ?? 0) + (r.passes.wide?.items ?? 0),
          0,
        ),
        detail: { users: userIds.length, ok: results.filter((r) => r.ok).length },
      };
    });

    if (lock.skipped) {
      return new Response(JSON.stringify({ skipped_locked: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const summary = {
      users: userIds.length,
      ok,
      failed,
      total_shipments: results.reduce((s, r) => s + (r.passes.recent?.shipments ?? 0), 0),
      total_items: results.reduce((s, r) => s + (r.passes.recent?.items ?? 0), 0),
      results,
    };
    console.log('[catchup-fba-shipments] done', JSON.stringify(summary).slice(0, 800));

    // NON-2XX WHEN NOTHING WORKED, DELIBERATELY.
    //
    // The previous version returned 200 { success: true, failed: N } however
    // badly it had gone. public.cron_http_failures only captures non-2xx
    // responses, so a wrapper that always answers 200 is invisible to the one
    // mechanism built to notice exactly this -- and "the job ran" got reported
    // as "the job worked" for six weeks. Those are two different facts and one
    // status code must not carry both.
    const everythingFailed = userIds.length > 0 && ok === 0;
    return new Response(JSON.stringify({ success: !everythingFailed, ...summary }), {
      status: everythingFailed ? 500 : 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[catchup-fba-shipments] error', e);
    return new Response(JSON.stringify({ success: false, error: (e as Error)?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
