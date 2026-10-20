-- READ-ONLY, and it is read-only for a structural reason worth stating.
--
-- The blocking question before any write is: WHICH SKU holds the 145 units
-- Amazon shows? Our DB has exactly one row for B00LFXMBKI (6DA-X5B-Y5SO) and
-- it has not had a real inventory write since 2026-09-03 17:52. If the 145
-- units sit on a different, newer SKU, then the tombstone on 6DA-X5B-Y5SO is
-- CORRECT and the defect is a missing row -- a different fix entirely.
--
-- Amazon can answer that, and rescue-inventory-asin already asks it: the
-- function fetches the FBA inventory summaries and returns raw_quantities,
-- matched_summary_identity, raw_summary_excerpt and live_stock in its body.
-- Crucially it will NOT write, because its own tombstone guard fires first
-- (skipped_update_reason = 'tombstoned:NOT_IN_CATALOG'). So this call reads
-- Amazon's truth with no risk of touching the row.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN RAISE NOTICE 'NO INTERNAL_SYNC_SECRET in vault'; RETURN; END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/rescue-inventory-asin',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-internal-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', v_uid, 'asin','B00LFXMBKI', 'sku','6DA-X5B-Y5SO', 'marketplace','US'
    ),
    timeout_milliseconds := 55000
  ) INTO v_req;

  RAISE NOTICE '== asked Amazon via rescue-inventory-asin, pg_net request id % ==', v_req;
  RAISE NOTICE '   read it back with the next probe';
END
$p$;
