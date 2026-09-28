-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- None of the six known-gated ASINs is in the shipment Amazon refused, so the
-- blocking item is one we have never checked (23 stocked ASINs have no
-- eligibility record) or one whose stored "approved" is stale.
-- Read the actual draft out of shipment_builder_drafts and check every SKU.

DO $p$
DECLARE v_uid uuid; v_draft jsonb; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT draft_id, status, updated_at,
                  jsonb_array_length(COALESCE(payload->'items', '[]'::jsonb)) AS items
           FROM public.shipment_builder_drafts
           WHERE user_id = v_uid ORDER BY updated_at DESC LIMIT 5 LOOP
    RAISE NOTICE 'draft % | % | % items | updated %', r.draft_id, r.status, r.items, r.updated_at;
  END LOOP;

  SELECT payload INTO v_draft FROM public.shipment_builder_drafts
  WHERE user_id = v_uid ORDER BY updated_at DESC LIMIT 1;
  IF v_draft IS NULL THEN RAISE NOTICE 'no draft payload found'; RETURN; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== items in the newest draft, with the eligibility we hold ==';
  n := 0;
  FOR r IN
    SELECT it->>'sku' AS sku, upper(it->>'asin') AS asin,
           COALESCE((it->>'qtyToShip')::int, 0) AS qty,
           uap.approval_status,
           to_char(uap.checked_at, 'YYYY-MM-DD') AS checked,
           left(COALESCE(it->>'title', ''), 40) AS title
    FROM jsonb_array_elements(COALESCE(v_draft->'items', '[]'::jsonb)) it
    LEFT JOIN public.user_approved_products uap
           ON uap.user_id = v_uid AND uap.asin = upper(it->>'asin')
          AND COALESCE(uap.marketplace, 'US') = 'US'
    WHERE COALESCE((it->>'qtyToShip')::int, 0) > 0
    ORDER BY (uap.approval_status IS NULL) DESC,
             (uap.approval_status IS DISTINCT FROM 'approved') DESC,
             uap.checked_at NULLS FIRST
  LOOP
    n := n + 1;
    RAISE NOTICE '  % / % x% | % (checked %) | %', r.sku, r.asin, r.qty,
      COALESCE(r.approval_status, 'NEVER CHECKED'), COALESCE(r.checked, '-'), r.title;
  END LOOP;
  RAISE NOTICE 'items with a quantity: %', n;

  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE uap.approval_status = 'approved') AS approved,
           count(*) FILTER (WHERE uap.approval_status IS NOT NULL AND uap.approval_status <> 'approved') AS not_approved,
           count(*) FILTER (WHERE uap.approval_status IS NULL) AS never_checked,
           count(*) FILTER (WHERE uap.checked_at < now() - interval '90 days') AS stale_90d
    FROM jsonb_array_elements(COALESCE(v_draft->'items', '[]'::jsonb)) it
    LEFT JOIN public.user_approved_products uap
           ON uap.user_id = v_uid AND uap.asin = upper(it->>'asin')
          AND COALESCE(uap.marketplace, 'US') = 'US'
    WHERE COALESCE((it->>'qtyToShip')::int, 0) > 0
  LOOP
    RAISE NOTICE 'summary: % items | approved % | not approved % | never checked % | approved-but-older-than-90d %',
      r.total, r.approved, r.not_approved, r.never_checked, r.stale_90d;
  END LOOP;
END
$p$;
