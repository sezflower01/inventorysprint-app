-- B01AXWBN6Y: is $19.97 a real market price, or just an idle list price?
-- READ ONLY.
--
-- Settled so far:
--   * Stock is 0 available / 0 inbound / 0 reserved, so the 90-day sales
--     drought is a STOCKOUT. It is not evidence the price was rejected, and
--     the objection "it sells at 19.97 now" cannot be dismissed on that basis.
--   * min_price and max_price are both NULL on all four (duplicate) repricer
--     rows, so the Feb-Apr prices were NOT a repricer floor being hit. They
--     were whatever the market paid.
--   * What the market paid, every time, was 12.64 to 15.59. Never 19.97.
--
-- So the open question is whether the market MOVED during the stockout. A
-- price carries no information while you have nothing to sell: your own
-- listing can show any number, and a Buy Box held by a competitor who is about
-- to run out is not a price you will inherit.
--
-- Keepa stores what the Buy Box actually did. That is the only witness here
-- that is independent of this seller's own (absent) sales.
DO $p$
DECLARE r record; v_uid uuid; v_asin text := 'B01AXWBN6Y'; v_n int; v_tbl text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. WHICH PRICE TABLES HOLD THIS ASIN? ########';
  FOR r IN
    SELECT t.table_name AS tn
    FROM information_schema.tables t
    WHERE t.table_schema = 'public'
      AND (t.table_name LIKE '%price%' OR t.table_name LIKE 'keepa%'
           OR t.table_name LIKE '%buybox%' OR t.table_name LIKE '%snapshot%')
      AND t.table_type = 'BASE TABLE'
      AND EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                     AND c.column_name = 'asin')
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE asin = %L', r.tn, v_asin)
      INTO v_n;
    IF v_n > 0 THEN
      RAISE NOTICE '   % -> % row(s)', rpad(r.tn, 38), v_n;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. KEEPA CURRENT ########';
  SELECT count(*) INTO v_n FROM information_schema.tables
  WHERE table_schema='public' AND table_name='keepa_price_cache';
  IF v_n > 0 THEN
    FOR r IN EXECUTE format(
      'SELECT to_jsonb(k) AS j FROM public.keepa_price_cache k
        WHERE k.asin = %L LIMIT 3', v_asin)
    LOOP
      RAISE NOTICE '   %', left(r.j::text, 600);
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   nothing cached for this ASIN'; END IF;
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. KEEPA BUY BOX HISTORY ########';
  RAISE NOTICE '   (the independent witness -- what the Buy Box did while';
  RAISE NOTICE '    this seller had no stock to influence it)';
  SELECT count(*) INTO v_n FROM information_schema.tables
  WHERE table_schema='public' AND table_name='keepa_price_history_cache';
  IF v_n > 0 THEN
    FOR r IN EXECUTE format(
      'SELECT to_jsonb(k) AS j FROM public.keepa_price_history_cache k
        WHERE k.asin = %L LIMIT 2', v_asin)
    LOOP
      RAISE NOTICE '   %', left(r.j::text, 1500);
    END LOOP;
    IF NOT FOUND THEN
      RAISE NOTICE '   NO Keepa history for this ASIN. Nothing independent to';
      RAISE NOTICE '   check 19.97 against -- the only evidence available is';
      RAISE NOTICE '   this seller''s own sales, which never exceeded 15.59.';
    END IF;
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. FEES ON RECORD ########';
  SELECT count(*) INTO v_n FROM information_schema.tables
  WHERE table_schema='public' AND table_name='asin_fee_cache';
  IF v_n > 0 THEN
    FOR r IN EXECUTE format(
      'SELECT to_jsonb(f) AS j FROM public.asin_fee_cache f
        WHERE f.asin = %L LIMIT 3', v_asin)
    LOOP
      RAISE NOTICE '   referral rate % | fba fixed % | updated %',
        r.j->>'referral_rate', r.j->>'fba_fee_fixed', r.j->>'updated_at';
    END LOOP;
    IF NOT FOUND THEN RAISE NOTICE '   no fee cache row'; END IF;
  END IF;

  ------------------------------------------------------------------
  -- The price was FALLING through the selling period. That matters more
  -- than any single month: it is what this seller's own supply did to
  -- the price last time, and 100 units would do it again.
  RAISE NOTICE '';
  RAISE NOTICE '######## 5. PRICE WHILE ACTUALLY SELLING ########';
  RAISE NOTICE '   month   | units | per unit | cumulative units sold';
  DECLARE v_cum int := 0;
  BEGIN
    FOR r IN
      SELECT to_char(date_trunc('month', s.order_date), 'YYYY-MM') AS mon,
             sum(s.quantity)::int AS units,
             round(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity))
                   / NULLIF(sum(s.quantity), 0), 2) AS per_unit
      FROM public.sales_orders s
      WHERE s.user_id = v_uid AND s.asin = v_asin
        AND COALESCE(s.is_cancelled, false) = false
        AND s.order_id NOT LIKE '%-REFUND'
        AND COALESCE(s.sold_price, 0) > 0
        AND s.order_date >= '2026-01-01'
      GROUP BY 1 ORDER BY 1
    LOOP
      v_cum := v_cum + r.units;
      RAISE NOTICE '   % | %  | %  | %',
        r.mon, lpad(r.units::text, 5), lpad(r.per_unit::text, 8), lpad(v_cum::text, 5);
    END LOOP;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
