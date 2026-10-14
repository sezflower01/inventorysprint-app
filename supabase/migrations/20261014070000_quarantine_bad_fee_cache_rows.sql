-- Quarantine the fee-cache rows written in the wrong currency.
--
-- calculate-roi-floor and learn-intl-fee-multipliers both ask Amazon's Fees API
-- in the MARKETPLACE's currency and wrote the answer straight into
-- asin_fee_cache.fba_fee_fixed, which is contracted as USD. backfill-fee-cache,
-- the writer behind the trusted fees_api rows, states the rule plainly in its
-- own comment: "sends NATIVE currency, converts response back to USD before
-- returning". These two skipped that step.
--
-- Measured 2026-10-14, MX:
--   sp_api_live     132 rows   fba $4.35    referral 12.47 pct
--   fees_api         87 rows   fba $3.30    referral 12.54 pct
--   live_roi_floor   92 rows   fba $48.07   referral 12.53 pct   <- pesos
--   live_verified     7 rows   fba $36.61   referral 29.79 pct   <- pesos AND
--                                                                   an impossible rate
--
-- ZEROED, NOT CONVERTED. Dividing by today's rate would be a guess: the rate
-- when the row was written is unknown, and $48.07 / 18.33 gives $2.62 against
-- the $4.35 sp_api_live reports for the same marketplace, so the conversion
-- does not land on the trusted figure either. A zero makes the read path fall
-- through -- every consumer tests fba_fee_fixed > 0 -- and the fixed writers
-- repopulate it with a real number. No fee is a better answer than a fee that
-- is ten times wrong.

CREATE TABLE IF NOT EXISTS public.backup_fee_cache_currency_20261014 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);

COMMENT ON TABLE public.backup_fee_cache_currency_20261014 IS
  'Pre-change snapshot of asin_fee_cache rows zeroed on 2026-10-14 because their fba_fee_fixed held a native-currency amount in a USD column, or their referral_rate was outside any rate Amazon charges.';

INSERT INTO public.backup_fee_cache_currency_20261014 (reason, row_data)
SELECT
  CASE WHEN COALESCE(referral_rate, 0) > 0.30 THEN 'impossible_referral_rate'
       ELSE 'native_currency_in_usd_column' END,
  to_jsonb(c)
FROM public.asin_fee_cache c
WHERE c.fee_source IN ('live_roi_floor', 'live_verified')
  AND c.marketplace <> 'US'
  AND (COALESCE(c.fba_fee_fixed, 0) > 0 OR COALESCE(c.referral_rate, 0) > 0.30);

DO $p$
DECLARE r record; n int;
BEGIN
  SELECT count(*) INTO n FROM public.backup_fee_cache_currency_20261014;
  RAISE NOTICE '== BACKUP: % rows saved ==', n;
  FOR r IN SELECT reason, count(*) AS rows FROM public.backup_fee_cache_currency_20261014
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '   % | % rows', rpad(r.reason, 32), r.rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE, by source and marketplace ==';
  FOR r IN
    SELECT fee_source, marketplace AS mk, count(*) AS rows,
           round(avg(fba_fee_fixed)::numeric, 2) AS avg_fba,
           round(max(fba_fee_fixed)::numeric, 2) AS max_fba,
           round(max(referral_rate * 100)::numeric, 2) AS max_ref_pct
    FROM public.asin_fee_cache
    WHERE fee_source IN ('live_roi_floor', 'live_verified') AND marketplace <> 'US'
    GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE '   % | % | % rows | avg $% | max $% | max referral % pct',
      rpad(r.fee_source, 16), rpad(r.mk, 4), lpad(r.rows::text, 4),
      lpad(r.avg_fba::text, 8), lpad(r.max_fba::text, 8), r.max_ref_pct;
  END LOOP;
END
$p$;

UPDATE public.asin_fee_cache
SET fba_fee_fixed = 0,
    referral_rate = CASE WHEN COALESCE(referral_rate, 0) > 0.30 THEN 0 ELSE referral_rate END,
    last_error = 'quarantined 2026-10-14: native currency written to a USD column',
    updated_at = now()
WHERE fee_source IN ('live_roi_floor', 'live_verified')
  AND marketplace <> 'US'
  AND (COALESCE(fba_fee_fixed, 0) > 0 OR COALESCE(referral_rate, 0) > 0.30);

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '== AFTER ==';
  SELECT count(*) INTO n FROM public.asin_fee_cache
  WHERE fee_source IN ('live_roi_floor', 'live_verified') AND marketplace <> 'US'
    AND (COALESCE(fba_fee_fixed, 0) > 0 OR COALESCE(referral_rate, 0) > 0.30);
  RAISE NOTICE '   suspect rows still carrying a fee: % (want 0)', n;

  RAISE NOTICE '';
  RAISE NOTICE '== usable non-US fee coverage, after the quarantine ==';
  FOR r IN
    SELECT marketplace AS mk,
           count(*) FILTER (WHERE fba_fee_fixed > 0) AS with_fba,
           count(*) FILTER (WHERE fba_fee_fixed > 0
                              AND fee_source IN ('sp_api_live', 'fees_api')) AS from_trusted,
           count(*) AS total_rows
    FROM public.asin_fee_cache WHERE user_id = v_uid AND marketplace <> 'US'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % of % rows still carry a fee | % of those from a trusted writer',
      rpad(r.mk, 4), lpad(r.with_fba::text, 4), lpad(r.total_rows::text, 4), r.from_trusted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the accuracy that is left, vs what Amazon billed ==';
  FOR r IN
    WITH billed AS (
      SELECT asin, marketplace, sum(fba_fee) / NULLIF(sum(quantity), 0) AS actual
      FROM public.sales_orders
      WHERE user_id = v_uid AND COALESCE(is_cancelled, false) = false
        AND order_id NOT LIKE '%-REFUND%' AND COALESCE(fba_fee, 0) > 0
        AND upper(COALESCE(fulfillment_channel, '')) LIKE 'AFN%'
      GROUP BY 1, 2
    )
    SELECT b.marketplace AS mk, count(*) AS asins,
           round((percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY fc.fba_fee_fixed / NULLIF(b.actual, 0)))::numeric, 2) AS median_ratio
    FROM billed b
    JOIN public.asin_fee_cache fc ON fc.user_id = v_uid AND fc.asin = b.asin
                               AND fc.marketplace = b.marketplace AND fc.fba_fee_fixed > 0
    GROUP BY 1 ORDER BY asins DESC
  LOOP
    RAISE NOTICE '   % | % ASINs | cached/billed median % (1.00 is exact)',
      rpad(r.mk, 4), lpad(r.asins::text, 6), r.median_ratio;
  END LOOP;
END
$p$;
