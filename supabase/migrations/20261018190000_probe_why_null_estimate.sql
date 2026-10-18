-- READ-ONLY. Step 3: why did this order arrive with estimated_price NULL?
--
-- fetch-live-orders DOES have a non-US chain (index.ts ~2530): Priority 1
-- Listings API by SKU -> native price tagged seller_derived:listings_api_<mp>;
-- Priority 2 Pricing API -> native, tagged hint:pricing_api_<mp>; then a
-- generic inventory fallback. Our row has price_source NULL and
-- price_calc_mode NULL, so NO branch fired at all -- which points at the
-- insert deferring pricing rather than at the chain failing.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== enrichment state of the order ==';
  FOR r IN
    SELECT COALESCE(needs_price_enrich::text,'-') AS npe,
           COALESCE(price_enrich_status,'-') AS pstat,
           COALESCE(enrich_attempts,0) AS att,
           COALESCE(last_enrich_attempt_at::text,'never') AS latt,
           COALESCE(last_enrich_error,'(none)') AS lerr,
           COALESCE(next_enrich_after::text,'NULL') AS nea,
           COALESCE(price_attempt_count,0) AS pcount,
           COALESCE(price_last_attempt_at::text,'never') AS platt,
           COALESCE(price_last_error,'(none)') AS perr,
           COALESCE(seller_sku,'NULL') AS ssku, sku, created_at
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   needs_price_enrich % | status % | attempts %', r.npe, r.pstat, r.att;
    RAISE NOTICE '   last_enrich_attempt % | next_enrich_after %', r.latt, r.nea;
    RAISE NOTICE '   last_enrich_error %', r.lerr;
    RAISE NOTICE '   price_attempt_count % | last % | error %', r.pcount, r.platt, r.perr;
    RAISE NOTICE '   sku % | seller_sku % <- Priority 1 needs a SKU', r.sku, r.ssku;
    RAISE NOTICE '   created_at %', r.created_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is this normal for new non-US orders, or unique? ==';
  RAISE NOTICE '   Of non-US orders created in the last 30 days, how many had a';
  RAISE NOTICE '   price_source set at all?';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS orders,
           count(*) FILTER (WHERE price_source IS NULL) AS no_source,
           count(*) FILTER (WHERE price_source LIKE 'seller_derived:listings_api%') AS listings,
           count(*) FILTER (WHERE price_source LIKE 'hint:pricing_api%') AS pricing_hint,
           count(*) FILTER (WHERE price_source LIKE 'hint:inventory%') AS inv_hint
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) <> 'US'
      AND created_at >= now() - interval '30 days' AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | % NO source | % listings_api | % pricing hint | % inventory hint',
      rpad(r.mk,3), lpad(r.orders::text,3), lpad(r.no_source::text,3),
      lpad(r.listings::text,3), lpad(r.pricing_hint::text,3), r.inv_hint;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== PROPOSAL COVERAGE: do we hold a CA list price per ASIN? ==';
  FOR r IN
    SELECT count(DISTINCT so.asin) AS ca_asins_ordered,
           count(DISTINCT so.asin) FILTER (WHERE mp.asin IS NOT NULL) AS with_ca_myprice
    FROM public.sales_orders so
    LEFT JOIN public.asin_my_price_cache mp
      ON mp.user_id = so.user_id AND mp.asin = so.asin
         AND mp.marketplace_id = 'A2EUQ1WTGCTBG2'
    WHERE so.user_id = v_uid AND so.marketplace = 'CA'
      AND so.order_date >= current_date - 365 AND COALESCE(so.is_cancelled,false) = false
  LOOP
    RAISE NOTICE '   CA ASINs ordered in the last year: %', r.ca_asins_ordered;
    RAISE NOTICE '   of those, with a CA my-price row:   % <- proposal coverage', r.with_ca_myprice;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== PREDICTED ERROR of "fill from the CA list price" ==';
  RAISE NOTICE '   This is NOT a new measurement: seller_derived:listings_api_ca';
  RAISE NOTICE '   IS the CA list price, so the replay already scored it.';
  FOR r IN
    WITH ca AS (
      SELECT so.sold_price, so.estimated_price / NULLIF(fx.rate,1) AS est_usd
      FROM public.sales_orders so
      CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1) fx
      WHERE so.user_id = v_uid AND so.marketplace = 'CA'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.estimated_price,0) > 0
        AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
        AND so.order_date > current_date - 365
        AND so.price_source LIKE 'seller_derived:listings_api%'
    )
    SELECT count(*) AS n,
           round((100*avg(abs(est_usd - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS abs_err,
           round((100*avg((est_usd - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS bias
    FROM ca
  LOOP
    RAISE NOTICE '   settled CA orders on listings_api: % | mean ABS error % pct | bias % pct',
      r.n, r.abs_err, r.bias;
  END LOOP;
END
$p$;
