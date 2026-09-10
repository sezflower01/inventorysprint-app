-- Read the single-dispatch sweep batch.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== batch 61390 ========';
  FOR r IN
    SELECT status_code,
           (content::jsonb ->> 'checked') AS checked,
           (content::jsonb ->> 'repaired') AS repaired,
           (content::jsonb ->> 'already_correct') AS ok,
           (content::jsonb ->> 'unverifiable') AS unver,
           (content::jsonb ->> 'revenue_skipped_non_usd') AS fx,
           (content::jsonb ->> 'elapsed_ms') AS ms
    FROM net._http_response WHERE id = 61390
  LOOP
    RAISE NOTICE '   status=% checked=% repaired=% already_ok=% unverif=% fx=% (%ms)',
      r.status_code, r.checked, r.repaired, r.ok, r.unver, r.fx, r.ms;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist (was 436) ========';
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP RAISE NOTICE '   % remain', r.n; END LOOP;
END
$probe$;
