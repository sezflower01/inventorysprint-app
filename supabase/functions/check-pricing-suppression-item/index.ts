// Per-item pricing-suppression check, called by pricing-suppression-worker
// to drain pricing_suppression_check_queue in small batches. Same detect /
// two-strike-clear logic as detect-pricing-suppressions (shared via
// _shared/pricing-suppression-core.ts), just scoped to ONE assignment per
// call instead of a user's whole catalog -- avoids the WORKER_RESOURCE_LIMIT
// crash a single large bulk invocation hit for accounts with 1,000+ SKUs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';
import { MARKETPLACES, getLwaAccessToken, checkAndUpdateSuppressionForItem } from '../_shared/pricing-suppression-core.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.user_id || '');
    const sku = String(body?.sku || '');
    const marketplaceCode = String(body?.marketplace || '');
    if (!userId || !sku || !marketplaceCode) {
      return new Response(JSON.stringify({ error: 'Missing user_id/sku/marketplace' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const mp = MARKETPLACES.find((m) => m.code === marketplaceCode);
    if (!mp) {
      return new Response(JSON.stringify({ error: `Unknown marketplace ${marketplaceCode}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: auth } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
      .eq('user_id', userId)
      .eq('marketplace_id', mp.id)
      .maybeSingle();
    if (!auth || auth.is_active === false || !auth.refresh_token) {
      return new Response(JSON.stringify({ error: `No active Amazon authorization for ${marketplaceCode}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const sellerId = auth.seller_id || auth.selling_partner_id;
    if (!sellerId) {
      return new Response(JSON.stringify({ error: 'Missing seller id' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: assignment } = await supabase
      .from('repricer_assignments')
      .select('id, sku, asin, marketplace, is_pricing_suppression, pricing_suppression_pending_clear_at, pricing_suppression_detected_at, pricing_suppression_raw_code, pricing_suppression_raw_message, pricing_suppression_categories, pricing_suppression_enforcement_actions, pricing_suppression_severity, is_listing_inactive_not_buyable, listing_inactive_detected_at, listing_inactive_reason_code, listing_inactive_reason_message')
      .eq('user_id', userId)
      .eq('sku', sku)
      .eq('marketplace', marketplaceCode)
      .maybeSingle();
    if (!assignment) {
      return new Response(JSON.stringify({ error: 'Assignment not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLwaAccessToken(auth.refresh_token);
    const runId = crypto.randomUUID();
    const result = await checkAndUpdateSuppressionForItem({
      supabase, userId, runId, accessToken, sellerId,
      marketplaceCode: mp.code, marketplaceId: mp.id, assignment,
    });

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[check-pricing-suppression-item] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
