-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The seller created a listing for B01A0LTJBO and does not see it on the COG
-- page, which since 20260915031000 lists every Created Listing that passes
-- is_active_created_listing(validation_status), newest first. Find where it
-- falls out: not saved, saved under a placeholder ASIN, a validation status
-- the filter rejects, or on the page but not where the seller looked.

DO $probe$
DECLARE v_uid uuid; r record; v_def text; v_pos int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. created_listings rows for B01A0LTJBO ========';
  FOR r IN
    SELECT id, asin, sku, validation_status, public.is_active_created_listing(validation_status) AS passes,
           date_created, created_at, cost, units, amount, (image_url IS NOT NULL) AS img, left(COALESCE(title, ''), 50) AS t,
           validation_failure_code, validation_failure_reason
    FROM public.created_listings
    WHERE user_id = v_uid AND (asin = 'B01A0LTJBO' OR title ILIKE '%B01A0LTJBO%' OR sku ILIKE '%B01A0LTJBO%')
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  % asin=% sku=% status=% passes_filter=% | date_created=% inserted=% | cost=% units=% amount=% img=% | % | fail=% %',
      r.id, r.asin, r.sku, r.validation_status, r.passes, r.date_created, r.created_at, r.cost, r.units, r.amount, r.img, r.t,
      COALESCE(r.validation_failure_code, '-'), COALESCE(r.validation_failure_reason, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. the newest listings of any ASIN (in case it was saved differently) ========';
  FOR r IN
    SELECT asin, sku, validation_status, public.is_active_created_listing(validation_status) AS passes,
           date_created, created_at, left(COALESCE(title, ''), 45) AS t
    FROM public.created_listings
    WHERE user_id = v_uid
    ORDER BY created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '  inserted % | asin=% sku=% status=% passes=% date_created=% | %',
      r.created_at, r.asin, r.sku, r.validation_status, r.passes, r.date_created, r.t;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. what the filter accepts ========';
  SELECT pg_get_functiondef('public.is_active_created_listing'::regproc) INTO v_def;
  RAISE NOTICE '%', regexp_replace(v_def, '\s+', ' ', 'g');
  FOR r IN
    SELECT COALESCE(validation_status, '(null)') AS st, public.is_active_created_listing(validation_status) AS passes, count(*) AS n,
           max(created_at) AS latest
    FROM public.created_listings WHERE user_id = v_uid
    GROUP BY 1, 2 ORDER BY latest DESC
  LOOP
    RAISE NOTICE '  status % passes=% rows=% latest insert %', rpad(r.st, 22), r.passes, r.n, r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. does the page function return it, as the seller? ========';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_pos := 0;
  FOR r IN SELECT row_number() OVER () AS pos, asin, date_created, cog_id, is_restock FROM public.get_cog_page_products() LOOP
    IF r.asin = 'B01A0LTJBO' THEN
      RAISE NOTICE '  YES: position % of the default order | date_created % | has COG % | restock %',
        r.pos, r.date_created, r.cog_id IS NOT NULL, r.is_restock;
      v_pos := r.pos;
    END IF;
  END LOOP;
  IF v_pos = 0 THEN RAISE NOTICE '  NO: not returned'; END IF;
  FOR r IN SELECT asin, date_created FROM public.get_cog_page_products() LIMIT 3 LOOP
    RAISE NOTICE '  top of page: % %', r.date_created, r.asin;
  END LOOP;
  SET LOCAL ROLE postgres;
END
$probe$;
