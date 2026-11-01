-- PHASE 2 (re-scoped) STEP 1: the INACTIVE population. READ ONLY.
--
-- ── THE RULE INACTIVE IS SUPPOSED TO FOLLOW ───────────────────────────
--
-- INACTIVE is OUR derived status, not Amazon's. Every writer computes it the
-- same way:
--   rescue-inventory-asin:549   hasStock ? 'ACTIVE' : 'INACTIVE'
--                               getTotalStock = available + reserved + inbound
--   sync-inventory-report:1017  (available + reserved + inbound) > 0
--   refresh-stale-inventory:304 totalLive > 0 ? 'ACTIVE' : 'INACTIVE'
--   bulk-live-verify:516/891    units > 0 || amazonSaysLive
--
-- So by our own rule, ANY row with available + reserved + inbound > 0 should be
-- ACTIVE. A row that is INACTIVE while holding stock is therefore internally
-- inconsistent with the rule that produced it -- which makes it a STATUS LAG on
-- our side, not a statement about Amazon. That distinction is step 1's actual
-- question, and it can be answered without calling Amazon at all.
--
-- Amazon's own view of whether a listing is inactive lives in two separate
-- columns, and they are reported alongside so the two concepts are not
-- conflated: amazon_listing_state and is_listing_inactive_not_buyable.
--
-- Those two columns are on repricer_assignments, NOT on inventory -- checked
-- rather than assumed after a first attempt here failed on
-- "column i.amazon_listing_state does not exist". They are joined in below,
-- which also means a SKU with no repricer assignment has no Amazon buyability
-- signal at all, and that absence is itself reported rather than shown as
-- "not flagged".
DO $p$
DECLARE
  r record; v_uid uuid;
  v_inact int; v_lagging int; v_sold30 int; v_both int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '############ 1. HOW MANY INACTIVE ROWS BREAK OUR OWN RULE? ############';
  SELECT count(*) INTO v_inact FROM public.inventory
   WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'INACTIVE';
  SELECT count(*) INTO v_lagging FROM public.inventory
   WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'INACTIVE'
     AND COALESCE(available,0) + COALESCE(reserved,0) + COALESCE(inbound,0) > 0;
  RAISE NOTICE '   INACTIVE rows in total                        : %', v_inact;
  RAISE NOTICE '   ... holding stock, so ACTIVE by our own rule  : %  <= STATUS LAG',
    v_lagging;
  RAISE NOTICE '   These are not Amazon telling us anything. They are rows whose';
  RAISE NOTICE '   status no longer matches the stock sitting beside it.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 2. THE POPULATION: stock or a sale in 30 days, per SKU ############';
  RAISE NOTICE '   asin         | sku                  | av | rv  | inb | sku30 | sku90 | stock age | amazon state | not_buyable';
  v_sold30 := 0; v_both := 0;
  FOR r IN
    WITH by_sku AS (
      SELECT seller_sku,
             sum(quantity) FILTER (WHERE order_date >= current_date - 30) AS u30,
             sum(quantity) FILTER (WHERE order_date >= current_date - 90) AS u90
      FROM public.sales_orders
      WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
        AND order_date >= current_date - 90 AND seller_sku IS NOT NULL
      GROUP BY seller_sku
    ),
    ra AS (
      SELECT asin, sku,
             bool_or(COALESCE(is_listing_inactive_not_buyable,false)) AS nb,
             max(COALESCE(amazon_listing_state,'')) AS astate
      FROM public.repricer_assignments
      WHERE user_id = v_uid GROUP BY asin, sku
    )
    SELECT i.asin, COALESCE(i.sku,'(null)') AS sku,
           COALESCE(i.available,0) AS av, COALESCE(i.reserved,0) AS rv,
           COALESCE(i.inbound,0) AS ib,
           COALESCE(k.u30,0) AS u30, COALESCE(k.u90,0) AS u90,
           CASE WHEN i.last_inventory_sync_at IS NULL THEN 'never'
                ELSE (extract(epoch from (now()-i.last_inventory_sync_at))/86400)::int || 'd'
           END AS age,
           COALESCE(NULLIF(a.astate,''),'(no assignment)') AS astate,
           COALESCE(a.nb::text,'-') AS nb,
           (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)) AS tot
    FROM public.inventory i
    LEFT JOIN by_sku k ON k.seller_sku = i.sku
    LEFT JOIN ra     a ON a.asin = i.asin AND a.sku = i.sku
    WHERE i.user_id = v_uid
      AND upper(COALESCE(i.listing_status,'')) = 'INACTIVE'
      AND (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0) > 0
           OR COALESCE(k.u30,0) > 0)
    ORDER BY (COALESCE(i.available,0)+COALESCE(i.reserved,0)+COALESCE(i.inbound,0)) DESC,
             COALESCE(k.u30,0) DESC
  LOOP
    IF r.u30 > 0 THEN v_sold30 := v_sold30 + 1; END IF;
    IF r.u30 > 0 AND r.tot > 0 THEN v_both := v_both + 1; END IF;
    RAISE NOTICE '   % | % | % | % | % | % | % | % | % | %',
      rpad(r.asin,12), rpad(r.sku,20), lpad(r.av::text,2), lpad(r.rv::text,3),
      lpad(r.ib::text,4), lpad(r.u30::text,5), lpad(r.u90::text,5),
      lpad(r.age,9), rpad(r.astate,12), r.nb;
  END LOOP;
  RAISE NOTICE '   ----------------------------------------------------------';
  RAISE NOTICE '   sold in 30 days: % | both stock AND a 30-day sale: %',
    v_sold30, v_both;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 3. B00LFXMBKI: lag or Amazon''s truth? ############';
  FOR r IN
    SELECT COALESCE(sku,'(null)') AS sku, COALESCE(listing_status,'-') AS st,
           COALESCE(available,0) AS av, COALESCE(reserved,0) AS rv,
           COALESCE(inbound,0) AS ib,
           COALESCE(inbound_working,0) AS ibw,
           COALESCE(inbound_shipped,0) AS ibs,
           COALESCE(inbound_receiving,0) AS ibr,
           COALESCE((SELECT max(COALESCE(amazon_listing_state,'(null)'))
                       FROM public.repricer_assignments ra
                      WHERE ra.user_id = v_uid AND ra.asin = i.asin),
                    '(no assignment)') AS astate,
           COALESCE((SELECT bool_or(COALESCE(is_listing_inactive_not_buyable,false))
                       FROM public.repricer_assignments ra
                      WHERE ra.user_id = v_uid AND ra.asin = i.asin),
                    false) AS nb,
           COALESCE(i.source,'-') AS src,
           i.last_inventory_sync_at AS synced, i.updated_at
    FROM public.inventory i WHERE i.user_id = v_uid AND i.asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | listing_status %', r.sku, r.st;
    RAISE NOTICE '      available % | reserved % | inbound % (working % shipped % receiving %)',
      r.av, r.rv, r.ib, r.ibw, r.ibs, r.ibr;
    RAISE NOTICE '      total by our rule: % -> our rule says %',
      r.av + r.rv + r.ib,
      CASE WHEN r.av + r.rv + r.ib > 0 THEN 'ACTIVE' ELSE 'INACTIVE' END;
    RAISE NOTICE '      amazon_listing_state % | is_listing_inactive_not_buyable %',
      r.astate, r.nb;
    RAISE NOTICE '      source % | synced % | updated %', r.src, r.synced, r.updated_at;
    RAISE NOTICE '';
    IF r.av + r.rv + r.ib > 0 AND upper(r.st) = 'INACTIVE' THEN
      RAISE NOTICE '      >>> VERDICT: OUR STATUS LAG. By the rule every writer';
      RAISE NOTICE '      >>> uses (available + reserved + inbound > 0 => ACTIVE)';
      RAISE NOTICE '      >>> this row should be ACTIVE. The status contradicts';
      RAISE NOTICE '      >>> the stock stored next to it, so nothing about';
      RAISE NOTICE '      >>> Amazon is being reported here -- our own rule is.';
      IF r.nb THEN
        RAISE NOTICE '      >>> BUT is_listing_inactive_not_buyable is TRUE, which';
        RAISE NOTICE '      >>> IS an Amazon signal: the listing is not buyable.';
        RAISE NOTICE '      >>> Then available 0 is real (nothing sellable) and';
        RAISE NOTICE '      >>> the 260 inbound is stock arriving at a dead';
        RAISE NOTICE '      >>> listing. Flipping the status would NOT fix that.';
      ELSE
        RAISE NOTICE '      >>> and is_listing_inactive_not_buyable is FALSE, so';
        RAISE NOTICE '      >>> Amazon is not calling the listing dead either.';
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE '   sales history:';
  FOR r IN
    SELECT to_char(date_trunc('month', order_date),'YYYY-MM') AS mo,
           sum(quantity) AS u, count(*) AS orders
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
      AND order_id NOT LIKE '%-REFUND%' AND order_date >= current_date - 120
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % units | % orders', r.mo, r.u, r.orders; END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ 4. WHAT THE LAG COSTS ############';
  RAISE NOTICE '   ghostFilter treats a row as a ghost when listing_status is';
  RAISE NOTICE '   NOT_IN_CATALOG/DELETED, OR when total stock <= 0 and status';
  RAISE NOTICE '   is not ACTIVE. So an INACTIVE row WITH stock is NOT filtered';
  RAISE NOTICE '   out by that rule -- it still reaches Inventory Valuation.';
  RAISE NOTICE '   The cost is elsewhere: auto-assign-bulk:1360 treats INACTIVE';
  RAISE NOTICE '   as a bad status, so the repricer will not manage it.';
  FOR r IN
    SELECT count(*) AS n,
           -- inventory has NO unit_cost column. Per the cost contract,
           -- inventory.cost IS the per-unit cost (Contract A) and `amount` is
           -- the line total over `units` -- the two tables swap the meaning,
           -- which is exactly the trap getInventoryUnitCost() exists to hide.
           -- Guessing `unit_cost` here cost one failed push.
           round(sum((COALESCE(available,0)+COALESCE(reserved,0))
                     * COALESCE(cost,
                         CASE WHEN COALESCE(units,0) > 0
                              THEN COALESCE(amount,0)/units ELSE 0 END)
                    )::numeric,2) AS value_at_cost
    FROM public.inventory
    WHERE user_id = v_uid AND upper(COALESCE(listing_status,'')) = 'INACTIVE'
      AND COALESCE(available,0)+COALESCE(reserved,0)+COALESCE(inbound,0) > 0
  LOOP
    RAISE NOTICE '   % lagging rows holding % of on-hand stock at cost',
      r.n, COALESCE(r.value_at_cost,0);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written, no API called.';
END
$p$;
