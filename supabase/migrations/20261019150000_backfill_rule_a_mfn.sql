-- Item 3: backfill the 32 rule-A rows to MFN.
--
-- RULE A is the only inference that survived testing. Against rows whose
-- channel Amazon itself stated (measured 2026-10-19):
--
--   AFN  13,733 of 13,739 (100.0 pct) carry an fba_fee |  0 carry a label fee
--   MFN      45 of     88 ( 51.1 pct) carry an fba_fee | 86 carry a label fee
--
-- NO AFN row carries a shipping label fee, and 97.7 pct of MFN rows do. A
-- label fee is money the SELLER paid a carrier, which only happens when the
-- seller ships. So shipping_label_fee > 0 proves MFN.
--
-- The converse does NOT hold and must not be used: fba_fee > 0 appears on half
-- of known-MFN orders, so it cannot prove AFN. That rule is withdrawn and the
-- 56,921 rows it would have "resolved" are left NULL.

CREATE TABLE IF NOT EXISTS public.backup_channel_backfill_20261019 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);

COMMENT ON TABLE public.backup_channel_backfill_20261019 IS
  'Pre-change snapshot of sales_orders rows whose fulfillment_channel was set by the 2026-10-19 rule-A backfill (shipping_label_fee > 0 proves MFN). Restore from row_data to revert.';

INSERT INTO public.backup_channel_backfill_20261019 (reason, row_data)
SELECT 'rule_a_label_fee_proves_mfn', to_jsonb(so)
FROM public.sales_orders so
WHERE so.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
  AND so.fulfillment_channel IS NULL
  AND COALESCE(so.shipping_label_fee, 0) > 0
  AND so.order_id NOT LIKE '%-REFUND%';

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT count(*) INTO n FROM public.backup_channel_backfill_20261019;
  RAISE NOTICE '== BACKUP: % rows saved ==', n;

  RAISE NOTICE '';
  RAISE NOTICE '== BEFORE: the candidate rows ==';
  FOR r IN
    SELECT order_id, order_date, asin, COALESCE(sku,'-') AS sku,
           shipping_label_fee AS label_fee,
           COALESCE(shipping_label_fee_source,'-') AS src,
           COALESCE(fba_fee,0) AS fba_fee
    FROM public.sales_orders
    WHERE user_id = v_uid AND fulfillment_channel IS NULL
      AND COALESCE(shipping_label_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%'
    ORDER BY order_date DESC
  LOOP
    RAISE NOTICE '   % | % | % | label % from % | fba_fee %',
      r.order_id, r.order_date, rpad(r.asin,12),
      lpad(r.label_fee::text,7), rpad(r.src,18), r.fba_fee;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none -- nothing to backfill)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '   NOTE: some of these also carry an fba_fee. That is expected --';
  RAISE NOTICE '   it is exactly the overlap that makes fba_fee useless as an';
  RAISE NOTICE '   AFN test, and it does not weaken the label-fee proof.';
END
$p$;

UPDATE public.sales_orders
SET fulfillment_channel = 'MFN',
    updated_at = now()
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
  AND fulfillment_channel IS NULL
  AND COALESCE(shipping_label_fee, 0) > 0
  AND order_id NOT LIKE '%-REFUND%';

DO $p$
DECLARE v_uid uuid; r record; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '== AFTER ==';
  FOR r IN
    SELECT COALESCE(fulfillment_channel,'(NULL)') AS fc, count(*) AS orders
    FROM public.sales_orders
    WHERE user_id = v_uid AND order_id NOT LIKE '%-REFUND%'
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '   % | % orders', rpad(r.fc,8), r.orders;
  END LOOP;

  SELECT count(*) INTO n FROM public.sales_orders
  WHERE user_id = v_uid AND fulfillment_channel IS NULL
    AND COALESCE(shipping_label_fee,0) > 0 AND order_id NOT LIKE '%-REFUND%';
  RAISE NOTICE '';
  RAISE NOTICE '   rule-A candidates remaining: % (want 0)', n;

  RAISE NOTICE '';
  RAISE NOTICE '== P&L CHECK ==';
  SELECT count(*) INTO n FROM public.financial_events_cache
  WHERE amazon_order_id IN (
    SELECT row_data->>'order_id' FROM public.backup_channel_backfill_20261019);
  RAISE NOTICE '   financial_events_cache rows for the touched orders: %', n;
  RAISE NOTICE '   fulfillment_channel is not a P&L input and nothing was';
  RAISE NOTICE '   written to financial_events_cache, so the P&L is unchanged.';
END
$p$;
