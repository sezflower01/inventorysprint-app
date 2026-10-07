-- STEP 3 (status half), batch 1. apply:true for the first time.
--
-- Guards already proven by three dry runs: refund rows excluded, 2.1s pacing
-- on the items call, Pending left untouched, every row backed up in the same
-- pass, and a durable log row per change.
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    WITH base AS (
      SELECT so.is_cancelled, so.order_status,
             so.estimated_price * GREATEST(so.quantity,1) / COALESCE(fx.rate,1) AS usd
      FROM public.sales_orders so
      LEFT JOIN public.fx_rates fx ON fx.base='USD'
        AND fx.quote = CASE upper(COALESCE(so.marketplace,'US'))
              WHEN 'CA' THEN 'CAD' WHEN 'MX' THEN 'MXN' WHEN 'BR' THEN 'BRL' END
      WHERE so.user_id = v_uid AND COALESCE(so.sold_price,0)=0
        AND COALESCE(so.estimated_price,0)>0 AND so.order_id NOT LIKE '%-REFUND%'
    )
    SELECT round(sum(usd) FILTER (WHERE COALESCE(is_cancelled,false)=false)::numeric,2) AS a
    FROM base
  LOOP
    RAISE NOTICE 'BEFORE batch 1: Live Sales estimated revenue $%', r.a;
  END LOOP;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/resolve-stuck-pending-orders',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object('limit', 20, 'apply', true, 'newestFirst', true),
    timeout_milliseconds := 280000
  ) INTO v_req;
  RAISE NOTICE 'batch 1 dispatched (apply=true, newest first), request %', v_req;
END
$p$;
