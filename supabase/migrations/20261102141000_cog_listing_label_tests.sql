-- TESTS for the unconfirmed label: new product, restock, FBM-only.
-- Fixtures created, asserted, then removed in an EXCEPTION-protected block so
-- cleanup runs even on failure. Reserved ASINs TESTLBL001..003 only.
DO $p$
DECLARE
  v_uid uuid; v_lot1 uuid; v_lot2 uuid; v_lot3 uuid;
  v_pass int := 0; v_fail int := 0;
  v_src text; v_cost numeric; v_conf boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  BEGIN
    ----------------------------------------------------------------
    -- TEST 1: NEW PRODUCT, no shipment -> listing_unconfirmed
    ----------------------------------------------------------------
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTLBL001', 'LBL-SKU-1', 'label test new', 240.00, 20, now())
    RETURNING id INTO v_lot1;

    SELECT source, unit_cost, (calculation->>'shipment_confirmed')::boolean
      INTO v_src, v_cost, v_conf
    FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'TESTLBL001';

    IF v_src = 'listing_unconfirmed' AND v_cost = 12.00 AND v_conf = false THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 1  new product, unshipped -> % at % (confirmed %)',
        v_src, v_cost, v_conf;
      RAISE NOTICE '        a cost EXISTS (so COGS is not lost) but is marked';
      RAISE NOTICE '        provisional -- which is the whole point.';
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 1  got source % cost % confirmed %, expected listing_unconfirmed 12.00 false',
        v_src, v_cost, v_conf;
    END IF;

    ----------------------------------------------------------------
    -- TEST 2: FBM-ONLY -- never allocated, never shipped. Must keep a cost.
    ----------------------------------------------------------------
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTLBL002', 'LBL-SKU-2', 'label test fbm', 300.00, 10, now())
    RETURNING id INTO v_lot2;

    SELECT source, unit_cost INTO v_src, v_cost
    FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'TESTLBL002';
    IF v_src = 'listing_unconfirmed' AND v_cost = 30.00 THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 2  FBM-only keeps a usable cost (% at %)', v_src, v_cost;
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 2  FBM-only got % at %', v_src, v_cost;
    END IF;

    -- and it must never reach a confirmed average
    IF NOT EXISTS (SELECT 1 FROM public.cog_purchase_confirmations
                    WHERE user_id = v_uid AND asin = 'TESTLBL002') THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 3  FBM-only lot is absent from cog_purchase_confirmations';
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 3  an unshipped lot got into the confirmations table';
    END IF;

    ----------------------------------------------------------------
    -- TEST 4: RESTOCK that IS shipped -> auto_shipment supersedes the label
    ----------------------------------------------------------------
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTLBL003', 'LBL-SKU-3', 'label test restock', 100.00, 10, now())
    RETURNING id INTO v_lot3;
    -- first write is provisional
    SELECT source INTO v_src FROM public.asin_cog_on_record
     WHERE user_id = v_uid AND asin = 'TESTLBL003';
    IF v_src = 'listing_unconfirmed' THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 4  restock starts provisional (%)', v_src;
    ELSE
      v_fail := v_fail + 1; RAISE NOTICE 'FAIL 4  restock started as %', v_src;
    END IF;

    -- now ship it
    INSERT INTO public.shipment_builder_drafts
      (user_id, draft_id, shipment_name, status, inbound_plan_id)
    VALUES (v_uid, 'TESTLBLDRAFT', 'label test draft', 'draft', 'PLAN-LBL-1');
    INSERT INTO public.shipment_purchase_allocations
      (user_id, draft_id, created_listing_id, asin, sku, units_allocated, units_shipped)
    VALUES (v_uid, 'TESTLBLDRAFT', v_lot3, 'TESTLBL003', 'LBL-SKU-3', 10, 10);
    UPDATE public.shipment_builder_drafts
       SET status='continued', continued_to_amazon_at = now(),
           amazon_shipment_id='FBA-LBL-1'
     WHERE user_id = v_uid AND draft_id = 'TESTLBLDRAFT';

    SELECT source, unit_cost INTO v_src, v_cost
    FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'TESTLBL003';
    IF v_src = 'auto_shipment' AND v_cost = 10.00 THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 5  once shipped -> % at % (provisional replaced)',
        v_src, v_cost;
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 5  after shipping got % at %, expected auto_shipment 10.00',
        v_src, v_cost;
    END IF;

    ----------------------------------------------------------------
    -- TEST 6: a provisional cost must never win over auto_shipment on a
    -- later unshipped purchase of the same product.
    ----------------------------------------------------------------
    INSERT INTO public.created_listings (user_id, asin, sku, title, cost, units, created_at)
    VALUES (v_uid, 'TESTLBL003', 'LBL-SKU-3B', 'label test restock 2', 900.00, 10, now());
    SELECT source, unit_cost INTO v_src, v_cost
    FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'TESTLBL003';
    IF v_src = 'auto_shipment' AND v_cost = 10.00 THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS 6  a later UNSHIPPED 90/unit purchase did not move the';
      RAISE NOTICE '        confirmed COG -- still % at %', v_src, v_cost;
    ELSE
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL 6  unshipped purchase changed the COG to % at %',
        v_src, v_cost;
    END IF;

  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail + 1;
    RAISE NOTICE 'ERROR during tests: %', SQLERRM;
  END;

  -- cleanup, always
  DELETE FROM public.cog_purchase_confirmations
   WHERE user_id = v_uid AND asin LIKE 'TESTLBL%';
  DELETE FROM public.asin_cog_on_record
   WHERE user_id = v_uid AND asin LIKE 'TESTLBL%';
  DELETE FROM public.shipment_purchase_allocations
   WHERE user_id = v_uid AND draft_id = 'TESTLBLDRAFT';
  DELETE FROM public.shipment_builder_drafts
   WHERE user_id = v_uid AND draft_id = 'TESTLBLDRAFT';
  DELETE FROM public.created_listings
   WHERE user_id = v_uid AND asin LIKE 'TESTLBL%';

  RAISE NOTICE '';
  RAISE NOTICE '======== % passed, % failed ========', v_pass, v_fail;
  RAISE NOTICE 'leftovers: listings % | cog % | confirmations %',
    (SELECT count(*) FROM public.created_listings
      WHERE user_id = v_uid AND asin LIKE 'TESTLBL%'),
    (SELECT count(*) FROM public.asin_cog_on_record
      WHERE user_id = v_uid AND asin LIKE 'TESTLBL%'),
    (SELECT count(*) FROM public.cog_purchase_confirmations
      WHERE user_id = v_uid AND asin LIKE 'TESTLBL%');
END
$p$;
