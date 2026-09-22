-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- B09N1RG7JC was deactivated by Amazon pending an invoice/receipt approval;
-- the seller got approved and reactivated it. When does it come back in the
-- repricer? Check every piece of state that decides that: inventory status,
-- the inactive / restricted / suppression flags, and the assignment itself.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now %', now();

  RAISE NOTICE '== inventory ==';
  FOR r IN SELECT sku, available, reserved, inbound, units, listing_status, fba_blocked, fba_block_reason, ghosted_at,
                  to_char(last_inventory_sync_at, 'MM-DD HH24:MI') AS inv_sync, to_char(updated_at, 'MM-DD HH24:MI') AS upd,
                  my_price, min_price, max_price
           FROM public.inventory WHERE user_id = v_uid AND asin = 'B09N1RG7JC' ORDER BY sku LOOP
    RAISE NOTICE '  % | avail % res % inb % units % | status % | fba_blocked % % | ghosted % | synced % | updated % | price % min % max %',
      r.sku, r.available, r.reserved, r.inbound, r.units, r.listing_status, r.fba_blocked, COALESCE(r.fba_block_reason,'-'),
      r.ghosted_at, r.inv_sync, r.upd, r.my_price, r.min_price, r.max_price;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== repricer assignments ==';
  FOR r IN SELECT marketplace, sku, status, is_enabled, is_restricted, is_listing_inactive_not_buyable AS inactive,
                  to_char(listing_inactive_detected_at, 'MM-DD HH24:MI') AS inact_since,
                  to_char(listing_inactive_last_checked_at, 'MM-DD HH24:MI') AS inact_checked,
                  to_char(listing_inactive_cleared_at, 'MM-DD HH24:MI') AS inact_cleared,
                  is_pricing_suppression AS supp, sellability_review_hold AS hold, marketplace_sellable,
                  last_disabled_reason, last_disabled_by, to_char(last_disabled_at, 'MM-DD HH24:MI') AS disabled_at,
                  pause_reason, paused_reason, to_char(paused_until, 'MM-DD HH24:MI') AS paused_until,
                  to_char(last_evaluated_at, 'MM-DD HH24:MI') AS last_eval, last_skip_reason,
                  to_char(restock_reentry_at, 'MM-DD HH24:MI') AS reentry
           FROM public.repricer_assignments WHERE user_id = v_uid AND asin = 'B09N1RG7JC' ORDER BY marketplace, sku LOOP
    RAISE NOTICE '  %/% | % enabled=% | restricted % | inactive % (since %, checked %, cleared %) | suppression % | review hold % | sellable %',
      r.marketplace, r.sku, r.status, r.is_enabled, r.is_restricted, r.inactive, r.inact_since, r.inact_checked, r.inact_cleared,
      r.supp, r.hold, r.marketplace_sellable;
    RAISE NOTICE '      disabled: % by % at % | paused % % until % | last eval % skip % | reentry %',
      COALESCE(r.last_disabled_reason,'-'), COALESCE(r.last_disabled_by,'-'), COALESCE(r.disabled_at,'-'),
      COALESCE(r.pause_reason,'-'), COALESCE(r.paused_reason,'-'), COALESCE(r.paused_until,'-'),
      COALESCE(r.last_eval,'never'), COALESCE(r.last_skip_reason,'-'), COALESCE(r.reentry,'-');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== jobs that re-check listing status / re-enable ==';
  FOR r IN SELECT j.jobid, j.jobname, j.schedule, j.active,
                  (SELECT max(start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_run
           FROM cron.job j
           WHERE j.jobname ILIKE ANY (ARRAY['%inactive%','%listing%','%auto-assign%','%inventory%','%sellab%','%suppress%'])
           ORDER BY j.jobid LOOP
    RAISE NOTICE '  #% % (%) active=% | last run %', r.jobid, r.jobname, r.schedule, r.active, r.last_run;
  END LOOP;
END
$p$;
