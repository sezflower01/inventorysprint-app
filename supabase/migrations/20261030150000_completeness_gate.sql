-- The completeness gate: two runs must agree, instead of zero rate-limit hits.
--
-- WHY THE OLD GATE HAS TO GO FOR FEB/MAR/APR. "Stop on any rate-limit hit"
-- cannot pass those three -- they throttle on some runs and not others -- but
-- six months of evidence says a hit changes nothing about the DATA. Every month
-- with two or more stored runs agrees on items, pages, clawbacks, signed total
-- and catch-all across 0 to 17 hits; the only fields that ever move are
-- elapsed_ms and rate_limit_hits, which describe the run, not the month. June
-- alone has nine runs saying so.
--
-- So hits become an observation and AGREEMENT becomes the gate. That is a
-- stronger check, not a weaker one: zero hits said "this run was not throttled",
-- which was never the same claim as "this run saw everything".
--
-- TWO THINGS THIS GETS RIGHT THAT THE OLD GATE DID NOT:
--
--   * Numeric comparison, not text. September's stored report printed -213.2
--     and the fresh one -213.20. Identical numbers; a text comparison would
--     have refused a correct run. Every money field is compared ::numeric and
--     every count ::bigint.
--
--   * Catch-all must be 0 in BOTH runs, not merely equal. Two runs that agree
--     on 7 catch-all items agree about being incomplete.
--
-- Deliberately pure functions over two jsonb reports: that is what makes the
-- planted-mismatch self-test at the bottom possible. A gate that has never been
-- shown to refuse anything is not a gate -- the db-lint gate was green on noop
-- for 205 runs, and pl_baseline_20261022 was 480 zero cells that could not fail.
CREATE OR REPLACE FUNCTION public.repull_compare_runs(p_a jsonb, p_b jsonb)
RETURNS TABLE (field text, kind text, run_a text, run_b text, verdict text)
LANGUAGE sql
IMMUTABLE
AS $fn$
  WITH f(field, kind) AS (
    VALUES ('api_items','count'),
           ('pages','count'),
           ('api_clawback_total','money'),
           ('api_signed_total','money'),
           ('api_items_via_catchall','count')
  )
  SELECT f.field, f.kind,
         COALESCE(p_a ->> f.field, '(absent)'),
         COALESCE(p_b ->> f.field, '(absent)'),
         CASE
           WHEN p_a ->> f.field IS NULL OR p_b ->> f.field IS NULL THEN 'ABSENT'
           WHEN f.kind = 'money'
             AND (p_a ->> f.field)::numeric = (p_b ->> f.field)::numeric THEN 'match'
           WHEN f.kind = 'count'
             AND (p_a ->> f.field)::bigint  = (p_b ->> f.field)::bigint  THEN 'match'
           ELSE 'MISMATCH'
         END
  FROM f
  ORDER BY f.field;
$fn$;

COMMENT ON FUNCTION public.repull_compare_runs(jsonb, jsonb) IS
  'Field-by-field comparison of two repull reports over the five fields that describe the DATA. Money compared ::numeric and counts ::bigint, so -213.2 and -213.20 match. elapsed_ms and rate_limit_hits are deliberately excluded -- they describe the run.';

