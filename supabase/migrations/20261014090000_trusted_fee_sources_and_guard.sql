-- (b) Non-US fees from the writers that convert, and a guard so a bad one
-- cannot land again.
--
-- Which writers convert native -> USD before writing fba_fee_fixed:
--   fees_api       backfill-fee-cache -- "sends NATIVE currency, converts
--                  response back to USD before returning"
--   sp_api_live    calculate-roi -- converts, and SKIPS the upsert entirely
--                  when FX is unavailable rather than writing native
--   live_roi_floor  fixed 2026-10-14, now follows the same rule
--   live_verified   fixed 2026-10-14, same
-- Everything else (learned_history, from_cache, unknown, fees_api_fbm) either
-- predates the contract or has no currency handling at all.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A rate Amazon does not charge is never written again.
--
-- 45 pct is the real ceiling -- Amazon Device Accessories -- so the guard sits
-- above every legitimate category and still catches the 69.14 pct that
-- live_verified produced. It cannot catch a native-currency FEE, because no
-- constraint can tell a peso from a dollar; that is what the writer fixes are
-- for. This closes the half a constraint CAN close.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.asin_fee_cache_sanity()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.referral_rate IS NOT NULL AND NEW.referral_rate > 0.45 THEN
    RAISE WARNING 'asin_fee_cache: refusing referral_rate % for % / % from % (above any Amazon category)',
      NEW.referral_rate, NEW.asin, NEW.marketplace, COALESCE(NEW.fee_source, '?');
    NEW.referral_rate := NULL;
    NEW.last_error := format('referral_rate %s rejected by sanity guard', NEW.referral_rate);
  END IF;
  IF NEW.referral_rate IS NOT NULL AND NEW.referral_rate < 0 THEN
    NEW.referral_rate := NULL;
  END IF;
  IF NEW.fba_fee_fixed IS NOT NULL AND NEW.fba_fee_fixed < 0 THEN
    NEW.fba_fee_fixed := 0;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS asin_fee_cache_sanity_trg ON public.asin_fee_cache;
CREATE TRIGGER asin_fee_cache_sanity_trg
  BEFORE INSERT OR UPDATE ON public.asin_fee_cache
  FOR EACH ROW EXECUTE FUNCTION public.asin_fee_cache_sanity();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. get_asin_fba_fee_basis prefers a writer that converts.
--
-- It already preferred a BILLED fee over any quote. This adds the same idea one
-- level down: among quotes, take one from a writer whose currency handling is
-- known good, and fall back to the rest only when there is nothing better.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trusted_fee_source_rank(p_source text)
RETURNS int
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE lower(COALESCE(p_source, ''))
    WHEN 'fees_api'       THEN 1
    WHEN 'sp_api_live'    THEN 1
    WHEN 'live_roi_floor' THEN 2   -- fixed 2026-10-14; older rows may predate it
    WHEN 'live_verified'  THEN 2
    ELSE 3                          -- no currency handling established
  END;
$fn$;

COMMENT ON FUNCTION public.trusted_fee_source_rank(text) IS
  'Lower is better. 1 = writer proven to convert native->USD and to skip rather than write native when FX is missing. 2 = fixed on 2026-10-14, older rows may predate the fix. 3 = currency handling not established.';

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== non-US fee rows by trust rank, after the quarantine ==';
  FOR r IN
    SELECT marketplace AS mk, trusted_fee_source_rank(fee_source) AS rank,
           count(*) FILTER (WHERE fba_fee_fixed > 0) AS usable,
           count(*) AS rows
    FROM public.asin_fee_cache WHERE user_id = v_uid AND marketplace <> 'US'
    GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE '   % | rank % | % of % rows still carry a fee',
      rpad(r.mk, 4), r.rank, lpad(r.usable::text, 4), lpad(r.rows::text, 4);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does ANY usable non-US row still come from an untrusted writer? ==';
  FOR r IN
    SELECT marketplace AS mk, COALESCE(fee_source, '(null)') AS src, count(*) AS rows,
           round(avg(fba_fee_fixed)::numeric, 2) AS avg_fba
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND marketplace <> 'US' AND fba_fee_fixed > 0
      AND trusted_fee_source_rank(fee_source) = 3
    GROUP BY 1, 2 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % | % rows | avg $%  <- unverified currency handling',
      rpad(r.mk, 4), rpad(r.src, 22), lpad(r.rows::text, 4), r.avg_fba;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== guard check: any referral rate left above 45 pct, anywhere? ==';
  FOR r IN
    SELECT count(*) AS n FROM public.asin_fee_cache WHERE referral_rate > 0.45
  LOOP
    RAISE NOTICE '   % (want 0)', r.n;
  END LOOP;
END
$p$;
