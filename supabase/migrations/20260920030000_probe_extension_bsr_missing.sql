-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Extension analyser shows BSR "—" and Est/mo "—" on some products. Both come
-- from mobile-scan-price-stability's `intel` (BSR is Keepa stats.current[3];
-- Est/mo falls back to a BSR curve), so they blank together whenever that call
-- returns emptyPayload -- Keepa refused, timed out, or the gate had no tokens
-- -- or when Keepa answered without a sales rank.
-- Quantify which it is from the cache table and the Keepa usage rows.

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT count(*) AS rows,
                  count(*) FILTER (WHERE (raw->>'sales_estimate_version') = '3') AS v3,
                  count(*) FILTER (WHERE raw->'intel'->>'bsr_current' IS NOT NULL) AS with_bsr,
                  count(*) FILTER (WHERE raw->'intel' IS NOT NULL AND raw->'intel'->>'bsr_current' IS NULL) AS intel_without_bsr,
                  count(*) FILTER (WHERE raw->'intel'->>'est_monthly_sales' IS NOT NULL) AS with_est,
                  count(*) FILTER (WHERE expires_at > now()) AS unexpired
           FROM public.keepa_price_stability_cache LOOP
    RAISE NOTICE 'stability cache: % rows | version 3 % | with BSR % | intel but no BSR % | with Est/mo % | unexpired %',
      r.rows, r.v3, r.with_bsr, r.intel_without_bsr, r.with_est, r.unexpired;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== cached products with intel but no BSR (Keepa had no rank) ==';
  FOR r IN SELECT asin, marketplace, raw->'intel'->>'est_monthly_sales' AS est, raw->'intel'->>'monthly_sold' AS sold,
                  drops_90, series_used, to_char(fetched_at, 'MM-DD HH24:MI') AS fetched
           FROM public.keepa_price_stability_cache
           WHERE raw->'intel' IS NOT NULL AND raw->'intel'->>'bsr_current' IS NULL
           ORDER BY fetched_at DESC LIMIT 10 LOOP
    RAISE NOTICE '  % % | est % | monthly_sold % | drops90 % | series % | %', r.asin, r.marketplace, r.est, r.sold, r.drops_90, r.series_used, r.fetched;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== Keepa budget pressure (what makes the gate refuse) ==';
  FOR r IN SELECT * FROM public.keepa_daily_usage ORDER BY 1 DESC LIMIT 3 LOOP
    RAISE NOTICE '  %', to_jsonb(r);
  END LOOP;
END
$p$;
