DO $p$
DECLARE r record;
BEGIN
  RAISE NOTICE '== rows captured today, exactly as stored ==';
  FOR r IN
    SELECT to_char(captured_at,'HH24:MI:SS') AS t,
           quote_literal(month) AS month_raw, applied,
           COALESCE(report->>'pages','-') AS pages,
           COALESCE(report->>'rate_limit_hits','-') AS rl,
           COALESCE(report->>'api_clawback_total','-') AS claw,
           (report ? 'api_signed_total') AS has_total
    FROM public.repull_reports WHERE captured_at >= current_date
    ORDER BY captured_at
  LOOP
    RAISE NOTICE '   % | month % | applied % | % pages | % hits | claw % | has_total %',
      r.t, r.month_raw, r.applied, r.pages, r.rl, r.claw, r.has_total;
  END LOOP;
END
$p$;
