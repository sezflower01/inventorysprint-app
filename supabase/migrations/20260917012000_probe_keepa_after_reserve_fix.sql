-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- check-seller-watchlist now claims Keepa tokens with the background reserve
-- (120) instead of the repricer default (60); deployed 13:50:42 UTC. Compare
-- its runs before and after, and read the shared budget now. The goal: the
-- ledger no longer sits near zero after each run, so the analyser panel has
-- tokens for price history and seller names.

DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  FOR r IN SELECT tokens_left, denied_count, last_denied_at, last_observed_at FROM public.keepa_token_budget LOOP
    RAISE NOTICE 'budget: tokens_left=% denied=% last_denied=% last_observed=%', round(r.tokens_left, 1), r.denied_count, r.last_denied_at, r.last_observed_at;
  END LOOP;

  RAISE NOTICE '';
  FOR r IN SELECT created,
                  (content::jsonb)->>'checked' AS checked,
                  (content::jsonb)->>'stoppedReason' AS stopped
           FROM net._http_response
           WHERE created > now() - interval '40 minutes' AND content LIKE '%queuedSellers%'
           ORDER BY created LOOP
    RAISE NOTICE '  % %  checked=% stopped=%',
      to_char(r.created, 'HH24:MI:SS'),
      CASE WHEN r.created > '2026-09-17 13:50:42+00' THEN 'AFTER ' ELSE 'before' END,
      r.checked, r.stopped;
  END LOOP;
END
$p$;
