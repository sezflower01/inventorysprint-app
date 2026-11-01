-- WHY THE FEE-RATIO SIGNAL FINDS NOTHING -- READ ONLY. 2026 ONLY.
--
-- 20261031141000 measured something that needs explaining before any fix is
-- proposed: of 215 quantity=1 collapsed orders, the FBA-fee ratio the repair
-- sweep looks for fires on ZERO of them. The sweep's own header expected the
-- opposite -- it was built on the premise that "Revenue kept one item, fees
-- cover N".
--
-- The likely reason is that the collapse overwrote the FEE as well as the
-- quantity, so fba_fee holds one unit's fee and the ratio sits near 1 instead
-- of near N. If so the detector is not merely weak, it is structurally doomed:
-- the same write that creates the defect destroys the signal it is detected by.
--
-- It also decides the SCOPE of any backfill. If fees were overwritten too, then
-- correcting quantity alone would leave fees understated and swing profit the
-- other way.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  CREATE TEMP TABLE cand ON COMMIT DROP AS
  WITH so AS (
    SELECT s.id, s.order_id, s.asin, s.order_date, s.quantity AS stored_qty,
           s.sold_price, s.fba_fee, s.referral_fee, s.total_sale_amount
    FROM public.sales_orders s
    WHERE s.user_id = v_uid
      AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status,'') NOT IN ('Canceled','Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND upper(COALESCE(s.marketplace,'US')) IN ('US','UNKNOWN')
      AND COALESCE(s.sold_price,0) > 0
  ),
  one_line AS (SELECT order_id FROM so GROUP BY order_id HAVING count(*) = 1),
  fec AS (
    SELECT amazon_order_id AS order_id,
           round(sum(abs(COALESCE(sales,0))),2)         AS amz_money,
           round(sum(abs(COALESCE(fba_fees,0))),2)      AS amz_fba,
           round(sum(abs(COALESCE(referral_fees,0))),2) AS amz_ref
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
      AND event_type = 'shipment' AND amazon_order_id IS NOT NULL
    GROUP BY amazon_order_id
  )
  SELECT so.*, f.amz_money, f.amz_fba, f.amz_ref,
         round(f.amz_money / so.sold_price) AS implied_qty
  FROM so
  JOIN one_line ol ON ol.order_id = so.order_id
  JOIN fec f       ON f.order_id  = so.order_id
  WHERE f.amz_money / so.sold_price > so.stored_qty + 0.5
    AND abs(f.amz_money / so.sold_price
            - round(f.amz_money / so.sold_price)) <= 0.02;

  RAISE NOTICE '== 1. does our stored fba_fee cover 1 unit or N? ==';
  RAISE NOTICE '   our fba_fee / Amazon''s fba_fees for the same order';
  RAISE NOTICE '   bucket                      | orders';
  FOR r IN
    SELECT CASE WHEN COALESCE(amz_fba,0) = 0 THEN 'Amazon billed no FBA fee'
                WHEN fba_fee / amz_fba <= 0.15 THEN 'ours <= 15 pct  (1 of many)'
                WHEN fba_fee / amz_fba <= 0.60 THEN 'ours 15-60 pct'
                WHEN fba_fee / amz_fba <= 0.95 THEN 'ours 60-95 pct'
                WHEN fba_fee / amz_fba <= 1.05 THEN 'ours ~= Amazon (covers N)'
                ELSE 'ours > Amazon' END AS bucket,
           count(*) AS n
    FROM cand GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '   % | %', rpad(r.bucket,27), lpad(r.n::text,6); END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. totals: what we stored vs what Amazon billed ==';
  FOR r IN
    SELECT count(*) AS n,
           round(sum(COALESCE(fba_fee,0))::numeric,2)     AS our_fba,
           round(sum(COALESCE(amz_fba,0)),2)              AS amz_fba,
           round(sum(COALESCE(referral_fee,0))::numeric,2) AS our_ref,
           round(sum(COALESCE(amz_ref,0)),2)              AS amz_ref,
           round(sum(COALESCE(sold_price,0) * stored_qty)::numeric,2) AS our_rev,
           round(sum(COALESCE(amz_money,0)),2)            AS amz_rev
    FROM cand
  LOOP
    RAISE NOTICE '   % orders', r.n;
    RAISE NOTICE '   revenue      ours % | Amazon % | short %',
      lpad(r.our_rev::text,10), lpad(r.amz_rev::text,10),
      lpad(round(r.amz_rev - r.our_rev,2)::text,9);
    RAISE NOTICE '   FBA fees     ours % | Amazon % | short %',
      lpad(r.our_fba::text,10), lpad(r.amz_fba::text,10),
      lpad(round(r.amz_fba - r.our_fba,2)::text,9);
    RAISE NOTICE '   referral     ours % | Amazon % | short %',
      lpad(r.our_ref::text,10), lpad(r.amz_ref::text,10),
      lpad(round(r.amz_ref - r.our_ref,2)::text,9);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 3. so what does the P&L actually use? ==';
  RAISE NOTICE '   The P&L reads financial_events_cache for BOTH revenue and';
  RAISE NOTICE '   fees -- i.e. Amazon''s column above -- so none of the three';
  RAISE NOTICE '   shortfalls touch it. COGS is the single exception, because';
  RAISE NOTICE '   get_monthly_cogs multiplies sales_orders.quantity.';
  RAISE NOTICE '   Per-order ROI screens read sales_orders and are wrong on all';
  RAISE NOTICE '   three.';
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written, no API called.';
END
$p$;
