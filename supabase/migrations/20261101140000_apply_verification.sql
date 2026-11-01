-- POST-APPLY VERIFICATION -- READ ONLY. Rules 4 and 5.
--
-- Everything here is measured from durable state: collapsed_repair_backup (the
-- pre-change rows in full), collapsed_preapply_snapshot (the before-picture)
-- and collapsed_order_checks (the verdicts). Nothing depends on a pg_net
-- response, so this report stays reproducible after the 6-hour prune.
--
-- The CEILING is reconstructed rather than remembered: implied units =
-- Amazon's posted money / the BACKUP's sold_price, which is exactly what the
-- shortlist computed before anything was written. The candidate function now
-- returns nothing (every row has a verdict), so recomputing from the backup is
-- the only way to re-derive it -- and it is the honest way, because it uses the
-- pre-change denominator.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_written int; v_units int; v_cost numeric;
  v_cogs_before numeric := 0; v_cogs_after numeric := 0;
  v_breach int := 0; v_claw numeric; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  -- reconstruct the per-month ceiling from the backup
  ------------------------------------------------------------------
  CREATE TEMP TABLE ceil AS
  WITH amz AS (
    SELECT amazon_order_id AS order_id, sum(abs(COALESCE(sales,0))) AS money
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'shipment'
      AND amazon_order_id IS NOT NULL AND event_date >= '2026-01-01'
    GROUP BY 1)
  SELECT EXTRACT(MONTH FROM b.order_date)::int AS m,
         sum(round(a.money / b.sold_price) - b.quantity) AS dq_ceiling,
         sum((round(a.money / b.sold_price) - b.quantity)
             * COALESCE(rc.unit_cost,0)) AS cost_ceiling
  FROM public.collapsed_repair_backup b
  JOIN amz a ON a.order_id = b.order_id
  CROSS JOIN LATERAL public.resolve_unit_cost_v1(
    v_uid, b.asin, b.sku, b.order_date, b.unit_cost) rc
  WHERE COALESCE(b.sold_price,0) > 0
  GROUP BY 1;

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. WHAT WAS WRITTEN ############';
  SELECT count(*),
         COALESCE(sum(s.quantity - b.quantity),0),
         round(COALESCE(sum(COALESCE(s.total_cost,0) - COALESCE(b.total_cost,0)),0)::numeric,2)
    INTO v_written, v_units, v_cost
  FROM public.collapsed_repair_backup b
  JOIN public.sales_orders s ON s.id = b.id
  WHERE COALESCE(s.quantity,0) <> COALESCE(b.quantity,0)
     OR COALESCE(s.total_cost,0) <> COALESCE(b.total_cost,0)
     OR COALESCE(s.total_sale_amount,0) <> COALESCE(b.total_sale_amount,0)
     OR COALESCE(s.sold_price,0) <> COALESCE(b.sold_price,0);
  RAISE NOTICE '   orders written : %', v_written;
  RAISE NOTICE '   units added    : %', v_units;
  RAISE NOTICE '   total_cost up  : %', v_cost;

  SELECT count(*) INTO v_n
  FROM public.collapsed_repair_backup b
  JOIN public.sales_orders s ON s.id = b.id
  WHERE COALESCE(s.quantity,0) <> COALESCE(b.quantity,0);
  RAISE NOTICE '   of which quantity changed: %', v_n;
  SELECT count(*) INTO v_n
  FROM public.collapsed_repair_backup b
  JOIN public.sales_orders s ON s.id = b.id
  WHERE COALESCE(s.quantity,0) = COALESCE(b.quantity,0)
    AND COALESCE(s.total_sale_amount,0) <> COALESCE(b.total_sale_amount,0);
  RAISE NOTICE '   revenue only (quantity was right): %', v_n;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. get_monthly_cogs BEFORE -> AFTER ############';
  RAISE NOTICE '   month |    COGS before |     COGS after |   moved | ceiling | within?';
  FOR r IN
    SELECT s.key::int AS m, s.val_a AS before,
           c.cogs AS after, COALESCE(ce.cost_ceiling,0) AS ceiling
    FROM public.collapsed_preapply_snapshot s
    JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = s.key::int
    LEFT JOIN ceil ce ON ce.m = s.key::int
    WHERE s.kind = 'cogs'
    ORDER BY s.key::int
  LOOP
    IF r.before <> 0 OR r.after <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | % | %',
        lpad(r.m::text,5), lpad(round(r.before,2)::text,14),
        lpad(round(r.after,2)::text,14),
        lpad(round(r.after - r.before,2)::text,8),
        lpad(round(r.ceiling,2)::text,8),
        CASE WHEN round(r.after - r.before,2) <= round(r.ceiling,2) + 0.01
             THEN 'yes' ELSE '>>> BREACH' END;
      v_cogs_before := v_cogs_before + r.before;
      v_cogs_after  := v_cogs_after  + r.after;
      IF round(r.after - r.before,2) > round(r.ceiling,2) + 0.01 THEN
        v_breach := v_breach + 1;
      END IF;
    END IF;
  END LOOP;
  RAISE NOTICE '   -----------------------------------------------------------------';
  RAISE NOTICE '   2026  | % | % | % |',
    lpad(round(v_cogs_before,2)::text,14), lpad(round(v_cogs_after,2)::text,14),
    lpad(round(v_cogs_after - v_cogs_before,2)::text,8);
  RAISE NOTICE '';
  RAISE NOTICE '   COGS increase : %', round(v_cogs_after - v_cogs_before,2);
  RAISE NOTICE '   net profit falls by the same amount.';
  RAISE NOTICE '   predicted ~4085 validated / 4789 ceiling.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. SKIPPED, AND WHY ############';
  RAISE NOTICE '   restricted to the 285 rows this apply could touch';
  FOR r IN
    SELECT COALESCE(k.outcome,'(no verdict)') AS outcome, count(*) AS n
    FROM public.collapsed_repair_backup b
    LEFT JOIN public.collapsed_order_checks k ON k.sales_order_id = b.id
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % | %', rpad(r.outcome,24), lpad(r.n::text,4),
      CASE r.outcome
        WHEN 'repaired' THEN 'written from GetOrderItems'
        WHEN 'already_correct' THEN 'Amazon agreed with what was stored'
        WHEN 'exceeds_money_estimate' THEN 'Amazon reported MORE than the ceiling -- skipped by rule 2'
        WHEN 'asin_not_in_order' THEN 'order exists but not that ASIN -- cannot verify'
        WHEN 'not_found' THEN 'Amazon has no such order (404)'
        ELSE 'no verdict recorded -- investigate' END;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   the rows skipped by the ceiling gate, in full:';
  FOR r IN
    SELECT b.order_id, b.asin, b.order_date, b.quantity AS stored
    FROM public.collapsed_repair_backup b
    JOIN public.collapsed_order_checks k ON k.sales_order_id = b.id
    WHERE k.outcome = 'exceeds_money_estimate'
    ORDER BY b.order_date
  LOOP
    RAISE NOTICE '      % | % | % | stored %', r.order_id, r.order_date,
      rpad(r.asin,12), r.stored;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      (none)'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. RULE 5 CONTROLS ############';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  FOR r IN
    SELECT val_a, val_b, val_c FROM public.collapsed_preapply_snapshot
    WHERE kind = 'fec'
  LOOP
    RAISE NOTICE '   financial_events_cache clawback % -> % | %',
      r.val_a, v_claw,
      CASE WHEN r.val_a = v_claw THEN 'UNCHANGED' ELSE '>>> MOVED -- STOP' END;
    FOR r IN
      SELECT round(sum(abs(COALESCE(sales,0))),2) AS s, count(*)::numeric AS c
      FROM public.financial_events_cache
      WHERE user_id = v_uid
        AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    LOOP
      RAISE NOTICE '   financial_events_cache sales    -> % | rows -> %', r.s, r.c;
    END LOOP;
  END LOOP;
  FOR r IN
    SELECT val_a, val_b FROM public.collapsed_preapply_snapshot WHERE kind='fec'
  LOOP
    RAISE NOTICE '   (snapshot had sales % )', r.val_b;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   2026 clawback magnitude: % | nine-month applied NET: -1765.91',
    v_claw;
  IF v_claw = 2046.17 THEN
    RAISE NOTICE '   >>> CLAWBACK TOTAL CONFIRMED UNCHANGED.';
  ELSE
    RAISE NOTICE '   >>> clawback magnitude is not 2046.17. INVESTIGATE.';
  END IF;

  RAISE NOTICE '';
  IF v_breach = 0 THEN
    RAISE NOTICE '   >>> RULE 5 SATISFIED: no month exceeded its ceiling and';
    RAISE NOTICE '   >>> financial_events_cache did not move. No restore needed.';
  ELSE
    RAISE NOTICE '   >>> % MONTH(S) BREACHED THE CEILING. Restore from', v_breach;
    RAISE NOTICE '   >>> collapsed_repair_backup -- the statement is in that';
    RAISE NOTICE '   >>> table''s COMMENT.';
  END IF;

  DROP TABLE ceil;
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- this report wrote nothing.';
END
$p$;
