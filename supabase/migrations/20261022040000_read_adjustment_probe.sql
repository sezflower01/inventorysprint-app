-- READ-ONLY. Read request 20881: the by_adjustment_type summary first, then
-- every item with its type, SKU, quantity, posted timestamp and SIGN.
DO $p$
DECLARE v_body jsonb; v_status int; r record;
BEGIN
  SELECT status_code, content::jsonb INTO v_status, v_body
  FROM net._http_response WHERE id = 20881;

  IF v_body IS NULL THEN
    RAISE NOTICE 'no response yet for 20881 (status %)', COALESCE(v_status::text,'-');
    FOR r IN SELECT id, status_code, left(COALESCE(content,error_msg,''),300) AS c
             FROM net._http_response ORDER BY id DESC LIMIT 3
    LOOP RAISE NOTICE '   recent: % | % | %', r.id, r.status_code, r.c; END LOOP;
    RETURN;
  END IF;

  RAISE NOTICE '== HTTP % | wrote_nothing=% ==', v_status, v_body->>'wrote_nothing';
  IF v_body ? 'error' THEN
    RAISE NOTICE '   ERROR: %', v_body->>'error';
    RETURN;
  END IF;

  RAISE NOTICE '   window % .. %', v_body->'window'->>'posted_after', v_body->'window'->>'posted_before';
  RAISE NOTICE '   pages % | adjustment events % | items %',
    v_body->>'pages', v_body->>'adjustment_events', v_body->>'adjustment_items';
  RAISE NOTICE '   other event lists seen: %', v_body->'other_event_lists_seen';

  RAISE NOTICE '';
  RAISE NOTICE '== BY ADJUSTMENT TYPE: signed vs absolute is the whole question ==';
  FOR r IN
    SELECT key AS atype,
           (value->>'items')::int AS items,
           (value->>'signed_total')::numeric AS signed_total,
           (value->>'abs_total')::numeric AS abs_total,
           (value->>'negatives')::int AS negs,
           (value->>'positives')::int AS poss
    FROM jsonb_each(v_body->'by_adjustment_type')
    ORDER BY abs((value->>'signed_total')::numeric) DESC
  LOOP
    RAISE NOTICE '   %', r.atype;
    RAISE NOTICE '      % items | % positive | % NEGATIVE', r.items, r.poss, r.negs;
    RAISE NOTICE '      signed total % | abs total %', r.signed_total, r.abs_total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== EVERY ITEM ==';
  FOR r IN
    SELECT it->>'adjustment_type' AS atype,
           left(COALESCE(it->>'posted_date','-'),19) AS posted,
           COALESCE(it->>'seller_sku','-') AS sku,
           COALESCE(it->>'quantity','-') AS qty,
           COALESCE(it->>'amount_raw','-') AS amt,
           it->>'sign' AS sgn,
           COALESCE(it->>'asin','-') AS asin
    FROM jsonb_array_elements(v_body->'items') AS it
    ORDER BY it->>'posted_date', it->>'adjustment_type'
  LOOP
    RAISE NOTICE '   % | % | sku % | qty % | amt % (%) | %',
      r.posted, rpad(left(r.atype,26),26), rpad(left(r.sku,16),16),
      lpad(r.qty,4), lpad(r.amt,9), r.sgn, r.asin;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== field availability (did Amazon even send SellerSKU/Quantity?) ==';
  FOR r IN
    SELECT it->'item_keys' AS ik
    FROM jsonb_array_elements(v_body->'items') AS it LIMIT 1
  LOOP RAISE NOTICE '   item keys: %', r.ik; END LOOP;
  FOR r IN
    SELECT it->'event_keys' AS ek
    FROM jsonb_array_elements(v_body->'items') AS it LIMIT 1
  LOOP RAISE NOTICE '   event keys: %', r.ek; END LOOP;
END
$p$;
