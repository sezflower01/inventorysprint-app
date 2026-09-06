-- PROBE (read-only): why does the Momentum Smart rule card say 54 ASINs?
--
-- RuleBuilder builds the per-rule count by FETCHING ROWS and counting them in
-- the browser:
--
--   supabase.from("repricer_assignments").select("rule_id").in("rule_id", ruleIds)
--
-- No .limit(), no range paging, no { count: 'exact', head: true }. PostgREST
-- caps a response at 1,000 rows by default and does not error when it truncates
-- -- the same silent cap that bit the seller-catalogue RPC earlier in this
-- project. So once total assignments across all rules exceed 1,000, every card
-- shows a share of 1,000 rather than the truth, and the numbers get smaller as
-- more rules compete for the same 1,000 rows.
--
-- Two things settle it: the true per-rule counts, and the grand total. If the
-- total is over 1,000 the cap is the explanation.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_total bigint; v_rules int;
BEGIN
  SELECT count(*) INTO v_total FROM public.repricer_assignments;
  SELECT count(*) INTO v_rules FROM public.repricer_rules;
  RAISE NOTICE '======== totals ========';
  RAISE NOTICE '   repricer_assignments rows : %', v_total;
  RAISE NOTICE '   repricer_rules rows       : %', v_rules;
  IF v_total > 1000 THEN
    RAISE NOTICE '   -> OVER THE 1,000-ROW POSTGREST CAP. The card counts cannot be right:';
    RAISE NOTICE '      they can only ever sum to 1,000.';
  ELSE
    RAISE NOTICE '   -> under the cap, so truncation is NOT the explanation here';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== true count per rule ========';
  FOR r IN
    SELECT rr.name, rr.id, rr.is_enabled,
           count(a.id) AS assignments,
           count(a.id) FILTER (WHERE a.is_enabled) AS enabled_assignments,
           count(DISTINCT a.asin) AS distinct_asins
    FROM public.repricer_rules rr
    LEFT JOIN public.repricer_assignments a ON a.rule_id = rr.id
    GROUP BY rr.id, rr.name, rr.is_enabled
    ORDER BY assignments DESC
  LOOP
    RAISE NOTICE '   %-34s rule_enabled=% | % assignments (% enabled) | % distinct ASINs',
      left(r.name, 34), r.is_enabled, r.assignments, r.enabled_assignments, r.distinct_asins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== assignments with no rule at all ========';
  FOR r IN
    SELECT count(*) AS orphan, count(*) FILTER (WHERE is_enabled) AS orphan_enabled
    FROM public.repricer_assignments WHERE rule_id IS NULL
  LOOP
    RAISE NOTICE '   % assignments have rule_id NULL (% of them enabled)', r.orphan, r.orphan_enabled;
    RAISE NOTICE '   (these are the ones a per-rule pause cannot stop)';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== by marketplace, for the biggest rule ========';
  FOR r IN
    SELECT rr.name, a.marketplace, count(*) AS n,
           count(*) FILTER (WHERE a.is_enabled) AS enabled
    FROM public.repricer_assignments a
    JOIN public.repricer_rules rr ON rr.id = a.rule_id
    WHERE rr.id = (SELECT rule_id FROM public.repricer_assignments
                    WHERE rule_id IS NOT NULL
                    GROUP BY rule_id ORDER BY count(*) DESC LIMIT 1)
    GROUP BY rr.name, a.marketplace ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % | % : % assignments (% enabled)', left(r.name,26), r.marketplace, r.n, r.enabled;
  END LOOP;
END
$probe$;
