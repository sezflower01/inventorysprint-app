-- Set the FORWARD cost for B0G4B3117X to 7.75, the last recorded purchase price.
--
-- Approved by the seller. Deliberately narrow:
--   * history is NOT touched. Every past sale keeps its locked snapshot, which
--     is step 1 of resolve_unit_cost_v1 and outranks everything here.
--   * the existing override (14.5625 effective 2026-05-02) STAYS. It still
--     governs orders dated between 2026-05-02 and today.
--   * this adds one row effective today. Step 2 takes the newest override with
--     effective_from <= order_date, so orders from today forward get 7.75 and
--     nothing earlier changes.
--   * reversible by deleting this single row.
--
-- WHY AN OVERRIDE AND NOT AN EDIT TO cost_history: last night's listing edit
-- wrote 25 rows at 7.75 AND 3 rows at 14.56, all effective 2026-09-11. Step 3a
-- breaks that tie on recorded_at DESC, and the 14.56 rows were written last
-- (00:33-00:34 vs 00:14-00:32), so cost_history resolves to 14.56. An override
-- sits above that rung and is unambiguous.
--
-- KNOWN CLIFF: steps 2 and 3 both require the SAME CALENDAR YEAR as the order.
-- On 2027-01-01 this override stops applying and the cost falls through to the
-- inventory fallback (currently 14.56). Revisit before year end.
--
-- Context: 271 units are on hand with no purchase record behind them (bought
-- 1,254, sold 1,250, returns 37, expected 41, actual 312). 7.75 is the last
-- price the seller actually recorded; if the unrecorded units cost something
-- else, this one row is what to change.

DO $apply$
DECLARE
  v_uid uuid;
  v_asin text := 'B0G4B3117X';
  v_cols text;
  v_existing int;
  r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT string_agg(column_name || CASE WHEN is_nullable = 'NO' AND column_default IS NULL
                                        THEN ' (required)' ELSE '' END, ', ' ORDER BY ordinal_position)
    INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'asin_cost_overrides';
  RAISE NOTICE 'asin_cost_overrides columns: %', v_cols;

  SELECT count(*) INTO v_existing
  FROM public.asin_cost_overrides
  WHERE user_id = v_uid AND asin = v_asin AND effective_from = CURRENT_DATE;

  IF v_existing > 0 THEN
    RAISE NOTICE 'an override for today already exists -- updating it to 7.75';
    UPDATE public.asin_cost_overrides
       SET unit_cost = 7.75
     WHERE user_id = v_uid AND asin = v_asin AND effective_from = CURRENT_DATE;
  ELSE
    INSERT INTO public.asin_cost_overrides (user_id, asin, unit_cost, effective_from)
    VALUES (v_uid, v_asin, 7.75, CURRENT_DATE);
    RAISE NOTICE 'inserted override: 7.75 effective %', CURRENT_DATE;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== overrides now on this ASIN ========';
  FOR r IN
    SELECT unit_cost, effective_from FROM public.asin_cost_overrides
    WHERE user_id = v_uid AND asin = v_asin ORDER BY effective_from
  LOOP
    RAISE NOTICE '   % effective %', r.unit_cost, r.effective_from;
  END LOOP;
END
$apply$;

DO $verify$
DECLARE r record; v_uid uuid; v_asin text := 'B0G4B3117X'; v_sku text := 'A0N-DRF-MIOM';
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '======== verify: what each date now resolves to ========';
  FOR r IN
    SELECT d::date AS order_date, x.unit_cost, x.source
    FROM (VALUES ('2026-09-12'), ('2026-09-11'), ('2026-08-15'), ('2026-06-15'), ('2026-04-10')) AS v(d)
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_uid, v_asin, v_sku, v.d::date, NULL) x
    ORDER BY 1 DESC
  LOOP
    RAISE NOTICE '   order dated %  ->  % per unit  (%)', r.order_date, r.unit_cost, r.source;
  END LOOP;
  RAISE NOTICE '   expected: 2026-09-11 onward 7.75; anything earlier unchanged at 14.56';

  RAISE NOTICE '';
  RAISE NOTICE '======== verify: no historical sale moved ========';
  FOR r IN
    SELECT count(*) AS rows_n,
           count(*) FILTER (WHERE cost_locked) AS locked,
           round(sum(COALESCE(total_cost,0))::numeric,2) AS cogs,
           round(min(COALESCE(unit_cost_at_sale, unit_cost))::numeric,2) AS min_unit,
           round(max(COALESCE(unit_cost_at_sale, unit_cost))::numeric,2) AS max_unit
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = v_asin
      AND order_id NOT LIKE '%-REFUND'
      AND COALESCE(order_status,'') NOT IN ('Canceled','Cancelled')
  LOOP
    RAISE NOTICE '   % sales rows, % locked, COGS % (unit costs % .. %)',
      r.rows_n, r.locked, r.cogs, r.min_unit, r.max_unit;
    RAISE NOTICE '   COGS was 18,143.49 before this change -- it must be unchanged';
  END LOOP;
END
$verify$;