-- READ-ONLY. Three specific discrepancies against InventoryLab 2026-10-18..21.
--
-- 1. A ONE-DAY SHIFT. IL says Oct 18 $549.58 / Oct 19 $19.68; we say Oct 18
--    $112.39 / Oct 19 $555.20. IL's Oct 18 total lands on our Oct 19. The
--    repo already documents this exact class of bug for sales_orders
--    (order_date is Pacific, purchase_timestamp_utc is UTC, 23% of rows differ
--    by a day). event_date is a DATE so the time is gone -- but raw_event
--    should still carry the original posted timestamp, which settles it.
--
-- 2. REVERSAL SIGN. IL has Reimbursement_Reversal at -$7.97 (Amazon taking a
--    reimbursement back). We hold reversal_reimbursement at +$80.41. Both the
--    sign and the magnitude disagree.
--
-- 3. CUSTOMER RETURNS MISSING. IL has CustomerReturn $97.46 and
--    CustomerServiceIssue $25.45. Our `reimbursements` column is $0.00 in the
--    window and has only 2 non-zero rows in all of history, so those are
--    either landing somewhere else or not ingested.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1. what does raw_event look like on a reimbursement row? ==';
  FOR r IN
    SELECT event_date, left(raw_event::text, 900) AS j
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      AND COALESCE(warehouse_lost,0) <> 0
    ORDER BY event_date LIMIT 3
  LOOP
    RAISE NOTICE '   event_date % ->', r.event_date;
    RAISE NOTICE '      %', r.j;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no warehouse_lost rows with raw_event in the window)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1b. any timestamp-looking keys in raw_event? ==';
  FOR r IN
    SELECT DISTINCT k
    FROM public.financial_events_cache f,
         LATERAL jsonb_object_keys(f.raw_event) AS k
    WHERE f.user_id = v_uid
      AND f.event_date BETWEEN '2026-10-18' AND '2026-10-21'
      AND COALESCE(f.warehouse_lost,0) <> 0
      AND (k ILIKE '%date%' OR k ILIKE '%time%' OR k ILIKE '%posted%')
    ORDER BY k
  LOOP RAISE NOTICE '   raw_event key: %', r.k; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO date/time key in raw_event -- the time was dropped at ingest'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. the reversal rows: sign and size ==';
  FOR r IN
    SELECT event_date, COALESCE(asin,'-') AS asin,
           reversal_reimbursement AS amt,
           COALESCE(amazon_order_id,'-') AS oid
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      AND COALESCE(reversal_reimbursement,0) <> 0
    ORDER BY event_date, abs(reversal_reimbursement) DESC
  LOOP
    RAISE NOTICE '   % | asin % | reversal_reimbursement % | order %',
      r.event_date, rpad(r.asin,12), lpad(r.amt::text,10), r.oid;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none in the window)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   all-time sign distribution for reversal_reimbursement:';
  FOR r IN
    SELECT count(*) FILTER (WHERE reversal_reimbursement > 0) AS positives,
           count(*) FILTER (WHERE reversal_reimbursement < 0) AS negatives,
           round(sum(reversal_reimbursement),2) AS net
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND COALESCE(reversal_reimbursement,0) <> 0
  LOOP
    RAISE NOTICE '      % positive | % negative | net $%', r.positives, r.negatives, r.net;
    RAISE NOTICE '      -- a REVERSAL is Amazon taking money back, so it should be negative';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. where could CustomerReturn reimbursements be landing? ==';
  RAISE NOTICE '   every non-zero money column in the window, so nothing hides:';
  FOR r IN
    SELECT col, v FROM (
      SELECT 'reimbursements' AS col, round(sum(COALESCE(reimbursements,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'free_replacement_refund_items' AS col, round(sum(COALESCE(free_replacement_refund_items,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'other_income' AS col, round(sum(COALESCE(other_income,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'refunds' AS col, round(sum(COALESCE(refunds,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'fba_customer_return_fees' AS col, round(sum(COALESCE(fba_customer_return_fees,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'compensated_clawback' AS col, round(sum(COALESCE(compensated_clawback,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'warehouse_lost' AS col, round(sum(COALESCE(warehouse_lost,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'warehouse_damage' AS col, round(sum(COALESCE(warehouse_damage,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
      UNION ALL
      SELECT 'reversal_reimbursement' AS col, round(sum(COALESCE(reversal_reimbursement,0)),2) AS v
      FROM public.financial_events_cache
      WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
    ) z ORDER BY abs(v) DESC
  LOOP
    RAISE NOTICE '      % $%', rpad(r.col,32), r.v;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. widen by a day each side: does the TOTAL converge? ==';
  RAISE NOTICE '   InventoryLab total for 10-18..21 was $689.89';
  FOR r IN
    SELECT 'exact 18..21' AS win,
           round(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                    +COALESCE(reimbursements,0)+COALESCE(free_replacement_refund_items,0)),2) AS reimb_only
    FROM public.financial_events_cache WHERE user_id=v_uid AND event_date BETWEEN '2026-10-18' AND '2026-10-21'
    UNION ALL
    SELECT 'shift -1 (17..20)',
           round(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                    +COALESCE(reimbursements,0)+COALESCE(free_replacement_refund_items,0)),2)
    FROM public.financial_events_cache WHERE user_id=v_uid AND event_date BETWEEN '2026-10-17' AND '2026-10-20'
    UNION ALL
    SELECT 'shift +1 (19..22)',
           round(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                    +COALESCE(reimbursements,0)+COALESCE(free_replacement_refund_items,0)),2)
    FROM public.financial_events_cache WHERE user_id=v_uid AND event_date BETWEEN '2026-10-19' AND '2026-10-22'
  LOOP
    RAISE NOTICE '      % -> $% (excludes reversals)', rpad(r.win,20), r.reimb_only;
  END LOOP;
END
$p$;
