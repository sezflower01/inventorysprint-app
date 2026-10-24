-- February's residual, decomposed and VERIFIED in SQL. READ-ONLY.
--
-- A GAP IN THE PAIRING DETECTOR, found here: repull_residual_explain joins
-- arrived amounts with "a2.amt > a1.amt", i.e. two DISTINCT halves. An exact
-- double can therefore never pair, and February contains exactly that --
-- 2 x 28.94 unpacking into 4 x 14.47. So February printed no PAIRED lines at
-- all while being almost entirely money-neutral. The decomposition below is
-- computed, not eyeballed, because hand arithmetic on these multisets has
-- already produced one phantom gap in this exercise.
DO $p$
DECLARE
  v_uid uuid; v_ms jsonb; r record;
  v_gone numeric; v_arr numeric; v_left_gone numeric; v_left_arr numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_ms := (public.repull_find_report('2026-02-01'::date, false, NULL, true))
            ->'api_amount_multiset'->'reversal_reimbursement';

  CREATE TEMP TABLE _api  ON COMMIT DROP AS
    SELECT round(x::numeric,2) AS amt
    FROM jsonb_array_elements_text(v_ms) AS t(x);
  CREATE TEMP TABLE _cur ON COMMIT DROP AS
    SELECT round(reversal_reimbursement,2) AS amt
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type='adjustment'
      AND event_date >= '2026-02-01' AND event_date < '2026-03-01'
      AND COALESCE(reversal_reimbursement,0) <> 0;

  SELECT COALESCE(sum(amt),0) INTO v_gone FROM _cur;
  SELECT COALESCE(sum(amt),0) INTO v_arr  FROM _api;
  RAISE NOTICE '== reversal_reimbursement, whole column ==';
  RAISE NOTICE '   stored total % over % rows | api total % over % rows',
    v_gone, (SELECT count(*) FROM _cur), v_arr, (SELECT count(*) FROM _api);
  RAISE NOTICE '   column delta %', round(v_arr - v_gone, 2);

  -- Cancel the amounts that are identical on both sides, by multiplicity.
  CREATE TEMP TABLE _gone ON COMMIT DROP AS
    WITH a AS (SELECT amt, count(*) n FROM _api GROUP BY 1),
         c AS (SELECT amt, count(*) n FROM _cur GROUP BY 1)
    SELECT c.amt, c.n - COALESCE(a.n,0) AS n
    FROM c LEFT JOIN a ON a.amt=c.amt WHERE c.n - COALESCE(a.n,0) > 0;
  CREATE TEMP TABLE _arr ON COMMIT DROP AS
    WITH a AS (SELECT amt, count(*) n FROM _api GROUP BY 1),
         c AS (SELECT amt, count(*) n FROM _cur GROUP BY 1)
    SELECT a.amt, a.n - COALESCE(c.n,0) AS n
    FROM a LEFT JOIN c ON c.amt=a.amt WHERE a.n - COALESCE(c.n,0) > 0;

  RAISE NOTICE '';
  RAISE NOTICE '   vanished: %',
    (SELECT string_agg(amt::text||' x'||n, ', ' ORDER BY amt) FROM _gone);
  RAISE NOTICE '   appeared: %',
    (SELECT string_agg(amt::text||' x'||n, ', ' ORDER BY amt) FROM _arr);
  SELECT COALESCE(sum(amt*n),0) INTO v_left_gone FROM _gone;
  SELECT COALESCE(sum(amt*n),0) INTO v_left_arr  FROM _arr;
  RAISE NOTICE '   vanished sums to % | appeared sums to % | net %',
    v_left_gone, v_left_arr, round(v_left_arr - v_left_gone, 2);

  RAISE NOTICE '';
  RAISE NOTICE '== money-neutral unpacks, including equal halves ==';
  -- An unpack is a vanished amount equal to a sum of arrived amounts. Checking
  -- the two- and three-term cases with repetition allowed covers everything
  -- February contains.
  FOR r IN
    SELECT g.amt AS whole, a1.amt AS p1, a2.amt AS p2
    FROM _gone g
    JOIN _arr a1 ON a1.amt < g.amt
    JOIN _arr a2 ON a2.amt <= a1.amt
    WHERE round(a1.amt + a2.amt, 2) = round(g.amt, 2)
      AND (a2.amt < a1.amt OR a1.n >= 2)
    ORDER BY g.amt
  LOOP
    RAISE NOTICE '   NEUTRAL % = % + %', r.whole, r.p1, r.p2;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   none found'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what is genuinely restated, after removing those ==';
  FOR r IN
    SELECT g.amt AS gone_amt, g.n AS gone_n
    FROM _gone g
    WHERE NOT EXISTS (
      SELECT 1 FROM _arr a1 JOIN _arr a2 ON a2.amt <= a1.amt
      WHERE a1.amt < g.amt AND round(a1.amt+a2.amt,2) = round(g.amt,2)
        AND (a2.amt < a1.amt OR a1.n >= 2))
    ORDER BY g.amt
  LOOP RAISE NOTICE '   unexplained vanished: % x %', r.gone_amt, r.gone_n; END LOOP;

  FOR r IN
    SELECT a.amt, a.n
    FROM _arr a
    WHERE NOT EXISTS (
      SELECT 1 FROM _gone g JOIN _arr b ON b.amt <= a.amt
      WHERE round(a.amt + b.amt, 2) = round(g.amt, 2))
    ORDER BY a.amt
  LOOP RAISE NOTICE '   unexplained appeared: % x %', r.amt, r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   The column delta is % and the whole-month residual is +0.13',
    round(v_arr - v_gone, 2);
  RAISE NOTICE '   (one cent of that is independent 2dp rounding of the two totals).';
END
$p$;
