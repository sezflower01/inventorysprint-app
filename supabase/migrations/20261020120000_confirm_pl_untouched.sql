-- READ-ONLY. The standing condition on every change: confirm the P&L is
-- unchanged. The inventory writes in 20261020090000 touched listing_status,
-- source and the stock quantities on ONE row. Prove that no P&L path can see
-- any of them.
DO $p$
DECLARE r record; v_def text; v_found bool := false;
BEGIN
  RAISE NOTICE '== every overload of the P&L RPC, and what it reads ==';
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_monthly_pl_breakdown'
    ORDER BY p.oid
  LOOP
    v_found := true;
    v_def := pg_get_functiondef(r.oid);
    RAISE NOTICE '   %(%)', r.proname, r.args;
    RAISE NOTICE '      financial_events_cache : %', (v_def ILIKE '%financial_events_cache%');
    RAISE NOTICE '      public.inventory       : %', (v_def ~* '(from|join|update|into)[[:space:]]+(public\.)?inventory[^_a-z]');
    RAISE NOTICE '      listing_status         : %', (v_def ILIKE '%listing_status%');
    RAISE NOTICE '      available / reserved   : % / %',
      (v_def ILIKE '%available%'), (v_def ILIKE '%reserved%');
  END LOOP;
  IF NOT v_found THEN RAISE NOTICE '   RPC get_monthly_pl_breakdown NOT FOUND'; END IF;
END
$p$;
