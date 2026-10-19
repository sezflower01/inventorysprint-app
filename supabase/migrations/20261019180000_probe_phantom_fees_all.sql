-- READ-ONLY. Condition 5: every order carrying BOTH a label fee and an
-- fba_fee, not just the MFN-tagged ones, and whether the P&L reads that
-- fba_fee.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== ALL orders with BOTH a label fee and an fba_fee, by channel ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS rows,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba_total,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS label_total,
           min(order_date) AS oldest, max(order_date) AS newest
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | fba % | label % | % .. %',
      rpad(r.fc,8), lpad(r.rows::text,5), lpad(r.fba_total::text,9),
      lpad(r.label_total::text,9), r.oldest, r.newest;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the full list ==';
  FOR r IN
    SELECT order_id, order_date, asin, COALESCE(fulfillment_channel,'(NULL)') AS fc,
           round(COALESCE(fba_fee,0)::numeric,2) AS fba,
           round(COALESCE(shipping_label_fee,0)::numeric,2) AS label,
           COALESCE(fees_source,'-') AS fsrc,
           COALESCE(shipping_label_fee_source,'-') AS lsrc
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
    ORDER BY order_date DESC
  LOOP
    RAISE NOTICE '   % % % % | fba % | label % | fees % | label_src %',
      r.order_id, r.order_date, rpad(r.asin,12), rpad(r.fc,6),
      lpad(r.fba::text,6), lpad(r.label::text,6), rpad(r.fsrc,16), r.lsrc;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== DOES THE P&L READ sales_orders.fba_fee? ==';
  RAISE NOTICE '   The P&L reads financial_events_cache, which has its own';
  RAISE NOTICE '   fba_fees column. Compare: is the per-order fba_fee on';
  RAISE NOTICE '   sales_orders mirrored there for these same orders?';
  FOR r IN
    SELECT count(*) AS orders_in_fec,
           round(sum(COALESCE(fec.fba_fees,0))::numeric,2) AS fec_fba_total
    FROM public.financial_events_cache fec
    WHERE fec.user_id = v_uid
      AND fec.amazon_order_id IN (
        SELECT order_id FROM public.sales_orders
        WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
          AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%')
  LOOP
    RAISE NOTICE '   % of those orders appear in financial_events_cache', r.orders_in_fec;
    RAISE NOTICE '   their fba_fees there total % (vs % on sales_orders)',
      r.fec_fba_total,
      (SELECT round(sum(COALESCE(fba_fee,0))::numeric,2) FROM public.sales_orders
       WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
         AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   -> If the FEC total is ~0, Amazon never billed an FBA fee on';
  RAISE NOTICE '      these and the sales_orders value is OUR estimate, not a';
  RAISE NOTICE '      charge. The P&L would then be unaffected, and only the';
  RAISE NOTICE '      per-order ROI on Live Sales is overstated.';
  RAISE NOTICE '   -> If it matches, Amazon DID bill both and the label fee';
  RAISE NOTICE '      needs re-examining instead.';

  RAISE NOTICE '';
  RAISE NOTICE '== which writer produced the suspect fba_fee? ==';
  FOR r IN
    SELECT COALESCE(fees_source,'(none)') AS fsrc, count(*) AS rows,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba_total
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | fba %', rpad(r.fsrc,20), lpad(r.rows::text,5), r.fba_total;
  END LOOP;
END
$p$;
