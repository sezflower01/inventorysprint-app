-- Diagnostic: why does Shipment Discrepancies show "Shipped 0" on every row?
--
-- /tools/unshipped-purchases reads fba_shipment_items and aggregates by ASIN:
--
--     for (const it of shipItems) {
--       const asin = it.asin;
--       if (!asin) continue;          <-- every null-ASIN row is DROPPED
--
-- It selects seller_sku in the same query and never uses it. Meanwhile
-- sync-fba-shipments writes:
--
--     asin: item?.ASIN || item?.asin || null,
--
-- and Amazon's InboundShipmentItem payload carries SellerSKU and
-- FulfillmentNetworkSKU but NOT an ASIN, so that lands null on write and
-- depends entirely on a later enrichment pass (which is skipped in
-- headers-only mode and capped at 10,000 rows).
--
-- Two causes produce the identical screen, and they need different fixes:
--
--   A. rows exist but asin is null      -> fixable on the page, by resolving
--                                          seller_sku to an ASIN
--   B. the table is empty for this user -> nothing to resolve; the FBA
--                                          shipment sync has not run or does
--                                          not reach back this far
--
-- Query 1 tells you which. Run the whole file; each block is independent.

-- ─── 1. Is there anything there at all, and how much of it is usable? ──────
select
  u.email,
  count(*)                                             as item_rows,
  count(i.asin)                                        as with_asin,
  count(*) - count(i.asin)                             as asin_null,
  round(100.0 * (count(*) - count(i.asin)) / nullif(count(*), 0), 1) as pct_null,
  count(distinct i.shipment_id)                        as shipments,
  sum(coalesce(i.quantity_shipped, 0))                 as units_shipped,
  sum(coalesce(i.quantity_received, 0))                as units_received
from fba_shipment_items i
join auth.users u on u.id = i.user_id
group by u.email
order by item_rows desc;

-- ─── 2. If asin is null, can seller_sku recover it? ───────────────────────
-- This is the proposed fix, measured before it is written: inventory is
-- Amazon's own sku -> asin mapping, created_listings is the seller's.
with null_rows as (
  select i.user_id, i.seller_sku, i.quantity_shipped, i.quantity_received
  from fba_shipment_items i
  where i.asin is null
)
select
  count(*)                                                       as null_asin_rows,
  count(distinct n.seller_sku)                                   as distinct_skus,
  count(inv.asin)                                                as resolvable_via_inventory,
  count(cl.asin)                                                 as resolvable_via_created_listings,
  count(coalesce(inv.asin, cl.asin))                             as resolvable_either_way,
  sum(coalesce(n.quantity_shipped, 0))
    filter (where coalesce(inv.asin, cl.asin) is not null)       as units_recoverable,
  sum(coalesce(n.quantity_shipped, 0))
    filter (where coalesce(inv.asin, cl.asin) is null)           as units_still_unattributable
from null_rows n
left join lateral (
  select v.asin from inventory v
  where v.user_id = n.user_id and upper(v.sku) = upper(n.seller_sku)
    and v.asin is not null
  limit 1
) inv on true
left join lateral (
  select c.asin from created_listings c
  where c.user_id = n.user_id and upper(c.sku) = upper(n.seller_sku)
    and c.asin is not null
  limit 1
) cl on true;

-- ─── 3. Spot-check the ten biggest money figures on the page ──────────────
-- Derived rather than pasted in, so this stays usable later and carries no
-- account identifiers in the repo. If these ASINs DO have shipment rows under
-- their SKU, the Missing and Value columns are overstating the shortfall.
with worst as (
  select c.user_id, c.asin, max(c.sku) as sku,
         sum(coalesce(c.units, 0)) as bought
  from created_listings c
  where c.asin is not null
    and coalesce(c.date_created, c.created_at::date) > current_date - 90
  group by c.user_id, c.asin
  order by bought desc
  limit 10
)
select
  w.asin,
  w.sku,
  w.bought,
  count(i.seller_sku)                     as shipment_item_rows,
  count(i.asin)                           as rows_carrying_the_asin,
  sum(coalesce(i.quantity_shipped, 0))    as shipped,
  sum(coalesce(i.quantity_received, 0))   as received,
  count(distinct i.shipment_id)           as shipments
from worst w
left join fba_shipment_items i
  on i.user_id = w.user_id
 and (upper(i.seller_sku) = upper(w.sku) or i.asin = w.asin)
group by w.asin, w.sku, w.bought
order by w.bought desc;

-- ─── 4. How far back does shipment history actually reach? ────────────────
-- The page's own caveat: a purchase older than the sync coverage looks
-- unshipped because it predates the data. These purchases are 21-46 days old,
-- so if the newest shipment here is older than that, cause B is in play too.
select
  u.email,
  count(*)                       as shipments,
  min(s.created_date)            as oldest,
  max(s.created_date)            as newest,
  count(s.received_date)         as with_received_date,
  max(s.received_date)           as newest_receipt
from fba_shipments s
join auth.users u on u.id = s.user_id
group by u.email
order by shipments desc;
