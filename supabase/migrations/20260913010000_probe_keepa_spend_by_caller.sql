-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- The extension analyser got Keepa's own HTTP 429 with tokensLeft -46 at
-- 2026-09-13 02:24 UTC. That is Keepa refusing, not our gate -- so something
-- spent past the balance. The seller believes the Seller Analyzer is the
-- overspender. This measures instead of assuming.
--
-- There is no per-caller token ledger: keepa_token_budget is one shared row
-- and recordKeepa429 names the caller only in function logs. So spend is
-- reconstructed from what each caller leaves behind -- a cache row or a
-- captured timestamp per Keepa call -- multiplied by its measured cost
-- (KEEPA_COST in _shared/keepa-rate-gate.ts).
--
-- Cache tables UPSERT on a key, so a key refreshed twice in the window counts
-- once. Every figure here is therefore a FLOOR on that caller's spend.
--
-- Three callers report tokensLeft but never CLAIM before calling, and so are
-- invisible to the gate until after they have spent: keepa-historical-price,
-- import-amazon-categories, and repricer-sp-api-pricing. Their footprints are
-- included for that reason.

DO $probe$
DECLARE
  r record;
  v_col text;
  v_24 bigint;
  v_3 bigint;
  v_1 bigint;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. the shared budget rows ========';
  BEGIN
    FOR r IN SELECT to_jsonb(t) AS j FROM public.keepa_token_budget t LOOP
      RAISE NOTICE '  keepa_token_budget: %', r.j;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  keepa_token_budget unreadable: %', SQLERRM; END;
  BEGIN
    FOR r IN SELECT to_jsonb(t) AS j FROM public.keepa_daily_usage t
             ORDER BY (to_jsonb(t) ->> 'usage_date') DESC NULLS LAST LIMIT 2 LOOP
      RAISE NOTICE '  keepa_daily_usage: %', left(r.j::text, 600);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  keepa_daily_usage unreadable: %', SQLERRM; END;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. check-seller-watchlist (Seller Analyzer monitoring) ========';
  BEGIN
    FOR r IN
      SELECT count(*) AS runs,
             sum(COALESCE((detail ->> 'checked')::int, items_processed, 0)) AS checked,
             sum(COALESCE((detail ->> 'seeded')::int, 0)) AS seeded,
             sum(COALESCE((detail ->> 'alertsFired')::int, 0)) AS alerts
      FROM public.cron_run_history
      WHERE job_name ILIKE '%seller-watchlist%'
        AND started_at > now() - interval '24 hours'
    LOOP
      RAISE NOTICE '  24h: % runs, % storefront checks (x10 = % tokens), % seeded, % alerts',
        r.runs, r.checked, r.checked * 10, r.seeded, r.alerts;
    END LOOP;
    FOR r IN
      SELECT COALESCE(detail ->> 'stoppedReason', '(none)') AS why, count(*) AS n
      FROM public.cron_run_history
      WHERE job_name ILIKE '%seller-watchlist%'
        AND started_at > now() - interval '24 hours'
      GROUP BY 1 ORDER BY n DESC
    LOOP
      RAISE NOTICE '    stoppedReason % x%', rpad(r.why, 28), r.n;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  cron_run_history unreadable: %', SQLERRM; END;

  -- Price capture: one /product?offers=20 call per (watch, captured_at).
  BEGIN
    FOR r IN
      WITH calls AS (
        SELECT watch_id, price_captured_at, count(*) AS asins
        FROM public.seller_watch_new_listings
        WHERE price_captured_at > now() - interval '24 hours'
        GROUP BY watch_id, price_captured_at
      )
      SELECT count(*) AS n_calls, COALESCE(sum(asins), 0) AS n_asins,
             COALESCE(max(asins), 0) AS biggest,
             count(*) FILTER (WHERE asins >= 20) AS big_calls
      FROM calls
    LOOP
      RAISE NOTICE '  price capture 24h: % calls, % ASINs (x6 = % tokens), biggest single call % ASINs (% tokens), calls >= 20 ASINs: %',
        r.n_calls, r.n_asins, r.n_asins * 6, r.biggest, r.biggest * 6, r.big_calls;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  price capture unreadable: %', SQLERRM; END;

  BEGIN
    FOR r IN
      SELECT count(*) AS detected FROM public.seller_watch_new_listings
      WHERE detected_at > now() - interval '24 hours'
    LOOP
      RAISE NOTICE '  new listings detected 24h: % (detail lookups go to SP-API first; Keepa only for the remainder)', r.detected;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  detections unreadable: %', SQLERRM; END;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. every other Keepa caller, by cache footprint ========';
  RAISE NOTICE '  table                              caller                          24h    3h    1h  ts column';
  FOR r IN
    SELECT * FROM (VALUES
      ('keepa_price_history_cache',     'extension analyser (price hist)', 5),
      ('keepa_price_stability_cache',   'extension price stability',       0),
      ('product_analyzer_snapshot_cache','product analyzer page',          5),
      ('keepa_seller_name_cache',       'seller-name lookups',             1),
      ('seller_storefront_cache',       'Seller Analyzer storefront view', 10),
      ('seller_storefront_page_cache',  'Seller Analyzer storefront pages', 0),
      ('asin_dimensions_cache',         'asin-dimensions',                 1),
      ('keepa_products',                'keepa-product-finder',            0),
      ('keepa_price_cache',             'keepa-historical-price UNGATED',  0),
      ('price_alerts',                  'check-price-alerts',              0),
      ('amazon_categories',             'import-amazon-categories UNGATED',0)
    ) AS t(tbl, caller, cost)
  LOOP
    v_col := NULL;
    SELECT c.column_name INTO v_col
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = r.tbl
      AND c.column_name IN ('fetched_at', 'last_checked_at', 'cached_at', 'captured_at',
                            'refreshed_at', 'updated_at', 'created_at')
    ORDER BY array_position(ARRAY['fetched_at', 'last_checked_at', 'cached_at', 'captured_at',
                                  'refreshed_at', 'updated_at', 'created_at'], c.column_name)
    LIMIT 1;

    IF v_col IS NULL THEN
      RAISE NOTICE '  % % (absent or no timestamp column)', rpad(r.tbl, 34), rpad(r.caller, 32);
      CONTINUE;
    END IF;

    BEGIN
      EXECUTE format(
        'SELECT count(*) FILTER (WHERE %1$I > now() - interval ''24 hours''),
                count(*) FILTER (WHERE %1$I > now() - interval ''3 hours''),
                count(*) FILTER (WHERE %1$I > now() - interval ''1 hour'')
         FROM public.%2$I', v_col, r.tbl)
      INTO v_24, v_3, v_1;
      RAISE NOTICE '  % % % % %  %',
        rpad(r.tbl, 34), rpad(r.caller, 32), lpad(v_24::text, 5), lpad(v_3::text, 5),
        lpad(v_1::text, 5), v_col
        || CASE WHEN r.cost > 0 THEN format('  (~%s tokens/24h at %s each)', v_24 * r.cost, r.cost) ELSE '' END;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '  % % unreadable: %', rpad(r.tbl, 34), rpad(r.caller, 32), SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. hour by hour, last 12h: watchlist vs price capture vs analyser ========';
  BEGIN
    FOR r IN
      WITH hours AS (
        SELECT generate_series(date_trunc('hour', now()) - interval '11 hours',
                               date_trunc('hour', now()), interval '1 hour') AS h
      )
      SELECT h.h,
        (SELECT COALESCE(sum(COALESCE((c.detail ->> 'checked')::int, c.items_processed, 0)), 0)
           FROM public.cron_run_history c
          WHERE c.job_name ILIKE '%seller-watchlist%'
            AND c.started_at >= h.h AND c.started_at < h.h + interval '1 hour') AS storefronts,
        (SELECT count(*) FROM public.seller_watch_new_listings l
          WHERE l.price_captured_at >= h.h AND l.price_captured_at < h.h + interval '1 hour') AS priced
      FROM hours h ORDER BY h.h
    LOOP
      RAISE NOTICE '  % UTC  watchlist storefronts=% (~% tk)  price-captured ASINs=% (~% tk)  total ~% tk vs 1500/h refill',
        to_char(r.h AT TIME ZONE 'UTC', 'MM-DD HH24:00'),
        lpad(r.storefronts::text, 4), lpad((r.storefronts * 10)::text, 5),
        lpad(r.priced::text, 4), lpad((r.priced * 6)::text, 5),
        lpad((r.storefronts * 10 + r.priced * 6)::text, 5);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  hourly unreadable: %', SQLERRM; END;
END
$probe$;
