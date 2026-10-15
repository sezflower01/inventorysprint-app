-- READ-ONLY. The candidate I was asked to test and did not: KEEPA PRICE as
-- the estimate for CA/MX/BR. First, what Keepa data do we actually hold, and
-- does any of it cover a non-US marketplace?
DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== columns of each Keepa price table ==';
  FOR r IN
    SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('keepa_price_cache','keepa_price_history_cache',
                         'keepa_products','keepa_simple_products','keepa_items')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  %:', r.table_name;
    RAISE NOTICE '    %', left(r.cols, 400);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== row counts ==';
  FOR r IN
    SELECT 'keepa_price_cache' AS t, count(*) AS n FROM public.keepa_price_cache
    UNION ALL SELECT 'keepa_price_history_cache', count(*) FROM public.keepa_price_history_cache
    UNION ALL SELECT 'keepa_products', count(*) FROM public.keepa_products
    UNION ALL SELECT 'keepa_simple_products', count(*) FROM public.keepa_simple_products
    UNION ALL SELECT 'keepa_items', count(*) FROM public.keepa_items
    ORDER BY 1
  LOOP
    RAISE NOTICE '  % | % rows', rpad(r.t, 28), r.n;
  END LOOP;
END
$p$;
