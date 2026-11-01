-- PHASE 2 step 1: the decisive numbers only. READ ONLY.
-- Short on purpose -- the previous two runs produced output long enough that
-- the conclusions scrolled past, which is its own kind of unreliable reporting.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_ever int; v_now int; v_sold30 int; v_nb_now int; v_nb_none int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) FILTER (WHERE COALESCE(is_listing_inactive_not_buyable,false)),
         count(*) FILTER (WHERE COALESCE(is_listing_inactive_not_buyable,false)
                            AND (listing_inactive_cleared_at IS NULL
                                 OR listing_inactive_detected_at > listing_inactive_cleared_at))
    INTO v_ever, v_now
  FROM public.repricer_assignments WHERE user_id = v_uid;
  RAISE NOTICE 'FLAG: ever-flagged % | still-flagged % (the real signal)', v_ever, v_now;

  ------------------------------------------------------------------
  CREATE TEMP TABLE pop AS
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
           count(*) AS n
    FROM public.repricer_assignments WHERE user_id = v_uid GROUP BY asin, sku)
  SELECT i.asin, i.sku, COALESCE(i.available,0) AS av,
         COALESCE(i.reserved,0) AS rv, COALESCE(i.inbound,0) AS ib,
         COALESCE(k.u30,0) AS u30, a.n AS n_assign,
         COALESCE(a.nb_now,false) AS nb_now
  FROM public.inventory i
  LEFT JOIN by_sku k ON k.seller_sku = i.sku
  LEFT JOIN ra     a ON a.asin = i.asin AND a.sku = i.sku
  WHERE i.user_id = v_uid
    AND upper(COALESCE(i.listing_status,'')) = 'INACTIVE'
    AND COALESCE(k.u30,0) > 0;

  SELECT count(*), count(*) FILTER (WHERE nb_now),
         count(*) FILTER (WHERE n_assign IS NULL)
    INTO v_sold30, v_nb_now, v_nb_none FROM pop;
  RAISE NOTICE 'INACTIVE rows that SOLD in 30 days : %', v_sold30;
  RAISE NOTICE '   currently not-buyable at Amazon : %', v_nb_now;
  RAISE NOTICE '   no repricer assignment, so no Amazon signal at all : %', v_nb_none;
  RAISE NOTICE '   neither flagged nor unknown (Amazon says fine)     : %',
    v_sold30 - v_nb_now - v_nb_none;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE 'B00LFXMBKI assignments:';
  FOR r IN
    SELECT COALESCE(sku,'(null)') AS sku,
           COALESCE(is_listing_inactive_not_buyable,false) AS nb,
           listing_inactive_detected_at AS det, listing_inactive_cleared_at AS clr,
           COALESCE(amazon_listing_state,'(null)') AS st,
           COALESCE(status,'(null)') AS active
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | nb % | det % | clr % | state % | status %',
      r.sku, r.nb, r.det, r.clr, r.st, r.active;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE -- no repricer assignment, so no Amazon buyability';
    RAISE NOTICE '   signal exists for it, and the repricer is not managing it.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'the 10 biggest 30-day sellers still marked INACTIVE:';
  FOR r IN
    SELECT asin, COALESCE(sku,'(null)') AS sku, av, rv, ib, u30,
           CASE WHEN n_assign IS NULL THEN 'no-assignment'
                WHEN nb_now THEN 'NOT-BUYABLE' ELSE 'amazon-ok' END AS verdict
    FROM pop ORDER BY u30 DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % | av % rv % ib % | %u/30d | %',
      rpad(r.asin,12), rpad(r.sku,20), lpad(r.av::text,2), lpad(r.rv::text,2),
      lpad(r.ib::text,3), lpad(r.u30::text,3), r.verdict;
  END LOOP;

  DROP TABLE pop;
  RAISE NOTICE '';
  RAISE NOTICE 'READ ONLY -- nothing written.';
END
$p$;
