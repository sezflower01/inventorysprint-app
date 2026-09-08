-- PROBE (read-only): the extension analyser showed "Keepa budget busy -- retry
-- in ~2s. Data below is incomplete." on the Competitors panel.
--
-- What that message actually means, from the code:
--   mobile-scan-price-history is on the TOKEN-ONLY lane (no Layer 1 call gate),
--   so blockedBy is the token bucket, not the call rate. It costs 5 tokens per
--   view, claims with minReserve 0, and acquireKeepaSlotWithRetry already waits
--   once and retries. Both attempts failed, so the bucket was under 5 tokens
--   twice in a row.
--
-- So the panel is not broken and the plan is not too small in the abstract --
-- something else was spending at that moment. Find out what.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_cols text;
BEGIN
  RAISE NOTICE 'now: %', now();

  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'keepa_daily_usage';
  RAISE NOTICE 'keepa_daily_usage columns: %', COALESCE(v_cols, '(table absent)');

  RAISE NOTICE '';
  RAISE NOTICE '======== the shared budget row right now ========';
  BEGIN
    FOR r IN SELECT to_jsonb(t) AS j FROM public.keepa_daily_usage t
             ORDER BY 1 DESC LIMIT 4
    LOOP
      RAISE NOTICE '   %', left(r.j::text, 500);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (unreadable: %)', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== which crons that spend Keepa ran in the last hour ========';
  FOR r IN
    SELECT job_name, count(*) AS runs, max(started_at) AS latest,
           sum(COALESCE(items_processed,0)) AS items
    FROM public.cron_run_history
    WHERE started_at > now() - interval '1 hour'
      AND (job_name ILIKE '%watchlist%' OR job_name ILIKE '%storefront%'
        OR job_name ILIKE '%source%'   OR job_name ILIKE '%keepa%'
        OR job_name ILIKE '%price-alert%')
    GROUP BY 1 ORDER BY latest DESC
  LOOP
    RAISE NOTICE '   %  runs=% items=% latest=%',
      rpad(left(r.job_name,34),34), r.runs, r.items, r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== seller watchlist: how much work is queued? ========';
  BEGIN
    FOR r IN
      SELECT count(*) AS total,
             count(*) FILTER (WHERE is_active) AS active,
             count(*) FILTER (WHERE last_checked_at > now() - interval '1 hour') AS checked_1h
      FROM public.seller_watchlist
    LOOP
      RAISE NOTICE '   % sellers | % active | % checked in the last hour',
        r.total, r.active, r.checked_1h;
      RAISE NOTICE '   (each /seller?storefront=1 is a flat 10 tokens)';
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (seller_watchlist unreadable: %)', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '======== every cron that ran in the last 15 minutes ========';
  FOR r IN
    SELECT job_name, count(*) AS runs, max(started_at) AS latest
    FROM public.cron_run_history
    WHERE started_at > now() - interval '15 minutes'
    GROUP BY 1 ORDER BY latest DESC LIMIT 20
  LOOP
    RAISE NOTICE '   %  runs=% latest=%', rpad(left(r.job_name,34),34), r.runs, r.latest;
  END LOOP;
END
$probe$;
