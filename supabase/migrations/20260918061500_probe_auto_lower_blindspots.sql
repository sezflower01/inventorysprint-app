-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- For each skip in the latest auto-lower-min dry run, does the data the worker
-- says is missing actually exist?
--   no_inventory_row    -> is there an inventory row for (user, sku)?
--   no_competitor_data  -> is there a US snapshot for the ASIN (24 h / 7 d)?
-- Plus: how many rows do the worker's two single-request loads really match
-- (PostgREST returns at most 1,000 whatever .limit() says)?

DO $p$
DECLARE v_uid uuid; r record; v jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT content::jsonb INTO v FROM net._http_response
  WHERE content LIKE '%"dry_run":true%' AND created > now() - interval '15 minutes'
  ORDER BY created DESC LIMIT 1;
  IF v IS NULL THEN RAISE NOTICE 'dry run not answered yet'; RETURN; END IF;
  RAISE NOTICE 'dry run: considered % would_lower % skips %', v->'detail'->>'considered', v->'detail'->>'would_lower', v->'detail'->'skip_reasons';

  CREATE TEMP TABLE _d AS
  SELECT d->>'assignment_id' AS assignment_id, d->>'asin' AS asin, d->>'reason' AS reason
  FROM jsonb_array_elements(v->'detail'->'decisions') d;

  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inventory i WHERE i.user_id = a.user_id AND i.sku = a.sku)) AS inv_exists
    FROM _d JOIN public.repricer_assignments a ON a.id::text = _d.assignment_id
    WHERE _d.reason = 'no_inventory_row'
  LOOP
    RAISE NOTICE 'no_inventory_row: % skipped, of which an inventory row DOES exist for the sku: %', r.n, r.inv_exists;
  END LOOP;

  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.repricer_competitor_snapshots s WHERE s.asin = _d.asin AND s.marketplace = 'US' AND s.fetched_at > now() - interval '24 hours')) AS snap_24h,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.repricer_competitor_snapshots s WHERE s.asin = _d.asin AND s.marketplace = 'US' AND s.fetched_at > now() - interval '7 days')) AS snap_7d
    FROM _d WHERE _d.reason = 'no_competitor_data'
  LOOP
    RAISE NOTICE 'no_competitor_data: % skipped, of which a US snapshot exists within 24 h: %, within 7 days: %', r.n, r.snap_24h, r.snap_7d;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN
    WITH a AS (SELECT DISTINCT user_id, sku, asin FROM public.repricer_assignments
               WHERE user_id = v_uid AND auto_lower_min_price AND is_enabled AND status = 'active' AND marketplace = 'US' AND rule_id IS NOT NULL)
    SELECT (SELECT count(*) FROM public.inventory i WHERE i.user_id = v_uid AND i.sku IN (SELECT sku FROM a)) AS inv_rows_matching,
           (SELECT count(DISTINCT sku) FROM a) AS skus,
           (SELECT count(*) FROM public.repricer_competitor_snapshots s WHERE s.marketplace = 'US' AND s.asin IN (SELECT asin FROM a)) AS snap_rows_matching
  LOOP
    RAISE NOTICE 'worker loads: inventory rows matching its % SKUs = % | snapshot rows matching its ASINs = % (each capped at 1,000 per request)',
      r.skus, r.inv_rows_matching, r.snap_rows_matching;
  END LOOP;

  DROP TABLE _d;
END
$p$;
