-- Read-only: how many brands would realistically need a source URL?
SET statement_timeout TO '300s';
DO $$
DECLARE v_all bigint; v_stocked bigint; v_prefix bigint; v_exact_hits bigint;
BEGIN
  SELECT count(*) FILTER (WHERE COALESCE(status,'') <> 'ignore'),
         count(*) FILTER (WHERE COALESCE(status,'') <> 'ignore'
                            AND (asin_count > 0 OR unit_count > 0 OR inbound_count > 0)),
         count(*) FILTER (WHERE COALESCE(status,'') <> 'ignore' AND match_mode = 'prefix')
    INTO v_all, v_stocked, v_prefix
  FROM public.user_brands;

  -- Exact-match only: uses the lower(btrim(brand)) index on the cache, so it
  -- returns. The prefix half is what made the full version time out.
  SELECT count(*) INTO v_exact_hits
  FROM public.user_brands u
  WHERE COALESCE(u.status,'') <> 'ignore'
    AND COALESCE(u.match_mode,'exact') <> 'prefix'
    AND EXISTS (SELECT 1 FROM public.asin_brand_cache ab
                 WHERE lower(btrim(ab.brand)) = lower(btrim(u.brand)));

  RAISE NOTICE 'active brands=% | currently stocked=% | prefix-mode=% | seen on a watched catalogue (exact)=%',
    v_all, v_stocked, v_prefix, v_exact_hits;
END $$;
