-- Helpers for the month-by-month re-pull. Fourteen invocations are coming
-- (six dry runs, eight applies), each needing the same pre-flight, the same
-- report shape and the same verification. Writing that out fourteen times is
-- fourteen chances for one month's checks to differ from another's, which
-- would quietly make the months non-comparable -- the same reason
-- fec_diff_month exists rather than a hand-rolled diff per month.

/**
 * Pre-flight and fire one month. Returns the pg_net request id.
 *
 * REFUSES rather than queues when the queue is busy: a contended pg_net queue
 * is what left January blank for minutes, and a concurrent fetch-profit-loss
 * run could upsert adjustment rows underneath the re-pull's transaction.
 */
CREATE OR REPLACE FUNCTION public.repull_fire(p_user uuid, p_month date, p_apply boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_secret text; v_req bigint; v_q bigint; v_running bigint;
BEGIN
  SELECT count(*) INTO v_q FROM net.http_request_queue;
  IF v_q > 3 THEN
    RAISE EXCEPTION 'ABORT %: pg_net queue depth % -- not firing into a busy queue',
      to_char(p_month,'YYYY-MM'), v_q;
  END IF;

  SELECT count(*) INTO v_running FROM public.pl_sync_progress
  WHERE user_id = p_user AND status IN ('running','continue');
  IF p_apply AND v_running > 0 THEN
    RAISE EXCEPTION 'ABORT %: % sync(s) running -- refusing to apply concurrently',
      to_char(p_month,'YYYY-MM'), v_running;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repull-month-adjustments',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', p_user,
                               'month', to_char(date_trunc('month',p_month),'YYYY-MM-01'),
                               'apply', p_apply),
    timeout_milliseconds := 115000
  ) INTO v_req;

  RAISE NOTICE '   fired % (apply=%) queue was % -> request %',
    to_char(p_month,'YYYY-MM'), p_apply, v_q, v_req;
  RETURN v_req;
END
$fn$;

