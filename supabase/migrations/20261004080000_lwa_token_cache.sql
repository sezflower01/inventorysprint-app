-- Shared cache for Amazon LWA access tokens.
--
-- WHY. Every edge-function invocation trades the refresh token for an access
-- token against api.amazon.com, and nothing anywhere caches the result. A
-- single analyser panel load does five to seven of them:
--   fetch-listing-snapshot up to 3 (one per marketplace), mobile-scan-price-history,
--   asin-dimensions, check-fba-listing-eligibility one each.
-- Measured round trip to that endpoint: ~175 ms warm, 520 ms on a cold TLS
-- handshake. So 0.9-1.2 s of every panel load is spent asking Amazon for a
-- credential it already issued minutes earlier.
--
-- The in-memory memo in _shared/lwa-token.ts does not help here: five functions
-- are five isolates, and an isolate is recycled constantly.
--
-- Access tokens are valid one hour. Cached with a two-minute safety margin and
-- keyed by a hash of (client_id, refresh_token), because that pair is what the
-- token belongs to -- the same user with two apps, or two marketplaces with
-- different refresh tokens, must never share a token.
--
-- SECURITY. An access token is a bearer credential for SP-API, so:
--   * the key is a SHA-256 of the identifying pair, never the pair itself;
--   * no RLS policy grants anything to `authenticated` -- only the service role
--     reads or writes this, so a browser holding a user JWT cannot read tokens
--     even for its own account;
--   * rows expire and are pruned, so a leak window is an hour at worst.
-- The refresh tokens next door are encrypted with pgsodium because they are
-- long-lived; a one-hour bearer in a service-role-only table is a deliberately
-- different trade, taken for the latency it removes from every call.

CREATE TABLE IF NOT EXISTS public.lwa_token_cache (
  token_key    text PRIMARY KEY,
  user_id      uuid,
  region       text NOT NULL DEFAULT 'NA',
  access_token text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  hit_count    integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS lwa_token_cache_expiry_idx
  ON public.lwa_token_cache (expires_at);

ALTER TABLE public.lwa_token_cache ENABLE ROW LEVEL SECURITY;

-- No policies on purpose. RLS with zero policies denies everything except the
-- service role, which bypasses it. Stated explicitly so a future reader does
-- not "fix" the missing policy.
REVOKE ALL ON public.lwa_token_cache FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.lwa_token_cache IS
  'Shared LWA access-token cache, service-role only (RLS on, no policies, so authenticated cannot read it). Keyed by SHA-256 of client_id:refresh_token. Saves ~175 ms per avoided exchange; an analyser panel load previously did 5-7. Tokens are stored with a 2-minute safety margin inside their 1-hour validity.';

-- Keep the table small. An expired row is useless and a stale bearer should not
-- outlive its purpose by days.
CREATE OR REPLACE FUNCTION public.prune_lwa_token_cache()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE n integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.lwa_token_cache
    WHERE expires_at < now() - interval '10 minutes'
    RETURNING 1)
  SELECT count(*) INTO n FROM gone;
  RETURN n;
END
$fn$;

REVOKE ALL ON FUNCTION public.prune_lwa_token_cache() FROM PUBLIC, anon, authenticated;

DO $p$
BEGIN
  RAISE NOTICE 'lwa_token_cache ready (service-role only, no RLS policies by design)';
END
$p$;

-- Hit counter, called fire-and-forget by the cache helper so a cache hit never
-- waits on bookkeeping. SECURITY DEFINER because the table is service-role only
-- and this is the one write the helper makes without the service client.
CREATE OR REPLACE FUNCTION public.increment_lwa_cache_hit(p_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  UPDATE public.lwa_token_cache
  SET hit_count = hit_count + 1
  WHERE token_key = p_key;
$fn$;

REVOKE ALL ON FUNCTION public.increment_lwa_cache_hit(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_lwa_cache_hit(text) TO authenticated, service_role;
