-- VERIFY the COG page's database path as the seller, not as postgres.
--
-- The page reads and edits asin_cog_on_record through the browser client, so
-- it runs as role `authenticated` with the seller's JWT under RLS. Migrations
-- run as postgres, which bypasses RLS -- so a passing load proves nothing about
-- whether the page can see or save a row. This impersonates the seller the
-- way PostgREST does (role + request.jwt.claims) and exercises:
--   1. SELECT own rows            -- the page load
--   2. UPDATE own row             -- saving a COG, exactly the page's patch
--   3. INSERT own row             -- "Add a product"
--   4. SELECT as a different uid  -- must see nothing
--
-- Steps 2 and 3 run inside a block that raises at the end, rolling back to
-- the block's savepoint, so B0G4BQ42W3 is left exactly as loaded: no COG,
-- flagged for review. Nothing is changed.

DO $verify$
DECLARE
  v_uid uuid;
  v_n int;
  v_row record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_n FROM public.asin_cog_on_record;
  RAISE NOTICE '1. as seller, rows visible: % (expect 3093)', v_n;

  BEGIN
    UPDATE public.asin_cog_on_record
       SET unit_cost = 11.25, source = 'manual', needs_review = false
     WHERE asin = 'B0G4BQ42W3'
    RETURNING unit_cost, source, needs_review, updated_at > created_at AS stamped
      INTO v_row;
    RAISE NOTICE '2. as seller, save COG on B0G4BQ42W3: cost=% source=% needs_review=% updated_at_moved=%',
      v_row.unit_cost, v_row.source, v_row.needs_review, v_row.stamped;

    INSERT INTO public.asin_cog_on_record (user_id, asin, unit_cost, source)
    VALUES (v_uid, 'B00074PE6E', 3.00, 'manual')
    RETURNING asin, unit_cost INTO v_row;
    RAISE NOTICE '3. as seller, add product: % at %', v_row.asin, v_row.unit_cost;

    RAISE EXCEPTION 'rollback-verify';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback-verify' THEN RAISE; END IF;
    RAISE NOTICE '   (steps 2-3 rolled back)';
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.asin_cog_on_record;
  RAISE NOTICE '4. as a different account, rows visible: % (expect 0)', v_n;

  -- SET LOCAL ROLE postgres, not RESET ROLE. Under `supabase db push` the
  -- session user is cli_login_postgres, which then SETs ROLE postgres; RESET
  -- returns to cli_login_postgres, which has no grant on this table. That
  -- failed the first attempt at this migration after all four checks passed.
  SET LOCAL ROLE postgres;

  SELECT unit_cost, needs_review, source INTO v_row
  FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B0G4BQ42W3';
  RAISE NOTICE 'after: B0G4BQ42W3 cost=% needs_review=% source=% (expect NULL, true, import)',
    COALESCE(v_row.unit_cost::text, 'NULL'), v_row.needs_review, v_row.source;
  SELECT count(*) INTO v_n FROM public.asin_cog_on_record WHERE user_id = v_uid AND asin = 'B00074PE6E';
  RAISE NOTICE 'after: B00074PE6E rows = % (expect 0)', v_n;
END
$verify$;
