-- READ-ONLY AUDIT. Account-wide 2026 version of the B0CKJNCZLY check.
--
-- IMPORTANT DISTINCTION, established before counting anything: the P&L is built
-- by get_monthly_pl_breakdown from financial_events_cache -- Amazon's own
-- settlement data -- not from sales_orders. So the artefacts below do NOT move
-- the year-end P&L total. What they corrupt is every PER-ASIN judgement: the
-- reorder card, ROI, Need to Buy Again, inventory valuation. That is where a
-- $0-revenue row with full fees charged turns a 48% winner into a reported
-- loss, as it did on B0CKJNCZLY.
--
-- Artefact classes, each counted with its dollar weight:
--   Z  sold_price <= 0 while fees were charged  (price-resolver zero-fallback)
--   R  "-REFUND" rows, which carry negative prices and are not sales
--   D  a -REFUND row AND refund_amount on the parent -> refunds counted twice
--   C  no cost at sale -> ROI incomputable, profit overstated
--   F  fees missing or flagged invalid

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE _s ON COMMIT DROP AS
  SELECT
    order_id, asin, quantity, order_date, fulfillment_channel,
    sold_price, total_sale_amount, total_fees, shipping_label_fee,
    COALESCE(unit_cost_at_sale, unit_cost) AS unit_cost,
    refund_quantity, refund_amount, fees_source, price_source,
    (order_id LIKE '%-REFUND') AS is_refund_row,
    (COALESCE(sold_price, 0) <= 0 AND order_id NOT LIKE '%-REFUND') AS zero_priced,
    (COALESCE(unit_cost_at_sale, unit_cost, 0) <= 0) AS no_cost,
    (COALESCE(total_fees, 0) <= 0 AND order_id NOT LIKE '%-REFUND') AS no_fees
  FROM public.sales_orders
  WHERE user_id = v_uid AND order_date >= '2026-01-01'
    AND COALESCE(is_cancelled, false) = false;

  RAISE NOTICE '== scale ==';
  FOR r IN SELECT count(*) AS rows, count(DISTINCT asin) AS asins, sum(quantity) AS units FROM _s LOOP
    RAISE NOTICE '  % rows | % ASINs | % units', r.rows, r.asins, r.units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== artefact Z: sold_price <= 0 but fees charged ==';
  FOR r IN SELECT count(*) AS rows, count(DISTINCT asin) AS asins, sum(quantity) AS units,
                  round(sum(COALESCE(total_fees, 0))::numeric, 2) AS fees_charged
           FROM _s WHERE zero_priced LOOP
    RAISE NOTICE '  % rows across % ASINs | % units | $% of fees charged against no revenue',
      r.rows, r.asins, r.units, r.fees_charged;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== artefact Z by price_source (who writes the zero?) ==';
  FOR r IN SELECT COALESCE(price_source, '(none)') AS src, count(*) AS rows,
                  round(sum(COALESCE(total_fees, 0))::numeric, 2) AS fees
           FROM _s WHERE zero_priced GROUP BY 1 ORDER BY 2 DESC LIMIT 8 LOOP
    RAISE NOTICE '  % : % rows, $% fees', r.src, r.rows, r.fees;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== artefact R: -REFUND rows ==';
  FOR r IN SELECT count(*) AS rows, count(DISTINCT asin) AS asins,
                  round(sum(COALESCE(sold_price, 0))::numeric, 2) AS negative_revenue,
                  round(sum(COALESCE(refund_amount, 0))::numeric, 2) AS refund_amt
           FROM _s WHERE is_refund_row LOOP
    RAISE NOTICE '  % rows across % ASINs | $% negative revenue | $% refund_amount',
      r.rows, r.asins, r.negative_revenue, r.refund_amt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== artefact D: refunds counted twice (REFUND row AND parent refund_amount) ==';
  FOR r IN
    SELECT count(*) AS pairs, round(sum(p.refund_amount)::numeric, 2) AS double_counted
    FROM _s rr
    JOIN _s p ON p.order_id = replace(rr.order_id, '-REFUND', '')
    WHERE rr.is_refund_row AND COALESCE(p.refund_amount, 0) > 0 LOOP
    RAISE NOTICE '  % order(s) have both | $% at risk of double counting', r.pairs, r.double_counted;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== artefact C and F: missing cost / missing fees (real sales only) ==';
  FOR r IN SELECT
             count(*) FILTER (WHERE no_cost) AS no_cost_rows,
             count(DISTINCT asin) FILTER (WHERE no_cost) AS no_cost_asins,
             round(sum(COALESCE(total_sale_amount, sold_price * quantity)) FILTER (WHERE no_cost)::numeric, 2) AS no_cost_revenue,
             count(*) FILTER (WHERE no_fees) AS no_fee_rows,
             round(sum(COALESCE(total_sale_amount, sold_price * quantity)) FILTER (WHERE no_fees)::numeric, 2) AS no_fee_revenue
           FROM _s WHERE NOT is_refund_row AND NOT zero_priced LOOP
    RAISE NOTICE '  no cost: % rows / % ASINs / $% revenue', r.no_cost_rows, r.no_cost_asins, r.no_cost_revenue;
    RAISE NOTICE '  no fees: % rows / $% revenue', r.no_fee_rows, r.no_fee_revenue;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the damage: ASINs reported at a loss that are profitable once cleaned ==';
  FOR r IN
    WITH per AS (
      SELECT asin,
             sum(CASE WHEN is_refund_row THEN 0 ELSE COALESCE(total_sale_amount, sold_price * quantity) END) AS rev_raw,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0
                      ELSE COALESCE(total_sale_amount, sold_price * quantity) END) AS rev_clean,
             sum(CASE WHEN is_refund_row THEN 0 ELSE COALESCE(total_fees, 0) END) AS fees_raw,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE COALESCE(total_fees, 0) END) AS fees_clean,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0
                      ELSE COALESCE(unit_cost, 0) * quantity END) AS cogs_clean,
             sum(CASE WHEN is_refund_row THEN 0 ELSE COALESCE(unit_cost, 0) * quantity END) AS cogs_raw,
             sum(COALESCE(refund_amount, 0)) AS refunds,
             sum(CASE WHEN is_refund_row OR zero_priced THEN 0 ELSE quantity END) AS units_clean,
             count(*) FILTER (WHERE zero_priced) AS zero_rows
      FROM _s GROUP BY asin)
    SELECT asin, units_clean, zero_rows,
           round((rev_raw - fees_raw - cogs_raw - refunds)::numeric, 2) AS profit_raw,
           round((rev_clean - fees_clean - cogs_clean - refunds)::numeric, 2) AS profit_clean,
           round(((rev_clean - fees_clean - cogs_clean - refunds)
                  - (rev_raw - fees_raw - cogs_raw - refunds))::numeric, 2) AS understated_by
    FROM per
    WHERE zero_rows > 0
      AND (rev_raw - fees_raw - cogs_raw - refunds) < 0
      AND (rev_clean - fees_clean - cogs_clean - refunds) > 0
    ORDER BY 6 DESC LIMIT 15
  LOOP
    RAISE NOTICE '  % | % units | % zero rows | reported $% -> cleaned $% (understated by $%)',
      r.asin, r.units_clean, r.zero_rows, r.profit_raw, r.profit_clean, r.understated_by;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== account-wide understatement from the zero rows alone ==';
  FOR r IN SELECT round(sum(COALESCE(total_fees, 0))::numeric, 2) AS fees_wrongly_charged
           FROM _s WHERE zero_priced LOOP
    RAISE NOTICE '  $% of fees sit against zero revenue in per-ASIN profit', r.fees_wrongly_charged;
  END LOOP;
END
$p$;
