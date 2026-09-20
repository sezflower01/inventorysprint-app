-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Two questions about the eligible-gap recovery raise on B0BXKSYPYY:
--   1. Is A28O1T3CVBNCHW (Buy Box holder at $33.94) US or a competitor? The
--      raise is only defensible if the $33.94 offer was our own.
--   2. How much churn does this pattern cause? 46,318 gap raises over 229
--      ASINs in 7 days -- measure the match/raise ping-pong per ASIN.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== our own Amazon seller id(s) ==';
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name IN ('selling_partner_id','seller_id','merchant_id')
             AND table_name IN ('amazon_connections','sp_api_credentials','user_settings','amazon_accounts','marketplace_connections')
           ORDER BY 1 LOOP
    RAISE NOTICE '  candidate identity column: %.%', r.table_name, r.column_name;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== is A28O1T3CVBNCHW ever recorded as the Buy Box holder while we owned the BB? ==';
  FOR r IN SELECT s.buybox_seller_id, count(*) AS snapshots,
                  count(*) FILTER (WHERE a.last_buybox_status IN ('winning','owned')) AS while_we_were_marked_owner
           FROM public.repricer_competitor_snapshots s
           JOIN public.repricer_assignments a ON a.user_id = s.user_id AND a.asin = s.asin AND a.marketplace = s.marketplace
           WHERE s.user_id = v_uid AND s.asin = 'B0BXKSYPYY' AND s.marketplace = 'US'
             AND s.fetched_at > now() - interval '2 days'
           GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  seller % : % snapshots (% while our status said owner)', r.buybox_seller_id, r.snapshots, r.while_we_were_marked_owner;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== price changes on B0BXKSYPYY in the last 24h ==';
  FOR r IN SELECT count(*) AS decisions,
                  count(*) FILTER (WHERE new_price IS NOT NULL) AS changes,
                  count(*) FILTER (WHERE reason ILIKE '%eligible-gap%') AS gap_raises,
                  count(*) FILTER (WHERE reason ILIKE '%undercut%') AS matches,
                  min(new_price) AS lowest_set, max(new_price) AS highest_set
           FROM public.repricer_ai_decisions
           WHERE user_id = v_uid AND asin = 'B0BXKSYPYY' AND marketplace = 'US' AND created_at > now() - interval '24 hours' LOOP
    RAISE NOTICE '  % evaluations | % price changes | % gap raises | % matches | set between % and %',
      r.decisions, r.changes, r.gap_raises, r.matches, r.lowest_set, r.highest_set;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the same ping-pong across the account (24h) ==';
  FOR r IN SELECT count(*) FILTER (WHERE reason ILIKE '%eligible-gap%') AS gap_raises,
                  count(DISTINCT asin) FILTER (WHERE reason ILIKE '%eligible-gap%') AS asins,
                  count(*) FILTER (WHERE new_price IS NOT NULL) AS total_changes
           FROM public.repricer_ai_decisions
           WHERE user_id = v_uid AND created_at > now() - interval '24 hours' LOOP
    RAISE NOTICE '  % gap raises over % ASINs, out of % price changes in 24h', r.gap_raises, r.asins, r.total_changes;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== worst offenders: ASINs with the most gap raises in 24h ==';
  FOR r IN SELECT asin, count(*) FILTER (WHERE reason ILIKE '%eligible-gap%') AS gap_raises,
                  count(*) FILTER (WHERE new_price IS NOT NULL) AS changes,
                  min(new_price) AS low, max(new_price) AS high
           FROM public.repricer_ai_decisions
           WHERE user_id = v_uid AND created_at > now() - interval '24 hours'
           GROUP BY 1 HAVING count(*) FILTER (WHERE reason ILIKE '%eligible-gap%') > 0
           ORDER BY 2 DESC LIMIT 8 LOOP
    RAISE NOTICE '  % : % gap raises, % changes, prices % .. %', r.asin, r.gap_raises, r.changes, r.low, r.high;
  END LOOP;
END
$p$;
