-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- The inventory row for B0C69ZH2D6 is NOT fba_blocked, yet the app shows
-- "FBA inbound ineligible — FBA_INB_0004" dated 2026-08-04. The created_listings
-- row is FAILED_VALIDATION from that date. Read its full failure text and see
-- how many other listings carry a FAILED_VALIDATION that later sold anyway.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT sku, validation_status, validation_failure_reason, validation_warning,
                  to_char(validation_started_at, 'YYYY-MM-DD HH24:MI') AS started,
                  to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS upd,
                  inbound_dry_run_status, inbound_dry_run_error
           FROM public.created_listings WHERE user_id = v_uid AND asin = 'B0C69ZH2D6' LOOP
    RAISE NOTICE 'sku % | % | started % | updated %', r.sku, r.validation_status, COALESCE(r.started,'-'), r.upd;
    RAISE NOTICE '  failure: %', COALESCE(r.validation_failure_reason, '(none)');
    RAISE NOTICE '  warning: %', COALESCE(r.validation_warning, '(none)');
    RAISE NOTICE '  dry run: % / %', COALESCE(r.inbound_dry_run_status,'-'), COALESCE(r.inbound_dry_run_error,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== FBA_INB_0004 anywhere in created_listings ==';
  FOR r IN SELECT count(*) AS n,
                  count(*) FILTER (WHERE validation_status = 'FAILED_VALIDATION') AS failed,
                  min(date_created) AS oldest, max(date_created) AS newest
           FROM public.created_listings
           WHERE user_id = v_uid
             AND (validation_failure_reason ILIKE '%FBA_INB_0004%' OR validation_warning ILIKE '%FBA_INB_0004%'
                  OR inbound_dry_run_error ILIKE '%FBA_INB_0004%' OR fba_block_reason ILIKE '%FBA_INB_0004%') LOOP
    RAISE NOTICE '  % rows (% still FAILED_VALIDATION), created % .. %', r.n, r.failed, r.oldest, r.newest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== FAILED_VALIDATION listings that have sold since ==';
  FOR r IN SELECT cl.asin, cl.sku, to_char(cl.date_created,'MM-DD') AS created,
                  left(COALESCE(cl.validation_failure_reason,'-'), 40) AS why,
                  (SELECT count(*) FROM public.sales_orders s
                   WHERE s.user_id = v_uid AND s.asin = cl.asin AND COALESCE(s.is_cancelled,false) = false
                     AND s.order_date >= cl.date_created) AS sales_since,
                  (SELECT COALESCE(sum(COALESCE(i.available,0) + COALESCE(i.reserved,0)), 0) FROM public.inventory i
                   WHERE i.user_id = v_uid AND i.sku = cl.sku) AS stock_now
           FROM public.created_listings cl
           WHERE cl.user_id = v_uid AND cl.validation_status = 'FAILED_VALIDATION'
           ORDER BY 5 DESC LIMIT 10 LOOP
    RAISE NOTICE '  % % (created %) | % | % sales since | stock now %', r.asin, r.sku, r.created, r.why, r.sales_since, r.stock_now;
  END LOOP;

  FOR r IN SELECT count(*) AS failed_total,
                  count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM public.sales_orders s
                    WHERE s.user_id = v_uid AND s.asin = cl.asin AND COALESCE(s.is_cancelled,false) = false
                      AND s.order_date >= cl.date_created)) AS sold_since
           FROM public.created_listings cl
           WHERE cl.user_id = v_uid AND cl.validation_status = 'FAILED_VALIDATION' LOOP
    RAISE NOTICE '';
    RAISE NOTICE 'FAILED_VALIDATION rows: % | of those, % have sold since being created', r.failed_total, r.sold_since;
  END LOOP;
END
$p$;
