-- READ-ONLY. Item 1: locate the July 2026 change.
--
-- ALTERNATIVE READING TO TEST FIRST. I called July a regression, but the run
-- is Feb 83, Mar 72, Apr 71, May 29, Jun 25, Jul 76, Aug 70, Sep 65, Oct 64.
-- July-October matches February-April. That makes MAY-JUNE the outlier, not
-- July -- consistent with a one-off backfill over those two months rather than
-- a code regression afterwards.
--
-- The test: if a backfill populated May/June, those rows were UPDATED long
-- after the order was placed. If the live writer populated them, updated_at
-- sits close to order_date.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== 1a. for rows WITH a channel, how long after the order was it set? ==';
  RAISE NOTICE '   (updated_at - order_date, median; a large gap means a backfill)';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon,
           count(*) AS with_channel,
           round((percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(epoch FROM (updated_at - order_date::timestamptz))/86400
           ))::numeric,1) AS median_days,
           min(updated_at)::date AS earliest_update,
           max(updated_at)::date AS latest_update
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
      AND order_date >= DATE '2026-02-01' AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % tagged | median % d after the order | updates % .. %',
      r.mon, lpad(r.with_channel::text,6), lpad(r.median_days::text,7),
      r.earliest_update, r.latest_update;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1b. WHEN were the May/June tags written, exactly? ==';
  RAISE NOTICE '   A backfill shows up as a spike of updated_at on a single day.';
  FOR r IN
    SELECT updated_at::date AS upd_day, count(*) AS rows_tagged
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
      AND order_date >= DATE '2026-05-01' AND order_date < DATE '2026-07-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY rows_tagged DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % rows tagged', r.upd_day, lpad(r.rows_tagged::text,6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1c. same question for July-October, for contrast ==';
  FOR r IN
    SELECT updated_at::date AS upd_day, count(*) AS rows_tagged
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
      AND order_date >= DATE '2026-07-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY rows_tagged DESC LIMIT 8
  LOOP
    RAISE NOTICE '   % | % rows tagged', r.upd_day, lpad(r.rows_tagged::text,6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1d. created_at vs order_date for NULL rows, by month ==';
  RAISE NOTICE '   If NULL rows were created LATE (long after the order), they';
  RAISE NOTICE '   came from a settlement/reconcile path rather than live sync --';
  RAISE NOTICE '   which is the population sync-sales-orders inserts without the';
  RAISE NOTICE '   column at all.';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon, count(*) AS nulls,
           round((percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(epoch FROM (created_at - order_date::timestamptz))/86400
           ))::numeric,1) AS median_days_to_create
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NULL
      AND order_date >= DATE '2026-02-01' AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % NULL | created a median of % d after the order',
      r.mon, lpad(r.nulls::text,6), lpad(r.median_days_to_create::text,7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 1e. and for rows that DO have a channel, same measure ==';
  FOR r IN
    SELECT to_char(order_date,'YYYY-MM') AS mon, count(*) AS tagged,
           round((percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(epoch FROM (created_at - order_date::timestamptz))/86400
           ))::numeric,1) AS median_days_to_create
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NOT NULL
      AND order_date >= DATE '2026-02-01' AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % tagged | created a median of % d after the order',
      r.mon, lpad(r.tagged::text,6), lpad(r.median_days_to_create::text,7);
  END LOOP;
END
$p$;
