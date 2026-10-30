-- READ-ONLY. Settle check 6.
--
-- Every column of both the live P&L and pl_baseline_20261022 read 0 for May and
-- June. The suspicion is that get_monthly_pl_breakdown is auth.uid()-scoped, so
-- calling it from a migration -- where there is no authenticated user -- returns
-- zeros, and the baseline captured on 2026-10-22 is therefore a table of zeros.
--
-- If so, "live P&L vs pl_baseline_20261022" cannot verify anything from SQL, and
-- saying it passed would be the same class of mistake as the gate that always
-- went green: a check that cannot fail.
DO $p$
DECLARE r record; v_nonzero int; v_cells int; v_def text;
BEGIN
  RAISE NOTICE '== 1. how much of pl_baseline_20261022 is non-zero? ==';
  SELECT count(*) FILTER (WHERE v <> '0' AND v <> '0.00' AND v IS NOT NULL),
         count(*)
    INTO v_nonzero, v_cells
  FROM public.pl_baseline_20261022 b,
       LATERAL jsonb_each_text(to_jsonb(b) - 'month_num') AS e(k, v);
  RAISE NOTICE '   % non-zero cells out of % (month_num excluded)', v_nonzero, v_cells;
  IF v_nonzero = 0 THEN
    RAISE NOTICE '   >>> THE BASELINE IS ENTIRELY ZEROS. It records nothing.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. is the RPC auth.uid()-scoped? ==';
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           (pg_get_functiondef(p.oid) ILIKE '%auth.uid()%') AS uses_auth_uid
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'get_monthly_pl%'
    ORDER BY 1,2
  LOOP
    RAISE NOTICE '   %(%) | uses auth.uid(): %', r.proname, r.args, r.uses_auth_uid;
  END LOOP;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_monthly_pl_breakdown' LIMIT 1;
  RAISE NOTICE '';
  RAISE NOTICE '   the WHERE clause that scopes it:';
  FOR r IN
    SELECT regexp_replace(line, E'\\s+', ' ', 'g') AS line
    FROM regexp_split_to_table(v_def, E'\n') AS line
    WHERE line ILIKE '%auth.uid%' OR line ILIKE '%user_id%'
    LIMIT 6
  LOOP RAISE NOTICE '      %', r.line; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. current auth context inside a migration ==';
  RAISE NOTICE '   current_user % | auth.uid() %', current_user,
    COALESCE((SELECT auth.uid())::text, 'NULL');

  RAISE NOTICE '';
  RAISE NOTICE '== 4. so what DOES move? the same figures, scoped by user_id ==';
  FOR r IN
    SELECT to_char(f.event_date,'YYYY-MM') AS m,
           round(COALESCE(sum(f.compensated_clawback),0)::numeric,2) AS claw
    FROM public.financial_events_cache f
    JOIN auth.users u ON u.id = f.user_id AND u.email='sezflower01@gmail.com'
    WHERE f.event_date >= '2026-01-01' AND f.event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | clawbacks %', r.m, lpad(r.claw::text,10); END LOOP;
END
$p$;
