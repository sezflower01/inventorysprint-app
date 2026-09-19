-- Trigger one check-seller-watchlist run and read what the rewritten detail
-- backfill did (20260919052000 + the batched SP-API change). Expect
-- imageBackfill.scanned ~400, spapiAsins up to 300, and the blank counts to
-- start falling. The run also does its normal Keepa-gated seller checks.

DO $p$
DECLARE v_req bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-seller-watchlist',
    headers := (SELECT jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', decrypted_secret::text)
                FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1),
    body := jsonb_build_object('triggered_by', 'detail-backfill-check'),
    timeout_milliseconds := 120000
  ) INTO v_req;
  RAISE NOTICE 'request %', v_req;
END
$p$;
