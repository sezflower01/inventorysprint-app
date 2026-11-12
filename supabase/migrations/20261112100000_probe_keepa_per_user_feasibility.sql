-- Could Keepa quota be tracked PER USER KEY as things stand? READ ONLY.
--
-- The proposal is that each new user supplies their own Keepa API key, so the
-- cost and the quota sit with them instead of the account owner. That is the
-- right instinct, but it only works if the shared gate can tell two keys
-- apart. Today Layer 1 claims ONE row in keepa_daily_usage.last_called_at and
-- Layer 2 reads/writes a single keepa_token_budget via
-- observe_keepa_tokens(p_tokens_left) -- neither takes a user or a key.
--
-- If that is so, two things break the moment a second key exists:
--   * users throttle each other although their quotas are separate, and
--   * reportKeepaTokensLeft overwrites the ONE budget row with whichever key
--     answered last, and repricer-sp-api-pricing then gates live repricing on
--     a stranger's token balance.
--
-- Print the actual columns and row counts rather than trusting the reading.

DO $p$
DECLARE r record; n bigint;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY['keepa_daily_usage','keepa_token_budget']) AS t
  LOOP
    RAISE NOTICE '=== % ===', r.t;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name=r.t) THEN
      RAISE NOTICE '  (table does not exist)';
      CONTINUE;
    END IF;
    FOR n IN EXECUTE format('SELECT COUNT(*) FROM public.%I', r.t) LOOP
      RAISE NOTICE '  rows: %', n;
    END LOOP;
    FOR r IN
      SELECT column_name AS c, data_type AS d
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=r.t
      ORDER BY ordinal_position
    LOOP
      RAISE NOTICE '  col % %', rpad(r.c,26), r.d;
    END LOOP;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== observe_keepa_tokens signature (does it take a user/key?) ===';
  FOR r IN
    SELECT p.proname AS fn, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname='public' AND p.proname IN ('observe_keepa_tokens','claim_keepa_tokens')
    ORDER BY 1
  LOOP
    RAISE NOTICE '%(%)', r.fn, r.args;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== any table that could already hold a per-user API key ===';
  FOR r IN
    SELECT table_name AS t, column_name AS c
    FROM information_schema.columns
    WHERE table_schema='public'
      AND (column_name ILIKE '%api_key%' OR column_name ILIKE '%keepa%key%')
    ORDER BY 1,2
  LOOP
    RAISE NOTICE 'candidate %.%', r.t, r.c;
  END LOOP;
  RAISE NOTICE '(no candidate lines = there is nowhere to put a user key today)';
END $p$;
