-- READ-ONLY. sync-fbm-label-cost's guard is `channel && channel !== 'MFN'`,
-- so a NULL channel PASSES and "Check Amazon now" does run for these orders.
-- It still returns nothing. So the question is not access, it is whether these
-- 6 orders are FBM AT ALL.
--
-- If they are FBA with a missing tag, there IS no shipping label fee to find,
-- and the dialog is promising one forever because its filter is
-- `channel !== "AFN"` -- which treats NULL as FBM by default.
--
-- The cleanest evidence is fba_fee: Amazon charges an FBA fulfilment fee only
-- on FBA orders. A positive fba_fee means FBA, which means no seller-paid
-- label exists.
DO $p$
DECLARE v_uid uuid; r record; v_ids text[] := ARRAY[
  '112-7360199-5292260','111-9775100-7119447','112-1158126-2871457',
  '113-3678765-0171412','111-5481970-0090636','112-5310326-3705811'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the 6 NULL-channel orders: FBA or FBM? ==';
  FOR r IN
    SELECT so.order_id, so.order_date, so.asin,
           COALESCE(so.fba_fee,0) AS fba_fee,
           COALESCE(so.referral_fee,0) AS referral,
           COALESCE(so.total_fees,0) AS total_fees,
           COALESCE(so.fees_source,'(none)') AS fsrc,
           COALESCE(so.shipping_price,0) AS ship_charged
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.order_id = ANY(v_ids)
    ORDER BY so.order_date DESC
  LOOP
    RAISE NOTICE '   % | % | %', r.order_id, r.order_date, r.asin;
    RAISE NOTICE '        fba_fee % | referral % | total_fees % | src % | shipping charged %',
      lpad(r.fba_fee::text,7), lpad(r.referral::text,7), lpad(r.total_fees::text,7),
      rpad(r.fsrc,16), r.ship_charged;
    RAISE NOTICE '        VERDICT: %',
      CASE WHEN r.fba_fee > 0 THEN 'FBA -- Amazon charged a fulfilment fee, so NO seller label exists'
           ELSE 'no FBA fee recorded -- inconclusive from fees alone' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cross-check: how do OTHER orders of the same ASINs ship? ==';
  FOR r IN
    SELECT so.asin,
           count(*) AS orders,
           count(*) FILTER (WHERE upper(COALESCE(so.fulfillment_channel,'')) LIKE 'AFN%') AS afn,
           count(*) FILTER (WHERE upper(COALESCE(so.fulfillment_channel,'')) LIKE 'MFN%') AS mfn,
           count(*) FILTER (WHERE so.fulfillment_channel IS NULL) AS untagged
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.asin IN (SELECT asin FROM public.sales_orders
                      WHERE user_id = v_uid AND order_id = ANY(v_ids))
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | AFN % | MFN % | untagged %',
      rpad(r.asin,12), lpad(r.orders::text,4), lpad(r.afn::text,4),
      lpad(r.mfn::text,4), r.untagged;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and do those ASINs hold FBA or FBM stock? ==';
  FOR r IN
    SELECT inv.asin, COALESCE(inv.available,0) AS avail,
           COALESCE(inv.reserved,0) AS reserved, COALESCE(inv.sku,'-') AS sku
    FROM public.inventory inv
    WHERE inv.user_id = v_uid
      AND inv.asin IN (SELECT asin FROM public.sales_orders
                       WHERE user_id = v_uid AND order_id = ANY(v_ids))
    ORDER BY inv.asin
  LOOP
    RAISE NOTICE '   % | sku % | available % | reserved %',
      rpad(r.asin,12), rpad(r.sku,16), r.avail, r.reserved;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== THE DIALOG''S FILTER IS THE PROBLEM IF THESE ARE FBA ==';
  RAISE NOTICE '   FbmLabelCostDialog keeps every row where channel !== "AFN",';
  RAISE NOTICE '   so a NULL channel is shown as an FBM order awaiting a fee.';
  RAISE NOTICE '   65 pct of October orders have no channel tag (1,774 of 2,743),';
  RAISE NOTICE '   so that default is wrong far more often than it is right.';
END
$p$;
