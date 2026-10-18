-- Re-quote the fee for CA order 701-0974352-2997055 with the fixed writer,
-- and count every other non-US order carrying a fee computed the broken way.
--
-- ANSWERING THE QUESTION DIRECTLY: the stored value is a WRONG ABSOLUTE
-- AMOUNT, and the display then compounds it.
--   stored referral_fee = 1.49  = 0.1505 x 9.90, where 9.90 is an inventory
--                                 (USD) figure, not this order's price
--   correct             = 0.1505 x CA$20.36 = CA$3.06 = US$2.16
--   displayed           = 1.49 / 1.4161 = US$1.05, because `from_cache` means
--                                 "referral is NATIVE" and 1.49 was not
-- So both: wrong number stored, then converted as if it were a currency it
-- was not.

CREATE TABLE IF NOT EXISTS public.backup_broken_fee_basis_20261018 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);

COMMENT ON TABLE public.backup_broken_fee_basis_20261018 IS
  'Snapshot of non-US sales_orders rows whose fees were computed by backfill-fee-cache before the 2026-10-18 price-basis fix (inventory USD figure used as the native price, no marketplace filter, estimated_price ignored).';

INSERT INTO public.backup_broken_fee_basis_20261018 (reason, row_data)
SELECT 'pre_fee_requote', to_jsonb(so)
FROM public.sales_orders so
WHERE so.user_id = (SELECT id FROM auth.users WHERE email = 'sezflower01@gmail.com')
  AND upper(COALESCE(so.marketplace,'US')) <> 'US'
  AND so.fees_source = 'from_cache'
  AND COALESCE(so.referral_fee,0) > 0;

DO $p$
DECLARE v_uid uuid; r record; v_secret text; v_req bigint; n int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT count(*) INTO n FROM public.backup_broken_fee_basis_20261018;
  RAISE NOTICE '== BACKUP: % non-US from_cache rows saved ==', n;

  RAISE NOTICE '';
  RAISE NOTICE '== HOW MANY NON-US ORDERS CARRY A from_cache FEE? ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS orders,
           count(*) FILTER (WHERE COALESCE(sold_price,0) = 0) AS pending,
           round(sum(referral_fee)::numeric,2) AS sum_referral
    FROM public.sales_orders
    WHERE user_id = v_uid AND upper(COALESCE(marketplace,'US')) <> 'US'
      AND fees_source = 'from_cache' AND COALESCE(referral_fee,0) > 0
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders (% still pending) | referral total %',
      rpad(r.mk,3), lpad(r.orders::text,4), lpad(r.pending::text,3), r.sum_referral;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (none)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== which of those look computed off the WRONG price? ==';
  RAISE NOTICE '   test: does referral_fee / referral_rate land near the order';
  RAISE NOTICE '   price, or near an inventory price instead?';
  FOR r IN
    SELECT so.marketplace AS mk, so.order_id, so.asin,
           so.estimated_price AS est_native, so.sold_price AS sold_usd,
           so.referral_fee AS stored_ref, fc.referral_rate AS rate,
           round((so.referral_fee / NULLIF(fc.referral_rate,0))::numeric,2) AS implied_price,
           inv.price AS inv_price, inv.my_price AS inv_my_price
    FROM public.sales_orders so
    JOIN public.asin_fee_cache fc ON fc.user_id = so.user_id AND fc.asin = so.asin
                                 AND fc.marketplace = so.marketplace
    LEFT JOIN public.inventory inv ON inv.user_id = so.user_id AND inv.asin = so.asin
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND so.fees_source = 'from_cache' AND COALESCE(so.referral_fee,0) > 0
      AND COALESCE(fc.referral_rate,0) > 0
    ORDER BY so.marketplace, so.order_id LIMIT 25
  LOOP
    RAISE NOTICE '   % % % | stored referral % -> implies price %',
      rpad(r.mk,3), r.order_id, r.asin, r.stored_ref, r.implied_price;
    RAISE NOTICE '        order est(native) % | sold(usd) % | inventory price % / my_price %',
      COALESCE(r.est_native::text,'-'), COALESCE(r.sold_usd::text,'-'),
      COALESCE(r.inv_price::text,'-'), COALESCE(r.inv_my_price::text,'-');
  END LOOP;

  -- Re-quote THIS order with the fixed writer. Clearing the fee fields first
  -- is what makes it eligible again (the selector needs fees_missing or an
  -- unavailable/null fees_source).
  UPDATE public.sales_orders
  SET referral_fee = NULL, fba_fee = NULL, total_fees = NULL,
      fees_source = 'unavailable', fees_missing = true,
      needs_fee_enrich = true, next_enrich_after = NULL, updated_at = now()
  WHERE user_id = v_uid AND order_id = '701-0974352-2997055';
  RAISE NOTICE '';
  RAISE NOTICE '== cleared fees on 701-0974352-2997055 so it re-quotes ==';

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-fee-cache',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid::text, 'max_asins', 3, 'force_bypass_ttl', true,
      'only', jsonb_build_array(jsonb_build_object('asin','B07KY25WY7','marketplace','CA'))
    ),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '== re-quote invoked, request id % ==', v_req;
END
$p$;
