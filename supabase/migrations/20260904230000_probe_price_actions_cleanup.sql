-- Read-only: why does the nightly cleanup of repricer_price_actions time out
-- while every other table's succeeds?
SET statement_timeout TO '300s';
DO $$
DECLARE r RECORD; v_total bigint; v_old bigint; v_cut timestamptz;
BEGIN
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename='repricer_price_actions'
  LOOP
    RAISE NOTICE '  index: % = %', r.indexname, left(r.indexdef, 110);
  END LOOP;

  SELECT count(*) INTO v_total FROM public.repricer_price_actions;
  v_cut := now() - interval '14 days';
  SELECT count(*) INTO v_old FROM public.repricer_price_actions WHERE created_at < v_cut;
  RAISE NOTICE 'rows total=% | older than 14 days=% (the backlog to delete)', v_total, v_old;

  SELECT min(created_at), max(created_at) INTO r FROM public.repricer_price_actions;
  RAISE NOTICE 'created_at range: % .. %', r.min, r.max;

  -- What the nightly cron actually runs under.
  FOR r IN
    SELECT j.jobname, j.schedule, left(j.command, 90) AS cmd
    FROM cron.job j WHERE j.jobname ILIKE '%cleanup%' OR j.jobname ILIKE '%maintenance%'
  LOOP
    RAISE NOTICE '  cron % (%): %', r.jobname, r.schedule, r.cmd;
  END LOOP;
END $$;
