-- The reconciliation totals and controls that scrolled past. READ ONLY.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);

  RAISE NOTICE 'month | pre-backfill |          now | backfill |  three |   total';
  FOR r IN
    SELECT o.month_num AS m, o.cogs AS orig, t.cogs AS mid, c.cogs AS now_
    FROM public.cog_backfill_cogs_before o
    JOIN public.cog_three_cogs_before t ON t.month_num = o.month_num
    JOIN public.get_monthly_cogs(2026, NULL) c ON c.month_num = o.month_num
    WHERE (o.cogs <> 0 OR c.cogs <> 0) AND o.month_num >= 4
    ORDER BY o.month_num
  LOOP
    RAISE NOTICE '  %  | % | % | % | % | %', lpad(r.m::text,4),
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
    RAISE NOTICE '-----------------------------------------------------------------';
    RAISE NOTICE '2026  | % | % | % | % | %',
      lpad(r.orig::text,12), lpad(r.now_::text,12),
      lpad(round(r.mid - r.orig,2)::text,8),
      lpad(round(r.now_ - r.mid,2)::text,6),
      lpad(round(r.now_ - r.orig,2)::text,8);
    RAISE NOTICE '';
    RAISE NOTICE 'backfill, 275 ASINs : %', round(r.mid - r.orig,2);
    RAISE NOTICE 'the three approved  : %', round(r.now_ - r.mid,2);
    RAISE NOTICE 'COMBINED            : %', round(r.now_ - r.orig,2);
  END LOOP;

  FOR r IN
    SELECT round(sum(abs(COALESCE(compensated_clawback,0))),2) AS claw, count(*) AS n,
           round(sum(abs(COALESCE(sales,0))),2) AS s
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE 'clawback % | % | fec rows % | sales %', r.claw,
      CASE WHEN r.claw = 2046.17 THEN 'UNCHANGED' ELSE '>>> MOVED' END, r.n, r.s;
  END LOOP;
  RAISE NOTICE 'nine-month applied NET -1765.91';

  RAISE NOTICE '';
  RAISE NOTICE 'B08HGY4PP8 is protected TWICE, which I should have spotted sooner:';
  FOR r IN
    SELECT round(c.unit_cost,2) AS cog, c.source AS src,
           EXISTS (SELECT 1 FROM public.asin_cost_overrides o
                    WHERE o.user_id=v_uid AND o.asin='B08HGY4PP8') AS has_override
    FROM public.asin_cog_on_record c
    WHERE c.user_id = v_uid AND c.asin = 'B08HGY4PP8'
  LOOP
    RAISE NOTICE '   COG % | source % | asin_cost_overrides row %',
      r.cog, r.src, r.has_override;
    RAISE NOTICE '   source=manual means recompute_cog_from_confirmed would have';
    RAISE NOTICE '   REFUSED it regardless of the 25 pct gate -- it was never at';
    RAISE NOTICE '   risk, and my hold-back notice overstated the danger.';
  END LOOP;
END
$p$;
