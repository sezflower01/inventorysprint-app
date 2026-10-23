DO $p$
DECLARE v_uid uuid; v_req bigint; v_s text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_s := public.repull_report2(44855);
  IF v_s = 'done' THEN
    RAISE NOTICE '';
    BEGIN v_req := public.repull_fire(v_uid,'2026-07-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  ELSIF v_s = 'lost' THEN
    RAISE NOTICE '   re-firing June';
    BEGIN v_req := public.repull_fire(v_uid,'2026-06-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  END IF;
END
$p$;
