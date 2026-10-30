-- FEBRUARY: read run A under the freshness guard, then fire run B.
--
-- Separate migration because pg_net delivers nothing from an uncommitted
-- transaction -- run A's report cannot be read in the migration that fired it.
--
-- repull_find_fresh_report refuses any report not captured after the fire, so
-- run A cannot silently resolve to the 10-24 or 10-25 report. NULL means STOP.
DO $p$
DECLARE r record; v_uid uuid; v_fired_a timestamptz := '2026-10-30 15:35:05.705259+00';
        v_a jsonb; v_i int := 0; v_req bigint; v_fired_b timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  WHILE v_i < 10 LOOP
    v_a := public.repull_find_fresh_report('2026-02-01'::date, v_fired_a);
    EXIT WHEN v_a IS NOT NULL;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  IF v_a IS NULL THEN
    RAISE NOTICE '== RUN A DID NOT LAND after % s -- STOP, run B not fired ==', v_i*15;
    RAISE NOTICE '   Request 35812 fired at %. A missing pg_net response row is', v_fired_a;
    RAISE NOTICE '   not evidence of failure (the queue is pruned) -- re-read first.';
    FOR r IN
      SELECT id, to_char(created,'MM-DD HH24:MI:SS') AS t, status_code,
             left(COALESCE(content,'')::text,200) AS body
      FROM net._http_response WHERE created > v_fired_a - interval '5 minutes'
      ORDER BY created DESC LIMIT 5
    LOOP RAISE NOTICE '   pg_net % % % %', r.id, r.t, r.status_code,
           replace(r.body,'%','%%'); END LOOP;
    RETURN;
  END IF;

  RAISE NOTICE '== FEBRUARY RUN A landed after ~% s ==', v_i*15;
  RAISE NOTICE '   items % | pages % | claw % | signed % | catch-all % | hits % | % ms',
    v_a->>'api_items', v_a->>'pages', v_a->>'api_clawback_total',
    v_a->>'api_signed_total', v_a->>'api_items_via_catchall',
    v_a->>'rate_limit_hits', v_a->>'elapsed_ms';
  RAISE NOTICE '   (hits recorded only -- the gate is agreement with run B)';

  -- Nothing may be in flight when B is fired.
  SELECT count(*) INTO v_i FROM net.http_request_queue
   WHERE url LIKE '%repull-month-adjustments%';
  IF v_i > 0 THEN RAISE EXCEPTION 'a repull is still queued -- not firing run B'; END IF;

  v_fired_b := clock_timestamp();
  v_req := public.repull_fire(v_uid, '2026-02-01'::date, false);
  RAISE NOTICE '';
  RAISE NOTICE '   fired FEBRUARY DRY RUN B (apply=false)';
  RAISE NOTICE '   fired_at % | request %', v_fired_b, v_req;
END
$p$;
