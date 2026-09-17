-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- Analyser shows no price history / no graph for B0B2GHCDP5, private-label
-- risk "Not enough data", yet an active "Private-Label Risk" alert. The
-- seller's Keepa extension shows a full graph, so Keepa has the data.
-- mobile-scan-price-history degrades to SP-API-only (no series) when the Keepa
-- budget is busy or exhausted. What does the cache hold, and what is the
-- budget doing?

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '======== keepa_price_history_cache for B0B2GHCDP5 ========';
  FOR r IN SELECT to_jsonb(c) AS j FROM public.keepa_price_history_cache c WHERE c.asin = 'B0B2GHCDP5' LOOP
    RAISE NOTICE '  mkt=% days=% fetched=% expires=%', r.j->>'marketplace', r.j->>'days_range', r.j->>'fetched_at', r.j->>'expires_at';
    RAISE NOTICE '    series keys: %', (SELECT string_agg(k || '(' || COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(r.j->'series'->k)='array' THEN r.j->'series'->k END),-1) || ')', ' ') FROM jsonb_object_keys(COALESCE(r.j->'series','{}'::jsonb)) k);
    RAISE NOTICE '    sellerHistory: %', left((r.j->'series'->'sellerHistory')::text, 200);
    RAISE NOTICE '    buyBoxOwnership: %', left((r.j->'series'->'buyBoxOwnership')::text, 200);
    RAISE NOTICE '    offers count: %', r.j->'offers'->>'count';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== keepa_daily_usage (latest rows) ========';
  FOR r IN SELECT to_jsonb(u) AS j FROM public.keepa_daily_usage u ORDER BY 1 DESC LIMIT 3 LOOP
    RAISE NOTICE '  %', left(r.j::text, 600);
  END LOOP;
END
$p$;
