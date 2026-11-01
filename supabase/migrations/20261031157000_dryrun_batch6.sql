-- DRY RUN batch 5 report + fire batch 6. READ-ONLY against our own tables.
--
-- Waits for the previous request to land before reading it. A response that has not
-- arrived is "not delivered yet", never "nothing to repair", so a timeout here
-- stops rather than reporting zero.
DO $p$
DECLARE
  v_uid uuid; v_secret text; v_req bigint; v_prev bigint := 60078;
  v_status int; v_content text; v_j jsonb; r record; i int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  FOR i IN 1..60 LOOP
    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = v_prev;
    EXIT WHEN v_status IS NOT NULL;
    PERFORM pg_sleep(3);
  END LOOP;

  IF v_status IS NULL THEN
    RAISE NOTICE '>>> request % never landed after 180s. STOPPING, not firing batch 6.',
      v_prev;
    RETURN;
  END IF;

  RAISE NOTICE '############ BATCH 5 (offset 200) -- HTTP % ############', v_status;
  IF v_status <> 200 THEN
    RAISE NOTICE '   body: %', left(COALESCE(v_content,''), 600);
    RAISE NOTICE '   >>> not a 200. STOPPING, not firing batch 6.';
    RETURN;
  END IF;

  v_j := v_content::jsonb;
  RAISE NOTICE '   dry_run        : %', v_j->>'dry_run';
  RAISE NOTICE '   checked        : %', v_j->>'checked';
  RAISE NOTICE '   would_repair   : %', v_j->>'would_repair';
  RAISE NOTICE '   already_correct: %', v_j->>'already_correct';
  RAISE NOTICE '   unverifiable   : %', v_j->>'unverifiable';
  RAISE NOTICE '   throttled      : %', v_j->>'throttled';
  RAISE NOTICE '   fx_skipped     : %', v_j->>'fx_skipped';
  RAISE NOTICE '   repaired (must be 0 in a dry run): %', v_j->>'repaired';

  RAISE NOTICE '';
  RAISE NOTICE '   order               | asin         | qty from->to | revenue from->to | total_cost from->to';
  FOR r IN
    SELECT e->>'order_id' AS oid, e->>'asin' AS asin, e->>'mp' AS mp,
           e->'quantity'->>'from'   AS qf, e->'quantity'->>'to'   AS qt,
           e->'revenue'->>'from'    AS rf, e->'revenue'->>'to'    AS rt,
           e->'total_cost'->>'from' AS cf, e->'total_cost'->>'to' AS ct,
           e->>'revenue_skipped_non_usd' AS fx
    FROM jsonb_array_elements(COALESCE(v_j->'rows','[]'::jsonb)) AS e
  LOOP
    -- NOTE: '%%' here would be a LITERAL percent sign, not a placeholder, so
    -- the fifth argument had nowhere to go and RAISE aborted the block. The
    -- rollback took the queued net.http_post with it, which is why no Amazon
    -- call was made -- pg_net cannot deliver a request fired in a transaction
    -- that never commits. A formatting slip was therefore harmless here, but
    -- only by luck of that ordering.
    RAISE NOTICE '   % | % | % | % | %',
      r.oid, rpad(COALESCE(r.asin,'-'),12),
      lpad(COALESCE(r.qf,'-') || '->' || COALESCE(r.qt,'-'), 12),
      lpad(COALESCE(r.rf,'-') || '->' || COALESCE(r.rt,'-'), 16),
      COALESCE(r.cf,'-') || '->' || COALESCE(r.ct,'-')
        || CASE WHEN r.fx IS NOT NULL THEN ' [fx-skipped ' || r.fx || ']' ELSE '' END;
  END LOOP;

  ------------------------------------------------------------------
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'marketplace', NULL,
                               'limit', 50, 'offset', 250),
    timeout_milliseconds := 118000
  ) INTO v_req;
  RAISE NOTICE '';
  RAISE NOTICE '   batch 6 (offset 250) fired at % -- request %',
    clock_timestamp(), v_req;
END
$p$;
