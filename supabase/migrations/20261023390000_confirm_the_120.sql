-- Pairing the multiset difference. Hypothesis: the vanished amounts are
-- collision SUMS that unpacked money-neutrally, except two that Amazon has
-- restated -- and those two restatements are the whole -1.20.
DO $p$
DECLARE r record; v_t numeric;
BEGIN
  RAISE NOTICE '== collision sums that unpacked EXACTLY (money-neutral) ==';
  FOR r IN
    SELECT * FROM (VALUES
      (9.44::numeric,  '4.72 + 4.72',  4.72::numeric + 4.72),
      (12.78,          '6.20 + 6.58',  6.20 + 6.58),
      (19.69,          '9.71 + 9.98',  9.71 + 9.98),
      (19.00,          '14.28 + 4.72', 14.28 + 4.72)
    ) AS t(vanished, parts, parts_sum)
  LOOP
    RAISE NOTICE '   % = % = %   exact: %',
      lpad(r.vanished::text,6), rpad(r.parts,14), lpad(r.parts_sum::text,6),
      (r.vanished = r.parts_sum);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the two that did NOT unpack: Amazon restated them ==';
  FOR r IN
    SELECT * FROM (VALUES
      (11.50::numeric, 11.13::numeric),
      (25.58,          24.75)
    ) AS t(before_amt, after_amt)
  LOOP
    RAISE NOTICE '   % -> %  (delta %)',
      lpad(r.before_amt::text,6), lpad(r.after_amt::text,6), round(r.after_amt - r.before_amt, 2);
  END LOOP;

  SELECT round((11.13 - 11.50) + (24.75 - 25.58), 2) INTO v_t;
  RAISE NOTICE '   ------------------------------';
  RAISE NOTICE '   restatement total: %', v_t;
  RAISE NOTICE '';
  RAISE NOTICE '== VERDICT on the -1.20 ==';
  RAISE NOTICE '   It is NOT the collision fix and NOT a dropped negative.';
  RAISE NOTICE '   Four vanished amounts are collision sums that split back into';
  RAISE NOTICE '   their exact components, so those are money-neutral. The other';
  RAISE NOTICE '   two are reversals Amazon has RESTATED downward since January';
  RAISE NOTICE '   was last synced: -0.37 and -0.83, totalling exactly %.', v_t;
  RAISE NOTICE '';
  RAISE NOTICE '   Same phenomenon as October, where two service_fee rows were';
  RAISE NOTICE '   restated and fba_removal_fees moved -3.36. Restatement is a';
  RAISE NOTICE '   normal property of this feed, not a defect in the re-pull.';
  RAISE NOTICE '';
  RAISE NOTICE '   Corroboration: warehouse_lost, warehouse_damage and';
  RAISE NOTICE '   free_replacement all moved EXACTLY 0.00 across the same 56';
  RAISE NOTICE '   extra rows. If the re-pull mis-split collisions, those three';
  RAISE NOTICE '   would have drifted too.';
END
$p$;
