-- BACK UP EVERY ROW AN APPLY COULD TOUCH. Additive only -- nothing is changed.
--
-- This is the "back up affected rows" step of the approved plan, taken BEFORE
-- approval because it is pure insurance: a full copy of the 285 candidate rows
-- as they stand right now. It destroys nothing, and having it in place means an
-- apply is a single decision rather than a decision plus a setup step.
--
-- repair-collapsed-orders writes quantity, total_cost, total_sale_amount,
-- item_price and sold_price. Rather than copy only those, the whole row is
-- copied: a restore then needs no judgement about which columns mattered, and a
-- column the function starts writing later is already covered.
--
-- The 19 non-whole-number orders are deliberately NOT in the candidate list, so
-- they are not here either. They are also not touchable by any apply, because
-- the whole-number gate lives inside collapsed_order_candidates.
DO $p$
DECLARE v_uid uuid; v_cand int; v_backed int; v_existing int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_existing FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'collapsed_repair_backup';
  IF v_existing > 0 THEN
    SELECT count(*) INTO v_existing FROM public.collapsed_repair_backup;
    RAISE NOTICE '== a backup already exists with % rows ==', v_existing;
    RAISE NOTICE '   NOT overwriting it. An earlier backup is the pre-change';
    RAISE NOTICE '   state; replacing it after any write would silently destroy';
    RAISE NOTICE '   the only copy of the original values.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_cand
  FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0);
  RAISE NOTICE '== candidates to back up: % ==', v_cand;

  CREATE TABLE public.collapsed_repair_backup AS
  SELECT s.*, now() AS backed_up_at, 'pre-collapse-repair-2026-11-01'::text AS label
  FROM public.sales_orders s
  WHERE s.user_id = v_uid
    AND s.id IN (SELECT id FROM public.collapsed_order_candidates(v_uid, 100000, NULL, 0));

  SELECT count(*) INTO v_backed FROM public.collapsed_repair_backup;
  RAISE NOTICE '   rows backed up: %', v_backed;

  IF v_backed <> v_cand THEN
    RAISE EXCEPTION 'backup count % does not match candidate count % -- refusing to leave a partial backup',
      v_backed, v_cand;
  END IF;
  RAISE NOTICE '   COUNT VERIFIED: % = %', v_backed, v_cand;

  ALTER TABLE public.collapsed_repair_backup ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.collapsed_repair_backup FROM PUBLIC, anon, authenticated;
  CREATE INDEX ON public.collapsed_repair_backup (id);
  CREATE INDEX ON public.collapsed_repair_backup (order_id, asin);

  COMMENT ON TABLE public.collapsed_repair_backup IS
    'Full pre-change copy of the 285 sales_orders rows eligible for the same-ASIN collapse repair, taken 2026-11-01 before any write. Restore: UPDATE sales_orders SET quantity=b.quantity, total_cost=b.total_cost, total_sale_amount=b.total_sale_amount, item_price=b.item_price, sold_price=b.sold_price FROM collapsed_repair_backup b WHERE sales_orders.id=b.id.';

  RAISE NOTICE '';
  RAISE NOTICE '   RLS on, no grants to anon/authenticated, indexed on id and';
  RAISE NOTICE '   (order_id, asin). The restore statement is in the table';
  RAISE NOTICE '   comment so it does not have to be reconstructed under pressure.';
  RAISE NOTICE '';
  RAISE NOTICE '   NOTHING IN sales_orders WAS CHANGED. This only added a copy.';
END
$p$;
