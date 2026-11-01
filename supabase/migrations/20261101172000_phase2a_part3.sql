-- PHASE 2a part 3: per-SKU sales, the trigger, and the writers' schedule.
-- READ ONLY.
--
-- ── A METHODOLOGICAL FIX TO MY OWN PART-2 QUERY ───────────────────────
--
-- Part 2 attributed sales by ASIN. That overstates the case for any individual
-- row, because several SKUs share one ASIN and only one of them need be live:
-- B09XFCCC9B shows 106 units in 90 days against a NOT_IN_CATALOG SKU AND an
-- INACTIVE SKU, and those 106 units could have gone entirely through either.
-- Tombstoning decisions are per SKU, so the evidence has to be per SKU.
--
-- sales_orders carries seller_sku, so this re-asks the question properly. A
-- tombstoned row whose OWN SKU has sold recently is a false tombstone. A
-- tombstoned row whose ASIN sold but whose SKU did not is probably correct --
-- the ASIN is alive through a different SKU.
DO $p$
DECLARE r record; v_uid uuid; v_own int; v_asin_only int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  CREATE TEMP TABLE t AS
  WITH by_sku AS (
    SELECT seller_sku,
           sum(quantity) FILTER (WHERE order_date >= current_date - 30) AS u30,
           sum(quantity) FILTER (WHERE order_date >= current_date - 90) AS u90,
           max(order_date) AS last_sale
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= current_date - 90 AND seller_sku IS NOT NULL
    GROUP BY seller_sku
  ),
  by_asin AS (
    SELECT asin, sum(quantity) AS a90 FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
      AND order_date >= current_date - 90 GROUP BY asin
  )
  SELECT i.asin, i.sku, i.listing_status AS st,
         COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
         COALESCE(i.inbound,0) AS ib,
         COALESCE(k.u30,0) AS sku30, COALESCE(k.u90,0) AS sku90,
         k.last_sale, COALESCE(a.a90,0) AS asin90,
         CASE WHEN i.last_inventory_sync_at IS NULL THEN 9999
              ELSE (extract(epoch from (now()-i.last_inventory_sync_at))/86400)::int
         END AS age_d
  FROM public.inventory i
  LEFT JOIN by_sku  k ON k.seller_sku = i.sku
  LEFT JOIN by_asin a ON a.asin = i.asin
  WHERE i.user_id = v_uid
    AND upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED');

  SELECT count(*) FILTER (WHERE sku90 > 0),
         count(*) FILTER (WHERE sku90 = 0 AND asin90 > 0)
    INTO v_own, v_asin_only FROM t;

  RAISE NOTICE '############ PROTECTED TOMBSTONES, EVIDENCE PER SKU ############';
  RAISE NOTICE '   tombstoned rows whose OWN SKU sold in 90d : %  <= false tombstones', v_own;
  RAISE NOTICE '   tombstoned rows where only the ASIN sold  : %  <= probably correct', v_asin_only;
  RAISE NOTICE '   (part 2 reported 64 by conflating the two)';

  RAISE NOTICE '';
  RAISE NOTICE '   the OWN-SKU sellers -- these are the real set:';
  RAISE NOTICE '   asin         | sku                  | av | rv | ib | sku30 | sku90 | last sale  | sync';
  FOR r IN
    SELECT * FROM t WHERE sku90 > 0 ORDER BY sku90 DESC, asin
  LOOP
    RAISE NOTICE '   % | % | % | % | % | % | % | % | %d',
      rpad(r.asin,12), rpad(COALESCE(r.sku,'(null)'),20),
      lpad(r.av::text,2), lpad(r.rv::text,2), lpad(r.ib::text,2),
      lpad(r.sku30::text,5), lpad(r.sku90::text,5),
      COALESCE(r.last_sale::text,'-'), r.age_d;
  END LOOP;
  IF v_own = 0 THEN
    RAISE NOTICE '      NONE. Every protected tombstone whose ASIN sold did so';
    RAISE NOTICE '      through a DIFFERENT, live SKU -- so there may be no';
    RAISE NOTICE '      false tombstone left to clear at all.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   tombstoned rows holding stock (any age):';
  FOR r IN
    SELECT * FROM t WHERE av + rv + ib > 0 ORDER BY av + rv + ib DESC
  LOOP
    RAISE NOTICE '   % | % | av % rv % ib % | sku90 % | sync %d',
      rpad(r.asin,12), rpad(COALESCE(r.sku,'(null)'),20),
      r.av, r.rv, r.ib, r.sku90, r.age_d;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ THE TRIGGER ############';
  FOR r IN
    SELECT t2.tgname, c.relname AS tbl,
           CASE t2.tgenabled WHEN 'O' THEN 'enabled' WHEN 'D' THEN 'DISABLED'
                             ELSE t2.tgenabled::text END AS state
    FROM pg_trigger t2
    JOIN pg_class c ON c.oid = t2.tgrelid
    JOIN pg_proc p ON p.oid = t2.tgfoid
    WHERE p.proname ILIKE '%ghost_tombstone%'
  LOOP
    RAISE NOTICE '   % on % | %', r.tgname, r.tbl, r.state;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   >>> NOT INSTALLED -- the protection the code relies on is';
    RAISE NOTICE '   >>> absent, so an ordinary write could clear a tombstone.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ THE THREE WRITERS ############';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active, max(d.start_time) AS last_run
    FROM cron.job j
    LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.command ILIKE '%clean-ghost-listings%'
       OR j.command ILIKE '%nightly-ghost-cleanup%'
       OR j.command ILIKE '%check-fba-listing-eligibility%'
    GROUP BY 1,2,3 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | active % | last %', rpad(r.jobname,34),
      rpad(r.schedule,14), r.active, r.last_run;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE of the three is scheduled in pg_cron. They are invoked';
    RAISE NOTICE '   from the app or by hand, which changes 2e: a 24-hour watch';
    RAISE NOTICE '   proves nothing unless one of them is actually run during it.';
  END IF;

  DROP TABLE t;
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
