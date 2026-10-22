-- Part B verification, step 1: BACK UP, then trigger one month's re-sync.
--
-- The re-sync is the normal fetch-profit-loss path. It deletes and re-inserts
-- the month's adjustment/liquidation/removal/service_fee rows, which is how
-- the new provenance columns get populated. The money values and signs are
-- produced by exactly the same code as before -- the only change deployed is
-- stampAdjustmentProvenance, which writes adjustment_type, seller_sku,
-- quantity, posted_at and raw_event and touches nothing else.
--
-- Two backups first, because this does rewrite rows:
--   pl_baseline_20261022        the full 2026 P&L, to prove it did not move
--   fec_adjustment_backup_20261022  October's adjustment rows as they stand

-- 1. P&L baseline for the whole of 2026, straight from the RPC the UI uses.
DROP TABLE IF EXISTS public.pl_baseline_20261022;
CREATE TABLE public.pl_baseline_20261022 AS
SELECT * FROM public.get_monthly_pl_breakdown(2026);

-- 2. The October adjustment rows, in full.
DROP TABLE IF EXISTS public.fec_adjustment_backup_20261022;
CREATE TABLE public.fec_adjustment_backup_20261022 AS
SELECT * FROM public.financial_events_cache
WHERE event_type = 'adjustment'
  AND event_date >= '2026-10-01' AND event_date < '2026-11-01';

DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT count(*) AS n FROM public.pl_baseline_20261022 LOOP
    RAISE NOTICE '== P&L baseline saved: % month rows ==', r.n;
  END LOOP;
  FOR r IN SELECT count(*) AS n FROM public.fec_adjustment_backup_20261022 LOOP
    RAISE NOTICE '== October adjustment rows backed up: % ==', r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2026 P&L, as it stands (income side, for the after-comparison) ==';
  FOR r IN
    SELECT month_num, round(sales,2) AS sales, round(reimbursements,2) AS reimb,
           round(warehouse_lost,2) AS lost, round(warehouse_damage,2) AS dmg,
           round(reversal_reimbursement,2) AS rev
    FROM public.pl_baseline_20261022 ORDER BY month_num
  LOOP
    RAISE NOTICE '   m% | sales % | reimbursements % | lost % | dmg % | reversal %',
      lpad(r.month_num::text,2), lpad(r.sales::text,12), lpad(r.reimb::text,10),
      lpad(r.lost::text,9), lpad(r.dmg::text,8), lpad(r.rev::text,9);
  END LOOP;

  -- 3. Trigger the re-sync for October only.
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN RAISE NOTICE 'NO INTERNAL_SYNC_SECRET -- not syncing'; RETURN; END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/fetch-profit-loss',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid,
      'startDate', '2026-10-01',
      'endDate', '2026-10-22',
      'forceRefresh', true
    ),
    timeout_milliseconds := 55000
  ) INTO v_req;

  RAISE NOTICE '';
  RAISE NOTICE '== re-sync triggered for 2026-10, pg_net request % ==', v_req;
  RAISE NOTICE '   verify with the next migration';
END
$p$;
