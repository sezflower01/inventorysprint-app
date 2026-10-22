-- ITEM 2: October's live API totals vs what we stored. The gap is what the
-- per-page key collision cost.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; v_body jsonb; r record;
        v_api_items int := 0; v_api_signed numeric := 0; v_api_claw numeric := 0; v_api_claw_n int := 0;
        v_st_rows int; v_st_signed numeric; v_st_claw numeric; v_st_claw_n int;
        v_id bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET';

  FOREACH v_id IN ARRAY ARRAY[26669::bigint, 26733] LOOP
    SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = v_id;
    CONTINUE WHEN v_body IS NULL OR v_body ? 'error';
    v_api_items := v_api_items + (v_body->>'adjustment_items')::int;
    FOR r IN SELECT key AS a, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS t
             FROM jsonb_each(v_body->'by_adjustment_type')
    LOOP
      v_api_signed := v_api_signed + r.t;
      IF upper(r.a) LIKE '%COMPENSATED_CLAWBACK%' THEN
        v_api_claw := v_api_claw + r.t; v_api_claw_n := v_api_claw_n + r.n;
      END IF;
    END LOOP;
  END LOOP;

  SELECT count(*),
         round(sum(COALESCE(reimbursements,0)+COALESCE(warehouse_lost,0)+COALESCE(warehouse_damage,0)
                  +COALESCE(reversal_reimbursement,0)+COALESCE(free_replacement_refund_items,0)
                  +COALESCE(compensated_clawback,0)),2),
         round(sum(COALESCE(compensated_clawback,0)),2),
         count(*) FILTER (WHERE adjustment_type = 'COMPENSATED_CLAWBACK')
    INTO v_st_rows, v_st_signed, v_st_claw, v_st_claw_n
  FROM public.financial_events_cache
  WHERE user_id = v_uid AND event_type='adjustment'
    AND event_date >= '2026-10-01' AND event_date <= '2026-10-31';

  RAISE NOTICE '== ITEM 2: OCTOBER COLLISION LOSS ==';
  RAISE NOTICE '   LIVE API : % items | signed $% | clawback $% over % events',
    v_api_items, round(v_api_signed,2), round(v_api_claw,2), v_api_claw_n;
  RAISE NOTICE '   STORED   : % rows  | signed $% | clawback $% over % typed rows',
    v_st_rows, v_st_signed, v_st_claw, v_st_claw_n;
  RAISE NOTICE '   --------------------------------------------------';
  RAISE NOTICE '   ITEMS LOST  : %', v_api_items - v_st_rows;
  RAISE NOTICE '   MONEY LOST  : $% (signed total)', round(v_api_signed - v_st_signed, 2);
  RAISE NOTICE '   CLAWBACK LOST: $%', round(v_api_claw - v_st_claw, 2);
  RAISE NOTICE '';
  RAISE NOTICE '   Collisions MERGE rather than duplicate (123 rows / 123 keys),';
  RAISE NOTICE '   and dedupeCacheEntries SUMS the money columns -- so a merge';
  RAISE NOTICE '   should preserve the total. Any money gap means two items with';
  RAISE NOTICE '   the same key landed in DIFFERENT columns and one was summed';
  RAISE NOTICE '   into a column the other had already claimed, or the upsert';
  RAISE NOTICE '   overwrote rather than merged across separate batches.';

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/probe-adjustment-events',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
      'posted_after','2026-09-01T00:00:00Z','posted_before','2026-09-16T00:00:00Z','summary_only',true),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '';
  RAISE NOTICE '== Sep 1..16 -> request % ==', v_req;

  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 26749;
  RAISE NOTICE '';
  IF v_body IS NULL THEN RAISE NOTICE '== 26749 (Aug 16..Sep 1): pending ==';
  ELSIF v_body ? 'error' THEN RAISE NOTICE '== 26749 ERROR: % ==', left(v_body->>'error',200);
  ELSE
    RAISE NOTICE '== Aug 16..Sep 1 | items % ==', v_body->>'adjustment_items';
    FOR r IN SELECT key AS a, (value->>'items')::int AS n, (value->>'signed_total')::numeric AS t
             FROM jsonb_each(v_body->'by_adjustment_type') ORDER BY abs((value->>'signed_total')::numeric) DESC
    LOOP RAISE NOTICE '   % | % | $%', rpad(r.a,32), lpad(r.n::text,4), r.t; END LOOP;
  END IF;
END
$p$;
