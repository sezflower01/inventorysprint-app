-- International panel, the four edges. READ ONLY.
--
-- Probe 1 (20261111140000) confirmed the panel's arithmetic to the cent and
-- found no dropped column. It also found 61 negative referral_fees rows and 9
-- negative other_fees rows -- which the RPC nets correctly, referral via
-- ABS(SUM(..)) per 20260814100000 and other_fees via a signed SUM(..). This
-- probe tests the cases that an ACCOUNT-WIDE verification could not see:
--
--   1. ABS(SUM()) is only safe while the NET stays positive. The 2026-08-14 fix
--      was verified account-wide, all marketplaces, all time. This panel slices
--      by (marketplace, month), where BR has 75 units all year -- so a single
--      month with more referral credit-backs than charges would be flipped from
--      a credit into a charge.
--   2. "Data through" reads financial_events_cache filtered on marketplace ONLY
--      -- no year. On a past year the panel would report the newest event of ALL
--      time, i.e. claim a closed year is current to yesterday.
--   3. Revenue is booked on event_date, COGS on order_date. 49 of 1,153 non-US
--      2026 events cross a year boundary. Quantify the dollars.
--   4. A financial event with no matching sales_orders row contributes revenue
--      and fees but no COGS at all -- pure overstated profit. Measure the match
--      rate per marketplace.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  RAISE NOTICE '=== 1. ABS(SUM()) FLIP RISK: (marketplace, month) net referral/other < 0 ===';
  FOR r IN
    SELECT UPPER(f.marketplace) AS mp,
           EXTRACT(MONTH FROM f.event_date::date)::int AS m,
           SUM(COALESCE(f.referral_fees,0)) AS net_ref,
           SUM(COALESCE(f.other_fees,0))    AS net_other
    FROM public.financial_events_cache f
    WHERE f.user_id = v_uid
      AND UPPER(COALESCE(f.marketplace,'')) IN ('CA','MX','BR')
      AND f.event_date::date >= '2026-01-01' AND f.event_date::date < '2027-01-01'
    GROUP BY 1,2
    HAVING SUM(COALESCE(f.referral_fees,0)) < 0 OR SUM(COALESCE(f.other_fees,0)) < 0
    ORDER BY 1,2
  LOOP
    RAISE NOTICE 'FLIP %-% net referral % net other %', r.mp, r.m,
      to_char(r.net_ref,'FM999999990.00'), to_char(r.net_other,'FM999999990.00');
  END LOOP;
  RAISE NOTICE '(no FLIP lines above = every month nets positive, ABS is a no-op)';

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 2. "Data through" YEAR BUG: non-US events per year ===';
  FOR r IN
    SELECT UPPER(marketplace) AS mp,
           EXTRACT(YEAR FROM event_date::date)::int AS y,
           COUNT(*) AS n, MAX(event_date::date) AS newest
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND UPPER(COALESCE(marketplace,'')) IN ('CA','MX','BR')
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '% year % : % events, newest %', r.mp, r.y, r.n, r.newest;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 3. DATE-BASIS MISMATCH in dollars, non-US ===';
  FOR r IN
    WITH j AS (
      SELECT UPPER(f.marketplace) AS mp,
             EXTRACT(YEAR FROM f.event_date::date)::int AS ev_y,
             EXTRACT(YEAR FROM s.order_date)::int       AS ord_y,
             ABS(COALESCE(f.sales,0)) AS rev
      FROM public.financial_events_cache f
      JOIN public.sales_orders s ON s.user_id = f.user_id AND s.order_id = f.amazon_order_id
      WHERE f.user_id = v_uid AND f.event_type = 'shipment'
        AND UPPER(COALESCE(f.marketplace,'')) IN ('CA','MX','BR')
    )
    SELECT mp,
           SUM(rev) FILTER (WHERE ev_y = 2026 AND ord_y < 2026)  AS rev_in_no_cogs,
           COUNT(*) FILTER (WHERE ev_y = 2026 AND ord_y < 2026)  AS n_in,
           SUM(rev) FILTER (WHERE ev_y > 2026 AND ord_y = 2026)  AS rev_out_cogs_here,
           COUNT(*) FILTER (WHERE ev_y > 2026 AND ord_y = 2026)  AS n_out
    FROM j GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '% revenue in 2026 from pre-2026 orders: % (% events) | 2026 orders settling later: % (% events)',
      r.mp, to_char(COALESCE(r.rev_in_no_cogs,0),'FM999999990.00'), r.n_in,
      to_char(COALESCE(r.rev_out_cogs_here,0),'FM999999990.00'), r.n_out;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== 4. ORPHAN EVENTS: non-US 2026 shipment revenue with no sales_orders row ===';
  FOR r IN
    SELECT UPPER(f.marketplace) AS mp,
           COUNT(*) AS events,
           COUNT(*) FILTER (WHERE s.order_id IS NULL) AS orphans,
           COALESCE(SUM(ABS(COALESCE(f.sales,0))) FILTER (WHERE s.order_id IS NULL),0) AS orphan_rev,
           COALESCE(SUM(ABS(COALESCE(f.sales,0))),0) AS all_rev
    FROM public.financial_events_cache f
    LEFT JOIN public.sales_orders s
      ON s.user_id = f.user_id AND s.order_id = f.amazon_order_id
    WHERE f.user_id = v_uid AND f.event_type = 'shipment'
      AND UPPER(COALESCE(f.marketplace,'')) IN ('CA','MX','BR')
      AND f.event_date::date >= '2026-01-01' AND f.event_date::date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '% % events, % orphaned, orphan revenue % of % total',
      r.mp, r.events, r.orphans,
      to_char(r.orphan_rev,'FM999999990.00'), to_char(r.all_rev,'FM999999990.00');
  END LOOP;
END $p$;
