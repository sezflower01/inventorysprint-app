-- Read the sweep batches and the resulting position.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
  v_checked int := 0; v_repaired int := 0; v_ok int := 0;
  v_unver int := 0; v_fx int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

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
    IF r.status_code = 200 THEN
      RAISE NOTICE '   id=% | checked=% repaired=% already_ok=% unverifiable=% fx_skipped=% (%ms)',
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

  RAISE NOTICE '';
  RAISE NOTICE '   TOTAL checked=% repaired=% already_correct=% unverifiable=% fx_skipped=%',
    v_checked, v_repaired, v_ok, v_unver, v_fx;

  RAISE NOTICE '';
  RAISE NOTICE '======== shortlist now (was 436) ========';
  FOR r IN
    SELECT marketplace, count(*) AS n
    FROM public.collapsed_order_candidates(v_uid, 5000)
    GROUP BY marketplace ORDER BY n DESC
  LOOP
    RAISE NOTICE '      % : % rows', rpad(r.marketplace,4), r.n;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.collapsed_order_candidates(v_uid, 5000)
  LOOP RAISE NOTICE '   % remain', r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== COGS impact of what was repaired ========';
  FOR r IN
    SELECT count(*) AS rows_fixed,
           sum(quantity) AS units_now,
           round(sum(total_cost)::numeric, 2) AS cogs_now
    FROM public.sales_orders
    WHERE user_id = v_uid AND quantity > 1
      AND updated_at > now() - interval '30 minutes'
  LOOP
    RAISE NOTICE '   % rows updated in the last 30 min now carry % units and % COGS',
      r.rows_fixed, r.units_now, r.cogs_now;
  END LOOP;
END
$probe$;