CREATE OR REPLACE FUNCTION public.repull_completeness_ok(p_a jsonb, p_b jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE v_bad int; v_catch_a text; v_catch_b text;
BEGIN
  IF p_a IS NULL OR p_b IS NULL THEN RETURN false; END IF;

  SELECT count(*) INTO v_bad
  FROM public.repull_compare_runs(p_a, p_b) WHERE verdict <> 'match';
  IF v_bad > 0 THEN RETURN false; END IF;

  -- Agreeing on an incomplete fetch is still incomplete.
  v_catch_a := p_a ->> 'api_items_via_catchall';
  v_catch_b := p_b ->> 'api_items_via_catchall';
  IF v_catch_a IS NULL OR v_catch_b IS NULL THEN RETURN false; END IF;
  IF v_catch_a::bigint <> 0 OR v_catch_b::bigint <> 0 THEN RETURN false; END IF;

  RETURN true;
END
$fn$;

COMMENT ON FUNCTION public.repull_completeness_ok(jsonb, jsonb) IS
  'True only when two repull reports agree on every data field AND catch-all is 0 in both. Replaces "zero rate-limit hits" as the stage-2 gate for Feb/Mar/Apr: hits describe the run, agreement describes the data.';

DO $p$
DECLARE v_base jsonb; v_same jsonb; v_t jsonb; r record; v_fails int := 0;
BEGIN
  v_base := jsonb_build_object(
    'api_items', 144, 'pages', 50,
    'api_clawback_total', -227.95, 'api_signed_total', 1052.94,
    'api_items_via_catchall', 0, 'rate_limit_hits', 14, 'elapsed_ms', 85357);

  RAISE NOTICE '== SELF-TEST: the gate must ACCEPT a genuine pair ==';

  -- 1. byte-identical
  IF NOT public.repull_completeness_ok(v_base, v_base) THEN
    v_fails := v_fails + 1; RAISE NOTICE '   FAIL: refused an identical pair';
  ELSE RAISE NOTICE '   identical reports                       -> accepted'; END IF;

  -- 2. differing ONLY in the fields that describe the run
  v_same := v_base || jsonb_build_object('rate_limit_hits', 0, 'elapsed_ms', 51399);
  IF NOT public.repull_completeness_ok(v_base, v_same) THEN
    v_fails := v_fails + 1; RAISE NOTICE '   FAIL: refused a pair differing only in hits/elapsed';
  ELSE RAISE NOTICE '   14 hits vs 0 hits, same data            -> accepted'; END IF;

  -- 3. the September text trap: -213.2 vs -213.20
  IF NOT public.repull_completeness_ok(
       jsonb_build_object('api_items',112,'pages',37,'api_clawback_total',-213.2,
                          'api_signed_total',970.94,'api_items_via_catchall',0),
       jsonb_build_object('api_items',112,'pages',37,'api_clawback_total',-213.20,
                          'api_signed_total',970.94,'api_items_via_catchall',0)) THEN
    v_fails := v_fails + 1; RAISE NOTICE '   FAIL: -213.2 vs -213.20 treated as a mismatch';
  ELSE RAISE NOTICE '   -213.2 vs -213.20 (numeric, not text)   -> accepted'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== SELF-TEST: the gate must REFUSE each planted mismatch ==';

  -- One planted mismatch per data field, each of which must be refused.
  FOR r IN
    SELECT * FROM (VALUES
      ('api_items',             to_jsonb(143)),
      ('pages',                 to_jsonb(49)),
      ('api_clawback_total',    to_jsonb(-227.94::numeric)),
      ('api_signed_total',      to_jsonb(1052.93::numeric)),
      ('api_items_via_catchall', to_jsonb(1))
    ) AS v(fld, val)
  LOOP
    v_t := v_base || jsonb_build_object(r.fld, r.val);
    IF public.repull_completeness_ok(v_base, v_t) THEN
      v_fails := v_fails + 1;
      RAISE NOTICE '   FAIL: accepted a pair differing in %', r.fld;
    ELSE
      RAISE NOTICE '   % planted mismatch                 -> refused', rpad(r.fld,24);
    END IF;
  END LOOP;

  -- Agreeing on a non-zero catch-all is still incomplete.
  v_t := v_base || jsonb_build_object('api_items_via_catchall', 7);
  IF public.repull_completeness_ok(v_t, v_t) THEN
    v_fails := v_fails + 1;
    RAISE NOTICE '   FAIL: accepted two runs agreeing on catch-all 7';
  ELSE RAISE NOTICE '   both runs catch-all 7 (agreeing, incomplete) -> refused'; END IF;

  -- A missing field must never read as agreement.
  v_t := v_base - 'api_clawback_total';
  IF public.repull_completeness_ok(v_base, v_t) THEN
    v_fails := v_fails + 1; RAISE NOTICE '   FAIL: accepted a report with no clawback total';
  ELSE RAISE NOTICE '   absent api_clawback_total               -> refused'; END IF;

  IF public.repull_completeness_ok(v_base, NULL) OR public.repull_completeness_ok(NULL, v_base) THEN
    v_fails := v_fails + 1; RAISE NOTICE '   FAIL: accepted a NULL report';
  ELSE RAISE NOTICE '   NULL report (no fresh run landed)       -> refused'; END IF;

  RAISE NOTICE '';
  IF v_fails > 0 THEN
    RAISE EXCEPTION 'completeness gate self-test failed % time(s) -- NOT installing it', v_fails;
  END IF;
  RAISE NOTICE '   SELF-TEST PASSED: 3 accepts, 8 refusals, all as intended';
  RAISE NOTICE '   rate_limit_hits is now RECORDED, not a stop condition';
END
$p$;
