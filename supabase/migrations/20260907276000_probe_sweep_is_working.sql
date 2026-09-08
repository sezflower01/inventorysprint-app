-- PROBE (read-only): the fixed cleanup deployed at 14:56 UTC and runs at
-- 15 */6. So it has had two runs since (18:15 and 00:15). Did they disable
-- anything? And of the 242 current orphans, how many predate the last run --
-- i.e. how many the sweep genuinely MISSED rather than has not reached yet.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== disables per hour since the fix deployed (14:56 UTC) ========';
  FOR r IN
    SELECT date_trunc('hour', last_disabled_at) AS hr,
           COALESCE(last_disabled_by,'?') AS who,
           count(*) AS n
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND last_disabled_at > '2026-09-07 14:00:00+00'
    GROUP BY 1,2 ORDER BY 1
  LOOP
    RAISE NOTICE '   % by %  : % rows', r.hr, rpad(r.who,20), r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== of the 242 orphans: reached by a sweep yet? ========';
  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE a.updated_at < '2026-09-08 00:15:00+00') AS predates_last_run,
      count(*) FILTER (WHERE a.updated_at >= '2026-09-08 00:15:00+00') AS after_last_run
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
  LOOP
    RAISE NOTICE '   % orphans total', r.total;
    RAISE NOTICE '   % changed AFTER the 00:15 run  -> next run at 06:15 will see them',
      r.after_last_run;
    RAISE NOTICE '   % predate it                   -> genuinely missed', r.predates_last_run;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the ones that predate it, in detail ========';
  FOR r IN
    SELECT a.asin, a.sku, a.marketplace, a.updated_at,
           COALESCE(rr.name,'(no rule)') AS rule_name,
           EXISTS (SELECT 1 FROM public.sales_orders s
                   WHERE s.user_id = v_uid AND s.asin = a.asin
                     AND s.order_date > now() - interval '365 days') AS sold_365d
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND i.sku IS NULL
      AND a.updated_at < '2026-09-08 00:15:00+00'
    ORDER BY a.updated_at DESC LIMIT 25
  LOOP
    RAISE NOTICE '   % | % | % | % | sold_365d=%',
      r.asin, rpad(left(r.sku,22),22), r.marketplace, rpad(left(r.rule_name,16),16), r.sold_365d;
  END LOOP;
END
$probe$;
