-- Re-run case 4 with a correct assertion.
--
-- 20261018060000 reported case 4 as FAIL, but the FAIL was in the test, not
-- the trigger: it asserted price_source should equal the manual label, while
-- this row's price_source is ALREADY seller_derived:snapshot -- that is the
-- very damage the Oct 18 write did. The trigger preserves OLD, so keeping
-- seller_derived:snapshot is correct behaviour. estimated_price WAS held at
-- 470.36, which is the thing that matters.
--
-- Correct assertion: every one of the five protected fields must come out
-- EXACTLY as it went in, whatever its current value happens to be.
DO $p$
DECLARE
  v_uid uuid;
  v_order text := '702-6705125-8817807';
  b_est numeric; b_lock numeric; b_from text; b_src text; b_conf text; b_mode text;
  a_est numeric; a_lock numeric; a_from text; a_src text; a_conf text; a_mode text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT estimated_price, locked_est_price, locked_from, price_source,
         price_confidence, price_calc_mode
    INTO b_est, b_lock, b_from, b_src, b_conf, b_mode
  FROM public.sales_orders WHERE user_id = v_uid AND order_id = v_order;

  RAISE NOTICE '=== BEFORE (the exact job-190 shape is about to be replayed) ===';
  RAISE NOTICE '   estimated_price  %', b_est;
  RAISE NOTICE '   locked_est_price %', b_lock;
  RAISE NOTICE '   locked_from      %', b_from;
  RAISE NOTICE '   price_source     %', b_src;
  RAISE NOTICE '   price_confidence %', b_conf;
  RAISE NOTICE '   price_calc_mode  %', b_mode;

  BEGIN
    UPDATE public.sales_orders
    SET price_source     = 'seller_derived:snapshot',
        price_confidence = 'HIGH_CONFIDENCE_PENDING',
        price_calc_mode  = 'seller_derived_snapshot',
        estimated_price  = 888.88,
        locked_est_price = 888.88
    WHERE user_id = v_uid AND order_id = v_order;

    SELECT estimated_price, locked_est_price, locked_from, price_source,
           price_confidence, price_calc_mode
      INTO a_est, a_lock, a_from, a_src, a_conf, a_mode
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = v_order;

    RAISE NOTICE '';
    RAISE NOTICE '=== AFTER the replayed write ===';
    RAISE NOTICE '   estimated_price  %  -> %', a_est,
      CASE WHEN a_est IS NOT DISTINCT FROM b_est THEN 'held  PASS' ELSE 'CHANGED  FAIL' END;
    RAISE NOTICE '   locked_est_price %  -> %', a_lock,
      CASE WHEN a_lock IS NOT DISTINCT FROM b_lock THEN 'held  PASS' ELSE 'CHANGED  FAIL' END;
    RAISE NOTICE '   locked_from      %  -> %', a_from,
      CASE WHEN a_from IS NOT DISTINCT FROM b_from THEN 'held  PASS' ELSE 'CHANGED  FAIL' END;
    RAISE NOTICE '   price_source     %  -> %', a_src,
      CASE WHEN a_src IS NOT DISTINCT FROM b_src THEN 'held  PASS' ELSE 'CHANGED  FAIL' END;
    RAISE NOTICE '   price_confidence %  -> %', a_conf,
      CASE WHEN a_conf IS NOT DISTINCT FROM b_conf THEN 'held  PASS' ELSE 'CHANGED  FAIL' END;
    RAISE NOTICE '   price_calc_mode  %  -> %', a_mode,
      CASE WHEN a_mode IS NOT DISTINCT FROM b_mode THEN 'held  PASS' ELSE 'CHANGED  FAIL' END;
    RAISE NOTICE '';
    RAISE NOTICE '   CASE 4 VERDICT: %',
      CASE WHEN a_est IS NOT DISTINCT FROM b_est
            AND a_lock IS NOT DISTINCT FROM b_lock
            AND a_from IS NOT DISTINCT FROM b_from
            AND a_src IS NOT DISTINCT FROM b_src
            AND a_conf IS NOT DISTINCT FROM b_conf
            AND a_mode IS NOT DISTINCT FROM b_mode
           THEN 'REJECTED in full -- the 2026-10-18 write can no longer land'
           ELSE 'STILL LEAKING -- do not proceed to the revert' END;

    RAISE EXCEPTION 'test_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'test_rollback' THEN RAISE NOTICE '!! TEST ERROR: %', SQLERRM; END IF;
  END;

  SELECT estimated_price INTO a_est FROM public.sales_orders
  WHERE user_id = v_uid AND order_id = v_order;
  RAISE NOTICE '';
  RAISE NOTICE '=== rolled back; live row still % MXN ===', a_est;
END
$p$;
