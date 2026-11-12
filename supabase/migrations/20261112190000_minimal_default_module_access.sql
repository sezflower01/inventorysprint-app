-- Narrow what a brand-new account is granted automatically.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- Until now a signup trigger granted 15 modules x 3 actions = 45 permissions
-- to every new account, before that account had connected anything or been
-- looked at. Among them were the modules that spend metered third-party quota
-- and the ones that display the operator's own commercial figures. A default
-- should be the smallest thing that lets someone get started, not the largest
-- thing that avoids a support request.
--
-- ── THE POLICY, IN THREE STAGES ──────────────────────────────────────────
--
--   signup            settings only. Enough to sign in, look around, and
--                     connect an Amazon account. Nothing that reads or spends.
--
--   amazon_connected  the operational modules, granted when the account first
--                     authorises Amazon -- at which point the person has data
--                     of their own and the modules have something to show.
--
--   explicit          repricer, profit_loss, supplier_discovery, fba_builder
--                     and personalhour. Never granted by any trigger. The
--                     first four act on live pricing, commercial figures or
--                     metered quota; personalhour is a separate product.
--
-- ── WHY A SEPARATE FUNCTION RATHER THAN A LIST INSIDE THE TRIGGER ────────
--
-- The policy is the part worth testing, and a trigger body cannot be tested
-- without creating a user. Pulling the list into a STABLE function that just
-- returns rows means the policy can be asserted directly, read-only, which is
-- what the verification block at the bottom of this file does.
--
-- It also means there is exactly ONE list. The previous arrangement would
-- have needed the same array written out again in the connect-time trigger,
-- and two copies of a permission list is how they drift apart.
--
-- ── WHAT THIS DOES *NOT* DO ──────────────────────────────────────────────
--
-- It does not revoke anything from anyone. Existing accounts keep every
-- permission they already hold, including the three that exist today. Taking
-- permissions away from a live account is a decision with consequences for
-- whoever is using it, so it stays a deliberate act, not a side effect of a
-- migration. The accompanying report lists what each existing account holds.

-- ════════════════════════════════════════════════════════════════════════
-- 1. The policy itself -- pure, read-only, returns rows and writes nothing.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_default_modules_for_stage(p_stage text)
RETURNS TABLE (module public.app_module, action public.app_action)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Column aliases are spelled out (AS s(m), AS acts(a)) rather than left as
  -- bare `AS m`, where the alias names both the table and its column and the
  -- reference becomes ambiguous to read even where Postgres resolves it.
  SELECT s.m::public.app_module, acts.a::public.app_action
  FROM unnest(
    CASE lower(p_stage)
      -- Signing in and connecting an account. Nothing that reads or spends.
      WHEN 'signup' THEN ARRAY[
        'settings'
      ]
      -- Granted once the account first authorises Amazon.
      WHEN 'amazon_connected' THEN ARRAY[
        'inventory', 'reports', 'product_library', 'buy_again',
        'still_thinking', 'mobile_live_sales', 'mobile_inventory_valuation',
        'upc_scanner', 'scan_history'
      ]
      -- Any other stage, including 'explicit', grants nothing. That is the
      -- point: repricer, profit_loss, supplier_discovery, fba_builder and
      -- personalhour are reachable only by someone granting them by hand.
      ELSE ARRAY[]::text[]
    END
  ) AS s(m)
  CROSS JOIN unnest(ARRAY['view', 'run', 'edit']) AS acts(a);
$$;

REVOKE EXECUTE ON FUNCTION public.fn_default_modules_for_stage(text) FROM anon, authenticated;

COMMENT ON FUNCTION public.fn_default_modules_for_stage(text) IS
  'Single source of truth for automatic module grants. Stages: signup, amazon_connected. Anything else returns no rows.';

