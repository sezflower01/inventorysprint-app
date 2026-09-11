-- PROBE (read-only): two results.
--
-- 1. The FBM sync fix. Job 78 was switched to the vault x-internal-secret in
--    20260911041000 and one run of sync-fbm-cleanup-all was dispatched as
--    request 105120. Its response lists dispatched / skipped / per-user errors
--    from the fan-out to sync-fbm-cleanup, which is the half of the chain the
--    fix did not touch. The fan-out awaits each per-user call, so the response
--    may not be in yet -- say so rather than read silence as success.
--    Evidence of real work: a bulk write to amazon_sync_fbm rows. The last one
--    before the fix was 2026-08-15 20:45 (47 rows).
--
-- 2. The collapsed-orders sweep ended: job 187 unscheduled itself at the
--    17:07 UTC tick via its 2-hour stall guard, after the shortlist fell from
--    290 to 5 and every later run recorded 0 of those 5. What did the 285
--    verdicts actually find, and why do the last 5 never settle?
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1a. sync-fbm-cleanup-all verification run (request 105120) ========';
  v_n := 0;
  FOR r IN
    SELECT created, status_code, timed_out,
           left(COALESCE(error_msg,''), 200) AS err,
           left(regexp_replace(COALESCE(content::text,''), '\s+', ' ', 'g'), 700) AS body
    FROM net._http_response WHERE id = 105120
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   created % status % timed_out %', r.created, r.status_code, r.timed_out;
    IF r.err <> '' THEN RAISE NOTICE '   error: %', r.err; END IF;
    RAISE NOTICE '   body: %', r.body;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no response yet -- the fan-out awaits each per-user sync; re-read shortly';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== 1b. bulk writes to amazon_sync_fbm rows (last before fix: 2026-08-15 20:45) ========';
  FOR r IN
    SELECT date_trunc('minute', last_inventory_sync_at) AS m, count(*) AS n
    FROM public.inventory
    WHERE user_id = v_uid AND source = 'amazon_sync_fbm' AND last_inventory_sync_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= 5
    ORDER BY 1 DESC LIMIT 4
  LOOP
    RAISE NOTICE '   % : % rows', r.m, r.n;
  END LOOP;
  FOR r IN
    SELECT count(*) FILTER (WHERE updated_at > '2026-09-11 21:00:00+00') AS touched_since_fix,
           count(*) AS total
    FROM public.inventory WHERE user_id = v_uid AND source = 'amazon_sync_fbm'
  LOOP
    RAISE NOTICE '   amazon_sync_fbm rows touched since 21:00 UTC: % of %', r.touched_since_fix, r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2a. the sweep''s 285 verdicts ========';
  FOR r IN
    SELECT outcome, count(*) AS n, min(checked_at) AS first_at, max(checked_at) AS last_at
    FROM public.collapsed_order_checks
    GROUP BY outcome ORDER BY n DESC
  LOOP
    RAISE NOTICE '   %  % rows (% .. %)', rpad(r.outcome,18), r.n, r.first_at, r.last_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2b. rows the sweep changed, and the COGS they now carry ========';
  FOR r IN
    SELECT count(*) AS n, sum(s.quantity) AS units,
           round(sum(COALESCE(s.total_cost,0))::numeric, 2) AS cogs,
           round(sum(COALESCE(s.total_sale_amount,0))::numeric, 2) AS revenue
    FROM public.collapsed_order_checks c
    JOIN public.sales_orders s ON s.id = c.sales_order_id
    WHERE c.outcome = 'repaired'
  LOOP
    RAISE NOTICE '   % repaired rows now hold % units, COGS %, revenue %', r.n, r.units, r.cogs, r.revenue;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2c. the 5 rows that never settled ========';
  FOR r IN
    SELECT order_id, asin, marketplace, order_date, quantity,
           round(total_sale_amount::numeric,2) AS rev, implied_units
    FROM public.collapsed_order_candidates(v_uid, 50)
  LOOP
    RAISE NOTICE '   % % % % qty=% rev=% implied=%',
      r.order_date, r.order_id, r.marketplace, r.asin, r.quantity, r.rev, r.implied_units;
  END LOOP;
  FOR r IN
    SELECT created,
           (content::jsonb ->> 'checked') AS chk,
           (content::jsonb ->> 'throttled') AS thr,
           (content::jsonb ->> 'unverifiable') AS unv,
           (content::jsonb ->> 'checks_recorded') AS rec
    FROM net._http_response
    WHERE content::text LIKE '%checks_recorded%'
    ORDER BY created DESC LIMIT 3
  LOOP
    RAISE NOTICE '   last responses: % checked=% throttled=% unverifiable=% recorded=%',
      r.created, r.chk, r.thr, r.unv, r.rec;
  END LOOP;
END
$probe$;