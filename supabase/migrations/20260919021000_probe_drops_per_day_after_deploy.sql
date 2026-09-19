-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- After deploy of 1aa4e0a: the values the Auto-lower min popover reads for
-- each covered rule, and whether each matches round(720 / interval).

DO $p$
DECLARE r record;
BEGIN
  FOR r IN SELECT name, auto_lower_min_interval_minutes AS iv, auto_lower_min_max_drops_per_day AS md,
                  round(720.0 / auto_lower_min_interval_minutes) AS expected
           FROM public.repricer_rules WHERE cardinality(auto_lower_min_marketplaces) > 0 ORDER BY name LOOP
    RAISE NOTICE '%: every % min | drops/day % | expected % | %', r.name, r.iv, r.md, r.expected,
      CASE WHEN r.md = r.expected THEN 'OK' ELSE 'MISMATCH' END;
  END LOOP;
END
$p$;
