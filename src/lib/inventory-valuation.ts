import { supabase } from "@/integrations/supabase/client";
import { getInventoryUnitCost, getListingTotalCost, getListingUnitCost } from "@/lib/cost-contract";

export interface InventoryValuationTotals {
  value: number;
  units: number;
  skus: number;
  available: number;
  reserved: number;
  inbound: number;
  unfulfilled: number;
  availableValue: number;
  reservedValue: number;
  inboundValue: number;
  unfulfilledValue: number;
  lowStock: number;
  totalRows: number;
  rowsStale24h: number;
  mostRecentSync: string | null;
}

type CostEntry = {
  unitCost: number | null;
  totalCost: number | null;
  units: number | null;
};

type InventoryRow = {
  id: string;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  unfulfilled: number | null;
  cost: number | null;
  amount: number | null;
  units: number | null;
  unit_cost_manual: boolean | null;
  last_summaries_at: string | null;
  listing_status: string | null;
  asin: string;
  sku: string;
  created_at: string;
};

type ListingRow = {
  id: string;
  asin: string | null;
  sku: string | null;
  cost: number | null;
  amount: number | null;
  units: number | null;
  created_at: string | null;
  updated_at: string | null;
};

type OverrideRow = {
  asin: string;
  unit_cost: number;
  effective_from: string;
};

/**
 * Same override source P&L's resolve_unit_cost_v1 treats as top-priority
 * (after the sale-time snapshot, which doesn't apply to unsold stock).
 * Wiring it in here too means Inventory Valuation and P&L agree on one
 * number per ASIN instead of drifting apart.
 */
async function fetchAsinCostOverrides(userId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("asin_cost_overrides")
    .select("asin, unit_cost, effective_from")
    .eq("user_id", userId)
    .order("effective_from", { ascending: true });
  const map = new Map<string, number>();
  if (error || !data) return map;
  const today = new Date().toISOString().slice(0, 10);
  const thisYear = today.slice(0, 4);
  for (const row of data as OverrideRow[]) {
    if (!row.asin) continue;
    const eff = (row.effective_from || "").slice(0, 10);
    const cost = Number(row.unit_cost);
    // Same calendar year as today only — don't reach back into a prior
    // year's override when nothing exists yet this year.
    if (eff && eff <= today && eff.slice(0, 4) === thisYear && cost > 0) map.set(row.asin, cost);
  }
  return map;
}

/**
 * COG on record — the seller's single typed average unit cost per ASIN, and
 * the source stock is valued at. See the precedence note in
 * getInventoryValuationTotalsLive.
 *
 * Paginated deliberately: ~3,100 rows, and PostgREST caps an un-ranged select
 * at 1,000, which would silently drop two thirds of the costs.
 */
async function fetchCogOnRecord(userId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; from < 50 * PAGE; from += PAGE) {
    const { data, error } = await supabase
      .from("asin_cog_for_repricer")
      .select("asin, unit_cost")
      .eq("user_id", userId)
      .not("unit_cost", "is", null)
      .range(from, from + PAGE - 1);
    // Throw rather than return a partial map: a short read here silently
    // undervalues stock, which is worse than showing the caller an error.
    // Matches fetchAllKeyset above.
    if (error) throw error;
    if (!data) break;
    for (const row of data as { asin: string; unit_cost: number }[]) {
      const cost = Number(row.unit_cost);
      if (row.asin && Number.isFinite(cost) && cost > 0) map.set(row.asin, cost);
    }
    if (data.length < PAGE) break;
  }
  return map;
}

