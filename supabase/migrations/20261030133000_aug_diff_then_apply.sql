-- AUGUST, step 2 of 2: prove the committed backup matches live, then apply.
--
-- The correct predicate: fec_diff_month returns EVERY key with a verdict,
-- INCLUDING 'unchanged'. Only rows whose verdict is not 'unchanged' are
-- differences. Counting all rows -- which the first May attempt did -- can never
-- be zero and misreads a healthy backup as a total mismatch, which is what
-- stopped that run on bad evidence.
DO $p$
DECLARE r record; v_uid uuid; v_bk int; v_changed int; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_bk FROM public.fec_repull_backup WHERE backup_month='2026-08-01';
  RAISE NOTICE '== August backup on file: % rows ==', v_bk;
  IF v_bk <> 4817 THEN RAISE EXCEPTION 'backup is % rows, expected 4817', v_bk; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== diff by verdict (only non-unchanged counts as a difference) ==';
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-08-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  SELECT count(*) INTO v_changed FROM public.fec_diff_month(v_uid,'2026-08-01'::date)
  WHERE verdict <> 'unchanged';
  RAISE NOTICE '   differences: % (must be 0)', v_changed;
  IF v_changed <> 0 THEN
    RAISE EXCEPTION 'backup and live differ by % rows before any write -- stopping', v_changed;
  END IF;
  RAISE NOTICE '   backup verified as a true copy';

  RAISE NOTICE '';
  v_req := public.repull_fire(v_uid, '2026-08-01'::date, true);
  RAISE NOTICE '   FIRED APPLY for August, pg_net request %', v_req;
  RAISE NOTICE '   fired_at %', clock_timestamp();
END
$p$;
