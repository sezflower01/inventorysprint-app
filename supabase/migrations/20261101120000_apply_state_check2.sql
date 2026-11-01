-- WHERE DID THE APPLY GET TO? -- READ ONLY, from durable state.
--
-- Rule 3 stopped the chain. This reports the position from
-- collapsed_order_checks and sales_orders rather than from pg_net, so it stays
-- true after the responses are pruned, and reads the last response only for
-- the throttle figure that nothing records by design.
DO $p$
DECLARE
  r record; v_uid uuid; v_content text; v_status int;
  v_remaining int; v_written int; v_units int; v_cogs_delta numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT status_code, content INTO v_status, v_content
  FROM net._http_response WHERE id = 70075;
  IF v_status = 200 THEN
    RAISE NOTICE '== the pass that triggered rule 3 (request 70075) ==';
    RAISE NOTICE '   checked % | repaired % | throttled % | already_correct %',
      v_content::jsonb->>'checked', v_content::jsonb->>'repaired',
      v_content::jsonb->>'throttled', v_content::jsonb->>'already_correct';
    RAISE NOTICE '   unverifiable % | exceeds_money_estimate % | elapsed % ms',
      v_content::jsonb->>'unverifiable',
      v_content::jsonb->>'exceeds_money_estimate',
      v_content::jsonb->>'elapsed_ms';
  ELSE
    RAISE NOTICE '== request 70075: status % (pruned or failed) ==', v_status;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== durable verdicts ==';
  FOR r IN SELECT outcome, count(*) AS n FROM public.collapsed_order_checks
           WHERE user_id = v_uid GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '   % | %', rpad(r.outcome,24), lpad(r.n::text,5); END LOOP;

  SELECT count(*) INTO v_remaining
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);
  RAISE NOTICE '';
  RAISE NOTICE '   candidates still awaiting a verdict: %', v_remaining;

  ------------------------------------------------------------------
  -- what actually changed in sales_orders, measured against the backup
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '== WHAT HAS ACTUALLY BEEN WRITTEN SO FAR ==';
  SELECT count(*),
         COALESCE(sum(s.quantity - b.quantity),0),
         round(COALESCE(sum(COALESCE(s.total_cost,0) - COALESCE(b.total_cost,0)),0)::numeric,2)
    INTO v_written, v_units, v_cogs_delta
  FROM public.collapsed_repair_backup b
  JOIN public.sales_orders s ON s.id = b.id
  WHERE COALESCE(s.quantity,0) <> COALESCE(b.quantity,0)
     OR COALESCE(s.total_cost,0) <> COALESCE(b.total_cost,0)
     OR COALESCE(s.total_sale_amount,0) <> COALESCE(b.total_sale_amount,0)
     OR COALESCE(s.sold_price,0) <> COALESCE(b.sold_price,0);
  RAISE NOTICE '   rows changed      : %', v_written;
  RAISE NOTICE '   units added       : %', v_units;
  RAISE NOTICE '   total_cost delta  : %', v_cogs_delta;

  RAISE NOTICE '';
  RAISE NOTICE '   by month:';
  FOR r IN
    SELECT EXTRACT(MONTH FROM b.order_date)::int AS m,
           count(*) AS n,
           sum(s.quantity - b.quantity) AS du,
           round(sum(COALESCE(s.total_cost,0) - COALESCE(b.total_cost,0))::numeric,2) AS dc
    FROM public.collapsed_repair_backup b
    JOIN public.sales_orders s ON s.id = b.id
    WHERE COALESCE(s.quantity,0) <> COALESCE(b.quantity,0)
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '      month % | % orders | +% units | +% cost', lpad(r.m::text,2),
      lpad(r.n::text,4), lpad(r.du::text,4), lpad(r.dc::text,8);
  END LOOP;

  ------------------------------------------------------------------
  -- RULE 5 CONTROLS, checked now rather than only at the end
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '== RULE 5: did anything outside sales_orders move? ==';
  FOR r IN
    SELECT s.kind, s.val_a AS was_a, s.val_b AS was_b, s.val_c AS was_c,
           n.val_a AS now_a, n.val_b AS now_b, n.val_c AS now_c
    FROM public.collapsed_preapply_snapshot s
    JOIN (
      SELECT 'fec'::text AS kind,
             round(sum(abs(COALESCE(compensated_clawback,0))),2) AS val_a,
             round(sum(abs(COALESCE(sales,0))),2) AS val_b,
             count(*)::numeric AS val_c
      FROM public.financial_events_cache
      WHERE user_id = v_uid
        AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    ) n ON n.kind = s.kind
    WHERE s.kind = 'fec'
  LOOP
    RAISE NOTICE '   financial_events_cache';
    RAISE NOTICE '      clawback  % -> % | %', r.was_a, r.now_a,
      CASE WHEN r.was_a = r.now_a THEN 'unchanged' ELSE '>>> MOVED' END;
    RAISE NOTICE '      sales     % -> % | %', r.was_b, r.now_b,
      CASE WHEN r.was_b = r.now_b THEN 'unchanged' ELSE '>>> MOVED' END;
    RAISE NOTICE '      rows      % -> % | %', r.was_c, r.now_c,
      CASE WHEN r.was_c = r.now_c THEN 'unchanged' ELSE 'moved (new orders posting -- expected)' END;
  END LOOP;

  FOR r IN
    SELECT s.val_a AS was_a, s.val_b AS was_b, s.val_c AS was_c,
           round(sum(COALESCE(o.quantity,0))::numeric,2) AS now_a,
           round(sum(COALESCE(o.total_cost,0))::numeric,2) AS now_b,
           count(*)::numeric AS now_c
    FROM public.collapsed_preapply_snapshot s,
         public.sales_orders o
    WHERE s.kind = 'so_noncandidate'
      AND o.user_id = v_uid
      AND o.order_date >= '2026-01-01' AND o.order_date < '2027-01-01'
      AND o.id NOT IN (SELECT id FROM public.collapsed_repair_backup)
    GROUP BY s.val_a, s.val_b, s.val_c
  LOOP
    RAISE NOTICE '   sales_orders NON-candidate rows';
    RAISE NOTICE '      quantity   % -> % | %', r.was_a, r.now_a,
      CASE WHEN r.was_a = r.now_a THEN 'unchanged'
           ELSE 'moved (new orders posting -- check the row count)' END;
    RAISE NOTICE '      total_cost % -> % | %', r.was_b, r.now_b,
      CASE WHEN r.was_b = r.now_b THEN 'unchanged' ELSE 'moved' END;
    RAISE NOTICE '      rows       % -> %', r.was_c, r.now_c;
    RAISE NOTICE '      NOTE: this account is live, so new orders arriving';
    RAISE NOTICE '      legitimately move these. A row-count increase with a';
    RAISE NOTICE '      matching quantity increase is new sales, not the repair.';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written here.';
END
$p$;