-- ════════════════════════════════════════════════════════════════════════
-- 2. Signup: settings only.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_grant_default_module_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Already provisioned: leave it alone. Re-running must never widen access.
  IF EXISTS (SELECT 1 FROM public.user_module_access WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Admins are allowed everything by the access guard itself, so granting
  -- individual rows for them is noise. Unchanged from the previous version.
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id AND role = 'admin') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_module_access (user_id, module, action)
  SELECT NEW.id, d.module, d.action
  FROM public.fn_default_modules_for_stage('signup') d
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_grant_default_module_access() FROM anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 3. First Amazon connection: the operational modules.
--
-- Fires only on the account's FIRST authorisation row. Without that
-- condition, revoking a module by hand and then having the user reconnect
-- would silently hand it back -- the permission change would appear to work
-- and then quietly undo itself, which is worse than not having the trigger.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_grant_modules_on_amazon_connect()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role = 'admin') THEN
    RETURN NEW;
  END IF;

  -- Not the first authorisation for this account -> do nothing.
  IF EXISTS (
    SELECT 1 FROM public.seller_authorizations
    WHERE user_id = NEW.user_id AND id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_module_access (user_id, module, action)
  SELECT NEW.user_id, d.module, d.action
  FROM public.fn_default_modules_for_stage('amazon_connected') d
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_grant_modules_on_amazon_connect() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_grant_modules_on_amazon_connect ON public.seller_authorizations;
CREATE TRIGGER trg_grant_modules_on_amazon_connect
  AFTER INSERT ON public.seller_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_grant_modules_on_amazon_connect();

-- ════════════════════════════════════════════════════════════════════════
-- 4. THE TEST.
--
-- Assertions, not notices: a failure here raises, the transaction rolls back
-- and the migration does not apply. A permission policy that printed a
-- warning and installed itself anyway would be worthless.
--
-- What is tested is the POLICY and the WIRING. The end-to-end path -- a real
-- account signing up and connecting -- is deliberately not tested here,
-- because that would mean inserting into auth.users from a migration. It is
-- covered instead by the new-user isolation test, which creates a genuine
-- account and asserts against it.
-- ════════════════════════════════════════════════════════════════════════
DO $p$
DECLARE
  n int;
  v_txt text;
  v_explicit text[] := ARRAY['repricer', 'profit_loss', 'supplier_discovery',
                             'fba_builder', 'personalhour'];
BEGIN
  -- (a) signup grants settings, and only settings
  SELECT count(*) INTO n FROM public.fn_default_modules_for_stage('signup');
  IF n <> 3 THEN
    RAISE EXCEPTION 'signup stage granted % rows, expected 3 (settings x view/run/edit)', n;
  END IF;
  SELECT count(*) INTO n FROM public.fn_default_modules_for_stage('signup')
   WHERE module::text <> 'settings';
  IF n <> 0 THEN
    RAISE EXCEPTION 'signup stage granted % module(s) other than settings', n;
  END IF;

  -- (b) the connect stage grants the operational set, and nothing reserved
  SELECT count(*) INTO n FROM public.fn_default_modules_for_stage('amazon_connected');
  IF n <> 27 THEN
    RAISE EXCEPTION 'amazon_connected granted % rows, expected 27 (9 modules x 3)', n;
  END IF;

  -- (c) THE LOAD-BEARING ONE: no reserved module is granted at any stage
  FOR v_txt IN SELECT unnest(v_explicit) LOOP
    SELECT count(*) INTO n
    FROM (
      SELECT module FROM public.fn_default_modules_for_stage('signup')
      UNION ALL
      SELECT module FROM public.fn_default_modules_for_stage('amazon_connected')
    ) x WHERE module::text = v_txt;
    IF n <> 0 THEN
      RAISE EXCEPTION 'reserved module "%" is granted automatically (% rows)', v_txt, n;
    END IF;
  END LOOP;

  -- (d) the two stages do not overlap -- an overlap means a module is granted
  --     twice and that the two lists have started to drift
  SELECT count(*) INTO n
  FROM public.fn_default_modules_for_stage('signup') s
  JOIN public.fn_default_modules_for_stage('amazon_connected') c
    ON c.module = s.module AND c.action = s.action;
  IF n <> 0 THEN
    RAISE EXCEPTION 'signup and amazon_connected overlap on % grant(s)', n;
  END IF;

  -- (e) an unknown stage grants nothing. Guards against a future typo in a
  --     caller silently falling through to a permissive default.
  FOR v_txt IN SELECT unnest(ARRAY['explicit', 'typo', '', 'SIGNUP ']) LOOP
    SELECT count(*) INTO n FROM public.fn_default_modules_for_stage(v_txt);
    IF n <> 0 THEN
      RAISE EXCEPTION 'unknown stage "%" granted % rows; it must grant none', v_txt, n;
    END IF;
  END LOOP;

  -- (f) wiring: both triggers exist and point at the right functions
  SELECT count(*) INTO n
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgname = 'trg_grant_default_module_access'
    AND p.proname = 'fn_grant_default_module_access'
    AND NOT t.tgisinternal;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the signup trigger is not wired to fn_grant_default_module_access (found %)', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE t.tgname = 'trg_grant_modules_on_amazon_connect'
    AND p.proname = 'fn_grant_modules_on_amazon_connect'
    AND c.relname = 'seller_authorizations'
    AND NOT t.tgisinternal;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the connect trigger is not wired to seller_authorizations (found %)', n;
  END IF;

  -- (g) the signup function really does route through the policy function,
  --     rather than keeping a list of its own that happens to match today
  IF position('fn_default_modules_for_stage' IN
       pg_get_functiondef('public.fn_grant_default_module_access()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the signup trigger does not call the policy function';
  END IF;

  RAISE NOTICE 'default-access policy: all assertions passed';
  RAISE NOTICE '  signup           -> settings only (3 grants)';
  RAISE NOTICE '  amazon_connected -> 9 operational modules (27 grants)';
  RAISE NOTICE '  reserved         -> repricer, profit_loss, supplier_discovery, fba_builder, personalhour';
END $p$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. What the EXISTING accounts hold right now. Report only -- no change.
-- ════════════════════════════════════════════════════════════════════════
DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE ' ';
  RAISE NOTICE '=== existing accounts: permissions held today (unchanged) ===';
  FOR r IN
    SELECT u.id, left(u.id::text, 8) AS short,
           count(a.*) AS grants,
           count(DISTINCT a.module) AS modules,
           EXISTS (SELECT 1 FROM public.user_roles ur
                    WHERE ur.user_id = u.id AND ur.role = 'admin') AS is_admin
    FROM auth.users u
    LEFT JOIN public.user_module_access a ON a.user_id = u.id
    GROUP BY u.id ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '  %  % grants across % modules  admin=%',
      r.short, lpad(r.grants::text, 4), lpad(r.modules::text, 3), r.is_admin;
  END LOOP;
  RAISE NOTICE ' ';
  RAISE NOTICE 'Nothing was revoked. Narrowing an existing account is a separate,';
  RAISE NOTICE 'deliberate step.';
END $p$;
