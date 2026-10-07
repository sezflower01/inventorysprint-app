-- READ-ONLY PROBE. The seller is right about the target: the screen should show
-- CA$34.13 converted to USD (about $24), not an estimate derived from the US
-- list price.
--
-- Amazon's Orders API withholds ItemPrice while an order is Pending -- the row
-- has item_price 0 -- which is the whole reason an estimator exists. So the
-- question is not "read the real price" but "do we hold a CANADIAN price for
-- this ASIN anywhere", instead of converting the US one.
--
-- sync-sales-orders already names the places it looks for a local price:
-- asin_my_price_cache, order_price_snapshots, estimated, sold, and
-- repricer_assignment -- and logs "using US inventory ... THIS MAY BE
-- INACCURATE!" when all five are empty. Find out which of them actually has a
-- CA number for B002HJ4HSS.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== asin_my_price_cache: does it exist, and what is in it for CA? ==';
  FOR r IN SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'asin_my_price_cache' LOOP
    RAISE NOTICE '  columns: %', r.cols;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no asin_my_price_cache table)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== asin_my_price_cache rows for B002HJ4HSS ==';
  FOR r IN
    SELECT COALESCE(marketplace_id,'-') AS mp, my_price, COALESCE(currency,'-') AS cur,
           COALESCE(source,'-') AS src, COALESCE(seller_sku,'-') AS sku, fetched_at
    FROM public.asin_my_price_cache WHERE user_id = v_uid AND asin = 'B002HJ4HSS'
  LOOP
    RAISE NOTICE '  marketplace_id % | my_price % | currency % | source % | sku % | fetched %',
      rpad(r.mp, 16), lpad(r.my_price::text, 9), rpad(r.cur, 5), rpad(r.src, 16), rpad(r.sku, 14), r.fetched_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no asin_my_price_cache row for this ASIN at all)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== coverage: how many ASINs have a CA-native price cached? ==';
  FOR r IN
    SELECT COALESCE(marketplace_id,'-') AS mp, COALESCE(currency,'(null)') AS cur,
           count(*) AS rows, round(avg(my_price)::numeric,2) AS avg_price,
           max(fetched_at) AS newest
    FROM public.asin_my_price_cache WHERE user_id = v_uid
    GROUP BY 1,2 ORDER BY rows DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | currency % | % rows | avg % | newest %',
      rpad(r.mp, 16), rpad(r.cur, 6), lpad(r.rows::text, 6), lpad(r.avg_price::text, 9), r.newest;
  END LOOP;

  RAISE NOTICE '== what did this ASIN SELL for on CA before, in native currency? ==';
  FOR r IN
    SELECT order_id, order_date, quantity, sold_price, estimated_price,
           COALESCE(price_source,'?') AS psrc
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B002HJ4HSS'
      AND upper(COALESCE(marketplace,'')) = 'CA'
      AND order_id NOT LIKE '%-REFUND'
    ORDER BY order_date DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % | % | q% | sold % | est % | %',
      r.order_id, r.order_date, r.quantity,
      lpad(COALESCE(r.sold_price::text,'-'), 8),
      lpad(COALESCE(r.estimated_price::text,'-'), 8), r.psrc;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (never sold on CA before this order)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== and on US, for comparison ==';
  FOR r IN
    SELECT count(*) AS orders, round(avg(sold_price)::numeric,2) AS avg_sold,
           max(order_date) AS last_sold
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B002HJ4HSS'
      AND upper(COALESCE(marketplace,'')) = 'US'
      AND COALESCE(sold_price,0) > 0 AND order_id NOT LIKE '%-REFUND'
  LOOP
    RAISE NOTICE '  % US orders | avg sold $% | last %', r.orders, r.avg_sold, r.last_sold;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== across ALL CA orders: how close is a converted US price to the truth? ==';
  RAISE NOTICE '   (the question that decides whether a CA-native price is worth plumbing in)';
  FOR r IN
    SELECT count(*) AS settled_ca_orders,
           round(avg(so.sold_price)::numeric, 2) AS avg_ca_sold_native,
           round(avg(inv.my_price * fx.rate)::numeric, 2) AS avg_us_price_as_cad,
           round((100 * avg((inv.my_price * fx.rate - so.sold_price) / NULLIF(so.sold_price,0)))::numeric, 1) AS err_pct
    FROM public.sales_orders so
    JOIN public.inventory inv ON inv.user_id = so.user_id AND inv.asin = so.asin
    JOIN public.fx_rates fx ON fx.base = 'USD' AND fx.quote = 'CAD'
    WHERE so.user_id = v_uid
      AND upper(COALESCE(so.marketplace,'')) = 'CA'
      AND COALESCE(so.sold_price,0) > 0
      AND COALESCE(inv.my_price,0) > 0
      AND so.order_id NOT LIKE '%-REFUND'
      AND so.order_date > current_date - 180
  LOOP
    RAISE NOTICE '   % settled CA orders | actually sold CA$% | US price converted CA$% | off by % pct',
      r.settled_ca_orders, r.avg_ca_sold_native, r.avg_us_price_as_cad, r.err_pct;
  END LOOP;
END
$p$;
