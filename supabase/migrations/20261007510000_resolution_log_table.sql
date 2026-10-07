-- Durable log for the stuck-pending resolver. Created before the function can
-- write, so there is never a run whose changes went unrecorded.
CREATE TABLE IF NOT EXISTS public.stuck_pending_resolution_log (
  id               bigserial PRIMARY KEY,
  resolved_at      timestamptz NOT NULL DEFAULT now(),
  order_id         text        NOT NULL,
  asin             text,
  old_status       text,
  new_status       text,
  old_is_cancelled boolean,
  new_is_cancelled boolean,
  estimated_price  numeric,
  new_sold_price   numeric,
  price_recovered  boolean     NOT NULL DEFAULT false,
  note             text
);
CREATE INDEX IF NOT EXISTS stuck_pending_resolution_log_order_idx
  ON public.stuck_pending_resolution_log (order_id);

COMMENT ON TABLE public.stuck_pending_resolution_log IS
  'One row per status change made by resolve-stuck-pending-orders on 2026-10-07. Pairs with backup_resolve_stuck_pending_20261007, which holds the pre-change row itself.';

-- ESTIMATE_UNRECOVERABLE: Amazon confirms the order shipped but withholds
-- ItemPrice on orders this old, so the estimate is the only figure available.
-- It is labelled rather than zeroed -- "we cannot verify this" and "this never
-- happened" are different claims and only one of them is true.
COMMENT ON COLUMN public.sales_orders.price_confidence IS
  'CONFIRMED | HIGH_CONFIDENCE_PENDING | LOW_CONFIDENCE_HINT | ESTIMATE_UNRECOVERABLE | REPLACEMENT_ZERO_REVENUE. ESTIMATE_UNRECOVERABLE means Amazon confirmed the order shipped but will not return its price any more; the estimate is kept and the row still counts, so filter on this value when a total has to be defensible.';
