-- PROBE (read-only): units of B0G4B3117X sent via Shipment Builder, deduplicated.
--
-- The naive sums from 20260911070000 are unusable and must not be quoted:
--   qtyToShip summed 3,460 over 52 matches
--   quantity  summed 3,020 over 46 matches
-- because the payload repeats each line WITHIN a draft (the builder's own item
-- list, plus the Amazon inbound-plan copy of the same line), and because the 26
-- drafts are largely successive saves of the same physical shipments rather
-- than 26 separate ones.
--
-- So: one figure per draft, then collapse drafts that became the same Amazon
-- shipment or inbound plan. Distinct values per draft are printed too, so a
-- draft that genuinely holds two different lines of this SKU is visible rather
-- than silently flattened.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== per draft: one quantity, plus every distinct value seen ========';
  FOR r IN
    WITH lines AS (
      SELECT d.draft_id, d.status, d.created_at, d.amazon_shipment_id, d.inbound_plan_id,
             COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric) AS qty
      FROM public.shipment_builder_drafts d
      CROSS JOIN LATERAL jsonb_path_query(
        d.payload,
        '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
        jsonb_build_object('a', v_asin, 's', v_sku)
      ) AS obj
      WHERE d.user_id = v_uid
    )
    SELECT draft_id, status, created_at::date AS day,
           COALESCE(amazon_shipment_id, '-') AS amz,
           COALESCE(inbound_plan_id, '-') AS plan,
           max(qty) AS qty_max,
           string_agg(DISTINCT qty::text, '/' ORDER BY qty::text) AS distinct_values,
           count(*) AS matches
    FROM lines WHERE qty IS NOT NULL
    GROUP BY draft_id, status, created_at, amazon_shipment_id, inbound_plan_id
    ORDER BY created_at
  LOOP
    RAISE NOTICE '   % % qty=% (seen % times, values %) amz=% plan=%',
      r.day, rpad(left(r.status,9),9), r.qty_max, r.matches, r.distinct_values,
      left(r.amz,18), left(r.plan,18);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== totals, three ways ========';
  FOR r IN
    WITH lines AS (
      SELECT d.draft_id, d.status, d.created_at, d.amazon_shipment_id, d.inbound_plan_id,
             COALESCE((obj->>'qtyToShip')::numeric, (obj->>'quantity')::numeric) AS qty
      FROM public.shipment_builder_drafts d
      CROSS JOIN LATERAL jsonb_path_query(
        d.payload,
        '$.** ? (@.asin == $a || @.sku == $s || @.seller_sku == $s || @.sellerSku == $s)',
        jsonb_build_object('a', v_asin, 's', v_sku)
      ) AS obj
      WHERE d.user_id = v_uid
    ),
    per_draft AS (
      SELECT draft_id, status, created_at, amazon_shipment_id, inbound_plan_id, max(qty) AS qty
      FROM lines WHERE qty IS NOT NULL
      GROUP BY draft_id, status, created_at, amazon_shipment_id, inbound_plan_id
    )
    SELECT
      sum(qty) AS all_drafts,
      sum(qty) FILTER (WHERE status = 'continued') AS continued_only,
      (SELECT sum(q) FROM (
         SELECT DISTINCT ON (COALESCE(inbound_plan_id, amazon_shipment_id, draft_id)) qty AS q
         FROM per_draft WHERE status = 'continued'
         ORDER BY COALESCE(inbound_plan_id, amazon_shipment_id, draft_id), created_at DESC
       ) x) AS continued_deduped_by_plan
    FROM per_draft
  LOOP
    RAISE NOTICE '   every draft, one figure each        : %', r.all_drafts;
    RAISE NOTICE '   only drafts continued to Amazon     : %', r.continued_only;
    RAISE NOTICE '   ... collapsed by inbound plan / id  : %  <- closest to reality', r.continued_deduped_by_plan;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many distinct plans/shipments are behind those drafts? ========';
  FOR r IN
    SELECT count(DISTINCT inbound_plan_id) FILTER (WHERE inbound_plan_id IS NOT NULL) AS plans,
           count(DISTINCT amazon_shipment_id) FILTER (WHERE amazon_shipment_id IS NOT NULL) AS amz_ids,
           count(*) AS drafts
    FROM public.shipment_builder_drafts d
    WHERE d.user_id = v_uid
      AND (d.payload::text LIKE '%' || v_asin || '%' OR d.payload::text LIKE '%' || v_sku || '%')
  LOOP
    RAISE NOTICE '   % drafts -> % distinct inbound plans, % distinct Amazon shipment ids',
      r.drafts, r.plans, r.amz_ids;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== reconciliation ========';
  RAISE NOTICE '   Amazon fba_shipment_items : 745 shipped / 525 received (52 shipments)';
  RAISE NOTICE '   purchases in created_listings : 1,254 units, none entered after 2026-05-25';
  RAISE NOTICE '   sold 1,250 | returns 37 | on hand 312 | unexplained 271';
END
$probe$;