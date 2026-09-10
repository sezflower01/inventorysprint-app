-- Re-read the sweep. The first read ran before net._http_response had the rows;
-- responses are recorded asynchronously and each batch has a 150s timeout.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
  v_checked int := 0; v_repaired int := 0; v_ok int := 0;
  v_unver int := 0; v_fx int := 0; v_seen int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== batch responses ========';
  FOR r IN
    SELECT id, status_code,
           (content::jsonb ->> 'checked')::int AS checked,
           (content::jsonb ->> 'repaired')::int AS repaired,
           (content::jsonb ->> 'already_correct')::int AS ok,
           (content::jsonb ->> 'unverifiable')::int AS unver,
           (content::jsonb ->> 'revenue_skipped_non_usd')::int AS fx,
           (content::jsonb ->> 'elapsed_ms')::int AS ms
    FROM net._http_response
    WHERE id BETWEEN 61367 AND 61373
    ORDER BY id
  LOOP
    v_seen := v_seen + 1;
    IF r.status_code = 200 THEN
      RAISE NOTICE '   id=% | checked=% repaired=% already_ok=% unverif=% fx=% (%ms)',
        r.id, r.checked, r.repaired, r.ok, r.unver, r.fx, r.ms;
      v_checked := v_checked + COALESCE(r.checked,0);
      v_repaired := v_repaired + COALESCE(r.repaired,0);
      v_ok := v_ok + COALESCE(r.ok,0);
      v_unver := v_unver + COALESCE(r.unver,0);
      v_fx := v_fx + COALESCE(r.fx,0);
    ELSE
      RAISE NOTICE '   id=% | status % <- FAILED', r.id, r.status_code;
    END IF;
  END LOOP;

  IF v_seen = 0 THEN
    RAISE NOTICE '   (still no responses recorded)';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   TOTAL over % batch(es): checked=% repaired=% already_ok=% unverif=% fx_skipped=%',
    v_seen, v_checked, v_repaired, v_ok, v_unver, v_fx;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist now (was 436 before the sweep) ========';
  FOR r IN
    SELECT marketplace, count(*) AS n
    FROM public.collapsed_order_candidates(v_uid, 5000)
    GROUP BY marketplace ORDER BY n DESC
  LOOP
    RAISE NOTICE '      % : % rows', rpad(r.marketplace,4), r.n;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP RAISE NOTICE '   % remain', r.n; END LOOP;
END
$probe$;
