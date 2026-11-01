-- DO YESTERDAY'S DRY-RUN RESULTS STILL EXIST? -- READ ONLY.
--
-- Everything validated yesterday lives in net._http_response and NOWHERE else:
-- a dry run deliberately records nothing in collapsed_order_checks, so there is
-- no persistent record of which 247 of 285 candidates were checked. pg_net
-- prunes its response table on a timer (6 hours by default), and the last pass
-- fired at 01:23 UTC.
--
-- If those rows are gone, the 38-candidate remainder cannot be identified and
-- the whole dry run has to be redone -- and this time persisted before, not
-- after. Checking costs one query and decides the morning's plan, so it runs
-- before anything calls Amazon.
DO $p$
DECLARE
  r record; v_uid uuid; v_present int := 0; v_missing int := 0;
  v_reqs bigint[] := ARRAY[59951, 59985, 60032, 60055, 60078, 60105,
                           60157, 60192, 60230, 60255];
  v_rq bigint; v_status int; v_rows int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== the ten dry-run responses ==';
  RAISE NOTICE '   request | status | rows | present?';
  FOREACH v_rq IN ARRAY v_reqs LOOP
    SELECT status_code,
           jsonb_array_length(COALESCE(content::jsonb->'rows','[]'::jsonb))
      INTO v_status, v_rows
    FROM net._http_response WHERE id = v_rq;
    IF v_status IS NULL THEN
      v_missing := v_missing + 1;
      RAISE NOTICE '   %  |      - |    - | >>> PRUNED', lpad(v_rq::text,7);
    ELSE
      v_present := v_present + 1;
      RAISE NOTICE '   %  | % | % | yes', lpad(v_rq::text,7),
        lpad(v_status::text,6), lpad(v_rows::text,4);
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   present % of 10 | pruned %', v_present, v_missing;

  IF v_missing = 0 THEN
    RAISE NOTICE '   >>> ALL SURVIVED. The 38-candidate remainder can be derived';
    RAISE NOTICE '   >>> and today only needs those 38 checked.';
  ELSIF v_present = 0 THEN
    RAISE NOTICE '   >>> ALL GONE. Yesterday''s validation is unrecoverable and';
    RAISE NOTICE '   >>> the full 285 must be re-run, persisted this time.';
  ELSE
    RAISE NOTICE '   >>> PARTIAL. Only the surviving responses can be trusted;';
    RAISE NOTICE '   >>> treat every candidate not in them as unvalidated.';
  END IF;

  -- how old is the oldest surviving pg_net response at all? that tells us the
  -- real retention window rather than assuming the 6-hour default.
  FOR r IN
    SELECT min(created) AS oldest, max(created) AS newest, count(*) AS n
    FROM net._http_response
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   net._http_response holds % rows, % .. %',
      r.n, r.oldest, r.newest;
    RAISE NOTICE '   now is %', clock_timestamp();
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, no API called.';
END
$p$;
