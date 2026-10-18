-- Test the closed hole with REAL partial UPDATEs against the live MX row, all
-- inside a block that is deliberately rolled back. RAISE NOTICE output
-- survives the rollback; the writes do not.
--
-- Case 4 is the one that matters: it reproduces the exact shape of the write
-- that got through on 2026-10-18 05:22 -- price_source, price_confidence and
-- price_calc_mode set, locked_from never mentioned.
DO $p$
DECLARE
  v_uid uuid;
  v_order text := '702-6705125-8817807';
  v_base numeric;
  v_est numeric;
  v_src text;
  v_mode text;
  v_fee numeric;
  v_audit int;
  v_audit0 int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT estimated_price INTO v_base FROM public.sales_orders
  WHERE user_id = v_uid AND order_id = v_order;
  SELECT count(*) INTO v_audit0 FROM public.sales_order_price_audit WHERE order_id = v_order;

  RAISE NOTICE '=== baseline: estimated_price = % MXN, audit rows = % ===', v_base, v_audit0;
  RAISE NOTICE '';

  BEGIN
    -- CASE 1: automatic write that OMITS locked_from (the hole).
    UPDATE public.sales_orders
    SET estimated_price = 111.11, price_source = 'estimate_pricing_api_mx'
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT estimated_price, price_source INTO v_est, v_src FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '1. automatic, locked_from OMITTED';
    RAISE NOTICE '     est % | src %', v_est, v_src;
    RAISE NOTICE '     -> % (must be REJECTED)',
      CASE WHEN v_est = v_base THEN 'REJECTED  PASS' ELSE 'ALLOWED  FAIL' END;

    -- CASE 2: automatic write that SETS a non-manual label.
    UPDATE public.sales_orders
    SET estimated_price = 222.22, locked_from = 'pricing_api_estimate'
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT estimated_price INTO v_est FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '2. automatic, locked_from = pricing_api_estimate';
    RAISE NOTICE '     est % -> % (must be REJECTED)', v_est,
      CASE WHEN v_est = v_base THEN 'REJECTED  PASS' ELSE 'ALLOWED  FAIL' END;

    -- CASE 3: automatic write that re-states the SAME manual label (the exact
    -- inherited-label case, made explicit).
    UPDATE public.sales_orders
    SET estimated_price = 333.33, locked_from = 'keepa_buybox:manual:buybox'
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT estimated_price INTO v_est FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '3. writer re-states the IDENTICAL manual label';
    RAISE NOTICE '     est % -> % (must be REJECTED: not distinct)', v_est,
      CASE WHEN v_est = v_base THEN 'REJECTED  PASS' ELSE 'ALLOWED  FAIL' END;

    -- CASE 4: THE EXACT 2026-10-18 05:22 SHAPE.
    UPDATE public.sales_orders
    SET price_source = 'seller_derived:snapshot',
        price_confidence = 'HIGH_CONFIDENCE_PENDING',
        price_calc_mode = 'seller_derived_snapshot',
        estimated_price = 888.88
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT estimated_price, price_source, price_calc_mode INTO v_est, v_src, v_mode
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '4. THE EXACT JOB-190 SHAPE (src+confidence+calc_mode, no locked_from)';
    RAISE NOTICE '     est % | src % | calc_mode %', v_est, v_src, v_mode;
    RAISE NOTICE '     -> % (must be REJECTED)',
      CASE WHEN v_est = v_base AND v_src = 'keepa_buybox:manual:buybox'
           THEN 'REJECTED, labels held too  PASS' ELSE 'ALLOWED  FAIL' END;

    -- CASE 5: a deliberate manual write with a UNIQUE label must pass.
    UPDATE public.sales_orders
    SET estimated_price = 555.55, locked_est_price = 555.55,
        locked_from = 'manual:test@2026-10-18T00:00:00Z',
        price_source = 'manual:test'
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT estimated_price INTO v_est FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '5. deliberate manual write, UNIQUE label';
    RAISE NOTICE '     est % -> % (must be ALLOWED)', v_est,
      CASE WHEN v_est = 555.55 THEN 'ALLOWED  PASS' ELSE 'REJECTED  FAIL' END;

    -- CASE 6: fees must still pass through on a REJECTED price write.
    UPDATE public.sales_orders
    SET referral_fee = 7.77, estimated_price = 999.99
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT referral_fee, estimated_price INTO v_fee, v_est FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '6. fee + blocked price in ONE statement';
    RAISE NOTICE '     referral % | est %', v_fee, v_est;
    RAISE NOTICE '     -> % (fee must land, price must not)',
      CASE WHEN v_fee = 7.77 AND v_est = 555.55 THEN 'PASS' ELSE 'FAIL' END;

    -- CASE 7: settlement must break through regardless.
    UPDATE public.sales_orders
    SET sold_price = 41.11, estimated_price = 41.11, locked_from = 'financial_events'
    WHERE user_id = v_uid AND order_id = v_order;
    SELECT estimated_price INTO v_est FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = v_order;
    RAISE NOTICE '7. settlement (sold_price > 0)';
    RAISE NOTICE '     est % -> % (must be ALLOWED)', v_est,
      CASE WHEN v_est = 41.11 THEN 'ALLOWED  PASS' ELSE 'BLOCKED  FAIL' END;

    -- The audit trail should have captured the writes that actually changed
    -- something, and nothing for the ones the trigger neutralised.
    SELECT count(*) INTO v_audit FROM public.sales_order_price_audit WHERE order_id = v_order;
    RAISE NOTICE '';
    RAISE NOTICE '8. audit rows written during the 7 cases: % (expect > 0)', v_audit - v_audit0;
    FOR v_src IN
      SELECT format('     %s -> %s | src %s -> %s | role %s',
                    COALESCE(old_estimate::text,'-'), COALESCE(new_estimate::text,'-'),
                    COALESCE(old_price_source,'-'), COALESCE(new_price_source,'-'), db_role)
      FROM public.sales_order_price_audit
      WHERE order_id = v_order ORDER BY id
    LOOP RAISE NOTICE '%', v_src; END LOOP;

    RAISE EXCEPTION 'test_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'test_rollback' THEN RAISE NOTICE '!! TEST ERROR: %', SQLERRM; END IF;
  END;

  SELECT estimated_price, price_source INTO v_est, v_src FROM public.sales_orders
  WHERE user_id = v_uid AND order_id = v_order;
  SELECT count(*) INTO v_audit FROM public.sales_order_price_audit WHERE order_id = v_order;
  RAISE NOTICE '';
  RAISE NOTICE '=== rolled back: est % (was %), src %, audit rows % (was %) ===',
    v_est, v_base, v_src, v_audit, v_audit0;
END
$p$;
