-- READ-ONLY PROBE. Result of request 15299 (re-check of B09N1RG7JC US) and
-- the assignment's flags afterwards.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT status_code, left(content, 600) AS body FROM net._http_response WHERE id = 15299 LOOP
    RAISE NOTICE 'HTTP % | %', r.status_code, r.body;
  END LOOP;

  FOR r IN SELECT marketplace, status, is_enabled, is_listing_inactive_not_buyable AS inactive,
                  to_char(listing_inactive_last_checked_at, 'MM-DD HH24:MI:SS') AS checked,
                  to_char(listing_inactive_cleared_at, 'MM-DD HH24:MI:SS') AS cleared,
                  listing_inactive_statuses, is_pricing_suppression
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B09N1RG7JC' AND marketplace = 'US' LOOP
    RAISE NOTICE 'US: % enabled=% | inactive % | Amazon statuses % | checked % | cleared % | suppression %',
      r.status, r.is_enabled, r.inactive, r.listing_inactive_statuses, r.checked, COALESCE(r.cleared, '-'), r.is_pricing_suppression;
  END LOOP;
END
$p$;
