-- Exercise topup_seller_catalog_queue on a real seller.
--
-- It reported "0 sellers" on install because every current seller was already
-- queued -- correct, but it means the path had never actually run. A cron that
-- has never done its job once is indistinguishable from a broken one, and this
-- repo has been bitten by exactly that more than once.

SET statement_timeout TO '600s';

DO $$
DECLARE
  v_seller text; v_mkt text; v_before bigint; v_after bigint; r RECORD;
BEGIN
  -- A small catalogue, so the test is cheap and the numbers are checkable.
  SELECT w.seller_id, w.marketplace INTO v_seller, v_mkt
  FROM public.seller_watchlist w
  WHERE jsonb_typeof(w.known_asin_list) = 'array'
    AND jsonb_array_length(w.known_asin_list) BETWEEN 5 AND 60
  LIMIT 1;

  IF v_seller IS NULL THEN
    RAISE NOTICE 'no small catalogue to test with -- skipping';
    RETURN;
  END IF;

  SELECT count(*) INTO v_before FROM public.seller_catalog_queue
   WHERE seller_id = v_seller AND marketplace = v_mkt;

  -- Pretend it was never synced, and remove a few rows so there is real work.
  DELETE FROM public.seller_catalog_queue
   WHERE ctid IN (SELECT ctid FROM public.seller_catalog_queue
                   WHERE seller_id = v_seller AND marketplace = v_mkt LIMIT 3);
  UPDATE public.seller_catalog_backfill_state
     SET queue_synced_at = NULL
   WHERE seller_id = v_seller AND marketplace = v_mkt;

  SELECT count(*) INTO v_after FROM public.seller_catalog_queue
   WHERE seller_id = v_seller AND marketplace = v_mkt;
  RAISE NOTICE 'seller %: had % queue rows, removed 3 -> %', v_seller, v_before, v_after;

  SELECT * INTO r FROM public.topup_seller_catalog_queue(5, 1000);
  RAISE NOTICE 'top-up ran: % sellers, % queue rows added, % cache rows added',
    r.sellers_processed, r.queue_rows_added, r.cache_rows_added;

  SELECT count(*) INTO v_after FROM public.seller_catalog_queue
   WHERE seller_id = v_seller AND marketplace = v_mkt;
  RAISE NOTICE 'restored to % rows (want %)', v_after, v_before;

  RAISE NOTICE 'queue_synced_at stamped: %',
    (SELECT queue_synced_at IS NOT NULL FROM public.seller_catalog_backfill_state
      WHERE seller_id = v_seller AND marketplace = v_mkt);
END $$;
