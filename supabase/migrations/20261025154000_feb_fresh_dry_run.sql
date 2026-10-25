-- STAGE 2, FEBRUARY: fresh dry run. apply := false. Nothing is written to
-- financial_events_cache.
--
-- February's existing report recorded 14 rate-limit hits, so its numbers are
-- not a safe basis for a replace. This is the clean re-measure.
DO $p$
DECLARE v_uid uuid; v_req bigint; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_n FROM net.http_request_queue
  WHERE url LIKE '%repull-month-adjustments%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'a repull call is already in flight -- refusing to fire a second';
  END IF;

  SELECT count(*) INTO v_n FROM public.repull_reports WHERE left(month,7)='2026-02';
  RAISE NOTICE 'February reports on file before this run: %', v_n;

  v_req := public.repull_fire(v_uid, '2026-02-01'::date, false);
  RAISE NOTICE 'fired FEBRUARY dry run (apply=false), pg_net request %', v_req;
END
$p$;
