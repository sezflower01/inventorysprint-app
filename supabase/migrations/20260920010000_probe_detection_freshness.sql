-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: most detections on the analyser page are dated 09/01, some 09/14 --
-- has detection stopped? Check (a) detections per day, (b) when watches were
-- last checked and how fast the rotation is, (c) the worker's own run history,
-- (d) how the blank title/image backfill has done overnight.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '== detections per day (last 21 days) ==';
  FOR r IN SELECT detected_at::date AS d, count(*) AS n, count(DISTINCT seller_id) AS sellers
           FROM public.seller_watch_new_listings
           WHERE detected_at > now() - interval '21 days' GROUP BY 1 ORDER BY 1 DESC LOOP
    RAISE NOTICE '  % : % detections from % sellers', r.d, r.n, r.sellers;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== watches: when last checked ==';
  FOR r IN SELECT count(*) AS watches,
                  count(*) FILTER (WHERE status = 'active') AS active,
                  count(*) FILTER (WHERE last_checked_at IS NULL) AS never,
                  count(*) FILTER (WHERE last_checked_at > now() - interval '1 day') AS within_1d,
                  count(*) FILTER (WHERE last_checked_at > now() - interval '3 days') AS within_3d,
                  count(*) FILTER (WHERE last_checked_at > now() - interval '7 days') AS within_7d,
                  min(last_checked_at) AS oldest_check, max(last_checked_at) AS newest_check
           FROM public.seller_watchlist WHERE status <> 'cancelled' LOOP
    RAISE NOTICE '  % watches (% active) | never checked % | <=1d % | <=3d % | <=7d %', r.watches, r.active, r.never, r.within_1d, r.within_3d, r.within_7d;
    RAISE NOTICE '  oldest last_checked_at % | newest %', r.oldest_check, r.newest_check;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== check-seller-watchlist runs (last 24h) ==';
  FOR r IN SELECT count(*) AS runs, min(started_at) AS first, max(started_at) AS last,
                  count(*) FILTER (WHERE status = 'success') AS ok, count(*) FILTER (WHERE status <> 'success') AS not_ok
           FROM public.cron_run_history
           WHERE job_name ILIKE '%seller-watchlist%' AND started_at > now() - interval '24 hours' LOOP
    RAISE NOTICE '  % runs, % ok, % not ok, % .. %', r.runs, r.ok, r.not_ok, r.first, r.last;
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '== pg_cron jobs touching the watchlist ==';
  FOR r IN SELECT j.jobid, j.jobname, j.schedule, j.active,
                  (SELECT max(start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_run,
                  (SELECT count(*) FROM cron.job_run_details d WHERE d.jobid = j.jobid AND d.start_time > now() - interval '24 hours') AS runs_24h
           FROM cron.job j WHERE j.command ILIKE '%seller-watchlist%' OR j.jobname ILIKE '%watchlist%' LOOP
    RAISE NOTICE '  #% % (%) active=% | last run % | % runs in 24h', r.jobid, r.jobname, r.schedule, r.active, r.last_run, r.runs_24h;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what the "To review" tab actually shows ==';
  -- The tab loads unsourced/sourcing rows ordered by my_brand_asins DESC
  -- first (when "my brands only" is on), THEN by date -- so a strong seller's
  -- older rows outrank today's detections.
  FOR r IN WITH top AS (
             SELECT detected_at, my_brand_asins FROM public.seller_new_listings_branded
             WHERE source_status IN ('unsourced','sourcing') AND brand_match_state = 'matched'
             ORDER BY my_brand_asins DESC NULLS LAST, detected_at DESC LIMIT 1000)
           SELECT detected_at::date AS d, count(*) AS n, max(my_brand_asins) AS top_brand_asins
           FROM top GROUP BY 1 ORDER BY 2 DESC LIMIT 8 LOOP
    RAISE NOTICE '  brand-sorted first 1000: % -> % rows (my_brand_asins up to %)', r.d, r.n, r.top_brand_asins;
  END LOOP;
  FOR r IN WITH top AS (
             SELECT detected_at FROM public.seller_new_listings_branded
             WHERE source_status IN ('unsourced','sourcing') AND brand_match_state = 'matched'
             ORDER BY detected_at DESC LIMIT 1000)
           SELECT detected_at::date AS d, count(*) AS n FROM top GROUP BY 1 ORDER BY 1 DESC LIMIT 6 LOOP
    RAISE NOTICE '  date-sorted first 1000: % -> % rows', r.d, r.n;
  END LOOP;
  FOR r IN SELECT count(*) AS queued,
                  count(*) FILTER (WHERE detected_at > now() - interval '2 days') AS last_2d,
                  count(*) FILTER (WHERE detected_at < now() - interval '30 days') AS older_than_window
           FROM public.seller_watch_new_listings WHERE source_status IN ('unsourced','sourcing') AND brand_match_state = 'matched' LOOP
    RAISE NOTICE '  queued total % | detected in last 2 days % | older than the 30-day review window %', r.queued, r.last_2d, r.older_than_window;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== blank title/image backfill since last night ==';
  FOR r IN SELECT count(*) AS total,
                  count(*) FILTER (WHERE title IS NULL) AS no_title,
                  count(*) FILTER (WHERE image_url IS NULL) AS no_image,
                  count(*) FILTER (WHERE details_checked_at IS NOT NULL) AS tried
           FROM public.seller_watch_new_listings LOOP
    RAISE NOTICE '  rows % | no title % | no image % | tried %', r.total, r.no_title, r.no_image, r.tried;
  END LOOP;
END
$p$;