/** Print one request's report. Returns true when a response exists. */
CREATE OR REPLACE FUNCTION public.repull_report(p_req bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_raw text; v_b jsonb; v_status int;
BEGIN
  SELECT status_code, left(COALESCE(content,''),2000) INTO v_status, v_raw
  FROM net._http_response WHERE id = p_req;
  IF v_raw IS NULL THEN
    RAISE NOTICE '   request %: PENDING (queue depth %)', p_req,
      (SELECT count(*) FROM net.http_request_queue);
    RETURN false;
  END IF;
  v_b := v_raw::jsonb;

  IF v_b ? 'error' THEN
    RAISE NOTICE '   % HTTP % ERROR: %', p_req, v_status, left(v_b->>'error',220);
    RETURN true;
  END IF;
  IF v_b ? 'aborted' THEN
    RAISE NOTICE '   % HTTP % ABORTED: %', p_req, v_status, v_b->>'aborted';
    RETURN true;
  END IF;

  RAISE NOTICE '   % | wrote % | pages % | %ms',
    v_b->>'month', v_b->>'wrote', v_b->>'pages', v_b->>'elapsed_ms';
  RAISE NOTICE '      API    % items -> % rows | signed $% | clawback $%',
    v_b->>'api_items', v_b->>'api_rows_after_dedupe',
    v_b->>'api_signed_total', v_b->>'api_clawback_total';
  RAISE NOTICE '      STORED % rows | signed $% | clawback $%',
    v_b->>'stored_rows', v_b->>'stored_signed_total', v_b->>'stored_clawback_total';
  RAISE NOTICE '      PREDICTED P&L change: $%',
    round((v_b->>'api_signed_total')::numeric - (v_b->>'stored_signed_total')::numeric, 2);
  IF v_b ? 'applied' THEN RAISE NOTICE '      applied: %', v_b->'applied'; END IF;
  RETURN true;
END
$fn$;

/** Full post-apply verification for one month. */
CREATE OR REPLACE FUNCTION public.repull_verify(p_user uuid, p_month date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  r record; v_col text; v_b numeric; v_a numeric; v_drift int := 0; v_net numeric := 0;
  v_start date := date_trunc('month',p_month)::date;
  v_end date := (date_trunc('month',p_month) + interval '1 month')::date;
  v_cols text[] := ARRAY['sales','refunds','shipping_credits','shipping_credit_refunds',
    'gift_wrap_credits','gift_wrap_credit_refunds','promotional_rebates','promotional_rebate_refunds',
    'other_income','reimbursements','liquidations','referral_fees','fba_fees','variable_closing_fees',
    'fixed_closing_fees','fba_inbound_fees','fba_storage_fees','fba_removal_fees','fba_disposal_fees',
    'fba_long_term_storage_fees','other_fees','sales_tax_collected','marketplace_facilitator_tax',
    'sales_tax_refunds','marketplace_facilitator_tax_refunds','fba_customer_return_fees',
    'compensated_clawback','hrr_non_apparel','digital_services_fee','warehouse_lost','warehouse_damage',
    'reversal_reimbursement','free_replacement_refund_items','fba_inbound_convenience_fee',
    'liquidations_brokerage_fee','re_commerce_grading_charge','shipping_chargeback',
    'shipping_chargeback_refund','restocking_fee','fbm_shipping_label_fee'];
BEGIN
  RAISE NOTICE '   -- fingerprint of NON-adjustment rows (must match the pre-run values) --';
  FOR r IN SELECT * FROM public.fec_other_types_fingerprint(p_user,v_start) ORDER BY event_type
  LOOP RAISE NOTICE '      % % %', rpad(r.event_type,13), lpad(r.rows::text,5), r.fingerprint; END LOOP;

  RAISE NOTICE '   -- diff by key --';
  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(p_user,v_start)
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % %', rpad(r.verdict,10), r.rows; END LOOP;
  FOR r IN
    SELECT verdict, event_type, count(*) AS rows FROM public.fec_diff_month(p_user,v_start)
    WHERE verdict <> 'unchanged' GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '         % % %', rpad(r.verdict,8), rpad(r.event_type,12), r.rows; END LOOP;

  RAISE NOTICE '   -- clawbacks and provenance --';
  FOR r IN
    SELECT count(*) AS adj, count(adjustment_type) AS prov,
           count(*) FILTER (WHERE adjustment_type='COMPENSATED_CLAWBACK') AS n,
           round(sum(COALESCE(compensated_clawback,0)),2) AS total
    FROM public.financial_events_cache
    WHERE user_id=p_user AND event_type='adjustment'
      AND event_date>=v_start AND event_date<v_end
  LOOP
    RAISE NOTICE '      % adj rows | provenance % | % clawbacks | $%', r.adj, r.prov, r.n, r.total;
  END LOOP;

  RAISE NOTICE '   -- P&L change, all 40 columns --';
  FOREACH v_col IN ARRAY v_cols LOOP
    BEGIN
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.fec_repull_backup
                        WHERE user_id=%L AND backup_month=%L$q$, v_col, p_user, v_start) INTO v_b;
      EXECUTE format($q$SELECT COALESCE(round(sum(%I)::numeric,2),0) FROM public.financial_events_cache
                        WHERE user_id=%L AND event_date>=%L AND event_date<%L$q$,
                     v_col, p_user, v_start, v_end) INTO v_a;
      IF COALESCE(v_b,0) <> COALESCE(v_a,0) THEN
        v_drift := v_drift + 1; v_net := v_net + (v_a - v_b);
        RAISE NOTICE '      % : % -> % (delta %)', rpad(v_col,32), v_b, v_a, round(v_a-v_b,2);
      END IF;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE '      % of 40 moved | net %', v_drift, round(v_net,2);
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_fire(uuid, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.repull_report(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.repull_verify(uuid, date) TO service_role;

-- Fire the FIRST dry run: February.
DO $p$
DECLARE v_uid uuid; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== DRY RUN: February ==';
  v_req := public.repull_fire(v_uid, '2026-02-01', false);
END
$p$;
