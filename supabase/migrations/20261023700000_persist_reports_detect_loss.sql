-- Two problems found while polling June, both of which make the remaining
-- months unreliable if left alone.
--
-- 1. pg_net DROPS requests. Request 39338 is in neither net.http_request_queue
--    nor net._http_response, while the worker has moved on to 40518. It is
--    LOST, not slow -- so polling it forever was never going to resolve. Every
--    earlier "stall" that eventually appeared was genuinely queued; this one
--    was not, and the two are indistinguishable without checking both tables.
--
-- 2. net._http_response is PURGED. The rows at 40511+ all share one `created`
--    timestamp, which is batch cleanup. So a dry-run report read once may be
--    unreadable later -- and this exercise reads reports minutes or hours after
--    the fact, across eight months.
--
-- Fix both: persist every report the moment it is read, and classify a request
-- as lost when it is absent from both tables and the worker has passed it.

CREATE TABLE IF NOT EXISTS public.repull_reports (
  req_id      bigint PRIMARY KEY,
  month       text,
  applied     boolean,
  captured_at timestamptz NOT NULL DEFAULT now(),
  report      jsonb NOT NULL
);

COMMENT ON TABLE public.repull_reports IS
  'Durable copies of repull-month-adjustments reports. net._http_response is purged in batches, so a report read once can vanish; this table is what the exposure table is built from.';

/**
 * Read a request, PERSIST it, and print it. Returns:
 *   'done'    a response existed (or was already persisted)
 *   'queued'  still waiting in net.http_request_queue
 *   'lost'    absent from both tables and the worker has moved past it
 */
CREATE OR REPLACE FUNCTION public.repull_report2(p_req bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_raw text; v_b jsonb; v_max bigint;
BEGIN
  -- Already persisted? Use that, so purging cannot lose it.
  SELECT report INTO v_b FROM public.repull_reports WHERE req_id = p_req;

  IF v_b IS NULL THEN
    SELECT left(COALESCE(content,''),20000) INTO v_raw
    FROM net._http_response WHERE id = p_req;

    IF v_raw IS NULL OR v_raw = '' THEN
      IF EXISTS (SELECT 1 FROM net.http_request_queue WHERE id = p_req) THEN
        RAISE NOTICE '   % QUEUED (depth %)', p_req,
          (SELECT count(*) FROM net.http_request_queue);
        RETURN 'queued';
      END IF;
      SELECT max(id) INTO v_max FROM net._http_response;
      IF COALESCE(v_max,0) > p_req THEN
        RAISE NOTICE '   % LOST -- not queued, no response, worker is at %. Re-fire it.',
          p_req, v_max;
        RETURN 'lost';
      END IF;
      RAISE NOTICE '   % in flight', p_req;
      RETURN 'queued';
    END IF;

    v_b := v_raw::jsonb;
    INSERT INTO public.repull_reports (req_id, month, applied, report)
    VALUES (p_req, v_b->>'month', COALESCE((v_b->>'wrote')::boolean,false), v_b)
    ON CONFLICT (req_id) DO NOTHING;
  END IF;

  IF v_b ? 'error' THEN
    RAISE NOTICE '   % ERROR: %', p_req, left(v_b->>'error',200);
    RETURN 'done';
  END IF;
  IF v_b ? 'aborted' THEN
    RAISE NOTICE '   % ABORTED: %', p_req, v_b->>'aborted';
    RETURN 'done';
  END IF;

  RAISE NOTICE '   % | wrote % | pages % | %ms',
    v_b->>'month', v_b->>'wrote', v_b->>'pages', v_b->>'elapsed_ms';
  RAISE NOTICE '      API % items -> % rows | signed $% | clawback $%',
    v_b->>'api_items', v_b->>'api_rows_after_dedupe',
    v_b->>'api_signed_total', v_b->>'api_clawback_total';
  RAISE NOTICE '      STORED % rows | signed $% | clawback $%',
    v_b->>'stored_rows', v_b->>'stored_signed_total', v_b->>'stored_clawback_total';
  RAISE NOTICE '      predicted P&L change $% | residual vs clawback $%',
    round((v_b->>'api_signed_total')::numeric - (v_b->>'stored_signed_total')::numeric, 2),
    round(((v_b->>'api_signed_total')::numeric - (v_b->>'stored_signed_total')::numeric)
          - (v_b->>'api_clawback_total')::numeric, 2);
  IF v_b ? 'applied' THEN RAISE NOTICE '      applied: %', v_b->'applied'; END IF;
  RETURN 'done';
END
$fn$;

GRANT EXECUTE ON FUNCTION public.repull_report2(bigint) TO service_role;

-- Backfill the reports already read this session, while they are still there.
DO $p$
DECLARE v_id bigint; v_s text;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[38095::bigint,39326,38097,38109,37912,37975] LOOP
    v_s := public.repull_report2(v_id);
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '== persisted reports ==';
  FOR v_id IN SELECT req_id FROM public.repull_reports ORDER BY req_id LOOP
    RAISE NOTICE '   %', v_id;
  END LOOP;
END
$p$;

-- June was lost: re-fire it, alone.
DO $p$
DECLARE v_uid uuid; v_req bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '';
  RAISE NOTICE '== DRY RUN: June, re-fired after pg_net dropped 39338 ==';
  BEGIN v_req := public.repull_fire(v_uid,'2026-06-01',false);
  EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
END
$p$;
