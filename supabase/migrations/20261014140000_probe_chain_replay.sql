-- READ-ONLY. Does C-then-D-then-A beat C alone? Non-US only.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== CHAIN REPLAY, settled CA orders: C -> D -> A ==';
  FOR r IN
    WITH ca AS (
      SELECT so.order_id, so.asin, so.sold_price, so.order_date,
             so.estimated_price / NULLIF(fx.rate,1) AS a_usd, fx.rate AS fx
      FROM public.sales_orders so
      CROSS JOIN (SELECT rate FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1) fx
      WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,''))='CA'
        AND COALESCE(so.sold_price,0) > 0 AND COALESCE(so.is_cancelled,false)=false
        AND so.order_id NOT LIKE '%-REFUND%' AND so.order_date > current_date - 365
    ), cand AS (
      SELECT c.*,
        (SELECT p.sold_price FROM public.sales_orders p
         WHERE p.user_id=v_uid AND p.asin=c.asin AND upper(COALESCE(p.marketplace,''))='CA'
           AND COALESCE(p.sold_price,0)>0 AND p.order_date < c.order_date
           AND p.order_id NOT LIKE '%-REFUND%'
         ORDER BY p.order_date DESC LIMIT 1) AS c_usd,
        (SELECT (pt.elem->>'v')::numeric / NULLIF(c.fx,1)
         FROM public.keepa_price_history_cache k
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) AS pt(elem)
         WHERE k.asin=c.asin AND k.marketplace='CA' AND (pt.elem->>'v')::numeric > 0
         ORDER BY abs(EXTRACT(epoch FROM ((pt.elem->>'t')::timestamptz - c.order_date::timestamptz)))
         LIMIT 1) AS d_usd
      FROM ca c
    ), chain AS (
      SELECT *, COALESCE(NULLIF(c_usd,0), NULLIF(d_usd,0), NULLIF(a_usd,0)) AS chained,
             CASE WHEN c_usd > 0 THEN 'C last settled'
                  WHEN d_usd > 0 THEN 'D keepa buybox'
                  WHEN a_usd > 0 THEN 'A listings_api' ELSE 'none' END AS tier
      FROM cand
    )
    SELECT tier, count(*) AS orders,
           round((100*avg(abs(chained - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS abs_err,
           round((100*avg((chained - sold_price)/NULLIF(sold_price,0)))::numeric,1) AS bias
    FROM chain GROUP BY 1
    UNION ALL
    SELECT 'ALL (chained)', count(*),
           round((100*avg(abs(chained - sold_price)/NULLIF(sold_price,0)))::numeric,1),
           round((100*avg((chained - sold_price)/NULLIF(sold_price,0)))::numeric,1)
    FROM chain WHERE chained > 0
    ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % orders | abs err % pct | bias % pct',
      rpad(r.tier, 15), lpad(r.orders::text, 4), lpad(r.abs_err::text, 6), r.bias;
  END LOOP;
END
$p$;
