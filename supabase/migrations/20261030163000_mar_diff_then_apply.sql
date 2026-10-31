-- MARCH, final step: re-assert the gate, prove the backup, then apply.
--
-- The gate is checked AGAIN here, immediately before the fire, from the same
-- two run reports. Not ceremony: the backup was taken in the previous
-- transaction, so this is a different transaction and the condition that
-- authorised the backup has to still hold at the point of the write. A gate
-- evaluated once, several minutes and one commit earlier, is a gate evaluated
-- somewhere other than where it matters.
--
-- March's four runs across seven days all read 113 items and -182.54, with hit
-- counts of 14, 0, 0 and 1. The data has never moved; only the throttling has.
DO $p$
DECLARE r record; v_uid uuid;
        v_fired_a timestamptz := '2026-10-31 00:12:29.117448+00';
        v_fired_b timestamptz := '2026-10-31 00:13:58.388315+00';
        v_a jsonb; v_b jsonb; v_bk int; v_changed int; v_pairs int; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT rr.report INTO v_a FROM public.repull_reports rr
   WHERE left(rr.month,7)='2026-03' AND rr.applied = false
     AND rr.report ? 'api_signed_total'
     AND rr.captured_at > v_fired_a AND rr.captured_at < v_fired_b
   ORDER BY rr.captured_at DESC LIMIT 1;
  SELECT rr.report INTO v_b FROM public.repull_reports rr
   WHERE left(rr.month,7)='2026-03' AND rr.applied = false
     AND rr.report ? 'api_signed_total'
     AND rr.captured_at > v_fired_b
   ORDER BY rr.captured_at DESC LIMIT 1;

  RAISE NOTICE '== the gate, re-asserted at the point of the write ==';
  FOR r IN SELECT * FROM public.repull_compare_runs(v_a, v_b) LOOP
    RAISE NOTICE '   % | A % | B % | %', rpad(r.field,24),
      lpad(r.run_a,10), lpad(r.run_b,10), r.verdict;
  END LOOP;
  IF NOT public.repull_completeness_ok(v_a, v_b) THEN
    RAISE EXCEPTION 'completeness gate no longer passes -- NOT applying March';
  END IF;
  RAISE NOTICE '   GATE PASSED (hits A % / B % -- recorded only)',
    v_a->>'rate_limit_hits', v_b->>'rate_limit_hits';

  RAISE NOTICE '';
  SELECT count(*) INTO v_bk FROM public.fec_repull_backup WHERE backup_month='2026-03-01';
  RAISE NOTICE '== March backup on file: % rows ==', v_bk;
  IF v_bk <> 5098 THEN RAISE EXCEPTION 'backup is % rows, expected 5098', v_bk; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== diff by verdict (only non-unchanged counts as a difference) ==';
  SELECT count(*) INTO v_pairs FROM public.fec_diff_month(v_uid,'2026-03-01'::date);
  RAISE NOTICE '   pairs returned % against % rows -- %', v_pairs, v_bk,
    CASE WHEN v_pairs > v_bk THEN 'duplicate join keys already present'
         ELSE 'keys unique, pairing exact' END;
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-03-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  SELECT count(*) INTO v_changed FROM public.fec_diff_month(v_uid,'2026-03-01'::date)
  WHERE verdict <> 'unchanged';
  RAISE NOTICE '   differences: % (must be 0)', v_changed;
  IF v_changed <> 0 THEN
    RAISE EXCEPTION 'backup and live differ by % rows before any write -- stopping', v_changed;
  END IF;
  RAISE NOTICE '   backup verified as a true copy';

  RAISE NOTICE '';
  v_req := public.repull_fire(v_uid, '2026-03-01'::date, true);
  RAISE NOTICE '   FIRED APPLY for March, pg_net request %', v_req;
  RAISE NOTICE '   fired_at %', clock_timestamp();
END
$p$;
