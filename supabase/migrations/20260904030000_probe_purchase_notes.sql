-- Read-only: does purchase history record WHERE anything was bought?
DO $$
DECLARE r RECORD; v_with_note bigint; v_total bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE btrim(COALESCE(note,'')) <> '')
    INTO v_total, v_with_note FROM public.created_listing_purchases;
  RAISE NOTICE 'purchases=% | with a note=%', v_total, v_with_note;

  FOR r IN SELECT note, unit_cost, purchase_date FROM public.created_listing_purchases
           WHERE btrim(COALESCE(note,'')) <> '' ORDER BY purchase_date DESC LIMIT 10
  LOOP
    RAISE NOTICE '  note: "%" ($%)', left(r.note, 70), r.unit_cost;
  END LOOP;
END $$;
