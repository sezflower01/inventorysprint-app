-- PROBE (read-only): did the bulk "assign everything to Momentum Smart"
-- actually write, or is the second computer just showing a stale page?
--
-- Two very different problems produce the same complaint:
--   a) the write succeeded and the other browser has not refetched -- the
--      Repricer polls prices and stock every 30s but NOT rules or
--      assignments, so a page left open keeps its original values;
--   b) the write only partially applied. That is a live concern here: this
--      account has 6,214 assignments, and yesterday the rule badges were
--      found to be reading a silently truncated 1,000 rows. A bulk update
--      built the same way would update 1,000 and report success.
--
-- Counts as of 2026-09-06, for comparison:
--   Momentum Builder  2,203 assignments |  362 enabled |  929 ASINs
--   Momentum Smart      525 assignments |  469 enabled |  254 ASINs
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_recent int;
BEGIN
  RAISE NOTICE '======== assignments per rule, right now ========';
  FOR r IN
    SELECT rr.name, count(a.id) AS assignments,
           count(a.id) FILTER (WHERE a.is_enabled) AS enabled,
           count(DISTINCT a.asin) AS asins,
           max(a.updated_at) AS last_touched
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    GROUP BY rr.id, rr.name
    HAVING count(a.id) > 0
    ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   %-34s % assignments | % enabled | % ASINs | last touched %',
      left(r.name,34), r.assignments, r.enabled, r.asins, r.last_touched;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== was anything written in the last 2 hours? ========';
  SELECT count(*) INTO v_recent
  FROM public.repricer_assignments WHERE updated_at > now() - interval '2 hours';
  RAISE NOTICE '   % assignments updated in the last 2 hours', v_recent;

  IF v_recent > 0 THEN
    FOR r IN
      SELECT rr.name, count(*) AS n,
             min(a.updated_at) AS first_write,
             max(a.updated_at) AS last_write
      FROM public.repricer_assignments a
      LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
      WHERE a.updated_at > now() - interval '2 hours'
      GROUP BY rr.name ORDER BY n DESC
    LOOP
      RAISE NOTICE '   -> % : % rows, % .. %', COALESCE(r.name,'(no rule)'), r.n, r.first_write, r.last_write;
    END LOOP;

    -- A batch that lands on exactly 1000 is the signature of the PostgREST cap.
    FOR r IN
      SELECT count(*) AS n FROM public.repricer_assignments
      WHERE updated_at > now() - interval '2 hours'
    LOOP
      IF r.n = 1000 OR r.n = 1000 * (r.n / 1000) AND r.n >= 1000 THEN
        RAISE NOTICE '   *** % is a suspiciously round multiple of 1,000 -- check for truncation ***', r.n;
      END IF;
    END LOOP;
  ELSE
    RAISE NOTICE '   -> NOTHING was written. The bulk assign did not reach the database.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== per-marketplace split (a bulk action may cover only one) ========';
  FOR r IN
    SELECT a.marketplace, rr.name, count(*) AS n
    FROM public.repricer_assignments a
    LEFT JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE rr.name ILIKE '%Momentum%'
    GROUP BY a.marketplace, rr.name
    ORDER BY a.marketplace, n DESC
  LOOP
    RAISE NOTICE '   % | %-28s : %', r.marketplace, left(COALESCE(r.name,'(none)'),28), r.n;
  END LOOP;
END
$probe$;
