-- READ-ONLY. Is the Keepa override actually safe, or will repair-pending-prices
-- clobber it? That function overwrites estimated_price / locked_est_price /
-- locked_from unconditionally for a pending order (index.ts ~1339) and picks
-- rows via needs_price_enrich OR needs_fee_enrich.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== are the overridden rows flagged for re-enrichment? ==';
  FOR r IN
    SELECT order_id, asin,
           COALESCE(needs_price_enrich::text,'NULL') AS npe,
           COALESCE(needs_fee_enrich::text,'NULL') AS nfe,
           COALESCE(price_enrich_status,'-') AS pes,
           COALESCE(next_enrich_after::text,'NULL') AS nea,
           COALESCE(enrich_attempts,0) AS att,
           COALESCE(fees_missing::text,'NULL') AS fm,
           estimated_price, locked_from
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_id IN ('701-1848920-5681843','702-3337276-9597036')
    ORDER BY order_id
  LOOP
    RAISE NOTICE '   % %', r.order_id, r.asin;
    RAISE NOTICE '     needs_price_enrich % | needs_fee_enrich % | status %',
      r.npe, r.nfe, r.pes;
    RAISE NOTICE '     next_enrich_after % | attempts % | fees_missing %',
      r.nea, r.att, r.fm;
    RAISE NOTICE '     est CA$% from %', r.estimated_price, r.locked_from;
    RAISE NOTICE '     AT RISK: %',
      CASE WHEN r.npe = 'true' OR r.nfe = 'true'
           THEN 'YES - repair-pending-prices will overwrite the Keepa value'
           ELSE 'no - not selected by the repair query' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many non-US pending rows carry needs_price_enrich=true? ==';
  FOR r IN
    SELECT marketplace AS mk,
           count(*) FILTER (WHERE needs_price_enrich) AS npe_true,
           count(*) FILTER (WHERE needs_fee_enrich) AS nfe_true,
           count(*) AS total
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) <> 'US'
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | needs_price_enrich % | needs_fee_enrich % | of % pending',
      rpad(r.mk,3), lpad(r.npe_true::text,3), lpad(r.nfe_true::text,3), r.total;
  END LOOP;
END
$p$;
