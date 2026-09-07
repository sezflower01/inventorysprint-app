-- PROBE (read-only): how much price oscillation is happening?
--
-- One listing shows a clean loop in twelve minutes:
--   15:22 lowered 28.10 -> 28.07  competitive_micro_step
--   15:30 raised  28.07 -> 28.10  eligible_gap_recovery_raise
--   15:34 lowered 28.10 -> 28.07  competitive_micro_step
--
-- The suspicious part is the stated reason for the drop: "match the lowest
-- competitor price ($28.07)" -- while the panel reports Buy Box $28.10, Lowest
-- FBA $28.10, and the seller already lowest at $28.07. There is no competitor
-- at $28.07. The only offer that was ever at $28.07 is the seller's own, from
-- before the raise. If the offer snapshot still carries their pre-change price
-- the engine is undercutting ITSELF, then gap-recovery raises again, forever.
--
-- Each lap is a real SP-API submission and a real price change, so this is
-- quota and margin, not just noise.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '======== ASINs flipping between the same two prices today ========';
  n := 0;
  FOR r IN
    WITH acts AS (
      SELECT asin, marketplace, created_at, old_price, new_price,
             LAG(new_price)  OVER (PARTITION BY asin, marketplace ORDER BY created_at) AS prev_new
      FROM public.repricer_price_actions
      WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
        AND created_at > now() - interval '12 hours'
        AND new_price IS NOT NULL AND old_price IS NOT NULL
        AND new_price <> old_price
    )
    SELECT asin, marketplace,
           count(*) AS changes,
           count(DISTINCT new_price) AS distinct_prices,
           min(new_price) AS lo, max(new_price) AS hi,
           round((max(new_price) - min(new_price))::numeric, 2) AS spread
    FROM acts
    GROUP BY asin, marketplace
    HAVING count(*) >= 4 AND count(DISTINCT new_price) <= 3
    ORDER BY changes DESC
    LIMIT 15
  LOOP
    n := n + 1;
    RAISE NOTICE '   % | % | % changes between only % prices ($% .. $%, spread $%)',
      r.asin, r.marketplace, r.changes, r.distinct_prices, r.lo, r.hi, r.spread;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '   (none flipping between <=3 prices with 4+ changes)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== how many price changes today, and how many are reversals? ========';
  FOR r IN
    WITH acts AS (
      SELECT asin, marketplace, created_at, old_price, new_price,
             CASE WHEN new_price > old_price THEN 'up' ELSE 'down' END AS dir,
             LAG(CASE WHEN new_price > old_price THEN 'up' ELSE 'down' END)
               OVER (PARTITION BY asin, marketplace ORDER BY created_at) AS prev_dir
      FROM public.repricer_price_actions
      WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
        AND created_at > now() - interval '24 hours'
        AND new_price IS NOT NULL AND old_price IS NOT NULL AND new_price <> old_price
    )
    SELECT count(*) AS changes,
           count(*) FILTER (WHERE prev_dir IS NOT NULL AND dir <> prev_dir) AS reversals,
           count(DISTINCT asin) AS asins
    FROM acts
  LOOP
    RAISE NOTICE '   % actual price changes across % ASINs | % were direction reversals',
      r.changes, r.asins, r.reversals;
    IF r.changes > 0 THEN
      RAISE NOTICE '   -> %%% of changes immediately reversed the previous move',
        round(100.0 * r.reversals / r.changes, 1);
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== the worst offender, blow by blow ========';
  FOR r IN
    WITH worst AS (
      SELECT asin, marketplace
      FROM public.repricer_price_actions
      WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
        AND created_at > now() - interval '12 hours'
        AND new_price IS NOT NULL AND old_price IS NOT NULL AND new_price <> old_price
      GROUP BY asin, marketplace ORDER BY count(*) DESC LIMIT 1
    )
    SELECT to_char(pa.created_at AT TIME ZONE 'America/Chicago','HH24:MI:SS') AS t,
           pa.asin, pa.old_price, pa.new_price, left(COALESCE(pa.reason,''), 76) AS reason
    FROM public.repricer_price_actions pa
    JOIN worst w ON w.asin = pa.asin AND w.marketplace = pa.marketplace
    WHERE pa.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
      AND pa.created_at > now() - interval '12 hours'
      AND pa.new_price IS NOT NULL AND pa.old_price IS NOT NULL AND pa.new_price <> pa.old_price
    ORDER BY pa.created_at DESC LIMIT 14
  LOOP
    RAISE NOTICE '   % | % | % -> % | %', r.t, r.asin, r.old_price, r.new_price, r.reason;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== is oscillation protection configured on Momentum Smart? ========';
  FOR r IN
    SELECT oscillation_mode, oscillation_max_reactions, oscillation_cooldown_minutes,
           oscillation_bb_loss_limit, war_protection_minutes, min_change_threshold,
           cooldown_minutes
    FROM public.repricer_rules
    WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
      AND name = 'Momentum Smart'
  LOOP
    RAISE NOTICE '   mode=% max_reactions=% cooldown=%min bb_loss_limit=% war_protection=%min',
      r.oscillation_mode, r.oscillation_max_reactions, r.oscillation_cooldown_minutes,
      r.oscillation_bb_loss_limit, r.war_protection_minutes;
    RAISE NOTICE '   min_change_threshold=% | cooldown_minutes=%', r.min_change_threshold, r.cooldown_minutes;
  END LOOP;
END
$probe$;
