-- Correct 113-1305212-7465044: a 2-unit order stored at a 1-unit total.
--
-- Seller Central shows Quantity 2, Unit price $24.99, so the line total is
-- $49.98. reconcile-pending-prices stored Amazon's preliminary pending
-- ItemPrice of 24.99 as the LINE TOTAL and divided it by QuantityOrdered,
-- giving sold_price 12.495 -- below the 12.32 unit cost, hence ROI -49.2%.
--
-- The row is now Shipped and still wrong: price_confidence CONFIRMED and
-- needs_price_enrich false mean nothing re-prices it. It does not self-heal.
--
-- SCOPE: one order. 114-8141058-0108255 (q5, unit 13.91 vs estimate 23.19) is
-- deliberately NOT touched -- that ratio is not a clean multiple and would be
-- a guess.
--
-- price_source becomes 'data_repair', which is on the TRUSTED_USD list in
-- live-sales-core.ts; leaving it as 'orders_itemprice' keeps it on the SUSPECT
-- list and invites the currency heuristics to second-guess a value we just
-- fixed by hand.
--
-- estimated_price is restored to 24.99 (the figure its four sibling orders of
-- the same ASIN carry that day). The writer had zeroed it, and that erasure is
-- what blinded the lowball guard.
--
-- THE P&L DOES NOT MOVE. fetch-profit-loss reads revenue from
-- financial_events_cache; it touches sales_orders only to map order_id ->
-- marketplace and to write shipping-label fees. This migration changes neither.

CREATE TABLE IF NOT EXISTS public.sales_orders_price_repair_20261025 AS
SELECT now() AS backed_up_at, s.*
FROM public.sales_orders s
WHERE s.order_id IN ('113-1305212-7465044','114-8141058-0108255');

ALTER TABLE public.sales_orders_price_repair_20261025 ENABLE ROW LEVEL SECURITY;

DO $p$
DECLARE v_n int; v_total numeric; v_qty int;
BEGIN
  SELECT count(*) INTO v_n FROM public.sales_orders_price_repair_20261025;
  RAISE NOTICE '== backup: % row(s) ==', v_n;
  IF v_n < 1 THEN RAISE EXCEPTION 'backup is empty -- refusing to write'; END IF;

  -- Refuse unless the row is exactly what was diagnosed.
  SELECT quantity, round(total_sale_amount,2) INTO v_qty, v_total
  FROM public.sales_orders WHERE order_id = '113-1305212-7465044';

  IF v_qty IS NULL THEN
    RAISE EXCEPTION 'order 113-1305212-7465044 not found';
  END IF;
  IF v_qty <> 2 OR v_total <> 24.99 THEN
    RAISE EXCEPTION 'row is not in the diagnosed state (qty %, total %) -- refusing to write', v_qty, v_total;
  END IF;
  RAISE NOTICE '   pre-check passed: qty %, total % -- proceeding', v_qty, v_total;
END
$p$;

UPDATE public.sales_orders
   SET sold_price        = 24.99,
       item_price        = 24.99,
       total_sale_amount = 49.98,
       estimated_price   = 24.99,
       price_source      = 'data_repair',
       updated_at        = now()
 WHERE order_id = '113-1305212-7465044'
   AND quantity = 2
   AND round(total_sale_amount,2) = 24.99;

DO $p$
DECLARE r record; v_uid uuid; v_units int := 0; v_shown numeric := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '== AFTER ==';
  FOR r IN
    SELECT quantity AS q, round(sold_price,2) AS unit_px,
           round(total_sale_amount,2) AS total, round(estimated_price,2) AS est,
           price_source AS src, round(roi,1) AS roi, round(unit_cost,2) AS cost
    FROM public.sales_orders WHERE order_id='113-1305212-7465044'
  LOOP
    RAISE NOTICE '   qty % | unit % | total % | est % | % | roi % | cost %',
      r.q, r.unit_px, r.total, r.est, r.src, r.roi, r.cost;
    IF r.total <> 49.98 THEN RAISE EXCEPTION 'total is % , expected 49.98', r.total; END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== Sales Report / Mobile: B0H854F7VF on 2026-10-24 ==';
  FOR r IN
    SELECT quantity AS q, COALESCE(sold_price,0) AS sold,
           COALESCE(total_sale_amount,0) AS total, COALESCE(estimated_price,0) AS est
    FROM public.sales_orders
    WHERE user_id=v_uid AND asin='B0H854F7VF' AND order_date=DATE '2026-10-24'
  LOOP
    v_units := v_units + r.q;
    v_shown := v_shown + CASE WHEN r.sold > 0 THEN r.total ELSE r.est * r.q END;
  END LOOP;
  RAISE NOTICE '   units % | shown % | Amazon truth % | short by %',
    v_units, round(v_shown,2), round(v_units*24.99,2), round(v_units*24.99 - v_shown,2);
  RAISE NOTICE '   (was: 6 units, 124.95 shown, short by 24.99)';

  RAISE NOTICE '';
  RAISE NOTICE '== P&L source untouched: financial_events_cache rows for this order ==';
  SELECT count(*) INTO v_units FROM public.financial_events_cache
  WHERE user_id = v_uid AND amazon_order_id = '113-1305212-7465044';
  RAISE NOTICE '   % financial event row(s) -- not written by this migration', v_units;
END
$p$;
