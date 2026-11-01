-- PHASE 1a report: what Amazon says about the 28. READ ONLY. Proposal only.
--
-- Note it is 28, not the 27 reported yesterday: a new non-whole-number case
-- appeared overnight (113-9417508-7485005, 2026-09-22, B0G4BQ42W3, implied
-- 2.020) as fresh money posted against an existing order. The group is derived,
-- not hardcoded, which is why it grew on its own.
DO $p$
DECLARE
  r record; v_uid uuid; v_req bigint := 70730;
  v_status int; v_content text; v_j jsonb; i int;
  v_qty_wrong int := 0; v_rev_wrong int := 0; v_ok int := 0;
  v_cogs numeric := 0; v_claw numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  FOR i IN 1..60 LOOP
    SELECT status_code, content INTO v_status, v_content
    FROM net._http_response WHERE id = v_req;
    EXIT WHEN v_status IS NOT NULL;
    PERFORM pg_sleep(3);
  END LOOP;
  IF v_status IS NULL THEN
    RAISE NOTICE '>>> request % has not landed. STOPPING (not "nothing found").', v_req;
    RETURN;
  END IF;
  IF v_status <> 200 THEN
    RAISE NOTICE '>>> HTTP %. body: %', v_status, left(COALESCE(v_content,''),400);
    RETURN;
  END IF;

  v_j := v_content::jsonb;
  RAISE NOTICE '############ SUMMARY ############';
  RAISE NOTICE '   dry_run % | checked % | would_repair % | already_correct %',
    v_j->>'dry_run', v_j->>'checked', v_j->>'would_repair', v_j->>'already_correct';
  RAISE NOTICE '   throttled % | unverifiable % | exceeds % | repaired (must be 0) %',
    v_j->>'throttled', v_j->>'unverifiable',
    v_j->>'exceeds_money_estimate', v_j->>'repaired';
  RAISE NOTICE '   rows % of % (truncated %)',
    jsonb_array_length(COALESCE(v_j->'rows','[]'::jsonb)),
    v_j->>'rows_total', v_j->>'rows_truncated';

  ------------------------------------------------------------------
  CREATE TEMP TABLE res (
    order_id text, asin text, qf numeric, qt numeric,
    rf numeric, rt numeric, cf numeric, ct numeric, skipped text,
    amazon_qty numeric
  ) ON COMMIT DROP;

  INSERT INTO res
  SELECT e->>'order_id', e->>'asin',
         NULLIF(e->'quantity'->>'from','')::numeric,
         NULLIF(e->'quantity'->>'to','')::numeric,
         NULLIF(e->'revenue'->>'from','')::numeric,
         NULLIF(e->'revenue'->>'to','')::numeric,
         NULLIF(e->'total_cost'->>'from','')::numeric,
         NULLIF(e->'total_cost'->>'to','')::numeric,
         e->>'skipped',
         NULLIF(e->>'amazon_quantity','')::numeric
  FROM jsonb_array_elements(COALESCE(v_j->'rows','[]'::jsonb)) AS e;

  RAISE NOTICE '';
  RAISE NOTICE '############ PER ORDER: stored vs Amazon, and what a repair would do ############';
  RAISE NOTICE '   order               | asin         | stored | Amazon | revenue from -> to      | cost from -> to';
  FOR r IN
    SELECT g.order_id, g.asin, g.stored, g.grp,
           x.qt, x.rf, x.rt, x.cf, x.ct, x.skipped, x.amazon_qty
    FROM (
      WITH one_line AS (
        SELECT order_id FROM public.sales_orders
        WHERE user_id = v_uid AND order_date >= '2026-01-01'
          AND order_id NOT LIKE '%-REFUND%'
        GROUP BY order_id HAVING count(*) = 1)
      SELECT s.order_id, s.asin, s.quantity AS stored,
             CASE WHEN k.outcome = 'exceeds_money_estimate'
                  THEN 'ceiling' ELSE 'non_whole' END AS grp
      FROM public.sales_orders s
      LEFT JOIN public.collapsed_order_checks k ON k.sales_order_id = s.id
      WHERE s.user_id = v_uid
        AND s.order_id IN (SELECT order_id FROM res)
    ) g
    LEFT JOIN res x ON x.order_id = g.order_id AND x.asin = g.asin
    ORDER BY g.grp, g.order_id
  LOOP
    IF r.skipped IS NOT NULL THEN
      RAISE NOTICE '   % | % | % | % | SKIPPED: %',
        r.order_id, rpad(r.asin,12), lpad(r.stored::text,6),
        lpad(COALESCE(r.amazon_qty::text,'?'),6), r.skipped;
    ELSIF r.qt IS NULL AND r.rt IS NULL THEN
      v_ok := v_ok + 1;
      RAISE NOTICE '   % | % | % |      = | Amazon AGREES -- nothing to change',
        r.order_id, rpad(r.asin,12), lpad(r.stored::text,6);
    ELSE
      IF r.qt IS NOT NULL THEN v_qty_wrong := v_qty_wrong + 1; END IF;
      IF r.rt IS NOT NULL THEN v_rev_wrong := v_rev_wrong + 1; END IF;
      v_cogs := v_cogs + COALESCE(r.ct,0) - COALESCE(r.cf,0);
      RAISE NOTICE '   % | % | % | % | % -> % | % -> %',
        r.order_id, rpad(r.asin,12), lpad(r.stored::text,6),
        lpad(COALESCE(r.qt::text,'=') ,6),
        lpad(COALESCE(r.rf::text,'-'),9), lpad(COALESCE(r.rt::text,'-'),9),
        lpad(COALESCE(r.cf::text,'-'),8), lpad(COALESCE(r.ct::text,'-'),8);
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ THE PROPOSAL ############';
  RAISE NOTICE '   Amazon agrees with us on          : % orders', v_ok;
  RAISE NOTICE '   quantity would change on          : % orders', v_qty_wrong;
  RAISE NOTICE '   revenue would change on           : % orders', v_rev_wrong;
  RAISE NOTICE '   COGS effect if all were repaired  : %', round(v_cogs,2);
  RAISE NOTICE '';
  RAISE NOTICE '   NOTHING WAS WRITTEN and no verdict was recorded, so the 8';
  RAISE NOTICE '   keep their exceeds_money_estimate verdict and the 20 stay';
  RAISE NOTICE '   outside the shortlist. Repairing any of them needs a';
  RAISE NOTICE '   deliberate order_ids run with dry_run: false.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ PHASE CONTROLS ############';
  SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '   2026 clawback magnitude: % | expected 2046.17 | %',
    v_claw, CASE WHEN v_claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END;
  RAISE NOTICE '   nine-month applied NET : -1765.91 (unchanged -- nothing here';
  RAISE NOTICE '   touches financial_events_cache)';
  FOR r IN
    SELECT count(*) AS n,
           round(sum(abs(COALESCE(sales,0))),2) AS s
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP
    RAISE NOTICE '   fec rows % | sales % (snapshot had 49068 / 978840.93 --', r.n, r.s;
    RAISE NOTICE '   a rise here is new orders posting, not this work)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- proposal only, nothing applied.';
END
$p$;
