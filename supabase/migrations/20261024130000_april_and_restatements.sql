DO $p$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '============ APRIL ============';
  PERFORM public.repull_residual_explain(v_uid,'2026-04-01');
END
$p$;
