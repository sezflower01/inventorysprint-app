-- READ ONLY. Nothing here writes, updates or deletes.
--
-- The operator confirmed the second account is their OWN, used by mistake from
-- 2026-04-06 to 2026-07-01, and that data written under it was later moved
-- across by hand. That reframes the question entirely.
--
-- The earlier probes asked "what did the second account RECEIVE from the main
-- one?". That was the right question while the account might have belonged to
-- someone else. It is the wrong question now. A hand transfer can be
-- incomplete, or can duplicate, and the risk that matters runs the OTHER way:
--
--   Q1  Does anything exist ONLY under the second account? Those rows would be
--       destroyed by a cleanup, and are missing from the P&L today.
--   Q2  Did the transfer duplicate anything under the main account? Duplicate
--       sales rows overstate revenue and COGS for Apr-Jul 2026.
--   Q3  Do the Apr-Jul months look whole under the main account?
--
-- Q1 must be answered before ANY deletion. The archive written by
-- 20261112160000 covers inventory, user_brands and inventory_history only, so
-- a row living alone in some fourth table is NOT protected by it.
--
-- Written generically over information_schema rather than against a list of
-- table names: this repo has 891 migrations, and a hand-written list is
-- precisely how a table gets missed.

DO $p$
DECLARE
  v_other uuid;
  v_owner uuid;
  r record;
  n_other bigint;
  n_owner bigint;
  v_sql text;
  v_only_in_other int := 0;
  v_tables_scanned int := 0;
