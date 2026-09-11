-- PROBE (read-only): how many units of B0G4B3117X went out through Shipment
-- Builder?
--
-- The seller's point: these purchases should have been captured when the stock
-- was shipped in. shipment_builder_drafts stores its contents in a JSONB
-- payload whose shape is not documented here, so this prints the matching
-- objects and their numeric fields BEFORE summing anything -- guessing a
-- quantity key and reporting the total would be worse than reporting nothing.
--
-- Cross-checked against fba_shipment_items, which for this ASIN holds 745
-- shipped / 525 received across 52 lines, with sync-time created_at rather
-- than real dates.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM'; v_n int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== 1. drafts mentioning this ASIN or SKU at all ========';
  FOR r IN
    SELECT count(*) AS drafts,
           count(*) FILTER (WHERE amazon_shipment_id IS NOT NULL) AS with_amazon_id,
           count(*) FILTER (WHERE continued_to_amazon_at IS NOT NULL) AS continued,
           min(created_at)::date AS first_draft, max(created_at)::date AS last_draft
    FROM public.shipment_builder_drafts
    WHERE user_id = v_uid
      AND (payload::text LIKE '%' || v_asin || '%' OR payload::text LIKE '%' || v_sku || '%')
  LOOP
    RAISE NOTICE '   % drafts (% with an Amazon shipment id, % continued to Amazon)',
      r.drafts, r.with_amazon_id, r.continued;
    RAISE NOTICE '   dated % .. %', r.first_draft, r.last_draft;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 2. by status ========';
  FOR r IN
    SELECT status, count(*) AS n, min(created_at)::date AS first_at, max(created_at)::date AS last_at
    FROM public.shipment_builder_drafts
    WHERE user_id = v_uid
      AND (payload::text LIKE '%' || v_asin || '%' OR payload::text LIKE '%' || v_sku || '%')
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   status=%  % drafts  (% .. %)', rpad(r.status,14), r.n, r.first_at, r.last_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 3. the matching line objects, so the shape is visible ========';
  FOR r IN
    SELECT d.draft_id, d.status, d.created_at::date AS day,
           left(regexp_replace(obj::text, '\s+', ' ', 'g'), 320) AS line
    FROM public.shipment_builder_drafts d
    CROSS JOIN LATERAL jsonb_path_query(
      d.payload,
      '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
      jsonb_build_object('a', v_asin, 's', v_sku)
    ) AS obj
    WHERE d.user_id = v_uid
    ORDER BY d.created_at DESC LIMIT 12
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % % %', r.day, rpad(left(r.draft_id,18),18), r.line;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no JSON object matched on asin/sku keys -- payload nests them differently';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== 4. candidate quantity keys found on those objects ========';
  FOR r IN
    SELECT k AS key_name, count(*) AS times_seen,
           sum(CASE WHEN jsonb_typeof(v) = 'number' THEN (v#>>'{}')::numeric ELSE 0 END) AS summed
    FROM public.shipment_builder_drafts d
    CROSS JOIN LATERAL jsonb_path_query(
      d.payload,
      '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
      jsonb_build_object('a', v_asin, 's', v_sku)
    ) AS obj
    CROSS JOIN LATERAL jsonb_each(obj) AS e(k, v)
    WHERE d.user_id = v_uid
      AND (k ILIKE '%quantity%' OR k ILIKE '%qty%' OR k ILIKE '%unit%' OR k ILIKE '%count%'
        OR k ILIKE '%cases%' OR k ILIKE '%pack%')
    GROUP BY k ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '   %  seen % times, values sum to %', rpad(r.key_name,26), r.times_seen, r.summed;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== 5. Amazon''s own record for this ASIN, for comparison ========';
  FOR r IN
    SELECT count(*) AS lines_n,
           sum(COALESCE(quantity_shipped,0)) AS shipped,
           sum(COALESCE(quantity_received,0)) AS received,
           count(DISTINCT shipment_id) AS shipments
    FROM public.fba_shipment_items
    WHERE user_id = v_uid AND (asin = v_asin OR seller_sku = v_sku)
  LOOP
    RAISE NOTICE '   fba_shipment_items: % lines across % shipments, shipped %, received %',
      r.lines_n, r.shipments, r.shipped, r.received;
  END LOOP;
  RAISE NOTICE '   for reference: purchases recorded 1,254 | sold 1,250 | on hand 312';
END
$probe$;