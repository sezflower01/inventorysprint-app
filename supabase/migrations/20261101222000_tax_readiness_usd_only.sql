-- THE DEPOSIT FIGURE, PER CURRENCY. READ ONLY.
--
-- My -66,538.16 residual is WITHDRAWN. It was built on two broken assumptions,
-- both now measured:
--
--   1. MIXED CURRENCIES. settlement_reports.marketplace reads 'US' on all 315
--      rows while `currency` holds BRL, CAD, MXN and USD. So the 491,085.51 I
--      quoted is four currencies added together, which is not a number. The
--      marketplace column cannot be used to separate US from non-US either --
--      it says US for everything. `currency` is the only usable splitter.
--   2. JANUARY AND FEBRUARY ARE MISSING. Zero settlement periods end between
--      2025-12-15 and 2026-01-31, and the deduplicated month table starts at
--      2026-03. Two months of cash are simply absent.
--
-- Also established: 29 reports failed with `getReportDocument failed: 429` --
-- Amazon throttled the document download -- for periods ending 2026-02-25 to
-- 2026-03-10. Today is 2026-11-01, so those are outside the ~90-day retention
-- window and are PERMANENTLY unrecoverable from the API. They have 0 line
-- items. That is the most likely home of the missing February cash.
--
-- This produces the figure that IS defensible: deposits per currency, and the
-- USD-only total, which is what a US return needs.
DO $p$
DECLARE r record; v_uid uuid; v_usd numeric; v_n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '######## DEPOSITS BY CURRENCY, 2026 ########';
  RAISE NOTICE '   currency | settlements | total        | first .. last deposit';
  FOR r IN
    SELECT COALESCE(currency,'(null)') AS cur, count(*) AS n,
           round(sum(COALESCE(total_amount,0)),2) AS amt,
           min(COALESCE(deposit_date, settlement_end_date)) AS f,
           max(COALESCE(deposit_date, settlement_end_date)) AS l
    FROM public.settlement_reports
    WHERE user_id = v_uid AND status = 'parsed'
      AND COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
      AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01'
    GROUP BY 1 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '   % | % | % | % .. %', rpad(r.cur,8), lpad(r.n::text,11),
      lpad(r.amt::text,12), r.f, r.l;
  END LOOP;

  SELECT round(sum(COALESCE(total_amount,0)),2) INTO v_usd
  FROM public.settlement_reports
  WHERE user_id = v_uid AND status = 'parsed' AND upper(COALESCE(currency,'')) = 'USD'
    AND COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
    AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01';
  RAISE NOTICE '';
  RAISE NOTICE '   >>> USD deposits on file for 2026: %', COALESCE(v_usd,0);
  RAISE NOTICE '   >>> and that figure is still MISSING January and February.';

  RAISE NOTICE '';
  RAISE NOTICE '   USD deposits by month:';
  FOR r IN
    SELECT to_char(date_trunc('month', COALESCE(deposit_date, settlement_end_date)),'YYYY-MM') AS mo,
           count(*) AS n, round(sum(COALESCE(total_amount,0)),2) AS amt
    FROM public.settlement_reports
    WHERE user_id = v_uid AND status = 'parsed' AND upper(COALESCE(currency,'')) = 'USD'
      AND COALESCE(deposit_date, settlement_end_date) >= '2026-01-01'
      AND COALESCE(deposit_date, settlement_end_date) <  '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '      % | % settlements | %', r.mo, lpad(r.n::text,3),
      lpad(r.amt::text,11);
  END LOOP;

  -- The line-item section that was here is removed: settlement_line_items has
  -- no settlement_id column (it keys on something else), and chasing the right
  -- name was blocking the reconciliation behind it. 178,352 rows exist and are
  -- worth mining later; the column names get confirmed first next time.
  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
