-- READ-ONLY. The seller reports B00O8F3JH4 showing "created" when it was
-- ADDED, and says it is not the only one.
--
-- My basis rule trusted any non-NULL created_listings.date_created as a real
-- listing creation date. That is the assumption to test: if date_created is
-- auto-stamped with "today" when a purchase is recorded, then a non-NULL value
-- proves nothing, and the 3,691 rows I labelled "created" include an unknown
-- number that are really "added".
--
-- The earlier probe already hinted at it: of 8,214 dated rows only 6,324 land
-- on a different calendar day than created_at -- so ~1,890 land on the SAME
-- day, which is what an auto-stamp looks like.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== columns on created_listings (looking for a provenance marker) ==';
  FOR r IN
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'created_listings'
  LOOP RAISE NOTICE '   %', r.cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the two rows the seller named, in full ==';
  FOR r IN
    SELECT to_jsonb(c)::text AS j
    FROM public.created_listings c
    WHERE c.user_id = v_uid AND c.asin IN ('B00O8F3JH4','B003L0OOVC')
    ORDER BY c.asin, c.created_at DESC
  LOOP RAISE NOTICE '   %', left(r.j, 1400); RAISE NOTICE ''; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no created_listings rows for either ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== same-day date_created vs created_at: the auto-stamp signature ==';
  FOR r IN
    SELECT
      count(*) AS dated_rows,
      count(*) FILTER (WHERE date_created = (created_at AT TIME ZONE 'UTC')::date) AS same_day,
      count(*) FILTER (WHERE date_created = (created_at AT TIME ZONE 'America/Los_Angeles')::date) AS same_day_pacific,
      count(*) FILTER (WHERE abs(((created_at AT TIME ZONE 'UTC')::date - date_created)) <= 1) AS within_1_day,
      count(*) FILTER (WHERE ((created_at AT TIME ZONE 'UTC')::date - date_created) > 1) AS genuinely_earlier,
      count(*) FILTER (WHERE ((created_at AT TIME ZONE 'UTC')::date - date_created) < -1) AS date_in_future
    FROM public.created_listings
    WHERE user_id = v_uid AND date_created IS NOT NULL
  LOOP
    RAISE NOTICE '   % rows carry a date_created', r.dated_rows;
    RAISE NOTICE '   % land on the SAME UTC day as created_at   <<< auto-stamp', r.same_day;
    RAISE NOTICE '   % land on the same Pacific day', r.same_day_pacific;
    RAISE NOTICE '   % are within 1 day either way', r.within_1_day;
    RAISE NOTICE '   % are genuinely EARLIER than the row insert (a real listing date)', r.genuinely_earlier;
    RAISE NOTICE '   % are LATER than the insert by >1 day (date in the future?)', r.date_in_future;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is there a text marker that says it came from a purchase? ==';
  FOR r IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='created_listings'
      AND data_type IN ('text','character varying','jsonb')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '   candidate text/jsonb column: %', r.column_name;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== recent rows: what do the newest 12 look like? ==';
  FOR r IN
    SELECT asin, COALESCE(sku,'-') AS sku,
           COALESCE(date_created::text,'NULL') AS dc,
           created_at,
           ((created_at AT TIME ZONE 'UTC')::date - date_created) AS days_earlier
    FROM public.created_listings
    WHERE user_id = v_uid
    ORDER BY created_at DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | sku % | date_created % | inserted % | earlier by %',
      r.asin, rpad(r.sku,16), rpad(r.dc,12), r.created_at, COALESCE(r.days_earlier::text,'-');
  END LOOP;
END
$p$;
