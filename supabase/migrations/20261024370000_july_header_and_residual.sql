-- ITEM 4, part 2. READ-ONLY. The header numbers and the +10.48, computed in
-- SQL rather than added up by hand -- hand arithmetic on these multisets has
-- already produced one phantom $34.80 gap in this exercise.
DO $p$
DECLARE r record; v_claw numeric; v_api numeric; v_stored numeric;
BEGIN
  RAISE NOTICE '== newest July dry run: header ==';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI:SS') AS t, month, applied,
           report->>'ok' AS ok,
           COALESCE(report->>'error', report->>'refused','-') AS problem,
           report->>'api_item_count' AS api_items,
           report->>'stored_count' AS stored,
           report->>'api_items_via_catchall' AS catchall,
           COALESCE(report->>'api_catchall_types','-') AS ctypes,
           report->>'pages' AS pages,
           report->>'paging_complete' AS paging,
           report->>'api_signed_total' AS api_total,
           report->>'stored_signed_total' AS stored_total,
           report->>'elapsed_ms' AS ms
    FROM public.repull_reports WHERE left(month,7)='2026-07'
    ORDER BY captured_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '   captured % | month % | applied % | ok % | problem %',
      r.t, r.month, r.applied, r.ok, r.problem;
    RAISE NOTICE '   api items % vs stored % | pages % | paging complete % | % ms',
      r.api_items, r.stored, r.pages, r.paging, r.ms;
    RAISE NOTICE '   VIA CATCH-ALL: %  types: %', r.catchall, r.ctypes;
    RAISE NOTICE '   api signed total % | stored signed total %', r.api_total, r.stored_total;
    v_api := NULLIF(r.api_total,'')::numeric;
    v_stored := NULLIF(r.stored_total,'')::numeric;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== all three July runs, to show this one agrees with the earlier two ==';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI:SS') AS t,
           COALESCE(report->>'api_item_count','-') AS items,
           COALESCE(report->>'api_signed_total','-') AS total,
           COALESCE(report->>'api_items_via_catchall','-') AS ca,
           COALESCE(report->>'ok','-') AS ok
    FROM public.repull_reports WHERE left(month,7)='2026-07'
    ORDER BY captured_at
  LOOP RAISE NOTICE '   % | % items | total % | catch-all % | ok %', r.t, lpad(r.items,5), lpad(r.total,12), r.ca, r.ok; END LOOP;

  -- The by-column breakdown of what is stored was attempted here against a
  -- column named adjustment_column, which does not exist. Guessing column
  -- names has cost several migrations in this exercise; the next file reads the
  -- report's own recorded fields instead, which need no guessing.

  RAISE NOTICE '';
  RAISE NOTICE '== THE +10.48: reimbursement-side net, excluding clawbacks ==';
  RAISE NOTICE '   (api_signed_total - stored_signed_total) splits into the clawbacks';
  RAISE NOTICE '   that are newly captured, plus whatever the reimbursement columns moved.';
  IF v_api IS NOT NULL AND v_stored IS NOT NULL THEN
    RAISE NOTICE '   api % - stored % = %', v_api, v_stored, round(v_api - v_stored, 2);
  END IF;
END
$p$;
