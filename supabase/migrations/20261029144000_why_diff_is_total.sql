DO $p$
DECLARE r record; v_n int;
BEGIN
  RAISE NOTICE '== column drift: financial_events_cache vs fec_repull_backup ==';
  FOR r IN
    SELECT
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='financial_events_cache') AS live_cols,
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='fec_repull_backup') AS backup_cols
  LOOP RAISE NOTICE '   live % columns | backup % columns', r.live_cols, r.backup_cols; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   in LIVE but MISSING from the backup table:';
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache'
    EXCEPT
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fec_repull_backup'
    ORDER BY 1
  LOOP RAISE NOTICE '      !! %', r.column_name; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      none -- schemas match'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what the diff actually reports ==';
  FOR r IN
    SELECT verdict, count(*) AS n
    FROM public.fec_diff_month(
      (SELECT id FROM auth.users WHERE email='sezflower01@gmail.com'), '2026-05-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== one example row, both sides ==';
  FOR r IN
    SELECT verdict, event_type, event_date, COALESCE(amazon_order_id,'(null)') AS oid,
           COALESCE(asin,'(null)') AS asin,
           left(COALESCE(before_money::text,'(null)'),200) AS before_m,
           left(COALESCE(after_money::text,'(null)'),200) AS after_m
    FROM public.fec_diff_month(
      (SELECT id FROM auth.users WHERE email='sezflower01@gmail.com'), '2026-05-01'::date)
    LIMIT 1
  LOOP
    RAISE NOTICE '   verdict % | % | % | % | %', r.verdict, r.event_type, r.event_date, r.oid, r.asin;
    RAISE NOTICE '   BEFORE: %', r.before_m;
    RAISE NOTICE '   AFTER : %', r.after_m;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how did January manage? its backup is from 10-23 ==';
  SELECT count(*) INTO v_n FROM public.fec_diff_month(
    (SELECT id FROM auth.users WHERE email='sezflower01@gmail.com'), '2026-01-01'::date);
  RAISE NOTICE '   January diff rows: %', v_n;
END
$p$;
