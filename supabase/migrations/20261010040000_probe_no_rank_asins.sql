-- READ-ONLY. Why does the analyser show "No rank" for some ASINs?
--
-- The panel shows "No rank" only when BOTH sources are empty (displayBsr() in
-- extension/panel.js): Keepa's bsr_current first, then Amazon's own rank from
-- the catalog call. Before both have answered it shows a dash instead, so
-- "No rank" is a settled answer, not a loading state.
--
-- fetch-listing-snapshot caches what Amazon said -- including nothing -- into
-- asin_brand_cache.sales_rank, precisely so this is answerable.
DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== how common is it? ==';
  FOR r IN
    SELECT count(*) AS cached,
           count(*) FILTER (WHERE sales_rank IS NULL) AS no_rank,
           count(*) FILTER (WHERE sales_rank > 0) AS ranked,
           round(100.0 * count(*) FILTER (WHERE sales_rank IS NULL) / NULLIF(count(*),0), 1) AS pct_no_rank
    FROM public.asin_brand_cache WHERE sales_rank_at IS NOT NULL
  LOOP
    RAISE NOTICE '  % ASINs asked | % ranked | % with NO rank from Amazon (% pct)',
      r.cached, r.ranked, r.no_rank, r.pct_no_rank;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what KIND of product has no rank? (ASIN prefix is a strong hint) ==';
  FOR r IN
    SELECT CASE WHEN asin ~ '^[0-9]' THEN 'ISBN / book (numeric ASIN)'
                WHEN asin ~ '^B0' THEN 'standard B0 ASIN'
                ELSE 'other' END AS kind,
           count(*) AS total,
           count(*) FILTER (WHERE sales_rank IS NULL) AS no_rank,
           round(100.0 * count(*) FILTER (WHERE sales_rank IS NULL) / NULLIF(count(*),0),1) AS pct
    FROM public.asin_brand_cache WHERE sales_rank_at IS NOT NULL
    GROUP BY 1 ORDER BY total DESC
  LOOP
    RAISE NOTICE '  % | % asked | % no rank | % pct', rpad(r.kind,28), lpad(r.total::text,6),
      lpad(r.no_rank::text,5), r.pct;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== do the no-rank ASINs still SELL? (a rank is not required to sell) ==';
  FOR r IN
    SELECT c.sales_rank IS NULL AS no_rank,
           count(DISTINCT c.asin) AS asins,
           count(DISTINCT so.asin) AS asins_with_sales,
           COALESCE(sum(so.quantity),0) AS units_sold
    FROM public.asin_brand_cache c
    LEFT JOIN public.sales_orders so
      ON so.asin = c.asin AND COALESCE(so.is_cancelled,false)=false
     AND so.order_id NOT LIKE '%-REFUND%' AND COALESCE(so.sold_price,0) > 0
    WHERE c.sales_rank_at IS NOT NULL
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  no_rank=% | % ASINs | % of them have sold | % units',
      r.no_rank, lpad(r.asins::text,6), lpad(r.asins_with_sales::text,5), r.units_sold;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== a sample of no-rank ASINs that DID sell ==';
  FOR r IN
    SELECT c.asin, left(COALESCE(i.title,''),44) AS title,
           count(*) AS orders, sum(so.quantity) AS units
    FROM public.asin_brand_cache c
    JOIN public.sales_orders so ON so.asin = c.asin
     AND COALESCE(so.is_cancelled,false)=false AND so.order_id NOT LIKE '%-REFUND%'
     AND COALESCE(so.sold_price,0) > 0
    LEFT JOIN public.inventory i ON i.asin = c.asin
    WHERE c.sales_rank_at IS NOT NULL AND c.sales_rank IS NULL
    GROUP BY 1,2 ORDER BY units DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | % | % orders | % units', r.asin, rpad(r.title,44), lpad(r.orders::text,4), r.units;
  END LOOP;
END
$p$;
