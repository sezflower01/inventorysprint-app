-- READ-ONLY, and it narrows the job sharply.
--
-- My "15 false tombstones" was wrong. The history shows several of those ASINs
-- have an ACTIVE sibling SKU row holding the real stock -- e.g. B000EYYP62's
-- tombstoned amzn.gr.10652056 sits beside an ACTIVE 1065205682 with 68
-- available. For those the tombstone is CORRECT: it marks a dead duplicate
-- SKU, not a dead ASIN. My ASIN-level sales join could not see the difference.
--
-- The genuine cases are ASINs where the tombstoned row is the ONLY row, so
-- there is nowhere else for the stock to live. Separate the two before writing
-- anything.
DO $p$
DECLARE v_uid uuid; r record; n_orphan int := 0; n_dup int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== per ASIN: tombstoned rows vs live siblings ==';
  FOR r IN
    WITH sellers AS (
      SELECT DISTINCT asin FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= CURRENT_DATE - 30
        AND COALESCE(is_cancelled,false) = false AND order_id NOT LIKE '%-REFUND%'
    ), tomb AS (
      SELECT inv.asin, inv.sku, inv.cost, inv.available
      FROM public.inventory inv JOIN sellers s ON s.asin = inv.asin
      WHERE inv.user_id = v_uid AND inv.listing_status = 'NOT_IN_CATALOG'
    )
    SELECT t.asin,
           count(*) AS tombstoned_rows,
           string_agg(DISTINCT t.sku, ', ') AS tombstoned_skus,
           (SELECT count(*) FROM public.inventory i2
            WHERE i2.user_id = v_uid AND i2.asin = t.asin) AS total_rows,
           (SELECT count(*) FROM public.inventory i2
            WHERE i2.user_id = v_uid AND i2.asin = t.asin
              AND COALESCE(i2.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS live_rows,
           (SELECT COALESCE(sum(COALESCE(i2.available,0) + COALESCE(i2.reserved,0) + COALESCE(i2.inbound,0)),0)
            FROM public.inventory i2
            WHERE i2.user_id = v_uid AND i2.asin = t.asin
              AND COALESCE(i2.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS live_units,
           (SELECT string_agg(i2.sku || '(' || COALESCE(i2.listing_status,'?') || ':' || COALESCE(i2.available,0) || ')', ', ')
            FROM public.inventory i2
            WHERE i2.user_id = v_uid AND i2.asin = t.asin
              AND COALESCE(i2.listing_status,'') NOT IN ('NOT_IN_CATALOG','DELETED')) AS live_detail
    FROM tomb t GROUP BY t.asin ORDER BY t.asin
  LOOP
    IF r.live_rows > 0 THEN
      n_dup := n_dup + 1;
      RAISE NOTICE '   % | DUPLICATE: % tombstoned, % live holding % units',
        r.asin, r.tombstoned_rows, r.live_rows, r.live_units;
      RAISE NOTICE '        tombstoned: %', r.tombstoned_skus;
      RAISE NOTICE '        live:       %', r.live_detail;
    ELSE
      n_orphan := n_orphan + 1;
      RAISE NOTICE '   % | ORPHAN: % tombstoned row(s), NO live sibling  <<< genuine',
        r.asin, r.tombstoned_rows;
      RAISE NOTICE '        tombstoned: %', r.tombstoned_skus;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== VERDICT: % ASINs are duplicates (tombstone CORRECT), % are orphans (genuine) ==',
    n_dup, n_orphan;

  RAISE NOTICE '';
  RAISE NOTICE '== B00LFXMBKI specifically: every row for it ==';
  FOR r IN
    SELECT COALESCE(sku,'-') AS sku, COALESCE(listing_status,'-') AS lstatus,
           COALESCE(available::text,'NULL') AS avail,
           COALESCE(reserved::text,'NULL') AS reserved,
           COALESCE(inbound::text,'NULL') AS inbound,
           COALESCE(source,'-') AS src, updated_at
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | % | avail % | reserved % | inbound % | src % | %',
      rpad(r.sku,16), rpad(r.lstatus,15), lpad(r.avail,5), lpad(r.reserved,5),
      lpad(r.inbound,5), rpad(r.src,10), r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and its history: has it EVER been ACTIVE with stock? ==';
  FOR r IN
    SELECT COALESCE(sku,'-') AS sku, COALESCE(listing_status,'-') AS lstatus,
           available, reserved, inbound, COALESCE(source,'-') AS src, captured_at
    FROM public.inventory_history
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
    ORDER BY captured_at DESC LIMIT 12
  LOOP
    RAISE NOTICE '   % | % | avail % | res % | inb % | % | %',
      rpad(r.sku,16), rpad(r.lstatus,15), lpad(COALESCE(r.available::text,'-'),5),
      lpad(COALESCE(r.reserved::text,'-'),4), lpad(COALESCE(r.inbound::text,'-'),4),
      rpad(r.src,10), r.captured_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NO history rows at all for B00LFXMBKI'; END IF;
END
$p$;
