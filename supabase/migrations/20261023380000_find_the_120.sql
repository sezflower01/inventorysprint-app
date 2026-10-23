-- ITEM 3, properly. My guess was wrong: the -$1.20 is NOT an unrecognised
-- negative landing in reimbursements (that column has no non-zero rows at all).
-- It came out of reversal_reimbursement, 801.23 -> 800.03.
--
-- Candidate explanations, in order of likelihood:
--   A. Amazon RESTATED or withdrew a reversal since January was last synced.
--      October showed the same thing on fba_removal_fees (-$3.36 across two
--      service_fee rows), so restatement is demonstrably normal here.
--   B. The old collision merged two reversals and the surviving row kept a
--      value that double-counted something.
--   C. A reversal arrived negative and abs() differed between old and new --
--      ruled out by inspection: both use the same router and the same abs().
--
-- A and B are distinguishable: compare the reversal amounts in the backup
-- against the reversal amounts now, as multisets.
DO $p$
DECLARE v_uid uuid; r record; v_b numeric; v_a numeric; v_nb int; v_na int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*), round(sum(reversal_reimbursement),2) INTO v_nb, v_b
  FROM public.fec_repull_backup
  WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'
    AND COALESCE(reversal_reimbursement,0) <> 0;
  SELECT count(*), round(sum(reversal_reimbursement),2) INTO v_na, v_a
  FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date>='2026-01-01' AND event_date<'2026-02-01'
    AND COALESCE(reversal_reimbursement,0) <> 0;

  RAISE NOTICE '== reversal rows: % (sum %) -> % (sum %) ==', v_nb, v_b, v_na, v_a;

  RAISE NOTICE '';
  RAISE NOTICE '== amounts present BEFORE but not AFTER (multiset difference) ==';
  FOR r IN
    WITH b AS (
      SELECT round(reversal_reimbursement,2) AS amt, count(*) AS n
      FROM public.fec_repull_backup
      WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'
        AND COALESCE(reversal_reimbursement,0) <> 0
      GROUP BY 1
    ), a AS (
      SELECT round(reversal_reimbursement,2) AS amt, count(*) AS n
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_type='adjustment'
        AND event_date>='2026-01-01' AND event_date<'2026-02-01'
        AND COALESCE(reversal_reimbursement,0) <> 0
      GROUP BY 1
    )
    SELECT COALESCE(b.amt,a.amt) AS amt, COALESCE(b.n,0) AS before_n, COALESCE(a.n,0) AS after_n
    FROM b FULL OUTER JOIN a ON a.amt = b.amt
    WHERE COALESCE(b.n,0) <> COALESCE(a.n,0)
    ORDER BY amt
  LOOP
    RAISE NOTICE '   amount % | before % rows | after % rows | change %',
      lpad(r.amt::text,9), lpad(r.before_n::text,3), lpad(r.after_n::text,3),
      r.after_n - r.before_n;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   multisets are identical -- the gap is not a missing amount'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the BACKUP rows that carried a reversal, with their keys ==';
  RAISE NOTICE '   (collided rows are the ones holding more than one amount)';
  FOR r IN
    SELECT amazon_order_id, event_date,
           round(COALESCE(reversal_reimbursement,0),2) AS rev,
           round(COALESCE(warehouse_lost,0),2) AS lost,
           round(COALESCE(warehouse_damage,0),2) AS dmg,
           round(COALESCE(free_replacement_refund_items,0),2) AS frep
    FROM public.fec_repull_backup
    WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'
      AND COALESCE(reversal_reimbursement,0) <> 0
      AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0
        OR COALESCE(free_replacement_refund_items,0) <> 0)
    ORDER BY event_date
  LOOP
    RAISE NOTICE '   % | % | rev % | lost % | dmg % | frep %',
      rpad(r.amazon_order_id,24), r.event_date, r.rev, r.lost, r.dmg, r.frep;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no backup row mixed a reversal with another column'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 3b restated: money by column, adjustment rows only ==';
  FOR r IN
    SELECT 'warehouse_lost' AS c,
      (SELECT round(sum(COALESCE(warehouse_lost,0)),2) FROM public.fec_repull_backup
        WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment') AS b,
      (SELECT round(sum(COALESCE(warehouse_lost,0)),2) FROM public.financial_events_cache
        WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01') AS a
    UNION ALL SELECT 'warehouse_damage',
      (SELECT round(sum(COALESCE(warehouse_damage,0)),2) FROM public.fec_repull_backup
        WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'),
      (SELECT round(sum(COALESCE(warehouse_damage,0)),2) FROM public.financial_events_cache
        WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01')
    UNION ALL SELECT 'reversal_reimbursement',
      (SELECT round(sum(COALESCE(reversal_reimbursement,0)),2) FROM public.fec_repull_backup
        WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'),
      (SELECT round(sum(COALESCE(reversal_reimbursement,0)),2) FROM public.financial_events_cache
        WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01')
    UNION ALL SELECT 'free_replacement',
      (SELECT round(sum(COALESCE(free_replacement_refund_items,0)),2) FROM public.fec_repull_backup
        WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'),
      (SELECT round(sum(COALESCE(free_replacement_refund_items,0)),2) FROM public.financial_events_cache
        WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01')
    UNION ALL SELECT 'compensated_clawback',
      (SELECT round(sum(COALESCE(compensated_clawback,0)),2) FROM public.fec_repull_backup
        WHERE user_id=v_uid AND backup_month='2026-01-01' AND event_type='adjustment'),
      (SELECT round(sum(COALESCE(compensated_clawback,0)),2) FROM public.financial_events_cache
        WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-01-01' AND event_date<'2026-02-01')
  LOOP
    RAISE NOTICE '   % | % -> % | delta %', rpad(r.c,26),
      lpad(COALESCE(r.b,0)::text,9), lpad(COALESCE(r.a,0)::text,9),
      round(COALESCE(r.a,0)-COALESCE(r.b,0),2);
  END LOOP;
END
$p$;
