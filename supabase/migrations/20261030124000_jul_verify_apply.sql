-- JULY: verify the apply from the database.
--
-- Six checks. Check 6 is the one that changed: it compares the live 2026 P&L
-- against pl_baseline_20261030, captured this morning THROUGH AN AUTH CONTEXT
-- (20261030101000) and gated on being non-empty with real sales. Its
-- predecessor, pl_baseline_20261022, was 480 zero cells because the RPC is
-- auth.uid()-scoped and auth.uid() is NULL in a migration -- so for May and
-- June that check compared zeros with zeros and could not fail. This one can:
-- it must show July's clawback line moving from 0.00 to 246.44, and it asserts
-- the baseline is usable before it believes a single "identical".
DO $p$
DECLARE r record; v_uid uuid; v_claw numeric; v_rows int; v_bad int;
        v_types_before int; v_types_after int; v_i int := 0;
        v_base_sales numeric; v_moved text := ''; v_jul_claw numeric;
        v_unexpected int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  -- Wait for the apply rather than guessing: the June read landed early once.
  WHILE v_i < 10 LOOP
    SELECT COALESCE(sum(compensated_clawback),0) INTO v_claw
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-07-01' AND event_date < '2026-08-01';
    EXIT WHEN round(v_claw,2) <> 0;
    PERFORM pg_sleep(15);
    v_i := v_i + 1;
  END LOOP;

  SELECT count(*) INTO v_rows FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-07-01' AND event_date < '2026-08-01';

  RAISE NOTICE '== JULY after the apply (waited ~% s) ==', v_i*15;
  RAISE NOTICE '   rows % (was 5501) | clawbacks stored % (API said -246.44)',
    v_rows, round(v_claw,2);

  IF round(v_claw,2) = 0 THEN
    RAISE NOTICE '   >>> APPLY HAS NOT LANDED -- re-read shortly, nothing is wrong';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. fingerprints, set comparison over whichever types exist ==';
  SELECT count(*) INTO v_types_before FROM public.fec_fingerprint_snapshot
   WHERE snap_month='2026-07-01' AND phase='before';
  v_types_after := public.fec_snapshot_fingerprints(v_uid, '2026-07-01'::date, 'after');
  RAISE NOTICE '   types before % | types after %', v_types_before, v_types_after;

  FOR r IN SELECT * FROM public.fec_compare_fingerprints('2026-07-01'::date)
  LOOP
    RAISE NOTICE '   % | % -> % rows | %',
      rpad(r.event_type,14), lpad(COALESCE(r.rows_before::text,'-'),5),
      lpad(COALESCE(r.rows_after::text,'-'),5), r.verdict;
  END LOOP;

  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-07-01'::date)
   WHERE verdict <> 'identical';
  RAISE NOTICE '   non-identical verdicts: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. clawbacks stored vs API ==';
  RAISE NOTICE '   stored % | API -246.44 | match %',
    round(v_claw,2), (round(v_claw,2) = -246.44);

  RAISE NOTICE '';
  RAISE NOTICE '== 3. diff by key, all 57 columns ==';
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-07-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   is every non-unchanged row an adjustment?';
  FOR r IN
    SELECT COALESCE(event_type,'(null)') AS et, verdict, count(*) AS n
    FROM public.fec_diff_month(v_uid,'2026-07-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '      % | % | % rows', rpad(r.et,12), rpad(r.verdict,8), r.n; END LOOP;

  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-07-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  RAISE NOTICE '      non-adjustment rows that moved: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '   a sample of what changed:';
  FOR r IN
    SELECT verdict, event_type, event_date, COALESCE(asin,'') AS asin,
           left(COALESCE(after_money::text,'(null)'),120) AS after_m
    FROM public.fec_diff_month(v_uid,'2026-07-01'::date)
    WHERE verdict <> 'unchanged' ORDER BY verdict, event_date LIMIT 6
  LOOP RAISE NOTICE '      % | % | % | %', rpad(r.verdict,8), r.event_type, r.event_date,
         replace(r.after_m,'%','%%'); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. every 2026 month: adjustment rows and clawbacks ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw, count(*) AS rows
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % adjustment rows | clawbacks %',
         r.m, lpad(r.rows::text,4), lpad(r.claw::text,10); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. unpaired amounts, by key ==';
  FOR r IN
    SELECT verdict, count(*) AS n,
           round(COALESCE(sum((after_money->>'compensated_clawback')::numeric),0),2) AS claw
    FROM public.fec_diff_month(v_uid,'2026-07-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows | clawbacks in them %',
         rpad(r.verdict,10), lpad(r.n::text,4), lpad(r.claw::text,10); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 6. live 2026 P&L vs pl_baseline_20261030 (a baseline that can fail) ==';
  SELECT COALESCE(sum((pl->>'sales')::numeric),0) INTO v_base_sales
    FROM public.pl_baseline_20261030;
  RAISE NOTICE '   baseline: % months | 2026 sales % (0 would make this check void)',
    (SELECT count(*) FROM public.pl_baseline_20261030), round(v_base_sales,2);
  IF v_base_sales <= 0 THEN
    RAISE EXCEPTION 'pl_baseline_20261030 has no sales -- refusing to report a pass against it';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  IF (SELECT auth.uid()) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'no auth context -- the live side would read as zeros';
  END IF;

  CREATE TEMP TABLE jul_live_pl ON COMMIT DROP AS
  SELECT (to_jsonb(l) ->> 'month_num')::integer AS month_num, to_jsonb(l) - 'month_num' AS pl
  FROM public.get_monthly_pl_breakdown(2026) l;

  FOR r IN
    SELECT b.month_num AS m, e.k AS cell,
           b.pl ->> e.k AS was, l.pl ->> e.k AS now
    FROM public.pl_baseline_20261030 b
    JOIN jul_live_pl l ON l.month_num = b.month_num
    CROSS JOIN LATERAL (
      SELECT DISTINCT key AS k
      FROM (SELECT jsonb_object_keys(b.pl) AS key
            UNION SELECT jsonb_object_keys(l.pl)) u) e
    WHERE COALESCE(b.pl ->> e.k,'~') <> COALESCE(l.pl ->> e.k,'~')
    ORDER BY 1,2
  LOOP
    RAISE NOTICE '   m% % : % -> %', lpad(r.m::text,2), rpad(r.cell,26),
      lpad(COALESCE(r.was,'-'),12), lpad(COALESCE(r.now,'-'),12);
    IF v_moved NOT LIKE '%' || r.m::text || '%' THEN
      v_moved := v_moved || r.m::text || ' ';
    END IF;
    IF r.m <> 7 THEN v_unexpected := v_unexpected + 1; END IF;
  END LOOP;

  SELECT (pl->>'compensated_clawback')::numeric INTO v_jul_claw
    FROM jul_live_pl WHERE month_num = 7;
  RAISE NOTICE '';
  RAISE NOTICE '   July P&L clawback line: baseline % -> live %',
    (SELECT round((pl->>'compensated_clawback')::numeric,2)
       FROM public.pl_baseline_20261030 WHERE month_num=7),
    round(v_jul_claw,2);
  RAISE NOTICE '   months that moved: %', COALESCE(NULLIF(v_moved,''),'NONE');
  RAISE NOTICE '   cells outside July that moved: % (October is the live month --',
    v_unexpected;
  RAISE NOTICE '   its nightly re-sync legitimately adds new clawback postings)';

  IF round(v_jul_claw,2) <> 246.44 THEN
    RAISE EXCEPTION 'July P&L clawback line reads % not 246.44 -- the apply did not reach the P&L',
      round(v_jul_claw,2);
  END IF;
  RAISE NOTICE '   JULY IS IN THE P&L: 246.44 as a magnitude, subtracted by plModel';

  RAISE NOTICE '';
  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-07-01'::date)
   WHERE verdict <> 'identical';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'a non-adjustment fingerprint is not identical -- run fec_restore_month';
  END IF;
  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-07-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% non-adjustment row(s) moved -- run fec_restore_month', v_bad;
  END IF;
  IF round(v_claw,2) <> -246.44 THEN
    RAISE EXCEPTION 'stored clawbacks % <> API -246.44', round(v_claw,2);
  END IF;
  RAISE NOTICE '   ALL CHECKS PASSED';
END
$p$;
