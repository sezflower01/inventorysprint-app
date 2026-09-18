-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- COG on record now outranks asin_cost_overrides everywhere. Which ASINs move,
-- by how much, and what does it do to stock value (stocked quantity only)?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    WITH ovr AS (
      SELECT DISTINCT ON (asin) asin, unit_cost, note FROM public.asin_cost_overrides
      WHERE user_id = v_uid AND effective_from <= CURRENT_DATE AND unit_cost > 0
      ORDER BY asin, effective_from DESC, created_at DESC
    ),
    stock AS (
      SELECT asin, sum(COALESCE(available,0)+COALESCE(reserved,0)+COALESCE(inbound,0)+COALESCE(unfulfilled,0)) AS qty
      FROM public.inventory WHERE user_id = v_uid
        AND UPPER(COALESCE(listing_status,'')) NOT IN ('NOT_IN_CATALOG','DELETED')
      GROUP BY asin
    )
    SELECT o.asin, o.unit_cost AS ovr, c.unit_cost AS cog, COALESCE(s.qty,0) AS qty,
           round((COALESCE(s.qty,0) * (c.unit_cost - o.unit_cost))::numeric, 2) AS value_delta,
           left(o.note, 30) AS note
    FROM ovr o
    JOIN public.asin_cog_for_repricer c ON c.user_id = v_uid AND c.asin = o.asin
    LEFT JOIN stock s ON s.asin = o.asin
    WHERE abs(c.unit_cost - o.unit_cost) > 0.005
    ORDER BY abs(COALESCE(s.qty,0) * (c.unit_cost - o.unit_cost)) DESC, o.asin
  LOOP
    RAISE NOTICE '  %  override %  ->  COG %   stocked %   stock value %   [%]', r.asin, r.ovr, r.cog, r.qty, r.value_delta, r.note;
  END LOOP;
END
$p$;
