-- PRE-APPLY: allow the new verdict, and snapshot everything rule 5 tests.
--
-- Rule 5 says: if any month moves by more than the prediction ceiling, or
-- anything OUTSIDE sales_orders changes, stop and restore. Neither can be
-- tested after the fact without a before-picture, and get_monthly_cogs moves on
-- its own as October keeps posting -- so the snapshot has to be taken in the
-- same breath as the apply, not read off yesterday's report.
--
-- Three things are recorded:
--   1. get_monthly_cogs per month, the figure the P&L actually uses
--   2. financial_events_cache control totals -- the table that must NOT move,
--      because every clawback figure lives there
--   3. sales_orders control totals for rows NOT in the candidate set, so
--      "only the 285 changed" is checkable rather than asserted
--
-- Also extends collapsed_order_checks' CHECK constraint for the new
-- 'exceeds_money_estimate' verdict. Without this the ceiling gate would throw
-- on its first use instead of recording a skip.

-- ── 1. the new verdict value ──────────────────────────────────────────
ALTER TABLE public.collapsed_order_checks
  DROP CONSTRAINT IF EXISTS collapsed_order_checks_outcome_check;
ALTER TABLE public.collapsed_order_checks
  ADD CONSTRAINT collapsed_order_checks_outcome_check
  CHECK (outcome IN ('repaired','already_correct','not_found',
                     'asin_not_in_order','exceeds_money_estimate'));

COMMENT ON CONSTRAINT collapsed_order_checks_outcome_check
  ON public.collapsed_order_checks IS
  'exceeds_money_estimate added 2026-11-01: GetOrderItems reported MORE units than the money signal''s upper bound, so the row was skipped rather than written. Final, like the other four -- throttles are still deliberately NOT recorded so they stay retryable.';

-- ── 2. the before-picture ─────────────────────────────────────────────
DO $p$
DECLARE v_uid uuid; v_n int; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='collapsed_preapply_snapshot') THEN
    RAISE NOTICE '== snapshot already exists -- NOT overwriting ==';
    RAISE NOTICE '   it is the before-picture; replacing it after a write would';
    RAISE NOTICE '   make the verification compare the result against itself.';
    RETURN;
  END IF;

  CREATE TABLE public.collapsed_preapply_snapshot AS
  SELECT 'cogs'::text AS kind,
         c.month_num::text AS key,
         c.cogs AS val_a,
         c.units_sold::numeric AS val_b,
         c.units_missing_cost::numeric AS val_c,
         now() AS taken_at
  FROM public.get_monthly_cogs(2026, NULL) c;

  -- financial_events_cache must not move at all
  INSERT INTO public.collapsed_preapply_snapshot (kind, key, val_a, val_b, val_c, taken_at)
  SELECT 'fec', 'control',
         round(sum(abs(COALESCE(compensated_clawback,0))),2),
         round(sum(abs(COALESCE(sales,0))),2),
         count(*)::numeric,
         now()
  FROM public.financial_events_cache
  WHERE user_id = v_uid
    AND event_date >= '2026-01-01' AND event_date < '2027-01-01';

  -- sales_orders rows OUTSIDE the candidate set must not move either
  INSERT INTO public.collapsed_preapply_snapshot (kind, key, val_a, val_b, val_c, taken_at)
  SELECT 'so_noncandidate', 'control',
         round(sum(COALESCE(s.quantity,0))::numeric,2),
         round(sum(COALESCE(s.total_cost,0))::numeric,2),
         count(*)::numeric,
         now()
  FROM public.sales_orders s
  WHERE s.user_id = v_uid
    AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
    AND s.id NOT IN (SELECT id FROM public.collapsed_repair_backup);

  -- and the candidate rows' own starting totals, for the arithmetic
  INSERT INTO public.collapsed_preapply_snapshot (kind, key, val_a, val_b, val_c, taken_at)
  SELECT 'so_candidate', 'control',
         round(sum(COALESCE(quantity,0))::numeric,2),
         round(sum(COALESCE(total_cost,0))::numeric,2),
         count(*)::numeric,
         now()
  FROM public.collapsed_repair_backup;

  ALTER TABLE public.collapsed_preapply_snapshot ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.collapsed_preapply_snapshot FROM PUBLIC, anon, authenticated;
  COMMENT ON TABLE public.collapsed_preapply_snapshot IS
    'Before-picture for the 2026-11-01 same-ASIN collapse repair: get_monthly_cogs per month, financial_events_cache control totals (must not move), sales_orders non-candidate control totals (must not move).';

  SELECT count(*) INTO v_n FROM public.collapsed_preapply_snapshot;
  RAISE NOTICE '== snapshot taken: % rows ==', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '   get_monthly_cogs BEFORE:';
  FOR r IN SELECT key, val_a, val_b FROM public.collapsed_preapply_snapshot
           WHERE kind='cogs' ORDER BY key::int
  LOOP
    IF r.val_a <> 0 THEN
      RAISE NOTICE '      month % | COGS % | units %', lpad(r.key,2),
        lpad(round(r.val_a,2)::text,12), lpad(r.val_b::text,6);
    END IF;
  END LOOP;

  FOR r IN SELECT kind, val_a, val_b, val_c FROM public.collapsed_preapply_snapshot
           WHERE kind <> 'cogs' ORDER BY kind
  LOOP
    RAISE NOTICE '   % | a=% b=% c=%', rpad(r.kind,16), r.val_a, r.val_b, r.val_c;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   fec a = 2026 clawback magnitude, b = sales, c = row count.';
  RAISE NOTICE '   All three MUST be identical afterwards. so_noncandidate too.';
  RAISE NOTICE '';
  RAISE NOTICE '   NOTHING WRITTEN TO sales_orders. Snapshot and constraint only.';
END
$p$;
