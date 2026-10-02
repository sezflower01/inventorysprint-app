-- READ-ONLY PROBE + one real env-path call. "Fully recovered" needs more than
-- the repricer: the ~73 env-credential functions were never re-tested after the
-- fix, and an hour of failing calls can leave residue behind (assignments
-- disabled by auto-assign-bulk for looking broken, queues backed up).

DO $p$
DECLARE v_uid uuid; r record; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now is %', now();

  -- Fire the env-path test first so its answer is ready on the next read.
  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/bulk-live-verify',
    headers := v_headers,
    body := jsonb_build_object('user_id', v_uid, 'mode', 'revive_ghosts',
                               'dry_run', true, 'limit', 5, 'deep_limit', 0),
    timeout_milliseconds := 180000
  ) INTO v_req;
  RAISE NOTICE 'env-path re-test fired as net request % (read next)', v_req;

  RAISE NOTICE '';
  RAISE NOTICE '== residue: anything disabled or suspended during the outage window ==';
  FOR r IN SELECT COALESCE(auto_suspended_reason, last_disabled_reason, '(none)') AS reason,
                  count(*) AS n, max(COALESCE(auto_suspended_at, last_disabled_at)) AS newest
           FROM public.repricer_assignments
           WHERE user_id = v_uid
             AND COALESCE(auto_suspended_at, last_disabled_at) BETWEEN '2026-10-02 01:09:00+00' AND now()
           GROUP BY 1 ORDER BY 2 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % : % | newest %', left(r.reason, 110), r.n, r.newest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (nothing disabled or suspended in the window)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the 7 flagged by auto-assign-bulk: do they have stock? ==';
  FOR r IN SELECT a.asin, a.sku, a.is_enabled, a.last_disabled_reason,
                  i.listing_status, i.available, i.reserved
           FROM public.repricer_assignments a
           LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.asin = a.asin
           WHERE a.user_id = v_uid AND a.marketplace = 'US'
             AND a.last_disabled_at BETWEEN '2026-10-02 01:09:00+00' AND now()
           ORDER BY i.available DESC NULLS LAST LIMIT 12 LOOP
    RAISE NOTICE '  % / % | enabled % | % | stock %/% | %',
      r.asin, r.sku, r.is_enabled, COALESCE(r.listing_status, '(no inv)'),
      COALESCE(r.available, 0), COALESCE(r.reserved, 0), left(COALESCE(r.last_disabled_reason, ''), 60);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== other SP-API consumers: successful cron runs since recovery (02:42) ==';
  FOR r IN SELECT job_name, status, count(*) AS n, max(started_at) AS newest
           FROM public.cron_run_history
           WHERE started_at > '2026-10-02 02:42:00+00'
           GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 15 LOOP
    RAISE NOTICE '  % | % x% | newest %', r.job_name, r.status, r.n, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== queues: anything backed up? ==';
  FOR r IN SELECT 'inventory_refresh_queue' AS q, status, count(*) AS n
           FROM public.inventory_refresh_queue WHERE user_id = v_uid GROUP BY 1, 2
           UNION ALL
           SELECT 'pricing_suppression_check_queue', status, count(*)
           FROM public.pricing_suppression_check_queue WHERE user_id = v_uid GROUP BY 1, 2
           ORDER BY 1, 3 DESC LOOP
    RAISE NOTICE '  % | % : %', r.q, r.status, r.n;
  END LOOP;
END
$p$;
