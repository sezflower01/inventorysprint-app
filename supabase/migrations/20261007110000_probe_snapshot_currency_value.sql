-- READ-ONLY PROBE. One value decides where the CA bug lives.
--
-- fetch-live-orders Tier B converts an inventory-sourced snapshot from USD to
-- the marketplace's native currency:
--
--   snapCurrency = currency_code || currency
--                  || (source is pricing_api/orders_api ? native : 'USD')
--   estimated    = snapCurrency === 'USD' && native !== 'USD' && fxRates[native]
--                    ? raw * fxRates[native] : raw
--
-- The snapshot is source 'backfill_inventory_asin', so the fallback would say
-- USD and the conversion WOULD run. It did not -- the stored estimate is 20.75,
-- byte for byte inventory.my_price. So either the row carries an explicit
-- currency of CAD over a USD number, or fxRates had no CAD entry.
--
-- Those are different bugs with different fixes, so read the value rather than
-- guessing.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the CA snapshot, currency columns included ==';
  FOR r IN
    SELECT snapshot_item_price, snapshot_source,
           COALESCE(currency, '(null)') AS cur,
           COALESCE(currency_code, '(null)') AS cur_code,
           COALESCE(fx_rate_used::text, '(null)') AS fx,
           COALESCE(marketplace_id, '(null)') AS mp,
           COALESCE(inventory_price_at_capture::text, '-') AS inv_at_capture,
           COALESCE(listing_api_price_at_capture::text, '-') AS api_at_capture,
           captured_at
    FROM public.order_price_snapshots
    WHERE user_id = v_uid AND order_id = '702-5492481-4068251'
  LOOP
    RAISE NOTICE '  item_price % | source %', r.snapshot_item_price, r.snapshot_source;
    RAISE NOTICE '  currency % | currency_code % | fx_rate_used %', r.cur, r.cur_code, r.fx;
    RAISE NOTICE '  marketplace_id % | inventory_at_capture % | listing_api_at_capture %',
      r.mp, r.inv_at_capture, r.api_at_capture;
    RAISE NOTICE '  captured %', r.captured_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== currency tagging across non-US snapshots ==';
  FOR r IN
    SELECT COALESCE(s.snapshot_source, '(null)') AS src,
           COALESCE(s.currency_code, s.currency, '(null)') AS cur,
           count(*) AS rows, round(avg(s.snapshot_item_price)::numeric, 2) AS avg_price
    FROM public.order_price_snapshots s
    JOIN public.sales_orders so ON so.user_id = s.user_id AND so.order_id = s.order_id
    WHERE s.user_id = v_uid AND upper(COALESCE(so.marketplace, '')) IN ('CA','MX','BR')
    GROUP BY 1, 2 ORDER BY rows DESC LIMIT 15
  LOOP
    RAISE NOTICE '  source % | currency % | % rows | avg %',
      rpad(r.src, 26), rpad(r.cur, 8), lpad(r.rows::text, 5), r.avg_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does fx_rates even have the pairs the estimator needs? ==';
  FOR r IN
    SELECT base, quote, rate, as_of, COALESCE(source, '?') AS src
    FROM public.fx_rates
    WHERE quote IN ('CAD','MXN','BRL','USD') OR base IN ('CAD','MXN','BRL','USD')
    ORDER BY as_of DESC, base, quote LIMIT 20
  LOOP
    RAISE NOTICE '  % -> % = % | as_of % | %', r.base, r.quote, r.rate, r.as_of, r.src;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (fx_rates is EMPTY -- no conversion could ever run)'; END IF;
END
$p$;
