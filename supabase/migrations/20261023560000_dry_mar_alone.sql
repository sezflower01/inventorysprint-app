-- March, ALONE this time. The previous three failures were caused by my
-- queueing four months close together so they ran back-to-back against a
-- ~0.5 req/sec endpoint. One request in flight, nothing else fired until it
-- returns.
DO $p$
DECLARE v_uid uuid; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== DRY RUN: March, alone ==';
  BEGIN v_req := public.repull_fire(v_uid,'2026-03-01',false);
  EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
END
$p$;
