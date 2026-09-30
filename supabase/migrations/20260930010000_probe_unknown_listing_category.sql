-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- The admin panel flags SKU V05-MQB-7OWI (B0F6KKKNJ6, US) with unknown
-- suppression category "LISTING". classifyIssues() only keeps the category
-- names, but repricer_pricing_suppression_checks.issues_seen keeps Amazon's
-- whole issues[] payload -- so the actual code and message are recoverable.
-- The seller says the ASIN could not be sold FBA and was switched to FBM, and
-- every competing offer is FBM.

DO $p$
DECLARE v_uid uuid; r record; j jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the assignment ==';
  FOR r IN SELECT sku, asin, marketplace, fulfillment_type, manual_paused, paused_reason,
                  is_pricing_suppression, listing_issue_unknown_flagged,
                  listing_issue_unknown_categories,
                  is_listing_inactive_not_buyable, listing_inactive_statuses,
                  listing_inactive_reason_code, listing_inactive_reason_message,
                  pricing_suppression_last_checked_at
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B0F6KKKNJ6' LOOP
    RAISE NOTICE '  % | % | % | fulfil % | paused % (%) | pricing_suppressed %',
      r.sku, r.asin, r.marketplace, r.fulfillment_type, r.manual_paused, r.paused_reason, r.is_pricing_suppression;
    RAISE NOTICE '      unknown % cats % | not_buyable % statuses %',
      r.listing_issue_unknown_flagged, r.listing_issue_unknown_categories,
      r.is_listing_inactive_not_buyable, r.listing_inactive_statuses;
    RAISE NOTICE '      inactive reason % :: %', r.listing_inactive_reason_code, r.listing_inactive_reason_message;
    RAISE NOTICE '      last checked %', r.pricing_suppression_last_checked_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what Amazon actually said (latest check with issues) ==';
  FOR r IN SELECT checked_at, http_status, trust_gate_passed, action_taken, issues_seen
           FROM public.repricer_pricing_suppression_checks
           WHERE user_id = v_uid AND asin = 'B0F6KKKNJ6'
             AND issues_seen IS NOT NULL AND jsonb_array_length(issues_seen) > 0
           ORDER BY checked_at DESC LIMIT 1 LOOP
    RAISE NOTICE '  checked % | http % | trust % | action %', r.checked_at, r.http_status, r.trust_gate_passed, r.action_taken;
    FOR j IN SELECT * FROM jsonb_array_elements(r.issues_seen) LOOP
      RAISE NOTICE '    code=% sev=% cats=% actions=%',
        j->>'code', j->>'severity', j->'categories', j->'enforcements'->'actions';
      RAISE NOTICE '      msg: %', left(COALESCE(j->>'message',''), 400);
      IF j ? 'attributeNames' THEN RAISE NOTICE '      attrs: %', j->'attributeNames'; END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every distinct (code, category, severity, actions) the account has seen ==';
  FOR r IN
    WITH iss AS (
      SELECT jsonb_array_elements(issues_seen) AS e
      FROM public.repricer_pricing_suppression_checks
      WHERE user_id = v_uid AND checked_at > now() - interval '30 days'
        AND issues_seen IS NOT NULL AND jsonb_array_length(issues_seen) > 0
    )
    SELECT e->>'code' AS code,
           e->'categories' AS cats,
           e->>'severity' AS sev,
           e->'enforcements'->'actions' AS actions,
           count(*) AS n,
           left(min(e->>'message'), 160) AS sample
    FROM iss GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 25
  LOOP
    RAISE NOTICE '  n=% | % | cats % | % | %', r.n, r.code, r.cats, r.sev, r.actions;
    RAISE NOTICE '        %', r.sample;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== who else is flagged unknown right now ==';
  FOR r IN SELECT marketplace, listing_issue_unknown_categories AS cats, count(*) AS n,
                  string_agg(DISTINCT asin, ', ') AS asins
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND listing_issue_unknown_flagged = true
           GROUP BY 1,2 ORDER BY n DESC LIMIT 15 LOOP
    RAISE NOTICE '  % | cats % | % listing(s) | %', r.marketplace, r.cats, r.n, left(r.asins, 200);
  END LOOP;
END
$p$;
