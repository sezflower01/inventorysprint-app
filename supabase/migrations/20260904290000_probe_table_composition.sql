-- Read-only: where do the 7 GB actually live?
DO $$
DECLARE
  v_total bigint; v_main bigint; v_idx bigint; v_toast bigint; v_toast_oid oid;
  r RECORD;
BEGIN
  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass),
         pg_relation_size('public.repricer_price_actions'::regclass),
         pg_indexes_size('public.repricer_price_actions'::regclass)
    INTO v_total, v_main, v_idx;
  SELECT reltoastrelid INTO v_toast_oid FROM pg_class
   WHERE oid = 'public.repricer_price_actions'::regclass;
  v_toast := CASE WHEN v_toast_oid = 0 THEN 0
                  ELSE pg_total_relation_size(v_toast_oid) END;

  RAISE NOTICE 'total % = main % + indexes % + TOAST %',
    pg_size_pretty(v_total), pg_size_pretty(v_main),
    pg_size_pretty(v_idx), pg_size_pretty(v_toast);

  -- Which column is big enough to be TOASTed?
  FOR r IN
    SELECT a.attname, t.typname, a.attstorage
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = 'public.repricer_price_actions'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attstorage IN ('x','e','m')
  LOOP
    RAISE NOTICE '  toastable column: % (%)', r.attname, r.typname;
  END LOOP;
END $$;
