-- ITEM 1: the $34.80 gap. Computed in SQL rather than in my head, which is
-- exactly where it came from.
DO $p$
DECLARE r record; v_slices numeric; v_months numeric; v_n int;
BEGIN
  CREATE TEMP TABLE claw_slices (label text, ev int, amt numeric) ON COMMIT DROP;
  INSERT INTO claw_slices VALUES
    ('Jul 24 - Aug 1',  10,  -51.58),
    ('Aug 1  - Aug 16',  8,  -57.89),
    ('Aug 16 - Sep 1',   6,  -74.19),
    ('Sep 1  - Sep 16',  6,  -97.21),
    ('Sep 16 - Oct 1',  10, -115.99),
    ('Oct 1  - Oct 16',  8, -101.25),
    ('Oct 16 - Oct 22',  4,  -33.68);

  RAISE NOTICE '== the 7 measured slices ==';
  FOR r IN SELECT label, ev, amt FROM claw_slices LOOP
    RAISE NOTICE '   % | % events | $%', rpad(r.label,16), lpad(r.ev::text,3), lpad(r.amt::text,8);
  END LOOP;

  SELECT sum(amt), sum(ev) INTO v_slices, v_n FROM claw_slices;
  RAISE NOTICE '   ---------------------------------------';
  RAISE NOTICE '   SLICE TOTAL : % events | $%', v_n, v_slices;

  RAISE NOTICE '';
  RAISE NOTICE '== rolled up per month ==';
  FOR r IN
    SELECT m AS label, ev, amt FROM (VALUES
      ('Jul 24-31 (part)', 10,  -51.58::numeric),
      ('August',           14, -132.08),
      ('September',        16, -213.20),
      ('Oct 1-22 (part)',  12, -134.93)
    ) AS t(m, ev, amt)
  LOOP
    RAISE NOTICE '   % | % events | $%', rpad(r.label,18), lpad(r.ev::text,3), lpad(r.amt::text,9);
  END LOOP;

  SELECT sum(a) INTO v_months FROM (VALUES
    (-51.58::numeric), (-132.08), (-213.20), (-134.93)) AS t(a);
  RAISE NOTICE '   ---------------------------------------';
  RAISE NOTICE '   MONTH TOTAL : $%', v_months;

  RAISE NOTICE '';
  RAISE NOTICE '== VERDICT ==';
  RAISE NOTICE '   slices  $%', v_slices;
  RAISE NOTICE '   months  $%', v_months;
  RAISE NOTICE '   they AGREE, difference $%', v_slices - v_months;
  RAISE NOTICE '';
  RAISE NOTICE '   So the $34.80 gap was not in the data at all: the per-slice and';
  RAISE NOTICE '   per-month tables are both correct and consistent. The figure';
  RAISE NOTICE '   I reported as the 90-day total, $-566.59, was simply added up';
  RAISE NOTICE '   wrong. The correct total is $%.', v_slices;
  RAISE NOTICE '   566.59 - 531.79 = 34.80, which is the whole gap.';
  RAISE NOTICE '';
  RAISE NOTICE '   Month rollups verified against their slices:';
  RAISE NOTICE '     August    = -57.89 + -74.19  = %', (-57.89::numeric) + (-74.19);
  RAISE NOTICE '     September = -97.21 + -115.99 = %', (-97.21::numeric) + (-115.99);
  RAISE NOTICE '     Oct 1-22  = -101.25 + -33.68 = %', (-101.25::numeric) + (-33.68);
END
$p$;
