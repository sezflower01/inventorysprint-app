-- Verify after the month-0 fetch: provenance filled, money unchanged.
DO $p$
DECLARE v_uid uuid; r record; v_status int; v_content text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT status_code, left(COALESCE(content,''),700) INTO v_status, v_content
  FROM net._http_response WHERE id = 20969;
  RAISE NOTICE '== month-0 response: HTTP % ==', COALESCE(v_status::text,'pending');
  IF v_content IS NOT NULL THEN RAISE NOTICE '   %', v_content; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== provenance fill for October adjustments ==';
  FOR r IN
    SELECT count(*) AS rows,
           count(adjustment_type) AS with_type,
           count(seller_sku) AS with_sku,
           count(quantity) AS with_qty,
           count(posted_at) AS with_posted,
           count(raw_event) AS with_raw
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date < '2026-11-01'
  LOOP
    RAISE NOTICE '   % rows | type % | sku % | qty % | posted % | raw %',
      r.rows, r.with_type, r.with_sku, r.with_qty, r.with_posted, r.with_raw;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== AdjustmentTypes now stored ==';
  FOR r IN
    SELECT adjustment_type, count(*) AS rows, sum(COALESCE(quantity,0)) AS units,
           round(sum(COALESCE(reimbursements,0)+COALESCE(warehouse_lost,0)
                    +COALESCE(warehouse_damage,0)+COALESCE(reversal_reimbursement,0)
                    +COALESCE(free_replacement_refund_items,0)),2) AS money
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment' AND adjustment_type IS NOT NULL
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | % units | $%',
      rpad(r.adjustment_type,32), lpad(r.rows::text,4), lpad(r.units::text,5), r.money;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   still none'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== MONEY DRIFT CHECK: October adjustment totals, backup vs live ==';
  FOR r IN
    SELECT
      (SELECT round(sum(COALESCE(reimbursements,0)),2) FROM public.fec_adjustment_backup_20261022) AS b_reimb,
      (SELECT round(sum(COALESCE(reimbursements,0)),2) FROM public.financial_events_cache
       WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-10-01' AND event_date<'2026-11-01') AS a_reimb,
      (SELECT round(sum(COALESCE(warehouse_lost,0)),2) FROM public.fec_adjustment_backup_20261022) AS b_lost,
      (SELECT round(sum(COALESCE(warehouse_lost,0)),2) FROM public.financial_events_cache
       WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-10-01' AND event_date<'2026-11-01') AS a_lost,
      (SELECT round(sum(COALESCE(reversal_reimbursement,0)),2) FROM public.fec_adjustment_backup_20261022) AS b_rev,
      (SELECT round(sum(COALESCE(reversal_reimbursement,0)),2) FROM public.financial_events_cache
       WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-10-01' AND event_date<'2026-11-01') AS a_rev,
      (SELECT round(sum(COALESCE(warehouse_damage,0)),2) FROM public.fec_adjustment_backup_20261022) AS b_dmg,
      (SELECT round(sum(COALESCE(warehouse_damage,0)),2) FROM public.financial_events_cache
       WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-10-01' AND event_date<'2026-11-01') AS a_dmg,
      (SELECT count(*) FROM public.fec_adjustment_backup_20261022) AS b_rows,
      (SELECT count(*) FROM public.financial_events_cache
       WHERE user_id=v_uid AND event_type='adjustment' AND event_date>='2026-10-01' AND event_date<'2026-11-01') AS a_rows
  LOOP
    RAISE NOTICE '   rows                   % -> %', r.b_rows, r.a_rows;
    RAISE NOTICE '   reimbursements         % -> %', r.b_reimb, r.a_reimb;
    RAISE NOTICE '   warehouse_lost         % -> %', r.b_lost, r.a_lost;
    RAISE NOTICE '   warehouse_damage       % -> %', r.b_dmg, r.a_dmg;
    RAISE NOTICE '   reversal_reimbursement % -> %', r.b_rev, r.a_rev;
  END LOOP;
END
$p$;
