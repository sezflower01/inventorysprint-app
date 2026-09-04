-- Read-only: is hobbylobby.com in the purchase history at all?
SET statement_timeout TO '300s';
DO $$
DECLARE r RECORD; v bigint;
BEGIN
  SELECT count(*) INTO v FROM public.created_listings c
  CROSS JOIN LATERAL jsonb_array_elements(c.supplier_links) l
  WHERE jsonb_typeof(c.supplier_links) = 'array'
    AND COALESCE(l ->> 'url', l ->> 'link', l #>> '{}') ILIKE '%hobbylobby%';
  RAISE NOTICE 'hobbylobby links in purchase history: %', v;

  FOR r IN
    SELECT c.asin, COALESCE(ab.brand, '(brand unknown)') AS brand,
           left(COALESCE(l ->> 'url', l ->> 'link', l #>> '{}'), 70) AS url
    FROM public.created_listings c
    CROSS JOIN LATERAL jsonb_array_elements(c.supplier_links) l
    LEFT JOIN public.asin_brand_cache ab ON ab.asin = c.asin
    WHERE jsonb_typeof(c.supplier_links) = 'array'
      AND COALESCE(l ->> 'url', l ->> 'link', l #>> '{}') ILIKE '%hobbylobby%'
    LIMIT 8
  LOOP
    RAISE NOTICE '  % [%] %', r.asin, r.brand, r.url;
  END LOOP;

  SELECT count(*) INTO v FROM public.user_retailers WHERE url_template ILIKE '%hobbylobby%';
  RAISE NOTICE 'hobbylobby shops now configured: %', v;
END $$;
