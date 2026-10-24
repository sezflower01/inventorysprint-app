-- ITEM 4, read the result of the single July dry run. READ-ONLY.
DO $p$
DECLARE r record; v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  RAISE NOTICE '== every July report on file, newest first ==';
  FOR r IN
    SELECT to_char(captured_at,'MM-DD HH24:MI:SS') AS t, month, applied,
           COALESCE(report->>'ok','-') AS ok,
           COALESCE(report->>'error', report->>'refused', '-') AS problem,
           COALESCE(report->>'api_item_count','-') AS api_items,
           COALESCE(report->>'stored_count','-') AS stored,
           COALESCE(report->>'api_items_via_catchall','(absent)') AS catchall,
           COALESCE(report->>'api_catchall_types','-') AS catchall_types,
           COALESCE(report->>'pages','-') AS pages,
           COALESCE(report->>'paging_complete','-') AS paging,
           COALESCE(report->>'api_signed_total','-') AS api_total,
           COALESCE(report->>'stored_signed_total','-') AS stored_total
    FROM public.repull_reports
    WHERE left(month,7)='2026-07'
    ORDER BY captured_at DESC
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE '   [%] month % applied % | ok % | problem %', r.t, r.month, r.applied, r.ok, r.problem;
    RAISE NOTICE '        api items % vs stored % | pages % | paging complete %',
      r.api_items, r.stored, r.pages, r.paging;
    RAISE NOTICE '        VIA CATCH-ALL: %   types: %', r.catchall, left(r.catchall_types,60);
    RAISE NOTICE '        api signed total % | stored signed total %', r.api_total, r.stored_total;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   no July report at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the multisets from the newest July run ==';
  FOR r IN
    SELECT report->>'api_amount_multiset' AS api_ms,
           report->>'stored_amount_multiset' AS stored_ms,
           report->>'api_by_column' AS api_cols,
           report->>'stored_by_column' AS stored_cols
    FROM public.repull_reports
    WHERE left(month,7)='2026-07' ORDER BY captured_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '   API by column:    %', left(COALESCE(r.api_cols,'(absent)'),400);
    RAISE NOTICE '   STORED by column: %', left(COALESCE(r.stored_cols,'(absent)'),400);
    RAISE NOTICE '';
    RAISE NOTICE '   API amounts:    %', left(COALESCE(r.api_ms,'(absent)'),700);
    RAISE NOTICE '';
    RAISE NOTICE '   STORED amounts: %', left(COALESCE(r.stored_ms,'(absent)'),700);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== residual explanation for July (where the +10.48 comes from) ==';
  BEGIN
    PERFORM public.repull_residual_explain(v_uid,'2026-07-01');
  EXCEPTION WHEN others THEN
    RAISE NOTICE '   repull_residual_explain failed: %', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '== stage-2 status board: dry run and apply state per month ==';
  FOR r IN
    SELECT left(month,7) AS m,
           count(*) FILTER (WHERE applied = false) AS dry_runs,
           count(*) FILTER (WHERE applied = true)  AS applies,
           max(COALESCE(report->>'api_items_via_catchall','?')) AS worst_catchall,
           to_char(max(captured_at),'MM-DD HH24:MI') AS last_run
    FROM public.repull_reports
    WHERE month >= '2026-01' AND month < '2026-13'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % dry | % applied | catch-all % | last %',
      r.m, lpad(r.dry_runs::text,3), lpad(r.applies::text,3),
      lpad(r.worst_catchall,8), r.last_run;
  END LOOP;
END
$p$;
