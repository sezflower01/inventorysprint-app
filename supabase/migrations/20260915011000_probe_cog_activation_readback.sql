-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- 20260915010000 switched COG on Record on. Two of its checks need explaining
-- before anything else is done:
--
--   * "B0G4BQ42W3 (no COG yet): 983 rows on COG (must be 0)". The activation
--     only re-prices products whose unit_cost IS NOT NULL, so this is only
--     possible if B0G4BQ42W3 had a COG by the time it ran -- i.e. the seller
--     set it on the page, which went live in 9409dea before the history log
--     existed. The check's label assumed the import state.
--   * B0G4B3117X re-priced at $10.00, not the imported $13.00 -- the same
--     explanation, if the seller edited it too.
--
-- Also: that migration's BEFORE total omitted its 2026 filter (it summed all
-- years), so its before/after line is not a like-for-like comparison. The
-- backup table holds the exact prior cost of every re-priced row; this compares
-- against it properly.

DO $probe$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== COGs edited on the page (source = manual) ========';
  FOR r IN
    SELECT asin, unit_cost, calculated_cost, needs_review, created_at, updated_at, left(COALESCE(title, ''), 50) AS t
    FROM public.asin_cog_on_record
    WHERE user_id = v_uid AND (source = 'manual' OR updated_at > created_at + interval '1 second')
    ORDER BY updated_at
  LOOP
    RAISE NOTICE '  % cog=% (import calculated %) review=% edited % | %',
      r.asin, r.unit_cost, COALESCE(r.calculated_cost::text, '-'), r.needs_review, r.updated_at, r.t;
  END LOOP;
  FOR r IN
    SELECT count(*) FILTER (WHERE source = 'manual') AS manual,
           count(*) FILTER (WHERE source = 'manual' AND calculated_cost IS NULL) AS added,
           count(*) FILTER (WHERE unit_cost IS NULL) AS unset
    FROM public.asin_cog_on_record WHERE user_id = v_uid
  LOOP
    RAISE NOTICE '  manual rows: % (of which added by hand, no import value: %) | rows with no COG: %',
      r.manual, r.added, r.unset;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2026 COGS before vs after, same rows (from the backup) ========';
  FOR r IN
    SELECT CASE WHEN s.order_id LIKE '%-REFUND' THEN 'refund'
                WHEN COALESCE(s.order_status, '') IN ('Canceled', 'Cancelled') THEN 'cancelled'
                ELSE 'sale' END AS kind,
           count(*) AS n,
           round(sum(b.total_cost), 2) AS before_cost,
           round(sum(s.total_cost), 2) AS after_cost,
           round(sum(s.total_cost) - sum(b.total_cost), 2) AS delta
    FROM public.sales_cost_backup_cog_activation b
    JOIN public.sales_orders s ON s.id::text = b.sales_order_id
    WHERE b.user_id = v_uid
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % rows=% before $% after $% change $%', rpad(r.kind, 10), r.n, r.before_cost, r.after_cost, r.delta;
  END LOOP;

  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date), 'YYYY-MM') AS mon,
           round(sum(b.total_cost), 2) AS before_cost, round(sum(s.total_cost), 2) AS after_cost
    FROM public.sales_cost_backup_cog_activation b
    JOIN public.sales_orders s ON s.id::text = b.sales_order_id
    WHERE b.user_id = v_uid AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  % sales COGS $% -> $% (change $%)', r.mon, r.before_cost, r.after_cost, round(r.after_cost - r.before_cost, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== biggest movers (sales only) ========';
  FOR r IN
    SELECT s.asin, count(*) AS n, round(sum(b.total_cost), 2) AS before_cost, round(sum(s.total_cost), 2) AS after_cost,
           max(c.unit_cost) AS cog, max(c.source) AS src
    FROM public.sales_cost_backup_cog_activation b
    JOIN public.sales_orders s ON s.id::text = b.sales_order_id
    JOIN public.asin_cog_on_record c ON c.user_id = s.user_id AND c.asin = s.asin
    WHERE b.user_id = v_uid AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
    GROUP BY s.asin
    ORDER BY abs(sum(s.total_cost) - sum(b.total_cost)) DESC LIMIT 8
  LOOP
    RAISE NOTICE '  % rows=% COGS $% -> $% (change $%) cog=$% %',
      r.asin, r.n, r.before_cost, r.after_cost, round(r.after_cost - r.before_cost, 2), r.cog, r.src;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== rule still holding after live sync traffic? ========';
  FOR r IN
    SELECT count(*) AS mismatched, max(s.updated_at) AS latest_write
    FROM public.sales_orders s
    JOIN public.asin_cog_on_record c ON c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND (s.unit_cost IS DISTINCT FROM c.unit_cost
           OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2))
  LOOP
    RAISE NOTICE '  2026 sales not matching their COG: % (must be 0)', r.mismatched;
  END LOOP;
  FOR r IN
    SELECT count(*) AS n FROM public.sales_orders
    WHERE user_id = v_uid AND order_date >= '2026-01-01' AND updated_at > now() - interval '30 minutes'
      AND cost_source_at_sale = 'cog_on_record'
  LOOP
    RAISE NOTICE '  2026 sales written in the last 30 min that are on COG: %', r.n;
  END LOOP;
END
$probe$;
