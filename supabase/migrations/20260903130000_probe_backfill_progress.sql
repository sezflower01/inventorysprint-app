-- Read-only progress check on the catalogue brand backfill.
DO $$
DECLARE v_pending bigint; v_done bigint; v_brand bigint; v_miss bigint; r RECORD;
BEGIN
  SELECT count(*) FILTER (WHERE checked_at IS NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL AND brand IS NOT NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL AND brand IS NULL)
    INTO v_pending, v_done, v_brand, v_miss FROM public.asin_brand_cache;
  RAISE NOTICE 'pending=% checked=% (with brand=%, no brand=%)', v_pending, v_done, v_brand, v_miss;

  FOR r IN
    SELECT jobname, status, return_message, start_time
    FROM cron.job_run_details d JOIN cron.job j USING (jobid)
    WHERE j.jobname IN ('catalog-brand-backfill','seller-brand-catalog-rollup')
    ORDER BY start_time DESC LIMIT 5
  LOOP
    RAISE NOTICE '  % % % %', r.start_time, r.jobname, r.status, left(COALESCE(r.return_message,''), 60);
  END LOOP;

  FOR r IN
    SELECT status_code, left(content::text, 220) AS body
    FROM net._http_response WHERE created > now() - interval '20 minutes'
    ORDER BY id DESC LIMIT 3
  LOOP
    RAISE NOTICE '  HTTP % : %', r.status_code, r.body;
  END LOOP;
END $$;
