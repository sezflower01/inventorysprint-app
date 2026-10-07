-- STEP 1c: the same rule, applied to the rest of the app.
--
-- Already backed up by 20261007250000 (all 321 rows, the remainder tagged
-- app_wide_remainder). The cohort pass moved Rule A from $36,597.24 to
-- $32,586.51 and left Rule B at $28,926.16 exactly as predicted, so the rule
-- behaves the way the measurement said it would.
--
-- Same restraint: only is_cancelled, cancelled_at and status_source move.
UPDATE public.sales_orders so
SET is_cancelled = true,
    cancelled_at = COALESCE(so.cancelled_at, now()),
    status_source = COALESCE(so.status_source, 'cancelled_flag_backfill_20261007')
WHERE so.order_status IN ('Canceled', 'Cancelled')
  AND COALESCE(so.is_cancelled, false) = false
  AND so.order_id NOT LIKE '%-REFUND';

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO n FROM public.sales_orders
  WHERE order_status IN ('Canceled','Cancelled')
    AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND';
  RAISE NOTICE '== rows anywhere still Canceled-but-unflagged: % (must be 0) ==', n;

  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled, so.order_status,
             so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0)=0
        AND COALESCE(so.estimated_price,0)>0 AND so.order_id NOT LIKE '%-REFUND'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false)::numeric,2) AS rule_a,
           round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false
                 AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled'))::numeric,2) AS rule_b
    FROM base
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   Rule A $%  (started $36597.24, total -$%)',
      r.rule_a, round((36597.24 - r.rule_a)::numeric,2);
    RAISE NOTICE '   Rule B $%  (started $28926.16)', r.rule_b;
    RAISE NOTICE '   the two rules now agree: %', (r.rule_a = r.rule_b);
  END LOOP;

  FOR r IN SELECT count(*) AS rows, round(sum(sales)::numeric,2) AS sales,
                  round(sum(refunds)::numeric,2) AS refunds
           FROM public.financial_events_cache WHERE user_id = v_uid LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   P&L now  % rows | sales $% | refunds $%', r.rows, r.sales, r.refunds;
    RAISE NOTICE '   P&L base 120429 rows | sales $2463045.47 | refunds $111143.09';
  END LOOP;
END
$p$;
