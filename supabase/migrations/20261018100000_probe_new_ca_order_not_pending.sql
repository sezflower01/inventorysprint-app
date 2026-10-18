-- READ-ONLY. Two complaints about CA order 701-0974352-2997055:
--   (a) the Keepa button says "nothing is pending"
--   (b) sales shows $9.90 against Amazon's CA$20.36
-- Amazon: purchased Sun 2026-10-18 09:49 PDT (= 16:49 UTC), q1, CA$20.36/unit,
-- ASIN B07KY25WY7, SKU NQN-BBR-MLDM, FBA, status Pending.
DO $p$
DECLARE v_uid uuid; r record; v_cad numeric; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;
  RAISE NOTICE '== now() % | USD/CAD % ==', date_trunc('second', now()), v_cad;
  RAISE NOTICE '   Amazon CA$20.36 / % = US$% expected',
    v_cad, round((20.36/v_cad)::numeric,2);
  RAISE NOTICE '   The screen shows US$9.90, which back-converts to CA$%',
    round((9.90*v_cad)::numeric,2);

  RAISE NOTICE '';
  RAISE NOTICE '== 1. is the order in sales_orders at all, and how fast? ==';
  SELECT count(*) INTO n FROM public.sales_orders
  WHERE user_id = v_uid AND order_id = '701-0974352-2997055';
  IF n = 0 THEN
    RAISE NOTICE '   NOT PRESENT -- the order has not been ingested yet.';
  ELSE
    FOR r IN
      SELECT order_id, asin, sku, seller_sku, quantity, marketplace,
             sold_price, item_price, total_sale_amount,
             estimated_price, locked_est_price,
             COALESCE(locked_from,'(none)') AS lf,
             COALESCE(price_source,'(none)') AS psrc,
             COALESCE(price_confidence,'(none)') AS pconf,
             COALESCE(price_calc_mode,'-') AS pmode,
             COALESCE(price_enrich_status,'-') AS pstat,
             referral_fee, fba_fee, total_fees,
             COALESCE(fees_source,'(none)') AS fsrc,
             COALESCE(fees_missing::text,'-') AS fmiss,
             COALESCE(needs_price_enrich::text,'-') AS npe,
             COALESCE(needs_fee_enrich::text,'-') AS nfe,
             COALESCE(is_cancelled::text,'-') AS canc,
             order_status, order_date, purchase_timestamp_utc, created_at, updated_at,
             COALESCE(fulfillment_channel,'-') AS fc
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
    LOOP
      RAISE NOTICE '   asin % | sku % / %', r.asin, r.sku, r.seller_sku;
      RAISE NOTICE '   marketplace % | quantity % | channel % | cancelled %',
        r.marketplace, r.quantity, r.fc, r.canc;
      RAISE NOTICE '   sold_price % | item_price % | total_sale_amount %',
        r.sold_price, COALESCE(r.item_price::text,'NULL'), COALESCE(r.total_sale_amount::text,'NULL');
      RAISE NOTICE '   estimated_price % | locked_est_price % | locked_from %',
        COALESCE(r.estimated_price::text,'NULL'), COALESCE(r.locked_est_price::text,'NULL'), r.lf;
      RAISE NOTICE '   price_source % | confidence % | calc_mode % | enrich %',
        r.psrc, r.pconf, r.pmode, r.pstat;
      RAISE NOTICE '   fees: referral % | fba % | total % | source % | missing %',
        COALESCE(r.referral_fee::text,'NULL'), COALESCE(r.fba_fee::text,'NULL'),
        COALESCE(r.total_fees::text,'NULL'), r.fsrc, r.fmiss;
      RAISE NOTICE '   needs_price_enrich % | needs_fee_enrich %', r.npe, r.nfe;
      RAISE NOTICE '   order_status % | order_date %', r.order_status, r.order_date;
      RAISE NOTICE '   purchase_utc %', r.purchase_timestamp_utc;
      RAISE NOTICE '   created_at   % <- DETECTION LATENCY: %',
        r.created_at, (r.created_at - r.purchase_timestamp_utc);
      RAISE NOTICE '   updated_at   %', r.updated_at;
      RAISE NOTICE '';
      RAISE NOTICE '   WOULD THE KEEPA BUTTON FIND IT?';
      RAISE NOTICE '     the function requires ALL of:';
      RAISE NOTICE '       marketplace = the pressed badge   -> % %',
        r.marketplace, CASE WHEN r.marketplace = 'CA' THEN 'OK' ELSE 'MISMATCH' END;
      RAISE NOTICE '       is_cancelled = false              -> % %',
        r.canc, CASE WHEN r.canc = 'false' THEN 'OK' ELSE 'FAILS (NULL is excluded by .eq)' END;
      RAISE NOTICE '       sold_price is null or 0           -> % %',
        r.sold_price, CASE WHEN COALESCE(r.sold_price,0) = 0 THEN 'OK' ELSE 'FAILS' END;
      RAISE NOTICE '       estimated_price > 0               -> % %',
        COALESCE(r.estimated_price::text,'NULL'),
        CASE WHEN COALESCE(r.estimated_price,0) > 0 THEN 'OK' ELSE 'FAILS -- THIS IS THE BLOCKER' END;
      RAISE NOTICE '';
      RAISE NOTICE '   WHERE DOES US$9.90 COME FROM?';
      RAISE NOTICE '     estimated_price as USD : %',
        COALESCE(round((r.estimated_price/v_cad)::numeric,2)::text,'n/a');
      RAISE NOTICE '     estimated_price raw    : % (if read as USD directly)',
        COALESCE(r.estimated_price::text,'NULL');
    END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. our own prices for this ASIN -- is a US price standing in? ==';
  FOR r IN
    SELECT COALESCE(marketplace_id,'-') AS mp, my_price, COALESCE(currency,'-') AS cur,
           COALESCE(source,'-') AS src, COALESCE(seller_sku,'-') AS sku, fetched_at
    FROM public.asin_my_price_cache
    WHERE user_id = v_uid AND asin = 'B07KY25WY7' ORDER BY fetched_at DESC
  LOOP
    RAISE NOTICE '   % | my_price % % | % | sku % | %',
      rpad(r.mp,16), lpad(r.my_price::text,8), r.cur, rpad(r.src,14), r.sku, r.fetched_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no my-price cache rows for this ASIN)'; END IF;

  FOR r IN
    SELECT sku, price, my_price, cost FROM public.inventory
    WHERE user_id = v_uid AND asin = 'B07KY25WY7'
  LOOP
    RAISE NOTICE '   inventory (one pool, USD) sku % | price % | my_price % | cost %',
      r.sku, COALESCE(r.price::text,'-'), COALESCE(r.my_price::text,'-'), COALESCE(r.cost::text,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. fee cache for this ASIN -- why no fees? ==';
  FOR r IN
    SELECT marketplace AS mk, referral_rate, fba_fee_fixed,
           COALESCE(fee_source,'-') AS src, COALESCE(last_error,'(none)') AS lerr, updated_at
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND asin = 'B07KY25WY7' ORDER BY marketplace
  LOOP
    RAISE NOTICE '   % | rate % | fba_fee_fixed % | % | %',
      rpad(r.mk,3), COALESCE(r.referral_rate::text,'NULL'),
      COALESCE(r.fba_fee_fixed::text,'NULL'), rpad(r.src,14), r.updated_at;
    RAISE NOTICE '        last_error %', r.lerr;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO fee-cache row in ANY marketplace for B07KY25WY7.';
    RAISE NOTICE '   isFeeCacheMissingForNonUs fires on exactly this: non-US row,';
    RAISE NOTICE '   no stored fees, no cache entry -> "Missing CA fee cache", ROI hidden.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. how long do new non-US orders normally take to appear? ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS orders,
           round(avg(EXTRACT(epoch FROM (created_at - purchase_timestamp_utc))/60)::numeric,1) AS avg_min,
           round(min(EXTRACT(epoch FROM (created_at - purchase_timestamp_utc))/60)::numeric,1) AS min_min,
           round(max(EXTRACT(epoch FROM (created_at - purchase_timestamp_utc))/60)::numeric,1) AS max_min
    FROM public.sales_orders
    WHERE user_id = v_uid AND purchase_timestamp_utc > now() - interval '14 days'
      AND purchase_timestamp_utc IS NOT NULL AND created_at IS NOT NULL
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | detection lag avg % min (min % / max %)',
      rpad(r.mk,3), lpad(r.orders::text,5), r.avg_min, r.min_min, r.max_min;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 5. how many pending non-US rows have NO estimate (button blind spot)? ==';
  FOR r IN
    SELECT marketplace AS mk,
           count(*) FILTER (WHERE COALESCE(estimated_price,0) > 0) AS with_est,
           count(*) FILTER (WHERE COALESCE(estimated_price,0) = 0) AS no_est,
           count(*) AS total
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) <> 'US'
      AND COALESCE(sold_price,0) = 0 AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % have an estimate | % have NONE (button cannot see these) | % total',
      rpad(r.mk,3), lpad(r.with_est::text,3), lpad(r.no_est::text,3), r.total;
  END LOOP;
END
$p$;
