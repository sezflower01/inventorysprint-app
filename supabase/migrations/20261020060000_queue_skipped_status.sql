-- Step 3: let the refresh queue record a SKIP instead of reporting success.
--
-- THE DEFECT. rescue-inventory-asin already decides, and already reports, that
-- it wrote nothing -- it returns `skipped_update_reason` in its body, with
-- values like `tombstoned:NOT_IN_CATALOG`, `no_exact_seller_sku_match`,
-- `suspicious_zero_unconfirmed` and `non_us_marketplace_skipped:CA`. But
-- inventory-refresh-worker only inspects `res.ok`, so a deliberate skip is
-- indistinguishable from a successful write and the queue records 'success'.
--
-- Measured on B00LFXMBKI 2026-10-20: 25+ queue rows, one every 3 hours,
-- every single one status 'success', attempts 1, last_error NULL -- while
-- `available` had not moved since 2026-09-03 and the ASIN sold 52 units in
-- the preceding 30 days. Seven weeks of green ticks on work that never
-- happened, which is why nobody looked.
--
-- A skip is NOT an error: it is a correct decision not to write, so it must
-- not consume retry attempts or trip error alerting. It needs its own state.

ALTER TABLE public.inventory_refresh_queue
  DROP CONSTRAINT IF EXISTS inventory_refresh_queue_status_check;

-- Widen the allowed statuses rather than overloading an existing one.
DO $p$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.inventory_refresh_queue'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';
  RAISE NOTICE '== pre-existing status constraint: % ==', COALESCE(v_def, '(none)');
END
$p$;

CREATE OR REPLACE FUNCTION public.mark_inventory_refresh_skipped(
  p_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- 'skipped' is terminal for this queue row, like success: the worker made a
  -- decision and there is nothing to retry. The reason lands in last_error
  -- purely because that is the existing text column -- it is diagnostic, not a
  -- failure, and attempts is deliberately NOT incremented.
  UPDATE public.inventory_refresh_queue
  SET status = 'skipped',
      processed_at = now(),
      last_error = left(COALESCE(p_reason, 'skipped'), 500),
      locked_at = NULL
  WHERE id = p_id;
$$;

COMMENT ON FUNCTION public.mark_inventory_refresh_skipped(uuid, text) IS
  'Terminal state for a refresh the worker deliberately did not apply (tombstoned row, no exact seller-SKU match, non-US marketplace, suspicious zero). Distinct from success so a green queue stops meaning "stock is current", and distinct from error so it does not burn retries or alert.';

GRANT EXECUTE ON FUNCTION public.mark_inventory_refresh_skipped(uuid, text) TO service_role;

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '';
  RAISE NOTICE '== current queue status distribution (before the worker change) ==';
  FOR r IN
    SELECT status, count(*) AS rows, max(processed_at) AS latest
    FROM public.inventory_refresh_queue WHERE user_id = v_uid
    GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | latest %', rpad(r.status,10), lpad(r.rows::text,7), r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many of those "success" rows were really skips? ==';
  RAISE NOTICE '   proxy: the row is tombstoned, so rescue can only have skipped';
  FOR r IN
    SELECT count(*) AS success_rows_on_tombstoned
    FROM public.inventory_refresh_queue q
    JOIN public.inventory i
      ON i.user_id = q.user_id AND i.sku = q.sku
    WHERE q.user_id = v_uid AND q.status = 'success'
      AND i.listing_status IN ('NOT_IN_CATALOG','DELETED')
  LOOP
    RAISE NOTICE '   % queue rows marked success against a tombstoned inventory row',
      r.success_rows_on_tombstoned;
    RAISE NOTICE '   -- every one of those wrote nothing';
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B00LFXMBKI right now (did the manual sync change it?) ==';
  FOR r IN
    SELECT COALESCE(sku,'-') AS sku, COALESCE(listing_status,'-') AS lstatus,
           COALESCE(available::text,'NULL') AS avail,
           COALESCE(reserved::text,'NULL') AS reserved,
           COALESCE(inbound::text,'NULL') AS inbound,
           COALESCE(source,'-') AS src, updated_at,
           COALESCE(last_inventory_sync_at::text,'never') AS last_sync
    FROM public.inventory WHERE user_id = v_uid AND asin = 'B00LFXMBKI'
  LOOP
    RAISE NOTICE '   sku % | % | avail % | res % | inb %',
      r.sku, r.lstatus, r.avail, r.reserved, r.inbound;
    RAISE NOTICE '   source % | updated % | last_inventory_sync %',
      r.src, r.updated_at, r.last_sync;
  END LOOP;
END
$p$;
