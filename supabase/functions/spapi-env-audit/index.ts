// spapi-env-audit — which LWA app is each credential slot actually on?
//
// WHY THIS EXISTS
//
// SP-API credentials live in this project under FOUR env names plus an
// encrypted per-user row, and different functions read them in different
// precedence order:
//
//   most functions        LWA_CLIENT_ID       || SPAPI_LWA_CLIENT_ID
//   exchange-amazon-code  SPAPI_LWA_CLIENT_ID || LWA_CLIENT_ID     <-- reversed
//   _shared/lwa-token     user_spapi_credentials, then LWA_*, then SPAPI_*
//
// On 2026-10-02 a seller rotated the secret of the WRONG Seller Central app
// (client id ending f01d instead of 15f6) and pasted it into several of those
// slots. Every symptom was a variation of the same opaque pair rejection --
// "Client authentication failed" / invalid_client from some functions,
// unauthorized_client from others, invalid_grant from the OAuth exchange --
// and because a Supabase secret cannot be read back, there was no way to see
// which slot held which app. The outage ran over an hour on guesswork.
//
// This answers it directly, and it is deliberately built so that answering
// costs nothing in secrecy:
//   * client IDs are not secrets, so their last 4 characters are returned;
//   * secrets are NEVER returned -- only their length and a SHA-256 prefix,
//     which is enough to say "these two slots hold the same value" or "they
//     differ" without revealing either;
//   * every (id, secret) combination is tried against Amazon's
//     client_credentials grant, which validates a pair on its own without a
//     refresh token, so the reply says which pairing actually works.
//
// Internal-only: it reports credential metadata, so it must never be callable
// from a browser.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

/** Enough to compare two values for equality, not enough to reconstruct either. */
async function fingerprint(v: string | null | undefined): Promise<string> {
  if (!v) return 'absent';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `len=${v.length} sha=${hex.slice(0, 10)}`;
}

/** Does Amazon accept this pair on its own? No refresh token involved. */
async function testPair(clientId: string, clientSecret: string): Promise<string> {
  try {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'sellingpartnerapi::notifications',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.access_token) return 'ACCEPTED';
    return `REJECTED ${res.status} ${body?.error || ''} ${body?.error_description || ''}`.trim();
  } catch (e) {
    return `ERROR ${(e as Error).message}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const userId = String(body?.user_id || '');

  const slots: Record<string, string | null> = {
    LWA_CLIENT_ID: Deno.env.get('LWA_CLIENT_ID') ?? null,
    SPAPI_LWA_CLIENT_ID: Deno.env.get('SPAPI_LWA_CLIENT_ID') ?? null,
    LWA_CLIENT_SECRET: Deno.env.get('LWA_CLIENT_SECRET') ?? null,
    SPAPI_LWA_CLIENT_SECRET: Deno.env.get('SPAPI_LWA_CLIENT_SECRET') ?? null,
    SPAPI_LWA_APP_ID: Deno.env.get('SPAPI_LWA_APP_ID') ?? null,
    SPAPI_REFRESH_TOKEN: Deno.env.get('SPAPI_REFRESH_TOKEN') ?? null,
  };

  const report: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(slots)) {
    const isId = name.endsWith('CLIENT_ID') || name.endsWith('APP_ID');
    report[name] = {
      present: !!value,
      // A client id is public information; a secret or refresh token is not, so
      // only the fingerprint is reported for those.
      ...(isId ? { last4: value ? value.slice(-4) : null } : {}),
      fingerprint: await fingerprint(value),
    };
  }

  // The per-user encrypted row, for the other half of the split.
  let stored: Record<string, unknown> = { present: false };
  if (userId) {
    try {
      const admin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const { data } = await admin.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.lwa_client_id) {
        stored = {
          present: true,
          client_id_last4: String(row.lwa_client_id).slice(-4),
          client_id_fingerprint: await fingerprint(row.lwa_client_id),
          secret_fingerprint: await fingerprint(row.lwa_client_secret),
          refresh_fingerprint: await fingerprint(row.refresh_token),
        };
      }
    } catch (e) {
      stored = { present: false, error: (e as Error).message };
    }
  }

  // Every pairing, tested against Amazon. This is the part that ends the
  // guessing: a slot can look plausible and still belong to another app.
  const ids: Array<[string, string | null]> = [
    ['LWA_CLIENT_ID', slots.LWA_CLIENT_ID],
    ['SPAPI_LWA_CLIENT_ID', slots.SPAPI_LWA_CLIENT_ID],
  ];
  const secrets: Array<[string, string | null]> = [
    ['LWA_CLIENT_SECRET', slots.LWA_CLIENT_SECRET],
    ['SPAPI_LWA_CLIENT_SECRET', slots.SPAPI_LWA_CLIENT_SECRET],
  ];

  const pairs: Array<Record<string, string>> = [];
  for (const [idName, idVal] of ids) {
    for (const [secName, secVal] of secrets) {
      if (!idVal || !secVal) {
        pairs.push({ pair: `${idName} + ${secName}`, result: 'SKIPPED (one side absent)' });
        continue;
      }
      pairs.push({ pair: `${idName} + ${secName}`, result: await testPair(idVal, secVal) });
    }
  }

  if ((stored as any).present && userId) {
    try {
      const admin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const { data } = await admin.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.lwa_client_id && row?.lwa_client_secret) {
        pairs.push({
          pair: 'stored admin-page id + stored admin-page secret',
          result: await testPair(row.lwa_client_id, row.lwa_client_secret),
        });
      }
    } catch { /* already reported above */ }
  }

  return new Response(JSON.stringify({ slots: report, stored, pairs }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
