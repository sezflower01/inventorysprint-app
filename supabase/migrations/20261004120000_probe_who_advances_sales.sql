-- READ-ONLY PROBE. "Live sales only update when I open the page."
--
-- Two completely different causes produce that sentence, and they live in
-- different layers:
--
--   (a) the PAGE is not refreshing itself in the background, so the numbers
--       exist but are not drawn until the tab is focused. This is what was
--       fixed twice -- the visibility catch-up read and the stalled-fetch
--       guard in MobileLiveSales.
--
--   (b) the DATA itself only advances when the page asks for it, because the
--       only thing calling the orders sync is the page. No amount of
--       client-side refreshing can fix that: there is nothing new to draw.
--
-- (b) would explain "it starts updating when I go to these pages" exactly, and
-- it would also explain why each fix felt right and then stopped working: the
-- page was the sync.
--
-- So: which crons exist for the sales path, and when were order rows actually
-- written?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== every cron job touching orders, sales or refunds ==';
  FOR r IN SELECT jobid, jobname, schedule, active,
                  substring(command from 'functions/v1/([a-z0-9-]+)') AS fn
           FROM cron.job
           WHERE command ~* '(live-orders|sales|order|refund|settlement)'
              OR jobname ~* '(sales|order|refund|settlement)'
           ORDER BY jobid LOOP
    RAISE NOTICE '  job % | % | % | active % | fn %',
      r.jobid, COALESCE(r.jobname, ''), r.schedule, r.active, COALESCE(r.fn, '');
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '  NONE. Nothing on a schedule syncs orders -- the page is the sync.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== when were order rows last WRITTEN (created_at), by hour ==';
  FOR r IN SELECT date_trunc('hour', created_at) AS hr, count(*) AS rows,
                  count(DISTINCT order_id) AS orders
           FROM public.sales_orders
           WHERE user_id = v_uid AND created_at > now() - interval '36 hours'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 24 LOOP
    RAISE NOTICE '  % | % rows | % orders', r.hr, r.rows, r.orders;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and when were they last UPDATED (enrichment etc.) ==';
  FOR r IN SELECT date_trunc('hour', updated_at) AS hr, count(*) AS rows
           FROM public.sales_orders
           WHERE user_id = v_uid AND updated_at > now() - interval '12 hours'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 12 LOOP
    RAISE NOTICE '  % | % rows touched', r.hr, r.rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cron_run_history for anything sales-shaped, last 6 h ==';
  FOR r IN SELECT job_name, status, count(*) AS runs, max(started_at) AS newest
           FROM public.cron_run_history
           WHERE started_at > now() - interval '6 hours'
             AND (job_name ~* '(sales|order|refund|settlement|live)')
           GROUP BY 1, 2 ORDER BY 4 DESC LOOP
    RAISE NOTICE '  % | % | % run(s) | newest %', r.job_name, r.status, r.runs, r.newest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no sales-shaped cron runs recorded in 6 h)'; END IF;
END
$p$;
