-- PROBE (read-only): batch 2 returned 51 unverifiable out of 60. That is a
-- different regime from batch 1 and worth understanding before spending more
-- SP-API budget -- the Orders API quota is shared with the repricer, so a
-- pointless sweep is not free.
--
-- Two candidates: Amazon's Orders API retention window (roughly two years,
-- after which GetOrderItems 404s), or throttling. Order age separates them.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== age of what remains on the shortlist ========';
  FOR r IN
    SELECT CASE
             WHEN order_date > now() - interval '90 days'  THEN 'under 90 days'
             WHEN order_date > now() - interval '365 days' THEN '90-365 days'
             WHEN order_date > now() - interval '730 days' THEN '1-2 years'
             ELSE 'over 2 years  <- outside Amazon retention'
           END AS bucket,
           count(*) AS n,
           min(order_date) AS oldest, max(order_date) AS newest
    FROM public.collapsed_order_candidates(v_uid, 5000)
    GROUP BY 1 ORDER BY min(order_date) DESC
  LOOP
    RAISE NOTICE '   %  : % rows  (% .. %)', rpad(r.bucket,34), r.n, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what the next batch would face ========';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE order_date > now() - interval '730 days') AS within_retention
    FROM public.collapsed_order_candidates(v_uid, 60)
  LOOP
    RAISE NOTICE '   next 60 candidates: % of them are inside the 2-year window',
      r.within_retention;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== value still on the table, by age ========';
  FOR r IN
    SELECT CASE WHEN order_date > now() - interval '730 days'
                THEN 'repairable' ELSE 'too old to verify' END AS bucket,
           count(*) AS n,
           round(sum(COALESCE(unit_cost,0) * implied_units - COALESCE(total_cost,0))::numeric, 2) AS cogs_understated
    FROM public.collapsed_order_candidates(v_uid, 5000)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   %  : % rows, COGS understated by about %',
      rpad(r.bucket,20), r.n, r.cogs_understated;
    RAISE NOTICE '      (estimate from the fee ratio -- Amazon confirms the real figure)';
  END LOOP;
END
$probe$;
