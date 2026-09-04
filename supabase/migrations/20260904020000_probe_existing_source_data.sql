-- Read-only: does the app already hold where things were bought?
DO $$
DECLARE r RECORD; v bigint;
BEGIN
  FOR r IN
    SELECT t, c FROM (VALUES
      ('source_retailers'), ('saved_sources'), ('suppliers'),
      ('created_listing_purchases'), ('source_candidates'),
      ('user_retailers'), ('user_brand_sources')
    ) AS x(t), LATERAL (SELECT 0 AS c) y
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.t) INTO v;
    RAISE NOTICE '  % : % rows', rpad(r.t, 28), v;
  END LOOP;

  FOR r IN SELECT domain, label, enabled, search_hits, price_success
           FROM public.source_retailers ORDER BY search_hits DESC LIMIT 15
  LOOP
    RAISE NOTICE '  retailer: % (%) enabled=% hits=% priced=%',
      r.domain, COALESCE(r.label,'-'), r.enabled, r.search_hits, r.price_success;
  END LOOP;

  FOR r IN SELECT domain, source_url, asin FROM public.saved_sources LIMIT 8 LOOP
    RAISE NOTICE '  saved_source: % % %', r.asin, COALESCE(r.domain,'-'), left(r.source_url, 60);
  END LOOP;
END $$;
