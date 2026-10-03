-- READ-ONLY EXPORT. Every 2026 ASIN whose per-ASIN profit is distorted by
-- zero-priced sale rows, emitted as pipe-delimited lines for extraction.
--
-- "reported" counts every non-cancelled row as the app's per-ASIN views do.
-- "cleaned" drops the rows whose sold_price <= 0 (fees charged, no revenue) and
-- the -REFUND rows, which are refund records rather than sales. Refunds are
-- subtracted once, from refund_amount.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _s ON COMMIT DROP AS
  SELECT asin, quantity, sold_price, total_sale_amount, total_fees,
         COALESCE(unit_cost_at_sale, unit_cost) AS unit_cost,
         COALESCE(refund_quantity, 0) AS refund_qty,
         COALESCE(refund_amount, 0) AS refund_amt,
         (order_id LIKE '%-REFUND') AS is_refund_row,
         (COALESCE(sold_price, 0) <= 0 AND order_id NOT LIKE '%-REFUND') AS zero_priced
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false;

  FOR r IN
    WITH per AS (
      SELECT asin,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE quantity END) AS units,
             sum(CASE WHEN zero_priced THEN 1 ELSE 0 END) AS zero_rows,
             sum(CASE WHEN zero_priced THEN quantity ELSE 0 END) AS zero_units,
             sum(CASE WHEN zero_priced THEN COALESCE(total_fees, 0) ELSE 0 END) AS orphan_fees,
             sum(CASE WHEN is_refund_row THEN 0 ELSE COALESCE(total_sale_amount, sold_price * quantity) END) AS rev_raw,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE COALESCE(total_sale_amount, sold_price * quantity) END) AS rev_clean,
             sum(CASE WHEN is_refund_row THEN 0 ELSE COALESCE(total_fees, 0) END) AS fees_raw,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE COALESCE(total_fees, 0) END) AS fees_clean,
             sum(CASE WHEN is_refund_row THEN 0 ELSE COALESCE(unit_cost, 0) * quantity END) AS cogs_raw,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE COALESCE(unit_cost, 0) * quantity END) AS cogs_clean,
             sum(refund_amt) AS refunds,
             sum(refund_qty) AS refund_units
      FROM _s GROUP BY asin)
    SELECT asin, units, zero_rows, zero_units,
           round(orphan_fees::numeric, 2) AS orphan_fees,
           round((rev_raw - fees_raw - cogs_raw - refunds)::numeric, 2) AS profit_reported,
           round((rev_clean - fees_clean - cogs_clean - refunds)::numeric, 2) AS profit_cleaned,
           round(refunds::numeric, 2) AS refunds,
           refund_units,
           CASE WHEN units > 0
                THEN round((100.0 * (rev_clean - fees_clean - cogs_clean - refunds) / NULLIF(cogs_clean, 0))::numeric, 1)
                ELSE NULL END AS roi_cleaned_pct
    FROM per
    WHERE zero_rows > 0
    ORDER BY (rev_clean - fees_clean - cogs_clean - refunds) - (rev_raw - fees_raw - cogs_raw - refunds) DESC
  LOOP
    RAISE NOTICE 'ROW|%|%|%|%|%|%|%|%|%|%',
      r.asin, r.units, r.zero_rows, r.zero_units, r.orphan_fees,
      r.profit_reported, r.profit_cleaned, r.refunds, r.refund_units,
      COALESCE(r.roi_cleaned_pct::text, '');
  END LOOP;
END
$p$;
