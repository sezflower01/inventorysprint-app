DO $p$
DECLARE v_body jsonb; r record;
BEGIN
  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 26773;
  IF v_body IS NULL THEN RAISE NOTICE '== 26773 (Sep 16..Oct 1): pending ==';
  ELSIF v_body ? 'error' THEN RAISE NOTICE '== 26773 ERROR: % ==', left(v_body->>'error',200);
  ELSE
    RAISE NOTICE '== Sep 16 .. Oct 1 | items % ==', v_body->>'adjustment_items';
    FOR r IN SELECT key AS a, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS t
             FROM jsonb_each(v_body->'by_adjustment_type') ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP RAISE NOTICE '   % | % | $%', rpad(r.a,32), lpad(r.n::text,4), r.t; END LOOP;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== CLAWBACK SIZING, all slices measured so far ==';
  RAISE NOTICE '   Jul 24 - Aug 1  (8d) : 10 events | $-51.58';
  RAISE NOTICE '   Aug 1  - Aug 16      :  8 events | $-57.89';
  RAISE NOTICE '   Aug 16 - Sep 1       :  6 events | $-74.19';
  RAISE NOTICE '   Sep 1  - Sep 16      :  6 events | $-97.21';
  RAISE NOTICE '   Sep 16 - Oct 1       : see above';
  RAISE NOTICE '   Oct 1  - Oct 16      :  8 events | $-101.25';
  RAISE NOTICE '   Oct 16 - Oct 22      :  4 events | $-33.68';
END
$p$;
