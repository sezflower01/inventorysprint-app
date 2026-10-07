-- STEP 1a: back up every row we are about to touch, and measure the BEFORE.
-- This migration makes NO change to sales_orders.
--
-- The set: orders Amazon told us were cancelled -- order_status 'Canceled' --
-- where is_cancelled is still false. sync-order-status-updates writes
-- order_status and nothing else, so the flag never moved.
--
-- TWO FILTER RULES EXIST IN THE APP, and the size of this fix depends entirely
-- on which surface you are looking at:
--
--   Rule A  is_cancelled only
--           LiveSalesPopup.tsx:309, PeriodStatsBlocks.tsx:623,
--           MissingCogsReview.tsx:98, AwaitingVerificationDialog.tsx:95
--           -> these DO count the affected orders today
--   Rule B  is_cancelled OR order_status in (Canceled, Cancelled)
--           MobileLiveSales.tsx:1023-1025, MissingMoneyDrilldown.tsx:49
--           -> these already exclude them
--
-- So setting the flag changes Rule A surfaces and leaves Rule B unchanged.
-- Both numbers are printed below rather than one headline, because claiming the
-- whole figure as a win would be false for half the app.

CREATE TABLE IF NOT EXISTS public.backup_cancelled_flag_20261007 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);

COMMENT ON TABLE public.backup_cancelled_flag_20261007 IS
  'Full pre-change snapshot of sales_orders rows whose is_cancelled was set true on 2026-10-07 because order_status already said Canceled. Restore with: UPDATE sales_orders SET is_cancelled = (row_data->>''is_cancelled'')::boolean FROM backup_cancelled_flag_20261007 b WHERE sales_orders.id = (b.row_data->>''id'')::uuid;';

INSERT INTO public.backup_cancelled_flag_20261007 (reason, row_data)
SELECT
  CASE WHEN so.order_date <= current_date - 90 THEN 'cohort_165' ELSE 'app_wide_remainder' END,
  to_jsonb(so)
FROM public.sales_orders so
WHERE so.order_status IN ('Canceled', 'Cancelled')
  AND COALESCE(so.is_cancelled, false) = false
  AND so.order_id NOT LIKE '%-REFUND';

DO $p$
DECLARE r record; n int;
BEGIN
  SELECT count(*) INTO n FROM public.backup_cancelled_flag_20261007;
  RAISE NOTICE '== BACKUP: % rows saved to backup_cancelled_flag_20261007 ==', n;

  FOR r IN SELECT reason, count(*) AS rows FROM public.backup_cancelled_flag_20261007
           GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '   % | % rows', rpad(r.reason, 20), r.rows;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE: estimated revenue these rows contribute, by filter rule ==';
  FOR r IN
    WITH affected AS (
      SELECT so.*,
             CASE WHEN so.order_date <= current_date - 90 THEN 'cohort_165'
                  ELSE 'app_wide_remainder' END AS grp,
             so.estimated_price * GREATEST(so.quantity, 1)
               / COALESCE(fx.rate, 1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx
        ON fx.base = 'USD'
       AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
                        WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN'
                        WHEN 'BR' THEN 'BRL' END
      WHERE so.order_status IN ('Canceled','Cancelled')
        AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND'
        AND COALESCE(so.sold_price,0) = 0
        AND COALESCE(so.estimated_price,0) > 0
    )
    SELECT grp, count(*) AS orders, sum(GREATEST(quantity,1)) AS units,
           round(sum(usd)::numeric, 2) AS usd_counted
    FROM affected GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders | % units | $% counted TODAY by Rule A surfaces',
      rpad(r.grp, 20), lpad(r.orders::text, 5), lpad(r.units::text, 5), r.usd_counted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   Rule B surfaces (Mobile Live Sales, Missing Money) already exclude';
  RAISE NOTICE '   all of the above, so their totals will NOT move.';

  -- The whole-app estimated-revenue figure, so the change has a denominator.
  RAISE NOTICE '';
  RAISE NOTICE '== context: ALL unsettled estimated revenue, Rule A vs Rule B ==';
  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled, so.order_status,
             so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx
        ON fx.base = 'USD'
       AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
                        WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN'
                        WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
        AND COALESCE(so.sold_price,0) = 0 AND COALESCE(so.estimated_price,0) > 0
        AND so.order_id NOT LIKE '%-REFUND'
    )
    SELECT
      round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false) = false)::numeric, 2) AS rule_a,
      round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false) = false
                               AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled'))::numeric, 2) AS rule_b
    FROM base
  LOOP
    RAISE NOTICE '   Rule A total $%  |  Rule B total $%  |  gap $%',
      r.rule_a, r.rule_b, round((r.rule_a - r.rule_b)::numeric, 2);
  END LOOP;

  -- The P&L reads financial_events_cache only. Record its total now so the
  -- "unchanged" claim after the write is a measurement, not an assertion.
  RAISE NOTICE '';
  RAISE NOTICE '== P&L baseline (financial_events_cache), to compare after the write ==';
  FOR r IN
    SELECT count(*) AS rows, round(sum(sales)::numeric, 2) AS sales,
           round(sum(refunds)::numeric, 2) AS refunds
    FROM public.financial_events_cache
    WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
  LOOP
    RAISE NOTICE '   % rows | sales $% | refunds $%', r.rows, r.sales, r.refunds;
  END LOOP;
END
$p$;
