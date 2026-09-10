-- PROBE (read-only): a Supabase SA has offered an architecture review and named
-- Realtime as the first thing to dig into.
--
-- That is worth checking rather than dismissing, because this project already
-- diagnosed exactly that: 93% of database work was Realtime broadcasting a
-- 185-column row on every bookkeeping write. A WHEN-gated trigger fix was
-- written on 2026-08-27 and the note recorded that the migrations were NOT yet
-- applied. If that is still true, the outreach is pointing at a real and
-- still-open problem.
--
-- Establish: which tables are in the realtime publication, whether the gated
-- triggers exist, and what the write volume on the hot table looks like.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== tables in the realtime publication ========';
  SELECT count(*) INTO v_n
  FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
  RAISE NOTICE '   % tables published to supabase_realtime', v_n;
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
    ORDER BY tablename LIMIT 40
  LOOP
    RAISE NOTICE '      %.%', r.schemaname, r.tablename;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== replica identity on the published tables ========';
  -- FULL replica identity makes every UPDATE ship the ENTIRE old row as well as
  -- the new one. On a 185-column table that is the difference between a small
  -- delta and two full rows per write.
  FOR r IN
    SELECT c.relname,
           CASE c.relreplident
             WHEN 'd' THEN 'default (PK only)'
             WHEN 'f' THEN 'FULL  <- ships the whole old row'
             WHEN 'n' THEN 'nothing'
             WHEN 'i' THEN 'index'
           END AS identity,
           (SELECT count(*) FROM information_schema.columns ic
             WHERE ic.table_schema = 'public' AND ic.table_name = c.relname) AS cols
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
      )
    ORDER BY cols DESC LIMIT 20
  LOOP
    RAISE NOTICE '   %  % cols  | %', rpad(r.relname,34), r.cols, r.identity;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is the WHEN-gated trigger fix applied? ========';
  FOR r IN
    SELECT t.tgname, c.relname,
           CASE WHEN pg_get_triggerdef(t.oid) ILIKE '%WHEN %' THEN 'GATED' ELSE 'ungated' END AS gating
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = 'public'
      AND (t.tgname ILIKE '%realtime%' OR t.tgname ILIKE '%broadcast%'
           OR t.tgname ILIKE '%notify%')
    ORDER BY c.relname, t.tgname LIMIT 30
  LOOP
    RAISE NOTICE '   %  on %  -> %', rpad(r.tgname,42), rpad(r.relname,26), r.gating;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== write volume on the biggest published tables ========';
  FOR r IN
    SELECT relname,
           n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_del AS deletes,
           n_live_tup AS live_rows
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
      AND relname IN (
        SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
      )
    ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC LIMIT 12
  LOOP
    RAISE NOTICE '   %  ins=% upd=% del=%  live=%',
      rpad(r.relname,32), r.inserts, r.updates, r.deletes, r.live_rows;
  END LOOP;
END
$probe$;
