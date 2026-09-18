-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- Seller: when the min is lowered, the PRICE must follow it down too. The
-- worker only writes min_price_override and leaves pricing to the repricer.
-- For the 5 floors lowered 2026-09-16 13:40 UTC: what did the repricer decide
-- and apply afterwards?

DO $p$
DECLARE r record; d record;
BEGIN
  FOR r IN SELECT a.id, a.asin, a.min_price_override AS min_now, a.last_applied_price, to_jsonb(a)->>'last_applied_at' AS last_applied_at,
                  to_jsonb(a)->>'last_recommendation_reason' AS last_reason
           FROM public.repricer_assignments a JOIN auth.users u ON u.id = a.user_id AND u.email = 'sezflower01@gmail.com'
           WHERE a.marketplace = 'US' AND a.asin IN ('B0C4Q8DLXN','B0F6KKKNJ6','B0H4WH84HR','B0H355GGTQ','B004J0FPFW') LOOP
    RAISE NOTICE '== % min now % | last applied price % at % | last reason: %', r.asin, r.min_now, r.last_applied_price, r.last_applied_at, left(r.last_reason, 110);
    FOR d IN SELECT created_at, current_price, new_price, min_price_used, lowest_fba_price, buybox_price, mode, left(reason, 90) AS reason
             FROM public.repricer_ai_decisions
             WHERE assignment_id = r.id AND created_at BETWEEN '2026-09-16 13:39:00+00' AND '2026-09-16 15:00:00+00'
             ORDER BY created_at LIMIT 4 LOOP
      RAISE NOTICE '   % price % -> % | min used % | lowest FBA % BB % | % | %', to_char(d.created_at, 'HH24:MI'), d.current_price, d.new_price, d.min_price_used, d.lowest_fba_price, d.buybox_price, d.mode, d.reason;
    END LOOP;
  END LOOP;
END
$p$;
