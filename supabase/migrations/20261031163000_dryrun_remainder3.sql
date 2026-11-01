-- DRY RUN remainder pass 3, at the new 3200ms pacing (32 per invocation).
--
-- The six batches validated 284 of 285 candidates, but the response capped
-- `rows` at 40 while the counts stayed complete, so 217 would_repair came back
-- with 189 rows of detail. 66 were also throttled (429) and never reached
-- Amazon at all. Together that leaves a remainder with no validated per-order
-- figures, and a COGS prediction built on the 189 is short.
--
-- Rather than re-walk all 285, this derives the remainder directly: every
-- current candidate whose order_id does NOT appear in the six responses. Those
-- go back through the dry run by explicit order_ids, which bypasses the
-- shortlist and checks exactly the given orders.
--
-- The reporting cap is now 250 (deployed 2026-10-31) with rows_total and
-- rows_truncated alongside it, so a 50-row invocation cannot be truncated
-- again, and if it ever were the response would say so.
DO $p$
DECLARE
  v_uid uuid; v_secret text; v_req bigint; r record;
  v_reqs bigint[] := ARRAY[59951, 59985, 60032, 60055, 60078, 60105, 60157, 60192];
  v_rq bigint; v_content text; v_ids text[]; v_n int; v_rem int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  CREATE TEMP TABLE seen (order_id text PRIMARY KEY) ON COMMIT DROP;
  FOREACH v_rq IN ARRAY v_reqs LOOP
    SELECT content INTO v_content FROM net._http_response WHERE id = v_rq;
    IF v_content IS NULL THEN
      RAISE NOTICE '>>> response % missing. STOPPING -- the remainder would be', v_rq;
      RAISE NOTICE '    computed against an incomplete seen-set and would';
      RAISE NOTICE '    re-check orders unnecessarily.';
      RETURN;
    END IF;
    INSERT INTO seen (order_id)
    SELECT DISTINCT e->>'order_id'
    FROM jsonb_array_elements(COALESCE(v_content::jsonb->'rows','[]'::jsonb)) AS e
    WHERE e->>'order_id' IS NOT NULL
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT count(*) INTO v_n FROM seen;
  RAISE NOTICE '== orders with validated detail already in hand: % ==', v_n;

  CREATE TEMP TABLE rem ON COMMIT DROP AS
  SELECT c.order_id, c.asin, c.quantity, c.implied_units,
         (c.implied_units - c.quantity) AS gap
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0) c
  LEFT JOIN seen s ON s.order_id = c.order_id
  WHERE s.order_id IS NULL;

  SELECT count(*) INTO v_rem FROM rem;
  RAISE NOTICE '   candidates still needing validation: %', v_rem;
  RAISE NOTICE '   (truncated detail + throttled + unverifiable)';

  IF v_rem = 0 THEN
    RAISE NOTICE '   nothing left to validate. Not firing.';
    RETURN;
  END IF;

  SELECT array_agg(order_id ORDER BY gap DESC, order_id)
    INTO v_ids
  FROM (SELECT order_id, gap FROM rem ORDER BY gap DESC, order_id LIMIT 32) x;

  RAISE NOTICE '';
  RAISE NOTICE '   sending % ids this pass (biggest gaps first):',
    array_length(v_ids,1);
  FOR r IN SELECT order_id, asin, quantity, implied_units FROM rem
           WHERE order_id = ANY(v_ids) ORDER BY (implied_units - quantity) DESC
  LOOP
    RAISE NOTICE '      % | % | stored % | money implies %', r.order_id,
      rpad(r.asin,12), lpad(r.quantity::text,3), r.implied_units;
  END LOOP;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid, 'marketplace', NULL,
                               'limit', 32, 'order_ids', to_jsonb(v_ids)),
    timeout_milliseconds := 118000
  ) INTO v_req;

  RAISE NOTICE '';
  RAISE NOTICE '   remainder pass 3 fired at % -- request %', clock_timestamp(), v_req;
  RAISE NOTICE '   DRY RUN: dry_run not passed, default true, repaired must be 0.';
END
$p$;
