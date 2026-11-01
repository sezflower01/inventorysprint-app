-- PHASE 2 step 1, CORRECTION. READ ONLY.
--
-- My previous query read is_listing_inactive_not_buyable with a bare
-- bool_or(...) and reported TRUE for every single row in the population. A flag
-- that is true for everything is almost always being read wrong, and it was:
-- the detection has a lifecycle -- listing_inactive_detected_at and
-- listing_inactive_cleared_at -- so the boolean alone says "was ever flagged",
-- not "is flagged now". A listing deactivated in June and fixed in July still
-- carries the boolean.
--
-- It was also aggregated with bool_or across every assignment matching the
-- (asin, sku), so one stale sibling could flag the row.
--
-- This re-asks it three ways so the difference is visible rather than assumed:
--   ever flagged           - the boolean alone, which is what I wrongly used
--   currently flagged      - boolean true AND not since cleared
--   clear-state unknown    - flagged with neither timestamp set
DO $p$
DECLARE r record; v_uid uuid; v_tot int; v_ever int; v_now int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '############ 1. HOW THE FLAG REALLY SITS ############';
  SELECT count(*),
         count(*) FILTER (WHERE COALESCE(is_listing_inactive_not_buyable,false)),
         count(*) FILTER (WHERE COALESCE(is_listing_inactive_not_buyable,false)
                            AND (listing_inactive_cleared_at IS NULL
                                 OR listing_inactive_detected_at > listing_inactive_cleared_at))
    INTO v_tot, v_ever, v_now
  FROM public.repricer_assignments WHERE user_id = v_uid;
  RAISE NOTICE '   repricer_assignments rows        : %', v_tot;
  RAISE NOTICE '   boolean true (EVER flagged)      : %', v_ever;
  RAISE NOTICE '   still flagged (not since cleared): %  <= the real signal', v_now;

  FOR r IN
    SELECT count(*) FILTER (WHERE listing_inactive_detected_at IS NULL) AS no_det,
           count(*) FILTER (WHERE listing_inactive_cleared_at IS NULL) AS no_clr,
           max(listing_inactive_detected_at) AS last_det,
           max(listing_inactive_last_checked_at) AS last_check
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND COALESCE(is_listing_inactive_not_buyable,false)
  LOOP
    RAISE NOTICE '   of the ever-flagged: % have no detected_at, % no cleared_at',
      r.no_det, r.no_clr;
    RAISE NOTICE '   newest detection % | newest check %', r.last_det, r.last_check;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. B00LFXMBKI, PROPERLY ############';
  FOR r IN
    SELECT COALESCE(i.sku,'(null)') AS sku, COALESCE(i.listing_status,'-') AS st,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib,
           COALESCE(i.inbound_working,0) AS ibw,
           COALESCE(i.inbound_shipped,0) AS ibs,
           COALESCE(i.inbound_receiving,0) AS ibr,
           COALESCE(i.source,'-') AS src, i.last_inventory_sync_at AS synced
    FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | status % | av % rv % inbound % (w% s% r%)',
      r.sku, r.st, r.av, r.rv, r.ib, r.ibw, r.ibs, r.ibr;
    RAISE NOTICE '   total by our rule % -> rule says %', r.av+r.rv+r.ib,
      CASE WHEN r.av+r.rv+r.ib > 0 THEN 'ACTIVE' ELSE 'INACTIVE' END;
    RAISE NOTICE '   source % | synced %', r.src, r.synced;
  END LOOP;

  RAISE NOTICE '   its repricer assignments:';
  FOR r IN
    SELECT COALESCE(sku,'(null)') AS sku,
           COALESCE(amazon_listing_state,'(null)') AS astate,
           COALESCE(is_listing_inactive_not_buyable,false) AS nb,
           listing_inactive_detected_at AS det,
           listing_inactive_cleared_at AS clr,
           listing_inactive_last_checked_at AS chk,
           COALESCE(listing_inactive_statuses::text,'-') AS statuses
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '      sku % | state % | not_buyable %', r.sku, r.astate, r.nb;
    RAISE NOTICE '         detected % | cleared % | checked %', r.det, r.clr, r.chk;
    RAISE NOTICE '         statuses %', r.statuses;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '      NO repricer assignment for B00LFXMBKI at all, so there';
    RAISE NOTICE '      is NO Amazon buyability signal for it -- the flag I';
    RAISE NOTICE '      printed as "true" came from the bad aggregate.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   sales by month:';
  FOR r IN
    SELECT to_char(date_trunc('month', order_date),'YYYY-MM') AS mo,
           sum(quantity) AS u
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
      AND order_id NOT LIKE '%-REFUND%' AND order_date >= current_date - 150
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % units', r.mo, r.u; END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. THE POPULATION, WITH THE FLAG READ CORRECTLY ############';
  RAISE NOTICE '   asin         | sku                  | av | rv | inb | sku30 | currently not-buyable';
  FOR r IN
    WITH by_sku AS (
      SELECT seller_sku, sum(quantity) AS u30 FROM public.sales_orders
      WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
        AND order_date >= current_date - 30 AND seller_sku IS NOT NULL
      GROUP BY seller_sku),
    ra AS (
      SELECT asin, sku,
             bool_or(COALESCE(is_listing_inactive_not_buyable,false)
                     AND (listing_inactive_cleared_at IS NULL
                          OR listing_inactive_detected_at > listing_inactive_cleared_at)) AS nb_now,
             count(*) AS n_assign
      FROM public.repricer_assignments WHERE user_id = v_uid GROUP BY asin, sku)
    SELECT i.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib, COALESCE(k.u30,0) AS u30,
           CASE WHEN a.n_assign IS NULL THEN 'no assignment'
                WHEN a.nb_now THEN 'YES'
                ELSE 'no' END AS nb
    FROM public.inventory i
    LEFT JOIN by_sku k ON k.seller_sku = i.sku
    LEFT JOIN ra     a ON a.asin = i.asin AND a.sku = i.sku
    WHERE i.user_id = v_uid
      AND upper(COALESCE(i.listing_status,'')) = 'INACTIVE'
      AND COALESCE(k.u30,0) > 0
    ORDER BY COALESCE(k.u30,0) DESC
    LIMIT 25
  LOOP
    RAISE NOTICE '   % | % | % | % | % | % | %',
      rpad(r.asin,12), rpad(r.sku,20), lpad(r.av::text,2), lpad(r.rv::text,2),
      lpad(r.ib::text,4), lpad(r.u30::text,5), r.nb;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
