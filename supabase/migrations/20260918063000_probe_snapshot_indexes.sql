-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- repricer-auto-lower-min needs "latest snapshot per ASIN". Which indexes
-- exist on repricer_competitor_snapshots, and how big is it?

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'repricer_competitor_snapshots' LOOP
    RAISE NOTICE '  %: %', r.indexname, r.indexdef;
  END LOOP;
  FOR r IN SELECT reltuples::bigint AS est_rows, pg_size_pretty(pg_total_relation_size('public.repricer_competitor_snapshots')) AS size
           FROM pg_class WHERE oid = 'public.repricer_competitor_snapshots'::regclass LOOP
    RAISE NOTICE 'estimated rows %, total size %', r.est_rows, r.size;
  END LOOP;
  FOR r IN SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'repricer_competitor_snapshots'
             AND column_name IN ('asin','marketplace','fetched_at','user_id','lowest_fba_price','lowest_overall_price','buybox_price') LOOP
    RAISE NOTICE '  column % %', r.column_name, r.data_type;
  END LOOP;
END
$p$;
