DO $p$
DECLARE v_body jsonb; r record; v_known text[] := ARRAY[
  'MISSING_FROM_INBOUND','WAREHOUSE_LOST','WAREHOUSE_DAMAGE','REVERSAL_REIMBURSEMENT',
  'FREE_REPLACEMENT_REFUND_ITEMS','COMPENSATED_CLAWBACK'];
BEGIN
  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 54537;
  IF v_body IS NULL THEN RAISE NOTICE '== 54537 pending =='; RETURN; END IF;
  IF v_body ? 'error' THEN RAISE NOTICE '== ERROR: % ==', v_body->>'error'; RETURN; END IF;

  RAISE NOTICE '== June AdjustmentTypes from the live API ==';
  FOR r IN
    SELECT key AS atype, (value->>'items')::int AS n,
           (value->>'signed_total')::numeric AS tot, (value->>'negatives')::int AS neg
    FROM jsonb_each(v_body->'by_adjustment_type')
    ORDER BY abs((value->>'signed_total')::numeric) DESC
  LOOP
    RAISE NOTICE '   % | % items | $% | % neg | router maps it: %',
      rpad(r.atype,34), lpad(r.n::text,4), lpad(r.tot::text,10), r.neg,
      (r.atype = ANY(v_known)
       OR upper(r.atype) LIKE '%LOST%' OR upper(r.atype) LIKE '%DAMAGE%'
       OR upper(r.atype) LIKE '%LIQUIDATION%' OR upper(r.atype) LIKE '%POSTAGE%'
       OR upper(r.atype) LIKE '%FREE_REPLACEMENT%'
       OR upper(r.atype) LIKE '%REVERSAL_REIMBURSEMENT%'
       OR upper(r.atype) LIKE '%COMPENSATED_CLAWBACK%');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the UNMAPPED one(s) ==';
  FOR r IN
    SELECT key AS atype, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS tot
    FROM jsonb_each(v_body->'by_adjustment_type')
    WHERE NOT (upper(key) LIKE '%LOST%' OR upper(key) LIKE '%DAMAGE%'
            OR upper(key) LIKE '%LIQUIDATION%' OR upper(key) LIKE '%POSTAGE%'
            OR upper(key) LIKE '%SHIPPINGSERVICE%' OR upper(key) LIKE '%SHIPPINGLABEL%'
            OR upper(key) LIKE '%BUYSHIPPING%' OR upper(key) LIKE '%SAFE-T%'
            OR upper(key) LIKE '%FREE_REPLACEMENT%'
            OR upper(key) LIKE '%REVERSAL_REIMBURSEMENT%'
            OR upper(key) LIKE '%COMPENSATED_CLAWBACK%')
  LOOP
    RAISE NOTICE '   >>> % | % items | $%', r.atype, r.n, r.tot;
    RAISE NOTICE '       routes to the catch-all (reimbursements) by default';
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none -- every type matches a router branch'; END IF;
END
$p$;
