-- PROBE (read-only): did Shipment Builder usage stop in mid-June, for
-- everything -- or only for this ASIN?
--
-- For B0G4B3117X the deduplicated Builder record ends 2026-06-11 (continued)
-- / 2026-06-15 (an unsent draft), while sales ran to September and 312 units
-- are still on hand. If Builder use stopped across the board at the same time,
-- that single change explains BOTH the missing purchase entries and the
-- missing shipment records -- one habit changing, not two systems failing.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== all Shipment Builder drafts by month (every ASIN) ========';
  FOR r IN
    SELECT to_char(created_at,'YYYY-MM') AS mon,
           count(*) AS drafts,
           count(*) FILTER (WHERE status = 'continued') AS continued,
           max(created_at)::date AS last_in_month
    FROM public.shipment_builder_drafts WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % drafts (% continued), last %', r.mon, r.drafts, r.continued, r.last_in_month;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== and created_listings entry by month (every ASIN) ========';
  FOR r IN
    SELECT to_char(date_created,'YYYY-MM') AS mon, count(*) AS lots, sum(units) AS units
    FROM public.created_listings WHERE user_id = v_uid
      AND date_created > '2026-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %: % lots, % units', r.mon, r.lots, r.units;
  END LOOP;
END
$probe$;