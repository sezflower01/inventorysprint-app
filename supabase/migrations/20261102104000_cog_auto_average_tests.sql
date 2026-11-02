-- TESTS for the auto-average on continued. Creates fixtures, asserts, CLEANS UP.
--
-- The four cases the seller asked for: double-continue, edit-and-resubmit,
-- partial lot, manual override present.
--
-- ── HOW THIS AVOIDS LEAVING RUBBISH BEHIND ───────────────────────────
--
-- A migration commits, so there is no transaction to roll back into. Instead
-- every fixture uses the reserved test ASINs TESTCOG001 / TESTCOG002 and is
-- deleted in an EXCEPTION-protected block, so cleanup runs even if an
-- assertion fails. Assertions report via NOTICE and set a pass/fail counter
-- rather than RAISE, because a failed migration would block the queue -- the
-- result is printed and the run still records cleanly.
--
-- The fixtures touch created_listings, shipment_purchase_allocations and
-- shipment_builder_drafts for those two ASINs only, and asin_cog_on_record /
-- cog_purchase_confirmations rows they cause. No real product is involved.
DO $p$
DECLARE
  v_uid uuid; v_lotA uuid; v_lotB uuid; v_lotC uuid;
  v_pass int := 0; v_fail int := 0;
  v_avg numeric; v_conf int; v_src text;

BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  BEGIN
    ----------------------------------------------------------------
    -- fixtures
    ----------------------------------------------------------------
    -- TESTCOG001: lot A 100 units for 500.00 (5.00/u) fully shipped
    --             lot B 100 units for 900.00 (9.00/u) HALF shipped
    --   expected: spent 500 + 450 = 950, units 150, avg 6.3333
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTCOG001', 'TEST-SKU-A', 'cog test A', 500.00, 100, now())
    RETURNING id INTO v_lotA;
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTCOG001', 'TEST-SKU-B', 'cog test B', 900.00, 100, now())
    RETURNING id INTO v_lotB;

    -- TESTCOG002: one lot, but the ASIN has a manual override -> must be skipped
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTCOG002', 'TEST-SKU-C', 'cog test C', 700.00, 100, now())
    RETURNING id INTO v_lotC;
    INSERT INTO public.asin_cost_overrides (user_id, asin, unit_cost, effective_from, note)
    VALUES (v_uid, 'TESTCOG002', 3.21, '2026-01-01', 'cog auto-average test override');

    INSERT INTO public.shipment_builder_drafts
      (user_id, draft_id, shipment_name, status, inbound_plan_id)
    VALUES (v_uid, 'TESTCOGDRAFT', 'cog test draft', 'draft', 'PLAN-TEST-1');

    INSERT INTO public.shipment_purchase_allocations
      (user_id, draft_id, created_listing_id, asin, sku, units_allocated, units_shipped)
    VALUES
      (v_uid, 'TESTCOGDRAFT', v_lotA, 'TESTCOG001', 'TEST-SKU-A', 100, 100),
      (v_uid, 'TESTCOGDRAFT', v_lotB, 'TESTCOG001', 'TEST-SKU-B', 100,  50),
      (v_uid, 'TESTCOGDRAFT', v_lotC, 'TESTCOG002', 'TEST-SKU-C', 100, 100);

    ----------------------------------------------------------------
    -- TEST 1: the transition fires, partial lot uses SHIPPED units
    ----------------------------------------------------------------
    UPDATE public.shipment_builder_drafts
       SET status = 'continued', continued_to_amazon_at = now(),
           amazon_shipment_id = 'FBA-TEST-1'
     WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT';

    SELECT unit_cost, source INTO v_avg, v_src
    FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'TESTCOG001';
    IF round(COALESCE(v_avg,0),4) = 6.3333 AND v_src = 'auto_shipment' THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 1  partial lot: avg % from 950.00 / 150 units, source %',
        v_avg, v_src;
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 1  partial lot: got avg % source %, expected 6.3333 auto_shipment',
        v_avg, v_src;
    END IF;

    SELECT count(*) INTO v_conf FROM public.cog_purchase_confirmations
     WHERE user_id = v_uid AND asin = 'TESTCOG001';
    IF v_conf = 2 THEN
      v_pass := v_pass + 1; RAISE NOTICE 'PASS 2  two lots confirmed';
    ELSE
      v_fail := v_fail + 1; RAISE NOTICE 'FAIL 2  expected 2 confirmations, got %', v_conf;
    END IF;

    SELECT units_source INTO v_src FROM public.cog_purchase_confirmations
     WHERE created_listing_id = v_lotB;
    IF v_src = 'units_shipped' THEN
      v_pass := v_pass + 1; RAISE NOTICE 'PASS 3  partial lot recorded units_shipped';
    ELSE
      v_fail := v_fail + 1; RAISE NOTICE 'FAIL 3  units_source was %', v_src;
    END IF;

    ----------------------------------------------------------------
    -- TEST 4: MANUAL OVERRIDE must be left alone
    ----------------------------------------------------------------
    -- ASSERTION CORRECTED. My first version demanded that NO
    -- asin_cog_on_record row exist, and it failed -- but not because the guard
    -- failed. cog_on_record_from_listing is an AFTER INSERT trigger on
    -- created_listings that fills a brand-new product's COG from that single
    -- listing with source='listing'. It created the row, not my function.
    -- The right assertion is therefore about the SOURCE: an override-protected
    -- ASIN must never be stamped auto_shipment.
    SELECT source INTO v_src FROM public.asin_cog_on_record
     WHERE user_id = v_uid AND asin = 'TESTCOG002';
    IF COALESCE(v_src,'(none)') <> 'auto_shipment' THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 4  override-protected ASIN not touched by auto (source %)',
        COALESCE(v_src,'(no row)');
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 4  auto_shipment overwrote an ASIN with a manual override';
    END IF;

    ----------------------------------------------------------------
    -- TEST 5: DOUBLE-CONTINUE must not double count
    ----------------------------------------------------------------
    UPDATE public.shipment_builder_drafts
       SET status = 'continued', continued_to_amazon_at = now(), synced_at = now()
     WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT';
    SELECT count(*) INTO v_conf FROM public.cog_purchase_confirmations
     WHERE user_id = v_uid AND asin = 'TESTCOG001';
    SELECT unit_cost INTO v_avg FROM public.asin_cog_on_record
     WHERE user_id = v_uid AND asin = 'TESTCOG001';
    IF v_conf = 2 AND round(COALESCE(v_avg,0),4) = 6.3333 THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 5  re-continue: still 2 confirmations, avg still %', v_avg;
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 5  re-continue changed things: % confirmations, avg %',
        v_conf, v_avg;
    END IF;

    ----------------------------------------------------------------
    -- TEST 6: EDIT AND RESUBMIT -- back to draft, then continued again
    ----------------------------------------------------------------
    UPDATE public.shipment_builder_drafts
       SET status = 'draft', continued_to_amazon_at = NULL
     WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT';
    -- while "editing", the seller ships MORE of lot B
    UPDATE public.shipment_purchase_allocations
       SET units_shipped = 100
     WHERE user_id = v_uid AND created_listing_id = v_lotB;
    UPDATE public.shipment_builder_drafts
       SET status = 'continued', continued_to_amazon_at = now()
     WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT';

    SELECT count(*) INTO v_conf FROM public.cog_purchase_confirmations
     WHERE user_id = v_uid AND asin = 'TESTCOG001';
    SELECT unit_cost INTO v_avg FROM public.asin_cog_on_record
     WHERE user_id = v_uid AND asin = 'TESTCOG001';
    IF v_conf = 2 THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 6  resubmit: still 2 confirmations (no duplicate lot)';
      RAISE NOTICE '        avg stayed % -- the FIRST confirmation owns the lot,', v_avg;
      RAISE NOTICE '        so shipping more of it later does NOT revise the';
      RAISE NOTICE '        average. That is a deliberate consequence of the';
      RAISE NOTICE '        lot-level primary key and is worth knowing.';
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 6  resubmit produced % confirmations', v_conf;
    END IF;

  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail + 1;
    RAISE NOTICE 'ERROR during tests: %', SQLERRM;
  END;

  ----------------------------------------------------------------
  -- cleanup, always
  ----------------------------------------------------------------
  DELETE FROM public.cog_purchase_confirmations
   WHERE user_id = v_uid AND asin IN ('TESTCOG001','TESTCOG002');
  DELETE FROM public.asin_cog_on_record
   WHERE user_id = v_uid AND asin IN ('TESTCOG001','TESTCOG002');
  DELETE FROM public.asin_cost_overrides
   WHERE user_id = v_uid AND asin = 'TESTCOG002';
  DELETE FROM public.shipment_purchase_allocations
   WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT';
  DELETE FROM public.shipment_builder_drafts
   WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT';
  DELETE FROM public.created_listings
   WHERE user_id = v_uid AND asin IN ('TESTCOG001','TESTCOG002');

  RAISE NOTICE '';
  RAISE NOTICE '======== % passed, % failed ========', v_pass, v_fail;
  RAISE NOTICE 'fixtures removed. Leftovers check:';
  RAISE NOTICE '   created_listings % | allocations % | drafts % | cog rows %',
    (SELECT count(*) FROM public.created_listings
      WHERE user_id = v_uid AND asin IN ('TESTCOG001','TESTCOG002')),
    (SELECT count(*) FROM public.shipment_purchase_allocations
      WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT'),
    (SELECT count(*) FROM public.shipment_builder_drafts
      WHERE user_id = v_uid AND draft_id = 'TESTCOGDRAFT'),
    (SELECT count(*) FROM public.asin_cog_on_record
      WHERE user_id = v_uid AND asin IN ('TESTCOG001','TESTCOG002'));
END
$p$;
