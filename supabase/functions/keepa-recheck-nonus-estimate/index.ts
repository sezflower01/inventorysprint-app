// Manual "Recheck Keepa" for a non-US record's pending price estimate.
//
// WHY THIS EXISTS. Measured 2026-10-14 over 928 settled CA orders, mean
// ABSOLUTE error of each candidate estimate:
//
//   listings_api (live today)         476 covered   28.1%   bias -26.0%
//   Keepa buybox nearest the order    340 covered   14.4%   bias  +6.6%
//   last settled price, same ASIN     745 covered   10.0%   bias  +2.9%
//
// On the 340 orders Keepa covers it scores 14.4% against listings_api's
// 26.2% on those same orders. So a recheck is a real improvement over what
// the automatic path produces -- but last-settled-price beats Keepa on both
// accuracy and coverage, and Keepa adds only 45 orders last-settled does not
// already cover. That is why this is a per-record BUTTON the seller presses,
// not a cron. Do not promote it to automatic without re-running the replay.
//
// WHY IT CALLS ANOTHER EDGE FUNCTION INSTEAD OF KEEPA.
// mobile-scan-price-history already owns the Keepa path: the shared
// token-lane gate (acquireKeepaTokensOnly plus the repricer reserve),
// tokensLeft reporting, 429 recording, and the keepa_price_history_cache
// write. Calling Keepa directly from here would be a second ungated caller
// on an account-wide 20-tokens/min guard -- exactly the failure CLAUDE.md
// warns about, and exactly how the repricer gets starved. Reuse, never
// duplicate.
//
// That target keeps verify_jwt = true because the browser calls it too, so
// the user's own Authorization header is forwarded and it resolves the same
// user. No service-role key is needed and none is used.
//
// CURRENCY. estimated_price is contracted NATIVE marketplace currency for
// non-US rows, and Keepa returns native. No conversion happens here, and
// none must be added -- converting is how CA/MX/BR fee rows were broken
// before (see 20261014070000_quarantine_bad_fee_cache_rows.sql).
//
// THE LOCK IS NOT OPTIONAL. fetch-live-orders preserves locked_est_price
// verbatim on every later poll (index.ts ~3421) and otherwise recomputes
// estimated_price from listings_api. Writing estimated_price alone would be
// silently reverted on the next sync, so estimated_price, locked_est_price,
// locked_from and price_source are always written together.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// Keepa carries no Buy Box for every non-US listing, so fall back through
// the offer tracks in descending order of how well each stands in for what
// a buyer would actually have paid.
const TRACKS = ['buybox', 'newFba', 'newFbm'] as const;
type Track = typeof TRACKS[number];

interface Point { t: string; v: number }

