-- READ-ONLY PROBE. Did the queued re-checks clear the stale review flags?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== queue state ==';
  FOR r IN SELECT status, count(*) AS n, min(created_at) AS oldest, max(processed_at) AS newest_done
           FROM public.pricing_suppression_check_queue
           WHERE user_id = v_uid AND created_at > now() - interval '2 hours'
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '  % : % | oldest % | last processed %', r.status, r.n, r.oldest, r.newest_done;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== still flagged for review ==';
  FOR r IN SELECT count(*) AS n FROM public.repricer_assignments
           WHERE user_id = v_uid AND listing_issue_unknown_flagged = true LOOP
    RAISE NOTICE '  % listing(s)', r.n;
  END LOOP;

  FOR r IN SELECT marketplace, sku, asin, listing_issue_unknown_categories AS cats,
                  pricing_suppression_last_checked_at AS checked
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND listing_issue_unknown_flagged = true
           ORDER BY marketplace, sku LIMIT 20 LOOP
    RAISE NOTICE '  % | % | % | % | checked %', r.marketplace, r.sku, r.asin, r.cats, r.checked;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B0F6KKKNJ6 specifically ==';
  FOR r IN SELECT marketplace, listing_issue_unknown_flagged AS flagged,
                  listing_issue_unknown_categories AS cats,
                  pricing_suppression_last_checked_at AS checked
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B0F6KKKNJ6' AND marketplace = 'US' LOOP
    RAISE NOTICE '  US | flagged % | cats % | checked %', r.flagged, r.cats, r.checked;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what the re-reads found (checks since the fix went live) ==';
  FOR r IN SELECT action_taken, count(*) AS n
           FROM public.repricer_pricing_suppression_checks
           WHERE user_id = v_uid AND checked_at > '2026-09-30 23:36:00+00'
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % : %', r.action_taken, r.n;
  END LOOP;
END
$p$;
