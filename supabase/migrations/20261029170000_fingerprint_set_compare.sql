-- Fingerprint checking as a SET comparison, not a fixed list of types.
--
-- WHY. The May verification checked "the four non-adjustment fingerprints" and
-- June has only three -- refund, service_fee, shipment, no liquidation. A check
-- hardcoded to four types would either fail on June for no reason or, worse,
-- silently pass while comparing nothing. And neither form notices the thing
-- that would matter most: a type APPEARING or DISAPPEARING across the apply.
-- A re-pull that invented a liquidation row, or dropped every refund row, would
-- leave each surviving type's fingerprint intact and sail through.
--
-- So the comparison is over the UNION of types present before and after, and
-- any asymmetry is a failure in its own right.
--
-- The snapshot is a real table, not a temp one, because before and after are
-- necessarily in different transactions -- the same reason the May backup and
-- its diff had to be split into separate migrations.

CREATE TABLE IF NOT EXISTS public.fec_fingerprint_snapshot (
  snap_month  date        NOT NULL,
  phase       text        NOT NULL CHECK (phase IN ('before','after')),
  event_type  text        NOT NULL,
  rows        integer     NOT NULL,
  fingerprint text        NOT NULL,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snap_month, phase, event_type)
);

ALTER TABLE public.fec_fingerprint_snapshot ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.fec_fingerprint_snapshot IS
  'Non-adjustment event-type fingerprints captured either side of a stage-2 adjustment re-pull. Written by fec_snapshot_fingerprints, read by fec_compare_fingerprints. Survives across transactions on purpose: before and after cannot share one.';

CREATE OR REPLACE FUNCTION public.fec_snapshot_fingerprints(
  p_uid uuid, p_month date, p_phase text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_n integer;
BEGIN
  IF p_phase NOT IN ('before','after') THEN
    RAISE EXCEPTION 'phase must be before or after, got %', p_phase;
  END IF;

  DELETE FROM public.fec_fingerprint_snapshot
   WHERE snap_month = p_month AND phase = p_phase;

  INSERT INTO public.fec_fingerprint_snapshot (snap_month, phase, event_type, rows, fingerprint)
  SELECT p_month, p_phase, f.event_type, f.rows, f.fingerprint
  FROM public.fec_other_types_fingerprint(p_uid, p_month) f;

  SELECT count(*) INTO v_n FROM public.fec_fingerprint_snapshot
   WHERE snap_month = p_month AND phase = p_phase;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.fec_snapshot_fingerprints(uuid, date, text) IS
  'Capture every non-adjustment event-type fingerprint for a month into fec_fingerprint_snapshot under the given phase. Returns the number of types captured -- which is itself part of the evidence, since the type SET is what the comparison guards.';

CREATE OR REPLACE FUNCTION public.fec_compare_fingerprints(p_month date)
RETURNS TABLE (event_type text, rows_before integer, rows_after integer,
               fp_before text, fp_after text, verdict text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(b.event_type, a.event_type) AS event_type,
         b.rows, a.rows, b.fingerprint, a.fingerprint,
         CASE
           WHEN b.event_type IS NULL THEN 'APPEARED'
           WHEN a.event_type IS NULL THEN 'DISAPPEARED'
           WHEN b.fingerprint = a.fingerprint AND b.rows = a.rows THEN 'identical'
           ELSE 'CHANGED'
         END AS verdict
  FROM (SELECT * FROM public.fec_fingerprint_snapshot
         WHERE snap_month = p_month AND phase = 'before') b
  FULL OUTER JOIN
       (SELECT * FROM public.fec_fingerprint_snapshot
         WHERE snap_month = p_month AND phase = 'after') a
    ON a.event_type = b.event_type
  ORDER BY 1;
$fn$;

COMMENT ON FUNCTION public.fec_compare_fingerprints(date) IS
  'Full outer join of the before and after fingerprint snapshots for a month. Verdict is identical, CHANGED, APPEARED or DISAPPEARED. Only identical passes: an APPEARED or DISAPPEARED type is a failure even though every surviving type would still match, which is the case a fixed four-type check cannot see.';

-- Self-test. The logic is only trustworthy if the asymmetric verdicts actually
-- fire, so all four are exercised against a month id that holds no real data.
DO $p$
DECLARE r record; v_seen text := '';
BEGIN
  DELETE FROM public.fec_fingerprint_snapshot WHERE snap_month = '1900-01-01';

  INSERT INTO public.fec_fingerprint_snapshot (snap_month, phase, event_type, rows, fingerprint) VALUES
    ('1900-01-01','before','steady',  10,'aaa'),
    ('1900-01-01','after', 'steady',  10,'aaa'),
    ('1900-01-01','before','moved',   10,'aaa'),
    ('1900-01-01','after', 'moved',   10,'bbb'),
    ('1900-01-01','before','vanished', 5,'ccc'),
    ('1900-01-01','after', 'arrived',  7,'ddd');

  RAISE NOTICE '== self-test of fec_compare_fingerprints ==';
  FOR r IN SELECT * FROM public.fec_compare_fingerprints('1900-01-01'::date)
  LOOP
    RAISE NOTICE '   % -> %', rpad(r.event_type,10), r.verdict;
    v_seen := v_seen || r.verdict || ' ';
  END LOOP;

  IF v_seen <> 'APPEARED CHANGED identical DISAPPEARED ' THEN
    RAISE EXCEPTION 'self-test produced "%" -- comparison logic is wrong', v_seen;
  END IF;
  RAISE NOTICE '   all four verdicts fire correctly';

  DELETE FROM public.fec_fingerprint_snapshot WHERE snap_month = '1900-01-01';
END
$p$;
