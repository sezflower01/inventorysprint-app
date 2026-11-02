-- Did MY function write that row, or something else? READ ONLY.
-- Test 4 asserted no asin_cog_on_record row should exist for an ASIN with a
-- manual override. A row existed. Before assuming the guard failed, check
-- whether another trigger creates COG rows from created_listings -- the live
-- 'listing' source value (96 rows) hints that one does.
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'triggers on created_listings:';
  FOR r IN
    SELECT t.tgname, p.proname
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.created_listings'::regclass AND NOT t.tgisinternal
    ORDER BY t.tgname
  LOOP RAISE NOTICE '   % -> %', rpad(r.tgname,42), r.proname; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'any function body that inserts into asin_cog_on_record:';
  FOR r IN
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) ILIKE '%INSERT INTO public.asin_cog_on_record%'
    ORDER BY 1
  LOOP RAISE NOTICE '   %', r.proname; END LOOP;
END
$p$;
