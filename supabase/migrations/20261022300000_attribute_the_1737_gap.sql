-- Is the $17.37 clawback gap a COLLISION loss, or an event that posted after
-- the sync ran? The sync completed 2026-10-22 13:59 UTC; my API read ran
-- 21:39 UTC, so 8 hours of newer events are inside the API window and outside
-- the stored snapshot. Attribution matters: one is a bug, the other is normal.
DO $p$
DECLARE v_uid uuid; v_body jsonb; r record; v_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== every clawback the API reports for October, with its posted time ==';
  FOREACH v_id IN ARRAY ARRAY[26669::bigint, 26733] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    CONTINUE WHEN v_body IS NULL OR v_body ? 'error';
    FOR r IN
      SELECT it->>'posted_date' AS posted, it->>'seller_sku' AS sku,
             it->>'amount_raw' AS amt, it->>'quantity' AS qty
      FROM jsonb_array_elements(v_body->'clawback_items') AS it
      ORDER BY it->>'posted_date'
    LOOP
      RAISE NOTICE '   % | sku % | qty % | $%',
        left(r.posted,19), rpad(COALESCE(r.sku,'-'),16), lpad(COALESCE(r.qty,'-'),3), r.amt;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== every clawback STORED for October ==';
  FOR r IN
    SELECT left(COALESCE(posted_at::text,'-'),19) AS posted, COALESCE(seller_sku,'-') AS sku,
           compensated_clawback AS amt, COALESCE(adjustment_type,'-') AS atype
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND COALESCE(compensated_clawback,0) <> 0
      AND event_date >= '2026-10-01' AND event_date <= '2026-10-31'
    ORDER BY posted_at
  LOOP
    RAISE NOTICE '   % | sku % | $% | %', r.posted, rpad(r.sku,16), lpad(r.amt::text,8), r.atype;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   sync completed 2026-10-22 13:59 UTC. Anything posted AFTER that';
  RAISE NOTICE '   is simply newer than the snapshot, not lost.';
END
$p$;
