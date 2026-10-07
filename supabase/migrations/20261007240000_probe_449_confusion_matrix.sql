-- READ-ONLY. What WE say vs what AMAZON says, for the 40 sampled orders.
-- The sample was stratified by our own order_status (top 10 by value from each
-- group), so this matrix says which of our labels are trustworthy -- which is
-- what decides whether the remaining 409 need an API call each or can be
-- resolved from data we already hold.
DO $p$
DECLARE v_uid uuid; v_body jsonb; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT content::jsonb INTO v_body FROM net._http_response WHERE id = 46501;
  IF v_body IS NULL THEN RAISE NOTICE 'no reply'; RETURN; END IF;

  RAISE NOTICE '== we say  ->  Amazon says  (sampled orders) ==';
  FOR r IN
    WITH amz AS (
      SELECT e.v->>'order_id' AS oid, e.v->>'amazon_status' AS amazon_status,
             (e.v->>'items_shipped')::int AS shipped
      FROM jsonb_array_elements(v_body->'rows') AS e(v)
    )
    SELECT COALESCE(so.order_status,'(null)') AS ours, a.amazon_status AS theirs,
           count(*) AS orders,
           round(sum(so.estimated_price * so.quantity)::numeric, 2) AS est
    FROM amz a JOIN public.sales_orders so
      ON so.user_id = v_uid AND so.order_id = a.oid
    GROUP BY 1,2 ORDER BY 1,2
  LOOP
    RAISE NOTICE '  we say % -> Amazon says % | % orders | $%',
      rpad(r.ours, 10), rpad(r.theirs, 10), lpad(r.orders::text, 3), r.est;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the marketplace of the sampled orders, as WE record it ==';
  FOR r IN
    WITH amz AS (SELECT e.v->>'order_id' AS oid FROM jsonb_array_elements(v_body->'rows') AS e(v))
    SELECT COALESCE(so.marketplace,'?') AS mk, count(*) AS orders
    FROM amz a JOIN public.sales_orders so ON so.user_id = v_uid AND so.order_id = a.oid
    GROUP BY 1 ORDER BY orders DESC
  LOOP
    RAISE NOTICE '  % | % sampled orders', rpad(r.mk, 4), r.orders;
  END LOOP;
END
$p$;
