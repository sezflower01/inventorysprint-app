-- READ-ONLY. The row on ONE line (jsonb_pretty got truncated), plus the
-- refresh queue and repricer assignment state.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the row, field by field ==';
  FOR r IN
    SELECT COALESCE(sku,'(null)') AS sku, COALESCE(fnsku,'(null)') AS fnsku,
           COALESCE(available::text,'NULL') AS avail,
           COALESCE(reserved::text,'NULL') AS reserved,
           COALESCE(inbound::text,'NULL') AS inbound,
           COALESCE(unfulfilled::text,'NULL') AS unful,
           COALESCE(units::text,'NULL') AS units,
           COALESCE(source,'(null)') AS src,
           COALESCE(listing_status,'(null)') AS lstatus,
           COALESCE(fba_blocked::text,'NULL') AS fba_blocked,
           COALESCE(fba_block_reason,'(none)') AS block_reason,
           COALESCE(ghost_reason,'(none)') AS ghost_reason,
           COALESCE(ghosted_at::text,'(never)') AS ghosted_at,
           COALESCE(deleted_reason,'(none)') AS del_reason,
           COALESCE(cost::text,'-') AS cost, COALESCE(amount::text,'-') AS amount,
           COALESCE(price::text,'-') AS price, COALESCE(my_price::text,'-') AS my_price,
           COALESCE(last_inventory_sync_at::text,'(never)') AS last_inv_sync,
           COALESCE(last_summaries_at::text,'(never)') AS last_summaries,
           updated_at, created_at
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | fnsku %', r.sku, r.fnsku;
    RAISE NOTICE '   available % | reserved % | inbound % | unfulfilled % | units %',
      r.avail, r.reserved, r.inbound, r.unful, r.units;
    RAISE NOTICE '   source % | listing_status %', r.src, r.lstatus;
    RAISE NOTICE '   fba_blocked % | reason %', r.fba_blocked, r.block_reason;
    RAISE NOTICE '   ghost_reason % | ghosted_at % | deleted_reason %',
      r.ghost_reason, r.ghosted_at, r.del_reason;
    RAISE NOTICE '   cost % | amount % | price % | my_price %',
      r.cost, r.amount, r.price, r.my_price;
    RAISE NOTICE '   last_inventory_sync_at % <<< the 09/03 the UI shows', r.last_inv_sync;
    RAISE NOTICE '   last_summaries_at % | updated_at % | created_at %',
      r.last_summaries, r.updated_at, r.created_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== inventory_refresh_queue entries ==';
  FOR r IN
    SELECT to_jsonb(q)::text AS j FROM public.inventory_refresh_queue q
    WHERE q.user_id = v_uid AND q.asin = 'B00LFXMBKI'
  LOOP RAISE NOTICE '   %', left(r.j, 600); END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NOT IN THE QUEUE at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== repricer_assignments for it ==';
  FOR r IN
    SELECT to_jsonb(a)::text AS j FROM public.repricer_assignments a
    WHERE a.user_id = v_uid AND a.asin = 'B00LFXMBKI'
  LOOP RAISE NOTICE '   %', left(r.j, 700); END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO repricer assignment'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what do the OTHER 212 stale rows look like? is it a cluster? ==';
  FOR r IN
    SELECT COALESCE(source,'(null)') AS src, COALESCE(listing_status,'(null)') AS lstatus,
           count(*) AS rows,
           count(*) FILTER (WHERE COALESCE(available,0) = 0) AS zero_avail,
           count(*) FILTER (WHERE COALESCE(ghost_reason,'') <> '') AS ghosted
    FROM public.inventory
    WHERE user_id = v_uid AND updated_at < now() - interval '30 days'
    GROUP BY 1,2 ORDER BY rows DESC LIMIT 10
  LOOP
    RAISE NOTICE '   source % | status % | % rows | % zero avail | % ghosted',
      rpad(r.src,22), rpad(r.lstatus,12), lpad(r.rows::text,4), r.zero_avail, r.ghosted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does the valuation summary include it? ==';
  FOR r IN
    SELECT to_jsonb(v)::text AS j FROM public.inventory_valuation_summary v
    WHERE v.user_id = v_uid LIMIT 1
  LOOP RAISE NOTICE '   summary shape: %', left(r.j, 400); END LOOP;
END
$p$;
