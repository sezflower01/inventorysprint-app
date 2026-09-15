-- VERIFY, as the seller, the path the listing-first layout adds: entering the
-- FIRST COG for a product that had none. Everything is rolled back.
--
-- Until 20260915031000 such products were not on the page, so every save was
-- an UPDATE of an imported row. Now the page INSERTs. Checked, for a product
-- with 2026 sales and no COG:
--   1. before: the product is on the page with no COG, and its sales are not
--      on COG (they keep the Created Listings cost);
--   2. the page's exact insert succeeds under RLS;
--   3. its 2026 sales are re-priced and the history row says 'added', by the
--      seller;
--   4. the page function now returns the product with that COG;
--   5. after rollback, nothing remains.

DO $verify$
DECLARE
  v_uid uuid;
  v_asin text;
  v_n int;
  r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  -- An uncosted listed product with the most 2026 sales.
  SELECT s.asin INTO v_asin
  FROM public.sales_orders s
  WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
    AND EXISTS (SELECT 1 FROM public.created_listings l WHERE l.user_id = v_uid AND l.asin = s.asin)
    AND NOT EXISTS (SELECT 1 FROM public.asin_cog_on_record c WHERE c.user_id = v_uid AND c.asin = s.asin)
  GROUP BY s.asin ORDER BY count(*) DESC LIMIT 1;
  RAISE NOTICE 'test product: %', COALESCE(v_asin, '(none found)');
  IF v_asin IS NULL THEN RETURN; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated', 'email', 'sezflower01@gmail.com')::text, true);
  SET LOCAL ROLE authenticated;

  FOR r IN SELECT asin, cog_id, unit_cost, date_created, latest_unit_cost FROM public.get_cog_page_products() WHERE asin = v_asin LOOP
    RAISE NOTICE '1. on page before: cog_id=% cog=% date=% latest purchase=$%',
      COALESCE(r.cog_id::text, 'none'), COALESCE(r.unit_cost::text, 'none'), r.date_created, r.latest_unit_cost;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.sales_orders
  WHERE user_id = v_uid AND asin = v_asin AND order_date >= '2026-01-01' AND cost_source_at_sale = 'cog_on_record';
  RAISE NOTICE '   2026 sales on COG before: % (expect 0)', v_n;

  BEGIN
    INSERT INTO public.asin_cog_on_record (user_id, asin, unit_cost, source, title)
    VALUES (v_uid, v_asin, 9.99, 'manual', 'verify');
    RAISE NOTICE '2. page insert at $9.99: ok';

    SELECT count(*) INTO v_n FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin AND order_date >= '2026-01-01'
      AND cost_source_at_sale = 'cog_on_record' AND unit_cost = 9.99;
    RAISE NOTICE '3. 2026 sales now at $9.99 on COG: %', v_n;

    FOR r IN SELECT action, old_unit_cost, new_unit_cost, sales_rows_repriced, changed_by_email
             FROM public.asin_cog_on_record_history WHERE asin = v_asin ORDER BY id DESC LIMIT 1 LOOP
      RAISE NOTICE '   history: % % -> % | % sales | %', r.action, COALESCE(r.old_unit_cost::text, 'not set'),
        r.new_unit_cost, r.sales_rows_repriced, r.changed_by_email;
    END LOOP;

    FOR r IN SELECT cog_id IS NOT NULL AS has_row, unit_cost, source FROM public.get_cog_page_products() WHERE asin = v_asin LOOP
      RAISE NOTICE '4. on page after: has COG row=% cog=% source=%', r.has_row, r.unit_cost, r.source;
    END LOOP;

    RAISE EXCEPTION 'rollback-verify';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-verify' THEN RAISE; END IF;
    RAISE NOTICE '   (rolled back)';
  END;

  SET LOCAL ROLE postgres;
  SELECT count(*) INTO v_n FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = v_asin;
  RAISE NOTICE '5. after rollback: COG rows for % = % (expect 0)', v_asin, v_n;
  SELECT count(*) INTO v_n FROM public.sales_orders
  WHERE user_id = v_uid AND asin = v_asin AND order_date >= '2026-01-01' AND cost_source_at_sale = 'cog_on_record';
  RAISE NOTICE '   2026 sales on COG after rollback: % (expect 0)', v_n;
END
$verify$;
