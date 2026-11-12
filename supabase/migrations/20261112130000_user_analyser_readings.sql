-- The table the User Analyser extension saves into.
--
-- Found missing on 2026-11-12 by probing for it: the extension (committed
-- cb49469) inserts into public.user_analyser_readings from its service worker,
-- and PRIVACY.md documents exactly these columns as what leaves the browser --
-- but the table was never created, so the Save button would have returned a
-- PostgREST 404 on first use. Caught before the extension was loaded.
--
-- Scoped to the user and nothing else. The whole point of that extension is
-- that it borrows no account, so these rows must be readable by their owner
-- ONLY -- not by the operator, not by an admin. There is deliberately no
-- admin-override policy: an admin bypass is what made every other table in
-- this project readable by the operator, and here that would undo the
-- extension's one guarantee.
CREATE TABLE IF NOT EXISTS public.user_analyser_readings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin           text,
  marketplace    text NOT NULL DEFAULT 'US',
  title          text,
  -- The price as the PAGE PRINTED IT, text, not numeric. readPage.js refuses
  -- to turn "$14.99 - $27.50" into a number, and storing numeric here would
  -- force exactly the guess the parser declines to make.
  price_text     text,
  buy_box_seller text,
  seller_count   integer,
  bsr            integer,
  -- Always 'page_read' in 0.1.0. A column rather than a constant because the
  -- panel labels every field with its source, and a later version adding
  -- Keepa or SP-API fields must be able to say which produced a row.
  source         text NOT NULL DEFAULT 'page_read',
  page_url       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_analyser_readings_user_created_idx
  ON public.user_analyser_readings (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_analyser_readings_user_asin_idx
  ON public.user_analyser_readings (user_id, asin);

ALTER TABLE public.user_analyser_readings ENABLE ROW LEVEL SECURITY;

DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='user_analyser_readings'
                   AND policyname='own_readings_select') THEN
    CREATE POLICY own_readings_select ON public.user_analyser_readings
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='user_analyser_readings'
                   AND policyname='own_readings_insert') THEN
    -- WITH CHECK, not USING: this is what stops a client inserting a row
    -- stamped with somebody else's user_id. background.js takes the id from
    -- the JWT rather than the request body, so the two agree, but the policy
    -- must hold even if that changes.
    CREATE POLICY own_readings_insert ON public.user_analyser_readings
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='user_analyser_readings'
                   AND policyname='own_readings_delete') THEN
    -- PRIVACY.md says "removing them removes them", so a user must be able to.
    CREATE POLICY own_readings_delete ON public.user_analyser_readings
      FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $p$;

-- No UPDATE policy: a reading is a record of what a page said at a moment.
-- Editing one would make it a claim about the page that the page never made.
