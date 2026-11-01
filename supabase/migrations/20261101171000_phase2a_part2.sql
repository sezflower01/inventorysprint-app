-- PHASE 2a part 2: the sections that scrolled past, plus the 2f split.
-- READ ONLY.
--
-- The part-1 survey mixed INACTIVE in with the true tombstones. They are not
-- the same problem and must not be counted together:
--   * NOT_IN_CATALOG / DELETED are the PROTECTED tombstone. The
--     fn_protect_ghost_tombstone trigger silently reverts any attempt to move
--     listing_status away from them unless the write also sets
--     source = 'force_relist'. These are the "false tombstones".
--   * INACTIVE is an ordinary status with no trigger protection. It blocks
--     dispatch, which is why it matters, but clearing it needs no hatch.
DO $p$
DECLARE r record; v_uid uuid; v_tomb int; v_inact int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '############ B00LFXMBKI ############';
  FOR r IN
    SELECT COALESCE(sku,'(null)') AS sku, COALESCE(listing_status,'(null)') AS st,
           COALESCE(available,0) AS av, COALESCE(reserved,0) AS rv,
           COALESCE(inbound,0) AS ib, COALESCE(unfulfilled,0) AS uf,
           COALESCE(source,'-') AS src, last_inventory_sync_at AS synced
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | status % | avail % resv % inbound % unfulfilled %',
      r.sku, r.st, r.av, r.rv, r.ib, r.uf;
    RAISE NOTICE '      source % | synced %', r.src, r.synced;
  END LOOP;
  FOR r IN
    SELECT sum(quantity) FILTER (WHERE order_date >= current_date - 30) AS u30,
           sum(quantity) FILTER (WHERE order_date >= current_date - 90) AS u90,
           max(order_date) AS last_sale
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI' AND order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   sold 30d % | 90d % | last sale %',
      COALESCE(r.u30,0), COALESCE(r.u90,0), r.last_sale;
  END LOOP;
  RAISE NOTICE '   NOTE: it is INACTIVE, not NOT_IN_CATALOG -- the protected';
  RAISE NOTICE '   tombstone was already lifted (20261020090000_revive_b00lfxmbki).';
  RAISE NOTICE '   So the remaining lock on it is the INACTIVE status and a zero';
  RAISE NOTICE '   `available`, NOT the trigger. Different fix.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2f: THE SPLIT THAT MATTERS ############';
  SELECT count(*) INTO v_tomb
  FROM public.inventory i
  WHERE i.user_id = v_uid
    AND upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
    AND (COALESCE(i.available,0)+COALESCE(i.reserved,0)
        +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0
      OR EXISTS (SELECT 1 FROM public.sales_orders s
                  WHERE s.user_id=v_uid AND s.asin=i.asin
                    AND s.order_id NOT LIKE '%-REFUND%'
                    AND s.order_date >= current_date - 90));
  SELECT count(*) INTO v_inact
  FROM public.inventory i
  WHERE i.user_id = v_uid
    AND upper(COALESCE(i.listing_status,'')) = 'INACTIVE'
    AND (COALESCE(i.available,0)+COALESCE(i.reserved,0)
        +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0
      OR EXISTS (SELECT 1 FROM public.sales_orders s
                  WHERE s.user_id=v_uid AND s.asin=i.asin
                    AND s.order_id NOT LIKE '%-REFUND%'
                    AND s.order_date >= current_date - 90));
  RAISE NOTICE '   PROTECTED tombstones (NOT_IN_CATALOG/DELETED) that sold in';
  RAISE NOTICE '   90d or hold stock : %  <= the actual false-tombstone set', v_tomb;
  RAISE NOTICE '   INACTIVE with the same test        : %  <= separate problem', v_inact;

  RAISE NOTICE '';
  RAISE NOTICE '   the protected ones, in full:';
  RAISE NOTICE '   asin         | sku                  | status         | av | rv | ib | u90 | sync age';
  FOR r IN
    WITH sold AS (
      SELECT asin, sum(quantity) AS u90 FROM public.sales_orders
      WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
        AND order_date >= current_date - 90 GROUP BY asin)
    SELECT i.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.listing_status,'(null)') AS st,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib, COALESCE(s.u90,0) AS u90,
           CASE WHEN i.last_inventory_sync_at IS NULL THEN 'never'
                ELSE (extract(epoch from (now()-i.last_inventory_sync_at))/86400)::int || 'd'
           END AS age
    FROM public.inventory i
    LEFT JOIN sold s ON s.asin = i.asin
    WHERE i.user_id = v_uid
      AND upper(COALESCE(i.listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')
      AND (COALESCE(i.available,0)+COALESCE(i.reserved,0)
          +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0
        OR COALESCE(s.u90,0) > 0)
    ORDER BY COALESCE(s.u90,0) DESC, i.asin
  LOOP
    RAISE NOTICE '   % | % | % | % | % | % | % | %',
      rpad(r.asin,12), rpad(r.sku,20), rpad(r.st,14),
      lpad(r.av::text,2), lpad(r.rv::text,2), lpad(r.ib::text,2),
      lpad(r.u90::text,3), r.age;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ THE THREE WRITERS: still scheduled? ############';
  FOR r IN
    SELECT j.jobname, j.schedule, j.active,
           max(d.start_time) AS last_run,
           count(d.*) FILTER (WHERE d.start_time >= now() - interval '7 days') AS runs_7d
    FROM cron.job j
    LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.command ILIKE '%clean-ghost-listings%'
       OR j.command ILIKE '%nightly-ghost-cleanup%'
       OR j.command ILIKE '%check-fba-listing-eligibility%'
    GROUP BY 1,2,3 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | active % | % runs/7d | last %',
      rpad(r.jobname,34), rpad(r.schedule,14), r.active,
      lpad(r.runs_7d::text,4), r.last_run;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   none of the three is on pg_cron -- they run from the app or';
    RAISE NOTICE '   by hand. That matters: a re-tombstone would follow a USER';
    RAISE NOTICE '   action, not a nightly job, so a 24h watch after a revival';
    RAISE NOTICE '   only proves anything if one of them is invoked meanwhile.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '############ THE TRIGGER ############';
  FOR r IN
    SELECT t.tgname, c.relname AS tbl,
           CASE t.tgenabled WHEN 'O' THEN 'enabled' WHEN 'D' THEN 'DISABLED'
                            ELSE t.tgenabled::text END AS state,
           p.proname AS fn
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname ILIKE '%ghost_tombstone%'
  LOOP
    RAISE NOTICE '   % on % | % | fn %', r.tgname, r.tbl, r.state, r.fn;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   >>> NOT INSTALLED. The protection the code comments rely on';
    RAISE NOTICE '   >>> does not exist in this database.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