async function fetchAllKeyset<T extends { id: string; created_at: string | null }>(table: string, columns: string, userId: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  const seenIds = new Set<string>();
  let lastCreatedAt: string | null = null;
  let lastId: string | null = null;

  for (let page = 0; page < 50; page += 1) {
    let query = supabase
      .from(table as any)
      .select(columns)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE);

    if (lastCreatedAt && lastId) {
      query = query.or(`created_at.lt.${lastCreatedAt},and(created_at.eq.${lastCreatedAt},id.lt.${lastId})`);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    const batch = data as unknown as T[];
    for (const row of batch) {
      if (row.id && !seenIds.has(row.id)) {
        seenIds.add(row.id);
        out.push(row);
      }
    }

    const lastRow = batch[batch.length - 1];
    lastCreatedAt = lastRow.created_at;
    lastId = lastRow.id;
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Read the server-written summary row. Returns null when missing or stale
 * beyond `maxAgeSeconds` (default 30 min) — caller falls back to live compute.
 *
 * Phase 1 of multi-client CPU scaling: 5 browser tabs share ONE row instead
 * of each scanning inventory + created_listings.
 */
async function readInventoryValuationSummary(
  userId: string,
  maxAgeSeconds = 30 * 60,
): Promise<InventoryValuationTotals | null> {
  try {
    const { data, error } = await supabase
      .from("inventory_valuation_summary")
      .select(
        "value,units,skus,available,reserved,inbound,unfulfilled,available_value,reserved_value,inbound_value,unfulfilled_value,low_stock,total_rows,rows_stale_24h,most_recent_sync,computed_at",
      )
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const computedAt = data.computed_at ? new Date(data.computed_at).getTime() : 0;
    if (!computedAt || Date.now() - computedAt > maxAgeSeconds * 1000) return null;
    return {
      value: Number(data.value || 0),
      units: Number(data.units || 0),
      skus: Number(data.skus || 0),
      available: Number(data.available || 0),
      reserved: Number(data.reserved || 0),
      inbound: Number(data.inbound || 0),
      unfulfilled: Number(data.unfulfilled || 0),
      availableValue: Number(data.available_value || 0),
      reservedValue: Number(data.reserved_value || 0),
      inboundValue: Number(data.inbound_value || 0),
      unfulfilledValue: Number(data.unfulfilled_value || 0),
      lowStock: Number(data.low_stock || 0),
      totalRows: Number(data.total_rows || 0),
      rowsStale24h: Number(data.rows_stale_24h || 0),
      mostRecentSync: data.most_recent_sync ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget request to the server writer. Used by the manual Refresh
 * button so the next poll sees a fresh row. Lock inside the edge fn
 * prevents concurrent recomputes when multiple tabs press refresh.
 */
export async function triggerInventoryValuationRefresh(): Promise<void> {
  try {
    await supabase.functions.invoke("refresh-inventory-valuation-summary", {
      body: { source: "manual" },
    });
  } catch {
    // ignore — UI falls back to live compute
  }
}

export async function getInventoryValuationTotals(
  userId: string,
  opts: { preferSummary?: boolean; maxAgeSeconds?: number } = {},
): Promise<InventoryValuationTotals> {
  const preferSummary = opts.preferSummary !== false;
  if (preferSummary) {
    const cached = await readInventoryValuationSummary(userId, opts.maxAgeSeconds);
    if (cached) return cached;
  }
  return getInventoryValuationTotalsLive(userId);
}

async function getInventoryValuationTotalsLive(userId: string): Promise<InventoryValuationTotals> {
  const [inventoryRows, listingRows, overridesByAsin, cogByAsin] = await Promise.all([
    fetchAllKeyset<InventoryRow>(
      "inventory",
      "id,available,reserved,inbound,unfulfilled,cost,amount,units,unit_cost_manual,last_summaries_at,listing_status,asin,sku,created_at",
      userId,
    ),
    fetchAllKeyset<ListingRow>(
      "created_listings",
      "id,asin,sku,cost,amount,units,created_at,updated_at",
      userId,
    ),
    fetchAsinCostOverrides(userId),
    fetchCogOnRecord(userId),
  ]);

  // Build cost maps EXACTLY like SyncedInventory desktop:
  // ordered by created_at DESC; first-seen wins for SKU; for ASIN keep entry
  // unless current has units > 0.
  const costBySku = new Map<string, CostEntry>();
  const costByAsin = new Map<string, CostEntry>();
  for (const row of listingRows) {
    if (!row.asin) continue;
    const entry: CostEntry = {
      unitCost: getListingUnitCost({ cost: row.cost, amount: row.amount, units: row.units }),
      totalCost: getListingTotalCost({ cost: row.cost, amount: row.amount, units: row.units }),
      units: row.units !== null && row.units !== undefined ? Number(row.units) : null,
    };
    if (row.sku && !costBySku.has(row.sku)) costBySku.set(row.sku, entry);
    const existing = costByAsin.get(row.asin);
    if (!existing || existing.units === null || existing.units <= 0) {
      costByAsin.set(row.asin, entry);
    }
  }

  // Desktop visibleInventory filter: exclude NOT_IN_CATALOG / DELETED.
  // Desktop groups by ASIN+SKU; we mirror that since same row can exist twice.
  const grouped = new Map<string, InventoryRow & { _unitCost: number }>();
  for (const row of inventoryRows) {
    const status = String(row.listing_status || "").toUpperCase();
    if (status === "NOT_IN_CATALOG" || status === "DELETED") continue;

    // Resolve unit cost using the SAME precedence as SyncedInventory:
    //   manual override → item.cost (per-unit)
    //   else → costEntry.unitCost ?? item.cost (already per-unit) ?? compute
    const costEntry = costBySku.get(row.sku) ?? costByAsin.get(row.asin);
    const override = overridesByAsin.get(row.asin);
    const cog = cogByAsin.get(row.asin);
    // Precedence (changed 2026-09-17): COG on record → asin_cost_overrides →
    // the Synced Inventory inline editor → created_listings → inventory.cost.
    // Overrides used to come first; 26 of 27 were auto-saved from purchases
    // and hid the seller's COG. Must stay identical to SyncedInventory.tsx and
    // to the server-side computeInventoryValuation.
    let unitCost: number;
    if (cog !== undefined) {
      unitCost = cog;
    } else if (override !== undefined) {
      unitCost = override;
    } else if (row.unit_cost_manual && row.cost !== null && row.cost !== undefined) {
      unitCost = Number(row.cost);
    } else {
      const fromEntry = costEntry?.unitCost;
      if (fromEntry !== null && fromEntry !== undefined) {
        unitCost = Number(fromEntry);
      } else if (row.cost !== null && row.cost !== undefined) {
        unitCost = Number(row.cost);
      } else {
        unitCost = getInventoryUnitCost({ cost: row.cost, amount: row.amount, units: row.units }) ?? 0;
      }
    }

    const key = `${row.asin}::${row.sku}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.available = (existing.available ?? 0) + (row.available ?? 0);
      existing.reserved = (existing.reserved ?? 0) + (row.reserved ?? 0);
      existing.inbound = (existing.inbound ?? 0) + (row.inbound ?? 0);
      existing.unfulfilled = (existing.unfulfilled ?? 0) + (row.unfulfilled ?? 0);
      // unit cost: keep first non-zero
      if (!existing._unitCost && unitCost) existing._unitCost = unitCost;
    } else {
      grouped.set(key, { ...row, _unitCost: unitCost });
    }
  }

  let available = 0, reserved = 0, inbound = 0, unfulfilled = 0;
  let availableValue = 0, reservedValue = 0, inboundValue = 0, unfulfilledValue = 0;
  let lowStock = 0, skus = 0, rowsStale24h = 0;
  let mostRecentSync: string | null = null;
  const staleCutoff = Date.now() - 24 * 3600 * 1000;

  for (const row of grouped.values()) {
    const av = Number(row.available || 0);
    const rs = Number(row.reserved || 0);
    const ib = Number(row.inbound || 0);
    const uf = Number(row.unfulfilled || 0);
    const unitCost = row._unitCost || 0;

    if (av + rs + ib + uf > 0) skus += 1;
    available += av;
    reserved += rs;
    inbound += ib;
    unfulfilled += uf;
    availableValue += av * unitCost;
    reservedValue += rs * unitCost;
    inboundValue += ib * unitCost;
    unfulfilledValue += uf * unitCost;
    if (av > 0 && av <= 3) lowStock += 1;
    if (row.last_summaries_at && (!mostRecentSync || row.last_summaries_at > mostRecentSync)) mostRecentSync = row.last_summaries_at;
    if (av + rs > 0 && (!row.last_summaries_at || new Date(row.last_summaries_at).getTime() < staleCutoff)) rowsStale24h += 1;
  }

  const value = availableValue + reservedValue + inboundValue + unfulfilledValue;
  return {
    value,
    units: available + reserved + inbound + unfulfilled,
    skus,
    available,
    reserved,
    inbound,
    unfulfilled,
    availableValue,
    reservedValue,
    inboundValue,
    unfulfilledValue,
    lowStock,
    totalRows: inventoryRows.length,
    rowsStale24h,
    mostRecentSync,
  };
}

// ---- Projected Sale / Profit / ROI ----
// Always live-computed (no server cache table for this yet, unlike the totals
// above) — no live Amazon API calls, just DB reads. Fee source priority per
// item: cached inventory.fees_json, then the repricer's own asin_fee_cache
// (real per-ASIN fba_fee_fixed + referral_rate), else a flat 15%
// referral-only estimate. Matches SyncedInventory.tsx's desktop/mobile logic
// exactly so the two pages never disagree.

export interface ProjectedValuationMetrics {
  projectedSale: number;
  projectedInvestment: number | null;
  projectedProfit: number | null;
  projectedRoi: number | null;
  projectedMargin: number | null;
  itemsWithCachedFees: number;
  itemsWithRoi: number;
}

export function estimateAmazonFees(feesJson: any, price: number): number {
  if (!feesJson) return price * 0.15;
  const otherFees = Number(
    feesJson.otherFees ?? feesJson.other_fees ?? feesJson.fixedClosingFee ??
    feesJson.fixed_closing_fee ?? feesJson.closingFee ?? feesJson.FixedClosingFee ?? 0
  );
  if (feesJson.referralFee !== undefined || feesJson.fbaFee !== undefined) {
    const referralFee = Number(feesJson.referralFee || 0);
    const fbaFee = Number(feesJson.fbaFee || 0);
    const variableClosingFee = Number(feesJson.variableClosingFee || 0);
    const feesAtPrice = feesJson.price ? Number(feesJson.price) : 0;
    if (feesAtPrice > 0 && Math.abs(feesAtPrice - price) > 0.01) {
      const referralRate = referralFee / feesAtPrice;
      return (price * referralRate) + fbaFee + variableClosingFee + otherFees;
    }
    return referralFee + fbaFee + variableClosingFee + otherFees;
  }
  if (feesJson.referral_rate !== undefined || feesJson.fba_fee_fixed !== undefined) {
    const referralRate = Number(feesJson.referral_rate ?? 0.15);
    const fbaFeeFixed = Number(feesJson.fba_fee_fixed ?? 0);
    const variableClosingFee = Number(feesJson.variable_closing_fee ?? feesJson.variableClosingFee ?? 0);
    return (price * referralRate) + fbaFeeFixed + variableClosingFee + otherFees;
  }
  return price * 0.15;
}

export function estimateRoi(price: number | null | undefined, unitCost: number | null | undefined, feesJson: any): number | null {
  if (!price || !unitCost || unitCost <= 0) return null;
  return ((price - estimateAmazonFees(feesJson, price) - unitCost) / unitCost) * 100;
}

async function fetchFeeCacheMap(userId: string): Promise<Map<string, { fba_fee_fixed: number; referral_rate: number }>> {
  const map = new Map<string, { fba_fee_fixed: number; referral_rate: number }>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("asin_fee_cache")
      .select("asin, fba_fee_fixed, referral_rate")
      .eq("user_id", userId)
      .eq("marketplace", "US")
      .range(from, from + pageSize - 1);
    if (error || !data) break;
    for (const row of data) {
      if (row.asin) map.set(row.asin, { fba_fee_fixed: Number(row.fba_fee_fixed) || 0, referral_rate: Number(row.referral_rate) || 0.15 });
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

export async function getProjectedValuationMetrics(userId: string): Promise<ProjectedValuationMetrics> {
  const [inventoryRows, listingRows, overridesByAsin, feeCacheByAsin, cogByAsin] = await Promise.all([
    fetchAllKeyset<InventoryRow & { price: number | null; fees_json: any }>(
      "inventory",
      "id,available,reserved,inbound,unfulfilled,cost,amount,units,unit_cost_manual,listing_status,asin,sku,created_at,price,fees_json",
      userId,
    ),
    fetchAllKeyset<ListingRow>(
      "created_listings",
      "id,asin,sku,cost,amount,units,created_at,updated_at",
      userId,
    ),
    fetchAsinCostOverrides(userId),
    fetchFeeCacheMap(userId),
    fetchCogOnRecord(userId),
  ]);

  // Same cost-map + resolution precedence as getInventoryValuationTotalsLive,
  // so this page's numbers can never drift from the Value total above.
  const costBySku = new Map<string, CostEntry>();
  const costByAsin = new Map<string, CostEntry>();
  for (const row of listingRows) {
    if (!row.asin) continue;
    const entry: CostEntry = {
      unitCost: getListingUnitCost({ cost: row.cost, amount: row.amount, units: row.units }),
      totalCost: getListingTotalCost({ cost: row.cost, amount: row.amount, units: row.units }),
      units: row.units !== null && row.units !== undefined ? Number(row.units) : null,
    };
    if (row.sku && !costBySku.has(row.sku)) costBySku.set(row.sku, entry);
    const existing = costByAsin.get(row.asin);
    if (!existing || existing.units === null || existing.units <= 0) {
      costByAsin.set(row.asin, entry);
    }
  }

  const grouped = new Map<string, { qty: number; unitCost: number; price: number | null; feesJson: any }>();
  for (const row of inventoryRows) {
    const status = String(row.listing_status || "").toUpperCase();
    if (status === "NOT_IN_CATALOG" || status === "DELETED") continue;

    const costEntry = costBySku.get(row.sku) ?? costByAsin.get(row.asin);
    const override = overridesByAsin.get(row.asin);
    const cog = cogByAsin.get(row.asin);
    // Precedence (changed 2026-09-17): COG on record → asin_cost_overrides →
    // the Synced Inventory inline editor → created_listings → inventory.cost.
    // Overrides used to come first; 26 of 27 were auto-saved from purchases
    // and hid the seller's COG. Must stay identical to SyncedInventory.tsx and
    // to the server-side computeInventoryValuation.
    let unitCost: number;
    if (cog !== undefined) {
      unitCost = cog;
    } else if (override !== undefined) {
      unitCost = override;
    } else if (row.unit_cost_manual && row.cost !== null && row.cost !== undefined) {
      unitCost = Number(row.cost);
    } else {
      const fromEntry = costEntry?.unitCost;
      if (fromEntry !== null && fromEntry !== undefined) {
        unitCost = Number(fromEntry);
      } else if (row.cost !== null && row.cost !== undefined) {
        unitCost = Number(row.cost);
      } else {
        unitCost = getInventoryUnitCost({ cost: row.cost, amount: row.amount, units: row.units }) ?? 0;
      }
    }

    const qty = (row.available ?? 0) + (row.reserved ?? 0) + (row.inbound ?? 0) + (row.unfulfilled ?? 0);
    const key = `${row.asin}::${row.sku}`;
    const feesJson = row.fees_json || feeCacheByAsin.get(row.asin) || null;
    const existing = grouped.get(key);
    if (existing) {
      existing.qty += qty;
      if (!existing.unitCost && unitCost) existing.unitCost = unitCost;
      if (existing.price == null) existing.price = row.price ?? null;
      if (!existing.feesJson) existing.feesJson = feesJson;
    } else {
      grouped.set(key, { qty, unitCost, price: row.price ?? null, feesJson });
    }
  }

  // Sale/Profit/ROI use the same revenue base (items with a price AND a known
  // unit cost) so they stay reconcilable by hand. Investment instead uses the
  // Total Valuation basis (all items with cost + stock, price or not) so it
  // always matches the Total Valuation figure shown alongside it — meaning
  // Investment can be a little larger than Sale/Profit's implied cost when a
  // few items have cost/stock but no live price yet.
  let roiRevenue = 0, roiFees = 0, roiCost = 0;
  let allItemsValue = 0;
  let itemsWithRoi = 0;
  let itemsWithCachedFees = 0;

  for (const g of grouped.values()) {
    if (g.unitCost <= 0 || g.qty <= 0) continue;
    allItemsValue += g.unitCost * g.qty;
    if (!g.price) continue;
    roiRevenue += g.price * g.qty;
    roiFees += estimateAmazonFees(g.feesJson, g.price) * g.qty;
    roiCost += g.unitCost * g.qty;
    itemsWithRoi += 1;
    if (g.feesJson) itemsWithCachedFees += 1;
  }

  // Dollar-weighted ROI (total profit / total cost), not a per-item average —
  // this guarantees ROI's sign always matches Profit's sign. A real dollar
  // loss should never show as a positive ROI just because most individual
  // listings happen to be healthy. Margin (Profit / Sale) is a different
  // denominator than ROI (Profit / Cost) — both are useful, neither replaces
  // the other.
  const profit = itemsWithRoi > 0 ? roiRevenue - roiFees - roiCost : null;
  return {
    projectedSale: roiRevenue,
    projectedInvestment: allItemsValue > 0 ? allItemsValue : null,
    projectedProfit: profit,
    projectedRoi: roiCost > 0 ? ((roiRevenue - roiFees - roiCost) / roiCost) * 100 : null,
    projectedMargin: profit != null && roiRevenue > 0 ? (profit / roiRevenue) * 100 : null,
    itemsWithCachedFees,
    itemsWithRoi,
  };
}
