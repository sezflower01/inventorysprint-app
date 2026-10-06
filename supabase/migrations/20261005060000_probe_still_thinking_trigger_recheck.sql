-- READ-ONLY PROBE (writes inside a savepoint it then rolls back).
--
-- still_thinking_sync_suppliers() is the single rule two writers depend on:
-- the extension writes supplier_url/discount_code, the Still Thinking page
-- writes supplier_links, and neither knows about the other. If the trigger is
-- wrong, they disagree silently -- which is exactly the failure mode that cost
-- this repo $2,491.75 on the P&L split. So exercise every path against the
-- real table and print what actually happened.
--
-- Rolled back at the end: nothing here survives.

DO $p$
DECLARE
  v_uid uuid;
  v_id  uuid;
  r     record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  BEGIN  -- savepoint
    -- 1. INSERT the way the extension does: singles only.
    INSERT INTO public.still_thinking_listings (user_id, asin, title, supplier_url, discount_code, status)
    VALUES (v_uid, 'ZZPROBE002', 'probe', 'www.target.com/p/thing?x=1#frag', 'SAVE10', 'probing')
    RETURNING id INTO v_id;
    SELECT supplier_url, supplier_domain, discount_code, supplier_links INTO r
    FROM public.still_thinking_listings WHERE id = v_id;
    RAISE NOTICE '1. extension-style insert (singles only)';
    RAISE NOTICE '   url=% domain=% code=%', r.supplier_url, r.supplier_domain, r.discount_code;
    RAISE NOTICE '   links=%', r.supplier_links;

    -- 2. The page adds a second retailer by writing the ARRAY.
    UPDATE public.still_thinking_listings
    SET supplier_links = '[{"link":"https://www.target.com/p/thing?x=1#frag","discount_code":"SAVE10"},
                           {"link":"walmart.com/ip/9","discount_code":""},
                           {"link":"","discount_code":"ignored"}]'::jsonb
    WHERE id = v_id;
    SELECT supplier_url, supplier_domain, discount_code, supplier_links INTO r
    FROM public.still_thinking_listings WHERE id = v_id;
    RAISE NOTICE '2. page writes the array (one blank row included)';
    RAISE NOTICE '   url=% domain=% code=%', r.supplier_url, r.supplier_domain, r.discount_code;
    RAISE NOTICE '   links=%', r.supplier_links;

    -- 3. The extension re-saves from a THIRD shop: singles only again.
    --    This must ADD, not replace -- the candidates gathered so far are the
    --    reason the ASIN is parked here.
    UPDATE public.still_thinking_listings
    SET supplier_url = 'https://shop.costco.com/item/5', discount_code = 'CC5'
    WHERE id = v_id;
    SELECT supplier_url, supplier_domain, discount_code, supplier_links INTO r
    FROM public.still_thinking_listings WHERE id = v_id;
    RAISE NOTICE '3. extension re-saves from a third shop (singles only)';
    RAISE NOTICE '   url=% domain=% code=%', r.supplier_url, r.supplier_domain, r.discount_code;
    RAISE NOTICE '   links=%', r.supplier_links;

    -- 4. Re-saving from a shop ALREADY on the row must not duplicate it.
    UPDATE public.still_thinking_listings
    SET supplier_url = 'https://shop.costco.com/item/5', discount_code = 'CC5-NEW'
    WHERE id = v_id;
    SELECT supplier_links INTO r FROM public.still_thinking_listings WHERE id = v_id;
    RAISE NOTICE '4. same shop again -> % entries (no duplicate)', jsonb_array_length(r.supplier_links);

    -- 5. The page removes every retailer. This has to be expressible, or the
    --    editor could add and edit but never fully delete.
    UPDATE public.still_thinking_listings SET supplier_links = '[]'::jsonb WHERE id = v_id;
    SELECT supplier_url, supplier_domain, discount_code, supplier_links INTO r
    FROM public.still_thinking_listings WHERE id = v_id;
    RAISE NOTICE '5. page clears the list';
    RAISE NOTICE '   url=% domain=% code=% links=%',
      COALESCE(r.supplier_url, 'NULL'), COALESCE(r.supplier_domain, 'NULL'),
      COALESCE(r.discount_code, 'NULL'), r.supplier_links;

    -- 6. An unrelated edit must not resurrect or reorder anything.
    UPDATE public.still_thinking_listings
    SET supplier_links = '[{"link":"target.com","discount_code":"A"},{"link":"walmart.com","discount_code":"B"}]'::jsonb
    WHERE id = v_id;
    UPDATE public.still_thinking_listings SET title = 'renamed only' WHERE id = v_id;
    SELECT supplier_url, supplier_links INTO r FROM public.still_thinking_listings WHERE id = v_id;
    RAISE NOTICE '6. title-only edit leaves retailers alone';
    RAISE NOTICE '   url=% links=%', r.supplier_url, r.supplier_links;

    RAISE EXCEPTION 'probe complete - rolling back';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'probe complete - rolling back' THEN
      RAISE NOTICE 'PROBE FAILED: %', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '';
  RAISE NOTICE 'probe rows left behind: %',
    (SELECT count(*) FROM public.still_thinking_listings WHERE asin = 'ZZPROBE002');
END
$p$;
