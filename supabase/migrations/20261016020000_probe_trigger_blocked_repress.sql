-- READ-ONLY. The toast reported 470.36 -> 516.66 but the row still holds
-- 470.36. Did my own preserve_manual_price_override trigger block the
-- button's SECOND press?
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== audit log for the MX order (what the button THOUGHT it did) ==';
  FOR r IN
    SELECT old_estimate, new_estimate, COALESCE(old_locked_from,'(none)') AS olf,
           COALESCE(old_price_source,'-') AS osrc, keepa_track, applied_at
    FROM public.keepa_estimate_recheck_log
    WHERE user_id = v_uid AND order_id = '702-6705125-8817807'
    ORDER BY applied_at
  LOOP
    RAISE NOTICE '   % -> % | old lock % | old src % | % | %',
      r.old_estimate, r.new_estimate, r.olf, r.osrc, r.keepa_track, r.applied_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no audit rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what the row ACTUALLY holds ==';
  FOR r IN
    SELECT estimated_price, locked_est_price, locked_from, updated_at
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '702-6705125-8817807'
  LOOP
    RAISE NOTICE '   est % | locked % | from % | updated %',
      r.estimated_price, r.locked_est_price, r.locked_from, r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== VERDICT ==';
  RAISE NOTICE '   If an audit row says X -> Y but the row still holds X, the';
  RAISE NOTICE '   trigger blocked a write it should have allowed: the button';
  RAISE NOTICE '   re-applying its OWN lock is not an automatic writer.';
END
$p$;
