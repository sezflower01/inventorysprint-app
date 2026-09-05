-- Run the nightly maintenance once, now, and prove repricer_price_actions
-- completes instead of timing out. Same retention it would apply tonight, so
-- this deletes nothing extra -- it just does it in batches.
SET statement_timeout TO '1800s';
DO $$
DECLARE v_before bigint; v_after bigint; r RECORD; v jsonb;
BEGIN
  SELECT count(*) INTO v_before FROM public.repricer_price_actions
   WHERE created_at < now() - interval '14 days';
  RAISE NOTICE 'backlog before: % rows past retention', v_before;

  v := public.run_nightly_maintenance();

  SELECT count(*) INTO v_after FROM public.repricer_price_actions
   WHERE created_at < now() - interval '14 days';
  RAISE NOTICE 'backlog after: % rows | total deleted this run: %',
    v_after, v ->> 'total_deleted';

  FOR r IN SELECT * FROM jsonb_array_elements(v -> 'results') e(x) LOOP
    RAISE NOTICE '  %', r.x::text;
  END LOOP;
END $$;
