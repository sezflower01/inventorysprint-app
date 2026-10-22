-- Clear Cache & Resync, OCTOBER 2026 ONLY.
--
-- This replicates handleClearCacheAndResync from ProfitLoss.tsx: delete every
-- financial_events_cache row in the range, then force a fresh sync. It is the
-- one destructive control on that page, and it is admin-gated there for that
-- reason.
--
-- It deletes ALL event types, not just adjustments, so the whole month is
-- backed up first and the DELETE is GUARDED: it only runs if the backup row
-- count matches the live count exactly. If the sync then comes back partial,
-- fec_october_backup_20261022 is a complete restore source.
--
-- Why it is needed at all: the normal sync has a skip-loop (isMonthCached)
-- that skips months whose cache already looks complete, so October would never
-- re-fetch on its own and the new provenance columns would stay empty.
--
-- The backup doubles as the BEFORE snapshot. Comparing aggregates between the
-- backup and the live table afterwards is exact, and better than an RPC
-- baseline -- get_monthly_pl_breakdown scopes by auth.uid(), which is NULL in a
-- migration, so calling it here returns zeros.

DROP TABLE IF EXISTS public.fec_october_backup_20261022;
CREATE TABLE public.fec_october_backup_20261022 AS
SELECT * FROM public.financial_events_cache
WHERE event_date >= '2026-10-01' AND event_date <= '2026-10-31';

DO $p$
DECLARE
  v_uid uuid; r record;
  v_backup_rows bigint; v_live_rows bigint; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO v_backup_rows FROM public.fec_october_backup_20261022;
  SELECT count(*) INTO v_live_rows FROM public.financial_events_cache
    WHERE event_date >= '2026-10-01' AND event_date <= '2026-10-31';

  RAISE NOTICE '== backup: % rows | live: % rows ==', v_backup_rows, v_live_rows;

  IF v_backup_rows <> v_live_rows OR v_backup_rows = 0 THEN
    RAISE EXCEPTION 'ABORT: backup % does not match live % -- refusing to delete',
      v_backup_rows, v_live_rows;
  END IF;
  RAISE NOTICE '   backup verified, safe to proceed';

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE: October by event_type ==';
  FOR r IN
    SELECT event_type, count(*) AS rows
    FROM public.fec_october_backup_20261022
    GROUP BY 1 ORDER BY rows DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.event_type,16), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE: the adjustment money columns ==';
  FOR r IN
    SELECT round(sum(COALESCE(reimbursements,0)),2) AS reimb,
           round(sum(COALESCE(warehouse_lost,0)),2) AS lost,
           round(sum(COALESCE(warehouse_damage,0)),2) AS dmg,
           round(sum(COALESCE(reversal_reimbursement,0)),2) AS rev,
           round(sum(COALESCE(free_replacement_refund_items,0)),2) AS freerep,
           round(sum(COALESCE(compensated_clawback,0)),2) AS clawback,
           count(adjustment_type) AS with_type
    FROM public.fec_october_backup_20261022 WHERE event_type = 'adjustment'
  LOOP
    RAISE NOTICE '   reimbursements % | warehouse_lost % | warehouse_damage %',
      r.reimb, r.lost, r.dmg;
    RAISE NOTICE '   reversal % | free_replacement % | CLAWBACK % | with provenance %',
      r.rev, r.freerep, r.clawback, r.with_type;
  END LOOP;

  -- THE DELETE. Whole month, every event type, exactly as the UI button does.
  DELETE FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-10-01' AND event_date <= '2026-10-31';
  RAISE NOTICE '';
  RAISE NOTICE '== October cache cleared ==';

  -- Fresh sync. forceRefresh bypasses the fast path; with the cache now empty
  -- the skip-loop cannot skip the month.
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fetch-profit-loss',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid,
      'startDate', '2026-10-01',
      'endDate', '2026-10-31',
      'forceRefresh', true
    ),
    timeout_milliseconds := 120000
  ) INTO v_req;

  RAISE NOTICE '== resync triggered, pg_net request % ==', v_req;
  RAISE NOTICE '   restore source if needed: public.fec_october_backup_20261022 (% rows)',
    v_backup_rows;
END
$p$;
