-- PROBE (read-only): the twin map for cron jobs that authenticate with a
-- hardcoded JWT.
--
-- Timestamp attribution failed here, as it did on 2026-09-01: every run of
-- every HTTP job fires in a window shared with other jobs (solo = 0 across the
-- board), so a failure cannot be pinned to one job by time.
--
-- What worked then, and what this supports now, is deterministic: a job's auth
-- style against its target's gate. This probe supplies the job side --
--   * which target function each job calls
--   * whether it authenticates with the vault secret or a hardcoded bearer
--   * for a hardcoded bearer, which ROLE the token carries (anon vs
--     service_role) and when it was issued, decoded from the JWT payload
--   * whether a twin job calls the same function with the vault secret, i.e.
--     whether a failing job is noise beside a working one, or the only caller
--
-- Only functions with at least one hardcoded-bearer caller are listed.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record;
BEGIN
  RAISE NOTICE 'now: %', now();
  RAISE NOTICE '';
  RAISE NOTICE '======== callers grouped by target function ========';
  FOR r IN
    WITH jobs AS (
      SELECT jobid, jobname, schedule, username AS owner,
             substring(command FROM 'functions/v1/([a-zA-Z0-9_-]+)') AS fn,
             substring(command FROM 'eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.') AS jwt_payload,
             (command ILIKE '%vault%' AND command ILIKE '%x-internal-secret%') AS vault_secret,
             (command ~ 'eyJ[A-Za-z0-9_-]{10,}' AND command ILIKE '%authorization%') AS bearer_jwt,
             COALESCE(substring(command FROM 'timeout_milliseconds\s*(?::=|=>)\s*([0-9]+)'), '5000') AS timeout_ms
      FROM cron.job
      WHERE active AND command ILIKE '%net.http%'
    ),
    decoded AS (
      SELECT j.*,
             CASE WHEN jwt_payload IS NULL THEN NULL ELSE
               convert_from(decode(
                 rpad(translate(jwt_payload, '-_', '+/'),
                      ((length(jwt_payload) + 3) / 4) * 4, '='), 'base64'), 'UTF8')::json
             END AS claims
      FROM jobs j
    )
    SELECT d.fn, d.jobid, d.jobname, d.schedule, d.owner, d.timeout_ms,
           CASE WHEN d.vault_secret AND d.bearer_jwt THEN 'vault+bearer'
                WHEN d.vault_secret THEN 'vault-secret'
                WHEN d.bearer_jwt THEN 'bearer-only'
                ELSE 'other' END AS auth,
           d.claims ->> 'role' AS jwt_role,
           to_timestamp((d.claims ->> 'iat')::bigint)::date AS jwt_issued,
           (SELECT count(*) FROM decoded t
             WHERE t.fn = d.fn AND t.jobid <> d.jobid AND t.vault_secret) AS vault_twins
    FROM decoded d
    WHERE d.fn IN (SELECT fn FROM decoded WHERE bearer_jwt)
    ORDER BY d.fn, d.jobid
  LOOP
    RAISE NOTICE '   % | [%] % % owner=% timeout=% auth=% role=% issued=% vault_twins=%',
      rpad(COALESCE(r.fn,'?'),30), r.jobid, rpad(left(r.jobname,34),34), rpad(r.schedule,14),
      r.owner, r.timeout_ms, r.auth, COALESCE(r.jwt_role,'-'), COALESCE(r.jwt_issued::text,'-'),
      r.vault_twins;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '======== distinct hardcoded tokens in use ========';
  FOR r IN
    WITH t AS (
      SELECT substring(command FROM 'eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.') AS p,
             count(*) OVER () AS _x, jobid, active
      FROM cron.job WHERE command ~ 'eyJ[A-Za-z0-9_-]{10,}'
    )
    SELECT convert_from(decode(rpad(translate(p,'-_','+/'), ((length(p)+3)/4)*4, '='),'base64'),'UTF8')::json ->> 'role' AS role,
           to_timestamp((convert_from(decode(rpad(translate(p,'-_','+/'), ((length(p)+3)/4)*4, '='),'base64'),'UTF8')::json ->> 'iat')::bigint)::date AS issued,
           count(*) AS jobs, count(*) FILTER (WHERE active) AS active_jobs
    FROM t WHERE p IS NOT NULL
    GROUP BY 1, 2 ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '   role=% issued=% : % jobs (% active)', r.role, r.issued, r.jobs, r.active_jobs;
  END LOOP;
END
$probe$;