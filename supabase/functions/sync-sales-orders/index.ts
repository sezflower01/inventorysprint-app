import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Low ROI alert threshold (percentage)
const LOW_ROI_THRESHOLD = 20;

// Global timezone for the current request - defaults to Pacific for backward compatibility
let USER_TIMEZONE = 'America/Los_Angeles';

// Global FX rates cache (fetched from fx_rates table) - live rates from database
// Format: { 'CAD': 1.38, 'MXN': 18.0, 'BRL': 5.4 } -> these are "1 USD = X foreign"
// So to convert CAD->USD, divide by rate: CAD / 1.38 = USD
let FX_RATES_CACHE: Record<string, number> = {};

// Module-level supabase client used ONLY by rate-limiter token-bucket gates
// inside helper functions like fetchOrderItems / fetchProductFees, where the
// request-scoped client isn't in scope. Always uses the service role.
let RATE_LIMIT_SUPABASE: any = null;
function getRateLimitClient() {
  if (RATE_LIMIT_SUPABASE) return RATE_LIMIT_SUPABASE;
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return null;
    RATE_LIMIT_SUPABASE = createClient(url, key);
    return RATE_LIMIT_SUPABASE;
  } catch {
    return null;
  }
}

/**
 * Inline BuyerInfo enrichment hook — fires backfill-customer-profiles for the
 * given user right after a sync completes so newly-inserted sales_orders rows
 * pick up buyer_id / buyer_email / buyer_name and populate customer_profiles
 * without waiting on the periodic safety cron.
 * Fire-and-forget: never blocks the sync response.
 */
function kickCustomerProfilesBackfill(userId: string | null | undefined, limit = 100) {
  if (!userId) return;
  try {
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/backfill-customer-profiles`;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const p = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ userId, limit, emitHealthIssues: true }),
    }).catch((e) => console.warn('[customer-profiles-inline] kick failed:', e?.message));
    const wu = (globalThis as any).EdgeRuntime?.waitUntil;
    if (wu) wu(p);
  } catch (e: any) {
    console.warn('[customer-profiles-inline] kick threw:', e?.message);
  }
}


type CurrencyConverter = (amount: number, currency: string) => number;

function readSignedMoney(component: any, convert?: CurrencyConverter): number {
  const money = component?.ChargeAmount
    || component?.FeeAmount
    || component?.PromotionAmount
    || component?.DirectPaymentAmount
    || component?.TaxWithheldAmount
    || component?.Amount;
  const raw = parseFloat(money?.CurrencyAmount || '0') || 0;
  const currency = money?.CurrencyCode || 'USD';
  return convert ? convert(raw, currency) : raw;
}

function sumSignedMoney(list: any[] | undefined, convert?: CurrencyConverter): number {
  return (list || []).reduce((total, component) => total + readSignedMoney(component, convert), 0);
}

/**
 * Refund amount must match Seller Central's Total column exactly.
 *
 * Seller Central Total = signed sum of every adjustment list on the refund item:
 *   - ItemChargeAdjustmentList:   Principal returned to buyer (debit), tax/shipping reversals
 *   - ItemFeeAdjustmentList:      Commission CREDITED back to seller (credit) MINUS
 *                                 RefundCommission admin fee Amazon keeps (debit, ~20%)
 *   - PromotionAdjustmentList:    Promotional rebates reversed
 *   - ShipmentFeeAdjustmentList:  Shipping fees reversed
 *   - DirectPaymentList:          Direct payments
 *   - ItemTaxWithheldList:        Marketplace facilitator tax reversals
 *
 * Amazon already encodes the sign of every entry (debit vs. credit to seller).
 * We must NOT filter by sign — doing so drops either the fee reversal OR the
 * refund administration fee and breaks parity with Seller Central.
 */
function calculateSellerCentralRefundAmount(item: any, convert?: CurrencyConverter): number {
  const signedTotal =
    sumSignedMoney(item?.ItemChargeAdjustmentList, convert) +
    sumSignedMoney(item?.ItemFeeAdjustmentList, convert) +
    sumSignedMoney(item?.PromotionAdjustmentList, convert) +
    sumSignedMoney(item?.ShipmentFeeAdjustmentList, convert) +
    sumSignedMoney(item?.DirectPaymentList, convert) +
    sumSignedMoney(item?.ItemTaxWithheldList, convert);

  return Math.abs(Number(signedTotal.toFixed(2)));
}

async function clearLegacyRefundMarkerFromSaleRow(supabase: any, userId: string, orderId: string): Promise<void> {
  const { data: saleRow } = await supabase
    .from('sales_orders')
    .select('id, refund_amount, refund_quantity')
    .eq('user_id', userId)
    .eq('order_id', orderId)
    .maybeSingle();

  if (saleRow && (Number(saleRow.refund_amount || 0) > 0 || Number(saleRow.refund_quantity || 0) > 0)) {
    await supabase
      .from('sales_orders')
      .update({
        refund_amount: 0,
        refund_quantity: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', saleRow.id);
    console.log(`💸 LEGACY_REFUND_MARKER_CLEARED: ${orderId}`);
  }
}

/**
 * Fetches live FX rates from the fx_rates table
 * Rates are stored as "1 USD = X foreign currency"
 * Returns a map of currency code -> rate (e.g., CAD -> 1.38)
 */
async function fetchFxRates(supabase: any): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase
      .from('fx_rates')
      .select('quote, rate')
      .eq('base', 'USD');
    
    if (error || !data) {
      console.warn('⚠️ FX_RATES_FETCH_ERROR:', error?.message || 'No data');
      // Return hardcoded fallbacks
      return { USD: 1, CAD: 1.38, MXN: 18.0, BRL: 5.4 };
    }
    
    const rates: Record<string, number> = { USD: 1 };
    for (const row of data) {
      rates[row.quote] = row.rate;
    }
    
    console.log('💱 FX_RATES_LOADED:', JSON.stringify(rates));
    return rates;
  } catch (err: any) {
    console.warn('⚠️ FX_RATES_EXCEPTION:', err?.message);
    return { USD: 1, CAD: 1.38, MXN: 18.0, BRL: 5.4 };
  }
}

/**
 * Convert foreign currency to USD using live FX rates
 * FX rates are stored as "1 USD = X foreign currency"
 * So to convert foreign -> USD: amount / rate
 */
function convertToUsd(amount: number, currencyCode: string, fxRates: Record<string, number>): number {
  if (currencyCode === 'USD' || !currencyCode) return amount;
  
  const rate = fxRates[currencyCode];
  if (!rate || rate === 0) {
    console.warn(`⚠️ FX_RATE_MISSING for ${currencyCode}, using 1:1`);
    return amount;
  }
  
  // Rate is "1 USD = X foreign", so divide to get USD
  const usdAmount = amount / rate;
  return Math.round(usdAmount * 100) / 100; // Round to cents
}

/**
 * AUDIT §14 (W2 FEC writer) — replaces three previously hardcoded
 * `CURRENCY_TO_USD = { BRL: 0.17, MXN: 0.05, CAD: 0.73 }` literals with live
 * rates from `fx_rates`. Format: "multiply native amount by this to get USD".
 *
 * Hardcoded BRL: 0.17 corresponded to 5.88 BRL/USD (stale) and caused FEC
 * settlement for BR orders to under-report revenue ~7-9% vs the FEC
 * `sales` aggregate. See sales_correction_history correction_type
 * 'audit_section_14_w2_fec_sales_mismatch'.
 *
 * Lazily refreshes FX_RATES_CACHE if it's empty (e.g. FEC-only invocations
 * that skip the top-level `fetchFxRates` load).
 */
async function getLiveCurrencyToUsd(supabase: any): Promise<Record<string, number>> {
  if (!FX_RATES_CACHE || Object.keys(FX_RATES_CACHE).length === 0) {
    try { FX_RATES_CACHE = await fetchFxRates(supabase); } catch { /* fall through to fallbacks */ }
  }
  const inv = (q: string, fallback: number): number => {
    const r = FX_RATES_CACHE?.[q];
    return r && r > 0 ? 1 / r : fallback;
  };
  // Fallbacks updated to current spot (~Jun 2026); still divergent over time,
  // but used only when fx_rates is completely unavailable.
  return {
    USD: 1,
    CAD: inv('CAD', 0.732),
    MXN: inv('MXN', 0.0571),
    BRL: inv('BRL', 0.186),
  };
}

// ================================================================
// CENTRALIZED UNIT COST RESOLVER — Contract A (LOCKED)
// See supabase/functions/_shared/cost-contract.ts for canonical helpers.
//
//   created_listings.cost   = TOTAL batch cost
//   created_listings.amount = UNIT cost
//   created_listings.units  = purchase quantity
//
//   inventory.cost   = UNIT cost
//   inventory.amount = TOTAL inventory value
//   inventory.units  = stock quantity
//
// This module mirrors getListingUnitCost / getInventoryUnitCost and tags
// each row with its source so we apply the right interpretation.
// ================================================================
import {
  getListingUnitCost,
  getInventoryUnitCost,
  getListingUnitCostSafe,
  getInventoryUnitCostSafe,
} from '../_shared/cost-contract.ts';
import { waitForApiToken, backoffMs } from '../_shared/rate-limiter.ts';
import { mergeOrderItemsByAsin } from '../_shared/order-items.ts';
import { HealthSignals } from '../_shared/health-signal.ts';
import { maybeFirePromoTripwire } from '../_shared/promo-tripwire.ts';
import { computeBbOwnEstimateFields, makeSellerIdCache } from '../_shared/bbOwnEstimate.ts';
import { computeNetRefundFromFecRows } from '../_shared/refund-math.ts';
import { getConfirmedSalesOrderRevenueUsd, getMarketplaceCurrency } from '../_shared/salesCurrencyGuard.ts';


type CostSource = 'listing' | 'inventory' | 'inventory_manual';

interface CostDataRow {
  asin: string;
  source: CostSource;
  cost: number | null;
  units: number | null;
  amount?: number | null;
}

type HistoricalCostResult = { unitCost: number | null; source: string | null };

function isValidCostAsin(asin?: string | null): asin is string {
  return !!asin && asin !== 'UNKNOWN' && asin !== 'PENDING';
}

function saleDayEndBoundary(orderDate?: string | null): string | null {
  if (!orderDate) return null;
  const d = new Date(`${String(orderDate).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function listingDay(row: any): string {
  return String(row?.date_created || row?.created_at || row?.updated_at || '').slice(0, 10);
}

function pickHistoricalPurchase(rows: any[] | undefined, orderDate?: string | null): any | null {
  const boundary = saleDayEndBoundary(orderDate);
  if (!boundary) return null;
  return (rows || [])
    .filter(r => Number(r?.unit_cost) > 0 && String(r?.purchase_date || '') < boundary)
    .sort((a, b) => {
      const ap = String(a?.purchase_date || ''), bp = String(b?.purchase_date || '');
      if (ap !== bp) return bp.localeCompare(ap);
      const ac = String(a?.created_at || ''), bc = String(b?.created_at || '');
      if (ac !== bc) return bc.localeCompare(ac);
      return String(b?.id || '').localeCompare(String(a?.id || ''));
    })[0] || null;
}

function historicalCostEventTs(row: any): string {
  return row?.purchase_date
    || (row?.date_created ? `${String(row.date_created).slice(0, 10)}T00:00:00.000Z` : '')
    || row?.created_at
    || '';
}

function pickHistoricalCost(rows: { purchases?: any[]; listings?: any[]; costHistory?: any[] }, orderDate?: string | null): HistoricalCostResult {
  const day = orderDate ? String(orderDate).slice(0, 10) : null;
  const boundary = saleDayEndBoundary(orderDate);
  const candidates: Array<{ unitCost: number; source: string; costTs: string; createdAt: string; tieRank: number; id: string }> = [];

  // Tier A — immutable cost_history (preferred)
  for (const row of rows.costHistory || []) {
    const unit = Number(row?.cost) || 0;
    if (unit <= 0) continue;
    const eff = String(row?.effective_date || '').slice(0, 10);
    const rec = String(row?.recorded_at || '').slice(0, 10);
    if (day && (!eff || eff > day)) continue;
    if (day && rec && rec > day) continue;
    candidates.push({ unitCost: unit, source: 'cost_history', costTs: `${eff}T00:00:00.000Z`, createdAt: String(row?.recorded_at || ''), tieRank: -1, id: String(row?.id || '') });
  }

  for (const row of rows.purchases || []) {
    const unit = Number(row?.unit_cost) || 0;
    if (unit <= 0 || (boundary && String(row?.purchase_date || '') >= boundary)) continue;
    candidates.push({ unitCost: unit, source: 'purchase_batch', costTs: historicalCostEventTs(row), createdAt: String(row?.created_at || ''), tieRank: 0, id: String(row?.id || '') });
  }

  // STRICT 3-clause guard on created_listings.
  for (const row of rows.listings || []) {
    const d = listingDay(row);
    if (day && (!d || d > day)) continue;
    const createdDay = String(row?.created_at || '').slice(0, 10);
    if (day && createdDay && createdDay > day) continue;
    const updatedDay = String(row?.updated_at || '').slice(0, 10);
    if (day && updatedDay && updatedDay > day) continue;
    const unit = getListingUnitCost({ cost: row.cost, amount: row.amount, units: row.units });
    if (unit === null || unit <= 0) continue;
    candidates.push({ unitCost: unit, source: 'created_listings_historical', costTs: historicalCostEventTs(row), createdAt: String(row?.created_at || ''), tieRank: 1, id: String(row?.id || '') });
  }

  const best = candidates.sort((a, b) => {
    if (a.costTs !== b.costTs) return b.costTs.localeCompare(a.costTs);
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.tieRank !== b.tieRank) return a.tieRank - b.tieRank;
    return b.id.localeCompare(a.id);
  })[0];

  return best ? { unitCost: Math.round(best.unitCost * 100) / 100, source: best.source } : { unitCost: null, source: null };
}

function pickHistoricalListing(rows: any[] | undefined, orderDate?: string | null): any | null {
  const day = orderDate ? String(orderDate).slice(0, 10) : null;
  const eligible = day ? (rows || []).filter(r => {
    const d = listingDay(r);
    return !!d && d <= day;
  }) : (rows || []);
  return eligible.sort((a, b) => {
    const ad = listingDay(a), bd = listingDay(b);
    if (ad !== bd) return bd.localeCompare(ad);
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  })[0] || null;
}

/**
 * Resolves the correct UNIT COST for an ASIN under Contract A.
 * NEVER falls back to raw `cost` from created_listings (that is the TOTAL).
 *
 * PRIORITY (highest first):
 *  1. inventory.unit_cost_manual = true  → inventory.cost (user-set, always wins)
 *  2. created_listings (Contract A: amount=UNIT, cost=TOTAL)
 *  3. inventory (Contract A: cost=UNIT)
 */
function resolveUnitCostForAsin(
  asin: string,
  costDataMap: Map<string, CostDataRow>
): number | null {
  const item = costDataMap.get(asin);
  if (!item) {
    console.log(`UNIT_COST_DEBUG: ${asin} -> NO data found`);
    return null;
  }

  // COST SANITY GUARD: refuse to derive unit_cost from rows with units<=0.
  // Such rows cannot be trusted (e.g. inventory{cost=237.49, units=0, amount=5.93}
  // would otherwise produce unit_cost=$237.49 and wreck ROI). Callers MUST
  // treat null as "cost pending / invalid" and set sales_orders.cost_invalid=true.
  const unit = item.source === 'listing'
    ? getListingUnitCostSafe(item)
    : getInventoryUnitCostSafe(item);

  if (unit === null) {
    console.log(`UNIT_COST_DEBUG: ${asin} -> SKIPPED (source=${item.source}, cost=${item.cost}, amount=${item.amount}, units=${item.units}) — units<=0 or no derivable unit cost. cost_invalid path.`);
    return null;
  }

  const rounded = Math.round(unit * 100) / 100;
  console.log(`UNIT_COST_DEBUG: ${asin} -> source=${item.source} unit=$${rounded.toFixed(2)} (cost=${item.cost}, amount=${item.amount}, units=${item.units})`);
  return rounded;

}

/**
 * Build a per-ASIN cost map. Manual inventory cost (unit_cost_manual=true)
 * always wins; otherwise created_listings overrides inventory.
 */
async function buildCostDataMap(supabase: any, userId: string, asins: string[]): Promise<Map<string, CostDataRow>> {
  if (asins.length === 0) return new Map();

  const [{ data: listingsData }, { data: inventoryData }] = await Promise.all([
    supabase
      .from('created_listings')
      .select('asin, cost, units, amount')
      .eq('user_id', userId)
      .in('asin', asins),
    supabase
      .from('inventory')
      .select('asin, cost, units, amount, unit_cost_manual')
      .eq('user_id', userId)
      .in('asin', asins)
  ]);

  const costDataMap = new Map<string, CostDataRow>();
  const manualAsins = new Set<string>();

  // Inventory first (lower priority unless manual).
  // CRITICAL: A manual inventory row with units<=0 is UNTRUSTWORTHY (the manual
  // edit happened without stock attached, so the "cost" cannot be sanity-checked).
  // We must NOT mark such ASINs as manual — otherwise we'd block the valid
  // created_listings fallback and flip every order to cost_invalid forever.
  inventoryData?.forEach((item: any) => {
    if (item.asin) {
      const hasUnits = Number(item.units) > 0;
      const isManual = item.unit_cost_manual === true && Number(item.cost) > 0 && hasUnits;
      if (isManual) manualAsins.add(item.asin);
      costDataMap.set(item.asin, {
        asin: item.asin,
        source: isManual ? 'inventory_manual' : 'inventory',
        cost: item.cost,
        units: item.units,
        amount: item.amount,
      });
    }
  });

  // created_listings overrides inventory unless a TRUSTED manual cost was set
  // (manualAsins only contains rows where units>0; see guard above).
  listingsData?.forEach((item: any) => {
    if (item.asin && !manualAsins.has(item.asin)) {
      costDataMap.set(item.asin, {
        asin: item.asin,
        source: 'listing',
        cost: item.cost,
        units: item.units,
        amount: item.amount,
      });
    }
  });


  console.log(`📚 buildCostDataMap: ${listingsData?.length || 0} listings, ${inventoryData?.length || 0} inventory -> ${costDataMap.size} unique ASINs`);
  return costDataMap;
}

async function fetchAllFinancialEventRefundRows(
  supabase: any,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = 1000;

  for (let from = 0; from < 50000; from += pageSize) {
    const { data, error } = await supabase
      .from('financial_events_cache')
      .select('amazon_order_id, asin, event_date, refunds, marketplace, promotional_rebate_refunds, shipping_credit_refunds, shipping_chargeback_refund, gift_wrap_credit_refunds, referral_fees, fba_fees, fba_customer_return_fees, restocking_fee, other_fees, digital_services_fee, reversal_reimbursement')
      .eq('user_id', userId)
      .eq('event_type', 'refund')
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .gt('refunds', 0)
      .order('event_date', { ascending: true })
      .order('amazon_order_id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Refund cache read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }

  return rows;
}

async function fetchSalesRowsByOrderIds(supabase: any, userId: string, orderIds: string[], selectCols: string): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];

  for (let i = 0; i < uniqueIds.length; i += 500) {
    const chunk = uniqueIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('sales_orders')
      .select(selectCols)
      .eq('user_id', userId)
      .in('order_id', chunk);

    if (error) throw new Error(`Sales order lookup failed: ${error.message}`);
    for (const row of data || []) {
      if (!result.has(row.order_id)) result.set(row.order_id, row);
    }
  }

  return result;
}

function isUsableAsin(val: string | null | undefined): boolean {
  if (!val || val === 'UNKNOWN') return false;
  if (val.length !== 10) return false;
  return /^B0[A-Z0-9]{8}$/.test(val) || /^\d{10}$/.test(val);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function syncRefundRowsFromFinancialEventsCache(
  supabase: any,
  userId: string,
  startDate: string,
  endDate: string,
  updateProgress?: (message: string, currentPage: number, totalPages: number, refundsFound: number, refundsApplied: number, status?: string) => Promise<void>,
): Promise<{ refundsFound: number; refundsApplied: number; refundsCreated: number }> {
  await updateProgress?.('Reading settled refund cache...', 0, 1, 0, 0);

  const refundRows = await fetchAllFinancialEventRefundRows(supabase, userId, startDate, endDate);
  const refundsFound = refundRows.length;
  await updateProgress?.(`Found ${refundsFound} settled refunds in financial cache...`, 0, 1, refundsFound, 0);

  if (refundRows.length === 0) {
    return { refundsFound: 0, refundsApplied: 0, refundsCreated: 0 };
  }

  const grouped = new Map<string, any[]>();
  for (const row of refundRows) {
    const orderId = row.amazon_order_id;
    if (!orderId) continue;
    if (!grouped.has(orderId)) grouped.set(orderId, []);
    grouped.get(orderId)!.push(row);
  }

  // PERMANENT PREVENTION: one canonical refund row per (order,asin,event_date).
  // Drop positional -REFUND-N suffixes entirely; key is fec_refund_key + DB unique index.
  const refundWork = Array.from(grouped.entries()).flatMap(([orderId, rows]) => rows.map((row, index) => {
    const refundOrderId = `${orderId}-REFUND`;
    return { orderId, refundOrderId, row, index };
  }));

  const [existingRefunds, originalOrders] = await Promise.all([
    fetchSalesRowsByOrderIds(supabase, userId, refundWork.map((item) => item.refundOrderId), 'id, order_id, asin, title, image_url, refund_amount'),
    fetchSalesRowsByOrderIds(supabase, userId, [...grouped.keys()], 'id, order_id, asin, title, image_url, marketplace'),
  ]);

  let refundsApplied = 0;
  let refundsCreated = 0;
  const existingPayloads: any[] = [];
  const newPayloads: any[] = [];

  for (let i = 0; i < refundWork.length; i++) {
    const { orderId, refundOrderId, row } = refundWork[i];
    const original = originalOrders.get(orderId);
    // CANONICAL refund formula — bit-identical to Mobile Live Sales display.
    // Previously stored only `row.refunds` (principal), which ignored the
    // referral-fee credit / admin retention / FBA fee credits and overstated
    // YTD US refunds by ~$769. See refund-math.ts for the single source of truth.
    const canonical = computeNetRefundFromFecRows([row], 'full');
    const amount = Number(canonical.refundCostNet.toFixed(2));
    const rawAsin = String(row.asin || '');
    const asin = isUsableAsin(rawAsin)
      ? rawAsin
      : (isUsableAsin(original?.asin) ? original.asin : 'UNKNOWN');
    const title = original?.title ? `[REFUND] ${String(original.title).replace(/^\[REFUND\]\s*/i, '')}` : '[REFUND]';
    const imageUrl = original?.image_url || null;
    const marketplace = row.marketplace || original?.marketplace || 'US';
    const existing = existingRefunds.get(refundOrderId);
    const payload = {
      user_id: userId,
      order_id: refundOrderId,
      asin: existing ? (existing.asin || asin) : asin,
      title,
      image_url: imageUrl,
      marketplace,
      quantity: 1,
      sold_price: -amount,
      total_sale_amount: -amount,
      referral_fee: 0,
      fba_fee: 0,
      closing_fee: 0,
      total_fees: 0,
      refund_quantity: 1,
      refund_amount: amount,
      order_date: row.event_date,
      status: 'pending',
      updated_at: new Date().toISOString(),
      fec_refund_key: `refund:${orderId}|${(existing ? (existing.asin || asin) : asin) || 'UNKNOWN'}|${row.event_date}`,
    };

    if (existing) {
      existingPayloads.push({ ...payload, id: existing.id });
    } else {
      newPayloads.push(payload);
    }
  }

  let processed = 0;
  const totalWork = existingPayloads.length + newPayloads.length;

  for (const chunk of chunkArray(existingPayloads, 250)) {
    const { error } = await supabase.from('sales_orders').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`Refund bulk update failed: ${error.message}`);
    refundsApplied += chunk.length;
    processed += chunk.length;
    await updateProgress?.(`Applying refunds ${processed}/${totalWork}...`, processed, totalWork, refundsFound, processed);
  }

  for (const chunk of chunkArray(newPayloads, 250)) {
    // Conflict on (user_id, order_id, asin), not fec_refund_key. sales_orders
    // carries BOTH unique constraints and ON CONFLICT guards only one; a refund
    // arriving with a different key does not conflict here, attempts a fresh
    // INSERT, and violates the asin index instead. See fetch-live-refunds
    // (commit 6a43a19) -- same defect, same reasoning, this is the second and
    // third instance of it.
    const { error } = await supabase.from('sales_orders').upsert(chunk, { onConflict: 'user_id,order_id,asin' });
    if (error) throw new Error(`Refund bulk insert failed: ${error.message}`);
    refundsCreated += chunk.length;
    processed += chunk.length;
    await updateProgress?.(`Applying refunds ${processed}/${totalWork}...`, processed, totalWork, refundsFound, processed);
  }

  if (processed === 0) {
    await updateProgress?.('No refund rows needed changes.', 1, 1, refundsFound, 0);
  }

  return { refundsFound, refundsApplied, refundsCreated };
}

// Main handler extracted from `serve` so we can run it in the background
// (EdgeRuntime.waitUntil) and avoid the 150s idle timeout. The client gets
// an immediate 202 Accepted; the actual sync continues server-side.
async function handleSyncRequest(req: Request): Promise<Response> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let requestBody: any = {};
    try {
      requestBody = await req.json();
    } catch {}

    // Set global timezone from request (defaults to Pacific for backward compatibility)
    USER_TIMEZONE = requestBody.timezone || 'America/Los_Angeles';
    console.log(`🌎 Using timezone: ${USER_TIMEZONE}`);

    // Fetch live FX rates from database (used for all currency conversions)
    FX_RATES_CACHE = await fetchFxRates(supabase);
    console.log(`💱 FX rates loaded: USD->CAD=${FX_RATES_CACHE.CAD || 'N/A'}, USD->MXN=${FX_RATES_CACHE.MXN || 'N/A'}, USD->BRL=${FX_RATES_CACHE.BRL || 'N/A'}`);

    const isAutomatedCall = requestBody.sync_all_users === true;

    // ================================================================
    // AUTOMATED SYNC (cron job) - minimal processing for all users
    // ================================================================
    if (isAutomatedCall) {
      console.log('🔄 Starting automated sales sync for all users at:', new Date().toISOString());

      const { data: authorizations, error: authFetchError } = await supabase
        .from('seller_authorizations')
        .select('user_id, seller_id, marketplace_id, refresh_token')
        .not('refresh_token', 'is', null);

      if (authFetchError || !authorizations || authorizations.length === 0) {
        return new Response(JSON.stringify({ success: true, message: 'No users to sync', syncedUsers: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // FAIRNESS + TIME BUDGET: this loop makes several SP-API calls (plus an
      // explicit 500ms sleep) per user with no bound on total user count —
      // with enough real users it runs well past this function's background
      // execution ceiling (~150s, see EdgeRuntime.waitUntil comment above)
      // and gets killed mid-loop. Whoever query order happened to put LAST
      // never got reached, so their sales_orders only ever refreshed when
      // they personally opened the app and triggered a direct sync — this
      // is the root cause of "Live Sales only updates when I check it".
      // Fix: process whoever's LEAST RECENTLY synced first (so the rotation
      // is fair across ticks — no one is perpetually starved), and stop
      // cleanly within budget instead of letting the platform kill us
      // mid-user-loop.
      const { data: syncStates } = await supabase
        .from('sales_sync_state')
        .select('user_id, last_orders_sync_at');
      const lastSyncByUser = new Map<string, number>(
        (syncStates || []).map((s: any) => [s.user_id, s.last_orders_sync_at ? new Date(s.last_orders_sync_at).getTime() : 0]),
      );
      const orderedAuthorizations = [...authorizations].sort((a: any, b: any) => {
        const aTime = lastSyncByUser.has(a.user_id) ? lastSyncByUser.get(a.user_id)! : 0;
        const bTime = lastSyncByUser.has(b.user_id) ? lastSyncByUser.get(b.user_id)! : 0;
        return aTime - bTime; // stalest (or never-synced) first
      });

      const AUTO_SYNC_START = Date.now();
      const AUTO_SYNC_TIME_BUDGET_MS = 100_000; // leaves margin under the ~150s background ceiling
      let skippedForBudget = 0;

      const results = { total: authorizations.length, successful: 0, failed: 0, errors: [] as any[] };

      for (const auth of orderedAuthorizations) {
        if (Date.now() - AUTO_SYNC_START > AUTO_SYNC_TIME_BUDGET_MS) {
          skippedForBudget = orderedAuthorizations.length - (results.successful + results.failed);
          console.log(`⏱️ AUTO_SYNC_BUDGET_EXHAUSTED: stopping after ${results.successful + results.failed}/${orderedAuthorizations.length} users; remaining ${skippedForBudget} will lead the next tick (stalest-first).`);
          break;
        }
        try {
          const accessToken = await getLWAAccessToken(auth.refresh_token);
          
          // Get incremental sync state
          const state = await getSyncState(supabase, auth.user_id);
          console.log(`🔄 User ${auth.user_id}: Orders sync from ${state.last_orders_sync_at.toISOString()}`);
          
          // Fetch orders incrementally
        const { orders, lastUpdateInBatch, failed } = await fetchOrdersIncremental(
            accessToken,
            auth.marketplace_id,
            state.last_orders_sync_at,
            500
          );
          console.log(`🔄 Fetched ${orders.length} orders for user ${auth.user_id}`);
          
          let newOrdersCount = 0;
          for (const order of orders) {
            const wasNew = await insertPendingOrderLite(supabase, auth.user_id, order, FX_RATES_CACHE);
            if (wasNew) newOrdersCount++;
          }
          
          // Update sync state
          if (lastUpdateInBatch) {
            const safeMarker = new Date(lastUpdateInBatch.getTime() - 60 * 1000);
            await saveSyncState(supabase, auth.user_id, { last_orders_sync_at: safeMarker });
          } else if (!failed && orders.length === 0) {
            // No orders returned — if the marker is more than 6 hours old, advance it
            // to prevent the marker from getting permanently stuck (e.g., SP-API returned
            // 0 results for a completed time window). Advance to 6 hours ago to stay safe.
            const markerAge = Date.now() - state.last_orders_sync_at.getTime();
            const SIX_HOURS = 6 * 60 * 60 * 1000;
            if (markerAge > SIX_HOURS) {
              const newMarker = new Date(Date.now() - SIX_HOURS);
              console.log(`🔄 MARKER_UNSTICK: No orders returned, marker was ${state.last_orders_sync_at.toISOString()}, advancing to ${newMarker.toISOString()}`);
              await saveSyncState(supabase, auth.user_id, { last_orders_sync_at: newMarker });
            }
          } else if (failed) {
            const markerAge = Date.now() - state.last_orders_sync_at.getTime();
            const TWELVE_HOURS = 12 * 60 * 60 * 1000;
            if (markerAge > TWELVE_HOURS) {
              const newMarker = new Date(Date.now() - 6 * 60 * 60 * 1000);
              console.log(`🔄 MARKER_RECOVERY_AFTER_FAILURE: Orders API failed and marker was stale (${state.last_orders_sync_at.toISOString()}); advancing to ${newMarker.toISOString()}`);
              await saveSyncState(supabase, auth.user_id, { last_orders_sync_at: newMarker });
            }
          }
          
          // Fetch financial events for settlement
          const now = new Date();
          const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

          // GUARD: if last_events_sync_at is stale (>24h old), Amazon's Finances API
          // will paginate days/weeks of events and timeout, throwing before the marker
          // is saved → marker stays stale forever and refunds stop landing.
          // Clamp the start window to 24h max; a separate nightly backfill handles gaps.
          const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
          const eventsStart = state.last_events_sync_at.getTime() < (now.getTime() - TWENTY_FOUR_HOURS)
            ? new Date(now.getTime() - TWENTY_FOUR_HOURS)
            : state.last_events_sync_at;
          if (eventsStart.getTime() !== state.last_events_sync_at.getTime()) {
            console.log(`🔧 EVENTS_MARKER_CLAMPED for ${auth.user_id}: ${state.last_events_sync_at.toISOString()} → ${eventsStart.toISOString()} (was >24h stale)`);
          }

          const financialEvents = await fetchFinancialEvents(
            accessToken,
            auth.marketplace_id,
            eventsStart.toISOString(),
            twoMinutesAgo.toISOString()
          );

          for (const event of financialEvents.slice(0, 200)) {
            await processFinancialEvent(supabase, auth.user_id, event, accessToken);
          }

          // Always re-scan recent refunds so newly Released refunds and corrected
          // Seller Central totals are upserted even if the incremental marker moved on.
          try {
            const recentRefundStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const recentRefundEvents = await fetchFinancialEventsForRefunds(
              accessToken,
              auth.marketplace_id,
              recentRefundStart.toISOString(),
              twoMinutesAgo.toISOString()
            );
            let recentRefundRows = 0;
            for (const refundEvent of recentRefundEvents.slice(0, 100)) {
              recentRefundRows += await applyRefundToOrder(supabase, auth.user_id, refundEvent, accessToken);
              await new Promise(resolve => setTimeout(resolve, 800));
            }
            console.log(`💸 AUTO_RECENT_REFUNDS: user=${auth.user_id} events=${recentRefundEvents.length} rows=${recentRefundRows}`);
          } catch (recentRefundError: any) {
            console.error(`💸 AUTO_RECENT_REFUNDS_ERROR for ${auth.user_id}:`, recentRefundError?.message || recentRefundError);
          }

          // Update events sync state
          await saveSyncState(supabase, auth.user_id, { last_events_sync_at: twoMinutesAgo });

      // ── SCHEDULING GUARD: yield to active repricer ──
      // Check if repricer dispatched in the last 2 minutes for this user
      let repricerActive = false;
      let earlyRefundsCount = 0;
      try {
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        const { count } = await supabase
          .from('repricer_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', auth.user_id)
          .eq('is_enabled', true)
          .gte('last_dispatch_at', twoMinAgo);
        repricerActive = (count || 0) > 0;
      } catch (_) { /* safe to ignore */ }

      if (repricerActive) {
        console.log(`⏸️ YIELDED_TO_REPRICER: Skipping enrichment for ${auth.user_id} — repricer dispatched within last 2 min`);
      } else {
        // Enrich pending ASINs (reduced batch for cron)
        await enrichPendingOrdersWithAsins(supabase, auth.user_id, accessToken, 5, FX_RATES_CACHE);

        // Auto-enrich from local tables (reduced batch for cron)
        await autoEnrichFromLocal(supabase, auth.user_id, accessToken, 50);

        // Check for early refunds via Orders API (detect refunds before Financial Events reports them)
        earlyRefundsCount = await detectEarlyRefundsViaOrdersApi(supabase, auth.user_id, accessToken, auth.marketplace_id, 5);
      }

          // Write sync trace for this user's auto-sync
          try {
            await supabase
              .from('sync_traces')
              .insert({
                user_id: auth.user_id,
                sync_type: 'unified',
                phase: 'auto_sync',
                status: 'completed',
                completed_at: new Date().toISOString(),
                rows_fetched: orders.length,
                rows_inserted: newOrdersCount,
                rows_updated: financialEvents.length,
                metadata: { earlyRefundsCount, yieldedToRepricer: repricerActive },
              });
          } catch (traceErr: any) {
            console.warn('[SYNC_TRACE] Failed:', traceErr?.message);
          }

          results.successful++;
          console.log(`✅ Auto-sync for ${auth.user_id}: ${newOrdersCount} new orders, ${earlyRefundsCount} early refunds detected`);
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (userError: any) {
          console.error(`❌ Sync failed for user ${auth.user_id}:`, userError.message);
          results.failed++;
          results.errors.push({ user_id: auth.user_id, error: userError.message });
          // This whole path runs via EdgeRuntime.waitUntil() — the cron
          // caller never sees this response, so a failure here was
          // completely invisible until now (sync_traces was ONLY written
          // on the success path below). Log it somewhere queryable.
          try {
            await supabase.from('sync_traces').insert({
              user_id: auth.user_id,
              sync_type: 'unified',
              phase: 'auto_sync',
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: String(userError?.message || userError).slice(0, 500),
            });
          } catch (traceErr: any) {
            console.warn('[SYNC_TRACE] Failed to log auto_sync failure:', traceErr?.message);
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: skippedForBudget > 0 ? 'Auto-sync stopped early (time budget) — remainder leads next tick' : 'Auto-sync completed',
        results,
        skippedForBudget,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // MANUAL MODE - Requires authentication OR internal service call
    // ================================================================
    const authHeader = req.headers.get('Authorization');
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const internalHeader = req.headers.get('x-internal-secret');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    
    // Check for internal service call (from enrich-pending-orders or other edge functions)
    // Internal calls pass user_id in body and use service role token
    const isInternalServiceCall = requestBody.user_id && requestBody.enrich_by_asin === true;
    
    // Check if Bearer token IS the service role key (internal call from auto-sync)
    const bearerToken = authHeader?.replace('Bearer ', '') || '';
    const isServiceRoleCall = bearerToken === serviceRoleKey && requestBody.user_id;
    
    let userId: string;
    
    if (isInternalServiceCall) {
      userId = requestBody.user_id;
      console.log(`🔧 INTERNAL_SERVICE_CALL: Processing enrich_by_asin for user ${userId}`);
    } else if (internalHeader && internalSecret && internalHeader === internalSecret && requestBody.user_id) {
      userId = requestBody.user_id;
      console.log(`🔧 INTERNAL_SECRET_CALL: Processing for user ${userId}`);
    } else if (isServiceRoleCall) {
      userId = requestBody.user_id;
      console.log(`🔧 SERVICE_ROLE_CALL: Processing for user ${userId}`);
    } else if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      
      // Try getClaims first (local, no DB call)
      let user: any = null;
      try {
        const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
        if (!claimsError && claimsData?.claims?.sub) {
          user = { id: claimsData.claims.sub };
        }
      } catch (_) { /* fall through */ }
      
      if (!user) {
        const { data: { user: fetchedUser }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !fetchedUser) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        user = fetchedUser;
      }
      userId = user.id;
    } else {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { startDate, endDate, marketplace } = requestBody;

    // Marketplace configuration - NA region uses same endpoint
    const MARKETPLACE_CONFIG: Record<string, { id: string; sellerIdKey: string }> = {
      'US': { id: 'ATVPDKIKX0DER', sellerIdKey: 'SPAPI_SELLER_ID' },
      'CA': { id: 'A2EUQ1WTGCTBG2', sellerIdKey: 'SPAPI_SELLER_ID_CA' },
      'MX': { id: 'A1AM78C64UM0Y8', sellerIdKey: 'SPAPI_SELLER_ID_MX' },
      'BR': { id: 'A2Q3Y263D00KWC', sellerIdKey: 'SPAPI_SELLER_ID_BR' },
    };

    // Determine which marketplace to use (default to US for backward compatibility)
    const requestedMarketplace = marketplace || 'US';
    const marketplaceConfig = MARKETPLACE_CONFIG[requestedMarketplace] || MARKETPLACE_CONFIG['US'];

    // Resolve SP-API credentials. Prefer per-user encrypted credentials in
    // user_spapi_credentials (decrypted via SECURITY DEFINER RPC). Fall back to
    // legacy global secrets if no row exists.
    let resolvedClientId: string | null = Deno.env.get('LWA_CLIENT_ID') || null;
    let resolvedClientSecret: string | null = Deno.env.get('LWA_CLIENT_SECRET') || null;
    let resolvedRefreshToken: string | null = Deno.env.get('SPAPI_REFRESH_TOKEN') || null;
    try {
      const { data: credRows } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
      const cred = (credRows as any[])?.[0];
      if (cred?.lwa_client_id) resolvedClientId = cred.lwa_client_id;
      if (cred?.lwa_client_secret) resolvedClientSecret = cred.lwa_client_secret;
      if (cred?.refresh_token) resolvedRefreshToken = cred.refresh_token;
    } catch (e) {
      console.warn('[SPAPI_CREDS] DB lookup failed, using env fallback:', (e as any)?.message);
    }

    const globalRefreshToken = resolvedRefreshToken;
    const globalMarketplaceId = marketplaceConfig.id;
    const globalSellerId = Deno.env.get(marketplaceConfig.sellerIdKey);

    console.log(`🌎 MARKETPLACE: ${requestedMarketplace} -> ID: ${globalMarketplaceId}, SellerID key: ${marketplaceConfig.sellerIdKey}`);

    if (!globalRefreshToken) {
      return new Response(JSON.stringify({ error: 'No SP-API refresh token. Save credentials at /tools/amazon-connection or set SPAPI_REFRESH_TOKEN.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!globalSellerId) {
      return new Response(JSON.stringify({ error: `Seller ID not configured for marketplace ${requestedMarketplace}. Please add ${marketplaceConfig.sellerIdKey} secret.` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create authData object for compatibility with existing code
    const authData = {
      refresh_token: globalRefreshToken,
      marketplace_id: globalMarketplaceId,
      seller_id: globalSellerId,
    };

    const accessToken = await getLWAAccessToken(
      authData.refresh_token,
      resolvedClientId || undefined,
      resolvedClientSecret || undefined,
    );

    // ================================================================
    // RESET REFUNDS - Fix accumulated refunds bug
    // ================================================================
    if (requestBody.reset_refunds === true) {
      console.log(`🔄 RESET_REFUNDS: Resetting all refund data for user ${userId}`);
      
      await supabase
        .from('sales_orders')
        .update({
          refund_quantity: 0,
          refund_amount: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .or('refund_quantity.gt.0,refund_amount.gt.0');
      
      return new Response(JSON.stringify({
        success: true,
        message: 'All refund data has been reset. Run Sync to re-apply refunds correctly.',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // ENRICH PENDING FEES - Fetch SP-API fees for all pending orders (for loading screen)
    // ================================================================
    if (requestBody.enrich_pending_fees === true) {
      console.log(`💰 ENRICH_PENDING_FEES: Starting fee enrichment for user ${userId}`);
      
      const targetDate = requestBody.target_date || getPacificDateString(new Date().toISOString());
      
      // Get all pending orders for target date that need fee enrichment
      // (either have $0 fees or have estimated fees that need SP-API lookup)
      const { data: pendingOrders, error: fetchError } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, sold_price, quantity, referral_fee, fba_fee, total_fees, unit_cost, status, fulfillment_channel')
        .eq('user_id', userId)
        .eq('order_date', targetDate)
        .eq('status', 'pending')
        .neq('asin', 'PENDING')
        .neq('asin', 'UNKNOWN')
        .not('asin', 'is', null)
        .gt('sold_price', 0)
        .order('created_at', { ascending: false })
        .limit(50);
      
      if (fetchError) {
        console.error('ENRICH_PENDING_FEES_ERROR:', fetchError.message);
        return new Response(JSON.stringify({ error: fetchError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (!pendingOrders || pendingOrders.length === 0) {
        console.log('ENRICH_PENDING_FEES: No orders need fee enrichment');
        return new Response(JSON.stringify({
          success: true,
          message: 'No orders need fee enrichment',
          enrichedCount: 0,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`💰 ENRICH_PENDING_FEES: Found ${pendingOrders.length} orders to enrich`);
      
      let enrichedCount = 0;
      let failedCount = 0;
      const pfSummaryFees: number[] = [];
      const pfSummaryRois: number[] = [];
      
      for (const order of pendingOrders) {
        try {
          const priceToUse = order.sold_price || 0;
          if (priceToUse <= 0 || !order.asin) continue;
          
          // Fetch actual fees from SP-API
          // Detect FBM orders: use IsAmazonFulfilled=false for FBM
          const isFbmOrder = order.fulfillment_channel === 'MFN';
          const apiFees = await fetchProductFees(accessToken, order.asin, priceToUse, 'ATVPDKIKX0DER', {}, undefined, !isFbmOrder);
          
          if (apiFees) {
            const qty = order.quantity || 1;
            let referralFee: number, fbaFee: number, closingFee: number, totalFees: number;
            
            if (isFbmOrder) {
              // FBM: Bundle ALL fees into fba_fee (FBA/FBM column), zero referral/closing
              const totalFbmFees = (apiFees.referralFee + apiFees.fbaFee + apiFees.closingFee) * qty;
              referralFee = 0;
              fbaFee = totalFbmFees;
              closingFee = 0;
              totalFees = totalFbmFees;
            } else {
              referralFee = apiFees.referralFee * qty;
              fbaFee = apiFees.fbaFee * qty;
              closingFee = apiFees.closingFee * qty;
              totalFees = apiFees.totalFees * qty;
            }
            
            // Calculate ROI
            const totalSale = priceToUse * qty;
            const unitCost = order.unit_cost || 0;
            const totalCost = unitCost * qty;
            let roi = 0;
            if (totalCost > 0) {
              const netProfit = totalSale - totalFees - totalCost;
              roi = Math.round((netProfit / totalCost) * 1000) / 10;
            }
            
            await supabase
              .from('sales_orders')
              .update({
                referral_fee: referralFee,
                fba_fee: fbaFee,
                closing_fee: closingFee,
                total_fees: totalFees,
                total_cost: totalCost,
                roi: roi,
                updated_at: new Date().toISOString(),
              })
              .eq('id', order.id);
            
            enrichedCount++;
            pfSummaryFees.push(totalFees);
            pfSummaryRois.push(roi);
          } else {
            failedCount++;
          }
          
          // Rate limit: 200ms between SP-API calls
          await new Promise(resolve => setTimeout(resolve, 200));
          
        } catch (err: any) {
          console.error(`ENRICH_ERROR: ${order.order_id}:`, err?.message || err);
          failedCount++;
        }
      }
      
      // Summary log instead of per-order
      const pfAvgFees = pfSummaryFees.length > 0 ? (pfSummaryFees.reduce((a, b) => a + b, 0) / pfSummaryFees.length) : 0;
      const pfAvgRoi = pfSummaryRois.length > 0 ? (pfSummaryRois.reduce((a, b) => a + b, 0) / pfSummaryRois.length) : 0;
      console.log(`📊 ENRICH_PENDING_SUMMARY: date=${requestBody.target_date || 'today'} | orders=${enrichedCount}/${pendingOrders.length} | avg_fees=$${pfAvgFees.toFixed(2)} | avg_roi=${pfAvgRoi.toFixed(1)}% | failed=${failedCount}`);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Enriched ${enrichedCount} orders with SP-API fees`,
        enrichedCount,
        failedCount,
        totalProcessed: pendingOrders.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // FIX REPLACEMENT - Convert a misclassified StandardOrder to Replacement
    // Used when Amazon reports a replacement as StandardOrder with $0 revenue
    // ================================================================
    if (requestBody.fix_replacement === true && requestBody.order_id) {
      const targetOrderId = requestBody.order_id;
      const targetAsin = requestBody.target_asin || requestBody.asin;
      console.log(`🔧 FIX_REPLACEMENT: Converting order ${targetOrderId} (ASIN: ${targetAsin}) to Replacement`);
      
      const updateFields: any = {
        order_type: 'Replacement',
        is_replacement: true,
        replacement_reason: 'manual_fix_replacement',
        sold_price: 0,
        item_price: 0,
        shipping_price: 0,
        total_sale_amount: 0,
        referral_fee: 0,
        closing_fee: 0,
        total_fees: 0,
        price_source: 'replacement_detected',
        price_confidence: 'REPLACEMENT_ZERO_REVENUE',
        needs_price_enrich: false,
        needs_fee_enrich: false,
        price_enrich_status: 'enriched',
      };
      
      let query = supabase
        .from('sales_orders')
        .update(updateFields)
        .eq('order_id', targetOrderId)
        .eq('user_id', userId);
      
      if (targetAsin) {
        query = query.eq('asin', targetAsin);
      }
      
      const { data: updated, error: updateErr } = await query.select('order_id, asin, order_type, sold_price');
      
      if (updateErr) {
        console.error('FIX_REPLACEMENT error:', updateErr.message);
        return new Response(JSON.stringify({ error: updateErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`🔧 FIX_REPLACEMENT: Updated ${updated?.length || 0} rows for order ${targetOrderId}`);
      return new Response(JSON.stringify({
        success: true,
        message: `Converted order ${targetOrderId} to Replacement`,
        updated: updated?.length || 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Used by "Refresh Selected" button to enrich fees ASIN by ASIN
    // ================================================================
    // Accept both target_asin and asin for backward compatibility
    // NEW: force_price_update flag allows manual sync to overwrite stale prices
    if (requestBody.enrich_by_asin === true && (requestBody.target_asin || requestBody.asin)) {
      const targetAsin = requestBody.target_asin || requestBody.asin;
      const forcePriceUpdate = requestBody.force_price_update === true;
      console.log(`💰 ENRICH_BY_ASIN: Starting fee enrichment for ASIN ${targetAsin}, user ${userId}, forcePriceUpdate=${forcePriceUpdate}`);
      
      // Get all orders for this ASIN that need fee enrichment
      // UPDATED: Include marketplace in select for marketplace-specific fees
      let ordersQuery = supabase
        .from('sales_orders')
        .select('id, order_id, asin, sold_price, quantity, referral_fee, fba_fee, closing_fee, total_fees, unit_cost, unit_cost_at_sale, cost_source_at_sale, cost_locked, total_cost, roi, status, fees_source, fees_missing, order_status, order_date, price_source, marketplace, estimated_price, fulfillment_channel, seller_sku, sku, created_at')
        .eq('user_id', userId)
        .eq('asin', targetAsin)
        .neq('asin', 'PENDING')
        .neq('asin', 'UNKNOWN');
      
      // If NOT forcing, only get orders that need fee enrichment
      // If forcing, get ALL pending orders so we can update their prices
      if (!forcePriceUpdate) {
        ordersQuery = ordersQuery.or('total_fees.eq.0,fees_source.is.null,fees_source.eq.unavailable,fees_source.eq.estimated');
      } else {
        // For forced updates, target all pending/unsettled orders (not refunds, not settled)
        ordersQuery = ordersQuery.or('order_status.eq.Pending,order_status.eq.Unshipped,order_status.eq.PartiallyShipped,order_status.eq.Shipped,order_status.is.null');
      }
      
      const { data: ordersForAsin, error: fetchError } = await ordersQuery
        .order('order_date', { ascending: false })
        .limit(100);
      
      if (fetchError) {
        console.error('ENRICH_BY_ASIN_ERROR:', fetchError.message);
        return new Response(JSON.stringify({ error: fetchError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (!ordersForAsin || ordersForAsin.length === 0) {
        console.log(`ENRICH_BY_ASIN: No orders found for ${targetAsin}`);
        return new Response(JSON.stringify({
          success: true,
          message: `No orders found for ${targetAsin}`,
          enrichedCount: 0,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`💰 ENRICH_BY_ASIN: Found ${ordersForAsin.length} orders for ${targetAsin} to process (forcePriceUpdate=${forcePriceUpdate})`);

      // AUTHORITATIVE FIX (2026-07-14): get an access token so we can fetch each
      // order's REAL Amazon PurchaseDate (GetOrder — basic order metadata, always
      // available even while Pending) to anchor the repricer_price_actions lookup
      // below. This is NOT used to fetch price — Amazon's GetOrderItems does not
      // return pricing for Pending orders, so PurchaseDate is the only thing worth
      // fetching live here. If auth is unavailable, we degrade gracefully to using
      // order.created_at (discovery time) as the anchor instead.
      let enrichAccessToken: string | null = null;
      if (forcePriceUpdate) {
        try {
          const { data: enrichAuths } = await supabase
            .from('seller_authorizations')
            .select('refresh_token, marketplace_id')
            .eq('user_id', userId);
          const enrichAuth = enrichAuths?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || enrichAuths?.[0];
          if (enrichAuth?.refresh_token) {
            enrichAccessToken = await getLWAAccessToken(enrichAuth.refresh_token);
          }
        } catch (authErr) {
          console.warn(`⚠️ ENRICH_BY_ASIN: Could not get access token for PurchaseDate lookup: ${(authErr as Error).message}`);
        }
      }

      // Build cost data map so we can resolve unit_cost if missing
      const enrichCostDataMap = await buildCostDataMap(supabase, userId, [targetAsin]);
      const resolvedUnitCost = resolveUnitCostForAsin(targetAsin, enrichCostDataMap);
      console.log(`💰 ENRICH_BY_ASIN: Resolved unit cost for ${targetAsin} = $${resolvedUnitCost?.toFixed(2) ?? 'null'}`);

      const { data: historicalListingRows } = await supabase
        .from('created_listings')
        .select('id, asin, sku, cost, units, amount, date_created, created_at, updated_at')
        .eq('user_id', userId)
        .eq('asin', targetAsin);
      const listingById = new Map((historicalListingRows || []).map((r: any) => [String(r.id), r]));
      const listingIds = [...listingById.keys()];
      const historicalPurchaseRows: any[] = [];
      for (let i = 0; i < listingIds.length; i += 100) {
        const { data: purchaseRows } = await supabase
          .from('created_listing_purchases')
          .select('id, listing_id, unit_cost, purchase_date, created_at')
          .eq('user_id', userId)
          .in('listing_id', listingIds.slice(i, i + 100))
          .gt('unit_cost', 0);
        for (const p of purchaseRows || []) {
          const listing = listingById.get(String(p.listing_id));
          if (listing) historicalPurchaseRows.push({ ...p, asin: listing.asin, sku: listing.sku });
        }
      }

      // cost_history rows for this ASIN (immutable ledger)
      const { data: historicalCostHistoryRows } = await supabase
        .from('cost_history')
        .select('id, asin, sku, cost, effective_date, recorded_at')
        .eq('user_id', userId)
        .eq('asin', targetAsin);

      const resolveSaleTimeCost = (order: any): HistoricalCostResult => {
        const locked = Number(order.unit_cost_at_sale || 0) || 0;
        if (order.cost_locked === true && locked > 0) return { unitCost: Math.round(locked * 100) / 100, source: order.cost_source_at_sale || 'sales_orders_locked' };
        const legacyLocked = Number(order.unit_cost || 0) || 0;
        if (order.cost_locked === true && legacyLocked > 0) return { unitCost: Math.round(legacyLocked * 100) / 100, source: order.cost_source_at_sale || 'sales_orders_locked_legacy' };
        const sku = order.seller_sku || order.sku || null;
        const purchases = historicalPurchaseRows.filter((r: any) => (!sku || r.sku === sku) || r.asin === targetAsin);
        const skuCost = sku ? pickHistoricalCost({
          purchases: purchases.filter((r: any) => r.sku === sku),
          listings: (historicalListingRows || []).filter((r: any) => r.sku === sku),
          costHistory: (historicalCostHistoryRows || []).filter((r: any) => r.sku === sku),
        }, order.order_date) : { unitCost: null, source: null };
        if (skuCost.unitCost !== null && skuCost.unitCost > 0) return { unitCost: skuCost.unitCost, source: `${skuCost.source}:sku` };
        const asinCost = pickHistoricalCost({
          purchases: purchases.filter((r: any) => r.asin === targetAsin),
          listings: historicalListingRows || [],
          costHistory: historicalCostHistoryRows || [],
        }, order.order_date);
        if (asinCost.unitCost !== null && asinCost.unitCost > 0) return { unitCost: asinCost.unitCost, source: `${asinCost.source}:asin` };
        return resolvedUnitCost && resolvedUnitCost > 0
          ? { unitCost: Math.round(resolvedUnitCost * 100) / 100, source: 'fallback_current_inventory' }
          : { unitCost: null, source: null };
      };
      
      let enrichedCount = 0;
      let failedCount = 0;
      // ENRICH_SUMMARY tracking
      let summaryFees: number[] = [];
      let summaryRois: number[] = [];
      let summaryPrices: number[] = [];
      let summaryRefunds = 0;
      let summaryMultiUnit = 0;
      let summaryCostFixes = 0;
      let summaryPriceUpdates = 0;
      const summaryExceptions: string[] = [];
      
      // MARKETPLACE-SPECIFIC FEE LOOKUP
      // Map marketplace names to marketplace IDs
      const MARKETPLACE_NAME_TO_ID: Record<string, string> = {
        'US': 'ATVPDKIKX0DER',
        'USA': 'ATVPDKIKX0DER',
        'United States': 'ATVPDKIKX0DER',
        'CA': 'A2EUQ1WTGCTBG2',
        'Canada': 'A2EUQ1WTGCTBG2',
        'MX': 'A1AM78C64UM0Y8',
        'Mexico': 'A1AM78C64UM0Y8',
        'BR': 'A2Q3Y263D00KWC',
        'Brazil': 'A2Q3Y263D00KWC',
      };
      
      // Group orders by marketplace
      const ordersByMarketplace = new Map<string, typeof ordersForAsin>();
      for (const order of ordersForAsin) {
        const mp = order.marketplace || 'US';
        const mpId = MARKETPLACE_NAME_TO_ID[mp] || MARKETPLACE_NAME_TO_ID['US'];
        if (!ordersByMarketplace.has(mpId)) {
          ordersByMarketplace.set(mpId, []);
        }
        ordersByMarketplace.get(mpId)!.push(order);
      }
      
      console.log(`💰 ENRICH_BY_ASIN: Orders by marketplace:`, [...ordersByMarketplace.entries()].map(([k, v]) => `${k}=${v.length}`).join(', '));
      
      // Fetch fees ONCE per marketplace (not once per order) for efficiency
      const feesByMarketplace = new Map<string, { referralFee: number; fbaFee: number; closingFee: number; totalFees: number; feeSource: string; referralRate: number }>();
      
      // Step 1: Always fetch fresh inventory price (authoritative source for current listing - USD)
      // MULTI-SKU FIX: Fetch ALL inventory rows for this ASIN (there may be multiple SKUs)
      const [{ data: invRows }, { data: listingRows }] = await Promise.all([
        supabase
          .from('inventory')
          .select('sku, amazon_price, price, my_price')
          .eq('user_id', userId)
          .eq('asin', targetAsin),
        supabase
          .from('created_listings')
          .select('sku, price')
          .eq('user_id', userId)
          .eq('asin', targetAsin)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);
      
      // Build a SKU→price map for multi-SKU resolution
      const skuPriceMap = new Map<string, number>();
      let fallbackInventoryPrice = 0;
      for (const row of (invRows || [])) {
        const p = row.my_price || row.price || 0;
        if (p > 0) {
          skuPriceMap.set(row.sku, p);
          if (!fallbackInventoryPrice) fallbackInventoryPrice = p;
        }
      }

      // If the inventory row has no price yet (common for newly-created / inbound
      // items), fall back to the user's own created_listing price. This is the
      // same seller-derived pending price behavior users expect for CA/MX/BR rows.
      for (const row of (listingRows || [])) {
        const p = Number(row.price || 0);
        const sku = String(row.sku || '').trim();
        if (p > 0 && sku && !skuPriceMap.has(sku)) {
          skuPriceMap.set(sku, p);
        }
        if (p > 0 && !fallbackInventoryPrice) fallbackInventoryPrice = p;
      }
      
      // Helper to resolve inventory price for a specific order's SKU
      const getInventoryPriceForSku = (orderSku: string | null): number => {
        if (orderSku && skuPriceMap.has(orderSku)) return skuPriceMap.get(orderSku)!;
        // Fallback to first available price
        return fallbackInventoryPrice;
      };
      
      const freshInventoryPrice = fallbackInventoryPrice;
      console.log(`💰 ENRICH_BY_ASIN: Fresh seller prices for ${targetAsin}: skuMap=${JSON.stringify([...skuPriceMap.entries()])}, fallback=$${freshInventoryPrice} USD`);
      
      // Process each marketplace
      for (const [marketplaceId, marketplaceOrders] of ordersByMarketplace.entries()) {
        let priceToUse = 0;
        let priceInLocalCurrency = 0; // The actual local currency price (e.g., MXN, CAD)
        let priceSource = 'none';
        const isNonUs = marketplaceId !== 'ATVPDKIKX0DER';
        const marketplaceShortName = marketplaceId === 'ATVPDKIKX0DER' ? 'US' : 
                                     marketplaceId === 'A2EUQ1WTGCTBG2' ? 'CA' :
                                     marketplaceId === 'A1AM78C64UM0Y8' ? 'MX' :
                                     marketplaceId === 'A2Q3Y263D00KWC' ? 'BR' : 'US';
        
        // Marketplace to currency mapping
        const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
          'ATVPDKIKX0DER': 'USD',
          'A2EUQ1WTGCTBG2': 'CAD',
          'A1AM78C64UM0Y8': 'MXN',
          'A2Q3Y263D00KWC': 'BRL',
        };
        const localCurrency = MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';
        const fxRate = FX_RATES_CACHE[localCurrency] || 1;
        
        // For NON-US marketplaces: MUST use actual marketplace price, NOT US inventory price
        // CRITICAL FIX: First check asin_my_price_cache for the REAL local currency price
        if (isNonUs) {
          // Priority 1: Check asin_my_price_cache for ACTUAL local currency listing price
          // This is the REAL price the product is listed for in MX/CA/BR
          const { data: myPriceData } = await supabase
            .from('asin_my_price_cache')
            .select('my_price, currency')
            .eq('user_id', userId)
            .eq('asin', targetAsin)
            .eq('marketplace_id', marketplaceId)
            .order('fetched_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          
          if (myPriceData?.my_price && myPriceData.my_price > 0) {
            // We have the actual local currency price - use it directly!
            priceInLocalCurrency = myPriceData.my_price;
            priceToUse = priceInLocalCurrency / fxRate; // Convert to USD for display/storage
            priceSource = 'my_price_cache_local';
            console.log(`💰 ENRICH_BY_ASIN: [NON-US] Using ACTUAL local price ${priceInLocalCurrency} ${localCurrency} (= $${priceToUse.toFixed(2)} USD) for ${targetAsin} (marketplace: ${marketplaceId})`);
          } else {
            // Fallback: Look for actual price snapshot from order discovery
            const orderIds = marketplaceOrders.map(o => o.order_id);
            const { data: snapshots } = await supabase
              .from('order_price_snapshots')
              .select('snapshot_price, snapshot_item_price, currency')
              .eq('user_id', userId)
              .eq('asin', targetAsin)
              .in('order_id', orderIds)
              .order('captured_at', { ascending: false })
              .limit(1);
            
            if (snapshots && snapshots.length > 0 && snapshots[0].snapshot_item_price > 0) {
              // Snapshot is in USD, so we need to convert to local for fee calculation
              priceToUse = snapshots[0].snapshot_item_price;
              priceInLocalCurrency = priceToUse * fxRate;
              priceSource = 'snapshot_price';
              console.log(`💰 ENRICH_BY_ASIN: [NON-US] Using snapshot price $${priceToUse} (= ${priceInLocalCurrency.toFixed(2)} ${localCurrency}) for ${targetAsin} (marketplace: ${marketplaceId})`);
            } else {
              // Priority 3: Use estimated_price if it differs significantly from US inventory
              const representativeOrder = marketplaceOrders.find(o => o.estimated_price && o.estimated_price > 0);
              if (representativeOrder?.estimated_price && Math.abs(representativeOrder.estimated_price - freshInventoryPrice) > 1) {
                priceToUse = representativeOrder.estimated_price;
                priceInLocalCurrency = priceToUse * fxRate;
                priceSource = 'estimated_price_intl';
                console.log(`💰 ENRICH_BY_ASIN: [NON-US] Using estimated_price $${priceToUse} (= ${priceInLocalCurrency.toFixed(2)} ${localCurrency}) for ${targetAsin} (marketplace: ${marketplaceId})`);
              } else if (representativeOrder?.sold_price && representativeOrder.sold_price > 0 && Math.abs(representativeOrder.sold_price - freshInventoryPrice) > 1) {
                priceToUse = representativeOrder.sold_price;
                priceInLocalCurrency = priceToUse * fxRate;
                priceSource = 'sold_price_intl';
                console.log(`💰 ENRICH_BY_ASIN: [NON-US] Using sold_price $${priceToUse} (= ${priceInLocalCurrency.toFixed(2)} ${localCurrency}) for ${targetAsin} (marketplace: ${marketplaceId})`);
              } else {
                // ═══════════════════════════════════════════════════════════
                // STEP 1.5 (user requirement, 2026-06-01):
                // Before falling back to US inventory × FX (which is almost
                // always wrong for CA/MX/BR), check repricer_assignments for
                // a per-marketplace local-currency price. `created_listings`
                // has no marketplace column, but `repricer_assignments` does
                // (`marketplace` + `last_applied_price` / `last_buybox_price`
                // / `detected_offer_price`), which is the equivalent
                // marketplace-scoped "my listing price" source.
                // ═══════════════════════════════════════════════════════════
                const marketplaceShortForAssignment = ({
                  'A2EUQ1WTGCTBG2': 'CA',
                  'A1AM78C64UM0Y8': 'MX',
                  'A2Q3Y263D00KWC': 'BR',
                } as Record<string, string>)[marketplaceId];
                let assignmentLocalPrice = 0;
                if (marketplaceShortForAssignment) {
                  const { data: assignmentRow } = await supabase
                    .from('repricer_assignments')
                    .select('last_applied_price, last_buybox_price, detected_offer_price')
                    .eq('user_id', userId)
                    .eq('asin', targetAsin)
                    .eq('marketplace', marketplaceShortForAssignment)
                    .maybeSingle();
                  if (assignmentRow) {
                    assignmentLocalPrice =
                      Number(assignmentRow.last_applied_price) ||
                      Number(assignmentRow.last_buybox_price) ||
                      Number(assignmentRow.detected_offer_price) ||
                      0;
                  }
                }

                if (assignmentLocalPrice > 0) {
                  priceInLocalCurrency = assignmentLocalPrice;
                  priceToUse = priceInLocalCurrency / fxRate; // local → USD once
                  priceSource = 'repricer_assignment_marketplace_local';
                  console.log(`💰 ENRICH_BY_ASIN: [NON-US] STEP_1.5 Using repricer_assignment local price ${priceInLocalCurrency} ${localCurrency} (= $${priceToUse.toFixed(2)} USD) for ${targetAsin} (marketplace: ${marketplaceId})`);
                } else {
                  // LAST RESORT: US inventory × FX (logged loudly)
                  priceToUse = freshInventoryPrice;
                  priceInLocalCurrency = priceToUse * fxRate;
                  priceSource = 'inventory_fallback_intl';
                  console.log(`⚠️ ENRICH_BY_ASIN: [NON-US] WARNING - No local price found (asin_my_price_cache + snapshot + estimated + sold + repricer_assignment all empty), using US inventory $${priceToUse} (= ${priceInLocalCurrency.toFixed(2)} ${localCurrency}) for ${targetAsin} - THIS MAY BE INACCURATE!`);
                }
              }

            }
          }
        } else if (forcePriceUpdate && freshInventoryPrice > 0) {
          // US marketplace with force update: use fresh inventory price
          priceToUse = freshInventoryPrice;
          priceInLocalCurrency = priceToUse; // USD = USD
          priceSource = 'inventory_forced';
          console.log(`💰 ENRICH_BY_ASIN: FORCE MODE - Using fresh inventory price $${priceToUse} for ${targetAsin} (marketplace: ${marketplaceId})`);
        } else {
          // US marketplace normal mode: 
          // PRIORITY 1: Check order_price_snapshots for the REAL captured price at order time
          const orderIds = marketplaceOrders.map(o => o.order_id);
          const { data: usSnapshots } = await supabase
            .from('order_price_snapshots')
            .select('snapshot_item_price, snapshot_source, order_id')
            .eq('user_id', userId)
            .eq('asin', targetAsin)
            .in('order_id', orderIds)
            .order('captured_at', { ascending: false })
            .limit(1);
          
          if (usSnapshots && usSnapshots.length > 0 && usSnapshots[0].snapshot_item_price > 0) {
            priceToUse = usSnapshots[0].snapshot_item_price;
            priceSource = 'snapshot_us';
            console.log(`💰 ENRICH_BY_ASIN: [US] Using SNAPSHOT price $${priceToUse} for ${targetAsin} (order: ${usSnapshots[0].order_id})`);
          } else if (freshInventoryPrice > 0) {
            // PRIORITY 2: Fresh inventory price (current listing price)
            priceToUse = freshInventoryPrice;
            priceSource = 'inventory';
            console.log(`💰 ENRICH_BY_ASIN: [US] Using fresh inventory price $${priceToUse} for ${targetAsin}`);
          } else {
            // PRIORITY 3: Existing order price (may be stale)
            const representativeOrder = marketplaceOrders.find(o => o.sold_price > 0);
            if (representativeOrder?.sold_price && representativeOrder.sold_price > 0) {
              priceToUse = representativeOrder.sold_price;
              priceSource = 'existing_order';
              console.log(`💰 ENRICH_BY_ASIN: [US] Using existing order price $${priceToUse} for ${targetAsin}`);
            } else {
              // Last resort: check buy_box_cache
              const { data: buyBoxData } = await supabase
                .from('buy_box_cache')
                .select('price')
                .eq('asin', targetAsin)
                .order('fetched_at', { ascending: false })
                .limit(1)
                .maybeSingle();
              
              if (buyBoxData?.price && buyBoxData.price > 0) {
                priceToUse = buyBoxData.price;
                priceSource = 'buy_box_cache';
                console.log(`💰 ENRICH_BY_ASIN: [US] Using buy_box_cache price $${priceToUse} for ${targetAsin}`);
              }
            }
          }
          priceInLocalCurrency = priceToUse; // USD = USD for US marketplace
        }
        
        if (priceToUse <= 0) {
          console.log(`ENRICH_BY_ASIN: No valid price found for ${targetAsin} in marketplace ${marketplaceId}`);
          failedCount += marketplaceOrders.length;
          continue;
        }
        
        // ============================================================
        // FEE PRIORITY: "Learned from history" BEFORE Fees API
        // Sellerboard-style: use actual settled fees from Financial Events
        // if available, since Fees API can be inaccurate (~$0.40-$0.64 off)
        // IMPORTANT: When force_price_update=true, SKIP learned_history and
        // go straight to Fees API to get fresh data from Amazon
        // ============================================================
        
        let finalFees: { fbaFee: number; referralFee: number; closingFee: number; totalFees: number } | null = null;
        let feeSource = 'fees_api'; // default
        let historySampleSize = 0;
        
        // PRIORITY 1: Check financial_events_cache for ACTUAL settled fees
        // ALWAYS try learned_history first (settled fees are authoritative, even in force mode)
        // Force mode only bypasses asin_fee_cache TTL, NOT settled financial history
        // financial_events_cache.asin stores SKU, so we need to look up the SKU first
        {
          const { data: invForSku } = await supabase
            .from('inventory')
            .select('sku')
            .eq('user_id', userId)
            .eq('asin', targetAsin)
            .limit(1)
            .maybeSingle();
          
          if (invForSku?.sku) {
            // STEP A: Try latest 3 within 30 days (fast-reacting)
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            let { data: settledFees } = await supabase
              .from('financial_events_cache')
              .select('fba_fees, referral_fees, fixed_closing_fees, variable_closing_fees, sales, event_date')
              .eq('user_id', userId)
              .eq('asin', invForSku.sku)
              .eq('marketplace', marketplaceShortName)
              .eq('event_type', 'shipment')
              .gt('fba_fees', 0)
              .gte('event_date', thirtyDaysAgo)
              .order('event_date', { ascending: false })
              .limit(3);
            
            let historyTag = 'learned_history';
            
            // STEP B: If no settlements in 30 days, fallback to 180 days for low-volume ASINs
            if (!settledFees || settledFees.length === 0) {
              const oneEightyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
              const { data: olderFees } = await supabase
                .from('financial_events_cache')
                .select('fba_fees, referral_fees, fixed_closing_fees, variable_closing_fees, sales, event_date')
                .eq('user_id', userId)
                .eq('asin', invForSku.sku)
                .eq('marketplace', marketplaceShortName)
                .eq('event_type', 'shipment')
                .gt('fba_fees', 0)
                .gte('event_date', oneEightyDaysAgo)
                .order('event_date', { ascending: false })
                .limit(3);
              
              if (olderFees && olderFees.length >= 1) {
                settledFees = olderFees;
                historyTag = 'learned_history_old'; // Tag as older data
                console.log(`🎓 ENRICH_BY_ASIN: No settlements in 30d for ${targetAsin}, using ${olderFees.length} settlements from 180d window`);
              }
            }
            
            if (settledFees && settledFees.length >= 1) {
              historySampleSize = settledFees.length;
              
              // FEE SANITY FIX: Normalize fees PER UNIT.
              // financial_events_cache stores AGGREGATE fees per shipment (multi-unit shipments
              // would otherwise inflate medianFba). Infer qty from sales/min_unit_price.
              // We approximate per-unit FBA as fba_fees / max(1, round(sales / priceToUse)).
              const perUnitFbaValues = settledFees
                .map(f => {
                  const fba = Number(f.fba_fees) || 0;
                  const sales = Number(f.sales) || 0;
                  if (fba <= 0 || sales <= 0 || priceToUse <= 0) return fba;
                  const inferredQty = Math.max(1, Math.round(sales / priceToUse));
                  return fba / inferredQty;
                })
                .sort((a, b) => a - b);
              const medianFba = perUnitFbaValues[Math.floor(perUnitFbaValues.length / 2)];
              
              // LEARN referral rate from history (rate is already proportional, no qty needed)
              const settledWithSales = settledFees.filter(f => Number(f.referral_fees) > 0 && Number(f.sales) > 0);
              let referralRate = 0.15; // fallback
              if (settledWithSales.length >= 1) {
                const rateValues = settledWithSales
                  .map(f => Number(f.referral_fees) / Number(f.sales))
                  .sort((a, b) => a - b);
                referralRate = rateValues[Math.floor(rateValues.length / 2)];
                console.log(`🎓 LEARNED referral rate from ${settledWithSales.length} recent settled orders: ${(referralRate * 100).toFixed(2)}%`);
              }
              
              const learnedReferralFee = priceToUse * referralRate;
              // Closing fees: also normalize per-unit
              const perUnitClosingValues = settledFees.map(f => {
                const variable = Number(f.variable_closing_fees || 0);
                const fixed = Number(f.fixed_closing_fees || 0);
                const closing = variable > 0 ? variable : fixed;
                const sales = Number(f.sales) || 0;
                if (closing <= 0 || sales <= 0 || priceToUse <= 0) return closing;
                const inferredQty = Math.max(1, Math.round(sales / priceToUse));
                return closing / inferredQty;
              }).sort((a, b) => a - b);
              const medianClosing = perUnitClosingValues[Math.floor(perUnitClosingValues.length / 2)];
              
              const learnedTotal = medianFba + learnedReferralFee + medianClosing;
              
              // FEE SANITY GUARD:
              //  (1) Total fees must not exceed 70% of sale price.
              //  (2) Per-unit FBA fee must not exceed 40% of sale price.
              // Real Amazon FBA fees for standard items rarely exceed 25-30%
              // of price; values above 40% almost always indicate quantity
              // mis-inference on a multi-unit shipment or cross-currency
              // contamination (e.g. MXN fee assigned to a USD row).
              const SANITY_THRESHOLD = 0.70;
              const FBA_SANITY_THRESHOLD = 0.40;
              const totalTooHigh = priceToUse > 0 && learnedTotal > priceToUse * SANITY_THRESHOLD;
              const fbaTooHigh = priceToUse > 0 && medianFba > priceToUse * FBA_SANITY_THRESHOLD;
              if (totalTooHigh || fbaTooHigh) {
                const reason = fbaTooHigh ? `per-unit FBA $${medianFba.toFixed(2)} > 40% of price $${priceToUse}` : `total $${learnedTotal.toFixed(2)} > 70% of price $${priceToUse}`;
                console.warn(`⚠️ FEE_SANITY_REJECT: ${targetAsin} ${reason} (fba=$${medianFba.toFixed(2)}, ref=$${learnedReferralFee.toFixed(2)}, close=$${medianClosing.toFixed(2)}). Falling back to Fees API.`);
                // Leave finalFees null so Fees API path runs below
              } else {
                finalFees = {
                  fbaFee: Math.round(medianFba * 100) / 100,
                  referralFee: Math.round(learnedReferralFee * 100) / 100,
                  closingFee: Math.round(medianClosing * 100) / 100,
                  totalFees: Math.round(learnedTotal * 100) / 100,
                };
                feeSource = historyTag;
                console.log(`🎓 ENRICH_BY_ASIN: LEARNED fees [${historyTag}] from ${settledFees.length} settled orders for ${targetAsin} (SKU: ${invForSku.sku}): per-unit fba=$${medianFba.toFixed(2)}, referral=$${learnedReferralFee.toFixed(2)}, closing=$${medianClosing.toFixed(2)}`);
              }
            }
          }
        }
        
        // PRIORITY 2: Fall back to Fees API if no history
        if (!finalFees) {
          // Detect FBM: check if ANY order in this marketplace group is FBM
          const isFbmAsin = marketplaceOrders.some((o: any) => o.fulfillment_channel === 'MFN');
          
          const apiFees = await fetchProductFees(accessToken, targetAsin, priceToUse, marketplaceId, FX_RATES_CACHE, isNonUs ? priceInLocalCurrency : undefined, !isFbmAsin);
          
          if (!apiFees) {
            console.error(`ENRICH_BY_ASIN: Failed to fetch fees for ${targetAsin} in marketplace ${marketplaceId}`);
            failedCount += marketplaceOrders.length;
            continue;
          }
          
          if (isFbmAsin) {
            // FBM: Bundle ALL fees into fbaFee, zero out referral/closing
            const totalFbmFees = apiFees.referralFee + apiFees.fbaFee + apiFees.closingFee;
            finalFees = { referralFee: 0, fbaFee: totalFbmFees, closingFee: 0, totalFees: totalFbmFees } as any;
            feeSource = 'fees_api_fbm';
            console.log(`📊 ENRICH_BY_ASIN: FBM fees for ${targetAsin}: bundled $${totalFbmFees.toFixed(2)} into FBA/FBM column`);
          } else {
            finalFees = apiFees;
            feeSource = 'fees_api';
            console.log(`📊 ENRICH_BY_ASIN: Using Fees API for ${targetAsin}: fba=$${apiFees.fbaFee.toFixed(2)}, referral=$${apiFees.referralFee.toFixed(2)}`);
          }
        }
        
        // Calculate referral rate (for cache) based on price used
        const ff = finalFees as any;
        const referralRate = priceToUse > 0 ? ff.referralFee / priceToUse : 0.15;
        
        feesByMarketplace.set(marketplaceId, {
          ...ff,
          referralRate,
          feeSource,
        } as any);
        
        // Update asin_fee_cache for this marketplace
        await supabase.from('asin_fee_cache').upsert({
          user_id: userId,
          asin: targetAsin,
          marketplace: marketplaceShortName,
          fba_fee_fixed: ff.fbaFee,
          referral_rate: referralRate,
          is_media: ff.closingFee > 0,
          attempt_count: 0,
          last_error: null,
          next_retry_at: null,
          updated_at: new Date().toISOString(),
          fee_source: feeSource,
          last_verified_at: new Date().toISOString(),
          history_sample_size: historySampleSize,
        }, { onConflict: 'user_id,asin,marketplace' });
        
        console.log(`💰 ENRICH_BY_ASIN: Cached fees for ${targetAsin} in ${marketplaceShortName} [source: ${feeSource}]: fba=$${ff.fbaFee.toFixed(2)}, referral_rate=${(referralRate * 100).toFixed(1)}%`);
      }
      
      // Now update all orders with their marketplace-specific fees
      const NON_US_MARKETPLACES = ['MX', 'CA', 'BR', 'Mexico', 'Canada', 'Brazil'];
      const PROTECTED_PRICE_SOURCES = [
        'pricing_api_mx', 'pricing_api_ca', 'pricing_api_br',
        'estimate_pricing_api_mx', 'estimate_pricing_api_ca', 'estimate_pricing_api_br',
        'orders_itemprice', 'orders_api', 'financial_events',
        // Per BB Own Estimate Phase 2 contract (memory: bb-own-estimate-tracking-phase1):
        // Repair/enrichment sweeps must NEVER downgrade a qualified
        // closest_bb_order_discovery estimate to a snapshot_price. Only
        // CONFIRMED Orders-API / FEC writes (handled elsewhere) may replace it.
        'closest_bb_order_discovery',
        // Live SP-API Listings price (Tier 0 in fetch-live-orders +
        // repair-pending-listings-price) — same source the repricer uses for
        // "my current Amazon price". Must NEVER be downgraded back to a stale
        // order_price_snapshots row by enrich-by-asin. Matched via .includes(),
        // so all `seller_derived:*` and `*listings_api*` variants are covered.
        'seller_derived:',
        'listings_api',
      ];

      // ═══════════════════════════════════════════════════════════════
      // GRACE PERIOD (2026-07-14 fix): orders younger than this are never
      // force/stale-price-overwritten with "current live price". A brand-new
      // Pending order's own discovery-time estimate (seller_derived resolver
      // in fetch-live-orders) is a far better guess than whatever the
      // repricer has since bounced the ASIN to. Real orders_api/FEC prices
      // are unaffected — this only gates the "no confirmed price yet" paths.
      // ═══════════════════════════════════════════════════════════════
      const PRICE_UPDATE_GRACE_PERIOD_MINUTES = 30;

      // Fetch the REAL Amazon PurchaseDate for one order via GetOrder — basic
      // order metadata, unlike GetOrderItems it's returned regardless of
      // Pending status. Used only to anchor the lookup below, never for price.
      const fetchOrderPurchaseDate = async (orderId: string, accessToken: string): Promise<string | null> => {
        try {
          const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}`;
          const headers = await signRequest('GET', url, '', accessToken);
          const res = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });
          if (!res.ok) {
            console.warn(`⚠️ PURCHASE_DATE_LOOKUP: ${orderId} failed: ${res.status}`);
            return null;
          }
          const data = await res.json();
          return data?.payload?.PurchaseDate || null;
        } catch (err) {
          console.warn(`⚠️ PURCHASE_DATE_LOOKUP: ${orderId} exception: ${(err as Error).message}`);
          return null;
        }
      };

      // AUTHORITATIVE TIME-ANCHORED RESOLVER (2026-07-14 fix): mirrors the
      // Tier A lookup fetch-live-orders already does at discovery time —
      // the latest successful repricer_price_actions row at/before the
      // order's REAL purchase moment. This is the actual price Amazon had
      // live when the order was placed, regardless of how many times the
      // repricer has since moved it. Prefers the true Amazon PurchaseDate
      // (fetched fresh via GetOrder) over order.created_at (our own discovery
      // timestamp), since Pending orders can take significant time to appear
      // in our system after the real purchase — created_at alone can anchor
      // to the wrong repricer cycle for fast-oscillating ASINs.
      const resolveTimeAnchoredPrice = async (
        orderId: string,
        asin: string,
        marketplace: string,
        createdAtFallback: string,
        accessToken: string | null,
      ): Promise<number> => {
        let purchaseTs = createdAtFallback;
        if (accessToken) {
          const realPurchaseDate = await fetchOrderPurchaseDate(orderId, accessToken);
          if (realPurchaseDate) {
            purchaseTs = realPurchaseDate;
          }
        }
        const { data: rpaRow } = await supabase
          .from('repricer_price_actions')
          .select('new_price, amazon_accepted_price')
          .eq('user_id', userId)
          .eq('asin', asin)
          .eq('marketplace', marketplace || 'US')
          .eq('success', true)
          .lte('created_at', purchaseTs)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return Number(rpaRow?.amazon_accepted_price || rpaRow?.new_price || 0);
      };

      for (const order of ordersForAsin) {
        try {
          const orderMarketplace = order.marketplace || 'US';
          const marketplaceId = MARKETPLACE_NAME_TO_ID[orderMarketplace] || MARKETPLACE_NAME_TO_ID['US'];
          const cachedFees = feesByMarketplace.get(marketplaceId);
          
          if (!cachedFees) {
            console.warn(`ENRICH_BY_ASIN: No fees available for ${order.order_id} in marketplace ${marketplaceId}`);
            failedCount++;
            continue;
          }
          
          const qty = order.quantity || 1;
          const saleTimeCost = resolveSaleTimeCost(order);
          const orderPriceSource = order.price_source || '';
          
          // Check if this is a non-US order that should be protected from price overwrites
          const isNonUsOrder = NON_US_MARKETPLACES.some(mp => 
            orderMarketplace.toUpperCase().includes(mp.toUpperCase())
          );
          const hasProtectedPriceSource = PROTECTED_PRICE_SOURCES.some(src => 
            orderPriceSource.toLowerCase().includes(src.toLowerCase())
          );
          
          // Determine price to use for ROI calculation
          let orderPrice = order.sold_price;
          let priceWasUpdated = false;
          let newPriceSource = orderPriceSource; // Track the actual price source used
          
          // PROTECTION: Skip price update for non-US orders
          if (isNonUsOrder || hasProtectedPriceSource) {
            console.log(`🛡️ PRICE_PROTECT: ${order.order_id} | Skipping price update - marketplace=${orderMarketplace}, price_source=${orderPriceSource}`);
            orderPrice = order.sold_price || order.estimated_price || 0;
          } else {
            // For US orders, check if we have a snapshot price that should override stale data
            // Stale sources include 'inventory_refresh' which may have old pricing
            const isStaleSource = orderPriceSource === 'inventory_refresh' || !orderPriceSource;
            
            // First, try to get the real snapshot price for this specific order
            const { data: orderSnapshot } = await supabase
              .from('order_price_snapshots')
              .select('snapshot_item_price, snapshot_source')
              .eq('user_id', userId)
              .eq('order_id', order.order_id)
              .maybeSingle();
            
            const snap = orderSnapshot as any;
            const orderAgeMinutes = order.created_at
              ? (Date.now() - new Date(order.created_at).getTime()) / 60000
              : Infinity;
            const pastGracePeriod = orderAgeMinutes >= PRICE_UPDATE_GRACE_PERIOD_MINUTES;

            if (snap?.snapshot_item_price > 0) {
              // Use the snapshot price captured at order discovery time
              if (orderPrice !== snap.snapshot_item_price) {
                console.log(`💰 PRICE_SYNC: ${order.order_id} | Using SNAPSHOT price $${snap.snapshot_item_price} (was $${orderPrice} from ${orderPriceSource})`);
                orderPrice = snap.snapshot_item_price;
                priceWasUpdated = true;
                newPriceSource = 'snapshot_price';
              }
            } else if (forcePriceUpdate && !pastGracePeriod) {
              console.log(`⏳ PRICE_GRACE_PERIOD: ${order.order_id} | order is ${orderAgeMinutes.toFixed(1)}min old (<${PRICE_UPDATE_GRACE_PERIOD_MINUTES}min) — skipping force price overwrite, keeping discovery-time estimate`);
            } else if (forcePriceUpdate) {
              // AUTHORITATIVE FIX: try the time-anchored repricer price first —
              // the actual price Amazon had live at/before this order's creation,
              // not whatever the repricer has since bounced the ASIN to.
              const anchoredPrice = await resolveTimeAnchoredPrice(order.order_id, order.asin, orderMarketplace, order.created_at, enrichAccessToken);
              if (anchoredPrice > 0 && orderPrice !== anchoredPrice) {
                console.log(`💰 PRICE_SYNC: ${order.order_id} | Using TIME-ANCHORED repricer price $${anchoredPrice} (was $${orderPrice} from ${orderPriceSource})`);
                orderPrice = anchoredPrice;
                priceWasUpdated = true;
                newPriceSource = 'repricer_action_time_anchored';
              } else {
                // MULTI-SKU FIX: Use SKU-specific inventory price
                const skuSpecificPrice = getInventoryPriceForSku(order.seller_sku || order.sku);
                if (skuSpecificPrice > 0 && orderPrice !== skuSpecificPrice) {
                  console.log(`💰 PRICE_SYNC: ${order.order_id} | FORCE updating price from $${orderPrice} to $${skuSpecificPrice} (sku=${order.seller_sku || order.sku})`);
                  orderPrice = skuSpecificPrice;
                  priceWasUpdated = true;
                  newPriceSource = 'inventory_refresh_forced';
                }
              }
            } else if (isStaleSource && !pastGracePeriod) {
              console.log(`⏳ PRICE_GRACE_PERIOD: ${order.order_id} | order is ${orderAgeMinutes.toFixed(1)}min old (<${PRICE_UPDATE_GRACE_PERIOD_MINUTES}min) — skipping stale-source overwrite, keeping discovery-time estimate`);
            } else if (isStaleSource && freshInventoryPrice > 0 && Math.abs(orderPrice - freshInventoryPrice) > 1) {
              // Stale source with significant price difference — try the
              // time-anchored repricer price first, same as the forced path above.
              const anchoredPrice = await resolveTimeAnchoredPrice(order.order_id, order.asin, orderMarketplace, order.created_at, enrichAccessToken);
              if (anchoredPrice > 0 && orderPrice !== anchoredPrice) {
                console.log(`💰 PRICE_SYNC: ${order.order_id} | Stale ${orderPriceSource} price $${orderPrice} — using TIME-ANCHORED repricer price $${anchoredPrice}`);
                orderPrice = anchoredPrice;
                priceWasUpdated = true;
                newPriceSource = 'repricer_action_time_anchored';
              } else {
                const skuSpecificPrice = getInventoryPriceForSku(order.seller_sku || order.sku);
                console.log(`💰 PRICE_SYNC: ${order.order_id} | Stale ${orderPriceSource} price $${orderPrice} differs from inventory $${skuSpecificPrice}, updating`);
                orderPrice = skuSpecificPrice;
                priceWasUpdated = true;
                newPriceSource = 'inventory_refresh';
              }
            } else if (!orderPrice || orderPrice <= 0) {
              const skuSpecificPrice = getInventoryPriceForSku(order.seller_sku || order.sku);
              orderPrice = skuSpecificPrice;
              priceWasUpdated = true;
              newPriceSource = 'inventory_refresh';
              console.log(`💰 PRICE_SYNC: ${order.order_id} | sold_price was $0, using fresh inventory price $${freshInventoryPrice}`);
            }
          }
          
          // Calculate fees based on actual order price using marketplace-specific fees
          // GUARD: If orderPrice is 0, do NOT overwrite existing fees with zeros!
          // Instead, keep existing DB fees and only update the fee_source/cache.
          const effectivePrice = orderPrice > 0 ? orderPrice : (order.sold_price || order.estimated_price || 0);
          
          if (effectivePrice <= 0) {
            // No price at all - skip fee update entirely to preserve existing data
            console.log(`⚠️ ENRICH_BY_ASIN: ${order.order_id} | No valid price (sold=$${order.sold_price}, est=$${order.estimated_price}), SKIPPING fee overwrite to preserve existing referral_fee=$${order.referral_fee}`);
            failedCount++;
            continue;
          }

          // ═══════════════════════════════════════════════════════════════
          // CURRENCY NORMALIZATION FOR FEE MATH (BR/MX/CA fix, 2026-06-22)
          // Per Sales Currency Contract (mem://architecture/sales/currency-contract-v1):
          //   estimated_price (non-US) is stored NATIVE.
          //   sales_orders.referral_fee / fba_fee / total_fees are stored USD.
          //   cachedFees.fbaFee is already USD (asin_fee_cache contract).
          //   cachedFees.referralRate is a currency-neutral fraction.
          // So we MUST convert the effective price NATIVE→USD before multiplying
          // by referralRate, otherwise we write a BRL/MXN/CAD referral fee into
          // a USD column (e.g. BR R$134.71 × 0.12 = R$16.17 stored as $16.17).
          // ═══════════════════════════════════════════════════════════════
          const _orderMpUpper = String(orderMarketplace || 'US').toUpperCase();
          const _localCcy = _orderMpUpper.includes('CA') || _orderMpUpper === 'CANADA' ? 'CAD'
            : _orderMpUpper.includes('MX') || _orderMpUpper === 'MEXICO' ? 'MXN'
            : _orderMpUpper.includes('BR') || _orderMpUpper === 'BRAZIL' ? 'BRL'
            : 'USD';
          const _localFxPerUsd = (FX_RATES_CACHE && FX_RATES_CACHE[_localCcy]) ? FX_RATES_CACHE[_localCcy] : 1;
          const _isNonUsRow = _localCcy !== 'USD';
          const effectivePriceUsd = _isNonUsRow && _localFxPerUsd > 0
            ? (effectivePrice / _localFxPerUsd)
            : effectivePrice;
          const orderPriceUsd = _isNonUsRow && _localFxPerUsd > 0 && orderPrice > 0
            ? (orderPrice / _localFxPerUsd)
            : orderPrice;

          const willRemainPendingPrice =
            priceWasUpdated &&
            orderPrice > 0 &&
            newPriceSource !== 'orders_itemprice' &&
            newPriceSource !== 'sold_price_intl';

          if (willRemainPendingPrice) {
            const estimatedReferralFee = Math.round(((orderPriceUsd * cachedFees.referralRate) * qty) * 100) / 100;
            const estimatedFbaFee = Math.round((cachedFees.fbaFee * qty) * 100) / 100;
            const estimatedClosingFee = Math.round((cachedFees.closingFee * qty) * 100) / 100;
            const estimatedTotalFees = Math.round((estimatedReferralFee + estimatedFbaFee + estimatedClosingFee) * 100) / 100;
            const estimatedUnitCost = (saleTimeCost.unitCost && saleTimeCost.unitCost > 0) ? saleTimeCost.unitCost : (Number(order.unit_cost) || 0);
            const estimatedTotalCost = Math.round((estimatedUnitCost * qty) * 100) / 100;
            const estimatedRoi = estimatedTotalCost > 0
              ? Math.round((((orderPriceUsd * qty) - estimatedTotalFees - estimatedTotalCost) / estimatedTotalCost) * 1000) / 10
              : 0;

            // ═══════════════════════════════════════════════════════════════
            // ZERO-OVERWRITE SAFETY GUARD (user requirement, 2026-06-01):
            // Pending-price enrichment must NEVER overwrite previously
            // non-zero estimated_price / unit_cost / fees / ROI with 0/null.
            // If a new computed value is 0 but the row already has a usable
            // value, KEEP the previous value and log the missing source.
            // Prevents brand-new ASIN first-sales (no warmed cache yet) from
            // appearing as $0 sales / $0 cost.
            // ═══════════════════════════════════════════════════════════════
            const preserveIfZero = (newVal: number, prevVal: number | null | undefined, label: string): number => {
              const prev = Number(prevVal) || 0;
              if (newVal > 0) return newVal;
              if (prev > 0) {
                console.log(`🛡️ PENDING_ZERO_GUARD: ${order.order_id} | ${label} new=${newVal} would overwrite prev=${prev} — KEEPING prev`);
                return prev;
              }
              return 0;
            };

            const safeEstimatedPrice = preserveIfZero(orderPrice, order.estimated_price, 'estimated_price');
            const safeReferralFee = preserveIfZero(estimatedReferralFee, order.referral_fee, 'referral_fee');
            const safeFbaFee = preserveIfZero(estimatedFbaFee, order.fba_fee, 'fba_fee');
            const safeClosingFee = preserveIfZero(estimatedClosingFee, order.closing_fee, 'closing_fee');
            const safeTotalFees = preserveIfZero(estimatedTotalFees, order.total_fees, 'total_fees');
            const safeUnitCost = preserveIfZero(estimatedUnitCost, order.unit_cost, 'unit_cost');
            const safeTotalCost = safeUnitCost > 0 ? Math.round((safeUnitCost * qty) * 100) / 100 : (Number(order.total_cost) || 0);
            const safeRoi = preserveIfZero(estimatedRoi, order.roi, 'roi');

            await supabase
              .from('sales_orders')
              .update({
                estimated_price: safeEstimatedPrice,
                price_source: newPriceSource,
                price_confidence: 'HIGH_CONFIDENCE_PENDING',
                needs_price_enrich: true,
                price_enrich_status: 'pending',
                referral_fee: safeReferralFee,
                fba_fee: safeFbaFee,
                closing_fee: safeClosingFee,
                total_fees: safeTotalFees,
                unit_cost: safeUnitCost || order.unit_cost || 0,
                unit_cost_at_sale: safeUnitCost > 0 ? safeUnitCost : (order.unit_cost_at_sale || null),
                cost_source_at_sale: safeUnitCost > 0 ? (saleTimeCost.source || order.cost_source_at_sale || 'sales_orders_existing') : order.cost_source_at_sale,
                cost_locked: safeUnitCost > 0 ? true : (order.cost_locked || false),
                cost_locked_at: safeUnitCost > 0 ? new Date().toISOString() : null,
                total_cost: safeTotalCost,
                roi: safeRoi,
                fees_source: cachedFees.feeSource,
                fees_missing: safeTotalFees > 0 ? false : (order.fees_missing ?? true),
                updated_at: new Date().toISOString(),
              })
              .eq('id', order.id);
            console.log(`📝 PRICE_ESTIMATE_PENDING: ${order.order_id} | estimate native=${safeEstimatedPrice} ${_localCcy} (USD $${orderPriceUsd.toFixed(2)}) + cost $${safeTotalCost} + fees $${safeTotalFees} while awaiting real Orders API ItemPrice`);
            summaryPriceUpdates++;
            enrichedCount++;
            continue;
          }

          
          const orderReferralFee = (effectivePriceUsd * cachedFees.referralRate) * qty;
          const orderFbaFee = cachedFees.fbaFee * qty;
          const orderClosingFee = cachedFees.closingFee * qty;
          const orderTotalFees = orderReferralFee + orderFbaFee + orderClosingFee;
          
          // FEE SANITY GUARD (write-time): if total_fees > 70% of total sale, mark invalid.
          // Prevents nonsense ROI like -87% from a corrupted fee cache.
          // IMPORTANT: only judge against a REAL sold_price. estimated_price is a
          // pre-settlement hint and can legitimately be very low (clearance, promo, $0
          // placeholder); we must not flag fees_invalid when the price itself isn't trusted.
          const hasRealSoldPrice = Number(order.sold_price) > 0;
          const totalSaleForGuard = hasRealSoldPrice ? (Number(order.sold_price) * qty) : 0;
          const feesInvalid = hasRealSoldPrice && totalSaleForGuard > 0 && orderTotalFees > totalSaleForGuard * 0.70;
          if (feesInvalid) {
            console.warn(`⚠️ FEE_SANITY_INVALID: ${order.order_id} (${order.asin}) | fees $${orderTotalFees.toFixed(2)} > 70% of sale $${totalSaleForGuard.toFixed(2)}. Marking fees_invalid=true, ROI=null.`);
          }
          
          // Calculate ROI — Contract A resolver is the source of truth for COG.
          // Prefer resolved cost over whatever is on the row, so corrupted unit_cost
          // values (e.g. 2.29 / 26 = 0.088) are self-healed on every enrichment pass.
          const totalSale = effectivePriceUsd * qty;
          const existingUnitCost = order.unit_cost || 0;
          const unitCost = (saleTimeCost.unitCost && saleTimeCost.unitCost > 0)
            ? saleTimeCost.unitCost
            : existingUnitCost;
          const totalCost = unitCost * qty;
          let roi = 0;
          if (totalCost > 0 && !feesInvalid) {
            const netProfit = totalSale - orderTotalFees - totalCost;
            roi = Math.round((netProfit / totalCost) * 1000) / 10;
          }
          
          // Build update object - always update fees, conditionally update prices
          const updateData: Record<string, any> = {
            referral_fee: orderReferralFee,
            fba_fee: orderFbaFee,
            closing_fee: orderClosingFee,
            total_fees: orderTotalFees,
            total_cost: totalCost,
            unit_cost_at_sale: unitCost > 0 ? unitCost : (order.unit_cost_at_sale || null),
            cost_source_at_sale: unitCost > 0 ? (saleTimeCost.source || order.cost_source_at_sale || 'sales_orders_existing') : order.cost_source_at_sale,
            cost_locked: unitCost > 0 ? true : (order.cost_locked || false),
            cost_locked_at: unitCost > 0 ? new Date().toISOString() : null,
            roi: roi,
            fees_source: cachedFees.feeSource,
            fees_missing: false,
            fees_invalid: feesInvalid,
            updated_at: new Date().toISOString(),
          };
          
          // Persist any unit_cost change (new value or self-heal of a corrupted one).
          if (unitCost > 0 && Math.abs(unitCost - existingUnitCost) > 0.01) {
            updateData.unit_cost = unitCost;
            summaryCostFixes++;
            summaryExceptions.push(`COG_FIX: ${order.order_id} unit_cost=$${existingUnitCost.toFixed(4)} -> $${unitCost.toFixed(2)}`);
          }
          
          // ARCHITECTURAL FIX: NEVER write snapshot/inventory price into sold_price.
          // sold_price is reserved for REAL ItemPrice from Orders API (or settlement/FEC).
          // Snapshot/inventory price is only a temporary display estimate → estimated_price.
          // Mark the row needs_price_enrich=true so the next Orders API enrichment fills sold_price.
          if (priceWasUpdated && orderPrice > 0) {
            const isRealApiPrice = newPriceSource === 'orders_itemprice' || newPriceSource === 'sold_price_intl';
            if (isRealApiPrice) {
              updateData.sold_price = orderPrice;
              updateData.item_price = orderPrice;
              updateData.estimated_price = orderPrice;
              updateData.total_sale_amount = totalSale;
              updateData.price_source = newPriceSource;
              updateData.needs_price_enrich = false;
              updateData.price_enrich_status = 'enriched';
            } else {
              // Estimate-only sources (snapshot_price, inventory_refresh, inventory_refresh_forced)
              updateData.estimated_price = orderPrice;
              updateData.price_source = newPriceSource;
              updateData.needs_price_enrich = true;
              updateData.price_enrich_status = 'pending';
              // Do NOT touch sold_price / item_price / total_sale_amount.
              console.log(`📝 PRICE_ESTIMATE_ONLY: ${order.order_id} | $${orderPrice} stored as estimated_price (source=${newPriceSource}); awaiting real Orders API ItemPrice`);
            }
            summaryPriceUpdates++;
          }
          
          await supabase
            .from('sales_orders')
            .update(updateData)
            .eq('id', order.id);
          
          enrichedCount++;
          summaryFees.push(orderTotalFees);
          summaryRois.push(roi);
          summaryPrices.push(orderPrice);

          // Log individual line ONLY for exceptions
          const isRefund = order.order_id?.includes('-REFUND');
          const isMultiUnit = qty > 1;
          if (isRefund) { summaryRefunds++; summaryExceptions.push(`REFUND: ${order.order_id} fees=$${orderTotalFees.toFixed(2)}`); }
          if (isMultiUnit) { summaryMultiUnit++; summaryExceptions.push(`MULTI_UNIT: ${order.order_id} qty=${qty} fees=$${orderTotalFees.toFixed(2)}`); }
        } catch (err: any) {
          console.error(`ENRICH_ERROR: ${order.order_id}:`, err?.message || err);
          summaryExceptions.push(`ERROR: ${order.order_id} ${err?.message || ''}`);
          failedCount++;
        }
      }
      
      // ── ENRICH_SUMMARY: one log per ASIN instead of per-order ──
      const avgFees = summaryFees.length > 0 ? (summaryFees.reduce((a, b) => a + b, 0) / summaryFees.length) : 0;
      const avgRoi = summaryRois.length > 0 ? (summaryRois.reduce((a, b) => a + b, 0) / summaryRois.length) : 0;
      const avgPrice = summaryPrices.length > 0 ? (summaryPrices.reduce((a, b) => a + b, 0) / summaryPrices.length) : 0;
      console.log(`📊 ENRICH_SUMMARY: ${targetAsin} | orders=${enrichedCount}/${ordersForAsin.length} | avg_price=$${avgPrice.toFixed(2)} | avg_fees=$${avgFees.toFixed(2)} | avg_roi=${avgRoi.toFixed(1)}% | refunds=${summaryRefunds} | multi_unit=${summaryMultiUnit} | cost_fixes=${summaryCostFixes} | price_updates=${summaryPriceUpdates} | failed=${failedCount}`);
      if (summaryExceptions.length > 0) {
        console.log(`⚠️ ENRICH_EXCEPTIONS: ${targetAsin} | ${summaryExceptions.join(' · ')}`);
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: `Enriched ${enrichedCount} orders for ${targetAsin} with marketplace-specific SP-API fees`,
        enrichedCount,
        failedCount,
        totalProcessed: ordersForAsin.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // SYNC ALL REFUNDS HISTORICAL - 2 years in 30-day chunks (background)
    // ================================================================
    if (requestBody.sync_all_refunds_historical === true) {
      console.log(`[REFUNDS_HISTORICAL] Starting full 2-year refund sync for user ${userId}`);
      
      // Create progress record
      const { data: progressData, error: progressError } = await supabase
        .from('pl_sync_progress')
        .insert({
          user_id: userId,
          status: 'running',
          current_chunk: 0,
          total_chunks: 24, // ~24 months
          message: 'Starting full historical refund sync (2 years)...',
          summary: { refundsFound: 0, refundsApplied: 0, refundsCreated: 0 },
        })
        .select('id')
        .single();
      
      if (progressError || !progressData) {
        return new Response(JSON.stringify({ error: 'Failed to create progress record' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      const progressId = progressData.id;
      console.log(`[REFUNDS_HISTORICAL] Created progress record: ${progressId}`);
      
      // Background processing function
      const backgroundProcess = async () => {
        try {
          const now = new Date(Date.now() - 3 * 60 * 1000);
          const twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
          
          // Split into 30-day chunks
          const chunks: Array<{ start: Date; end: Date }> = [];
          let chunkEnd = new Date(now);
          while (chunkEnd > twoYearsAgo) {
            const chunkStart = new Date(Math.max(chunkEnd.getTime() - 30 * 24 * 60 * 60 * 1000, twoYearsAgo.getTime()));
            chunks.push({ start: chunkStart, end: chunkEnd });
            chunkEnd = new Date(chunkStart.getTime() - 1);
          }
          
          console.log(`[REFUNDS_HISTORICAL] Processing ${chunks.length} chunks over 2 years`);
          
          let totalRefundsFound = 0;
          let totalRefundsApplied = 0;
          let totalRefundsCreated = 0;
          
          for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            const chunk = chunks[chunkIdx];
            const chunkNum = chunkIdx + 1;
            
            await supabase
              .from('pl_sync_progress')
              .update({
                current_chunk: chunkNum,
                total_chunks: chunks.length,
                message: `Processing chunk ${chunkNum}/${chunks.length}: ${chunk.start.toISOString().split('T')[0]} to ${chunk.end.toISOString().split('T')[0]}`,
                summary: { refundsFound: totalRefundsFound, refundsApplied: totalRefundsApplied, refundsCreated: totalRefundsCreated },
                updated_at: new Date().toISOString(),
              })
              .eq('id', progressId);
            
            console.log(`[REFUNDS_HISTORICAL] Chunk ${chunkNum}/${chunks.length}: ${chunk.start.toISOString()} to ${chunk.end.toISOString()}`);
            
            // Fetch refunds for this chunk
            let allRefundEvents: any[] = [];
            let nextToken: string | undefined;
            let pageCount = 0;
            
            do {
              const eventsUrl = new URL('https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents');
              eventsUrl.searchParams.set('PostedAfter', chunk.start.toISOString());
              eventsUrl.searchParams.set('PostedBefore', chunk.end.toISOString());
              eventsUrl.searchParams.set('MaxResultsPerPage', '100');
              if (nextToken) eventsUrl.searchParams.set('NextToken', nextToken);
              
              const headers = await signRequest('GET', eventsUrl.toString(), '', accessToken);
              const response = await fetch(eventsUrl.toString(), { method: 'GET', headers });
              
              if (!response.ok) {
                console.error(`[REFUNDS_HISTORICAL] API error on chunk ${chunkNum}: ${response.status}`);
                break;
              }
              
              const data = await response.json();
              const payload = data?.payload?.FinancialEvents;
              
              if (payload?.RefundEventList) {
                for (const event of payload.RefundEventList) {
                  allRefundEvents.push(event);
                }
              }
              
              nextToken = data?.payload?.NextToken;
              pageCount++;
              
              if (nextToken) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            } while (nextToken && pageCount < 20);
            
            console.log(`[REFUNDS_HISTORICAL] Chunk ${chunkNum}: Found ${allRefundEvents.length} refunds`);
            totalRefundsFound += allRefundEvents.length;
            
            // Process each refund
            for (const event of allRefundEvents) {
              const orderId = event.AmazonOrderId;
              // CRITICAL FIX: Use ShipmentItemAdjustmentList exclusively for refunds
              const refundItems = event.ShipmentItemAdjustmentList || [];
              if (!orderId || refundItems.length === 0) continue;
              
              // PERMANENT PREVENTION: aggregate all items in this refund event by
              // resolved ASIN, then upsert ONE canonical row per (order,asin,event_date)
              // keyed by fec_refund_key. The DB unique index (user_id, fec_refund_key)
              // rejects any duplicate insert at the database level.
              const isValidAsin = (val: string) => {
                if (!val || val === 'UNKNOWN') return false;
                if (val.length !== 10) return false;
                if (/^B0[A-Z0-9]{8}$/.test(val)) return true;
                if (/^\d{10}$/.test(val)) return true;
                return false;
              };
              const postedDate = event.PostedDate || new Date().toISOString();
              const ptDate = new Date(postedDate).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles' }).split(',')[0];

              // Pass 1: resolve ASIN per item and aggregate by ASIN
              const aggByAsin = new Map<string, { qty: number; amount: number; sku: string; title: string | null; imageUrl: string | null }>();
              for (const item of refundItems) {
                const itemQty = parseInt(item.QuantityReturned || item.QuantityShipped || item.Quantity || '1', 10);
                const itemRefundAmount = calculateSellerCentralRefundAmount(item);
                const rawAsin = item.ASIN || '';
                let asin = isValidAsin(rawAsin) ? rawAsin : 'UNKNOWN';
                const sellerSku = item.SellerSKU || '';
                if (asin === 'UNKNOWN' && sellerSku) {
                  const { data: skuLookup } = await supabase.from('created_listings').select('asin').eq('user_id', userId).eq('sku', sellerSku).maybeSingle();
                  if (skuLookup && isValidAsin(skuLookup.asin)) asin = skuLookup.asin;
                  if (asin === 'UNKNOWN') {
                    const { data: invLookup } = await supabase.from('inventory').select('asin').eq('user_id', userId).eq('sku', sellerSku).maybeSingle();
                    if (invLookup && isValidAsin(invLookup.asin)) asin = invLookup.asin;
                  }
                }
                if (asin === 'UNKNOWN') {
                  const { data: origOrder } = await supabase.from('sales_orders').select('asin').eq('user_id', userId).eq('order_id', orderId).maybeSingle();
                  if (origOrder && isValidAsin(origOrder.asin)) asin = origOrder.asin;
                }
                const prev = aggByAsin.get(asin) || { qty: 0, amount: 0, sku: sellerSku, title: null, imageUrl: null };
                aggByAsin.set(asin, { qty: prev.qty + itemQty, amount: prev.amount + itemRefundAmount, sku: prev.sku || sellerSku, title: prev.title, imageUrl: prev.imageUrl });
              }

              // Pass 2: enrich title/image once per ASIN, then upsert by fec_refund_key
              for (const [asin, agg] of aggByAsin.entries()) {
                let title: string | null = agg.title;
                let imageUrl: string | null = agg.imageUrl;
                if (asin !== 'UNKNOWN' && (!title || !imageUrl)) {
                  const { data: asinData } = await supabase.from('created_listings').select('title, image_url').eq('user_id', userId).eq('asin', asin).maybeSingle();
                  if (asinData) { title = title || asinData.title; imageUrl = imageUrl || asinData.image_url; }
                }
                if (!title || !imageUrl) {
                  const { data: origOrder } = await supabase.from('sales_orders').select('title, image_url').eq('user_id', userId).eq('order_id', orderId).maybeSingle();
                  if (origOrder) { title = title || origOrder.title; imageUrl = imageUrl || origOrder.image_url; }
                }
                const refundOrderId = `${orderId}-REFUND`;
                const fecRefundKey = `refund:${orderId}|${asin}|${ptDate}`;
                const { error: upsertErr } = await supabase
                  .from('sales_orders')
                  .upsert({
                    user_id: userId,
                    order_id: refundOrderId,
                    asin,
                    title: title ? `[REFUND] ${title}` : '[REFUND]',
                    image_url: imageUrl,
                    quantity: agg.qty,
                    sold_price: -agg.amount,
                    total_sale_amount: -agg.amount,
                    referral_fee: 0,
                    fba_fee: 0,
                    closing_fee: 0,
                    total_fees: 0,
                    refund_quantity: agg.qty,
                    refund_amount: agg.amount,
                    order_date: ptDate,
                    status: 'pending',
                    fec_refund_key: fecRefundKey,
                    // See the note on the bulk refund upsert above: the asin
                    // index is the constraint that actually gets violated.
                  }, { onConflict: 'user_id,order_id,asin' });
                if (!upsertErr) {
                  totalRefundsCreated++;
                } else {
                  console.error(`[REFUNDS_HISTORICAL] Upsert error for ${fecRefundKey}: ${upsertErr.message}`);
                }
              }
              
              totalRefundsApplied++;
            }
            
            // Update progress after each chunk
            await supabase
              .from('pl_sync_progress')
              .update({
                summary: { refundsFound: totalRefundsFound, refundsApplied: totalRefundsApplied, refundsCreated: totalRefundsCreated },
                updated_at: new Date().toISOString(),
              })
              .eq('id', progressId);
            
            // Delay between chunks to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          // Mark complete
          await supabase
            .from('pl_sync_progress')
            .update({
              status: 'complete',
              message: `Complete! Found ${totalRefundsFound} refunds, created ${totalRefundsCreated} records`,
              summary: { refundsFound: totalRefundsFound, refundsApplied: totalRefundsApplied, refundsCreated: totalRefundsCreated },
              updated_at: new Date().toISOString(),
            })
            .eq('id', progressId);
          
          console.log(`[REFUNDS_HISTORICAL] Complete: Found ${totalRefundsFound}, created ${totalRefundsCreated}`);
          
        } catch (err: any) {
          console.error('[REFUNDS_HISTORICAL] Error:', err);
          await supabase
            .from('pl_sync_progress')
            .update({ status: 'error', error: (err as Error).message || 'Unknown error' })
            .eq('id', progressId);
        }
      };
      
      // Start background processing
      (globalThis as any).EdgeRuntime?.waitUntil?.(backgroundProcess());
      
      return new Response(JSON.stringify({
        success: true,
        progressId,
        message: 'Full historical refund sync started (2 years in 30-day chunks)',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // SYNC REFUNDS ONLY - Force fetch refunds for last N days OR custom date range (with live progress)
    // ================================================================
    if (requestBody.sync_refunds_only === true) {
      const daysBack = requestBody.refund_days || 30;
      const customStartDate = requestBody.custom_start_date; // Format: YYYY-MM-DD
      const customEndDate = requestBody.custom_end_date; // Format: YYYY-MM-DD
      const trackProgress = requestBody.track_progress === true;
      
      let startDate: Date;
      let endDate: Date;
      
      if (customStartDate && customEndDate) {
        // Use custom date range (add timezone offset for Pacific Time)
        startDate = new Date(`${customStartDate}T00:00:00-08:00`);
        endDate = new Date(`${customEndDate}T23:59:59-08:00`);
        console.log(`[REFUNDS] Fetching refunds for custom range: ${customStartDate} to ${customEndDate} for user ${userId}`);
      } else {
        // Use default days back
        const now = new Date(Date.now() - 3 * 60 * 1000);
        endDate = now;
        startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
        console.log(`[REFUNDS] Fetching refunds for last ${daysBack} days for user ${userId}`);
      }
      
      // Create progress record if tracking is enabled
      let progressId: string | null = null;
      if (trackProgress) {
        const { data: progressData, error: progressError } = await supabase
          .from('pl_sync_progress')
          .insert({
            user_id: userId,
            status: 'running',
            current_chunk: 0,
            total_chunks: 1,
            message: 'Starting refund sync...',
            summary: { refundsFound: 0, refundsApplied: 0 },
          })
          .select('id')
          .single();
        
        if (!progressError && progressData) {
          progressId = progressData.id;
          console.log(`[REFUNDS] Created progress record: ${progressId}`);
        }
      }
      
      // Helper to update progress
      const updateProgress = async (message: string, currentPage: number, totalPages: number, refundsFound: number, refundsApplied: number, status = 'running') => {
        if (!progressId) return;
        await supabase
          .from('pl_sync_progress')
          .update({
            status,
            current_chunk: currentPage,
            total_chunks: totalPages,
            message,
            summary: { refundsFound, refundsApplied },
            updated_at: new Date().toISOString(),
          })
          .eq('id', progressId);
      };
      
      // Return immediately with progressId if tracking
      if (trackProgress && progressId) {
        const backgroundProcess = async () => {
          try {
            const startKey = getPacificDateString(startDate.toISOString());
            const endKey = getPacificDateString(endDate.toISOString());
            const result = await syncRefundRowsFromFinancialEventsCache(
              supabase,
              userId,
              startKey,
              endKey,
              updateProgress,
            );

            console.log(`[REFUNDS] Cache sync complete: found=${result.refundsFound}, applied=${result.refundsApplied}, created=${result.refundsCreated}`);
            await updateProgress(
              `Complete: ${result.refundsFound} refunds found, ${result.refundsApplied} updated, ${result.refundsCreated} created`,
              1,
              1,
              result.refundsFound,
              result.refundsApplied + result.refundsCreated,
              'done',
            );
          } catch (err: any) {
            console.error('[REFUNDS] Background error:', err);
            if (progressId) {
              await supabase
                .from('pl_sync_progress')
                .update({ status: 'error', error: (err as Error).message || 'Unknown error' })
                .eq('id', progressId);
            }
          }
        };
        
        // Start background processing
        (globalThis as any).EdgeRuntime?.waitUntil?.(backgroundProcess());
        
        return new Response(JSON.stringify({
          success: true,
          progressId,
          message: 'Refund sync started in background',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      // NON-BACKGROUND PATH: Process refunds synchronously
      let allRefundEvents: any[] = [];
      let nextToken: string | undefined;
      let pageCount = 0;
      const maxPages = 30;
      
      do {
        const eventsUrl = new URL('https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents');
        eventsUrl.searchParams.set('PostedAfter', startDate.toISOString());
        eventsUrl.searchParams.set('PostedBefore', endDate.toISOString());
        eventsUrl.searchParams.set('MaxResultsPerPage', '100');
        if (nextToken) eventsUrl.searchParams.set('NextToken', nextToken);
        
        const headers = await signRequest('GET', eventsUrl.toString(), '', accessToken);
        const response = await fetch(eventsUrl.toString(), { method: 'GET', headers });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[REFUNDS] API error: ${response.status} - ${errorText}`);
          break;
        }
        
        const data = await response.json();
        const payload = data?.payload?.FinancialEvents;
        
        if (payload?.RefundEventList) {
          for (const event of payload.RefundEventList) {
            allRefundEvents.push({ ...event, _eventType: 'refund' });
          }
        }
        
        nextToken = data?.payload?.NextToken;
        pageCount++;
        
        if (nextToken) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } while (nextToken && pageCount < maxPages);
      
      console.log(`[REFUNDS] Total: Found ${allRefundEvents.length} refund events across ${pageCount} pages`);
      
      let appliedCount = 0;
      let createdCount = 0;
      
      for (const event of allRefundEvents) {
        const orderId = event.AmazonOrderId;
        const refundItems = event.ShipmentItemAdjustmentList || [];
        if (!orderId || refundItems.length === 0) continue;
        
        const refundOrderId = `${orderId}-REFUND`;
        const ptDate = getPacificDateString(event.PostedDate || new Date().toISOString());
        
        // ⚠️ NOT .maybeSingle(). PostgREST returns an ERROR, not a row, when more
        // than one row matches -- and an order refunded across two ASINs has two
        // -REFUND rows, because sales_orders is uniquely indexed on
        // (user_id, order_id, asin) and refunds are stored per ASIN.
        //
        // With .maybeSingle() that error was never destructured, so `data` came
        // back null, this code concluded "no refund row exists", fell through to
        // the INSERT below, and violated the very index that guaranteed the
        // second row existed. Not once -- every run, forever, because nothing
        // about the situation ever changed. Logged 2026-08-22 on
        // 111-2004018-7122615-REFUND / B016Q4DMDA, roughly every ten minutes for
        // as long as the event stayed inside the Financial Events window.
        //
        // Taking [0] preserves the single-row behaviour exactly; the point of
        // the change is that a multi-ASIN refund no longer reads as "missing".
        const { data: existingRefundRows, error: existingRefundErr } = await supabase
          .from('sales_orders')
          .select('id, asin, refund_amount')
          .eq('user_id', userId)
          .eq('order_id', refundOrderId);
        if (existingRefundErr) {
          console.error(`REFUND_LOOKUP_ERROR ${refundOrderId}: ${existingRefundErr.message}`);
        }
        const existingRefund = (existingRefundRows || [])[0] ?? null;
        
        let totalRefundAmount = 0;
        let totalRefundQty = 0;
        for (const item of refundItems) {
          const qty = parseInt(item.QuantityShipped || item.Quantity || '1', 10);
          totalRefundQty += qty;
          totalRefundAmount += calculateSellerCentralRefundAmount(item);
        }
        totalRefundAmount = Number(totalRefundAmount.toFixed(2));
        
        if (existingRefund) {
          // Always update to recomputed NET so existing rows match Seller Central
          const prev = Number(existingRefund.refund_amount || 0);
          if (Math.abs(prev - totalRefundAmount) > 0.005) {
            await supabase
              .from('sales_orders')
              .update({
                refund_quantity: totalRefundQty,
                refund_amount: totalRefundAmount,
                sold_price: -totalRefundAmount,
                total_sale_amount: -totalRefundAmount,
                updated_at: new Date().toISOString(),
              })
              .eq('id', existingRefund.id);
            console.log(`💸 NET_RECALC sync ${existingRefund.id}: $${prev.toFixed(2)} -> $${totalRefundAmount.toFixed(2)}`);
            appliedCount++;
          }
        } else {
          // Look up ASIN from original order
          let asin = 'UNKNOWN';
          let title: string | null = null;
          let imageUrl: string | null = null;
          
          // Same trap as above: a multi-ASIN order matches several rows, so
          // .maybeSingle() errored and left asin as the 'UNKNOWN' placeholder.
          // There is no single right ASIN for a multi-item order here, but the
          // first real one beats a placeholder that has to be repaired later.
          const { data: originalOrderRows } = await supabase
            .from('sales_orders')
            .select('asin, title, image_url')
            .eq('user_id', userId)
            .eq('order_id', orderId)
            .limit(20);
          const originalOrder = (originalOrderRows || [])[0] ?? null;
          
          if (originalOrder) {
            asin = originalOrder.asin || 'UNKNOWN';
            title = originalOrder.title;
            imageUrl = originalOrder.image_url;
          }
          
          // upsert on the index that was actually being violated, and capture
          // the error -- this call swallowed it entirely, so the only evidence
          // the write had failed was in the Postgres log.
          const { error: refundInsertErr } = await supabase
            .from('sales_orders')
            .upsert({
              user_id: userId,
              order_id: refundOrderId,
              asin,
              title: title ? `[REFUND] ${title}` : '[REFUND]',
              image_url: imageUrl,
              quantity: totalRefundQty,
              sold_price: -totalRefundAmount,
              total_sale_amount: -totalRefundAmount,
              referral_fee: 0,
              fba_fee: 0,
              closing_fee: 0,
              total_fees: 0,
              refund_quantity: totalRefundQty,
              refund_amount: totalRefundAmount,
              order_date: ptDate,
              status: 'pending',
            }, { onConflict: 'user_id,order_id,asin' });
          if (refundInsertErr) {
            console.error(`REFUND_INSERT_ERROR ${refundOrderId} / ${asin}: ${refundInsertErr.message}`);
          } else {
            createdCount++;
          }
        }
      }
      
      // Also run early refund detection
      const earlyRefundsCount = await detectEarlyRefundsViaOrdersApi(supabase, userId, accessToken, authData.marketplace_id, 30);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Found ${allRefundEvents.length} refunds: ${appliedCount} updated, ${createdCount} created, ${earlyRefundsCount} early refunds detected`,
        refundsFound: allRefundEvents.length,
        refundsApplied: appliedCount,
        refundsCreated: createdCount,
        earlyRefundsDetected: earlyRefundsCount,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // ENRICH MISSING ONLY - Fetch image/title for specific orders
    // ================================================================
    if (requestBody.enrich_missing_only === true && Array.isArray(requestBody.order_ids)) {
      console.log(`🔄 ENRICH_MISSING: Fetching missing data for ${requestBody.order_ids.length} orders`);
      
      const orderIds = requestBody.order_ids as string[];
      let enrichedCount = 0;
      
      // Fetch orders that need enrichment
      const { data: ordersToEnrich, error: fetchErr } = await supabase
        .from('sales_orders')
        .select('*')
        .eq('user_id', userId)
        .in('order_id', orderIds);
      
      if (fetchErr || !ordersToEnrich) {
        console.error('Failed to fetch orders for enrichment:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch orders for enrichment',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      for (const order of ordersToEnrich) {
        const needsImage = !order.image_url;
        const needsTitle = !order.title || order.title === 'Order Processing...' || order.title === 'Untitled Product';
        
        if (!needsImage && !needsTitle) continue;
        
        const asin = order.asin;
        if (!asin || asin === 'PENDING' || asin === 'UNKNOWN') continue;
        
        try {
          // Fetch from SP-API Catalog
          const catalogData = await fetchCatalogItem(accessToken, asin);
          
          const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
          
          if (needsImage && catalogData?.imageUrl) {
            updateData.image_url = catalogData.imageUrl;
          }
          if (needsTitle && catalogData?.title) {
            updateData.title = catalogData.title;
          }
          
          if (Object.keys(updateData).length > 1) {
            await supabase
              .from('sales_orders')
              .update(updateData)
              .eq('id', order.id);
            
            enrichedCount++;
            console.log(`✅ ENRICHED_MISSING: ${order.order_id} - title: ${!!catalogData?.title}, image: ${!!catalogData?.imageUrl}`);
          }
          
          // Rate limit protection
          await new Promise(resolve => setTimeout(resolve, 300));
          
        } catch (err: any) {
          console.log(`⚠️ ENRICH_FAILED: ${order.order_id} (${asin}): ${err?.message || err}`);
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: `Fixed missing data for ${enrichedCount} orders`,
        enrichedCount,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // FIX UNIT COSTS - Repair wrong unit costs using inventory-first logic
    // ================================================================
    if (requestBody.fix_unit_costs === true) {
      console.log(`💰 FIX_UNIT_COSTS: Starting unit cost repair for user ${userId}`);
      
      // Fetch all pending orders from recent days (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { data: ordersToFix, error: fetchErr } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, unit_cost, quantity, sold_price, total_fees, marketplace, total_sale_amount, price_source, price_calc_mode, estimated_price')
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString());

      if (fetchErr || !ordersToFix) {
        console.error('Failed to fetch orders for unit cost fix:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch orders',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`💰 FIX_UNIT_COSTS: Checking ${ordersToFix.length} orders from last 30 days`);
      const fixUnitCostsFxRates = await fetchFxRates(supabase);
      const fixUnitCostsToUsd = (amount: number, mp: string | null | undefined) =>
        convertToUsd(amount, getMarketplaceCurrency(mp), fixUnitCostsFxRates);
      
      // Get all unique ASINs
      const uniqueAsins = [...new Set(ordersToFix.map(o => o.asin).filter(Boolean))];
      console.log(`💰 FIX_UNIT_COSTS: Found ${uniqueAsins.length} unique ASINs`);
      
      // Fetch from both created_listings and inventory tables
      const listMap = await buildCostDataMap(supabase, userId, uniqueAsins);
      
      let fixedCount = 0;
      
      for (const order of ordersToFix) {
        if (!order.asin) continue;
        
        // Use the centralized resolver (created_listings + inventory)
        const correctUnitCost = resolveUnitCostForAsin(order.asin, listMap);
        
        // Debug log for specific ASINs
        if (['B0CFF4C9DC', 'B000EX3208', 'B00004U4N8'].includes(order.asin)) {
          console.log(`💰 DEBUG_ASIN: ${order.asin} - current_unit_cost=${order.unit_cost}, resolved_unit_cost=${correctUnitCost}`);
        }
        
        // Skip if no valid cost found
        if (!correctUnitCost || correctUnitCost <= 0) {
          continue;
        }
        
        // Skip if cost is the same (within 1 cent)
        if (order.unit_cost && Math.abs(correctUnitCost - order.unit_cost) < 0.01) {
          continue;
        }
        
        // Skip unreasonable costs (likely data errors)
        if (correctUnitCost > 500) {
          console.log(`💰 SKIP_HIGH_COST: ${order.asin} -> $${correctUnitCost} (too high, skipping)`);
          continue;
        }
        
        // Calculate new ROI — currency-safe: sold_price on non-US orders may be
        // stored native or USD depending on which writer touched it (see
        // Sales Currency Contract), so use the same source-aware guard the
        // frontend uses rather than treating it as USD unconditionally.
        const qty = order.quantity || 1;
        const totalCost = correctUnitCost * qty;
        const totalFees = Math.abs(order.total_fees || 0);
        const totalSale = getConfirmedSalesOrderRevenueUsd(order as any, fixUnitCostsToUsd);
        const netProfit = totalSale - totalFees - totalCost;
        const newRoi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;
        const roundedRoi = Math.round(newRoi * 10) / 10;

        console.log(`💰 UNIT_COST_FIX: ${order.order_id} (${order.asin}) - old: $${order.unit_cost?.toFixed(2) || 'null'} -> new: $${correctUnitCost.toFixed(2)}, ROI: ${roundedRoi}%`);
        
        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update({
            unit_cost: correctUnitCost,
            total_cost: totalCost,
            roi: roundedRoi,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        if (!updateErr) {
          fixedCount++;
        }
      }
      
      console.log(`💰 FIX_UNIT_COSTS complete: Fixed ${fixedCount} orders`);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Fixed unit costs for ${fixedCount} orders`,
        fixedCount,
        totalChecked: ordersToFix.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // REFRESH ALL UNIT COSTS - Update ALL orders from created_listings (no API calls)
    // This is purely DB operations, no rate limit concerns
    // ================================================================
    if (requestBody.refresh_all_unit_costs === true) {
      console.log(`💰 REFRESH_ALL_UNIT_COSTS: Starting full unit cost refresh for user ${userId}`);
      
      // Fetch ALL sales orders for this user (no date filter)
      const { data: allOrders, error: fetchErr } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, unit_cost, quantity, sold_price, total_fees, marketplace, total_sale_amount, price_source, price_calc_mode, estimated_price')
        .eq('user_id', userId);

      if (fetchErr || !allOrders) {
        console.error('Failed to fetch all orders for unit cost refresh:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch orders',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`💰 REFRESH_ALL_UNIT_COSTS: Found ${allOrders.length} total orders`);
      const refreshAllFxRates = await fetchFxRates(supabase);
      const refreshAllToUsd = (amount: number, mp: string | null | undefined) =>
        convertToUsd(amount, getMarketplaceCurrency(mp), refreshAllFxRates);
      
      // Get all unique ASINs
      const uniqueAsins = [...new Set(allOrders.map(o => o.asin).filter(Boolean))];
      console.log(`💰 REFRESH_ALL_UNIT_COSTS: Found ${uniqueAsins.length} unique ASINs`);
      
      if (uniqueAsins.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          message: 'No orders to refresh',
          fixedCount: 0,
          totalChecked: 0,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      // Fetch from both created_listings and inventory tables
      const listMap = await buildCostDataMap(supabase, userId, uniqueAsins);
      
      let fixedCount = 0;
      let skippedCount = 0;
      
      for (const order of allOrders) {
        if (!order.asin) {
          skippedCount++;
          continue;
        }
        
        // Use the centralized resolver (created_listings + inventory)
        const correctUnitCost = resolveUnitCostForAsin(order.asin, listMap);
        
        // Skip if no valid cost found
        if (!correctUnitCost || correctUnitCost <= 0) {
          skippedCount++;
          continue;
        }
        
        // Skip if cost is already correct (within 1 cent)
        if (order.unit_cost && Math.abs(correctUnitCost - order.unit_cost) < 0.01) {
          continue;
        }
        
        // Skip unreasonable costs (likely data errors)
        if (correctUnitCost > 500) {
          console.log(`💰 SKIP_HIGH_COST: ${order.asin} -> $${correctUnitCost} (too high, skipping)`);
          skippedCount++;
          continue;
        }
        
        // Calculate new ROI — currency-safe, same source-aware guard as above.
        const qty = order.quantity || 1;
        const totalCost = correctUnitCost * qty;
        const totalFees = Math.abs(order.total_fees || 0);
        const totalSale = getConfirmedSalesOrderRevenueUsd(order as any, refreshAllToUsd);
        const netProfit = totalSale - totalFees - totalCost;
        const newRoi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;
        const roundedRoi = Math.round(newRoi * 10) / 10;

        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update({
            unit_cost: correctUnitCost,
            total_cost: totalCost,
            roi: roundedRoi,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        if (!updateErr) {
          fixedCount++;
        }
      }

      console.log(`💰 REFRESH_ALL_UNIT_COSTS complete: Fixed ${fixedCount} of ${allOrders.length} orders`);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Refreshed unit costs for ${fixedCount} orders`,
        fixedCount,
        totalChecked: allOrders.length,
        skipped: skippedCount,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // RECALCULATE FEES - Fetch actual fees from SP-API for specified orders
    // ================================================================
    if (requestBody.recalculate_fees === true) {
      const targetDate = requestBody.target_date;
      const targetAsin = requestBody.target_asin;
      
      console.log(`💰 RECALCULATE_FEES: Starting fee recalculation for user ${userId}${targetDate ? ` on ${targetDate}` : ''}${targetAsin ? ` for ASIN ${targetAsin}` : ''}`);
      
      // Build query - get orders that need fee recalculation
      let query = supabase
        .from('sales_orders')
        .select('id, order_id, asin, sold_price, total_fees, unit_cost, quantity, referral_fee, fba_fee, closing_fee, marketplace, total_sale_amount, price_source, price_calc_mode, estimated_price')
        .eq('user_id', userId)
        .gt('sold_price', 0);
      
      if (targetDate) {
        query = query.eq('order_date', targetDate);
      }
      if (targetAsin) {
        query = query.eq('asin', targetAsin);
      }
      
      // Default: only recalculate orders from last 30 days if no date specified
      if (!targetDate && !targetAsin) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        query = query.gte('created_at', thirtyDaysAgo.toISOString());
      }
      
      const { data: ordersToRecalc, error: fetchErr } = await query.limit(100);
      
      if (fetchErr || !ordersToRecalc) {
        console.error('Failed to fetch orders for fee recalculation:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch orders',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`💰 RECALCULATE_FEES: Found ${ordersToRecalc.length} orders to process`);
      const recalcFeesFxRates = await fetchFxRates(supabase);
      const recalcFeesToUsd = (amount: number, mp: string | null | undefined) =>
        convertToUsd(amount, getMarketplaceCurrency(mp), recalcFeesFxRates);

      let updatedCount = 0;
      let skippedCount = 0;
      
      for (const order of ordersToRecalc) {
        if (!order.asin || !order.sold_price || order.sold_price <= 0) {
          skippedCount++;
          continue;
        }
        
        // Fetch actual fees from SP-API
        const apiFees = await fetchProductFees(accessToken, order.asin, order.sold_price);
        
        if (!apiFees) {
          console.log(`💰 RECALCULATE_FEES: No API fees for ${order.asin}, skipping`);
          skippedCount++;
          continue;
        }
        
        const qty = order.quantity || 1;
        const oldTotalFees = Math.abs(order.total_fees || 0);
        const newReferralFee = Math.round((apiFees.referralFee * qty) * 100) / 100;
        const newFbaFee = Math.round((apiFees.fbaFee * qty) * 100) / 100;
        const newClosingFee = Math.round((apiFees.closingFee * qty) * 100) / 100;
        const newTotalFees = Math.round((apiFees.totalFees * qty) * 100) / 100;
        
        // Only update if fees changed significantly (more than 1 cent)
        if (Math.abs(oldTotalFees - newTotalFees) < 0.01) {
          console.log(`💰 RECALCULATE_FEES: ${order.asin} fees unchanged ($${oldTotalFees.toFixed(2)} -> $${newTotalFees.toFixed(2)})`);
          skippedCount++;
          continue;
        }
        
        // Recalculate ROI with new fees — currency-safe, same source-aware guard as above.
        const totalSale = getConfirmedSalesOrderRevenueUsd(order as any, recalcFeesToUsd);
        const unitCost = order.unit_cost || 0;
        const totalCost = unitCost * qty;
        const netProfit = totalSale - newTotalFees - totalCost;
        const newRoi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;
        const roundedRoi = Math.round(newRoi * 10) / 10;
        
        console.log(`💰 RECALCULATE_FEES: ${order.asin} fees: $${oldTotalFees.toFixed(2)} -> $${newTotalFees.toFixed(2)}, ROI: ${roundedRoi}%`);
        
        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update({
            referral_fee: newReferralFee,
            fba_fee: newFbaFee,
            closing_fee: newClosingFee,
            total_fees: newTotalFees,
            roi: roundedRoi,
            total_cost: totalCost > 0 ? totalCost : null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        if (!updateErr) {
          updatedCount++;
        }
        
        // Rate limiting: 500ms delay between API calls
        await new Promise(r => setTimeout(r, 500));
      }
      
      console.log(`💰 RECALCULATE_FEES complete: Updated ${updatedCount}, skipped ${skippedCount}`);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Recalculated fees for ${updatedCount} orders (${skippedCount} skipped)`,
        updatedCount,
        skippedCount,
        totalChecked: ordersToRecalc.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // BACKFILL DAILY ROLLUP - Populate asin_sales_daily from sales_orders
    // Idempotent: safe to run multiple times, uses upsert on (user_id, asin, date, marketplace)
    // ================================================================
    if (requestBody.backfill_daily_rollup === true) {
      const daysBack = requestBody.days_back || 7;
      console.log(`📊 BACKFILL_DAILY_ROLLUP: Starting for user ${userId}, last ${daysBack} days`);

      // Get today in Pacific Time
      const nowPT = new Date().toLocaleString('en-CA', { timeZone: 'America/Los_Angeles' });
      const todayPT = nowPT.split(',')[0];

      // Calculate start date
      const startDate = new Date(todayPT + 'T12:00:00');
      startDate.setDate(startDate.getDate() - daysBack);
      const startDateStr = startDate.toISOString().slice(0, 10);

      console.log(`📊 BACKFILL_DAILY_ROLLUP: Range ${startDateStr} to ${todayPT}`);

      // Count before
      const { count: beforeCount } = await supabase
        .from('asin_sales_daily')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('date', startDateStr);

      // Fetch all non-cancelled, non-refund sales_orders in range
      const pageSize = 1000;
      let from = 0;
      const allRows: { asin: string; quantity: number; order_date: string; marketplace: string }[] = [];

      while (true) {
        const { data, error } = await supabase
          .from('sales_orders')
          .select('asin, quantity, order_date, marketplace')
          .eq('user_id', userId)
          .gte('order_date', startDateStr)
          .neq('asin', 'PENDING')
          .neq('asin', 'UNKNOWN')
          .not('order_id', 'like', '%-REFUND')
          .or('is_cancelled.is.null,is_cancelled.eq.false')
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('BACKFILL_DAILY_ROLLUP fetch error:', (error as Error).message);
          break;
        }
        allRows.push(...(data || []).map((r: any) => ({
          asin: (r.asin || '').trim(),
          quantity: r.quantity || 1,
          order_date: r.order_date || todayPT,
          marketplace: r.marketplace || 'US',
        })));
        if ((data || []).length < pageSize) break;
        from += pageSize;
      }

      console.log(`📊 BACKFILL_DAILY_ROLLUP: Found ${allRows.length} order rows to aggregate`);

      // Aggregate by (asin, date, marketplace)
      const agg: Record<string, { units: number; revenue: number }> = {};
      for (const row of allRows) {
        if (!row.asin) {
          console.warn(`⚠️ ROLLUP_SKIP_MISSING_ASIN: user_id=${userId}, order_date=${row.order_date}, marketplace=${row.marketplace}`);
          continue;
        }
        if (!row.order_date) {
          console.warn(`⚠️ ROLLUP_SKIP_MISSING_DATE: user_id=${userId}, asin=${row.asin}, marketplace=${row.marketplace}`);
          continue;
        }
        const key = `${row.asin}|${row.order_date}|${row.marketplace}`;
        if (!agg[key]) agg[key] = { units: 0, revenue: 0 };
        agg[key].units += row.quantity;
      }

      // Upsert into asin_sales_daily
      const upsertRows = Object.entries(agg).map(([key, val]) => {
        const [asin, date, marketplace] = key.split('|');
        return {
          user_id: userId,
          asin,
          date,
          marketplace,
          units: val.units,
          revenue: 0,
          last_updated_at: new Date().toISOString(),
        };
      });

      let upsertedCount = 0;
      // Batch upsert in chunks of 200
      for (let i = 0; i < upsertRows.length; i += 200) {
        const batch = upsertRows.slice(i, i + 200);
        const { error: upsertErr } = await supabase
          .from('asin_sales_daily')
          .upsert(batch, { onConflict: 'user_id,asin,date,marketplace' });

        if (upsertErr) {
          console.error(`BACKFILL_DAILY_ROLLUP upsert error (batch ${i}):`, upsertErr.message);
        } else {
          upsertedCount += batch.length;
        }
      }

      // Count after
      const { count: afterCount } = await supabase
        .from('asin_sales_daily')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('date', startDateStr);

      // Today-specific counts
      const { count: todayAfter } = await supabase
        .from('asin_sales_daily')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('date', todayPT);

      const todayUnits = upsertRows
        .filter(r => r.date === todayPT)
        .reduce((sum, r) => sum + r.units, 0);

      console.log(`📊 BACKFILL_DAILY_ROLLUP complete:
  Before: ${beforeCount || 0} rows in range
  After: ${afterCount || 0} rows in range
  Today rows: ${todayAfter || 0}
  Today units: ${todayUnits}
  Total upserted: ${upsertedCount}`);

      return new Response(JSON.stringify({
        success: true,
        message: `Backfilled ${upsertedCount} rollup rows`,
        before: { totalRows: beforeCount || 0 },
        after: { totalRows: afterCount || 0, todayRows: todayAfter || 0, todayUnits },
        orderRowsProcessed: allRows.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // FIX ROI ONLY - Recalculate ROI for orders with -100 or null ROI
    // ================================================================
    if (requestBody.fix_roi_only === true) {
      console.log(`📊 FIX_ROI: Starting ROI recalculation for user ${userId}`);
      
      // Find orders with bad ROI values
      const { data: badRoiOrders, error: fetchErr } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, sku, sold_price, total_fees, unit_cost, quantity, roi, status')
        .eq('user_id', userId)
        .or('roi.eq.-100,roi.is.null,roi.lte.-99');
      
      if (fetchErr || !badRoiOrders) {
        console.error('Failed to fetch orders for ROI fix:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch orders for ROI fix',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`📊 FIX_ROI: Found ${badRoiOrders.length} orders with bad ROI`);
      
      // BATCH: Get all unique ASINs and fetch cost data upfront
      const uniqueAsins = [...new Set(badRoiOrders.map(o => o.asin).filter(Boolean))];
      
      // Use the centralized cost data builder
      const listMap = await buildCostDataMap(supabase, userId, uniqueAsins);
      
      let fixedCount = 0;
      let costLookupCount = 0;
      
      for (const order of badRoiOrders) {
        let unitCost = order.unit_cost;
        
        // If no unit_cost or it seems wrong (> $100), use the resolver
        if (!unitCost || unitCost <= 0 || unitCost > 100) {
          const resolvedCost = resolveUnitCostForAsin(order.asin, listMap);
          if (resolvedCost && resolvedCost > 0) {
            unitCost = resolvedCost;
            costLookupCount++;
          }
        }
        
        // Calculate ROI if we have all the data
        const soldPrice = order.sold_price || 0;
        const totalFees = Math.abs(order.total_fees || 0);
        const qty = order.quantity || 1;
        
        if (soldPrice > 0 && unitCost && unitCost > 0) {
          const totalCost = unitCost * qty;
          const totalSale = soldPrice * qty;
          const netProfit = totalSale - totalFees - totalCost;
          const newRoi = (netProfit / totalCost) * 100;
          const roundedRoi = Math.round(newRoi * 10) / 10;
          
          const updateData: Record<string, any> = {
            roi: roundedRoi,
            total_cost: totalCost,
            updated_at: new Date().toISOString(),
          };
          
          // Also update unit_cost if we looked it up
          if (!order.unit_cost || order.unit_cost <= 0) {
            updateData.unit_cost = unitCost;
          }
          
          const { error: updateErr } = await supabase
            .from('sales_orders')
            .update(updateData)
            .eq('id', order.id);
          
          if (!updateErr) {
            fixedCount++;
            console.log(`📊 ROI_FIXED: ${order.order_id} -> price=$${soldPrice.toFixed(2)} - fees=$${(totalFees/qty).toFixed(2)} - cost=$${unitCost.toFixed(2)} = ROI=${roundedRoi.toFixed(1)}%`);
          }
        } else {
          console.log(`⚠️ ROI_SKIP: ${order.order_id} (${order.asin}) - missing data: price=$${soldPrice}, cost=$${unitCost || 'null'}`);
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: `Fixed ROI for ${fixedCount} orders (${costLookupCount} costs looked up)`,
        fixedCount,
        costLookupCount,
        totalChecked: badRoiOrders.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // RECALCULATE COSTS - Force re-fetch unit costs from inventory/created_listings
    // ================================================================
    if (requestBody.recalculate_costs === true) {
      console.log(`💰 RECALC_COSTS: Starting cost recalculation for user ${userId}`);
      
      // Fetch all orders that have a unit_cost (we want to recalculate them)
      const { data: ordersToFix, error: fetchErr } = await supabase
        .from('sales_orders')
        .select('id, order_id, asin, sku, sold_price, total_fees, unit_cost, quantity')
        .eq('user_id', userId)
        .not('unit_cost', 'is', null);
      
      if (fetchErr || !ordersToFix) {
        console.error('Failed to fetch orders for cost recalc:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch orders',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`💰 RECALC_COSTS: Checking ${ordersToFix.length} orders`);
      
      // Get unique ASINs
      const uniqueAsins = [...new Set(ordersToFix.map(o => o.asin).filter(Boolean))];
      
      // Fetch inventory data for all ASINs at once
      const { data: inventoryData } = await supabase
        .from('inventory')
        .select('asin, amount, units, cost')
        .eq('user_id', userId)
        .in('asin', uniqueAsins);
      
      const { data: listingsData } = await supabase
        .from('created_listings')
        .select('asin, amount, units, cost')
        .eq('user_id', userId)
        .in('asin', uniqueAsins);
      
      // Build lookup maps
      const invMap = new Map<string, any>();
      inventoryData?.forEach(item => {
        if (item.asin) invMap.set(item.asin, item);
      });
      
      const listMap = new Map<string, any>();
      listingsData?.forEach(item => {
        if (item.asin) listMap.set(item.asin, item);
      });
      
      let fixedCount = 0;
      
      for (const order of ordersToFix) {
        // Calculate correct unit cost from inventory/listings
        let correctUnitCost: number | null = null;
        
        // Try inventory first (priority)
        const invItem = invMap.get(order.asin);
        if (invItem) {
          if (invItem.amount && invItem.amount > 0 && invItem.units && invItem.units > 0) {
            correctUnitCost = invItem.amount / invItem.units;
          } else if (invItem.cost && invItem.cost > 0) {
            correctUnitCost = invItem.cost;
          }
        }
        
        // Fallback to created_listings
        if (!correctUnitCost) {
          const listItem = listMap.get(order.asin);
          if (listItem) {
            if (listItem.amount && listItem.amount > 0 && listItem.units && listItem.units > 0) {
              correctUnitCost = listItem.amount / listItem.units;
            } else if (listItem.cost && listItem.cost > 0) {
              correctUnitCost = listItem.cost;
            }
          }
        }
        
        // Skip if no correct cost found or if cost is the same
        if (!correctUnitCost || Math.abs(correctUnitCost - (order.unit_cost || 0)) < 0.01) {
          continue;
        }
        
        // Calculate new ROI
        const soldPrice = order.sold_price || 0;
        const totalFees = Math.abs(order.total_fees || 0);
        const qty = order.quantity || 1;
        const totalCost = correctUnitCost * qty;
        const totalSale = soldPrice * qty;
        const netProfit = totalSale - totalFees - totalCost;
        const newRoi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;
        const roundedRoi = Math.round(newRoi * 10) / 10;
        
        console.log(`💰 COST_FIX: ${order.order_id} (${order.asin}) - old: $${order.unit_cost?.toFixed(2)} -> new: $${correctUnitCost.toFixed(2)}, ROI: ${roundedRoi}%`);
        
        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update({
            unit_cost: correctUnitCost,
            total_cost: totalCost,
            roi: roundedRoi,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        
        if (!updateErr) {
          fixedCount++;
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: `Recalculated ${fixedCount} orders with corrected unit costs`,
        fixedCount,
        totalChecked: ordersToFix.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // REFRESH SINGLE ASIN BUY BOX PRICE
    // NOTE: Buy Box is CURRENT market price (may be another seller), not your sold price.
    // We only update inventory.amazon_price (reference), never sales_orders.sold_price.
    // ================================================================
    if (requestBody.refresh_single_asin === true && requestBody.asin) {
      const targetAsin = requestBody.asin;
      console.log(`💰 REFRESH_SINGLE: Fetching Buy Box price for ${targetAsin} (inventory only)`);

      const buyBoxPrice = await fetchBuyBoxPrice(accessToken, targetAsin);
      if (!buyBoxPrice || buyBoxPrice <= 0) {
        return new Response(JSON.stringify({
          success: false,
          message: `No Buy Box price found for ${targetAsin}`,
          asin: targetAsin,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Update inventory amazon_price as a reference (does NOT affect Sales report sold prices)
      const { error: invErr } = await supabase
        .from('inventory')
        .update({
          amazon_price: buyBoxPrice,
          last_price_confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('asin', targetAsin);

      if (invErr) {
        console.error('REFRESH_SINGLE: Failed to update inventory amazon_price', invErr);
      }

      return new Response(JSON.stringify({
        success: true,
        message: `Updated inventory Buy Box reference for ${targetAsin}: $${buyBoxPrice.toFixed(2)}`,
        asin: targetAsin,
        buyBoxPrice,
        updatedInventory: !invErr,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // ================================================================
    // REFRESH BUY BOX PRICES
    // NOTE: Disabled for Sales reporting. Buy Box is CURRENT market price (often not your sale price).
    // ================================================================
    if (requestBody.refresh_buybox === true) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Buy Box refresh is disabled because it can overwrite actual sold prices. Use Refresh Pending to re-enrich Pending orders from Orders API (GetOrderItems).',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // RESET PENDING PRICES - Clear any incorrect pending prices (e.g., Buy Box)
    // Then user can run REFRESH_PENDING to re-enrich from Orders API (GetOrderItems).
    // ================================================================
    if (requestBody.reset_pending_prices === true) {
      const targetDate = requestBody.target_date;
      console.log(`🧹 RESET_PENDING_PRICES: Clearing pending prices${targetDate ? ` on ${targetDate}` : ' (all dates)'}`);

      let updateQuery = supabase
        .from('sales_orders')
        .update({
          sold_price: 0,
          total_sale_amount: 0,
          referral_fee: 0,
          fba_fee: 0,
          closing_fee: 0,
          shipping_label_fee: 0,
          total_fees: 0,
          roi: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('status', 'pending')
        .eq('order_status', 'Pending')
        .gt('sold_price', 0);

      if (targetDate) {
        updateQuery = updateQuery.eq('order_date', targetDate);
      }

      const { error: resetErr, count } = await (updateQuery as any).select('id', { count: 'exact', head: true });

      if (resetErr) {
        console.error('RESET_PENDING_PRICES error:', resetErr);
        return new Response(JSON.stringify({ success: false, message: resetErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: `Cleared prices for ${count || 0} pending orders. Now run Refresh Pending to pull real prices from Amazon.`,
        clearedCount: count || 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // REFRESH PENDING ORDERS - Re-enrich Pending orders from Orders API
    // IMPORTANT: No Buy Box fallback. ItemPrice + ShippingPrice only (NO tax).
    // ================================================================
    if (requestBody.refresh_pending === true) {
      const targetDate = requestBody.target_date;
      console.log(`📋 REFRESH_PENDING: Re-enriching Pending orders from Orders API${targetDate ? ` on ${targetDate}` : ' (all dates)'}`);

      const startTime = Date.now();
      const MAX_EXECUTION_TIME_MS = 25000;

      // Build query for Pending orders and placeholders (regardless of existing sold_price)
      let query = supabase
        .from('sales_orders')
        .select('id, order_id, asin, sku, sold_price, total_fees, unit_cost, unit_cost_at_sale, cost_source_at_sale, cost_locked, quantity, order_date, order_status, status')
        .eq('user_id', userId)
        .or('asin.eq.PENDING,order_status.eq.Pending,status.eq.pending');

      if (targetDate) {
        query = query.eq('order_date', targetDate);
      }

      const batchLimit = requestBody.limit || 15;
      const { data: pendingOrders, error: fetchErr } = await query.limit(batchLimit);

      if (fetchErr || !pendingOrders) {
        console.error('Failed to fetch pending orders:', fetchErr);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch pending orders',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`📋 REFRESH_PENDING: Found ${pendingOrders.length} orders to enrich`);

      if (pendingOrders.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          message: 'No pending orders to refresh',
          updatedCount: 0,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let updatedCount = 0;
      let errorCount = 0;
      let timeoutReached = false;

      const processedOrderIds = new Set<string>();

      for (const order of pendingOrders) {
        if (processedOrderIds.has(order.order_id)) {
          continue;
        }
        processedOrderIds.add(order.order_id);

        if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
          console.log(`⏱️ REFRESH_PENDING: Timeout, processed ${updatedCount} so far`);
          timeoutReached = true;
          break;
        }

        try {
          await new Promise(resolve => setTimeout(resolve, 500));

          const itemsUrl = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${order.order_id}/orderItems`;
          const signedHeaders = await signRequest('GET', itemsUrl, '', accessToken);

          const itemsRes = await fetch(itemsUrl, {
            method: 'GET',
            headers: signedHeaders,
          });

          if (!itemsRes.ok) {
            console.log(`❌ REFRESH_PENDING: Failed to get items for ${order.order_id}: ${itemsRes.status}`);
            errorCount++;
            continue;
          }

          const itemsData = await itemsRes.json();
          // Same merge as fetchOrderItems -- this path reads the API inline
          // rather than through that helper, and without it a repeated ASIN
          // line here overwrites instead of summing.
          const items = mergeOrderItemsByAsin(itemsData?.payload?.OrderItems || []);

          if (items.length === 0) {
            console.log(`📋 REFRESH_PENDING: No items found for ${order.order_id}`);
            errorCount++;
            continue;
          }

          const { data: existingRows } = await supabase
            .from('sales_orders')
            .select('id, order_id, asin, sku, seller_sku, unit_cost, unit_cost_at_sale, cost_source_at_sale, cost_locked, order_date, marketplace, fulfillment_channel')
            .eq('user_id', userId)
            .eq('order_id', order.order_id);

          const rowsByAsin = new Map((existingRows || []).map((row: any) => [row.asin, row]));
          const rowsBySku = new Map((existingRows || []).filter((row: any) => row.sku || row.seller_sku).map((row: any) => [row.sku || row.seller_sku, row]));
          const placeholderRows = (existingRows || []).filter((row: any) => !row.asin || ['PENDING', 'UNKNOWN', ''].includes(row.asin));
          const usedRowIds = new Set<string>();

          for (const item of items) {
            const asin = item.ASIN || 'UNKNOWN';
            const sku = item.SellerSKU || null;
            const title = item.Title || 'Unknown Product';
            const qty = Number(item.QuantityOrdered || 1);

            const rawItemPrice = parseFloat(item.ItemPrice?.Amount || '0') || 0;
            const rawShippingPrice = parseFloat(item.ShippingPrice?.Amount || '0') || 0;
            const itemCurrency = item.ItemPrice?.CurrencyCode || item.ShippingPrice?.CurrencyCode || 'USD';
            const shippingCurrency = item.ShippingPrice?.CurrencyCode || itemCurrency;
            const itemPriceUsd = convertToUsd(rawItemPrice, itemCurrency, FX_RATES_CACHE);
            const shippingPriceUsd = convertToUsd(rawShippingPrice, shippingCurrency, FX_RATES_CACHE);
            // Principal-only revenue contract: shipping is tracked separately.
            const soldPrice = itemPriceUsd;

            if (soldPrice <= 0) {
              console.log(`📋 REFRESH_PENDING: No sold price from Orders API for ${order.order_id} item ${asin}/${sku || 'no-sku'}`);
              continue;
            }

            let imageUrl = '';
            if (asin && !['PENDING', 'UNKNOWN'].includes(asin)) {
              try {
                const catalogUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${asin}?marketplaceIds=ATVPDKIKX0DER&includedData=images`;
                const catalogHeaders = await signRequest('GET', catalogUrl, '', accessToken);
                const catalogRes = await fetch(catalogUrl, { method: 'GET', headers: catalogHeaders });
                if (catalogRes.ok) {
                  const catalogData = await catalogRes.json();
                  const images = catalogData?.images?.[0]?.images || [];
                  if (images.length > 0) imageUrl = images[0].link || '';
                }
              } catch (e) {}
            }

            const totalSale = soldPrice;
            const existingForItem = rowsByAsin.get(asin) || (sku ? rowsBySku.get(sku) : null);
            const placeholderForItem = placeholderRows.find((row: any) => !usedRowIds.has(row.id));
            const targetRow = existingForItem || placeholderForItem;
            const lockedUnitCost = Number(targetRow?.unit_cost_at_sale || order.unit_cost_at_sale || 0) || 0;
            const lockedLegacyCost = Number(targetRow?.unit_cost || order.unit_cost || 0) || 0;
            const hasLockedCost = (targetRow?.cost_locked === true || order.cost_locked === true);
            let unitCost = lockedUnitCost > 0
              ? lockedUnitCost
              : hasLockedCost && lockedLegacyCost > 0
                ? lockedLegacyCost
                : 0;
            let costSourceAtSale = unitCost > 0
              ? (targetRow?.cost_source_at_sale || order.cost_source_at_sale || 'sales_orders_locked')
              : null;

            // IMPORTANT: refresh_pending must not pull the newest inventory cost for
            // old orders. Resolve through the central date-aware COGS function:
            // locked snapshot → purchase batch/listing <= order_date → current
            // inventory only as the final low-confidence fallback.
            if (unitCost <= 0 && asin && asin !== 'UNKNOWN' && asin !== 'PENDING') {
              const { data: resolvedRows, error: resolvedCostError } = await supabase.rpc('resolve_unit_cost_v1', {
                p_user_id: userId,
                p_asin: asin,
                p_sku: sku,
                p_order_date: targetRow?.order_date || order.order_date,
                p_snapshot_unit_cost: null,
              });
              const resolved = Array.isArray(resolvedRows) ? resolvedRows[0] : resolvedRows;
              if (!resolvedCostError && Number(resolved?.unit_cost || 0) > 0) {
                unitCost = Math.round(Number(resolved.unit_cost) * 100) / 100;
                costSourceAtSale = `refresh_pending:${resolved.source || 'resolved'}`;
              } else if (resolvedCostError) {
                console.warn(`⚠️ REFRESH_PENDING_COST_RESOLVE_FAILED: ${order.order_id}/${asin}/${sku || 'no-sku'}: ${resolvedCostError.message}`);
              }
            }
            const totalCost = unitCost * qty;

            const itemPayload: any = {
              user_id: userId,
              order_id: order.order_id,
              asin,
              sku,
              seller_sku: sku,
              title,
              image_url: imageUrl || undefined,
              quantity: qty,
              sold_price: Math.round((qty > 0 ? soldPrice / qty : soldPrice) * 100) / 100,
              item_price: Math.round((qty > 0 ? soldPrice / qty : soldPrice) * 100) / 100,
              shipping_price: Math.round((qty > 0 ? shippingPriceUsd / qty : shippingPriceUsd) * 100) / 100,
              total_sale_amount: Math.round(totalSale * 100) / 100,
              price_source: itemCurrency === 'USD' ? 'orders_itemprice' : 'orders_itemprice_usd',
              price_confidence: 'CONFIRMED',
              price_enrich_status: 'enriched',
              needs_price_enrich: false,
              referral_fee: 0,
              fba_fee: 0,
              closing_fee: 0,
              total_fees: 0,
              unit_cost: unitCost || null,
              unit_cost_at_sale: unitCost || null,
              cost_source_at_sale: costSourceAtSale,
              cost_locked: unitCost > 0,
              cost_locked_at: unitCost > 0 ? new Date().toISOString() : null,
              total_cost: totalCost > 0 ? totalCost : null,
              roi: null,
              status: 'pending',
              order_status: 'Pending',
              order_date: targetRow?.order_date || order.order_date,
              marketplace: targetRow?.marketplace || 'US',
              fulfillment_channel: targetRow?.fulfillment_channel || 'AFN',
              order_type: 'StandardOrder',
              updated_at: new Date().toISOString(),
            };

            const writeResult = targetRow
              ? await supabase.from('sales_orders').update(itemPayload).eq('id', targetRow.id)
              : await supabase.from('sales_orders').upsert(itemPayload, { onConflict: 'user_id,order_id,asin' });

            if (!writeResult.error) {
              if (targetRow?.id) usedRowIds.add(targetRow.id);
              updatedCount++;
              console.log(`✅ REFRESH_PENDING_ITEM: ${order.order_id} -> ASIN=${asin}, SKU=${sku || 'none'}, price=$${soldPrice}`);
            } else {
              errorCount++;
              console.error(`❌ REFRESH_PENDING_ITEM: Failed ${order.order_id} ${asin}/${sku || 'no-sku'}: ${writeResult.error.message}`);
            }
          }
        } catch (err: any) {
          errorCount++;
          console.error(`❌ REFRESH_PENDING: Error for ${order.order_id}:`, err?.message || err);
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`📋 REFRESH_PENDING complete in ${elapsed}s: ${updatedCount} updated, ${errorCount} errors${timeoutReached ? ' (timeout)' : ''}`);

      // Self-heal ASINs that Amazon Orders API returned wrong/missing (uses fnsku_map).
      try {
        const { data: healRes, error: healErr } = await supabase.rpc('repair_sales_orders_asin_for_user', {
          p_user_id: userId,
          p_days: 30,
        });
        if (healErr) {
          console.warn(`⚠️ ASIN self-heal (refresh_pending) failed: ${healErr.message}`);
        } else if (healRes) {
          console.log(`🩹 ASIN self-heal (refresh_pending):`, healRes);
        }
      } catch (e: any) {
        console.warn(`⚠️ ASIN self-heal (refresh_pending) threw: ${e?.message || e}`);
      }

      const has_more = timeoutReached || pendingOrders.length >= batchLimit;
      return new Response(JSON.stringify({
        success: true,
        message: timeoutReached
          ? `Refreshed ${updatedCount} orders (timeout - run again for more)`
          : `Refreshed ${updatedCount} pending orders`,
        updatedCount,
        errorCount,
        totalPending: pendingOrders.length,
        has_more,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // RESYNC TODAY - Force re-fetch all of today's orders (ignores sync state)
    // ================================================================
    if (requestBody.resync_today === true) {
      console.log(`🔄 RESYNC_TODAY: Force re-syncing all orders from today for user ${userId}`);
      
      // Get start of today in Pacific time
      const nowPT = new Date();
      const todayStart = new Date(getPacificDateString(nowPT.toISOString()) + 'T00:00:00.000Z');
      const todayStartUTC = new Date(todayStart.getTime() + 8 * 60 * 60 * 1000); // PT is UTC-8
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
      
      console.log(`📦 Fetching orders from ${todayStartUTC.toISOString()} to ${twoMinutesAgo.toISOString()}`);
      
      // Fetch ALL orders for today (not incremental)
      const todayOrders = await fetchAllOrdersForDateRange(
        accessToken,
        authData.marketplace_id,
        todayStartUTC.toISOString(),
        twoMinutesAgo.toISOString()
      );
      
      console.log(`📦 RESYNC_TODAY: Fetched ${todayOrders.length} orders from Amazon`);
      
      // Log any CA orders found
      const caOrders = todayOrders.filter((o: any) => o.AmazonOrderId?.startsWith('701-'));
      if (caOrders.length > 0) {
        console.log(`🍁 RESYNC_TODAY: Found ${caOrders.length} CA orders:`);
        for (const ca of caOrders) {
          console.log(`🍁 CA_ORDER: ${ca.AmazonOrderId} | Total=${ca.OrderTotal?.CurrencyCode || 'N/A'} ${ca.OrderTotal?.Amount || 'N/A'} | Status=${ca.OrderStatus}`);
        }
      }
      
      let newOrdersCount = 0;
      let existingCount = 0;
      let updatedExistingCount = 0;
      
      for (const order of todayOrders) {
        const orderId = order.AmazonOrderId;
        if (!orderId) continue;

        // Always call lite insert; it will also fix marketplace for existing CA orders.
        const wasNew = await insertPendingOrderLite(supabase, userId, order, FX_RATES_CACHE);
        if (wasNew) {
          newOrdersCount++;
        } else {
          existingCount++;

          // Prefer item-level totals (includes shipping/tax/discounts) for CA orders;
          // OrderTotal is sometimes identical/incorrect for pending cross-border orders.
          try {
            if (orderId.startsWith('701-')) {
              const items = await fetchOrderItems(accessToken, orderId);
              if ((items as any)?.__rateLimited === true) {
                console.warn(`⏳ requeued_order_items_rate_limited: CA_TOTALS ${orderId} - skipping refresh this cycle`);
                HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'rate_limited', orderId);
                HealthSignals.orderItemsRateLimited(userId, 'sync-sales-orders', orderId);
                continue;
              }
              if (!items || items.length === 0) {
                console.log(`💰 requeued_order_items_no_price: CA_TOTALS ${orderId} - no items returned; will retry next refresh`);
                HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'no_price', orderId);
                continue;
              }

              const currencyCode =
                order.OrderTotal?.CurrencyCode ||
                items?.[0]?.ItemPrice?.CurrencyCode ||
                items?.[0]?.ShippingPrice?.CurrencyCode ||
                'USD';

              const CURRENCY_TO_USD = await getLiveCurrencyToUsd(supabase);
              const rate = CURRENCY_TO_USD[currencyCode] || 1;

              const sumMoney = (m: any) => (m?.Amount ? parseFloat(m.Amount) : 0);

              // Total paid by buyer for this order (items + shipping + taxes - discounts)
              let total = 0;
              let promoNative = 0;
              for (const it of items || []) {
                total += sumMoney(it.ItemPrice);
                total += sumMoney(it.ShippingPrice);
                total += sumMoney(it.ItemTax);
                total += sumMoney(it.ShippingTax);
                const pd = sumMoney(it.PromotionDiscount);
                total -= pd;
                promoNative += pd;
                total -= sumMoney(it.ShippingDiscount);
              }

              const totalInUSD = rate !== 1 ? total * rate : total;
              const promoInUSD = rate !== 1 ? promoNative * rate : promoNative;

              const { data: existingRow } = await supabase
                .from('sales_orders')
                .select('id, status, sold_price, estimated_price')
                .eq('user_id', userId)
                .eq('order_id', orderId)
                .maybeSingle();

              if (
                existingRow &&
                existingRow.status === 'pending' &&
                totalInUSD > 0 &&
                Math.abs((existingRow.estimated_price || 0) - totalInUSD) > 0.01
              ) {
                // ARCHITECTURAL RULE: pre-settlement OrderTotal is an estimate, NOT real sold_price.
                // Write to estimated_price only; sold_price stays 0 until orders_itemprice / FEC.
                const caUpdate: any = {
                  estimated_price: totalInUSD,
                  needs_price_enrich: true,
                  price_enrich_status: 'pending',
                  updated_at: new Date().toISOString(),
                };
                if (promoNative > 0) {
                  caUpdate.promotion_discount_native = promoNative;
                  caUpdate.promotion_discount = promoInUSD;
                  caUpdate.promotion_discount_currency = currencyCode;
                  caUpdate.promotion_discount_source = 'orders_pending';
                  caUpdate.promotion_discount_captured_at = new Date().toISOString();
                  maybeFirePromoTripwire({
                    userId,
                    orderId,
                    asin: null,
                    marketplace: 'CA',
                    promotionDiscount: promoNative,
                    currency: currencyCode,
                    sourceFunction: 'sync-sales-orders:orders_pending_ca',
                  });
                }
                await supabase
                  .from('sales_orders')
                  .update(caUpdate)
                  .eq('id', existingRow.id);
                updatedExistingCount++;

                console.log(
                  `🍁 CA_TOTALS_UPDATED (estimate): ${orderId} ${currencyCode} ${total.toFixed(2)} -> USD ${totalInUSD.toFixed(2)} promo=${promoNative.toFixed(2)} ${currencyCode}`
                );
              }

              // We handled CA orders via OrderItems; skip the OrderTotal fallback below.
              continue;
            }
          } catch (e: any) {
            console.warn(`🍁 CA_TOTALS_FAILED: ${orderId}`, e?.message || e);
          }

          // If Amazon provides OrderTotal now, refresh ESTIMATED_PRICE for pending orders.
          // ARCHITECTURAL RULE: pre-settlement OrderTotal is an estimate, NOT real sold_price.
          // Real sold_price is only written from orders_itemprice / sold_price_intl / FEC.
          const currencyCode = order.OrderTotal?.CurrencyCode;
          const amountStr = order.OrderTotal?.Amount;
          if (currencyCode && amountStr) {
            const CURRENCY_TO_USD = await getLiveCurrencyToUsd(supabase);
            const rate = CURRENCY_TO_USD[currencyCode] || 1;
            const amt = parseFloat(amountStr || '0');
            const totalInUSD = rate !== 1 ? amt * rate : amt;

            const { data: existingRow } = await supabase
              .from('sales_orders')
              .select('id, status, sold_price, estimated_price')
              .eq('user_id', userId)
              .eq('order_id', orderId)
              .maybeSingle();

            if (
              existingRow &&
              existingRow.status === 'pending' &&
              totalInUSD > 0 &&
              Math.abs((existingRow.estimated_price || 0) - totalInUSD) > 0.01
            ) {
              await supabase
                .from('sales_orders')
                .update({
                  estimated_price: totalInUSD,
                  needs_price_enrich: true,
                  price_enrich_status: 'pending',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', existingRow.id);
              updatedExistingCount++;
            }
          }
        }
      }

      // IMPORTANT: Resync Today should also attempt to settle today's orders by pulling Financial Events.
      // This is where we get the real itemized Principal/Shipping and fees.
      try {
        console.log(`💰 RESYNC_TODAY: Fetching financial events for today to settle orders...`);
        const events = await fetchFinancialEvents(
          accessToken,
          authData.marketplace_id,
          todayStartUTC.toISOString(),
          twoMinutesAgo.toISOString()
        );

        let settledCount = 0;
        for (const event of events) {
        const didSettle = await processFinancialEvent(supabase, userId, event, accessToken);
          if (didSettle) settledCount++;
        }
        console.log(`💰 RESYNC_TODAY: Settled ${settledCount} order(s) from financial events`);
      } catch (eventsErr: any) {
        console.warn('💰 RESYNC_TODAY: Financial events settlement failed:', eventsErr?.message || eventsErr);
      }
      
      console.log(`📦 RESYNC_TODAY complete: ${newOrdersCount} new, ${existingCount} already existed, ${updatedExistingCount} refreshed totals`);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Resynced today: ${newOrdersCount} new orders added, ${existingCount} already existed`,
        details: {
          newOrders: newOrdersCount,
          existingOrders: existingCount,
          refreshedExistingTotals: updatedExistingCount,
          totalFetched: todayOrders.length,
          caOrdersFound: caOrders.length,
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (requestBody.unified_sync === true) {
      console.log(`🚀 UNIFIED_SYNC: Starting comprehensive sync for user ${userId}`);
      
      // Get incremental sync state
      const state = await getSyncState(supabase, userId);
      console.log(`📦 Orders sync starting from: ${state.last_orders_sync_at.toISOString()}`);
      console.log(`💰 Events sync starting from: ${state.last_events_sync_at.toISOString()}`);
      
      // Diagnostic: Count existing pending orders needing enrichment BEFORE sync
      const { count: pendingNeedingAsinBefore } = await supabase
        .from('sales_orders')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .or('asin.eq.PENDING,asin.is.null,asin.eq.,asin.eq.UNKNOWN');
      
      console.log(`🔍 DIAGNOSTIC: ${pendingNeedingAsinBefore || 0} orders needing ASIN enrichment BEFORE sync`);
      
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
      
      let newOrdersCount = 0;
      let settledCount = 0;
      let enrichedCount = 0;
      let missingOrdersSynced = 0;
      let pendingEnrichedCount = 0;
      const allFetchedOrderIds: string[] = [];
      let recentOrders: any[] = [];
      const markerAgeMs = Date.now() - state.last_orders_sync_at.getTime();
      const staleMarkerNeedsReplay = markerAgeMs > 12 * 60 * 60 * 1000;
      
      // ===== STEP 1: Fetch Orders API INCREMENTALLY =====
      console.log('📦 Step 1: Fetching orders from Orders API (incremental)...');
      try {
        const { orders, lastUpdateInBatch, failed } = await fetchOrdersIncremental(
          accessToken,
          authData.marketplace_id,
          state.last_orders_sync_at,
          500
        );
        
        recentOrders = orders;
        console.log(`📦 Orders API returned ${orders.length} orders since ${state.last_orders_sync_at.toISOString()}`);
        
        // LITE INSERT: Just create pending records without calling fetchOrderItems
        for (const order of orders) {
          allFetchedOrderIds.push(order.AmazonOrderId);
          const wasNew = await insertPendingOrderLite(supabase, userId, order, FX_RATES_CACHE);
          if (wasNew) newOrdersCount++;
        }

        if (staleMarkerNeedsReplay) {
          const replayStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
          const replayEnd = new Date(Date.now() - 2 * 60 * 1000).toISOString();
          console.log(`📦 STALE_MARKER_REPLAY: marker=${state.last_orders_sync_at.toISOString()} replaying ${replayStart} → ${replayEnd}`);
          const replayOrders = await fetchAllOrdersForDateRange(
            accessToken,
            authData.marketplace_id,
            replayStart,
            replayEnd,
          );

          for (const order of replayOrders) {
            allFetchedOrderIds.push(order.AmazonOrderId);
            const wasNew = await insertPendingOrderLite(supabase, userId, order, FX_RATES_CACHE);
            if (wasNew) {
              newOrdersCount++;
              missingOrdersSynced++;
            }
          }

          console.log(`📦 STALE_MARKER_REPLAY complete: ${replayOrders.length} replayed, ${missingOrdersSynced} inserted`);
        }
        console.log(`📦 Step 1 complete: ${newOrdersCount} new pending orders created`);
        
        // Advance sync state
        if (lastUpdateInBatch) {
          const safeMarker = new Date(lastUpdateInBatch.getTime() - 60 * 1000);
          await saveSyncState(supabase, userId, { last_orders_sync_at: safeMarker });
          console.log(`📦 Updated orders sync marker to: ${safeMarker.toISOString()}`);
        } else if (!failed && orders.length === 0) {
          // Unstick marker if it's more than 6 hours old and SP-API returned 0 orders
          const markerAge = Date.now() - state.last_orders_sync_at.getTime();
          const SIX_HOURS = 6 * 60 * 60 * 1000;
          if (markerAge > SIX_HOURS) {
            const newMarker = new Date(Date.now() - SIX_HOURS);
            console.log(`📦 MARKER_UNSTICK: No orders returned, marker was ${state.last_orders_sync_at.toISOString()}, advancing to ${newMarker.toISOString()}`);
            await saveSyncState(supabase, userId, { last_orders_sync_at: newMarker });
          }
        } else if (failed) {
          const markerAge = Date.now() - state.last_orders_sync_at.getTime();
          const TWELVE_HOURS = 12 * 60 * 60 * 1000;
          if (markerAge > TWELVE_HOURS) {
            const newMarker = new Date(Date.now() - 6 * 60 * 60 * 1000);
            console.log(`📦 MARKER_RECOVERY_AFTER_FAILURE: Orders API failed and marker was stale (${state.last_orders_sync_at.toISOString()}); advancing to ${newMarker.toISOString()}`);
            await saveSyncState(supabase, userId, { last_orders_sync_at: newMarker });
          }
        }
      } catch (ordersError: any) {
        console.error('📦 Orders API failed:', ordersError?.message || ordersError);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // ===== STEP 2: Fetch Financial Events to settle pending =====
      console.log('💰 Step 2: Fetching Financial Events for settlement (incremental)...');
      const shipmentEventOrderIds: string[] = [];
      try {
        const events = await fetchFinancialEvents(
          accessToken, 
          authData.marketplace_id, 
          state.last_events_sync_at.toISOString(),
          twoMinutesAgo.toISOString()
        );
        
        // DIAGNOSTIC: Log event summary
        const shipmentEvents = events.filter((e: any) => e._eventType === 'shipment');
        const refundEvents = events.filter((e: any) => e._eventType === 'refund');
        console.log('EVENTS_DEBUG_SUMMARY', {
          totalEvents: events.length,
          shipmentEvents: shipmentEvents.length,
          refundEvents: refundEvents.length,
          dateRange: { from: state.last_events_sync_at.toISOString(), to: twoMinutesAgo.toISOString() }
        });
        
        // Collect all order IDs from shipment events
        for (const event of shipmentEvents) {
          if (event.AmazonOrderId) {
            shipmentEventOrderIds.push(event.AmazonOrderId);
          }
        }
        
        console.log(`💰 Processing ${events.length} financial events`);
        for (const event of events) {
          const wasSettled = await processFinancialEvent(supabase, userId, event, accessToken);
          if (wasSettled) settledCount++;
        }
        console.log(`💰 Step 2 complete: ${settledCount} orders settled`);
        
        // Update events sync state
        await saveSyncState(supabase, userId, { last_events_sync_at: twoMinutesAgo });
        console.log(`💰 Updated events sync marker to: ${twoMinutesAgo.toISOString()}`);
        
        // DIAGNOSTIC: Check for orders that have shipment events but are still pending
        if (shipmentEventOrderIds.length > 0) {
          const { data: pendingWithShipments } = await supabase
            .from('sales_orders')
            .select('order_id, status, asin')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .in('order_id', shipmentEventOrderIds);
          
          if (pendingWithShipments && pendingWithShipments.length > 0) {
            console.log('EVENTS_DEBUG_PENDING_WITH_SHIPMENTS', {
              count: pendingWithShipments.length,
              orders: pendingWithShipments.slice(0, 10) // Show first 10
            });
          }
        }
        
        // DIAGNOSTIC: Get today's counts
        const todayPT = getPacificDateString(new Date().toISOString());
        const { data: todayCounts } = await supabase
          .from('sales_orders')
          .select('status')
          .eq('user_id', userId)
          .eq('order_date', todayPT);
        
        const pendingToday = todayCounts?.filter((o: any) => o.status === 'pending').length || 0;
        const settledToday = todayCounts?.filter((o: any) => o.status === 'settled').length || 0;
        console.log('EVENTS_DEBUG_TODAY_COUNTS', { date: todayPT, pending: pendingToday, settled: settledToday, total: todayCounts?.length || 0 });
        
      } catch (finError: any) {
        console.error('💰 Financial Events failed:', finError?.message || finError);
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      // ===== STEP 3: Fetch ASINs for orders with bad ASIN =====
      console.log('🔄 Step 3: Fetching ASINs for orders needing enrichment...');
      try {
        pendingEnrichedCount = await enrichPendingOrdersWithAsins(supabase, userId, accessToken, 50, FX_RATES_CACHE);
        console.log(`🔄 Step 3 complete: ${pendingEnrichedCount} orders enriched with ASIN`);
      } catch (pendingError: any) {
        console.error('🔄 ASIN enrichment failed:', pendingError?.message || pendingError);
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      // ===== STEP 4: Enrich from local tables =====
      console.log('📚 Step 4: Enriching from local tables...');
      const enrichResult = await autoEnrichFromLocal(supabase, userId, accessToken, 500);
      enrichedCount = enrichResult.enrichedCount;
      console.log(`📚 Step 4 complete: ${enrichedCount} orders enriched from local data`);

      // ===== STEP 4B: SP-API fallback for missing data =====
      console.log('🌐 Step 4B: SP-API fallback for missing data...');
      try {
        const spApiFallbackCount = await enrichFromSpApiFallback(supabase, userId, accessToken, 25);
        console.log(`🌐 Step 4B complete: ${spApiFallbackCount} orders enriched from SP-API`);
      } catch (spApiError: any) {
        console.error('🌐 SP-API fallback error:', spApiError?.message || spApiError);
      }

      // ===== STEP 4C: Inline Fee Cache Warm-up =====
      // For new orders with valid ASINs but missing fees, populate asin_fee_cache immediately
      // This prevents the "chicken-and-egg" problem where backfill cron can't help
      console.log('💰 Step 4C: Inline fee cache warm-up...');
      let feeCacheWarmedCount = 0;
      try {
        feeCacheWarmedCount = await warmUpFeeCache(supabase, userId, accessToken, 10);
        console.log(`💰 Step 4C complete: ${feeCacheWarmedCount} ASINs cached and fees applied`);
      } catch (feeCacheError: any) {
        console.error('💰 Fee cache warm-up error:', feeCacheError?.message || feeCacheError);
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      // ===== STEP 5: Detect and sync missing orders =====
      console.log('🔍 Step 5: Checking for missing orders...');
      if (allFetchedOrderIds.length > 0) {
        const { data: existingOrders } = await supabase
          .from('sales_orders')
          .select('order_id')
          .eq('user_id', userId)
          .in('order_id', allFetchedOrderIds);
        
        const existingIds = new Set(existingOrders?.map(o => o.order_id) || []);
        const missingIds = allFetchedOrderIds.filter(id => !existingIds.has(id));
        
        if (missingIds.length > 0) {
          console.log(`🔍 Found ${missingIds.length} missing orders, inserting...`);
          for (const orderId of missingIds) {
            const order = recentOrders.find((o: any) => o.AmazonOrderId === orderId);
            if (order) {
              await insertPendingOrderLite(supabase, userId, order, FX_RATES_CACHE);
              missingOrdersSynced++;
            }
          }
        }
        console.log(`🔍 Step 5 complete: ${missingOrdersSynced} missing orders inserted`);
      }

      // ===== STEP 5B: Always fetch recent refunds (last 7 days) for live visibility =====
      console.log('💸 Step 5B: Fetching recent refunds (last 7 days)...');
      let refundsApplied = 0;
      try {
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        
        // Fetch financial events specifically for refunds
        const refundStartDate = sevenDaysAgo.toISOString();
        const refundEndDate = new Date(now.getTime() - 2 * 60 * 1000).toISOString(); // 2 min ago
        
        const refundEvents = await fetchFinancialEventsForRefunds(
          accessToken,
          authData.marketplace_id,
          refundStartDate,
          refundEndDate
        );
        
        console.log(`💸 Found ${refundEvents.length} refund events in last 7 days`);
        
        for (const event of refundEvents) {
          const recordsCreated = await applyRefundToOrder(supabase, userId, event);
          refundsApplied += recordsCreated;
        }
        
        console.log(`💸 Step 5B complete: ${refundsApplied} refunds applied`);
      } catch (refundError: any) {
        console.error('💸 Refund sync error:', refundError?.message || refundError);
      }

      // ===== Get final counts =====
      const { count: pendingCount } = await supabase
        .from('sales_orders')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'pending');

      const { count: settledTotalCount } = await supabase
        .from('sales_orders')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'settled');

      console.log(`✅ UNIFIED_SYNC complete: new=${newOrdersCount}, settled=${settledCount}, enriched=${enrichedCount}, asinEnriched=${pendingEnrichedCount}, feesCached=${feeCacheWarmedCount}`);
      
      // ===== STEP 6: Background Backfill (one chunk per sync) =====
      // Start background backfill if not complete - works backwards from cursor
      if ((globalThis as any).EdgeRuntime?.waitUntil) {
        (globalThis as any).EdgeRuntime?.waitUntil(performBackfillChunk(supabase, userId, accessToken, authData.marketplace_id));
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: `Synced: ${newOrdersCount} new, ${settledCount} settled, ${enrichedCount} enriched, ${feeCacheWarmedCount} fees cached`,
        details: {
          newOrders: newOrdersCount,
          settledOrders: settledCount,
          enrichedOrders: enrichedCount,
          asinEnrichedOrders: pendingEnrichedCount,
          feeCacheWarmed: feeCacheWarmedCount,
          missingOrdersSynced,
          pendingCount: pendingCount || 0,
          settledTotalCount: settledTotalCount || 0,
        },
        timestamp: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // SYNC HISTORY - For historical date ranges (beyond 48 hours)
    // ================================================================
    if (startDate && endDate) {
      console.log(`📅 SYNC_HISTORY INPUT: startDate="${startDate}", endDate="${endDate}" for user ${userId}`);
      
      // Validate date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        console.error(`📅 Invalid date format: startDate="${startDate}", endDate="${endDate}"`);
        return new Response(JSON.stringify({ 
          error: 'Invalid date format. Use YYYY-MM-DD.' 
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      // Smaller chunks prevent Edge Function CPU timeouts for high-volume sellers
      const MAX_DAYS = 7;
      const MAX_RETENTION_DAYS = 730;
      
      const maxLookbackDate = new Date();
      maxLookbackDate.setDate(maxLookbackDate.getDate() - MAX_RETENTION_DAYS);
      
      let startDateObj = new Date(`${startDate}T00:00:00-08:00`);
      if (startDateObj < maxLookbackDate) {
        startDateObj = maxLookbackDate;
      }
      
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
      const requestedEndDate = new Date(`${endDate}T23:59:59-08:00`);
      
      // CRITICAL: Cap end date to 2 minutes ago - Amazon requires this
      const endDateObj = requestedEndDate > twoMinutesAgo ? twoMinutesAgo : requestedEndDate;
      
      // Validate start is before end
      if (startDateObj >= endDateObj) {
        console.error(`📅 Invalid date range: start=${startDateObj.toISOString()}, end=${endDateObj.toISOString()}`);
        return new Response(JSON.stringify({ 
          error: 'Start date must be before end date, and end date cannot be in the future.' 
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      console.log(`📅 SYNC_HISTORY COMPUTED: start=${startDateObj.toISOString()}, end=${endDateObj.toISOString()}`);

      const dateChunks: Array<{ start: string; end: string }> = [];
      let chunkStart = new Date(startDateObj);

      while (chunkStart < endDateObj) {
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS - 1);
        const actualEnd = chunkEnd > endDateObj ? endDateObj : chunkEnd;
        
        dateChunks.push({ start: chunkStart.toISOString(), end: actualEnd.toISOString() });
        
        chunkStart = new Date(actualEnd);
        chunkStart.setDate(chunkStart.getDate() + 1);
      }

      console.log(`📅 Processing ${dateChunks.length} chunk(s)`);

      const processChunks = async () => {
        let totalProcessed = 0;
        let totalEvents = 0;
        let pendingOrdersCount = 0;
        // Backfill verification stats (surfaced to UI via sales_sync_state.last_backfill_stats)
        const backfillStats: Record<string, any> = {
          started_at: new Date().toISOString(),
          start_date: startDate,
          end_date: endDate,
          include_orders: requestBody.include_orders !== false,
          orders_api_returned: 0,
          orders_inserted_new: 0,
          orders_api_error: null,
          financial_events_returned: 0,
          financial_events_processed: 0,
          chunks_total: dateChunks.length,
          chunks_completed: 0,
          finished_at: null,
          status: 'running',
        };
        const persistStats = async (extra: Record<string, any> = {}) => {
          try {
            await supabase
              .from('sales_sync_state')
              .update({ last_backfill_stats: { ...backfillStats, ...extra }, updated_at: new Date().toISOString() })
              .eq('user_id', userId);
          } catch (e) {
            console.error('[BACKFILL_STATS] persist failed:', e);
          }
        };
        await persistStats();
        
        // NOTE: We intentionally load any resume cursor BEFORE writing progress updates,
        // because progress updates would overwrite the saved HIST_CURSOR token.
        // (See resume logic further below.)

        // STEP 2: Financial Events (time-sliced + resumable)
        console.log('💰 Fetching Financial Events...');

        const TIME_BUDGET_MS = 45_000;
        const startedAt = Date.now();
        const CURSOR_PREFIX = 'HIST_CURSOR:';

        const loadCursor = async (): Promise<
          | { startDate: string; endDate: string; chunkIndex: number; nextToken: string | null }
          | null
        > => {
          const { data } = await supabase
            .from('sales_sync_state')
            .select('historical_sync_progress')
            .eq('user_id', userId)
            .maybeSingle();

          const raw = data?.historical_sync_progress || '';
          const idx = raw.indexOf(CURSOR_PREFIX);
          if (idx === -1) return null;

          try {
            const json = raw.slice(idx + CURSOR_PREFIX.length).trim();
            const parsed = JSON.parse(json);
            if (!parsed?.startDate || !parsed?.endDate) return null;
            return {
              startDate: String(parsed.startDate),
              endDate: String(parsed.endDate),
              chunkIndex: Number(parsed.chunkIndex || 0),
              nextToken: parsed.nextToken ? String(parsed.nextToken) : null,
            };
          } catch {
            return null;
          }
        };

        const saveCursor = async (cursor: {
          startDate: string;
          endDate: string;
          chunkIndex: number;
          nextToken: string | null;
          message: string;
        }) => {
          await supabase
            .from('sales_sync_state')
            .update({
              historical_sync_progress: `${cursor.message}\n${CURSOR_PREFIX}${JSON.stringify({
                startDate: cursor.startDate,
                endDate: cursor.endDate,
                chunkIndex: cursor.chunkIndex,
                nextToken: cursor.nextToken,
              })}`,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId);
        };

        // Resume cursor (if the prior run timed out)
        const cursor = await loadCursor();
        const shouldResume = cursor && cursor.startDate === startDate && cursor.endDate === endDate;

        let resumeChunkIndex = shouldResume ? cursor!.chunkIndex : 0;
        let resumeNextToken: string | null = shouldResume ? cursor!.nextToken : null;

        // Mark historical sync as in progress (after cursor load)
        try {
          await supabase
            .from('sales_sync_state')
            .upsert(
              {
                user_id: userId,
                historical_sync_in_progress: true,
                historical_sync_started_at: new Date().toISOString(),
                historical_sync_progress: shouldResume
                  ? `Resuming sync for ${startDate} to ${endDate}...`
                  : `Starting sync for ${startDate} to ${endDate}...`,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id' }
            );
        } catch (e) {
          console.error('Failed to mark sync in progress:', e);
        }

        // STEP 1: Orders API — ALWAYS include for historical sync to get correct purchase dates
        // FEC-only path writes postedDate (settlement date) which shifts orders to wrong days
        //
        // CHUNKED HISTORICAL RECOVERY: Amazon's Orders API will frequently
        // return zero rows for very wide CreatedAfter/CreatedBefore windows
        // (especially older months). We iterate the SAME 7-day chunks we use
        // for Financial Events so each Orders API call covers a narrow window
        // and we can report per-chunk counts back to the UI.
        const includeOrders = requestBody.include_orders !== false;
        if (includeOrders) {
          console.log(`📦 Fetching orders from Orders API in ${dateChunks.length} chunk(s)...`);
          const ordersPerChunk: Array<{
            start: string;
            end: string;
            returned: number;
            inserted: number;
            error: string | null;
          }> = [];
          backfillStats.orders_per_chunk = ordersPerChunk;

          try {
            await supabase
              .from('sales_sync_state')
              .update({ historical_sync_progress: `Fetching orders from Amazon (0/${dateChunks.length} chunks)...` })
              .eq('user_id', userId);

            let totalOrdersReturned = 0;
            for (let ci = 0; ci < dateChunks.length; ci++) {
              const ch = dateChunks[ci];
              const chunkLabel = `${ch.start.slice(0, 10)} → ${ch.end.slice(0, 10)}`;
              const chunkRecord = { start: ch.start, end: ch.end, returned: 0, inserted: 0, error: null as string | null };
              try {
                const chunkOrders = await fetchAllOrdersForDateRange(
                  accessToken,
                  authData.marketplace_id,
                  ch.start,
                  ch.end
                );
                chunkRecord.returned = chunkOrders.length;
                totalOrdersReturned += chunkOrders.length;
                console.log(`📦 Orders chunk ${ci + 1}/${dateChunks.length} (${chunkLabel}): ${chunkOrders.length} orders`);

                let chunkInserted = 0;
                for (const order of chunkOrders) {
                  const wasNew = await insertPendingOrderLite(supabase, userId, order, FX_RATES_CACHE);
                  if (wasNew) {
                    chunkInserted++;
                    pendingOrdersCount++;
                  }
                }
                chunkRecord.inserted = chunkInserted;
              } catch (chunkErr: any) {
                const cmsg = chunkErr?.message || String(chunkErr);
                console.error(`📦 Orders chunk ${ci + 1} failed (${chunkLabel}):`, cmsg);
                chunkRecord.error = cmsg;
                // Keep going — one bad chunk shouldn't kill the whole backfill.
                if (!backfillStats.orders_api_error) backfillStats.orders_api_error = cmsg;
              }
              ordersPerChunk.push(chunkRecord);
              backfillStats.orders_api_returned = totalOrdersReturned;
              backfillStats.orders_inserted_new = pendingOrdersCount;
              backfillStats.chunks_completed = ci + 1;
              await persistStats();

              await supabase
                .from('sales_sync_state')
                .update({
                  historical_sync_progress: `Orders API: ${ci + 1}/${dateChunks.length} chunks (${totalOrdersReturned} returned, ${pendingOrdersCount} new)`,
                })
                .eq('user_id', userId);

              // Light pacing between chunks to respect Orders API quotas (~6 req/sec).
              if (ci < dateChunks.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
              }
            }

            console.log(`📦 Orders step complete: ${totalOrdersReturned} returned across ${dateChunks.length} chunks, ${pendingOrdersCount} new rows inserted`);
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (ordersError: any) {
            const msg = ordersError?.message || String(ordersError);
            console.error('Orders API failed:', msg);
            backfillStats.orders_api_error = msg;
            await persistStats();
          }
        } else {
          console.log('📦 Skipping Orders API for historical sync (include_orders=false)');
          await supabase
            .from('sales_sync_state')
            .update({
              historical_sync_progress: 'Skipping Orders API (fast mode). Fetching financial events...',
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId);
        }

        // Continue with Financial Events (time-sliced + resumable)
        for (let i = resumeChunkIndex; i < dateChunks.length; i++) {
          const chunk = dateChunks[i];
          console.log(`Processing chunk ${i + 1}/${dateChunks.length}: ${chunk.start} to ${chunk.end}`);

          // Update progress
          await supabase
            .from('sales_sync_state')
            .update({
              historical_sync_progress: `Processing financial data chunk ${i + 1}/${dateChunks.length}...`,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId);

          try {
            let nextToken: string | null = i === resumeChunkIndex ? resumeNextToken : null;
            let page = 0;

            while (true) {
              page++;
              if (Date.now() - startedAt > TIME_BUDGET_MS) {
                await saveCursor({
                  startDate,
                  endDate,
                  chunkIndex: i,
                  nextToken,
                  message: `Paused to avoid timeout. Resume from chunk ${i + 1}/${dateChunks.length} (page ${page}). Re-run Sync History to continue.`,
                });
                return { totalProcessed, totalEvents, pendingOrdersCount };
              }

              const pageResult = await fetchFinancialEventsPage(
                accessToken,
                authData.marketplace_id,
                chunk.start,
                chunk.end,
                nextToken
              );

              totalEvents += pageResult.events.length;

              for (const event of pageResult.events) {
                await processFinancialEvent(supabase, userId, event, accessToken);
                totalProcessed++;

                if (Date.now() - startedAt > TIME_BUDGET_MS) {
                  await saveCursor({
                    startDate,
                    endDate,
                    chunkIndex: i,
                    nextToken: pageResult.nextToken,
                    message: `Paused to avoid timeout. Resume from chunk ${i + 1}/${dateChunks.length} (page ${page}). Re-run Sync History to continue.`,
                  });
                  return { totalProcessed, totalEvents, pendingOrdersCount };
                }
              }

              nextToken = pageResult.nextToken;
              if (!nextToken) break;

              // Light rate-limit between pages
              await new Promise((resolve) => setTimeout(resolve, 700));
            }

            // Finished this chunk; reset resume token for next chunk
            resumeNextToken = null;

            if (i < dateChunks.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
            }
          } catch (chunkError: any) {
            console.error(`Error processing chunk ${i + 1}:`, chunkError?.message || chunkError);
          }
        }

        // STEP 3: Enrich ASINs
        await supabase
          .from('sales_sync_state')
          .update({ historical_sync_progress: 'Enriching order details...' })
          .eq('user_id', userId);
        await enrichPendingOrdersWithAsins(supabase, userId, accessToken, 50, FX_RATES_CACHE);

        // STEP 4: Auto-enrich from local
        await supabase
          .from('sales_sync_state')
          .update({ historical_sync_progress: 'Applying cost data...' })
          .eq('user_id', userId);
        await autoEnrichFromLocal(supabase, userId, accessToken, 500);
        
        // STEP 5: Refresh ALL unit costs from created_listings (no API calls, just DB)
        await supabase
          .from('sales_sync_state')
          .update({ historical_sync_progress: 'Finalizing unit costs...' })
          .eq('user_id', userId);
        await refreshAllUnitCosts(supabase, userId);

        // Mark sync as complete
        try {
          await supabase
            .from('sales_sync_state')
            .update({
              historical_sync_in_progress: false,
              historical_sync_progress: `Complete: ${pendingOrdersCount} orders, ${totalProcessed} settlements`,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);
        } catch (e) {
          console.error('Failed to mark sync complete:', e);
        }

        backfillStats.financial_events_returned = totalEvents;
        backfillStats.financial_events_processed = totalProcessed;
        backfillStats.orders_inserted_new = pendingOrdersCount;
        backfillStats.chunks_completed = dateChunks.length;
        backfillStats.finished_at = new Date().toISOString();
        backfillStats.status = 'complete';
        await persistStats();

        console.log(`✅ Sync complete: ${pendingOrdersCount} orders, ${totalProcessed}/${totalEvents} events processed`);

        // Self-heal ASINs on the full historical window.
        try {
          const { data: healRes, error: healErr } = await supabase.rpc('repair_sales_orders_asin_for_user', {
            p_user_id: userId,
            p_days: 60,
          });
          if (healErr) {
            console.warn(`⚠️ ASIN self-heal (historical) failed: ${healErr.message}`);
          } else if (healRes) {
            console.log(`🩹 ASIN self-heal (historical):`, healRes);
          }
        } catch (e: any) {
          console.warn(`⚠️ ASIN self-heal (historical) threw: ${e?.message || e}`);
        }

        return { totalProcessed, totalEvents, pendingOrdersCount };
      };

      // ALWAYS run historical sync in background to prevent timeouts
      if ((globalThis as any).EdgeRuntime?.waitUntil) {
        (globalThis as any).EdgeRuntime?.waitUntil((async () => {
          await processChunks();
          kickCustomerProfilesBackfill(userId, 150);
        })());
        return new Response(
          JSON.stringify({
            success: true,
            message: `Historical sync started for ${startDate} to ${endDate} (${dateChunks.length} chunk(s))`,
            chunks: dateChunks.length,
            background: true,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // Fallback if EdgeRuntime not available
      const result = await processChunks();
      kickCustomerProfilesBackfill(userId, 150);
      return new Response(
        JSON.stringify({
          success: true,
          message: `Synced ${result.pendingOrdersCount} orders + ${result.totalProcessed} settlements`,
          totalEvents: result.totalEvents,
          processedEvents: result.totalProcessed,
          pendingOrders: result.pendingOrdersCount,
          background: false,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // No recognized operation
    return new Response(
      JSON.stringify({
        error: 'No valid operation specified. Use unified_sync=true or provide startDate/endDate.',
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error syncing sales orders:', error);
    const message = error instanceof Error ? (error as Error).message : 'Unknown error';

    if (message.startsWith('SPAPI_QUOTA_EXCEEDED')) {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'QUOTA_EXCEEDED',
          message: 'Amazon SP-API quota exceeded. Try again later.',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// Thin wrapper that returns 202 immediately and continues sync in the
// background, avoiding the 150s edge-function idle timeout (504 IDLE_TIMEOUT).
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Read the body ONCE up front. req.clone() + double-read is unreliable in
  // the Deno edge runtime (second read can race with the first and end up
  // empty `{}`), which caused refund re-sync to silently fall through to the
  // generic 202 wrapper and never run.
  const rawBody = await req.text().catch(() => '');
  let parsedBody: any = {};
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    console.warn('[sync-sales-orders] body parse failed:', (e as Error)?.message);
  }

  const buildReq = () => new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: rawBody || null,
  });

  // Refund re-sync with progress tracking must return the real progressId to
  // the browser. The generic background wrapper below returns only "accepted",
  // which makes the UI think the job completed immediately.
  if (parsedBody?.sync_refunds_only === true && parsedBody?.track_progress === true) {
    console.log('[sync-sales-orders] routing refund-only+track_progress to foreground');
    return await handleSyncRequest(buildReq());
  }

  const bgPromise = handleSyncRequest(buildReq()).catch((err) => {
    console.error('[sync-sales-orders] background failure:', err);
  });

  try {
    (globalThis as any).EdgeRuntime?.waitUntil?.(bgPromise);
  } catch (e) {
    console.error('[sync-sales-orders] waitUntil unavailable:', e);
  }

  return new Response(
    JSON.stringify({
      success: true,
      status: 'accepted',
      message: 'Sync started in background. Results will appear as orders are processed.',
    }),
    {
      status: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
});

// ============================================================
// SYNC STATE HELPERS
// ============================================================

async function getSyncState(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from('sales_sync_state')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('SYNC_STATE_SELECT_ERROR', (error as Error).message);
  }

  const now = new Date();
  const defaultSince = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days back

  return {
    last_orders_sync_at: data?.last_orders_sync_at
      ? new Date(data.last_orders_sync_at)
      : defaultSince,
    last_events_sync_at: data?.last_events_sync_at
      ? new Date(data.last_events_sync_at)
      : defaultSince,
  };
}

async function saveSyncState(
  supabase: any,
  userId: string,
  updates: { last_orders_sync_at?: Date; last_events_sync_at?: Date }
) {
  const payload: any = { 
    user_id: userId,
    updated_at: new Date().toISOString()
  };

  if (updates.last_orders_sync_at) {
    payload.last_orders_sync_at = updates.last_orders_sync_at.toISOString();
  }
  if (updates.last_events_sync_at) {
    payload.last_events_sync_at = updates.last_events_sync_at.toISOString();
  }

  const { error } = await supabase
    .from('sales_sync_state')
    .upsert(payload, { onConflict: 'user_id' });

  if (error) {
    console.error('SYNC_STATE_UPSERT_ERROR', (error as Error).message);
  }
}

// ============================================================
// BACKGROUND BACKFILL - Gradually sync historical data
// ============================================================

async function performBackfillChunk(
  supabase: any, 
  userId: string, 
  accessToken: string, 
  marketplaceId: string
): Promise<void> {
  try {
    // Get current backfill state
    const { data: syncState, error: stateError } = await supabase
      .from('sales_sync_state')
      .select('backfill_cursor_date, backfill_complete')
      .eq('user_id', userId)
      .maybeSingle();
    
    if (stateError) {
      console.error('⏪ BACKFILL: Error getting state:', stateError.message);
      return;
    }
    
    // If backfill complete, nothing to do
    if (syncState?.backfill_complete === true) {
      console.log('⏪ BACKFILL: Already complete for user', userId);
      return;
    }
    
    // Calculate 2-year limit
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const twoYearsAgoDate = twoYearsAgo.toISOString().split('T')[0];
    
    // Default cursor to today if not set
    let cursorDate = syncState?.backfill_cursor_date || new Date().toISOString().split('T')[0];
    
    // If we've reached 2 years ago, mark complete
    if (cursorDate <= twoYearsAgoDate) {
      console.log('⏪ BACKFILL: Reached 2-year limit, marking complete');
      await supabase
        .from('sales_sync_state')
        .update({ backfill_complete: true })
        .eq('user_id', userId);
      return;
    }
    
    // Calculate chunk: go back 7 days from cursor
    // CRITICAL: Amazon requires CreatedBefore to be at least 2 minutes in the past
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    
    let chunkEndDate = new Date(cursorDate + 'T23:59:59-08:00');
    // Cap end date to 2 minutes ago if it's in the future
    if (chunkEndDate > twoMinutesAgo) {
      chunkEndDate = twoMinutesAgo;
    }
    
    const chunkStartDate = new Date(chunkEndDate);
    chunkStartDate.setDate(chunkStartDate.getDate() - 6); // 7 days total
    
    // Don't go past 2 years
    if (chunkStartDate < twoYearsAgo) {
      chunkStartDate.setTime(twoYearsAgo.getTime());
    }
    
    console.log(`⏪ BACKFILL: Processing chunk ${chunkStartDate.toISOString()} to ${chunkEndDate.toISOString()} for user ${userId}`);
    
    // Fetch orders for this chunk
    let ordersInserted = 0;
    try {
      const orders = await fetchAllOrdersForDateRange(
        accessToken,
        marketplaceId,
        chunkStartDate.toISOString(),
        chunkEndDate.toISOString()
      );
      
      console.log(`⏪ BACKFILL: Found ${orders.length} orders in chunk`);
      
      for (const order of orders) {
        const wasNew = await insertPendingOrderLite(supabase, userId, order, FX_RATES_CACHE);
        if (wasNew) ordersInserted++;
        
        // Small delay every 20 orders
        if (ordersInserted % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    } catch (ordersErr: any) {
      console.error('⏪ BACKFILL: Orders API error:', ordersErr?.message || ordersErr);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Fetch financial events for this chunk
    let eventsProcessed = 0;
    try {
      const events = await fetchFinancialEvents(
        accessToken,
        marketplaceId,
        chunkStartDate.toISOString(),
        chunkEndDate.toISOString()
      );
      
      console.log(`⏪ BACKFILL: Found ${events.length} financial events in chunk`);

      for (const event of events) {
        await processFinancialEvent(supabase, userId, event, accessToken);
        eventsProcessed++;
      }
    } catch (eventsErr: any) {
      console.error('⏪ BACKFILL: Financial events error:', eventsErr?.message || eventsErr);
    }
    
    // Update cursor to day before chunk start
    const newCursorDate = new Date(chunkStartDate);
    newCursorDate.setDate(newCursorDate.getDate() - 1);
    const newCursorStr = newCursorDate.toISOString().split('T')[0];
    
    // Mark complete if we've reached the limit
    const isComplete = newCursorStr <= twoYearsAgoDate;
    
    await supabase
      .from('sales_sync_state')
      .update({ 
        backfill_cursor_date: newCursorStr,
        backfill_complete: isComplete
      })
      .eq('user_id', userId);
    
    console.log(`⏪ BACKFILL: Chunk complete - ${ordersInserted} orders, ${eventsProcessed} events. Next cursor: ${newCursorStr}. Complete: ${isComplete}`);
    
  } catch (err: any) {
    console.error('⏪ BACKFILL: Unexpected error:', err?.message || err);
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function getLWAAccessToken(
  refreshToken: string,
  clientIdOverride?: string,
  clientSecretOverride?: string,
): Promise<string> {
  const clientId = clientIdOverride || Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = clientSecretOverride || Deno.env.get('LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('LWA credentials not configured (LWA_CLIENT_ID / LWA_CLIENT_SECRET)');
  }

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LWA token error:', errorText);
    throw new Error(`Failed to get LWA access token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Auto-enrich from local tables - title, image, and cost (never sets sold price)
async function autoEnrichFromLocal(supabase: any, userId: string, accessToken: string, maxRecords: number = 50): Promise<{ enrichedCount: number; skipped: number }> {
  let totalEnriched = 0;
  let totalSkipped = 0;
  
  // Find orders missing title, image, unit_cost, OR pending orders with $0 price, OR bad ROI
  // CRITICAL: Order by created_at DESC to prioritize NEWEST orders first (so today's pending orders get enriched immediately)
  const { data: incompleteOrders, error: incompleteError } = await supabase
    .from('sales_orders')
    .select('id, order_id, asin, sku, title, image_url, unit_cost, quantity, sold_price, total_fees, status, roi')
    .eq('user_id', userId)
    .or('image_url.is.null,title.is.null,title.eq.Order Processing...,title.like.Untitled Product%,unit_cost.is.null,unit_cost.eq.0,sold_price.eq.0,sold_price.is.null,roi.eq.-100,roi.is.null')
    .neq('asin', 'PENDING')
    .neq('asin', 'UNKNOWN')
    .not('asin', 'is', null)
    .neq('asin', '')
    .order('created_at', { ascending: false })
    .limit(maxRecords);
  
  if (!incompleteError && incompleteOrders && incompleteOrders.length > 0) {
    console.log(`📚 Found ${incompleteOrders.length} orders missing title/image/cost/price`);
    const result = await enrichOrdersFromLocal(supabase, userId, accessToken, incompleteOrders);
    totalEnriched += result.enrichedCount;
    totalSkipped += result.skipped;
    console.log(`📚 Enrichment complete: ${result.enrichedCount} enriched`);
  }
  
  return { enrichedCount: totalEnriched, skipped: totalSkipped };
}

// Helper function to enrich orders from local tables - title/image/cost only (no Buy Box pricing)
async function enrichOrdersFromLocal(supabase: any, userId: string, accessToken: string, orders: any[]): Promise<{ enrichedCount: number; skipped: number }> {
  const uniqueAsins = [...new Set(orders.map((o: any) => o.asin).filter((a: any) => a && a !== 'PENDING' && a !== 'UNKNOWN' && a !== ''))];
  const uniqueSkus = [...new Set(orders.map((o: any) => o.sku).filter((s: any) => s && s !== ''))];
  
  if (uniqueAsins.length === 0 && uniqueSkus.length === 0) {
    return { enrichedCount: 0, skipped: orders.length };
  }
  
  console.log(`📚 Looking up ${uniqueAsins.length} unique ASINs and ${uniqueSkus.length} unique SKUs in created_listings AND inventory`);
  
  // Query both created_listings and inventory tables by ASIN AND SKU
  const queries = [];
  
  if (uniqueAsins.length > 0) {
    queries.push(
      supabase.from('created_listings').select('asin, sku, title, image_url, cost, units, amount, price').eq('user_id', userId).in('asin', uniqueAsins),
      supabase.from('inventory').select('asin, sku, title, image_url, cost, units, amount').eq('user_id', userId).in('asin', uniqueAsins)
    );
  } else {
    queries.push(Promise.resolve({ data: [] }), Promise.resolve({ data: [] }));
  }
  
  if (uniqueSkus.length > 0) {
    queries.push(
      supabase.from('created_listings').select('asin, sku, title, image_url, cost, units, amount, price').eq('user_id', userId).in('sku', uniqueSkus),
      supabase.from('inventory').select('asin, sku, title, image_url, cost, units, amount').eq('user_id', userId).in('sku', uniqueSkus)
    );
  } else {
    queries.push(Promise.resolve({ data: [] }), Promise.resolve({ data: [] }));
  }
  
  const [{ data: createdByAsin }, { data: inventoryByAsin }, { data: createdBySku }, { data: inventoryBySku }] = await Promise.all(queries);
  
  console.log(`📚 Found by ASIN: ${createdByAsin?.length || 0} created_listings, ${inventoryByAsin?.length || 0} inventory`);
  console.log(`📚 Found by SKU: ${createdBySku?.length || 0} created_listings, ${inventoryBySku?.length || 0} inventory`);
  
  const costDataMap = new Map<string, CostDataRow>();
  const localDataMap = new Map<string, any>();
  const skuToDataMap = new Map<string, any>(); // SKU -> data lookup (carries source tag)
  
  // Inventory first (lower priority) — by ASIN.
  // Contract A: inventory.cost = UNIT cost, inventory.amount = TOTAL value.
  inventoryByAsin?.forEach((item: any) => {
    if (item.asin) {
      costDataMap.set(item.asin, { asin: item.asin, source: 'inventory', cost: item.cost, units: item.units, amount: item.amount });
      localDataMap.set(item.asin, { ...item, __cost_source: 'inventory' });
    }
    if (item.sku) {
      skuToDataMap.set(item.sku, { ...item, __cost_source: 'inventory' });
    }
  });
  
  // Inventory by SKU.
  inventoryBySku?.forEach((item: any) => {
    if (item.sku && !skuToDataMap.has(item.sku)) {
      skuToDataMap.set(item.sku, { ...item, __cost_source: 'inventory' });
    }
    if (item.asin && !costDataMap.has(item.asin)) {
      costDataMap.set(item.asin, { asin: item.asin, source: 'inventory', cost: item.cost, units: item.units, amount: item.amount });
      localDataMap.set(item.asin, { ...item, __cost_source: 'inventory' });
    }
  });
  
  // created_listings overrides inventory — DIFFERENT contract semantics.
  // Contract A: created_listings.cost = TOTAL, created_listings.amount = UNIT.
  createdByAsin?.forEach((item: any) => {
    if (item.asin) {
      costDataMap.set(item.asin, {
        asin: item.asin,
        source: 'listing',
        cost: item.cost,
        units: item.units,
        amount: item.amount,
      });
      localDataMap.set(item.asin, { ...localDataMap.get(item.asin), ...item, __cost_source: 'listing' });
    }
    if (item.sku) {
      skuToDataMap.set(item.sku, { ...skuToDataMap.get(item.sku), ...item, __cost_source: 'listing' });
    }
  });
  
  // created_listings by SKU (highest priority).
  createdBySku?.forEach((item: any) => {
    if (item.sku) {
      skuToDataMap.set(item.sku, { ...skuToDataMap.get(item.sku), ...item, __cost_source: 'listing' });
    }
    if (item.asin) {
      costDataMap.set(item.asin, {
        asin: item.asin,
        source: 'listing',
        cost: item.cost,
        units: item.units,
        amount: item.amount,
      });
      localDataMap.set(item.asin, { ...localDataMap.get(item.asin), ...item, __cost_source: 'listing' });
    }
  });
  
  let enrichedCount = 0;
  let skipped = 0;
  
  for (const order of orders) {
    // Try to find local data - priority: SKU lookup > ASIN lookup
    let localData = null;
    let resolvedCostData: CostDataRow | undefined;
    
    // Strategy 1: SKU lookup (most reliable for matching)
    if (order.sku && skuToDataMap.has(order.sku)) {
      localData = skuToDataMap.get(order.sku);
      // Build cost data from SKU match — preserve source tag for Contract A.
      if (localData && (localData.cost != null || localData.amount != null)) {
        resolvedCostData = {
          asin: localData.asin || order.asin,
          source: localData.__cost_source === 'inventory' ? 'inventory' : 'listing',
          cost: localData.cost,
          units: localData.units,
          amount: localData.amount
        };
      }
    }
    
    // Strategy 2: ASIN lookup (fallback)
    if (!localData && order.asin && order.asin !== 'PENDING' && order.asin !== 'UNKNOWN' && order.asin !== '') {
      localData = localDataMap.get(order.asin);
      resolvedCostData = costDataMap.get(order.asin);
    }
    
    // Skip if no local data found via either method
    if (!localData && (!order.asin || order.asin === 'PENDING' || order.asin === 'UNKNOWN' || order.asin === '')) {
      skipped++;
      continue;
    }
    
    const updates: any = {};
    
    // Update image
    if (!order.image_url && localData?.image_url) {
      updates.image_url = localData.image_url;
    }
    
    // Update title
    const isPlaceholderTitle = !order.title || 
      order.title === 'Order Processing...' || 
      order.title.startsWith('Untitled Product');
    if (isPlaceholderTitle && localData?.title) {
      updates.title = localData.title;
    }
    
    // Get unit cost - try SKU-resolved data first, then ASIN resolver.
    // COST SANITY GUARD: only trust rows where units > 0. Otherwise mark cost_invalid.
    let unitCost = order.unit_cost;
    if (unitCost === null || unitCost === 0 || unitCost > 100) {
      let resolvedCost: number | null = null;
      let sawRowWithZeroUnits = false;

      if (resolvedCostData) {
        const safe = resolvedCostData.source === 'listing'
          ? getListingUnitCostSafe(resolvedCostData)
          : getInventoryUnitCostSafe(resolvedCostData);
        if (safe !== null && safe > 0) {
          resolvedCost = safe;
        } else {
          // Row exists but units<=0 → not trustworthy.
          sawRowWithZeroUnits = true;
          console.warn(`⚠️ COST_INVALID_GUARD: ${order.order_id} | SKU=${order.sku} ASIN=${order.asin} -> resolvedCostData has units<=0 (cost=${resolvedCostData.cost}, units=${resolvedCostData.units}); refusing to write unit_cost.`);
          HealthSignals.costInvalidUnitsZero(userId, 'sync-sales-orders', order.order_id, order.asin || undefined);
        }
      }

      if (!resolvedCost && order.asin && order.asin !== 'PENDING' && order.asin !== 'UNKNOWN') {
        resolvedCost = resolveUnitCostForAsin(order.asin, costDataMap);
        if (!resolvedCost) sawRowWithZeroUnits = true;
      }

      if (resolvedCost && resolvedCost > 0) {
        unitCost = Math.round(resolvedCost * 100) / 100;
        updates.unit_cost = unitCost;
        updates.total_cost = unitCost * (order.quantity || 1);
        updates.cost_invalid = false;
        console.log(`💰 COST_ENRICHED: ${order.order_id} | SKU=${order.sku}, ASIN=${order.asin} -> unit_cost=$${unitCost.toFixed(2)}`);
      } else if (sawRowWithZeroUnits) {
        // Mark cost pending/invalid so ROI is hidden.
        updates.cost_invalid = true;
        updates.roi = null;
        console.warn(`⚠️ COST_PENDING: ${order.order_id} | cost_invalid=true, roi hidden (cost row has units<=0 or no derivable unit cost).`);
      }
    }

    
    // IMPORTANT: Never set sold_price from Buy Box or inventory pricing.
    // If sold_price is missing/0, it must be re-enriched from Orders API (GetOrderItems)
    // via REFRESH_PENDING or fetch-live-orders.
    // (We still allow ROI recalculation below when a real sold_price exists.)
    
    // ALWAYS recalculate ROI if we have price and cost but ROI is bad (-100 or null)
    const hasBadRoi = order.roi === null || order.roi === -100 || order.roi <= -99;
    const hasPrice = (updates.sold_price || order.sold_price) > 0;
    const hasCost = (updates.unit_cost || order.unit_cost) > 0;
    
    if (hasBadRoi && hasPrice && hasCost) {
      const qty = order.quantity || 1;
      const soldPrice = updates.sold_price || order.sold_price;
      const unitCost = updates.unit_cost || order.unit_cost;
      // Use absolute value of fees since they may be stored as negative
      const totalFees = Math.abs(updates.total_fees || order.total_fees || 0);
      const totalCost = unitCost * qty;
      
      if (totalCost > 0) {
        const totalSale = soldPrice * qty;
        const netProfit = totalSale - totalFees - totalCost;
        const newRoi = (netProfit / totalCost) * 100;
        updates.roi = Math.round(newRoi * 10) / 10;
        updates.total_cost = totalCost;
        console.log(`📊 ROI_RECALC: ${order.order_id} -> price=$${soldPrice.toFixed(2)} - fees=$${(totalFees/qty).toFixed(2)} - cost=$${unitCost.toFixed(2)} = ROI=${updates.roi.toFixed(1)}%`);
      }
    }
    
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update(updates)
        .eq('id', order.id);
      
      if (!updateError) {
        enrichedCount++;
      }
    } else {
      skipped++;
    }
  }
  
  return { enrichedCount, skipped };
}

// ================================================================
// SP-API FALLBACK: Fetch title/image/price from Amazon when local data missing
// ================================================================
async function enrichFromSpApiFallback(
  supabase: any,
  userId: string,
  accessToken: string,
  maxRecords: number = 15
): Promise<number> {
  // Find pending orders with valid ASIN but missing title/price
  const { data: incompleteOrders, error } = await supabase
    .from('sales_orders')
    .select('id, order_id, asin, sku, title, image_url, sold_price, quantity, status, estimated_price, item_price, pending_enrich_attempts, marketplace')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .or('title.eq.Order Processing...,title.is.null,sold_price.eq.0,sold_price.is.null,image_url.is.null')
    .neq('asin', 'PENDING')
    .neq('asin', 'UNKNOWN')
    .not('asin', 'is', null)
    .neq('asin', '')
    .limit(maxRecords);
  
  if (error || !incompleteOrders || incompleteOrders.length === 0) {
    console.log('🌐 SP-API_FALLBACK: No orders need API fallback');
    return 0;
  }
  
  console.log(`🌐 SP-API_FALLBACK: Found ${incompleteOrders.length} orders for API enrichment`);
  
  let enrichedCount = 0;
  
  for (const order of incompleteOrders) {
    try {
      const updates: any = {};
      const needsTitle = !order.title || order.title === 'Order Processing...';
      const needsImage = !order.image_url;
      const needsPrice = order.sold_price === null || order.sold_price === 0;
      
      // Fetch from GetOrderItems API for price (if needed)
      if (needsPrice) {
        let gotPrice = false;
        const orderItems = await fetchOrderItems(accessToken, order.order_id);
        const wasRateLimited = (orderItems as any).__rateLimited === true;

        if (wasRateLimited) {
          // RE-QUEUE: do NOT mark enrichment complete. Bump attempt counter
          // and let the next refresh cycle pick this order up again.
          const nextAfter = new Date(Date.now() + Math.min(30, 5 + (order.pending_enrich_attempts || 0) * 5) * 60_000).toISOString();
          await supabase
            .from('sales_orders')
            .update({
              pending_enrich_attempts: (order.pending_enrich_attempts || 0) + 1,
              pending_enrich_last_attempt_at: new Date().toISOString(),
              pending_enrich_last_error: 'ORDER_ITEMS_RATE_LIMITED',
              next_enrich_after: nextAfter,
              needs_price_enrich: true,
              price_enrich_status: 'pending',
              updated_at: new Date().toISOString(),
            })
            .eq('id', order.id);
          console.warn(`⏳ requeued_order_items_rate_limited: ${order.order_id} -> next attempt after ${nextAfter}`);
          HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'rate_limited', order.order_id);
          HealthSignals.orderItemsRateLimited(userId, 'sync-sales-orders', order.order_id);
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }

        if (orderItems && orderItems.length > 0) {
          const firstItem = orderItems[0];
          let itemPrice = 0;
          
          // Also extract title from GetOrderItems if missing
          if (needsTitle && firstItem.Title) {
            updates.title = firstItem.Title;
            console.log(`📝 TITLE_FROM_ORDERITEMS: ${order.order_id} -> "${firstItem.Title.substring(0, 40)}..."`);
          }
          
          // CONTRACT: total_sale_amount = principal only (NEVER includes shipping).
          // Shipping lives in its own `shipping_price` column. Mirrors FEC writer contract.
          const rawItemPrice = parseFloat(firstItem.ItemPrice?.Amount || '0') || 0;
          const rawShippingPrice = parseFloat(firstItem.ShippingPrice?.Amount || '0') || 0;
          const itemCurrency = firstItem.ItemPrice?.CurrencyCode || 'USD';
          const shippingCurrency = firstItem.ShippingPrice?.CurrencyCode || itemCurrency;
          const itemPriceUsd = convertToUsd(rawItemPrice, itemCurrency, FX_RATES_CACHE);
          const shippingPriceUsd = convertToUsd(rawShippingPrice, shippingCurrency, FX_RATES_CACHE);
          itemPrice = itemPriceUsd; // principal only, stored in USD
          if (rawShippingPrice > 0) {
            console.log(`📦 ENRICH: ${order.order_id} ItemPrice=${itemCurrency} ${rawItemPrice}→$${itemPriceUsd} Shipping=${shippingCurrency} ${rawShippingPrice}→$${shippingPriceUsd} (kept separate)`);
          }

          // PROMOTIONAL REBATES: capture Amazon-applied coupon / lightning deal / automatic promo
          // discounts so Live Sales + Sales Report subtract them from profit. Sum across ALL items
          // in the order so multi-line orders aren't underreported. Amazon deducts these from
          // payout even when seller did not create the promotion.
          let rawPromoDiscountSum = 0;
          let promoCurrency = firstItem.ItemPrice?.CurrencyCode || 'USD';
          for (const it of orderItems) {
            const pd = parseFloat(it?.PromotionDiscount?.Amount || '0') || 0;
            if (pd > 0) rawPromoDiscountSum += pd;
            if (it?.PromotionDiscount?.CurrencyCode) promoCurrency = it.PromotionDiscount.CurrencyCode;
          }

          if (itemPrice > 0) {
            const qty = order.quantity || 1;
            let unitPrice = itemPrice / qty;
            let effectiveLineTotal = itemPrice; // assume Amazon returned line-total (qty × unit)

            // RAW ENRICH LOG (for double-division diagnosis)
            console.log(`🧾 RAW_ENRICH_A: ${order.order_id} asin=${order.asin} qty=${qty} rawItemPrice=${rawItemPrice} rawShipping=${rawShippingPrice} computedUnit=${unitPrice.toFixed(2)} estimated_price=${order.estimated_price ?? 'null'} promo=${rawPromoDiscountSum.toFixed(2)} ${promoCurrency}`);

            const refPrice = Math.max(
              Number(order.estimated_price) || 0,
              Number(order.item_price) || 0,
              Number(order.sold_price) || 0
            );

            // INVERSE GUARD: Amazon's GetOrderItems sometimes returns ItemPrice as
            // PER-UNIT instead of line-total (observed for multi-qty Pending orders
            // on certain US accounts). Symptom: unit = rawItemPrice/qty is far below
            // the listing price, AND rawItemPrice itself ≈ listing price.
            // Example caught: order 114-2517244-0299440, qty=7, rawItemPrice=$22.38,
            //   est=$22.46. Old code wrote sold_price=$3.20, total=$22.38. Real
            //   total per Seller Central was $156.66 (= 7 × $22.38).
            // When pattern matches, treat rawItemPrice as PER-UNIT and rebuild totals.
            if (
              qty > 1 &&
              refPrice > 0 &&
              unitPrice < refPrice * 0.6 &&
              rawItemPrice >= refPrice * 0.8 &&
              rawItemPrice <= refPrice * 1.2
            ) {
              console.warn(`🔁 ORDERS_API_PER_UNIT_FIX: ${order.order_id} qty=${qty} rawItemPrice=$${rawItemPrice.toFixed(2)} ref=$${refPrice.toFixed(2)} | treating ItemPrice as per-unit → unit=$${rawItemPrice.toFixed(2)} total=$${(rawItemPrice * qty).toFixed(2)}`);
              unitPrice = rawItemPrice;
              effectiveLineTotal = rawItemPrice * qty;
            } else if (qty > 1 && refPrice > 0 && unitPrice < refPrice * 0.6) {
              // SANITY GUARD: half-price / double-division corruption with no clear
              // per-unit signal. Hold the row for FEC settlement rather than guess.
              console.log(`🛑 SUSPICIOUS_HALF_PRICE_HOLD: ${order.order_id} qty=${qty} unit=$${unitPrice.toFixed(2)} ref=$${refPrice.toFixed(2)} rawItemPrice=$${rawItemPrice.toFixed(2)} -> NOT writing sold_price, waiting for FEC settlement`);
              updates.needs_price_enrich = true;
              updates.price_last_error = 'SUSPICIOUS_HALF_PRICE_HOLD';
              updates.price_last_attempt_at = new Date().toISOString();
              gotPrice = true; // we deliberately skipped; suppress PRICE_MISSING log
              // skip the write block below by re-using the same control flow
            }

            const shouldWrite =
              !(qty > 1 && refPrice > 0 && unitPrice < refPrice * 0.6 &&
                !(rawItemPrice >= refPrice * 0.8 && rawItemPrice <= refPrice * 1.2));

            if (shouldWrite) {
              // Try to get actual fees from SP-API, fallback to estimates
              let referralFee: number;
              let fbaFee: number;
              let closingFee: number;
              let totalFees: number;

              const marketplaceIdForFees = MARKETPLACE_ID_MAP[String(order.marketplace || 'US').toUpperCase()] || 'ATVPDKIKX0DER';
              const localUnitPriceForFees = itemCurrency !== 'USD' ? rawItemPrice / qty : undefined;
              const apiFees = await fetchProductFees(accessToken, order.asin, unitPrice, marketplaceIdForFees, FX_RATES_CACHE, localUnitPriceForFees);
              if (apiFees) {
                referralFee = apiFees.referralFee;
                fbaFee = apiFees.fbaFee;
                closingFee = apiFees.closingFee;
                totalFees = apiFees.totalFees;
                console.log(`💰 SPAPI_PRICE_API_FEES: ${order.order_id} -> fees from API`);
              } else {
                // STRICT: No hardcoded fallbacks - fees remain 0 until settlement
                referralFee = 0;
                fbaFee = 0;
                closingFee = 0;
                totalFees = 0;
                console.log(`⚠️ SPAPI_FEES_UNAVAILABLE: ${order.order_id} -> fees=0 (strict mode)`);
              }

              updates.sold_price = unitPrice;
              updates.item_price = unitPrice;
              updates.shipping_price = shippingPriceUsd > 0 ? shippingPriceUsd / qty : 0;
              updates.total_sale_amount = effectiveLineTotal;
              // Product Fees API estimates are per unit because we call it with unitPrice.
              // sales_orders stores line-level fees, so multiply by quantity before writing.
              updates.referral_fee = Math.round((referralFee * qty) * 100) / 100;
              updates.fba_fee = Math.round((fbaFee * qty) * 100) / 100;
              updates.closing_fee = Math.round((closingFee * qty) * 100) / 100;
              updates.total_fees = Math.round((totalFees * qty) * 100) / 100;
              updates.price_source = itemCurrency === 'USD' ? 'orders_itemprice' : 'orders_itemprice_usd';
              updates.price_confidence = 'CONFIRMED';
              updates.fees_source = apiFees ? apiFees.feeSource : 'unavailable';
              updates.fees_missing = !apiFees;
              updates.needs_fee_enrich = !apiFees;
              updates.price_enrich_status = 'enriched';
              updates.needs_price_enrich = false;
              updates.price_last_error = null;

              // Persist promo regardless of fee status — Amazon already deducted it from payout.
              if (rawPromoDiscountSum > 0) {
                updates.promotion_discount_native = rawPromoDiscountSum;
                updates.promotion_discount = rawPromoDiscountSum; // native discount; UI converts only when safe
                updates.promotion_discount_currency = promoCurrency;
                updates.promotion_discount_source = 'orders_itemprice';
                updates.promotion_discount_captured_at = new Date().toISOString();
                console.log(`🎟️ PROMO_DISCOUNT: ${order.order_id} -> ${rawPromoDiscountSum.toFixed(2)} ${promoCurrency}`);
                maybeFirePromoTripwire({
                  userId,
                  orderId: order.order_id,
                  asin: order.asin,
                  marketplace: order.marketplace,
                  promotionDiscount: rawPromoDiscountSum,
                  currency: promoCurrency,
                  sourceFunction: 'sync-sales-orders:orders_itemprice',
                });
              }

              console.log(`💰 SPAPI_PRICE: ${order.order_id} -> $${unitPrice.toFixed(2)}`);
              gotPrice = true;
            }
          }
        }
        
        // IMPORTANT: Do NOT fall back to Buy Box pricing.
        // If GetOrderItems doesn't return a price (rate limit / missing data), leave sold_price as-is (usually 0)
        // and let the next refresh try again. RE-QUEUE: bump attempt counter.
        if (!gotPrice) {
          await supabase
            .from('sales_orders')
            .update({
              pending_enrich_attempts: (order.pending_enrich_attempts || 0) + 1,
              pending_enrich_last_attempt_at: new Date().toISOString(),
              pending_enrich_last_error: 'NO_ITEM_PRICE',
              needs_price_enrich: true,
              price_enrich_status: 'pending',
              updated_at: new Date().toISOString(),
            })
            .eq('id', order.id);
          console.log(`💰 requeued_order_items_no_price: ${order.order_id} (${order.asin}) - no ItemPrice; row re-queued for next refresh`);
          HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'no_price', order.order_id);
        }
        
        // Rate limit delay
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      
      // Fetch from Catalog API for title/image (if needed)
      if (needsTitle || needsImage) {
        try {
          const catalogData = await fetchCatalogItem(accessToken, order.asin);
          if (catalogData) {
            if (needsTitle && catalogData.title) {
              updates.title = catalogData.title;
              console.log(`📝 SPAPI_TITLE: ${order.asin} -> "${catalogData.title.substring(0, 40)}..."`);
            }
            if (needsImage && catalogData.imageUrl) {
              updates.image_url = catalogData.imageUrl;
            }
          }
        } catch (catalogErr: any) {
          console.warn(`🌐 Catalog API failed for ${order.asin}:`, catalogErr?.message);
        }
        
        // Rate limit delay
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        
        const { error: updateError } = await supabase
          .from('sales_orders')
          .update(updates)
          .eq('id', order.id);
        
        if (!updateError) {
          enrichedCount++;
        }
      }
    } catch (err: any) {
      console.error(`🌐 SP-API_FALLBACK_ERROR: ${order.order_id}:`, err?.message || err);
    }
  }
  
  console.log(`🌐 SP-API_FALLBACK complete: ${enrichedCount} orders enriched`);
  return enrichedCount;
}

// ================================================================
// INLINE FEE CACHE WARM-UP
// Immediately populates asin_fee_cache for new ASINs with missing fees
// This solves the "chicken-and-egg" problem where orders come in with
// fees_missing=true but backfill cron hasn't run yet
//
// IMPORTANT ADDITION:
// Fees cannot be computed if price is 0/NULL. For Pending orders that arrive
// without ItemPrice, we must first populate estimated_price using the same
// fallback chain used elsewhere:
//   asin_my_price_cache.my_price -> inventory.price -> buy_box_cache.price
// Then apply fee cache using COALESCE(sold_price, estimated_price).
// ================================================================

async function computeAndPersistEstimatedPrices(
  supabase: any,
  userId: string,
  asins: string[],
  maxOrdersToUpdate: number = 250
): Promise<Map<string, { price: number; source: string; ts?: number }>> {
  // Each candidate carries the timestamp of its underlying signal so we can
  // pick the FRESHEST seller-derived price across (repricer_price_actions,
  // asin_my_price_cache, inventory). This fixes the bug where a multi-day-old
  // my_price_cache ($30) was preferred over a repricer submission from minutes
  // before the order ($26.50).
  const result = new Map<string, { price: number; source: string; ts: number }>();
  const uniqueAsins = Array.from(new Set(asins.filter(a => !!a)))
    .filter(a => a !== 'PENDING' && a !== 'UNKNOWN');
  if (uniqueAsins.length === 0) return result;

  const consider = (asin: string, price: number, source: string, ts: number) => {
    if (!(price > 0)) return;
    const prev = result.get(asin);
    if (!prev || ts > prev.ts) result.set(asin, { price, source, ts });
  };

  // Collect all candidates first, then resolve. See:
  //   .lovable/pending-sales-price-report.md §4 (A/B/C).
  // Bug context: `asin_my_price_cache` returns Product Pricing API GetMyPrice
  // (list price, ignores active deals/coupons). `inventory.price` comes from
  // Listings Items API (featured/effective price). They legitimately diverge
  // during deals and briefly after repricer edits. A stale my_price_cache row
  // stamped with a fresh `fetched_at` (e.g. by auto_activation) used to beat
  // both `repricer_price_actions` and `inventory.price` on freshness — we now
  // resolve conflicts by *agreement* between seller-derived signals, not by
  // timestamp alone.
  type Candidate = { price: number; ts: number };
  const repricerAction = new Map<string, Candidate>();
  const myPriceLive = new Map<string, Candidate>();     // ONLY real live API pulls
  const myPriceAny = new Map<string, Candidate>();      // any source (fallback only)
  const invPrice = new Map<string, Candidate>();

  // 1) repricer_price_actions — most recent successful submit per ASIN (US),
  //    within 14 days (older submissions may be superseded by manual edits).
  const REPRICER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const { data: priceActionRows } = await supabase
    .from('repricer_price_actions')
    .select('asin, new_price, created_at, success, marketplace')
    .eq('user_id', userId)
    .eq('success', true)
    .eq('marketplace', 'US')
    .gt('new_price', 0)
    .in('asin', uniqueAsins)
    .order('created_at', { ascending: false })
    .limit(4000);

  const seenAction = new Set<string>();
  for (const row of (priceActionRows || [])) {
    if (seenAction.has(row.asin)) continue;
    seenAction.add(row.asin);
    const price = Number(row.new_price || 0);
    const ts = new Date(row.created_at).getTime();
    if (price > 0 && nowMs - ts <= REPRICER_WINDOW_MS) {
      repricerAction.set(row.asin, { price, ts });
    }
  }

  // 2) asin_my_price_cache (US) — split by whether the row came from a real
  //    live API pull. Only `listings_api` writes reflect the actual current
  //    Amazon listing price; `auto_activation`, `repricer_write_back`,
  //    `manual` etc. stamp `fetched_at=now()` even when the value is stale.
  //    See report §4-B.
  const LIVE_MYPRICE_SOURCES = new Set([
    'listings_api',
    'product_pricing_api',
    'get_my_price',
    'sp_api_listings',
    'live_api',
  ]);
  const { data: myPriceRows } = await supabase
    .from('asin_my_price_cache')
    .select('asin, my_price, currency, marketplace_id, fetched_at, source')
    .eq('user_id', userId)
    .eq('marketplace_id', 'ATVPDKIKX0DER')
    .in('asin', uniqueAsins)
    .order('fetched_at', { ascending: false })
    .limit(2000);

  const seenMyPriceLive = new Set<string>();
  const seenMyPriceAny = new Set<string>();
  for (const row of (myPriceRows || [])) {
    const price = typeof row.my_price === 'number' ? row.my_price : Number(row.my_price || 0);
    if (!(price > 0)) continue;
    const ts = row.fetched_at ? new Date(row.fetched_at).getTime() : 0;
    const src = String((row as any).source || '').toLowerCase();
    if (!seenMyPriceAny.has(row.asin)) {
      seenMyPriceAny.add(row.asin);
      myPriceAny.set(row.asin, { price, ts });
    }
    if (LIVE_MYPRICE_SOURCES.has(src) && !seenMyPriceLive.has(row.asin)) {
      seenMyPriceLive.add(row.asin);
      myPriceLive.set(row.asin, { price, ts });
    }
  }

  // 3) inventory.price (Listings-API refresh) — the *featured* price the
  //    customer actually pays. Now promoted from last-resort to first-class
  //    seller-derived signal.
  //
  //    BUG FIX: a single ASIN can have multiple `inventory` rows (one per
  //    SKU — e.g. a real active listing plus a stale/ghost NOT_IN_CATALOG
  //    row left over from a prior SKU). This query had no listing_status
  //    filter and no ORDER BY, so which row "won" for a given ASIN was
  //    whatever order Postgres happened to return them in — not
  //    necessarily the active one. Confirmed in production: ASIN
  //    B0G6TFFF2M had an ACTIVE row (sku 11H-Y2V-XYYP, price $18.25) and a
  //    NOT_IN_CATALOG ghost row (sku 42P-MBK-PY8L, price $21.98) — picking
  //    the ghost row doubled to $43.96 instead of the correct $36.50 across
  //    two pending orders.
  //    Fix: prefer ACTIVE listing_status over any other status, and track
  //    price per (asin, sku) as well as per asin alone, so the per-order
  //    write-back below can prefer the row matching the order's own SKU.
  const { data: invRows } = await supabase
    .from('inventory')
    .select('asin, sku, price, amazon_price, my_price, updated_at, listing_status')
    .eq('user_id', userId)
    .in('asin', uniqueAsins)
    .limit(2000);

  const invPriceBySku = new Map<string, Candidate>();
  const isBetterInvCandidate = (active: boolean, ts: number, existingActive?: boolean, existingTs?: number) => {
    if (existingActive === undefined) return true;
    if (active !== existingActive) return active; // ACTIVE always beats non-ACTIVE
    return ts > (existingTs ?? 0);
  };
  const invActiveByAsin = new Map<string, boolean>();
  const invActiveBySku = new Map<string, boolean>();

  for (const row of (invRows || [])) {
    const price = Number(row.price || 0) || Number(row.amazon_price || 0) || Number(row.my_price || 0);
    if (!(price > 0)) continue;
    const ts = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const active = String(row.listing_status || '').trim().toUpperCase() === 'ACTIVE';
    const sku = String(row.sku || '').trim();

    if (isBetterInvCandidate(active, ts, invActiveByAsin.get(row.asin), invPrice.get(row.asin)?.ts)) {
      invPrice.set(row.asin, { price, ts });
      invActiveByAsin.set(row.asin, active);
    }
    if (sku) {
      const key = `${row.asin}::${sku}`;
      if (isBetterInvCandidate(active, ts, invActiveBySku.get(key), invPriceBySku.get(key)?.ts)) {
        invPriceBySku.set(key, { price, ts });
        invActiveBySku.set(key, active);
      }
    }
  }

  // ─── Resolve per ASIN ──────────────────────────────────────────────────
  // Rules (in order):
  //   C. Repricer action + inventory agree (<5% delta) AND my_price_cache
  //      disagrees (>5%) → trust Listings/Repricer. Tag `seller_derived:repricer+inventory`.
  //   A. my_price_cache vs inventory diverge >5% → trust inventory
  //      (Listings API = featured price incl. deals). Tag
  //      `inventory.price_over_mypricecache`.
  //   B. Otherwise, fall back to freshness-wins across
  //      (repricer_action, my_price_LIVE, inventory, my_price_any).
  const DIVERGENCE_THRESHOLD = 0.05;
  const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 0.01);

  for (const asin of uniqueAsins) {
    const rp = repricerAction.get(asin);
    const mpLive = myPriceLive.get(asin);
    const mpAny = myPriceAny.get(asin);
    const inv = invPrice.get(asin);

    // C: repricer + inventory agree, my_price disagrees
    if (rp && inv && pct(rp.price, inv.price) < DIVERGENCE_THRESHOLD) {
      if (mpAny && pct(mpAny.price, inv.price) > DIVERGENCE_THRESHOLD) {
        consider(asin, inv.price, 'seller_derived:repricer+inventory', Math.max(rp.ts, inv.ts));
        continue;
      }
    }

    // A: my_price_cache vs inventory diverge → trust inventory
    if (mpAny && inv && pct(mpAny.price, inv.price) > DIVERGENCE_THRESHOLD) {
      consider(asin, inv.price, 'inventory.price_over_mypricecache', inv.ts);
      continue;
    }

    // B: freshness-wins fallback. Prefer LIVE my_price_cache over any-source.
    if (rp) consider(asin, rp.price, 'repricer_price_actions', rp.ts);
    if (mpLive) consider(asin, mpLive.price, 'asin_my_price_cache_live', mpLive.ts);
    if (inv) consider(asin, inv.price, 'inventory.price', inv.ts);
    if (!result.has(asin) && mpAny) {
      // Last-resort: my_price_cache from a non-live write path.
      consider(asin, mpAny.price, 'asin_my_price_cache', mpAny.ts);
    }
  }

  // NOTE: buy_box_cache is intentionally excluded from estimated_price.

  // Persist estimated_price for orders that still have no price
  const candidates = uniqueAsins.filter(a => (result.get(a)?.price || 0) > 0);
  if (candidates.length === 0) return result;

  // We only update orders where BOTH sold_price and estimated_price are 0/NULL.
  // This keeps the "never lock estimates into sold_price" rule intact.
  // CRITICAL: Both price sources above (asin_my_price_cache filtered to ATVPDKIKX0DER,
  // and inventory.price which is US-only) return USD values. Writing those into
  // estimated_price for a non-US order corrupts the row: the Sales UI treats
  // estimated_price as NATIVE for intl markets and divides by FX, producing tiny
  // values like $1.43/unit for MX orders. Restrict warmup to US orders only.
  // Intl markets are priced separately by sync-intl-marketplace / listings_api_mx.
  const { data: ordersToPrice } = await supabase
    .from('sales_orders')
    .select('id, asin, sku, seller_sku, sold_price, estimated_price, order_status, marketplace, price_source')
    .eq('user_id', userId)
    .eq('fees_missing', true)
    .in('marketplace', ['US', 'ATVPDKIKX0DER'])
    .in('asin', candidates)
    .limit(maxOrdersToUpdate);

  // BUG FIX (cont'd): the per-ASIN `result` map above is a reasonable default,
  // but when the winning candidate for an ASIN came from `inventory.price`
  // and this specific order's own SKU has its OWN inventory row (a different
  // price than whichever SKU happened to win the per-ASIN aggregation),
  // prefer the order's own SKU. Only overrides inventory-sourced estimates —
  // repricer_action / my_price_cache signals are already ASIN-scoped with no
  // multi-SKU ambiguity, so they're left untouched.
  const resolveEstimateForOrder = (asin: string, orderSku: string | null | undefined) => {
    const base = result.get(asin);
    if (!base) return base;
    const isInventorySourced = base.source === 'inventory.price' || base.source === 'inventory.price_over_mypricecache' || base.source === 'seller_derived:repricer+inventory';
    const sku = String(orderSku || '').trim();
    if (!isInventorySourced || !sku) return base;
    const bySku = invPriceBySku.get(`${asin}::${sku}`);
    if (bySku && bySku.price > 0 && bySku.price !== base.price) {
      return { price: bySku.price, source: base.source, ts: bySku.ts };
    }
    return base;
  };

  // Allow refresh when:
  //  - no price yet (original behavior), OR
  //  - existing estimate came from an `estimated:*` source AND the freshest seller-
  //    derived price differs by >1% (e.g. repricer dropped from $30 → $26.50 after
  //    we wrote a stale my_price_cache estimate).
  const needsEstimate = (o: any, fresh: { price: number; source: string }) => {
    const sold = Number(o?.sold_price || 0);
    if (sold > 0) return false; // never override real Orders/FEC prices
    const status = String(o?.order_status || 'Pending');
    if (!(status === 'Pending' || status === '' || status === 'Unknown')) return false;
    const est = Number(o?.estimated_price || 0);
    if (est <= 0) return true;
    const src = String(o?.price_source || '');
    if (!src.startsWith('estimated:')) return false;
    const drift = Math.abs(fresh.price - est) / Math.max(est, 0.01);
    return drift > 0.01;
  };

  const updates: any[] = [];
  for (const row of (ordersToPrice || [])) {
    const est = resolveEstimateForOrder(row.asin, row.sku || row.seller_sku);
    if (!est) continue;
    if (!needsEstimate(row, est)) continue;
    updates.push({
      id: row.id,
      estimated_price: Math.round(est.price * 100) / 100,
      price_source: `estimated:${est.source}`,
      price_calc_mode: 'estimated_fee_warmup',
      updated_at: new Date().toISOString(),
    });
  }

  if (updates.length > 0) {
    // IMPORTANT: Do NOT use upsert here.
    // Postgres validates NOT NULL constraints on the INSERT portion of an upsert
    // before conflict resolution, which fails because our partial rows omit required
    // columns (user_id, order_id, order_date, etc.).
    // Use targeted UPDATE-by-id instead.
    let ok = 0;
    for (const u of updates) {
      const { error } = await supabase
        .from('sales_orders')
        .update({
          estimated_price: u.estimated_price,
          price_source: u.price_source,
          price_calc_mode: u.price_calc_mode,
          updated_at: u.updated_at,
        })
        .eq('id', u.id);

      if (error) {
        console.warn('💰 PRICE_WARMUP: Failed to update estimated_price for order id', u.id, error?.message || error);
      } else {
        ok++;
      }
    }

    console.log(`💰 PRICE_WARMUP: Updated estimated_price for ${ok}/${updates.length} orders`);
  }

  return result;
}

async function warmUpFeeCache(
  supabase: any,
  userId: string,
  accessToken: string,
  maxAsins: number = 10
): Promise<number> {
  // Step 1: Find orders with valid ASINs but missing fees (fees_missing=true)
  const { data: ordersNeedingFees, error: fetchError } = await supabase
    .from('sales_orders')
    .select('asin, sold_price, estimated_price, marketplace')
    .eq('user_id', userId)
    .eq('fees_missing', true)
    .neq('asin', 'PENDING')
    .neq('asin', 'UNKNOWN')
    .not('asin', 'is', null)
    .neq('asin', '')
    .limit(200);
  
  if (fetchError || !ordersNeedingFees || ordersNeedingFees.length === 0) {
    console.log('💰 FEE_CACHE_WARMUP: No orders need fee cache warm-up');
    return 0;
  }
  
  // Step 2: Deduplicate by ASIN
  const uniqueAsins = new Map<string, { price: number; marketplace: string }>();
  for (const order of ordersNeedingFees) {
    if (!uniqueAsins.has(order.asin)) {
      const price = order.sold_price || order.estimated_price || 0;
      uniqueAsins.set(order.asin, {
        price,
        marketplace: order.marketplace || 'US'
      });
    }
  }

  // Step 2B: If price is missing (0/NULL), populate estimated_price first.
  // Without this, referral fees will compute as 0 and the UI shows "zero fees".
  const asinsMissingPrice = Array.from(uniqueAsins.entries())
    .filter(([_, v]) => (v.price || 0) <= 0)
    .map(([asin]) => asin);

  if (asinsMissingPrice.length > 0) {
    console.log(`💰 PRICE_WARMUP: ${asinsMissingPrice.length} ASINs have no price; populating estimated_price...`);
    const estMap = await computeAndPersistEstimatedPrices(supabase, userId, asinsMissingPrice);

    // Update our local price map so downstream fee API calls use a better reference price.
    for (const asin of asinsMissingPrice) {
      const est = estMap.get(asin);
      if (est && est.price > 0) {
        const prev = uniqueAsins.get(asin);
        uniqueAsins.set(asin, { price: est.price, marketplace: prev?.marketplace || 'US' });
      }
    }
    
    // Step 2C: For ASINs STILL missing price after cache lookup, fetch the SELLER'S listing price
    // from the Listings Items API (this is the user's actual set price).
    const stillMissingPrice = asinsMissingPrice.filter(asin => {
      const entry = uniqueAsins.get(asin);
      return !entry || (entry.price || 0) <= 0;
    });

    if (stillMissingPrice.length > 0) {
      console.log(`💰 PRICE_WARMUP: ${stillMissingPrice.length} ASINs still missing price, fetching SELLER listing price via Listings API...`);

      try {
        const { data: authData } = await supabase
          .from('seller_authorizations')
          .select('selling_partner_id, seller_id, marketplace_id')
          .eq('user_id', userId)
          .maybeSingle();

        const sellerId = authData?.selling_partner_id || authData?.seller_id || null;
        const marketplaceId = authData?.marketplace_id || 'ATVPDKIKX0DER';

        if (!sellerId) {
          console.warn('💰 PRICE_WARMUP: No seller_authorizations found (missing sellerId); skipping Listings API price fetch');
        } else {
          const { data: invRows } = await supabase
            .from('inventory')
            .select('asin, sku')
            .eq('user_id', userId)
            .in('asin', stillMissingPrice)
            .limit(2000);

          const skuByAsin = new Map<string, string>();
          for (const r of (invRows || [])) {
            if (r?.asin && r?.sku) skuByAsin.set(String(r.asin), String(r.sku));
          }

          for (const asin of stillMissingPrice.slice(0, 5)) {
            const sku = skuByAsin.get(asin);
            if (!sku) {
              console.warn(`💰 PRICE_WARMUP: Missing inventory.sku for ${asin}; cannot call Listings API`);
              continue;
            }

            try {
              const listing = await fetchListingPriceFromListingsApi(accessToken, sellerId, sku, marketplaceId);
              if (listing.price && listing.price > 0) {
                const nowIso = new Date().toISOString();

                // Persist authoritative listing price cache
                await supabase
                  .from('asin_my_price_cache')
                  .upsert(
                    {
                      user_id: userId,
                      asin,
                      marketplace_id: marketplaceId,
                      seller_sku: sku || '__NO_SKU__',
                      my_price: listing.price,
                      fetched_at: nowIso,
                      updated_at: nowIso,
                      source: listing.source,
                      last_error: null,
                      next_retry_at: null,
                      attempt_count: 0,
                      currency: null,
                    },
                    { onConflict: 'user_id,asin,marketplace_id,seller_sku' }
                  );

                // SKU-FIRST PRICING: Update inventory by SKU first to avoid overwriting wrong offers
                // Only fall back to ASIN if there's a single SKU for this ASIN
                const { data: skuCount } = await supabase
                  .from('inventory')
                  .select('sku')
                  .eq('user_id', userId)
                  .eq('asin', asin);
                
                const skuList = (skuCount || []).map((r: any) => r.sku).filter(Boolean);
                
                if (skuList.length === 1 || skuList.length === 0) {
                  // Single SKU or no SKU - safe to update by ASIN
                  await supabase
                    .from('inventory')
                    .update({
                      price: listing.price,
                      my_price: listing.price,
                      last_price_update_at: nowIso,
                      last_price_update_status: 'listings_api',
                      updated_at: nowIso,
                    })
                    .eq('user_id', userId)
                    .eq('asin', asin);
                  
                  console.log(`💰 PRICE_WARMUP: Updated inventory.price for ASIN ${asin} (single SKU) = $${listing.price.toFixed(2)}`);
                } else {
                  // Multiple SKUs - update by specific SKU only
                  await supabase
                    .from('inventory')
                    .update({
                      price: listing.price,
                      my_price: listing.price,
                      last_price_update_at: nowIso,
                      last_price_update_status: 'listings_api',
                      updated_at: nowIso,
                    })
                    .eq('user_id', userId)
                    .eq('sku', sku);
                  
                  console.log(`💰 PRICE_WARMUP: Updated inventory.price for SKU ${sku} (ASIN ${asin}, multi-SKU) = $${listing.price.toFixed(2)}`);
                }
              } else {
                console.log(`⚠️ PRICE_WARMUP: Listings API returned no price for ${asin} (SKU ${sku})`);
              }

              // Rate limit buffer
              await new Promise(resolve => setTimeout(resolve, 1200));
            } catch (listingErr: any) {
              console.warn(`❌ PRICE_WARMUP: Listings API error for ${asin}:`, listingErr?.message || listingErr);
            }
          }

          // After updating caches, persist estimated_price for any orders that still have none
          const estMap2 = await computeAndPersistEstimatedPrices(supabase, userId, stillMissingPrice);
          for (const asin of stillMissingPrice) {
            const est = estMap2.get(asin);
            if (est && est.price > 0) {
              const prev = uniqueAsins.get(asin);
              uniqueAsins.set(asin, { price: est.price, marketplace: prev?.marketplace || 'US' });
            }
          }
        }
      } catch (authErr: any) {
        console.warn('💰 PRICE_WARMUP: Failed Listings API price fetch due to auth/inventory lookup error:', authErr?.message || authErr);
      }

      // Step 2D: If still missing after Listings API, fetch from Buy Box API (fee reference only)
      const stillMissingAfterListings = stillMissingPrice.filter(asin => {
        const entry = uniqueAsins.get(asin);
        return !entry || (entry.price || 0) <= 0;
      });

      if (stillMissingAfterListings.length > 0) {
        console.log(`💰 PRICE_WARMUP: ${stillMissingAfterListings.length} ASINs still missing price after Listings API, fetching from Buy Box API (fee reference only)...`);

        // Limit to first 5 ASINs to avoid timeout (rate limit is ~1 call per second)
        for (const asin of stillMissingAfterListings.slice(0, 5)) {
          try {
            const buyBoxPrice = await fetchBuyBoxPrice(accessToken, asin);

            if (buyBoxPrice && buyBoxPrice > 0) {
              console.log(`💰 PRICE_WARMUP: Got Buy Box price for ${asin}: $${buyBoxPrice.toFixed(2)}`);

              // Update local map
              const prev = uniqueAsins.get(asin);
              uniqueAsins.set(asin, { price: buyBoxPrice, marketplace: prev?.marketplace || 'US' });

              // Also cache to buy_box_cache for future use
              await supabase.from('buy_box_cache').upsert({
                asin,
                price: buyBoxPrice,
                marketplace_id: 'ATVPDKIKX0DER',
                fetched_at: new Date().toISOString(),
              }, { onConflict: 'asin,marketplace_id' });

              // NOTE: Buy Box price is cached for FEE CALCULATION reference only.
              // We do NOT update estimated_price with Buy Box - that should come from Listings/inventory.
              console.log(`💰 PRICE_WARMUP: Cached Buy Box for ${asin} (for fee calculation only, not for estimated_price)`);
            } else {
              console.log(`⚠️ PRICE_WARMUP: No Buy Box price found for ${asin}`);
            }

            // Rate limit: 1.5 seconds between API calls
            await new Promise(resolve => setTimeout(resolve, 1500));

          } catch (priceErr: any) {
            console.error(`❌ PRICE_WARMUP: Error fetching Buy Box for ${asin}:`, priceErr?.message || priceErr);
          }
        }
      }
    }
  }

  console.log(`💰 FEE_CACHE_WARMUP: Found ${uniqueAsins.size} unique ASINs needing fees`);
  
  // Step 3: Check which ASINs are NOT in asin_fee_cache yet
  const asinList = Array.from(uniqueAsins.keys());
  const { data: existingCache } = await supabase
    .from('asin_fee_cache')
    .select('asin, fba_fee_fixed, referral_rate, updated_at')
    .eq('user_id', userId)
    .in('asin', asinList);
  
  // Build set of already-cached ASINs with valid AND FRESH fees (14-day TTL)
  const FEE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const nowMs = Date.now();
  const cachedAsins = new Set<string>();
  for (const cache of (existingCache || [])) {
    if (cache.fba_fee_fixed > 0 || cache.referral_rate > 0) {
      // Check staleness: if updated_at is older than 14 days, treat as stale
      const updatedAt = cache.updated_at ? new Date(cache.updated_at).getTime() : 0;
      if ((nowMs - updatedAt) < FEE_CACHE_TTL_MS) {
        cachedAsins.add(cache.asin);
      } else {
        console.log(`💰 FEE_CACHE_WARMUP: ${cache.asin} cache is STALE (${Math.round((nowMs - updatedAt) / 86400000)}d old), will re-fetch`);
      }
    }
  }
  
  // Filter to ASINs NOT in cache (or with zero/stale fees in cache)
  const asinsToFetch = asinList.filter(asin => !cachedAsins.has(asin));
  
  if (asinsToFetch.length === 0) {
    // All ASINs are already cached - just apply cached fees to orders
    console.log('💰 FEE_CACHE_WARMUP: All ASINs already cached, applying to orders...');
    return await applyFeeCacheToOrders(supabase, userId, asinList);
  }
  
  console.log(`💰 FEE_CACHE_WARMUP: ${asinsToFetch.length} ASINs need API fetch (${cachedAsins.size} already cached)`);
  
  // Step 4: Fetch fees from API for uncached ASINs (rate-limited)
  let successCount = 0;
  const asinsToProcess = asinsToFetch.slice(0, maxAsins); // Cap to avoid timeout
  
  // Marketplace short-code → SP-API marketplaceId. Required so fetchProductFees
  // converts the reference price to local currency AND converts fees back to USD.
  const MKT_SHORT_TO_ID: Record<string, string> = {
    US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
  };
  const MKT_SHORT_TO_CCY: Record<string, string> = {
    US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL',
  };

  // Ensure FX cache is loaded so non-US calls can normalize to USD before storage.
  if (!FX_RATES_CACHE || Object.keys(FX_RATES_CACHE).length === 0) {
    try { FX_RATES_CACHE = await fetchFxRates(supabase); } catch { /* fall through */ }
  }

  for (const asin of asinsToProcess) {
    const { price, marketplace } = uniqueAsins.get(asin) || { price: 25, marketplace: 'US' };
    const mktShort = String(marketplace || 'US').toUpperCase();
    const marketplaceId = MKT_SHORT_TO_ID[mktShort] || 'ATVPDKIKX0DER';
    const ccy = MKT_SHORT_TO_CCY[mktShort] || 'USD';
    const isNonUs = ccy !== 'USD';
    const fxRate = isNonUs ? (FX_RATES_CACHE[ccy] || 0) : 1;
    const referencePrice = price > 0 ? price : 25; // Default if no price (assumed USD reference)

    // AUDIT §14d — Without fx_rates, fees_api stored native fees as USD (the
    // BR `B0FGVN6B8B` case: fba_fee_fixed=R$3.45 written as "$3.45"). Refuse
    // to cache non-US fees when fx is missing.
    if (isNonUs && !(fxRate > 1.05)) {
      console.warn(`💰 FEE_CACHE_WARMUP_SKIP: ${asin} ${mktShort} — fx_rate missing/invalid (${fxRate}); refusing to store potentially-native fees`);
      continue;
    }

    try {
      // Fetch fees from Product Fees API — pass marketplaceId + FX so fees come back in USD.
      const apiFees = await fetchProductFees(accessToken, asin, referencePrice, marketplaceId, FX_RATES_CACHE, undefined, true);

      if (apiFees && (apiFees.fbaFee > 0 || apiFees.referralFee > 0)) {
        // referral_rate is a fraction (currency-neutral) computed from USD inputs.
        const referralRate = referencePrice > 0 ? apiFees.referralFee / referencePrice : 0.15;

        // Magnitude guard: for non-US, USD fba_fee should be small (typ. < $20).
        // If it leaked through as native (e.g. 60 MXN), refuse.
        if (isNonUs && apiFees.fbaFee > referencePrice * 0.70) {
          console.warn(`💰 FEE_CACHE_WARMUP_SANITY_REJECT: ${asin} ${mktShort} fba=$${apiFees.fbaFee.toFixed(2)} > 70% of ref $${referencePrice.toFixed(2)} — likely native, not storing`);
          continue;
        }

        // Upsert to asin_fee_cache
        const { error: upsertError } = await supabase
          .from('asin_fee_cache')
          .upsert({
            user_id: userId,
            asin: asin,
            marketplace: mktShort,
            fba_fee_fixed: apiFees.fbaFee,
            referral_rate: referralRate,
            is_media: apiFees.closingFee > 0,
            updated_at: new Date().toISOString(),
            last_attempt_at: new Date().toISOString(),
            attempt_count: 0,
            last_error: null,
            next_retry_at: null,
            fee_source: 'fees_api',
            last_verified_at: new Date().toISOString(),
            history_sample_size: 0,
          }, { onConflict: 'user_id,asin,marketplace' });

        if (!upsertError) {
          successCount++;
          console.log(`💰 FEE_CACHE_WARMUP: Cached ${asin} ${mktShort} | FBA=$${apiFees.fbaFee.toFixed(2)} USD, Referral=${(referralRate * 100).toFixed(1)}%`);
        }
      } else {
        console.log(`⚠️ FEE_CACHE_WARMUP: No fees from API for ${asin} ${mktShort}`);
      }

      // Rate limit: 2 seconds between API calls
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (err: any) {
      console.error(`❌ FEE_CACHE_WARMUP: Error for ${asin}:`, err?.message || err);
    }
  }
  
  // Step 5: Apply cached fees to all orders (including newly cached)
  const ordersUpdated = await applyFeeCacheToOrders(supabase, userId, asinList);
  
  console.log(`💰 FEE_CACHE_WARMUP: Cached ${successCount} ASINs, updated ${ordersUpdated} orders`);
  return successCount;
}

// Apply cached fees from asin_fee_cache to orders with fees_missing=true
async function applyFeeCacheToOrders(
  supabase: any,
  userId: string,
  asins: string[]
): Promise<number> {
  if (asins.length === 0) return 0;
  
  // Get all cached fees for these ASINs (per-marketplace, never cross-pollute)
  const { data: cacheData } = await supabase
    .from('asin_fee_cache')
    .select('asin, marketplace, fba_fee_fixed, referral_rate, is_media')
    .eq('user_id', userId)
    .in('asin', asins);
  
  if (!cacheData || cacheData.length === 0) return 0;
  
  // Build cache lookup map KEYED BY (asin, marketplace) — prior code keyed by
  // asin only, so a MX/CA cache row would clobber the US row and a US order
  // could inherit an intl-native FBA fee (e.g. 63 MXN written as $63 USD).
  const cacheMap = new Map<string, { fbaFee: number; referralRate: number; isMedia: boolean }>();
  for (const cache of cacheData) {
    if (cache.fba_fee_fixed > 0 || cache.referral_rate > 0) {
      const mkt = (cache.marketplace || 'US').toUpperCase();
      cacheMap.set(`${cache.asin}::${mkt}`, {
        fbaFee: Number(cache.fba_fee_fixed) || 0,
        referralRate: Number(cache.referral_rate) || 0,
        isMedia: !!cache.is_media,
      });
    }
  }
  
  // Get orders that need updating (include marketplace for per-mkt cache lookup)
  const { data: ordersToUpdate } = await supabase
    .from('sales_orders')
    .select('id, asin, marketplace, sold_price, estimated_price, quantity, unit_cost')
    .eq('user_id', userId)
    .eq('fees_missing', true)
    .in('asin', asins);
  
  if (!ordersToUpdate || ordersToUpdate.length === 0) return 0;
  
  let updatedCount = 0;
  
  for (const order of ordersToUpdate) {
    const mkt = (order.marketplace || 'US').toUpperCase();
    const cache = cacheMap.get(`${order.asin}::${mkt}`);
    if (!cache) continue;
    
    const price = order.sold_price || order.estimated_price || 0;
    if (price <= 0) continue;
    
    const qty = order.quantity || 1;
    const referralFee = price * cache.referralRate;
    const fbaFee = cache.fbaFee;
    const closingFee = cache.isMedia ? 1.80 : 0;
    const totalFees = referralFee + fbaFee + closingFee;

    // 70% sanity guard: refuse cached fees that exceed 70% of the reference
    // price (covers sold_price OR estimated_price for pending rows). Prevents
    // corrupt intl-native cache values from poisoning a US/USD order.
    if (totalFees > price * 0.70) {
      console.warn(`💰 FEE_CACHE_SANITY_REJECT: ${order.asin} ${mkt} totalFees=$${totalFees.toFixed(2)} > 70% of price $${price.toFixed(2)} — leaving fees_missing=true`);
      continue;
    }

    const lineReferralFee = Math.round((referralFee * qty) * 100) / 100;
    const lineFbaFee = Math.round((fbaFee * qty) * 100) / 100;
    const lineClosingFee = Math.round((closingFee * qty) * 100) / 100;
    const lineTotalFees = Math.round((totalFees * qty) * 100) / 100;
    
    // Calculate ROI if we have unit cost
    const unitCost = order.unit_cost || 0;
    const totalCost = unitCost * qty;
    const totalSale = price * qty;
    const netProfit = totalSale - (totalFees * qty) - totalCost;
    const roi = totalCost > 0 ? Math.round((netProfit / totalCost) * 1000) / 10 : null;
    
    const { error: updateError } = await supabase
      .from('sales_orders')
      .update({
        referral_fee: lineReferralFee,
        fba_fee: lineFbaFee,
        closing_fee: lineClosingFee,
        total_fees: lineTotalFees,
        fees_source: 'from_cache',
        fees_missing: false,
        roi: roi,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    
    if (!updateError) {
      updatedCount++;
    }
  }
  
  return updatedCount;
}

// Fetch catalog item (title/image) from SP-API
async function fetchCatalogItem(accessToken: string, asin: string): Promise<{ title: string | null; imageUrl: string | null } | null> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const marketplaceId = 'ATVPDKIKX0DER';
  const path = `/catalog/2022-04-01/items/${asin}`;
  const params = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: 'summaries,images'
  });
  const url = `${endpoint}${path}?${params}`;
  
  try {
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { headers });
    
    if (response.status === 429) {
      console.warn(`Catalog API rate limited for ${asin}`);
      return null;
    }
    
    if (!response.ok) {
      console.warn(`Catalog API failed for ${asin}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    // Extract title from summaries
    let title: string | null = null;
    const summaries = data.summaries || [];
    if (summaries.length > 0) {
      title = summaries[0].itemName || null;
    }
    
    // Extract image URL
    let imageUrl: string | null = null;
    const images = data.images || [];
    if (images.length > 0 && images[0].images?.length > 0) {
      imageUrl = images[0].images[0].link || null;
    }
    
    return { title, imageUrl };
  } catch (err: any) {
    console.warn(`Catalog fetch error for ${asin}:`, err?.message);
    return null;
  }
}

// ================================================================
// MARKETPLACE PRICING API - Fetch listing price for non-US marketplaces
// Used when GetOrderItems returns $0 for pending orders
// ================================================================
const MARKETPLACE_ID_MAP: Record<string, string> = {
  'US': 'ATVPDKIKX0DER',
  'CA': 'A2EUQ1WTGCTBG2',
  'MX': 'A1AM78C64UM0Y8',
  'BR': 'A2Q3Y263D00KWC',
};

const SALES_MARKETPLACES = new Set(['US', 'CA', 'MX', 'BR']);

function isValidSalesAsin(asin: unknown): asin is string {
  return typeof asin === 'string' && !!asin.trim() && !['PENDING', 'UNKNOWN'].includes(asin.trim().toUpperCase());
}

async function ensureRepricerAssignmentFromSale(
  supabase: any,
  userId: string,
  asin: string,
  sku: string | null | undefined,
  marketplace: string,
  fulfillmentType: string = 'FBA'
): Promise<void> {
  const mkt = String(marketplace || 'US').toUpperCase();
  const cleanSku = typeof sku === 'string' ? sku.trim() : '';
  if (!SALES_MARKETPLACES.has(mkt) || !isValidSalesAsin(asin) || !cleanSku) return;

  const { data: existingBySku } = await supabase
    .from('repricer_assignments')
    .select('id, rule_id')
    .eq('user_id', userId)
    .eq('marketplace', mkt)
    .eq('sku', cleanSku)
    .limit(1)
    .maybeSingle();
  const existing = existingBySku;

  const { data: sourceBySku } = await supabase
    .from('repricer_assignments')
    .select('rule_id, is_enabled, min_price_override, max_price_override, min_roi_override, fulfillment_type, item_condition, status')
    .eq('user_id', userId)
    .eq('sku', cleanSku)
    .not('rule_id', 'is', null)
    .order('marketplace', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: sourceByAsin } = sourceBySku?.rule_id ? { data: null } : await supabase
    .from('repricer_assignments')
    .select('rule_id, is_enabled, min_price_override, max_price_override, min_roi_override, fulfillment_type, item_condition, status')
    .eq('user_id', userId)
    .eq('asin', asin)
    .not('rule_id', 'is', null)
    .order('marketplace', { ascending: false })
    .limit(1)
    .maybeSingle();
  const sourceAssignment = sourceBySku || sourceByAsin;

  let ruleId = sourceAssignment?.rule_id || null;
  if (!ruleId) {
    const { data: rule } = await supabase
      .from('repricer_rules')
      .select('id')
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .contains('marketplaces', [mkt])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    ruleId = rule?.id || null;
  }

  if (!ruleId) {
    console.warn(`⚠️ SALES_REPRICER_ASSIGNMENT_SKIPPED_NO_RULE: user=${userId} ${asin}/${cleanSku} ${mkt}`);
    return;
  }

  if (existing?.id) {
    if (!existing.rule_id || mkt !== 'US') {
      const repairData: any = {
        rule_id: existing.rule_id || ruleId,
        status: sourceAssignment?.status || 'active',
        updated_at: new Date().toISOString(),
      };
      if (mkt !== 'US') {
        repairData.intl_listing_status = '["BUYABLE"]';
        repairData.marketplace_sellable = true;
        repairData.marketplace_sellability_reason = 'sales_order_observed';
        repairData.marketplace_checked_at = new Date().toISOString();
      }
      await supabase.from('repricer_assignments').update(repairData).eq('id', existing.id);
    }
    return;
  }

  const insertData: any = {
    user_id: userId,
    asin,
    sku: cleanSku,
    marketplace: mkt,
    rule_id: ruleId,
    is_enabled: sourceAssignment?.is_enabled ?? true,
    min_price_override: sourceAssignment?.min_price_override ?? null,
    max_price_override: sourceAssignment?.max_price_override ?? null,
    min_roi_override: sourceAssignment?.min_roi_override ?? null,
    fulfillment_type: sourceAssignment?.fulfillment_type || fulfillmentType || 'FBA',
    item_condition: sourceAssignment?.item_condition || 'New',
    status: sourceAssignment?.status || 'active',
    updated_at: new Date().toISOString(),
  };

  if (mkt !== 'US') {
    insertData.intl_listing_status = '["BUYABLE"]';
    insertData.marketplace_sellable = true;
    insertData.marketplace_sellability_reason = 'sales_order_observed';
    insertData.marketplace_checked_at = new Date().toISOString();
  }

  const { error } = await supabase.from('repricer_assignments').insert(insertData);
  if (error) {
    if (!String(error.message || '').toLowerCase().includes('duplicate')) {
      console.error(`❌ SALES_REPRICER_ASSIGNMENT_ERROR: ${asin}/${cleanSku} ${mkt}`, error.message);
    }
    return;
  }
  console.log(`✅ SALES_REPRICER_ASSIGNMENT_CREATED: ${asin}/${cleanSku} ${mkt} rule=${ruleId}`);
}

const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
  'ATVPDKIKX0DER': 'USD',
  'A2EUQ1WTGCTBG2': 'CAD',
  'A1AM78C64UM0Y8': 'MXN',
  'A2Q3Y263D00KWC': 'BRL',
};

async function getMarketplacePricingPrice(
  asin: string,
  marketplaceId: string,
  accessToken: string,
  fxRates: Record<string, number>
): Promise<{ priceUsd: number | null; localPrice: number | null; currency: string; fxRate: number }> {
  try {
    const endpoint = 'https://sellingpartnerapi-na.amazon.com';
    const path = `/products/pricing/v0/items/${asin}/offers`;
    const queryParams = `MarketplaceId=${marketplaceId}&ItemCondition=New`;
    const url = `${endpoint}${path}?${queryParams}`;

    const headers = await signRequest('GET', url, '', accessToken);
    const rlClient = getRateLimitClient();
    if (rlClient) await waitForApiToken(rlClient, 'pricing_api', { maxWaitMs: 6000 });
    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[PRICING_API] Error for ASIN ${asin} (${marketplaceId}): ${response.status} ${text.slice(0, 200)}`);
      return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
    }

    const data = await response.json();
    const summary = data?.payload?.Summary;
    const offers = data?.payload?.Offers || [];

    let listingPrice: number | null = null;
    let currency = MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';

    // PRIORITY 1: Get listing price from first offer (actual listing price)
    if (offers.length > 0) {
      const firstOffer = offers[0];
      listingPrice = firstOffer.ListingPrice?.Amount || null;
      currency = firstOffer.ListingPrice?.CurrencyCode || currency;
      if (listingPrice) {
        console.log(`[PRICING_API] Found listing price from Offers: ${currency} ${listingPrice}`);
      }
    }

    // PRIORITY 2: Fallback to LowestPrices for FBA items
    if (listingPrice === null && summary?.LowestPrices) {
      const newLowest = summary.LowestPrices.find((p: any) => p.condition === 'New' && p.fulfillmentChannel === 'Amazon');
      if (newLowest) {
        listingPrice = newLowest.ListingPrice?.Amount || newLowest.LandedPrice?.Amount || null;
        currency = newLowest.ListingPrice?.CurrencyCode || newLowest.LandedPrice?.CurrencyCode || currency;
        if (listingPrice) {
          console.log(`[PRICING_API] Found listing price from LowestPrices: ${currency} ${listingPrice}`);
        }
      }
    }

    // PRIORITY 3: Fallback to BuyBoxPrices
    if (listingPrice === null && summary?.BuyBoxPrices) {
      const newBuyBox = summary.BuyBoxPrices.find((p: any) => p.condition === 'New');
      if (newBuyBox) {
        listingPrice = newBuyBox.ListingPrice?.Amount || newBuyBox.LandedPrice?.Amount || null;
        currency = newBuyBox.ListingPrice?.CurrencyCode || newBuyBox.LandedPrice?.CurrencyCode || currency;
        if (listingPrice) {
          console.log(`[PRICING_API] Found listing price from BuyBoxPrices: ${currency} ${listingPrice}`);
        }
      }
    }

    if (listingPrice === null) {
      console.log(`[PRICING_API] No price found for ASIN ${asin} in marketplace ${marketplaceId}`);
      return { priceUsd: null, localPrice: null, currency, fxRate: 1 };
    }

    // Convert to USD using live FX rates
    const fxRate = fxRates[currency] || 1;
    const priceUsd = currency === 'USD' ? listingPrice : listingPrice / fxRate;
    const roundedPriceUsd = Math.round(priceUsd * 100) / 100;

    console.log(`[PRICING_API] ${asin}: ${currency} ${listingPrice} / ${fxRate} = USD $${roundedPriceUsd.toFixed(2)}`);

    return { 
      priceUsd: roundedPriceUsd, 
      localPrice: listingPrice, 
      currency, 
      fxRate 
    };
  } catch (err: any) {
    console.error(`[PRICING_API] Exception for ${asin}:`, err?.message || err);
    return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
  }
}

// ================================================================
// DAILY SALES ROLLUP - Incremental upsert for fast repricer lookups
// ================================================================
async function upsertDailyRollup(
  supabase: any,
  userId: string,
  asin: string,
  date: string,
  marketplace: string,
  sku: string | null
): Promise<void> {
  if (!asin || asin === 'PENDING' || asin === 'UNKNOWN' || !date) return;
  
  try {
    // Re-aggregate from sales_orders for this user/date/asin to stay authoritative
    const { data: rows } = await supabase
      .from('sales_orders')
      .select('quantity, total_sale_amount')
      .eq('user_id', userId)
      .eq('order_date', date)
      .eq('asin', asin)
      .not('order_id', 'like', '%-REFUND')
      .or('order_status.is.null,order_status.neq.Canceled');

    let units = 0;
    let revenue = 0;
    for (const r of (rows || [])) {
      units += r.quantity || 1;
      revenue += r.total_sale_amount || 0;
    }

    const { error } = await supabase
      .from('asin_sales_daily')
      .upsert({
        user_id: userId,
        marketplace: marketplace || 'US',
        date,
        asin,
        sku: sku || null,
        units,
        revenue: Math.round(revenue * 100) / 100,
        last_updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,marketplace,date,asin' });

    if (error) {
      console.warn(`ROLLUP_UPSERT_ERROR: ${asin} ${date}`, (error as Error).message);
    }
  } catch (err: any) {
    console.warn(`ROLLUP_EXCEPTION: ${asin} ${date}`, err?.message);
  }
}


// Fetch the SELLER listing price ("My Price") from the Listings Items API
// This reflects the actual price set in the seller's Amazon account.
async function fetchListingPriceFromListingsApi(
  accessToken: string,
  sellerId: string,
  sku: string,
  marketplaceId: string
): Promise<{ price: number | null; source: string; error?: string }> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
  const params = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: 'offers,summaries',
  });
  const url = `${endpoint}${path}?${params}`;

  try {
    const headers = await signRequest('GET', url, '', accessToken);
    const rlClient = getRateLimitClient();
    if (rlClient) await waitForApiToken(rlClient, 'listings_api', { maxWaitMs: 6000 });
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      return { price: null, source: 'listings_api', error: 'rate_limit' };
    }
    if (response.status === 403) {
      return { price: null, source: 'listings_api', error: 'authorization_required' };
    }
    if (!response.ok) {
      const txt = await response.text();
      console.warn(`Listings API failed for SKU ${sku}: ${response.status} - ${txt.substring(0, 300)}`);
      return { price: null, source: 'listings_api', error: `API ${response.status}` };
    }

    const data = await response.json();

    let price: number | null = null;

    // offers[] is the most common location
    if (Array.isArray(data?.offers)) {
      for (const offer of data.offers) {
        const rawAmount =
          offer?.price?.amount ||
          offer?.price?.listingPrice?.amount ||
          offer?.listingPrice?.amount ||
          offer?.ourPrice?.amount ||
          offer?.regularPrice?.amount ||
          offer?.offerPrice?.amount ||
          offer?.purchasableOffer?.price?.amount;

        const parsed = typeof rawAmount === 'string' ? parseFloat(rawAmount) : rawAmount;
        if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
          price = parsed;
          break;
        }
      }
    }

    // summaries[] fallback
    if (!price && Array.isArray(data?.summaries)) {
      for (const summary of data.summaries) {
        const raw = summary?.price?.listingPrice?.amount || summary?.price?.amount;
        const parsed = typeof raw === 'string' ? parseFloat(raw) : raw;
        if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
          price = parsed;
          break;
        }
      }
    }

    return { price, source: 'listings_api' };
  } catch (err: any) {
    console.warn(`Listings API exception for SKU ${sku}:`, err?.message || err);
    return { price: null, source: 'listings_api', error: String(err?.message || err) };
  }
}

// Fetch Buy Box price from Pricing API - uses getItemOffers to get ALL offers including Buy Box
async function fetchBuyBoxPrice(accessToken: string, asin: string): Promise<number | null> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const marketplaceId = 'ATVPDKIKX0DER';
  
  // First try getItemOffers which returns ALL offers for an ASIN (not just your own)
  const offersPath = `/products/pricing/v0/items/${asin}/offers`;
  const offersParams = new URLSearchParams({
    MarketplaceId: marketplaceId,
    ItemCondition: 'New'
  });
  const offersUrl = `${endpoint}${offersPath}?${offersParams}`;
  
  try {
    const headers = await signRequest('GET', offersUrl, '', accessToken);
    const rlClient = getRateLimitClient();
    if (rlClient) await waitForApiToken(rlClient, 'pricing_api', { maxWaitMs: 6000 });
    const response = await fetch(offersUrl, { headers });
    
    if (response.status === 429) {
      console.warn(`ItemOffers API rate limited for ${asin}`);
      // Fall back to getCompetitivePricing
      return await fetchCompetitivePricing(accessToken, asin);
    }
    
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`ItemOffers API failed for ${asin}: ${response.status} - ${errText.substring(0, 200)}`);
      // Fall back to getCompetitivePricing
      return await fetchCompetitivePricing(accessToken, asin);
    }
    
    const data = await response.json();
    console.log(`📊 ITEM_OFFERS_RAW for ${asin}:`, JSON.stringify(data).substring(0, 1500));
    
    const payload = data.payload;
    if (!payload) {
      console.log(`📊 ITEM_OFFERS: No payload for ${asin}`);
      return await fetchCompetitivePricing(accessToken, asin);
    }
    
    // Check for Buy Box price in Summary
    const buyBoxPrice = payload.Summary?.BuyBoxPrices?.[0]?.LandedPrice?.Amount;
    if (buyBoxPrice) {
      const price = parseFloat(buyBoxPrice);
      console.log(`📊 ITEM_OFFERS: ${asin} BuyBoxPrice = $${price}`);
      return price || null;
    }
    
    // Check lowest price from offers
    const offers = payload.Offers || [];
    console.log(`📊 ITEM_OFFERS: ${asin} has ${offers.length} offers`);
    
    // Find Buy Box winner or lowest price
    for (const offer of offers) {
      if (offer.IsBuyBoxWinner && offer.ListingPrice?.Amount) {
        const price = parseFloat(offer.ListingPrice.Amount);
        console.log(`📊 ITEM_OFFERS: ${asin} BuyBoxWinner = $${price}`);
        return price || null;
      }
    }
    
    // Get lowest offer price
    if (offers.length > 0 && offers[0].ListingPrice?.Amount) {
      const price = parseFloat(offers[0].ListingPrice.Amount);
      console.log(`📊 ITEM_OFFERS: ${asin} LowestOffer = $${price}`);
      return price || null;
    }
    
    console.log(`📊 ITEM_OFFERS: ${asin} no price found, trying competitive pricing`);
    return await fetchCompetitivePricing(accessToken, asin);
  } catch (err: any) {
    console.warn(`ItemOffers API error for ${asin}:`, err?.message);
    return await fetchCompetitivePricing(accessToken, asin);
  }
}

// Fallback: Fetch competitive pricing
async function fetchCompetitivePricing(accessToken: string, asin: string): Promise<number | null> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const marketplaceId = 'ATVPDKIKX0DER';
  const path = '/products/pricing/v0/competitivePrice';
  const params = new URLSearchParams({
    MarketplaceId: marketplaceId,
    Asins: asin,
    ItemType: 'Asin'
  });
  const url = `${endpoint}${path}?${params}`;
  
  try {
    const headers = await signRequest('GET', url, '', accessToken);
    const rlClient = getRateLimitClient();
    if (rlClient) await waitForApiToken(rlClient, 'pricing_api', { maxWaitMs: 6000 });
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      console.warn(`CompetitivePricing API rate limited for ${asin}`);
      return null;
    }
    
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`CompetitivePricing API failed for ${asin}: ${response.status} - ${errText.substring(0, 200)}`);
      return null;
    }
    
    const data = await response.json();
    console.log(`📊 COMPETITIVE_PRICING_RAW for ${asin}:`, JSON.stringify(data).substring(0, 1500));
    
    const payload = data.payload?.[0];
    if (!payload || payload.status !== 'Success') {
      console.log(`📊 COMPETITIVE_PRICING: No success for ${asin}`);
      return null;
    }
    
    // Get competitive prices
    const compPrices = payload.Product?.CompetitivePricing?.CompetitivePrices || [];
    console.log(`📊 COMPETITIVE_PRICING: ${asin} has ${compPrices.length} prices`);
    
    for (const cp of compPrices) {
      // Look for BuyBoxPrice condition
      if (cp.condition === 'New' || cp.belongsToRequester) {
        const landedPrice = cp.Price?.LandedPrice?.Amount;
        const listingPrice = cp.Price?.ListingPrice?.Amount;
        if (landedPrice) {
          const price = parseFloat(landedPrice);
          console.log(`📊 COMPETITIVE_PRICING: ${asin} LandedPrice = $${price}`);
          return price || null;
        }
        if (listingPrice) {
          const price = parseFloat(listingPrice);
          console.log(`📊 COMPETITIVE_PRICING: ${asin} ListingPrice = $${price}`);
          return price || null;
        }
      }
    }
    
    // Try any competitive price
    if (compPrices.length > 0) {
      const cp = compPrices[0];
      const price = parseFloat(cp.Price?.LandedPrice?.Amount || cp.Price?.ListingPrice?.Amount || '0');
      if (price > 0) {
        console.log(`📊 COMPETITIVE_PRICING: ${asin} FirstPrice = $${price}`);
        return price;
      }
    }
    
    console.log(`📊 COMPETITIVE_PRICING: ${asin} no price found`);
    return null;
  } catch (err: any) {
    console.warn(`Pricing API error for ${asin}:`, err?.message);
    return null;
  }
}

// Fetch actual fees from SP-API Product Fees API
// Uses the "My Fees Estimate for ASIN" endpoint (not listings endpoint)
// UPDATED: Now supports marketplace-specific fees for non-US markets (MX, CA, BR)
// NEW: priceInLocalCurrency parameter allows passing the ACTUAL local currency price
// directly without conversion (important when we have the real MX/CA/BR listing price)
async function fetchProductFees(
  accessToken: string, 
  asin: string, 
  priceUsd: number,
  marketplaceId: string = 'ATVPDKIKX0DER',
  fxRates: Record<string, number> = {},
  priceInLocalCurrency?: number, // Optional: actual local currency price (e.g., 210 MXN)
  isAmazonFulfilled: boolean = true // false = FBM (Merchant Fulfilled)
): Promise<{
  referralFee: number;
  fbaFee: number;
  closingFee: number;
  totalFees: number;
  feeSource: string;
} | null> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  
  // Marketplace to currency mapping
  const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
    'ATVPDKIKX0DER': 'USD', // US
    'A2EUQ1WTGCTBG2': 'CAD', // CA
    'A1AM78C64UM0Y8': 'MXN', // MX
    'A2Q3Y263D00KWC': 'BRL', // BR
  };
  
  const currencyCode = MARKETPLACE_TO_CURRENCY[marketplaceId] || 'USD';
  const isNonUs = currencyCode !== 'USD';
  const fxRate = (fxRates && fxRates[currencyCode]) ? fxRates[currencyCode] : 1;
  
  // CRITICAL FIX: If we have the actual local currency price, use it directly
  // Otherwise, convert USD to local currency for the API call
  let priceLocal: number;
  if (priceInLocalCurrency && priceInLocalCurrency > 0 && isNonUs) {
    // We have the ACTUAL local currency price - use it directly!
    priceLocal = priceInLocalCurrency;
    console.log(`[FEES_API] ${asin} Using ACTUAL local price ${priceLocal.toFixed(2)} ${currencyCode} for marketplace ${marketplaceId}`);
  } else if (isNonUs) {
    // Fallback: Convert USD to local currency (less accurate)
    priceLocal = priceUsd * fxRate;
    console.log(`[FEES_API] ${asin} Converting USD $${priceUsd.toFixed(2)} → ${currencyCode} ${priceLocal.toFixed(2)} for marketplace ${marketplaceId} (FX rate: ${fxRate})`);
  } else {
    priceLocal = priceUsd;
  }
  
  // Use the ASIN-based endpoint (more reliable than listings endpoint)
  const path = `/products/fees/v0/items/${asin}/feesEstimate`;
  const url = `${endpoint}${path}`;
  
  const requestBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: isAmazonFulfilled,
      ...(isAmazonFulfilled ? { OptionalFulfillmentProgram: "FBA_CORE" } : {}),
      PriceToEstimateFees: {
        ListingPrice: {
          CurrencyCode: currencyCode,
          Amount: priceLocal
        },
        Shipping: {
          CurrencyCode: currencyCode,
          Amount: 0
        }
      },
      Identifier: `fee-estimate-${asin}-${Date.now()}`
    }
  });
  
  console.log(`[FEES_API] ${asin} Requesting fees with IsAmazonFulfilled=${isAmazonFulfilled}`);
  
  // GLOBAL TOKEN BUCKET: gate every Fees API call so sync-sales-orders,
  // calculate-roi-range and any other enrichment share one budget.
  const rlClient = getRateLimitClient();
  if (rlClient) {
    await waitForApiToken(rlClient, 'fees_api', { maxWaitMs: 6000 });
  }

  try {
    const headers = await signRequest('POST', url, requestBody, accessToken);
    headers['Content-Type'] = 'application/json';
    
    const response = await fetch(url, { 
      method: 'POST',
      headers,
      body: requestBody
    });

    
    if (response.status === 429) {
      console.warn(`⚠️ FEES_API_RATE_LIMITED: ${asin}`);
      // Wait and retry once
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryResponse = await fetch(url, { method: 'POST', headers, body: requestBody });
      if (!retryResponse.ok) {
        console.warn(`⚠️ FEES_API_RETRY_FAILED: ${asin}: ${retryResponse.status}`);
        return null;
      }
      const retryData = await retryResponse.json();
      return parseFeesResponse(retryData, asin, priceUsd, isNonUs, fxRate, marketplaceId);
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`⚠️ FEES_API_ERROR: ${asin}: ${response.status} - ${errorText.substring(0, 200)}`);
      return null;
    }
    
    const data = await response.json();
    return parseFeesResponse(data, asin, priceUsd, isNonUs, fxRate, marketplaceId);
  } catch (err: any) {
    console.warn(`⚠️ FEES_API_EXCEPTION: ${asin}: ${err?.message}`);
    return null;
  }
}

// Parse the fees response from SP-API
// UPDATED: Now handles non-US currencies and converts fees back to USD
function parseFeesResponse(
  data: any, 
  asin: string, 
  priceUsd: number,
  isNonUs: boolean = false,
  fxRate: number = 1,
  marketplaceId: string = 'ATVPDKIKX0DER'
): {
  referralFee: number;
  fbaFee: number;
  closingFee: number;
  totalFees: number;
  feeSource: string;
} | null {
  const feesEstimate = data.payload?.FeesEstimateResult?.FeesEstimate;
  
  if (!feesEstimate) {
    console.warn(`⚠️ FEES_API_NO_ESTIMATE: ${asin} - Response: ${JSON.stringify(data).substring(0, 300)}`);
    return null;
  }
  
  // Check for API errors in the response
  if (data.payload?.FeesEstimateResult?.Error) {
    const error = data.payload.FeesEstimateResult.Error;
    console.warn(`⚠️ FEES_API_RESULT_ERROR: ${asin} - ${error.Code}: ${error.Message}`);
    return null;
  }
  
  const feeDetailList = feesEstimate.FeeDetailList || [];
  
  if (feeDetailList.length === 0) {
    console.warn(`⚠️ FEES_API_EMPTY_LIST: ${asin} - TotalFees: ${feesEstimate.TotalFeesEstimate?.Amount || 'N/A'}`);
    
    // STRICT: If only TotalFeesEstimate exists but no breakdown, we CANNOT guess the split
    // Return null so fees remain unknown - will be accurate after settlement
    if (feesEstimate.TotalFeesEstimate?.Amount) {
      console.warn(`⚠️ FEES_API_TOTAL_ONLY: ${asin} - Has total but no breakdown, returning null (strict mode)`);
    }
    return null;
  }
  
  let referralFeeLocal = 0;
  let fbaFeeLocal = 0;
  let closingFeeLocal = 0;
  
  for (const feeDetail of feeDetailList) {
    const amount = parseFloat(feeDetail.FinalFee?.Amount || '0');
    const feeType = feeDetail.FeeType;
    
    // Log each fee type for debugging
    console.log(`  📋 FeeType: ${feeType} = ${amount.toFixed(2)} (${isNonUs ? 'local currency' : 'USD'})`);
    
    if (feeType === 'ReferralFee') {
      referralFeeLocal = amount;
    } else if (feeType === 'FBAFees' || feeType === 'FulfillmentFee' || feeType === 'FBAWeightBasedFee' || feeType === 'FBAPerUnitFulfillmentFee') {
      fbaFeeLocal += amount; // Add up all FBA-related fees
    } else if (feeType === 'VariableClosingFee') {
      closingFeeLocal = amount;
    }
  }
  
  // If no FBA fee was found in details but we have total, calculate it
  if (fbaFeeLocal === 0 && feesEstimate.TotalFeesEstimate?.Amount) {
    const totalFromApi = parseFloat(feesEstimate.TotalFeesEstimate.Amount);
    fbaFeeLocal = Math.max(totalFromApi - referralFeeLocal - closingFeeLocal, 0);
  }
  
  // CRITICAL: Convert fees from local currency to USD for non-US marketplaces
  // We store everything in USD for consistent reporting
  let referralFee = referralFeeLocal;
  let fbaFee = fbaFeeLocal;
  let closingFee = closingFeeLocal;
  
  if (isNonUs && fxRate > 0) {
    referralFee = referralFeeLocal / fxRate;
    fbaFee = fbaFeeLocal / fxRate;
    closingFee = closingFeeLocal / fxRate;
    console.log(`[FEES_API] ${asin} Converting fees from local → USD (rate=${fxRate}): referral=${referralFeeLocal.toFixed(2)} → $${referralFee.toFixed(2)}, fba=${fbaFeeLocal.toFixed(2)} → $${fbaFee.toFixed(2)}`);
  }
  
  const totalFees = referralFee + fbaFee + closingFee;
  const marketplaceLabel = isNonUs ? ` [${marketplaceId}]` : '';
  console.log(`💰 FEES_API_SUCCESS: ${asin} @ $${priceUsd.toFixed(2)}${marketplaceLabel} -> referral=$${referralFee.toFixed(2)}, fba=$${fbaFee.toFixed(2)}, closing=$${closingFee.toFixed(2)}, total=$${totalFees.toFixed(2)} USD`);
  
  const feeSource = isNonUs ? `fees_api_${marketplaceId.slice(-2).toLowerCase()}` : 'fees_api';
  
  return { referralFee, fbaFee, closingFee, totalFees, feeSource };
}

// Convert timestamp to Pacific Time date string (YYYY-MM-DD)
// Amazon business day = midnight-to-midnight in Pacific Time
// NO "subtract 2 hours" hack - just format directly in PT
function getPacificDateString(isoTimestamp: string): string {
  try {
    return new Date(isoTimestamp).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  } catch {
    // Fallback if toLocaleDateString fails
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    
    const parts = formatter.formatToParts(new Date(isoTimestamp));
    const year = parts.find(p => p.type === 'year')?.value || '2025';
    const month = parts.find(p => p.type === 'month')?.value || '01';
    const day = parts.find(p => p.type === 'day')?.value || '01';
    
    return `${year}-${month}-${day}`;
  }
}

// ================================================================
// LITE INSERT - Fast pending order creation WITHOUT fetchOrderItems
// ================================================================
async function insertPendingOrderLite(
  supabase: any,
  userId: string,
  order: any,
  fxRates: Record<string, number> = {}
): Promise<boolean> {
  const orderId = order.AmazonOrderId;
  const orderStatus = order.OrderStatus;
  const purchaseDate = order.PurchaseDate ? getPacificDateString(order.PurchaseDate) : null;
  
  if (!orderId || !purchaseDate) {
    return false;
  }

  // Handle cancelled orders - zero them out if they exist
  if (orderStatus === 'Canceled') {
    // Check if this order already exists in our database
    const { data: existingCancelled } = await supabase
      .from('sales_orders')
      .select('id, asin, sold_price')
      .eq('user_id', userId)
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (existingCancelled) {
      // Order exists - zero it out instead of hiding
      console.log(`🚫 CANCELLATION_DETECTED: ${orderId} | ASIN=${existingCancelled.asin} | was $${existingCancelled.sold_price} -> ZEROING OUT`);
      
      const { error: cancelError } = await supabase
        .from('sales_orders')
        .update({
          sold_price: 0,
          total_sale_amount: 0,
          referral_fee: 0,
          fba_fee: 0,
          closing_fee: 0,
          total_fees: 0,
          total_cost: 0,
          roi: 0,
          order_status: 'Canceled',
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingCancelled.id);
      
      if (cancelError) {
        console.error(`🚫 CANCELLATION_UPDATE_ERROR: ${orderId}`, cancelError.message);
      } else {
        console.log(`🚫 CANCELLATION_ZEROED: ${orderId} | Successfully zeroed out`);
      }
      return false; // Not a new order
    }
    
    // Order doesn't exist - skip insertion of cancelled orders
    console.log(`LITE_SKIP_CANCELLED: ${orderId} | status=${orderStatus} (never existed in DB)`);
    return false;
  }

  const currencyCode = order.OrderTotal?.CurrencyCode || 'USD';
  const CURRENCY_TO_MARKETPLACE: Record<string, string> = { 'USD': 'US', 'MXN': 'MX', 'CAD': 'CA', 'BRL': 'BR' };
  const MARKETPLACE_ID_TO_CODE: Record<string, string> = {
    'ATVPDKIKX0DER': 'US',
    'A2EUQ1WTGCTBG2': 'CA',
    'A1AM78C64UM0Y8': 'MX',
    'A2Q3Y263D00KWC': 'BR',
  };
  
  // Determine marketplace priority:
  // 1. MarketplaceId from Amazon API (most reliable)
  // 2. SalesChannel domain
  // 3. CurrencyCode mapping
  // 4. Order ID prefix (unreliable - 701- can be CA or MX, don't use)
  let marketplace = 'US';
  
  // Priority 1: Use MarketplaceId from Amazon (most reliable)
  if (order.MarketplaceId && MARKETPLACE_ID_TO_CODE[order.MarketplaceId]) {
    marketplace = MARKETPLACE_ID_TO_CODE[order.MarketplaceId];
    console.log(`🌎 MARKETPLACE_FROM_ID: ${orderId} -> ${marketplace} (MarketplaceId: ${order.MarketplaceId})`);
  }
  // Priority 2: Use SalesChannel domain
  else if (order.SalesChannel) {
    const channel = order.SalesChannel;
    if (channel.includes('.com.mx')) marketplace = 'MX';
    else if (channel.includes('.com.br')) marketplace = 'BR';
    else if (channel.includes('.ca')) marketplace = 'CA';
    else if (channel.includes('.com')) marketplace = 'US';
    console.log(`🌎 MARKETPLACE_FROM_CHANNEL: ${orderId} -> ${marketplace} (SalesChannel: ${channel})`);
  }
  // Priority 3: Use currency code
  else if (currencyCode !== 'USD' && CURRENCY_TO_MARKETPLACE[currencyCode]) {
    marketplace = CURRENCY_TO_MARKETPLACE[currencyCode];
    console.log(`🌎 MARKETPLACE_FROM_CURRENCY: ${orderId} -> ${marketplace} (currency: ${currencyCode})`);
  }
  // No order ID prefix fallback - 701- can be CA or MX, unreliable

  // Does this order already exist in ANY form?
  //
  // ⚠️ This check used to filter `.eq('asin', 'PENDING')`, and that single clause
  // was the source of ~1,079 ghost rows (diagnosed 2026-08-21). Once
  // enrich-pending-orders resolves an order's ASIN there is NO 'PENDING' row left,
  // so the next sync of the same order saw "not present" and inserted a fresh
  // placeholder. The upsert below cannot catch it either: its onConflict is
  // (user_id, order_id, asin), and 'PENDING' never conflicts with the real ASIN.
  //
  // The ghost is then picked up by enrich-pending-orders, resolved to the real
  // ASIN, and the write collides with the already-settled row on
  // sales_orders_user_order_asin_idx -- an error that function swallows, so the
  // ghost is never cleared and the loop repeats ~2.7s apart, indefinitely.
  //
  // Two generators were confirmed from the row data:
  //   * routine incremental sync -- ghost appears exactly one ~30-minute cycle
  //     after the real row (11:41:34 -> 12:11:33, 09:40:33 -> 10:10:33, ...)
  //   * performBackfillChunk walking backwards through history -- 1,070 ghosts in
  //     ~2 minutes on 2026-08-20 13:13-13:15, all for orders that settled in July
  //
  // The cancelled-order branch at the top of this function already queries
  // (user_id, order_id) with no ASIN filter. This now matches it.
  const { data: existingRows } = await supabase
    .from('sales_orders')
    .select('id, asin, status, marketplace, quantity')
    .eq('user_id', userId)
    .eq('order_id', orderId)
    .limit(50);

  const rowsForOrder = existingRows || [];
  const existingPending = rowsForOrder.find((r: any) => r.asin === 'PENDING') || null;

  // Already known under a real ASIN, with no placeholder left: there is nothing to
  // insert. Deliberately NOT falling through to the upsert -- the resolved row
  // already carries settled price and fees, and writing a placeholder beside it is
  // exactly the defect this guard exists to prevent.
  if (!existingPending && rowsForOrder.length > 0) {
    console.log(`LITE_SKIP_ALREADY_RESOLVED: ${orderId} | ${rowsForOrder.length} row(s) | asins=${rowsForOrder.map((r: any) => r.asin).join(',')}`);
    return false;
  }

  // Compute correct quantity (shipped + unshipped)
  const desiredQty = (() => {
    const shipped = Number(order.NumberOfItemsShipped || 0);
    const unshipped = Number(order.NumberOfItemsUnshipped || 0);
    const total = shipped + unshipped;
    return total > 0 ? total : 1;
  })();

  // Placeholder still present: fix marketplace/quantity in place.
  //
  // These corrections stay scoped to the PENDING placeholder ON PURPOSE. desiredQty
  // is the ORDER-level unit count, while a resolved multi-item order carries one row
  // per ASIN -- applying it to a real row would overwrite a correct per-item
  // quantity with the order total.
  if (existingPending) {
    const updates: any = { updated_at: new Date().toISOString() };

    // Fix marketplace if it was incorrectly set using MarketplaceId from API
    if (order.MarketplaceId && MARKETPLACE_ID_TO_CODE[order.MarketplaceId]) {
      const correctMarketplace = MARKETPLACE_ID_TO_CODE[order.MarketplaceId];
      if (existingPending.marketplace !== correctMarketplace) {
        updates.marketplace = correctMarketplace;
        console.log(`🌎 MARKETPLACE_CORRECTED: ${orderId} -> ${correctMarketplace} (was ${existingPending.marketplace}, from MarketplaceId)`);
      }
    }

    // Fix quantity for multi-unit orders (common for pending orders)
    if (desiredQty && desiredQty !== (existingPending.quantity || 0)) {
      updates.quantity = desiredQty;
      console.log(`🧮 QTY_CORRECTED: ${orderId} -> ${existingPending.quantity} → ${desiredQty}`);
    }

    if (Object.keys(updates).length > 1) {
      await supabase.from('sales_orders').update(updates).eq('id', existingPending.id);
    }

    return false;
  }

  // Calculate basic totals from OrderTotal using live FX rates
  // CRITICAL: Use OrderTotal.Amount as provisional price for pending orders (matches Sellerboard behavior)
  // This is the actual transaction total, NOT an estimate like Buy Box price
  const orderTotal = parseFloat(order.OrderTotal?.Amount || '0');
  const totalInUSD = convertToUsd(orderTotal, currencyCode, fxRates);
  
  // Determine price_source based on order status and data availability
  // order_total_pending: Using OrderTotal from GetOrders (provisional, will be overwritten)
  // orders_itemprice: Using ItemPrice from GetOrderItems (real transaction price)
  // financial_events: Final authoritative price from Financial Events API
  const priceSource = orderTotal > 0 ? 'order_total_pending' : null;
  
  console.log(`💱 ORDER_TOTAL_CONVERT: ${orderId} ${currencyCode} ${orderTotal} -> USD $${totalInUSD.toFixed(2)} | price_source=${priceSource}`);

  // Insert as pending - Financial Events will fill in ASIN, fees, etc.
  // ARCHITECTURAL RULE: sold_price/total_sale_amount come ONLY from real Orders API ItemPrice
  // (orders_itemprice/sold_price_intl) or FEC settlement. OrderTotal at insertion is a pre-
  // settlement estimate → goes to estimated_price ONLY, with needs_price_enrich=true so the
  // next enrichment cycle pulls real ItemPrice / Financial Events.
  const orderData: any = {
    user_id: userId,
    order_id: orderId,
    asin: 'PENDING',
    sku: null,
    title: 'Order Processing...',
    image_url: null,
    // IMPORTANT: total units in the order = shipped + unshipped (Amazon often splits them)
    // Using only one of them undercounts multi-unit orders.
    quantity: (() => {
      const shipped = Number(order.NumberOfItemsShipped || 0);
      const unshipped = Number(order.NumberOfItemsUnshipped || 0);
      const total = shipped + unshipped;
      return total > 0 ? total : 1;
    })(),
    sold_price: 0,
    total_sale_amount: 0,
    item_price: 0,
    estimated_price: totalInUSD > 0 ? totalInUSD : null,
    needs_price_enrich: true,
    price_enrich_status: 'pending',
    referral_fee: null, // NULL = unknown (will be enriched later)
    fba_fee: null,
    closing_fee: null,
    total_fees: null,
    fees_source: 'unavailable',
    fees_missing: true, // Flag for UI filtering
    needs_fee_enrich: true, // Ensure enrich-pending-orders retries fees once ASIN/price resolve
    unit_cost: 0,
    total_cost: 0,
    roi: 0,
    order_date: purchaseDate,
    marketplace,
    status: 'pending',
    order_status: orderStatus,
    updated_at: new Date().toISOString(),
  };

  // Add price_source if we have a provisional price
  if (priceSource) {
    orderData.price_source = priceSource;
  }

  // Use upsert to avoid unique-constraint failures (race conditions / retries)
  const { error } = await supabase
    .from('sales_orders')
    .upsert(orderData, { onConflict: 'user_id,order_id,asin' });

  if (error) {
    console.error(`LITE_UPSERT_ERROR: ${orderId}`, (error as Error).message);
    return false;
  }
  
  console.log(`LITE_UPSERTED: ${orderId} | ${purchaseDate} | pending | price_source=${priceSource}`);
  return true;
}

// ================================================================
// ENRICH ORDERS WITH ASIN - Fixed to catch ALL bad ASINs regardless of status
// ================================================================
async function enrichPendingOrdersWithAsins(
  supabase: any,
  userId: string,
  accessToken: string,
  batchSize: number = 25,
  fxRates: Record<string, number> = {}
): Promise<number> {
  // Find orders needing enrichment:
  // 1. Orders with bad ASIN (PENDING, UNKNOWN, null, empty)
  // 2. Pending orders with valid ASIN but $0 sold_price (need price from API)
  
  // First: orders needing ASIN
  const { data: needsAsin, error: asinError } = await supabase
    .from('sales_orders')
    .select('id, order_id, asin, sold_price, status, unit_cost, quantity, order_date, marketplace, sku, seller_sku, price_source, estimated_price, fulfillment_channel')
    .eq('user_id', userId)
    .or('asin.eq.PENDING,asin.eq.UNKNOWN,asin.is.null,asin.eq.')
    .order('created_at', { ascending: false })
    .limit(batchSize);
  
  // Second: pending orders with valid ASIN but $0 price
  const { data: needsPrice, error: priceError } = await supabase
    .from('sales_orders')
    .select('id, order_id, asin, sold_price, status, unit_cost, quantity, order_date, marketplace, sku, seller_sku, price_source, estimated_price, fulfillment_channel')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .eq('sold_price', 0)
    .not('asin', 'in', '(PENDING,UNKNOWN)')
    .not('asin', 'is', null)
    .neq('asin', '')
    .order('created_at', { ascending: false })
    .limit(batchSize);
  
  if (asinError) console.error('🔄 ASIN_ENRICH_SELECT_ERROR:', asinError.message);
  if (priceError) console.error('🔄 PRICE_ENRICH_SELECT_ERROR:', priceError.message);
  
  // Combine and deduplicate by order_id
  const seenOrderRows = new Set<string>();
  const allOrders: any[] = [];
  
  for (const order of (needsAsin || [])) {
    if (!seenOrderRows.has(order.id)) {
      seenOrderRows.add(order.id);
      allOrders.push(order);
    }
  }
  
  for (const order of (needsPrice || [])) {
    if (!seenOrderRows.has(order.id)) {
      seenOrderRows.add(order.id);
      allOrders.push(order);
    }
  }
  
  if (allOrders.length === 0) {
    console.log('🔄 ENRICH: No orders needing ASIN or price enrichment');
    return 0;
  }
  
  console.log(`🔄 ENRICH: Found ${allOrders.length} orders (${needsAsin?.length || 0} need ASIN, ${needsPrice?.length || 0} need price)`);
  
  let enrichedCount = 0;
  
  // Currency to marketplace mapping (FX rates now passed as parameter)
  const CURRENCY_TO_MARKETPLACE: Record<string, string> = { 'USD': 'US', 'MXN': 'MX', 'CAD': 'CA', 'BRL': 'BR' };
  
  for (const order of allOrders) {
    try {
      const orderItems = await fetchOrderItems(accessToken, order.order_id);

      if ((orderItems as any)?.__rateLimited === true) {
        // RE-QUEUE: rate-limited → never mark enrichment complete.
        const nextAfter = new Date(Date.now() + Math.min(30, 5 + (order.pending_enrich_attempts || 0) * 5) * 60_000).toISOString();
        await supabase
          .from('sales_orders')
          .update({
            pending_enrich_attempts: (order.pending_enrich_attempts || 0) + 1,
            pending_enrich_last_attempt_at: new Date().toISOString(),
            pending_enrich_last_error: 'ORDER_ITEMS_RATE_LIMITED',
            next_enrich_after: nextAfter,
            needs_price_enrich: true,
            price_enrich_status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        console.warn(`⏳ requeued_order_items_rate_limited: ENRICH ${order.order_id} -> next attempt after ${nextAfter}`);
        HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'rate_limited', order.order_id);
        HealthSignals.orderItemsRateLimited(userId, 'sync-sales-orders', order.order_id);
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }

      if (orderItems && orderItems.length > 0) {
        // Multi-item orders are common: match the API line item to this sales_orders row,
        // otherwise item #1 metadata/price can overwrite item #2.
        const firstItem = orderItems.find((item: any) =>
          (order.sku && item.SellerSKU === order.sku) ||
          (order.seller_sku && item.SellerSKU === order.seller_sku) ||
          (order.asin && !['PENDING', 'UNKNOWN', ''].includes(order.asin) && item.ASIN === order.asin)
        ) || orderItems[0];
        const asin = firstItem.ASIN || firstItem.SellerSKU || order.asin || 'UNKNOWN';
        const sku = firstItem.SellerSKU || null;
        const quantity = parseInt(firstItem.QuantityOrdered || '1', 10);
        const apiTitle = firstItem.Title || null;
        
        // CRITICAL: Extract ItemPrice + ShippingPrice WITH currency conversion using live FX rates
        // Amazon returns ItemPrice (product) and ShippingPrice (shipping paid by customer) separately
        let itemPrice = 0;
        let shippingPrice = 0;
        let itemCurrencyCode = 'USD';
        let marketplace = 'US';
        
        if (firstItem.ItemPrice?.Amount) {
          const rawAmount = parseFloat(firstItem.ItemPrice.Amount) || 0;
          itemCurrencyCode = firstItem.ItemPrice?.CurrencyCode || 'USD';
          marketplace = CURRENCY_TO_MARKETPLACE[itemCurrencyCode] || 'US';
          
          // Convert item price to USD using live FX rates
          itemPrice = convertToUsd(rawAmount, itemCurrencyCode, fxRates);
          
          if (itemCurrencyCode !== 'USD') {
            console.log(`💱 ITEM_PRICE_CONVERT: ${order.order_id} ${itemCurrencyCode} ${rawAmount} -> USD $${itemPrice.toFixed(2)} (rate: ${fxRates[itemCurrencyCode] || 'N/A'})`);
          }
        }
        
        // Also extract ShippingPrice - this is the shipping the customer paid
        if (firstItem.ShippingPrice?.Amount) {
          const rawShipping = parseFloat(firstItem.ShippingPrice.Amount) || 0;
          const shippingCurrency = firstItem.ShippingPrice?.CurrencyCode || itemCurrencyCode || 'USD';
          
          // Convert shipping to USD using live FX rates
          shippingPrice = convertToUsd(rawShipping, shippingCurrency, fxRates);
          
          if (shippingCurrency !== 'USD' || rawShipping > 0) {
            console.log(`📦 SHIPPING_PRICE: ${order.order_id} ${shippingCurrency} ${rawShipping} -> USD $${shippingPrice.toFixed(2)}`);
          }
        }
        
        // CONTRACT: principal-only flows into sold_price/item_price/total_sale_amount.
        // Shipping is tracked separately in shipping_price (matches FEC writer).
        if (shippingPrice > 0) {
          console.log(`💰 PRICES_SPLIT: ${order.order_id} item=$${itemPrice.toFixed(2)} shipping=$${shippingPrice.toFixed(2)} (kept separate)`);
        }
        
        // Look up product data from local tables (like settled orders do)
        // CRITICAL: Try SKU first, then ASIN - same strategy as processFinancialEvent
        const finalAsin = asin !== 'UNKNOWN' ? asin : order.asin;
        let localTitle = null;
        let localImageUrl = null;
        let localUnitCost = 0;
        let createdItem: any = null;
        let createdItemSource: CostSource = 'listing';
        
        // Strategy 0: Manual inventory cost override wins over stale ledger fields —
        // but ONLY when the manual row also has units>0. A manual cost on a row with
        // units<=0 is unreliable and would otherwise flip the order to cost_invalid
        // even when valid created_listings cost exists.
        if (sku) {
          const { data: manualInvSku } = await supabase
            .from('inventory')
            .select('asin, title, image_url, cost, units, amount, unit_cost_manual')
            .eq('user_id', userId)
            .eq('sku', sku)
            .eq('unit_cost_manual', true)
            .gt('units', 0)
            .maybeSingle();
          if (manualInvSku) {
            createdItem = manualInvSku;
            createdItemSource = 'inventory_manual';
            console.log(`📚 COST_LOOKUP_BY_SKU_MANUAL_INVENTORY: ${order.order_id} | SKU=${sku} -> found manual inventory cost`);
          }
        }
        if (!createdItem && finalAsin && !['PENDING', 'UNKNOWN', ''].includes(finalAsin)) {
          const { data: manualInvAsin } = await supabase
            .from('inventory')
            .select('asin, title, image_url, cost, units, amount, unit_cost_manual')
            .eq('user_id', userId)
            .eq('asin', finalAsin)
            .eq('unit_cost_manual', true)
            .gt('units', 0)
            .maybeSingle();
          if (manualInvAsin) {
            createdItem = manualInvAsin;
            createdItemSource = 'inventory_manual';
            console.log(`📚 COST_LOOKUP_BY_ASIN_MANUAL_INVENTORY: ${order.order_id} | ASIN=${finalAsin} -> found manual inventory cost`);
          }
        }

        // Strategy 1: Look up by SKU first (most reliable)
        if (!createdItem && sku) {
          const { data: skuMatch } = await supabase
            .from('created_listings')
            .select('asin, title, image_url, cost, units, amount')
            .eq('user_id', userId)
            .eq('sku', sku)
            .maybeSingle();
          if (skuMatch) {
            createdItem = skuMatch;
            createdItemSource = 'listing';
            console.log(`📚 COST_LOOKUP_BY_SKU: ${order.order_id} | SKU=${sku} -> found in created_listings`);
          }
        }
        
        // Strategy 2: Fallback to ASIN lookup
        if (!createdItem && finalAsin && !['PENDING', 'UNKNOWN', ''].includes(finalAsin)) {
          const { data: asinMatch } = await supabase
            .from('created_listings')
            .select('asin, title, image_url, cost, units, amount')
            .eq('user_id', userId)
            .eq('asin', finalAsin)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (asinMatch) {
            createdItem = asinMatch;
            createdItemSource = 'listing';
            console.log(`📚 COST_LOOKUP_BY_ASIN: ${order.order_id} | ASIN=${finalAsin} -> found in created_listings`);
          }
        }
        
        // Strategy 3: Try inventory table as fallback
        if (!createdItem) {
          if (sku) {
            const { data: invSkuMatch } = await supabase
              .from('inventory')
              .select('asin, title, image_url, cost, units, amount')
              .eq('user_id', userId)
              .eq('sku', sku)
              .maybeSingle();
            if (invSkuMatch) {
              createdItem = invSkuMatch;
              createdItemSource = 'inventory';
              console.log(`📚 COST_LOOKUP_BY_SKU_INVENTORY: ${order.order_id} | SKU=${sku} -> found in inventory`);
            }
          }
          if (!createdItem && finalAsin && !['PENDING', 'UNKNOWN', ''].includes(finalAsin)) {
            const { data: invAsinMatch } = await supabase
              .from('inventory')
              .select('asin, title, image_url, cost, units, amount')
              .eq('user_id', userId)
              .eq('asin', finalAsin)
              .maybeSingle();
            if (invAsinMatch) {
              createdItem = invAsinMatch;
              createdItemSource = 'inventory';
              console.log(`📚 COST_LOOKUP_BY_ASIN_INVENTORY: ${order.order_id} | ASIN=${finalAsin} -> found in inventory`);
            }
          }
        }
        
        let costInvalidFlag = false;
        if (createdItem) {
          localTitle = createdItem.title;
          localImageUrl = createdItem.image_url;
          // COST SANITY GUARD: refuse to derive unit_cost when units<=0.
          const unit = createdItemSource === 'listing'
            ? getListingUnitCostSafe(createdItem)
            : getInventoryUnitCostSafe(createdItem);
          if (unit !== null && unit > 0) {
            localUnitCost = unit;
            console.log(`💰 UNIT_COST_CALCULATED[${createdItemSource}]: ${order.order_id} | cost=${createdItem.cost}, amount=${createdItem.amount}, units=${createdItem.units} -> unit_cost=$${localUnitCost.toFixed(2)}`);
          } else {
            costInvalidFlag = true;
            console.warn(`⚠️ COST_INVALID_GUARD[${createdItemSource}]: ${order.order_id} | cost=${createdItem.cost}, units=${createdItem.units} -> SKIPPING unit_cost write (cost_invalid=true).`);
          }
        } else {
          console.log(`⚠️ NO_COST_DATA: ${order.order_id} | SKU=${sku}, ASIN=${finalAsin} -> not found in created_listings or inventory`);
        }

        
        // Build update object - ALWAYS update marketplace if we detected non-US
        const updateData: any = {
          sku,
          quantity,
          updated_at: new Date().toISOString(),
        };
        
        // Update marketplace if we detected non-US currency
        if (marketplace !== 'US') {
          updateData.marketplace = marketplace;
          console.log(`🌍 MARKETPLACE: ${order.order_id} -> ${marketplace} (from ${itemCurrencyCode})`);
        }
        
        // Update title: API title > local title (if current is placeholder)
        const finalTitle = apiTitle || localTitle;
        const isPlaceholderTitle = !order.title || order.title === 'Order Processing...' || order.title.startsWith('Untitled Product');
        if (isPlaceholderTitle && finalTitle) {
          updateData.title = finalTitle;
          console.log(`📝 TITLE: ${order.order_id} -> "${finalTitle.substring(0, 40)}..." (source: ${apiTitle ? 'API' : 'local'})`);
        }
        
        // Update image if missing - try local first, then SP-API
        if (!order.image_url && localImageUrl) {
          updateData.image_url = localImageUrl;
        } else if (!order.image_url && !localImageUrl && finalAsin && !['PENDING', 'UNKNOWN', ''].includes(finalAsin)) {
          // Fallback: fetch image from SP-API Catalog
          try {
            const catalogData = await fetchCatalogItem(accessToken, finalAsin);
            if (catalogData?.imageUrl) {
              updateData.image_url = catalogData.imageUrl;
              console.log(`🖼️ IMAGE_FROM_SPAPI: ${order.order_id} -> ${catalogData.imageUrl.substring(0, 50)}...`);
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (imgErr: any) {
            console.log(`⚠️ IMAGE_FETCH_FAILED: ${finalAsin}: ${imgErr?.message || imgErr}`);
          }
        }
        
        // Update unit_cost if missing (only when sanity guard passed)
        if ((!order.unit_cost || order.unit_cost === 0) && localUnitCost > 0) {
          updateData.unit_cost = localUnitCost;
          updateData.cost_invalid = false;
          console.log(`💰 COST: ${order.order_id} -> $${localUnitCost.toFixed(2)} from local tables`);
        } else if (costInvalidFlag && (!order.unit_cost || order.unit_cost === 0)) {
          // Cost lookup row exists but units<=0 — mark pending so ROI stays hidden.
          updateData.cost_invalid = true;
          updateData.roi = null;
          console.warn(`⚠️ cost_invalid_units_zero: ${order.order_id} -> cost_invalid=true (units<=0 in source row); ROI hidden.`);
          HealthSignals.costInvalidUnitsZero(userId, 'sync-sales-orders', order.order_id, order.asin || undefined);
        }

        
        // Only update ASIN if it was bad (PENDING, UNKNOWN, null, etc.)
        const badAsins = ['PENDING', 'UNKNOWN', '', null];
        if (badAsins.includes(order.asin) || !order.asin) {
          updateData.asin = asin;
        }
        
        // CRITICAL: total_sale_amount = principal only (NEVER includes shipping).
        // finalPrice now tracks principal-only sale value. Shipping is persisted
        // separately to `shipping_price` further down.
        let finalPrice = itemPrice;
        const priceAsin = updateData.asin || order.asin || asin;
        
        // Determine price_source based on data source
        // NEVER persist Buy Box estimates to sold_price - they're for UI display only
        let priceSource: string | null = null;
        
        if (finalPrice > 0) {
          // Got real price from GetOrderItems - this is the actual transaction
          priceSource = 'orders_itemprice';
          console.log(`💰 PRICE_FROM_ORDER_ITEMS: ${order.order_id} -> $${finalPrice.toFixed(2)} | price_source=orders_itemprice`);
        } else if (order.sold_price === 0 && marketplace !== 'US') {
          // CRITICAL: Non-US pending orders often return $0 from GetOrderItems
          // Use Pricing API to get marketplace-specific listing price as estimate
          const isNonUsMarketplace = ['MX', 'CA', 'BR'].includes(marketplace);
          const finalAsin = updateData.asin || order.asin || asin;
          
          if (isNonUsMarketplace && finalAsin && !['PENDING', 'UNKNOWN', ''].includes(finalAsin)) {
            const marketplaceIdForPricing = MARKETPLACE_ID_MAP[marketplace] || 'ATVPDKIKX0DER';
            console.log(`🌎 NON_US_PRICING_FALLBACK: ${order.order_id} (${marketplace}) - Fetching from Pricing API...`);
            
            const pricingResult = await getMarketplacePricingPrice(finalAsin, marketplaceIdForPricing, accessToken, fxRates);
            
            if (pricingResult.priceUsd !== null && pricingResult.priceUsd > 0) {
              // Store as ESTIMATE only - don't pollute sold_price
              // UI will show "Est." badge and use estimated_price
              updateData.estimated_price = pricingResult.priceUsd;
              updateData.price_source = `estimate_pricing_api_${marketplace.toLowerCase()}`;
              // CRITICAL: Set actual prices to 0 to force UI to use estimated_price
              updateData.sold_price = 0;
              updateData.item_price = 0;
              updateData.shipping_price = 0;
              updateData.total_sale_amount = 0;
              updateData.needs_price_enrich = true;
              console.log(`✅ NON_US_ESTIMATE: ${order.order_id} | ${finalAsin} -> ${pricingResult.currency} ${pricingResult.localPrice} / ${pricingResult.fxRate} = USD $${pricingResult.priceUsd.toFixed(2)}`);
              
              // Update finalPrice for fee calculation below (but don't persist to sold_price)
              finalPrice = pricingResult.priceUsd * quantity;
              priceSource = `estimate_pricing_api_${marketplace.toLowerCase()}`;
            } else {
              console.log(`⚠️ NON_US_PRICING_FAILED: ${order.order_id} (${marketplace}) - No price from Pricing API`);
            }
            
            // Rate limit between Pricing API calls
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else if (order.sold_price === 0) {
          // US orders: GetOrderItems returned $0 - wait for Financial Events settlement
          console.log(`⚠️ PRICE_PENDING: ${order.order_id} (${marketplace}) has $0 price - will be corrected by Financial Events settlement`);
        }
        
        if (finalPrice > 0 && order.sold_price === 0 && order.status === 'pending') {
          let unitPrice = finalPrice / quantity;
          let totalSaleAmount = finalPrice;

          // RAW ENRICH LOG (for double-division diagnosis)
          console.log(`🧾 RAW_ENRICH_B: ${order.order_id} asin=${priceAsin} qty=${quantity} finalPrice=${finalPrice} computedUnit=${unitPrice.toFixed(2)} priceSource=${priceSource} estimated_price=${order.estimated_price ?? 'null'}`);

          // SANITY GUARD: half-price / double-division corruption
          const refPriceB = Math.max(
            Number(order.estimated_price) || 0,
            Number(order.item_price) || 0,
            Number(order.sold_price) || 0
          );

          // INVERSE GUARD: Amazon GetOrderItems sometimes returns ItemPrice
          // PER-UNIT instead of line-total for multi-qty Pending orders.
          // If unit looks too low but rawFinalPrice ≈ listing price, treat
          // finalPrice as per-unit and rebuild the line total.
          const perUnitFix =
            quantity > 1 &&
            refPriceB > 0 &&
            unitPrice < refPriceB * 0.6 &&
            finalPrice >= refPriceB * 0.8 &&
            finalPrice <= refPriceB * 1.2 &&
            priceSource === 'orders_itemprice';

          if (perUnitFix) {
            console.warn(`🔁 ORDERS_API_PER_UNIT_FIX: ${order.order_id} qty=${quantity} finalPrice=$${finalPrice.toFixed(2)} ref=$${refPriceB.toFixed(2)} | treating as per-unit -> unit=$${finalPrice.toFixed(2)} total=$${(finalPrice * quantity).toFixed(2)}`);
            unitPrice = finalPrice;
            totalSaleAmount = finalPrice * quantity;
          }

          if (quantity > 1 && refPriceB > 0 && unitPrice < refPriceB * 0.6 && priceSource === 'orders_itemprice') {
            console.log(`🛑 SUSPICIOUS_HALF_PRICE_HOLD: ${order.order_id} qty=${quantity} unit=$${unitPrice.toFixed(2)} ref=$${refPriceB.toFixed(2)} finalPrice=$${finalPrice.toFixed(2)} -> NOT writing sold_price, waiting for FEC settlement`);
            updateData.needs_price_enrich = true;
            updateData.price_last_error = 'SUSPICIOUS_HALF_PRICE_HOLD';
            updateData.price_last_attempt_at = new Date().toISOString();
          } else {
          
          // Try to get actual fees from SP-API Product Fees API first
          let referralFee: number;
          let fbaFee: number;
          let closingFee: number;
          let totalFees: number;
          
          const marketplaceIdForFees = MARKETPLACE_ID_MAP[marketplace] || 'ATVPDKIKX0DER';
          const currencyForFees = MARKETPLACE_TO_CURRENCY[marketplaceIdForFees] || 'USD';
          const fxRateForFees = FX_RATES_CACHE[currencyForFees] || 1;
          const localUnitPriceForFees = currencyForFees !== 'USD' && itemCurrencyCode === currencyForFees
            ? Number(firstItem.ItemPrice?.Amount || 0) / Math.max(1, quantity)
            : currencyForFees !== 'USD'
              ? unitPrice * fxRateForFees
              : undefined;
          const apiFees = await fetchProductFees(
            accessToken,
            priceAsin,
            unitPrice,
            marketplaceIdForFees,
            FX_RATES_CACHE,
            localUnitPriceForFees,
          );
          
          if (apiFees) {
            // Product Fees API estimates are per unit because it is called with unitPrice.
            // sales_orders stores line-level fees, so multiply by quantity before writing.
            referralFee = Math.round((apiFees.referralFee * quantity) * 100) / 100;
            fbaFee = Math.round((apiFees.fbaFee * quantity) * 100) / 100;
            closingFee = Math.round((apiFees.closingFee * quantity) * 100) / 100;
            totalFees = Math.round((apiFees.totalFees * quantity) * 100) / 100;
              console.log(`💰 FEES_FROM_API: ${order.order_id} (${marketplace}/${marketplaceIdForFees}) -> referral=$${referralFee.toFixed(2)}, fba=$${fbaFee.toFixed(2)}, closing=$${closingFee.toFixed(2)}`);
          } else {
            // Fallback: Check asin_fee_cache before giving up
            const marketplaceShort = marketplace === 'CA' ? 'CA' : marketplace === 'MX' ? 'MX' : marketplace === 'BR' ? 'BR' : 'US';
            const { data: cachedFee } = await supabase
              .from('asin_fee_cache')
              .select('fba_fee_fixed, referral_rate, is_media')
              .eq('user_id', userId)
              .eq('asin', priceAsin)
              .eq('marketplace', marketplaceShort)
              .maybeSingle();

            if (cachedFee && (cachedFee.fba_fee_fixed > 0 || cachedFee.referral_rate > 0)) {
              // Cache stores per-unit FBA and referral rate; sales_orders stores line-level fees.
              const unitReferralFee = unitPrice * cachedFee.referral_rate;
              const unitFbaFee = Number(cachedFee.fba_fee_fixed) || 0;
              const unitClosingFee = cachedFee.is_media ? 1.80 : 0;
              referralFee = Math.round((unitReferralFee * quantity) * 100) / 100;
              fbaFee = Math.round((unitFbaFee * quantity) * 100) / 100;
              closingFee = Math.round((unitClosingFee * quantity) * 100) / 100;
              totalFees = Math.round((referralFee + fbaFee + closingFee) * 100) / 100;
              console.log(`💰 FEES_FROM_CACHE: ${order.order_id} (${marketplaceShort}) -> referral=$${referralFee.toFixed(2)}, fba=$${fbaFee.toFixed(2)}, closing=$${closingFee.toFixed(2)}`);
              updateData.fees_source = 'from_cache';
              updateData.fees_missing = false;
            } else {
              // No cache either - fees remain NULL until settlement
              referralFee = null as any;
              fbaFee = null as any;
              closingFee = null as any;
              totalFees = null as any;
              console.log(`⚠️ FEES_UNAVAILABLE: ${order.order_id} (${marketplaceShort}) -> No API data and no cache, fees=NULL (flagging for retry)`);
              updateData.fees_missing = true;
              updateData.fees_source = 'unavailable';
              // CRITICAL: Flag so enrich-pending-orders / repair-pending-prices retries fees later.
              // Without this, intl pending rows (no Fees API + no cache yet) stay fee-less forever
              // and Live Sales shows $0 fees deducted (B0G15SJPW9 MX bug, May 2026).
              updateData.needs_fee_enrich = true;
              updateData.next_enrich_after = new Date().toISOString();
            }
          }
          
          updateData.sold_price = unitPrice;
          updateData.item_price = unitPrice;
          updateData.shipping_price = quantity > 0 ? shippingPrice / quantity : 0;
          updateData.total_sale_amount = totalSaleAmount; // principal only (finalPrice = itemPrice)
          updateData.referral_fee = referralFee;
          updateData.fba_fee = fbaFee;
          updateData.closing_fee = closingFee;
          updateData.total_fees = totalFees;
          
          // Set price_source when we update the price
          if (priceSource) {
            updateData.price_source = priceSource;
          }
          updateData.price_confidence = 'CONFIRMED';
          updateData.price_enrich_status = 'enriched';
          updateData.needs_price_enrich = false;
          updateData.price_last_error = null;
          
          // Calculate ROI - use local unit cost we just looked up, or existing order unit_cost
          const unitCost = localUnitCost || updateData.unit_cost || order.unit_cost || 0;
          if (unitCost > 0) {
            const profit = unitPrice - (totalFees / quantity) - unitCost;
            const roi = (profit / unitCost) * 100;
            updateData.roi = Math.round(roi * 10) / 10; // Round to 1 decimal
            updateData.total_cost = unitCost * quantity;
            console.log(`📊 ROI_CALC: price=$${unitPrice.toFixed(2)} - fees=$${(totalFees/quantity).toFixed(2)} - cost=$${unitCost.toFixed(2)} = profit=$${profit.toFixed(2)} -> ROI=${roi.toFixed(1)}%`);
            
            // FIX #6: Only send low ROI alert when ROI is based on trusted inputs
            // Check if we have actual data (not estimates) before alerting
            const priceCalcMode = order.price_calc_mode || 'unknown';
            const roiSourceFromOrder = order.roi_source || 'unknown';
            const priceSource = updateData.price_source || order.price_source || 'unknown';
            
            // ROI is trustworthy if price comes from Orders API and we have actual cost
            const hasTrustedPrice = priceSource === 'orders_itemprice' || priceCalcMode === 'orders_itemprice';
            const hasTrustedCost = unitCost > 0;
            const isTrustedRoi = hasTrustedPrice && hasTrustedCost;
            
            // Send low ROI alert for pending orders with ROI < threshold ONLY if ROI is trusted
            // Skip refunds AND replacement orders - they shouldn't trigger low ROI alerts
            const isRefundOrder = order.order_id?.includes('-REFUND') || 
                                  order.order_type === 'Refund' || 
                                  order.order_type === 'refund';
            
            // Replacement orders have $0 revenue but still incur costs - not a sourcing issue
            const isReplacementOrder = (order.order_type || '').toLowerCase().includes('replacement');
            
            // Skip any zero or negative revenue orders (catches edge cases from rounding, adjustments)
            // This is the "belt + suspenders" approach ChatGPT recommended
            const isZeroOrNegativeRevenue = unitPrice <= 0;
            
            const shouldSkipAlert = isRefundOrder || isReplacementOrder || isZeroOrNegativeRevenue;
            
            if (roi < LOW_ROI_THRESHOLD && order.status === 'pending' && isTrustedRoi && !shouldSkipAlert) {
              console.log(`⚠️ LOW_ROI: ${order.order_id} ROI=${roi.toFixed(1)}% (in-page alert via roi_alerts table)`);
            } else if (roi < LOW_ROI_THRESHOLD && !isTrustedRoi) {
              console.log(`⚠️ LOW_ROI_SKIP: ${order.order_id} ROI=${roi.toFixed(1)}% but not trusted (price_source=${priceSource}, hasCost=${hasTrustedCost})`);
            } else if (roi < LOW_ROI_THRESHOLD && shouldSkipAlert) {
              console.log(`⚠️ LOW_ROI_SKIP: ${order.order_id} ROI=${roi.toFixed(1)}% is refund/replacement, skipping alert`);
            }
          }
          
          console.log(`💰 PRICE_UPDATED: ${order.order_id} -> $${unitPrice.toFixed(2)} (qty ${quantity}, fees ~$${totalFees.toFixed(2)}) | price_source=${priceSource}`);
          } // end else (sanity guard pass)
        }

        // Phase 1: own-BB tracking capture (DATA CAPTURE ONLY).
        // Write bb_estimate_* columns whenever the row is still pending
        // (no confirmed sold_price yet). Safe: never touches sold_price /
        // estimated_price / repricer behavior.
        const stillPending =
          (updateData.sold_price === undefined ? (order.sold_price || 0) : updateData.sold_price) === 0;
        if (stillPending && order.asin && !['PENDING', 'UNKNOWN'].includes(order.asin)) {
          try {
            const orderDateIso =
              order.purchase_timestamp_utc || order.order_date || new Date().toISOString();
            const bbFields = await computeBbOwnEstimateFields(
              supabase,
              {
                userId,
                asin: order.asin,
                marketplace: order.marketplace || marketplace || 'US',
                orderDateIso,
                fulfillmentChannel: order.fulfillment_channel || null,
              },
              ((globalThis as any).__bbSellerIdCache ||= makeSellerIdCache()),
            );
            Object.assign(updateData, bbFields);
            // Own-BB capture is diagnostic only for pending orders. Never promote
            // bb_estimate_price into estimated_price: even a qualified Buy Box
            // price can be another offer's price. Pending order display must use
            // seller-derived values only (snapshot, repricer action, Listings).
            const currentConfidence = (updateData as any).price_confidence ?? (order as any).price_confidence;
            const currentSoldPrice = (updateData as any).sold_price === undefined ? (order.sold_price || 0) : (updateData as any).sold_price;
            if (
              bbFields.bb_estimate_qualified &&
              (bbFields.bb_estimate_price ?? 0) > 0 &&
              currentConfidence !== 'CONFIRMED' &&
              currentSoldPrice === 0
            ) {
              console.log(`🛡️ BB_CAPTURE_ONLY: ${order.order_id}/${order.asin} did not promote BB=$${bbFields.bb_estimate_price}; pending prices require seller-derived source`);
            }
          } catch (e: any) {
            console.warn(`[bbOwnEstimate] sync-sales-orders capture skipped for ${order.order_id}/${order.asin}: ${e?.message ?? e}`);
          }
        }

        const { error: updateError } = await supabase
          .from('sales_orders')
          .update(updateData)
          .eq('id', order.id);
        
        if (!updateError) {
          console.log(`✅ ENRICHED: ${order.order_id} -> ${updateData.asin || order.asin} (qty ${quantity})`);
          enrichedCount++;
          const enrichedAsinForAssignment = updateData.asin || order.asin;
          const enrichedMarketplace = updateData.marketplace || order.marketplace || marketplace || 'US';
          await ensureRepricerAssignmentFromSale(
            supabase,
            userId,
            enrichedAsinForAssignment,
            sku || order.sku || order.seller_sku,
            enrichedMarketplace,
            order.fulfillment_channel === 'MFN' ? 'FBM' : 'FBA'
          );
          // Update daily rollup when ASIN is resolved from PENDING
          const enrichedAsin = updateData.asin || order.asin;
          if (enrichedAsin && enrichedAsin !== 'PENDING' && enrichedAsin !== 'UNKNOWN') {
            await upsertDailyRollup(supabase, userId, enrichedAsin, order.order_date, enrichedMarketplace, sku || order.sku || null);
          }
        } else {
          // Duplicate key: a real (order_id, asin) row already exists.
          // The current row is the stale PENDING placeholder — delete it to resolve the conflict.
          const isDuplicate = (updateError as any)?.code === '23505'
            || /duplicate key|sales_orders_user_order_asin_idx/i.test(updateError.message || '');
          if (isDuplicate && (order.asin === 'PENDING' || order.asin === 'UNKNOWN' || !order.asin)) {
            const { error: delError } = await supabase
              .from('sales_orders')
              .delete()
              .eq('id', order.id);
            if (!delError) {
              console.log(`🧹 ENRICH_DEDUPE: Deleted stale PENDING row ${order.order_id} (id=${order.id}); real ASIN row already exists`);
            } else {
              console.error(`❌ ENRICH_DEDUPE_DELETE_ERROR: ${order.order_id}`, delError.message);
            }
          } else {
            console.error(`❌ ENRICH_UPDATE_ERROR: ${order.order_id}`, updateError.message);
          }
        }
      } else {
        // No items returned (not rate-limited — that path already re-queued above).
        // Treat as "not yet enriched" so the next refresh cycle retries instead of
        // silently marking the order as finished.
        const nextAfter = new Date(Date.now() + Math.min(30, 5 + (order.pending_enrich_attempts || 0) * 5) * 60_000).toISOString();
        await supabase
          .from('sales_orders')
          .update({
            pending_enrich_attempts: (order.pending_enrich_attempts || 0) + 1,
            pending_enrich_last_attempt_at: new Date().toISOString(),
            pending_enrich_last_error: 'NO_ORDER_ITEMS',
            next_enrich_after: nextAfter,
            needs_price_enrich: true,
            price_enrich_status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);
        console.log(`💰 requeued_order_items_no_price: ENRICH ${order.order_id} - no items returned; next attempt after ${nextAfter}`);
        HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'no_price', order.order_id);
      }
      
      // Rate limit: 500ms delay between GetOrderItems calls (reduced from 1s)
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err: any) {
      console.error(`❌ ASIN_ENRICH_ERROR: ${order.order_id}:`, err?.message || err);
    }
  }
  
  console.log(`🔄 ASIN_ENRICH complete: ${enrichedCount}/${allOrders.length} enriched`);
  return enrichedCount;
}

// ================================================================
// North American Marketplace IDs
const NA_MARKETPLACE_IDS = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

// ================================================================
// INCREMENTAL ORDERS FETCH - Uses CreatedAfter to catch all new orders
// Now fetches from ALL North American marketplaces
// CRITICAL FIX: Changed from LastUpdatedAfter to CreatedAfter
// LastUpdatedAfter missed orders created before but not updated since
// ================================================================
async function fetchOrdersIncremental(
  accessToken: string,
  marketplaceId: string, // Primary marketplace (kept for backward compat)
  lastSync: Date,
  maxOrders: number
): Promise<{ orders: any[]; lastUpdateInBatch: Date | null; failed: boolean }> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = '/orders/v0/orders';
  const maxRetries = 3;
  
  const now = new Date();
  const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
  
  // Query ALL North American marketplaces (comma-separated)
  const allNAMarketplaces = Object.values(NA_MARKETPLACE_IDS).join(',');
  console.log(`📦 Fetching orders from ALL NA marketplaces: ${allNAMarketplaces}`);
  console.log(`📦 Using CreatedAfter: ${lastSync.toISOString()} to CreatedBefore: ${twoMinutesAgo.toISOString()}`);
  
  // CRITICAL: Use CreatedAfter instead of LastUpdatedAfter
  // This ensures we catch ALL newly created orders, not just updated ones
  // CRITICAL: Use Ascending sort so oldest orders are fetched first.
  // With Descending + maxOrders cap, the sync marker would jump to the newest
  // order's timestamp, permanently skipping older orders beyond the cap.
  // Ascending ensures the marker advances chronologically without gaps.
  const params = new URLSearchParams({
    MarketplaceIds: allNAMarketplaces,
    CreatedAfter: lastSync.toISOString(),
    CreatedBefore: twoMinutesAgo.toISOString(),
    MaxResultsPerPage: '100',
    SortOrder: 'Ascending',
  });

  const url = `${endpoint}${path}?${params}`;

  let allOrders: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  let lastUpdateInBatch: Date | null = null;
  let failed = false;

  do {
    pageCount++;
    const currentUrl: string = nextToken ? `${endpoint}${path}?NextToken=${encodeURIComponent(nextToken)}` : url;
    
    let attempt = 0;
    let response: Response | null = null;
    
    while (attempt < maxRetries) {
      attempt++;
      const currentHeaders = await signRequest('GET', currentUrl, '', accessToken);
      response = await fetch(currentUrl, { headers: currentHeaders });
      
      if (response.ok) break;
      
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 2000;
        console.warn(`📦 Orders API rate limited (page ${pageCount}), waiting ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      const errorText = await response.text();
      console.error(`Orders API failed: ${response.status}`, errorText);
      break;
    }
    
    if (!response || !response.ok) {
      console.warn(`📦 Orders API failed after ${attempt} attempts, returning ${allOrders.length} orders collected`);
      failed = true;
      break;
    }
    
    const data: any = await response.json();
    const orders = data.payload?.Orders || [];
    
    for (const o of orders) {
      allOrders.push(o);
      
      // DEBUG: Log CA marketplace orders (701-prefix)
      if (o.AmazonOrderId?.startsWith('701-')) {
        const salesChannel = o.SalesChannel || 'Unknown';
        const orderTotal = o.OrderTotal?.Amount || 'N/A';
        const currency = o.OrderTotal?.CurrencyCode || 'N/A';
        console.log(`🍁 CA_ORDER_FOUND: ${o.AmazonOrderId} | Channel=${salesChannel} | Total=${currency} ${orderTotal} | Status=${o.OrderStatus}`);
      }
      
      // Track the most recent LastUpdateDate
      const updated = new Date(o.LastUpdateDate || o.PurchaseDate);
      if (!lastUpdateInBatch || updated > lastUpdateInBatch) {
        lastUpdateInBatch = updated;
      }
      
      if (allOrders.length >= maxOrders) break;
    }
    
    nextToken = data.payload?.NextToken || null;
    
    console.log(`📦 Orders page ${pageCount}: ${orders.length} orders (total: ${allOrders.length})`);
    
    if (allOrders.length >= maxOrders) {
      console.log(`📦 Reached maxOrders limit (${maxOrders}), stopping pagination`);
      break;
    }
    
    if (nextToken) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } while (nextToken);

  console.log(`📦 fetchOrdersIncremental complete: ${allOrders.length} orders, lastUpdate=${lastUpdateInBatch?.toISOString() || 'null'}, failed=${failed}`);
  return { orders: allOrders, lastUpdateInBatch, failed };
}

// Fetch ALL orders for a date range (for historical sync)
// Now fetches from ALL North American marketplaces
async function fetchAllOrdersForDateRange(
  accessToken: string,
  marketplaceId: string, // Primary marketplace (kept for backward compat)
  startDateTime: string,
  endDateTime: string
): Promise<any[]> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = '/orders/v0/orders';
  
  // Query ALL North American marketplaces (comma-separated)
  const allNAMarketplaces = Object.values(NA_MARKETPLACE_IDS).join(',');
  console.log(`📦 fetchAllOrdersForDateRange from ALL NA marketplaces: ${allNAMarketplaces}`);
  
  const params = new URLSearchParams({
    MarketplaceIds: allNAMarketplaces,
    CreatedAfter: startDateTime,
    CreatedBefore: endDateTime,
    MaxResultsPerPage: '100',
    SortOrder: 'Descending',
  });

  let allOrders: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  const maxRetries = 3;

  do {
    pageCount++;
    const currentUrl: string = nextToken 
      ? `${endpoint}${path}?NextToken=${encodeURIComponent(nextToken)}` 
      : `${endpoint}${path}?${params}`;
    
    let attempt = 0;
    let response: Response | null = null;

    while (attempt < maxRetries) {
      attempt++;
      const headers = await signRequest('GET', currentUrl, '', accessToken);
      response = await fetch(currentUrl, { headers });
      
      if (response.ok) break;
      
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 4000;
        console.warn(`📦 Orders API rate limited (page ${pageCount}), waiting ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      const errorText = await response.text();
      console.error(`Orders API error page ${pageCount}: ${response.status}`, errorText);
      break;
    }
    
    if (!response || !response.ok) {
      console.warn(`📦 Orders API failed after ${attempt} attempts, returning ${allOrders.length} orders collected`);
      break;
    }
    
    const data: any = await response.json();
    const orders = data.payload?.Orders || [];
    allOrders = allOrders.concat(orders);
    nextToken = data.payload?.NextToken || null;
    
    console.log(`📦 Page ${pageCount}: ${orders.length} orders (total: ${allOrders.length})`);
    
    if (nextToken) {
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  } while (nextToken);

  console.log(`📦 fetchAllOrdersForDateRange complete: ${allOrders.length} total orders`);
  return allOrders;
}

// Fetch order items.
// Lower concurrency: this is awaited serially by all callers. We surface a
// rate-limit signal via a sentinel property on the returned array so callers
// can re-queue the order instead of marking enrichment complete.
async function fetchOrderItems(accessToken: string, orderId: string, retries = 5): Promise<any[] & { __rateLimited?: boolean }> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = `/orders/v0/orders/${orderId}/orderItems`;
  const url = `${endpoint}${path}`;

  // GLOBAL TOKEN BUCKET for Order Items API (shared across functions).
  const rlClient = getRateLimitClient();
  if (rlClient) {
    await waitForApiToken(rlClient, 'order_items_api', { maxWaitMs: 6000 });
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = await signRequest('GET', url, '', accessToken);
      const response = await fetch(url, { headers });

      if (response.status === 429) {
        console.warn(`fetchOrderItems rate limited for ${orderId}, attempt ${attempt}/${retries}`);
        if (attempt < retries) {
          // Exponential backoff with jitter, capped at 30s.
          await new Promise(resolve => setTimeout(resolve, backoffMs(attempt, 1500, 30_000)));
          continue;
        }
        const out: any = [];
        out.__rateLimited = true;
        return out;
      }

      if (!response.ok) {
        console.warn(`fetchOrderItems failed for ${orderId}: ${response.status}`);
        return [];
      }

      const data = await response.json();
      return mergeOrderItemsByAsin(data.payload?.OrderItems || []);
    } catch (err: any) {
      console.warn(`fetchOrderItems error for ${orderId}:`, err?.message || err);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, backoffMs(attempt, 1000, 15_000)));
        continue;
      }
      return [];
    }
  }
  return [];
}


// Fetch Financial Events (one page)
async function fetchFinancialEventsPage(
  accessToken: string,
  marketplaceId: string,
  startDate: string,
  endDate: string,
  nextToken: string | null
): Promise<{ events: any[]; nextToken: string | null }> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = '/finances/v0/financialEvents';

  const params = new URLSearchParams({
    PostedAfter: startDate,
    PostedBefore: endDate,
  });
  if (nextToken) params.append('NextToken', nextToken);

  const url = `${endpoint}${path}?${params}`;
  const headers = await signRequest('GET', url, '', accessToken);

  let attempt = 0;
  const maxRetries = 3;
  let waitMs = 2000;

  while (true) {
    attempt++;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 429 && attempt < maxRetries) {
        console.warn(`Rate limited, waiting ${waitMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        waitMs *= 2;
        continue;
      }

      if (response.status === 429) {
        throw new Error('SPAPI_QUOTA_EXCEEDED');
      }

      if (response.status === 400) {
        console.error('Financial Events 400 error - returning empty page');
        return { events: [], nextToken: null };
      }

      throw new Error(`Financial Events API failed: ${response.status}`);
    }

    const data = await response.json();
    const payload = data.payload?.FinancialEvents || data.payload || {};

    const events: any[] = [];

    if (payload?.ShipmentEventList) {
      for (const event of payload.ShipmentEventList) {
        events.push({ ...event, _eventType: 'shipment' });
      }
    }

    if (payload?.RefundEventList) {
      for (const event of payload.RefundEventList) {
        events.push({ ...event, _eventType: 'refund' });
      }
    }

    const newNextToken = data.payload?.NextToken || null;
    return { events, nextToken: newNextToken };
  }
}

// Fetch Financial Events (all pages) - kept for compatibility
async function fetchFinancialEvents(
  accessToken: string,
  marketplaceId: string,
  startDate: string,
  endDate: string
): Promise<any[]> {
  let allEvents: any[] = [];
  let nextToken: string | null = null;

  while (true) {
    const page = await fetchFinancialEventsPage(accessToken, marketplaceId, startDate, endDate, nextToken);
    allEvents = allEvents.concat(page.events);
    nextToken = page.nextToken;
    if (!nextToken) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  console.log(`Fetched ${allEvents.length} financial events`);
  return allEvents;
}

// Fetch the REAL Amazon PurchaseDate for one order via GetOrder — basic order
// metadata, returned regardless of order status. Used so a settlement-only
// insert (financial event arrived with no prior Orders API record) gets the
// true purchase date instead of the settlement/posted date.
async function fetchOrderPurchaseDateForSettlement(orderId: string, accessToken: string): Promise<string | null> {
  try {
    const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}`;
    const headers = await signRequest('GET', url, '', accessToken);
    const res = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });
    if (!res.ok) {
      console.warn(`⚠️ SETTLEMENT_PURCHASE_DATE_LOOKUP: ${orderId} failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.payload?.PurchaseDate || null;
  } catch (err) {
    console.warn(`⚠️ SETTLEMENT_PURCHASE_DATE_LOOKUP: ${orderId} exception: ${(err as Error).message}`);
    return null;
  }
}

// Process Financial Event
async function processFinancialEvent(
  supabase: any,
  userId: string,
  event: any,
  accessToken?: string
): Promise<boolean> {
  const eventType = event._eventType || 'shipment';
  const orderId = event.AmazonOrderId;
  const postedDate = event.PostedDate ? getPacificDateString(event.PostedDate) : null;
  
  if (!orderId || !postedDate) {
    console.log('EVENTS_DEBUG_SKIP', { reason: 'missing_id_or_date', orderId, postedDate });
    return false;
  }

  // Handle refunds
  if (eventType === 'refund') {
    await processRefundEvent(supabase, userId, event, postedDate);
    return false;
  }

  const items = event.ShipmentItemList || [];
  if (items.length === 0) {
    console.log('EVENTS_DEBUG_SKIP', { reason: 'no_items', orderId });
    return false;
  }
  
  const CURRENCY_TO_USD = await getLiveCurrencyToUsd(supabase);
  const CURRENCY_TO_MARKETPLACE: Record<string, string> = { 'USD': 'US', 'MXN': 'MX', 'CAD': 'CA', 'BRL': 'BR' };

  // IMPORTANT: Amazon may send multiple ShipmentItems for the same ASIN (one per unit).
  // We must AGGREGATE all items by ASIN before processing to get correct totals.
  interface AggregatedItem {
    asin: string;
    sku: string | null;
    quantity: number;
    totalPrincipal: number;
    shippingCharge: number;
    referralFee: number;
    fbaFee: number;
    closingFee: number;
    currencyCode: string;
    feeCurrency: string;
    asinSource: 'exact' | 'unknown'; // Track if ASIN is valid or SKU stored in ASIN field
  }

  const aggregatedByAsin = new Map<string, AggregatedItem>();

  // Helper to validate ASIN pattern
  const isValidAsinPattern = (val: string): boolean => {
    if (!val || val === 'UNKNOWN' || val === 'PENDING') return false;
    if (val.length !== 10) return false;
    if (/^B0[A-Z0-9]{8}$/.test(val)) return true; // Standard ASIN
    if (/^\d{10}$/.test(val)) return true; // ISBN-style ASIN
    return false;
  };

  for (const item of items) {
    // CRITICAL FIX: Only use item.ASIN if it's a valid ASIN pattern
    // If ASIN is missing or looks like a SKU, set asin to null and store SKU separately
    const rawIdentifier = item.ASIN || '';
    const sellerSku = item.SellerSKU || null;
    const isRealAsin = isValidAsinPattern(rawIdentifier);
    
    // Determine the actual ASIN - only use rawIdentifier if it matches ASIN pattern
    const rawAsin = isRealAsin ? rawIdentifier : (sellerSku || 'UNKNOWN');
    const asinSource = isRealAsin ? 'exact' : 'unknown';
    
    const sku = sellerSku;
    const qty = parseInt(item.QuantityShipped) || 1;
    
    // Log SKU-in-ASIN detection
    if (!isRealAsin && rawIdentifier) {
      console.log(`⚠️ SKU_DETECTED_IN_ASIN: ${orderId} | identifier="${rawIdentifier}" is not valid ASIN pattern, treating as SKU`);
    }
    
    // Extract charges for this item
    let itemPrincipal = 0;
    let itemShipping = 0;
    let itemCurrencyCode = 'USD';
    const itemCharges = item.ItemChargeList || [];
    for (const charge of itemCharges) {
      if (charge.ChargeType === 'Principal') {
        itemPrincipal = parseFloat(charge.ChargeAmount?.CurrencyAmount || '0');
        itemCurrencyCode = charge.ChargeAmount?.CurrencyCode || 'USD';
      } else if (charge.ChargeType === 'Shipping') {
        itemShipping = parseFloat(charge.ChargeAmount?.CurrencyAmount || '0');
      }
    }

    // Extract fees for this item
    let itemReferralFee = 0, itemFbaFee = 0, itemClosingFee = 0;
    let itemFeeCurrency = 'USD';
    const itemFees = item.ItemFeeList || [];
    for (const fee of itemFees) {
      const feeAmount = Math.abs(parseFloat(fee.FeeAmount?.CurrencyAmount || '0'));
      itemFeeCurrency = fee.FeeAmount?.CurrencyCode || 'USD';
      if (fee.FeeType === 'Commission') itemReferralFee = feeAmount;
      else if (fee.FeeType === 'FBAPerUnitFulfillmentFee') itemFbaFee = feeAmount;
      else if (fee.FeeType === 'VariableClosingFee') itemClosingFee = feeAmount;
    }

    // FEC_PROMO_DIAG (Option B, log-only): Extract PromotionList for diagnostic
    // visibility only. NEVER write to sales_orders.promotion_discount* on FEC
    // rows — P&L already consumes financial_events_cache.promotional_rebates,
    // and writing here would double-deduct downstream. See memory:
    // features/sales/promotional-rebate-capture-v1.
    let itemPromoAmount = 0;
    let itemPromoCurrency = 'USD';
    const promoList = item.PromotionList || item.PromotionDiscountList || [];
    for (const promo of promoList) {
      const amt = Math.abs(parseFloat(promo?.PromotionAmount?.CurrencyAmount || promo?.Amount?.CurrencyAmount || '0'));
      if (amt > 0) {
        itemPromoAmount += amt;
        itemPromoCurrency = promo?.PromotionAmount?.CurrencyCode || promo?.Amount?.CurrencyCode || itemPromoCurrency;
      }
    }
    if (itemPromoAmount > 0) {
      console.log(`🎟️ FEC_PROMO_DIAG: order=${orderId} asin=${rawAsin} sku=${sku} qty=${qty} promo=${itemPromoAmount.toFixed(4)} ${itemPromoCurrency} principal=${itemPrincipal.toFixed(4)} ${itemCurrencyCode} (log-only, not written)`);
    }

    // Aggregate into the map by ASIN
    const existing = aggregatedByAsin.get(rawAsin);
    if (existing) {
      existing.quantity += qty;
      existing.totalPrincipal += itemPrincipal;
      existing.shippingCharge += itemShipping;
      existing.referralFee += itemReferralFee;
      existing.fbaFee += itemFbaFee;
      existing.closingFee += itemClosingFee;
      existing.promoAmount = (existing.promoAmount || 0) + itemPromoAmount;
    } else {
      aggregatedByAsin.set(rawAsin, {
        asin: rawAsin,
        sku,
        quantity: qty,
        totalPrincipal: itemPrincipal,
        shippingCharge: itemShipping,
        referralFee: itemReferralFee,
        fbaFee: itemFbaFee,
        closingFee: itemClosingFee,
        currencyCode: itemCurrencyCode,
        feeCurrency: itemFeeCurrency,
        promoAmount: itemPromoAmount,
        promoCurrency: itemPromoCurrency,
        asinSource, // Track if ASIN is exact or unknown
      });
    }
  }

  // FEC_PROMO_DIAG summary — helps quantify how often promos land on FEC rows
  // across the fleet, so we can decide later whether Option A's four-file
  // consumer surgery is justified. Log-only, no DB writes.
  let orderPromoTotal = 0;
  for (const agg of aggregatedByAsin.values()) orderPromoTotal += (agg.promoAmount || 0);
  if (orderPromoTotal > 0) {
    console.log(`🎟️ FEC_PROMO_DIAG_ORDER: order=${orderId} asinGroups=${aggregatedByAsin.size} totalPromo=${orderPromoTotal.toFixed(4)} (log-only, not written)`);
  }

  console.log(`📦 AGGREGATED: ${orderId} -> ${aggregatedByAsin.size} unique ASINs from ${items.length} items`);

  let wasSettled = false;

  // Process each aggregated ASIN group
  for (const [itemAsin, agg] of aggregatedByAsin) {
    const sku = agg.sku;
    const quantity = agg.quantity;
    const asinSource = agg.asinSource; // 'exact' if valid ASIN, 'unknown' if SKU stored in ASIN
    
    // Use aggregated values (already summed from all items with this ASIN)
    // CONTRACT: total_sale_amount = principal only. Shipping stays in shipping_price.
    let totalPrincipal = agg.totalPrincipal;
    let shippingTotal = agg.shippingCharge || 0;
    if (shippingTotal > 0) {
      console.log(`📦 SHIPPING_CHARGE: ${orderId} | ${itemAsin} | shipping=$${shippingTotal} (kept separate from principal)`);
    }

    let referralFee = agg.referralFee;
    let fbaFee = agg.fbaFee;
    let closingFee = agg.closingFee;
    const currencyCode = agg.currencyCode;
    const feeCurrency = agg.feeCurrency;

    const rate = CURRENCY_TO_USD[currencyCode] || 1;
    if (rate !== 1) {
      totalPrincipal *= rate;
      shippingTotal *= rate;
    }
    
    const feeRate = CURRENCY_TO_USD[feeCurrency] || 1;
    if (feeRate !== 1) {
      referralFee *= feeRate;
      fbaFee *= feeRate;
      closingFee *= feeRate;
    }

    const totalFees = referralFee + fbaFee + closingFee;
    // total_sale_amount = principal only (FEC contract)
    const totalSaleAmount = totalPrincipal;
    // Per-unit sold/shipping prices (principal only on sold_price)
    const soldPrice = quantity > 0 ? totalPrincipal / quantity : totalPrincipal;
    const shippingPerUnit = quantity > 0 ? shippingTotal / quantity : 0;
    
    console.log(`💰 SETTLED: ${orderId} | ${itemAsin} | qty=${quantity} | total=$${totalSaleAmount.toFixed(2)} | fees=$${totalFees.toFixed(2)}`);

    // Look up product data from ONLY created_listings
    // Try SKU first, then ASIN as fallback
    let createdItem: any = null;
    
    // Strategy 1: Look up by SKU
    if (sku) {
      const { data: skuMatch } = await supabase
        .from('created_listings')
        .select('asin, cost, units, amount, title, image_url')
        .eq('user_id', userId)
        .eq('sku', sku)
        .maybeSingle();
      if (skuMatch) createdItem = skuMatch;
    }
    
    // Strategy 2: Look up by ASIN (fallback)
    if (!createdItem && itemAsin) {
      const { data: asinMatch } = await supabase
        .from('created_listings')
        .select('asin, cost, units, amount, title, image_url')
        .eq('user_id', userId)
        .eq('asin', itemAsin)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (asinMatch) createdItem = asinMatch;
    }

    let realAsin = itemAsin;
    let finalAsinSource = asinSource; // Track whether resolved or still unknown
    let unitCost = 0;
    let title = null;
    let imageUrl = null;
    
    // Use ONLY created_listings — Contract A: amount=UNIT, cost=TOTAL.
    if (createdItem) {
      // If we found a match and asinSource was unknown, we've now resolved it
      if (createdItem.asin && (!realAsin || realAsin === sku || asinSource === 'unknown')) {
        realAsin = createdItem.asin;
        finalAsinSource = 'resolved' as any; // We resolved via local lookup
        console.log(`🔄 ASIN_RESOLVED: ${orderId} | ${itemAsin} -> ${realAsin} (from created_listings)`);
      }
      const unit = getListingUnitCost(createdItem);
      if (unit !== null && unit > 0) {
        unitCost = unit;
        console.log(`💰 UNIT_COST_FOUND: ${realAsin} -> cost=${createdItem.cost}, amount=${createdItem.amount}, units=${createdItem.units}, unit_cost=${unitCost.toFixed(2)}`);
      }
      title = createdItem.title;
      imageUrl = createdItem.image_url;
    }

    if (!realAsin) realAsin = sku || '';

    const totalCost = unitCost * quantity;
    const netProfit = totalSaleAmount - totalFees - totalCost;
    const roi = unitCost > 0 ? (netProfit / totalCost) * 100 : 0;
    // Determine marketplace from currency, with order ID prefix fallback
    let marketplace = CURRENCY_TO_MARKETPLACE[currencyCode] || 'US';
    // Order ID prefix 701- = Canada (when currency might not indicate correctly for cross-border FBA)
    if (orderId.startsWith('701-') && marketplace === 'US') {
      marketplace = 'CA';
      console.log(`🍁 MARKETPLACE_FIX_SETTLEMENT: ${orderId} -> CA (from order ID prefix, charge currency was ${currencyCode})`);
    }

    // ==============================================================
    // CRITICAL FIX: SKU-First Matching for Settlement Data
    // ==============================================================
    // Financial Events often provides SKU instead of ASIN.
    // We must match by SKU first to merge with existing "Pending" orders
    // and preserve the original ASIN from the Orders API.
    
    let existing = null;
    let matchType = 'none';
    let preservedAsin = null; // Store original ASIN from matched record
    
    // Strategy 1: Match by order_id + sku (PRIMARY for settlement - most reliable)
    // This is critical because Financial Events usually only has SKU, not ASIN
    if (sku) {
      const { data: skuMatch } = await supabase
        .from('sales_orders')
        .select('id, status, asin, seller_sku, order_date')
        .eq('user_id', userId)
        .eq('order_id', orderId)
        .eq('seller_sku', sku)
        .maybeSingle();
      if (skuMatch) {
        existing = skuMatch;
        matchType = 'sku_match';
        // CRITICAL: Preserve the original ASIN from Orders API if it's valid
        if (skuMatch.asin && skuMatch.asin !== 'PENDING' && skuMatch.asin !== 'UNKNOWN') {
          preservedAsin = skuMatch.asin;
          console.log(`🔐 ASIN_PRESERVED: ${orderId} | Keeping original ASIN ${skuMatch.asin} from Orders API, settlement had SKU ${sku}`);
        }
      }
    }
    
    // Strategy 2: Exact match by order_id + asin (when settlement has valid ASIN)
    if (!existing && asinSource === 'exact') {
      const { data: exactMatch } = await supabase
        .from('sales_orders')
        .select('id, status, asin, seller_sku, order_date')
        .eq('user_id', userId)
        .eq('order_id', orderId)
        .eq('asin', realAsin)
        .maybeSingle();
      
      if (exactMatch) {
        existing = exactMatch;
        matchType = 'exact_asin';
      }
    }
    
    // Strategy 3: Match pending orders (asin = 'PENDING')
    if (!existing) {
      const { data: pendingMatch } = await supabase
        .from('sales_orders')
        .select('id, status, asin, seller_sku, order_date')
        .eq('user_id', userId)
        .eq('order_id', orderId)
        .eq('asin', 'PENDING')
        .maybeSingle();
      if (pendingMatch) {
        existing = pendingMatch;
        matchType = 'pending_asin';
      }
    }
    
    // Strategy 4: Match any order with same order_id (only if single result - use first())
    if (!existing) {
      const { data: orderMatches } = await supabase
        .from('sales_orders')
        .select('id, status, asin, seller_sku, order_date')
        .eq('user_id', userId)
        .eq('order_id', orderId)
        .limit(1);
      if (orderMatches && orderMatches.length > 0) {
        existing = orderMatches[0];
        matchType = 'order_id_only';
        // Preserve original ASIN if valid
        if (existing.asin && existing.asin !== 'PENDING' && existing.asin !== 'UNKNOWN') {
          preservedAsin = existing.asin;
        }
      }
    }
    
    // Determine final ASIN to use:
    // 1. Preserved ASIN from existing record (from Orders API - most reliable)
    // 2. Real ASIN from settlement (if it's a valid pattern)
    // 3. Resolved ASIN from created_listings lookup
    // 4. NEVER use SKU as ASIN - leave as null/unknown instead
    let finalAsin = preservedAsin || (asinSource === 'exact' ? realAsin : null);
    
    // If we still don't have an ASIN, try created_listings resolved value (but NOT a raw SKU)
    if (!finalAsin && createdItem?.asin && createdItem.asin !== sku) {
      finalAsin = createdItem.asin;
      finalAsinSource = 'resolved' as any;
    }
    
    // Fallback: if still no ASIN, use the realAsin but mark source as unknown
    if (!finalAsin) {
      finalAsin = realAsin;
      if (asinSource !== 'exact') {
        finalAsinSource = 'unknown';
      }
    }

    // SAFETY NET: finalAsin must never equal the raw SKU. This is the exact
    // gap that let SKU "GNC-AK0-7ZU5" end up in the asin column for order
    // 113-4056832-6171438 (asin_source stuck at 'unknown') even though our
    // own created_listings/inventory already had the correct ASIN
    // (B0G15SJPW9) mapped to that SKU — realAsin gets set to the raw sku a
    // few lines above this block when nothing else resolved it, and this
    // fallback then accepted it without the same "!== sku" check Strategy 3
    // above already applies. One more direct lookup before giving up; if it
    // still can't resolve, use 'UNKNOWN' (never the raw SKU) so the UI never
    // shows a SKU where an ASIN belongs.
    if (finalAsin && sku && finalAsin === sku) {
      let recovered: string | null = null;
      const { data: recoverCl } = await supabase
        .from('created_listings')
        .select('asin')
        .eq('user_id', userId)
        .eq('sku', sku)
        .maybeSingle();
      if (recoverCl?.asin && isValidAsinPattern(recoverCl.asin)) recovered = recoverCl.asin;
      if (!recovered) {
        const { data: recoverInv } = await supabase
          .from('inventory')
          .select('asin')
          .eq('user_id', userId)
          .eq('sku', sku)
          .maybeSingle();
        if (recoverInv?.asin && isValidAsinPattern(recoverInv.asin)) recovered = recoverInv.asin;
      }
      if (recovered) {
        console.log(`🔄 ASIN_RECOVERED_FROM_SKU_CONTAMINATION: ${orderId} | sku=${sku} -> asin=${recovered}`);
        finalAsin = recovered;
        finalAsinSource = 'resolved' as any;
      } else {
        console.warn(`⚠️ ASIN_SKU_CONTAMINATION_UNRESOLVED: ${orderId} | sku=${sku} had no ASIN mapping anywhere — using UNKNOWN instead of SKU`);
        finalAsin = 'UNKNOWN';
        finalAsinSource = 'unknown';
      }
    }
    
    // DIAGNOSTIC: Log the settlement process
    console.log('EVENTS_DEBUG_PROCESS', {
      amazonOrderId: orderId,
      eventType,
      settlementAsin: itemAsin,
      resolvedAsin: finalAsin,
      matchType,
      preservedOriginalAsin: !!preservedAsin,
      beforeStatus: existing?.status || 'no_existing_record',
      afterStatus: 'settled',
      existingAsin: existing?.asin,
      willUpdate: !!existing,
      willInsert: !existing
    });
    
    if (existing) {
      // Settle the pending order - DO NOT change order_date
      // ALWAYS update to settled even if already settled (to fix fee data)
      // CRITICAL: Use finalAsin (preserves Orders API ASIN), NOT raw settlement identifier
      // CRITICAL: Set price_source to 'financial_events' - this is the final authoritative price
      console.log(`✅ Settling order: ${orderId} | ASIN: ${finalAsin} (original: ${existing.asin}) | matchType: ${matchType} | price_source=financial_events`);
      
      // Build update object - only update ASIN if we have a valid one and existing is PENDING/UNKNOWN
      const updateData: Record<string, any> = {
        seller_sku: sku, // Always update seller_sku
        title: title || undefined, // Only update if we have new data
        image_url: imageUrl || undefined,
        quantity,
        sold_price: soldPrice,
        item_price: soldPrice,
        shipping_price: shippingPerUnit,
        total_sale_amount: totalSaleAmount,
        referral_fee: referralFee,
        fba_fee: fbaFee,
        closing_fee: closingFee,
        total_fees: totalFees,
        unit_cost: unitCost > 0 ? unitCost : undefined, // Only update if we found cost
        total_cost: unitCost > 0 ? totalCost : undefined,
        roi: unitCost > 0 ? roi : undefined, // Only update ROI if we have cost
        marketplace,
        status: 'settled',
        price_source: 'financial_events', // Final authoritative price from Financial Events API
        price_confidence: 'CONFIRMED',
        price_enrich_status: 'enriched',
        needs_price_enrich: false,
        price_last_error: null,
        fees_source: 'financial_events',
        asin_source: finalAsinSource, // Track ASIN validity: 'exact', 'resolved', or 'unknown'
        updated_at: new Date().toISOString(),
      };
      
      // CRITICAL: Only update ASIN if existing one is invalid/placeholder
      // This preserves the correct ASIN from Orders API
      const existingAsinIsInvalid = !existing.asin || existing.asin === 'PENDING' || existing.asin === 'UNKNOWN';
      if (existingAsinIsInvalid && finalAsin && finalAsin !== 'UNKNOWN') {
        updateData.asin = finalAsin;
        console.log(`🔄 ASIN_UPDATE: ${orderId} | ${existing.asin} -> ${finalAsin}`);
      } else if (!existingAsinIsInvalid) {
        console.log(`🔐 ASIN_KEPT: ${orderId} | Keeping existing ASIN ${existing.asin} (settlement had: ${itemAsin})`);
      }
      
      // Remove undefined values
      Object.keys(updateData).forEach(key => {
        if (updateData[key] === undefined) delete updateData[key];
      });
      
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update(updateData)
        .eq('id', existing.id);
      
      if (updateError) {
        console.error('EVENTS_DEBUG_UPDATE_ERROR', { orderId, error: updateError.message });
      }
      wasSettled = true;
      // Update daily rollup (use existing order_date, not postedDate, to stay consistent)
      const rollupDate = existing.order_date || postedDate;
      await upsertDailyRollup(supabase, userId, finalAsin, rollupDate, marketplace, sku);
    } else {
      // Insert new settled order (edge case: settlement arrived before order)
      // CRITICAL: Use finalAsin, not raw SKU-as-ASIN from settlement
      
      // DUPLICATE PREVENTION: Before inserting, do a final broad check for any existing row
      // with this order_id. The earlier strategies may have missed if the existing row's ASIN
      // doesn't match (e.g., Orders API stored B005SRS8TK but FEC has seller SKU 1066863685).
      // If we find an existing row with matching quantity + similar price, UPDATE it instead.
      const { data: broadMatch } = await supabase
        .from('sales_orders')
        .select('id, asin, quantity, sold_price, order_date')
        .eq('user_id', userId)
        .eq('order_id', orderId)
        .not('order_id', 'like', '%-REFUND');
      
      // EXACT ASIN FIRST. The unique index is (user_id, order_id, asin), so a row
      // with the same ASIN IS the row we are about to collide with -- match it
      // before applying any heuristic.
      //
      // The fuzzy test below (same quantity, price within $2) exists to catch
      // rows whose ASIN differs between sources, and it is still needed. But it
      // was the ONLY test, so a row with a MATCHING ASIN whose quantity or price
      // had since moved by $2+ was judged "not a match", fell through to INSERT,
      // and collided with the very row broadMatch had just returned.
      //
      // That was not merely log noise. The insert carries the settled payload --
      // settlement_date, financial-events fees, price_source, and
      // price_confidence CONFIRMED -- and its failure is swallowed as
      // EVENTS_DEBUG_INSERT_ERROR while wasSettled is set to true regardless. So
      // the order kept its older ESTIMATED fees and was marked settled anyway.
      // Financial events are the authoritative fee source, so those orders were
      // silently excluded from the P&L's best data.
      //
      // Observed 2026-08-21: duplicate-key errors every 2-3 seconds through a
      // sync window, on real ASINs (e.g. B001DKV5H8), not placeholders.
      const matchingExisting =
        (broadMatch || []).find((row: any) => row.asin && row.asin === finalAsin) ??
        (broadMatch || []).find((row: any) => {
          if (row.asin === 'PENDING' || row.asin === 'UNKNOWN') return true; // always safe to update placeholders
          return row.quantity === quantity && Math.abs((row.sold_price || 0) - soldPrice) < 2.0;
        });
      
      if (matchingExisting) {
        // Found an existing row that's likely the same item — update instead of creating duplicate
        console.log(`🛡️ DUPE_PREVENTION: Order ${orderId} already exists as ${matchingExisting.asin}, updating instead of inserting duplicate with ${finalAsin}`);
        const updateData: Record<string, any> = {
          seller_sku: sku,
          quantity,
          sold_price: soldPrice,
          item_price: soldPrice,
          shipping_price: shippingPerUnit,
          total_sale_amount: totalSaleAmount,
          referral_fee: referralFee,
          fba_fee: fbaFee,
          closing_fee: closingFee,
          total_fees: totalFees,
          unit_cost: unitCost > 0 ? unitCost : undefined,
          total_cost: unitCost > 0 ? totalCost : undefined,
          roi: unitCost > 0 ? roi : undefined,
          marketplace,
          status: 'settled',
          price_source: 'financial_events',
          price_confidence: 'CONFIRMED',
          price_enrich_status: 'enriched',
          needs_price_enrich: false,
          price_last_error: null,
          fees_source: 'financial_events',
          asin_source: finalAsinSource,
          updated_at: new Date().toISOString(),
        };
        // Only upgrade ASIN if existing one is not a real ASIN and we have one
        const existAsin = matchingExisting.asin || '';
        const existIsReal = /^B0[A-Z0-9]{8}$/i.test(existAsin);
        const newIsReal = /^B0[A-Z0-9]{8}$/i.test(finalAsin || '');
        if (!existIsReal && newIsReal) {
          updateData.asin = finalAsin;
        }
        if (title) updateData.title = title;
        if (imageUrl) updateData.image_url = imageUrl;
        Object.keys(updateData).forEach(k => { if (updateData[k] === undefined) delete updateData[k]; });
        
        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update(updateData)
          .eq('id', matchingExisting.id);
        if (updateErr) {
          console.error('EVENTS_DEBUG_DUPE_PREVENTION_UPDATE_ERROR', { orderId, error: updateErr.message });
        }
        wasSettled = true;
        const rollupDate = matchingExisting.order_date || postedDate;
        await upsertDailyRollup(supabase, userId, finalAsin, rollupDate, marketplace, sku);
      } else {
        // For new inserts (settlement arrived with no prior Orders API record),
        // fetch the REAL purchase date via GetOrder — using postedDate (the
        // settlement date) as order_date shifts the sale to the wrong day.
        // Confirmed live on order 113-4056832-6171438: purchased 2026-07-11,
        // settled 2026-07-23 — without this lookup it permanently showed as a
        // 07-23 sale. Falls back to postedDate only if the lookup fails.
        let resolvedOrderDate = postedDate;
        if (accessToken) {
          const realPurchaseDate = await fetchOrderPurchaseDateForSettlement(orderId, accessToken);
          if (realPurchaseDate) {
            resolvedOrderDate = getPacificDateString(realPurchaseDate);
            console.log(`📅 SETTLEMENT_PURCHASE_DATE_RESOLVED: ${orderId} settlement=${postedDate} -> real purchase=${resolvedOrderDate}`);
          }
        }
        console.log(`📝 Inserting settled order: ${orderId} / ${finalAsin} | asinSource: ${finalAsinSource} | price_source=financial_events | order_date=${resolvedOrderDate}`);
        const { error: insertError } = await supabase.from('sales_orders').insert({
          user_id: userId,
          order_id: orderId,
          asin: finalAsin,
          seller_sku: sku,
          title,
          image_url: imageUrl,
          quantity,
          sold_price: soldPrice,
          item_price: soldPrice,
          shipping_price: shippingPerUnit,
          total_sale_amount: totalSaleAmount,
          referral_fee: referralFee,
          fba_fee: fbaFee,
          closing_fee: closingFee,
          total_fees: totalFees,
          unit_cost: unitCost > 0 ? unitCost : null,
          total_cost: unitCost > 0 ? totalCost : null,
          roi: unitCost > 0 ? roi : null,
          order_date: resolvedOrderDate,
          settlement_date: postedDate,
          marketplace,
          status: 'settled',
          price_source: 'financial_events',
          price_confidence: 'CONFIRMED',
          price_enrich_status: 'enriched',
          needs_price_enrich: false,
          price_last_error: null,
          fees_source: 'financial_events',
          asin_source: finalAsinSource,
        });
        
        if (insertError) {
          console.error('EVENTS_DEBUG_INSERT_ERROR', { orderId, error: insertError.message });
        }
        wasSettled = true;
        await upsertDailyRollup(supabase, userId, finalAsin, postedDate, marketplace, sku);
      }
    }
  }

  return wasSettled;
}

// Process Refund Event - SET refund values (not add)
// FIXED: Now creates standalone refund records when original order doesn't exist
async function processRefundEvent(
  supabase: any,
  userId: string,
  event: any,
  postedDate: string
): Promise<void> {
  const orderId = event.AmazonOrderId;
  const refundItems = event.ShipmentItemAdjustmentList || [];
  
  if (!orderId || refundItems.length === 0) return;

  // Original order is used only for enrichment. Refund accounting must live on
  // standalone -REFUND rows so Live Sales / RefundsSection can display it.
  const { data: existingOrder } = await supabase
    .from('sales_orders')
    .select('id, asin, title, image_url, refund_amount, refund_quantity')
    .eq('user_id', userId)
    .eq('order_id', orderId)
    .maybeSingle();

  // PR-A: track keys written in THIS call so multi-item refunds still aggregate
  // within one pass, but never accumulate on top of a prior-pass DB value.
  const writtenThisCall = new Set<string>();

  // Calculate refund totals per item
  for (let itemIdx = 0; itemIdx < refundItems.length; itemIdx++) {
    const item = refundItems[itemIdx];
    const qty = parseInt(item.QuantityShipped || item.QuantityReturned || item.Quantity || '1', 10);
    
    const itemRefundAmount = calculateSellerCentralRefundAmount(item);
    
    // Validate ASIN pattern - only use if it's a real ASIN
    const rawAsinValue = item.ASIN || '';
    const isValidAsinPattern = (val: string): boolean => {
      if (!val || val === 'UNKNOWN') return false;
      if (val.length !== 10) return false;
      if (/^B0[A-Z0-9]{8}$/.test(val)) return true;
      if (/^\d{10}$/.test(val)) return true;
      return false;
    };
    
    const asin = isValidAsinPattern(rawAsinValue) ? rawAsinValue : (existingOrder?.asin || 'UNKNOWN');
    const asinSource = isValidAsinPattern(rawAsinValue) ? 'exact' : 'unknown';
    const sellerSku = item.SellerSKU || '';

    // PERMANENT PREVENTION: single canonical row per (order,asin,event_date).
    const refundOrderId = `${orderId}-REFUND`;
    const eventDate = (postedDate || new Date().toISOString()).split('T')[0];
    const fecRefundKey = `refund:${orderId}|${asin || 'UNKNOWN'}|${eventDate}`;

    // Existence check via idempotency key (aggregate multi-item into same row)
    const { data: existingRefund } = await supabase
      .from('sales_orders')
      .select('id, refund_amount, refund_quantity')
      .eq('user_id', userId)
      .eq('fec_refund_key', fecRefundKey)
      .maybeSingle();

    if (existingRefund) {
      const alreadyWrittenThisCall = writtenThisCall.has(fecRefundKey);
      const aggAmount = alreadyWrittenThisCall
        ? Number(existingRefund.refund_amount || 0) + itemRefundAmount
        : itemRefundAmount;
      const aggQty = alreadyWrittenThisCall
        ? Number(existingRefund.refund_quantity || 0) + qty
        : qty;
      await supabase
        .from('sales_orders')
        .update({
          refund_quantity: aggQty,
          refund_amount: aggAmount,
          sold_price: -aggAmount,
          total_sale_amount: -aggAmount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingRefund.id);
      writtenThisCall.add(fecRefundKey);
      console.log(`💸 Standalone refund ${alreadyWrittenThisCall ? 'AGG' : 'RESET'} ${fecRefundKey}: -> $${aggAmount.toFixed(2)}`);
      await clearLegacyRefundMarkerFromSaleRow(supabase, userId, orderId);
      continue;
    }

      // Try to get title/image from local tables
      let title: string | null = null;
      let imageUrl: string | null = null;

      if (sellerSku) {
        const { data: skuLookup } = await supabase
          .from('created_listings')
          .select('title, image_url')
          .eq('user_id', userId)
          .eq('sku', sellerSku)
          .maybeSingle();
        if (skuLookup) {
          title = skuLookup.title;
          imageUrl = skuLookup.image_url;
        }
      }

      if ((!title || !imageUrl) && asin !== 'UNKNOWN') {
        const { data: invLookup } = await supabase
          .from('inventory')
          .select('title, image_url')
          .eq('user_id', userId)
          .eq('asin', asin)
          .maybeSingle();
        if (invLookup) {
          title = title || invLookup.title;
          imageUrl = imageUrl || invLookup.image_url;
        }
      }

      const { error: upsertError } = await supabase
        .from('sales_orders')
        .upsert({
          user_id: userId,
          order_id: refundOrderId,
          asin: asin,
          sku: sellerSku || null,
          title: title ? `[REFUND] ${title}` : '[REFUND]',
          image_url: imageUrl,
          quantity: qty,
          sold_price: -itemRefundAmount,
          total_sale_amount: -itemRefundAmount,
          referral_fee: 0,
          fba_fee: 0,
          closing_fee: 0,
          total_fees: 0,
          refund_quantity: qty,
          refund_amount: itemRefundAmount,
          order_date: postedDate,
          status: 'refund',
          asin_source: asinSource,
          fec_refund_key: fecRefundKey,
        }, { onConflict: 'user_id,order_id,asin' });

      if (!upsertError) {
        console.log(`💸 Created standalone refund ${fecRefundKey}: asin=${asin}, qty=${qty}, amount=$${itemRefundAmount.toFixed(2)}`);
        writtenThisCall.add(fecRefundKey);
        await clearLegacyRefundMarkerFromSaleRow(supabase, userId, orderId);
      } else {
        console.error(`💸 Failed to upsert standalone refund ${fecRefundKey}:`, upsertError.message);
      }
  }
}

// Fetch Financial Events specifically for refunds (last N days)
async function fetchFinancialEventsForRefunds(
  accessToken: string,
  marketplaceId: string,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = '/finances/v0/financialEvents';
  
  let allRefunds: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  const maxPages = 10; // Limit pages to avoid timeout

  do {
    pageCount++;
    const params = new URLSearchParams({
      PostedAfter: startDate,
      PostedBefore: endDate,
      MaxResultsPerPage: '100',
    });
    if (nextToken) params.append('NextToken', nextToken);

    const url = `${endpoint}${path}?${params}`;
    const headers = await signRequest('GET', url, '', accessToken);

    let attempt = 0;
    const maxRetries = 3;
    let waitMs = 2000;

    while (true) {
      attempt++;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        if (response.status === 429 && attempt < maxRetries) {
          console.warn(`💸 Refund fetch rate limited, waiting ${waitMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          waitMs *= 2;
          continue;
        }
        if (response.status === 400 || response.status === 429) {
          console.error(`💸 Refund fetch error: ${response.status}`);
          return allRefunds;
        }
        throw new Error(`Financial Events API failed: ${response.status}`);
      }

      const data = await response.json();
      const payload = data.payload?.FinancialEvents || data.payload || {};

      // Only collect RefundEventList
      if (payload?.RefundEventList && Array.isArray(payload.RefundEventList)) {
        console.log(`💸 Page ${pageCount}: Found ${payload.RefundEventList.length} refunds`);
        allRefunds.push(...payload.RefundEventList);
      }

      nextToken = data.payload?.NextToken || null;
      break;
    }

    if (nextToken) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (nextToken && pageCount < maxPages);

  console.log(`💸 fetchFinancialEventsForRefunds complete: ${allRefunds.length} total refunds`);
  return allRefunds;
}

// Apply a refund event to an order (returns count of records created/updated)
// FIXED: Create ONE record per refund item to match fetch-profit-loss behavior
// This ensures order like 112-7024050-1590604 with 3 refund items creates 3 records
async function applyRefundToOrder(
  supabase: any,
  userId: string,
  event: any,
  accessToken?: string
): Promise<number> {
  const orderId = event.AmazonOrderId;
  
  // CRITICAL: Use ShipmentItemAdjustmentList for refunds (matching fetch-profit-loss)
  const refundItems = event.ShipmentItemAdjustmentList || [];
  
  if (!orderId || refundItems.length === 0) {
    console.log(`💸 REFUND_SKIP: No refund items for ${orderId}`);
    return 0;
  }

  // ASIN validation helper
  const isValidAsin = (val: string | undefined | null): boolean => {
    if (!val || val === 'UNKNOWN') return false;
    if (val.length !== 10) return false;
    if (/^B0[A-Z0-9]{8}$/.test(val)) return true;
    if (/^\d{10}$/.test(val)) return true;
    return false;
  };

  // Get date in PT from event
  const postedDate = event.PostedDate || new Date().toISOString();
  const ptDate = new Date(postedDate).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles' }).split(',')[0];

  let recordsCreated = 0;
  // PR-A: track keys we've already written in THIS call so multi-item refunds
  // still aggregate within a single sync pass, but the same key never
  // accumulates on top of an already-correct DB value across sync passes.
  const writtenThisCall = new Set<string>();

  // Process EACH refund item separately (matching fetch-profit-loss behavior)
  for (let itemIdx = 0; itemIdx < refundItems.length; itemIdx++) {
    const item = refundItems[itemIdx];
    
    // PERMANENT PREVENTION: canonical order_id + fec_refund_key idempotency
    const refundOrderId = `${orderId}-REFUND`;
    // (fecRefundKey depends on resolved ASIN; assigned after ASIN resolution below)
    
    // Calculate refund amount for THIS item only
    const qty = parseInt(item.QuantityReturned || item.QuantityShipped || item.Quantity || '1', 10);
    
    // Currency conversion rates to USD (same as fetch-live-refunds)
    const convertToUSD = (amount: number, currency: string): number => {
      const rates: Record<string, number> = {
        'USD': 1,
        'CAD': 0.73,
        'MXN': 0.05,
        'BRL': 0.17,
        'GBP': 1.27,
        'EUR': 1.08,
      };
      return amount * (rates[currency] || 1);
    };
    
    const itemRefundAmount = calculateSellerCentralRefundAmount(item, convertToUSD);

    // (fec_refund_key existence check is deferred until after ASIN resolution below)
    
    // Get ASIN - first try from the item directly
    let asin = item.ASIN || 'UNKNOWN';
    let title: string | null = null;
    let imageUrl: string | null = null;
    const sellerSku = item.SellerSKU || '';
    
    console.log(`💸 REFUND_ITEM[${itemIdx}]: ${orderId} -> rawAsin="${asin}", sku="${sellerSku}", amount=$${itemRefundAmount.toFixed(2)}`);
    
    // If ASIN invalid, try Orders API
    if (!isValidAsin(asin) && accessToken) {
      console.log(`💸 REFUND_ORDERS_API_LOOKUP: ${orderId} - getting ASIN from Orders API`);
      try {
        const orderItems = await fetchOrderItemsForRefund(accessToken, orderId);
        if (orderItems && orderItems.length > 0) {
          // Match by SKU if possible, otherwise use first item
          const matchedItem = orderItems.find((oi: any) => oi.SellerSKU === sellerSku) || orderItems[0];
          if (matchedItem?.ASIN && isValidAsin(matchedItem.ASIN)) {
            asin = matchedItem.ASIN;
            title = matchedItem.Title || null;
            console.log(`💸 REFUND_ASIN_FROM_ORDERS_API: ${orderId} -> ${asin}`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`💸 REFUND_ORDERS_API_ERROR: ${orderId}`, err);
      }
    }
    
    // Fallback: Try SKU lookup in local tables
    if (!isValidAsin(asin) && sellerSku) {
      const { data: skuLookup } = await supabase
        .from('created_listings')
        .select('asin, title, image_url')
        .eq('user_id', userId)
        .eq('sku', sellerSku)
        .maybeSingle();
      
      if (skuLookup && isValidAsin(skuLookup.asin)) {
        asin = skuLookup.asin;
        title = skuLookup.title;
        imageUrl = skuLookup.image_url;
      } else {
        const { data: invLookup } = await supabase
          .from('inventory')
          .select('asin, title, image_url')
          .eq('user_id', userId)
          .eq('sku', sellerSku)
          .maybeSingle();
        
        if (invLookup && isValidAsin(invLookup.asin)) {
          asin = invLookup.asin;
          title = invLookup.title;
          imageUrl = invLookup.image_url;
        }
      }
    }
    
    // Get title/image from local tables if we have ASIN but missing data
    if (isValidAsin(asin) && (!title || !imageUrl)) {
      const { data: listingData } = await supabase
        .from('created_listings')
        .select('title, image_url')
        .eq('user_id', userId)
        .eq('asin', asin)
        .maybeSingle();
      
      if (listingData) {
        if (!title) title = listingData.title;
        if (!imageUrl) imageUrl = listingData.image_url;
      } else {
        const { data: invData } = await supabase
          .from('inventory')
          .select('title, image_url')
          .eq('user_id', userId)
          .eq('asin', asin)
          .maybeSingle();
        if (invData) {
          if (!title) title = invData.title;
          if (!imageUrl) imageUrl = invData.image_url;
        }
      }
    }
    
    // Idempotency: check by fec_refund_key. If a row for the same
    // (order, asin, event_date) exists, aggregate into it (sum) instead of
    // creating a new suffixed row.
    const fecRefundKey = `refund:${orderId}|${asin || 'UNKNOWN'}|${ptDate}`;
    const { data: existingByKey } = await supabase
      .from('sales_orders')
      .select('id, refund_amount, refund_quantity')
      .eq('user_id', userId)
      .eq('fec_refund_key', fecRefundKey)
      .maybeSingle();

    if (existingByKey) {
      // PR-A: first write in THIS call replaces stale DB value; subsequent
      // items on the same key within this call aggregate on top.
      const alreadyWrittenThisCall = writtenThisCall.has(fecRefundKey);
      const aggAmount = alreadyWrittenThisCall
        ? Number(existingByKey.refund_amount || 0) + itemRefundAmount
        : itemRefundAmount;
      const aggQty = alreadyWrittenThisCall
        ? Number(existingByKey.refund_quantity || 0) + qty
        : qty;
      await supabase
        .from('sales_orders')
        .update({
          refund_quantity: aggQty,
          refund_amount: aggAmount,
          sold_price: -aggAmount,
          total_sale_amount: -aggAmount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingByKey.id);
      writtenThisCall.add(fecRefundKey);
      console.log(`💸 REFUND_${alreadyWrittenThisCall ? 'AGG' : 'RESET'} ${fecRefundKey}: -> $${aggAmount.toFixed(2)}`);
      await clearLegacyRefundMarkerFromSaleRow(supabase, userId, orderId);
      recordsCreated++;
      continue;
    }

    const { error: upsertError } = await supabase
      .from('sales_orders')
      .upsert({
        user_id: userId,
        order_id: refundOrderId,
        asin: asin,
        title: title ? `[REFUND] ${title}` : '[REFUND]',
        image_url: imageUrl,
        quantity: qty,
        sold_price: -itemRefundAmount,
        total_sale_amount: -itemRefundAmount,
        referral_fee: 0,
        fba_fee: 0,
        closing_fee: 0,
        total_fees: 0,
        refund_quantity: qty,
        refund_amount: itemRefundAmount,
        order_date: ptDate,
        status: 'pending',
        fec_refund_key: fecRefundKey,
      }, { onConflict: 'user_id,order_id,asin' });

    if (!upsertError) {
      console.log(`💸 Upserted refund record ${fecRefundKey}: asin=${asin}, amount=$${itemRefundAmount.toFixed(2)}`);
      writtenThisCall.add(fecRefundKey);
      await clearLegacyRefundMarkerFromSaleRow(supabase, userId, orderId);
      recordsCreated++;
    } else {
      console.error(`💸 Failed to upsert refund record ${fecRefundKey}:`, upsertError.message);
    }
  }

  return recordsCreated;
}

// ================================================================
// REFRESH ALL UNIT COSTS - Helper function for auto-sync
// Updates all sales orders from created_listings (no API calls)
// ================================================================
async function refreshAllUnitCosts(supabase: any, userId: string): Promise<void> {
  console.log(`💰 AUTO_REFRESH_UNIT_COSTS: Starting for user ${userId}`);
  
  try {
    // Fetch ALL sales orders for this user
    const { data: allOrders, error: fetchErr } = await supabase
      .from('sales_orders')
      .select('id, order_id, asin, unit_cost, quantity, sold_price, total_fees')
      .eq('user_id', userId);
    
    if (fetchErr || !allOrders || allOrders.length === 0) {
      console.log(`💰 AUTO_REFRESH_UNIT_COSTS: No orders to refresh`);
      return;
    }
    
    console.log(`💰 AUTO_REFRESH_UNIT_COSTS: Found ${allOrders.length} total orders`);
    
    // Get all unique ASINs
    const uniqueAsins = [...new Set(allOrders.map((o: any) => o.asin).filter(Boolean))];
    
    if (uniqueAsins.length === 0) {
      console.log(`💰 AUTO_REFRESH_UNIT_COSTS: No ASINs to process`);
      return;
    }
    
    // Fetch from created_listings table — Contract A fields.
    const { data: listingsData } = await supabase
      .from('created_listings')
      .select('asin, cost, units, amount')
      .eq('user_id', userId)
      .in('asin', uniqueAsins);
    
    // Build lookup map (preserves all 3 fields so the helper can decide).
    const listMap = new Map<string, { cost: number | null; units: number | null; amount: number | null }>();
    listingsData?.forEach((item: any) => {
      if (item.asin) {
        listMap.set(item.asin, { cost: item.cost, units: item.units, amount: item.amount });
      }
    });
    
    console.log(`💰 AUTO_REFRESH_UNIT_COSTS: Found ${listMap.size} ASINs with cost data`);
    
    let fixedCount = 0;
    
    for (const order of allOrders) {
      if (!order.asin) continue;
      
      // Contract A: derive UNIT cost via shared helper. NEVER read listing.cost raw.
      const listing = listMap.get(order.asin);
      if (!listing) continue;
      const unit = getListingUnitCost(listing);
      if (unit === null || unit <= 0) continue;
      
      const correctUnitCost = Math.round(unit * 100) / 100;
      
      // Skip if already correct
      if (order.unit_cost && Math.abs(correctUnitCost - order.unit_cost) < 0.01) {
        continue;
      }
      
      // Skip unreasonable costs
      if (correctUnitCost > 500) continue;
      
      // Calculate new ROI
      const qty = order.quantity || 1;
      const totalCost = correctUnitCost * qty;
      const soldPrice = order.sold_price || 0;
      const totalFees = Math.abs(order.total_fees || 0);
      const totalSale = soldPrice * qty;
      const netProfit = totalSale - totalFees - totalCost;
      const newRoi = totalCost > 0 ? Math.round((netProfit / totalCost) * 1000) / 10 : 0;
      
      await supabase
        .from('sales_orders')
        .update({
          unit_cost: correctUnitCost,
          total_cost: totalCost,
          roi: newRoi,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);
      
      fixedCount++;
    }
    
    console.log(`💰 AUTO_REFRESH_UNIT_COSTS: Fixed ${fixedCount} orders`);
  } catch (err) {
    console.error('AUTO_REFRESH_UNIT_COSTS error:', err);
  }
}

// ================================================================
// DETECT EARLY REFUNDS VIA ORDERS API - Check for returns before Financial Events reports them
// This catches refunds faster by checking order item return status
// ================================================================
async function detectEarlyRefundsViaOrdersApi(
  supabase: any,
  userId: string,
  accessToken: string,
  marketplaceId: string,
  maxOrders: number = 20
): Promise<number> {
  console.log(`🔍 EARLY_REFUND_DETECTION: Starting for user ${userId}`);
  
  try {
    // Fetch recent orders from last 14 days that are already shipped (potential refund candidates)
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    
    const endpoint = 'https://sellingpartnerapi-na.amazon.com';
    const path = '/orders/v0/orders';
    
    const params = new URLSearchParams({
      MarketplaceIds: marketplaceId,
      CreatedAfter: fourteenDaysAgo.toISOString(),
      CreatedBefore: twoMinutesAgo.toISOString(),
      MaxResultsPerPage: '50',
      OrderStatuses: 'Shipped,Unshipped,PartiallyShipped,Canceled', // Include Canceled for potential refunds
      SortOrder: 'Descending',
    });
    
    const url = `${endpoint}${path}?${params}`;
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      console.warn(`🔍 EARLY_REFUND_DETECTION: Orders API failed: ${response.status}`);
      return 0;
    }
    
    const data = await response.json();
    const orders = data.payload?.Orders || [];
    
    console.log(`🔍 EARLY_REFUND_DETECTION: Found ${orders.length} recent orders to check`);
    
    let earlyRefundsCreated = 0;
    let ordersChecked = 0;
    
    let cancelledOrdersZeroed = 0;
    
    for (const order of orders.slice(0, maxOrders)) {
      const orderId = order.AmazonOrderId;
      if (!orderId) continue;
      
      ordersChecked++;
      
      // CRITICAL: Check if order is cancelled and zero it out in our database
      if (order.OrderStatus === 'Canceled') {
        const { data: existingOrder } = await supabase
          .from('sales_orders')
          .select('id, asin, sold_price, status')
          .eq('user_id', userId)
          .eq('order_id', orderId)
          .maybeSingle();
        
        // If order exists and is NOT already zeroed, zero it out
        if (existingOrder && existingOrder.status !== 'cancelled' && existingOrder.sold_price > 0) {
          console.log(`🚫 CANCELLATION_DETECTED: ${orderId} | ASIN=${existingOrder.asin} | was $${existingOrder.sold_price} -> ZEROING OUT`);
          
          const { error: cancelError } = await supabase
            .from('sales_orders')
            .update({
              sold_price: 0,
              total_sale_amount: 0,
              referral_fee: 0,
              fba_fee: 0,
              closing_fee: 0,
              total_fees: 0,
              total_cost: 0,
              roi: 0,
              order_status: 'Canceled',
              status: 'cancelled',
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingOrder.id);
          
          if (!cancelError) {
            cancelledOrdersZeroed++;
            console.log(`🚫 CANCELLATION_ZEROED: ${orderId} | Successfully zeroed out`);
          } else {
            console.error(`🚫 CANCELLATION_UPDATE_ERROR: ${orderId}`, cancelError.message);
          }
        }
        continue; // Skip to next order - cancelled orders don't need refund records
      }
      
      // Check if refund record already exists for this order
      const refundOrderId = `${orderId}-REFUND`;
      const { data: existingRefund } = await supabase
        .from('sales_orders')
        .select('id')
        .eq('user_id', userId)
        .eq('order_id', refundOrderId)
        .maybeSingle();
      
      if (existingRefund) {
        continue; // Refund already recorded
      }
      
      // Fetch order items to check for returns/refunds
      await new Promise(resolve => setTimeout(resolve, 300)); // Rate limiting
      const orderItems = await fetchOrderItems(accessToken, orderId);

      if ((orderItems as any)?.__rateLimited === true) {
        console.warn(`⏳ requeued_order_items_rate_limited: REFUND_SCAN ${orderId} - skipping; will retry next scan`);
        HealthSignals.orderItemsRateLimited(userId, 'sync-sales-orders', orderId);
        continue;
      }
      if (!orderItems || orderItems.length === 0) {
        console.log(`💰 requeued_order_items_no_price: REFUND_SCAN ${orderId} - no items returned; will retry next scan`);
        HealthSignals.enrichmentRequeued(userId, 'sync-sales-orders', 'no_price', orderId);
        continue;
      }
      
      // Check each item for return/refund indicators
      for (const item of orderItems) {
        const quantityOrdered = parseInt(item.QuantityOrdered || '0', 10);
        const quantityShipped = parseInt(item.QuantityShipped || '0', 10);
        
        // Check if item has been returned
        // Amazon Orders API provides "IsGift", "ConditionId", and sometimes return info
        // The most reliable indicator is checking if there's a mismatch or if order is Canceled
        // For now, we check Canceled orders to create early refund records
        
        if (order.OrderStatus === 'Canceled' && quantityOrdered > 0) {
          const asin = item.ASIN || item.SellerSKU || 'UNKNOWN';
          const title = item.Title || null;
          let imageUrl = null;
          
          // Look up image from local tables
          if (asin !== 'UNKNOWN') {
            const { data: listingData } = await supabase
              .from('created_listings')
              .select('image_url, title')
              .eq('user_id', userId)
              .eq('asin', asin)
              .maybeSingle();
            
            if (listingData?.image_url) {
              imageUrl = listingData.image_url;
            }
            
            // Also check inventory
            if (!imageUrl) {
              const { data: invData } = await supabase
                .from('inventory')
                .select('image_url')
                .eq('user_id', userId)
                .eq('asin', asin)
                .maybeSingle();
              if (invData?.image_url) {
                imageUrl = invData.image_url;
              }
            }
          }
          
          // Get the item price (for refund amount estimate)
          let refundAmount = 0;
          if (item.ItemPrice?.Amount) {
            refundAmount = parseFloat(item.ItemPrice.Amount) || 0;
          }
          
          // Get PT date from order date
          const orderDate = order.PurchaseDate ? getPacificDateString(order.PurchaseDate) : getPacificDateString(new Date().toISOString());
          
          // Create early refund record
          const { error: insertError } = await supabase
            .from('sales_orders')
            .insert({
              user_id: userId,
              order_id: refundOrderId,
              asin: asin,
              title: title ? `[REFUND] ${title}` : `[REFUND] ${asin}`,
              image_url: imageUrl,
              quantity: quantityOrdered,
              sold_price: -refundAmount,
              total_sale_amount: -refundAmount,
              referral_fee: 0,
              fba_fee: 0,
              closing_fee: 0,
              total_fees: 0,
              refund_quantity: quantityOrdered,
              refund_amount: refundAmount,
              order_date: orderDate,
              status: 'pending',
              order_status: 'Canceled',
            });
          
          if (!insertError) {
            earlyRefundsCreated++;
            console.log(`🔍 EARLY_REFUND: Created refund record for canceled order ${orderId}: asin=${asin}, amount=$${refundAmount.toFixed(2)}`);
          }
          
          break; // One refund record per order
        }
      }
    }
    
    console.log(`🔍 EARLY_REFUND_DETECTION: Complete - checked ${ordersChecked} orders, zeroed ${cancelledOrdersZeroed} cancelled orders, created ${earlyRefundsCreated} early refund records`);
    return earlyRefundsCreated + cancelledOrdersZeroed;
    
  } catch (err: any) {
    console.error('🔍 EARLY_REFUND_DETECTION error:', err?.message || err);
    return 0;
  }
}

// AWS SigV4 Signing
async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url);
  const host = urlObj.host;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';
  
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  
  const payloadHash = await sha256(body || '');
  const canonicalRequest = `${method}\n${urlObj.pathname}\n${urlObj.search.slice(1)}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;
  
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);
  
  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
    'Authorization': authorizationHeader,
    'Content-Type': 'application/json',
  };
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer as any);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const result = await hmac(key, message);
  return Array.from(new Uint8Array(result)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + key), dateStamp);
  const kRegion = await hmac(kDate, regionName);
  const kService = await hmac(kRegion, serviceName);
  return await hmac(kService, 'aws4_request');
}

// Fetch order items from Orders API to get ASIN for refunds
// Amazon Financial Events API doesn't always include ASIN, but Orders API always does
async function fetchOrderItemsForRefund(accessToken: string, orderId: string): Promise<any[] | null> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = 'us-east-1';
  const service = 'execute-api';
  const host = 'sellingpartnerapi-na.amazon.com';
  const endpoint = `/orders/v0/orders/${orderId}/orderItems`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalQuerystring = '';
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const payloadHash = await sha256('');
  const canonicalRequest = `GET\n${endpoint}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;

  const signingKey = await getSignatureKey(awsSecretAccessKey!, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const response = await fetch(`https://${host}${endpoint}`, {
      method: 'GET',
      headers: {
        'host': host,
        'x-amz-access-token': accessToken,
        'x-amz-date': amzDate,
        'Authorization': authorizationHeader,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`💸 Orders API error for refund ${orderId}: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    return data.payload?.OrderItems || null;
  } catch (error) {
    console.error(`💸 Error fetching order items for refund ${orderId}:`, error);
    return null;
  }
}
