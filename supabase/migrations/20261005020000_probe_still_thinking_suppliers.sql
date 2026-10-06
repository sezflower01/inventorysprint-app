-- READ-ONLY PROBE. Still Thinking carries ONE supplier per row
-- (supplier_url / supplier_domain / discount_code / supplier_id) and the page
-- renders it read-only, so an ASIN saved straight from Amazon has no retailer
-- and no way to add one afterwards. Re-saving from the extension reports
-- "Already in Still Thinking (refreshed)" but INVSPRNT_SAVE_THINKING only
-- re-reads the row on conflict -- it patches nothing, so the second save does
-- not fill the retailer in either.
--
-- Before adding a supplier_links array + a sync trigger, confirm: the exact
-- columns, the unique constraint the upsert collides with, any existing
-- triggers, and how many rows would be backfilled.

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== columns ==';
  FOR r IN SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'still_thinking_listings'
           ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % | % | null=% | default %',
      rpad(r.column_name, 28), rpad(r.data_type, 26), r.is_nullable, COALESCE(r.column_default, '');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== indexes / constraints ==';
  FOR r IN SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'still_thinking_listings' LOOP
    RAISE NOTICE '  % :: %', r.indexname, r.indexdef;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== triggers already on the table ==';
  FOR r IN SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
           WHERE tgrelid = 'public.still_thinking_listings'::regclass AND NOT tgisinternal LOOP
    RAISE NOTICE '  % :: %', r.tgname, r.def;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how much data, and how much of it has a retailer? ==';
  FOR r IN SELECT status,
                  count(*) AS rows,
                  count(*) FILTER (WHERE COALESCE(supplier_url, '') <> '') AS with_url,
                  count(*) FILTER (WHERE COALESCE(discount_code, '') <> '') AS with_code,
                  count(*) FILTER (WHERE supplier_id IS NOT NULL) AS with_supplier_id
           FROM public.still_thinking_listings
           WHERE user_id = v_uid
           GROUP BY status ORDER BY status LOOP
    RAISE NOTICE '  % | % rows | % with url | % with code | % linked to a suppliers row',
      rpad(r.status, 12), r.rows, r.with_url, r.with_code, r.with_supplier_id;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no rows for this user)'; END IF;

  SELECT count(*) INTO n FROM public.still_thinking_listings;
  RAISE NOTICE '  total rows across all users: %', n;

  RAISE NOTICE '';
  RAISE NOTICE '== the ten most recent, so the shape is concrete ==';
  FOR r IN SELECT asin, left(COALESCE(title, ''), 36) AS t, status,
                  COALESCE(supplier_domain, '-') AS dom,
                  COALESCE(discount_code, '-') AS code,
                  created_at
           FROM public.still_thinking_listings
           WHERE user_id = v_uid ORDER BY created_at DESC LIMIT 10 LOOP
    RAISE NOTICE '  % | % | % | % | % | %',
      r.asin, rpad(r.t, 36), rpad(r.status, 10), rpad(r.dom, 22), rpad(r.code, 12), r.created_at;
  END LOOP;
END
$p$;
