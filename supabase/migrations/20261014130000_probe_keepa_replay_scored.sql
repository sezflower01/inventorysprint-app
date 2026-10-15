-- READ-ONLY. Score Keepa as candidate D on the CA orders it covers.
--
-- The premise needs correcting first: Keepa DOES carry non-US Buy Box data.
-- keepa_price_history_cache holds a buybox series for 117 CA ASINs, 99 MX and
-- 88 BR. It is keepa_price_CACHE that is US-only.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== D REPLAY: Keepa buybox nearest the order date, CA ==';
  FOR r IN
    WITH ca AS (
      SELECT so.order_id, so.asin, so.sold_price, so.order_date,
             so.estimated_price / NULLIF(fx.rate,1) AS est_a_usd, fx.rate AS fx
      FROM public.sales_orders so
      CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1) fx
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,''))='CA'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false)=false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), d AS (
      SELECT c.*,
        (SELECT (pt.elem->>'v')::numeric
         FROM public.keepa_price_history_cache k
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) AS pt(elem)
         WHERE k.asin = c.asin AND k.marketplace = 'CA'
           AND (pt.elem->>'v') IS NOT NULL AND (pt.elem->>'v')::numeric > 0
         ORDER BY abs(EXTRACT(epoch FROM ((pt.elem->>'t')::timestamptz - c.order_date::timestamptz)))
         LIMIT 1) AS keepa_bb_native
      FROM ca c
    )
    SELECT count(*) AS orders,
           count(*) FILTER (WHERE keepa_bb_native > 0) AS covered,
           round((100*avg(abs(keepa_bb_native/fx - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE keepa_bb_native > 0))::numeric,1) AS d_abs_err,
           round((100*avg((keepa_bb_native/fx - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE keepa_bb_native > 0))::numeric,1) AS d_bias,
           round((100*avg(abs(est_a_usd - sold_price)/NULLIF(sold_price,0))
                  FILTER (WHERE keepa_bb_native > 0 AND est_a_usd > 0))::numeric,1) AS a_abs_on_same
    FROM d
  LOOP
    RAISE NOTICE '  % settled CA orders | Keepa buybox covered %', r.orders, r.covered;
    RAISE NOTICE '  D (Keepa buybox)  mean absolute error % pct | bias % pct', r.d_abs_err, r.d_bias;
    RAISE NOTICE '  A (current) on the SAME orders: % pct', r.a_abs_on_same;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the order in question, all four candidates ==';
  FOR r IN
    SELECT (SELECT (pt.elem->>'v')::numeric
            FROM public.keepa_price_history_cache k
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) AS pt(elem)
            WHERE k.asin='B00DLD1C0A' AND k.marketplace='CA'
            ORDER BY abs(EXTRACT(epoch FROM ((pt.elem->>'t')::timestamptz - now()))) LIMIT 1) AS keepa_bb,
           (SELECT (pt.elem->>'t') FROM public.keepa_price_history_cache k
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) AS pt(elem)
            WHERE k.asin='B00DLD1C0A' AND k.marketplace='CA' LIMIT 1) AS keepa_when
  LOOP
    RAISE NOTICE '  Amazon actual       CA$39.08/unit';
    RAISE NOTICE '  A listings_api      CA$49.56   (+26.8 pct)';
    RAISE NOTICE '  D Keepa buybox      CA$%   (captured %)', r.keepa_bb, r.keepa_when;
  END LOOP;
END
$p$;
