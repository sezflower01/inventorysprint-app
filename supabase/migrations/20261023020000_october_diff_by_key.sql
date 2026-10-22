-- READ-ONLY. Item 1: diff October's backup against the current rows BY UPSERT
-- KEY (user_id, event_type, event_date, amazon_order_id, asin).
--
-- The question is specifically whether any PREVIOUSLY STORED row changed value.
-- A newly posted event is expected -- October is still open, which is why 17
-- columns moved in aggregate -- but an existing row changing its money is not,
-- and a key disappearing would be data loss.
--
-- Money comparison is done by stripping the non-money columns out of
-- to_jsonb(row) and comparing what remains, rather than naming 40 columns:
-- that way a column added later is compared automatically instead of being
-- silently skipped.
DO $p$
DECLARE
  v_uid uuid; r record;
  -- Columns that are NOT money, or that may legitimately differ on a re-sync.
  v_ignore text[] := ARRAY[
    'id','created_at','updated_at',          -- row identity and timestamps
    'raw_event','adjustment_type','seller_sku','quantity','posted_at', -- new provenance
    'sync_trace_id','source',                -- sync bookkeeping
    'marketplace','marketplace_id'           -- re-attributed each sync
  ];
  v_unchanged bigint; v_changed bigint; v_new bigint; v_removed bigint;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE oct_diff ON COMMIT DROP AS
  WITH b AS (
    SELECT user_id, event_type, event_date, amazon_order_id, asin,
           to_jsonb(x) - v_ignore AS money
    FROM public.fec_october_backup_20261022 x
    WHERE x.user_id = v_uid
  ), l AS (
    SELECT user_id, event_type, event_date, amazon_order_id, asin,
           to_jsonb(y) - v_ignore AS money
    FROM public.financial_events_cache y
    WHERE y.user_id = v_uid AND y.event_date >= '2026-10-01' AND y.event_date <= '2026-10-31'
  )
  SELECT
    COALESCE(b.event_type, l.event_type) AS event_type,
    COALESCE(b.event_date, l.event_date) AS event_date,
    COALESCE(b.amazon_order_id, l.amazon_order_id) AS amazon_order_id,
    COALESCE(b.asin, l.asin) AS asin,
    b.money AS before_money,
    l.money AS after_money,
    CASE
      WHEN b.money IS NULL THEN 'new'
      WHEN l.money IS NULL THEN 'REMOVED'
      WHEN b.money = l.money THEN 'unchanged'
      ELSE 'CHANGED'
    END AS verdict
  FROM b FULL OUTER JOIN l
    ON  b.user_id = l.user_id
    AND b.event_type = l.event_type
    AND b.event_date = l.event_date
    AND b.amazon_order_id = l.amazon_order_id
    AND b.asin = l.asin;

  SELECT count(*) FILTER (WHERE verdict='unchanged'),
         count(*) FILTER (WHERE verdict='CHANGED'),
         count(*) FILTER (WHERE verdict='new'),
         count(*) FILTER (WHERE verdict='REMOVED')
    INTO v_unchanged, v_changed, v_new, v_removed
  FROM oct_diff;

  RAISE NOTICE '== OCTOBER DIFF BY UPSERT KEY ==';
  RAISE NOTICE '   unchanged : %', v_unchanged;
  RAISE NOTICE '   CHANGED   : %   <<< a previously stored row moved', v_changed;
  RAISE NOTICE '   new       : %   (expected: events posted since the backup)', v_new;
  RAISE NOTICE '   REMOVED   : %   <<< a key that no longer exists', v_removed;

  RAISE NOTICE '';
  RAISE NOTICE '== new rows, by event_type ==';
  FOR r IN
    SELECT event_type, count(*) AS rows, min(event_date) AS first_d, max(event_date) AS last_d
    FROM oct_diff WHERE verdict='new' GROUP BY 1 ORDER BY rows DESC
  LOOP
    RAISE NOTICE '   % | % rows | % .. %', rpad(r.event_type,14), lpad(r.rows::text,5), r.first_d, r.last_d;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== are the new adjustment rows the clawbacks? ==';
  FOR r IN
    SELECT d.event_date, d.amazon_order_id,
           COALESCE(f.adjustment_type,'-') AS atype,
           round(COALESCE(f.compensated_clawback,0),2) AS clawback
    FROM oct_diff d
    JOIN public.financial_events_cache f
      ON f.user_id = v_uid AND f.event_type = d.event_type
     AND f.event_date = d.event_date AND f.amazon_order_id = d.amazon_order_id
     AND f.asin = d.asin
    WHERE d.verdict='new' AND d.event_type='adjustment'
    ORDER BY d.event_date
  LOOP
    RAISE NOTICE '   % | % | % | clawback %',
      r.event_date, rpad(left(r.amazon_order_id,24),24), rpad(r.atype,30), r.clawback;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no new adjustment rows)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== CHANGED rows: which columns moved, old -> new ==';
  FOR r IN
    SELECT d.event_type, d.event_date, d.amazon_order_id, d.asin,
           k.key AS col,
           d.before_money->>k.key AS old_v,
           d.after_money->>k.key AS new_v
    FROM oct_diff d
    CROSS JOIN LATERAL jsonb_object_keys(d.after_money) AS k(key)
    WHERE d.verdict='CHANGED'
      AND COALESCE(d.before_money->>k.key,'') IS DISTINCT FROM COALESCE(d.after_money->>k.key,'')
    ORDER BY d.event_date, d.amazon_order_id, k.key
    LIMIT 60
  LOOP
    RAISE NOTICE '   % % % | % : % -> %',
      r.event_type, r.event_date, left(COALESCE(r.amazon_order_id,'-'),22),
      rpad(r.col,28), COALESCE(r.old_v,'null'), COALESCE(r.new_v,'null');
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE '   NONE. No previously stored row changed a single money value.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== REMOVED rows (data loss, if any) ==';
  FOR r IN
    SELECT event_type, event_date, amazon_order_id, asin FROM oct_diff
    WHERE verdict='REMOVED' ORDER BY event_date LIMIT 30
  LOOP
    RAISE NOTICE '   % | % | % | %', r.event_type, r.event_date,
      left(COALESCE(r.amazon_order_id,'-'),30), COALESCE(r.asin,'-');
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   NONE. Every backed-up key still exists.'; END IF;
END
$p$;
