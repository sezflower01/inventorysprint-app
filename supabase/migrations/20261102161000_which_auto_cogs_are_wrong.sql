-- Which of the 275 applied COGs might be wrong? READ ONLY.
--
-- B0CKHRZ663 vindicated confirmed-only, but for a specific reason worth
-- generalising rather than assuming: all four of its 2026 sales fell AFTER the
-- confirmed lot arrived, so those units came from the confirmed stock and its
-- price is the right cost. The seller confirms the lower price was a genuine
-- deal, not an error.
--
-- The risk case is the opposite shape: an ASIN whose 2026 sales happened
-- BEFORE its confirmed lot existed. Those units came out of OLDER stock, so
-- pricing them at the newer confirmed cost is wrong -- and 163 of the 278
-- auto_shipment ASINs do have unconfirmed lots alongside, covering 771 lots.
--
-- This finds them, and sizes the error. Dates are import stamps rather than
-- true purchase dates, so "before" is approximate -- but a sale months before
-- a lot's stamp is still strong evidence it came from different stock.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_err numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  CREATE TEMP TABLE risk AS
  WITH conf AS (
    -- earliest confirmed lot per ASIN, and the cost now in force
    SELECT c.asin,
           min(cl.created_at::date) AS first_conf_lot,
           max(oc.unit_cost) AS cog_now
    FROM public.cog_purchase_confirmations c
    JOIN public.created_listings cl ON cl.id = c.created_listing_id
    JOIN public.asin_cog_on_record oc
      ON oc.user_id = c.user_id AND oc.asin = c.asin AND oc.source = 'auto_shipment'
    WHERE c.user_id = v_uid
    GROUP BY c.asin),
  unconf AS (
    -- the older real lots, and what they cost per unit
    SELECT cl.asin,
           sum(cl.cost) AS spent, sum(cl.units) AS units, count(*) AS lots
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
      AND NOT EXISTS (SELECT 1 FROM public.cog_purchase_confirmations cc
                       WHERE cc.created_listing_id = cl.id)
    GROUP BY cl.asin)
  SELECT conf.asin, conf.first_conf_lot, round(conf.cog_now,2) AS cog_now,
         round(unconf.spent / NULLIF(unconf.units,0), 2) AS cog_unconf,
         unconf.lots AS unconf_lots,
         (SELECT count(*) FROM public.sales_orders s
           WHERE s.user_id = v_uid AND s.asin = conf.asin
             AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
             AND s.order_id NOT LIKE '%-REFUND%'
             AND s.order_date < conf.first_conf_lot) AS rows_before,
         (SELECT COALESCE(sum(s.quantity),0) FROM public.sales_orders s
           WHERE s.user_id = v_uid AND s.asin = conf.asin
             AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
             AND s.order_id NOT LIKE '%-REFUND%'
             AND s.order_date < conf.first_conf_lot) AS units_before
  FROM conf JOIN unconf ON unconf.asin = conf.asin;

  SELECT count(*) INTO v_n FROM risk;
  RAISE NOTICE '######## auto_shipment ASINs that also have older real lots: % ########', v_n;

  SELECT count(*) INTO v_n FROM risk WHERE units_before > 0;
  RAISE NOTICE '   ... with 2026 units sold BEFORE the confirmed lot: %', v_n;

  SELECT round(sum(units_before * (cog_unconf - cog_now)),2) INTO v_err
  FROM risk WHERE units_before > 0 AND cog_unconf IS NOT NULL;
  RAISE NOTICE '   COGS understated on those units by about: %', COALESCE(v_err,0);
  RAISE NOTICE '   (positive means the older stock cost MORE than the COG now';
  RAISE NOTICE '    in force, so those sales are priced too cheaply)';

  RAISE NOTICE '';
  RAISE NOTICE '   the 15 largest, worst first:';
  RAISE NOTICE '   asin         | cog now | older lots | units sold before | error';
  FOR r IN
    SELECT asin, cog_now, cog_unconf, unconf_lots, units_before,
           round(units_before * (cog_unconf - cog_now),2) AS err
    FROM risk
    WHERE units_before > 0 AND cog_unconf IS NOT NULL
    ORDER BY abs(units_before * (cog_unconf - cog_now)) DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '   % | % | % (% lots) | % | %', rpad(r.asin,12),
      lpad(r.cog_now::text,7), lpad(r.cog_unconf::text,10), r.unconf_lots,
      lpad(r.units_before::text,17), lpad(r.err::text,9);
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE -- every auto_shipment ASIN sold only AFTER its';
    RAISE NOTICE '   confirmed lot arrived, exactly as B0CKHRZ663 did. The';
    RAISE NOTICE '   confirmed-only rule is then right across the board.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   and the reassuring side:';
  SELECT count(*) INTO v_n FROM risk WHERE units_before = 0;
  RAISE NOTICE '   % ASINs sold nothing before their confirmed lot -- the', v_n;
  RAISE NOTICE '   B0CKHRZ663 pattern, where confirmed-only is correct.';

  DROP TABLE risk;
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
