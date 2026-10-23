-- ITEM 2 verification: did the key fix split the collided items, and is the
-- Oct 7 clawback now filed under its own SKU, time and type?
DO $p$
DECLARE v_uid uuid; r record; v_live bigint; v_status int; v_body text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT status_code, left(COALESCE(content,''),300) INTO v_status, v_body
  FROM net._http_response WHERE id = 37539;
  RAISE NOTICE '== resync HTTP % | % ==', COALESCE(v_status::text,'pending'), COALESCE(v_body,'-');

  SELECT count(*) INTO v_live FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date < '2026-11-01';
  RAISE NOTICE '';
  RAISE NOTICE '== October rows: 3286 backed up -> % live ==', v_live;
  IF v_live = 0 THEN
    RAISE NOTICE '   NOT LANDED YET. Restore if needed:';
    RAISE NOTICE '     INSERT INTO public.financial_events_cache';
    RAISE NOTICE '     SELECT (f).* FROM public.fec_repull_backup f WHERE backup_month=''2026-10-01'';';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== DIFF BY KEY ==';
  FOR r IN
    SELECT verdict, count(*) AS rows FROM public.fec_diff_month(v_uid,'2026-10-01')
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.rows; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== adjustment rows and clawbacks ==';
  FOR r IN
    SELECT count(*) AS adj,
           count(*) FILTER (WHERE adjustment_type='COMPENSATED_CLAWBACK') AS claw_typed,
           round(sum(COALESCE(compensated_clawback,0)),2) AS claw_total
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type='adjustment'
      AND event_date >= '2026-10-01' AND event_date < '2026-11-01'
  LOOP
    RAISE NOTICE '   % adjustment rows (was 123, API said 134)', r.adj;
    RAISE NOTICE '   % typed COMPENSATED_CLAWBACK | total $%', r.claw_typed, r.claw_total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== THE OCT 7 ROW: does the clawback now carry its OWN provenance? ==';
  RAISE NOTICE '   Amazon says: sku OJ-BZSH-BBVU, 2026-10-07T16:54:26, COMPENSATED_CLAWBACK, -9.29';
  FOR r IN
    SELECT COALESCE(adjustment_type,'-') AS atype, COALESCE(seller_sku,'-') AS sku,
           left(COALESCE(posted_at::text,'-'),19) AS posted,
           round(COALESCE(compensated_clawback,0),2) AS claw,
           round(COALESCE(reversal_reimbursement,0),2) AS rev,
           amazon_order_id
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date = '2026-10-07' AND event_type='adjustment'
    ORDER BY posted_at
  LOOP
    RAISE NOTICE '   % | sku % | % | claw % | rev % | %',
      rpad(r.atype,26), rpad(r.sku,16), r.posted, lpad(r.claw::text,7), lpad(r.rev::text,7), r.amazon_order_id;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== rows whose amount still contradicts their type ==';
  FOR r IN
    SELECT event_date, adjustment_type, COALESCE(seller_sku,'-') AS sku,
           round(COALESCE(compensated_clawback,0),2) AS claw
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type='adjustment'
      AND event_date >= '2026-10-01' AND event_date < '2026-11-01'
      AND adjustment_type IS NOT NULL
      AND ((adjustment_type='COMPENSATED_CLAWBACK' AND COALESCE(compensated_clawback,0)=0)
        OR (adjustment_type<>'COMPENSATED_CLAWBACK' AND COALESCE(compensated_clawback,0)<>0))
  LOOP
    RAISE NOTICE '   % | % | sku % | claw %', r.event_date, r.adjustment_type, r.sku, r.claw;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE -- every row now matches its own type'; END IF;
END
$p$;
