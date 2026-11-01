-- PHASE 1c verification. READ ONLY.
--
-- Checks, in order: the response, what changed measured against
-- collapsed_repair_backup_9, COGS by month against the pre-apply snapshot plus
-- the already-applied main repair, financial_events_cache unchanged, and the
-- clawback total.
--
-- The COGS baseline needs care. collapsed_preapply_snapshot holds the figures
-- from BEFORE the main 275-order repair, so comparing against it would show
-- this repair's movement PLUS that one's. The main repair's contribution is
-- already measured (+4,045.10 total), so the expected end state is
-- snapshot + 4,045.10 + 409.27 per month in aggregate. Both deltas are shown
-- separately rather than merged, so neither can hide the other.
DO $p$
DECLARE
  r record; v_uid uuid; v_req bigint := 70822;
  v_status int; v_content text; v_j jsonb; i int;
  v_rows int; v_units int; v_cost numeric; v_claw numeric;
  v_rev_moved int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR i IN 1..40 LOOP
    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = v_req;
    EXIT WHEN v_status IS NOT NULL;
    PERFORM pg_sleep(3);
  END LOOP;

  IF v_status = 200 THEN
    v_j := v_content::jsonb;
    RAISE NOTICE '############ 1. THE RESPONSE ############';
    RAISE NOTICE '   dry_run % | quantity_only % | checked % | repaired %',
      v_j->>'dry_run', v_j->>'quantity_only', v_j->>'checked', v_j->>'repaired';
    RAISE NOTICE '   already_correct % | throttled % | unverifiable % | checks_recorded %',
      v_j->>'already_correct', v_j->>'throttled', v_j->>'unverifiable',
      v_j->>'checks_recorded';
  ELSE
    RAISE NOTICE '############ 1. response status % -- reading the DB instead ############',
      v_status;
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. WHAT CHANGED, vs the 9-row backup ############';
  RAISE NOTICE '   order               | asin         | qty      | total_cost        | revenue';
  FOR r IN
    SELECT b.order_id, b.asin,
           b.quantity AS qb, s.quantity AS qa,
           round(COALESCE(b.total_cost,0)::numeric,2) AS cb,
           round(COALESCE(s.total_cost,0)::numeric,2) AS ca,
           round(COALESCE(b.total_sale_amount,0)::numeric,2) AS rb,
           round(COALESCE(s.total_sale_amount,0)::numeric,2) AS ra
    FROM public.collapsed_repair_backup_9 b
    JOIN public.sales_orders s ON s.id = b.id
    ORDER BY b.order_id
  LOOP
    RAISE NOTICE '   % | % | % -> % | % -> % | % -> % %',
      r.order_id, rpad(r.asin,12), lpad(r.qb::text,3), lpad(r.qa::text,3),
      lpad(r.cb::text,8), lpad(r.ca::text,8),
      lpad(r.rb::text,8), lpad(r.ra::text,8),
      CASE WHEN r.rb = r.ra THEN '(revenue untouched, as instructed)'
           ELSE '>>> REVENUE MOVED -- should not have' END;
  END LOOP;

  SELECT count(*), COALESCE(sum(s.quantity - b.quantity),0),
         round(COALESCE(sum(COALESCE(s.total_cost,0) - COALESCE(b.total_cost,0)),0)::numeric,2),
         count(*) FILTER (WHERE COALESCE(s.total_sale_amount,0)
                            <> COALESCE(b.total_sale_amount,0))
    INTO v_rows, v_units, v_cost, v_rev_moved
  FROM public.collapsed_repair_backup_9 b
  JOIN public.sales_orders s ON s.id = b.id
  WHERE COALESCE(s.quantity,0) <> COALESCE(b.quantity,0);

  RAISE NOTICE '';
  RAISE NOTICE '   rows with a quantity change : % of 9', v_rows;
  RAISE NOTICE '   units added                 : %', v_units;
  RAISE NOTICE '   total_cost increase         : % (expected 409.27)', v_cost;
  RAISE NOTICE '   rows whose revenue moved    : % (must be 0)', v_rev_moved;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. COGS BY MONTH ############';
  RAISE NOTICE '   baseline is the PRE-MAIN-REPAIR snapshot, so the main repair';
  RAISE NOTICE '   (+4045.10) and this one are separated out.';
  RAISE NOTICE '   month | snapshot  | now       | total moved | of which these 9';
  FOR r IN
    SELECT s.key::int AS m, s.val_a AS snap, c.cogs AS now,
           COALESCE(n.d,0) AS nine
    FROM public.collapsed_preapply_snapshot s
    JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = s.key::int
    LEFT JOIN (
      SELECT EXTRACT(MONTH FROM b.order_date)::int AS m,
             sum(COALESCE(s2.total_cost,0) - COALESCE(b.total_cost,0)) AS d
      FROM public.collapsed_repair_backup_9 b
      JOIN public.sales_orders s2 ON s2.id = b.id
      GROUP BY 1
    ) n ON n.m = s.key::int
    WHERE s.kind = 'cogs'
    ORDER BY s.key::int
  LOOP
    IF r.snap <> 0 OR r.now <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | %', lpad(r.m::text,5),
        lpad(round(r.snap,2)::text,9), lpad(round(r.now,2)::text,9),
        lpad(round(r.now - r.snap,2)::text,11),
        lpad(round(r.nine,2)::text,16);
    END IF;
  END LOOP;

  FOR r IN
    SELECT round(sum(c.cogs),2) AS total,
           (SELECT round(sum(val_a),2) FROM public.collapsed_preapply_snapshot
             WHERE kind='cogs') AS snap
    FROM public.get_monthly_cogs(2026, NULL) c
  LOOP
    RAISE NOTICE '   ------------------------------------------------------------';
    RAISE NOTICE '   2026 total: snapshot % -> now % | moved %',
      r.snap, r.total, round(r.total - r.snap,2);
    RAISE NOTICE '   expected: 4045.10 (main) + 409.27 (these 9) = %',
      round(4045.10 + 409.27,2);
    IF round(r.total - r.snap,2) = round(4045.10 + 409.27,2) THEN
      RAISE NOTICE '   >>> MATCHES TO THE CENT.';
    ELSE
      RAISE NOTICE '   >>> differs by % -- October keeps posting, so a small',
        round((r.total - r.snap) - (4045.10 + 409.27),2);
      RAISE NOTICE '   >>> drift in month 10/11 is expected; check those rows.';
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. PHASE CONTROLS ############';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  FOR r IN
    SELECT s.val_a AS claw_was, s.val_b AS sales_was, s.val_c AS rows_was,
           (SELECT round(sum(abs(COALESCE(sales,0))),2)
              FROM public.financial_events_cache
             WHERE user_id = v_uid AND event_date >= '2026-01-01'
               AND event_date < '2027-01-01') AS sales_now,
           (SELECT count(*)::numeric FROM public.financial_events_cache
             WHERE user_id = v_uid AND event_date >= '2026-01-01'
               AND event_date < '2027-01-01') AS rows_now
    FROM public.collapsed_preapply_snapshot s WHERE s.kind = 'fec'
  LOOP
    RAISE NOTICE '   financial_events_cache';
    RAISE NOTICE '      clawback % -> % | %', r.claw_was, v_claw,
      CASE WHEN r.claw_was = v_claw THEN 'UNCHANGED' ELSE '>>> MOVED' END;
    RAISE NOTICE '      sales    % -> % | %', r.sales_was, r.sales_now,
      CASE WHEN r.sales_was = r.sales_now THEN 'UNCHANGED'
           ELSE 'moved (new orders posting)' END;
    RAISE NOTICE '      rows     % -> %', r.rows_was, r.rows_now;
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '   nine-month applied NET: -1765.91 | clawback magnitude: %', v_claw;
  IF v_claw = 2046.17 THEN
    RAISE NOTICE '   >>> CLAWBACK TOTAL CONFIRMED UNCHANGED.';
  ELSE
    RAISE NOTICE '   >>> clawback not 2046.17. INVESTIGATE before proceeding.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   verdicts now on file for these 9:';
  FOR r IN
    SELECT k.outcome, count(*) AS n
    FROM public.collapsed_repair_backup_9 b
    JOIN public.collapsed_order_checks k ON k.sales_order_id = b.id
    GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '      % | %', rpad(r.outcome,24), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- this report wrote nothing.';
END
$p$;
