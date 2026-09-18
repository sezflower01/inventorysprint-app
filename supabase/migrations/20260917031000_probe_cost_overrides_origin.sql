-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- asin_cost_overrides sits ABOVE COG on record in every chain shipped
-- 2026-09-15..17, on the assumption that overrides are deliberate seller
-- entries. B0G54FYGXQ's is "Auto-saved from purchase (10 units @ $16.70)" and
-- hides the seller's COG of 9.10. How many overrides are auto-saved, and how
-- many disagree with a COG?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  FOR r IN
    SELECT CASE WHEN o.note ILIKE 'auto-saved%' THEN 'auto-saved from purchase'
                WHEN o.note IS NULL OR o.note = '' THEN '(no note)'
                ELSE 'other: ' || left(o.note, 40) END AS kind,
           count(*) AS n,
           count(*) FILTER (WHERE c.unit_cost IS NOT NULL AND abs(c.unit_cost - o.unit_cost) > 0.005) AS differs_from_cog,
           min(o.effective_from) AS first_eff, max(o.effective_from) AS last_eff, max(o.created_at) AS last_created
    FROM public.asin_cost_overrides o
    LEFT JOIN public.asin_cog_for_repricer c ON c.user_id = o.user_id AND c.asin = o.asin
    WHERE o.user_id = v_uid
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  %: % overrides, % differ from the COG | effective % .. % | newest written %',
      r.kind, r.n, r.differs_from_cog, r.first_eff, r.last_eff, r.last_created;
  END LOOP;
END
$p$;
