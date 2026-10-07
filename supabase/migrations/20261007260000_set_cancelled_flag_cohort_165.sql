-- STEP 1b: set is_cancelled on the 165 cohort orders only.
--
-- Backed up first by 20261007250000 (321 rows in
-- backup_cancelled_flag_20261007, 168 tagged cohort_165).
--
-- Amazon confirmed this label directly: of ten we called Canceled, Amazon
-- called all ten Canceled. 10/10, so no API call is needed to act on it.
--
-- ONLY is_cancelled moves. Quantity, price and fees are left exactly as they
-- are. refresh-order-status zeroes all of those on a cancelled order, and that
-- is a far larger claim about the data than "this order was cancelled" -- it
-- destroys the record of what was ordered. If the seller later wants the
-- figures zeroed too, that is a separate decision with its own backup.
--
-- The estimate stops counting as a CONSEQUENCE of the flag, not by clearing
-- estimated_price: every surface already filters on is_cancelled (Rule A) or
-- on the status too (Rule B), so the flag is the switch. Verified below with
-- the same arithmetic both rules use.

UPDATE public.sales_orders so
SET is_cancelled = true,
    cancelled_at = COALESCE(so.cancelled_at, now()),
    status_source = COALESCE(so.status_source, 'cancelled_flag_backfill_20261007')
WHERE so.order_status IN ('Canceled', 'Cancelled')
  AND COALESCE(so.is_cancelled, false) = false
  AND so.order_id NOT LIKE '%-REFUND'
  AND so.order_date <= current_date - 90;

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO n FROM public.sales_orders
  WHERE order_status IN ('Canceled','Cancelled')
    AND COALESCE(is_cancelled,false) = false
    AND order_id NOT LIKE '%-REFUND'
    AND order_date <= current_date - 90;
  RAISE NOTICE '== cohort rows still unflagged: % (must be 0) ==', n;

  RAISE NOTICE '';
  RAISE NOTICE '== AFTER: all unsettled estimated revenue, both rules ==';
  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled, so.order_status,
             so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx
        ON fx.base = 'USD'
       AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
                        WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN'
                        WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid
        AND COALESCE(so.sold_price,0) = 0 AND COALESCE(so.estimated_price,0) > 0
        AND so.order_id NOT LIKE '%-REFUND'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false) = false)::numeric, 2) AS rule_a,
           round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false) = false
                                    AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled'))::numeric, 2) AS rule_b
    FROM base
  LOOP
    RAISE NOTICE '   Rule A $% (was $36597.24, -$%)',
      r.rule_a, round((36597.24 - r.rule_a)::numeric, 2);
    RAISE NOTICE '   Rule B $% (was $28926.16, unchanged as predicted)', r.rule_b;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the 449 stuck-pending cohort, recounted ==';
  FOR r IN
    SELECT count(*) AS orders, round(sum(estimated_price * quantity)::numeric, 2) AS est
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND COALESCE(sold_price,0) = 0 AND COALESCE(estimated_price,0) > 0
      AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND'
      AND order_date <= current_date - 90
  LOOP
    RAISE NOTICE '   % orders | $% (was 449 orders / $11702.14)', r.orders, r.est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== P&L, which must not have moved ==';
  FOR r IN
    SELECT count(*) AS rows, round(sum(sales)::numeric,2) AS sales,
           round(sum(refunds)::numeric,2) AS refunds
    FROM public.financial_events_cache WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '   % rows | sales $% | refunds $%', r.rows, r.sales, r.refunds;
    RAISE NOTICE '   baseline was 120429 rows | sales $2463045.47 | refunds $111143.09';
  END LOOP;
END
$p$;
