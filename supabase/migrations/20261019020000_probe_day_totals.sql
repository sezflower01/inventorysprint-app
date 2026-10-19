-- READ-ONLY. The order row is correct (total_sale_amount 36.43 USD,
-- estimated_price 669.62 native) and the mobile aggregation does convert
-- (getRevenueUsdWithFallback -> toUsd). So find what actually makes the day
-- total look high, and whether ANY row contributes a native figure.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== THE TIMEZONE SPLIT, which may be the whole complaint ==';
  RAISE NOTICE '   Amazon shows: purchased Sun Oct 18, 5:01 PM PDT';
  RAISE NOTICE '   that is 2026-10-19 00:01 UTC';
  RAISE NOTICE '   order_date is PACIFIC, so the sale books to Oct 18 -- which';
  RAISE NOTICE '   is "yesterday" when read on Oct 19. Correct, but it is why';
  RAISE NOTICE '   yesterday went up and today did not.';

  RAISE NOTICE '';
  RAISE NOTICE '== Oct 18 vs Oct 19, by marketplace, native sum vs USD sum ==';
  FOR r IN
    SELECT so.order_date, COALESCE(so.marketplace,'(NULL)') AS mk, count(*) AS orders,
           round(sum(CASE
             WHEN COALESCE(so.total_sale_amount,0) > 0 THEN so.total_sale_amount
             WHEN COALESCE(so.sold_price,0) > 0 THEN so.sold_price * so.quantity
             ELSE COALESCE(so.estimated_price,0) * so.quantity END)::numeric,2) AS raw_mixed,
           round(sum(CASE
             WHEN COALESCE(so.total_sale_amount,0) > 0 THEN so.total_sale_amount
             WHEN COALESCE(so.sold_price,0) > 0 THEN so.sold_price * so.quantity
             ELSE COALESCE(so.estimated_price,0) * so.quantity / COALESCE(fx.rate,1) END)::numeric,2) AS usd_correct
    FROM public.sales_orders so
    LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND so.order_date IN (DATE '2026-10-18', DATE '2026-10-19')
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '   % | % | % orders | raw(mixed) % | USD %',
      r.order_date, rpad(r.mk,6), lpad(r.orders::text,4),
      lpad(r.raw_mixed::text,10), lpad(r.usd_correct::text,9);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every non-US order on those two days, and what it contributes ==';
  FOR r IN
    SELECT so.order_date AS od, so.marketplace AS mk, so.order_id, so.asin, so.quantity AS qty,
           so.total_sale_amount AS tsa, so.sold_price, so.estimated_price AS est,
           COALESCE(so.price_source,'(none)') AS psrc,
           CASE
             WHEN COALESCE(so.total_sale_amount,0) > 0 THEN so.total_sale_amount
             WHEN COALESCE(so.sold_price,0) > 0 THEN so.sold_price * so.quantity
             ELSE COALESCE(so.estimated_price,0) * so.quantity / COALESCE(fx.rate,1)
           END AS usd_contrib,
           CASE
             WHEN COALESCE(so.total_sale_amount,0) > 0 THEN 'total_sale_amount (USD)'
             WHEN COALESCE(so.sold_price,0) > 0 THEN 'sold_price x qty (USD)'
             WHEN COALESCE(so.estimated_price,0) > 0 THEN 'estimated native -> USD'
             ELSE 'ZERO' END AS via
    FROM public.sales_orders so
    LEFT JOIN public.fx_rates fx ON fx.base='USD' AND fx.quote =
      CASE so.marketplace WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
    WHERE so.user_id = v_uid AND so.order_date IN (DATE '2026-10-18', DATE '2026-10-19')
      AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
    ORDER BY so.order_date, so.marketplace, so.order_id
  LOOP
    RAISE NOTICE '   % % % % q% | tsa % sold % est %',
      r.od, rpad(r.mk,3), r.order_id, r.asin, r.qty,
      COALESCE(r.tsa::text,'-'), COALESCE(r.sold_price::text,'-'), COALESCE(r.est::text,'-');
    RAISE NOTICE '        -> US$% via % | src %',
      round(r.usd_contrib::numeric,2), r.via, r.psrc;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no non-US orders on those days)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== KEEPA CALIBRATION: Amazon just gave ground truth on this ASIN ==';
  RAISE NOTICE '   Amazon MX$669.62 for the Oct 19 00:01 purchase.';
  RAISE NOTICE '   Keepa nearest-to-purchase is 583.92 -> % pct out',
    round((100*(583.92-669.62)/669.62)::numeric,1);
  RAISE NOTICE '   So Keepa is not uniformly HIGH -- here it is LOW. The';
  RAISE NOTICE '   purchase-time anchor fixes WHICH point is used, not the';
  RAISE NOTICE '   fact that Keepa''s Buy Box differs from what the buyer paid.';
END
$p$;
