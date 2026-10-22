-- READ-ONLY. 10 rows are typed COMPENSATED_CLAWBACK but only 7 carry a
-- non-zero clawback amount, and one REVERSAL_REIMBURSEMENT row carries -9.29
-- of clawback. Suspected cause: _adjEvtIdx is declared INSIDE the page loop
-- (line 1516) while serviceFeeIdx is declared outside it (line 1397), so the
-- synthetic key ADJ-{date}-{evtIdx}#{itemIdx} restarts at 1 on every page and
-- two unrelated adjustments on the same date collide on the upsert key
-- (user_id, event_type, event_date, amazon_order_id, asin).
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== clawback-typed rows vs rows carrying an amount ==';
  FOR r IN
    SELECT count(*) AS typed_clawback,
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) <> 0) AS with_amount,
           count(*) FILTER (WHERE COALESCE(compensated_clawback,0) = 0) AS zero_amount
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND adjustment_type = 'COMPENSATED_CLAWBACK'
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
  LOOP
    RAISE NOTICE '   % typed | % carry an amount | % are ZERO',
      r.typed_clawback, r.with_amount, r.zero_amount;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== rows whose stored amount contradicts their own type ==';
  FOR r IN
    SELECT event_date, adjustment_type, COALESCE(seller_sku,'-') AS sku,
           COALESCE(amazon_order_id,'-') AS oid,
           round(COALESCE(compensated_clawback,0),2) AS clawback,
           round(COALESCE(reversal_reimbursement,0),2) AS reversal,
           round(COALESCE(warehouse_lost,0),2) AS lost,
           round(COALESCE(free_replacement_refund_items,0),2) AS freerep
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
      AND adjustment_type IS NOT NULL
      AND (
        (adjustment_type = 'COMPENSATED_CLAWBACK' AND COALESCE(compensated_clawback,0) = 0)
        OR (adjustment_type <> 'COMPENSATED_CLAWBACK' AND COALESCE(compensated_clawback,0) <> 0)
      )
    ORDER BY event_date
  LOOP
    RAISE NOTICE '   % | % | sku % | oid %', r.event_date, rpad(r.adjustment_type,26), rpad(r.sku,14), r.oid;
    RAISE NOTICE '       clawback % | reversal % | lost % | freerep %',
      r.clawback, r.reversal, r.lost, r.freerep;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none -- no contradictions'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== duplicate synthetic keys: the collision signature ==';
  FOR r IN
    SELECT amazon_order_id, count(*) AS rows,
           count(DISTINCT adjustment_type) AS distinct_types,
           string_agg(DISTINCT adjustment_type, ' + ') AS types
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
    GROUP BY amazon_order_id
    HAVING count(*) > 1 OR count(DISTINCT adjustment_type) > 1
    ORDER BY rows DESC LIMIT 10
  LOOP
    RAISE NOTICE '   % | % rows | % types: %', r.amazon_order_id, r.rows, r.distinct_types, r.types;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   no duplicate keys SURVIVE -- collisions merge in-memory';
    RAISE NOTICE '   (dedupeCacheEntries merges before the upsert, so the loser';
    RAISE NOTICE '    is absorbed rather than left behind as a second row)';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how many adjustment keys repeat a date+index pattern? ==';
  FOR r IN
    SELECT count(*) AS adj_rows,
           count(DISTINCT amazon_order_id) AS distinct_keys
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'adjustment'
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
  LOOP
    RAISE NOTICE '   % rows across % distinct keys (equal means no survivors lost)',
      r.adj_rows, r.distinct_keys;
  END LOOP;
END
$p$;
