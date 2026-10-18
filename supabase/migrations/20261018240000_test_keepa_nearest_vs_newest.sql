-- READ-ONLY. Test the new NEAREST-TO-PURCHASE selection against the two CA
-- orders whose real price is known from Seller Central, and against the other
-- Keepa-touched orders for contrast.
--
--   702-5492481-4068251  B002HJ4HSS  verified CA$34.13
--   701-1848920-5681843  B00DLD1C0A  verified CA$39.08
--
-- This replicates in SQL exactly what pickPrice() now does: scan the buybox
-- track and take the point minimising |t - purchase_timestamp_utc|, versus the
-- old behaviour of taking max(t).
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== VERIFIED ORDERS: nearest-to-purchase vs newest ==';
  RAISE NOTICE '';
  FOR r IN
    WITH v(order_id, asin, truth) AS (
      VALUES ('702-5492481-4068251','B002HJ4HSS',34.13::numeric),
             ('701-1848920-5681843','B00DLD1C0A',39.08::numeric)
    )
    SELECT v.order_id, v.asin, v.truth, so.purchase_timestamp_utc AS bought,
      (SELECT (e->>'v')::numeric FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin = v.asin AND k.marketplace = 'CA' AND (e->>'v')::numeric > 0
       ORDER BY abs(EXTRACT(epoch FROM ((e->>'t')::timestamptz - so.purchase_timestamp_utc)))
       LIMIT 1) AS nearest_v,
      (SELECT (e->>'t') FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin = v.asin AND k.marketplace = 'CA' AND (e->>'v')::numeric > 0
       ORDER BY abs(EXTRACT(epoch FROM ((e->>'t')::timestamptz - so.purchase_timestamp_utc)))
       LIMIT 1) AS nearest_t,
      (SELECT (e->>'v')::numeric FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin = v.asin AND k.marketplace = 'CA' AND (e->>'v')::numeric > 0
       ORDER BY (e->>'t') DESC LIMIT 1) AS newest_v,
      (SELECT (e->>'t') FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin = v.asin AND k.marketplace = 'CA' AND (e->>'v')::numeric > 0
       ORDER BY (e->>'t') DESC LIMIT 1) AS newest_t
    FROM v JOIN public.sales_orders so
      ON so.order_id = v.order_id AND so.user_id = v_uid
  LOOP
    RAISE NOTICE '   % % | Amazon truth CA$% | bought %',
      r.order_id, r.asin, r.truth, r.bought;
    RAISE NOTICE '     OLD newest  CA$% at % -> % pct out',
      lpad(COALESCE(r.newest_v::text,'-'),7), COALESCE(r.newest_t,'-'),
      CASE WHEN r.newest_v IS NULL THEN NULL
           ELSE round((100*(r.newest_v - r.truth)/r.truth)::numeric,1) END;
    RAISE NOTICE '     NEW nearest CA$% at % -> % pct out',
      lpad(COALESCE(r.nearest_v::text,'-'),7), COALESCE(r.nearest_t,'-'),
      CASE WHEN r.nearest_v IS NULL THEN NULL
           ELSE round((100*(r.nearest_v - r.truth)/r.truth)::numeric,1) END;
    RAISE NOTICE '     gap to purchase: %',
      CASE WHEN r.nearest_t IS NULL THEN '-'
           ELSE (abs(EXTRACT(epoch FROM (r.nearest_t::timestamptz - r.bought)))/3600)::int::text || ' h' END;
    RAISE NOTICE '';
  END LOOP;

  RAISE NOTICE '== every Keepa-touched order: how much does the anchor change it? ==';
  FOR r IN
    SELECT DISTINCT so.order_id, so.marketplace AS mk, so.asin,
      so.purchase_timestamp_utc AS bought,
      (SELECT (e->>'v')::numeric FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin = so.asin AND k.marketplace = so.marketplace AND (e->>'v')::numeric > 0
       ORDER BY abs(EXTRACT(epoch FROM ((e->>'t')::timestamptz - so.purchase_timestamp_utc)))
       LIMIT 1) AS nearest_v,
      (SELECT (e->>'v')::numeric FROM public.keepa_price_history_cache k
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.series->'buybox','[]'::jsonb)) e
       WHERE k.asin = so.asin AND k.marketplace = so.marketplace AND (e->>'v')::numeric > 0
       ORDER BY (e->>'t') DESC LIMIT 1) AS newest_v
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.order_id IN (SELECT DISTINCT order_id FROM public.keepa_estimate_recheck_log WHERE user_id = v_uid)
    ORDER BY so.marketplace, so.order_id
  LOOP
    RAISE NOTICE '   % % % | newest % -> nearest % | % pct change',
      rpad(r.mk,3), r.order_id, r.asin,
      lpad(COALESCE(r.newest_v::text,'-'),8), lpad(COALESCE(r.nearest_v::text,'-'),8),
      CASE WHEN r.newest_v IS NULL OR r.nearest_v IS NULL OR r.newest_v = 0 THEN NULL
           ELSE round((100*(r.nearest_v - r.newest_v)/r.newest_v)::numeric,1) END;
  END LOOP;
END
$p$;
