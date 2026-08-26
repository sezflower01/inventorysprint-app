// Nightly per-user pricing-suppression detector.
// Reads enabled+rule-assigned SKUs, calls SP-API getListingsItem (includedData=summaries,issues),
// classifies pricing suppressions from Amazon's live payload shape (categories[] + enforcements.actions[]),
// and writes state onto repricer_assignments with a two-strike clear.
//
// Trust gate: only http_status===200 AND summaries[].length > 0 counts as a valid signal.
// Anything else -> action="skipped_untrusted", no writes to suppression columns.
//
// Pricing suppression = categories INCLUDES 'INVALID_PRICE' AND severity === 'ERROR'.
// Unknown/uncategorized = LISTING_SUPPRESSED + severity=ERROR + not fully explained by
// known-non-pricing buckets -> writes listing_issue_unknown_flagged for admin review.
//
// Two-strike clear: first clean read stages `pending_clear_at`; the SECOND consecutive
// clean read promotes `cleared_at`, flips is_pricing_suppression=false, and archives the
// episode into repricer_pricing_suppression_history.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { isInternalCaller } from '../_shared/require-internal.ts';
import { MARKETPLACES, getLwaAccessToken, checkAndUpdateSuppressionForItem } from '../_shared/pricing-suppression-core.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json().catch(() => ({}));

    // Auth: body.user_id is only trusted from an internal caller (the
    // detect-pricing-suppressions-all fan-out cron, verified via
    // x-internal-secret or service-role Bearer). Anyone else must be an
    // authenticated user acting on their own account — a prior version
    // trusted body.user_id unconditionally, letting any caller run
    // detection (and Amazon SP-API calls + repricer_assignments writes)
    // against an arbitrary user's account.
    let userId: string;
    if (body?.user_id && isInternalCaller(req)) {
      userId = String(body.user_id);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) throw new Error('Missing authorization');
      const jwt = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(jwt);
      if (!user) throw new Error('Unauthorized');
      userId = user.id;
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let totalChecked = 0, detected = 0, staged = 0, cleared = 0, skippedUntrusted = 0, unknownHits = 0;

    const { data: auths } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
      .eq('user_id', userId);
    const activeAuths = (auths || []).filter((a: any) => a.is_active !== false && a.refresh_token);

    // Run marketplaces concurrently so a slow/large US pass doesn't starve BR/CA/MX
    // before the edge-function wall-time budget expires.
    await Promise.all(MARKETPLACES.map(async (mp) => {
      const auth = activeAuths.find((a: any) => a.marketplace_id === mp.id);
      if (!auth) return;
      const sellerId = auth.seller_id || auth.selling_partner_id;
      if (!sellerId) return;

      // Normal detection needs is_enabled+rule_id (only actively-repriced SKUs
      // get NEW suppressions flagged). But a row ALREADY marked suppressed must
      // stay eligible for re-check regardless of enabled/rule_id state, or it
      // can never self-clear once disabled (e.g. the repricer paused it because
      // it was suppressed in the first place) -- confirmed live: this exact gap
      // was leaving fixed listings stuck showing as suppressed indefinitely.
      const { data: assignments } = await supabase
        .from('repricer_assignments')
        .select('id, sku, asin, marketplace, is_pricing_suppression, pricing_suppression_pending_clear_at, pricing_suppression_detected_at, pricing_suppression_raw_code, pricing_suppression_raw_message, pricing_suppression_categories, pricing_suppression_enforcement_actions, pricing_suppression_severity, is_listing_inactive_not_buyable, listing_inactive_detected_at, listing_inactive_reason_code, listing_inactive_reason_message')
        .eq('user_id', userId)
        .eq('marketplace', mp.code)
        .not('sku', 'is', null)
        .or('and(is_enabled.eq.true,rule_id.not.is.null),is_pricing_suppression.eq.true');

      const list = assignments || [];
      if (list.length === 0) return;

      let accessToken: string;
      try { accessToken = await getLwaAccessToken(auth.refresh_token); }
      catch (e: any) { console.error(`[LWA ${mp.code}]`, e?.message); return; }

      for (const a of list) {
        totalChecked++;
        const { action_taken, unknownFlagged } = await checkAndUpdateSuppressionForItem({
          supabase, userId, runId, accessToken, sellerId,
          marketplaceCode: mp.code, marketplaceId: mp.id, assignment: a,
        });
        if (action_taken === 'skipped_untrusted') skippedUntrusted++;
        else if (action_taken === 'detected' || action_taken === 'kept_suppressed') detected++;
        else if (action_taken === 'pending_clear') staged++;
        else if (action_taken === 'cleared') cleared++;
        if (unknownFlagged) unknownHits++;

        await sleep(220); // ~4.5 req/s throttle per marketplace (independent buckets)
      }
    }));

    return new Response(JSON.stringify({
      run_id: runId,
      user_id: userId,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      total_checked: totalChecked,
      detected,
      staged_pending_clear: staged,
      cleared,
      skipped_untrusted: skippedUntrusted,
      unknown_flagged: unknownHits,
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[detect-pricing-suppressions] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
