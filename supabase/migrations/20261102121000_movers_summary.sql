-- The movers' summary that scrolled past, plus a date-field caveat. READ ONLY.
--
-- Worth noting from the lot listing: B014I9DJWY has 16 lots ALL stamped
-- 2025-11-30 and one at 2026-06-16; B0CKHRZ663 and B0DDCVFQZF likewise carry
-- 2025-11-30 lots. A single repeated date across many lots is an IMPORT stamp,
-- not a purchase date -- so created_at on created_listings is when the row
-- arrived in the app, and "purchases this calendar year" really means "lots
-- created in the app this year". That does not invalidate the averages, but it
-- is the wrong name for the filter and matters if anyone reads it as a
-- purchase date.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  RAISE NOTICE 'the three movers: 2025-stamped lots vs the 2026 confirmed one';
  FOR r IN
    SELECT cl.asin,
           count(*) FILTER (WHERE cl.created_at < '2026-01-01') AS lots_2025,
           round(avg(cl.cost/NULLIF(cl.units,0)) FILTER (WHERE cl.created_at < '2026-01-01')::numeric,2) AS unit_2025,
           count(*) FILTER (WHERE cl.created_at >= '2026-01-01') AS lots_2026,
           round(avg(cl.cost/NULLIF(cl.units,0)) FILTER (WHERE cl.created_at >= '2026-01-01')::numeric,2) AS unit_2026
    FROM public.created_listings cl
    WHERE cl.user_id = v_uid AND cl.cost > 0 AND cl.units > 0
      AND cl.asin IN ('B0CKHRZ663','B0DDCVFQZF','B014I9DJWY')
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | 2025: % lots at %/unit | 2026: % lots at %/unit',
      r.asin, lpad(r.lots_2025::text,2), lpad(COALESCE(r.unit_2025::text,'-'),6),
      lpad(r.lots_2026::text,2), lpad(COALESCE(r.unit_2026::text,'-'),6);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'current COG and 2026 sales exposure:';
  FOR r IN
    SELECT c.asin, round(c.unit_cost,2) AS cog, COALESCE(c.source,'-') AS src,
           (SELECT count(*) FROM public.sales_orders s WHERE s.user_id=v_uid
             AND s.asin=c.asin AND s.order_date >= '2026-01-01'
             AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%') AS rows,
           (SELECT COALESCE(sum(s.quantity),0) FROM public.sales_orders s WHERE s.user_id=v_uid
             AND s.asin=c.asin AND s.order_date >= '2026-01-01'
             AND s.order_date < '2027-01-01' AND s.order_id NOT LIKE '%-REFUND%') AS units
    FROM public.asin_cog_on_record c
    WHERE c.user_id = v_uid AND c.asin IN ('B0CKHRZ663','B0DDCVFQZF','B014I9DJWY')
    ORDER BY c.asin
  LOOP
    RAISE NOTICE '   % | COG % (%) | % sales rows, % units in 2026',
      r.asin, lpad(r.cog::text,7), rpad(r.src,8), lpad(r.rows::text,3), r.units;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'backups on file:';
  RAISE NOTICE '   cog_backfill_backup_20261102 : % rows',
    (SELECT count(*) FROM public.cog_backfill_backup_20261102);
  RAISE NOTICE '   cog_conf_backup_20261102     : % rows',
    (SELECT count(*) FROM public.cog_conf_backup_20261102);
  RAISE NOTICE '   cog_backfill_cogs_before     : % months, 2026 total %',
    (SELECT count(*) FROM public.cog_backfill_cogs_before WHERE cogs <> 0),
    (SELECT round(sum(cogs),2) FROM public.cog_backfill_cogs_before);
  RAISE NOTICE '';
  RAISE NOTICE 'READ ONLY -- nothing written.';
END
$p$;
