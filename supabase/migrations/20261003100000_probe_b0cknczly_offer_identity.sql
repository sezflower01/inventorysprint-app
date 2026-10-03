-- READ-ONLY PROBE. The repricer is holding at $16.20 because it believes a
-- competitor is AT $16.20: "Already lowest among eligible competitors
-- ($16.20 <= $16.20) -- holding price (BB owner)". We also hold the Buy Box
-- (A1B0EBOAJDDILW is us) and we are the lowest FBA offer, with the lowest FBM
-- offer up at $21.39.
--
-- Either reading is consistent with that line, and they are worth very
-- different money:
--   * a real rival matching us to the cent -> $16.20 is the market, 26.5% net
--     is the honest return, and raising loses the Buy Box;
--   * our own offer counted as the competitor -> we have been shadowing
--     ourselves down since June, and at $20 this product nets 84% instead of
--     26.5% (about $228/month on 60 units).
--
-- offers_json names the sellers, so it decides. Our seller id is A1B0EBOAJDDILW.

DO $p$
DECLARE v_uid uuid; r record; v_json jsonb; v_when timestamptz;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT offers_json, created_at INTO v_json, v_when
  FROM public.repricer_competitor_snapshots
  WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND offers_json IS NOT NULL
  ORDER BY created_at DESC LIMIT 1;

  IF v_json IS NULL THEN
    RAISE NOTICE 'no offers_json stored for this ASIN';
    RETURN;
  END IF;

  RAISE NOTICE 'snapshot %', v_when;
  RAISE NOTICE 'shape: % | % entries', jsonb_typeof(v_json),
    CASE WHEN jsonb_typeof(v_json) = 'array' THEN jsonb_array_length(v_json) ELSE NULL END;

  RAISE NOTICE '';
  RAISE NOTICE '== keys on the first entry ==';
  FOR r IN SELECT jsonb_object_keys(v_json->0) AS k LOOP
    RAISE NOTICE '  %', r.k;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every offer, cheapest first ==';
  FOR r IN
    SELECT e AS offer
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_json) = 'array' THEN v_json ELSE '[]'::jsonb END) e
    ORDER BY COALESCE((e->>'price')::numeric, (e->>'listing_price')::numeric, 9999)
    LIMIT 15
  LOOP
    RAISE NOTICE '  %', left(r.offer::text, 300);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many offers sit exactly at 16.20, and are any of them ours? ==';
  FOR r IN
    SELECT count(*) AS at_1620,
           count(*) FILTER (WHERE e->>'seller_id' = 'A1B0EBOAJDDILW'
                              OR e->>'sellerId' = 'A1B0EBOAJDDILW') AS ours,
           count(*) FILTER (WHERE COALESCE(e->>'is_fba', e->>'isFba', 'false') IN ('true', 't')) AS fba
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_json) = 'array' THEN v_json ELSE '[]'::jsonb END) e
    WHERE COALESCE((e->>'price')::numeric, (e->>'listing_price')::numeric, 0) BETWEEN 16.19 AND 16.21
  LOOP
    RAISE NOTICE '  % offer(s) at $16.20 | % of them ours | % FBA', r.at_1620, r.ours, r.fba;
  END LOOP;
END
$p$;
