-- STAGE 2, MAY: pre-flight + fresh dry run. apply := false.
-- Recorded figures to match: 38 pages, 103 items, 0 rate-limit hits,
-- clawbacks -187.96, residual 0.00.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== MAY pre-flight ==';
  SELECT count(*) INTO v_n FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-05-01' AND event_date < '2026-06-01';
  RAISE NOTICE '   live rows in May (all event types): %', v_n;

  FOR r IN
    SELECT event_type, count(*) AS n FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date >= '2026-05-01' AND event_date < '2026-06-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % rows', rpad(r.event_type,14), lpad(r.n::text,5); END LOOP;

  SELECT count(*) INTO v_n FROM public.fec_repull_backup WHERE backup_month='2026-05-01';
  RAISE NOTICE '   existing May backup rows: % (0 = still to take)', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   the four non-adjustment fingerprints, BEFORE:';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-05-01') ORDER BY event_type
  LOOP RAISE NOTICE '      % | % rows | %', rpad(r.event_type,14), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  RAISE NOTICE '';
  SELECT count(*) INTO v_n FROM net.http_request_queue WHERE url LIKE '%repull-month-adjustments%';
  IF v_n > 0 THEN RAISE EXCEPTION 'a repull is already in flight'; END IF;

  v_req := public.repull_fire(v_uid, '2026-05-01'::date, false);
  RAISE NOTICE 'fired MAY dry run (apply=false), pg_net request %', v_req;
END
$p$;
