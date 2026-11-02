-- BACKFILL PREP: show the three movers, back up, snapshot. NO COG CHANGED.
--
-- The seller asked to see B0CKHRZ663, B0DDCVFQZF and B014I9DJWY lot by lot
-- before anything is applied, and to SKIP any product whose average would move
-- more than 25 pct on the strength of a SINGLE confirmed lot until approved.
-- Those are exactly the three: each is 1-of-1 or 1-of-3, so one lot would
-- replace a broader average.
--
-- This migration writes only backups and a snapshot. The apply is separate so
-- the movers can be read first and so a problem in the apply cannot leave the
-- backup half-made.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_exp int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  RAISE NOTICE '######## THE THREE MOVERS, LOT BY LOT ########';
  FOR r IN
    SELECT cl.asin, COALESCE(cl.sku,'(null)') AS sku,
           cl.created_at::date AS bought,
           round(cl.cost::numeric,2) AS lot_total,
           cl.units,
           round((cl.cost/NULLIF(cl.units,0))::numeric,2) AS unit_cost,
           EXISTS (SELECT 1 FROM public.shipment_purchase_allocations a
                    JOIN public.shipment_builder_drafts d
                      ON d.user_id = a.user_id AND d.draft_id = a.draft_id
                   WHERE a.created_listing_id = cl.id
                     AND d.continued_to_amazon_at IS NOT NULL) AS confirmed,
           COALESCE((SELECT GREATEST(a.units_shipped, a.units_allocated)
                     FROM public.shipment_purchase_allocations a
                     WHERE a.created_listing_id = cl.id
                     ORDER BY GREATEST(a.units_shipped, a.units_allocated) DESC
                     LIMIT 1),0) AS units_in_shipment,
           COALESCE(left(cl.supplier_links::text, 48),'-') AS supplier
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid
      AND cl.asin IN ('B0CKHRZ663','B0DDCVFQZF','B014I9DJWY')
      AND cl.cost > 0 AND cl.units > 0
    ORDER BY cl.asin, cl.created_at
  LOOP
    RAISE NOTICE '   % | % | bought % | lot total % | % units | %/unit | confirmed % | % in shipment',
      r.asin, rpad(r.sku,16), r.bought, lpad(r.lot_total::text,9),
      lpad(r.units::text,4), lpad(r.unit_cost::text,7), r.confirmed,
      r.units_in_shipment;
    RAISE NOTICE '        supplier %', r.supplier;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   current COG vs what confirmed-only would give:';
  FOR r IN
    SELECT c.asin, round(c.unit_cost,2) AS now_, COALESCE(c.source,'-') AS src,
           (SELECT count(*) FROM public.created_listings cl
             WHERE cl.user_id=v_uid AND cl.asin=c.asin AND cl.cost>0 AND cl.units>0
               AND cl.created_at >= date_trunc('year', now())) AS lots_all
    FROM public.asin_cog_on_record c
    WHERE c.user_id = v_uid AND c.asin IN ('B0CKHRZ663','B0DDCVFQZF','B014I9DJWY')
  LOOP
    RAISE NOTICE '   % | COG % (source %) | % lots this year',
      r.asin, lpad(r.now_::text,7), rpad(r.src,10), r.lots_all;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   2026 sales exposure of the three:';
  FOR r IN
    SELECT s.asin, count(*) AS rows, sum(s.quantity) AS units,
           round(sum(COALESCE(s.total_cost,0))::numeric,2) AS cogs_now
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin IN ('B0CKHRZ663','B0DDCVFQZF','B014I9DJWY')
      AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
      AND s.order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % sales rows | % units | % of COGS today',
      r.asin, lpad(r.rows::text,4), lpad(r.units::text,4), lpad(r.cogs_now::text,9);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## BACKUPS ########';
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='cog_backfill_backup_20261102') THEN
    RAISE NOTICE '   backup already exists -- NOT overwriting (it is the';
    RAISE NOTICE '   pre-change state; replacing it after a write destroys it)';
  ELSE
    CREATE TABLE public.cog_backfill_backup_20261102 AS
    SELECT c.*, now() AS backed_up_at
    FROM public.asin_cog_on_record c WHERE c.user_id = v_uid;
    SELECT count(*) INTO v_n FROM public.cog_backfill_backup_20261102;
    SELECT count(*) INTO v_exp FROM public.asin_cog_on_record WHERE user_id = v_uid;
    IF v_n <> v_exp THEN
      RAISE EXCEPTION 'backup % rows vs % live -- refusing', v_n, v_exp;
    END IF;
    ALTER TABLE public.cog_backfill_backup_20261102 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.cog_backfill_backup_20261102 FROM PUBLIC, anon, authenticated;
    COMMENT ON TABLE public.cog_backfill_backup_20261102 IS
      'Full pre-change copy of asin_cog_on_record before the 2026-11-02 shipment-confirmed backfill. Restore: UPDATE asin_cog_on_record t SET unit_cost=b.unit_cost, source=b.source, calculated_cost=b.calculated_cost, calculation=b.calculation FROM cog_backfill_backup_20261102 b WHERE t.id=b.id.';
    RAISE NOTICE '   asin_cog_on_record backed up: % rows, COUNT VERIFIED', v_n;
  END IF;

  -- cog_purchase_confirmations is currently empty, but back it up anyway so
  -- the restore path is uniform rather than conditional.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='cog_conf_backup_20261102') THEN
    CREATE TABLE public.cog_conf_backup_20261102 AS
    SELECT * , now() AS backed_up_at FROM public.cog_purchase_confirmations;
    ALTER TABLE public.cog_conf_backup_20261102 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.cog_conf_backup_20261102 FROM PUBLIC, anon, authenticated;
    RAISE NOTICE '   cog_purchase_confirmations backed up: % rows',
      (SELECT count(*) FROM public.cog_conf_backup_20261102);
  END IF;

  ------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='cog_backfill_cogs_before') THEN
    CREATE TABLE public.cog_backfill_cogs_before AS
    SELECT month_num, cogs, units_sold, units_missing_cost, now() AS captured_at
    FROM public.get_monthly_cogs(2026, NULL);
    ALTER TABLE public.cog_backfill_cogs_before ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.cog_backfill_cogs_before FROM PUBLIC, anon, authenticated;
  END IF;
  RAISE NOTICE '';
  RAISE NOTICE '######## get_monthly_cogs BEFORE ########';
  FOR r IN SELECT month_num AS m, cogs FROM public.cog_backfill_cogs_before
           WHERE cogs <> 0 ORDER BY month_num
  LOOP RAISE NOTICE '   month % | %', lpad(r.m::text,2), lpad(round(r.cogs,2)::text,12); END LOOP;
  FOR r IN SELECT round(sum(cogs),2) AS t FROM public.cog_backfill_cogs_before
  LOOP RAISE NOTICE '   2026 total | %', r.t; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   NO COG CHANGED. Backups and snapshot only.';
END
$p$;
