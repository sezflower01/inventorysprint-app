-- Record the two COG edits made before the change log existed, and verify the
-- page's save path end to end AS THE SELLER.
--
-- ---- THE GAP ------------------------------------------------------------
--
-- The COG page went live in 9409dea, before 20260915010000 added the history
-- log. In that window the seller set two COGs at 2026-09-15 01:29 UTC:
--   B0G4BQ42W3 (Funko Derpy)  NULL -> 10.00   (import left it unset for review)
--   B0G4B3117X (Funko Rumi)   13.00 -> 10.00  (import value)
-- The activation then applied both, correctly -- 20260915011000 confirmed it.
-- They are the only manual rows. Recorded here so the log is complete, with a
-- note saying how they were recorded. Each row was edited once (a single
-- updated_at, and source flipped from import to manual), so the prior value is
-- the imported one.
--
-- ---- THE VERIFICATION ---------------------------------------------------
--
-- Migrations run as postgres, which bypasses RLS and has an auth.uid() of
-- NULL, so a save made here would not prove the page works. This impersonates
-- the seller the way PostgREST does and performs the page's exact update, then
-- checks that the chain fired: sales re-priced, history written with the
-- seller's id and email, the log unwritable from the browser. All inside a
-- block that rolls back.

ALTER TABLE public.asin_cog_on_record_history
  ADD COLUMN IF NOT EXISTS note TEXT;

DO $backfill$
DECLARE v_uid uuid; v_email text; v_n int;
BEGIN
  SELECT id, email INTO v_uid, v_email FROM auth.users WHERE email = 'sezflower01@gmail.com';

  INSERT INTO public.asin_cog_on_record_history
    (user_id, asin, action, old_unit_cost, new_unit_cost, old_source, new_source,
     sales_rows_repriced, changed_by, changed_by_email, changed_at, note)
  SELECT c.user_id, c.asin, 'changed',
         CASE WHEN c.needs_review IS FALSE AND c.asin = 'B0G4BQ42W3' THEN NULL ELSE c.calculated_cost END,
         c.unit_cost, 'import', 'manual',
         (SELECT count(*) FROM public.sales_cost_backup_cog_activation b
            JOIN public.sales_orders s ON s.id::text = b.sales_order_id
           WHERE b.user_id = c.user_id AND b.asin = c.asin
             AND (b.total_cost IS DISTINCT FROM s.total_cost OR b.cost_source_at_sale IS DISTINCT FROM 'cog_on_record')),
         v_uid, v_email, c.updated_at,
         'Edited on the COG page before the change log existed; recorded afterwards from the row''s '
         || 'timestamps (20260915012000). Applied to 2026 sales by the activation in 20260915010000.'
  FROM public.asin_cog_on_record c
  WHERE c.user_id = v_uid AND c.source = 'manual'
    AND c.asin IN ('B0G4BQ42W3', 'B0G4B3117X')
    AND NOT EXISTS (SELECT 1 FROM public.asin_cog_on_record_history h
                    WHERE h.user_id = c.user_id AND h.asin = c.asin);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'backfilled % history rows', v_n;
END
$backfill$;

DO $verify$
DECLARE
  v_uid uuid;
  v_n int;
  v_row record;
  v_before numeric;
  v_after numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR v_row IN SELECT asin, action, old_unit_cost, new_unit_cost, sales_rows_repriced, changed_by_email, changed_at
               FROM public.asin_cog_on_record_history WHERE user_id = v_uid ORDER BY changed_at LOOP
    RAISE NOTICE 'history: % % % -> % | % sales | % | %', v_row.asin, v_row.action,
      COALESCE(v_row.old_unit_cost::text, 'not set'), v_row.new_unit_cost, v_row.sales_rows_repriced,
      v_row.changed_by_email, v_row.changed_at;
  END LOOP;

  SELECT round(sum(total_cost), 2) INTO v_before FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B071GWMDWD' AND order_date >= '2026-01-01';

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated', 'email', 'sezflower01@gmail.com')::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    -- The page's exact save.
    UPDATE public.asin_cog_on_record
       SET unit_cost = 14.00, source = 'manual', needs_review = false
     WHERE asin = 'B071GWMDWD';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '1. seller saves B071GWMDWD 13.50 -> 14.00: % row updated', v_n;

    SELECT action, old_unit_cost, new_unit_cost, sales_rows_repriced, changed_by = v_uid AS by_seller, changed_by_email
      INTO v_row
    FROM public.asin_cog_on_record_history
    WHERE asin = 'B071GWMDWD' ORDER BY id DESC LIMIT 1;
    RAISE NOTICE '2. history as seen by the seller: % % -> % | % sales re-priced | by seller: % (%)',
      v_row.action, v_row.old_unit_cost, v_row.new_unit_cost, v_row.sales_rows_repriced, v_row.by_seller, v_row.changed_by_email;

    SELECT round(sum(total_cost), 2) INTO v_after FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B071GWMDWD' AND order_date >= '2026-01-01';
    RAISE NOTICE '3. B071GWMDWD 2026 total_cost $% -> $% (expect +0.50 per unit)', v_before, v_after;

    BEGIN
      UPDATE public.asin_cog_on_record_history SET new_unit_cost = 1 WHERE asin = 'B071GWMDWD';
      GET DIAGNOSTICS v_n = ROW_COUNT;
      RAISE NOTICE '4. seller tries to edit the log: % rows changed (expect 0)', v_n;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '4. seller tries to edit the log: refused (%)', SQLERRM;
    END;

    RAISE EXCEPTION 'rollback-verify';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-verify' THEN RAISE; END IF;
    RAISE NOTICE '   (rolled back)';
  END;

  SET LOCAL ROLE postgres;

  SELECT round(sum(total_cost), 2) INTO v_after FROM public.sales_orders
  WHERE user_id = v_uid AND asin = 'B071GWMDWD' AND order_date >= '2026-01-01';
  RAISE NOTICE 'after rollback: B071GWMDWD 2026 total_cost $% (must equal $%)', v_after, v_before;
END
$verify$;
