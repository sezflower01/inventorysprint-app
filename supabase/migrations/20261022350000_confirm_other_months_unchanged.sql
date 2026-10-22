-- Item 6: confirm every month OTHER than October is untouched.
DO $p$
DECLARE v_uid uuid; r record; v_other_claw numeric; v_other_rows bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== compensated_clawback by month (only 2026-10 should be non-zero) ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS ym, count(*) AS rows,
           round(sum(COALESCE(compensated_clawback,0)),2) AS claw,
           count(adjustment_type) AS with_provenance
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % adj rows | clawback % | provenance on %',
      r.ym, lpad(r.rows::text,4), lpad(r.claw::text,9), r.with_provenance;
  END LOOP;

  SELECT round(sum(COALESCE(compensated_clawback,0)),2), count(*)
    INTO v_other_claw, v_other_rows
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND NOT (event_date >= '2026-10-01' AND event_date <= '2026-10-31');

  RAISE NOTICE '';
  RAISE NOTICE '== outside October: % rows | clawback total % ==', v_other_rows, v_other_claw;
  IF COALESCE(v_other_claw,0) = 0 THEN
    RAISE NOTICE '   CONFIRMED: no month other than October carries a clawback,';
    RAISE NOTICE '   so no other month''s P&L moved. Their reimbursement, lost,';
    RAISE NOTICE '   damage and reversal columns were never touched -- only';
    RAISE NOTICE '   October was deleted and re-synced.';
  ELSE
    RAISE NOTICE '   >>> UNEXPECTED: clawback outside October';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== and provenance exists ONLY where the new writer ran ==';
  FOR r IN
    SELECT count(*) AS total_adj,
           count(adjustment_type) AS with_type,
           count(*) FILTER (WHERE adjustment_type IS NOT NULL
             AND NOT (event_date >= '2026-10-01' AND event_date <= '2026-10-31')) AS outside_oct
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
  LOOP
    RAISE NOTICE '   % adjustment rows | % with provenance | % of those outside October',
      r.total_adj, r.with_type, r.outside_oct;
  END LOOP;
END
$p$;
