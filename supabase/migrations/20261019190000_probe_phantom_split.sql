-- READ-ONLY. My "329.01 of phantom FBA fees" was WRONG and this quantifies
-- the real picture.
--
-- sync-sales-orders:1097 does this ON PURPOSE for an FBM order:
--   "FBM: Bundle ALL fees into fba_fee (FBA/FBM column), zero referral/closing"
-- so on an MFN row, fba_fee is a BUNDLED TOTAL, not an FBA fulfilment fee. A
-- row with referral_fee = 0 and fba_fee > 0 is that bundle working correctly.
--
-- The rows worth questioning are the ones where fba_fee was quoted as a real
-- FBA fee because the channel was unknown AT THE TIME -- those have a non-zero
-- referral_fee alongside it, which the FBM path would have zeroed.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the 67 rows split by whether the FBM bundle was applied ==';
  FOR r IN
    SELECT COALESCE(fees_source,'(none)') AS fsrc,
           CASE WHEN COALESCE(referral_fee,0) = 0 THEN 'bundled (referral zeroed) = BY DESIGN'
                ELSE 'NOT bundled (referral present) = quoted as FBA' END AS kind,
           count(*) AS rows,
           round(sum(COALESCE(fba_fee,0))::numeric,2) AS fba_total,
           round(sum(COALESCE(referral_fee,0))::numeric,2) AS referral_total,
           round(sum(COALESCE(shipping_label_fee,0))::numeric,2) AS label_total
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1,2 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | %', rpad(r.fsrc,16), r.kind;
    RAISE NOTICE '        % rows | fba % | referral % | label %',
      lpad(r.rows::text,4), lpad(r.fba_total::text,8),
      lpad(r.referral_total::text,8), r.label_total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== totals: how much is genuinely questionable? ==';
  FOR r IN
    SELECT count(*) FILTER (WHERE COALESCE(referral_fee,0) = 0) AS bundled_rows,
           round(sum(COALESCE(fba_fee,0)) FILTER (WHERE COALESCE(referral_fee,0) = 0)::numeric,2) AS bundled_fba,
           count(*) FILTER (WHERE COALESCE(referral_fee,0) > 0) AS suspect_rows,
           round(sum(COALESCE(fba_fee,0)) FILTER (WHERE COALESCE(referral_fee,0) > 0)::numeric,2) AS suspect_fba
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
      AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   BY DESIGN     % rows | fba % (a bundled FBM total, correct)',
      r.bundled_rows, r.bundled_fba;
    RAISE NOTICE '   QUESTIONABLE  % rows | fba % (quoted as FBA on a self-shipped order)',
      r.suspect_rows, r.suspect_fba;
    RAISE NOTICE '';
    RAISE NOTICE '   So my earlier "329.01 phantom" conflated the two. The';
    RAISE NOTICE '   questionable figure is % , not 329.01.', r.suspect_fba;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== DOES THE P&L SEE ANY OF IT? ==';
  FOR r IN
    SELECT count(DISTINCT fec.amazon_order_id) AS orders_in_fec,
           round(sum(COALESCE(fec.fba_fees,0))::numeric,2) AS fec_fba_total
    FROM public.financial_events_cache fec
    WHERE fec.user_id = v_uid
      AND fec.amazon_order_id IN (
        SELECT order_id FROM public.sales_orders
        WHERE user_id = v_uid AND COALESCE(shipping_label_fee,0) > 0
          AND COALESCE(fba_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%')
  LOOP
    RAISE NOTICE '   % of the 67 appear in financial_events_cache', r.orders_in_fec;
    RAISE NOTICE '   Amazon-billed fba_fees there total %', r.fec_fba_total;
    RAISE NOTICE '';
    RAISE NOTICE '   The P&L reads ONLY financial_events_cache, so whatever';
    RAISE NOTICE '   sales_orders.fba_fee says cannot reach it. If the figure';
    RAISE NOTICE '   above is ~0, Amazon never billed an FBA fee on these and';
    RAISE NOTICE '   only the per-order ROI on Live Sales is affected.';
  END LOOP;
END
$p$;
