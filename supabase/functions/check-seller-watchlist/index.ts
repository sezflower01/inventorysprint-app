// CHECK-SELLER-WATCHLIST
// Resumable, fair-rotation worker (see migrations 20260815133728 and
// 20260815220000). Runs every 5 minutes, spends whatever Keepa budget is
// available on the STALEST watches, and stops cleanly when the budget or the
// clock runs out. The next run resumes from wherever this one stopped.
//
// WHY THIS SHAPE -- the previous version had three defects that combined
// into silent, permanent starvation rather than mere slowness:
//
//   1. `.limit(500)` was GLOBAL across all users, so with more than 500
//      active watches the overflow was never read from the database at all.
//   2. No ORDER BY, so the arbitrary rows Postgres returned first won the
//      rate-limit slot on EVERY run. last_checked_at was written but never
//      read, so nothing preferred a seller that hadn't been checked.
//   3. On a busy gate it did `continue`, and the skip count lived only in
//      the response JSON. The next run started from the same arbitrary order
//      with zero memory of who had been passed over.
//
// Net effect: the same handful of sellers were checked forever while the
// rest never were, and the UI showed all of them as "Watching". Users could
// not tell the difference between "checked and nothing new" and "never
// checked at all".
//
// The fix is ordering, not throughput. `last_checked_at ASC NULLS FIRST`
// makes the queue self-balancing: whoever waited longest goes next, and
// NULLS FIRST puts brand-new unseeded watches at the head so they finish
// seeding promptly. Once ordering is fair, stopping early is CORRECT rather
// than lossy -- an unprocessed seller is simply the stalest one next time.
// That is why this breaks out of the loop instead of skipping onward.
//
// Cost model (measured 2026-08-15, see _shared/keepa-rate-gate.ts):
// /seller?storefront=1 is a flat 10 tokens regardless of catalog size, and
// the plan refills 5 tokens/min, so a full check costs about two minutes of
// budget. At a 50% share that is roughly 350 checks/day across ALL watched
// sellers -- about a 3-day rotation at 1000 sellers. The seller-list diff
// deliberately never calls /product; only genuinely-new ASINs (typically
// 0-5) get a bounded detail batch, so cost scales with new-listing volume
// rather than catalog size.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { acquireKeepaGlobalSlot, reportKeepaTokensLeft, recordKeepa429, KEEPA_COST } from '../_shared/keepa-rate-gate.ts';
import { lookupAsinDetails } from '../_shared/asin-catalog-lookup.ts';
import { getCatalogAccessToken, fetchCatalogItemDetails, fetchCatalogItemsBatch, SPAPI_HOSTS } from '../_shared/spapi-catalog-image.ts';
import { MARKETPLACE_META } from '../_shared/marketplace-map.ts';
import { waitForApiToken } from '../_shared/rate-limiter.ts';
import { qualifyListing } from '../_shared/source-qualification.ts';
import { summarizeOffers } from '../_shared/keepa-offers.ts';
import { readEligibility, resolveEligibility } from '../_shared/eligibility-lookup.ts';
import { withCronLock } from '../_shared/cron-lock.ts';

// Bound on SP-API catalog lookups per run. These cost no Keepa tokens, but
// they do cost wall-clock inside the run budget, and a run only processes a
// couple of sellers anyway.
const MAX_SPAPI_IMAGE_LOOKUPS = 12;

// How many picture-less rows to consider per run. Newest first, since a fresh
// detection is the one a user is most likely looking at right now.
const BLANK_IMAGE_SCAN_LIMIT = 60;

const MAX_PRODUCT_DETAIL_ASINS = 50;

// Stalest N watches considered per run. Only a couple will actually be
// processed on a 5-tokens/min plan; the surplus is headroom so a run with
// spare budget (or a future larger plan) can keep going without a redeploy.
const CANDIDATE_BATCH = 60;

// Leave room inside the cron's 120s timeout to finish the current seller and
// write its state, rather than being killed mid-update.
// Every outbound call goes through this, and none did before.
//
// The function budgets itself 90s (RUN_BUDGET_MS) and checks that deadline
// between sellers -- but a bare fetch() has no timeout, so if Keepa or Amazon
// accepts the connection and never answers, the await never resolves and the
// deadline check is never reached again. The run hangs until the platform
// kills it, holding its 300s cron lock throughout and blocking every
// subsequent run.
//
// That is what happened. check-seller-watchlist last COMPLETED on 2026-08-22;
// for ten days afterwards every run either hung or was skipped as locked while
// pg_cron recorded success. No seller was checked and no new listing detected
// in that whole period -- and nothing surfaced it, because a hung run writes
// no failure row.
//
// 20s per call: well above a healthy Keepa response, far below the run budget,
// so one slow endpoint costs a single seller rather than the entire run.
const FETCH_TIMEOUT_MS = 20_000;

