-- READ-ONLY. Does any issued invoice still carry the old brand?
--
-- generated_invoices.product_name defaults to 'ArbiProSeller' and
-- generate-invoice-pdf renders it straight into the PDF, while
-- BillingSettings.tsx renders it in the Billing tab. Both current writers
-- (generate-admin-invoices and list-invoices) now pass "InventorySprint"
-- explicitly, so the default is dead for new rows -- but rows written before
-- that change would still show the old name to the customer.
DO $p$
DECLARE r record; v_n bigint;
BEGIN
  RAISE NOTICE '== the column default as it stands live ==';
  FOR r IN
    SELECT column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='generated_invoices'
      AND column_name='product_name'
  LOOP RAISE NOTICE '   product_name DEFAULT %', r.column_default; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== product_name values actually stored ==';
  FOR r IN
    SELECT COALESCE(product_name,'(null)') AS pn, count(*) AS n,
           min(issued_at)::date AS first_issued, max(issued_at)::date AS last_issued,
           count(*) FILTER (WHERE pdf_path IS NOT NULL) AS with_pdf
    FROM public.generated_invoices
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '   % | % invoices | % .. % | % have a stored PDF',
      rpad(r.pn,28), lpad(r.n::text,5), r.first_issued, r.last_issued, r.with_pdf;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   generated_invoices is EMPTY -- no issued invoice carries any brand'; END IF;

  SELECT count(*) INTO v_n FROM public.generated_invoices
  WHERE product_name ILIKE '%arbipro%';
  RAISE NOTICE '';
  RAISE NOTICE '   invoices carrying the OLD brand: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '== any other table with a stored brand string? ==';
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.data_type IN ('text','character varying')
      AND c.column_name IN ('product_name','plan_name','description','title','name',
                            'subject','body','template','label','display_name')
    ORDER BY 1,2
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I ILIKE %L',
                   r.table_name, r.column_name, '%arbipro%') INTO v_n;
    IF v_n > 0 THEN
      RAISE NOTICE '   !! %.% has % row(s) containing the old brand',
        r.table_name, r.column_name, v_n;
    END IF;
  END LOOP;
  RAISE NOTICE '   (only non-zero findings are printed)';
END
$p$;
