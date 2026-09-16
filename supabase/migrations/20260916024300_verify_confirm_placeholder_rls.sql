-- VERIFICATION, ROLLED BACK. Leaves no change behind.
--
-- The COG page's "Confirm $1.00" button (markReviewed) now writes
-- { reviewed_at: now, needs_review: false }. Prove, as the seller under RLS,
-- that (1) the update is allowed, (2) it does not touch unit_cost, so no 2026
-- sale is re-priced, and (3) the confirmed COG then appears in
-- asin_cog_for_repricer. Everything runs in a subtransaction that is
-- deliberately aborted, so the flagged row is exactly as before.

DO $p$
DECLARE
  v_uid uuid; v_asin text := 'B0725P2SY3';
  v_before int; v_after int; v_cost_before numeric; v_cost_after numeric; v_rows int;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  SELECT count(*) INTO v_before FROM public.asin_cog_for_repricer WHERE user_id = v_uid AND asin = v_asin;
  SELECT unit_cost INTO v_cost_before FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = v_asin;
  RAISE NOTICE 'before: % in repricer view = %, unit_cost = %', v_asin, v_before, v_cost_before;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;

    UPDATE public.asin_cog_on_record
       SET reviewed_at = now(), needs_review = false
     WHERE user_id = v_uid AND asin = v_asin;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    SELECT count(*) INTO v_after FROM public.asin_cog_for_repricer WHERE user_id = v_uid AND asin = v_asin;
    SELECT unit_cost INTO v_cost_after FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = v_asin;

    RAISE NOTICE 'as seller: rows updated = % (expect 1)', v_rows;
    RAISE NOTICE 'as seller: in repricer view after confirm = % (expect 1), unit_cost = % (expect unchanged)', v_after, v_cost_after;

    SET LOCAL ROLE postgres;
    RAISE EXCEPTION 'rollback-verify';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-verify' THEN RAISE; END IF;
  END;

  SELECT count(*) INTO v_after FROM public.asin_cog_for_repricer WHERE user_id = v_uid AND asin = v_asin;
  RAISE NOTICE 'after rollback: % in repricer view = % (expect 0 again)', v_asin, v_after;
END
$p$;
