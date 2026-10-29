DO $p$
DECLARE r record; v_uid uuid; v_live int; v_bk int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-01-01' AND event_date < '2026-02-01';
  SELECT count(*) INTO v_bk FROM public.fec_repull_backup WHERE backup_month='2026-01-01';
  RAISE NOTICE '== January: live % rows | backup % rows ==', v_live, v_bk;

  RAISE NOTICE '';
  RAISE NOTICE '== January diff by verdict ==';
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-01-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== are the join keys usable? NULLs break an equality join ==';
  FOR r IN
    SELECT 'live' AS side,
           count(*) FILTER (WHERE amazon_order_id IS NULL) AS null_order,
           count(*) FILTER (WHERE asin IS NULL) AS null_asin,
           count(*) FILTER (WHERE asin = '') AS empty_asin,
           count(*) AS total
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_date >= '2026-01-01' AND event_date < '2026-02-01'
    UNION ALL
    SELECT 'backup',
           count(*) FILTER (WHERE amazon_order_id IS NULL),
           count(*) FILTER (WHERE asin IS NULL),
           count(*) FILTER (WHERE asin = ''),
           count(*)
    FROM public.fec_repull_backup WHERE backup_month='2026-01-01'
  LOOP
    RAISE NOTICE '   % | % null order_id | % null asin | % empty asin | % total',
      rpad(r.side,7), lpad(r.null_order::text,6), lpad(r.null_asin::text,6),
      lpad(r.empty_asin::text,6), r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does the backup carry user_id? the diff filters on it ==';
  FOR r IN
    SELECT count(*) FILTER (WHERE user_id = v_uid) AS mine,
           count(*) FILTER (WHERE user_id IS NULL) AS null_user, count(*) AS total
    FROM public.fec_repull_backup WHERE backup_month='2026-01-01'
  LOOP RAISE NOTICE '   % match my user_id | % null | % total', r.mine, r.null_user, r.total; END LOOP;
END
$p$;
