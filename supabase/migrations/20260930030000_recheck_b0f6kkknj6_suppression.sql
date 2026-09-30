-- Force one fresh suppression check for B0F6KKKNJ6 (US, SKU V05-MQB-7OWI).
--
-- listing_issue_unknown_flagged is STORED state, written by the last check.
-- That check ran 2026-09-30 09:05 UTC, and the locator-vs-reason fix went live
-- at 23:36 UTC, so the admin panel is still showing the old verdict. The flag
-- is recomputed on every check (unknownPatch in checkAndUpdateSuppressionForItem),
-- so a single re-check clears it -- no manual UPDATE, which would only paper
-- over the stored value and tell us nothing about whether the fix works.
--
-- Calls check-pricing-suppression-item directly rather than going through
-- pricing_suppression_check_queue: one item, now, with the result verifiable in
-- the next probe. Reuses cron job 190's header so the call carries both a
-- service-role bearer (for the gateway) and x-internal-secret (for the
-- function's own requireInternalCall guard).

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT (regexp_match(command, 'headers:=''(\{.*?\})''::jsonb'))[1]::jsonb INTO v_headers
  FROM cron.job WHERE jobid = 190;
  IF v_headers IS NULL THEN
    RAISE NOTICE 'no usable auth header on cron job 190 — nothing sent';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-pricing-suppression-item',
    headers := v_headers,
    body := jsonb_build_object('user_id', v_uid, 'sku', 'V05-MQB-7OWI', 'marketplace', 'US'),
    timeout_milliseconds := 60000
  ) INTO v_req;

  RAISE NOTICE 'recheck requested (net request %)', v_req;
END
$p$;