async function fetchT(url: string | URL, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await globalThis.fetch(url, { ...(init ?? {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const RUN_BUDGET_MS = 90_000;

// How long to wait for a token slot before ending the run. A 10-token call
// needs ~2 minutes of refill, which is longer than a run should idle -- past
// this, stopping and letting the next run pick up is cheaper than blocking.
const MAX_SLOT_WAIT_SECONDS = 25;
// Above this, a watch has lost its baseline rather than seen new listings.
// 500 is far beyond any plausible interval burst and far below a storefront.
const MAX_NEW_PER_WATCH = 500;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const KEEPA_DOMAIN: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

const NEW_ASINS_IN_EMAIL = 10;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fill in new-listing rows that are missing a picture.
 *
 * Runs ONCE PER INVOCATION over every blank row, deliberately decoupled from
 * which sellers this run happens to check. The first version keyed this to the
 * seller being processed, which meant a blank image waited for that seller's
 * turn in the rotation -- up to a full cycle, about ten hours at 400 sellers.
 * That coupling bought nothing: none of this spends Keepa tokens, so there is
 * no reason to ration it by rotation slot. Now a row detected at any point
 * gets its image on the next 5-minute run.
 *
 * Sources in cheapest-first order: catalogs this app already populated (free
 * table reads), then SP-API Catalog Items for whatever is still missing --
 * Amazon's own data, on a quota entirely separate from Keepa.
 */
async function backfillBlankImages(admin: any, deadlineAt: number): Promise<Record<string, number>> {
  const stats = { scanned: 0, fromCatalog: 0, fromSpApi: 0, stillBlank: 0, tokenMissing: 0 };
  try {
    const { data: blankRows } = await admin
      .from('seller_watch_new_listings')
      .select('id, asin, user_id, marketplace, title, image_url')
      .is('image_url', null)
      .order('detected_at', { ascending: false })
      .limit(BLANK_IMAGE_SCAN_LIMIT);

    if (!blankRows?.length) return stats;
    stats.scanned = blankRows.length;

    const details = await lookupAsinDetails(admin, blankRows.map((r: any) => r.asin));

    // Group the leftovers by (user, marketplace): the SP-API token is scoped
    // to both, so this exchanges one token per group rather than per row.
    const stillBlank = blankRows.filter((r: any) => !details.get(r.asin)?.image);
    const groups = new Map<string, any[]>();
    for (const row of stillBlank) {
      const key = `${row.user_id}|${row.marketplace}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    let spapiBudget = MAX_SPAPI_IMAGE_LOOKUPS;
    for (const [key, rows] of groups) {
      if (spapiBudget <= 0 || Date.now() >= deadlineAt) break;
      const [userId, marketplace] = key.split('|');
      const token = await getCatalogAccessToken(admin, userId, marketplace);
      if (!token) {
        stats.tokenMissing += rows.length;
        continue;
      }
      for (const row of rows) {
        if (spapiBudget <= 0 || Date.now() >= deadlineAt) break;
        spapiBudget--;
        const spapi = await fetchCatalogItemDetails(admin, token, row.asin, marketplace);
        if (spapi.image || spapi.title) {
          const prev = details.get(row.asin);
          details.set(row.asin, {
            title: prev?.title ?? spapi.title,
            image: prev?.image ?? spapi.image,
          });
          if (spapi.image) stats.fromSpApi++;
        }
      }
    }

    for (const row of blankRows) {
      const found = details.get(row.asin);
      if (!found?.image && !found?.title) { stats.stillBlank++; continue; }
      const patch: Record<string, unknown> = {};
      if (found.image) patch.image_url = found.image;
      if (found.title && !row.title) patch.title = found.title;
      if (!Object.keys(patch).length) { stats.stillBlank++; continue; }
      await admin.from('seller_watch_new_listings').update(patch).eq('id', row.id);
    }
    stats.fromCatalog = stats.scanned - stats.stillBlank - stats.fromSpApi;
  } catch (e) {
    console.warn('[check-seller-watchlist] image backfill failed', (e as Error).message);
  }
  return stats;
}

/**
 * Claim a token slot, waiting briefly if the wait is short enough to be worth
 * it and there is time left in the run. Returns the final (possibly failed)
 * claim; callers end the run rather than skipping onward, so that a refused
 * seller stays at the head of the queue for next time.
 */
async function acquireSlotOrGiveUp(admin: any, estimatedTokens: number, deadlineAt: number) {
  const first = await acquireKeepaGlobalSlot(admin, { estimatedTokens });
  if (first.ok) return first;

  const waitSeconds = Math.min(first.waitSeconds ?? MAX_SLOT_WAIT_SECONDS, MAX_SLOT_WAIT_SECONDS);
  if (Date.now() + waitSeconds * 1000 >= deadlineAt) return first;

  await sleep(waitSeconds * 1000);
  return acquireKeepaGlobalSlot(admin, { estimatedTokens });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // Same auth gate as check-price-alerts: internal secret (cron) or
  // service-role bearer (manual/internal trigger). Never open to the public
  // -- this reads every user's active watches and spends Keepa tokens.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKey && bearer === serviceRoleKey;
  if (!okSecret && !okServiceBearer) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + RUN_BUDGET_MS;

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
  if (!KEEPA_KEY) return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);
  const admin = createClient(SUPABASE_URL, serviceRoleKey);

  // Wrapped so every run leaves a row in cron_run_history.
  //
  // Two crons call this function -- the 5-minute sweep and an hourly catch-up
  // -- and both are now confined to midnight-6am Pacific, so they overlap far
  // more often within a narrow window than they used to. The lock stops two
  // runs claiming Keepa tokens against the same budget.
  //
  // The observability half matters just as much. A watch's FIRST check seeds
  // its baseline and deliberately produces no listings, so an empty Done tab
  // is the expected outcome of a successful seeding run -- indistinguishable
  // from the job never having fired. Without a run record there was no way to
  // tell those apart except by reading the code and inferring.
  let outcome: Record<string, unknown> = {};
  // Early exits inside the lock cannot return a Response -- withCronLock wants
  // a work result -- so the status rides alongside the body.
  let outcomeStatus = 200;
  // A watchdog that frees the lock even if the run below never returns.
  //
  // Wrapping the five outbound fetches in a 20s timeout was not enough: a run
  // acquired at 11:37 was still holding at 11:40:39, well past its 90s
  // RUN_BUDGET_MS. So the stall is not in those calls -- it is in one of the
  // many supabase-js awaits (admin.from / admin.rpc), which carry their own
  // fetch and no timeout. On a database with documented PostgREST pool
  // exhaustion, a DB call that never answers is entirely plausible.
  //
  // Rather than guess which await hangs, this bounds the CONSEQUENCE. The
  // lock is released unconditionally shortly after the run budget expires, so
  // a hung run can no longer block its successors. Every run then gets its
  // chance at the queue instead of alternating between hang and skip, which is
  // what left the job with no completed run since 2026-08-22.
  //
  // Releasing early is safe: withCronLock releases again in its finally, and
  // release_cron_lock on an already-free lock is a no-op. The hung isolate is
  // eventually reaped by the platform.
  //
  // This does NOT fix the hang. It stops one hang costing ten days.
  const watchdog = setTimeout(() => {
    void (async () => {
      try {
        await admin.rpc('release_cron_lock', { p_job_name: 'check-seller-watchlist' });
        console.warn('[seller-watch] watchdog released the lock — run exceeded its budget');
      } catch (e) {
        console.warn('[seller-watch] watchdog release failed:', e);
      }
    })();
  }, RUN_BUDGET_MS + 15_000);

  // TTL 240s, not 300. The cron fires every 300s, so an equal TTL means a run
  // that overruns by a second still blocks the next one outright.
  const lock = await withCronLock(admin, 'check-seller-watchlist', 240, async () => {

    // Plan mode: report the queue order WITHOUT calling Keepa or mutating
    // anything. This is how fair rotation is verified against real data --
    // run it, run the worker, run it again, and watch the just-checked seller
    // move to the back.
    //
    // Accepted BOTH as ?plan=true and as {"plan":true}. The query parameter
    // exists because PowerShell strips inner quotes when passing a JSON body
    // to native curl, so a bash-shaped `-d '{"plan":true}'` silently arrives
    // as invalid JSON. A query string has no such hazard.
    //
    // An unparseable body is now a 400 rather than an empty object. It
    // previously fell back to `{}`, which meant a mangled --data turned a
    // read-only request into a live run that spent real Keepa tokens -- the
    // exact opposite of what the caller asked for. Cron sends well-formed
    // JSON, and a bodyless POST is still fine, so failing closed here costs
    // nothing and removes a foot-gun.
    const rawBody = await req.text().catch(() => '');
    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        outcome = {
          error: 'Request body was not valid JSON. Nothing was run and no Keepa tokens were spent. On PowerShell, prefer the query form: ?plan=true',
          receivedBody: rawBody.slice(0, 200),
        };
        outcomeStatus = 400;
        return { items_processed: 0, detail: { badRequest: true } };
      }
    }

    const planParam = new URL(req.url).searchParams.get('plan');
    const planOnly = body?.plan === true || planParam === 'true' || planParam === '1';

    // --- Step 1: the stalest watches, oldest first, unseeded ahead of all ---
    // No global cap. The bound is "what one run can plausibly process",
    // applied in staleness order, rather than an arbitrary slice of the table.
    const { data: candidates, error } = await admin
      .from('seller_watchlist')
      .select('id, seller_id, marketplace, last_checked_at')
      .eq('status', 'active')
      .order('last_checked_at', { ascending: true, nullsFirst: true })
      .limit(CANDIDATE_BATCH);
    if (error) throw new Error(error.message);

    const { count: totalActive } = await admin
      .from('seller_watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    if (!candidates?.length) {
      outcome = { ok: true, checked: 0, alertsFired: 0, distinctSellers: 0, totalActive: totalActive ?? 0 };
      return { items_processed: 0, detail: { nothingQueued: true, totalActive: totalActive ?? 0 } };
    }

    // Distinct seller+marketplace pairs, preserving staleness order.
    const orderedPairs: { sellerId: string; marketplace: string; stalest: string | null }[] = [];
    const seenPair = new Set<string>();
    for (const c of candidates) {
      const key = `${c.seller_id}|${c.marketplace}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      orderedPairs.push({ sellerId: c.seller_id, marketplace: c.marketplace, stalest: c.last_checked_at });
    }

    if (planOnly) {
      outcome = {
        ok: true,
        planOnly: true,
        totalActive: totalActive ?? 0,
        queue: orderedPairs.map((p, i) => ({
          position: i + 1,
          sellerId: p.sellerId,
          marketplace: p.marketplace,
          lastCheckedAt: p.stalest,
          seeded: p.stalest !== null,
        })),
        note: 'Order is last_checked_at ASC NULLS FIRST. Unseeded watches (null) sort first, then longest-waiting. Nothing was called or modified.',
      };
      return { items_processed: 0, detail: { planOnly: true, queued: orderedPairs.length } };
    }

    // --- Step 2: all watchers of those sellers, so one Keepa call still
    // serves everyone watching the same storefront (the original cost-sharing
    // property). Fetched by the pair components then filtered exactly, since
    // PostgREST cannot express a composite IN cleanly.
    const { data: allWatches, error: fetchErr } = await admin
      .from('seller_watchlist')
      .select('id, user_id, seller_id, seller_name, marketplace, notify_email, known_asin_list')
      .eq('status', 'active')
      .in('seller_id', orderedPairs.map((p) => p.sellerId))
      .in('marketplace', Array.from(new Set(orderedPairs.map((p) => p.marketplace))));
    if (fetchErr) throw new Error(fetchErr.message);

    const groups = new Map<string, typeof allWatches>();
    for (const w of allWatches || []) {
      const key = `${w.seller_id}|${w.marketplace}`;
      if (!seenPair.has(key)) continue; // over-fetch from the cross-product
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(w);
    }

    // Before the Keepa loop: this spends no Keepa tokens, and running it
    // after would let an exhausted budget (which breaks out of that loop)
    // skip it entirely.
    const imageBackfill = await backfillBlankImages(admin, deadlineAt);

    let checked = 0;
    let alertsFired = 0;
    let processedSellers = 0;
  let lostBaselines = 0;
    // Counted separately from `checked` because a first check is the one that
    // produces NO listings by design. Without this number, a night that
    // correctly seeded 200 baselines is indistinguishable in the record from a
    // night the job never ran.
    let seeded = 0;
    let stoppedReason: string | null = null;
    const nowIso = new Date().toISOString();

    for (const pair of orderedPairs) {
      const key = `${pair.sellerId}|${pair.marketplace}`;
      const group = groups.get(key);
      if (!group?.length) continue;

      if (Date.now() >= deadlineAt) { stoppedReason = 'run-time-budget'; break; }

      const { sellerId, marketplace } = pair;

      const slot = await acquireSlotOrGiveUp(admin, KEEPA_COST.sellerStorefront, deadlineAt);
      if (!slot.ok) {
        // Deliberately BREAK, not continue. With fair ordering this seller is
        // simply the stalest next run; grinding through the rest would spend
        // the remaining budget on fresher sellers and re-starve this one.
        stoppedReason = `keepa-${slot.blockedBy ?? 'budget'}`;
        break;
      }

      const domainId = KEEPA_DOMAIN[marketplace] ?? 1;
      let currentAsins: string[] | null = null;
      let currentSellerName: string | null = null;
      try {
        const url = `https://api.keepa.com/seller?key=${KEEPA_KEY}&domain=${domainId}&seller=${encodeURIComponent(sellerId)}&storefront=1`;
        const res = await fetchT(url);
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          await reportKeepaTokensLeft(admin, json?.tokensLeft, json?.refillRate);
          const seller = json?.sellers?.[sellerId];
          if (seller) {
            currentAsins = Array.isArray(seller.asinList) ? seller.asinList : [];
            currentSellerName = seller.sellerName || null;
          } else {
            console.warn(`[check-seller-watchlist] seller not found in Keepa response: ${sellerId}`);
          }
        } else {
          console.warn(`[check-seller-watchlist] Keepa HTTP ${res.status} for ${sellerId}`);
          // A 429 body carries the balance AT refusal, usually NEGATIVE.
          // Recording it is what keeps keepa_token_budget from reading
          // positive while the account is overdrawn -- the desync that let the
          // gate approve calls against a number that was already fiction.
          if (res.status === 429) {
            const txt = await res.text().catch(() => '');
            let tl: unknown = undefined;
            try { tl = JSON.parse(txt)?.tokensLeft; } catch { /* not JSON */ }
            await recordKeepa429(admin, tl, 'check-seller-watchlist /seller');
          }
        }
      } catch (e) {
        console.warn(`[check-seller-watchlist] Keepa fetch failed for ${sellerId}`, (e as Error).message);
      }

      // Fetch failed entirely -- leave these watches untouched so they keep
      // their place at the head of the queue and retry next run, rather than
      // silently losing their baseline.
      if (currentAsins === null) continue;

      processedSellers++;

      // Pass 1: compute each watch's own newAsins (their known_asin_list may
      // differ if they subscribed at different times) and accumulate the union
      // so product details are fetched once per ASIN, not once per watch.
      const perWatchNew = new Map<string, string[]>();
      const unionNewAsins = new Set<string>();
      for (const w of group) {
        const priorList = w.known_asin_list as string[] | null;
        if (priorList === null || priorList === undefined) continue; // first check -- seeds below, no diff
        const priorSet = new Set(priorList);
        const newAsins = currentAsins.filter((a) => !priorSet.has(a));

        // A diff this size is a LOST BASELINE, not a listing burst.
        //
        // Measured 2026-09-01: one seller produced 71,925 "new" ASINs -- an
        // entire storefront. An empty known_asin_list ([] rather than NULL)
        // passes the first-check guard above, and then every current ASIN
        // looks new. Downstream, the eligibility read alone spent 83 seconds
        // on that list and the platform killed the isolate on CPU before the
        // run could write a completion row -- which is why this job was
        // INVISIBLE rather than merely broken for ten days.
        //
        // Skipping is safe and self-healing: Pass 2 sets
        // known_asin_list = currentAsins for every watch regardless, so the
        // baseline is rewritten and the next run diffs correctly. Emitting
        // 71,925 false "new listings" would be far worse than emitting none.
        if (newAsins.length > MAX_NEW_PER_WATCH) {
          console.warn(`[seller-watch] ${sellerId} watch ${w.id}: ${newAsins.length} new ASINs exceeds ${MAX_NEW_PER_WATCH} -- treating as lost baseline, re-seeding without alerts`);
          lostBaselines++;
          continue;
        }

        if (newAsins.length > 0) {
          perWatchNew.set(w.id, newAsins);
          for (const a of newAsins) unionNewAsins.add(a);
        }
      }

      // One bounded batch call for whatever's genuinely new across the whole
      // group -- title/brand/image/upc, needed for the new-listings feed and
      // Find Source's search query. /product bills 1 token PER ASIN, so this
      // reserves for the real batch size rather than "one call".
      const productDetails = new Map<string, {
        title: string | null; brand: string | null; image: string | null; upc: string | null;
        productGroup?: string | null; salesRank?: number | null;
      }>();
      if (unionNewAsins.size > 0) {
        const asinsToFetch = Array.from(unionNewAsins).slice(0, MAX_PRODUCT_DETAIL_ASINS);

        // SP-API Catalog Items FIRST. It supplies the same four fields this
        // used to take from Keepa (title, brand, image, upc) on a quota about
        // 24x the entire Keepa daily budget -- catalog_api runs at 2 req/s
        // against Keepa's 5 tokens/min total. This is the only Keepa call in
        // the 5-minute cron that has an equivalent elsewhere, so moving it is
        // the one place a shift actually relieves the shared budget.
        //
        // Note this does NOT speed up the rotation: that is bounded by
        // /seller?storefront=1 at a flat 10 tokens, which SP-API cannot
        // replace at all. What it buys is that new-listing metadata stops
        // competing with the storefront sweep for the same tokens.
        // BATCHED: 20 ASINs per call, so all MAX_PRODUCT_DETAIL_ASINS get
        // resolved in ~3 calls instead of 12 ASINs in 12 calls.
        //
        // This matters far beyond speed. SP-API is the ONLY source of
        // productGroup -- the Keepa fallback below supplies title/brand/image/
        // upc and no category at all -- so the old per-ASIN cap meant the
        // category filter usually ran on a null product_group, and unknown
        // deliberately qualifies. Measured 2026-08-17 before this change:
        // product_group resolved on 12% of 2,284 listings.
        const spApiToken = await getCatalogAccessToken(admin, group[0].user_id, marketplace);
        if (spApiToken && Date.now() < deadlineAt) {
          const batch = await fetchCatalogItemsBatch(admin, spApiToken, asinsToFetch, marketplace);
          for (const [asin, sp] of batch) {
            if (sp.title || sp.image || sp.productGroup) {
              productDetails.set(asin, {
                title: sp.title, brand: sp.brand, image: sp.image, upc: sp.upc,
                productGroup: sp.productGroup, salesRank: sp.salesRank,
              });
            }
          }
        }
        // Only ask Keepa for what SP-API could not supply, and reserve tokens
        // for that remainder rather than the original batch size -- otherwise
        // the shift saves no budget at all, just adds a second call.
        const keepaStillNeeded = asinsToFetch.filter((a) => !productDetails.get(a)?.title);
        const detailSlot = keepaStillNeeded.length
          ? await acquireSlotOrGiveUp(admin, keepaStillNeeded.length * KEEPA_COST.productPerAsin, deadlineAt)
          : { ok: false, waitSeconds: 0, skipped: true } as const;
        if (detailSlot.ok) {
          try {
            const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domainId}&asin=${keepaStillNeeded.join(',')}`;
            const res = await fetchT(url);
            if (res.ok) {
              const json = await res.json().catch(() => ({}));
              await reportKeepaTokensLeft(admin, json?.tokensLeft, json?.refillRate);
              const products = Array.isArray(json?.products) ? json.products : [];
              for (const p of products) {
                if (!p?.asin) continue;
                const image = p?.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${String(p.imagesCSV).split(',')[0]}` : null;
                const upc = Array.isArray(p?.upcList) && p.upcList.length ? String(p.upcList[0]) : null;
                productDetails.set(p.asin, {
                  title: p?.title || null,
                  brand: p?.brand || p?.manufacturer || null,
                  image,
                  upc,
                });
              }
            } else {
              console.warn(`[check-seller-watchlist] Keepa /product HTTP ${res.status} for new-asin batch`);
              if (res.status === 429) {
                const txt = await res.text().catch(() => '');
                let tl: unknown = undefined;
                try { tl = JSON.parse(txt)?.tokensLeft; } catch { /* not JSON */ }
                await recordKeepa429(admin, tl, 'check-seller-watchlist /product-batch');
              }
            }
          } catch (e) {
            console.warn(`[check-seller-watchlist] Keepa /product fetch failed for new-asin batch`, (e as Error).message);
          }
        } else {
          // Detail fetch is optional: the new-listing rows still get written
          // with null metadata and the seller-level diff is not lost.
          // Silent when there is simply nothing left for Keepa to add --
          // that is the shift working, not a failure.
          if (keepaStillNeeded.length) {
            console.warn(`[check-seller-watchlist] no token budget for ${keepaStillNeeded.length} product-detail ASIN(s) for ${sellerId}/${marketplace}`);
          }
        }

        // Fill whatever Keepa left blank from catalogs we already populate.
        // A brand-new listing is exactly when Keepa's record is thinnest --
        // a title often arrives before imagesCSV does -- and this costs no
        // tokens, so it runs whether or not the fetch above was skipped.
        const missing = Array.from(unionNewAsins).filter((a) => !productDetails.get(a)?.image);
        if (missing.length) {
          const fromCatalog = await lookupAsinDetails(admin, missing);
          for (const [asin, details] of fromCatalog) {
            const existing = productDetails.get(asin);
            productDetails.set(asin, {
              title: existing?.title ?? details.title,
              brand: existing?.brand ?? null,
              image: existing?.image ?? details.image,
              upc: existing?.upc ?? null,
            });
          }
        }
      }

      // Eligibility for the ASINs about to be written. Restricted items are
      // excluded from auto-search entirely, so resolving this BEFORE the row
      // is stamped avoids ever queueing an unsellable product. One
      // listings_api call (5 req/s) against a search chain costing a CSE
      // query plus several Gemini calls -- the trade is heavily favourable.
      const eligibilityByAsin = new Map<string, 'approved' | 'approval_required' | 'restricted'>();
      let allowNeedsApproval = true;
      // undefined = fall back to the built-in defaults in source-qualification.
      // An empty result from the table would otherwise read as "exclude
      // nothing", silently switching the filter off for a user whose seed rows
      // failed to write.
      const userExclusions: { groups?: Set<string>; brands?: Set<string>; titles?: string[] } = {};
      // Per-user alert address. NULL means the account email, which is what
      // seller_watchlist.notify_email already holds -- so the fallback below is
      // the existing behaviour, unchanged.
      let notifyOverride: string | null = null;

      // The seller's own brands, for the price-capture filter further down.
      //
      // Declared HERE, beside userExclusions, rather than inside the
      // `unionNewAsins.size > 0` block where it was first written: that block
      // closes before Pass 2 builds the rows, so the helper was out of scope at
      // the only place that uses it.
      const myBrandsExact = new Set<string>();
      const myBrandsPrefix: string[] = [];
      try {
        const { data: ub } = await admin
          .from('user_brands')
          .select('brand, match_mode, status')
          .eq('user_id', group[0].user_id);
        for (const b of ub || []) {
          const name = String(b?.brand ?? '').trim().toLowerCase();
          if (!name) continue;
          if (String(b?.status ?? '') === 'ignore') continue;
          if (String(b?.match_mode ?? '') === 'prefix') myBrandsPrefix.push(name);
          else myBrandsExact.add(name);
        }
      } catch (e) {
        // Non-fatal, and it fails CLOSED: an empty brand set prices nothing,
        // which is the safe direction for a Keepa budget the repricer shares.
        console.warn('[seller-watch] user_brands load failed:', (e as Error).message);
      }
      const isMyBrand = (raw: string | null | undefined): boolean => {
        const b = String(raw ?? '').trim().toLowerCase();
        if (!b) return false;
        if (myBrandsExact.has(b)) return true;
        return myBrandsPrefix.some((pfx) => b.startsWith(pfx));
      };
      if (unionNewAsins.size > 0) {
        const uid = group[0].user_id;
        const { data: cfg } = await admin
          .from('auto_source_config')
          .select('search_needs_approval, notify_email')
          .eq('user_id', uid)
          .maybeSingle();
        // Absent config means defaults, and the default is to allow.
        allowNeedsApproval = cfg?.search_needs_approval !== false;
        notifyOverride = cfg?.notify_email?.trim() || null;

        const { data: terms } = await admin
          .from('source_excluded_terms')
          .select('kind, value')
          .eq('user_id', uid);
        // Each kind is assigned ONLY when it actually has entries.
        //
        // The outer `terms?.length` guard was not enough. qualifyListing reads
        // `input.excludedBrands ?? EXCLUDED_BRANDS`, so an EMPTY set is still
        // "provided" and silently overrides the built-in defaults. A user with
        // category exclusions but no brand exclusions therefore had brand
        // filtering switched off entirely -- generic/unbranded/unknown stopped
        // being excluded, with nothing to indicate it. Exactly the failure the
        // outer guard was written to prevent, one level down.
        if (terms?.length) {
          const groups = terms.filter((t: any) => t.kind === 'category').map((t: any) => String(t.value));
          const brands = terms.filter((t: any) => t.kind === 'brand').map((t: any) => String(t.value));
          const titles = terms.filter((t: any) => t.kind === 'title_keyword').map((t: any) => String(t.value));
          if (groups.length) userExclusions.groups = new Set(groups);
          if (brands.length) userExclusions.brands = new Set(brands);
          // Titles are the exception to the guard above: there is no built-in
          // default list to fall back to, so an empty array and an omitted one
          // mean the same thing. Assigned unconditionally for that reason.
          userExclusions.titles = titles;
        }

        const wanted = Array.from(unionNewAsins);
        const cached = await readEligibility(admin, uid, marketplace, wanted);
        const unknown = wanted.filter((a) => !cached.has(a));
        for (const [a, v] of cached) eligibilityByAsin.set(a, v);
        if (unknown.length && Date.now() < deadlineAt) {
          const fresh = await resolveEligibility(
            admin, SUPABASE_URL, serviceRoleKey, internalSecret, uid, marketplace, unknown,
          );
          for (const [a, v] of fresh) eligibilityByAsin.set(a, v);
        }
      }

      // Pass 2: seed first-check watches, persist new-listing rows, email, update.
      for (const w of group) {
        checked++;
        const patch: Record<string, unknown> = { last_checked_at: nowIso, known_asin_list: currentAsins };
        if (currentSellerName && !w.seller_name) patch.seller_name = currentSellerName;

        const priorList = w.known_asin_list as string[] | null;
        if (priorList === null || priorList === undefined) {
          // First check for this watch -- seed the baseline, don't alert.
          await admin.from('seller_watchlist').update(patch).eq('id', w.id);
          seeded++;
          continue;
        }

        const newAsins = perWatchNew.get(w.id) || [];

        if (newAsins.length > 0) {
          const rows = newAsins.map((asin) => {
            const details = productDetails.get(asin);
            // Decide here, once, whether this is worth an automatic source
            // search. Storing the verdict (and WHY) means the worker does a
            // cheap indexed read instead of re-deriving it, and a surprising
            // exclusion can be explained after the fact rather than guessed at.
            const q = qualifyListing({
              productGroup: details?.productGroup ?? null,
              salesRank: details?.salesRank ?? null,
              upc: details?.upc ?? null,
              brand: details?.brand ?? null,
              eligibility: eligibilityByAsin.get(asin) ?? null,
              allowNeedsApproval,
              title: details?.title ?? null,
              excludedGroups: userExclusions.groups,
              excludedBrands: userExclusions.brands,
              excludedTitleTerms: userExclusions.titles,
            });
            return {
              watch_id: w.id,
              user_id: w.user_id,
              seller_id: sellerId,
              marketplace,
              asin,
              title: details?.title ?? null,
              brand: details?.brand ?? null,
              image_url: details?.image ?? null,
              upc: details?.upc ?? null,
              product_group: details?.productGroup ?? null,
              sales_rank: details?.salesRank ?? null,
              qualified: q.qualified,
              disqualified_reason: q.reason,
              // Filled in below, for qualified rows only. Declared here so the
              // column is always present rather than appearing on some rows and
              // not others depending on which branch ran.
              amazon_price_cents: null as number | null,
              new_price_cents: null as number | null,
              price_captured_at: null as string | null,
              referral_fee_cents: null as number | null,
              fba_fee_cents: null as number | null,
              total_fees_cents: null as number | null,
              fees_captured_at: null as string | null,
              // Offer composition for strict mode. NULL stays meaningful: it is
              // "never captured", which strict mode treats as unknown rather
              // than as zero competition.
              fba_offer_count: null as number | null,
              fbm_offer_count: null as number | null,
              seller_offer_is_fba: null as boolean | null,
              offers_captured_at: null as string | null,
              detected_at: nowIso,
            };
          });

          // PRICE CAPTURE, for ROI -- only on rows matching the SELLER'S OWN
          // BRANDS.
          //
          // Was `r.qualified`, which stopped being a useful selector on
          // 2026-09-02 when qualification was reduced to the `restricted` check
          // alone. Under the old seven rules ~4% of detections qualified; under
          // one rule nearly all do, so keeping that predicate would have priced
          // roughly 25x more ASINs against a Keepa budget of 20 tokens/min that
          // the repricer shares -- starving live repricing to price listings
          // nobody asked to see.
          //
          // Brand match is the right selector now because it is the ONLY filter
          // the seller kept: a listing that is not one of their brands is never
          // shown, so pricing it buys nothing. Volume lands close to the old 4%
          // for the same reason.
          //
          // Matched here rather than read from brand_match_state because that
          // column is filled later by classify-listing-brands, on its own cron.
          // At detection time it is always 'pending', so reading it would price
          // nothing at all.
          //
          // WHY A SEPARATE CALL. The Keepa /product above only runs for ASINs
          // SP-API could not resolve, and since the batched catalog lookup
          // landed that is nearly none -- so adding stats=1 there would capture
          // almost nothing. This is its own call, and its own cost.
          //
          // COST, measured not assumed: /product is 1 token per ASIN and
          // stats=1 adds ZERO (verified: plain call tokensConsumed 1, with
          // stats=1 tokensConsumed 1). At ~4% of ~281 detections/day that is
          // roughly 11 tokens/day against a 7,200/day refill.
          //
          // buybox=1 was measured at tokensConsumed 3 -- triple -- and is
          // deliberately NOT used. stats.current[1] (lowest New) is the proxy;
          // it is not the buy-box price and the column comment says so.
          const needPrice = rows
            .filter((r: any) => isMyBrand(r.brand))
            .map((r: any) => r.asin);
          if (needPrice.length && Date.now() < deadlineAt) {
            // offers=20 rather than stats=1 alone, changed 2026-08-19.
            //
            // stats.current[11] (COUNT_NEW) is free on a stats=1 call and was
            // the original plan for "how many sellers". It cannot answer the
            // question actually being asked: it counts FBA AND FBM together.
            // Measured live -- B00JSWP62I reported COUNT_NEW 2 with ZERO FBA
            // offers, B0D8H77XRY reported 1 with zero FBA. Per-offer isFBA only
            // comes with offers=20, and locating the WATCHED seller's own offer
            // (by exact sellerId, verified 2/2 on real watches) needs the offer
            // array too.
            //
            // COST: 5-6 tokens per ASIN instead of 1, measured not assumed. At
            // the ~11 qualified ASINs/day this call already covers that is ~60
            // tokens/day against a 7,200/day refill. Accepted deliberately.
            const priceSlot = await acquireSlotOrGiveUp(
              admin, needPrice.length * KEEPA_COST.productWithOffersPerAsin, deadlineAt,
            );
            if (priceSlot.ok) {
              try {
                const purl = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domainId}&asin=${needPrice.join(',')}&stats=1&offers=20`;
                const pres = await fetchT(purl);
                if (pres.ok) {
                  const pjson = await pres.json().catch(() => ({}));
                  await reportKeepaTokensLeft(admin, pjson?.tokensLeft, pjson?.refillRate);
                  // Keepa signals failure in the body of a 200 -- same trap as
                  // mobile-scan-price-history. Check it before reading products.
                  if (pjson?.error) {
                    console.warn('[check-seller-watchlist] price capture Keepa in-body error:',
                      typeof pjson.error === 'string' ? pjson.error : JSON.stringify(pjson.error));
                  } else {
                    const nowIsoPrice = new Date().toISOString();
                    for (const p of (Array.isArray(pjson?.products) ? pjson.products : [])) {
                      const cur = p?.stats?.current;
                      if (!p?.asin || !Array.isArray(cur)) continue;
                      const row = rows.find((r: any) => r.asin === p.asin);
                      if (!row) continue;
                      // -1 is Keepa's "no data" and -2 is "unavailable". Neither
                      // is a price, and storing either as one would silently
                      // produce negative ROI.
                      const clean = (v: unknown) =>
                        typeof v === 'number' && v > 0 ? Math.round(v) : null;
                      row.amazon_price_cents = clean(cur[0]);
                      row.new_price_cents = clean(cur[1]);
                      if (row.amazon_price_cents != null || row.new_price_cents != null) {
                        row.price_captured_at = nowIsoPrice;
                      }

                      // Offer composition, from the SAME response. Counting the
                      // raw offers array would overstate competition badly --
                      // B0GYVHLP4L returned 116 offers of which only 61 were
                      // live -- so summarizeOffers() walks liveOffersOrder.
                      const summary = summarizeOffers(p?.offers, p?.liveOffersOrder, row.seller_id);
                      row.fba_offer_count = summary.fbaCount;
                      row.fbm_offer_count = summary.fbmCount;
                      row.seller_offer_is_fba = summary.sellerOfferIsFba;
                      row.offers_captured_at = nowIsoPrice;
                    }
                  }
                } else if (pres.status === 429) {
                  // The offers=20 price-capture batch is the most expensive
                  // shape this worker makes, so its refusals move the balance
                  // furthest and matter most to record.
                  const ptxt = await pres.text().catch(() => '');
                  let ptl: unknown = undefined;
                  try { ptl = JSON.parse(ptxt)?.tokensLeft; } catch { /* not JSON */ }
                  await recordKeepa429(admin, ptl, 'check-seller-watchlist /price-capture');
                }
              } catch (e) {
                console.warn('[check-seller-watchlist] price capture failed:', (e as Error).message);
              }
            }
          }

          // FEES, for the rows that got a price.
          //
          // The Fees API needs the sell price as an input, so this must follow
          // price capture and cannot be done in the browser from cached data.
          // Captured once here rather than when the Done tab opens, which would
          // burst one call per visible row on every page view.
          //
          // fees_api is a SEPARATE bucket from the contended pricing_api
          // (measured: capacity 2 / refill 1s, versus 1 / 0.5s shared with the
          // repricer), which is what makes this affordable at all.
          const needFees = rows.filter((r: any) => r.new_price_cents || r.amazon_price_cents);
          if (needFees.length && Date.now() < deadlineAt) {
            const feeToken = await getCatalogAccessToken(admin, group[0].user_id, marketplace);
            const mpId = MARKETPLACE_META[marketplace]?.amazonMarketplaceId;
            const spHost = SPAPI_HOSTS[marketplace];
            if (feeToken && mpId && spHost) {
              for (const row of needFees) {
                if (Date.now() >= deadlineAt) break;
                const cents = row.new_price_cents ?? row.amazon_price_cents;
                if (!cents) continue;
                try {
                  await waitForApiToken(admin, 'fees_api');
                  const fres = await fetchT(
                    `https://${spHost}/products/fees/v0/items/${row.asin}/feesEstimate`,
                    {
                      method: 'POST',
                      headers: { 'x-amz-access-token': feeToken, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        FeesEstimateRequest: {
                          MarketplaceId: mpId,
                          IsAmazonFulfilled: true,
                          Identifier: row.asin,
                          PriceToEstimateFees: {
                            ListingPrice: { CurrencyCode: 'USD', Amount: cents / 100 },
                          },
                        },
                      }),
                    },
                  );
                  if (!fres.ok) { console.warn(`[check-seller-watchlist] fees HTTP ${fres.status} for ${row.asin}`); continue; }
                  const fj = await fres.json().catch(() => ({}));
                  const result = fj?.payload?.FeesEstimateResult;
                  // Amazon reports per-item failure INSIDE a 200 via Status.
                  if (result?.Status !== 'Success') {
                    console.warn(`[check-seller-watchlist] fees status ${result?.Status} for ${row.asin}`);
                    continue;
                  }
                  const det = result?.FeesEstimate?.FeeDetailList || [];
                  const pick = (t: string) =>
                    Number(det.find((d: any) => d?.FeeType === t)?.FeeAmount?.Amount ?? 0);
                  const total = Number(result?.FeesEstimate?.TotalFeesEstimate?.Amount ?? 0);
                  if (!(total > 0)) continue;
                  row.referral_fee_cents = Math.round(pick('ReferralFee') * 100);
                  row.fba_fee_cents = Math.round(pick('FBAFees') * 100);
                  row.total_fees_cents = Math.round(total * 100);
                  row.fees_captured_at = new Date().toISOString();
                } catch (e) {
                  console.warn(`[check-seller-watchlist] fee capture failed for ${row.asin}:`, (e as Error).message);
                }
              }
            }
          }

          const { error: insertErr } = await admin
            .from('seller_watch_new_listings')
            .upsert(rows, { onConflict: 'watch_id,asin', ignoreDuplicates: true });
          if (insertErr) console.error(`[check-seller-watchlist] new-listing insert failed for watch ${w.id}`, insertErr.message);

          try {
            const emailRes = await fetchT(`${SUPABASE_URL}/functions/v1/send-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
              body: JSON.stringify({
                // Resolved at SEND time, not baked into the watch row. A user
                // who changes their address gets it applied to all 400+ existing
                // watches immediately, with no bulk update and nothing to
                // backfill. Falls back to the per-watch address, which is the
                // account email the creator functions stamped.
                to: notifyOverride || w.notify_email,
                name: 'there',
                emailType: 'seller-watch-new-listings',
                sellerWatch: {
                  sellerId,
                  sellerName: w.seller_name || currentSellerName,
                  marketplace,
                  newAsins: newAsins.slice(0, NEW_ASINS_IN_EMAIL),
                  totalNew: newAsins.length,
                },
              }),
            });
            if (!emailRes.ok) console.error(`[check-seller-watchlist] alert email send failed for watch ${w.id}`, await emailRes.text());
          } catch (e) {
            console.error(`[check-seller-watchlist] alert email send error for watch ${w.id}`, (e as Error).message);
          }
          patch.last_alert_at = nowIso;
          alertsFired++;
        }

        await admin.from('seller_watchlist').update(patch).eq('id', w.id);
      }
    }

    outcome = {
      ok: true,
      checked,
      alertsFired,
      processedSellers,
      lostBaselines,
      queuedSellers: orderedPairs.length,
      seeded,
      totalActive: totalActive ?? 0,
      imageBackfill,
      stoppedReason,
      elapsedMs: Date.now() - startedAt,
    };
    // `seeded` is the number that answers "did tonight do anything" when the
    // Done tab is still empty: a first check writes a baseline and no listing.
    return {
      items_processed: checked,
      detail: {
        checked, seeded, alertsFired, processedSellers, lostBaselines,
        queuedSellers: orderedPairs.length, stoppedReason,
      },
    };
  });
  clearTimeout(watchdog);

  if (lock.skipped) {
    return jsonResponse({ ok: true, skipped_locked: true, reason: 'a previous run is still in flight' });
  }
  if (lock.status === 'failed') {
    console.error('[check-seller-watchlist] error', lock.error);
    return jsonResponse({ error: lock.error || 'run failed' }, 500);
  }
  return jsonResponse(outcome, outcomeStatus);
});
