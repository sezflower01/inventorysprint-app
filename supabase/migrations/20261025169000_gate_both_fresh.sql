-- READ-ONLY. Both of today's fresh reports, through the freshness guard.
DO $p$
DECLARE b jsonb; m record;
BEGIN
  FOR m IN SELECT unnest(ARRAY['2026-02-01','2026-05-01']::date[]) AS d,
                  unnest(ARRAY[-227.95, -187.96]::numeric[]) AS want_claw
  LOOP
    b := public.repull_find_fresh_report(m.d, current_date::timestamptz);
    RAISE NOTICE '== % ==', to_char(m.d,'YYYY-MM');
    IF b IS NULL THEN
      RAISE NOTICE '   NO FRESH REPORT today -- stop';
    ELSE
      RAISE NOTICE '   items % | pages % | elapsed % ms',
        b->>'api_items', b->>'pages', b->>'elapsed_ms';
      RAISE NOTICE '   rate-limit hits % | catch-all % | types %',
        b->>'rate_limit_hits', b->>'api_items_via_catchall', b->'api_catchall_types';
      RAISE NOTICE '   stored % -> api % | clawbacks % (want %)',
        b->>'stored_signed_total', b->>'api_signed_total', b->>'api_clawback_total', m.want_claw;
      RAISE NOTICE '   GATES: hits=0 % | catchall=0 % | clawbacks match %',
        ((b->>'rate_limit_hits')::int = 0),
        ((b->>'api_items_via_catchall')::int = 0),
        ((b->>'api_clawback_total')::numeric = m.want_claw);
    END IF;
    RAISE NOTICE '';
  END LOOP;
END
$p$;
