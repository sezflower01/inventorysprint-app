-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Third read of inventory_valuation_summary: has the 10-minute cron recomputed
-- it with the deployed COG precedence yet?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE '';
  FOR r IN
    SELECT value, units, skus, computed_at,
           round(EXTRACT(EPOCH FROM (now() - computed_at))/60.0, 1) AS age_min
    FROM public.inventory_valuation_summary WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  stored value: %   units: %   skus: %', round(r.value::numeric, 2), r.units, r.skus;
    RAISE NOTICE '  computed_at : %  (% min ago)', r.computed_at, r.age_min;
    IF r.value > 59900 AND r.value < 60050 THEN
      RAISE NOTICE '  -> NEW COG-based total. Deployed function is live and correct.';
    ELSIF r.value > 59200 AND r.value < 59300 THEN
      RAISE NOTICE '  -> still the OLD total.';
    ELSE
      RAISE NOTICE '  -> unexpected; investigate.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '  -- recent runs of the refresh cron --';
  FOR r IN
    SELECT j.jobname, d.status, d.start_time, d.end_time,
           left(COALESCE(d.return_message, ''), 120) AS msg
    FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.jobname = 'inventory-valuation-summary-refresh-10min'
    ORDER BY d.start_time DESC LIMIT 4
  LOOP
    RAISE NOTICE '    % % start=% msg=%', r.jobname, r.status, r.start_time, r.msg;
  END LOOP;
END
$p$;
