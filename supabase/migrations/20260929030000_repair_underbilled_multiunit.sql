-- Re-enrich the multi-unit orders that were billed as single units.
--
-- Cause (fixed in fetch-live-orders this deploy): the ENRICHMENT fee path
-- never multiplied the per-unit Fees API answer by order quantity, while the
-- new-order path beside it did. 69 orders / 220 units carry single-unit fees:
-- $15,204 of revenue with $1,084.80 booked against it, roughly $3,254 short.
--
-- Repaired by re-enrichment, NOT by multiplying the stored numbers. The stored
-- figure is only per-unit when the bug wrote it; multiplying blind would
-- corrupt any row that is low for an honest reason. sync-sales-orders'
-- ENRICH_BY_ASIN recomputes from the fee cache and multiplies by quantity
-- correctly (it always did).
--
-- financial_events rows are EXCLUDED: those came from Amazon's settlements and
-- are already order-level truth. A settlement that looks small is usually a
-- partial or adjusted one, and replacing it with an API estimate would trade
-- a fact for a guess. Ten such orders (~$338) are left for separate review.

DO $p$
DECLARE v_uid uuid; v_headers jsonb; v_req bigint; r text; n int; asins text[];
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  WITH bad AS (
    SELECT id FROM public.sales_orders
    WHERE user_id = v_uid
      AND quantity > 1
      AND COALESCE(is_cancelled, false) = false
      AND COALESCE(total_fees, 0) > 0
      AND COALESCE(total_sale_amount, sold_price * quantity, 0) > 0
      AND total_fees < 0.15 * COALESCE(total_sale_amount, sold_price * quantity)
      AND COALESCE(fees_source, '') <> 'financial_events'
  ), cleared AS (
    UPDATE public.sales_orders o SET fees_source = NULL, needs_fee_enrich = true
    FROM bad WHERE o.id = bad.id RETURNING 1)
  SELECT count(*) INTO n FROM cleared;
  RAISE NOTICE 'orders marked for re-enrichment: %', n;

  SELECT array_agg(DISTINCT asin) INTO asins
  FROM public.sales_orders
  WHERE user_id = v_uid AND needs_fee_enrich = true AND fees_source IS NULL
    AND quantity > 1 AND COALESCE(is_cancelled,false) = false;
  RAISE NOTICE 'distinct ASINs to re-enrich: %', COALESCE(array_length(asins, 1), 0);

  SELECT (regexp_match(command, 'headers:=''(\{.*?\})''::jsonb'))[1]::jsonb INTO v_headers
  FROM cron.job WHERE jobid = 190;
  IF v_headers IS NULL THEN RAISE NOTICE 'no usable auth header — nothing sent'; RETURN; END IF;

  FOREACH r IN ARRAY COALESCE(asins, ARRAY[]::text[]) LOOP
    SELECT net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
      headers := v_headers,
      body := jsonb_build_object('user_id', v_uid, 'enrich_by_asin', true, 'target_asin', r, 'force_price_update', false),
      timeout_milliseconds := 120000
    ) INTO v_req;
  END LOOP;
  RAISE NOTICE 'enrichment requested for % ASIN(s)', COALESCE(array_length(asins, 1), 0);
END
$p$;
