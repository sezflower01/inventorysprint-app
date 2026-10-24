-- The gate fired on June: one adjustment item routed to the catch-all
-- (reimbursements) at -5.78, meaning an AdjustmentType the router has no column
-- for. The multiset gives the amount but not the type, so ask the read-only
-- probe for June's by_adjustment_type breakdown and look for a name that is not
-- one of the six the router knows.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
      'posted_after','2026-06-01T00:00:00Z','posted_before','2026-07-01T00:00:00Z',
      'summary_only', true),
    timeout_milliseconds := 115000
  ) INTO v_req;
  RAISE NOTICE '== June type breakdown requested: % ==', v_req;
END
$p$;
