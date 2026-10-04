// Shared LWA access-token cache.
//
// Every function that talks to SP-API first trades a refresh token for an
// access token against api.amazon.com. Nothing cached that, so a single
// analyser panel load spent 0.9-1.2 s re-asking Amazon for a credential it had
// already issued: five to seven exchanges at ~175 ms warm, 520 ms on a cold TLS
// handshake (measured 2026-10-04).
//
// The in-memory memo in lwa-token.ts cannot help across functions -- five
// functions are five isolates. This one is backed by public.lwa_token_cache,
// which is service-role only, so every function shares one token per
// (client_id, refresh_token) pair for the hour it is valid.
//
// USAGE. The caller keeps its own exchange code and passes it in, so adopting
// the cache is a two-line change at each call site rather than a rewrite:
//
//   const token = await getCachedLwaToken(admin, {
//     clientId, refreshToken, region: 'NA', userId,
//     exchange: () => myExistingExchange(),      // returns {access_token, expires_in}
//   });
//
// FAILS OPEN. If the cache cannot be read or written -- missing table, RLS
// surprise, transient error -- the exchange still happens and the token is
// still returned. A caching layer must never be able to break the thing it was
// added to speed up.

interface ExchangeResult {
  access_token: string;
  expires_in?: number;
}

interface CacheArgs {
  clientId: string;
  refreshToken: string;
  region?: string;
  userId?: string | null;
  exchange: () => Promise<ExchangeResult>;
  /** Skip the read and force a fresh exchange. For the benchmark only. */
  forceRefresh?: boolean;
}

/** Identifies the pair a token belongs to, without storing either value. */
async function tokenKey(clientId: string, refreshToken: string, region: string): Promise<string> {
  const data = new TextEncoder().encode(`${clientId}:${refreshToken}:${region}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** How long before expiry a cached token stops being offered. */
const SAFETY_MARGIN_MS = 120_000;

export interface CachedTokenResult {
  token: string;
  fromCache: boolean;
  /** Milliseconds spent, for instrumentation. */
  ms: number;
}

export async function getCachedLwaTokenVerbose(
  supabase: any,
  args: CacheArgs,
): Promise<CachedTokenResult> {
  const started = Date.now();
  const region = args.region || 'NA';

  if (!args.clientId || !args.refreshToken) {
    // Nothing to key on: just exchange, and let the caller's own error handling
    // deal with whatever is missing.
    const fresh = await args.exchange();
    return { token: fresh.access_token, fromCache: false, ms: Date.now() - started };
  }

  const key = await tokenKey(args.clientId, args.refreshToken, region);

  if (!args.forceRefresh) {
    try {
      const { data } = await supabase
        .from('lwa_token_cache')
        .select('access_token, expires_at')
        .eq('token_key', key)
        .maybeSingle();
      if (data?.access_token && data?.expires_at) {
        const usableUntil = new Date(data.expires_at).getTime() - SAFETY_MARGIN_MS;
        if (usableUntil > Date.now()) {
          // Count the hit without blocking on it.
          supabase.rpc('increment_lwa_cache_hit', { p_key: key }).then(() => {}, () => {});
          return { token: data.access_token, fromCache: true, ms: Date.now() - started };
        }
      }
    } catch (e) {
      console.warn('[lwa-cache] read failed, exchanging instead:', (e as Error).message);
    }
  }

  const fresh = await args.exchange();
  const ttlSeconds = Number(fresh.expires_in) > 0 ? Number(fresh.expires_in) : 3600;

  try {
    await supabase.from('lwa_token_cache').upsert({
      token_key: key,
      user_id: args.userId ?? null,
      region,
      access_token: fresh.access_token,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token_key' });
  } catch (e) {
    console.warn('[lwa-cache] write failed, token still returned:', (e as Error).message);
  }

  return { token: fresh.access_token, fromCache: false, ms: Date.now() - started };
}

/** The common case: just give me a token. */
export async function getCachedLwaToken(supabase: any, args: CacheArgs): Promise<string> {
  const r = await getCachedLwaTokenVerbose(supabase, args);
  return r.token;
}
