-- READ-ONLY PROBE. Creates nothing, changes nothing.
--
-- COG on Record depends on the zz_apply_cog_on_record trigger winning against
-- sync-sales-orders, which re-resolves costs from purchase history on every
-- enrichment pass. The activation check ran seconds after switch-on; this reads
-- again after live sync traffic, and finds when the Live Sales summary caches
-- (whose resolver was fixed to honour locked costs in the same change) next
-- rebuild.

DO $probe$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  RAISE NOTICE 'now: %', now();

  FOR r IN
    SELECT count(*) AS mismatched
    FROM public.sales_orders s
    JOIN public.asin_cog_on_record c ON c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND (s.unit_cost IS DISTINCT FROM c.unit_cost
           OR s.unit_cost_at_sale IS DISTINCT FROM c.unit_cost
           OR s.total_cost IS DISTINCT FROM round(c.unit_cost * COALESCE(s.quantity, 0), 2)
           OR s.cost_locked IS NOT TRUE)
  LOOP
    RAISE NOTICE '2026 sales with a COG not matching it: % (must be 0)', r.mismatched;
  END LOOP;

  FOR r IN
    SELECT count(*) AS written, min(s.updated_at) AS first_w, max(s.updated_at) AS last_w,
           count(*) FILTER (WHERE s.created_at > timestamptz '2026-09-15 01:52:00+00') AS new_orders
    FROM public.sales_orders s
    JOIN public.asin_cog_on_record c ON c.user_id = s.user_id AND c.asin = s.asin AND c.unit_cost IS NOT NULL
    WHERE s.user_id = v_uid AND s.order_date >= '2026-01-01'
      AND s.updated_at > timestamptz '2026-09-15 01:53:00+00'
  LOOP
    RAISE NOTICE 'sales with a COG written AFTER activation (by sync etc.): % rows, % new orders, % to % -- all still match above',
      r.written, r.new_orders, r.first_w, r.last_w;
  END LOOP;

  FOR r IN
    SELECT jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%live-sales%' OR command ILIKE '%refresh-live-sales%'
    ORDER BY jobname
  LOOP
    RAISE NOTICE 'cron: % | % | active=%', rpad(r.jobname, 44), r.schedule, r.active;
  END LOOP;
END
$probe$;
