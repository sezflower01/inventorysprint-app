-- Read-only: how much history does financial_events_cache hold, and how far
-- back would a "Clear Cache & Resync" be betting Amazon can still serve?
DO $$
DECLARE r RECORD; v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM public.sales_orders LIMIT 1;

  SELECT min(event_date) AS oldest, max(event_date) AS newest, count(*) AS n
    INTO r FROM public.financial_events_cache WHERE user_id = v_uid;
  RAISE NOTICE 'financial_events_cache: % rows, % .. %', r.n, r.oldest, r.newest;

  FOR r IN
    SELECT date_trunc('month', event_date)::date AS m, count(*) AS n
    FROM public.financial_events_cache WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 1 DESC LIMIT 12
  LOOP
    RAISE NOTICE '  % : % rows', r.m, r.n;
  END LOOP;
END $$;
