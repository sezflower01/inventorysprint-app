-- READ-ONLY PROBE. Before changing any ROI maths, establish what the two
-- numbers being compared actually ARE.
--
-- 20261007020000 produced a result that does not fit the "large item quoted as
-- standard" story on its own:
--   * within Large Standard, Amazon billed anywhere from $2.44 to $10.61
--   * the per-tier average gap is only $0.13
--   * several of the worst misses are TINY -- 5.0 x 3.0 x 1.1 in at 0.07 lb,
--     quoted $3.86, billed $6.17
-- A 0.07 lb item is not an oversize-fee problem. So either sales_orders.fba_fee
-- is not just the fulfilment fee, or the quote is stale, or both.
--
-- Getting this wrong means shipping a "fix" that replaces one wrong number with
-- another, on the screen the seller uses to commit money. So: decompose.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== is the quote simply STALE? gap vs fee-cache age ==';
  FOR r IN
    WITH actual AS (
      SELECT so.asin, sum(so.quantity) AS units,
             sum(so.fba_fee)/NULLIF(sum(so.quantity),0) AS act,
             max(so.order_date) AS last_sold
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND' AND COALESCE(so.fba_fee,0) > 0
        AND upper(COALESCE(so.fulfillment_channel,'')) LIKE 'AFN%'
      GROUP BY so.asin
    )
    SELECT CASE
             WHEN fc.updated_at > now() - interval '30 days'  THEN '1. quoted < 30d ago'
             WHEN fc.updated_at > now() - interval '90 days'  THEN '2. 30-90d'
             WHEN fc.updated_at > now() - interval '180 days' THEN '3. 90-180d'
             ELSE                                                  '4. over 180d'
           END AS age,
           count(*) AS asins,
           round(avg(fc.fba_fee_fixed)::numeric,2) AS est,
           round(avg(a.act)::numeric,2) AS act,
           round(avg(a.act - fc.fba_fee_fixed)::numeric,2) AS gap,
           count(*) FILTER (WHERE a.act > fc.fba_fee_fixed + 0.25) AS n_under
    FROM actual a
    JOIN public.asin_fee_cache fc ON fc.user_id = v_uid AND fc.asin = a.asin AND fc.marketplace = 'US'
    WHERE fc.fba_fee_fixed > 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % ASINs | est $% vs billed $% | gap $% | % under',
      rpad(r.age, 22), lpad(r.asins::text,4), lpad(r.est::text,6),
      lpad(r.act::text,6), lpad(r.gap::text,6), r.n_under;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is the gap a DATE effect? billed fee per unit by quarter ==';
  FOR r IN
    SELECT to_char(date_trunc('quarter', so.order_date), 'YYYY-"Q"Q') AS q,
           count(*) AS orders, sum(so.quantity) AS units,
           round((sum(so.fba_fee)/NULLIF(sum(so.quantity),0))::numeric, 2) AS fee_per_unit
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND COALESCE(so.is_cancelled,false) = false
      AND so.order_id NOT LIKE '%-REFUND' AND COALESCE(so.fba_fee,0) > 0
      AND upper(COALESCE(so.fulfillment_channel,'')) LIKE 'AFN%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % orders | % units | $%/unit', r.q, lpad(r.orders::text,6), lpad(r.units::text,6), r.fee_per_unit;
  END LOOP;

  -- The decisive one: for a single badly-missed ASIN, is $6.72 ONE fee or a sum?
  RAISE NOTICE '';
  RAISE NOTICE '== B09N6FR8MT order by order (quoted $3.52, billed $6.72/unit) ==';
  FOR r IN
    SELECT so.order_id, so.order_date, so.quantity,
           round(so.sold_price::numeric,2) AS price,
           round(so.fba_fee::numeric,2) AS fba,
           round(so.referral_fee::numeric,2) AS ref,
           round(so.total_fees::numeric,2) AS tot,
           COALESCE(so.fees_source,'?') AS src
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.asin = 'B09N6FR8MT'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND'
    ORDER BY so.order_date DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % | % | qty % | $% | fba $% | ref $% | total $% | %',
      r.order_id, r.order_date, r.quantity, lpad(r.price::text,7),
      lpad(r.fba::text,6), lpad(r.ref::text,6), lpad(r.tot::text,6), r.src;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== where do sales_orders fee numbers come from at all? ==';
  FOR r IN
    SELECT COALESCE(fees_source, '(null)') AS src, count(*) AS orders,
           round(avg(fba_fee)::numeric,2) AS avg_fba,
           round(avg(total_fees)::numeric,2) AS avg_total
    FROM public.sales_orders
    WHERE user_id = v_uid AND COALESCE(is_cancelled,false) = false
      AND order_id NOT LIKE '%-REFUND' AND COALESCE(fba_fee,0) > 0
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  % | % orders | avg fba $% | avg total $%',
      rpad(r.src, 26), lpad(r.orders::text,7), r.avg_fba, r.avg_total;
  END LOOP;
END
$p$;
