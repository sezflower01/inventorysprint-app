-- HOW LONG AFTER A MONTH ENDS DO ITS FINANCIAL EVENTS STOP ARRIVING?
-- READ ONLY.
--
-- The seller's instinct is to wait about two months before filing. This turns
-- that into a measurement instead of a guess, using a lag that is already
-- recorded: created_at (when WE first stored the row) minus event_date (the
-- PostedDate Amazon stamped it with).
--
-- ── THE SUBTLETY THAT CHANGES WHAT YOU ARE WAITING FOR ───────────────
--
-- get_monthly_pl_breakdown buckets by event_date and filters
-- event_date >= 2026-01-01 AND < 2027-01-01. So a December ORDER whose money
-- posts in January carries a JANUARY event_date and lands in the 2027 P&L. No
-- amount of waiting pulls it into 2026, and it should not -- that is just what
-- accrual-by-posting-date means.
--
-- What waiting DOES recover is rows with a 2026 event_date that Amazon had not
-- yet made available. That is real and already proven: October's clawback total
-- rose 166.28 -> 196.85 -> 222.49 across successive re-pulls, all with October
-- posted-dates. So the question is how long that availability tail runs.
DO $p$
DECLARE r record; v_uid uuid; v_n bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  ------------------------------------------------------------------
  RAISE NOTICE '######## 1. ARRIVAL LAG: created_at - event_date ########';
  RAISE NOTICE '   how long after Amazon stamps a PostedDate do we first see it';
  RAISE NOTICE '   lag        | rows    | pct   | money';
  FOR r IN
    SELECT CASE
             WHEN d < 0  THEN 'stored BEFORE posted'
             WHEN d = 0  THEN 'same day'
             WHEN d <= 2 THEN '1-2 days'
             WHEN d <= 7 THEN '3-7 days'
             WHEN d <= 14 THEN '8-14 days'
             WHEN d <= 30 THEN '15-30 days'
             WHEN d <= 60 THEN '31-60 days'
             WHEN d <= 90 THEN '61-90 days'
             ELSE 'over 90 days' END AS bucket,
           min(d) AS lo, max(d) AS hi,
           count(*) AS n,
           round(sum(money),2) AS amt
    FROM (
      SELECT (f.created_at::date - f.event_date) AS d,
             abs(COALESCE(f.sales,0)) + abs(COALESCE(f.compensated_clawback,0))
               + abs(COALESCE(f.reimbursements,0)) AS money
      FROM public.financial_events_cache f
      WHERE f.user_id = v_uid
        AND f.event_date >= '2026-01-01' AND f.event_date < '2027-01-01'
    ) x
    GROUP BY 1 ORDER BY min(d)
  LOOP
    RAISE NOTICE '   % | % | % | % (range % .. %)', rpad(r.bucket,22),
      lpad(r.n::text,7), lpad('', 5), lpad(r.amt::text,11), r.lo, r.hi;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.financial_events_cache
   WHERE user_id = v_uid AND event_date >= '2026-01-01' AND event_date < '2027-01-01';
  RAISE NOTICE '   total 2026 rows: %', v_n;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 2. THE TAIL THAT MATTERS: rows stored LATE ########';
  RAISE NOTICE '   for each event month, what share arrived more than 30 days';
  RAISE NOTICE '   after the month ENDED -- i.e. what you would have missed by';
  RAISE NOTICE '   closing the books one month after month-end';
  RAISE NOTICE '   month   | rows    | arrived >30d after month end | pct';
  FOR r IN
    SELECT to_char(date_trunc('month', event_date),'YYYY-MM') AS mo,
           count(*) AS n,
           count(*) FILTER (
             WHERE created_at::date
                   > (date_trunc('month', event_date) + interval '1 month' + interval '30 days')::date
           ) AS late
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND event_date >= '2026-01-01' AND event_date < '2026-11-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % | % pct', r.mo, lpad(r.n::text,7),
      lpad(r.late::text,28),
      lpad(round(100.0*r.late/NULLIF(r.n,0),2)::text,6);
  END LOOP;
  RAISE NOTICE '   NOTE: anything re-pulled by hand in October-November shows';
  RAISE NOTICE '   as "late" here even if Amazon had it earlier -- the stage-2';
  RAISE NOTICE '   clawback re-pull deleted and re-inserted every adjustment';
  RAISE NOTICE '   row, so created_at was reset. Read the adjustment rows with';
  RAISE NOTICE '   that in mind; shipment rows are untouched and honest.';

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '######## 3. SHIPMENT ROWS ONLY -- the clean signal ########';
  RAISE NOTICE '   shipments were never re-pulled, so their created_at is real';
  RAISE NOTICE '   month   | rows   | 95th pct lag | max lag';
  FOR r IN
    SELECT to_char(date_trunc('month', event_date),'YYYY-MM') AS mo,
           count(*) AS n,
           percentile_disc(0.95) WITHIN GROUP (
             ORDER BY (created_at::date - event_date)) AS p95,
           max(created_at::date - event_date) AS mx
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'shipment'
      AND event_date >= '2026-01-01' AND event_date < '2026-11-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % | % days | % days', r.mo, lpad(r.n::text,6),
      lpad(r.p95::text,12), lpad(r.mx::text,7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   READING IT: the 95th percentile is the practical wait. If it';
  RAISE NOTICE '   sits in single-digit days, a month''s money is effectively';
  RAISE NOTICE '   complete within a fortnight and a two-month wait is';
  RAISE NOTICE '   conservative -- which is fine, but the binding constraint';
  RAISE NOTICE '   would then be the ADJUSTMENT tail (clawbacks), not shipments.';

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- nothing written.';
END
$p$;
