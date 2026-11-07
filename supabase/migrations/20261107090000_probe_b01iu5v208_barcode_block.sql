-- B01IU5V208 / SKU 1061637734: what is actually attached to this SKU?
-- READ ONLY.
--
-- The FBA Eligibility page lists exactly ONE blocked listing, at 0 available /
-- 0 reserved / 0 inbound. Two things follow from that and both change the
-- advice I gave:
--
--   * ONE row, not a page of them, means the account-level FBA barcode
--     preference is probably already "Amazon barcode" and this SKU is an
--     exception, not the start of a wave. Worth confirming before telling
--     anyone to go change an account-wide setting.
--   * ZERO stock anywhere means nothing is at risk in deleting it. I warned
--     against deleting because 200 units were heading to it -- but those 200
--     are an unconfirmed shipment PLAN, not inbound stock, so there is no
--     inventory to orphan.
--
-- What still matters before recreating: does this SKU carry history? Sales,
-- a cost on record, or a repricer assignment all tie to the SKU, and a new SKU
-- starts empty. And is there already a SECOND SKU on this ASIN with a good
-- FNSKU, in which case nothing needs creating at all.
DO $p$
DECLARE r record; v_uid uuid; v_asin text := 'B01IU5V208'; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. EVERY SKU WE HOLD ON THIS ASIN ########';
  RAISE NOTICE '   (a second SKU with a real FNSKU would mean nothing to create)';
  FOR r IN
    SELECT to_jsonb(i) AS j FROM public.inventory i
    WHERE i.user_id = v_uid AND i.asin = v_asin
  LOOP
    RAISE NOTICE '   sku % | fnsku % | avail % | inbound % | reserved % | status %',
      r.j->>'sku', COALESCE(r.j->>'fnsku','-'), r.j->>'available',
      r.j->>'inbound', r.j->>'reserved', COALESCE(r.j->>'listing_status','-');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no inventory rows'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   fnsku_map (this is what the gate actually reads):';
  FOR r IN
    SELECT to_jsonb(f) AS j FROM public.fnsku_map f WHERE f.asin = v_asin
  LOOP
    RAISE NOTICE '   sku % | fnsku % | %',
      COALESCE(r.j->>'seller_sku','-'), r.j->>'fnsku',
      CASE WHEN upper(COALESCE(r.j->>'fnsku','')) = v_asin
           THEN '<-- MANUFACTURER MODE (fnsku = asin)'
           WHEN COALESCE(r.j->>'fnsku','') ~ '^X[A-Z0-9]{9}$' THEN 'valid FNSKU'
           ELSE 'unrecognised' END;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no fnsku_map rows'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. DOES THIS SKU CARRY HISTORY? ########';
  RAISE NOTICE '   (anything here is lost to reporting if the SKU is replaced)';
  FOR r IN
    SELECT count(*)::int AS orders, COALESCE(sum(s.quantity),0)::int AS units,
           round(COALESCE(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity)),0)::numeric, 2) AS revenue,
           min(s.order_date) AS first_d, max(s.order_date) AS last_d
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
  LOOP
    IF r.orders = 0 THEN
      RAISE NOTICE '   NEVER SOLD. No sales history to preserve.';
    ELSE
      RAISE NOTICE '   % orders, % units, revenue %, % to %',
        r.orders, r.units, r.revenue, r.first_d, r.last_d;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.asin_cog_on_record
  WHERE user_id = v_uid AND asin = v_asin;
  IF v_n > 0 THEN
    FOR r IN
      SELECT source, round(unit_cost, 2) AS c FROM public.asin_cog_on_record
      WHERE user_id = v_uid AND asin = v_asin
    LOOP
      RAISE NOTICE '   COG on record: % per unit (source %)', r.c, r.source;
    END LOOP;
  ELSE
    RAISE NOTICE '   no COG on record';
  END IF;

  FOR r IN
    SELECT COALESCE(sku,'-') AS sku, COALESCE(status,'-') AS st
    FROM public.repricer_assignments
    WHERE user_id = v_uid AND asin = v_asin
  LOOP
    RAISE NOTICE '   repricer assignment: sku % | status %', r.sku, r.st;
  END LOOP;

  FOR r IN
    SELECT COALESCE(sku,'-') AS sku, COALESCE(units,0) AS u,
           round(COALESCE(cost,0)::numeric,2) AS c, created_at::date AS d
    FROM public.created_listings
    WHERE user_id = v_uid AND asin = v_asin ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '   created_listing: sku % | % units | cost % | %', r.sku, r.u, r.c, r.d;
  END LOOP;

  ------------------------------------------------------------------
  -- If this really is the only one, the account setting is not the culprit.
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. IS THIS ACCOUNT-WIDE OR JUST THIS SKU? ########';
  SELECT count(DISTINCT f.asin) INTO v_n
  FROM public.fnsku_map f
  WHERE upper(f.fnsku) = upper(f.asin);
  RAISE NOTICE '   ASINs in manufacturer mode across the whole map: %', v_n;
  IF v_n <= 1 THEN
    RAISE NOTICE '   >>> Just this one. The account-level barcode preference is';
    RAISE NOTICE '   >>> very likely already "Amazon barcode" -- do NOT go';
    RAISE NOTICE '   >>> changing account-wide settings over a single SKU.';
  ELSE
    FOR r IN
      SELECT DISTINCT f.asin AS a, COALESCE(f.seller_sku,'-') AS sku
      FROM public.fnsku_map f WHERE upper(f.fnsku) = upper(f.asin) LIMIT 15
    LOOP
      RAISE NOTICE '      % | sku %', r.a, r.sku;
    END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
