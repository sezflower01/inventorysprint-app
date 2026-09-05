-- Read-only: is the realtime publication still carrying the hot table?
DO $$
DECLARE r RECORD; v bigint;
BEGIN
  SELECT count(*) INTO v FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime';
  RAISE NOTICE 'tables in supabase_realtime publication: %', v;

  FOR r IN
    SELECT pt.tablename,
           COALESCE(s.n_tup_ins + s.n_tup_upd + s.n_tup_del, 0) AS writes
    FROM pg_publication_tables pt
    LEFT JOIN pg_stat_user_tables s ON s.relname = pt.tablename
    WHERE pt.pubname = 'supabase_realtime'
    ORDER BY writes DESC LIMIT 10
  LOOP
    RAISE NOTICE '  % : % writes since stats reset', rpad(r.tablename, 34), r.writes;
  END LOOP;
END $$;
