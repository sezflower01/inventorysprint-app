-- Reporting only. The fire step is wrapped so a busy pg_net queue is REPORTED
-- rather than failing the migration: the guard refusing is the correct
-- outcome, not an error, and a raised exception here blocks the whole
-- migration queue behind it.
DO $p$
DECLARE v_uid uuid; v_req bigint; v_ok boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_ok := public.repull_report(38095);
  v_ok := public.repull_report(38096);
  v_ok := public.repull_report(38097);
  RAISE NOTICE '';
  RAISE NOTICE '== DRY RUN: May ==';
  BEGIN
    v_req := public.repull_fire(v_uid, '2026-05-01', false);
  EXCEPTION WHEN others THEN
    RAISE NOTICE '   NOT FIRED: %', SQLERRM;
    RAISE NOTICE '   (the cron fleet is busy; retry in the next step)';
  END;
END
$p$;
