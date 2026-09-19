-- READ-ONLY PROBE. Creates nothing, changes nothing.
-- (Rewritten: a per-listing staleness scan over 679 listings timed out.)
-- Seller asks: does auto-lower skip listings that already own the Buy Box or
-- are already the lowest? The code does (already_owns_buybox,
-- already_lowest). Check the 6 real lowers at 20:03 UTC: what did the
-- repricer's own last evaluation of each listing see just before?

DO $p$
DECLARE r record; v jsonb;
BEGIN
  SELECT to_jsonb(h)->'detail' INTO v FROM public.cron_run_history h
  WHERE to_jsonb(h)::text LIKE '%repricer-auto-lower-min%'
    AND (to_jsonb(h)->>'started_at')::timestamptz BETWEEN '2026-09-18 20:03:00+00' AND '2026-09-18 20:04:00+00'
  LIMIT 1;
  RAISE NOTICE 'skips that run: already_owns_buybox % | already_lowest %',
    v->'skip_reasons'->>'already_owns_buybox', v->'skip_reasons'->>'already_lowest';

  FOR r IN
    SELECT d->>'asin' AS asin, (d->>'assignment_id')::uuid AS aid, d->>'current_min' AS cur_min, d->>'new_min' AS new_min, d->>'lowest' AS lowest
    FROM jsonb_array_elements(v->'decisions') d WHERE d->>'action' = 'lower'
  LOOP
    RAISE NOTICE '  % min % -> % (lowest %) | BB status now % | last eval before: %', r.asin, r.cur_min, r.new_min, r.lowest,
      (SELECT last_buybox_status FROM public.repricer_assignments WHERE id = r.aid),
      (SELECT format('%s price %s, BB %s, lowest FBA %s: %s', to_char(d.created_at, 'HH24:MI'), d.current_price, d.buybox_price, d.lowest_fba_price, left(d.reason, 80))
       FROM public.repricer_ai_decisions d
       WHERE d.assignment_id = r.aid AND d.created_at BETWEEN '2026-09-18 18:00:00+00' AND '2026-09-18 20:03:30+00'
       ORDER BY d.created_at DESC LIMIT 1);
  END LOOP;
END
$p$;
