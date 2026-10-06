-- Make the mirror exact: supplier_url gets the scheme too.
--
-- The trigger probe (20261005040000) showed one asymmetry. On the
-- singles-written path the array entry was normalized to
-- https://www.target.com/p/thing but supplier_url was left exactly as the
-- extension sent it -- 'www.target.com/p/thing', no scheme. Everything that
-- reads supplier_links was fine; anything putting supplier_url straight into
-- an href would get a RELATIVE link and send the seller to
-- inventorysprint.com/tools/www.target.com/... instead of to the shop.
--
-- The whole point of the trigger is that the two sides cannot disagree, so a
-- near-mirror is not good enough. Take the normalized element 0 in both
-- branches rather than copying the raw input.

CREATE OR REPLACE FUNCTION public.still_thinking_sync_suppliers()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_links        jsonb;
  v_links_moved  boolean;
  v_url_moved    boolean;
  v_first        jsonb;
BEGIN
  v_links := still_thinking_normalize_suppliers(NEW.supplier_links);

  IF TG_OP = 'INSERT' THEN
    v_links_moved := jsonb_array_length(v_links) > 0;
    v_url_moved   := COALESCE(btrim(NEW.supplier_url), '') <> '';
  ELSE
    v_links_moved := v_links IS DISTINCT FROM still_thinking_normalize_suppliers(OLD.supplier_links);
    v_url_moved   := NEW.supplier_url IS DISTINCT FROM OLD.supplier_url
                  OR NEW.discount_code IS DISTINCT FROM OLD.discount_code;
  END IF;

  -- The singles are the truth only when they moved and the array did not: the
  -- extension re-saving from a new shop. Fold that shop in at the FRONT and
  -- keep the rest -- the candidates gathered so far are why the ASIN is parked
  -- here at all. Normalization then de-duplicates, so re-saving the same shop
  -- updates its code instead of adding a second copy.
  IF NOT v_links_moved AND v_url_moved AND COALESCE(btrim(NEW.supplier_url), '') <> '' THEN
    v_links := still_thinking_normalize_suppliers(
      jsonb_build_array(
        jsonb_build_object('link', NEW.supplier_url, 'discount_code', COALESCE(NEW.discount_code, ''))
      ) || v_links
    );
  END IF;

  -- One assignment site for the mirror, from the normalized array, so the two
  -- representations cannot differ even by a missing scheme.
  NEW.supplier_links := v_links;
  v_first := v_links -> 0;
  IF v_first IS NULL THEN
    NEW.supplier_url    := NULL;
    NEW.supplier_domain := NULL;
    NEW.discount_code   := NULL;
  ELSE
    NEW.supplier_url    := v_first ->> 'link';
    NEW.supplier_domain := still_thinking_domain_from_url(v_first ->> 'link');
    NEW.discount_code   := NULLIF(v_first ->> 'discount_code', '');
  END IF;

  RETURN NEW;
END
$fn$;

-- Re-normalize the rows already stored, through the trigger itself.
UPDATE public.still_thinking_listings SET supplier_links = supplier_links;

DO $p$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.still_thinking_listings
  WHERE COALESCE(supplier_url, '') IS DISTINCT FROM COALESCE(supplier_links -> 0 ->> 'link', '');
  RAISE NOTICE 'rows where supplier_url disagrees with supplier_links[0]: % (must be 0)', n;

  SELECT count(*) INTO n FROM public.still_thinking_listings
  WHERE COALESCE(supplier_url, '') <> '' AND supplier_url !~* '^https?://';
  RAISE NOTICE 'rows whose supplier_url still has no scheme: % (must be 0)', n;
END
$p$;
