-- READ-ONLY. What did the re-sync (request 20957) actually do?
DO $p$
DECLARE r record; v_status int; v_content text; v_err text;
BEGIN
  SELECT status_code, left(COALESCE(content,''),1200), left(COALESCE(error_msg,''),400)
    INTO v_status, v_content, v_err
  FROM net._http_response WHERE id = 20957;

  IF v_status IS NULL AND v_err IS NULL THEN
    RAISE NOTICE 'no response row for 20957 yet';
  ELSE
    RAISE NOTICE '== HTTP % ==', COALESCE(v_status::text,'(none)');
    IF COALESCE(v_err,'') <> '' THEN RAISE NOTICE '   error_msg: %', v_err; END IF;
    RAISE NOTICE '   body: %', v_content;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== sync state ==';
  FOR r IN
    SELECT to_jsonb(s)::text AS j FROM public.financial_sync_state s
    WHERE s.user_id = (SELECT id FROM auth.users WHERE email='sezflower01@gmail.com')
  LOOP RAISE NOTICE '   %', left(r.j, 500); END LOOP;
END
$p$;
