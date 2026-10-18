-- READ-ONLY. Step 5: which Keepa price the button reads, and why it landed
-- +93 pct and +113 pct on two CA orders. Nothing is changed.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== every track Keepa holds for the two CA ASINs that jumped ==';
  RAISE NOTICE '   (the button prefers buybox, then newFba, then newFbm)';
  RAISE NOTICE '';
  FOR r IN
    SELECT k.asin, k.marketplace AS mk, t.track,
           jsonb_array_length(COALESCE(k.series->t.track,'[]'::jsonb)) AS points,
           (SELECT (e->>'v')::numeric FROM jsonb_array_elements(k.series->t.track) e
            WHERE (e->>'v')::numeric > 0
            ORDER BY (e->>'t') DESC LIMIT 1) AS newest_v,
           (SELECT (e->>'t') FROM jsonb_array_elements(k.series->t.track) e
            WHERE (e->>'v')::numeric > 0
            ORDER BY (e->>'t') DESC LIMIT 1) AS newest_t,
           (SELECT (e->>'v')::numeric FROM jsonb_array_elements(k.series->t.track) e
            WHERE (e->>'v')::numeric > 0
            ORDER BY (e->>'t') ASC LIMIT 1) AS oldest_v,
           k.expires_at
    FROM public.keepa_price_history_cache k
    CROSS JOIN (VALUES ('buybox'),('newFba'),('newFbm'),('newPrice'),('amazon')) AS t(track)
    WHERE k.asin IN ('B002HJ4HSS','B08HHBDW3C') AND k.marketplace = 'CA'
    ORDER BY k.asin, t.track
  LOOP
    RAISE NOTICE '   % % | % | % pts | newest % at % | oldest %',
      r.asin, rpad(r.mk,3), rpad(r.track,9), lpad(r.points::text,3),
      lpad(COALESCE(r.newest_v::text,'-'),8), COALESCE(r.newest_t,'-'),
      COALESCE(r.oldest_v::text,'-');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no CA history rows for either ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== B002HJ4HSS: we now have Amazon ground truth (CA$34.13) ==';
  RAISE NOTICE '   snapshot estimate  20.75  -> % pct vs truth',
    round((100*(20.75-34.13)/34.13)::numeric,1);
  RAISE NOTICE '   Keepa buybox       44.27  -> % pct vs truth',
    round((100*(44.27-34.13)/34.13)::numeric,1);
  RAISE NOTICE '   So the +113 pct JUMP was between two wrong numbers on';
  RAISE NOTICE '   opposite sides of the real price, not a 113 pct error.';

  RAISE NOTICE '';
  RAISE NOTICE '== is OUR OWN offer in the picture? our CA list price for these ==';
  FOR r IN
    SELECT asin, COALESCE(marketplace_id,'-') AS mp, my_price,
           COALESCE(currency,'-') AS cur, COALESCE(source,'-') AS src, fetched_at
    FROM public.asin_my_price_cache
    WHERE user_id = v_uid AND asin IN ('B002HJ4HSS','B08HHBDW3C')
    ORDER BY asin, fetched_at DESC
  LOOP
    RAISE NOTICE '   % | % | my_price % % | % | %',
      r.asin, rpad(r.mp,16), lpad(r.my_price::text,8), r.cur, rpad(r.src,14), r.fetched_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no my-price cache rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what did the snapshot estimate come from, for these two? ==';
  FOR r IN
    SELECT l.order_id, l.asin, l.old_estimate, l.new_estimate,
           COALESCE(l.old_price_source,'-') AS osrc, l.keepa_track, l.keepa_point_at, l.applied_at
    FROM public.keepa_estimate_recheck_log l
    WHERE l.user_id = v_uid AND l.asin IN ('B002HJ4HSS','B08HHBDW3C')
    ORDER BY l.applied_at
  LOOP
    RAISE NOTICE '   % % | % -> % | prev src %',
      r.order_id, r.asin, r.old_estimate, r.new_estimate, r.osrc;
    RAISE NOTICE '        keepa track % captured % | applied %',
      r.keepa_track, r.keepa_point_at, r.applied_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how far is the Keepa point from the PURCHASE time? ==';
  FOR r IN
    SELECT so.order_id, so.asin, so.purchase_timestamp_utc AS bought,
           l.keepa_point_at AS captured,
           (l.keepa_point_at - so.purchase_timestamp_utc) AS gap
    FROM public.keepa_estimate_recheck_log l
    JOIN public.sales_orders so ON so.order_id = l.order_id AND so.user_id = l.user_id
    WHERE l.user_id = v_uid
    ORDER BY (l.keepa_point_at - so.purchase_timestamp_utc) DESC
  LOOP
    RAISE NOTICE '   % % | bought % | keepa point % | gap %',
      r.order_id, r.asin, r.bought, r.captured, r.gap;
  END LOOP;
END
$p$;
