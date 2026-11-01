-- PHASE 2a + 2f: tombstoned rows that look alive. READ ONLY. Nothing changed.
--
-- A row is "tombstoned" when listing_status is NOT_IN_CATALOG or DELETED --
-- the two values _shared/ghostFilter.ts treats as a ghost, which removes the
-- row from Inventory Valuation, the repricer's view and the FBA shipment
-- builder. INACTIVE is reported alongside them because it blocks dispatch too
-- (see the two-locks finding), but it is NOT the same thing and is not
-- protected by the trigger.
--
-- "Looks alive" is deliberately two independent tests, because either alone is
-- weak:
--   * SOLD recently -- units in sales_orders in the last 30 and 90 days. A
--     tombstoned ASIN that is selling is selling from stock Amazon holds.
--   * HAS STOCK -- available/reserved/inbound/unfulfilled above zero. This is
--     only evidence if it is FRESH, so the age of last_inventory_sync_at is
--     reported with it; a stale nonzero left over from months ago is what the
--     7-day stock-evidence gate in clean-ghost-listings exists to discount.
DO $p$
DECLARE
  r record; v_uid uuid; v_n int; v_tot int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '############ 0. THE WHOLE TOMBSTONE POPULATION ############';
  FOR r IN
    SELECT COALESCE(listing_status,'(null)') AS st, count(*) AS n,
           count(*) FILTER (WHERE COALESCE(available,0) + COALESCE(reserved,0)
                                + COALESCE(inbound,0) + COALESCE(unfulfilled,0) > 0) AS with_stock
    FROM public.inventory WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % rows | % with stock', rpad(r.st,16),
      lpad(r.n::text,6), lpad(r.with_stock::text,5);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 1. TOMBSTONED *AND* SELLING OR STOCKED ############';
  RAISE NOTICE '   asin         | sku                  | status         | avail | resv | inb | u30 | u90 | sync age';
  v_n := 0;
  FOR r IN
    WITH sold AS (
      SELECT asin,
             sum(quantity) FILTER (WHERE order_date >= current_date - 30) AS u30,
             sum(quantity) FILTER (WHERE order_date >= current_date - 90) AS u90
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
        AND order_date >= current_date - 90
      GROUP BY asin
    )
    SELECT i.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.listing_status,'(null)') AS st,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib,
           COALESCE(s.u30,0) AS u30, COALESCE(s.u90,0) AS u90,
           CASE WHEN i.last_inventory_sync_at IS NULL THEN 'never'
                ELSE (extract(epoch from (now() - i.last_inventory_sync_at))
                      / 86400)::int || 'd' END AS age,
           COALESCE(i.source,'-') AS src
    FROM public.inventory i
    LEFT JOIN sold s ON s.asin = i.asin
    WHERE i.user_id = v_uid
      AND upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED','INACTIVE')
      AND (COALESCE(s.u90,0) > 0
           OR COALESCE(i.available,0) + COALESCE(i.reserved,0)
            + COALESCE(i.inbound,0) + COALESCE(i.unfulfilled,0) > 0)
    ORDER BY COALESCE(s.u90,0) DESC, i.asin
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % | % | % | % | % | % | % | % | % (%)',
      rpad(r.asin,12), rpad(r.sku,20), rpad(r.st,14),
      lpad(r.av::text,5), lpad(r.rv::text,4), lpad(r.ib::text,3),
      lpad(r.u30::text,3), lpad(r.u90::text,3), r.age, r.src;
  END LOOP;
  RAISE NOTICE '   ----------------------------------------------------------';
  RAISE NOTICE '   total: % rows', v_n;
  IF v_n = 0 THEN
    RAISE NOTICE '   >>> NONE. Either the earlier revivals cleared them all, or';
    RAISE NOTICE '   >>> no tombstoned row currently shows stock or sales.';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. B00LFXMBKI SPECIFICALLY ############';
  FOR r IN
    SELECT i.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.listing_status,'(null)') AS st,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib, COALESCE(i.source,'-') AS src,
           i.last_inventory_sync_at AS synced, i.updated_at
    FROM public.inventory i
    WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   % / % | status % | available % | reserved % | inbound %',
      r.asin, r.sku, r.st, r.av, r.rv, r.ib;
    RAISE NOTICE '      source % | synced % | updated %', r.src, r.synced, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   no inventory row for B00LFXMBKI at all';
  END IF;
  FOR r IN
    SELECT sum(quantity) FILTER (WHERE order_date >= current_date - 30) AS u30,
           sum(quantity) FILTER (WHERE order_date >= current_date - 90) AS u90,
           max(order_date) AS last_sale
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
      AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   units sold: 30d % | 90d % | last sale %',
      COALESCE(r.u30,0), COALESCE(r.u90,0), r.last_sale;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. ARE THE THREE TOMBSTONE WRITERS STILL ACTIVE? ############';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active,
           count(d.*) FILTER (WHERE d.start_time >= now() - interval '7 days') AS runs_7d,
           max(d.start_time) AS last_run
    FROM cron.job j
    LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.command ILIKE '%clean-ghost-listings%'
       OR j.command ILIKE '%nightly-ghost-cleanup%'
       OR j.command ILIKE '%check-fba-listing-eligibility%'
    GROUP BY 1,2,3 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | active % | % runs/7d | last %',
      rpad(r.jobname,36), rpad(r.schedule,14), r.active,
      lpad(r.runs_7d::text,4), r.last_run;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   no pg_cron job references any of the three. They are';
    RAISE NOTICE '   invoked from the app or by hand, not on a schedule.';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. THE TOMBSTONE TRIGGER ############';
  FOR r IN
    SELECT t.tgname, c.relname AS tbl, t.tgenabled,
           p.proname AS fn
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname ILIKE '%ghost_tombstone%'
  LOOP
    RAISE NOTICE '   trigger % on % | enabled % | fn %',
      r.tgname, r.tbl, r.tgenabled, r.fn;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   >>> no ghost-tombstone trigger found -- the protection';
    RAISE NOTICE '   >>> described in the code comments is NOT installed.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, no API called.';
END
$p$;
