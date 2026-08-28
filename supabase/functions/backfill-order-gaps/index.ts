import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Automatic repair for order-placement gaps.
 *
 * `check_sync_parity` finds days where Financial Events has shipments but
 * sales_orders has no placement row (`gap_type = 'so_missing'`). The P&L banner
 * has surfaced those for a while with the note "Nothing repairs these gaps
 * automatically -- run this when you see one." This is that automation.
 *
 * ⚠️ WHY THE ATTEMPT CAP IS THE POINT, NOT A DETAIL
 * -------------------------------------------------
 * Some gaps are PERMANENT. If Amazon's Orders API never returned placement rows
 * for a day, re-asking will not conjure them. A human sees a repair fail twice
 * and stops clicking; a nightly job does not. Without a cap this would
 * re-attempt dead days every night forever, spending SP-API quota on a repair
 * that cannot succeed -- the same shape as the ghost-row loop found 2026-08-21,
 * which retried an impossible insert every 2.7 seconds for weeks.
 *
 * After MAX_ATTEMPTS the day is marked `permanent` and never retried.
 *
 * `permanent` does NOT mean hidden. The banner keeps showing these days,
 * reworded from "repair" to "confirmed unrepairable", and keeps a manual
 * override. Automation that quietly buried missing data would be the exact
 * failure this codebase keeps getting caught by.
 *
 * REPAIR IS BOUNDED BY DATE, NOT BY GAP COUNT
 * -------------------------------------------
 * sync-sales-orders takes a date RANGE, so N scattered gap days in one window
 * cost one call, not N. The range is capped at MAX_RANGE_DAYS so a wide spread
 * cannot turn into an unbounded Orders API sweep; anything wider is repaired
 * across successive nightly runs instead.
 */

// 60, not 30. The dry run on 2026-08-22 found 3 gaps where the banner showed 4:
// 2026-07-10 had already fallen outside a 30-day window. A day that ages out of
// the lookback is never repaired and never marked permanent -- it just sits in
// the banner forever while the job reports itself healthy. Widening costs
// nothing per run, because MAX_RANGE_DAYS bounds the Orders API work regardless;
// a larger backlog simply takes more nights to clear.
const LOOKBACK_DAYS   = 60;
// Hard ceiling for the `lookbackDays` override below. Amazon's Orders API will
// not serve arbitrarily old data anyway, and an unbounded value would let one
// call ask check_sync_parity to scan the entire order history.
const MAX_LOOKBACK_DAYS = 400;
const MAX_ATTEMPTS    = 3;   // then `permanent`
const MAX_RANGE_DAYS  = 14;  // per run, per user

interface ParityRow {
  check_date: string;
  marketplace: string;
  so_count: number;
  fec_count: number;
  gap_type: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') ?? '';

    const body = await req.json().catch(() => ({}));
    // dryRun reports what it WOULD do and writes nothing -- for verifying the
    // first live run without spending Orders API calls.
    const dryRun = body?.dryRun === true;
    // One-off deep catch-up, without touching what the nightly cron does.
    //
    // 60 days is right for the nightly run: it keeps the parity scan cheap and
    // covers anything recent. It also means a gap older than 60 days is
    // invisible FOREVER -- the job cannot see it, so it never repairs it and
    // never marks it permanent, while reporting itself healthy.
    //
    // Found live 2026-08-28: check_sync_parity over 240 days showed ~47 gap
    // days and roughly 1,300 missing orders, the worst in March and April
    // (2026-03-17 US: 10 orders recorded against 144 in Financial Events).
    // order_gap_repair_attempts held just 4 days, all from the 60-day window.
    // Every March and April gap was permanently out of reach.
    //
    // Raising the constant would make every nightly run rescan a year. An
    // override lets a human clear the backlog deliberately:
    //   { "lookbackDays": 240 }
    // MAX_RANGE_DAYS still bounds the Orders API work per run, so clearing a
    // large backlog takes several invocations rather than one heavy one.
    const requestedLookback = Number(body?.lookbackDays);
    const lookbackDays = Number.isFinite(requestedLookback) && requestedLookback > 0
      ? Math.min(Math.floor(requestedLookback), MAX_LOOKBACK_DAYS)
      : LOOKBACK_DAYS;

    // Only users who can actually call the Orders API. A user without a live
    // refresh token cannot be repaired, and counting attempts against them
    // would burn their cap on a condition that has nothing to do with the gap.
    const { data: auths, error: authErr } = await admin
      .from('seller_authorizations')
      .select('user_id')
      .not('refresh_token', 'is', null);
    if (authErr) return json({ error: authErr.message }, 500);

    const userIds = [...new Set((auths ?? []).map((a: { user_id: string }) => a.user_id))];
    const report: Array<Record<string, unknown>> = [];

