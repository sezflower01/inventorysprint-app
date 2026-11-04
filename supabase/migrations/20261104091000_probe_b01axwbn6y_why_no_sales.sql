-- B01AXWBN6Y: why have there been no sales in 90 days? READ ONLY.
--
-- The price probe found the last sale on 2026-06-23 and nothing since. That
-- reading is ambiguous and the ambiguity decides a $750 purchase:
--
--   * If the listing RAN OUT OF STOCK in June, then "no sales in 90 days" says
--     nothing whatever about the price. It is the expected consequence of
--     having nothing to sell -- and is presumably why a re-buy is being
--     considered at all. $19.97 could be perfectly achievable.
--   * If stock has been available all along and nothing sold, then $19.97 is a
--     price the market is refusing, and the re-buy is a bad idea.
--
-- The second signal that matters is the repricer floor. March and April show
-- 46 units at $13.52 -- the same figure over and over, which is what a MINIMUM
-- PRICE looks like, not what a market looks like. If that floor is still set,
-- 100 new units will be sold down to it again regardless of the list price
-- today, and the forecast at $19.97 is fiction for a reason that has nothing to
-- do with demand.
--
-- Columns are printed via to_jsonb rather than named, because guessing column
-- names on these two tables has cost real time before.
DO $p$
DECLARE r record; v_uid uuid; v_asin text := 'B01AXWBN6Y'; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. INVENTORY -- is there anything to sell? ########';
  FOR r IN
    SELECT to_jsonb(i) AS j FROM public.inventory i
    WHERE i.user_id = v_uid AND i.asin = v_asin
  LOOP
    RAISE NOTICE '   sku            : %', r.j->>'sku';
    RAISE NOTICE '   available      : %', r.j->>'available';
    RAISE NOTICE '   inbound        : %', r.j->>'inbound';
    RAISE NOTICE '   reserved       : %', r.j->>'reserved';
    RAISE NOTICE '   status         : %', r.j->>'status';
    RAISE NOTICE '   fulfillment    : %', r.j->>'fulfillment_channel';
    RAISE NOTICE '   last updated   : %', r.j->>'updated_at';
    RAISE NOTICE '';
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO inventory row at all for this ASIN.';
    RAISE NOTICE '';
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '######## 2. REPRICER -- is there a floor at 13.52? ########';
  FOR r IN
    SELECT to_jsonb(a) AS j FROM public.repricer_assignments a
    WHERE a.user_id = v_uid AND a.asin = v_asin
  LOOP
    RAISE NOTICE '   sku % | status % | strategy %',
      r.j->>'sku', r.j->>'status', r.j->>'strategy_id';
    RAISE NOTICE '   min_price % | max_price % | current %',
      r.j->>'min_price', r.j->>'max_price', r.j->>'current_price';
    RAISE NOTICE '   not buyable % | listing state %',
      r.j->>'is_listing_inactive_not_buyable', r.j->>'amazon_listing_state';
    RAISE NOTICE '';
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NO repricer assignment -- price is whatever was last set';
    RAISE NOTICE '   by hand, and nothing is defending it.';
    RAISE NOTICE '';
  END IF;

  ------------------------------------------------------------------
  -- Stock is only meaningful as a history. A zero today with a zero all
  -- summer is a stockout; a zero today after stock sat unsold is not.
  RAISE NOTICE '######## 3. WHEN DID IT GO OUT OF STOCK? ########';
  SELECT count(*) INTO v_n FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'inventory_snapshots';
  IF v_n > 0 THEN
    FOR r IN EXECUTE format(
      'SELECT to_jsonb(s) AS j FROM public.inventory_snapshots s
        WHERE s.user_id = %L AND s.asin = %L
        ORDER BY s.created_at DESC LIMIT 12', v_uid, v_asin)
    LOOP
      RAISE NOTICE '   % | available %', r.j->>'created_at', r.j->>'available';
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   no snapshots for this ASIN'; END IF;
  ELSE
    RAISE NOTICE '   (no inventory_snapshots table -- skipping)';
  END IF;

  ------------------------------------------------------------------
  -- The one remaining explanation for a dead listing that is neither
  -- stock nor price.
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. IS THE LISTING SUPPRESSED? ########';
  SELECT count(*) INTO v_n FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'listing_suppressions';
  IF v_n > 0 THEN
    FOR r IN EXECUTE format(
      'SELECT to_jsonb(x) AS j FROM public.listing_suppressions x
        WHERE x.user_id = %L AND x.asin = %L ORDER BY 1 DESC LIMIT 5', v_uid, v_asin)
    LOOP
      RAISE NOTICE '   %', r.j;
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   no suppression records'; END IF;
  ELSE
    RAISE NOTICE '   (no listing_suppressions table -- skipping)';
  END IF;

  ------------------------------------------------------------------
  -- 46 of the year's 82 units went at 13.52. How concentrated is that?
  RAISE NOTICE '';
  RAISE NOTICE '######## 5. PRICE POINTS, MOST UNITS FIRST ########';
  RAISE NOTICE '   per unit | units | orders | first      | last';
  FOR r IN
    SELECT round(COALESCE(s.total_sale_amount, s.sold_price * s.quantity)
                 / NULLIF(s.quantity, 0), 2) AS per_unit,
           sum(s.quantity)::int AS units, count(*)::int AS orders,
           min(s.order_date) AS first_d, max(s.order_date) AS last_d
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) > 0
      AND s.order_date >= current_date - 365
    GROUP BY 1 ORDER BY 2 DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % | % | % | %',
      lpad(r.per_unit::text, 8), lpad(r.units::text, 5),
      lpad(r.orders::text, 6), r.first_d, r.last_d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
