-- READ-ONLY PROBE. fn_protect_ghost_tombstone is a BEFORE UPDATE trigger on
-- inventory that touches listing_status -- the likely reason the revive cleared
-- ghosted_at but could not move listing_status off NOT_IN_CATALOG. Read it, and
-- fn_inventory_freshness_guard beside it, before changing anything.

DO $p$
DECLARE r record; v_def text;
BEGIN
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('fn_protect_ghost_tombstone', 'fn_inventory_freshness_guard')
           ORDER BY p.proname LOOP
    RAISE NOTICE '=== % ===', r.proname;
    FOR v_def IN SELECT unnest(string_to_array(r.def, chr(10))) LOOP
      RAISE NOTICE '%', v_def;
    END LOOP;
    RAISE NOTICE ' ';
  END LOOP;
END
$p$;
