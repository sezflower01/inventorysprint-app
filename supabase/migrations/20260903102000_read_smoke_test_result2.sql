-- Read the smoke-test response. Read-only.
DO $$
DECLARE r RECORD; v_pending bigint; v_done bigint; v_brands bigint;
BEGIN
  SELECT status_code, content::text AS body, error_msg INTO r
    FROM net._http_response WHERE id = 71354;
  IF NOT FOUND THEN
    RAISE NOTICE 'request 71354 has no response row yet';
  ELSE
    RAISE NOTICE 'HTTP % | err=% | body=%', r.status_code, r.error_msg, left(r.body, 900);
  END IF;

  SELECT count(*) FILTER (WHERE checked_at IS NULL),
         count(*) FILTER (WHERE checked_at IS NOT NULL),
         count(*) FILTER (WHERE brand IS NOT NULL)
    INTO v_pending, v_done, v_brands FROM public.asin_brand_cache;
  RAISE NOTICE 'cache: pending=% checked=% with_brand=%', v_pending, v_done, v_brands;
END $$;
