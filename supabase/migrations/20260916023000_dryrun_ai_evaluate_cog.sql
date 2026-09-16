-- DRY RUN ONLY. Writes nothing to repricer data and pushes no price.
--
-- Verify the deployed COG-aware repricer-ai-evaluate picks the right unit
-- cost. dry_run=true skips every write in the evaluator (decision log,
-- assignment updates), and the evaluator never pushes a price itself -- the
-- scheduler does. Two real assignments:
--   B0H4WH84HR  COG $12.75, no inventory.cost      -> expect "COG on record"
--   B0725P2SY3  placeholder $1.00 COG, flagged     -> expect NOT COG on record
-- Responses land in net._http_response; read by the next probe.

SELECT a.asin,
       net.http_post(
         url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-ai-evaluate',
         headers := (
           SELECT jsonb_build_object(
             'Content-Type',      'application/json',
             'x-internal-secret', decrypted_secret::text
           )
           FROM vault.decrypted_secrets
           WHERE name = 'INTERNAL_SYNC_SECRET'
           LIMIT 1
         ),
         body := jsonb_build_object(
           'internal', true,
           'user_id', a.user_id,
           'assignmentId', a.id,
           'asin', a.asin,
           'sku', a.sku,
           'marketplace', a.marketplace,
           'ruleId', a.rule_id,
           'dry_run', true,
           'triggered_by', 'cog-change-evaluator-dry-run'
         ),
         timeout_milliseconds := 120000
       ) AS request_id
FROM public.repricer_assignments a
JOIN auth.users u ON u.id = a.user_id AND u.email = 'sezflower01@gmail.com'
WHERE a.asin IN ('B0H4WH84HR', 'B0725P2SY3')
  AND a.marketplace = 'US'
  AND a.is_enabled = true;
