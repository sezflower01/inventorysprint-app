-- READ-ONLY PROBE. Lowest overall, lowest FBA and the Buy Box have all read
-- exactly $16.20 for eight days, which is also our own price and one cent above
-- our $16.15 floor. Two very different worlds produce that:
--
--   A. competitors sit at $16.20 and the repricer is matching them -- the price
--      is market-set, and buying more at 26.5% net is the whole decision;
--   B. we are the only offer (or the only competitive one) and the repricer has
--      simply parked us at our own floor -- in which case the price is OURS to
--      raise, and at $20 this product nets 84% instead of 26.5%.
--
-- offers_count and the Buy Box seller settle it. The realised price falling
-- 20.96 -> 20.35 -> 17.44 -> 16.77 -> 16.20 since June looks like competitive
-- pressure, but it looks identical to a repricer walking its own floor down.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== offers on the listing, last 10 days ==';
  FOR r IN SELECT date_trunc('day', created_at) AS d,
                  round(avg(offers_count)::numeric, 1) AS avg_offers,
                  min(offers_count) AS min_offers, max(offers_count) AS max_offers,
                  round(min(lowest_overall_price)::numeric, 2) AS lowest,
                  round(min(buybox_price)::numeric, 2) AS bb,
                  bool_or(buybox_is_fba) AS bb_fba,
                  max(buybox_seller_name) AS bb_seller
           FROM public.repricer_competitor_snapshots
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
             AND created_at > now() - interval '10 days'
           GROUP BY 1 ORDER BY 1 DESC LOOP
    RAISE NOTICE '  % | offers % (%-%) | lowest $% | bb $% | bb_fba % | seller %',
      r.d, r.avg_offers, r.min_offers, r.max_offers, r.lowest, r.bb, r.bb_fba,
      COALESCE(r.bb_seller, '(none)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the most recent snapshot in full ==';
  FOR r IN SELECT created_at, offers_count, lowest_overall_price, lowest_fba_price,
                  lowest_fbm_price, buybox_price, buybox_seller_id, buybox_seller_name,
                  buybox_is_fba, source
           FROM public.repricer_competitor_snapshots
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY'
           ORDER BY created_at DESC LIMIT 1 LOOP
    RAISE NOTICE '  % | % offers | lowest overall $% (fba $%, fbm $%)',
      r.created_at, r.offers_count, r.lowest_overall_price, r.lowest_fba_price, r.lowest_fbm_price;
    RAISE NOTICE '  buybox $% held by % (%) | fba % | source %',
      r.buybox_price, COALESCE(r.buybox_seller_name, '?'), COALESCE(r.buybox_seller_id, '?'),
      r.buybox_is_fba, r.source;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== our own seller id, for comparison ==';
  FOR r IN SELECT DISTINCT COALESCE(seller_id, selling_partner_id) AS sid
           FROM public.seller_authorizations WHERE user_id = v_uid LOOP
    RAISE NOTICE '  %', r.sid;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== what the repricer thinks it is doing ==';
  FOR r IN SELECT marketplace, sku, min_price_override, max_price_override,
                  last_applied_price, last_buybox_status, last_recommendation_reason,
                  last_skip_reason, rule_id, last_applied_at
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B0CKJNCZLY' AND marketplace = 'US' LOOP
    RAISE NOTICE '  % % | bounds %/% | last applied % at %',
      r.marketplace, r.sku, r.min_price_override, r.max_price_override, r.last_applied_price, r.last_applied_at;
    RAISE NOTICE '  buybox status % | rule %', r.last_buybox_status, r.rule_id;
    RAISE NOTICE '  reason: %', left(COALESCE(r.last_recommendation_reason, '(none)'), 300);
    RAISE NOTICE '  skip:   %', left(COALESCE(r.last_skip_reason, '(none)'), 200);
  END LOOP;
END
$p$;
