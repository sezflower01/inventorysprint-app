-- Still Thinking: many retailers per ASIN, and one rule that keeps the old
-- single-supplier columns honest.
--
-- THE PROBLEM. still_thinking_listings carried exactly one retailer --
-- supplier_url / supplier_domain / discount_code -- written only by the
-- extension from whatever tab the save came from. An ASIN saved straight off
-- Amazon therefore had no retailer at all, and the page rendered the column
-- read-only, so there was no way to add one afterwards. Re-saving from the
-- extension reports "Already in Still Thinking (refreshed)" but
-- INVSPRNT_SAVE_THINKING only re-READS the row on conflict, so the second save
-- did not fill it in either. Measured 2026-10-05: 109 thinking rows, 107 with a
-- URL, 10 with a discount code -- the two without are exactly the ones saved
-- from the Amazon page.
--
-- It is also genuinely one-to-many in practice: the point of Still Thinking is
-- to hold an ASIN while you look for the cheapest source, which means several
-- candidate retailers, each with its own code, before you commit.
--
-- THE SHAPE. supplier_links jsonb, the same [{link, discount_code}] array
-- created_listings already uses -- so Convert hands it straight through instead
-- of rebuilding a one-element array, and anything that already knows how to
-- read a supplier list keeps working.
--
-- WHY A TRIGGER AND NOT APPLICATION CODE. There are two writers that do not
-- know about each other: the extension writes the singles (it saves from a
-- browser tab and has no array), the web page writes the array. Mirroring them
-- in both apps is how the P&L web/Excel split drifted $2,491.75 and how COG
-- ended up with four implementations to keep in sync. One BEFORE trigger means
-- one rule, applied to whichever writer touched the row, and neither app has to
-- know the other exists.

ALTER TABLE public.still_thinking_listings
  ADD COLUMN IF NOT EXISTS supplier_links jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.still_thinking_listings.supplier_links IS
  'Candidate retailers: [{link, discount_code}]. Same shape as created_listings.supplier_links. '
  'supplier_url / supplier_domain / discount_code mirror element 0 and are maintained by '
  'still_thinking_sync_suppliers() -- write either side, never both.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Normalizer. The column is free-form jsonb and several callers treat "an entry
-- exists" as "a retailer is on file", so a blank row left behind in the editor
-- would read as a real one. Drop linkless entries, add the scheme, de-duplicate
-- on the normalized link, and cap the list so a runaway client cannot grow a
-- row without bound.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.still_thinking_normalize_suppliers(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  WITH src AS (
    SELECT e.value AS v, e.ordinality AS ord
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END)
         WITH ORDINALITY AS e(value, ordinality)
  ), cleaned AS (
    SELECT
      ord,
      CASE
        WHEN btrim(COALESCE(v ->> 'link', '')) = '' THEN NULL
        WHEN btrim(v ->> 'link') ~* '^https?://' THEN btrim(v ->> 'link')
        ELSE 'https://' || btrim(v ->> 'link')
      END AS link,
      btrim(COALESCE(v ->> 'discount_code', '')) AS code
    FROM src
  ), deduped AS (
    SELECT DISTINCT ON (lower(link)) ord, link, code
    FROM cleaned
    WHERE link IS NOT NULL
    ORDER BY lower(link), ord
  )
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('link', link, 'discount_code', code) ORDER BY ord),
    '[]'::jsonb
  )
  FROM (SELECT * FROM deduped ORDER BY ord LIMIT 25) t;
$fn$;

-- Host of a URL, minus www. Used only to keep supplier_domain in step; the
-- page and the search both read it, so it must never go stale against link 0.
CREATE OR REPLACE FUNCTION public.still_thinking_domain_from_url(p_url text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT NULLIF(
    regexp_replace(
      split_part(
        split_part(split_part(regexp_replace(COALESCE(p_url, ''), '^https?://', '', 'i'), '#', 1), '?', 1),
        '/', 1
      ),
      '^www\.', '', 'i'
    ),
    ''
  );
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The one rule. Whichever side the writer touched becomes the truth for this
-- statement, and the other side is rebuilt from it.
--   - array supplied (or changed)  -> singles mirror element 0
--   - only the singles supplied    -> array is built from them
-- An explicitly emptied array clears the singles: "I removed every retailer"
-- has to be expressible, or the page could add but never fully delete.
-- ─────────────────────────────────────────────────────────────────────────────
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

  -- The array wins when it moved, or when nothing moved but it is the only
  -- side carrying anything (the backfill case, and any writer that sets only
  -- the array on a row whose singles were already empty).
  IF v_links_moved OR (NOT v_url_moved AND jsonb_array_length(v_links) > 0) THEN
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
  END IF;

  -- Otherwise the singles are the truth: rebuild the array from them, keeping
  -- any OTHER retailers already on the row. The extension re-saving from a new
  -- shop should ADD that shop, not wipe the candidates gathered so far.
  IF COALESCE(btrim(NEW.supplier_url), '') <> '' THEN
    NEW.supplier_domain := still_thinking_domain_from_url(NEW.supplier_url);
    NEW.supplier_links := still_thinking_normalize_suppliers(
      jsonb_build_array(
        jsonb_build_object(
          'link', NEW.supplier_url,
          'discount_code', COALESCE(NEW.discount_code, '')
        )
      ) || COALESCE(v_links, '[]'::jsonb)
    );
  ELSE
    NEW.supplier_links := v_links;
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS still_thinking_sync_suppliers_trg ON public.still_thinking_listings;
CREATE TRIGGER still_thinking_sync_suppliers_trg
  BEFORE INSERT OR UPDATE ON public.still_thinking_listings
  FOR EACH ROW EXECUTE FUNCTION public.still_thinking_sync_suppliers();

-- Backfill. Written through a plain UPDATE so the trigger itself does the
-- conversion -- there is no second code path to get wrong.
UPDATE public.still_thinking_listings
SET supplier_links = '[]'::jsonb
WHERE COALESCE(btrim(supplier_url), '') <> ''
  AND jsonb_array_length(COALESCE(supplier_links, '[]'::jsonb)) = 0;

DO $p$
DECLARE r record; n int;
BEGIN
  RAISE NOTICE '== after backfill ==';
  FOR r IN SELECT status,
                  count(*) AS rows,
                  count(*) FILTER (WHERE jsonb_array_length(supplier_links) > 0) AS with_links,
                  count(*) FILTER (WHERE jsonb_array_length(supplier_links) > 1) AS with_several,
                  count(*) FILTER (WHERE COALESCE(supplier_url, '') <> '') AS with_url
           FROM public.still_thinking_listings GROUP BY status ORDER BY status LOOP
    RAISE NOTICE '  % | % rows | % with links | % with several | % still carry supplier_url',
      rpad(r.status, 12), r.rows, r.with_links, r.with_several, r.with_url;
  END LOOP;

  -- The mirror must agree on every row, or the page and the extension are
  -- already looking at two different retailers.
  SELECT count(*) INTO n FROM public.still_thinking_listings
  WHERE COALESCE(supplier_url, '') IS DISTINCT FROM COALESCE(supplier_links -> 0 ->> 'link', '');
  RAISE NOTICE '  rows where supplier_url disagrees with supplier_links[0]: % (must be 0)', n;
END
$p$;
