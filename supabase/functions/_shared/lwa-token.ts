// Shared LWA token exchanger.
// Prefers per-user stored LWA Client ID/Secret (from user_spapi_credentials, decrypted via
// get_spapi_credentials_decrypted) so that refresh tokens minted under the user's own
// Develop-Apps client work on EVERY marketplace (US/CA/MX/BR/EU/FE), not just the marketplace
// whose refresh token happens to match the global env LWA_CLIENT_ID/SECRET.
//
// Fallback order:
//   1. User-stored LWA app  (per-user, exact match for their refresh_token)
//   2. Env LWA_CLIENT_ID / LWA_CLIENT_SECRET  (preferred shared app)
//   3. Env SPAPI_LWA_CLIENT_ID / SPAPI_LWA_CLIENT_SECRET (legacy OAuth app)
// This matters because older marketplace authorizations may have been minted under the
// SPAPI_* app while newer code preferred LWA_* or user-stored app credentials.

// Cross-function token cache. Without it each isolate re-exchanges a token
// Amazon already issued -- ~175 ms warm, 520 ms on a cold TLS handshake, and
// an analyser panel load did five to seven of them.
import { getCachedLwaTokenVerbose } from './lwa-token-cache.ts';

/**
 * EVERY MEMO IN THIS FILE EXPIRES. It did not, and that turned a 10-minute
 * credential mistake into a 90-minute outage on 2026-10-02.
 *
 * The caches are per-isolate and were written once and trusted forever. So when
 * the stored credentials were briefly wrong, a warm isolate cached the bad app
 * (or cached `null`) and kept using it after the credentials had been corrected
 * -- and because the failure happens inside the token exchange, the symptom was
 * silence: the dispatch crons kept reporting success, no assignment recorded an
 * error, and the SP-API gate was simply never claimed. 85 minutes with nothing
 * to look at.
 *
 * A short TTL makes the system self-healing: fix the credentials and the next
 * minute's run picks them up. It costs one extra RPC per user per minute, which
 * is nothing next to an outage that can only be cleared by redeploying.
 */
const CRED_CACHE_TTL_MS = 60_000;
/**
 * Dead-source memos expire faster still. Their whole purpose is to avoid
 * re-attempting a source that cannot work for this (user, token) pair -- a
 * genuine app/token ownership mismatch, which is stable. But the same memo is
 * written when a credential is merely WRONG, which is temporary by nature, and
 * a permanent memo then outlives the fix.
 */
const DEAD_SOURCE_TTL_MS = 30_000;

const _userLwaCache = new Map<string, { app: { id: string; secret: string; refresh?: string | null } | null; at: number }>();
// Sticky per-(user, refreshToken) memo: once a source works, prefer it and skip the failing one.
// Also remembers sources that have already failed so they are not retried on every call.
const _winningSource = new Map<string, { source: string; at: number }>();
const _deadSources = new Map<string, Map<string, number>>();   // key -> source -> marked at

const _fresh = (at: number, ttl: number) => Date.now() - at < ttl;
const _sourceKey = (userId: string | null | undefined, refresh: string) => `${userId ?? 'anon'}::${refresh.slice(0, 24)}`;

async function getUserLwaApp(
  supabase: any,
  userId: string | null | undefined,
): Promise<{ id: string; secret: string; refresh?: string | null } | null> {
  if (!userId) return null;
  const cached = _userLwaCache.get(userId);
  if (cached && _fresh(cached.at, CRED_CACHE_TTL_MS)) return cached.app;
  try {
    const { data, error } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
    if (error) {
      console.warn('[lwa-token] decrypt RPC failed:', error.message);
      _userLwaCache.set(userId, { app: null, at: Date.now() });
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.lwa_client_id && row?.lwa_client_secret) {
      const app = {
        id: row.lwa_client_id as string,
        secret: row.lwa_client_secret as string,
        refresh: row.refresh_token as string | null,
      };
      _userLwaCache.set(userId, { app, at: Date.now() });
      return app;
    }
  } catch (e) {
    console.warn('[lwa-token] exception:', (e as Error).message);
  }
  _userLwaCache.set(userId, { app: null, at: Date.now() });
  return null;
}

