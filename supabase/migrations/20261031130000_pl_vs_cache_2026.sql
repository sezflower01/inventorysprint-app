-- DOES THE ON-SCREEN P&L COUNT EVERY DOLLAR IN THE CACHE? -- READ ONLY. 2026 ONLY.
--
-- Scope: 2026. Nothing here looks at 2025 and nothing is written.
--
-- The P&L screen reads get_monthly_pl_breakdown, which does NOT simply total
-- financial_events_cache. It applies three transforms, and each one can drop or
-- reshape money:
--
--   1. an event_type GATE -- `sales` counts only on event_type='shipment',
--      `refunds` only on 'refund', and shipping_credits / gift_wrap_credits /
--      promotional_rebates only on 'shipment'. Money in those columns on any
--      other event_type is silently dropped from the report.
--   2. NETTING -- referral_fees is ABS(SUM(signed)), i.e. netted first then
--      made positive; reimbursements, other_income and other_fees are summed
--      SIGNED. Every other column is SUM(ABS(per row)).
--   3. a MARKETPLACE filter -- 'US' admits NULL/US/UNKNOWN; 'ALL' (the screen's
--      default, p_marketplace = null) admits everything.
--
-- So "the RPC differs from the cache" has a precise meaning: compare what the
-- RPC returns against the face magnitude of every row in the cache, per month,
-- per column, and attribute each difference to the transform that caused it.
-- The RPC is called with p_marketplace = NULL, which is what the screen sends
-- by default, so any difference found here is NOT a marketplace filter effect.
--
-- Classification follows src/lib/profitloss/plModel.ts exactly -- INCOME_ROWS,
-- EXPENSE_ROWS, and the columns with NO RowDef at all (which reach no total).
DO $p$
DECLARE
  r record; v_uid uuid; v_n int;
  v_net_rpc numeric; v_net_face numeric; v_tot_rpc numeric := 0; v_tot_face numeric := 0;
  -- plModel INCOME_ROWS, expanded to the raw columns behind them.
  -- The RPC's single `reimbursements` output merges three raw columns.
  v_income text[] := ARRAY[
    'sales','reimbursements','reversal_reimbursement','free_replacement_refund_items',
    'shipping_credits','gift_wrap_credits','promotional_rebate_refunds',
    'restocking_fee','other_income','liquidations','warehouse_lost',
    'warehouse_damage','shipping_chargeback_refund'];
  -- plModel EXPENSE_ROWS.
  v_expense text[] := ARRAY[
    'referral_fees','variable_closing_fees','fixed_closing_fees','fba_fees',
    'fba_customer_return_fees','fba_inbound_fees','fba_inbound_convenience_fee',
    'fba_storage_fees','fba_removal_fees','fba_disposal_fees',
    'fba_long_term_storage_fees','digital_services_fee','other_fees',
    'liquidations_brokerage_fee','re_commerce_grading_charge','hrr_non_apparel',
    'compensated_clawback','shipping_chargeback','refunds',
    'shipping_credit_refunds','gift_wrap_credit_refunds','promotional_rebates'];
  -- columns the RPC returns but no RowDef reads, plus the tax memo rows.
  -- These are NOT part of Net Profit by design.
  v_notprofit text[] := ARRAY[
    'sales_tax_collected','marketplace_facilitator_tax','sales_tax_refunds',
    'marketplace_facilitator_tax_refunds','intl_markets','fbm_shipping_label_fee'];
  -- the five columns the event_type gate applies to, and the type it admits
  v_gated text[] := ARRAY['sales','refunds','shipping_credits',
    'gift_wrap_credits','promotional_rebates'];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  -- what the RPC returns, as jsonb so 42 columns need no hand-typing
  ------------------------------------------------------------------
  CREATE TEMP TABLE pl_rpc ON COMMIT DROP AS
  SELECT t.month_num AS m, to_jsonb(t) AS j
  FROM public.get_monthly_pl_breakdown(2026, NULL) t;

  SELECT count(*) INTO v_n FROM pl_rpc;
  RAISE NOTICE '== impersonation check: RPC returned % months ==', v_n;
  SELECT round(sum((j->>'sales')::numeric),2) INTO v_net_rpc FROM pl_rpc;
  RAISE NOTICE '   2026 sales per the RPC: %  (0.00 would mean auth.uid() did not resolve)',
    v_net_rpc;
  IF COALESCE(v_net_rpc,0) = 0 THEN
    RAISE NOTICE '   >>> STOP: impersonation failed, every figure below would be a zero.';
    RETURN;
  END IF;

  ------------------------------------------------------------------
  -- the cache at face value: magnitude and signed, per month per column
  ------------------------------------------------------------------
  CREATE TEMP TABLE cache_tot ON COMMIT DROP AS
  SELECT EXTRACT(MONTH FROM t.event_date)::int AS m,
         e.k AS col,
         sum(abs(e.v::numeric)) AS magn,
         sum(e.v::numeric)      AS signed
  FROM public.financial_events_cache t,
       LATERAL jsonb_each_text(to_jsonb(t)) AS e(k,v)
  WHERE t.user_id = v_uid
    AND t.event_date >= '2026-01-01' AND t.event_date < '2027-01-01'
    AND e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
    AND e.k NOT IN ('id','quantity')
  GROUP BY 1,2;

  ------------------------------------------------------------------
  -- 1. EVERY column/month where the RPC differs from the cache
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 1. RPC vs CACHE FACE VALUE, by month and column ############';
  RAISE NOTICE '   (p_marketplace = NULL, so no marketplace filter is in play)';
  RAISE NOTICE '   month | column                        |      RPC |     cache |     diff | cause';
  FOR r IN
    SELECT c.m, c.col, round(c.magn,2) AS magn, c.signed,
           round(COALESCE((p.j->>c.col)::numeric, 0),2) AS rpc
    FROM cache_tot c
    JOIN pl_rpc p ON p.m = c.m
    WHERE (c.col = ANY(v_income) OR c.col = ANY(v_expense))
      AND round(c.magn,2) <> round(COALESCE((p.j->>c.col)::numeric, 0),2)
      AND c.col <> 'reimbursements'   -- merged output, handled on its own below
    ORDER BY c.m, c.col
  LOOP
    RAISE NOTICE '   %  | % | % | % | % | %',
      lpad(r.m::text,5), rpad(r.col,29), lpad(r.rpc::text,8),
      lpad(r.magn::text,9), lpad(round(r.magn - r.rpc,2)::text,8),
      CASE WHEN r.col = ANY(v_gated) THEN 'event_type gate'
           WHEN r.col IN ('referral_fees') THEN 'ABS(net) vs sum(ABS)'
           WHEN r.col IN ('other_income','other_fees') THEN 'signed sum'
           ELSE 'UNEXPLAINED -- investigate' END;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   none -- every classified column matches the cache exactly';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   the merged Reimbursements row (RPC = signed reimbursements';
  RAISE NOTICE '   + ABS(reversal) + ABS(free replacement)):';
  RAISE NOTICE '   month |   RPC row | cache signed+ABS+ABS | cache all-magnitude | diff';
  FOR r IN
    SELECT p.m,
           round((p.j->>'reimbursements')::numeric,2) AS rpc,
           round(COALESCE(sum(CASE WHEN c.col='reimbursements' THEN c.signed END),0)
               + COALESCE(sum(CASE WHEN c.col='reversal_reimbursement' THEN c.magn END),0)
               + COALESCE(sum(CASE WHEN c.col='free_replacement_refund_items' THEN c.magn END),0),2) AS repro,
           round(COALESCE(sum(CASE WHEN c.col IN ('reimbursements','reversal_reimbursement',
                 'free_replacement_refund_items') THEN c.magn END),0),2) AS face
    FROM pl_rpc p
    LEFT JOIN cache_tot c ON c.m = p.m
    GROUP BY p.m, p.j ORDER BY p.m
  LOOP
    IF r.rpc <> 0 OR r.face <> 0 THEN
      RAISE NOTICE '   %  | % | % | % | %',
        lpad(r.m::text,5), lpad(r.rpc::text,9), lpad(r.repro::text,20),
        lpad(r.face::text,19), lpad(round(r.face - r.rpc,2)::text,8);
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- 2. attribute the gate: where does the dropped money sit?
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. WHAT THE event_type GATE DROPS, 2026 ############';
  RAISE NOTICE '   column            | event_type held on | rows |  magnitude | counted?';
  FOR r IN
    SELECT c.col, f.event_type AS et, count(*) AS rows,
           round(sum(abs(CASE c.col
             WHEN 'sales' THEN f.sales
             WHEN 'refunds' THEN f.refunds
             WHEN 'shipping_credits' THEN f.shipping_credits
             WHEN 'gift_wrap_credits' THEN f.gift_wrap_credits
             WHEN 'promotional_rebates' THEN f.promotional_rebates END)),2) AS magn
    FROM public.financial_events_cache f
    CROSS JOIN LATERAL unnest(v_gated) AS c(col)
    WHERE f.user_id = v_uid
      AND f.event_date >= '2026-01-01' AND f.event_date < '2027-01-01'
      AND COALESCE(abs(CASE c.col
             WHEN 'sales' THEN f.sales
             WHEN 'refunds' THEN f.refunds
             WHEN 'shipping_credits' THEN f.shipping_credits
             WHEN 'gift_wrap_credits' THEN f.gift_wrap_credits
             WHEN 'promotional_rebates' THEN f.promotional_rebates END),0) > 0
    GROUP BY 1,2 ORDER BY 1, 4 DESC
  LOOP
    RAISE NOTICE '   % | % | % | % | %',
      rpad(r.col,17), rpad(COALESCE(r.et,'(null)'),18), lpad(r.rows::text,4),
      lpad(r.magn::text,10),
      CASE WHEN (r.col IN ('sales','shipping_credits','gift_wrap_credits',
                           'promotional_rebates') AND r.et = 'shipment')
             OR (r.col = 'refunds' AND r.et = 'refund')
           THEN 'YES' ELSE '>>> DROPPED' END;
  END LOOP;

  ------------------------------------------------------------------
  -- 3. net profit: what the screen shows vs every dollar in the cache
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. NET PROFIT, screen vs cache face value ############';
  RAISE NOTICE '   plModel: Net = INCOME_ROWS - EXPENSE_ROWS (COGS and tax sit outside)';
  RAISE NOTICE '   month | net per RPC | net at face value |      diff';
  FOR r IN
    SELECT p.m,
           -- as the screen computes it, from the RPC's own outputs
           round(
             (SELECT COALESCE(sum((p.j->>k)::numeric),0) FROM unnest(ARRAY[
                'sales','reimbursements','shipping_credits','gift_wrap_credits',
                'promotional_rebate_refunds','restocking_fee','other_income',
                'liquidations','warehouse_lost','warehouse_damage',
                'shipping_chargeback_refund']) AS k)
           - (SELECT COALESCE(sum((p.j->>k)::numeric),0) FROM unnest(v_expense) AS k)
           ,2) AS net_rpc,
           -- every classified dollar in the cache, at face magnitude
           round(COALESCE(sum(CASE WHEN c.col = ANY(v_income)  THEN  c.magn
                                   WHEN c.col = ANY(v_expense) THEN -c.magn
                                   ELSE 0 END),0),2) AS net_face
    FROM pl_rpc p
    LEFT JOIN cache_tot c ON c.m = p.m
    GROUP BY p.m, p.j ORDER BY p.m
  LOOP
    IF r.net_rpc <> 0 OR r.net_face <> 0 THEN
      RAISE NOTICE '   %  | % | % | %',
        lpad(r.m::text,5), lpad(r.net_rpc::text,11), lpad(r.net_face::text,17),
        lpad(round(r.net_face - r.net_rpc,2)::text,9);
      v_tot_rpc  := v_tot_rpc + r.net_rpc;
      v_tot_face := v_tot_face + r.net_face;
    END IF;
  END LOOP;
  RAISE NOTICE '   ----------------------------------------------------------';
  RAISE NOTICE '   2026 | % | % | %',
    lpad(round(v_tot_rpc,2)::text,11), lpad(round(v_tot_face,2)::text,17),
    lpad(round(v_tot_face - v_tot_rpc,2)::text,9);
  RAISE NOTICE '   NOTE: "face value" is a DIAGNOSTIC, not a better P&L. The gate';
  RAISE NOTICE '   exists on purpose -- a refund row carrying a sales figure would';
  RAISE NOTICE '   double-count revenue. A non-zero diff says only: money in these';
  RAISE NOTICE '   columns sits on an event_type the report does not read.';

  ------------------------------------------------------------------
  -- 4. columns no RowDef reads -- money the report cannot show at all
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. CACHE MONEY WITH NO P&L ROW AT ALL, 2026 ############';
  FOR r IN
    SELECT c.col, round(sum(c.magn),2) AS magn, count(*) FILTER (WHERE c.magn <> 0) AS months
    FROM cache_tot c
    WHERE NOT (c.col = ANY(v_income)) AND NOT (c.col = ANY(v_expense))
      AND c.col NOT IN ('user_id','event_date','amazon_order_id','asin',
                        'seller_sku','event_type','marketplace','currency_code',
                        'created_at','updated_at','posted_at')
    GROUP BY 1 HAVING round(sum(c.magn),2) <> 0
    ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % | % months | %', rpad(r.col,36), lpad(r.magn::text,12),
      lpad(r.months::text,2),
      CASE WHEN r.col = ANY(v_notprofit) THEN 'excluded by design (memo/informational)'
           ELSE '>>> NO RowDef -- reaches no total' END;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none'; END IF;

  ------------------------------------------------------------------
  -- 5. marketplace exposure: what a US filter would drop
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 5. WHAT THE "US" FILTER DROPS (the screen defaults to ALL) ############';
  FOR r IN
    SELECT COALESCE(upper(marketplace),'(NULL)') AS mp, count(*) AS rows,
           round(sum(abs(COALESCE(sales,0))),2) AS sales
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % rows | sales % | %', rpad(r.mp,10), lpad(r.rows::text,7),
      lpad(r.sales::text,12),
      CASE WHEN r.mp IN ('(NULL)','US','UNKNOWN') THEN 'kept by US filter'
           ELSE 'dropped by US filter' END;
  END LOOP;

  ------------------------------------------------------------------
  -- 6. units_missing_cost per month, and what it is worth
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 6. units_missing_cost BY MONTH, 2026 ############';
  RAISE NOTICE '   month |    COGS | units | costed | MISSING | avg costed | est. missing COGS';
  v_tot_face := 0;
  FOR r IN
    SELECT month_num AS m, round(cogs,2) AS cogs, units_sold AS u,
           units_with_cost AS uc, units_missing_cost AS um,
           orders_missing_cost AS om, asins_missing_cost AS am
    FROM public.get_monthly_cogs(2026, NULL)
    ORDER BY month_num
  LOOP
    IF r.u > 0 OR r.um > 0 THEN
      RAISE NOTICE '   %  | % | % | % | % | % | %',
        lpad(r.m::text,5), lpad(r.cogs::text,7), lpad(r.u::text,5),
        lpad(r.uc::text,6), lpad(r.um::text,7),
        lpad(CASE WHEN r.uc > 0 THEN round(r.cogs / r.uc,2)::text ELSE '-' END,10),
        lpad(CASE WHEN r.uc > 0 THEN round(r.um * (r.cogs / r.uc),2)::text
                  ELSE 'unknown' END,17);
      IF r.uc > 0 THEN v_tot_face := v_tot_face + round(r.um * (r.cogs / r.uc),2); END IF;
    END IF;
  END LOOP;
  RAISE NOTICE '   -------------------------------------------------------------------';
  RAISE NOTICE '   2026 estimated COGS missing from the P&L: % (uncosted units priced',
    round(v_tot_face,2);
  RAISE NOTICE '     at their own month''s average costed unit -- an ESTIMATE, not a fact)';
  RAISE NOTICE '   Every uncosted unit is currently reported at 100 pct gross margin,';
  RAISE NOTICE '   so Net Profit is OVERSTATED by whatever those units really cost.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, nothing fired.';
END
$p$;
