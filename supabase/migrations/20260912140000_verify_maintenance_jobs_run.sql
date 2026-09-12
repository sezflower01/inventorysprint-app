-- Prove the two new jobs actually run, instead of finding out at 04:02 UTC.
--
-- Both are budgeted to return inside 100 seconds, well under the ~120s ceiling
-- documented in 20260906070000, so one call of each fits here.
--
-- Every call is wrapped so a failure is REPORTED rather than thrown: a
-- migration that aborts blocks every later migration in the queue until it is
-- neutered, and that is a worse outcome than a job that needs another look.
--
-- This does real work -- it deletes rows past retention and nulls payloads past
-- the 7-day cutoff -- but only work the schedule would do tonight anyway.

DO $verify$
DECLARE
  v jsonb;
  v_secs numeric;
  t0 timestamptz;
  r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  -- ── catch-up ──────────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '======== run_maintenance_catchup() ========';
  BEGIN
    t0 := clock_timestamp();
    SELECT public.run_maintenance_catchup() INTO v;
    v_secs := round(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::numeric, 1);
    RAISE NOTICE '  returned in % s, % rows deleted', v_secs, v ->> 'total_deleted';
    FOR r IN SELECT * FROM jsonb_array_elements(v -> 'results') AS e(j)
    LOOP
      RAISE NOTICE '    %', r.j;
    END LOOP;
    IF v_secs > 115 THEN
      RAISE WARNING '  took % s -- close to the ~120s ceiling', v_secs;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  FAILED: %', SQLERRM;
  END;

  -- ── payload prune ─────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '======== prune_maintenance_payloads() ========';
  BEGIN
    t0 := clock_timestamp();
    SELECT public.prune_maintenance_payloads() INTO v;
    v_secs := round(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::numeric, 1);
    RAISE NOTICE '  returned in % s, % rows nulled', v_secs, v ->> 'total_nulled';
    FOR r IN SELECT * FROM jsonb_array_elements(v -> 'results') AS e(j)
    LOOP
      RAISE NOTICE '    %', r.j;
    END LOOP;
    IF v_secs > 115 THEN
      RAISE WARNING '  took % s -- close to the ~120s ceiling', v_secs;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  FAILED: %', SQLERRM;
  END;

  -- ── what is left ──────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '======== remaining backlog ========';
  FOR r IN
    SELECT count(*) AS n
    FROM public.repricer_price_actions
    WHERE created_at < now() - interval '7 days'
      AND intelligence_factors IS NOT NULL
  LOOP
    RAISE NOTICE '  price actions still carrying a payload past 7 days: %', r.n;
  END LOOP;

  FOR r IN
    SELECT count(*) AS n FROM public.repricer_ai_decisions
    WHERE created_at < now() - interval '14 days'
  LOOP
    RAISE NOTICE '  ai decisions still past 14 days: %', r.n;
  END LOOP;

  FOR r IN
    SELECT round(EXTRACT(epoch FROM (now() - min(created_at))) / 86400.0, 1) AS days
    FROM public.repricer_price_actions
  LOOP
    RAISE NOTICE '  price actions window now: % days (retention 14)', r.days;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  NOTE: freed space is reusable but NOT returned to the disk.';
  RAISE NOTICE '  The database size will not fall until a VACUUM FULL, which';
  RAISE NOTICE '  stays manual and is worth running once the backlog is clear.';
END $verify$;
