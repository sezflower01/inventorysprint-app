// Deno port of Live Sales aggregation logic — HYBRID version (v2).
// MUST stay in lock-step with the canonical client logic in:
//   - src/pages/tools/LiveSales.tsx
//       getLineRevenue, getEstimatedPendingRevenueNative,
//       buildUsdFallbackContext, dedupeDebugRows, isPendingPlaceholderRow
//   - src/lib/sales/currencyConversion.ts (FX)
//   - src/lib/sales/feeNormalization.ts   (fee USD normalization)
//   - src/lib/cogs/resolveUnitCost.ts     (COGS ladder)
//
// Phase 2 / Step 2 — read-only writer used by refresh-live-sales-summary.
// No repricer / sellability / pricing / FX-rule changes.
//
// HYBRID OUTPUT: for every (business_date, marketplace_id) we compute BOTH:
//   • confirmed-only columns (revenue / fees / cost / profit / units / orders)
//       — settled P&L truth (matches the pre-hybrid summary exactly).
//   • _with_fallback columns
//       — matches the current Live Sales KPI (`setTodaySummary.revenue`)
//         which uses the full fallback ladder + Phase 2 dedup.
//   • pending_estimate_revenue — subset of _with_fallback that came from
//         estimated_price (no confirmed sale yet).
//   • confidence counts — confirmed_count / high_confidence_count /
//         low_confidence_count / fallback_count.

import { getListingUnitCost, getInventoryUnitCost } from "./cost-contract.ts";
import {
  applyLearnedFeeMultiplier,
  loadLearnedFeeMultipliers,
  loadAsinFeeMultipliers,
  loadLearnedFeeSettings,
  type LearnedFeeMultiplierMap,
  type AsinFeeMultiplierMap,
  type LearnedFeeSettings,
} from "./learned-fee-multipliers.ts";

export const SUMMARY_VERSION = 3;

export const SALES_BUSINESS_TZ = "America/Los_Angeles";

export const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
  UK: "GBP", DE: "EUR", ES: "EUR", FR: "EUR", IT: "EUR",
  JP: "JPY", AU: "AUD", IN: "INR", SG: "SGD", AE: "AED",
  SA: "SAR", NL: "EUR", SE: "SEK", PL: "PLN", BE: "EUR", TR: "TRY",
};

