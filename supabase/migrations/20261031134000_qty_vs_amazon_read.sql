-- WHAT AMAZON SAID -- READ ONLY. 2026 ONLY.
--
-- Reads back request 55934, fired by 20261031133000. The sample is recomputed
-- with the identical deterministic selection (ORDER BY md5(order_id) LIMIT 60)
-- and joined to Amazon's answer on order_id, so nothing had to be stored to
-- carry it across the transaction boundary.
--
-- getOrder gives NumberOfItemsShipped and NumberOfItemsUnshipped. Their SUM is
-- what Amazon still considers ordered; shipped alone is what left the
-- warehouse. Both are printed, because they answer different questions: COGS
-- should follow what shipped, while a stored quantity above ordered is a
-- straightforward ingest error.
--
-- If the response is not there yet, this STOPS and says so. A missing response
-- is "not delivered yet", never "no mismatches".
DO $p$
DECLARE
  r record; v_uid uuid; v_req bigint := 55934;
  v_status int; v_content text; v_j jsonb; v_n int;
  v_avg_cost numeric; v_pop_orders int; v_pop_units bigint;
  v_cmp int := 0; v_match int := 0; v_mismatch int := 0;
  v_delta_units bigint := 0; v_abs_units bigint := 0; v_err int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT status_code, content INTO v_status, v_content
  FROM net._http_response WHERE id = v_req;

  IF v_status IS NULL THEN
    RAISE NOTICE '>>> request % has no response row yet. STOPPING.', v_req;
    RAISE NOTICE '    This is "not delivered", NOT "no mismatches". Re-run later.';
    RETURN;
  END IF;
  RAISE NOTICE '== response to request %: HTTP % ==', v_req, v_status;
  IF v_status <> 200 THEN
    RAISE NOTICE '   body: %', left(COALESCE(v_content,''), 500);
    RAISE NOTICE '   >>> not a 200. STOPPING -- nothing can be concluded.';
    RETURN;
  END IF;

  v_j := v_content::jsonb;
  RAISE NOTICE '   readOnly flag from the function : %', v_j->>'readOnly';
  RAISE NOTICE '   ids requested                   : %', v_j->>'requested';
  RAISE NOTICE '   rows returned                   : %',
    jsonb_array_length(COALESCE(v_j->'rows','[]'::jsonb));
  RAISE NOTICE '   Amazon status tally             : %', v_j->'tally';

  ------------------------------------------------------------------
  -- the average costed unit, for pricing any mismatch
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);
  SELECT CASE WHEN sum(units_with_cost) > 0
              THEN round(sum(cogs) / sum(units_with_cost), 4) ELSE NULL END
    INTO v_avg_cost
  FROM public.get_monthly_cogs(2026, NULL);
  RAISE NOTICE '   2026 average costed unit        : % (used to price any gap)',
    COALESCE(v_avg_cost,0);

  ------------------------------------------------------------------
  -- recompute the sample, join to Amazon, compare
  ------------------------------------------------------------------
  CREATE TEMP TABLE cmp ON COMMIT DROP AS
  WITH single AS (
    SELECT order_id FROM public.sales_orders
    WHERE user_id = v_uid
      AND order_date >= '2026-01-01' AND order_date < '2027-01-01'
      AND order_id NOT LIKE '%-REFUND%'
    GROUP BY order_id HAVING count(*) = 1
  ),
  settled AS (
    SELECT DISTINCT amazon_order_id FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_type = 'shipment'
      AND amazon_order_id IS NOT NULL
  ),
  sample AS (
    SELECT so.order_id, so.order_date, so.asin, so.quantity
    FROM public.sales_orders so
    JOIN single  s ON s.order_id = so.order_id
    JOIN settled f ON f.amazon_order_id = so.order_id
    WHERE so.user_id = v_uid
      AND so.order_date >= '2026-01-01' AND so.order_date < '2027-01-01'
      AND COALESCE(so.quantity,0) >= 2
    ORDER BY md5(so.order_id)
    LIMIT 60
  ),
  amz AS (
    SELECT e->>'order_id' AS order_id,
           e->>'amazon_status' AS status,
           NULLIF(e->>'items_shipped','')::int   AS shipped,
           NULLIF(e->>'items_unshipped','')::int AS unshipped,
           NULLIF(e->>'http','')::int            AS http
    FROM jsonb_array_elements(v_j->'rows') AS e
  )
  SELECT s.order_id, s.order_date, s.asin, s.quantity AS stored,
         a.status, a.shipped, a.unshipped, a.http,
         (COALESCE(a.shipped,0) + COALESCE(a.unshipped,0)) AS ordered
  FROM sample s LEFT JOIN amz a ON a.order_id = s.order_id;

  SELECT count(*) INTO v_n FROM cmp;
  RAISE NOTICE '   sample rows recomputed and joined: %', v_n;

  RAISE NOTICE '';
  RAISE NOTICE '############ QUANTITY: STORED vs AMAZON ############';
  RAISE NOTICE '   order                | date       | asin         | stored | shipped | unshipped | verdict';
  FOR r IN SELECT * FROM cmp ORDER BY order_date LOOP
    IF r.status IS NULL THEN
      v_err := v_err + 1;
      RAISE NOTICE '   % | % | % | % |       - |         - | NO ANSWER (http %)',
        r.order_id, r.order_date, rpad(r.asin,12), lpad(r.stored::text,6),
        COALESCE(r.http::text,'?');
    ELSE
      v_cmp := v_cmp + 1;
      IF r.stored = r.ordered THEN
        v_match := v_match + 1;
      ELSE
        v_mismatch := v_mismatch + 1;
        v_delta_units := v_delta_units + (r.stored - r.ordered);
        v_abs_units := v_abs_units + abs(r.stored - r.ordered);
      END IF;
      RAISE NOTICE '   % | % | % | % | % | % | % %',
        r.order_id, r.order_date, rpad(r.asin,12), lpad(r.stored::text,6),
        lpad(COALESCE(r.shipped::text,'-'),7), lpad(COALESCE(r.unshipped::text,'-'),9),
        CASE WHEN r.stored = r.ordered THEN 'match' ELSE '>>> MISMATCH' END,
        CASE WHEN r.stored = r.ordered THEN ''
             ELSE format('(stored %s, Amazon %s)', r.stored, r.ordered) END;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  RAISE NOTICE '';
  RAISE NOTICE '############ RESULT ############';
  RAISE NOTICE '   answered by Amazon      : % of %', v_cmp, v_n;
  RAISE NOTICE '   no answer / error       : %', v_err;
  RAISE NOTICE '   quantity MATCHES        : %', v_match;
  RAISE NOTICE '   quantity MISMATCHES     : %', v_mismatch;
  IF v_cmp > 0 THEN
    RAISE NOTICE '   mismatch rate           : % pct',
      round(100.0 * v_mismatch / v_cmp, 1);
  END IF;

  IF v_mismatch = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '   >>> NO MISMATCH IN THE SAMPLE. On % settled single-ASIN', v_cmp;
    RAISE NOTICE '   >>> multi-unit 2026 orders, sales_orders.quantity equals what';
    RAISE NOTICE '   >>> Amazon reports. COGS effect measured on this sample: 0.00.';
    RAISE NOTICE '';
    RAISE NOTICE '   What that does and does NOT establish: % of % eligible orders', v_cmp,
      (SELECT count(*) FROM (
         SELECT so.order_id FROM public.sales_orders so
         WHERE so.user_id = v_uid AND so.order_date >= '2026-01-01'
           AND so.order_date < '2027-01-01' AND COALESCE(so.quantity,0) >= 2
           AND so.order_id NOT LIKE '%-REFUND%') z);
    RAISE NOTICE '   is a 2 pct sample. Zero hits in 60 bounds the rate at roughly';
    RAISE NOTICE '   5 pct at 95 pct confidence -- it does not prove zero. It does';
    RAISE NOTICE '   mean there is no WIDESPREAD quantity defect to find.';
  ELSE
    RAISE NOTICE '   net unit delta (stored - Amazon) : %', v_delta_units;
    RAISE NOTICE '   absolute units in dispute        : %', v_abs_units;
    RAISE NOTICE '   COGS effect on the sample        : % (net delta x % per unit)',
      round(v_delta_units * COALESCE(v_avg_cost,0), 2), COALESCE(v_avg_cost,0);
    RAISE NOTICE '   A POSITIVE net delta means stored quantity exceeds Amazon, so';
    RAISE NOTICE '   COGS is OVERSTATED and profit UNDERSTATED by that amount.';

    WITH single AS (
      SELECT order_id FROM public.sales_orders
      WHERE user_id = v_uid AND order_date >= '2026-01-01'
        AND order_date < '2027-01-01' AND order_id NOT LIKE '%-REFUND%'
      GROUP BY order_id HAVING count(*) = 1),
    settled AS (
      SELECT DISTINCT amazon_order_id FROM public.financial_events_cache
      WHERE user_id = v_uid AND event_type='shipment' AND amazon_order_id IS NOT NULL)
    SELECT count(*), sum(so.quantity) INTO v_pop_orders, v_pop_units
    FROM public.sales_orders so
    JOIN single s ON s.order_id = so.order_id
    JOIN settled f ON f.amazon_order_id = so.order_id
    WHERE so.user_id = v_uid AND so.order_date >= '2026-01-01'
      AND so.order_date < '2027-01-01' AND COALESCE(so.quantity,0) >= 2;

    RAISE NOTICE '';
    RAISE NOTICE '   SCALED to the eligible population (% orders, % units):',
      v_pop_orders, v_pop_units;
    RAISE NOTICE '   at the sample rate, roughly % orders and % units of COGS',
      round(v_pop_orders * v_mismatch::numeric / greatest(v_cmp,1), 0),
      round(v_pop_units * v_abs_units::numeric / greatest(
        (SELECT sum(stored) FROM cmp WHERE status IS NOT NULL), 1), 0);
    RAISE NOTICE '   An EXTRAPOLATION from 60 orders, not a measurement. Confirm by';
    RAISE NOTICE '   widening the sample before acting on the figure.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   READ ONLY -- 2026 only, nothing written.';
END
$p$;
