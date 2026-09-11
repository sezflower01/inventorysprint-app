-- PROBE (read-only): repair-collapsed-orders-15min has run 146 times, all
-- "succeeded", yet the shortlist only fell 348 -> 290. At ~50 candidates per
-- run that should have finished many times over.
--
-- Suspected cause: the scheduled body always posts offset 0. A REPAIRED row
-- leaves the shortlist (its quantity is no longer 1), but an ALREADY-CORRECT
-- row never does -- so every run would re-check the same head and spend Orders
-- API quota, shared with sync-sales-orders, on rows it already cleared.
--
-- pg_cron's "succeeded" only means the SQL dispatched the HTTP call; it says
-- nothing about what the function did. Read the function's own responses.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_n int := 0;
BEGIN
  RAISE NOTICE 'now: %', now();

  RAISE NOTICE '';
  RAISE NOTICE '======== recent repair responses ========';
  FOR r IN
    SELECT id, created,
           status_code,
           (content::jsonb ->> 'checked')                 AS checked,
           (content::jsonb ->> 'repaired')                AS repaired,
           (content::jsonb ->> 'already_correct')         AS ok,
           (content::jsonb ->> 'unverifiable')            AS unver,
           (content::jsonb ->> 'throttled')               AS throttled,
           (content::jsonb ->> 'revenue_skipped_non_usd') AS fx,
           (content::jsonb ->> 'elapsed_ms')              AS ms
    FROM net._http_response
    WHERE content IS NOT NULL
      AND content::text LIKE '%"already_correct"%'
    ORDER BY created DESC LIMIT 20
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE '   % | % | checked=% repaired=% already_ok=% unverif=% throttled=% fx=% (%ms)',
      r.created, r.status_code, r.checked, r.repaired, r.ok, r.unver, r.throttled, r.fx, r.ms;
  END LOOP;
  IF v_n = 0 THEN
    RAISE NOTICE '   no repair responses retained in net._http_response';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '======== totals over retained responses ========';
  FOR r IN
    SELECT count(*) AS runs,
           sum((content::jsonb ->> 'checked')::int)         AS checked,
           sum((content::jsonb ->> 'repaired')::int)        AS repaired,
           sum((content::jsonb ->> 'already_correct')::int) AS ok,
           sum((content::jsonb ->> 'unverifiable')::int)    AS unver,
           sum(COALESCE((content::jsonb ->> 'throttled')::int,0)) AS throttled,
           min(created) AS first_seen, max(created) AS last_seen
    FROM net._http_response
    WHERE content IS NOT NULL AND content::text LIKE '%"already_correct"%'
  LOOP
    RAISE NOTICE '   % runs retained (% .. %)', r.runs, r.first_seen, r.last_seen;
    RAISE NOTICE '   checked % | repaired % | already correct % | unverifiable % | throttled %',
      r.checked, r.repaired, r.ok, r.unver, r.throttled;
    IF COALESCE(r.checked,0) > 0 THEN
      RAISE NOTICE '   -> % %% of SP-API calls found nothing to repair',
        round(100.0 * (COALESCE(r.ok,0) + COALESCE(r.unver,0)) / r.checked, 1);
    END IF;
  END LOOP;
END
$probe$;
