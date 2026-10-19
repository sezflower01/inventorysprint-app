-- READ-ONLY. New MX order 701-8676794-7473022 (B0C8Z7L2LQ, q1, Amazon
-- MX$669.62, purchased 2026-10-18 17:01 PDT = 2026-10-19 00:01 UTC).
-- Complaint: mobile sales did not convert to USD, and yesterday's total looks
-- high. MX$669.62 / 18.3835 should read US$36.42; if it reads 669.62 the
-- marketplace tag or the conversion is at fault.
DO $p$
DECLARE v_uid uuid; r record; v_mxn numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_mxn FROM public.fx_rates WHERE base='USD' AND quote='MXN' LIMIT 1;
  RAISE NOTICE '== USD/MXN % | MX$669.62 should read US$% ==',
    v_mxn, round((669.62/v_mxn)::numeric,2);

  RAISE NOTICE '';
  RAISE NOTICE '== 1. the new order ==';
  FOR r IN
    SELECT order_id, asin, sku, quantity AS qty,
           COALESCE(marketplace,'(NULL)') AS mk,
           sold_price, item_price, total_sale_amount, estimated_price,
           COALESCE(price_source,'(none)') AS psrc,
           COALESCE(price_confidence,'(none)') AS pconf,
           referral_fee, fba_fee, total_fees, COALESCE(fees_source,'(none)') AS fsrc,
           order_status, order_date, purchase_timestamp_utc, created_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-8676794-7473022'
  LOOP
    RAISE NOTICE '   % % q% | marketplace % <- MUST be MX for conversion',
      r.order_id, r.asin, r.qty, r.mk;
    RAISE NOTICE '   sold % | item % | total_sale % | estimated %',
      r.sold_price, COALESCE(r.item_price::text,'NULL'),
      COALESCE(r.total_sale_amount::text,'NULL'), COALESCE(r.estimated_price::text,'NULL');
    RAISE NOTICE '   price_source % | confidence %', r.psrc, r.pconf;
    RAISE NOTICE '   fees ref % fba % total % src %',
      COALESCE(r.referral_fee::text,'NULL'), COALESCE(r.fba_fee::text,'NULL'),
      COALESCE(r.total_fees::text,'NULL'), r.fsrc;
    RAISE NOTICE '   status % | order_date % | purchase_utc %',
      r.order_status, r.order_date, r.purchase_timestamp_utc;
    RAISE NOTICE '   created_at % (lag %)', r.created_at,
      (r.created_at - r.purchase_timestamp_utc);
    RAISE NOTICE '';
    IF r.mk = '(NULL)' OR r.mk = 'US' THEN
      RAISE NOTICE '   >>> MARKETPLACE IS % -- toUsd() would divide by 1, so a', r.mk;
      RAISE NOTICE '   >>> native MXN figure is displayed verbatim as dollars.';
    ELSE
      RAISE NOTICE '   >>> marketplace is %, so conversion should apply.', r.mk;
      RAISE NOTICE '   >>> est % / % = US$%', COALESCE(r.estimated_price::text,'NULL'),
        v_mxn, COALESCE(round((r.estimated_price/v_mxn)::numeric,2)::text,'-');
    END IF;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (order not ingested yet)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. AMAZON JUST VALIDATED THE PURCHASE-TIME ANCHOR ==';
  RAISE NOTICE '   Same ASIN B0C8Z7L2LQ, two MX orders a week apart:';
  FOR r IN
    SELECT so.order_id, so.purchase_timestamp_utc AS bought, so.estimated_price AS est,
      (SELECT (e->>'v')::numeric FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin='B0C8Z7L2LQ' AND k.marketplace='MX' AND (e->>'v')::numeric > 0
       ORDER BY abs(EXTRACT(epoch FROM ((e->>'t')::timestamptz - so.purchase_timestamp_utc)))
       LIMIT 1) AS nearest,
      (SELECT (e->>'v')::numeric FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin='B0C8Z7L2LQ' AND k.marketplace='MX' AND (e->>'v')::numeric > 0
       ORDER BY (e->>'t') DESC LIMIT 1) AS newest
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.asin = 'B0C8Z7L2LQ' AND so.marketplace = 'MX'
    ORDER BY so.purchase_timestamp_utc
  LOOP
    RAISE NOTICE '   % | bought % | stored est % | nearest % | newest %',
      r.order_id, r.bought, COALESCE(r.est::text,'NULL'),
      COALESCE(r.nearest::text,'-'), COALESCE(r.newest::text,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. YESTERDAY (Oct 18) by marketplace: native vs USD ==';
  FOR r IN
    SELECT COALESCE(so.marketplace,'(NULL)') AS mk, count(*) AS orders,
           round(sum(COALESCE(NULLIF(so.total_sale_amount,0),
                              NULLIF(so.sold_price,0)*so.quantity,
                              COALESCE(so.estimated_price,0)*so.quantity))::numeric,2) AS raw_sum,
           round(sum(COALESCE(NULLIF(so.total_sale_amount,0),
                              NULLIF(so.sold_price,0)*so.quantity,
                              COALESCE(so.estimated_price,0)*so.quantity)
                     / COALESCE(fx.rate,1))::numeric,2) AS usd_sum
    FROM public.sales_orders so
    LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND so.order_date = DATE '2026-10-18'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | raw (mixed ccy) % | converted USD %',
      rpad(r.mk,6), lpad(r.orders::text,4), lpad(r.raw_sum::text,10), r.usd_sum;
  END LOOP;
  RAISE NOTICE '   -> the gap between raw and converted is what an unconverted';
  RAISE NOTICE '      non-US row adds to a day total.';
END
$p$;
