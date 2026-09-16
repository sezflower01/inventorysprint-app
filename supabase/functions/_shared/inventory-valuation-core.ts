// Deno port of src/lib/inventory-valuation.ts — bit-for-bit equivalent.
// Used by refresh-inventory-valuation-summary to compute server-side totals.

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
async function fetchAsinCostOverrides(supabase: any, userId: string): Promise<Map<string, number>> {
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
 * computeInventoryValuation.
 *
 * Paginated deliberately: ~3,100 rows, and PostgREST caps an un-ranged select
 * at 1,000, which would silently drop two thirds of the costs and write an
 * undervalued summary row that every client then trusts.
 */
async function fetchCogOnRecord(supabase: any, userId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; from < 50 * PAGE; from += PAGE) {
    const { data, error } = await supabase
      .from("asin_cog_on_record")
      .select("asin, unit_cost")
      .eq("user_id", userId)
      .not("unit_cost", "is", null)
      .range(from, from + PAGE - 1);
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

const toNum = (n: unknown): number | null => {
  if (n === null || n === undefined) return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
};
const pos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

function listingUnitCost(row: { cost: number | null; amount: number | null; units: number | null }): number | null {
  const amount = toNum(row.amount);
  if (amount !== null && amount > 0) return amount;
  const cost = toNum(row.cost);
  const units = toNum(row.units);
  if (cost !== null && cost > 0 && pos(units)) return cost / units;
  return null;
}
function listingTotalCost(row: { cost: number | null; amount: number | null; units: number | null }): number | null {
  const cost = toNum(row.cost);
  if (cost !== null && cost >= 0) return cost;
  const amount = toNum(row.amount);
  const units = toNum(row.units);
  if (amount !== null && amount >= 0 && pos(units)) return amount * units;
  return null;
}
function inventoryUnitCost(row: { cost: number | null; amount: number | null; units: number | null }): number | null {
  const cost = toNum(row.cost);
  if (cost !== null && cost >= 0) return cost;
  const amount = toNum(row.amount);
  const units = toNum(row.units);
  if (amount !== null && amount >= 0 && pos(units)) return amount / units;
  return null;
}

async function fetchAllKeyset<T extends { id: string; created_at: string | null }>(
  supabase: any,
  table: string,
  columns: string,
  userId: string,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  const seen = new Set<string>();
  let lastCreatedAt: string | null = null;
  let lastId: string | null = null;

  for (let p = 0; p < 50; p += 1) {
    let q = supabase
      .from(table)
      .select(columns)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE);
    if (lastCreatedAt && lastId) {
      q = q.or(`created_at.lt.${lastCreatedAt},and(created_at.eq.${lastCreatedAt},id.lt.${lastId})`);
    }
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    const batch = data as unknown as T[];
    for (const r of batch) {
      if (r.id && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
    const last = batch[batch.length - 1];
    lastCreatedAt = last.created_at;
    lastId = last.id;
    if (data.length < PAGE) break;
  }
  return out;
}

export async function computeInventoryValuation(supabase: any, userId: string): Promise<InventoryValuationTotals> {
  const [inventoryRows, listingRows, overridesByAsin, cogByAsin] = await Promise.all([
    fetchAllKeyset<InventoryRow>(
      supabase,
      "inventory",
      "id,available,reserved,inbound,unfulfilled,cost,amount,units,unit_cost_manual,last_summaries_at,listing_status,asin,sku,created_at",
      userId,
    ),
    fetchAllKeyset<ListingRow>(
      supabase,
      "created_listings",
      "id,asin,sku,cost,amount,units,created_at",
      userId,
    ),
    fetchAsinCostOverrides(supabase, userId),
    fetchCogOnRecord(supabase, userId),
  ]);

  const costBySku = new Map<string, CostEntry>();
  const costByAsin = new Map<string, CostEntry>();
  for (const row of listingRows) {
    if (!row.asin) continue;
    const entry: CostEntry = {
      unitCost: listingUnitCost(row),
      totalCost: listingTotalCost(row),
      units: row.units !== null && row.units !== undefined ? Number(row.units) : null,
    };
    if (row.sku && !costBySku.has(row.sku)) costBySku.set(row.sku, entry);
    const existing = costByAsin.get(row.asin);
    if (!existing || existing.units === null || existing.units <= 0) {
      costByAsin.set(row.asin, entry);
    }
  }

  const grouped = new Map<string, InventoryRow & { _unitCost: number }>();
  for (const row of inventoryRows) {
    const status = String(row.listing_status || "").toUpperCase();
    if (status === "NOT_IN_CATALOG" || status === "DELETED") continue;

    const costEntry = costBySku.get(row.sku) ?? costByAsin.get(row.asin);
    const override = overridesByAsin.get(row.asin);
    const cog = cogByAsin.get(row.asin);
    // ---- Unit-cost precedence (changed 2026-09-15) ----------------------
    //
    // Stock is valued at the COG on record -- the single average the seller
    // types on the COG page -- not at the newest created_listings lot. COG
    // already drives COGS on 2026 sales, so valuing stock the same way keeps
    // this summary, the Synced Inventory page and P&L on one number.
    //
    // COG outranks inventory.unit_cost_manual (the inline editor on Synced
    // Inventory). Measured over 421 stocked rows: 81 disagreed, and on all 76
    // that carried both dates the COG was the newer edit, the inline value on
    // none. asin_cost_overrides stays above COG -- a separate, maintained
    // escape hatch shared with P&L's resolve_unit_cost_v1.
    //
    // This block must stay identical to src/lib/inventory-valuation.ts and
    // src/pages/tools/SyncedInventory.tsx.
    let unitCost: number;
    if (override !== undefined) {
      unitCost = override;
    } else if (cog !== undefined) {
      unitCost = cog;
    } else if (row.unit_cost_manual && row.cost !== null && row.cost !== undefined) {
      unitCost = Number(row.cost);
    } else {
      const fromEntry = costEntry?.unitCost;
      if (fromEntry !== null && fromEntry !== undefined) {
        unitCost = Number(fromEntry);
      } else if (row.cost !== null && row.cost !== undefined) {
        unitCost = Number(row.cost);
      } else {
        unitCost = inventoryUnitCost(row) ?? 0;
      }
    }

    const key = `${row.asin}::${row.sku}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.available = (existing.available ?? 0) + (row.available ?? 0);
      existing.reserved = (existing.reserved ?? 0) + (row.reserved ?? 0);
      existing.inbound = (existing.inbound ?? 0) + (row.inbound ?? 0);
      existing.unfulfilled = (existing.unfulfilled ?? 0) + (row.unfulfilled ?? 0);
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
    available += av; reserved += rs; inbound += ib; unfulfilled += uf;
    availableValue += av * unitCost;
    reservedValue += rs * unitCost;
    inboundValue += ib * unitCost;
    unfulfilledValue += uf * unitCost;
    if (av > 0 && av <= 3) lowStock += 1;
    if (row.last_summaries_at && (!mostRecentSync || row.last_summaries_at > mostRecentSync)) mostRecentSync = row.last_summaries_at;
    if (av + rs > 0 && (!row.last_summaries_at || new Date(row.last_summaries_at).getTime() < staleCutoff)) rowsStale24h += 1;
  }

  return {
    value: availableValue + reservedValue + inboundValue + unfulfilledValue,
    units: available + reserved + inbound + unfulfilled,
    skus, available, reserved, inbound, unfulfilled,
    availableValue, reservedValue, inboundValue, unfulfilledValue,
    lowStock,
    totalRows: inventoryRows.length,
    rowsStale24h,
    mostRecentSync,
  };
}
