-- JUNE: verify the apply from the database.
--
-- Six checks. Two differ from the May verification on purpose:
--
--   Check 1 now uses fec_snapshot_fingerprints / fec_compare_fingerprints --
--   a SET comparison over whichever non-adjustment types exist, failing on a
--   type that APPEARS or DISAPPEARS as well as one that changed. May's check
--   was a hardcoded list of four types; June has three, and a fixed list
--   cannot see a type arriving or vanishing at all.
--
--   Check 6 compares the live 2026 P&L against pl_baseline_20261022 month by
--   month and names which months moved, rather than asserting none did -- Jan,
--   May and Oct were applied deliberately and June is the point of this run,
--   so "nothing moved" would be the wrong assertion.
DO $p$
DECLARE r record; v_uid uuid; v_claw numeric; v_rows int; v_bad int;
        v_types_before int; v_types_after int; v_key text; v_moved text := '';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_rows FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-06-01' AND event_date < '2026-07-01';
  SELECT COALESCE(sum(compensated_clawback),0) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date >= '2026-06-01' AND event_date < '2026-07-01';

  RAISE NOTICE '== JUNE after the apply ==';
  RAISE NOTICE '   rows % (was 5682) | clawbacks stored % (API said -209.69)',
    v_rows, round(v_claw,2);

  IF round(v_claw,2) = 0 THEN
    RAISE NOTICE '   >>> APPLY HAS NOT LANDED YET -- re-read shortly, nothing is wrong';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. fingerprints, set comparison over whichever types exist ==';
  SELECT count(*) INTO v_types_before FROM public.fec_fingerprint_snapshot
   WHERE snap_month='2026-06-01' AND phase='before';
  v_types_after := public.fec_snapshot_fingerprints(v_uid, '2026-06-01'::date, 'after');
  RAISE NOTICE '   types before % | types after %', v_types_before, v_types_after;

  FOR r IN SELECT * FROM public.fec_compare_fingerprints('2026-06-01'::date)
  LOOP
    RAISE NOTICE '   % | % -> % rows | %',
      rpad(r.event_type,14), lpad(COALESCE(r.rows_before::text,'-'),5),
      lpad(COALESCE(r.rows_after::text,'-'),5), r.verdict;
  END LOOP;

  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-06-01'::date)
   WHERE verdict <> 'identical';
  RAISE NOTICE '   non-identical verdicts: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. clawbacks stored vs API ==';
  RAISE NOTICE '   stored % | API -209.69 | match %',
    round(v_claw,2), (round(v_claw,2) = -209.69);

  RAISE NOTICE '';
  RAISE NOTICE '== 3. diff by key, all 57 columns ==';
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-06-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   is every non-unchanged row an adjustment?';
  FOR r IN
    SELECT COALESCE(event_type,'(null)') AS et, verdict, count(*) AS n
    FROM public.fec_diff_month(v_uid,'2026-06-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '      % | % | % rows', rpad(r.et,12), rpad(r.verdict,8), r.n; END LOOP;

  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-06-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  RAISE NOTICE '      non-adjustment rows that moved: % (must be 0)', v_bad;

  RAISE NOTICE '';
  RAISE NOTICE '   a sample of what changed:';
  FOR r IN
    SELECT verdict, event_type, event_date, COALESCE(asin,'') AS asin,
           left(COALESCE(after_money::text,'(null)'),120) AS after_m
    FROM public.fec_diff_month(v_uid,'2026-06-01'::date)
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
    FROM public.fec_diff_month(v_uid,'2026-06-01'::date)
    WHERE verdict <> 'unchanged' GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows | clawbacks in them %',
         rpad(r.verdict,10), lpad(r.n::text,4), lpad(r.claw::text,10); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 6. live 2026 P&L vs pl_baseline_20261022 ==';
  FOR r IN
    SELECT COALESCE(l.month_num, b.month_num) AS m,
           (to_jsonb(l) - 'month_num') AS live, (to_jsonb(b) - 'month_num') AS base
    FROM public.get_monthly_pl_breakdown(2026) l
    FULL OUTER JOIN public.pl_baseline_20261022 b ON b.month_num = l.month_num
    ORDER BY 1
  LOOP
    IF r.live = r.base THEN
      RAISE NOTICE '   m% identical', lpad(r.m::text,2);
    ELSE
      v_moved := v_moved || r.m::text || ' ';
      RAISE NOTICE '   m% MOVED:', lpad(r.m::text,2);
      FOR v_key IN SELECT k FROM jsonb_object_keys(r.base) k ORDER BY 1 LOOP
        IF COALESCE(r.live->>v_key,'~') <> COALESCE(r.base->>v_key,'~') THEN
          RAISE NOTICE '        % : % -> %', rpad(v_key,30),
            lpad(COALESCE(r.base->>v_key,'-'),12), lpad(COALESCE(r.live->>v_key,'-'),12);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RAISE NOTICE '   months that moved vs the 10-22 baseline: %', COALESCE(NULLIF(v_moved,''),'none');
  RAISE NOTICE '   (1, 5, 6 and 10 are the applied months -- anything else is a surprise)';

  RAISE NOTICE '';
  SELECT count(*) INTO v_bad FROM public.fec_compare_fingerprints('2026-06-01'::date)
   WHERE verdict <> 'identical';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'a non-adjustment fingerprint is not identical -- run fec_restore_month';
  END IF;
  SELECT count(*) INTO v_bad FROM public.fec_diff_month(v_uid,'2026-06-01'::date)
   WHERE verdict <> 'unchanged' AND COALESCE(event_type,'') <> 'adjustment';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% non-adjustment row(s) moved -- run fec_restore_month', v_bad;
  END IF;
  IF round(v_claw,2) <> -209.69 THEN
    RAISE EXCEPTION 'stored clawbacks % <> API -209.69', round(v_claw,2);
  END IF;
  RAISE NOTICE '   ALL CHECKS PASSED';
END
$p$;
