-- READ-ONLY. Do InventoryLab's reimbursements for 2026-10-18..21 match ours?
--
-- financial_events_cache is a WIDE per-category table -- no generic `amount`
-- column -- and the reimbursement categories have their own fields:
--   reimbursements, warehouse_lost, warehouse_damage, reversal_reimbursement,
--   free_replacement_refund_items, compensated_clawback
-- The date column is event_date, not posted_date.
--
-- InventoryLab's rows are embedded below exactly as pasted, so the comparison
-- is arithmetic Postgres does, not arithmetic I do by hand.
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  CREATE TEMP TABLE il_reimb (
    d date, msku text, qty int, buy_cost numeric, amount numeric, descr text
  ) ON COMMIT DROP;

  INSERT INTO il_reimb VALUES
    ('2026-10-21','1066452194',1,0.00,17.05,'CustomerReturn'),
    ('2026-10-21','3G-W3TS-XQU3',1,0.00,7.74,'CustomerServiceIssue'),
    ('2026-10-20','1068284261',1,8.30,4.62,'Lost_Inbound'),
    ('2026-10-20','1068778316',1,0.00,20.25,'CustomerReturn'),
    ('2026-10-20','899-FGHQWE21',1,4.76,2.50,'Lost_Warehouse'),
    ('2026-10-20','1065498830',1,0.00,19.53,'CustomerReturn'),
    ('2026-10-20','1068778316',1,0.00,20.25,'CustomerReturn'),
    ('2026-10-20','JF0-EHR-72Q7',1,0.00,15.68,'CustomerReturn'),
    ('2026-10-20','VGN-0Q0-CH5I',1,0.00,17.71,'CustomerServiceIssue'),
    ('2026-10-20','1067904498',0,-6.75,-4.70,'Reimbursement_Reversal'),
    ('2026-10-19','8KN-OIT-P89U',0,-13.09,-3.27,'Reimbursement_Reversal'),
    ('2026-10-19','8J-WMV4-YTAN',1,4.97,3.00,'Lost_Inbound'),
    ('2026-10-19','1063210615',1,4.09,1.83,'Lost_Inbound'),
    ('2026-10-19','1068763435',1,4.59,4.76,'Lost_Inbound'),
    ('2026-10-19','1067904498',1,0.00,4.70,'CustomerReturn'),
    ('2026-10-19','C2S-HF6-Y803',1,9.99,6.83,'Lost_Warehouse'),
    ('2026-10-19','1063210615',1,4.09,1.83,'Lost_Warehouse'),
    ('2026-10-18','1067710647',1,3.03,2.78,'Damaged_Warehouse'),
    ('2026-10-18','QBJ-AT9-AM0M',1,9.35,5.11,'Lost_Inbound'),
    ('2026-10-18','P4-XY6Z-JFE2',6,44.34,27.60,'Lost_Inbound'),
    ('2026-10-18','6C-Y55A-0OUX',1,13.15,6.90,'Lost_Inbound'),
    ('2026-10-18','1065667431',1,16.16,8.32,'Lost_Inbound'),
    ('2026-10-18','fgvfdgfdg',5,67.50,31.40,'Lost_Inbound'),
    ('2026-10-18','1064346483',5,66.20,38.10,'Lost_Inbound'),
    ('2026-10-18','Z3-DPZV-J1GM',1,7.50,5.82,'Lost_Inbound'),
    ('2026-10-18','RZ-EZ5Q-VUGA',6,37.80,23.34,'Lost_Inbound'),
    ('2026-10-18','H1-ULHH-B60P',1,7.53,4.40,'Lost_Inbound'),
    ('2026-10-18','VGN-0Q0-CH5I',1,14.96,7.58,'Lost_Warehouse'),
    ('2026-10-18','QM-4JMW-5149',2,33.00,21.20,'Lost_Inbound'),
    ('2026-10-18','JS-9PYO-5DD3',1,12.50,5.89,'Lost_Inbound'),
    ('2026-10-18','D7-PHW7-VV70',2,27.72,16.84,'Lost_Inbound'),
    ('2026-10-18','1068948917',1,8.00,6.67,'Lost_Inbound'),
    ('2026-10-18','1064965282',19,289.94,180.69,'Lost_Inbound'),
    ('2026-10-18','1064345175',1,11.50,5.08,'Lost_Inbound'),
    ('2026-10-18','YS-0N1A-BWDW',1,4.99,3.39,'Lost_Inbound'),
    ('2026-10-18','P4-XY6Z-JFE2',2,14.78,9.20,'Lost_Inbound'),
    ('2026-10-18','IX4-QX3-TYOW',1,4.31,2.34,'Lost_Inbound'),
    ('2026-10-18','QBJ-AT9-AM0M',10,93.50,51.10,'Lost_Inbound'),
    ('2026-10-18','1065560175',1,10.78,5.47,'Lost_Inbound'),
    ('2026-10-18','IS-S5KQ-JPSL',3,8.94,7.17,'Lost_Inbound'),
    ('2026-10-18','1066881345',4,23.92,17.52,'Lost_Inbound'),
    ('2026-10-18','1067710081',1,5.94,2.53,'Lost_Inbound'),
    ('2026-10-18','1069064853',2,27.00,14.46,'Lost_Inbound'),
    ('2026-10-18','XOI-9PN-68E9',1,6.44,5.57,'Lost_Inbound'),
    ('2026-10-18','Z3-DPZV-J1GM',1,7.50,5.82,'Lost_Inbound'),
    ('2026-10-18','XOI-9PN-68E9',1,6.44,5.57,'Lost_Inbound'),
    ('2026-10-18','VB-THNB-1OSP',1,7.32,4.39,'Lost_Inbound'),
    ('2026-10-18','SXH-0ZW-N5US',1,4.34,3.18,'Damaged_Warehouse'),
    ('2026-10-18','fgvfdgfdg',1,13.50,6.28,'Lost_Inbound'),
    ('2026-10-18','3R-1HXO-9172',1,14.67,7.87,'Lost_Inbound');

  RAISE NOTICE '== INVENTORYLAB, as pasted ==';
  FOR r IN
    SELECT count(*) AS rows, sum(qty) AS units,
           round(sum(amount),2) AS reimbursed,
           round(sum(buy_cost),2) AS cost_of_goods
    FROM il_reimb
  LOOP
    RAISE NOTICE '   % rows | % units | reimbursed $% | COGS involved $%',
      r.rows, r.units, r.reimbursed, r.cost_of_goods;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   by day:';
  FOR r IN
    SELECT d, count(*) AS n, round(sum(amount),2) AS reimbursed
    FROM il_reimb GROUP BY d ORDER BY d
  LOOP RAISE NOTICE '      % | % rows | $%', r.d, lpad(r.n::text,3), r.reimbursed; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   by reason:';
  FOR r IN
    SELECT descr, count(*) AS n, round(sum(amount),2) AS reimbursed
    FROM il_reimb GROUP BY descr ORDER BY sum(amount) DESC
  LOOP RAISE NOTICE '      % | % rows | $%', rpad(r.descr,24), lpad(r.n::text,3), r.reimbursed; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== INVENTORYSPRINT: financial_events_cache, same window ==';
  FOR r IN
    SELECT count(*) AS rows,
           round(sum(COALESCE(reimbursements,0)),2) AS reimbursements,
           round(sum(COALESCE(warehouse_lost,0)),2) AS warehouse_lost,
           round(sum(COALESCE(warehouse_damage,0)),2) AS warehouse_damage,
           round(sum(COALESCE(reversal_reimbursement,0)),2) AS reversal,
           round(sum(COALESCE(free_replacement_refund_items,0)),2) AS free_replacement,
           round(sum(COALESCE(compensated_clawback,0)),2) AS clawback
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-10-18' AND event_date < '2026-10-22'
  LOOP
    RAISE NOTICE '   % FEC rows in the window', r.rows;
    RAISE NOTICE '   reimbursements          $%', r.reimbursements;
    RAISE NOTICE '   warehouse_lost          $%', r.warehouse_lost;
    RAISE NOTICE '   warehouse_damage        $%', r.warehouse_damage;
    RAISE NOTICE '   reversal_reimbursement  $%', r.reversal;
    RAISE NOTICE '   free_replacement_items  $%', r.free_replacement;
    RAISE NOTICE '   compensated_clawback    $%', r.clawback;
    RAISE NOTICE '   ------------------------------';
    RAISE NOTICE '   SUM of those             $%',
      round(COALESCE(r.reimbursements,0)+COALESCE(r.warehouse_lost,0)
           +COALESCE(r.warehouse_damage,0)+COALESCE(r.reversal,0)
           +COALESCE(r.free_replacement,0)+COALESCE(r.clawback,0), 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   our side, by day:';
  FOR r IN
    SELECT event_date AS d, count(*) AS n,
           round(sum(COALESCE(reimbursements,0)+COALESCE(warehouse_lost,0)
                    +COALESCE(warehouse_damage,0)+COALESCE(reversal_reimbursement,0)
                    +COALESCE(free_replacement_refund_items,0)),2) AS reimb
    FROM public.financial_events_cache
    WHERE user_id = v_uid AND event_date >= '2026-10-18' AND event_date < '2026-10-22'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '      % | % rows | $%', r.d, lpad(r.n::text,5), r.reimb; END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '      NO financial_events_cache rows in the window at all'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== how far back does our reimbursement data go at all? ==';
  FOR r IN
    SELECT min(event_date) AS first_ev, max(event_date) AS last_ev, count(*) AS n
    FROM public.financial_events_cache WHERE user_id = v_uid
  LOOP RAISE NOTICE '   FEC spans % .. % over % rows', r.first_ev, r.last_ev, r.n; END LOOP;

  FOR r IN
    SELECT max(event_date) AS last_reimb,
           count(*) FILTER (WHERE COALESCE(warehouse_lost,0) <> 0) AS lost_rows,
           count(*) FILTER (WHERE COALESCE(warehouse_damage,0) <> 0) AS dmg_rows,
           count(*) FILTER (WHERE COALESCE(reimbursements,0) <> 0) AS reimb_rows,
           count(*) FILTER (WHERE COALESCE(reversal_reimbursement,0) <> 0) AS rev_rows
    FROM public.financial_events_cache
    WHERE user_id = v_uid
      AND (COALESCE(warehouse_lost,0) <> 0 OR COALESCE(warehouse_damage,0) <> 0
        OR COALESCE(reimbursements,0) <> 0 OR COALESCE(reversal_reimbursement,0) <> 0)
  LOOP
    RAISE NOTICE '   most recent NON-ZERO reimbursement event: %', COALESCE(r.last_reimb::text,'(none ever)');
    RAISE NOTICE '   all-time rows: warehouse_lost % | damage % | reimbursements % | reversal %',
      r.lost_rows, r.dmg_rows, r.reimb_rows, r.rev_rows;
  END LOOP;
END
$p$;
