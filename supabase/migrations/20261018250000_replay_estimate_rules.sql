-- READ-ONLY. Item 3: replay both estimate rules against SETTLED non-US orders,
-- using the price AS OF PURCHASE. Nothing applied.
--
--   Rule 1  last settled price, same ASIN + marketplace, strictly BEFORE this
--           order's purchase time
--   Rule 2  the listing price as of purchase, from asin_price_history
--
-- I assumed Rule 2 was unmeasurable because asin_my_price_cache holds only the
-- current value. That was wrong: asin_price_history exists and carries exactly
-- what is needed -- asin, marketplace, captured_at, listing_price,
-- buybox_price, currency_code, price_usd, fx_rate. So both rules can be scored
-- honestly against the price that was live when the order was placed, instead
-- of today's price replayed against last month's sale (which would flatter
-- Rule 2 for free).
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== asin_price_history coverage ==';
  FOR r IN
    SELECT COALESCE(marketplace,'(null)') AS mk, count(*) AS rows,
           count(DISTINCT asin) AS asins,
           count(*) FILTER (WHERE COALESCE(listing_price,0) > 0) AS with_listing,
           min(captured_at)::date AS oldest, max(captured_at)::date AS newest
    FROM public.asin_price_history WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | % rows | % asins | % with listing_price | % .. %',
      rpad(r.mk,4), lpad(r.rows::text,6), lpad(r.asins::text,5),
      lpad(r.with_listing::text,6), r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== BOTH RULES, settled non-US orders, last 365 days ==';
  RAISE NOTICE '   sold_price is USD; listing_price is native, so it is';
  RAISE NOTICE '   converted with the fx_rate captured ALONGSIDE it, not today''s.';
  RAISE NOTICE '';
  FOR r IN
    WITH settled AS (
      SELECT so.order_id, so.asin, so.marketplace, so.sold_price,
             COALESCE(so.purchase_timestamp_utc, so.order_date::timestamptz) AS bought
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), scored AS (
      SELECT s.*,
        -- Rule 1: last settled price before this purchase (already USD)
        (SELECT p.sold_price FROM public.sales_orders p
         WHERE p.user_id = v_uid AND p.asin = s.asin AND p.marketplace = s.marketplace
           AND COALESCE(p.sold_price,0) > 0
           AND COALESCE(p.purchase_timestamp_utc, p.order_date::timestamptz) < s.bought
           AND p.order_id NOT LIKE '%-REFUND%' AND COALESCE(p.is_cancelled,false) = false
         ORDER BY COALESCE(p.purchase_timestamp_utc, p.order_date::timestamptz) DESC
         LIMIT 1) AS r1_usd,
        -- Rule 2: listing price as of purchase, converted with ITS OWN fx_rate
        (SELECT CASE
                  WHEN COALESCE(h.fx_rate,0) > 0 THEN h.listing_price / h.fx_rate
                  WHEN COALESCE(h.price_usd,0) > 0 THEN h.price_usd
                  ELSE NULL END
         FROM public.asin_price_history h
         WHERE h.user_id = v_uid AND h.asin = s.asin AND h.marketplace = s.marketplace
           AND COALESCE(h.listing_price,0) > 0 AND h.captured_at <= s.bought
         ORDER BY h.captured_at DESC LIMIT 1) AS r2_usd
      FROM settled s
    )
    SELECT marketplace AS mk, count(*) AS settled,
           count(*) FILTER (WHERE r1_usd > 0) AS r1_cov,
           round((100*avg(abs(r1_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE r1_usd > 0))::numeric,1) AS r1_err,
           round((100*avg((r1_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE r1_usd > 0))::numeric,1) AS r1_bias,
           count(*) FILTER (WHERE r2_usd > 0) AS r2_cov,
           round((100*avg(abs(r2_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE r2_usd > 0))::numeric,1) AS r2_err,
           round((100*avg((r2_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE r2_usd > 0))::numeric,1) AS r2_bias,
           count(*) FILTER (WHERE COALESCE(r1_usd,0) = 0 AND COALESCE(r2_usd,0) = 0) AS neither
    FROM scored GROUP BY 1
    UNION ALL
    SELECT 'ALL', count(*),
           count(*) FILTER (WHERE r1_usd > 0),
           round((100*avg(abs(r1_usd - sold_price)/NULLIF(sold_price,0)) FILTER (WHERE r1_usd > 0))::numeric,1),
           round((100*avg((r1_usd - sold_price)/NULLIF(sold_price,0)) FILTER (WHERE r1_usd > 0))::numeric,1),
           count(*) FILTER (WHERE r2_usd > 0),
           round((100*avg(abs(r2_usd - sold_price)/NULLIF(sold_price,0)) FILTER (WHERE r2_usd > 0))::numeric,1),
           round((100*avg((r2_usd - sold_price)/NULLIF(sold_price,0)) FILTER (WHERE r2_usd > 0))::numeric,1),
           count(*) FILTER (WHERE COALESCE(r1_usd,0) = 0 AND COALESCE(r2_usd,0) = 0)
    FROM scored ORDER BY 1
  LOOP
    RAISE NOTICE '   %', rpad(r.mk,4);
    RAISE NOTICE '     settled % | RULE 1 last-settled: % covered, abs err % pct, bias % pct',
      lpad(r.settled::text,4), lpad(r.r1_cov::text,4),
      lpad(COALESCE(r.r1_err::text,'-'),6), COALESCE(r.r1_bias::text,'-');
    RAISE NOTICE '              | RULE 2 list@purchase: % covered, abs err % pct, bias % pct',
      lpad(r.r2_cov::text,4), lpad(COALESCE(r.r2_err::text,'-'),6), COALESCE(r.r2_bias::text,'-');
    RAISE NOTICE '              | neither rule can price: %', r.neither;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== THE CHAIN: Rule 1, falling back to Rule 2 ==';
  FOR r IN
    WITH settled AS (
      SELECT so.asin, so.marketplace, so.sold_price,
             COALESCE(so.purchase_timestamp_utc, so.order_date::timestamptz) AS bought
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), scored AS (
      SELECT s.*,
        (SELECT p.sold_price FROM public.sales_orders p
         WHERE p.user_id = v_uid AND p.asin = s.asin AND p.marketplace = s.marketplace
           AND COALESCE(p.sold_price,0) > 0
           AND COALESCE(p.purchase_timestamp_utc, p.order_date::timestamptz) < s.bought
           AND p.order_id NOT LIKE '%-REFUND%' AND COALESCE(p.is_cancelled,false) = false
         ORDER BY COALESCE(p.purchase_timestamp_utc, p.order_date::timestamptz) DESC LIMIT 1) AS r1,
        (SELECT CASE WHEN COALESCE(h.fx_rate,0) > 0 THEN h.listing_price / h.fx_rate
                     WHEN COALESCE(h.price_usd,0) > 0 THEN h.price_usd ELSE NULL END
         FROM public.asin_price_history h
         WHERE h.user_id = v_uid AND h.asin = s.asin AND h.marketplace = s.marketplace
           AND COALESCE(h.listing_price,0) > 0 AND h.captured_at <= s.bought
         ORDER BY h.captured_at DESC LIMIT 1) AS r2
      FROM settled s
    ), chained AS (
      SELECT *, COALESCE(NULLIF(r1,0), NULLIF(r2,0)) AS est,
             CASE WHEN r1 > 0 THEN 'rule1_last_settled'
                  WHEN r2 > 0 THEN 'rule2_list_at_purchase' ELSE 'none' END AS tier
      FROM scored
    )
    SELECT tier, count(*) AS orders,
           round((100*avg(abs(est - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS abs_err,
           round((100*avg((est - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS bias
    FROM chained GROUP BY 1
    UNION ALL
    SELECT 'CHAINED TOTAL', count(*),
           round((100*avg(abs(est - sold_price)/NULLIF(sold_price,0)))::numeric,1),
           round((100*avg((est - sold_price)/NULLIF(sold_price,0)))::numeric,1)
    FROM chained WHERE est > 0
    ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % orders | abs err % pct | bias % pct',
      rpad(r.tier,24), lpad(r.orders::text,4),
      lpad(COALESCE(r.abs_err::text,'-'),6), COALESCE(r.bias::text,'-');
  END LOOP;
END
$p$;
