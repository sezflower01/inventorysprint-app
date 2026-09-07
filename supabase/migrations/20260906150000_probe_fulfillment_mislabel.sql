-- PROBE (read-only): are FBA listings being labelled FBM?
--
-- AssignmentsTable derives the badge through a five-step cascade:
--   1. HARD FBA  -> fnsku present, OR reserved+inbound > 0, OR source is FBA-ish
--   2. HARD FBM  -> source is amazon_sync_fbm AND no fnsku AND reserved+inbound = 0
--   3. the stored repricer_assignments.fulfillment_type
--   4. source contains 'fbm'
--   5. fallback: available+reserved+inbound > 0 OR buybox_is_fba -> FBA else FBM
--
-- Note what step 1 does NOT count: `available`. An FBA row sitting in stock with
-- zero reserved and zero inbound, no FNSKU and an unrecognised source falls
-- straight past step 1 -- and if the stored value at step 3 says FBM, that is
-- what wins, even though step 5 would have said FBA from available alone.
--
-- This measures which step is actually deciding, and whether the underlying
-- inventory rows really look FBA.
--
-- It matters beyond a badge: repricer-ai-evaluate branches on own fulfilment
-- (effectiveOwnFulfillment === 'FBM') and has a separate fbm_undercut_amount
-- path, so a wrong label can route pricing down the wrong branch entirely.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE '======== stored fulfillment_type on assignments ========';
  FOR r IN
    SELECT COALESCE(fulfillment_type, '(null)') AS ft, count(*) AS n,
           count(*) FILTER (WHERE is_enabled) AS enabled
    FROM public.repricer_assignments GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   %-8s : % assignments (% enabled)', r.ft, r.n, r.enabled;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== what does inventory say about those SKUs? ========';
  FOR r IN
    SELECT COALESCE(a.fulfillment_type,'(null)') AS stored,
           count(*) AS rows,
           count(*) FILTER (WHERE i.fnsku IS NOT NULL AND btrim(i.fnsku) <> '') AS has_fnsku,
           count(*) FILTER (WHERE COALESCE(i.reserved,0) + COALESCE(i.inbound,0) > 0) AS has_reserved_inbound,
           count(*) FILTER (WHERE COALESCE(i.available,0) > 0) AS has_available,
           count(*) FILTER (WHERE lower(COALESCE(i.source,'')) = 'amazon_sync') AS src_amazon_sync,
           count(*) FILTER (WHERE lower(COALESCE(i.source,'')) = 'amazon_sync_fbm') AS src_fbm
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.is_enabled
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   stored=%-7s | % rows | fnsku % | reserved/inbound % | available % | src amazon_sync % | src fbm %',
      r.stored, r.rows, r.has_fnsku, r.has_reserved_inbound, r.has_available,
      r.src_amazon_sync, r.src_fbm;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the source values actually present ========';
  FOR r IN
    SELECT COALESCE(i.source,'(null)') AS src, count(*) AS n,
           count(*) FILTER (WHERE i.fnsku IS NOT NULL AND btrim(i.fnsku) <> '') AS with_fnsku
    FROM public.inventory i
    WHERE EXISTS (SELECT 1 FROM public.repricer_assignments a
                   WHERE a.user_id = i.user_id AND a.sku = i.sku AND a.is_enabled)
    GROUP BY 1 ORDER BY n DESC LIMIT 12
  LOOP
    RAISE NOTICE '   %-24s : % rows (% with fnsku)', r.src, r.n, r.with_fnsku;
  END LOOP;

  -- The specific ASINs from the screen, so the abstraction is checkable.
  RAISE NOTICE '';
  RAISE NOTICE '======== the ASINs shown as FBM on screen ========';
  FOR r IN
    SELECT a.asin, a.sku,
           COALESCE(a.fulfillment_type,'(null)') AS stored,
           COALESCE(i.source,'(null)') AS src,
           CASE WHEN i.fnsku IS NOT NULL AND btrim(i.fnsku) <> '' THEN 'yes' ELSE 'no' END AS fnsku,
           COALESCE(i.available,0) AS avail,
           COALESCE(i.reserved,0)  AS reserved,
           COALESCE(i.inbound,0)   AS inbound,
           COALESCE(i.listing_status,'(null)') AS status
    FROM public.repricer_assignments a
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.asin IN ('B0GN9MX14H','B0863C1KVV','B0987XSSB6','B0F6KKKNJ6','B0GDSMS2BK',
                     'B01797D8BY','B004AGM25Q','B001GQ2DBG')
      AND a.marketplace = 'US'
    ORDER BY a.asin
  LOOP
    RAISE NOTICE '   % sku=%-24s stored=%-6s src=%-18s fnsku=%-3s avail=% res=% inb=% status=%',
      r.asin, left(r.sku,24), r.stored, left(r.src,18), r.fnsku, r.avail, r.reserved, r.inbound, r.status;
  END LOOP;
END
$probe$;
