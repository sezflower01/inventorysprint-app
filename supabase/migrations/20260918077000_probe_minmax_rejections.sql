-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- update-amazon-price sends minimum_seller_allowed_price in the SAME Listings
-- PATCH as the new price, so a lowered min should reach Amazon with the price.
-- Confirm from Amazon's answers: in the last 14 days, did any price push for
-- an auto-lowered assignment fail on min/max bounds?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE to_jsonb(p)::text ~* '(minimum_seller_allowed_price|maximum_seller_allowed_price|must be between|min/max)') AS minmax_failures,
           count(*) FILTER (WHERE COALESCE(to_jsonb(p)->>'status','') ILIKE '%fail%' OR to_jsonb(p)->>'error' IS NOT NULL) AS failures
    FROM public.price_actions p
    JOIN public.repricer_assignments a ON a.user_id = p.user_id AND a.asin = p.asin AND a.marketplace = 'US'
    WHERE p.user_id = v_uid AND p.created_at > now() - interval '14 days' AND COALESCE(a.auto_floor_drop_count, 0) > 0
  LOOP
    RAISE NOTICE 'price actions on auto-lowered ASINs (14 d): % | failed % | min/max-bound failures %', r.n, r.failures, r.minmax_failures;
  END LOOP;

  FOR r IN
    SELECT p.asin, p.created_at, left(regexp_replace(to_jsonb(p)::text, '\s+', ' ', 'g'), 220) AS j
    FROM public.price_actions p
    WHERE p.user_id = v_uid AND p.created_at > now() - interval '14 days'
      AND to_jsonb(p)::text ~* '(minimum_seller_allowed_price|must be between)'
    ORDER BY p.created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  % % | %', r.asin, r.created_at, r.j;
  END LOOP;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  RAISE NOTICE 'shape differs: %', SQLERRM;
END
$p$;
