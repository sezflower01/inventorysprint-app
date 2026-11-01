-- PHASE 1c: back up the 9, then repair quantity ONLY.
--
-- The 9 are the 8 ceiling-skips plus 111-7767894-5821021, all confirmed against
-- GetOrderItems on 2026-11-01 as genuine quantity errors. The other 19
-- non-whole-number orders and the 9 revenue-only corrections are NOT in this
-- list and are not reachable by it -- the order_ids are enumerated explicitly
-- below rather than derived, so the set cannot widen on its own the way the
-- examination group did overnight.
--
-- quantity_only: true, so only quantity and total_cost are written. Revenue is
-- left as it stands even where Amazon disagrees, per the operator's decision.
-- Consequence, recorded here as well as in the function: those rows become
-- internally inconsistent (10 units carrying a revenue figure for 2), so
-- per-order ROI screens will show a loss on them. COGS and the P&L are
-- unaffected -- get_monthly_cogs reads quantity, and the P&L takes revenue from
-- financial_events_cache.
--
-- Expected COGS movement: +409.27 in total.
DO $p$
DECLARE
  r record; v_uid uuid; v_secret text; v_req bigint; v_n int;
  v_ids text[] := ARRAY[
    '112-6706940-0661820',  -- B07RQ9QB6K   1 ->  6
    '111-6434384-9441019',  -- B09WJHD19B   1 ->  9
    '112-7082671-1878635',  -- B0064CUFVC   1 ->  8
    '113-9168743-1857006',  -- B09NW3S8RB   2 ->  7
    '111-2576090-7258664',  -- B000HHJKZW   2 -> 10
    '113-2697655-0557028',  -- B06XDRKVJ1   3 ->  6
    '114-6818443-7399464',  -- B003BL7W42   2 ->  4
    '114-2324224-6392269',  -- B01AI9EZ3K   1 ->  3
    '111-7767894-5821021'   -- B01D0BD8CM   7 -> 10
  ];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  -- backup first, with the count verified before anything is fired
  ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='collapsed_repair_backup_9') THEN
    SELECT count(*) INTO v_n FROM public.collapsed_repair_backup_9;
    RAISE NOTICE '== backup_9 already exists with % rows -- NOT overwriting ==', v_n;
  ELSE
    CREATE TABLE public.collapsed_repair_backup_9 AS
    SELECT s.*, now() AS backed_up_at,
           'pre-quantity-only-repair-2026-11-01'::text AS label
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.order_id = ANY(v_ids);

    SELECT count(*) INTO v_n FROM public.collapsed_repair_backup_9;
    IF v_n <> 9 THEN
      RAISE EXCEPTION 'backup holds % rows, expected 9 -- refusing to proceed', v_n;
    END IF;
    ALTER TABLE public.collapsed_repair_backup_9 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.collapsed_repair_backup_9 FROM PUBLIC, anon, authenticated;
    COMMENT ON TABLE public.collapsed_repair_backup_9 IS
      'Pre-change copy of the 9 quantity-error rows repaired 2026-11-01 (quantity_only). Restore: UPDATE sales_orders SET quantity=b.quantity, total_cost=b.total_cost FROM collapsed_repair_backup_9 b WHERE sales_orders.id=b.id.';
    RAISE NOTICE '== backup_9 created: % rows, COUNT VERIFIED ==', v_n;
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '   the 9, as they stand now:';
  RAISE NOTICE '   order               | asin         | qty | total_cost | revenue';
  FOR r IN
    SELECT order_id, asin, quantity AS q,
           round(COALESCE(total_cost,0)::numeric,2) AS tc,
           round(COALESCE(total_sale_amount,0)::numeric,2) AS rev
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = ANY(v_ids)
    ORDER BY order_id
  LOOP
    RAISE NOTICE '   % | % | % | % | %', r.order_id, rpad(r.asin,12),
      lpad(r.q::text,3), lpad(r.tc::text,10), lpad(r.rev::text,8);
  END LOOP;

  SELECT count(*) INTO v_n FROM public.sales_orders
   WHERE user_id = v_uid AND order_id = ANY(v_ids);
  IF v_n <> 9 THEN
    RAISE NOTICE '>>> expected 9 live rows, found %. Not firing.', v_n;
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'INTERNAL_SYNC_SECRET';
  IF v_secret IS NULL THEN
    RAISE NOTICE '>>> no INTERNAL_SYNC_SECRET. Not firing.';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repair-collapsed-orders',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-internal-secret', v_secret),
    body := jsonb_build_object('user_id', v_uid,
                               'marketplace', NULL,
                               'limit', 10,
                               'order_ids', to_jsonb(v_ids),
                               'quantity_only', true,
                               'dry_run', false),
    timeout_milliseconds := 118000
  ) INTO v_req;

  RAISE NOTICE '';
  RAISE NOTICE '   fired 9 ids at % -- request %', clock_timestamp(), v_req;
  RAISE NOTICE '   dry_run false, quantity_only true. 9 calls at 2100ms is ~19s.';
END
$p$;
