-- READ-ONLY. Items 4 and 5: the monthly P&L exposure, and what a re-pull costs.
--
-- Established so far:
--   ingest  fetch-profit-loss ~line 1500: entry.reversal_reimbursement += Math.abs(amount)
--   RPC     reimbursements = reimbursements + ABS(reversal_reimbursement) + ABS(free_replacement_refund_items)
--   model   plModel INCOME_ROWS includes { label: "Reimbursements", key: "reimbursements" }
--
-- So a reversal is added to income as a positive, twice-absoluted. If Amazon
-- sends reversals negative -- which InventoryLab's own report implies, showing
-- Reimbursement_Reversal at -$7.97 -- then each row is wrong by 2x: it should
-- subtract and instead it adds.
--
-- raw_event is NULL on every row and createCacheEntry never sets it, so the
-- original sign and AdjustmentType are unrecoverable from storage. This probe
-- therefore quantifies EXPOSURE, not a confirmed error.
DO $p$
DECLARE v_uid uuid; r record; v_total numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== raw_event coverage: is provenance recoverable anywhere? ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(raw_event) AS with_raw,
           count(*) FILTER (WHERE event_type = 'adjustment') AS adjustment_rows,
           count(raw_event) FILTER (WHERE event_type = 'adjustment') AS adjustment_with_raw
    FROM public.financial_events_cache WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % FEC rows, % with raw_event', r.rows, r.with_raw;
    RAISE NOTICE '   % adjustment rows, % with raw_event', r.adjustment_rows, r.adjustment_with_raw;
    IF r.with_raw = 0 THEN
      RAISE NOTICE '   >>> raw_event is EMPTY table-wide. AdjustmentType, SellerSKU,';
      RAISE NOTICE '       Quantity and the posted TIME are all unrecoverable.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 5: reversal_reimbursement by month (the exposure) ==';
  RAISE NOTICE '   as-is = added to income; correct = subtracted; swing = 2x';
  FOR r IN
    SELECT to_char(event_date, 'YYYY-MM') AS ym,
           count(*) AS rows,
           round(sum(reversal_reimbursement), 2) AS as_is,
           round(-sum(reversal_reimbursement), 2) AS if_corrected,
           round(2 * sum(reversal_reimbursement), 2) AS swing
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND COALESCE(reversal_reimbursement,0) <> 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | as-is +% | corrected % | swing %',
      r.ym, lpad(r.rows::text,4), lpad(r.as_is::text,10),
      lpad(r.if_corrected::text,11), lpad(r.swing::text,11);
  END LOOP;

  SELECT round(sum(reversal_reimbursement),2) INTO v_total
  FROM public.financial_events_cache WHERE user_id = v_uid;
  RAISE NOTICE '   ------------------------------------------------';
  RAISE NOTICE '   TOTAL as-is +% | swing if corrected %', v_total, round(2*v_total,2);

  RAISE NOTICE '';
  RAISE NOTICE '== the same ABS() pattern on its siblings ==';
  FOR r IN
    SELECT 'free_replacement_refund_items' AS col,
           count(*) FILTER (WHERE COALESCE(free_replacement_refund_items,0) <> 0) AS rows,
           count(*) FILTER (WHERE free_replacement_refund_items < 0) AS negatives,
           round(sum(COALESCE(free_replacement_refund_items,0)),2) AS total
    FROM public.financial_events_cache WHERE user_id = v_uid
    UNION ALL
    SELECT 'compensated_clawback',
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) <> 0),
           count(*) FILTER (WHERE compensated_clawback < 0),
           round(sum(COALESCE(compensated_clawback,0)),2)
    FROM public.financial_events_cache WHERE user_id = v_uid
    UNION ALL
    SELECT 'warehouse_lost',
           count(*) FILTER (WHERE COALESCE(warehouse_lost,0) <> 0),
           count(*) FILTER (WHERE warehouse_lost < 0),
           round(sum(COALESCE(warehouse_lost,0)),2)
    FROM public.financial_events_cache WHERE user_id = v_uid
    UNION ALL
    SELECT 'warehouse_damage',
           count(*) FILTER (WHERE COALESCE(warehouse_damage,0) <> 0),
           count(*) FILTER (WHERE warehouse_damage < 0),
           round(sum(COALESCE(warehouse_damage,0)),2)
    FROM public.financial_events_cache WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % | % rows | % negative | total %',
      rpad(r.col,32), lpad(r.rows::text,5), lpad(r.negatives::text,4), r.total;
  END LOOP;
  RAISE NOTICE '   -- warehouse_lost/damage DO branch on sign at ingest';
  RAISE NOTICE '      (if amount > 0 ... else entry.reimbursements += amount),';
  RAISE NOTICE '      so a negative there lands in reimbursements. Reversal does not.';

  RAISE NOTICE '';
  RAISE NOTICE '== ITEM 4: re-pull volume for the last 90 days ==';
  FOR r IN
    SELECT count(*) AS fec_rows,
           count(*) FILTER (WHERE event_type = 'adjustment') AS adj_rows,
           count(DISTINCT to_char(event_date,'YYYY-MM')) AS months,
           min(event_date) AS from_d, max(event_date) AS to_d
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= CURRENT_DATE - 90
  LOOP
    RAISE NOTICE '   % FEC rows over % .. % (% months)',
      r.fec_rows, r.from_d, r.to_d, r.months;
    RAISE NOTICE '   of which % are adjustment rows', r.adj_rows;
    RAISE NOTICE '   at MaxResultsPerPage=100 that is roughly % pages,',
      ceil(r.fec_rows / 100.0);
    RAISE NOTICE '   fetched one month per invocation, maxPages 500 each.';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how far back does our own cache claim to go? ==';
  FOR r IN
    SELECT min(event_date) AS first_d, max(event_date) AS last_d, count(*) AS n,
           count(DISTINCT to_char(event_date,'YYYY-MM')) AS months
    FROM public.financial_events_cache WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % .. % | % rows | % distinct months', r.first_d, r.last_d, r.n, r.months;
  END LOOP;
END
$p$;
