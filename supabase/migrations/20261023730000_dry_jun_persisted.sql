-- June again, with the function now persisting its own report. A dropped
-- pg_net response no longer loses the result.
DO $p$
DECLARE v_uid uuid; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  BEGIN v_req := public.repull_fire(v_uid,'2026-06-01',false);
  EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
END
$p$;
