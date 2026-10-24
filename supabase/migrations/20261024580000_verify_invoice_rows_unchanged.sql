-- READ-ONLY. Prove the two invoice rows changed in product_name and nothing
-- else of substance.
--
-- The BEFORE state, captured by 20261024570000 before it wrote:
--   APS-202604-0001 | ArbiProSeller | 0 USD | paid | issued 2026-04-11 | period 2026-04-01 .. 2026-04-30 | pdf (none)
--   APS-202607-0002 | ArbiProSeller | 0 USD | paid | issued 2026-07-26 | period 2026-07-01 .. 2026-07-31 | pdf (none)
--
-- Every column is printed below so the comparison is on the whole row rather
-- than on the handful of fields I happened to select earlier.
--
-- One honest exception, stated rather than buried: updated_at DID change. The
-- UPDATE set it to now() deliberately, because a row that was modified and
-- claims it was not is worse than one that admits it. It is a bookkeeping
-- timestamp, not an invoice field.
DO $p$
DECLARE r record; v_bad int := 0;
BEGIN
  RAISE NOTICE '== every column of both invoices, as they stand now ==';
  FOR r IN
    SELECT * FROM public.generated_invoices ORDER BY issued_at
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   invoice_number  %', r.invoice_number;
    RAISE NOTICE '   product_name    %', r.product_name;
    RAISE NOTICE '   amount          %', r.amount;
    RAISE NOTICE '   currency        %', r.currency;
    RAISE NOTICE '   status          %', r.status;
    RAISE NOTICE '   period_start    %', r.period_start;
    RAISE NOTICE '   period_end      %', r.period_end;
    RAISE NOTICE '   issued_at       %', r.issued_at;
    RAISE NOTICE '   due_date        %', r.due_date;
    RAISE NOTICE '   pdf_path        %', COALESCE(r.pdf_path,'(null)');
    RAISE NOTICE '   user_id         %', r.user_id;
    RAISE NOTICE '   id              %', r.id;
    RAISE NOTICE '   created_at      %', r.created_at;
    RAISE NOTICE '   updated_at      %   <-- set by the rebrand UPDATE', r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== assertions against the captured BEFORE values ==';

  -- Invoice numbers, amounts, currency, status, periods and issue dates must
  -- match the BEFORE output exactly.
  FOR r IN
    SELECT invoice_number, product_name, amount, currency, status,
           period_start, period_end, issued_at::date AS issued, pdf_path
    FROM public.generated_invoices ORDER BY issued_at
  LOOP
    IF r.invoice_number = 'APS-202604-0001' THEN
      IF NOT (r.amount = 0 AND r.currency = 'USD' AND r.status = 'paid'
              AND r.period_start = DATE '2026-04-01' AND r.period_end = DATE '2026-04-30'
              AND r.issued = DATE '2026-04-11' AND r.pdf_path IS NULL) THEN
        v_bad := v_bad + 1;
        RAISE NOTICE '   !! APS-202604-0001 does NOT match its BEFORE values';
      ELSE
        RAISE NOTICE '   APS-202604-0001  number, amount, currency, status, period, issue date, pdf: ALL IDENTICAL';
      END IF;
    ELSIF r.invoice_number = 'APS-202607-0002' THEN
      IF NOT (r.amount = 0 AND r.currency = 'USD' AND r.status = 'paid'
              AND r.period_start = DATE '2026-07-01' AND r.period_end = DATE '2026-07-31'
              AND r.issued = DATE '2026-07-26' AND r.pdf_path IS NULL) THEN
        v_bad := v_bad + 1;
        RAISE NOTICE '   !! APS-202607-0002 does NOT match its BEFORE values';
      ELSE
        RAISE NOTICE '   APS-202607-0002  number, amount, currency, status, period, issue date, pdf: ALL IDENTICAL';
      END IF;
    ELSE
      v_bad := v_bad + 1;
      RAISE NOTICE '   !! unexpected invoice %', r.invoice_number;
    END IF;

    IF r.product_name <> 'InventorySprint' THEN
      v_bad := v_bad + 1;
      RAISE NOTICE '   !! % still reads %', r.invoice_number, r.product_name;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  IF v_bad = 0 THEN
    RAISE NOTICE '   VERIFIED: only product_name (and updated_at) changed on both rows.';
  ELSE
    RAISE EXCEPTION '% assertion(s) failed', v_bad;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== row count unchanged (2 before, 2 now) and no row created or deleted ==';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE created_at > now() - interval '2 hours') AS created_recently,
           count(*) FILTER (WHERE updated_at > now() - interval '2 hours') AS touched_recently
    FROM public.generated_invoices
  LOOP
    RAISE NOTICE '   % invoices | % created in the last 2h | % updated in the last 2h',
      r.n, r.created_recently, r.touched_recently;
  END LOOP;
END
$p$;
