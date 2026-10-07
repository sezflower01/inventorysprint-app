-- READ-ONLY PROBE, the last link in the chain.
--
-- fetch-live-orders Tier B has an explicit currency contract: estimated_price
-- is NATIVE marketplace currency for non-US, and an inventory-sourced snapshot
-- is USD and must be converted first. The stored estimate for the CA order is
-- 20.75 -- byte for byte inventory.my_price -- so NO conversion happened, which
-- means the snapshot row claimed to be in CAD already.
--
--   inventory KVB-CBK-JRNR : price 25.93, my_price 20.75   (one pool, all 4
--                                                           marketplaces, USD)
--   order estimate          : 20.75, tagged CA
--   screen                  : 20.75 x 0.70 = $14.56
--   Amazon                  : CA$34.13 = about US$24
--
-- And it is not one order. Estimate vs settled price, 180 days:
--   US  21,194 orders  est $20.47 vs sold $20.50   +0.3%
--   CA     185 orders  est $36.39 vs sold $28.13  +30.0%
--   MX     110 orders  est $479.05 vs sold $27.73  +1630%
--   BR      29 orders  est $148.83 vs sold $28.73   +422%
--
-- US is fine. Every non-US marketplace is wrong, in both directions, which is
-- the signature of a currency tag rather than a bad price.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== order_price_snapshots columns ==';
  FOR r IN SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'order_price_snapshots' LOOP
    RAISE NOTICE '  %', r.cols;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the snapshot behind the CA order ==';
  FOR r IN
    SELECT order_id, asin, snapshot_price, snapshot_item_price,
           snapshot_source, captured_at
    FROM public.order_price_snapshots
    WHERE user_id = v_uid AND order_id = '702-5492481-4068251'
    ORDER BY captured_at DESC
  LOOP
    RAISE NOTICE '  % | % | price % | item_price % | source % | %',
      r.order_id, r.asin, r.snapshot_price, r.snapshot_item_price,
      COALESCE(r.snapshot_source, '(null)'), r.captured_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no snapshot row for this order)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what currency do NON-US snapshots claim, and by source? ==';
  FOR r IN
    SELECT COALESCE(s.snapshot_source, '(null)') AS src,
           count(*) AS rows,
           round(avg(s.snapshot_item_price)::numeric, 2) AS avg_price
    FROM public.order_price_snapshots s
    JOIN public.sales_orders so
      ON so.user_id = s.user_id AND so.order_id = s.order_id
    WHERE s.user_id = v_uid
      AND upper(COALESCE(so.marketplace, '')) IN ('CA', 'MX', 'BR')
      AND s.captured_at > now() - interval '120 days'
    GROUP BY 1 ORDER BY rows DESC LIMIT 12
  LOOP
    RAISE NOTICE '  source % | % rows | avg price %',
      rpad(r.src, 26), lpad(r.rows::text, 6), r.avg_price;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no non-US snapshots in 120 days)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the FX table the estimator multiplies by ==';
  FOR r IN SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fx_rates' LOOP
    RAISE NOTICE '  fx_rates columns: %', r.cols;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no fx_rates table -- rates come from elsewhere)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== non-US orders still unsettled and carrying an estimate ==';
  FOR r IN
    SELECT order_id, asin, COALESCE(marketplace, '?') AS mk, quantity,
           estimated_price, COALESCE(price_calc_mode, '?') AS mode,
           COALESCE(price_confidence, '?') AS conf, order_date
    FROM public.sales_orders
    WHERE user_id = v_uid
      AND upper(COALESCE(marketplace, '')) IN ('CA', 'MX', 'BR')
      AND COALESCE(sold_price, 0) = 0 AND COALESCE(estimated_price, 0) > 0
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND'
    ORDER BY estimated_price DESC LIMIT 20
  LOOP
    RAISE NOTICE '  % | % | % | q% | est % | % | % | %',
      r.order_id, r.asin, r.mk, r.quantity, lpad(r.estimated_price::text, 9),
      rpad(r.mode, 24), rpad(r.conf, 23), r.order_date;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (none)'; END IF;
END
$p$;
