-- READ-ONLY. Exactly which keys differ between the two overloads, and by how much.
DO $p$
DECLARE r record; j1 jsonb; j2 jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    (SELECT id::text FROM auth.users WHERE email='sezflower01@gmail.com'), true);

  SELECT row_to_json(t)::jsonb INTO j1
  FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text) t;
  SELECT row_to_json(t)::jsonb INTO j2
  FROM public.get_pl_live_summary('2026-01-01T00:00:00Z', now()::text, 'ALL') t;

  RAISE NOTICE '== keys that differ, 2-arg vs 3-arg, Jan 1 to today ==';
  FOR r IN
    SELECT k,
           COALESCE(j1->>k,'(absent)') AS two_arg,
           COALESCE(j2->>k,'(absent)') AS three_arg
    FROM (SELECT DISTINCT jsonb_object_keys(j1 || j2) AS k) keys
    WHERE COALESCE(j1->>k,'~') IS DISTINCT FROM COALESCE(j2->>k,'~')
    ORDER BY k
  LOOP
    RAISE NOTICE '  % | 2-arg % | 3-arg %', rpad(r.k,34), lpad(left(r.two_arg,16),16), left(r.three_arg,16);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no key differs)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how much FBM label cost is in the period at all? ==';
  FOR r IN
    SELECT count(*) AS rows, round(sum(fbm_shipping_label_fee)::numeric,2) AS total
    FROM public.financial_events_cache
    WHERE user_id = (SELECT id FROM auth.users WHERE email='sezflower01@gmail.com')
      AND event_date >= '2026-01-01' AND COALESCE(fbm_shipping_label_fee,0) <> 0
  LOOP
    RAISE NOTICE '  % rows carry a label fee | $% in total since Jan 1', r.rows, r.total;
  END LOOP;
END
$p$;
