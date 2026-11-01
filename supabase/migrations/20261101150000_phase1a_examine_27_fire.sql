-- PHASE 1a: examine the 27 unexamined orders. READ-ONLY -- dry run, no write.
--
-- Two groups, never looked at:
--   * 19 whose money-implied quantity is NOT a whole number, excluded by the
--     gate inside collapsed_order_candidates so no apply could reach them;
--   * 8 recorded 'exceeds_money_estimate', where GetOrderItems reported MORE
--     units than the money ceiling and the new gate skipped them.
--
-- ── WHY THE EXPLICIT order_ids PATH, NOT THE SHORTLIST ────────────────
--
-- repair-collapsed-orders has two candidate sources. The shortlist applies the
-- whole-number gate and excludes rows with a recorded verdict, so it can reach
-- NEITHER group -- that is precisely why both are unexamined. The order_ids
-- path selects straight from sales_orders instead, bypassing both filters.
--
-- It also means `implied_units` is absent on these rows, so the ceiling gate's
-- `moneyImplied > 0` guard is false and the gate does not fire. That is what we
-- want here: the whole point is to SEE Amazon's answer for the 8 rows the gate
-- previously hid behind a skip, rather than skipping them a second time.
--
-- dry_run is not passed, so the function default (true) stands and nothing can
-- be written. A dry run also records no verdict, so the 8 keep their existing
-- 'exceeds_money_estimate' and the 19 stay outside the shortlist -- examining
-- them changes no state at all.
--
-- 27 orders at 2100ms is ~57s, inside the 110s budget, so ONE invocation does
-- the whole job and nothing else calls Amazon while it runs.
DO $p$
DECLARE
  r record; v_uid uuid; v_secret text; v_req bigint;
  v_ids text[]; v_n19 int; v_n8 int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  -- group A: the 19 non-whole-number orders, re-derived not hardcoded
  ------------------------------------------------------------------
  -- ON COMMIT DROP goes AFTER the column list. Second time I have put it
  -- before; noting it here rather than silently fixing it again.
  CREATE TEMP TABLE grp (
    grp text, order_id text, asin text, order_date date,
    stored int, implied numeric
  ) ON COMMIT DROP;

  INSERT INTO grp
  WITH one_line AS (
    SELECT order_id FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY order_id HAVING count(*) = 1),
  amz AS (
    SELECT amazon_order_id AS order_id, sum(abs(COALESCE(sales,0))) AS money
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'shipment'
      AND amazon_order_id IS NOT NULL AND event_date >= '2026-01-01'
    GROUP BY 1)
  SELECT 'non_whole', s.order_id, s.asin, s.order_date, s.quantity,
         round((a.money / s.sold_price)::numeric, 3)
  FROM public.sales_orders s
  JOIN one_line ol ON ol.order_id = s.order_id
  JOIN amz a       ON a.order_id  = s.order_id
  WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
    AND s.order_id NOT LIKE '%-REFUND%'
    AND COALESCE(s.sold_price,0) > 0
    AND (a.money / s.sold_price) > COALESCE(s.quantity,0) + 0.5
    AND abs(a.money / s.sold_price - round((a.money / s.sold_price)::numeric)) > 0.02
    AND COALESCE(s.order_status,'') NOT IN ('Cancelled','Canceled')
    AND (s.is_cancelled IS NULL OR s.is_cancelled = false);

  ------------------------------------------------------------------
  -- group B: the 8 ceiling-gate skips, from their recorded verdict
  ------------------------------------------------------------------
  INSERT INTO grp
  SELECT 'exceeds_ceiling', s.order_id, s.asin, s.order_date, s.quantity, NULL
  FROM public.collapsed_order_checks k
  JOIN public.sales_orders s ON s.id = k.sales_order_id
  WHERE k.user_id = v_uid AND k.outcome = 'exceeds_money_estimate';

  SELECT count(*) FILTER (WHERE grp='non_whole'),
         count(*) FILTER (WHERE grp='exceeds_ceiling')
    INTO v_n19, v_n8 FROM grp;
  RAISE NOTICE '== group A (non-whole-number): % ==', v_n19;
  RAISE NOTICE '== group B (ceiling skips)   : % ==', v_n8;
  RAISE NOTICE '   total to examine: %', v_n19 + v_n8;

  RAISE NOTICE '';
  RAISE NOTICE '   group            | order               | date       | asin         | stored | money implies';
  FOR r IN SELECT * FROM grp ORDER BY grp, order_date LOOP
    RAISE NOTICE '   % | % | % | % | % | %', rpad(r.grp,16), r.order_id,
      r.order_date, rpad(r.asin,12), lpad(r.stored::text,6),
      lpad(COALESCE(r.implied::text,'(n/a)'),13);
  END LOOP;

  SELECT array_agg(DISTINCT order_id) INTO v_ids FROM grp;

  ------------------------------------------------------------------
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN
    RAISE NOTICE '>>> no INTERNAL_SYNC_SECRET. Not firing.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
                               'marketplace', NULL,
                               'limit', 30,
                               'order_ids', to_jsonb(v_ids)),
    timeout_milliseconds := 118000
  ) INTO v_req;

  RAISE NOTICE '';
  RAISE NOTICE '   fired % ids at % -- request %',
    array_length(v_ids,1), clock_timestamp(), v_req;
  RAISE NOTICE '   DRY RUN: dry_run not passed, default true. Nothing can be';
  RAISE NOTICE '   written and no verdict is recorded, so examining these';
  RAISE NOTICE '   changes no state whatsoever.';
END
$p$;
