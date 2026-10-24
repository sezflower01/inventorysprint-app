-- Category (b): the only place the old brand reaches a customer through data.
--
-- generated_invoices.product_name defaulted to 'ArbiProSeller'. It is rendered
-- in the Billing tab (BillingSettings.tsx line 189) and written straight into
-- the invoice PDF by generate-invoice-pdf (lines 169 and 171). Neither of the
-- two current writers uses the default -- generate-admin-invoices and
-- list-invoices both pass "InventorySprint" explicitly -- so the default is
-- dead for new rows, but two invoices written before that change still carry
-- the old name, and their PDFs are generated on demand from the row (pdf_path
-- is NULL on both), so every download would reprint the old brand.
--
-- Both are $0 admin/owner invoices from generate-admin-invoices, not customer
-- payment records: amount: 0 is hardcoded at index.ts line 77. Correcting the
-- brand on them changes no financial figure. The amounts are printed below so
-- that is visible rather than asserted.
--
-- This changes a DEFAULT and two text values. It touches no identifier, table
-- name, function name, cron job, storage bucket or env var.
DO $p$
DECLARE r record; v_n bigint;
BEGIN
  RAISE NOTICE '== BEFORE ==';
  FOR r IN
    SELECT invoice_number, product_name, amount, currency, status,
           issued_at::date AS issued, period_start, period_end,
           COALESCE(pdf_path,'(none)') AS pdf
    FROM public.generated_invoices WHERE product_name ILIKE '%arbipro%'
    ORDER BY issued_at
  LOOP
    RAISE NOTICE '   % | % | % % | % | issued % | period % .. % | pdf %',
      r.invoice_number, r.product_name, r.amount, r.currency, r.status,
      r.issued, r.period_start, r.period_end, r.pdf;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.generated_invoices
  WHERE product_name ILIKE '%arbipro%' AND amount <> 0;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'REFUSING: % invoice(s) carrying the old brand have a non-zero amount. A paid invoice is a financial record and gets a decision, not a sed.', v_n;
  END IF;
  RAISE NOTICE '   all are zero-amount -- safe to correct';
END
$p$;

ALTER TABLE public.generated_invoices
  ALTER COLUMN product_name SET DEFAULT 'InventorySprint';

UPDATE public.generated_invoices
   SET product_name = 'InventorySprint',
       updated_at   = now()
 WHERE product_name ILIKE '%arbipro%';

DO $p$
DECLARE r record; v_n bigint;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '== AFTER ==';
  FOR r IN
    SELECT column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name='generated_invoices'
      AND column_name='product_name'
  LOOP RAISE NOTICE '   default is now %', r.column_default; END LOOP;

  FOR r IN
    SELECT COALESCE(product_name,'(null)') AS pn, count(*) AS n,
           round(sum(amount)::numeric,2) AS total
    FROM public.generated_invoices GROUP BY 1 ORDER BY 2 DESC
  LOOP RAISE NOTICE '   % | % invoices | amount total %', rpad(r.pn,20), r.n, r.total; END LOOP;

  SELECT count(*) INTO v_n FROM public.generated_invoices
  WHERE product_name ILIKE '%arbipro%';
  RAISE NOTICE '   invoices still carrying the old brand: %', v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'brand still present on % invoice(s)', v_n; END IF;
END
$p$;
