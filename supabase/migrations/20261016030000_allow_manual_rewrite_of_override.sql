-- Fix: my own trigger blocked the Recheck Keepa button from re-pressing.
--
-- 20261014260000 held estimated_price against ANY writer once locked_from
-- started with the manual prefix -- including the button itself. Observed on
-- MX order 702-6705125-8817807:
--
--   press 1   392.30 -> 470.36   applied (no lock yet)
--   press 2   470.36 -> 516.66   audit row written, ROW UNCHANGED
--   press 3   470.36 -> 516.66   audit row written, ROW UNCHANGED
--
-- Two faults in one. The button could not correct its own earlier value, and
-- the audit log recorded changes that never happened -- an audit trail that
-- lies is worse than none, because it is the thing you reach for when the
-- numbers are disputed.
--
-- The rule should have been "no AUTOMATIC writer may replace a manual
-- override", not "nothing may". A deliberate manual write is exactly the case
-- that must get through.

CREATE OR REPLACE FUNCTION public.preserve_manual_price_override()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  -- Settlement releases the override: a real sold_price outranks any estimate.
  IF COALESCE(NEW.sold_price, 0) > 0 OR COALESCE(NEW.total_sale_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- A DELIBERATE MANUAL WRITE MAY REPLACE A MANUAL OVERRIDE.
  -- The Recheck Keepa button re-pressing, or an explicit revert, both label
  -- themselves. Only unlabelled (automatic) writers are held off.
  IF COALESCE(NEW.locked_from, '') LIKE 'keepa_buybox:manual%'
     OR COALESCE(NEW.locked_from, '') LIKE 'manual:%' THEN
    RETURN NEW;
  END IF;

  IF NEW.estimated_price IS DISTINCT FROM OLD.estimated_price THEN
    RAISE LOG 'preserve_manual_price_override: held % (% -> % from % rejected)',
      NEW.order_id, OLD.estimated_price, NEW.estimated_price,
      COALESCE(NEW.locked_from, '?');
  END IF;

  NEW.estimated_price  := OLD.estimated_price;
  NEW.locked_est_price := OLD.locked_est_price;
  NEW.locked_from      := OLD.locked_from;
  NEW.price_source     := OLD.price_source;
  NEW.price_confidence := OLD.price_confidence;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.preserve_manual_price_override() IS
  'Holds the pending estimate on rows the seller manually overrode, against AUTOMATIC writers that ignore locked_est_price (notably repair-pending-prices). Released by settlement (sold_price/total_sale_amount positive) and by any deliberate manual write, which labels itself via locked_from (keepa_buybox:manual% or manual:%). Fees and all other columns always pass through.';

-- Verify all four behaviours on the real row, then unwind.
DO $p$
DECLARE v_uid uuid; v0 numeric; v numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT estimated_price INTO v0 FROM public.sales_orders
  WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
  RAISE NOTICE '== starting value: % MXN ==', v0;

  BEGIN
    -- 1. an AUTOMATIC writer must still be blocked
    UPDATE public.sales_orders
    SET estimated_price = 99.99, locked_est_price = 99.99,
        locked_from = 'pricing_api_estimate', price_source = 'estimate_pricing_api_mx'
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    SELECT estimated_price INTO v FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    RAISE NOTICE '   automatic writer blocked: % | %', v,
      CASE WHEN v = v0 THEN 'PASS' ELSE 'FAIL' END;

    -- 2. the BUTTON re-pressing must now get through
    UPDATE public.sales_orders
    SET estimated_price = 516.66, locked_est_price = 516.66,
        locked_from = 'keepa_buybox:manual:buybox', price_source = 'keepa_buybox:manual:buybox'
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    SELECT estimated_price INTO v FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    RAISE NOTICE '   button re-press allowed: % | %', v,
      CASE WHEN v = 516.66 THEN 'PASS' ELSE 'FAIL' END;

    -- 3. an explicit manual revert must get through
    UPDATE public.sales_orders
    SET estimated_price = 392.30, locked_est_price = 392.30,
        locked_from = 'manual:revert_to_listings_api', price_source = 'manual:revert_to_listings_api'
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    SELECT estimated_price INTO v FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    RAISE NOTICE '   manual revert allowed: % | %', v,
      CASE WHEN v = 392.30 THEN 'PASS' ELSE 'FAIL' END;

    -- 4. fees must still pass through on a blocked automatic write
    UPDATE public.sales_orders
    SET referral_fee = 1.23, locked_from = 'pricing_api_estimate'
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    SELECT referral_fee INTO v FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
    RAISE NOTICE '   fee passthrough: % | %', v,
      CASE WHEN v = 1.23 THEN 'PASS' ELSE 'FAIL' END;

    RAISE EXCEPTION 'selftest_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'selftest_rollback' THEN
      RAISE NOTICE '== SELF-TEST ERROR: % ==', SQLERRM;
    END IF;
  END;

  SELECT estimated_price INTO v FROM public.sales_orders
  WHERE user_id = v_uid AND order_id = '702-6705125-8817807';
  RAISE NOTICE '== rolled back; row still holds % MXN (unchanged) ==', v;
END
$p$;
