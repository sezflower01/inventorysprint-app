-- READ-ONLY. What did the re-pull ACTUALLY change in the P&L, per month?
--
-- July's verification was the first to run against a baseline that records
-- something, and it reported more than the clawback line:
--
--    m7 compensated_clawback      0      ->  246.44
--    m7 reimbursements        439.0868   ->  440.6928
--    m7 reversal_reimbursement 358.4368  ->  360.0428
--    m7 warehouse_damage      334.07     ->  342.95
--
-- That is expected in hindsight -- the re-pull deletes and re-inserts every
-- adjustment row for the month (133 in, 77 out for July), and those rows carry
-- reversal reimbursements and warehouse damage as well as clawbacks -- but it
-- had never been SEEN before, because the only prior baseline was 480 zeros.
-- It matters for one specific reason: the figure being sent to an accountant.
-- "July costs 246.44" is the clawback line alone; the month's actual profit
-- movement is the clawback MINUS whatever income those same rows added.
--
-- May and June cannot be re-measured from the P&L -- they were applied before a
-- usable baseline existed -- but they CAN be measured from their own backups,
-- which hold the pre-apply rows in full. That is what this does: for every
-- backed-up month, every money column, backup total vs live total.
DO $p$
DECLARE r record; v_uid uuid; v_m date; v_months date[];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT array_agg(DISTINCT backup_month ORDER BY backup_month) INTO v_months
  FROM public.fec_repull_backup;
  RAISE NOTICE '== months with a backup on file: % ==', v_months;

  FOREACH v_m IN ARRAY v_months LOOP
    RAISE NOTICE '';
    RAISE NOTICE '################ % ################', to_char(v_m,'YYYY-MM');
    FOR r IN
      SELECT count(*) FILTER (WHERE src='b') AS b_rows,
             count(*) FILTER (WHERE src='l') AS l_rows
      FROM (
        SELECT 'b' AS src FROM public.fec_repull_backup WHERE backup_month = v_m
        UNION ALL
        SELECT 'l' FROM public.financial_events_cache
         WHERE user_id = v_uid AND event_date >= v_m
           AND event_date < (v_m + interval '1 month')) s
    LOOP RAISE NOTICE '   rows: backup % | live %', r.b_rows, r.l_rows; END LOOP;

    RAISE NOTICE '   money columns whose MONTH TOTAL moved:';
    FOR r IN
      WITH b AS (
        SELECT e.k, sum(e.v::numeric) AS tot
        FROM public.fec_repull_backup t,
             LATERAL jsonb_each_text(to_jsonb(t) - 'backup_month' - 'backed_up_at') AS e(k,v)
        WHERE t.backup_month = v_m AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        GROUP BY 1),
      l AS (
        SELECT e.k, sum(e.v::numeric) AS tot
        FROM public.financial_events_cache t,
             LATERAL jsonb_each_text(to_jsonb(t)) AS e(k,v)
        WHERE t.user_id = v_uid AND t.event_date >= v_m
          AND t.event_date < (v_m + interval '1 month')
          AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
        GROUP BY 1)
      SELECT COALESCE(b.k, l.k) AS col,
             round(COALESCE(b.tot,0),4) AS was,
             round(COALESCE(l.tot,0),4) AS now,
             round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4) AS delta
      FROM b FULL OUTER JOIN l ON l.k = b.k
      WHERE round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4) <> 0
        AND COALESCE(b.k, l.k) NOT IN ('id','quantity')
      ORDER BY abs(round(COALESCE(l.tot,0) - COALESCE(b.tot,0),4)) DESC
    LOOP
      RAISE NOTICE '      % | % -> % | delta %', rpad(r.col,32),
        lpad(r.was::text,14), lpad(r.now::text,14), lpad(r.delta::text,12);
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '      none -- nothing in this month moved'; END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== reading it ==';
  RAISE NOTICE '   compensated_clawback is an EXPENSE in plModel (subtracted as a';
  RAISE NOTICE '   magnitude). reimbursements, reversal_reimbursement,';
  RAISE NOTICE '   warehouse_damage and warehouse_lost are INCOME. A month net';
  RAISE NOTICE '   movement is the clawback plus the income deltas, not the';
  RAISE NOTICE '   clawback alone -- which is what the accountant figure quotes.';
END
$p$;
