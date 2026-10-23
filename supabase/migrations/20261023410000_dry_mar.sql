DO $p$
DECLARE v_uid uuid; v_req bigint; v_ok boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== February dry run ==';
  v_ok := public.repull_report(38095);
  RAISE NOTICE '';
  RAISE NOTICE '== DRY RUN: March ==';
  v_req := public.repull_fire(v_uid, '2026-03-01', false);
END
$p$;
