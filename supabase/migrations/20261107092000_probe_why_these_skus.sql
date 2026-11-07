-- "I always print FNSKU on every product I ship" -- so why are 266 stickerless?
-- READ ONLY.
--
-- Both statements can be true at once, and the likely reason is that they
-- describe different moments:
--
--   Printing an FNSKU happens when you SHIP a unit.
--   The barcode mode is fixed when the OFFER IS CREATED.
--
-- A SKU in manufacturer-barcode mode never gets an FNSKU issued at all, so
-- there is nothing to print and no step at which the seller would notice. The
-- setting only surfaces when you finally try to send that SKU to FBA -- which
-- is exactly how B01IU5V208 surfaced, 18 months after it was created.
--
-- If that is right, the stickerless SKUs should be the ones that were NEVER
-- SHIPPED, and the shipped catalogue should be almost entirely FNSKU. And the
-- stickerless ones should cluster in time, because an account-level barcode
-- preference applies to everything created while it is set.
--
-- fnsku = asin is Amazon's own report value, not ours: sync-fnsku-report skips
-- rows with no fnsku (index.ts:425) and stores the column verbatim, and Amazon
-- reports the ASIN in that field for a commingled SKU.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE mode_split ON COMMIT DROP AS
  SELECT DISTINCT ON (f.asin)
         f.asin,
         CASE WHEN EXISTS (SELECT 1 FROM public.fnsku_map g
                            WHERE g.asin = f.asin AND g.fnsku ~ '^X[A-Z0-9]{9}$')
              THEN 'fnsku' ELSE 'stickerless' END AS mode
  FROM public.fnsku_map f
  WHERE f.marketplace_id = 'ATVPDKIKX0DER';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. HAVE THEY EVER SOLD? ########';
  RAISE NOTICE '   mode        | ASINs | ever sold | never sold | %% never sold';
  FOR r IN
    SELECT m.mode,
           count(*)::int AS n,
           count(*) FILTER (WHERE s.units > 0)::int AS sold,
           count(*) FILTER (WHERE COALESCE(s.units,0) = 0)::int AS never,
           round(100.0 * count(*) FILTER (WHERE COALESCE(s.units,0) = 0)
                 / NULLIF(count(*),0), 1) AS pct
    FROM mode_split m
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(so.quantity),0) AS units
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND so.asin = m.asin
        AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND'
    ) s ON true
    GROUP BY m.mode ORDER BY m.mode
  LOOP
    RAISE NOTICE '   % | % | % | % | %%%',
      rpad(r.mode,11), lpad(r.n::text,5), lpad(r.sold::text,9),
      lpad(r.never::text,10), lpad(r.pct::text,5);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. HAVE THEY EVER BEEN SENT TO FBA? ########';
  RAISE NOTICE '   (any FBA fee ever billed = a unit physically shipped in)';
  FOR r IN
    SELECT m.mode,
           count(*) FILTER (WHERE s.fees > 0)::int AS shipped,
           count(*) FILTER (WHERE COALESCE(s.fees,0) = 0)::int AS never_shipped
    FROM mode_split m
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(so.fba_fee),0) AS fees
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND so.asin = m.asin
    ) s ON true
    GROUP BY m.mode ORDER BY m.mode
  LOOP
    RAISE NOTICE '   % | shipped % | never shipped %',
      rpad(r.mode,11), lpad(r.shipped::text,5), lpad(r.never_shipped::text,5);
  END LOOP;

  ------------------------------------------------------------------
  -- An account-level preference applies to everything created while set, so
  -- a wrong default leaves a date-shaped fingerprint.
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. WHEN WERE THEY CREATED? ########';
  RAISE NOTICE '   month   | stickerless | fnsku';
  FOR r IN
    SELECT to_char(date_trunc('month', cl.created_at), 'YYYY-MM') AS mon,
           count(*) FILTER (WHERE m.mode = 'stickerless')::int AS sl,
           count(*) FILTER (WHERE m.mode = 'fnsku')::int AS fn
    FROM public.created_listings cl
    JOIN mode_split m ON m.asin = cl.asin
    WHERE cl.user_id = v_uid
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | %', r.mon, lpad(r.sl::text,11), lpad(r.fn::text,5);
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no created_listings overlap'; END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. THE TEST THAT SETTLES IT ########';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE m.mode='fnsku'       AND s.units > 0)::int AS fn_sold,
      count(*) FILTER (WHERE m.mode='stickerless' AND s.units > 0)::int AS sl_sold,
      count(*) FILTER (WHERE m.mode='fnsku'       AND COALESCE(s.units,0)=0)::int AS fn_cold,
      count(*) FILTER (WHERE m.mode='stickerless' AND COALESCE(s.units,0)=0)::int AS sl_cold
    FROM mode_split m
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(so.quantity),0) AS units
      FROM public.sales_orders so
      WHERE so.user_id = v_uid AND so.asin = m.asin
        AND COALESCE(so.is_cancelled,false) = false
        AND so.order_id NOT LIKE '%-REFUND'
    ) s ON true
  LOOP
    RAISE NOTICE '   sold at least once : % FNSKU vs % stickerless', r.fn_sold, r.sl_sold;
    RAISE NOTICE '   never sold         : % FNSKU vs % stickerless', r.fn_cold, r.sl_cold;
    RAISE NOTICE '';
    IF r.sl_sold = 0 THEN
      RAISE NOTICE '   >>> NOT ONE stickerless SKU has ever sold. The seller is';
      RAISE NOTICE '   >>> right: everything actually shipped carries an FNSKU.';
    ELSIF r.sl_sold < r.sl_cold / 4 THEN
      RAISE NOTICE '   >>> Stickerless SKUs are overwhelmingly ones never sold --';
      RAISE NOTICE '   >>> consistent with the mode being set at offer creation';
      RAISE NOTICE '   >>> and never noticed, because nothing was ever shipped.';
    ELSE
      RAISE NOTICE '   >>> Stickerless SKUs HAVE sold, so the mode is not simply';
      RAISE NOTICE '   >>> a property of dormant listings. Needs another look.';
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
