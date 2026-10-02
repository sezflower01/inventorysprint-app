-- Confirm the override sources are legal now, then revive B09PJPB34P for real.
--
-- 20261001250000 added 'force_relist' (plus 'manual_override' and
-- 'amazon_sync_accept') to inventory_source_check. Until then the tombstone
-- guard's only accepted escape hatch was a value the CHECK constraint refused,
-- so no row could ever be un-ghosted.

DO $p$
DECLARE v_uid uuid; v_def text; v_headers jsonb; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT pg_get_constraintdef(con.oid) INTO v_def
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'inventory' AND con.conname = 'inventory_source_check';

  RAISE NOTICE 'constraint now: %', left(COALESCE(v_def, '(missing)'), 400);
  RAISE NOTICE 'force_relist allowed: %', COALESCE(v_def, '') LIKE '%force_relist%';

  IF COALESCE(v_def, '') NOT LIKE '%force_relist%' THEN
    RAISE NOTICE 'hatch still closed — not attempting the revive';
    RETURN;
  END IF;

  SELECT jsonb_build_object(
           'Content-Type', 'application/json',
           'x-internal-secret', decrypted_secret::text
         ) INTO v_headers
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/bulk-live-verify',
    headers := v_headers,
    body := jsonb_build_object('user_id', v_uid, 'mode', 'revive_ghosts',
                               'dry_run', false, 'limit', 50, 'deep_limit', 3,
                               'target_asin', 'B09PJPB34P'),
    timeout_milliseconds := 180000
  ) INTO v_req;

  RAISE NOTICE 'revive fired as net request %', v_req;
END
$p$;
