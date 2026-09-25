-- Clear FAILED_VALIDATION on listings that reality has since disproved.
--
-- A validation failure is a snapshot of one moment just after a listing was
-- created. B0C69ZH2D6 / MIQ-AAW-8EH3 was flagged FBA_INB_0004 at 17:29 on
-- 2026-08-04 and given up on at 18:44 the same day -- Amazon's "not eligible
-- for inbound right now", which is what it says while a new listing is still
-- being set up. The seller shipped it in, and it has sold 22 units across 18
-- orders since 08-15 and holds 34 units today. Nothing ever re-checked it, so
-- seven weeks later the app still called it FBA-inbound-ineligible.
--
-- If a listing has stock in an Amazon warehouse or has sold since it was
-- created, it demonstrably passed inbound. That is stronger evidence than the
-- old check, so the flag goes.
--
-- The listing's own record of what happened is kept in validation_warning
-- rather than erased: "this failed once, here is why, and here is why we
-- stopped believing it" is worth more than a clean row.

DO $p$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT cl.id, cl.user_id, cl.asin, cl.sku, cl.validation_failure_reason,
           COALESCE((SELECT sum(COALESCE(i.available,0) + COALESCE(i.reserved,0))
                     FROM public.inventory i WHERE i.user_id = cl.user_id AND i.sku = cl.sku), 0) AS stock,
           (SELECT count(*) FROM public.sales_orders s
            WHERE s.user_id = cl.user_id AND s.asin = cl.asin
              AND COALESCE(s.is_cancelled, false) = false
              AND s.order_date >= cl.date_created) AS sales_since
    FROM public.created_listings cl
    WHERE cl.validation_status = 'FAILED_VALIDATION'
  LOOP
    CONTINUE WHEN r.stock <= 0 AND r.sales_since <= 0;

    UPDATE public.created_listings
    SET validation_status = 'ACTIVE',
        validation_failure_reason = NULL,
        validation_failure_code = NULL,
        validation_warning = format(
          'Validation had failed (%s) but the listing has %s units in stock and %s sale(s) since — cleared 2026-09-25.',
          COALESCE(r.validation_failure_reason, 'reason not recorded'), r.stock, r.sales_since)
    WHERE id = r.id;

    n := n + 1;
    RAISE NOTICE 'cleared % % | stock % | sales since % | was: %', r.asin, r.sku, r.stock, r.sales_since,
      COALESCE(r.validation_failure_reason, '-');
  END LOOP;

  RAISE NOTICE 'listings cleared: %', n;

  FOR r IN SELECT count(*) AS still_failed FROM public.created_listings WHERE validation_status = 'FAILED_VALIDATION' LOOP
    RAISE NOTICE 'still FAILED_VALIDATION (no stock, no sales — these get re-checked): %', r.still_failed;
  END LOOP;
END
$p$;