BEGIN
  SELECT id INTO v_other FROM auth.users WHERE id::text LIKE 'e697c7c7%';
  SELECT id INTO v_owner FROM auth.users WHERE id::text LIKE '020dd71f%';
  IF v_other IS NULL OR v_owner IS NULL THEN
    RAISE NOTICE 'one of the two accounts was not found -- aborting';
    RETURN;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- Q1. EVERY public table carrying a user_id: how many rows does each hold?
  -- ════════════════════════════════════════════════════════════════════════
  RAISE NOTICE '=== Q1: tables where the SECOND account still holds rows ===';
  RAISE NOTICE '(only tables with at least one row under it are printed)';
  RAISE NOTICE ' ';
  RAISE NOTICE '%  %  %  %', rpad('table', 38), lpad('second', 8), lpad('main', 10), 'verdict';

  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'user_id'
      AND c.data_type = 'uuid'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name NOT LIKE 'archive_copied_%'
    ORDER BY c.table_name
  LOOP
    v_tables_scanned := v_tables_scanned + 1;
    v_sql := format('SELECT count(*) FROM public.%I WHERE user_id = $1', r.table_name);
    BEGIN
      EXECUTE v_sql INTO n_other USING v_other;
      EXECUTE v_sql INTO n_owner USING v_owner;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '%  (could not read: %)', rpad(r.table_name, 38), SQLERRM;
      CONTINUE;
    END;

    IF n_other > 0 THEN
      IF n_owner = 0 THEN
        v_only_in_other := v_only_in_other + 1;
        RAISE NOTICE '%  %  %  *** ONLY IN SECOND ACCOUNT ***',
          rpad(r.table_name, 38), lpad(n_other::text, 8), lpad(n_owner::text, 10);
      ELSE
        RAISE NOTICE '%  %  %  both',
          rpad(r.table_name, 38), lpad(n_other::text, 8), lpad(n_owner::text, 10);
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE 'scanned % tables carrying a uuid user_id', v_tables_scanned;
  RAISE NOTICE 'tables where ONLY the second account has rows: %', v_only_in_other;
  IF v_only_in_other = 0 THEN
    RAISE NOTICE '-> no table is exclusive to the second account.';
  ELSE
    RAISE NOTICE '-> the starred tables above are NOT covered by the archive.';
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- Q1b. The sales tables by name -- the ones the hand transfer was about.
  -- ════════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== Q1b: did any SALES or COST data stay behind? ===';
  FOR r IN
    SELECT t AS tbl FROM unnest(ARRAY[
      'sales_orders', 'financial_events_cache', 'settlement_line_items',
      'created_listings', 'asin_cog_on_record', 'inventory_cog_lots',
      'shipment_builder_drafts', 'supplier_links', 'repricer_assignments'
    ]) t
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = 'user_id') THEN
      v_sql := format('SELECT count(*) FROM public.%I WHERE user_id = $1', r.tbl);
      EXECUTE v_sql INTO n_other USING v_other;
      EXECUTE v_sql INTO n_owner USING v_owner;
      RAISE NOTICE '%  second %  main %  %',
        rpad(r.tbl, 28), lpad(n_other::text, 7), lpad(n_owner::text, 9),
        CASE WHEN n_other = 0 THEN 'clean -- nothing left behind'
             ELSE '*** ' || n_other || ' ROWS STILL UNDER THE SECOND ACCOUNT ***' END;
    ELSE
      RAISE NOTICE '%  (no user_id column, or table absent)', rpad(r.tbl, 28);
    END IF;
  END LOOP;

  -- ════════════════════════════════════════════════════════════════════════
  -- Q2. Did the hand transfer DUPLICATE anything under the main account?
  --
  -- Care is needed. A repeated (order_id, asin) is NOT automatically a
  -- duplicate: a multi-shipment order legitimately produces several rows for
  -- the same ASIN -- the documented same-ASIN OrderItem behaviour. So two
  -- different things are reported, and they must not be confused:
  --
  --   * EXACT duplicates -- same order, asin, sku, quantity, price AND date.
  --     A hand transfer re-inserting a row looks exactly like this.
  --   * repeated (order_id, asin) with differing content -- expected, shown
  --     separately so it cannot be mistaken for the first.
  -- ════════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== Q2: duplicates under the MAIN account ===';

  FOR r IN
    SELECT count(*) AS groups, COALESCE(sum(n - 1), 0) AS surplus
    FROM (
      SELECT count(*) AS n
      FROM public.sales_orders
      WHERE user_id = v_owner
      GROUP BY order_id, asin, COALESCE(sku, ''), quantity, sold_price, order_date
      HAVING count(*) > 1
    ) d
  LOOP
    RAISE NOTICE 'EXACT duplicate groups: %   surplus rows: %   -> %',
      r.groups, r.surplus,
      CASE WHEN r.groups = 0 THEN 'none; the transfer did not re-insert rows'
           ELSE '*** revenue and COGS are overstated -- investigate ***' END;
  END LOOP;

  FOR r IN
    SELECT count(*) AS groups
    FROM (
      SELECT order_id, asin FROM public.sales_orders
      WHERE user_id = v_owner
      GROUP BY order_id, asin HAVING count(*) > 1
    ) d
  LOOP
    RAISE NOTICE 'repeated (order_id, asin): % groups -- EXPECTED for multi-shipment orders, not duplicates', r.groups;
  END LOOP;

  FOR r IN
    SELECT count(*) AS groups, COALESCE(sum(n - 1), 0) AS surplus
    FROM (
      SELECT count(*) AS n
      FROM public.sales_orders
      WHERE user_id = v_owner
        AND order_date >= '2026-04-01' AND order_date < '2026-08-01'
      GROUP BY order_id, asin, COALESCE(sku, ''), quantity, sold_price, order_date
      HAVING count(*) > 1
    ) d
  LOOP
    RAISE NOTICE 'EXACT duplicates INSIDE the overlap window Apr-Jul 2026: % groups, % surplus rows',
      r.groups, r.surplus;
  END LOOP;

  -- ════════════════════════════════════════════════════════════════════════
  -- Q3. Are the overlap months whole under the main account?
  --
  -- order_date is the Pacific-local field and is populated on every row, so it
  -- is the right one here; purchase_timestamp_utc is NULL on roughly 10%. The
  -- count of distinct days with sales is the useful signal: a real month has
  -- sales on nearly every day, and a partial transfer leaves gaps.
  -- ════════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== Q3: monthly sales under the MAIN account, Feb-Sep 2026 ===';
  RAISE NOTICE '%  %  %  %  %', rpad('month', 9), lpad('orders', 7), lpad('units', 7),
    lpad('revenue', 12), lpad('days', 6);
  FOR r IN
    SELECT to_char(order_date, 'YYYY-MM') AS ym,
           count(DISTINCT order_id) AS orders,
           sum(quantity) AS units,
           round(sum(total_sale_amount)::numeric, 2) AS revenue,
           count(DISTINCT order_date::date) AS active_days
    FROM public.sales_orders
    WHERE user_id = v_owner
      AND order_date >= '2026-02-01' AND order_date < '2026-10-01'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '%  %  %  %  %',
      rpad(r.ym, 9), lpad(r.orders::text, 7), lpad(COALESCE(r.units, 0)::text, 7),
      lpad(COALESCE(r.revenue, 0)::text, 12), lpad(r.active_days::text, 6);
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE 'A month with far fewer active days than its neighbours is the shape';
  RAISE NOTICE 'of an incomplete transfer. A roughly flat day count is not.';

  -- ════════════════════════════════════════════════════════════════════════
  -- Q4. What did the second account actually DO?
  -- ════════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== Q4: activity recorded under the second account ===';
  -- module_usage keys on `path`, not `module`, and carries a column literally
  -- named `count` -- so the aggregate is spelled out rather than bare count().
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'module_usage') THEN
    FOR r IN
      SELECT path::text AS m, sum(mu.count) AS n,
             min(created_at)::date AS first_used, max(last_used)::date AS last_at
      FROM public.module_usage mu WHERE user_id = v_other
      GROUP BY 1 ORDER BY 2 DESC LIMIT 15
    LOOP
      RAISE NOTICE 'page % opened %x  (% .. %)',
        rpad(r.m, 28), lpad(r.n::text, 6), r.first_used, r.last_at;
    END LOOP;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- Q5. THE LIVE QUESTION.
  --
  -- The identity probe showed auto_activate_runs rows under the second account
  -- dated as recently as today -- months after that account last signed in.
  -- Rows do not appear under a dormant account on their own, so either a
  -- scheduled job is still running under that user_id, or the reading was
  -- wrong. This settles it, and it matters more than the cleanup does: if a
  -- job is still writing there, deleting rows today just means they come back.
  -- ════════════════════════════════════════════════════════════════════════
  RAISE NOTICE ' ';
  RAISE NOTICE '=== Q5: is anything STILL writing under the second account? ===';
  FOR r IN
    SELECT 'second' AS who, count(*) AS n, min(created_at)::date AS first_run,
           max(created_at)::date AS last_run, count(DISTINCT created_at::date) AS days
    FROM public.auto_activate_runs WHERE user_id = v_other
    UNION ALL
    SELECT 'main', count(*), min(created_at)::date, max(created_at)::date,
           count(DISTINCT created_at::date)
    FROM public.auto_activate_runs WHERE user_id = v_owner
  LOOP
    RAISE NOTICE 'auto_activate_runs [%] % runs over % days (% .. %)',
      rpad(r.who, 7), lpad(r.n::text, 7), lpad(r.days::text, 4), r.first_run, r.last_run;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE 'last 7 days, by day and account:';
  FOR r IN
    SELECT created_at::date AS d,
           count(*) FILTER (WHERE user_id = v_other) AS second_n,
           count(*) FILTER (WHERE user_id = v_owner) AS main_n
    FROM public.auto_activate_runs
    WHERE created_at >= now() - interval '7 days'
      AND user_id IN (v_other, v_owner)
    GROUP BY 1 ORDER BY 1 DESC
  LOOP
    RAISE NOTICE '  %   second %   main %',
      r.d, lpad(r.second_n::text, 6), lpad(r.main_n::text, 6);
  END LOOP;

  -- What do those runs actually DO? A run that finds no candidates is noise;
  -- one that activates or re-enables something is changing live repricer state.
  FOR r IN
    SELECT count(*) AS runs,
           COALESCE(sum(candidates), 0) AS cand,
           COALESCE(sum(activated), 0) AS act,
           COALESCE(sum(re_enabled), 0) AS reen,
           count(*) FILTER (WHERE error IS NOT NULL) AS errored
    FROM public.auto_activate_runs
    WHERE user_id = v_other AND created_at >= now() - interval '30 days'
  LOOP
    RAISE NOTICE ' ';
    RAISE NOTICE 'second account, last 30 days: % runs, % candidates, % activated, % re-enabled, % errored',
      r.runs, r.cand, r.act, r.reen, r.errored;
    RAISE NOTICE '-> %', CASE WHEN r.act + r.reen > 0
      THEN '*** still CHANGING repricer state under that account ***'
      ELSE 'runs are firing but changing nothing (no candidates to act on)' END;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE 'READ ONLY -- nothing was written, updated or deleted.';
END $p$;
