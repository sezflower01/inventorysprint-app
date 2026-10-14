-- READ-ONLY. Verify order 701-1848920-5681843.
--
-- Amazon: CA marketplace, B00DLD1C0A, SKU QY8-1QN-FYH6, quantity 2,
-- item subtotal CA$78.16, purchased 2026-10-14 10:10 PDT, still Pending.
-- Mobile Live Sales shows US$69.60 with fees of $24.26.
--
-- CA$78.16 at the stored USD->CAD rate is nowhere near $69.60, so one of the
-- two numbers is answering a different question. Read the row rather than
-- reason about the screen.

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the order row ==';
  FOR r IN
    SELECT order_id, asin, sku, quantity, COALESCE(marketplace, '-') AS mk,
           sold_price, item_price, total_sale_amount, estimated_price,
           COALESCE(price_source, '-') AS psrc, COALESCE(price_calc_mode, '-') AS mode,
           COALESCE(price_confidence, '-') AS conf,
           referral_fee, fba_fee, closing_fee, total_fees,
           COALESCE(fees_source, '-') AS fsrc,
           COALESCE(order_status, '-') AS st, is_cancelled,
           order_date, purchase_timestamp_utc, created_at
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id = '701-1848920-5681843'
  LOOP
    RAISE NOTICE '  % | % | % | qty % | marketplace %', r.order_id, r.asin, r.sku, r.quantity, r.mk;
    RAISE NOTICE '  sold_price % | item_price % | total_sale_amount % | estimated_price %',
      r.sold_price, COALESCE(r.item_price::text, '-'),
      COALESCE(r.total_sale_amount::text, '-'), COALESCE(r.estimated_price::text, '-');
    RAISE NOTICE '  price_source % | mode % | confidence %', r.psrc, r.mode, r.conf;
    RAISE NOTICE '  fees referral % | fba % | closing % | TOTAL % | source %',
      COALESCE(r.referral_fee::text, '-'), COALESCE(r.fba_fee::text, '-'),
      COALESCE(r.closing_fee::text, '-'), COALESCE(r.total_fees::text, '-'), r.fsrc;
    RAISE NOTICE '  status % | cancelled % | order_date % | utc %',
      r.st, r.is_cancelled, r.order_date, COALESCE(r.purchase_timestamp_utc::text, '-');
    RAISE NOTICE '  row written %', r.created_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no row for this order yet)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the conversion, from the rate actually stored ==';
  FOR r IN SELECT rate, as_of FROM public.fx_rates WHERE base = 'USD' AND quote = 'CAD' LOOP
    RAISE NOTICE '  USD -> CAD = % (as of %)', r.rate, r.as_of;
    RAISE NOTICE '  CA$78.16 total      = US$%', round((78.16 / r.rate)::numeric, 2);
    RAISE NOTICE '  CA$39.08 per unit   = US$%', round((39.08 / r.rate)::numeric, 2);
    RAISE NOTICE '  screen says US$69.60; that would need CA$% at this rate',
      round((69.60 * r.rate)::numeric, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== fee cache for this ASIN ==';
  FOR r IN
    SELECT marketplace, round((referral_rate * 100)::numeric, 2) AS referral_pct,
           round(fba_fee_fixed::numeric, 2) AS fba, COALESCE(fee_source, '-') AS src, updated_at
    FROM public.asin_fee_cache WHERE user_id = v_uid AND asin = 'B00DLD1C0A'
    ORDER BY marketplace
  LOOP
    RAISE NOTICE '  % | referral % pct | fba fixed $% | % | %',
      rpad(r.marketplace, 4), r.referral_pct, r.fba, r.src, r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (no fee cache row for this ASIN)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== what Amazon has actually billed for this ASIN before ==';
  FOR r IN
    SELECT COALESCE(marketplace, '-') AS mk, count(*) AS orders, sum(quantity) AS units,
           round(avg(sold_price)::numeric, 2) AS avg_sold,
           round((sum(referral_fee) / NULLIF(sum(quantity), 0))::numeric, 2) AS referral_u,
           round((sum(fba_fee) / NULLIF(sum(quantity), 0))::numeric, 2) AS fba_u,
           round((sum(total_fees) / NULLIF(sum(quantity), 0))::numeric, 2) AS fees_u
    FROM public.sales_orders
    WHERE user_id = v_uid AND asin = 'B00DLD1C0A'
      AND COALESCE(is_cancelled, false) = false AND order_id NOT LIKE '%-REFUND%'
      AND COALESCE(total_fees, 0) > 0
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % orders | % units | sold $% | referral $%/u | fba $%/u | fees $%/u',
      rpad(r.mk, 4), r.orders, r.units, r.avg_sold, r.referral_u, r.fba_u, r.fees_u;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '  (never billed, anywhere)'; END IF;
END
$p$;
