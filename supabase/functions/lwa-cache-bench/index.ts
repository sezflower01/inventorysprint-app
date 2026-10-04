// lwa-cache-bench — measures what the shared token cache actually saves.
//
// Internal-only. It exists because "this should be faster" is not a number: the
// claim behind the cache is that an analyser panel load spent 0.9-1.2 s asking
// Amazon for a credential it had already issued, five to seven times. This
// measures both halves of that claim from inside Supabase's network, where the
// real calls run, rather than from a laptop.
//
// It runs the SAME code path the functions use: getCachedLwaTokenVerbose, once
// with forceRefresh to time a real exchange, then without, to time a cache hit.
// LWA token exchanges are not metered by Amazon, so the measurement costs
// nothing but a few hundred milliseconds.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';
import { getCachedLwaTokenVerbose } from '../_shared/lwa-token-cache.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET') || '';
  const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN') || '';

  if (!clientId || !clientSecret || !refreshToken) {
    return new Response(JSON.stringify({ error: 'LWA credentials not configured' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const exchange = async () => {
    const r = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!r.ok) throw new Error(`LWA ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return await r.json();
  };

  const uncached: number[] = [];
  const cached: number[] = [];
  const errors: string[] = [];
  const rounds = 3;

  for (let i = 0; i < rounds; i++) {
    try {
      const a = await getCachedLwaTokenVerbose(admin, {
        clientId, refreshToken, region: 'NA', exchange, forceRefresh: true,
      });
      uncached.push(a.ms);
    } catch (e) { errors.push(`exchange ${i}: ${(e as Error).message}`); }

    try {
      const b = await getCachedLwaTokenVerbose(admin, {
        clientId, refreshToken, region: 'NA', exchange,
      });
      // A hit is only a hit if it did not exchange; record it as such either way
      // so a silent miss cannot masquerade as a fast cache.
      if (b.fromCache) cached.push(b.ms);
      else errors.push(`round ${i}: expected a cache hit, got an exchange`);
    } catch (e) { errors.push(`cached ${i}: ${(e as Error).message}`); }
  }

  const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const uAvg = avg(uncached);
  const cAvg = avg(cached);

  return new Response(JSON.stringify({
    rounds,
    exchange_ms: uncached,
    exchange_avg_ms: uAvg,
    cache_hit_ms: cached,
    cache_hit_avg_ms: cAvg,
    saved_per_exchange_ms: (uAvg != null && cAvg != null) ? uAvg - cAvg : null,
    // What a panel load actually pays: fetch-listing-snapshot up to 3,
    // mobile-scan-price-history, asin-dimensions and
    // check-fba-listing-eligibility one each.
    panel_exchanges_before: 6,
    panel_saving_ms: (uAvg != null && cAvg != null) ? (uAvg - cAvg) * 6 : null,
    errors,
  }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
