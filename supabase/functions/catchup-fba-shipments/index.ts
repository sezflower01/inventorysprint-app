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
// Two defects, either one fatal. 20260704022227 had the cron fan out one POST
// per user at sync-fba-shipments with { user_id, lookbackDays: 540,
// headersOnly: true }, which worked. 20260901160000 then repaired that job's
// missing gateway bearer -- correctly diagnosed -- but rewrote the whole
// command and cut the body to { triggered_by }, so:
//
//   1. NO user_id. sync-fba-shipments requires it on the internal-secret path
//      ('user_id required when using internal-secret auth') and its catch
//      block returns 500. A 401 was traded for a 500.
//   2. The bearer added is the LEGACY anon JWT hardcoded into cron.job -- the
//      token the platform refuses as UNAUTHORIZED_LEGACY_JWT on
//      verify_jwt = true functions after the key rotation (20260901180000,
//      20260911041000). sync-fba-shipments is one, because the browser calls
//      it. The call never reached the function.
//
// pg_cron records SUCCESS for any completed POST whatever the response, so
// seven consecutive dead Sundays looked identical to seven healthy ones.
//
// The cron therefore now sends ONLY the vault secret to this wrapper, which is
// verify_jwt = false, and this wrapper calls sync-fba-shipments with the
// service-role key FROM ITS OWN ENVIRONMENT -- re-read on every cold start, so
// no future key rotation can silently kill it. See CLAUDE.md, "The same trap
// applies one call deeper".
//
// ── WHY ONE PASS PER REQUEST, AND WHY THE RUN IS TIME-BOUNDED ─────────────
//
// The first version of this fix ran BOTH passes for every user inside one
// request. It was killed on its very first run: a 504
// {"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s)
// reached"} at 2026-11-18 01:53:09Z, 13 minutes after deploy. The platform
// cuts a request off after 150s with no response bytes written, and awaiting
// two heavy SP-API syncs plus 3.5s of throttles is comfortably over that.
//
// The kill was invisible in exactly the way this whole fix is about.
// withCronLock only writes to cron_run_history when the work RETURNS, so a
// killed worker leaves no row at all -- and "no rows" then means both "never
// ran" and "ran and died", which is one state doing two jobs again. Worse, the
// 504 landed in cron_http_failures attributed by TIMING to
// repricer-unified-dispatch-v2 (candidate_jobs=16), because a hand-dispatched
// net.http_post has no cron job behind it to attribute to. It nearly cost a
// day chasing a healthy repricer.
//
// So, three changes, none of them "raise the timeout" -- that was tried twice
// on the nightly cleanup and regressed both times. Bound the work instead:
//
//   * ONE PASS PER REQUEST. `mode` picks it, and the cron fires two jobs 20
//     minutes apart instead of one job doing both.
//   * A 'started' ROW BEFORE ANY WORK, so a killed run is distinguishable
//     from a run that never happened.
//   * A WALL-CLOCK DEADLINE. No new user is started past DEADLINE_MS; the
//     rest are reported as deferred and picked up next run. The request
//     always returns, so it always records.
//
// ── THE TWO PASSES, AND WHY THEIR ORDER IS LOAD-BEARING ───────────────────
//
// They mirror the two buttons on /tools/shipment-tracking that are known to
// work, rather than inventing a third calling convention:
//
//   recent (no body -> lookbackDays 60, headersOnly false) == "Sync".
//     Pulls shipment ITEMS and runs PHASE 1.5, the v2024-03-20 Inbound API
//     discovery, which is the ONLY path on which "Send to Amazon" shipments
//     appear at all.
//   wide (lookbackDays 540, headersOnly true) == "Sync Missing (18mo)".
//     Headers only: cheap, and restores how far coverage reaches.
//
// RECENT MUST LAND FIRST. src/lib/shipmentCoverage.ts decides "Amazon received
// nothing" vs "we have no record of this period" from HEADER dates, so a
// headers-only pass moves coverage forward over October WITHOUT pulling the
// items the Shipped/Received columns are computed from. Run alone, it would
// make the discrepancies page confidently report real units as never
// received -- a false supplier shortfall, which is the expensive direction to
// be wrong in.
//
// Cron timing alone is not enough to guarantee that, so `wide` ENFORCES it:
// it refuses to run unless `recent` has recorded a success within
// RECENT_FRESHNESS_HOURS. An invariant the page depends on belongs in code,
// not in two cron expressions that someone will later restagger.
//
// A 13-month window WITH items is what hit HTTP 546 WORKER_RESOURCE_LIMIT and
// got this wrapper abandoned in July (20260704022227). It is not attempted:
// the wide pass is headers-only and the item pass is 60 days.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { withCronLock } from "../_shared/cron-lock.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

type Mode = 'recent' | 'wide';

