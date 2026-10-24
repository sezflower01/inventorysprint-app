-- Name the unmapped type without another API call. January and October are
-- applied and carry adjustment_type on every row, so any value outside the six
-- the router maps will show up there -- and a row whose money sits in
-- reimbursements is one that fell to the catch-all.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== every adjustment_type stored in the applied months ==';
  FOR r IN
    SELECT adjustment_type, count(*) AS n,
           round(sum(COALESCE(reimbursements,0)),2) AS catchall,
           round(sum(COALESCE(compensated_clawback,0)),2) AS claw,
           round(sum(COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                    +COALESCE(reversal_reimbursement,0)
                    +COALESCE(free_replacement_refund_items,0)),2) AS mapped
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment' AND adjustment_type IS NOT NULL
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % | % rows | mapped $% | clawback $% | CATCH-ALL $%',
      rpad(r.adjustment_type,34), lpad(r.n::text,4), lpad(r.mapped::text,9),
      lpad(r.claw::text,9), r.catchall;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== rows whose money landed in the CATCH-ALL (unmapped types) ==';
  FOR r IN
    SELECT adjustment_type, event_date, COALESCE(seller_sku,'-') AS sku,
           round(reimbursements,2) AS amt
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND COALESCE(reimbursements,0) <> 0
    ORDER BY event_date
  LOOP
    RAISE NOTICE '   % | % | sku % | $%', r.event_date, rpad(COALESCE(r.adjustment_type,'(null)'),30),
      rpad(r.sku,16), r.amt;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE in the applied months -- so the unmapped type June';
    RAISE NOTICE '   found does not occur in January or October, and cannot be';
    RAISE NOTICE '   named from stored data. It needs the API breakdown.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== driver status ==';
  FOR r IN
    SELECT seq, to_char(month,'YYYY-MM') AS m, status, attempts,
           COALESCE(left(note,44),'-') AS note
    FROM public.repull_schedule ORDER BY seq
  LOOP RAISE NOTICE '   % | % | % | att % | %', r.seq, r.m, rpad(r.status,7), r.attempts, r.note; END LOOP;

  FOR r IN SELECT jobname, active FROM cron.job WHERE jobname='repull-adjustments-2m'
  LOOP RAISE NOTICE '   cron % active %', r.jobname, r.active; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   cron job NOT scheduled'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== reports captured so far ==';
  FOR r IN
    SELECT left(month,7) AS m, count(*) AS n,
           max(report->>'api_clawback_total') AS claw,
           bool_or(report ? 'api_amount_multiset') AS ms
    FROM public.repull_reports WHERE report ? 'api_signed_total'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % reports | claw % | multiset %', r.m, r.n, r.claw, r.ms; END LOOP;
END
$p$;
