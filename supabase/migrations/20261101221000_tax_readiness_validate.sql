-- VALIDATE THE RECONCILIATION BEFORE TRUSTING IT. READ ONLY.
--
-- The previous run produced a residual of -66,538.16 and I am not reporting
-- that as a finding, because four things about the aggregate are obviously
-- wrong and each would move it:
--
--   1. JANUARY IS ABSENT. The 2026 month table starts at 2026-02. A missing
--      month of deposits would understate the deposit side by itself.
--   2. 2026-02 SHOWS 23 PERIODS AND 0.00. Reports with no amount.
--   3. THE PERIOD COUNTS ARE IMPOSSIBLE. Amazon settles about every 14 days,
--      so a month holds 2-3 periods per marketplace -- 4 marketplaces is at
--      most ~12. The table shows 23, 43, 37, 40, 46. Either settlements are
--      stored more than once, or settlement_end_date is not what I assumed.
--   4. 29 REPORTS ARE status='error' with 0.00, so they are unparsed.
--
-- Grouping by settlement_end_date also double-counts if one settlement period
-- produced several report rows. This checks each of those before any number is
-- quoted.
DO $p$
DECLARE r record; v_uid uuid; v_n int; v_dup int; v_distinct numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. ARE SETTLEMENTS STORED MORE THAN ONCE? ########';
  SELECT count(*) INTO v_n FROM public.settlement_reports WHERE user_id = v_uid;
  SELECT count(DISTINCT settlement_id) INTO v_dup
  FROM public.settlement_reports WHERE user_id = v_uid AND settlement_id IS NOT NULL;
  RAISE NOTICE '   report rows % | distinct settlement_id %', v_n, v_dup;
  SELECT count(*) INTO v_n FROM (
    SELECT settlement_id FROM public.settlement_reports
    WHERE user_id = v_uid AND settlement_id IS NOT NULL
    GROUP BY settlement_id HAVING count(*) > 1) x;
  RAISE NOTICE '   settlement_ids appearing more than once: %', v_n;
  SELECT count(*) INTO v_n FROM public.settlement_reports
   WHERE user_id = v_uid AND settlement_id IS NULL;
  RAISE NOTICE '   rows with NULL settlement_id: %', v_n;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. DEPOSITS, DEDUPLICATED BY settlement_id ########';
  RAISE NOTICE '   one row per settlement, by DEPOSIT DATE (the cash date)';
  RAISE NOTICE '   month   | settlements | deposits';
  FOR r IN
    WITH one AS (
      SELECT DISTINCT ON (settlement_id)
             settlement_id, deposit_date, settlement_end_date,
             total_amount, currency, marketplace, status
      FROM public.settlement_reports
      WHERE user_id = v_uid AND settlement_id IS NOT NULL
      ORDER BY settlement_id, parsed_at DESC NULLS LAST, created_at DESC)
    SELECT to_char(date_trunc('month', COALESCE(deposit_date, settlement_end_date)),'YYYY-MM') AS mo,
           count(*) AS n, round(sum(COALESCE(total_amount,0)),2) AS amt
    FROM one
    WHERE COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
      AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | %', r.mo, lpad(r.n::text,11), lpad(r.amt::text,11);
  END LOOP;

  WITH one AS (
    SELECT DISTINCT ON (settlement_id) settlement_id, deposit_date,
           settlement_end_date, total_amount
    FROM public.settlement_reports
    WHERE user_id = v_uid AND settlement_id IS NOT NULL
    ORDER BY settlement_id, parsed_at DESC NULLS LAST, created_at DESC)
  SELECT round(sum(COALESCE(total_amount,0)),2) INTO v_distinct
  FROM one
  WHERE COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
    AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01';
  RAISE NOTICE '   2026 deposits, deduplicated: %', COALESCE(v_distinct,0);
  RAISE NOTICE '   (the previous run said 491,085.51 WITHOUT dedup)';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. WHERE IS JANUARY? ########';
  FOR r IN
    SELECT count(*) AS n, min(settlement_start_date) AS f,
           max(settlement_end_date) AS l,
           round(sum(COALESCE(total_amount,0)),2) AS amt
    FROM public.settlement_reports
    WHERE user_id = v_uid
      AND settlement_end_date >= '2025-12-15' AND settlement_end_date < '2026-02-01'
  LOOP
    RAISE NOTICE '   periods ending 2025-12-15 .. 2026-01-31: % | % .. % | %',
      r.n, r.f, r.l, r.amt;
  END LOOP;
  RAISE NOTICE '   if that is 0, January''s cash is simply not stored and the';
  RAISE NOTICE '   deposit side of any 2026 reconciliation is short a month.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 4. THE ZERO AND ERROR ROWS ########';
  FOR r IN
    SELECT COALESCE(status,'(null)') AS st,
           count(*) AS n,
           count(*) FILTER (WHERE COALESCE(total_amount,0) = 0) AS zero_amt,
           count(*) FILTER (WHERE deposit_date IS NULL) AS no_deposit_date,
           round(sum(COALESCE(rows_parsed,0))::numeric,0) AS li
    FROM public.settlement_reports WHERE user_id = v_uid
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '   % | % reports | % with 0.00 | % with no deposit_date | % line items',
      rpad(r.st,10), lpad(r.n::text,4), lpad(r.zero_amt::text,4),
      lpad(r.no_deposit_date::text,4), r.li;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   the error rows, so they can be re-fetched if still in window:';
  FOR r IN
    SELECT amazon_report_id, settlement_end_date AS ed,
           left(COALESCE(error_message,'(none)'),70) AS err
    FROM public.settlement_reports
    WHERE user_id = v_uid AND status = 'error'
    ORDER BY settlement_end_date DESC NULLS LAST LIMIT 8
  LOOP
    RAISE NOTICE '      % | % | %', rpad(r.amazon_report_id,22),
      COALESCE(r.ed::text,'(null)'), r.err;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 5. MARKETPLACE SPLIT ########';
  RAISE NOTICE '   a US-only tax figure must exclude CA/MX/BR deposits';
  FOR r IN
    SELECT COALESCE(marketplace, COALESCE(marketplace_id,'(null)')) AS mp,
           count(*) AS n, round(sum(COALESCE(total_amount,0)),2) AS amt,
           COALESCE(string_agg(DISTINCT currency, ','),'-') AS cur
    FROM public.settlement_reports
    WHERE user_id = v_uid AND settlement_end_date >= '2026-01-01'
      AND settlement_end_date < '2027-01-01'
    GROUP BY 1 ORDER BY 3 DESC NULLS LAST
  LOOP
    RAISE NOTICE '   % | % reports | % | currency %', rpad(r.mp,16),
      lpad(r.n::text,4), lpad(r.amt::text,11), r.cur;
  END LOOP;
  RAISE NOTICE '   NOTE: if several currencies appear, summing total_amount';
  RAISE NOTICE '   across them is meaningless -- CAD and MXN cannot be added';
  RAISE NOTICE '   to USD. That alone could account for the residual.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
