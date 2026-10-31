-- ASK AMAZON WHAT THE QUANTITY WAS -- 2026 ONLY. READS AMAZON, WRITES NOTHING.
--
-- COGS = quantity x unit cost, so a wrong sales_orders.quantity mis-states COGS
-- directly and proportionally. 3,394 of 2026's orders are multi-unit and they
-- hold 8,919 of 48,027 units (18.6 pct), so the exposure is real enough to
-- check against the source rather than reason about.
--
-- ── WHY THIS IS SAFE, as a property you can check rather than a promise ──
--
-- It calls probe-order-status-sample, which exists for exactly this shape of
-- question: internal-only (x-internal-secret, verify_jwt = false), paced at
-- 250 ms against getOrder's 0.5 rps, capped at MAX_IDS = 60, and with NO table
-- write anywhere in the file. getOrder is a different SP-API operation from
-- getItemOffers, so this does not touch the repricer's pricing quota.
--
-- ── WHAT IS COMPARED, AND THE ONE TRAP ──
--
-- getOrder returns NumberOfItemsShipped for the WHOLE order, while sales_orders
-- is one row per order ITEM. On a two-ASIN order Amazon's number covers both
-- ASINs and the row's quantity covers one, so the comparison would show a fake
-- mismatch on every such order. The sample is therefore restricted to orders
-- with exactly ONE sales_orders row, where quantity and NumberOfItemsShipped
-- are the same measurement and must agree exactly.
--
-- "Settled" is taken from financial_events_cache having a shipment row for the
-- order, NOT from order_status -- 19,724 orders have been stuck at Pending
-- since 2025-12-28, so order_status cannot establish settlement.
--
-- Selection is deterministic (ORDER BY md5(order_id) LIMIT 60), so the read-back
-- migration can recompute the identical 60 rows and join on order_id. Nothing
-- needs to be stored to carry the sample between the two.
DO $p$
DECLARE
  r record; v_uid uuid; v_secret text; v_req bigint; v_ids text[]; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  WITH single AS (
    SELECT order_id FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY order_id HAVING count(*) = 1
  ),
  settled AS (
    SELECT DISTINCT amazon_order_id FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'shipment'
      AND amazon_order_id IS NOT NULL
  )
  SELECT array_agg(so.order_id ORDER BY md5(so.order_id))
    INTO v_ids
  FROM (
    SELECT so.order_id
    FROM public.sales_orders so
    JOIN single  s ON s.order_id = so.order_id
    JOIN settled f ON f.amazon_order_id = so.order_id
    WHERE so.user_id = v_uid
      AND so.order_date >= '2026-01-01' AND so.order_date < '2027-01-01'
      AND COALESCE(so.quantity,0) >= 2
    ORDER BY md5(so.order_id)
    LIMIT 60
  ) so;

  v_n := COALESCE(array_length(v_ids,1),0);
  RAISE NOTICE '== sample: % settled single-ASIN multi-unit 2026 orders ==', v_n;

  RAISE NOTICE '   how large is the population this 60 is drawn from?';
  FOR r IN
    WITH single AS (
      SELECT order_id FROM public.sales_orders
      WHERE user_id = v_uid
        AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
        AND order_id NOT LIKE '%-REFUND%'
      GROUP BY order_id HAVING count(*) = 1
    ),
    settled AS (
      SELECT DISTINCT amazon_order_id FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type = 'shipment'
        AND amazon_order_id IS NOT NULL
    )
    SELECT count(*) AS eligible, sum(so.quantity) AS units
    FROM public.sales_orders so
    JOIN single  s ON s.order_id = so.order_id
    JOIN settled f ON f.amazon_order_id = so.order_id
    WHERE so.user_id = v_uid
      AND so.order_date >= '2026-01-01' AND so.order_date < '2027-01-01'
      AND COALESCE(so.quantity,0) >= 2
  LOOP
    RAISE NOTICE '      eligible orders % holding % units', r.eligible, r.units;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE '   >>> nothing eligible. Not firing.';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   the sample, with the quantity we will be checking:';
  FOR r IN
    SELECT so.order_id, so.order_date, so.asin, so.quantity AS qty,
           COALESCE(so.fulfillment_channel,'(NULL)') AS fc
    FROM public.sales_orders so
    WHERE so.user_id = v_uid AND so.order_id = ANY(v_ids)
    ORDER BY so.order_date
  LOOP
    RAISE NOTICE '      % | % | % | qty % | %', r.order_id, r.order_date,
      rpad(r.asin,12), lpad(r.qty::text,3), r.fc;
  END LOOP;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN
    RAISE NOTICE '   >>> no INTERNAL_SYNC_SECRET in Vault. Not firing.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-order-status-sample',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('order_ids', to_jsonb(v_ids),
                               'user_email', 'sezflower01@gmail.com'),
    timeout_milliseconds := 115000
  ) INTO v_req;

  RAISE NOTICE '';
  RAISE NOTICE '   fired at % -- request %', clock_timestamp(), v_req;
  RAISE NOTICE '   60 ids at 250 ms pacing is about 15 s of Amazon calls.';
  RAISE NOTICE '   The response cannot be read in this transaction (pg_net does';
  RAISE NOTICE '   not deliver a request fired in an uncommitted one), so the';
  RAISE NOTICE '   comparison runs in the next migration.';
  RAISE NOTICE '';
  RAISE NOTICE '   NO TABLE WRITE IN THIS MIGRATION. 2026 only.';
END
$p$;
