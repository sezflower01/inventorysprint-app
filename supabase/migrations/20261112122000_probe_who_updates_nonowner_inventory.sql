-- Is the catalogue copy in e697c7c7's account still being maintained? READ ONLY.
--
-- 3,790 of its 3,820 inventory rows share an (asin, sku) with the operator, all
-- created 2026-04-06, yet updated_at reached 2026-11-12. That account last
-- signed in 2026-07-01 and sync-amazon-inventory is per-user (it reads
-- user.id), so a signed-in session cannot explain today's timestamp. Either a
-- cron sweeps all users, a trigger touches updated_at, or the max is a single
-- stray row. The three look identical in a MAX() and mean very different
-- things, so this spreads them out.
DO $p$
DECLARE v_owner uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9'; r record; n bigint;
BEGIN
  RAISE NOTICE '=== updated_at spread for the non-owner rows ===';
  FOR r IN
    SELECT updated_at::date AS d, COUNT(*) AS rows
    FROM public.inventory WHERE user_id <> v_owner
    GROUP BY 1 ORDER BY 1 DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % : % rows', r.d, r.rows;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== queue rows for that user (would mean a worker still picks it up) ===';
  FOR r IN
    SELECT table_name AS t FROM information_schema.tables
    WHERE table_schema='public' AND table_name LIKE '%queue%' ORDER BY 1
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=r.t AND column_name='user_id') THEN
      EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE user_id <> %L', r.t, v_owner) INTO n;
      RAISE NOTICE '  % : % non-owner rows', rpad(r.t,34), n;
    END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== any pg_cron job whose command mentions inventory ===';
  FOR r IN
    SELECT jobname, schedule, active FROM cron.job
    WHERE command ILIKE '%inventor%' ORDER BY jobname
  LOOP
    RAISE NOTICE '  % (%) active=%', rpad(r.jobname,42), r.schedule, r.active;
  END LOOP;
END $p$;
