-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- sync-sales-orders runs every 10 min with no overlap lock. Before proposing a
-- tighter cadence: how long does a run take, and how do insert times cluster
-- relative to the :x0 cron ticks over the last 24h?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT to_jsonb(u) - 'user_id' AS j FROM public.user_sync_status u WHERE u.user_id = v_uid LOOP
    RAISE NOTICE 'user_sync_status: %', left(r.j::text, 900);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '-- new-order inserts in the last 24h, seconds after the 10-minute tick --';
  FOR r IN
    WITH x AS (
      SELECT created_at,
             (EXTRACT(MINUTE FROM created_at)::int % 10) * 60 + EXTRACT(SECOND FROM created_at) AS sec_after_tick
      FROM public.sales_orders
      WHERE user_id = v_uid AND created_at > now() - interval '24 hours'
    )
    SELECT count(*) AS n,
           count(*) FILTER (WHERE sec_after_tick < 30) AS within_30s,
           count(*) FILTER (WHERE sec_after_tick >= 30 AND sec_after_tick < 120) AS s30_120,
           count(*) FILTER (WHERE sec_after_tick >= 120) AS later,
           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY sec_after_tick)::numeric, 1) AS p90_sec
    FROM x
  LOOP
    RAISE NOTICE '  inserts: %  within 30s of a tick: %  30-120s: %  later (page-triggered syncs): %', r.n, r.within_30s, r.s30_120, r.later;
  END LOOP;
END
$p$;
