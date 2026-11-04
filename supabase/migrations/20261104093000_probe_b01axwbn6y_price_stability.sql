-- B01AXWBN6Y: is 19.54 CURRENT, and is it STABLE? READ ONLY.
--
-- The offer-stack probe found a healthy picture: cheapest FBA 19.54, then
-- 21.00 and 21.99, with nobody undercutting. If that is a live reading it
-- supports the purchase outright -- the market really has moved up since the
-- 13.12-13.58 months.
--
-- But it was printed WITHOUT a timestamp, which makes it unusable as it
-- stands. A Keepa snapshot from September says nothing about November, and
-- "hope the price stays" is exactly the belief that a stale snapshot would
-- falsely confirm. So: date the snapshots, then look at the price series that
-- covers the stockout.
--
-- Three independent witnesses, none of which depend on this seller selling:
--   asin_price_history (53 rows) -- the series over time
--   bb_price_alerts (17 rows)    -- recorded Buy Box movements
--   keepa_price_stability_cache  -- Keepa's own volatility read
DO $p$
DECLARE r record; v_uid uuid; v_asin text := 'B01AXWBN6Y'; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. HOW OLD ARE THOSE KEEPA SNAPSHOTS? ########';
  FOR r IN
    SELECT to_jsonb(k) - 'offers' AS meta,
           (k.offers->'list'->0->>'price') AS first_price,
           jsonb_array_length(COALESCE(k.offers->'list', '[]'::jsonb)) AS n_offers
    FROM public.keepa_price_history_cache k
    WHERE k.asin = v_asin
  LOOP
    RAISE NOTICE '   %', left(r.meta::text, 500);
    RAISE NOTICE '      offers in list: % | first listed price: %', r.n_offers, r.first_price;
    RAISE NOTICE '';
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '######## 2. PRICE SERIES OVER THE STOCKOUT ########';
  RAISE NOTICE '   (this seller has had 0 units since late June, so anything';
  RAISE NOTICE '    here after that is the market without them in it)';
  -- Real columns, confirmed by introspection rather than guessed:
  -- asin, buybox_price, captured_at, currency_code, fx_rate, id,
  -- listing_price, marketplace, price_usd, source, user_id
  RAISE NOTICE '   captured   | buybox | listing | usd    | source';
  FOR r IN
    SELECT h.captured_at::date AS d, h.buybox_price AS bb, h.listing_price AS lp,
           h.price_usd AS usd, COALESCE(h.source,'-') AS src, h.marketplace AS mk
    FROM public.asin_price_history h
    WHERE h.asin = v_asin
    ORDER BY h.captured_at DESC LIMIT 25
  LOOP
    RAISE NOTICE '   % | % | % | % | % (%)',
      r.d, lpad(COALESCE(r.bb::text,'-'),6), lpad(COALESCE(r.lp::text,'-'),7),
      lpad(COALESCE(r.usd::text,'-'),6), r.src, r.mk;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   buy box since the stockout (after 2026-06-23):';
  FOR r IN
    SELECT count(*) AS n, min(h.buybox_price) AS lo, max(h.buybox_price) AS hi,
           round(avg(h.buybox_price), 2) AS av,
           min(h.captured_at)::date AS first_d, max(h.captured_at)::date AS last_d
    FROM public.asin_price_history h
    WHERE h.asin = v_asin AND h.captured_at > '2026-06-23'
      AND h.buybox_price IS NOT NULL
  LOOP
    IF COALESCE(r.n,0) = 0 THEN
      RAISE NOTICE '   NO readings since the stockout -- the offer stack seen';
      RAISE NOTICE '   earlier cannot be dated from this table either.';
    ELSE
      RAISE NOTICE '   % readings, % to %, low % high % avg %',
        r.n, r.first_d, r.last_d, r.lo, r.hi, r.av;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. RECORDED BUY BOX MOVES ########';
  FOR r IN
    SELECT to_jsonb(b) AS j FROM public.bb_price_alerts b
    WHERE b.asin = v_asin LIMIT 17
  LOOP
    RAISE NOTICE '   %', left((r.j - 'id' - 'asin' - 'user_id')::text, 300);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. KEEPA STABILITY READ ########';
  FOR r IN
    SELECT to_jsonb(s) AS j FROM public.keepa_price_stability_cache s
    WHERE s.asin = v_asin
  LOOP
    RAISE NOTICE '   %', left(r.j::text, 900);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 5. WHAT PRICE WAS *OURS* SET TO? ########';
  RAISE NOTICE '   (asin_my_price_cache -- our own listed price over time)';
  FOR r IN
    SELECT to_jsonb(m) AS j FROM public.asin_my_price_cache m
    WHERE m.asin = v_asin ORDER BY 1 DESC LIMIT 6
  LOOP
    RAISE NOTICE '   %', left(r.j::text, 320);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
