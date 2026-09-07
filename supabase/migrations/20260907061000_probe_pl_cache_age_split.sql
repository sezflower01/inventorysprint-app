-- PROBE (read-only): are the 2,598 cache rows without PL data simply OLDER
-- than the change that started collecting it?
--
-- The correlation is exact: 1,644 rows carry sellerHistory, 1,644 carry
-- buyBoxOwnership, and 1,644 carry both. Never one without the other. Genuine
-- per-product availability would not line up like that -- the two come from
-- different Keepa fields (csv[COUNT_NEW] versus buyBoxSellerIdHistory), so
-- some products should have one and not the other. Perfect correlation means
-- they are written together or not at all, which makes it a property of WHEN
-- the row was fetched rather than of the product.
--
-- If the rows without the data are all older than a cutoff, the fix is simply
-- to refetch -- nothing is broken, the cache is just stale. If they are
-- interleaved with recent rows, something else is dropping the fields.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== fetched_at range, with PL data vs without ========';
  FOR r IN
    SELECT (series -> 'buyBoxOwnership' IS NOT NULL) AS has_pl,
           count(*) AS rows,
           min(fetched_at) AS earliest,
           max(fetched_at) AS latest
    FROM public.keepa_price_history_cache
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   has_pl=%-5s : % rows | % .. %', r.has_pl, r.rows, r.earliest, r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== by day, last 14 days ========';
  FOR r IN
    SELECT fetched_at::date AS d,
           count(*) AS rows,
           count(*) FILTER (WHERE series -> 'buyBoxOwnership' IS NOT NULL) AS with_pl
    FROM public.keepa_price_history_cache
    WHERE fetched_at > now() - interval '14 days'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % : % rows, % with PL data', r.d, r.rows, r.with_pl;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== does days_range explain it? ========';
  -- The PL series carry a windowDays and are derived only for certain ranges;
  -- if every row lacking them shares a days_range, that is the real gate.
  FOR r IN
    SELECT days_range, count(*) AS rows,
           count(*) FILTER (WHERE series -> 'buyBoxOwnership' IS NOT NULL) AS with_pl
    FROM public.keepa_price_history_cache
    GROUP BY 1 ORDER BY rows DESC LIMIT 10
  LOOP
    RAISE NOTICE '   days_range=%-6s : % rows, % with PL data', r.days_range, r.rows, r.with_pl;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many are already expired? ========';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE expires_at < now()) AS expired,
           count(*) FILTER (WHERE expires_at >= now()) AS live
    FROM public.keepa_price_history_cache
  LOOP
    RAISE NOTICE '   % rows | % expired | % still live', r.total, r.expired, r.live;
    RAISE NOTICE '   (an expired row is refetched on next view, so stale rows self-heal)';
  END LOOP;
END
$probe$;