function getBusinessDateISO(d: Date, tz = SALES_BUSINESS_TZ): string {
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

function num(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : 0;
}

function addDaysISO(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ───────────── Row shape ─────────────

type SaleRow = {
  id?: string;
  order_id?: string | null;
  asin?: string | null;
  sku?: string | null;
  seller_sku?: string | null;
  title?: string | null;
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
  marketplace?: string | null;
  is_cancelled?: boolean | null;
  order_status?: string | null;
  order_type?: string | null;
  price_source?: string | null;
  price_calc_mode?: string | null;
  price_confidence?: string | null;
  needs_price_enrich?: boolean | null;
  price_enrich_status?: string | null;
  referral_fee?: number | null;
  fba_fee?: number | null;
  closing_fee?: number | null;
  total_fees?: number | null;
  shipping_label_fee?: number | null;
  unit_cost?: number | null;
  unit_cost_at_sale?: number | null;
  cost_source_at_sale?: string | null;
  cost_locked?: boolean | null;
  total_cost?: number | null;
  fulfillment_channel?: string | null;
  order_date?: string | null;
  fees_invalid?: boolean | null;
  // Promotional rebates Amazon deducted from payout (coupons, lightning deals,
  // automatic rebates). Stored in same currency unit as sold_price (native).
  promotion_discount?: number | null;
  promotion_discount_native?: number | null;
  promotion_discount_currency?: string | null;
};

// ───────────── Revenue / pending helpers (mirror LiveSales.tsx) ─────────────

function getLineRevenueRaw(row: SaleRow): number {
  const qty = Math.max(1, num(row.quantity));
  const total = num(row.total_sale_amount);
  if (total > 0) return total;
  const sp = num(row.sold_price);
  if (sp > 0) return sp * qty;
  return 0;
}

const TRUSTED_USD_PRICE_SOURCES = new Set(["financial_events", "reconciled_fec", "settled", "orders_api", "orders_api_ca_reconciled", "data_repair", "orders_itemprice_usd"]);
const SUSPECT_NATIVE_PRICE_SOURCES = ["", "orders_itemprice", "order_items_api", "order_total_pending", "fees_api", "listings_api", "pricing_api", "estimate", "estimated:"];
function nativeMagnitudeThreshold(mp: string, fxRate: number): number {
  if (mp === "MX") return Math.max(120, fxRate * 7);
  if (mp === "BR") return Math.max(75, fxRate * 14);
  if (mp === "CA") return 150;
  return 150;
}
function shouldTreatConfirmedRevenueAsNative(row: SaleRow, rawTotal: number, qty: number, mp: string, fxRate: number): boolean {
  const priceSource = String(row.price_source || "").trim().toLowerCase();
  const calcMode = String(row.price_calc_mode || "").trim().toLowerCase();
  const hasTrustedUsdMarker = TRUSTED_USD_PRICE_SOURCES.has(priceSource) || TRUSTED_USD_PRICE_SOURCES.has(calcMode) || priceSource.endsWith("_usd") || calcMode.endsWith("_usd") || priceSource.includes("_reconciled") || calcMode.includes("_reconciled");
  if (hasTrustedUsdMarker) return false;
  const suspectSource = SUSPECT_NATIVE_PRICE_SOURCES.some(prefix => prefix === "" ? priceSource === "" : priceSource.startsWith(prefix) || calcMode.startsWith(prefix));
  if (!suspectSource) return false;
  const estimatedTotal = num(row.estimated_price) * qty;
  if (estimatedTotal > 0) {
    const usdLikeRatio = rawTotal / estimatedTotal;
    if (usdLikeRatio >= (1 / fxRate) * 0.75 && usdLikeRatio <= (1 / fxRate) * 1.35) return false;
  }
  // AUDIT §14 (BR confirmed revenue): removed hard-coded native treatment for
  // orders_itemprice / order_items_api / order_total_pending. Writer stores
  // USD on those paths (see [Sales Currency Contract]); treating as native
  // caused reader to divide BR by FX a second time (~5.4× understatement).
  // Mirrors src/lib/sales/currencyConversion.ts patch. Genuine legacy native
  // rows are still caught by the estimated-ratio + magnitude guards below.
  // AUDIT §14c: removed `ratio ≈ 1.0 → native` branch. New USD writer sets
  // sold_price = estimated_price (both USD), so that ratio matches healthy
  // USD rows and caused BR double-conversion (e.g. $32.86 → $6.11 on
  // 702-6403753-5454661). Mirrors src/lib/sales/currencyConversion.ts.
  if (estimatedTotal > 0) {
    const ratio = rawTotal / estimatedTotal;
    if (ratio >= fxRate * 0.65 && ratio <= fxRate * 1.45) return true;
  }
  return rawTotal >= nativeMagnitudeThreshold(mp, fxRate);
}
// Recent still-Pending orders can carry a preliminary/wrong price from
// Amazon before payment authorization finishes -- confirmed live: a 10-unit
// order with price_source="orders_itemprice" showed $150.57 total while the
// order was still Pending and the seller's own current listing price
// (estimated_price) was $215.10 (the real, correct amount). Validated
// against 900 recent (order_date within 30d) Pending + suspect-sourced US
// rows: 893/900 were healthy (raw within 15% of estimated_price*qty); the
// 7 genuine outliers were ALL understated, never overstated. Deliberately
// scoped to Pending + recent + suspect-sourced + understated only -- older
// or non-Pending mismatches usually mean the price legitimately changed
// since the sale (estimated_price drifted, not the sale data), and treating
// those as wrong caused the regressions documented in AUDIT §14/§14c above.
function isRecentPendingSuspectLowball(row: SaleRow, raw: number, qty: number): boolean {
  const status = String(row.order_status || "").trim().toLowerCase();
  if (status !== "pending") return false;
  const priceSource = String(row.price_source || "").trim().toLowerCase();
  const calcMode = String(row.price_calc_mode || "").trim().toLowerCase();
  const hasTrustedUsdMarker = TRUSTED_USD_PRICE_SOURCES.has(priceSource) || TRUSTED_USD_PRICE_SOURCES.has(calcMode) || priceSource.endsWith("_usd") || calcMode.endsWith("_usd") || priceSource.includes("_reconciled") || calcMode.includes("_reconciled");
  if (hasTrustedUsdMarker) return false;
  const suspectSource = SUSPECT_NATIVE_PRICE_SOURCES.some(prefix => prefix === "" ? priceSource === "" : priceSource.startsWith(prefix) || calcMode.startsWith(prefix));
  if (!suspectSource) return false;
  const orderDate = String(row.order_date || "");
  if (!orderDate) return false;
  const ageDays = (Date.now() - new Date(`${orderDate}T00:00:00Z`).getTime()) / 86400000;
  if (!(ageDays >= 0 && ageDays <= 30)) return false;
  const est = num(row.estimated_price) * qty;
  if (!(est > 0)) return false;
  return raw < est * 0.85;
}

function getConfirmedSalesOrderRevenueUsd(row: SaleRow, toUsd: (a:number,m:string|null|undefined)=>number): number {
  const qty = Math.max(1, num(row.quantity));
  const raw = getLineRevenueRaw(row);
  if (raw <= 0) return 0;
  if (isRecentPendingSuspectLowball(row, raw, qty)) return num(row.estimated_price) * qty;
  const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
  if (mp === "US") return raw;
  const oneUsd = toUsd(1, mp);
  const fxRate = oneUsd > 0 ? 1 / oneUsd : 0;
  if (!(fxRate > 1.05)) return raw;
  return shouldTreatConfirmedRevenueAsNative(row, raw, qty, mp, fxRate) ? toUsd(raw, mp) : raw;
}
function getConfirmedSalesOrderUnitRevenueUsd(row: SaleRow, toUsd: (a:number,m:string|null|undefined)=>number): number {
  const qty = Math.max(1, num(row.quantity));
  const total = getConfirmedSalesOrderRevenueUsd(row, toUsd);
  return total > 0 ? total / qty : 0;
}


function getEstimatedPendingNative(row: SaleRow): number {
  if (row.is_cancelled === true) return 0;
  const s = String(row.order_status || "").toLowerCase();
  if (s === "canceled" || s === "cancelled") return 0;
  if (num(row.total_sale_amount) > 0) return 0;
  if (num(row.sold_price) > 0) return 0;
  const qty = Math.max(1, num(row.quantity));
  const est = num(row.locked_est_price) || num(row.estimated_price);
  return est > 0 ? est * qty : 0;
}

function isLowConfidencePending(row: SaleRow): boolean {
  if (num(row.sold_price) > 0 || num(row.total_sale_amount) > 0) return false;
  const ps = String(row.price_source || "").toLowerCase();
  const pc = String(row.price_confidence || "").toUpperCase();
  if (ps === "snapshot_price" || ps === "snapshot_item_price" || ps.startsWith("seller_derived:snapshot")) return false;
  if (pc === "LOW_CONFIDENCE_HINT") return true;
  return (
    ps.startsWith("hint:") ||
    ps.startsWith("pricing_api_") ||
    ps.startsWith("estimated:keepa") ||
    ps.startsWith("estimated:inventory") ||
    ps.startsWith("estimated:amazon_price") ||
    ps.startsWith("estimated:my_price") ||
    ps.startsWith("estimated:buy_box")
  );
}

function isPendingPlaceholderRow(row: SaleRow): boolean {
  const asin = String(row.asin || "").trim().toUpperCase();
  const title = String(row.title || "").trim().toLowerCase();
  return asin === "PENDING" || title.startsWith("order processing");
}

function isRealAsin(val: string | null | undefined): boolean {
  const s = String(val || "").trim();
  return /^B0[A-Z0-9]{8}$/i.test(s);
}

// ───────────── FX ─────────────

export async function loadFxRates(admin: any): Promise<Record<string, number>> {
  const { data } = await admin.from("fx_rates").select("quote, rate").eq("base", "USD");
  const map: Record<string, number> = {};
  for (const r of (data || [])) map[r.quote] = Number(r.rate);
  return map;
}

function makeToUsd(fxRates: Record<string, number>) {
  return (amount: number, mp: string | null | undefined): number => {
    const cur = MARKETPLACE_CURRENCY[String(mp || "US").trim().toUpperCase()] || "USD";
    if (cur === "USD") return amount;
    const r = fxRates[cur];
    return r && r > 0 ? amount / r : amount;
  };
}

// ───────────── Fee normalization ─────────────

const isNonUs = (mp?: string | null) => String(mp || "US").trim().toUpperCase() !== "US";

function normalizePossibleLocalFee(amount: number, mp: string | null | undefined, revenueUsd: number, toUsd: (a:number,m:string|null|undefined)=>number): number {
  if (amount <= 0) return 0;
  if (!isNonUs(mp)) return amount;
  if (revenueUsd > 0 && amount > revenueUsd * 0.7) return toUsd(amount, mp);
  return amount;
}

function getSalesOrderFeesUsd(row: SaleRow, revenueUsd: number, toUsd: (a:number,m:string|null|undefined)=>number): number {
  const referral = num(row.referral_fee);
  const fba = num(row.fba_fee);
  const closing = num(row.closing_fee);
  const label = Math.max(0, num(row.shipping_label_fee));
  const labelUsd = label > 0 ? normalizePossibleLocalFee(label, row.marketplace, revenueUsd, toUsd) : 0;
  const componentTotal = referral + fba + closing;
  if (componentTotal > 0) {
    return (
      normalizePossibleLocalFee(referral, row.marketplace, revenueUsd, toUsd) +
      normalizePossibleLocalFee(fba, row.marketplace, revenueUsd, toUsd) +
      normalizePossibleLocalFee(closing, row.marketplace, revenueUsd, toUsd) +
      labelUsd
    );
  }
  return normalizePossibleLocalFee(num(row.total_fees), row.marketplace, revenueUsd, toUsd) + labelUsd;
}

// Cached fee profile fallback — mirrors getCachedFeesUsd in feeNormalization.ts.
// Used when per-row referral/fba/closing/total_fees are all 0 (typical for pending rows).
export type FeeCacheEntry = { fba: number; refRate: number; isMedia: boolean };
function getCachedFeesUsd(
  cache: FeeCacheEntry, revenueUsd: number, quantity: number,
  marketplace: string | null | undefined, toUsd: (a:number,m:string|null|undefined)=>number,
): number {
  const refRate = cache.refRate > 0 ? cache.refRate : 0.15;
  const referralFee = revenueUsd * refRate;
  const fbaFee = normalizePossibleLocalFee(cache.fba * quantity, marketplace, revenueUsd, toUsd);
  const closingFee = cache.isMedia ? 1.8 * quantity : 0;
  return referralFee + fbaFee + closingFee;
}

function feeCacheKey(asin: string, mp: string | null | undefined): string {
  return `${String(asin || "").trim()}::${String(mp || "US").trim().toUpperCase()}`;
}

async function loadAsinFeeCache(admin: any, userId: string, asins: string[]): Promise<Map<string, FeeCacheEntry>> {
  const out = new Map<string, FeeCacheEntry>();
  if (!asins.length) return out;
  for (let i = 0; i < asins.length; i += 200) {
    const batch = asins.slice(i, i + 200);
    const { data } = await admin.from("asin_fee_cache")
      .select("asin, marketplace, fba_fee_fixed, referral_rate, is_media")
      .eq("user_id", userId).in("asin", batch);
    for (const f of (data || []) as any[]) {
      const k = feeCacheKey(f.asin, f.marketplace);
      if (f.asin && !out.has(k)) {
        out.set(k, {
          fba: Number(f.fba_fee_fixed) || 0,
          refRate: Number(f.referral_rate) || 0.15,
          isMedia: Boolean(f.is_media),
        });
      }
    }
  }
  return out;
}

// ───────────── COGS resolver (port of src/lib/cogs/resolveUnitCost.ts) ─────────────

type OverrideEntry = { effective_from: string; unit_cost: number };
type ListingRow = { asin?: string|null; sku?: string|null; cost?: number|null; amount?: number|null; units?: number|null; date_created?: string|null; created_at?: string|null; updated_at?: string|null; id?: string|null; price?: number|null };
type InvRow = { asin?: string|null; sku?: string|null; cost?: number|null; amount?: number|null; units?: number|null; price?: number|null; my_price?: number|null; amazon_price?: number|null };
type PurchaseEntry = { asin?: string|null; sku?: string|null; unit_cost: number; purchase_date: string; created_at?: string|null; id?: string|null };
type CostHistoryEntry = { asin?: string|null; sku?: string|null; cost: number; effective_date: string; recorded_at: string; id?: string|null };
type HistoricalCostCandidate = { unitCost: number; source: string; costTs: string; createdAt: string; tieRank: number; id: string };

const isValidAsin = (a?: string | null): a is string => !!a && a !== "PENDING" && a !== "UNKNOWN";

function pickNewestListing(rows: ListingRow[]): ListingRow | undefined {
  if (!rows.length) return undefined;
  const sorted = [...rows].sort((a, b) => {
    const ad = a.date_created || "", bd = b.date_created || "";
    if (ad !== bd) { if (!ad) return 1; if (!bd) return -1; return bd.localeCompare(ad); }
    const ac = a.created_at || "", bc = b.created_at || "";
    if (ac !== bc) return bc.localeCompare(ac);
    return (b.id || "").localeCompare(a.id || "");
  });
  for (const row of sorted) {
    const u = getListingUnitCost(row);
    if (u !== null && u > 0) return row;
  }
  return undefined;
}

function orderDateEndBoundary(orderDate: string | null): string | null {
  if (!orderDate) return null;
  const d = new Date(`${orderDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function pickHistoricalListing(rows: ListingRow[], orderDate: string | null): ListingRow | undefined {
  if (!orderDate) return pickNewestListing(rows);
  const od = orderDate.slice(0, 10);
  return pickNewestListing(rows.filter(r => {
    const d = r.date_created || r.created_at?.slice(0, 10) || "";
    return !!d && d <= od;
  }));
}

function pickHistoricalPurchase(rows: PurchaseEntry[], orderDate: string | null): PurchaseEntry | undefined {
  const boundary = orderDateEndBoundary(orderDate);
  if (!boundary) return undefined;
  return [...rows]
    .filter(r => Number(r.unit_cost) > 0 && r.purchase_date < boundary)
    .sort((a, b) => {
      if (a.purchase_date !== b.purchase_date) return b.purchase_date.localeCompare(a.purchase_date);
      const ac = a.created_at || "", bc = b.created_at || "";
      if (ac !== bc) return bc.localeCompare(ac);
      return (b.id || "").localeCompare(a.id || "");
    })[0];
}

function listingCostTs(row: ListingRow): string {
  return row.date_created ? `${row.date_created}T00:00:00.000Z` : row.created_at || row.date_created || "";
}

function pickHistoricalCost(purchases: PurchaseEntry[], listings: ListingRow[], costHistory: CostHistoryEntry[], orderDate: string | null): HistoricalCostCandidate | undefined {
  if (!orderDate) {
    const row = pickNewestListing(listings);
    if (!row) return undefined;
    const unit = getListingUnitCost(row);
    return unit && unit > 0 ? { unitCost: unit, source: 'listingsHistorical', costTs: listingCostTs(row), createdAt: row.created_at || "", tieRank: 1, id: row.id || "" } : undefined;
  }
  const boundary = orderDateEndBoundary(orderDate);
  if (!boundary) return undefined;
  const day = orderDate.slice(0, 10);
  const candidates: HistoricalCostCandidate[] = [];

  // Tier A — immutable cost_history.
  for (const row of costHistory) {
    const unit = Number(row.cost) || 0;
    if (unit <= 0) continue;
    const eff = (row.effective_date || "").slice(0, 10);
    const rec = (row.recorded_at || "").slice(0, 10);
    if (!eff || eff > day) continue;
    if (rec && rec > day) continue;
    candidates.push({ unitCost: unit, source: 'costHistory', costTs: `${eff}T00:00:00.000Z`, createdAt: row.recorded_at || "", tieRank: -1, id: row.id || "" });
  }

  for (const row of purchases) {
    const unit = Number(row.unit_cost) || 0;
    if (unit <= 0 || !row.purchase_date || row.purchase_date >= boundary) continue;
    candidates.push({ unitCost: unit, source: 'purchaseBatch', costTs: row.purchase_date, createdAt: row.created_at || "", tieRank: 0, id: row.id || "" });
  }
  // STRICT 3-clause guard on listings.
  for (const row of listings) {
    const d = row.date_created || row.created_at?.slice(0, 10) || "";
    if (!d || d > day) continue;
    const createdDay = row.created_at?.slice(0, 10) || "";
    if (createdDay && createdDay > day) continue;
    const updatedDay = row.updated_at?.slice(0, 10) || "";
    if (updatedDay && updatedDay > day) continue;
    const unit = getListingUnitCost(row);
    if (!unit || unit <= 0) continue;
    candidates.push({ unitCost: unit, source: 'listingsHistorical', costTs: listingCostTs(row), createdAt: row.created_at || "", tieRank: 1, id: row.id || "" });
  }
  return candidates.sort((a, b) => {
    if (a.costTs !== b.costTs) return b.costTs.localeCompare(a.costTs);
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.tieRank !== b.tieRank) return a.tieRank - b.tieRank;
    return b.id.localeCompare(a.id);
  })[0];
}

function pickInvRow(rows: InvRow[]): InvRow | undefined {
  for (const r of rows) {
    const u = getInventoryUnitCost(r);
    if (u !== null && u > 0) return r;
  }
  return undefined;
}

async function inBatches<K, R>(keys: K[], size: number, fn: (b: K[]) => Promise<R[] | null | undefined>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < keys.length; i += size) {
    const rows = await fn(keys.slice(i, i + size));
    if (rows && rows.length) out.push(...rows);
  }
  return out;
}

export async function buildCogsResolver(admin: any, userId: string, orders: Array<{asin?: string|null; sku?: string|null}>) {
  const asins = [...new Set(orders.map(o => o.asin).filter(isValidAsin))] as string[];
  const skus = [...new Set(orders.filter(o => !!o.sku).map(o => o.sku as string))];

  const listingsByAsin = new Map<string, ListingRow[]>();
  const listingById = new Map<string, ListingRow>();
  if (asins.length) {
    const rows = await inBatches(asins, 100, async b => {
      const { data } = await admin.from("created_listings")
        .select("asin,sku,cost,amount,units,date_created,created_at,updated_at,id")
        .eq("user_id", userId).in("asin", b);
      return data as ListingRow[] | null;
    });
    for (const r of rows) {
      if (r.id) listingById.set(String(r.id), r);
      const k = r.asin!; if (!k) continue; (listingsByAsin.get(k) || listingsByAsin.set(k, []).get(k)!).push(r);
    }
  }

  const listingsBySku = new Map<string, ListingRow[]>();
  if (skus.length) {
    const rows = await inBatches(skus, 100, async b => {
      const { data } = await admin.from("created_listings")
        .select("asin,sku,cost,amount,units,date_created,created_at,updated_at,id")
        .eq("user_id", userId).in("sku", b);
      return data as ListingRow[] | null;
    });
    for (const r of rows) {
      if (r.id) listingById.set(String(r.id), r);
      const k = r.sku!; if (!k) continue; (listingsBySku.get(k) || listingsBySku.set(k, []).get(k)!).push(r);
    }
  }

  const purchasesByAsin = new Map<string, PurchaseEntry[]>();
  const purchasesBySku = new Map<string, PurchaseEntry[]>();
  const listingIds = [...listingById.keys()];
  if (listingIds.length) {
    const rows = await inBatches(listingIds, 100, async b => {
      const { data } = await admin.from("created_listing_purchases")
        .select("id,listing_id,unit_cost,purchase_date,created_at")
        .eq("user_id", userId).in("listing_id", b).gt("unit_cost", 0);
      return data as any[] | null;
    });
    for (const r of rows as any[]) {
      const l = listingById.get(String(r.listing_id));
      if (!l) continue;
      const e: PurchaseEntry = { asin: l.asin, sku: l.sku, unit_cost: Number(r.unit_cost), purchase_date: r.purchase_date, created_at: r.created_at, id: r.id };
      if (e.asin) (purchasesByAsin.get(e.asin) || purchasesByAsin.set(e.asin, []).get(e.asin)!).push(e);
      if (e.sku) (purchasesBySku.get(e.sku) || purchasesBySku.set(e.sku, []).get(e.sku)!).push(e);
    }
  }

  const inventoryByAsin = new Map<string, InvRow>();
  if (asins.length) {
    const rows = await inBatches(asins, 100, async b => {
      const { data } = await admin.from("inventory").select("asin,sku,cost,amount,units").eq("user_id", userId).in("asin", b);
      return data as InvRow[] | null;
    });
    const grp = new Map<string, InvRow[]>();
    for (const r of rows) { const k = r.asin!; if (!k) continue; (grp.get(k) || grp.set(k, []).get(k)!).push(r); }
    for (const [k, g] of grp) { const p = pickInvRow(g); if (p) inventoryByAsin.set(k, p); }
  }
  const inventoryBySku = new Map<string, InvRow>();
  if (skus.length) {
    const rows = await inBatches(skus, 100, async b => {
      const { data } = await admin.from("inventory").select("asin,sku,cost,amount,units").eq("user_id", userId).in("sku", b);
      return data as InvRow[] | null;
    });
    const grp = new Map<string, InvRow[]>();
    for (const r of rows) { const k = r.sku!; if (!k) continue; (grp.get(k) || grp.set(k, []).get(k)!).push(r); }
    for (const [k, g] of grp) { const p = pickInvRow(g); if (p) inventoryBySku.set(k, p); }
  }

  // cost_history (immutable ledger), preferred over listings/purchases
  const costHistoryByAsin = new Map<string, CostHistoryEntry[]>();
  const costHistoryBySku = new Map<string, CostHistoryEntry[]>();
  if (asins.length) {
    const rows = await inBatches(asins, 100, async b => {
      const { data } = await admin.from("cost_history")
        .select("id,asin,sku,cost,effective_date,recorded_at")
        .eq("user_id", userId).in("asin", b);
      return data as CostHistoryEntry[] | null;
    });
    for (const r of rows) {
      if (r.asin) (costHistoryByAsin.get(r.asin) || costHistoryByAsin.set(r.asin, []).get(r.asin)!).push(r);
    }
  }
  if (skus.length) {
    const rows = await inBatches(skus, 100, async b => {
      const { data } = await admin.from("cost_history")
        .select("id,asin,sku,cost,effective_date,recorded_at")
        .eq("user_id", userId).in("sku", b);
      return data as CostHistoryEntry[] | null;
    });
    for (const r of rows) {
      if (r.sku) (costHistoryBySku.get(r.sku) || costHistoryBySku.set(r.sku, []).get(r.sku)!).push(r);
    }
  }


  const overridesByAsin = new Map<string, OverrideEntry[]>();
  if (asins.length) {
    for (let i = 0; i < asins.length; i += 200) {
      const chunk = asins.slice(i, i + 200);
      const { data } = await admin.from("asin_cost_overrides")
        .select("asin, unit_cost, effective_from").eq("user_id", userId).in("asin", chunk)
        .order("effective_from", { ascending: true });
      for (const row of (data || []) as any[]) {
        const list = overridesByAsin.get(row.asin) || [];
        list.push({ effective_from: row.effective_from, unit_cost: Number(row.unit_cost) });
        overridesByAsin.set(row.asin, list);
      }
    }
  }
  const resolveOverride = (asin: string, orderDate: string | null) => {
    const t = overridesByAsin.get(asin);
    if (!t?.length || !orderDate) return 0;
    let chosen = 0;
    for (const e of t) { if (e.effective_from <= orderDate) chosen = e.unit_cost; else break; }
    return chosen > 0 ? chosen : 0;
  };

  return {
    resolve(o: { asin?: string|null; sku?: string|null; order_date?: string|null; unit_cost?: number|null; unit_cost_at_sale?: number|null; cost_locked?: boolean|null }): number {
      const asin = isValidAsin(o.asin) ? o.asin : null;
      const sku = o.sku || null;
      const od = o.order_date || null;
      const lockedSnap = Number(o.unit_cost_at_sale) || 0;
      if (o.cost_locked === true && lockedSnap > 0) return lockedSnap;
      const snap = Number(o.unit_cost) || 0;
      if (o.cost_locked === true && snap > 0) return snap;
      if (asin) { const ov = resolveOverride(asin, od); if (ov > 0) return ov; }
      if (sku) {
        const c = pickHistoricalCost(purchasesBySku.get(sku) || [], listingsBySku.get(sku) || [], costHistoryBySku.get(sku) || [], od); if (c?.unitCost) return c.unitCost;
      }
      if (asin) { const c = pickHistoricalCost(purchasesByAsin.get(asin) || [], listingsByAsin.get(asin) || [], costHistoryByAsin.get(asin) || [], od); if (c?.unitCost) return c.unitCost; }
      if (sku) {
        const ir = inventoryBySku.get(sku); if (ir) { const u = getInventoryUnitCost(ir); if (u && u > 0) return u; }
      }
      if (asin) { const r = inventoryByAsin.get(asin); if (r) { const u = getInventoryUnitCost(r); if (u && u > 0) return u; } }
      return 0;
    },
  };
}

// ───────────── Fallback unit-price context (port of buildUsdFallbackContext) ─────────────
//
// For every ASIN in the window we build a USD per-unit price ladder:
//   1) period-window average (computed live from confirmed rows in the window)
//   2) 90-day same-ASIN historical USD unit price (sales_orders, strict)
//   3) created_listings.price OR inventory.{price,my_price,amazon_price}
//
// Used only for rows that have NO confirmed price AND NO estimated_price.

async function buildFallbackUsdUnitMap(opts: {
  admin: any;
  userId: string;
  windowRows: SaleRow[];
  toUsd: (a: number, m: string | null | undefined) => number;
  rangeStart: string;
  rangeEnd: string;
}): Promise<(asin: string) => number> {
  const { admin, userId, windowRows, toUsd, rangeStart, rangeEnd } = opts;

  // (1) period-window same-ASIN USD average from confirmed rows
  const periodAvgByAsin = new Map<string, { sum: number; n: number }>();
  for (const r of windowRows) {
    const asin = String(r.asin || "").trim();
    if (!asin || !isValidAsin(asin)) continue;
    const qty = Math.max(1, num(r.quantity));
      const unitUsd = getConfirmedSalesOrderUnitRevenueUsd(r, toUsd);
    if (unitUsd <= 0) continue;
    const cur = periodAvgByAsin.get(asin) || { sum: 0, n: 0 };
    cur.sum += unitUsd; cur.n += 1;
    periodAvgByAsin.set(asin, cur);
  }
  const asinAvgUsd = new Map<string, number>();
  for (const [k, v] of periodAvgByAsin) if (v.n > 0) asinAvgUsd.set(k, v.sum / v.n);

  const asinSet = new Set<string>();
  for (const r of windowRows) {
    const a = String(r.asin || "").trim();
    if (a && isValidAsin(a)) asinSet.add(a);
  }
  const asinArr = Array.from(asinSet);

  // (2) historical same-ASIN USD unit price (90-day lookback, strict)
  const historicalUsdByAsin = new Map<string, number>();
  if (asinArr.length) {
    const historyStart = addDaysISO(rangeStart, -90);
    const histRows = await inBatches(asinArr, 100, async b => {
      const { data } = await admin.from("sales_orders")
        .select("asin, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, marketplace, price_source, price_calc_mode, price_confidence, order_date, updated_at")
        .eq("user_id", userId)
        .in("asin", b)
        .gte("order_date", historyStart)
        .lte("order_date", rangeEnd)
        .not("order_id", "like", "%-REFUND")
        .or("sold_price.gt.0,total_sale_amount.gt.0,estimated_price.gt.0")
        .order("order_date", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(500);
      return data as any[] | null;
    });
    for (const h of histRows) {
      const asinKey = String(h.asin || "").trim();
      if (!asinKey || historicalUsdByAsin.has(asinKey)) continue;
      if (isLowConfidencePending(h)) continue;
      const confirmedUnitUsd = getConfirmedSalesOrderUnitRevenueUsd(h, toUsd);
      const unitUsd = confirmedUnitUsd > 0 ? confirmedUnitUsd : toUsd(num(h.locked_est_price) || num(h.estimated_price), h.marketplace);
      if (unitUsd > 0) historicalUsdByAsin.set(asinKey, unitUsd);
    }
  }

  // (3) inventory / created_listings fallback
  const inventoryUsdByAsin = new Map<string, number>();
  if (asinArr.length) {
    const listingRows = await inBatches(asinArr, 100, async b => {
      const { data } = await admin.from("created_listings")
        .select("asin, price")
        .eq("user_id", userId).in("asin", b).gt("price", 0)
        .order("created_at", { ascending: false }).limit(500);
      return data as any[] | null;
    });
    for (const item of listingRows) {
      const asinKey = String(item.asin || "").trim();
      const priceUsd = Number(item.price || 0);
      if (asinKey && priceUsd > 0 && !inventoryUsdByAsin.has(asinKey)) inventoryUsdByAsin.set(asinKey, priceUsd);
    }
    const invRows = await inBatches(asinArr, 100, async b => {
      const { data } = await admin.from("inventory")
        .select("asin, price, my_price, amazon_price")
        .eq("user_id", userId).in("asin", b)
        .order("updated_at", { ascending: false }).limit(500);
      return data as any[] | null;
    });
    for (const item of invRows) {
      const asinKey = String(item.asin || "").trim();
      const priceUsd = Number(item.price || item.my_price || item.amazon_price || 0);
      if (asinKey && priceUsd > 0 && !inventoryUsdByAsin.has(asinKey)) inventoryUsdByAsin.set(asinKey, priceUsd);
    }
  }

  return (asin: string) =>
    asinAvgUsd.get(asin) || historicalUsdByAsin.get(asin) || inventoryUsdByAsin.get(asin) || 0;
}

// ───────────── Aggregation ─────────────

export type SummaryRow = {
  user_id: string;
  business_date: string;
  marketplace_id: string;
  // Confirmed-only (settled P&L truth)
  units: number;
  orders: number;
  revenue: number;
  fees: number;
  cost: number;
  profit: number;
  roi: number;
  refund_amount: number;
  refund_count: number;
  // With-fallback (matches Live Sales KPI)
  units_with_fallback: number;
  orders_with_fallback: number;
  revenue_with_fallback: number;
  fees_with_fallback: number;
  cost_with_fallback: number;
  profit_with_fallback: number;
  pending_estimate_revenue: number;
  // Confidence breakdown
  confirmed_count: number;
  high_confidence_count: number;
  low_confidence_count: number;
  fallback_count: number;
};

export type PerAsinRow = {
  user_id: string;
  asin: string;
  business_date: string;
  marketplace: string;
  units: number;
  orders: number;
  revenue_usd: number;                // confirmed-only
  units_with_fallback: number;
  revenue_with_fallback_usd: number;  // matches UI
  pending_estimate_usd: number;
  summary_version: number;
};

async function fetchSalesOrders(admin: any, userId: string, startISO: string, endISO: string): Promise<SaleRow[]> {
  const rows: SaleRow[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("sales_orders")
      // unit_cost_at_sale + cost_locked are REQUIRED by the COGS resolver's
      // step 1. They were missing until 2026-09-15, so resolve() never saw a
      // locked snapshot and re-derived every sale's cost from purchase history
      // -- the server summaries silently disagreed with P&L and the browser
      // resolver, which both honour locked costs. It became unmissable with
      // COG on Record, which is written into exactly these columns.
      .select("id, order_id, asin, sku, seller_sku, title, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, marketplace, is_cancelled, order_status, order_type, price_source, price_calc_mode, price_confidence, needs_price_enrich, price_enrich_status, referral_fee, fba_fee, closing_fee, total_fees, shipping_label_fee, unit_cost, unit_cost_at_sale, cost_locked, total_cost, fulfillment_channel, order_date, fees_invalid, promotion_discount, promotion_discount_native, promotion_discount_currency")
      .eq("user_id", userId)
      .gte("order_date", startISO).lte("order_date", endISO)
      .not("order_id", "like", "%-REFUND")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as SaleRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchRefundsByDay(admin: any, userId: string, startISO: string, endISO: string): Promise<Map<string, { amount: number; count: number }>> {
  // Refund math routed through the canonical shared helper to eliminate the
  // formula drift documented in .lovable/architecture-audit.md §1.2.
  // Uses `simple` mode so the cached `live_sales_summary` rows produced by
  // this writer remain bit-identical to the legacy 6-column output. Once
  // the cache has been rebuilt under `full` mode, this can switch over.
  const { computeNetRefundFromFecRows } = await import("./refund-math.ts");
  const out = new Map<string, { amount: number; count: number }>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("financial_events_cache")
      .select("event_date, refunds, promotional_rebate_refunds, shipping_credit_refunds, shipping_chargeback_refund, gift_wrap_credit_refunds, referral_fees, amazon_order_id")
      .eq("user_id", userId).eq("event_type", "refund")
      .gte("event_date", startISO).lte("event_date", endISO)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    // Group rows by day, then run canonical helper per-day for bit-identical
    // semantics (helper is event-level abs-then-sum, matching legacy).
    const byDay = new Map<string, any[]>();
    for (const r of data as any[]) {
      const day = String(r.event_date || "").slice(0, 10);
      if (!day) continue;
      const arr = byDay.get(day) || [];
      arr.push(r);
      byDay.set(day, arr);
    }
    for (const [day, rows] of byDay) {
      const canon = computeNetRefundFromFecRows(rows, 'simple');
      const cur = out.get(day) || { amount: 0, count: 0 };
      cur.amount += canon.refundCostNet;
      cur.count += canon.refundEventCount;
      out.set(day, cur);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}


// Phase 1 + Phase 2 dedup — exact port of LiveSales.tsx `dedupeDebugRows`.
function dedupePhase1Plus2(rows: SaleRow[]): SaleRow[] {
  const seen = new Set<string>();
  const phase1: SaleRow[] = [];
  for (const row of rows) {
    const key = `${String(row.order_id || "").trim()}::${String(row.asin || "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    phase1.push(row);
  }
  const byOrder = new Map<string, SaleRow[]>();
  for (const row of phase1) {
    const oid = String(row.order_id || "").trim();
    if (!oid) continue;
    (byOrder.get(oid) || byOrder.set(oid, []).get(oid)!).push(row);
  }
  const dropSet = new Set<SaleRow>();
  for (const [, group] of byOrder) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const qtyA = num(a.quantity) || 1, qtyB = num(b.quantity) || 1;
        const priceA = num(a.sold_price), priceB = num(b.sold_price);
        if (qtyA !== qtyB) continue;
        if (Math.abs(priceA - priceB) > 1.0) continue;
        const aReal = isRealAsin(a.asin), bReal = isRealAsin(b.asin);
        if (aReal && !bReal) dropSet.add(b);
        else if (bReal && !aReal) dropSet.add(a);
      }
    }
  }
  return phase1.filter(r => !dropSet.has(r));
}

export async function computeLiveSalesSummary(opts: {
  admin: any;
  userId: string;
  startISO: string;
  endISO: string;
}): Promise<{ daily: SummaryRow[]; todayByAsin: PerAsinRow[]; rowCount: number; computeMs: number }> {
  const { admin, userId, startISO, endISO } = opts;
  const t0 = Date.now();

  const fxRates = await loadFxRates(admin);
  const toUsd = makeToUsd(fxRates);

  const allRows = await fetchSalesOrders(admin, userId, startISO, endISO);

  // Cancel + replacement filter (matches LiveSales).
  const valid = allRows.filter(r => {
    if (r.is_cancelled === true) return false;
    const s = String(r.order_status || "").toLowerCase();
    if (s === "canceled" || s === "cancelled") return false;
    const t = String(r.order_type || "").toLowerCase();
    if (t.includes("replacement")) return false;
    return true;
  });

  // Confirmed path: Phase 1 dedup only (legacy summary contract).
  const seenC = new Set<string>();
  const dedupedConfirmed = valid.filter(r => {
    const k = `${String(r.order_id || "").trim()}::${String(r.asin || "").trim()}`;
    if (seenC.has(k)) return false;
    seenC.add(k); return true;
  });

  // Fallback path: Phase 1+2 dedup AND drop pure-placeholder rows (matches UI totals).
  const dedupedFallback = dedupePhase1Plus2(valid.filter(r => !isPendingPlaceholderRow(r)));

  // COGS resolver covers union of both row sets.
  const cogsResolver = await buildCogsResolver(admin, userId, dedupedFallback.map(r => ({
    asin: String(r.asin || "").trim(),
    sku: String(r.sku || r.seller_sku || "").trim(),
  })));

  // Fallback per-ASIN USD unit map (built from confirmed window rows + history + inventory).
  const fallbackUsdUnitFor = await buildFallbackUsdUnitMap({
    admin, userId, windowRows: dedupedConfirmed, toUsd, rangeStart: startISO, rangeEnd: endISO,
  });

  // Cached fee profile by ASIN+marketplace — UI applies this when per-row fee
  // columns are zero (typical for pending rows). Without it the writer
  // systematically undercounts fees on pending revenue.
  const feeAsinSet = new Set<string>();
  for (const r of dedupedFallback) {
    const a = String(r.asin || "").trim();
    if (a && isValidAsin(a)) feeAsinSet.add(a);
  }
  const feeByAsin = await loadAsinFeeCache(admin, userId, Array.from(feeAsinSet));

  // Phase 2: learned international fee multipliers (CA/MX/BR pending only).
  // Settled FEC fees + confirmed orders are NEVER touched. See
  // mem://features/sales/learned-intl-fee-multipliers-v1.
  const learnedFeeSettings: LearnedFeeSettings = await loadLearnedFeeSettings(admin, userId);
  const learnedFeeMultipliers: LearnedFeeMultiplierMap = await loadLearnedFeeMultipliers(admin, userId);
  const asinFeeMultipliers: AsinFeeMultiplierMap = await loadAsinFeeMultipliers(admin, userId);

  // UI fee calc (mirrors LiveSales.tsx fees/cost effect):
  //   feeBasisUsd = rawRevenueUsd || (estimated_price * qty in USD)
  //   feesUsd = getSalesOrderFeesUsd(row, feeBasisUsd)
  //   if feesUsd <= 0 && feeBasisUsd > 0 -> fall back to asin_fee_cache profile
  //   `fees_invalid` is NOT respected by the UI — neither does the writer.
  const computeFeesUsdLikeUi = (row: SaleRow, qty: number): number => {
    const rawRevenueUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    const feeBasisUsd = rawRevenueUsd > 0
      ? rawRevenueUsd
      : toUsd((num(row.locked_est_price) || num(row.estimated_price)) * qty, row.marketplace);
    let feesUsd = getSalesOrderFeesUsd(row, feeBasisUsd, toUsd);
    if (feesUsd <= 0 && feeBasisUsd > 0) {
      const f = feeByAsin.get(feeCacheKey(String(row.asin || ""), row.marketplace));
      if (f) feesUsd = getCachedFeesUsd(f, feeBasisUsd, qty, row.marketplace, toUsd);
    }
    // Learned multiplier (pending CA/MX/BR only — guarded inside helper).
    feesUsd = applyLearnedFeeMultiplier({
      row, rawFeesUsd: feesUsd, settings: learnedFeeSettings, multipliers: learnedFeeMultipliers,
      asinMultipliers: asinFeeMultipliers,
    });
    return feesUsd;
  };


  const today = getBusinessDateISO(new Date());
  const daily = new Map<string, SummaryRow>();
  const perAsinToday = new Map<string, PerAsinRow>();

  const blankDay = (bd: string, mp: string): SummaryRow => ({
    user_id: userId, business_date: bd, marketplace_id: mp,
    units: 0, orders: 0, revenue: 0, fees: 0, cost: 0, profit: 0, roi: 0,
    refund_amount: 0, refund_count: 0,
    units_with_fallback: 0, orders_with_fallback: 0,
    revenue_with_fallback: 0, fees_with_fallback: 0, cost_with_fallback: 0, profit_with_fallback: 0,
    pending_estimate_revenue: 0,
    confirmed_count: 0, high_confidence_count: 0, low_confidence_count: 0, fallback_count: 0,
  });

  // (A) Confirmed-only pass — drives revenue/fees/cost/units/orders columns.
  for (const row of dedupedConfirmed) {
    const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
    const bd = String(row.order_date || "").slice(0, 10);
    if (!bd) continue;
    const key = `${bd}|${mp}`;
    const cur = daily.get(key) || blankDay(bd, mp);

    const qty = Math.max(1, num(row.quantity));
    let revUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    if (revUsd <= 0) continue;            // confirmed-only — skip pending here

    // PROMOTIONAL REBATE: Amazon deducted this from payout (coupons, lightning
    // deals, automatic promos). Subtract from revenue so profit isn't overstated.
    const promoNative = Math.abs(num(row.promotion_discount));
    if (promoNative > 0) {
      const promoUsd = toUsd(promoNative, row.marketplace);
      revUsd = Math.max(0, revUsd - promoUsd);
    }
    const unitCost = cogsResolver.resolve({
      asin: String(row.asin || "").trim() || null,
      sku: String(row.sku || row.seller_sku || "").trim(),
      order_date: row.order_date || null,
      unit_cost: num(row.unit_cost),
      unit_cost_at_sale: row.unit_cost_at_sale ?? null,
      cost_locked: row.cost_locked ?? null,
    });
    const lineCost = unitCost * qty;
    const feesUsd = computeFeesUsdLikeUi(row, qty);

    cur.units += qty;
    cur.orders += 1;
    cur.revenue += revUsd;
    cur.fees += feesUsd;
    cur.cost += lineCost;
    daily.set(key, cur);

    if (bd === today) {
      const asin = String(row.asin || "").trim();
      if (asin) {
        const k2 = `${asin}|${mp}`;
        const r = perAsinToday.get(k2) || {
          user_id: userId, asin, business_date: bd, marketplace: mp,
          units: 0, orders: 0, revenue_usd: 0,
          units_with_fallback: 0, revenue_with_fallback_usd: 0, pending_estimate_usd: 0,
          summary_version: SUMMARY_VERSION,
        };
        r.units += qty;
        r.orders += 1;
        r.revenue_usd += revUsd;
        perAsinToday.set(k2, r);
      }
    }
  }

  // (B) With-fallback pass — drives _with_fallback / pending / confidence columns.
  for (const row of dedupedFallback) {
    const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
    const bd = String(row.order_date || "").slice(0, 10);
    if (!bd) continue;
    const key = `${bd}|${mp}`;
    const cur = daily.get(key) || blankDay(bd, mp);

    const qty = Math.max(1, num(row.quantity));
    const asinKey = String(row.asin || "").trim();

    // Revenue ladder (mirrors getRevenueUsdWithFallback)
    const confirmedUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    let revUsd = 0;
    let pendingUsd = 0;
    let bucket: "confirmed" | "high" | "low" | "fallback" = "fallback";
    if (confirmedUsd > 0) {
      revUsd = confirmedUsd;
      bucket = "confirmed";
    } else {
      const estNative = (num(row.locked_est_price) || num(row.estimated_price)) * qty;
      if (estNative > 0) {
        revUsd = toUsd(estNative, row.marketplace);
        pendingUsd = revUsd;
        bucket = isLowConfidencePending(row) ? "low" : "high";
      } else {
        const unitUsd = asinKey ? fallbackUsdUnitFor(asinKey) : 0;
        if (unitUsd > 0) {
          revUsd = unitUsd * qty;
          pendingUsd = revUsd;
          bucket = "fallback";
        }
      }
    }
    // PROMOTIONAL REBATE: subtract from fallback revenue + pending too.
    const promoNativeF = Math.abs(num(row.promotion_discount));
    if (promoNativeF > 0 && revUsd > 0) {
      const promoUsdF = toUsd(promoNativeF, row.marketplace);
      revUsd = Math.max(0, revUsd - promoUsdF);
      if (pendingUsd > 0) pendingUsd = Math.max(0, pendingUsd - promoUsdF);
    }
    if (revUsd <= 0) continue;

    // NOTE: fees + cost are NOT accumulated here. UI computes them in a
    // separate effect over a Phase-1-only dedup of `valid` (no placeholder
    // filter, no Phase 2). We mirror that in pass (C) below over
    // `dedupedConfirmed` so the row set matches exactly.

    cur.units_with_fallback += qty;
    cur.orders_with_fallback += 1;
    cur.revenue_with_fallback += revUsd;
    cur.pending_estimate_revenue += pendingUsd;
    if (bucket === "confirmed") cur.confirmed_count += 1;
    else if (bucket === "high") cur.high_confidence_count += 1;
    else if (bucket === "low") cur.low_confidence_count += 1;
    else cur.fallback_count += 1;
    daily.set(key, cur);

    if (bd === today && asinKey) {
      const k2 = `${asinKey}|${mp}`;
      const r = perAsinToday.get(k2) || {
        user_id: userId, asin: asinKey, business_date: bd, marketplace: mp,
        units: 0, orders: 0, revenue_usd: 0,
        units_with_fallback: 0, revenue_with_fallback_usd: 0, pending_estimate_usd: 0,
        summary_version: SUMMARY_VERSION,
      };
      r.units_with_fallback += qty;
      r.revenue_with_fallback_usd += revUsd;
      r.pending_estimate_usd += pendingUsd;
      perAsinToday.set(k2, r);
    }
  }

  // (C) Fees + cost (with-fallback path) — UI pipeline.
  // Iterates `dedupedConfirmed` (Phase 1 dedup of valid, NO placeholder filter,
  // NO Phase 2) to match LiveSales.tsx fees/cost effect exactly. This is why
  // the writer-only Phase 1+2 + placeholder-filter row set used for revenue
  // does NOT also drive fees: the UI uses two different row sets internally.
  for (const row of dedupedConfirmed) {
    const mp = String(row.marketplace || "US").trim().toUpperCase() || "US";
    const bd = String(row.order_date || "").slice(0, 10);
    if (!bd) continue;
    const key = `${bd}|${mp}`;
    const cur = daily.get(key) || blankDay(bd, mp);
    const qty = Math.max(1, num(row.quantity));
    const unitCost = cogsResolver.resolve({
      asin: String(row.asin || "").trim() || null,
      sku: String(row.sku || row.seller_sku || "").trim(),
      order_date: row.order_date || null,
      unit_cost: num(row.unit_cost),
      unit_cost_at_sale: row.unit_cost_at_sale ?? null,
      cost_locked: row.cost_locked ?? null,
    });
    cur.fees_with_fallback += computeFeesUsdLikeUi(row, qty);
    cur.cost_with_fallback += unitCost * qty;
    daily.set(key, cur);
  }

  // Refunds — same attachment policy as before.
  const refundsByDay = await fetchRefundsByDay(admin, userId, startISO, endISO);
  const dayMarketplaces = new Map<string, string[]>();
  for (const row of daily.values()) {
    const arr = dayMarketplaces.get(row.business_date) || [];
    arr.push(row.marketplace_id);
    dayMarketplaces.set(row.business_date, arr);
  }
  for (const [day, ref] of refundsByDay) {
    const mps = (dayMarketplaces.get(day) || ["US"]).sort();
    const target = mps[0];
    const k = `${day}|${target}`;
    const cur = daily.get(k) || blankDay(day, target);
    cur.refund_amount += ref.amount;
    cur.refund_count += ref.count;
    daily.set(k, cur);
  }

  // Finalize profit + roi + rounding.
  const dailyArr: SummaryRow[] = [];
  for (const r of daily.values()) {
    r.profit = r.revenue - r.fees - r.cost - r.refund_amount;
    r.profit_with_fallback = r.revenue_with_fallback - r.fees_with_fallback - r.cost_with_fallback - r.refund_amount;
    r.roi = r.cost > 0 ? r.profit / r.cost : 0;
    const round = (x: number) => Math.round(x * 100) / 100;
    r.revenue = round(r.revenue); r.fees = round(r.fees); r.cost = round(r.cost);
    r.refund_amount = round(r.refund_amount); r.profit = round(r.profit);
    r.revenue_with_fallback = round(r.revenue_with_fallback);
    r.fees_with_fallback = round(r.fees_with_fallback);
    r.cost_with_fallback = round(r.cost_with_fallback);
    r.profit_with_fallback = round(r.profit_with_fallback);
    r.pending_estimate_revenue = round(r.pending_estimate_revenue);
    r.roi = Math.round(r.roi * 10000) / 10000;
    dailyArr.push(r);
  }

  const perAsinArr: PerAsinRow[] = [];
  for (const r of perAsinToday.values()) {
    r.revenue_usd = Math.round(r.revenue_usd * 100) / 100;
    r.revenue_with_fallback_usd = Math.round(r.revenue_with_fallback_usd * 100) / 100;
    r.pending_estimate_usd = Math.round(r.pending_estimate_usd * 100) / 100;
    perAsinArr.push(r);
  }

  return {
    daily: dailyArr,
    todayByAsin: perAsinArr,
    rowCount: dedupedFallback.length,
    computeMs: Date.now() - t0,
  };
}
