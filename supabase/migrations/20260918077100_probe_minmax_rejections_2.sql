-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- (Rewritten: the first version scanned repricer_price_actions with to_jsonb
-- + regex and hit the statement timeout.)
--
-- update-amazon-price sends minimum_seller_allowed_price in the SAME Listings
-- PATCH as the price. Proof on the 5 floors auto-lowered 2026-09-16 13:40 UTC:
-- did the first price pushes afterwards carry the LOWERED min to Amazon, and
-- did Amazon accept them?

DO $p$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT pa.asin, pa.created_at, pa.action_type, pa.old_price, pa.new_price, pa.old_min_price, pa.new_min_price, pa.success,
           pa.trigger_source
    FROM public.repricer_price_actions pa
    JOIN auth.users u ON u.id = pa.user_id AND u.email = 'sezflower01@gmail.com'
    WHERE pa.marketplace = 'US'
      AND pa.asin IN ('B0C4Q8DLXN','B0F6KKKNJ6','B0H4WH84HR','B0H355GGTQ','B004J0FPFW')
      AND pa.created_at BETWEEN '2026-09-16 13:39:00+00' AND '2026-09-16 14:15:00+00'
    ORDER BY pa.asin, pa.created_at
  LOOP
    RAISE NOTICE '% % % | price % -> % | Amazon min % -> % | accepted %',
      r.asin, to_char(r.created_at, 'HH24:MI:SS'), r.action_type, r.old_price, r.new_price, r.old_min_price, r.new_min_price, r.success;
  END LOOP;
END
$p$;