    for (const userId of userIds) {
      const { data: parity, error: parityErr } = await admin
        .rpc('check_sync_parity', { p_user_id: userId, p_days: lookbackDays });
      if (parityErr) {
        report.push({ userId, error: `parity: ${parityErr.message}` });
        continue;
      }

      const gaps = ((parity ?? []) as ParityRow[]).filter((r) => r.gap_type === 'so_missing');
      if (!gaps.length) {
        report.push({ userId, gaps: 0, action: 'none' });
        continue;
      }

      // What we already know about these days.
      const { data: known } = await admin
        .from('order_gap_repair_attempts')
        .select('check_date, marketplace, attempts, status')
        .eq('user_id', userId)
        .in('check_date', gaps.map((g) => g.check_date));

      const knownBy = new Map<string, { attempts: number; status: string }>();
      for (const k of (known ?? []) as Array<{ check_date: string; marketplace: string; attempts: number; status: string }>) {
        knownBy.set(`${k.check_date}|${k.marketplace}`, { attempts: k.attempts, status: k.status });
      }

      // Repairable = not already settled as permanent or repaired, and under cap.
      const actionable = gaps.filter((g) => {
        const k = knownBy.get(`${g.check_date}|${g.marketplace}`);
        if (!k) return true;
        if (k.status === 'permanent' || k.status === 'repaired') return false;
        return k.attempts < MAX_ATTEMPTS;
      });

      // A gap still present at the cap is permanent. Recorded, never retried.
      const nowIso = new Date().toISOString();
      const toPermanent = gaps.filter((g) => {
        const k = knownBy.get(`${g.check_date}|${g.marketplace}`);
        return k && k.status === 'pending' && k.attempts >= MAX_ATTEMPTS;
      });
      if (toPermanent.length && !dryRun) {
        for (const g of toPermanent) {
          await admin.from('order_gap_repair_attempts')
            .update({ status: 'permanent', updated_at: nowIso,
                      last_result: `still missing after ${MAX_ATTEMPTS} attempts` })
            .eq('user_id', userId).eq('check_date', g.check_date).eq('marketplace', g.marketplace);
        }
      }

      if (!actionable.length) {
        report.push({
          userId, gaps: gaps.length, action: 'none',
          markedPermanent: toPermanent.length,
          note: 'all gaps are permanent, repaired, or at the attempt cap',
        });
        continue;
      }

      // One date range covers every actionable day -- N gaps, one Orders API
      // sweep. Capped so a wide spread cannot become an unbounded backfill.
      const dates = actionable.map((g) => g.check_date).sort();
      const start = dates[0];
      let end = dates[dates.length - 1];
      const spanDays = Math.round(
        (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
      ) + 1;
      let capped = false;
      if (spanDays > MAX_RANGE_DAYS) {
        const cappedEnd = new Date(start);
        cappedEnd.setDate(cappedEnd.getDate() + MAX_RANGE_DAYS - 1);
        end = cappedEnd.toISOString().slice(0, 10);
        capped = true;
      }
      const inRange = actionable.filter((g) => g.check_date >= start && g.check_date <= end);

      if (dryRun) {
        report.push({
          userId, gaps: gaps.length, wouldRepair: inRange.length,
          range: { start, end }, capped, markedPermanent: toPermanent.length, dryRun: true, lookbackDays,
        });
        continue;
      }

      // Count the attempt BEFORE the call, not after. A repair that times out
      // or crashes still consumed quota, and a cap that only counts clean
      // failures is not a cap.
      for (const g of inRange) {
        const prior = knownBy.get(`${g.check_date}|${g.marketplace}`);
        await admin.from('order_gap_repair_attempts').upsert({
          user_id: userId,
          check_date: g.check_date,
          marketplace: g.marketplace,
          attempts: (prior?.attempts ?? 0) + 1,
          status: 'pending',
          last_attempted_at: nowIso,
          so_count: g.so_count,
          fec_count: g.fec_count,
          updated_at: nowIso,
        }, { onConflict: 'user_id,check_date,marketplace' });
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-sales-orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Both: the gateway wants a bearer (sync-sales-orders keeps
          // verify_jwt=true for the browser), the function wants the secret.
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'x-internal-secret': internalSecret,
        },
        body: JSON.stringify({ startDate: start, endDate: end, include_orders: true }),
      });
      const repairOk = res.ok;
      const repairMsg = repairOk ? 'ok' : `sync-sales-orders ${res.status}`;

      // Re-check parity: the only proof that matters is the gap being gone.
      const { data: after } = await admin
        .rpc('check_sync_parity', { p_user_id: userId, p_days: lookbackDays });
      const stillMissing = new Set(
        ((after ?? []) as ParityRow[])
          .filter((r) => r.gap_type === 'so_missing')
          .map((r) => `${r.check_date}|${r.marketplace}`),
      );

      let repaired = 0;
      for (const g of inRange) {
        const key = `${g.check_date}|${g.marketplace}`;
        const gone = !stillMissing.has(key);
        if (gone) repaired++;
        await admin.from('order_gap_repair_attempts')
          .update({
            status: gone ? 'repaired' : 'pending',
            last_result: gone ? 'repaired' : repairMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId).eq('check_date', g.check_date).eq('marketplace', g.marketplace);
      }

      report.push({
        userId,
        gaps: gaps.length,
        attempted: inRange.length,
        repaired,
        stillOpen: inRange.length - repaired,
        markedPermanent: toPermanent.length,
        range: { start, end },
        capped,
        repairCall: repairMsg,
      });
    }

    console.log('[backfill-order-gaps]', JSON.stringify(report));
    return json({ ok: true, users: userIds.length, report, dryRun });
  } catch (e) {
    console.error('[backfill-order-gaps] failed', e);
    return json({ error: (e as Error).message }, 500);
  }
});
