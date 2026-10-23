-- Request 37601 (the January resync I gave up on) now HAS a response. It may
-- have landed AFTER I restored from backup, which would mean January has been
-- re-synced rather than merely restored. Find out before reporting anything.
DO $p$
DECLARE v_uid uuid; r record; v_status int; v_body text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT status_code, left(COALESCE(content,''),300) INTO v_status, v_body
  FROM net._http_response WHERE id = 37601;
  RAISE NOTICE '== 37601 (January resync): HTTP % | % ==', v_status, v_body;

  FOR r IN
    SELECT count(*) AS rows, round(sum(sales),2) AS sales,
           count(*) FILTER (WHERE event_type='adjustment') AS adj,
           count(adjustment_type) AS prov,
           round(sum(COALESCE(compensated_clawback,0)),2) AS claw,
           max(source) AS src_max, min(source) AS src_min
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date>='2026-01-01' AND event_date<'2026-02-01'
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '== January NOW ==';
    RAISE NOTICE '   % rows | sales % | % adjustment rows', r.rows, r.sales, r.adj;
    RAISE NOTICE '   provenance on % | clawback %', r.prov, r.claw;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== diff vs the January backup ==';
  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-01-01')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the January dry run (37863)? ==';
  IF EXISTS (SELECT 1 FROM net._http_response WHERE id = 37863) THEN
    SELECT status_code, left(COALESCE(content,''),900) INTO v_status, v_body
    FROM net._http_response WHERE id = 37863;
    RAISE NOTICE '   HTTP % | %', v_status, v_body;
  ELSE
    RAISE NOTICE '   still queued behind % cron requests',
      (SELECT count(*) FROM net.http_request_queue);
  END IF;
END
$p$;