/** What each mode sends to sync-fba-shipments. See the header comment. */
const MODE_BODY: Record<Mode, Record<string, unknown>> = {
  // 60d, items, v2024 discovery -- but NOT the catalogue enrichment pass.
  //
  // That pass is the one unbounded phase in sync-fba-shipments and it is scoped
  // to the user's whole history, not to the window just synced: ~10,000
  // fba_shipment_items rows with a null asin (null on write by design, because
  // Amazon's InboundShipmentItem payload has no ASIN), one rate-limited SP-API
  // catalog call per unique SKU, then up to 10,000 sequential single-row
  // UPDATEs. It never finishes, so the inner call was being cut off by the
  // platform's 150s idle timeout and returning 504 -- measured 2026-11-18, a
  // 151,610 ms run with ok:0 and items_processed:0.
  //
  // Nothing here needs it: the discrepancies page resolves a line's ASIN via
  // seller_sku (src/lib/shipmentAttribution.ts). Enrichment is a backfill, not
  // part of a sync.
  recent: {
    skipEnrichment: true,
    // The cursor: only fetch items for shipments that have none yet. Most of
    // the 2,112 historical shipments already do, and skipping one costs no
    // SP-API call at all -- so the loop's real work is the recent backlog,
    // not the whole history, and a run that runs out of budget resumes rather
    // than restarting.
    skipShipmentsWithItems: true,
    // Stop fetching items at 70s. The platform kills any request at 150s with
    // nothing written, and two measured runs died there having persisted
    // nothing, because no row is written until the item loop is reached.
    // Headers keep being upserted past this point; only the per-shipment
    // SP-API call stops, and the response says how many were left.
    itemFetchBudgetMs: 70_000,
    // Breadcrumbs to cron_run_history before each phase, so the next kill
    // names the phase instead of leaving us to infer it from a duration.
    phaseTrace: true,
  },
  wide: { lookbackDays: 540, headersOnly: true },   // coverage only
};

/**
 * Stop STARTING work at 110s. The platform kills the request at 150s with no
 * response written, and one sync call plus its throttle has to fit in the
 * remainder. Deliberately well short of the limit rather than near it: the
 * point is that the request always returns and therefore always records.
 */
const DEADLINE_MS = 110_000;

/** How recently `recent` must have succeeded before `wide` may advance coverage. */
const RECENT_FRESHNESS_HOURS = 24;

/**
 * How many times to re-enter the inner sync for one user in a single run. The
 * inner call bounds itself at itemFetchBudgetMs and says whether item work
 * remains; this caps how much of our own 110s we spend resuming it. Anything
 * still outstanding is picked up by the next run through the same cursor.
 */
