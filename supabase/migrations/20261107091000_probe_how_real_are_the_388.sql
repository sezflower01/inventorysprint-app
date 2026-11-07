-- 388 manufacturer-mode rows in fnsku_map, but the page shows 1. READ ONLY.
--
-- Those two numbers read DIFFERENT TABLES, which is why they disagree:
--   the page   filters public.inventory on fnsku = asin
--   the gate   reads public.fnsku_map, where 388 ASINs carry fnsku = asin
--
-- 388 is not automatically 388 problems. A row only blocks when the gate finds
-- manufacturer mode AND no valid FNSKU anywhere on that ASIN AND an active
-- listing exists (check-fba-listing-eligibility/index.ts:281). A stale row left
-- behind by a deleted listing sits in the map harmlessly and the self-heal
-- clears it on the next forced check.
--
-- So: of the 388, how many would actually block today? That is the difference
-- between "one SKU to fix" and "a queue of them waiting to surprise you mid
-- shipment", and it should not be guessed at.
DO $p$
DECLARE r record; v_uid uuid; v_mm int; v_dup int; v_exposed int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. SPLIT BY MARKETPLACE ########';
  FOR r IN
    SELECT COALESCE(f.marketplace_id,'-') AS mk, count(DISTINCT f.asin)::int AS n
    FROM public.fnsku_map f WHERE upper(f.fnsku) = upper(f.asin)
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % -> % ASIN(s)%', rpad(r.mk, 16), lpad(r.n::text, 5),
      CASE WHEN r.mk = 'ATVPDKIKX0DER' THEN '  (US)' ELSE '' END;
  END LOOP;

  ------------------------------------------------------------------
  -- The gate short-circuits when ANY row on the ASIN has a real FNSKU.
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. HOW MANY WOULD ACTUALLY BLOCK? ########';
  WITH mm AS (
    SELECT DISTINCT f.asin FROM public.fnsku_map f
    WHERE upper(f.fnsku) = upper(f.asin)
  ), rescued AS (
    SELECT m.asin FROM mm m
    WHERE EXISTS (SELECT 1 FROM public.fnsku_map g
                   WHERE g.asin = m.asin AND g.fnsku ~ '^X[A-Z0-9]{9}$')
  )
  SELECT (SELECT count(*) FROM mm), (SELECT count(*) FROM rescued)
    INTO v_mm, v_dup;
  v_exposed := v_mm - v_dup;
  RAISE NOTICE '   manufacturer-mode ASINs in the map : %', v_mm;
  RAISE NOTICE '   ... rescued by a real FNSKU elsewhere on the ASIN : %', v_dup;
  RAISE NOTICE '   ... left with NO valid FNSKU anywhere          : %', v_exposed;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '   of those, split by whether a live listing exists:';
  FOR r IN
    WITH mm AS (
      SELECT DISTINCT f.asin FROM public.fnsku_map f
      WHERE upper(f.fnsku) = upper(f.asin)
    ), exposed AS (
      SELECT m.asin FROM mm m
      WHERE NOT EXISTS (SELECT 1 FROM public.fnsku_map g
                         WHERE g.asin = m.asin AND g.fnsku ~ '^X[A-Z0-9]{9}$')
    )
    SELECT
      count(*) FILTER (WHERE inv_live)::int  AS live,
      count(*) FILTER (WHERE NOT inv_live)::int AS dead,
      COALESCE(sum(stock) FILTER (WHERE inv_live), 0)::int AS units
    FROM (
      SELECT e.asin,
             EXISTS (SELECT 1 FROM public.inventory i
                      WHERE i.user_id = v_uid AND i.asin = e.asin
                        AND COALESCE(i.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS inv_live,
             COALESCE((SELECT sum(COALESCE(i.available,0) + COALESCE(i.inbound,0) + COALESCE(i.reserved,0))
                       FROM public.inventory i
                       WHERE i.user_id = v_uid AND i.asin = e.asin), 0) AS stock
      FROM exposed e
    ) x
  LOOP
    RAISE NOTICE '   live listing (WOULD BLOCK) : %  holding % units', r.live, r.units;
    RAISE NOTICE '   no live listing (harmless) : %', r.dead;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. THE ONES THAT WOULD BLOCK, WITH STOCK FIRST ########';
  FOR r IN
    WITH mm AS (
      SELECT DISTINCT f.asin FROM public.fnsku_map f
      WHERE upper(f.fnsku) = upper(f.asin)
    ), exposed AS (
      SELECT m.asin FROM mm m
      WHERE NOT EXISTS (SELECT 1 FROM public.fnsku_map g
                         WHERE g.asin = m.asin AND g.fnsku ~ '^X[A-Z0-9]{9}$')
    )
    SELECT e.asin AS a,
           COALESCE(i.sku,'-') AS sku,
           COALESCE(i.available,0) AS av, COALESCE(i.inbound,0) AS ib,
           COALESCE(i.listing_status,'-') AS st,
           left(COALESCE(i.title,'-'), 42) AS t
    FROM exposed e
    JOIN public.inventory i ON i.user_id = v_uid AND i.asin = e.asin
    WHERE COALESCE(i.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')
    ORDER BY (COALESCE(i.available,0) + COALESCE(i.inbound,0)) DESC, e.asin
    LIMIT 20
  LOOP
    RAISE NOTICE '   % | % | av % ib % | % | %',
      r.a, rpad(r.sku, 12), lpad(r.av::text, 4), lpad(r.ib::text, 4),
      rpad(r.st, 10), r.t;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE with a live inventory row -- every exposed ASIN is a';
    RAISE NOTICE '   stale map row from a listing that no longer exists.';
  END IF;

  ------------------------------------------------------------------
  -- Noticed while reading B01IU5V208: its two fnsku_map rows are identical.
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. DUPLICATE MAP ROWS ########';
  SELECT count(*) INTO v_dup FROM (
    SELECT asin, seller_sku, fnsku, count(*) AS n
    FROM public.fnsku_map GROUP BY 1,2,3 HAVING count(*) > 1
  ) d;
  RAISE NOTICE '   (asin, sku, fnsku) triples stored more than once: %', v_dup;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing changed.';
END
$p$;
