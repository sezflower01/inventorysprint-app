-- Protect a MANUAL Keepa override from being silently overwritten.
--
-- THE HOLE. locked_est_price only works for the writer that honours it.
-- fetch-live-orders does (index.ts ~3421, "existingLockedEstimate > 0" keeps
-- the value verbatim). repair-pending-prices does NOT: for a pending order it
-- overwrites estimated_price, locked_est_price AND locked_from
-- unconditionally with a pricing_api estimate (index.ts ~1339), and it
-- SELECTs locked_from without ever testing it. It picks rows up via
-- needs_price_enrich OR needs_fee_enrich.
--
-- Measured 2026-10-14 right after the first real press: both overridden rows
-- carried needs_price_enrich = true, needs_fee_enrich = true and
-- next_enrich_after = NULL, so the very next repair run would have replaced
-- the Keepa value. Across all non-US pending rows: CA 9 of 9 flagged, MX 8 of
-- 9, BR 1 of 1. So this was not an edge case, it was every row.
--
-- WHY A TRIGGER AND NOT A PATCH. repair-pending-prices writes the estimate
-- from four separate sites in a 2,000-line function, and sync-sales-orders,
-- enrich-pending-orders and fetch-live-orders all write it too. Guarding each
-- call site means finding every one and keeping them in step forever; one
-- missed site silently reopens the hole. The rule belongs where the data is.
--
-- SCOPE IS DELIBERATELY TINY. The WHEN clause fires only for rows whose
-- locked_from already starts with the manual prefix, which nothing but the
-- Recheck Keepa button ever sets. Every other row on this table is untouched
-- and pays nothing -- which matters, because sales_orders is the hot table
-- and an ungated trigger on it is a known performance fault here.
--
-- WHAT IT STILL ALLOWS, on purpose:
--   - settlement: once sold_price > 0 the real price wins and the override is
--     released entirely. Amazon's number always beats an estimate.
--   - fees: referral_fee / fba_fee / total_fees / fees_source pass straight
--     through, so re-enrichment still refreshes fees against the held
--     estimate. This is what makes "fees and ROI follow on the next sync"
--     true rather than wishful.
--   - every other column: status, flags, attempt counters, all unaffected.

CREATE OR REPLACE FUNCTION public.preserve_manual_price_override()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  -- Settlement releases the override: a real sold_price outranks any estimate.
  IF COALESCE(NEW.sold_price, 0) > 0 OR COALESCE(NEW.total_sale_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- Otherwise hold the estimate and its labels against every other writer.
  IF NEW.estimated_price IS DISTINCT FROM OLD.estimated_price
     OR NEW.locked_est_price IS DISTINCT FROM OLD.locked_est_price
     OR NEW.locked_from IS DISTINCT FROM OLD.locked_from
     OR NEW.price_source IS DISTINCT FROM OLD.price_source THEN
    RAISE LOG 'preserve_manual_price_override: held % (% -> % rejected, lock %)',
      NEW.order_id, OLD.estimated_price, NEW.estimated_price, OLD.locked_from;
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
  'Holds estimated_price/locked_est_price/locked_from/price_source/price_confidence on rows the seller manually overrode via the Recheck Keepa button, against writers that ignore locked_est_price (notably repair-pending-prices). Released as soon as sold_price or total_sale_amount is positive, so settlement always wins. Fees and all other columns pass through.';

DROP TRIGGER IF EXISTS preserve_manual_price_override_trg ON public.sales_orders;
CREATE TRIGGER preserve_manual_price_override_trg
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW
  WHEN (OLD.locked_from LIKE 'keepa_buybox:manual%')
  EXECUTE FUNCTION public.preserve_manual_price_override();

-- Prove it, on the real rows, then unwind. An untested guard is how the RLS
-- deny reached a live button earlier today.
DO $p$
DECLARE v_uid uuid; r record; v_before numeric; v_after numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  BEGIN
    SELECT estimated_price INTO v_before FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843';

    -- Simulate exactly what repair-pending-prices would write.
    UPDATE public.sales_orders
    SET estimated_price = 99.99, locked_est_price = 99.99,
        locked_from = 'pricing_api_estimate',
        price_source = 'estimate_pricing_api_ca',
        referral_fee = 7.77            -- a fee change, which MUST pass through
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843';

    SELECT estimated_price INTO v_after FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843';

    RAISE NOTICE '== estimate overwrite attempt: % -> stayed % | %',
      v_before, v_after,
      CASE WHEN v_after = v_before THEN 'PASS (held)' ELSE 'FAIL (overwritten)' END;

    SELECT referral_fee INTO v_after FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843';
    RAISE NOTICE '== fee passthrough: referral is now % | %', v_after,
      CASE WHEN v_after = 7.77 THEN 'PASS (fees still update)' ELSE 'FAIL (fee blocked)' END;

    -- And settlement must break through.
    UPDATE public.sales_orders
    SET sold_price = 41.11, estimated_price = 41.11, locked_from = 'financial_events'
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843';
    SELECT estimated_price INTO v_after FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843';
    RAISE NOTICE '== settlement override: estimate is now % | %', v_after,
      CASE WHEN v_after = 41.11 THEN 'PASS (settlement wins)' ELSE 'FAIL (lock blocked settlement)' END;

    RAISE EXCEPTION 'trigger_selftest_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'trigger_selftest_rollback' THEN
      RAISE NOTICE '== TRIGGER SELF-TEST ERROR: % ==', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '== self-test rolled back; live rows untouched ==';
  FOR r IN
    SELECT order_id, estimated_price, locked_from, sold_price
    FROM public.sales_orders WHERE user_id = v_uid
      AND order_id IN ('701-1848920-5681843','702-3337276-9597036') ORDER BY order_id
  LOOP
    RAISE NOTICE '   % | est CA$% | % | sold %', r.order_id, r.estimated_price, r.locked_from, r.sold_price;
  END LOOP;
END
$p$;
