-- Running exposure table, computed in SQL. Doing this arithmetic by hand is
-- how the earlier $34.80 phantom gap appeared.
DO $p$
DECLARE r record; v_claw numeric; v_pred numeric; v_n int;
BEGIN
  CREATE TEMP TABLE exposure (
    mon text, status text, api_rows int, stored_rows int,
    clawback numeric, predicted numeric
  ) ON COMMIT DROP;

  INSERT INTO exposure VALUES
    ('2026-01','APPLIED',      148, 92, -230.38, -231.58),
    ('2026-02','dry run done', 144,109, -227.95, -227.82),
    ('2026-03','dry run done', 113, 83, -182.54, -181.95),
    ('2026-04','dry run done', 116, 78, -193.44, -191.07),
    ('2026-05','dry run done', 103, 75, -187.96, -187.96),
    ('2026-06','in flight',   NULL,NULL,    NULL,    NULL),
    ('2026-07','not yet run', NULL,NULL,    NULL,    NULL),
    ('2026-08','API measured',NULL,NULL, -132.08,    NULL),
    ('2026-09','API measured',NULL,NULL, -213.20,    NULL),
    ('2026-10','APPLIED',      134,123, -134.93, -134.93);

  RAISE NOTICE '== 2026 ADJUSTMENT RE-PULL: exposure so far ==';
  RAISE NOTICE '   month   | status        | API | stored | clawback | predicted | residual';
  FOR r IN
    SELECT mon, status, api_rows, stored_rows, clawback, predicted,
           CASE WHEN predicted IS NOT NULL AND clawback IS NOT NULL
                THEN round(predicted - clawback, 2) END AS residual
    FROM exposure ORDER BY mon
  LOOP
    RAISE NOTICE '   % | % | % | % | % | % | %',
      r.mon, rpad(r.status,13),
      lpad(COALESCE(r.api_rows::text,'-'),4), lpad(COALESCE(r.stored_rows::text,'-'),6),
      lpad(COALESCE(r.clawback::text,'-'),9), lpad(COALESCE(r.predicted::text,'-'),10),
      lpad(COALESCE(r.residual::text,'-'),8);
  END LOOP;

  SELECT round(sum(clawback),2), count(clawback) INTO v_claw, v_n FROM exposure;
  SELECT round(sum(predicted),2) INTO v_pred FROM exposure;
  RAISE NOTICE '   ------------------------------------------------------------';
  RAISE NOTICE '   clawback total across the % months measured : $%', v_n, v_claw;
  RAISE NOTICE '   predicted P&L change where known            : $%', v_pred;

  RAISE NOTICE '';
  RAISE NOTICE '== residuals needing a multiset explanation before apply ==';
  FOR r IN
    SELECT mon, round(predicted - clawback,2) AS resid FROM exposure
    WHERE predicted IS NOT NULL AND clawback IS NOT NULL
      AND round(predicted - clawback,2) <> 0
    ORDER BY mon
  LOOP RAISE NOTICE '   % | %', r.mon, r.resid; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   January''s was -1.20 and resolved to two Amazon restatements.';
  RAISE NOTICE '   Feb +0.13, Mar +0.59 and Apr +2.37 are POSITIVE, i.e. restated';
  RAISE NOTICE '   UPWARD, the opposite direction -- which is why they need the';
  RAISE NOTICE '   same pairing done rather than assumed. May needs none: its';
  RAISE NOTICE '   predicted change equals its clawback to the cent.';
END
$p$;
