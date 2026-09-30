-- READ-ONLY PROBE. Did the forced re-check clear the stale review flag?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the call ==';
  FOR r IN SELECT id, status_code, left(COALESCE(content,''), 200) AS body, created
           FROM net._http_response WHERE id = 161055 LOOP
    RAISE NOTICE '  net % | http % | % | %', r.id, r.status_code, r.created, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the flag now ==';
  FOR r IN SELECT marketplace, sku, listing_issue_unknown_flagged AS flagged,
                  listing_issue_unknown_categories AS cats,
                  is_pricing_suppression, is_listing_inactive_not_buyable AS not_buyable,
                  pricing_suppression_last_checked_at AS last_checked
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B0F6KKKNJ6' AND marketplace = 'US' LOOP
    RAISE NOTICE '  % % | flagged % | cats % | suppressed % | not_buyable % | checked %',
      r.marketplace, r.sku, r.flagged, r.cats, r.is_pricing_suppression, r.not_buyable, r.last_checked;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== newest check rows ==';
  FOR r IN SELECT checked_at, action_taken, http_status, trust_gate_passed AS trust,
                  jsonb_array_length(issues_seen) AS issues
           FROM public.repricer_pricing_suppression_checks
           WHERE user_id = v_uid AND asin = 'B0F6KKKNJ6'
           ORDER BY checked_at DESC LIMIT 3 LOOP
    RAISE NOTICE '  % | % | http % | trust % | % issue(s)', r.checked_at, r.action_taken, r.http_status, r.trust, r.issues;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== anything else still flagged for review, account-wide ==';
  FOR r IN SELECT marketplace, sku, asin, listing_issue_unknown_categories AS cats
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND listing_issue_unknown_flagged = true
           ORDER BY marketplace, sku LIMIT 20 LOOP
    RAISE NOTICE '  % | % | % | %', r.marketplace, r.sku, r.asin, r.cats;
  END LOOP;
END
$p$;
