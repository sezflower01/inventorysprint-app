-- APPLY the shipment-confirmed backfill, holding back the >25%-single-lot ones.
--
-- Backups verified in 20261102120000: cog_backfill_backup_20261102 holds all
-- 3,193 asin_cog_on_record rows, cog_backfill_cogs_before holds the monthly
-- COGS (2026 total 455,671.23).
--
-- ── WHAT IS HELD BACK, AND WHY ───────────────────────────────────────
--
-- Per instruction: any product whose average would move more than 25 pct on
-- the strength of a SINGLE confirmed lot is skipped until approved. That is
-- B0CKHRZ663, B0DDCVFQZF and B014I9DJWY, and the rule is implemented as a
-- CONDITION rather than a hardcoded list, so a fourth product that qualifies
-- is also held back instead of slipping through.
--
-- Their detail was reported first and all three look legitimate -- each has a
-- current COG from the import priced off 2025 lots, against one confirmed 2026
-- lot at a genuinely different price. They are held back anyway, because the
-- instruction was to hold them and "it turned out fine" is not a reason to
-- ignore a gate.
--
-- Overrides and source='manual' are skipped by recompute_cog_from_confirmed
-- itself, so they need no special handling here.
DO $p$
DECLARE
  r record; v_uid uuid;
  v_conf_before int; v_conf_after int;
  v_applied int := 0; v_held int := 0; v_skipped int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='cog_backfill_backup_20261102') THEN
    RAISE NOTICE '>>> NO BACKUP. Refusing to write.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_conf_before FROM public.cog_purchase_confirmations;

  ------------------------------------------------------------------
  -- 1. confirm every already-shipped lot. PK = lot, so idempotent.
  ------------------------------------------------------------------
  INSERT INTO public.cog_purchase_confirmations
    (created_listing_id, user_id, asin, draft_id, shipment_id,
     inbound_plan_id, units_confirmed, units_source)
  SELECT DISTINCT ON (a.created_listing_id)
         a.created_listing_id, a.user_id, a.asin, a.draft_id,
         COALESCE(a.shipment_id, d.amazon_shipment_id), d.inbound_plan_id,
         CASE WHEN a.units_shipped > 0 THEN a.units_shipped ELSE a.units_allocated END,
         CASE WHEN a.units_shipped > 0 THEN 'units_shipped' ELSE 'units_allocated' END
  FROM public.shipment_purchase_allocations a
  JOIN public.shipment_builder_drafts d
    ON d.user_id = a.user_id AND d.draft_id = a.draft_id
  JOIN public.created_listings cl ON cl.id = a.created_listing_id
  WHERE a.user_id = v_uid
    AND d.continued_to_amazon_at IS NOT NULL
    AND GREATEST(a.units_shipped, a.units_allocated) > 0
    AND cl.cost > 0 AND cl.units > 0
  ORDER BY a.created_listing_id,
           GREATEST(a.units_shipped, a.units_allocated) DESC,
           d.continued_to_amazon_at DESC
  ON CONFLICT (created_listing_id) DO NOTHING;

  SELECT count(*) INTO v_conf_after FROM public.cog_purchase_confirmations;
  RAISE NOTICE '== confirmations: % -> % (% new lots) ==',
    v_conf_before, v_conf_after, v_conf_after - v_conf_before;

  ------------------------------------------------------------------
  -- 2. recompute, per ASIN, holding back the big single-lot movers
  ------------------------------------------------------------------
  FOR r IN
    WITH conf AS (
      SELECT c.asin,
             sum(cl.cost * c.units_confirmed::numeric / NULLIF(cl.units,0)) AS spent,
             sum(c.units_confirmed) AS units,
             count(*) AS lots
      FROM public.cog_purchase_confirmations c
      JOIN public.created_listings cl ON cl.id = c.created_listing_id
      WHERE c.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
      GROUP BY c.asin)
    SELECT conf.asin, conf.lots,
           round(conf.spent / NULLIF(conf.units,0), 4) AS new_cog,
           cur.unit_cost AS old_cog
    FROM conf
    LEFT JOIN public.asin_cog_on_record cur
      ON cur.user_id = v_uid AND cur.asin = conf.asin
    WHERE conf.units > 0
  LOOP
    IF r.old_cog IS NOT NULL AND r.old_cog > 0
       AND r.lots = 1
       AND abs(r.new_cog - r.old_cog) / r.old_cog > 0.25
    THEN
      v_held := v_held + 1;
      RAISE NOTICE '   HELD  % | % -> % (% pct on a single lot)', r.asin,
        round(r.old_cog,2), round(r.new_cog,2),
        round(100.0*(r.new_cog-r.old_cog)/r.old_cog,1);
    ELSE
      IF (public.recompute_cog_from_confirmed(v_uid, r.asin, NULL) ? 'skipped') THEN
        v_skipped := v_skipped + 1;
      ELSE
        v_applied := v_applied + 1;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   applied % | held back % | skipped (override/manual) %',
    v_applied, v_held, v_skipped;

  ------------------------------------------------------------------
  -- 3. before / after
  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## get_monthly_cogs BEFORE -> AFTER ########';
  RAISE NOTICE '   month |       before |        after |    moved';
  FOR r IN
    SELECT b.month_num AS m, b.cogs AS before_, c.cogs AS after_
    FROM public.cog_backfill_cogs_before b
    JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = b.month_num
    WHERE b.cogs <> 0 OR c.cogs <> 0
    ORDER BY b.month_num
  LOOP
    RAISE NOTICE '   %  | % | % | %', lpad(r.m::text,5),
      lpad(round(r.before_,2)::text,12), lpad(round(r.after_,2)::text,12),
      lpad(round(r.after_ - r.before_,2)::text,9);
  END LOOP;
  FOR r IN
    SELECT (SELECT round(sum(cogs),2) FROM public.cog_backfill_cogs_before) AS b,
           (SELECT round(sum(cogs),2) FROM public.get_monthly_cogs(2026, NULL)) AS a
  LOOP
    RAISE NOTICE '   ------------------------------------------------';
    RAISE NOTICE '   2026  | % | % | %', lpad(r.b::text,12), lpad(r.a::text,12),
      lpad(round(r.a - r.b,2)::text,9);
    RAISE NOTICE '   expected under about 450 for the year.';
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## CONTROLS ########';
  FOR r IN
    SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) AS claw, count(*) AS n
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP
    RAISE NOTICE '   clawback % | % | fec rows % (was 49068)', r.claw,
      CASE WHEN r.claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END, r.n;
  END LOOP;
  RAISE NOTICE '   nine-month applied NET -1765.91 -- this phase writes';
  RAISE NOTICE '   asin_cog_on_record and sales_orders cost columns only.';
  RAISE NOTICE '';
  RAISE NOTICE '   restore: see the comment on cog_backfill_backup_20261102';
END
$p$;
