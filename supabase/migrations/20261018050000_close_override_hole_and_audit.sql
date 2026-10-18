-- (1) Close the trigger hole, and (2) add a provable audit trail for changes
-- to estimated_price / price_source.
--
-- WHY THE PREVIOUS FIX DID NOT WORK.
-- 20261016030000 allowed a write through when NEW.locked_from matched the
-- manual prefix. In a BEFORE UPDATE trigger, NEW holds the WHOLE row: a column
-- the writer never mentioned still appears in NEW carrying OLD's value. So an
-- automatic partial UPDATE that simply did not mention locked_from inherited
-- the manual label and sailed through the check meant to identify deliberate
-- manual writes. Proven 2026-10-18: an UPDATE setting only price_source and
-- estimated_price = 888.88 was let straight through.
--
-- Postgres cannot tell "omitted" from "set to the same value" -- there is no
-- per-column was-assigned flag. So the label itself has to carry the evidence:
-- a manual write now uses a UNIQUE suffix, which makes NEW.locked_from
-- necessarily DISTINCT from OLD.locked_from. An inherited label is by
-- definition not distinct, so it can no longer pass.
--
--   automatic, omits locked_from  -> NEW = OLD      -> not distinct -> BLOCKED
--   automatic, sets pricing_api   -> distinct, not manual           -> BLOCKED
--   button, unique manual label   -> distinct AND manual            -> ALLOWED
--   revert, unique manual label   -> distinct AND manual            -> ALLOWED
--   settlement (sold_price > 0)   -> released outright              -> ALLOWED

CREATE OR REPLACE FUNCTION public.preserve_manual_price_override()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  -- Settlement releases the override entirely: Amazon's real number always
  -- outranks any estimate, manual or not.
  IF COALESCE(NEW.sold_price, 0) > 0 OR COALESCE(NEW.total_sale_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- A DELIBERATE manual write must CHANGE locked_from to a manual label.
  -- Requiring the change is the whole point: it is the only thing that
  -- distinguishes an intentional write from an inherited label.
  IF NEW.locked_from IS DISTINCT FROM OLD.locked_from
     AND (COALESCE(NEW.locked_from, '') LIKE 'keepa_buybox:manual%'
          OR COALESCE(NEW.locked_from, '') LIKE 'manual:%') THEN
    RETURN NEW;
  END IF;

  IF NEW.estimated_price IS DISTINCT FROM OLD.estimated_price
     OR NEW.price_source IS DISTINCT FROM OLD.price_source THEN
    RAISE LOG 'preserve_manual_price_override: held % (est % to % / src % to % under lock %)',
      NEW.order_id, OLD.estimated_price, NEW.estimated_price,
      OLD.price_source, NEW.price_source, COALESCE(NEW.locked_from, '?');
  END IF;

  NEW.estimated_price  := OLD.estimated_price;
  NEW.locked_est_price := OLD.locked_est_price;
  NEW.locked_from      := OLD.locked_from;
  NEW.price_source     := OLD.price_source;
  NEW.price_confidence := OLD.price_confidence;
  NEW.price_calc_mode  := OLD.price_calc_mode;  -- was missing; job 190 changed it

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.preserve_manual_price_override() IS
  'Holds the pending estimate and its labels on manually-overridden rows against AUTOMATIC writers. A write passes only by CHANGING locked_from to a manual label (keepa_buybox:manual% or manual:%) -- an inherited label is not distinct and so cannot pass. Settlement releases the override. Fees and every other column always pass through.';

-- Widen the gate so manual: labels are protected too, not just keepa ones.
DROP TRIGGER IF EXISTS preserve_manual_price_override_trg ON public.sales_orders;
CREATE TRIGGER preserve_manual_price_override_trg
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW
  WHEN (OLD.locked_from LIKE 'keepa_buybox:manual%' OR OLD.locked_from LIKE 'manual:%')
  EXECUTE FUNCTION public.preserve_manual_price_override();

-- (2) AUDIT TRAIL.
-- The 2026-10-18 overwrite could only be pinned circumstantially -- job 190
-- ran at 05:21:00 and the row changed at 05:22:15 -- because nothing records
-- price changes. current_query() gives the actual statement, which names the
-- writer instead of implying it.
CREATE TABLE IF NOT EXISTS public.sales_order_price_audit (
  id               bigserial PRIMARY KEY,
  order_id         text        NOT NULL,
  user_id          uuid,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  old_estimate     numeric,
  new_estimate     numeric,
  old_price_source text,
  new_price_source text,
  old_locked_from  text,
  new_locked_from  text,
  old_sold_price   numeric,
  new_sold_price   numeric,
  db_role          text,
  jwt_sub          text,
  app_name         text,
  backend_pid      int,
  statement        text
);

COMMENT ON TABLE public.sales_order_price_audit IS
  'Append-only record of every change to sales_orders.estimated_price or price_source. Written by a WHEN-gated trigger so unchanged rows cost nothing -- sales_orders is the hot table and an ungated trigger on it is a known performance fault here. statement holds current_query() so the writer is provable rather than inferred.';

CREATE INDEX IF NOT EXISTS sales_order_price_audit_order_idx
  ON public.sales_order_price_audit (order_id, changed_at DESC);

ALTER TABLE public.sales_order_price_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own price audit" ON public.sales_order_price_audit;
CREATE POLICY "own price audit" ON public.sales_order_price_audit
  FOR SELECT USING (auth.uid() = user_id);
-- No INSERT policy is needed because the trigger function is SECURITY DEFINER
-- and writes as the owner, not the caller. (Learned the hard way on
-- keepa_estimate_recheck_log, where RLS silently denied every insert.)

CREATE OR REPLACE FUNCTION public.audit_sales_order_price()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  INSERT INTO public.sales_order_price_audit (
    order_id, user_id, old_estimate, new_estimate,
    old_price_source, new_price_source, old_locked_from, new_locked_from,
    old_sold_price, new_sold_price,
    db_role, jwt_sub, app_name, backend_pid, statement
  ) VALUES (
    NEW.order_id, NEW.user_id, OLD.estimated_price, NEW.estimated_price,
    OLD.price_source, NEW.price_source, OLD.locked_from, NEW.locked_from,
    OLD.sold_price, NEW.sold_price,
    current_user,
    COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '(none)'),
    COALESCE(current_setting('application_name', true), '(none)'),
    pg_backend_pid(),
    left(COALESCE(current_query(), '(none)'), 2000)
  );
  RETURN NULL; -- AFTER trigger
EXCEPTION WHEN OTHERS THEN
  -- Auditing must never break a write. Losing one audit row is bad; failing
  -- the sale update that triggered it is worse.
  RAISE WARNING 'audit_sales_order_price failed for %: %', NEW.order_id, SQLERRM;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS audit_sales_order_price_trg ON public.sales_orders;
CREATE TRIGGER audit_sales_order_price_trg
  AFTER UPDATE ON public.sales_orders
  FOR EACH ROW
  WHEN (OLD.estimated_price IS DISTINCT FROM NEW.estimated_price
        OR OLD.price_source IS DISTINCT FROM NEW.price_source)
  EXECUTE FUNCTION public.audit_sales_order_price();