export async function exchangeLwaToken(
  refreshToken: string,
  supabase?: any,
  userId?: string | null,
): Promise<string> {
  const candidates: Array<{ refresh: string; id: string; secret: string; source: string }> = [];
  const addCandidate = (refresh: string | null | undefined, id: string | null | undefined, secret: string | null | undefined, source: string) => {
    if (!refresh || !id || !secret) return;
    if (candidates.some(c => c.refresh === refresh && c.id === id && c.secret === secret)) return;
    candidates.push({ refresh, id, secret, source });
  };

  if (supabase && userId) {
    const app = await getUserLwaApp(supabase, userId);
    if (app) {
      addCandidate(refreshToken, app.id, app.secret, 'user_stored_auth_token');
      addCandidate(app.refresh, app.id, app.secret, 'user_stored_own_token');
    }
  }
  addCandidate(refreshToken, Deno.env.get('LWA_CLIENT_ID'), Deno.env.get('LWA_CLIENT_SECRET'), 'env_lwa_auth_token');
  addCandidate(refreshToken, Deno.env.get('SPAPI_LWA_CLIENT_ID'), Deno.env.get('SPAPI_LWA_CLIENT_SECRET'), 'env_spapi_lwa_auth_token');
  addCandidate(Deno.env.get('SPAPI_REFRESH_TOKEN'), Deno.env.get('SPAPI_LWA_CLIENT_ID'), Deno.env.get('SPAPI_LWA_CLIENT_SECRET'), 'env_spapi_default_token');

  if (candidates.length === 0) {
    throw new Error('LWA credentials not configured');
  }

  // Apply sticky memo: skip known-dead sources, prioritize known-winner.
  const memoKey = _sourceKey(userId, refreshToken);
  const deadMap = _deadSources.get(memoKey);
  const isDead = (src: string) => {
    const at = deadMap?.get(src);
    return at !== undefined && _fresh(at, DEAD_SOURCE_TTL_MS);
  };
  const winnerMemo = _winningSource.get(memoKey);
  const winner = winnerMemo && _fresh(winnerMemo.at, CRED_CACHE_TTL_MS) ? winnerMemo.source : null;
  let ordered = candidates.filter(c => !isDead(c.source));
  if (winner) {
    ordered.sort((a, b) => (a.source === winner ? -1 : b.source === winner ? 1 : 0));
  }
  if (ordered.length === 0) ordered = candidates; // safety net

  const doFetch = async (rt: string, cid: string, secret: string) => {
    return await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt,
        client_id: cid,
        client_secret: secret,
      }),
    });
  };

  const attemptedSources: string[] = [];
  let lastErrorText = '';
  for (const candidate of ordered) {
    attemptedSources.push(candidate.source);

    // Ask the shared cache first, for THIS candidate's exact (client, refresh)
    // pair. Keyed per pair on purpose: two marketplaces with different refresh
    // tokens, or two Develop-Apps clients, must never hand each other a token.
    //
    // Only attempted when a supabase client was passed. Callers that do not
    // supply one keep the previous behaviour exactly, so adopting the cache is
    // opt-in per call site rather than a flag day.
    if (supabase) {
      try {
        const cached = await getCachedLwaTokenVerbose(supabase, {
          clientId: candidate.id,
          refreshToken: candidate.refresh,
          userId: userId ?? null,
          exchange: async () => {
            const r = await doFetch(candidate.refresh, candidate.id, candidate.secret);
            if (!r.ok) throw new Error(await r.text().catch(() => `LWA ${r.status}`));
            return await r.json();
          },
        });
        _winningSource.set(memoKey, { source: candidate.source, at: Date.now() });
        _deadSources.get(memoKey)?.delete(candidate.source);
        return cached.token;
      } catch (e) {
        // Same decision the uncached path makes below: a rejected credential
        // means try the next source, anything else means stop rather than mask
        // a 429 or a 5xx by shopping around.
        lastErrorText = String((e as Error).message || e);
        if (lastErrorText.includes('unauthorized_client') || lastErrorText.includes('invalid_client')) {
          if (!_deadSources.has(memoKey)) _deadSources.set(memoKey, new Map());
          _deadSources.get(memoKey)!.set(candidate.source, Date.now());
          continue;
        }
        break;
      }
    }

    const resp = await doFetch(candidate.refresh, candidate.id, candidate.secret);
    if (resp.ok) {
      // Remember the winner so future calls skip the failing source silently.
      _winningSource.set(memoKey, { source: candidate.source, at: Date.now() });
      // A source that works clears its own tombstone, so a transient rejection
      // cannot keep shadowing a credential that has since been fixed.
      _deadSources.get(memoKey)?.delete(candidate.source);
      const json = await resp.json();
      return json.access_token as string;
    }

    lastErrorText = await resp.text().catch(() => '');
    // Only log on the very first time we see a failure for this (user, token, source).
    const wasKnownDead = isDead(candidate.source);
    if (!wasKnownDead) {
      // Downgrade to warn — we have a working fallback path.
      console.warn(`[lwa-token] source=${candidate.source} unauthorized for user=${userId ?? 'n/a'} (will skip on future calls): ${lastErrorText.slice(0, 200)}`);
    }

    // Try the next slot on EITHER credential rejection:
    //   unauthorized_client -> the client is fine but this refresh token was
    //                          not issued to it (app/token ownership mismatch);
    //   invalid_client      -> the client id + secret pair itself was rejected.
    //
    // invalid_client used to fall through to the `break` below, so the very
    // first rejected candidate ended the attempt and the other slots -- which
    // may well hold the right app -- were never tried. On 2026-10-02 that is
    // exactly what happened: LWA_* held one app's secret and SPAPI_* another's,
    // and a single invalid_client stopped the search instead of finding the
    // pairing that worked.
    if (lastErrorText.includes('unauthorized_client') || lastErrorText.includes('invalid_client')) {
      if (!_deadSources.has(memoKey)) _deadSources.set(memoKey, new Map());
      _deadSources.get(memoKey)!.set(candidate.source, Date.now());
      continue;
    }
    // Everything else (429, 5xx, malformed request) is NOT a credential
    // problem, so trying another app would only mask it.
    break;
  }

  throw new Error(`Failed to get access token (attempted=${attemptedSources.join('>') || 'none'}): ${lastErrorText.slice(0, 200)}`);
}
