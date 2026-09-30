-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- classifyIssues() flags an ERROR + LISTING_SUPPRESSED issue for admin review
-- when any of its categories is outside KNOWN_NON_PRICING_CATEGORIES. The
-- census showed why B0F6KKKNJ6 was flagged: its categories are
-- ["QUALIFICATION_REQUIRED", "LISTING"], and LISTING is not a reason at all --
-- it says WHERE the issue sits, exactly like PRODUCT on the sibling warning.
--
-- Before treating LISTING/PRODUCT/OFFER as locators, enumerate every hard
-- suppression by what is LEFT after stripping them, so the replacement rule is
-- built against real data rather than the top-25 slice:
--   * reason set empty  -> must be recognised by CODE or the panel floods
--   * reason set present -> must be a category we already know

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== hard suppressions (ERROR + LISTING_SUPPRESSED), by code and reason-after-stripping ==';
  FOR r IN
    WITH iss AS (
      SELECT jsonb_array_elements(issues_seen) AS e
      FROM public.repricer_pricing_suppression_checks
      WHERE user_id = v_uid AND checked_at > now() - interval '60 days'
        AND issues_seen IS NOT NULL AND jsonb_array_length(issues_seen) > 0
    ), hard AS (
      SELECT e->>'code' AS code,
             COALESCE(ARRAY(SELECT jsonb_array_elements_text(e->'categories')), ARRAY[]::text[]) AS cats,
             e->>'message' AS msg
      FROM iss
      WHERE upper(COALESCE(e->>'severity','')) = 'ERROR'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(e->'enforcements'->'actions','[]'::jsonb)) a
          WHERE a->>'action' = 'LISTING_SUPPRESSED')
    )
    SELECT code,
           ARRAY(SELECT unnest(cats) EXCEPT SELECT unnest(ARRAY['LISTING','PRODUCT','OFFER'])) AS reasons,
           count(*) AS n,
           count(DISTINCT cats::text) AS cat_shapes,
           left(min(msg), 130) AS sample
    FROM hard GROUP BY 1,2 ORDER BY n DESC
  LOOP
    RAISE NOTICE '  n=% | code % | reasons % | %', r.n, r.code, r.reasons, r.sample;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== of those, the ones with NO reason category left: what code are they? ==';
  FOR r IN
    WITH iss AS (
      SELECT jsonb_array_elements(issues_seen) AS e
      FROM public.repricer_pricing_suppression_checks
      WHERE user_id = v_uid AND checked_at > now() - interval '60 days'
        AND issues_seen IS NOT NULL AND jsonb_array_length(issues_seen) > 0
    ), hard AS (
      SELECT e->>'code' AS code,
             COALESCE(ARRAY(SELECT jsonb_array_elements_text(e->'categories')), ARRAY[]::text[]) AS cats,
             e->>'message' AS msg
      FROM iss
      WHERE upper(COALESCE(e->>'severity','')) = 'ERROR'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(e->'enforcements'->'actions','[]'::jsonb)) a
          WHERE a->>'action' = 'LISTING_SUPPRESSED')
    )
    SELECT code, count(*) AS n, left(min(msg), 200) AS sample
    FROM hard
    WHERE NOT EXISTS (SELECT unnest(cats) EXCEPT SELECT unnest(ARRAY['LISTING','PRODUCT','OFFER']))
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '  n=% | code % | %', r.n, r.code, r.sample;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B0F6KKKNJ6: is it actually suppressed, or live with a standing ERROR? ==';
  FOR r IN SELECT checked_at, action_taken, http_status,
                  (SELECT count(*) FROM jsonb_array_elements(issues_seen) x
                     WHERE upper(COALESCE(x->>'severity','')) = 'ERROR') AS errors
           FROM public.repricer_pricing_suppression_checks
           WHERE user_id = v_uid AND asin = 'B0F6KKKNJ6'
           ORDER BY checked_at DESC LIMIT 6 LOOP
    RAISE NOTICE '  % | % | http % | % error issue(s)', r.checked_at, r.action_taken, r.http_status, r.errors;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== does the account have other listings under the same code 100332? ==';
  FOR r IN
    WITH iss AS (
      SELECT sku, asin, marketplace, checked_at, jsonb_array_elements(issues_seen) AS e
      FROM public.repricer_pricing_suppression_checks
      WHERE user_id = v_uid AND checked_at > now() - interval '30 days'
        AND issues_seen IS NOT NULL AND jsonb_array_length(issues_seen) > 0
    )
    SELECT marketplace, asin, sku, max(checked_at) AS last_seen
    FROM iss WHERE e->>'code' IN ('100332','18616')
    GROUP BY 1,2,3 ORDER BY 1,2 LIMIT 25
  LOOP
    RAISE NOTICE '  % | % | % | last seen %', r.marketplace, r.asin, r.sku, r.last_seen;
  END LOOP;
END
$p$;
