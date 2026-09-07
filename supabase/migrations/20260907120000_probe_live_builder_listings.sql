-- PROBE (read-only): the live listings still on Momentum Builder, so the
-- seller can decide item by item rather than in bulk.
--
-- After disabling 238 dead assignments the Builder-versus-Smart question
-- collapsed from "344 versus 235" to a couple of dozen real listings. Small
-- enough to read, which is the point -- a bulk move was never the right shape
-- for this.
--
-- "Live" is the same definition used throughout: the inventory row exists,
-- listing_status is ACTIVE, and there is stock somewhere across available,
-- reserved, inbound or unfulfilled.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== live listings still on Momentum Builder ========';
  n := 0;
  FOR r IN
    SELECT a.marketplace, a.asin, a.sku,
           COALESCE(i.available,0) AS avail,
           COALESCE(i.reserved,0)  AS reserved,
           COALESCE(i.inbound,0)   AS inbound,
           round(i.cost::numeric, 2)      AS cost,
           round(i.my_price::numeric, 2)  AS price,
           round(a.min_price_override::numeric, 2) AS min_ovr,
           COALESCE(s.units_90d, 0) AS sold_90d,
           left(COALESCE(i.title,''), 44) AS title
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(so.quantity),0) AS units_90d
      FROM public.sales_orders so
      WHERE so.user_id = a.user_id AND so.asin = a.asin
        AND COALESCE(so.is_cancelled,false) = false
        AND so.order_date >= current_date - 90
    ) s ON true
    WHERE a.user_id = v_uid
      AND a.is_enabled
      AND rr.name = 'Momentum Builder'
      AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
      AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
         +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0
    ORDER BY a.marketplace, s.units_90d DESC NULLS LAST, a.asin
  LOOP
    n := n + 1;
    RAISE NOTICE '% | % | % | stock %/%/% | cost % | price % | min % | sold90 % | %',
      lpad(n::text,2), r.marketplace, r.asin, r.avail, r.reserved, r.inbound,
      COALESCE(r.cost::text,'-'), COALESCE(r.price::text,'-'),
      COALESCE(r.min_ovr::text,'-'), r.sold_90d, r.title;
  END LOOP;
  RAISE NOTICE '   total: % live listings on Momentum Builder', n;

  RAISE NOTICE '';
  RAISE NOTICE '======== per marketplace ========';
  FOR r IN
    SELECT a.marketplace, count(*) AS live,
           count(*) FILTER (WHERE s.units_90d > 0) AS sold_recently
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(so.quantity),0) AS units_90d
      FROM public.sales_orders so
      WHERE so.user_id = a.user_id AND so.asin = a.asin
        AND COALESCE(so.is_cancelled,false) = false
        AND so.order_date >= current_date - 90
    ) s ON true
    WHERE a.user_id = v_uid AND a.is_enabled AND rr.name = 'Momentum Builder'
      AND upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
      AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
         +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0
    GROUP BY a.marketplace ORDER BY live DESC
  LOOP
    RAISE NOTICE '   % : % live (% sold in 90d)', r.marketplace, r.live, r.sold_recently;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== and what is still enabled on Builder but NOT live ========';
  FOR r IN
    SELECT a.marketplace, count(*) AS n
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
    WHERE a.user_id = v_uid AND a.is_enabled AND rr.name = 'Momentum Builder'
      AND NOT (upper(COALESCE(i.listing_status,'')) = 'ACTIVE'
               AND COALESCE(i.available,0)+COALESCE(i.reserved,0)
                  +COALESCE(i.inbound,0)+COALESCE(i.unfulfilled,0) > 0)
    GROUP BY a.marketplace ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % : % still enabled but not live (kept -- they sold within the year)',
      r.marketplace, r.n;
  END LOOP;
END
$probe$;
