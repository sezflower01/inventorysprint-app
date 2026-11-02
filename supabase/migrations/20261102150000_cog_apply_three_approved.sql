-- Apply the three approved movers. Hold B08HGY4PP8. Reconcile the whole backfill.
--
-- Approved: B014I9DJWY, B0CKHRZ663, B0DDCVFQZF.
-- Held: B08HGY4PP8, pending an invoice check -- its lot detail is printed
-- below and NO write touches it.
--
-- Two baselines are in play and both are reported so the figures reconcile:
--   cog_backfill_cogs_before  -- before the 275-ASIN backfill (2026: 455,671.23)
--   a fresh snapshot here     -- after that backfill, before these three
-- The whole-backfill movement and this apply's movement therefore add up.
DO $p$
DECLARE
  r record; v_uid uuid; v_n int;
  v_approved text[] := ARRAY['B014I9DJWY','B0CKHRZ663','B0DDCVFQZF'];
  a text; v_res jsonb;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  ------------------------------------------------------------------
  RAISE NOTICE '######## HELD: B08HGY4PP8, for your invoice check ########';
  RAISE NOTICE '   every lot on file, no date filter:';
  RAISE NOTICE '   sku              | date       | units | lot total | unit cost | confirmed | in shipment';
  FOR r IN
    SELECT COALESCE(cl.sku,'(null)') AS sku,
           cl.created_at::date AS d,
           cl.units,
           round(cl.cost::numeric,2) AS total,
           round((cl.cost/NULLIF(cl.units,0))::numeric,2) AS unit,
           EXISTS (SELECT 1 FROM public.cog_purchase_confirmations cc
                    WHERE cc.created_listing_id = cl.id) AS confirmed,
           COALESCE((SELECT cc.units_confirmed FROM public.cog_purchase_confirmations cc
                      WHERE cc.created_listing_id = cl.id),0) AS units_conf,
           COALESCE(left(cl.supplier_links::text, 60),'-') AS supplier
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid AND cl.asin = 'B08HGY4PP8'
      AND cl.cost > 0 AND cl.units > 0
    ORDER BY cl.created_at
  LOOP
    RAISE NOTICE '   % | % | % | % | % | % | %',
      rpad(r.sku,16), r.d, lpad(r.units::text,5), lpad(r.total::text,9),
      lpad(r.unit::text,9), rpad(r.confirmed::text,9), r.units_conf;
    RAISE NOTICE '        supplier %', r.supplier;
  END LOOP;

  FOR r IN
    SELECT round(c.unit_cost,2) AS cog, COALESCE(c.source,'-') AS src
    FROM public.asin_cog_on_record c
    WHERE c.user_id = v_uid AND c.asin = 'B08HGY4PP8'
  LOOP RAISE NOTICE '   current COG % (source %)', r.cog, r.src; END LOOP;

  FOR r IN
    SELECT count(*) AS rows, COALESCE(sum(s.quantity),0) AS units,
           round(COALESCE(sum(s.total_cost),0)::numeric,2) AS cogs,
           min(s.order_date) AS first_sale, max(s.order_date) AS last_sale
    FROM public.sales_orders s
    WHERE s.user_id = v_uid AND s.asin = 'B08HGY4PP8'
      AND s.order_date >= '2026-01-01' AND s.order_date < '2027-01-01'
      AND s.order_id NOT LIKE '%-REFUND%'
  LOOP
    RAISE NOTICE '   2026: % sales rows | % units sold | % of COGS | % .. %',
      r.rows, r.units, r.cogs, r.first_sale, r.last_sale;
    RAISE NOTICE '   if approved at 14.67 the COGS effect would be about %',
      round(r.units * (14.67 - 9.00), 2);
  END LOOP;
  RAISE NOTICE '   >>> NOT WRITTEN. Held pending your invoice.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## BACKUP OF THE THREE ########';
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='cog_three_backup_20261102') THEN
    RAISE NOTICE '   backup already exists -- not overwriting';
  ELSE
    CREATE TABLE public.cog_three_backup_20261102 AS
    SELECT c.*, now() AS backed_up_at
    FROM public.asin_cog_on_record c
    WHERE c.user_id = v_uid AND c.asin = ANY(v_approved);
    SELECT count(*) INTO v_n FROM public.cog_three_backup_20261102;
    IF v_n <> 3 THEN RAISE EXCEPTION 'backup has % rows, expected 3', v_n; END IF;
    ALTER TABLE public.cog_three_backup_20261102 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.cog_three_backup_20261102 FROM PUBLIC, anon, authenticated;
    COMMENT ON TABLE public.cog_three_backup_20261102 IS
      'Pre-change copy of the 3 COGs approved 2026-11-02 (B014I9DJWY, B0CKHRZ663, B0DDCVFQZF). Restore: UPDATE asin_cog_on_record t SET unit_cost=b.unit_cost, source=b.source, calculated_cost=b.calculated_cost, calculation=b.calculation FROM cog_three_backup_20261102 b WHERE t.id=b.id.';
    RAISE NOTICE '   3 rows backed up, COUNT VERIFIED';
  END IF;

  -- snapshot of COGS as it stands now (after the 275-ASIN backfill)
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='cog_three_cogs_before') THEN
    CREATE TABLE public.cog_three_cogs_before AS
    SELECT month_num, cogs, now() AS captured_at
    FROM public.get_monthly_cogs(2026, NULL);
    ALTER TABLE public.cog_three_cogs_before ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.cog_three_cogs_before FROM PUBLIC, anon, authenticated;
  END IF;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## APPLYING THE THREE ########';
  FOREACH a IN ARRAY v_approved LOOP
    v_res := public.recompute_cog_from_confirmed(v_uid, a, NULL);
    RAISE NOTICE '   % -> %', a, v_res::text;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   COG now:';
  FOR r IN
    SELECT c.asin, round(c.unit_cost,2) AS cog, c.source AS src,
           round((b.unit_cost)::numeric,2) AS was
    FROM public.asin_cog_on_record c
    JOIN public.cog_three_backup_20261102 b ON b.asin = c.asin
    WHERE c.user_id = v_uid AND c.asin = ANY(v_approved) ORDER BY c.asin
  LOOP
    RAISE NOTICE '   % | % -> % (%)', r.asin, lpad(r.was::text,7),
      lpad(r.cog::text,7), r.src;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## get_monthly_cogs: THIS APPLY ########';
  RAISE NOTICE '   month |  before this |   after this |    moved';
  FOR r IN
    SELECT b.month_num AS m, b.cogs AS before_, c.cogs AS after_
    FROM public.cog_three_cogs_before b
    JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = b.month_num
    WHERE b.cogs <> 0 OR c.cogs <> 0 ORDER BY b.month_num
  LOOP
    RAISE NOTICE '   %  | % | % | %', lpad(r.m::text,5),
      lpad(round(r.before_,2)::text,12), lpad(round(r.after_,2)::text,12),
      lpad(round(r.after_ - r.before_,2)::text,9);
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## RECONCILIATION: whole backfill + these three ########';
  RAISE NOTICE '   month | pre-backfill |          now | backfill |  three |   total';
  FOR r IN
    SELECT o.month_num AS m, o.cogs AS orig, t.cogs AS mid, c.cogs AS now_
    FROM public.cog_backfill_cogs_before o
    JOIN public.cog_three_cogs_before t ON t.month_num = o.month_num
    JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = o.month_num
    WHERE o.cogs <> 0 OR c.cogs <> 0 ORDER BY o.month_num
  LOOP
    RAISE NOTICE '   %  | % | % | % | % | %', lpad(r.m::text,5),
      lpad(round(r.orig,2)::text,12), lpad(round(r.now_,2)::text,12),
      lpad(round(r.mid - r.orig,2)::text,8),
      lpad(round(r.now_ - r.mid,2)::text,6),
      lpad(round(r.now_ - r.orig,2)::text,8);
  END LOOP;
  FOR r IN
    SELECT (SELECT round(sum(cogs),2) FROM public.cog_backfill_cogs_before) AS orig,
           (SELECT round(sum(cogs),2) FROM public.cog_three_cogs_before) AS mid,
           (SELECT round(sum(cogs),2) FROM public.get_monthly_cogs(2026, NULL)) AS now_
  LOOP
    RAISE NOTICE '   -----------------------------------------------------------';
    RAISE NOTICE '   2026  | % | % | % | % | %',
      lpad(r.orig::text,12), lpad(r.now_::text,12),
      lpad(round(r.mid - r.orig,2)::text,8),
      lpad(round(r.now_ - r.mid,2)::text,6),
      lpad(round(r.now_ - r.orig,2)::text,8);
    RAISE NOTICE '';
    RAISE NOTICE '   backfill 275 ASINs : %', round(r.mid - r.orig,2);
    RAISE NOTICE '   these three        : %', round(r.now_ - r.mid,2);
    RAISE NOTICE '   combined           : %', round(r.now_ - r.orig,2);
    RAISE NOTICE '   B08HGY4PP8 still held, so it is in none of these.';
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
  RAISE NOTICE '   nine-month applied NET -1765.91';
END
$p$;
