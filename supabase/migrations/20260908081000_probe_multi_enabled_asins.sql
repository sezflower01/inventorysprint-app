-- PROBE (read-only): after keying the dedup on (asin, channel), which ASINs now
-- hold more than one ENABLED US assignment?
--
-- The answer should be FBA/FBM pairs and nothing else. Two enabled SKUs on one
-- ASIN in the SAME channel would mean the ghost protection stopped working --
-- the B004IH1WSK/BR failure this pass was written for.
--
-- Creates nothing, changes nothing.

DO $probe$
DECLARE r record; v_uid uuid; v_pairs int := 0; v_same int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '======== ASINs with 2+ ENABLED US assignments ========';
  FOR r IN
    WITH en AS (
      SELECT a.asin, a.sku,
             COALESCE(i.source,'(no inv row)') AS source,
             COALESCE(i.available,0) AS av,
             COALESCE(i.reserved,0) + COALESCE(i.inbound,0) AS fba_units,
             i.fnsku,
             CASE
               WHEN i.sku IS NULL THEN 'unknown'
               WHEN i.source = 'amazon_sync_fbm'
                    AND COALESCE(i.reserved,0) + COALESCE(i.inbound,0) = 0 THEN 'FBM'
               WHEN i.fnsku IS NOT NULL
                    OR COALESCE(i.reserved,0) + COALESCE(i.inbound,0) > 0 THEN 'FBA'
               WHEN i.source = 'amazon_sync_fbm' THEN 'FBM'
               ELSE 'FBA'
             END AS channel
      FROM public.repricer_assignments a
      LEFT JOIN public.inventory i ON i.user_id = a.user_id AND i.sku = a.sku
      WHERE a.user_id = v_uid AND a.marketplace = 'US' AND a.is_enabled
    )
    SELECT asin,
           count(*) AS n,
           count(DISTINCT channel) AS channels,
           string_agg(sku || ' (' || channel || ', av=' || av || ')', '  |  ' ORDER BY sku) AS detail
    FROM en GROUP BY asin HAVING count(*) > 1
    ORDER BY count(DISTINCT channel) DESC, count(*) DESC
  LOOP
    IF r.channels > 1 THEN v_pairs := v_pairs + 1; ELSE v_same := v_same + 1; END IF;
    RAISE NOTICE '   %  % enabled, % distinct channel(s)', r.asin, r.n, r.channels;
    RAISE NOTICE '        %', left(r.detail, 170);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   % ASIN(s) are legitimate cross-channel pairs', v_pairs;
  RAISE NOTICE '   % ASIN(s) hold 2+ enabled SKUs in the SAME channel', v_same;
  IF v_same > 0 THEN
    RAISE NOTICE '   -> same-channel duplicates should NOT survive; investigate';
  ELSE
    RAISE NOTICE '   -> ghost protection intact: no same-channel duplicates enabled';
  END IF;
END
$probe$;