/** Newest usable point across the tracks, in preference order. */
function pickPrice(series: Record<string, unknown>): { price: number; track: Track; at: string } | null {
  for (const track of TRACKS) {
    const pts = (series?.[track] as Point[] | undefined) || [];
    const usable = pts.filter((p) => Number.isFinite(Number(p?.v)) && Number(p.v) > 0);
    if (usable.length === 0) continue;
    const newest = usable.reduce((a, b) => (new Date(b.t) > new Date(a.t) ? b : a));
    return { price: Number(newest.v), track, at: newest.t };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader) return json({ error: 'Missing Authorization' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // User-scoped client: every read and write below runs as the caller, so
    // RLS applies and one seller can never touch another's orders.
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userRes, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userRes?.user) return json({ error: 'Unauthorized' }, 401);
    const userId = userRes.user.id;

    const body = await req.json().catch(() => ({}));
    const asin = String(body.asin || '').trim().toUpperCase();
    const marketplace = String(body.marketplace || '').trim().toUpperCase();
    const dryRun = body.dryRun === true;

    if (!asin) return json({ error: 'asin is required' }, 400);
    if (!marketplace) return json({ error: 'marketplace is required' }, 400);

    // US is deliberately refused. The US estimate chain has its own snapshot
    // and own-Buy-Box machinery anchored far closer to purchase time, so
    // Keepa would be a downgrade there, not an upgrade.
    if (marketplace === 'US') {
      return json({ error: 'US is not supported: this recheck is for non-US marketplaces only' }, 400);
    }

    // 1. Which pending orders would this touch?
    // Only rows genuinely awaiting a price: no settled sold_price, an
    // estimate currently standing in for it, not cancelled, not a refund.
    const { data: pending, error: pendErr } = await supabase
      .from('sales_orders')
      .select('id, order_id, asin, marketplace, quantity, estimated_price, price_source, locked_from, order_date')
      .eq('user_id', userId)
      .eq('asin', asin)
      .eq('marketplace', marketplace)
      .eq('is_cancelled', false)
      .or('sold_price.is.null,sold_price.eq.0')
      .not('order_id', 'like', '%-REFUND%')
      .order('order_date', { ascending: false });

    if (pendErr) return json({ error: `Could not read orders: ${pendErr.message}` }, 500);

    const targets = (pending || []).filter((o) => Number(o.estimated_price || 0) > 0);
    if (targets.length === 0) {
      return json({
        ok: true, applied: 0, asin, marketplace,
        message: `No pending ${marketplace} orders with an estimate for ${asin}.`,
      });
    }

    // 2. Recheck Keepa, through the gated owner of that path.
    // force: true bypasses the history cache -- which is the point of a
    // "recheck", and necessary in practice because nearly every non-US
    // cache row is expired anyway (CA 1 of 125 unexpired on 2026-10-14).
    const histRes = await fetch(`${supabaseUrl}/functions/v1/mobile-scan-price-history`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ asin, marketplace, range: '90', force: true }),
    });

    const hist = await histRes.json().catch(() => null);
    if (!histRes.ok || !hist || hist.error) {
      // A Keepa slot denial surfaces here as a degraded or failed payload.
      // Say so plainly rather than writing a guess.
      return json({
        error: hist?.error || `Keepa recheck failed (HTTP ${histRes.status})`,
        degraded_reason: hist?.degraded_reason ?? null,
      }, 502);
    }

    const picked = pickPrice(hist.series || {});
    if (!picked) {
      return json({
        ok: false, applied: 0, asin, marketplace,
        error: `Keepa returned no Buy Box or offer price for ${asin} on ${marketplace}.`,
        degraded: hist.degraded ?? false,
      });
    }

    const newEstimate = Math.round(picked.price * 100) / 100;

    if (dryRun) {
      return json({
        ok: true, dryRun: true, asin, marketplace,
        keepa: { price: newEstimate, track: picked.track, captured_at: picked.at, cached: hist.cached ?? false },
        would_update: targets.map((o) => ({
          order_id: o.order_id,
          old_estimate: Number(o.estimated_price || 0),
          new_estimate: newEstimate,
        })),
      });
    }

    // 3. Back up BEFORE writing.
    const { error: logErr } = await supabase.from('keepa_estimate_recheck_log').insert(
      targets.map((o) => ({
        user_id: userId,
        order_id: o.order_id,
        asin,
        marketplace,
        old_estimate: Number(o.estimated_price || 0),
        new_estimate: newEstimate,
        old_price_source: o.price_source ?? null,
        old_locked_from: o.locked_from ?? null,
        keepa_track: picked.track,
        keepa_point_at: picked.at,
      })),
    );
    // A failed backup aborts the write. An unrecoverable override is worse
    // than no override at all.
    if (logErr) return json({ error: `Backup failed, nothing was changed: ${logErr.message}` }, 500);

    // 4. Apply, with the lock so the next poll cannot revert it.
    const source = `keepa_buybox:manual:${picked.track}`;
    const results: Array<Record<string, unknown>> = [];
    for (const o of targets) {
      const { error: updErr } = await supabase
        .from('sales_orders')
        .update({
          estimated_price: newEstimate,
          locked_est_price: newEstimate,
          locked_from: source,
          price_source: source,
          price_confidence: 'ESTIMATE_KEEPA_MANUAL',
        })
        .eq('id', o.id)
        .eq('user_id', userId);

      results.push({
        order_id: o.order_id,
        old_estimate: Number(o.estimated_price || 0),
        new_estimate: newEstimate,
        ok: !updErr,
        error: updErr?.message ?? null,
      });
    }

    const applied = results.filter((r) => r.ok).length;

    return json({
      ok: true,
      asin,
      marketplace,
      applied,
      keepa: {
        price: newEstimate,
        track: picked.track,
        captured_at: picked.at,
        cached: hist.cached ?? false,
      },
      orders: results,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
