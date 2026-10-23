-- MY BUG, caught by the diff. 41 rows dated 2026-10-23 (38 shipments, 3
-- refunds) were deleted and never re-fetched, costing sales $836.99 and the
-- fees that go with them.
--
-- Cause: I passed endDate as the bare date '2026-10-23'. fetch-profit-loss
-- parses that as 2026-10-23T00:00:00Z, i.e. MIDNIGHT, so the fetch window
-- excluded all of Oct 23 -- while my DELETE covered Oct 1..31 inclusive. Delete
-- inclusive, re-fetch exclusive: the last day is removed and not replaced.
--
-- THIS WOULD HAVE HIT EVERY MONTH IN THE RE-PULL. endDate '2026-01-31' excludes
-- Jan 31 the same way. Every month must be requested with the FIRST OF THE NEXT
-- MONTH as endDate, which is the correction applied from here on.
--
-- Restored from the backup rather than re-fetched: it is the exact pre-delete
-- content, and re-fetching risks a third window mistake on a day that is still
-- accumulating events.
DO $p$
DECLARE v_uid uuid; v_restored bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  -- Explicit column list: fec_repull_backup carries two extra leading columns
  -- (backup_month, backed_up_at), so a bare .* has more expressions than the
  -- target has columns. Built from the catalogue so it cannot drift.
  DECLARE v_cols text;
  BEGIN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_cols
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_events_cache';

    EXECUTE format($q$
      INSERT INTO public.financial_events_cache (%s)
      SELECT %s FROM public.fec_repull_backup
      WHERE user_id = %L AND backup_month = '2026-10-01' AND event_date = '2026-10-23'
      ON CONFLICT (user_id, event_type, event_date, amazon_order_id, asin) DO NOTHING
    $q$, v_cols, v_cols, v_uid);
    GET DIAGNOSTICS v_restored = ROW_COUNT;
  END;

  RAISE NOTICE '== restored % rows dated 2026-10-23 ==', v_restored;

  RAISE NOTICE '';
  RAISE NOTICE '== money by column, backup vs live, after the restore ==';
  FOR r IN
    SELECT
      round(sum(COALESCE(b_sales,0)),2) AS b_sales, round(sum(COALESCE(l_sales,0)),2) AS l_sales
    FROM (
      SELECT (SELECT sum(sales) FROM public.fec_repull_backup
              WHERE user_id=v_uid AND backup_month='2026-10-01') AS b_sales,
             (SELECT sum(sales) FROM public.financial_events_cache
              WHERE user_id=v_uid AND event_date>='2026-10-01' AND event_date<'2026-11-01') AS l_sales
    ) z
  LOOP
    RAISE NOTICE '   sales: backup % -> live %  (delta %)',
      r.b_sales, r.l_sales, round(r.l_sales - r.b_sales, 2);
  END LOOP;

  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-10-01')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   diff: % | % rows', rpad(r.verdict,10), r.rows; END LOOP;
END
$p$;
