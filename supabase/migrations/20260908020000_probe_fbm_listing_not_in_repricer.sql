-- PROBE (read-only): B0G2YNN87D shows its FBA SKU (MAQ-E85-W0JD) in the
-- repricer. The seller created an FBM listing for the same ASIN and it has not
-- appeared. Find out where it stops.
--
-- Candidate stalls, each with a different fix:
--   1. no inventory row     -> the sync has not picked the SKU up at all
--   2. row but no assignment-> sync found it, auto-assign did not run or refused
--   3. assignment disabled  -> auto-assign enabled then something disabled it
--   4. row with zero stock  -> the grid hides it (available = 0)
--
-- Point 4 matters here specifically: inventory has ONE available column for two
-- fulfilment channels, and FBA-only writers are known to zero real FBM quantity
-- (see the fba-writers-zero-fbm-stock note). An FBM row that exists but reads 0
-- available is invisible in the grid and looks identical to "never synced".
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G2YNN87D';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== every inventory row for % ========', v_asin;
  FOR r IN
    SELECT sku, source, listing_status, fnsku,
           COALESCE(available,0) AS avail, COALESCE(reserved,0) AS resv,
           COALESCE(inbound,0) AS inb, COALESCE(unfulfilled,0) AS unful,
           my_price, created_at, updated_at, last_inventory_sync_at
    FROM public.inventory
    WHERE user_id = v_uid AND asin = v_asin
    ORDER BY created_at
  LOOP
    RAISE NOTICE '   sku=%  source=%  status=%',
      rpad(r.sku,16), rpad(COALESCE(r.source,'-'),18), COALESCE(r.listing_status,'-');
    RAISE NOTICE '       fnsku=%  avail=% resv=% inb=% unful=%  price=%',
      COALESCE(r.fnsku,'(none)'), r.avail, r.resv, r.inb, r.unful, COALESCE(r.my_price::text,'-');
    RAISE NOTICE '       created=%  updated=%  amazon_confirmed=%',
      r.created_at, r.updated_at, COALESCE(r.last_inventory_sync_at::text,'NEVER');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== repricer assignments for % ========', v_asin;
  FOR r IN
    SELECT a.sku, a.marketplace, a.is_enabled,
           COALESCE(rr.name,'(no rule)') AS rule_name,
           a.created_at, a.updated_at,
           COALESCE(a.last_disabled_by,'-') AS dis_by,
           COALESCE(a.last_disabled_reason,'-') AS dis_reason
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE a.user_id = v_uid AND a.asin = v_asin
    ORDER BY a.created_at
  LOOP
    RAISE NOTICE '   sku=%  %  enabled=%  rule=%',
      rpad(r.sku,16), r.marketplace, r.is_enabled, r.rule_name;
    RAISE NOTICE '       created=%  updated=%', r.created_at, r.updated_at;
    RAISE NOTICE '       disabled_by=%  reason=%', r.dis_by, left(r.dis_reason,70);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how long do OTHER new SKUs take to reach an assignment? ========';
  FOR r IN
    SELECT date_trunc('day', i.created_at)::date AS created_day,
           count(*) AS new_skus,
           count(a.sku) AS got_assignment,
           round(avg(EXTRACT(EPOCH FROM (a.created_at - i.created_at))/60.0)::numeric, 1) AS avg_minutes
    FROM public.inventory i
    LEFT JOIN public.repricer_assignments a
           ON a.user_id = i.user_id AND a.sku = i.sku AND a.marketplace = 'US'
    WHERE i.user_id = v_uid AND i.created_at > now() - interval '14 days'
    GROUP BY 1 ORDER BY 1 DESC LIMIT 10
  LOOP
    RAISE NOTICE '   %  new_skus=%  assigned=%  avg lag=% min',
      r.created_day, r.new_skus, r.got_assignment, COALESCE(r.avg_minutes::text,'n/a');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many FBM rows exist at all, and how fresh? ========';
  FOR r IN
    SELECT COALESCE(source,'(null)') AS src, count(*) AS n,
           count(*) FILTER (WHERE COALESCE(available,0) > 0) AS with_stock,
           max(created_at) AS newest_row
    FROM public.inventory WHERE user_id = v_uid
    GROUP BY 1 ORDER BY n DESC LIMIT 8
  LOOP
    RAISE NOTICE '   %  rows=%  with_stock=%  newest=%',
      rpad(r.src,20), r.n, r.with_stock, r.newest_row;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is the FBM sync job even scheduled? ========';
  BEGIN
    FOR r IN
      SELECT jobname, schedule, active FROM cron.job
      WHERE command ILIKE '%fbm%' OR command ILIKE '%merchant%'
         OR command ILIKE '%all-listings%' OR command ILIKE '%sync-amazon-inventory%'
    LOOP
      RAISE NOTICE '   % | % | active=%', r.jobname, r.schedule, r.active;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '   (cron.job unreadable: %)', SQLERRM;
  END;
END
$probe$;
