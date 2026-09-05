-- Read-only: is there room to rewrite the biggest table?
--
-- VACUUM FULL builds a complete new copy before dropping the old one, so it
-- needs free space roughly equal to the table it is rewriting. On a nearly
-- full volume it fails partway and leaves the original untouched -- or worse,
-- fills the disk.
DO $$
DECLARE v_tbl bigint; v_db bigint;
BEGIN
  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass) INTO v_tbl;
  SELECT pg_database_size(current_database()) INTO v_db;
  RAISE NOTICE 'repricer_price_actions: % (of a % database)',
    pg_size_pretty(v_tbl), pg_size_pretty(v_db);
  RAISE NOTICE 'VACUUM FULL needs roughly % of FREE disk to rewrite it',
    pg_size_pretty(v_tbl);
  RAISE NOTICE 'indexes on that table: %',
    pg_size_pretty(pg_total_relation_size('public.repricer_price_actions'::regclass)
                   - pg_relation_size('public.repricer_price_actions'::regclass));
END $$;
