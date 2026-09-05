-- Read-only: 6.3 GB of the 7.0 GB table is indexes. Which earn their place?
DO $$
DECLARE r RECORD; v_unused bigint := 0; v_unused_n int := 0;
BEGIN
  FOR r IN
    SELECT i.indexrelname AS name,
           pg_relation_size(i.indexrelid) AS bytes,
           i.idx_scan
    FROM pg_stat_user_indexes i
    WHERE i.relname = 'repricer_price_actions'
    ORDER BY pg_relation_size(i.indexrelid) DESC
  LOOP
    RAISE NOTICE '  % | % | % scans',
      rpad(r.name, 42), lpad(pg_size_pretty(r.bytes), 9), r.idx_scan;
    IF r.idx_scan = 0 THEN
      v_unused := v_unused + r.bytes;
      v_unused_n := v_unused_n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'NEVER SCANNED: % indexes totalling %', v_unused_n, pg_size_pretty(v_unused);
  RAISE NOTICE 'stats since: %', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database());
END $$;
