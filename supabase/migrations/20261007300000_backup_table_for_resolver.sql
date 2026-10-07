-- Backup target for the stuck-pending resolver. Created before the function
-- can write, so there is never a window where it would silently skip the copy.
CREATE TABLE IF NOT EXISTS public.backup_resolve_stuck_pending_20261007 (
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  row_data     jsonb       NOT NULL
);
COMMENT ON TABLE public.backup_resolve_stuck_pending_20261007 IS
  'Pre-change snapshot of sales_orders rows resolved by resolve-stuck-pending-orders on 2026-10-07. Each row holds the columns the resolver read before writing: id, order_id, asin, sku, quantity, estimated_price, order_status, is_cancelled, sold_price, order_date.';
