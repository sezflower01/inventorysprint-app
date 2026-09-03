-- Read-only probe: scope of the brand backfill with a 1,000-ASIN-per-seller
-- cap. Writes nothing.

SET statement_timeout TO '600s';

DO $$
DECLARE
  v_uncapped bigint; v_capped bigint; v_affected bigint; v_unaffected bigint;
  v_known bigint; v_todo bigint;
  r RECORD;
BEGIN
  SELECT COALESCE(sum(n),0), COALESCE(sum(LEAST(n, 1000)),0),
         count(*) FILTER (WHERE n > 1000), count(*) FILTER (WHERE n <= 1000)
    INTO v_uncapped, v_capped, v_affected, v_unaffected
  FROM (SELECT jsonb_array_length(known_asin_list) AS n
        FROM public.seller_watchlist
        WHERE jsonb_typeof(known_asin_list) = 'array') s;

  RAISE NOTICE 'uncapped slots=% | CAPPED AT 1000/seller=% (%.1f%% of the work)',
    v_uncapped, v_capped, (100.0 * v_capped / GREATEST(v_uncapped,1));
  RAISE NOTICE 'sellers UNAFFECTED by the cap=% | sellers truncated by it=%',
    v_unaffected, v_affected;

  -- Distinct, because the same ASIN under two sellers is one lookup.
  CREATE TEMP TABLE _capped AS
  SELECT DISTINCT a.asin FROM public.seller_watchlist w
  CROSS JOIN LATERAL (
    SELECT e AS asin FROM jsonb_array_elements_text(w.known_asin_list) WITH ORDINALITY t(e, ord)
    WHERE t.ord <= 1000
  ) a
  WHERE jsonb_typeof(w.known_asin_list) = 'array';

  SELECT count(*) INTO v_capped FROM _capped;
  SELECT count(*) INTO v_known FROM _capped p
   WHERE EXISTS (SELECT 1 FROM public.seller_watch_new_listings l
                  WHERE l.asin = p.asin AND l.brand IS NOT NULL AND btrim(l.brand) <> '')
      OR EXISTS (SELECT 1 FROM public.inventory i
                  WHERE i.asin = p.asin AND i.brand IS NOT NULL AND btrim(i.brand) <> '');
  v_todo := v_capped - v_known;

  RAISE NOTICE 'DISTINCT ASINs under the cap=% | already known=% | TO LOOK UP=%',
    v_capped, v_known, v_todo;
  RAISE NOTICE 'calls at 20/batch=% | at 2 req/s=% hours | at 1 req/s (yielding)=% hours',
    ceil(v_todo / 20.0),
    round((v_todo / 40.0 / 3600.0)::numeric, 1),
    round((v_todo / 20.0 / 3600.0)::numeric, 1);

  -- What the cap costs the sellers it actually bites.
  FOR r IN
    SELECT seller_id, jsonb_array_length(known_asin_list) AS n
    FROM public.seller_watchlist
    WHERE jsonb_typeof(known_asin_list) = 'array'
      AND jsonb_array_length(known_asin_list) > 1000
    ORDER BY jsonb_array_length(known_asin_list) DESC LIMIT 8
  LOOP
    RAISE NOTICE '  seller %: % items -> we would see 1000 (%.1f%% of their catalogue)',
      r.seller_id, r.n, (100.0 * 1000 / r.n);
  END LOOP;

  DROP TABLE _capped;
END $$;
