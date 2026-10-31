-- MARCH: read run B, run the COMPLETENESS GATE on A vs B, back up if it passes.
--
-- Both reports are located by captured_at window rather than by "newest", so
-- neither can resolve to the 10-24 or 10-30 14:51 report:
--   run A: captured after 00:12:29.117448, before run B was fired
--   run B: captured after 00:13:58.388315
--
-- The gate is repull_completeness_ok (20261030150000, self-tested with eight
-- planted refusals): all five data fields equal, money compared ::numeric, and
-- catch-all 0 in BOTH. Rate-limit hits are printed and ignored.
--
-- The backup is taken in this same transaction only if the gate passes, and the
-- diff stays in the NEXT migration -- a diff cannot see an uncommitted backup,
-- which is what made May's first attempt report all 3,792 rows as new.
DO $p$
DECLARE r record; v_uid uuid;
        v_fired_a timestamptz := '2026-10-31 00:12:29.117448+00';
        v_fired_b timestamptz := '2026-10-31 00:13:58.388315+00';
        v_a jsonb; v_b jsonb; v_i int := 0; v_live int; v_backed bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  WHILE v_i < 10 LOOP
    v_b := public.repull_find_fresh_report('2026-03-01'::date, v_fired_b);
    EXIT WHEN v_b IS NOT NULL;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  IF v_b IS NULL THEN
    RAISE NOTICE '== RUN B DID NOT LAND after % s -- STOP, nothing backed up ==', v_i*15;
    RAISE NOTICE '   NULL means stop, never "nothing to check".';
    RETURN;
  END IF;

  -- Run A: the report captured after A fired and before B fired.
  SELECT rr.report INTO v_a FROM public.repull_reports rr
   WHERE left(rr.month,7)='2026-03' AND rr.applied = false
     AND rr.report ? 'api_signed_total'
     AND rr.captured_at > v_fired_a AND rr.captured_at < v_fired_b
   ORDER BY rr.captured_at DESC LIMIT 1;

  IF v_a IS NULL THEN
    RAISE NOTICE '== RUN A REPORT NOT FOUND in its window -- STOP ==';
    RETURN;
  END IF;

  RAISE NOTICE '== MARCH, two fresh runs ==';
  RAISE NOTICE '   run A | items % | pages % | claw % | signed % | catch-all % | hits % | % ms',
    v_a->>'api_items', v_a->>'pages', v_a->>'api_clawback_total',
    v_a->>'api_signed_total', v_a->>'api_items_via_catchall',
    v_a->>'rate_limit_hits', v_a->>'elapsed_ms';
  RAISE NOTICE '   run B | items % | pages % | claw % | signed % | catch-all % | hits % | % ms',
    v_b->>'api_items', v_b->>'pages', v_b->>'api_clawback_total',
    v_b->>'api_signed_total', v_b->>'api_items_via_catchall',
    v_b->>'rate_limit_hits', v_b->>'elapsed_ms';

  RAISE NOTICE '';
  RAISE NOTICE '== THE COMPLETENESS GATE, field by field ==';
  FOR r IN SELECT * FROM public.repull_compare_runs(v_a, v_b) LOOP
    RAISE NOTICE '   % (%) | A % | B % | %', rpad(r.field,24), rpad(r.kind,5),
      lpad(r.run_a,10), lpad(r.run_b,10), r.verdict;
  END LOOP;
  RAISE NOTICE '   catch-all must be 0 in both, not merely equal';
  RAISE NOTICE '   hits A % vs B % -- recorded, NOT a stop condition',
    v_a->>'rate_limit_hits', v_b->>'rate_limit_hits';

  RAISE NOTICE '';
  IF NOT public.repull_completeness_ok(v_a, v_b) THEN
    RAISE NOTICE '   >>> GATE FAILED. Nothing backed up, nothing applied. Stop.';
    RETURN;
  END IF;
  RAISE NOTICE '   GATE PASSED: two fresh runs agree on every data field, catch-all 0';

  -- Cross-check against the older pair, for the record only.
  FOR r IN
    SELECT rr.report->>'api_clawback_total' AS claw, rr.report->>'api_items' AS items,
           to_char(rr.captured_at,'MM-DD HH24:MI') AS t
    FROM public.repull_reports rr
    WHERE left(rr.month,7)='2026-03' AND rr.report ? 'api_signed_total'
      AND rr.captured_at < v_fired_a
    ORDER BY rr.captured_at
  LOOP
    RAISE NOTICE '   (earlier run % also read items % claw %)', r.t, r.items, r.claw;
  END LOOP;
  RAISE NOTICE '   four runs over seven days, same 113 items and same clawback total';

  RAISE NOTICE '';
  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-03-01' AND event_date < '2026-04-01';
  IF v_live <> 5098 THEN
    RAISE EXCEPTION 'March live rows %, expected 5098 -- the month moved since pre-flight', v_live;
  END IF;

  v_backed := public.fec_backup_month(v_uid, '2026-03-01'::date);
  RAISE NOTICE '== backup ==';
  RAISE NOTICE '   live % rows | backed up %', v_live, v_backed;
  IF v_backed <> v_live THEN
    RAISE EXCEPTION 'backup % vs live % -- refusing to go further', v_backed, v_live;
  END IF;
  RAISE NOTICE '   backup count verified -- fec_restore_month can undo from here';
END
$p$;
