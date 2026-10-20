-- READ-ONLY. Is B00LFXMBKI still classified as a ghost anywhere?
--
-- src/lib/ghostFilter.ts says a row is GHOST when ANY of: listing_status is
-- NOT_IN_CATALOG/DELETED/INACTIVE/INCOMPLETE/SUPPRESSED, the SKU starts with
-- "amzn.gr.", or total stock is 0 while status is not ACTIVE. It mirrors
-- public.is_ghost_inventory_row(). Check the row against BOTH, and check
-- whether any cached/summary object still holds the pre-fix value.
DO $p$
DECLARE v_uid uuid; r record; v_relkind char;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the row, against each ghost clause ==';
  FOR r IN
    SELECT sku, COALESCE(listing_status,'(null)') AS ls,
           COALESCE(available,0) AS av, COALESCE(reserved,0) AS rs,
           COALESCE(inbound,0) AS ib, COALESCE(unfulfilled,0) AS uf,
           COALESCE(available,0)+COALESCE(reserved,0)+COALESCE(inbound,0)+COALESCE(unfulfilled,0) AS total,
           (upper(COALESCE(listing_status,'')) IN ('NOT_IN_CATALOG','DELETED')) AS c1_tombstone,
           (upper(COALESCE(listing_status,'')) IN ('INACTIVE','INCOMPLETE','SUPPRESSED')
             OR upper(COALESCE(listing_status,'')) LIKE '%INACTIVE%') AS c2_inactive,
           (lower(COALESCE(sku,'')) LIKE 'amzn.gr.%') AS c3_grading_sku,
           ((COALESCE(available,0)+COALESCE(reserved,0)+COALESCE(inbound,0)+COALESCE(unfulfilled,0)) <= 0
             AND upper(COALESCE(listing_status,'')) <> 'ACTIVE') AS c4_zero_not_active,
           COALESCE(last_inventory_sync_at::text,'never') AS sync
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | status % | stock % (%+%+%+%)',
      r.sku, r.ls, r.total, r.av, r.rs, r.ib, r.uf;
    RAISE NOTICE '   clause 1 tombstone (NOT_IN_CATALOG/DELETED) : %', r.c1_tombstone;
    RAISE NOTICE '   clause 2 inactive/incomplete/suppressed     : %', r.c2_inactive;
    RAISE NOTICE '   clause 3 amzn.gr. grading SKU               : %', r.c3_grading_sku;
    RAISE NOTICE '   clause 4 zero stock and not ACTIVE          : %', r.c4_zero_not_active;
    RAISE NOTICE '   >>> GHOST = %', (r.c1_tombstone OR r.c2_inactive OR r.c3_grading_sku OR r.c4_zero_not_active);
    RAISE NOTICE '   last_inventory_sync_at %', r.sync;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and what does the DB function say? (must agree with the TS) ==';
  BEGIN
    FOR r IN
      SELECT public.is_ghost_inventory_row(i) AS g
      FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
    LOOP RAISE NOTICE '   is_ghost_inventory_row() = %', r.g; END LOOP;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '   could not call it with a row arg (%); trying column args', SQLERRM;
    BEGIN
      FOR r IN
        SELECT public.is_ghost_inventory_row(i.listing_status, i.sku, i.available, i.reserved, i.inbound, i.unfulfilled) AS g
        FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
      LOOP RAISE NOTICE '   is_ghost_inventory_row() = %', r.g; END LOOP;
    EXCEPTION WHEN others THEN
      RAISE NOTICE '   signature not matched either (%)', SQLERRM;
      FOR r IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname ILIKE '%ghost%'
      LOOP RAISE NOTICE '   available: %(%)', r.proname, r.args; END LOOP;
    END;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '== is inventory_valuation_summary a TABLE (cached) or a VIEW (live)? ==';
  SELECT c.relkind INTO v_relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relname='inventory_valuation_summary';
  RAISE NOTICE '   relkind % (r=table, v=view, m=materialized view)', COALESCE(v_relkind::text,'(absent)');

  IF v_relkind = 'r' OR v_relkind = 'm' THEN
    RAISE NOTICE '   CACHED -- it may still hold the pre-fix numbers';
  ELSE
    RAISE NOTICE '   LIVE -- it recomputes from inventory on every read, nothing to refresh';
  END IF;
END
$p$;
