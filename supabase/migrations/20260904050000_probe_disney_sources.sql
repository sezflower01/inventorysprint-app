-- Read-only: where were Disney-brand items actually bought?
SET statement_timeout TO '300s';
DO $$
DECLARE r RECORD; v_brands bigint; v_pairs bigint;
BEGIN
  CREATE TEMP TABLE _bl ON COMMIT DROP AS
  SELECT c.user_id,
         lower(btrim(COALESCE(ab.brand, i.brand))) AS brand,
         lower(regexp_replace(COALESCE(l ->> 'url', l ->> 'link', l #>> '{}'),
               '^https?://(www\.)?([^/]+).*$', '\2')) AS domain
  FROM public.created_listings c
  CROSS JOIN LATERAL jsonb_array_elements(c.supplier_links) l
  LEFT JOIN public.asin_brand_cache ab ON ab.asin = c.asin
  LEFT JOIN LATERAL (SELECT brand FROM public.inventory i2
                      WHERE i2.asin = c.asin AND i2.brand IS NOT NULL LIMIT 1) i ON true
  WHERE jsonb_typeof(c.supplier_links) = 'array';

  DELETE FROM _bl WHERE brand IS NULL OR brand = '' OR domain IS NULL OR domain = '';

  SELECT count(DISTINCT brand), count(*) INTO v_brands, v_pairs
    FROM (SELECT DISTINCT brand, domain FROM _bl) x;
  RAISE NOTICE 'derivable: % distinct brands, % brand-to-shop pairs', v_brands, v_pairs;

  FOR r IN SELECT brand, domain, count(*) AS n FROM _bl
           WHERE brand LIKE 'disney%' GROUP BY brand, domain ORDER BY count(*) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  DISNEY: "%" bought from % (% links)', r.brand, r.domain, r.n;
  END LOOP;

  FOR r IN SELECT brand, count(DISTINCT domain) AS shops FROM _bl
           GROUP BY brand ORDER BY count(DISTINCT domain) DESC LIMIT 6
  LOOP
    RAISE NOTICE '  multi-shop brand: "%" -> % different shops', r.brand, r.shops;
  END LOOP;
END $$;
