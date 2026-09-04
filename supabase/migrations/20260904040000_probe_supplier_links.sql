-- Read-only: supplier_links are the real purchase history. Which shops, which
-- brands? Brand comes via asin_brand_cache / inventory, since created_listings
-- stores the ASIN, not the brand.
SET statement_timeout TO '300s';
DO $$
DECLARE r RECORD; v_total bigint; v_with bigint;
BEGIN
  SELECT count(*), count(*) FILTER (
           WHERE jsonb_typeof(supplier_links) = 'array'
             AND jsonb_array_length(supplier_links) > 0)
    INTO v_total, v_with FROM public.created_listings;
  RAISE NOTICE 'created_listings=% | with supplier_links=%', v_total, v_with;

  FOR r IN
    SELECT asin, supplier_links FROM public.created_listings
    WHERE jsonb_typeof(supplier_links) = 'array' AND jsonb_array_length(supplier_links) > 0
    LIMIT 4
  LOOP
    RAISE NOTICE '  % -> %', r.asin, left(r.supplier_links::text, 180);
  END LOOP;

  CREATE TEMP TABLE _links ON COMMIT DROP AS
  SELECT c.user_id, c.asin,
         lower(regexp_replace(
           COALESCE(l ->> 'url', l ->> 'link', l #>> '{}'),
           '^https?://(www\.)?([^/]+).*$', '\2')) AS domain
  FROM public.created_listings c
  CROSS JOIN LATERAL jsonb_array_elements(c.supplier_links) l
  WHERE jsonb_typeof(c.supplier_links) = 'array';

  FOR r IN
    SELECT k.domain,
           count(DISTINCT k.asin) AS asins,
           count(DISTINCT lower(btrim(ab.brand))) FILTER (WHERE ab.brand IS NOT NULL) AS brands
    FROM _links k
    LEFT JOIN public.asin_brand_cache ab ON ab.asin = k.asin
    WHERE k.domain IS NOT NULL AND k.domain <> ''
    GROUP BY k.domain ORDER BY count(DISTINCT k.asin) DESC LIMIT 15
  LOOP
    RAISE NOTICE '  % -> % asins, % named brands', rpad(r.domain, 30), r.asins, r.brands;
  END LOOP;
END $$;