const MAX_INNER_CALLS = 2;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    if (!internalSecret || !expectedSecret || internalSecret !== expectedSecret) {
      return json({ error: 'Forbidden' }, 403);
    }

    let requestBody: Record<string, unknown> = {};
    try { requestBody = await req.json(); } catch { requestBody = {}; }
    const mode: Mode = requestBody?.mode === 'wide' ? 'wide' : 'recent';
    const jobName = `catchup-fba-shipments-${mode}`;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // BEFORE ANY WORK. If the platform kills this request at 150s, this row is
    // the only evidence it ever started -- and the absence of it is then a real
    // answer rather than an ambiguous one.
    await supabase.rpc('record_cron_run', {
      p_job_name: jobName,
      p_status: 'started',
      p_duration_ms: 0,
      p_items_processed: 0,
      p_error: null,
      p_detail: { triggered_by: requestBody?.triggered_by ?? null, mode },
    });

    // The ordering invariant, enforced rather than assumed.
    if (mode === 'wide') {
      const since = new Date(Date.now() - RECENT_FRESHNESS_HOURS * 3600_000).toISOString();
      const { data: recentOk } = await supabase
        .from('cron_run_history')
        .select('id')
        .eq('job_name', 'catchup-fba-shipments-recent')
        .eq('status', 'success')
        .gte('started_at', since)
        .limit(1);

      if (!recentOk || recentOk.length === 0) {
        const reason =
          `refusing to advance coverage: catchup-fba-shipments-recent has no success in the last ${RECENT_FRESHNESS_HOURS}h. ` +
          `A headers-only pass without the matching items makes /tools/unshipped-purchases report real units as never received.`;
        await supabase.rpc('record_cron_run', {
          p_job_name: jobName,
          p_status: 'failed',
          p_duration_ms: 0,
          p_items_processed: 0,
          p_error: reason,
          p_detail: { skipped_reason: 'recent_pass_not_fresh' },
        });
        // Non-2xx so cron_http_failures sees it. This is a refusal, not a
        // success with a note attached.
        return json({ success: false, mode, error: reason }, 409);
      }
    }

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
      shipments?: number;
      items?: number;
      error?: string;
    };
    const results: UserOutcome[] = [];
    const deferred: string[] = [];
    const t0 = Date.now();

    // 600s TTL: longer than the platform could ever let one run live (150s)
    // and than pg_net waits (300s), so two runs cannot overlap -- but short
    // enough that a killed worker, which never reaches the lock release in
    // withCronLock's finally, does not block a manual retry for long.
    const lock = await withCronLock(supabase, jobName, 600, async () => {
      for (const userId of userIds) {
        if (Date.now() - t0 > DEADLINE_MS) {
          deferred.push(userId);
          continue;
        }

        // The inner sync bounds its own item work and reports what is left,
        // so call it again while there is more AND our own budget allows. Each
        // pass resumes from the cursor; it never redoes a shipment.
        let calls = 0;
        let shipments = 0;
        let items = 0;
        let lastError: string | undefined;
        let sawSuccess = false;

        while (calls < MAX_INNER_CALLS && Date.now() - t0 < DEADLINE_MS) {
          calls++;
          let more = false;
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
              },
              // user_id is MANDATORY on that guard's path. Omitting it is
              // defect 1 above.
              body: JSON.stringify({ user_id: userId, ...MODE_BODY[mode] }),
            });

            const text = await resp.text();
            let payload: Record<string, unknown> | null = null;
            try { payload = JSON.parse(text); } catch { payload = null; }

            if (!resp.ok) {
              lastError = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
              break;
            }

            sawSuccess = true;
            shipments = Number(payload?.shipmentCount ?? payload?.shipmentsFound ?? shipments);
            items += Number(payload?.itemsUpserted ?? payload?.itemCount ?? 0);
            more = payload?.moreItemWorkRemaining === true;
          } catch (e) {
            lastError = (e as Error)?.message ?? String(e);
            break;
          }

          if (!more) break;
          // Breather before resuming the next slice.
          await new Promise((r) => setTimeout(r, 1000));
        }

        if (sawSuccess) {
          results.push({ user_id: userId, ok: true, shipments, items, ...(lastError ? { error: lastError } : {}) });
        } else {
          results.push({ user_id: userId, ok: false, error: lastError ?? 'no response' });
        }

        // Breather for SP-API between users.
        await new Promise((r) => setTimeout(r, 1500));
      }

      const okCount = results.filter((r) => r.ok).length;
      const firstError = results.find((r) => !r.ok)?.error ?? null;

      // THROW SO THE HISTORY ROW SAYS 'failed'.
      //
      // withCronLock derives its status from whether this callback threw, not
      // from what it returned. Swallowing every per-user failure into `results`
      // therefore recorded status 'success' alongside ok:0 -- "the wrapper
      // completed" written down as "the job worked", which is the third time
      // that exact conflation has bitten in this one chain of fixes. The error
      // text goes with it, because `ok:0` with a null error is not actionable.
      if (results.length > 0 && okCount === 0) {
        throw new Error(
          `no user synced (mode=${mode}, users=${results.length}): ${firstError ?? 'no error recorded'}`,
        );
      }

      return {
        items_processed: results.reduce((s, r) => s + (r.items ?? 0), 0),
        detail: {
          mode,
          users: userIds.length,
          ok: okCount,
          deferred: deferred.length,
          ...(firstError ? { first_error: firstError } : {}),
        },
      };
    });

    if (lock.skipped) {
      return json({ skipped_locked: true, mode });
    }

    const ok = results.filter((r) => r.ok).length;
    const summary = {
      mode,
      users: userIds.length,
      ok,
      failed: results.filter((r) => !r.ok).length,
      deferred: deferred.length,
      duration_ms: Date.now() - t0,
      total_shipments: results.reduce((s, r) => s + (r.shipments ?? 0), 0),
      total_items: results.reduce((s, r) => s + (r.items ?? 0), 0),
      results,
    };
    console.log('[catchup-fba-shipments] done', JSON.stringify(summary).slice(0, 800));

    // NON-2XX WHEN NOTHING WORKED, DELIBERATELY.
    //
    // The previous version returned 200 { success: true, failed: N } however
    // badly a run went. public.cron_http_failures only captures non-2xx, so a
    // wrapper that always answers 200 is invisible to the one mechanism built
    // to notice exactly this -- and "the job ran" got reported as "the job
    // worked" for six weeks. Those are two different facts and one status code
    // must not carry both.
    const attempted = userIds.length - deferred.length;
    const everythingFailed = attempted > 0 && ok === 0;
    return json({ success: !everythingFailed, ...summary }, everythingFailed ? 500 : 200);
  } catch (e) {
    console.error('[catchup-fba-shipments] error', e);
    return json({ success: false, error: (e as Error)?.message ?? String(e) }, 500);
  }
});
