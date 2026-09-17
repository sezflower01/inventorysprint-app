-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The analyser panel is getting Keepa 429 with tokensLeft -44 (plan refills
-- 25/min). No price history, no graph, seller IDs instead of names. The gate
-- (claim_keepa_tokens) keeps one budget row and no per-caller log, so find the
-- spenders from the schedules and recent runs of every Keepa-calling job.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT to_jsonb(b) AS j FROM public.keepa_token_budget b LOOP
    RAISE NOTICE 'keepa_token_budget: %', r.j;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== active cron jobs calling Keepa-spending functions ========';
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule,
           substring(j.command from 'functions/v1/([a-z0-9-]+)') AS fn,
           (SELECT count(*) FROM cron.job_run_details d WHERE d.jobid = j.jobid AND d.start_time > now() - interval '1 hour') AS runs_1h
    FROM cron.job j
    WHERE j.active
      AND j.command ~ 'functions/v1/(check-seller-watchlist|find-source-candidates|auto-source-new-listings|seller-storefront-snapshot|repricer-sp-api-pricing|mobile-scan-price-history|classify-listing-brands|keepa[a-z0-9-]*|[a-z0-9-]*keepa[a-z0-9-]*|seller-[a-z0-9-]+|brand-[a-z0-9-]+)'
    ORDER BY fn
  LOOP
    RAISE NOTICE '  #% % [%] -> % | runs in last hour: %', r.jobid, r.jobname, r.schedule, r.fn, r.runs_1h;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== recent pg_net responses mentioning Keepa tokens ========';
  FOR r IN SELECT created, left(regexp_replace(content, '\s+', ' ', 'g'), 260) AS head
           FROM net._http_response
           WHERE created > now() - interval '30 minutes'
             AND (content ILIKE '%keepa%' OR content ILIKE '%tokensLeft%' OR content ILIKE '%token-budget%' OR content ILIKE '%queuedSellers%')
           ORDER BY created DESC LIMIT 12 LOOP
    RAISE NOTICE '  % | %', to_char(r.created, 'HH24:MI:SS'), r.head;
  END LOOP;
END
$p$;
