-- MAY dry run. ONE invocation. apply := false, so nothing is written.
DO $p$
DECLARE v_uid uuid; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  IF EXISTS (SELECT 1 FROM net.http_request_queue q
             WHERE q.url LIKE '%repull-month-adjustments%') THEN
    RAISE EXCEPTION 'a repull call is still in flight -- not firing a second one';
  END IF;

  v_req := public.repull_fire(v_uid, '2026-05-01'::date, false);
  RAISE NOTICE 'fired MAY dry run, pg_net request %', v_req;
END
$p$;
