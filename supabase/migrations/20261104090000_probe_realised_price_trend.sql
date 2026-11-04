-- Is $19.97 a price this ASIN ACHIEVES, or a price it is merely listed at?
-- READ ONLY.
--
-- The buy-again analysis said no, on the grounds that 82 units averaged $14.37
-- against a $19.97 forecast. The seller's objection is that it sells at $19.97
-- NOW, and $14.37 is history. That objection is correct in principle: a
-- twelve-month average is the wrong statistic if the price moved partway
-- through, because old cheap sales drag it down forever.
--
-- So the average is not the thing to look at. The question is the TREND -- what
-- did units actually clear at, month by month, and what are the most recent
-- ones clearing at. If recent months sit near $19.97 the forecast is sound and
-- the purchase is good. If they still sit near $14 then $19.97 is a list price
-- that is not converting, and the average was telling the truth.
--
-- Revenue follows get_asin_profit exactly: non-refund, positively-priced rows,
-- COALESCE(total_sale_amount, sold_price * quantity). sold_price is a UNIT
-- price (see line-total-stored-as-unit-price), so per-unit realised price is
-- revenue / units, never avg(sold_price), which would weight a 3-unit order the
-- same as a 1-unit one.
DO $p$
DECLARE
  r record; v_uid uuid; v_asin text; v_n int;
  v_rev numeric; v_units int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  -- 1. Identify the ASIN from the figures on screen: 82 units and
  --    $1,178.37 of revenue over the trailing year.
  ------------------------------------------------------------------
  SELECT s.asin,
         sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity)) AS rev,
         sum(s.quantity)::int AS units
    INTO v_asin, v_rev, v_units
  FROM public.sales_orders s
  WHERE s.user_id = v_uid
    AND COALESCE(s.is_cancelled, false) = false
    AND s.order_id NOT LIKE '%-REFUND'
    AND COALESCE(s.sold_price, 0) > 0
    AND s.order_date >= current_date - 365
  GROUP BY s.asin
  HAVING sum(s.quantity) BETWEEN 80 AND 84
     AND sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity))
         BETWEEN 1170 AND 1186
  ORDER BY abs(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity)) - 1178.37)
  LIMIT 1;

  IF v_asin IS NULL THEN
    RAISE NOTICE 'No ASIN matches 82 units / $1,178.37 in the trailing year.';
    RAISE NOTICE 'Nothing further can be said without the ASIN -- stopping.';
    RETURN;
  END IF;

  RAISE NOTICE '######## ASIN % ########', v_asin;
  RAISE NOTICE '   trailing year: % units, revenue %, average %',
    v_units, round(v_rev, 2), round(v_rev / NULLIF(v_units, 0), 2);

  ------------------------------------------------------------------
  -- 2. The trend. This is the whole question.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## REALISED PRICE BY MONTH ########';
  RAISE NOTICE '   month   | units | revenue  | per unit | vs 19.97';
  FOR r IN
    SELECT to_char(date_trunc('month', s.order_date), 'YYYY-MM') AS mon,
           sum(s.quantity)::int AS units,
           round(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity)), 2) AS rev,
           round(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity))
                 / NULLIF(sum(s.quantity), 0), 2) AS per_unit
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) > 0
      AND s.order_date >= current_date - 540
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | %  | % | %  | %',
      r.mon, lpad(r.units::text, 5), lpad(r.rev::text, 8),
      lpad(r.per_unit::text, 8),
      lpad(round(r.per_unit - 19.97, 2)::text, 8);
  END LOOP;

  ------------------------------------------------------------------
  -- 3. The most recent units, individually. A monthly average can hide
  --    a split between full-price and discounted sales.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## THE LAST 15 ORDERS ########';
  RAISE NOTICE '   date       | qty | line total | per unit';
  FOR r IN
    SELECT s.order_date, s.quantity,
           round(COALESCE(s.total_sale_amount, s.sold_price * s.quantity), 2) AS line,
           round(COALESCE(s.total_sale_amount, s.sold_price * s.quantity)
                 / NULLIF(s.quantity, 0), 2) AS per_unit
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) > 0
    ORDER BY s.order_date DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '   % | % | % | %',
      r.order_date, lpad(r.quantity::text, 3),
      lpad(r.line::text, 10), lpad(r.per_unit::text, 8);
  END LOOP;

  ------------------------------------------------------------------
  -- 4. The decisive split: last 90 days against the rest of the year.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## RECENT vs EARLIER ########';
  FOR r IN
    SELECT
      sum(s.quantity) FILTER (WHERE s.order_date >= current_date - 90)::int AS u_recent,
      round(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity))
              FILTER (WHERE s.order_date >= current_date - 90)
            / NULLIF(sum(s.quantity) FILTER (WHERE s.order_date >= current_date - 90), 0), 2) AS p_recent,
      sum(s.quantity) FILTER (WHERE s.order_date <  current_date - 90
                                AND s.order_date >= current_date - 365)::int AS u_earlier,
      round(sum(COALESCE(s.total_sale_amount, s.sold_price * s.quantity))
              FILTER (WHERE s.order_date < current_date - 90
                        AND s.order_date >= current_date - 365)
            / NULLIF(sum(s.quantity) FILTER (WHERE s.order_date < current_date - 90
                                               AND s.order_date >= current_date - 365), 0), 2) AS p_earlier
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = v_asin
      AND COALESCE(s.is_cancelled, false) = false
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.sold_price, 0) > 0
  LOOP
    RAISE NOTICE '   last 90 days      : % units at % per unit',
      COALESCE(r.u_recent, 0), COALESCE(r.p_recent, 0);
    RAISE NOTICE '   the 9 months before: % units at % per unit',
      COALESCE(r.u_earlier, 0), COALESCE(r.p_earlier, 0);
    RAISE NOTICE '';
    IF COALESCE(r.u_recent, 0) = 0 THEN
      RAISE NOTICE '   >>> NO sales in the last 90 days. A list price with no';
      RAISE NOTICE '   >>> conversions behind it is not evidence of anything.';
    ELSIF r.p_recent >= 18.50 THEN
      RAISE NOTICE '   >>> Recent units ARE clearing near 19.97. The twelve-month';
      RAISE NOTICE '   >>> average was dragged down by older cheap sales and the';
      RAISE NOTICE '   >>> forecast is the better guide. The seller is right.';
    ELSIF r.p_recent >= 16.00 THEN
      RAISE NOTICE '   >>> Recent units clear well above the year average but';
      RAISE NOTICE '   >>> BELOW 19.97. Re-run the maths at the recent figure,';
      RAISE NOTICE '   >>> not at the list price.';
    ELSE
      RAISE NOTICE '   >>> Recent units still clear near the year average, so';
      RAISE NOTICE '   >>> 19.97 is a list price that is not converting.';
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- 5. Current cost basis, since the verdict is per-unit margin.
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## COST ON RECORD ########';
  FOR r IN
    SELECT c.source, round(c.unit_cost, 2) AS unit_cost, c.updated_at::date AS updated
    FROM public.asin_cog_on_record c
    WHERE c.user_id = v_uid AND c.asin = v_asin
  LOOP
    RAISE NOTICE '   % | % per unit | set %', rpad(r.source, 20), r.unit_cost, r.updated;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no COG on record'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
