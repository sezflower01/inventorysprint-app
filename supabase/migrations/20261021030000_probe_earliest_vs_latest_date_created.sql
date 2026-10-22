-- READ-ONLY. Testing the real cause.
--
-- created_listings is a PURCHASE LOG: one row per buy, several per SKU. Its
-- date_created is 0-1 days before created_at on every recent row, so it is
-- when the PURCHASE was entered, not when Amazon created the listing.
--
-- SyncedInventory's cost map keeps "the most recent entry for the SKU" -- right
-- for cost, wrong for a creation date. A restock yesterday therefore stamps an
-- ASIN first listed months ago with yesterday's date, which is exactly what the
-- seller saw on B00O8F3JH4 (restocked 2026-10-21, first recorded 2026-09-29).
--
-- If that is the cause, the EARLIEST date_created per ASIN+SKU should be a far
-- better "created" proxy. Measure how many rows it moves and by how much.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== SKUs with more than one purchase row (the ones that can be wrong) ==';
  FOR r IN
    SELECT count(*) AS sku_groups,
           count(*) FILTER (WHERE n > 1) AS multi_purchase,
           count(*) FILTER (WHERE n > 1 AND earliest <> latest) AS date_would_change,
           max(spread_days) AS worst_spread_days,
           round(avg(spread_days) FILTER (WHERE spread_days > 0), 1) AS avg_spread_when_differs
    FROM (
      SELECT asin, sku, count(*) AS n,
             min(date_created) AS earliest, max(date_created) AS latest,
             (max(date_created) - min(date_created)) AS spread_days
      FROM public.created_listings
      WHERE user_id = v_uid AND date_created IS NOT NULL
      GROUP BY asin, sku
    ) g
  LOOP
    RAISE NOTICE '   % ASIN+SKU groups | % have >1 purchase | % would show a DIFFERENT date',
      r.sku_groups, r.multi_purchase, r.date_would_change;
    RAISE NOTICE '   worst spread % days | average spread when it differs % days',
      r.worst_spread_days, r.avg_spread_when_differs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the two the seller named ==';
  FOR r IN
    SELECT asin, sku, count(*) AS purchases,
           min(date_created) AS earliest, max(date_created) AS latest,
           (max(date_created) - min(date_created)) AS spread_days
    FROM public.created_listings
    WHERE user_id = v_uid AND asin IN ('B00O8F3JH4','B003L0OOVC') AND date_created IS NOT NULL
    GROUP BY asin, sku ORDER BY asin
  LOOP
    RAISE NOTICE '   % / % | % purchases | shown now % | should be % | off by % days',
      r.asin, r.sku, r.purchases, r.latest, r.earliest, r.spread_days;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst offenders: biggest gap between first and last purchase ==';
  FOR r IN
    SELECT asin, sku, count(*) AS purchases,
           min(date_created) AS earliest, max(date_created) AS latest,
           (max(date_created) - min(date_created)) AS spread_days
    FROM public.created_listings
    WHERE user_id = v_uid AND date_created IS NOT NULL
    GROUP BY asin, sku
    HAVING count(*) > 1 AND (max(date_created) - min(date_created)) > 0
    ORDER BY (max(date_created) - min(date_created)) DESC
    LIMIT 12
  LOOP
    RAISE NOTICE '   % / % | % buys | shown % | first %  (% days too new)',
      r.asin, rpad(r.sku,16), lpad(r.purchases::text,3), r.latest, r.earliest, r.spread_days;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== sanity: is date_created ever a plausible AMAZON listing date? ==';
  RAISE NOTICE '   if it were, the FIRST purchase date would often be well before';
  RAISE NOTICE '   the row insert. Check the earliest row per SKU specifically.';
  FOR r IN
    SELECT
      count(*) AS first_rows,
      count(*) FILTER (WHERE ((created_at AT TIME ZONE 'UTC')::date - date_created) <= 1) AS within_1_day_of_insert,
      count(*) FILTER (WHERE ((created_at AT TIME ZONE 'UTC')::date - date_created) > 30) AS over_30d_before_insert
    FROM (
      SELECT DISTINCT ON (asin, sku) asin, sku, date_created, created_at
      FROM public.created_listings
      WHERE user_id = v_uid AND date_created IS NOT NULL
      ORDER BY asin, sku, date_created ASC
    ) f
  LOOP
    RAISE NOTICE '   % first-purchase rows | % are within 1 day of the insert | % are >30d before',
      r.first_rows, r.within_1_day_of_insert, r.over_30d_before_insert;
    RAISE NOTICE '   -- heavily within-1-day means date_created is an ENTRY date,';
    RAISE NOTICE '      so "created" can only ever mean "first recorded here".';
  END LOOP;
END
$p$;
