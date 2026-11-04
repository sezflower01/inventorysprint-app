-- B01AXWBN6Y: which FBA fee is right? READ ONLY.
--
-- The Create panel says ROI 75%, the analyser says 67%, on the same ASIN at
-- the same cost. Both use profit / unitCost, so the formula is not the
-- disagreement -- the fulfilment fee is. Four different figures are in play:
--
--   3.86   what fetch-listing-snapshot handed the Create panel
--   4.11   Keepa's fba_fee_estimate in keepa_price_stability_cache
--   4.4356 asin_fee_cache, the row updated 2026-09-09
--   ?      whatever Amazon has actually BILLED on settled orders
--
-- CLAUDE.md is explicit that the last one wins: Amazon's Fees API prices
-- ACTUAL weight while Amazon bills DIMENSIONAL weight, so the quote
-- understates bulky-but-light items, and get_asin_fba_fee_basis is the
-- authority. This ASIN is a 3.5" pool suction cover -- light, and bulky for
-- its weight -- which is exactly the shape that gets under-quoted.
--
-- 77 units have settled on this ASIN, so there is an invoice to read rather
-- than an estimate to argue about.
DO $p$
DECLARE r record; v_uid uuid; v_asin text := 'B01AXWBN6Y'; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. THE AUTHORITY: get_asin_fba_fee_basis ########';
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_asin_fba_fee_basis';
  IF v_n > 0 THEN
    BEGIN
      FOR r IN EXECUTE format(
        'SELECT to_jsonb(x) AS j FROM public.get_asin_fba_fee_basis(%L::uuid, %L::text) x',
        v_uid, v_asin)
      LOOP
        RAISE NOTICE '   %', left(r.j::text, 900);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '   call failed (%) -- falling back to the raw billed data', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '   function not present';
  END IF;

  ------------------------------------------------------------------
  -- The invoice itself: what Amazon charged per unit on settled orders.
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. WHAT AMAZON ACTUALLY BILLED ########';
  RAISE NOTICE '   month   | units | fba fee | per unit';
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date), 'YYYY-MM') AS mon,
           sum(s.quantity)::int AS units,
           round(sum(COALESCE(s.fba_fee, 0))::numeric, 2) AS fee,
           round((sum(COALESCE(s.fba_fee, 0)) / NULLIF(sum(s.quantity), 0))::numeric, 2) AS per_unit
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.fba_fee, 0) > 0
      AND s.order_date >= current_date - 400
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | %  | % | %', r.mon, lpad(r.units::text, 5),
      lpad(r.fee::text, 7), lpad(r.per_unit::text, 8);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no billed FBA fees recorded'; END IF;

  FOR r IN
    SELECT sum(s.quantity)::int AS units,
           round((sum(COALESCE(s.fba_fee, 0)) / NULLIF(sum(s.quantity), 0))::numeric, 4) AS avg_fee,
           round(min(COALESCE(s.fba_fee, 0) / NULLIF(s.quantity, 0))::numeric, 2) AS lo,
           round(max(COALESCE(s.fba_fee, 0) / NULLIF(s.quantity, 0))::numeric, 2) AS hi
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.fba_fee, 0) > 0
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   >>> BILLED AVERAGE over % units: % per unit (range % to %)',
      r.units, r.avg_fee, r.lo, r.hi;
    RAISE NOTICE '   >>> the quote the Create panel used was 3.86';
    IF r.avg_fee IS NOT NULL THEN
      RAISE NOTICE '   >>> under-quoted by % per unit',
        round((r.avg_fee - 3.86)::numeric, 2);
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. THE FEE CACHE ROWS ########';
  FOR r IN
    SELECT to_jsonb(f) AS j FROM public.asin_fee_cache f WHERE f.asin = v_asin
  LOOP
    RAISE NOTICE '   mk % | referral % | fba % | updated %',
      COALESCE(r.j->>'marketplace','-'), r.j->>'referral_rate',
      r.j->>'fba_fee_fixed', left(COALESCE(r.j->>'updated_at','-'), 10);
  END LOOP;

  ------------------------------------------------------------------
  -- ROI at each candidate fee, so the size of the disagreement is explicit.
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. ROI AT EACH CANDIDATE FEE ########';
  RAISE NOTICE '   (Buy Box 19.54, cost 7.50, referral 15.02%%)';
  RAISE NOTICE '   fba fee | profit | ROI';
  FOR r IN
    SELECT f AS fee,
           round((19.54 - (19.54 * 0.15022) - f - 7.50)::numeric, 2) AS profit,
           round(((19.54 - (19.54 * 0.15022) - f - 7.50) / 7.50 * 100)::numeric, 0) AS roi
    FROM unnest(ARRAY[3.86, 4.11, 4.4356]::numeric[]) AS f
  LOOP
    RAISE NOTICE '   %  | %  | %%%', lpad(r.fee::text, 7),
      lpad(r.profit::text, 6), lpad(r.roi::text, 3);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
