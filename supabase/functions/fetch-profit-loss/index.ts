import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authHeader,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;

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
    const error = await response.text();
    console.error('LWA token error:', error);
    throw new Error('Failed to get LWA access token');
  }

  const data = await response.json();
  return data.access_token;
}

// Currency conversion rates to USD
// Loaded from fx_rates table at runtime; falls back to hardcoded if DB lookup fails
const FALLBACK_RATES: Record<string, number> = {
  'USD': 1,
  'CAD': 0.73,
  'MXN': 0.05,
  'BRL': 0.17,
  'GBP': 1.27,
  'EUR': 1.08,
};

let liveFxRates: Record<string, number> | null = null;
let fxSource: 'fx_rates_table' | 'hardcoded_fallback' = 'hardcoded_fallback';
let fxLoadedAt: string | null = null;
let fxCurrenciesConverted = new Set<string>();

async function loadFxRates(supabase: any): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('fx_rates')
      .select('quote, rate, as_of')
      .eq('base', 'USD');

    if (error || !data || data.length === 0) {
      console.warn('[FX] Failed to load fx_rates, using hardcoded fallback:', error?.message);
      liveFxRates = null;
      fxSource = 'hardcoded_fallback';
      return;
    }

    liveFxRates = { 'USD': 1 };
    let latestAsOf: string | null = null;

    for (const row of data) {
      if (row.quote && row.rate) {
        // fx_rates stores USD->quote rate, so to convert quote->USD we divide
        liveFxRates[row.quote] = Number(row.rate);
        if (!latestAsOf || row.as_of > latestAsOf) {
          latestAsOf = row.as_of;
        }
      }
    }

    fxSource = 'fx_rates_table';
    fxLoadedAt = latestAsOf;
    console.log(`[FX] Loaded ${data.length} rates from fx_rates table (as_of: ${latestAsOf})`);
  } catch (err: any) {
    console.warn('[FX] Exception loading fx_rates:', err?.message);
    liveFxRates = null;
    fxSource = 'hardcoded_fallback';
  }
}

function convertToUSD(amount: number, currency: string): number {
  if (currency === 'USD') return amount;
  
  fxCurrenciesConverted.add(currency);

  // Try live rates first (these are USD->currency, so divide)
  if (liveFxRates && liveFxRates[currency]) {
    return amount / liveFxRates[currency];
  }

  // Fallback to hardcoded (these are multipliers, currency->USD)
  return amount * (FALLBACK_RATES[currency] || 1);
}

function getFxMetadata(): { source: string; loadedAt: string | null; currenciesConverted: string[]; method: string } {
  return {
    source: fxSource,
    loadedAt: fxLoadedAt,
    currenciesConverted: Array.from(fxCurrenciesConverted),
    method: liveFxRates ? 'divide by USD->quote rate' : 'multiply by hardcoded factor',
  };
}

interface RefundRecord {
  orderId: string;
  postedDate: string;
  amount: number;
  asin?: string;
}

interface FinancialSummary {
  sales: number;
  refunds: number;
  reimbursements: number;
  shippingCredits: number;
  shippingCreditRefunds: number;
  giftWrapCredits: number;
  giftWrapCreditRefunds: number;
  promotionalRebates: number;
  promotionalRebateRefunds: number;
  otherIncome: number;
  liquidations: number;
  totalIncome: number;
  referralFees: number;
  fbaFees: number;
  variableClosingFees: number;
  fixedClosingFees: number;
  fbaInboundFees: number;
  fbaStorageFees: number;
  fbaRemovalFees: number;
  fbaDisposalFees: number;
  fbaLongTermStorageFees: number;
  fbaCustomerReturnFees: number;
  otherFees: number;
  totalExpenses: number;
  salesTaxCollected: number;
  marketplaceFacilitatorTax: number;
  salesTaxRefunds: number;
  marketplaceFacilitatorTaxRefunds: number;
  totalTax: number;
  refundRecords: RefundRecord[];
  // Granular fee/income categories (Phase 1+5)
  compensatedClawback: number;
  hrrNonApparel: number;
  digitalServicesFee: number;
  warehouseLost: number;
  warehouseDamage: number;
  reversalReimbursement: number;
  freeReplacementRefundItems: number;
  fbaInboundConvenienceFee: number;
  liquidationsBrokerageFee: number;
  reCommerceGradingCharge: number;
  // FX metadata (Phase 2)
  fxMetadata?: { source: string; loadedAt: string | null; currenciesConverted: string[]; method: string };
}

function initSummary(): FinancialSummary {
  return {
    sales: 0,
    refunds: 0,
    reimbursements: 0,
    shippingCredits: 0,
    shippingCreditRefunds: 0,
    giftWrapCredits: 0,
    giftWrapCreditRefunds: 0,
    promotionalRebates: 0,
    promotionalRebateRefunds: 0,
    otherIncome: 0,
    liquidations: 0,
    totalIncome: 0,
    referralFees: 0,
    fbaFees: 0,
    variableClosingFees: 0,
    fixedClosingFees: 0,
    fbaInboundFees: 0,
    fbaStorageFees: 0,
    fbaRemovalFees: 0,
    fbaDisposalFees: 0,
    fbaLongTermStorageFees: 0,
    fbaCustomerReturnFees: 0,
    otherFees: 0,
    totalExpenses: 0,
    salesTaxCollected: 0,
    marketplaceFacilitatorTax: 0,
    salesTaxRefunds: 0,
    marketplaceFacilitatorTaxRefunds: 0,
    totalTax: 0,
    refundRecords: [],
    // Granular
    compensatedClawback: 0,
    hrrNonApparel: 0,
    digitalServicesFee: 0,
    warehouseLost: 0,
    warehouseDamage: 0,
    reversalReimbursement: 0,
    freeReplacementRefundItems: 0,
    fbaInboundConvenienceFee: 0,
    liquidationsBrokerageFee: 0,
    reCommerceGradingCharge: 0,
  };
}

// Legacy: aggregate cached events by reading every row. Retained as a safety fallback
// when the pl_month_summary path fails. Do not call from hot paths.
async function aggregateFromCacheLegacy(
  supabase: any,
  userId: string,
  startDate: string,
  endDate: string
): Promise<FinancialSummary> {
  const summary = initSummary();

  // IMPORTANT: Supabase has a default 1000-row limit. We must paginate.
  const PAGE_SIZE = 1000;
  let from = 0;

  const selectCols = [
    'event_type',
    'event_date',
    'amazon_order_id',
    'asin',
    'sales',
    'refunds',
    'shipping_credits',
    'shipping_credit_refunds',
    'gift_wrap_credits',
    'gift_wrap_credit_refunds',
    'promotional_rebates',
    'promotional_rebate_refunds',
    'other_income',
    'reimbursements',
    'liquidations',
    'referral_fees',
    'fba_fees',
    'variable_closing_fees',
    'fixed_closing_fees',
    'fba_inbound_fees',
    'fba_storage_fees',
    'fba_removal_fees',
    'fba_disposal_fees',
    'fba_long_term_storage_fees',
    'fba_customer_return_fees',
    'other_fees',
    'sales_tax_collected',
    'marketplace_facilitator_tax',
    'sales_tax_refunds',
    'marketplace_facilitator_tax_refunds',
    'compensated_clawback',
    'hrr_non_apparel',
    'digital_services_fee',
    'warehouse_lost',
    'warehouse_damage',
    'reversal_reimbursement',
    'free_replacement_refund_items',
    'fba_inbound_convenience_fee',
    'liquidations_brokerage_fee',
    're_commerce_grading_charge',
    'shipping_chargeback',
    'shipping_chargeback_refund',
  ].join(',');

  while (true) {
    const { data: eventsPage, error } = await supabase
      .from('financial_events_cache')
      .select(selectCols)
      .eq('user_id', userId)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('Error fetching cached events:', error);
      throw error;
    }

    const events = eventsPage || [];

    for (const event of events) {
      summary.sales += Number(event.sales) || 0;
      summary.refunds += Number(event.refunds) || 0;
      summary.shippingCredits += Number(event.shipping_credits) || 0;
      summary.shippingCreditRefunds += Number(event.shipping_credit_refunds) || 0;
      summary.giftWrapCredits += Number(event.gift_wrap_credits) || 0;
      summary.giftWrapCreditRefunds += Number(event.gift_wrap_credit_refunds) || 0;
      summary.promotionalRebates += Number(event.promotional_rebates) || 0;
      summary.promotionalRebateRefunds += Number(event.promotional_rebate_refunds) || 0;
      summary.otherIncome += Number(event.other_income) || 0;
      summary.reimbursements +=
        (Number(event.reimbursements) || 0)
        + Math.abs(Number(event.reversal_reimbursement) || 0)
        + Math.abs(Number(event.free_replacement_refund_items) || 0);
      summary.liquidations += Number(event.liquidations) || 0;

      summary.referralFees += Number(event.referral_fees) || 0;
      summary.fbaFees += Number(event.fba_fees) || 0;
      summary.variableClosingFees += Number(event.variable_closing_fees) || 0;
      summary.fixedClosingFees += Number(event.fixed_closing_fees) || 0;
      summary.fbaInboundFees += Number(event.fba_inbound_fees) || 0;
      summary.fbaStorageFees += Number(event.fba_storage_fees) || 0;
      summary.fbaRemovalFees += Number(event.fba_removal_fees) || 0;
      summary.fbaDisposalFees += Number(event.fba_disposal_fees) || 0;
      summary.fbaLongTermStorageFees += Number(event.fba_long_term_storage_fees) || 0;
      summary.fbaCustomerReturnFees += Number(event.fba_customer_return_fees) || 0;
      summary.otherFees += Number(event.other_fees) || 0;

      summary.salesTaxCollected += Number(event.sales_tax_collected) || 0;
      summary.marketplaceFacilitatorTax += Number(event.marketplace_facilitator_tax) || 0;
      summary.salesTaxRefunds += Number(event.sales_tax_refunds) || 0;
      summary.marketplaceFacilitatorTaxRefunds += Number(event.marketplace_facilitator_tax_refunds) || 0;

      summary.compensatedClawback += Number(event.compensated_clawback) || 0;
      summary.hrrNonApparel += Number(event.hrr_non_apparel) || 0;
      summary.digitalServicesFee += Number(event.digital_services_fee) || 0;
      summary.warehouseLost += Number(event.warehouse_lost) || 0;
      summary.warehouseDamage += Number(event.warehouse_damage) || 0;
      summary.reversalReimbursement += Number(event.reversal_reimbursement) || 0;
      summary.freeReplacementRefundItems += Number(event.free_replacement_refund_items) || 0;
      summary.fbaInboundConvenienceFee += Number(event.fba_inbound_convenience_fee) || 0;
      summary.liquidationsBrokerageFee += Number(event.liquidations_brokerage_fee) || 0;
      summary.reCommerceGradingCharge += Number(event.re_commerce_grading_charge) || 0;

      if (event.event_type === 'refund' && (Number(event.refunds) || 0) > 0) {
        summary.refundRecords.push({
          orderId: event.amazon_order_id || 'Unknown',
          postedDate: event.event_date,
          amount: Number(event.refunds) || 0,
          asin: event.asin,
        });
      }
    }

    if (events.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  finalizeTotals(summary);
  return summary;
}

function finalizeTotals(summary: FinancialSummary): void {
  summary.totalIncome =
    summary.sales -
    summary.refunds +
    summary.reimbursements +
    summary.shippingCredits -
    summary.shippingCreditRefunds +
    summary.giftWrapCredits -
    summary.giftWrapCreditRefunds -
    summary.promotionalRebates +
    summary.promotionalRebateRefunds +
    summary.otherIncome +
    summary.liquidations;

  summary.totalExpenses =
    summary.referralFees +
    summary.fbaFees +
    summary.variableClosingFees +
    summary.fixedClosingFees +
    summary.fbaInboundFees +
    summary.fbaStorageFees +
    summary.fbaRemovalFees +
    summary.fbaDisposalFees +
    summary.fbaLongTermStorageFees +
    summary.fbaCustomerReturnFees +
    summary.otherFees;

  summary.totalTax =
    summary.salesTaxCollected -
    summary.marketplaceFacilitatorTax -
    summary.salesTaxRefunds +
    summary.marketplaceFacilitatorTaxRefunds;
}

// Enumerate first-of-month date strings covering [startDate, endDate] (inclusive).
// startDate/endDate are 'YYYY-MM-DD' strings.
function enumerateMonthKeys(startDate: string, endDate: string): string[] {
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  const out: string[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Aggregate cached events into summary. FAST PATH now reads pre-aggregated month rows
// from pl_month_summary. Falls back to per-row scan if the summary path fails.
async function aggregateFromCache(
  supabase: any,
  userId: string,
  startDate: string,
  endDate: string
): Promise<FinancialSummary> {
  console.log(`[pl_month_summary] enter aggregateFromCache v2 user=${userId} range=${startDate}..${endDate}`);
  const summaryPathStart = Date.now();
  try {
    const monthKeys = enumerateMonthKeys(startDate, endDate);
    if (monthKeys.length === 0) {
      return initSummary();
    }

    // Read existing summary rows for the requested months
    const { data: rows, error: readErr } = await supabase
      .from('pl_month_summary')
      .select('*')
      .eq('user_id', userId)
      .in('month_key', monthKeys);

    if (readErr) throw readErr;

    const rowsByMonth = new Map<string, any>();
    for (const r of rows || []) {
      // month_key comes back as 'YYYY-MM-DD' string
      rowsByMonth.set(String(r.month_key).slice(0, 10), r);
    }

    // Determine which months need a live recompute:
    //   - missing row
    //   - stale_at IS NOT NULL (trigger marked as dirty since last recompute)
    //   - month contains today or the future (current month always recomputes)
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentMonthKey = `${todayStr.slice(0, 7)}-01`;

    const toRecompute: string[] = [];
    for (const mk of monthKeys) {
      const row = rowsByMonth.get(mk);
      if (!row) { toRecompute.push(mk); continue; }
      if (row.stale_at) { toRecompute.push(mk); continue; }
      if (mk === currentMonthKey) { toRecompute.push(mk); continue; }
    }

    let recomputeMs = 0;
    if (toRecompute.length > 0) {
      const recStart = Date.now();
      // Recompute serially to keep DB load bounded; each call is a single grouped aggregate.
      for (const mk of toRecompute) {
        const { error: rpcErr } = await supabase.rpc('recompute_pl_month_summary', {
          p_user_id: userId,
          p_month_key: mk,
          p_source: 'reader_lazy',
        });
        if (rpcErr) throw rpcErr;
      }
      recomputeMs = Date.now() - recStart;

      // Re-read the recomputed rows
      const { data: fresh, error: reReadErr } = await supabase
        .from('pl_month_summary')
        .select('*')
        .eq('user_id', userId)
        .in('month_key', toRecompute);
      if (reReadErr) throw reReadErr;
      for (const r of fresh || []) {
        rowsByMonth.set(String(r.month_key).slice(0, 10), r);
      }
    }

    // Sum month rows into summary
    const summary = initSummary();
    for (const mk of monthKeys) {
      const r = rowsByMonth.get(mk);
      if (!r) continue; // month with no events at all — nothing to add
      summary.sales += Number(r.sales) || 0;
      summary.refunds += Number(r.refunds) || 0;
      summary.shippingCredits += Number(r.shipping_credits) || 0;
      summary.shippingCreditRefunds += Number(r.shipping_credit_refunds) || 0;
      summary.giftWrapCredits += Number(r.gift_wrap_credits) || 0;
      summary.giftWrapCreditRefunds += Number(r.gift_wrap_credit_refunds) || 0;
      summary.promotionalRebates += Number(r.promotional_rebates) || 0;
      summary.promotionalRebateRefunds += Number(r.promotional_rebate_refunds) || 0;
      summary.otherIncome += Number(r.other_income) || 0;
      // Aggregated reimbursements mirrors legacy: raw + |reversal| + |free_replacement|
      summary.reimbursements +=
        (Number(r.reimbursements_raw) || 0)
        + Math.abs(Number(r.reversal_reimbursement) || 0)
        + Math.abs(Number(r.free_replacement_refund_items) || 0);
      summary.liquidations += Number(r.liquidations) || 0;

      summary.referralFees += Number(r.referral_fees) || 0;
      summary.fbaFees += Number(r.fba_fees) || 0;
      summary.variableClosingFees += Number(r.variable_closing_fees) || 0;
      summary.fixedClosingFees += Number(r.fixed_closing_fees) || 0;
      summary.fbaInboundFees += Number(r.fba_inbound_fees) || 0;
      summary.fbaStorageFees += Number(r.fba_storage_fees) || 0;
      summary.fbaRemovalFees += Number(r.fba_removal_fees) || 0;
      summary.fbaDisposalFees += Number(r.fba_disposal_fees) || 0;
      summary.fbaLongTermStorageFees += Number(r.fba_long_term_storage_fees) || 0;
      summary.fbaCustomerReturnFees += Number(r.fba_customer_return_fees) || 0;
      summary.otherFees += Number(r.other_fees) || 0;

      summary.salesTaxCollected += Number(r.sales_tax_collected) || 0;
      summary.marketplaceFacilitatorTax += Number(r.marketplace_facilitator_tax) || 0;
      summary.salesTaxRefunds += Number(r.sales_tax_refunds) || 0;
      summary.marketplaceFacilitatorTaxRefunds += Number(r.marketplace_facilitator_tax_refunds) || 0;

      summary.compensatedClawback += Number(r.compensated_clawback) || 0;
      summary.hrrNonApparel += Number(r.hrr_non_apparel) || 0;
      summary.digitalServicesFee += Number(r.digital_services_fee) || 0;
      summary.warehouseLost += Number(r.warehouse_lost) || 0;
      summary.warehouseDamage += Number(r.warehouse_damage) || 0;
      summary.reversalReimbursement += Number(r.reversal_reimbursement) || 0;
      summary.freeReplacementRefundItems += Number(r.free_replacement_refund_items) || 0;
      summary.fbaInboundConvenienceFee += Number(r.fba_inbound_convenience_fee) || 0;
      summary.liquidationsBrokerageFee += Number(r.liquidations_brokerage_fee) || 0;
      summary.reCommerceGradingCharge += Number(r.re_commerce_grading_charge) || 0;
    }

    // Refund records: fetch only refund rows (typically tiny subset)
    const { data: refundRows, error: refundErr } = await supabase
      .from('financial_events_cache')
      .select('amazon_order_id,event_date,refunds,asin')
      .eq('user_id', userId)
      .eq('event_type', 'refund')
      .gt('refunds', 0)
      .gte('event_date', startDate)
      .lte('event_date', endDate);
    if (refundErr) {
      console.warn('[pl_month_summary] refund fetch failed, continuing without records:', refundErr.message);
    } else {
      for (const rr of refundRows || []) {
        summary.refundRecords.push({
          orderId: rr.amazon_order_id || 'Unknown',
          postedDate: rr.event_date,
          amount: Number(rr.refunds) || 0,
          asin: rr.asin,
        });
      }
    }

    finalizeTotals(summary);

    const hits = monthKeys.length - toRecompute.length;
    console.log(
      `[pl_month_summary] months=${monthKeys.length} hits=${hits} misses=${toRecompute.length} recompute_ms=${recomputeMs} total_ms=${Date.now() - summaryPathStart} refund_records=${summary.refundRecords.length}`
    );

    return summary;
  } catch (err) {
    console.error(`[pl_month_summary] path failed after ${Date.now() - summaryPathStart}ms, falling back to legacy per-row scan:`, err);
    return aggregateFromCacheLegacy(supabase, userId, startDate, endDate);
  }
}

interface CacheEntry {
  user_id: string;
  event_type: string;
  event_date: string;
  amazon_order_id: string;
  asin: string;
  marketplace: string;
  marketplace_id: string | null;
  sales: number;
  refunds: number;
  shipping_credits: number;
  shipping_credit_refunds: number;
  gift_wrap_credits: number;
  gift_wrap_credit_refunds: number;
  promotional_rebates: number;
  promotional_rebate_refunds: number;
  other_income: number;
  reimbursements: number;
  liquidations: number;
  referral_fees: number;
  fba_fees: number;
  variable_closing_fees: number;
  fixed_closing_fees: number;
  fba_inbound_fees: number;
  fba_storage_fees: number;
  fba_removal_fees: number;
  fba_disposal_fees: number;
  fba_long_term_storage_fees: number;
  fba_customer_return_fees: number;
  other_fees: number;
  sales_tax_collected: number;
  marketplace_facilitator_tax: number;
  sales_tax_refunds: number;
  marketplace_facilitator_tax_refunds: number;
  // Granular fee columns (Sellerboard-style)
  compensated_clawback: number;
  hrr_non_apparel: number;
  digital_services_fee: number;
  warehouse_lost: number;
  warehouse_damage: number;
  reversal_reimbursement: number;
  free_replacement_refund_items: number;
  fba_inbound_convenience_fee: number;
  liquidations_brokerage_fee: number;
  re_commerce_grading_charge: number;
  shipping_chargeback: number;
  shipping_chargeback_refund: number;
  restocking_fee: number;
  fbm_shipping_label_fee: number;
}

function createCacheEntry(
  userId: string,
  eventType: string,
  eventDate: string,
  orderId?: string,
  asin?: string,
  marketplace?: string,
  marketplaceId?: string
): CacheEntry {
  return {
    user_id: userId,
    event_type: eventType,
    event_date: eventDate,
    amazon_order_id: orderId || '',
    asin: asin || '',
    marketplace: marketplace || 'UNKNOWN',
    marketplace_id: marketplaceId || null,
    sales: 0,
    refunds: 0,
    shipping_credits: 0,
    shipping_credit_refunds: 0,
    gift_wrap_credits: 0,
    gift_wrap_credit_refunds: 0,
    promotional_rebates: 0,
    promotional_rebate_refunds: 0,
    other_income: 0,
    reimbursements: 0,
    liquidations: 0,
    referral_fees: 0,
    fba_fees: 0,
    variable_closing_fees: 0,
    fixed_closing_fees: 0,
    fba_inbound_fees: 0,
    fba_storage_fees: 0,
    fba_removal_fees: 0,
    fba_disposal_fees: 0,
    fba_long_term_storage_fees: 0,
    fba_customer_return_fees: 0,
    other_fees: 0,
    sales_tax_collected: 0,
    marketplace_facilitator_tax: 0,
    sales_tax_refunds: 0,
    marketplace_facilitator_tax_refunds: 0,
    // Granular fee columns
    compensated_clawback: 0,
    hrr_non_apparel: 0,
    digital_services_fee: 0,
    warehouse_lost: 0,
    warehouse_damage: 0,
    reversal_reimbursement: 0,
    free_replacement_refund_items: 0,
    fba_inbound_convenience_fee: 0,
    liquidations_brokerage_fee: 0,
    re_commerce_grading_charge: 0,
    shipping_chargeback: 0,
    shipping_chargeback_refund: 0,
    restocking_fee: 0,
    fbm_shipping_label_fee: 0,
  };
}

function mergeCacheEntries(target: CacheEntry, incoming: CacheEntry) {
  target.sales += incoming.sales;
  target.refunds += incoming.refunds;
  target.shipping_credits += incoming.shipping_credits;
  target.shipping_credit_refunds += incoming.shipping_credit_refunds;
  target.gift_wrap_credits += incoming.gift_wrap_credits;
  target.gift_wrap_credit_refunds += incoming.gift_wrap_credit_refunds;
  target.promotional_rebates += incoming.promotional_rebates;
  target.promotional_rebate_refunds += incoming.promotional_rebate_refunds;
  target.other_income += incoming.other_income;
  target.reimbursements += incoming.reimbursements;
  target.liquidations += incoming.liquidations;
  target.referral_fees += incoming.referral_fees;
  target.fba_fees += incoming.fba_fees;
  target.variable_closing_fees += incoming.variable_closing_fees;
  target.fixed_closing_fees += incoming.fixed_closing_fees;
  target.fba_inbound_fees += incoming.fba_inbound_fees;
  target.fba_storage_fees += incoming.fba_storage_fees;
  target.fba_removal_fees += incoming.fba_removal_fees;
  target.fba_disposal_fees += incoming.fba_disposal_fees;
  target.fba_long_term_storage_fees += incoming.fba_long_term_storage_fees;
  target.fba_customer_return_fees += incoming.fba_customer_return_fees;
  target.other_fees += incoming.other_fees;
  target.sales_tax_collected += incoming.sales_tax_collected;
  target.marketplace_facilitator_tax += incoming.marketplace_facilitator_tax;
  target.sales_tax_refunds += incoming.sales_tax_refunds;
  target.marketplace_facilitator_tax_refunds += incoming.marketplace_facilitator_tax_refunds;
  // Granular fee columns
  target.compensated_clawback += incoming.compensated_clawback;
  target.hrr_non_apparel += incoming.hrr_non_apparel;
  target.digital_services_fee += incoming.digital_services_fee;
  target.warehouse_lost += incoming.warehouse_lost;
  target.warehouse_damage += incoming.warehouse_damage;
  target.reversal_reimbursement += incoming.reversal_reimbursement;
  target.free_replacement_refund_items += incoming.free_replacement_refund_items;
  target.fba_inbound_convenience_fee += incoming.fba_inbound_convenience_fee;
  target.liquidations_brokerage_fee += incoming.liquidations_brokerage_fee;
  target.re_commerce_grading_charge += incoming.re_commerce_grading_charge;
  target.shipping_chargeback += incoming.shipping_chargeback;
  target.shipping_chargeback_refund += incoming.shipping_chargeback_refund;
  target.restocking_fee += incoming.restocking_fee;
  target.fbm_shipping_label_fee += incoming.fbm_shipping_label_fee;
}

function dedupeCacheEntries(entries: CacheEntry[]): CacheEntry[] {
  const map = new Map<string, CacheEntry>();
  for (const e of entries) {
    const key = `${e.user_id}|${e.event_type}|${e.event_date}|${e.amazon_order_id}|${e.asin}`;
    const existing = map.get(key);
    if (existing) {
      mergeCacheEntries(existing, e);
    } else {
      map.set(key, { ...e });
    }
  }
  return Array.from(map.values());
}


function processShipmentEventToCache(event: any, userId: string): CacheEntry[] {
  const entries: CacheEntry[] = [];
  const eventDate = event.PostedDate?.split('T')[0] || new Date().toISOString().split('T')[0];
  
  // Helper to validate ASIN pattern - same logic as sync-sales-orders
  const isValidAsinPattern = (val: string): boolean => {
    if (!val || val === 'UNKNOWN' || val === 'PENDING') return false;
    if (val.length !== 10) return false;
    if (/^B0[A-Z0-9]{8}$/.test(val)) return true; // Standard ASIN
    if (/^\d{10}$/.test(val)) return true; // ISBN-style ASIN
    return false;
  };
  
  for (const item of event.ShipmentItemList || []) {
    // CRITICAL FIX: Use ASIN field if valid, otherwise leave empty (don't use SKU as ASIN)
    // This prevents SKU pollution in the financial_events_cache asin column
    const rawAsin = item.ASIN || '';
    const sellerSku = item.SellerSKU || '';
    const asin = isValidAsinPattern(rawAsin) ? rawAsin : (isValidAsinPattern(sellerSku) ? sellerSku : '');
    
    const entry = createCacheEntry(userId, 'shipment', eventDate, event.AmazonOrderId, asin);
    
    // Process item charges
    for (const charge of item.ItemChargeList || []) {
      const currency = charge.ChargeAmount?.CurrencyCode || 'USD';
      const amount = convertToUSD(parseFloat(charge.ChargeAmount?.CurrencyAmount || 0), currency);
      const chargeType = String(charge.ChargeType || '');

      if (chargeType.toLowerCase().includes('liquidation')) {
        entry.liquidations += amount;
        continue;
      }

      switch (chargeType) {
        case 'Principal':
          entry.sales += amount;
          break;
        case 'ShippingCharge':
          // Positive = customer-paid shipping credit; Negative = Amazon
          // Buy Shipping label charge billed back to the seller for an FBM
          // order. Split them so the label cost is visible on its own line.
          if (amount < 0) {
            entry.fbm_shipping_label_fee += Math.abs(amount);
          } else {
            entry.shipping_credits += amount;
          }
          break;
        case 'GiftWrap':
          entry.gift_wrap_credits += amount;
          break;
        case 'Tax':
          entry.sales_tax_collected += amount;
          break;
        case 'MarketplaceFacilitatorTax-Principal':
        case 'MarketplaceFacilitatorTax-Shipping':
        case 'MarketplaceFacilitatorTax-Giftwrap':
          entry.marketplace_facilitator_tax += amount;
          break;
        default:
          if (chargeType.includes('Tax')) {
            entry.sales_tax_collected += amount;
          } else {
            entry.other_income += amount;
          }
      }
    }

    // Marketplace facilitator tax. Amazon does NOT deliver this in
    // ItemChargeList -- it arrives in its own ItemTaxWithheldList, so the
    // MarketplaceFacilitatorTax-* cases in the switch above have never once
    // matched. Confirmed 2026-08-31: the column read $0.00 for all of 2026
    // while InventoryLab reported $51,308.12 of tax Amazon remitted on the
    // seller's behalf.
    //
    // This is the same failure as fbm_shipping_label_fee earlier the same day:
    // a handler exists, looks correct, and is pointed at a list Amazon never
    // populates. sync-sales-orders already reads ItemTaxWithheldList and even
    // documents it as "Marketplace facilitator tax reversals"; only this
    // parser, the one that feeds the P&L, was missing it.
    //
    // Informational only -- it never touches Net Profit. But "did Amazon remit
    // my sales tax or do I owe it" is exactly the question a tax filing turns
    // on, and $0.00 is the wrong answer to it.
    for (const withheld of item.ItemTaxWithheldList || []) {
      // Canonical shape is nested: TaxWithheldComponent.TaxesWithheld[] holds
      // ChargeType/ChargeAmount. Some payloads flatten to TaxWithheldAmount, so
      // accept both rather than depending on which one this account gets.
      const components = withheld?.TaxesWithheld || (withheld?.TaxWithheldAmount ? [withheld] : []);
      for (const c of components) {
        const money = c?.ChargeAmount || c?.TaxWithheldAmount || c?.Amount;
        const currency = money?.CurrencyCode || 'USD';
        const amount = Math.abs(convertToUSD(parseFloat(money?.CurrencyAmount || 0), currency));
        if (amount === 0) continue;
        // Stored as a positive magnitude, matching sales_tax_collected. The P&L
        // renders it negative (OTHER_ROWS carries negative: true).
        entry.marketplace_facilitator_tax += amount;
      }
    }

    // Process item fees
    for (const fee of item.ItemFeeList || []) {
      const currency = fee.FeeAmount?.CurrencyCode || 'USD';
      const amount = Math.abs(convertToUSD(parseFloat(fee.FeeAmount?.CurrencyAmount || 0), currency));
      
      switch (fee.FeeType) {
        case 'Commission':
        case 'ReferralFee':
          entry.referral_fees += amount;
          break;
        case 'FBAPerUnitFulfillmentFee':
        case 'FBAFee':
        case 'FulfillmentFee':
          entry.fba_fees += amount;
          break;
        case 'VariableClosingFee':
          entry.variable_closing_fees += amount;
          break;
        case 'FixedClosingFee':
          entry.fixed_closing_fees += amount;
          break;
        case 'CompensatedClawback':
          entry.compensated_clawback += amount;
          break;
        case 'HrrNonApparelRollup':
        case 'HighRateReturnProcessingFee':
          entry.hrr_non_apparel += amount;
          break;
        case 'DigitalServicesFee':
          entry.digital_services_fee += amount;
          break;
        case 'ReCommerceGradingCharge':
          entry.re_commerce_grading_charge += amount;
          break;
        case 'ShippingChargeback':
        case 'ShippingChargebackFee':
          // FBM Buy Shipping overage Amazon bills back to the seller.
          entry.shipping_chargeback += amount;
          break;
        default:
          entry.other_fees += amount;
      }
    }

    // Process promotions
    for (const promo of item.PromotionList || []) {
      const currency = promo.PromotionAmount?.CurrencyCode || 'USD';
      const amount = Math.abs(convertToUSD(parseFloat(promo.PromotionAmount?.CurrencyAmount || 0), currency));
      entry.promotional_rebates += amount;
    }

    // Process item charges that indicate free replacements
    for (const charge of item.ItemChargeList || []) {
      const chargeType = String(charge.ChargeType || '');
      if (chargeType === 'FreeReplacementRefundItems') {
        const currency = charge.ChargeAmount?.CurrencyCode || 'USD';
        const amount = Math.abs(convertToUSD(parseFloat(charge.ChargeAmount?.CurrencyAmount || 0), currency));
        entry.free_replacement_refund_items += amount;
      }
    }
    
    entries.push(entry);
  }
  
  return entries;
}

function processRefundEventToCache(event: any, userId: string): CacheEntry[] {
  const entries: CacheEntry[] = [];
  const eventDate = event.PostedDate?.split('T')[0] || new Date().toISOString().split('T')[0];
  
  for (const item of event.ShipmentItemAdjustmentList || []) {
    const entry = createCacheEntry(userId, 'refund', eventDate, event.AmazonOrderId, item.ASIN);
    
    for (const charge of item.ItemChargeAdjustmentList || []) {
      const currency = charge.ChargeAmount?.CurrencyCode || 'USD';
      const amount = Math.abs(convertToUSD(parseFloat(charge.ChargeAmount?.CurrencyAmount || 0), currency));
      
      // Restocking fees come through SP-API as a positive ChargeAmount on refund
      // events (the buyer is charged a restocking penalty, the seller keeps it).
      // Amazon represents them as either an explicit "RestockingFee" ChargeType
      // or — in some marketplaces — as a negative Principal entry with
      // ChargeAdjustmentReason="RestockingFee". Treat both as seller income.
      const rawCharge = parseFloat(charge.ChargeAmount?.CurrencyAmount || 0);
      const isRestocking =
        charge.ChargeType === 'RestockingFee' ||
        (charge.ChargeAdjustmentReason || '').toString().toLowerCase().includes('restocking');

      if (isRestocking) {
        entry.restocking_fee += amount;
        continue;
      }

      switch (charge.ChargeType) {
        case 'Principal':
          entry.refunds += amount;
          break;
        case 'ShippingCharge':
          entry.shipping_credit_refunds += amount;
          break;
        case 'GiftWrap':
          entry.gift_wrap_credit_refunds += amount;
          break;
        case 'Tax':
          entry.sales_tax_refunds += amount;
          break;
        case 'MarketplaceFacilitatorTax-Principal':
        case 'MarketplaceFacilitatorTax-Shipping':
        case 'MarketplaceFacilitatorTax-Giftwrap':
          entry.marketplace_facilitator_tax_refunds += amount;
          break;
        default:
          if (charge.ChargeType?.includes('Tax')) {
            entry.sales_tax_refunds += amount;
          }
      }
      void rawCharge;
    }

    // Facilitator tax reversed back when a customer refunds. Same list, same
    // reason it was missing -- and without it the refund side of the tax
    // picture is as blank as the charge side was.
    for (const withheld of item.ItemTaxWithheldList || []) {
      const components = withheld?.TaxesWithheld || (withheld?.TaxWithheldAmount ? [withheld] : []);
      for (const c of components) {
        const money = c?.ChargeAmount || c?.TaxWithheldAmount || c?.Amount;
        const currency = money?.CurrencyCode || 'USD';
        const amount = Math.abs(convertToUSD(parseFloat(money?.CurrencyAmount || 0), currency));
        if (amount === 0) continue;
        entry.marketplace_facilitator_tax_refunds += amount;
      }
    }

    // Process fee adjustments as a signed Amazon ledger.
    // Positive amounts are fee credits back to the seller; negative amounts
    // are refund commission/admin fees Amazon keeps. Net must match Seller Central.
    for (const fee of item.ItemFeeAdjustmentList || []) {
      const currency = fee.FeeAmount?.CurrencyCode || 'USD';
      const rawAmount = parseFloat(fee.FeeAmount?.CurrencyAmount || 0);
      if (rawAmount !== 0) {
        const amount = convertToUSD(rawAmount, currency);
        switch (fee.FeeType) {
          case 'Commission':
          case 'ReferralFee':
          case 'RefundCommission':
            entry.referral_fees -= amount;
            break;
          case 'FBAPerUnitFulfillmentFee':
          case 'FBAFee':
          case 'FulfillmentFee':
            entry.fba_fees -= amount;
            break;
          case 'ShippingChargeback':
          case 'ShippingChargebackFee':
            // Amazon refunded a previously billed shipping chargeback (separate
            // P&L line so we don't dilute the gross chargeback expense).
            entry.shipping_chargeback_refund += Math.abs(amount);
            break;
          default:
            entry.other_fees -= amount;
        }
      }
    }

    // Process promotional rebate refunds
    for (const promo of item.PromotionAdjustmentList || []) {
      const currency = promo.PromotionAmount?.CurrencyCode || 'USD';
      const amount = Math.abs(convertToUSD(parseFloat(promo.PromotionAmount?.CurrencyAmount || 0), currency));
      entry.promotional_rebate_refunds += amount;
    }
    
    entries.push(entry);
  }
  
  return entries;
}

function getFinancialEventDate(event: any, fallbackDate?: string): string {
  const rawDate = event.PostedDate || event.PostedDateTime || event.EventDate || event.TransactionPostedDate;
  if (!rawDate) return fallbackDate || new Date().toISOString().split('T')[0];
  return String(rawDate).split('T')[0];
}

function isFbmShippingLabelReason(s: string | undefined | null): boolean {
  if (!s) return false;
  const v = String(s).toLowerCase();
  return (
    v.includes('shippingservice') ||
    v.includes('shippinglabel') ||
    v.includes('buyshipping') ||
    v.includes('buy shipping') ||
    v === 'safe-t' ||
    v.includes('safe-t') ||
    v.includes('postage')
  );
}

function processServiceFeeEventToCache(event: any, userId: string, idx: number = 0, fallbackDate?: string): CacheEntry {
  const eventDate = getFinancialEventDate(event, fallbackDate);
  // Service fees (storage, LTS, etc.) often have NO AmazonOrderId. Without a
  // synthetic unique key, multiple service fee events on the same day collapse
  // into one row via the (user_id,event_type,event_date,amazon_order_id,asin)
  // upsert conflict, hiding monthly storage charges.
  const orderBase = event.AmazonOrderId && event.AmazonOrderId.length > 0
    ? event.AmazonOrderId
    : `SVC-${eventDate}-${idx}`;
  const entry = createCacheEntry(userId, 'service_fee', eventDate, orderBase);

  // Event-level FeeReason (e.g. "ShippingServices", "ShippingLabelPurchase",
  // "SAFE-T") — when set, ALL fees in this event are FBM Buy Shipping label
  // costs and must be tracked separately from FBA inbound transportation.
  const eventReasonIsLabel = isFbmShippingLabelReason(event.FeeReason);

  const feeList = event.FeeList || event.FeeComponentList || event.ChargeComponentList || [];

  for (const fee of feeList) {
    const amountObj = fee.FeeAmount || fee.ChargeAmount || fee.Amount || {};
    const currency = amountObj.CurrencyCode || 'USD';
    const amount = Math.abs(convertToUSD(parseFloat(amountObj.CurrencyAmount || 0), currency));
    const feeType = String(fee.FeeType || fee.ChargeType || fee.Type || '');
    const feeTypeLower = feeType.toLowerCase();

    // FBM Buy Shipping label — keep distinct from fba_inbound_fees
    if (eventReasonIsLabel || isFbmShippingLabelReason(feeType)) {
      entry.fbm_shipping_label_fee += amount;
      continue;
    }

    if (feeType.includes('FBAInboundTransportation') || feeTypeLower.includes('transportation')) {
      entry.fba_inbound_fees += amount;
    } else if (feeType.includes('FBAInboundConvenience') || feeType === 'FBAInboundConvenienceFee' || feeTypeLower.includes('convenience')) {
      entry.fba_inbound_convenience_fee += amount;
    } else if (feeType.includes('FBAInbound') || feeTypeLower.includes('inbound')) {
      // Generic inbound fees not covered above
      entry.fba_inbound_fees += amount;
    } else if (feeType.includes('LongTermStorage') || (feeTypeLower.includes('long') && feeTypeLower.includes('storage'))) {
      entry.fba_long_term_storage_fees += amount;
    } else if (feeType.includes('StorageFee') || feeType.includes('Storage') || feeTypeLower.includes('storage')) {
      entry.fba_storage_fees += amount;
    } else if (feeType.includes('Removal') || feeTypeLower.includes('removal')) {
      entry.fba_removal_fees += amount;
    } else if (feeType.includes('Disposal') || feeTypeLower.includes('disposal')) {
      entry.fba_disposal_fees += amount;
    } else if (feeType.includes('FBACustomerReturnPerUnitFee') || feeType.includes('CustomerReturn') || feeTypeLower.includes('customerreturn')) {
      entry.fba_customer_return_fees += amount;
    } else {
      entry.other_fees += amount;
    }
  }

  return entry;
}

async function updateProgress(
  supabase: any, 
  progressId: string, 
  update: {
    current_chunk?: number;
    total_chunks?: number;
    message?: string;
    status?: string;
    summary?: any;
    cogs?: number;
    net_profit?: number;
    error?: string;
  }
) {
  try {
    await supabase
      .from('pl_sync_progress')
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', progressId);
  } catch (e) {
    console.error('Failed to update progress:', e);
  }
}

function isEventDateInMonth(eventDate: string, startDate: Date, endDate: Date): boolean {
  const start = startDate.toISOString().split('T')[0];
  const end = endDate.toISOString().split('T')[0];
  return eventDate >= start && eventDate < end;
}

async function fetchFinancialEventGroupIds(accessToken: string, startDate: Date, endDate: Date, monthLabel: string): Promise<string[]> {
  const groupIds: string[] = [];
  const groupDiagnostics: Array<{ id: string; start?: string; end?: string; status?: string }> = [];
  let nextToken: string | null = null;
  const lookbackStart = new Date(startDate);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 45); // widen lookback to catch settlements posted after month end
  const lookforwardEnd = new Date(endDate);
  lookforwardEnd.setUTCDate(lookforwardEnd.getUTCDate() + 21);

  console.log(`[${monthLabel}] [GROUP_DIAG] Querying FinancialEventGroups: started_after=${lookbackStart.toISOString()} started_before=${lookforwardEnd.toISOString()}`);

  do {
    const params = new URLSearchParams({
      FinancialEventGroupStartedAfter: lookbackStart.toISOString(),
      FinancialEventGroupStartedBefore: lookforwardEnd.toISOString(),
      MaxResultsPerPage: '100',
    });
    if (nextToken) params.set('NextToken', nextToken);

    const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEventGroups?${params.toString()}`;
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { method: 'GET', headers });

    if (response.status === 429) {
      console.log(`[${monthLabel}] [GROUP_DIAG] Event groups rate limited, waiting 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[${monthLabel}] [GROUP_DIAG] Event groups fallback failed: ${response.status} - ${errorText.slice(0, 300)}`);
      break;
    }

    const data = await response.json();
    const list = data.payload?.FinancialEventGroupList || [];
    for (const group of list) {
      if (group.FinancialEventGroupId) {
        groupIds.push(group.FinancialEventGroupId);
        groupDiagnostics.push({
          id: group.FinancialEventGroupId,
          start: group.FinancialEventGroupStart,
          end: group.FinancialEventGroupEnd,
          status: group.ProcessingStatus,
        });
      }
    }
    nextToken = data.payload?.NextToken || null;
    if (nextToken) await new Promise((resolve) => setTimeout(resolve, 600));
  } while (nextToken);

  const unique = [...new Set(groupIds)];
  console.log(`[${monthLabel}] [GROUP_DIAG] Found ${unique.length} unique settlement groups (raw=${groupIds.length}). Sample:`, JSON.stringify(groupDiagnostics.slice(0, 8)));
  return unique;
}

async function fetchFinancialEventsByGroupId(accessToken: string, groupId: string, monthLabel: string): Promise<any[]> {
  const payloads: any[] = [];
  let nextToken: string | null = null;

  do {
    const params = new URLSearchParams({ MaxResultsPerPage: '100' });
    if (nextToken) params.set('NextToken', nextToken);

    const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents/${encodeURIComponent(groupId)}?${params.toString()}`;
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { method: 'GET', headers });

    if (response.status === 429) {
      console.log(`[${monthLabel}] Group ${groupId} rate limited, waiting 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[${monthLabel}] Group ${groupId} events failed: ${response.status} - ${errorText.slice(0, 300)}`);
      break;
    }

    const data = await response.json();
    payloads.push(data.payload?.FinancialEvents || {});
    nextToken = data.payload?.NextToken || null;
    if (nextToken) await new Promise((resolve) => setTimeout(resolve, 600));
  } while (nextToken);

  return payloads;
}

function processSupplementalServiceAndRemovalEvents(
  events: any,
  userId: string,
  startDate: Date,
  endDate: Date,
  seedIdx: number,
  diag?: { groupId?: string; monthLabel?: string }
): { entries: CacheEntry[]; serviceFees: number } {
  const entries: CacheEntry[] = [];
  let serviceFees = 0;
  let svcIdx = seedIdx;

  const sfeList: any[] = events?.ServiceFeeEventList || [];
  const fallbackDate = startDate.toISOString().split('T')[0];
  const feeTypeCounts: Record<string, number> = {};
  let svcInRange = 0;
  let svcOutOfRange = 0;
  const sampleDates: string[] = [];
  for (const event of sfeList) {
    const evDate = getFinancialEventDate(event, fallbackDate);
    if (sampleDates.length < 3) sampleDates.push(evDate || 'unknown');
    for (const fee of event?.FeeList || []) {
      const t = String(fee?.FeeType || 'Unknown');
      feeTypeCounts[t] = (feeTypeCounts[t] || 0) + 1;
    }
    if (!isEventDateInMonth(evDate, startDate, endDate)) {
      svcOutOfRange++;
      continue;
    }
    svcInRange++;
    entries.push(processServiceFeeEventToCache(event, userId, svcIdx++, fallbackDate));
    serviceFees++;
  }

  if (sfeList.length > 0 || diag) {
    console.log(`[${diag?.monthLabel || ''}] [GROUP_DIAG] group=${diag?.groupId || 'n/a'} ServiceFeeEventList: total=${sfeList.length} inserted=${svcInRange} skipped_out_of_range=${svcOutOfRange} fee_types=${JSON.stringify(feeTypeCounts)} sample_dates=${JSON.stringify(sampleDates)} window=[${startDate.toISOString().split('T')[0]}..${endDate.toISOString().split('T')[0]})`);
  }

  let rsIdx = 0;
  for (const event of events?.RemovalShipmentEventList || []) {
    const eventDate = getFinancialEventDate(event);
    if (!isEventDateInMonth(eventDate, startDate, endDate)) continue;
    rsIdx++;
    const txnType = String(event.TransactionType || '').toUpperCase();
    const isLiquidation = txnType.includes('LIQUIDATION');
    const orderBase = String(event.MerchantOrderId || event.OrderId || event.AmazonOrderId || `RSE-GRP-${eventDate}-${rsIdx}`);
    let itemIdx = 0;
    for (const item of event.RemovalShipmentItemList || []) {
      itemIdx++;
      const itemAsin = String(item.FulfillmentNetworkSKU || item.ASIN || item.SellerSKU || `item${itemIdx}`);
      const entry = createCacheEntry(userId, isLiquidation ? 'liquidation' : 'removal', eventDate, `${orderBase}#${itemIdx}`, itemAsin);
      const feeCurrency = item.FeeAmount?.CurrencyCode || 'USD';
      const feeAmount = Math.abs(convertToUSD(parseFloat(item.FeeAmount?.CurrencyAmount || 0), feeCurrency));
      if (isLiquidation) {
        const revCurrency = item.Revenue?.CurrencyCode || 'USD';
        entry.liquidations += convertToUSD(parseFloat(item.Revenue?.CurrencyAmount || 0), revCurrency);
        entry.liquidations_brokerage_fee += feeAmount;
      } else {
        entry.fba_removal_fees += feeAmount;
      }
      entries.push(entry);
    }
  }

  let rsaIdx = 0;
  for (const event of events?.RemovalShipmentAdjustmentEventList || []) {
    const eventDate = getFinancialEventDate(event);
    if (!isEventDateInMonth(eventDate, startDate, endDate)) continue;
    rsaIdx++;
    const txnType = String(event.TransactionType || '').toUpperCase();
    const isLiquidation = txnType.includes('LIQUIDATION');
    const orderBase = String(event.MerchantOrderId || event.OrderId || event.AmazonOrderId || `RSAE-GRP-${eventDate}-${rsaIdx}`);
    let itemIdx = 0;
    for (const item of event.RemovalShipmentItemAdjustmentList || []) {
      itemIdx++;
      const itemAsin = String(item.FulfillmentNetworkSKU || item.ASIN || item.SellerSKU || `item${itemIdx}`);
      const entry = createCacheEntry(userId, isLiquidation ? 'liquidation' : 'removal', eventDate, `${orderBase}#${itemIdx}`, itemAsin);
      const revCurrency = item.RevenueAdjustment?.CurrencyCode || item.RevenueAmount?.CurrencyCode || 'USD';
      const feeCurrency = item.FeeAdjustment?.CurrencyCode || item.FeeAmount?.CurrencyCode || 'USD';
      const revenueAdj = convertToUSD(parseFloat(item.RevenueAdjustment?.CurrencyAmount ?? item.RevenueAmount?.CurrencyAmount ?? 0), revCurrency);
      const feeAdj = convertToUSD(parseFloat(item.FeeAdjustment?.CurrencyAmount ?? item.FeeAmount?.CurrencyAmount ?? 0), feeCurrency);
      if (isLiquidation) {
        entry.liquidations += revenueAdj;
        entry.liquidations_brokerage_fee += Math.abs(feeAdj);
      } else {
        entry.fba_removal_fees += Math.abs(feeAdj);
      }
      entries.push(entry);
    }
  }

  return { entries, serviceFees };
}

// Fetch a single month's financial events - returns cache entries
// This is designed to be called ONCE per edge function invocation to avoid CPU timeout
async function fetchMonthEvents(
  accessToken: string,
  startDate: Date,
  endDate: Date,
  userId: string,
  monthLabel: string,
  supabase?: any,
  progressId?: string
): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  let consecutiveRateLimits = 0;
  let serviceFeeIdx = 0;
  const monthFallbackDate = startDate.toISOString().split('T')[0];
  const maxConsecutiveRateLimits = 10;
  const maxPages = 500; // Safety limit per month
  const requestTimeoutMs = 30_000;

  do {
    const params = new URLSearchParams({
      PostedAfter: startDate.toISOString(),
      PostedBefore: endDate.toISOString(),
      MaxResultsPerPage: '100',
    });

    if (nextToken) {
      params.set('NextToken', nextToken);
    }

    const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params.toString()}`;
    const headers = await signRequest('GET', url, '', accessToken);

    pageCount++;

    // Heartbeat every 5 pages
    if (supabase && progressId && (pageCount === 1 || pageCount % 5 === 0)) {
      await updateProgress(supabase, progressId, {
        message: `${monthLabel}: page ${pageCount}...`,
      });
    }

    console.log(`[${monthLabel}] Page ${pageCount}...`);

    if (pageCount > maxPages) {
      console.warn(`[${monthLabel}] Hit max pages (${maxPages}), stopping.`);
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { ...headers, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
    } catch (err: any) {
      console.error(`[${monthLabel}] Request failed: ${err?.message || err}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue; // retry
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      consecutiveRateLimits++;
      if (consecutiveRateLimits >= maxConsecutiveRateLimits) {
        console.log(`[${monthLabel}] Too many rate limits, stopping with ${entries.length} entries.`);
        break;
      }
      const waitTime = Math.min(consecutiveRateLimits * 2000, 10000);
      console.log(`[${monthLabel}] Rate limited (${consecutiveRateLimits}/${maxConsecutiveRateLimits}), waiting ${waitTime / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      continue;
    }

    consecutiveRateLimits = 0;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${monthLabel}] API error: ${response.status} - ${errorText}`);
      throw new Error(`Financial events API failed: ${response.status}`);
    }

    const data = await response.json();
    const events = data.payload?.FinancialEvents;

    // Process all event types
    for (const event of events?.ShipmentEventList || []) {
      entries.push(...processShipmentEventToCache(event, userId));
    }
    for (const event of events?.RefundEventList || []) {
      entries.push(...processRefundEventToCache(event, userId));
    }
    for (const event of events?.ServiceFeeEventList || []) {
      entries.push(processServiceFeeEventToCache(event, userId, serviceFeeIdx++, monthFallbackDate));
    }
    let _adjEvtIdx = 0;
    for (const event of events?.AdjustmentEventList || []) {
      _adjEvtIdx++;
      const eventDate = event.PostedDate?.split('T')[0] || new Date().toISOString().split('T')[0];
      const adjustmentType = (event.AdjustmentType || '').toUpperCase();
      const isPostageBilling = isFbmShippingLabelReason(adjustmentType);
      let _itemIdx = 0;
      for (const item of event.AdjustmentItemList || []) {
        _itemIdx++;
        const currency = item.TotalAmount?.CurrencyCode || 'USD';
        const amount = convertToUSD(parseFloat(item.TotalAmount?.CurrencyAmount || 0), currency);
        // Synthetic unique key so multiple same-day adjustments don't collapse on upsert
        const adjOrderId = event.AmazonOrderId && event.AmazonOrderId.length > 0
          ? `${event.AmazonOrderId}#${_itemIdx}`
          : `ADJ-${eventDate}-${_adjEvtIdx}#${_itemIdx}`;
        const itemAsin = item.ASIN || '';
        if (isPostageBilling) {
          const orderBase = event.AmazonOrderId && event.AmazonOrderId.length > 0
            ? event.AmazonOrderId
            : `POSTAGE-${eventDate}-${_adjEvtIdx}#${_itemIdx}`;
          const entry = createCacheEntry(userId, 'adjustment', eventDate, orderBase, itemAsin);
          entry.fbm_shipping_label_fee += Math.abs(amount);
          entries.push(entry);
        } else if (adjustmentType.includes('LIQUIDATION')) {
          const entry = createCacheEntry(userId, 'liquidation', eventDate, adjOrderId, itemAsin);
          entry.liquidations += amount > 0 ? amount : 0;
          entries.push(entry);
        } else if (adjustmentType.includes('REVERSAL_REIMBURSEMENT')) {
          const entry = createCacheEntry(userId, 'adjustment', eventDate, adjOrderId, itemAsin);
          entry.reversal_reimbursement += Math.abs(amount);
          entries.push(entry);
        } else if (adjustmentType.includes('WAREHOUSE_LOST') || adjustmentType.includes('MISSING_FROM_INBOUND') || adjustmentType.includes('LOST')) {
          const entry = createCacheEntry(userId, 'adjustment', eventDate, adjOrderId, itemAsin);
          if (amount > 0) entry.warehouse_lost += amount;
          else entry.reimbursements += amount;
          entries.push(entry);
        } else if (adjustmentType.includes('WAREHOUSE_DAMAGE') || adjustmentType.includes('DAMAGE')) {
          const entry = createCacheEntry(userId, 'adjustment', eventDate, adjOrderId, itemAsin);
          if (amount > 0) entry.warehouse_damage += amount;
          else entry.reimbursements += amount;
          entries.push(entry);
        } else if (adjustmentType.includes('FREE_REPLACEMENT')) {
          const entry = createCacheEntry(userId, 'adjustment', eventDate, adjOrderId, itemAsin);
          if (amount > 0) entry.free_replacement_refund_items += amount;
          entries.push(entry);
        } else if (amount > 0) {
          const entry = createCacheEntry(userId, 'adjustment', eventDate, adjOrderId, itemAsin);
          entry.reimbursements += amount;
          entries.push(entry);
        }
      }
    }
    // RemovalShipmentEventList: contains BOTH true removals AND liquidation proceeds.
    // Amazon flags liquidations via TransactionType (e.g. "WHOLESALE_LIQUIDATION").
    // Liquidation events carry a positive `Revenue` and a negative `FeeAmount` (brokerage fee).
    // Real removal/disposal events have no revenue and only a fee.
    // FIX (2026-04): emit ONE row per item with a synthetic unique amazon_order_id
    // so the upsert key (user_id,event_type,event_date,amazon_order_id,asin) doesn't
    // collapse multiple same-day liquidations into a single surviving row.
    let _rsEvtIdx = 0;
    for (const event of events?.RemovalShipmentEventList || []) {
      _rsEvtIdx++;
      const eventDate = event.PostedDate?.split('T')[0] || new Date().toISOString().split('T')[0];
      const txnType = String(event.TransactionType || '').toUpperCase();
      const isLiquidation = txnType.includes('LIQUIDATION');
      const orderBase = String(event.MerchantOrderId || event.OrderId || event.AmazonOrderId || `RSE-${eventDate}-${_rsEvtIdx}`);
      let _itemIdx = 0;
      for (const item of event.RemovalShipmentItemList || []) {
        _itemIdx++;
        const itemAsin = String(item.FulfillmentNetworkSKU || item.ASIN || item.SellerSKU || `item${_itemIdx}`);
        const uniqueOrderId = `${orderBase}#${_itemIdx}`;
        const entry = createCacheEntry(userId, isLiquidation ? 'liquidation' : 'removal', eventDate, uniqueOrderId, itemAsin);
        const feeCurrency = item.FeeAmount?.CurrencyCode || 'USD';
        const feeAmount = Math.abs(convertToUSD(parseFloat(item.FeeAmount?.CurrencyAmount || 0), feeCurrency));
        if (isLiquidation) {
          const revCurrency = item.Revenue?.CurrencyCode || 'USD';
          const revenue = convertToUSD(parseFloat(item.Revenue?.CurrencyAmount || 0), revCurrency);
          if (revenue !== 0) entry.liquidations += revenue;
          if (feeAmount !== 0) entry.liquidations_brokerage_fee += feeAmount;
        } else {
          entry.fba_removal_fees += feeAmount;
        }
        entries.push(entry);
      }
    }
    let _flEvtIdx = 0;
    for (const event of events?.FBALiquidationEventList || []) {
      _flEvtIdx++;
      const eventDate = event.PostedDate?.split('T')[0] || new Date().toISOString().split('T')[0];
      const uniqueOrderId = String(event.OriginalRemovalOrderId || `FLE-${eventDate}-${_flEvtIdx}`);
      const entry = createCacheEntry(userId, 'liquidation', eventDate, uniqueOrderId);
      const currency = event.LiquidationProceedsAmount?.CurrencyCode || 'USD';
      entry.liquidations += convertToUSD(parseFloat(event.LiquidationProceedsAmount?.CurrencyAmount || 0), currency);
      entry.liquidations_brokerage_fee += Math.abs(convertToUSD(parseFloat(event.LiquidationFeeAmount?.CurrencyAmount || 0), currency));
      entries.push(entry);
    }
    // RemovalShipmentAdjustmentEventList: corrections to prior removal/liquidation events.
    // Amazon returns RevenueAdjustment / FeeAdjustment / TaxAmountAdjustment fields
    // (NOT RevenueAmount / FeeAmount as previously assumed). Sign is preserved so that
    // negative adjustments correctly reduce the bucket.
    let _rsAdjIdx = 0;
    for (const event of events?.RemovalShipmentAdjustmentEventList || []) {
      _rsAdjIdx++;
      const eventDate = event.PostedDate?.split('T')[0] || new Date().toISOString().split('T')[0];
      const txnType = String(event.TransactionType || '').toUpperCase();
      const isLiquidation = txnType.includes('LIQUIDATION');
      const orderBase = String(event.MerchantOrderId || event.OrderId || event.AmazonOrderId || `RSAE-${eventDate}-${_rsAdjIdx}`);
      let _itemIdx = 0;
      for (const item of event.RemovalShipmentItemAdjustmentList || []) {
        _itemIdx++;
        const itemAsin = String(item.FulfillmentNetworkSKU || item.ASIN || item.SellerSKU || `item${_itemIdx}`);
        const uniqueOrderId = `${orderBase}#${_itemIdx}`;
        const revCurrency =
          item.RevenueAdjustment?.CurrencyCode || item.RevenueAmount?.CurrencyCode || 'USD';
        const revenueAdj = convertToUSD(
          parseFloat(item.RevenueAdjustment?.CurrencyAmount ?? item.RevenueAmount?.CurrencyAmount ?? 0),
          revCurrency,
        );
        const feeCurrency =
          item.FeeAdjustment?.CurrencyCode || item.FeeAmount?.CurrencyCode || 'USD';
        const feeAdj = convertToUSD(
          parseFloat(item.FeeAdjustment?.CurrencyAmount ?? item.FeeAmount?.CurrencyAmount ?? 0),
          feeCurrency,
        );
        if (revenueAdj === 0 && feeAdj === 0) continue;
        const entry = createCacheEntry(userId, isLiquidation ? 'liquidation' : 'removal', eventDate, uniqueOrderId, itemAsin);
        if (isLiquidation) {
          if (revenueAdj !== 0) entry.liquidations += revenueAdj;
          if (feeAdj !== 0) entry.liquidations_brokerage_fee += Math.abs(feeAdj);
        } else {
          if (feeAdj !== 0) entry.fba_removal_fees += Math.abs(feeAdj);
        }
        entries.push(entry);
      }
    }

    nextToken = data.payload?.NextToken || null;

    if (nextToken) {
      await new Promise((resolve) => setTimeout(resolve, 600)); // throttle
    }
  } while (nextToken);
  
  const directServiceFeeCount = entries.filter((entry) => entry.event_type === 'service_fee').length;
  console.log(`[${monthLabel}] [GROUP_DIAG] Direct feed produced ${directServiceFeeCount} service_fee rows from ${pageCount} pages`);
  if (directServiceFeeCount === 0) {
    console.log(`[${monthLabel}] [GROUP_DIAG] Direct feed returned 0 service_fee rows; activating settlement groups fallback...`);
    const groupIds = await fetchFinancialEventGroupIds(accessToken, startDate, endDate, monthLabel);
    let fallbackServiceFees = 0;
    let groupsWithFees = 0;
    for (const groupId of groupIds) {
      const groupPayloads = await fetchFinancialEventsByGroupId(accessToken, groupId, monthLabel);
      let perGroupFees = 0;
      for (const payload of groupPayloads) {
        const processed = processSupplementalServiceAndRemovalEvents(
          payload, userId, startDate, endDate, serviceFeeIdx,
          { groupId, monthLabel }
        );
        serviceFeeIdx += processed.serviceFees;
        fallbackServiceFees += processed.serviceFees;
        perGroupFees += processed.serviceFees;
        entries.push(...processed.entries);
      }
      if (perGroupFees > 0) groupsWithFees++;
    }
    console.log(`[${monthLabel}] [GROUP_DIAG] FALLBACK SUMMARY: groups_queried=${groupIds.length} groups_with_fees=${groupsWithFees} service_fee_rows_inserted=${fallbackServiceFees}`);
  }

  console.log(`[${monthLabel}] Complete: ${entries.length} entries, ${pageCount} pages`);
  return entries;
}

// Process ONE month, save to cache, then return next month info for continuation
// Marketplace ID to short code mapping
const MARKETPLACE_ID_TO_CODE: Record<string, string> = {
  'ATVPDKIKX0DER': 'US',
  'A2EUQ1WTGCTBG2': 'CA',
  'A1AM78C64UM0Y8': 'MX',
  'A2Q3Y263D00KWC': 'BR',
  'A1F83G8C2ARO7P': 'UK',
  'A1PA6795UKMFR9': 'DE',
  'A1RKKUPIHCS9HS': 'ES',
};

/**
 * Attribute marketplace to cache entries by looking up order IDs in sales_orders.
 * Tier 1: order ID match in sales_orders → use that marketplace
 * Tier 2: no match → 'UNKNOWN'
 */
async function attributeMarketplace(entries: CacheEntry[], userId: string, supabase: any): Promise<void> {
  const orderIds = [...new Set(
    entries
      .filter(e => e.amazon_order_id && e.amazon_order_id !== '')
      .map(e => {
        const oid = e.amazon_order_id;
        return oid.endsWith('-REFUND') ? oid.replace(/-REFUND$/, '') : oid;
      })
  )];

  if (orderIds.length === 0) return;

  const marketplaceMap = new Map<string, { marketplace: string; marketplace_id: string | null }>();
  const batchSize = 500;

  for (let i = 0; i < orderIds.length; i += batchSize) {
    const batch = orderIds.slice(i, i + batchSize);
    const { data: orders, error } = await supabase
      .from('sales_orders')
      .select('order_id, marketplace')
      .eq('user_id', userId)
      .in('order_id', batch);

    if (error) {
      console.error('[attributeMarketplace] sales_orders lookup failed:', error);
      continue;
    }

    if (orders) {
      for (const o of orders) {
        if (o.order_id && o.marketplace && o.marketplace !== 'UNKNOWN') {
          marketplaceMap.set(o.order_id, {
            marketplace: o.marketplace,
            marketplace_id: Object.entries(MARKETPLACE_ID_TO_CODE).find(([, code]) => code === o.marketplace)?.[0] || null,
          });
        }
      }
    }
  }

  console.log(`[attributeMarketplace] Resolved ${marketplaceMap.size}/${orderIds.length} order IDs to marketplaces`);

  for (const entry of entries) {
    if (entry.marketplace && entry.marketplace !== 'UNKNOWN') continue;

    const oid = entry.amazon_order_id?.endsWith('-REFUND')
      ? entry.amazon_order_id.replace(/-REFUND$/, '')
      : entry.amazon_order_id;

    const match = oid ? marketplaceMap.get(oid) : undefined;
    if (match) {
      entry.marketplace = match.marketplace;
      entry.marketplace_id = match.marketplace_id;
    }
  }
}

// ============================================================
// SYNC TRACE HELPER - writes per-run stats to sync_traces table
// ============================================================
async function writeSyncTrace(
  supabase: any,
  userId: string,
  syncType: string,
  phase: string | null,
  stats: {
    rows_fetched?: number;
    rows_inserted?: number;
    rows_updated?: number;
    duplicates_skipped?: number;
    rows_corrected?: number;
    rows_missing_price?: number;
    rows_missing_fees?: number;
    error_count?: number;
    retry_count?: number;
    error_message?: string;
    status?: string;
    started_at?: string;
    completed_at?: string;
    metadata?: any;
  }
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('sync_traces')
      .insert({
        user_id: userId,
        sync_type: syncType,
        phase,
        status: stats.status || 'completed',
        started_at: stats.started_at || new Date().toISOString(),
        completed_at: stats.completed_at || new Date().toISOString(),
        rows_fetched: stats.rows_fetched || 0,
        rows_inserted: stats.rows_inserted || 0,
        rows_updated: stats.rows_updated || 0,
        duplicates_skipped: stats.duplicates_skipped || 0,
        rows_corrected: stats.rows_corrected || 0,
        rows_missing_price: stats.rows_missing_price || 0,
        rows_missing_fees: stats.rows_missing_fees || 0,
        error_count: stats.error_count || 0,
        retry_count: stats.retry_count || 0,
        error_message: stats.error_message || null,
        metadata: stats.metadata || null,
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[SYNC_TRACE] Failed to write:', (error as Error).message);
      return null;
    }
    return data?.id || null;
  } catch (err: any) {
    console.warn('[SYNC_TRACE] Exception:', err?.message);
    return null;
  }
}

async function processSingleMonth(
  accessToken: string,
  month: { start: Date; end: Date; label: string },
  userId: string,
  supabase: any,
  progressId: string
): Promise<number> {
  console.log(`Processing ${month.label}: ${month.start.toISOString()} to ${month.end.toISOString()}`);
  const traceStartedAt = new Date().toISOString();
  
  // PHASE: SP-API paginated fetch (report P4)
  const fetchStart = Date.now();
  const entries = await fetchMonthEvents(
    accessToken,
    month.start,
    month.end,
    userId,
    month.label,
    supabase,
    progressId
  );
  const fetchElapsed = Date.now() - fetchStart;
  console.log(`[phase] ${month.label} fetchMonthEvents elapsed_ms=${fetchElapsed} entries=${entries.length}`);

  let insertedCount = 0;
  let duplicatesSkipped = 0;
  let deduped: any[] = [];

  if (entries.length > 0) {
    // Attribute marketplace to entries via order ID lookup
    const attrStart = Date.now();
    await attributeMarketplace(entries, userId, supabase);
    console.log(`[phase] ${month.label} attributeMarketplace elapsed_ms=${Date.now() - attrStart}`);
    
    deduped = dedupeCacheEntries(entries);
    duplicatesSkipped = entries.length - deduped.length;

    // CLEANUP: delete stale liquidation/removal rows for this month before re-inserting.
    // The old parser collapsed many same-day events into a single row via empty
    // (amazon_order_id, asin) — those stale rows would never be overwritten by the
    // new per-item rows (different keys) and would inflate totals. Wipe and rewrite.
    const monthStart = month.start.toISOString().split('T')[0];
    const monthEnd = month.end.toISOString().split('T')[0];
    const deleteStart = Date.now();
    const { error: cleanupErr } = await supabase
      .from('financial_events_cache')
      .delete()
      .eq('user_id', userId)
      .in('event_type', ['liquidation', 'removal', 'service_fee', 'adjustment'])
      .gte('event_date', monthStart)
      .lt('event_date', monthEnd);
    const deleteElapsed = Date.now() - deleteStart;
    if (cleanupErr) {
      console.warn(`[phase] ${month.label} delete_stale FAILED elapsed_ms=${deleteElapsed}:`, cleanupErr.message);
    } else {
      console.log(`[phase] ${month.label} delete_stale elapsed_ms=${deleteElapsed} range=${monthStart}…${monthEnd}`);
    }

    console.log(`[${month.label}] Saving ${deduped.length} entries (${duplicatesSkipped} merged in-memory)...`);

    // Upsert in batches
    const upsertStart = Date.now();
    const batchSize = 500;
    for (let i = 0; i < deduped.length; i += batchSize) {
      const batch = deduped.slice(i, i + batchSize);
      const { error } = await supabase
        .from('financial_events_cache')
        .upsert(batch, {
          onConflict: 'user_id,event_type,event_date,amazon_order_id,asin',
          ignoreDuplicates: false,
        });
      if (error) {
        console.error('Error upserting batch:', error);
      } else {
        insertedCount += batch.length;
      }
    }
    console.log(`[phase] ${month.label} upsert elapsed_ms=${Date.now() - upsertStart} inserted=${insertedCount} batches=${Math.ceil(deduped.length / batchSize)}`);
  }

  // Backfill sales_orders.shipping_label_fee for FBM Buy Shipping label costs
  // discovered in this batch. Groups by amazon_order_id and updates matching
  // orders so the label cost shows up next to each FBM line / refund row.
  try {
    const labelByOrder = new Map<string, number>();
    for (const e of deduped) {
      const amt = Number(e.fbm_shipping_label_fee || 0);
      if (!amt || !e.amazon_order_id || e.amazon_order_id.startsWith('SVC-')) continue;
      labelByOrder.set(e.amazon_order_id, (labelByOrder.get(e.amazon_order_id) || 0) + amt);
    }
    if (labelByOrder.size > 0) {
      let labelUpdated = 0;
      for (const [orderId, fee] of labelByOrder.entries()) {
        const { error: updErr } = await supabase
          .from('sales_orders')
          .update({
            shipping_label_fee: Number(fee.toFixed(2)),
            shipping_label_fee_source: 'settlement',
            shipping_label_fee_synced_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('order_id', orderId);
        if (!updErr) labelUpdated++;
      }
      console.log(`[${month.label}] Backfilled shipping_label_fee on ${labelUpdated}/${labelByOrder.size} sales_orders rows`);
    }
  } catch (e) {
    console.warn(`[${month.label}] shipping_label_fee backfill failed:`, (e as Error).message);
  }

  // Write sync trace for this month
  await writeSyncTrace(supabase, userId, 'financial_events', month.label, {
    started_at: traceStartedAt,
    rows_fetched: entries.length,
    rows_inserted: insertedCount,
    duplicates_skipped: duplicatesSkipped,
    metadata: { month: month.label, progressId },
  });

  return entries.length;
}

// Generate month chunks for a date range
function generateMonthChunks(startDate: Date, endDate: Date): { start: Date; end: Date; label: string }[] {
  const months: { start: Date; end: Date; label: string }[] = [];
  let current = new Date(startDate);
  
  while (current < endDate) {
    const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    const chunkEnd = monthEnd < endDate ? monthEnd : endDate;
    const label = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
    months.push({ start: new Date(current), end: chunkEnd, label });
    current = monthEnd;
  }
  
  return months;
}

// Sprint 1 + Option A: per-month cache-status check.
//
// KNOWN DEBT (tracked as Sprint 4/5 → Option C: explicit pl_month_sync_state table).
// The "partial = shipments > 0 AND service_fees == 0" heuristic is unreliable for
// historical backfills — older sync paths pulled shipments without service_fees, so
// entire past years get permanently flagged partial and re-sync forever. Verified:
// 2025-01 through 2025-12 have 0 service_fees each; 2026+ live syncs have 300-400.
// This is a structural backfill boundary, NOT a settlement lag.
//
// Rule applied here (stopgap, honest naming):
//   - No rows at all                                  → not cached (fetch)
//   - Has shipments, missing service_fees, RECENT     → not cached (fetch, might still land)
//   - Has shipments, missing service_fees, OLD (>60d) → CACHED (trust shipments, give up on service_fees)
//   - Has shipments + service_fees                    → cached
//
// The 60-day cutoff is arbitrary: Amazon reliably posts service_fees within the
// same or following month, so anything older that's still zero will not spontaneously
// gain rows. Treat this as "give up checking after 60 days", not freshness detection.
const SERVICE_FEE_GRACE_DAYS = 60;

// Sprint 1.1: Prefetch per-month counts in ONE RPC round-trip instead of
// firing 3 parallel `count exact` HTTP calls per month (36 total for a
// 12-month year). The old shape produced 7-25s tail-latency spikes on the
// shared PostgREST pool even though the underlying queries ran in ~5ms.
// Returns a Map keyed by 'YYYY-MM' → { total, ship, sf }. Missing months
// (no rows in FEC) simply don't appear in the map, and isMonthCached
// treats them as total=0 (NOT_CACHED, matches prior behaviour).
type MonthCounts = { total: number; ship: number; sf: number };
async function prefetchMonthCounts(
  supabase: any,
  userId: string,
  months: Array<{ start: Date; end: Date; label: string }>,
): Promise<{ counts: Map<string, MonthCounts>; elapsedMs: number; ok: boolean }> {
  if (months.length === 0) return { counts: new Map(), elapsedMs: 0, ok: true };
  const t0 = Date.now();
  const startStr = months[0].start.toISOString().split('T')[0];
  // RPC filter is inclusive on both ends (event_date <= p_end_date), so use
  // the last day of the last month directly.
  const lastMonth = months[months.length - 1];
  const endDate = new Date(lastMonth.end.getTime());
  const endStr = endDate.toISOString().split('T')[0];
  try {
    const { data, error } = await supabase.rpc('get_fec_month_counts', {
      p_user_id: userId,
      p_start_date: startStr,
      p_end_date: endStr,
    });
    const elapsedMs = Date.now() - t0;
    if (error) {
      console.warn(`[prefetchMonthCounts] RPC failed after ${elapsedMs}ms, falling back to per-month HTTP counts:`, error?.message || error);
      return { counts: new Map(), elapsedMs, ok: false };
    }
    const counts = new Map<string, MonthCounts>();
    for (const row of (data || []) as Array<{ month_key: string; total_cnt: number | string; ship_cnt: number | string; sf_cnt: number | string }>) {
      counts.set(row.month_key, {
        total: Number(row.total_cnt) || 0,
        ship: Number(row.ship_cnt) || 0,
        sf: Number(row.sf_cnt) || 0,
      });
    }
    console.log(`[prefetchMonthCounts] rpc_ok months=${months.length} rows_returned=${counts.size} elapsed_ms=${elapsedMs}`);
    return { counts, elapsedMs, ok: true };
  } catch (err: any) {
    const elapsedMs = Date.now() - t0;
    console.warn(`[prefetchMonthCounts] threw after ${elapsedMs}ms, falling back:`, err?.message || err);
    return { counts: new Map(), elapsedMs, ok: false };
  }
}

// Classification logic — UNCHANGED from the previous per-month-HTTP version.
// This is a pure transport refactor: when `prefetched` is supplied we use its
// counts and skip the 3 HTTP round-trips; when it's null we fall back to the
// original 3-parallel `count exact` shape. Cached/partial verdicts must be
// bit-identical either way — verified by comparing per-month log lines.
// This is a pure transport refactor: when `prefetched` is supplied we use its
// counts and skip the 3 HTTP round-trips; when it's null we fall back to the
// original 3-parallel `count exact` shape. Cached/partial verdicts must be
// bit-identical either way — verified by comparing per-month log lines.
async function isMonthCached(
  supabase: any,
  userId: string,
  month: { start: Date; end: Date; label: string },
  prefetched: Map<string, MonthCounts> | null = null,
): Promise<boolean> {
  const t0 = Date.now();
  let total = 0;
  let shipments = 0;
  let serviceFees = 0;
  let source = 'rpc';
  try {
    if (prefetched) {
      const hit = prefetched.get(month.label);
      total = hit?.total ?? 0;
      shipments = hit?.ship ?? 0;
      serviceFees = hit?.sf ?? 0;
    } else {
      source = 'http-fallback';
      const startStr = month.start.toISOString().split('T')[0];
      const endStr = month.end.toISOString().split('T')[0];
      const [totalRes, shipmentRes, serviceFeeRes] = await Promise.all([
        supabase
          .from('financial_events_cache')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('event_date', startStr)
          .lt('event_date', endStr),
        supabase
          .from('financial_events_cache')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('event_type', 'shipment')
          .gte('event_date', startStr)
          .lt('event_date', endStr),
        supabase
          .from('financial_events_cache')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('event_type', 'service_fee')
          .gte('event_date', startStr)
          .lt('event_date', endStr),
      ]);
      total = totalRes.count ?? 0;
      shipments = shipmentRes.count ?? 0;
      serviceFees = serviceFeeRes.count ?? 0;
    }
    const dtMs = Date.now() - t0;

    const ageMs = Date.now() - month.end.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const isOld = ageMs > SERVICE_FEE_GRACE_DAYS * 24 * 60 * 60 * 1000;

    // Structured decision log — one line per month, cheap to grep.
    const base = `[isMonthCached] ${month.label} total=${total} ship=${shipments} sf=${serviceFees} ageDays=${ageDays} old=${isOld} check_ms=${dtMs} src=${source}`;

    if (total === 0) {
      console.log(`${base} → NOT_CACHED reason=missing_no_rows`);
      return false;
    }
    if (shipments > 0 && serviceFees === 0) {
      if (isOld) {
        console.log(`${base} → CACHED reason=old_shipments_only_service_fees_will_never_land`);
        return true;
      }
      console.log(`${base} → NOT_CACHED reason=recent_partial_service_fees_may_still_arrive`);
      return false;
    }
    console.log(`${base} → CACHED reason=has_rows`);
    return true;
  } catch (err: any) {
    console.warn(`[isMonthCached] ${month.label} check FAILED, forcing re-sync:`, err?.message);
    return false; // fail-safe: sync
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization');
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const internalHeader = req.headers.get('x-internal-secret');

    // Multi-tier auth: internal secret → service role key → getClaims → getUser
    let userId: string | null = null;
    let supabase: any;
    
    // Parse body early for all auth paths (needed to check user_id)
    let bodyJson: any = {};
    try {
      const bodyText = await req.text();
      bodyJson = JSON.parse(bodyText);
      (req as any)._parsedBody = bodyJson;
    } catch (_) {}

    // Check if Bearer token IS the service role key (internal call from auto-sync)
    const bearerToken = authHeader?.replace('Bearer ', '') || '';
    const isServiceRoleCall = bearerToken === serviceKey && bodyJson.user_id;

    // Check for internal service call (from auto-sync-all-users)
    if (internalHeader && internalSecret && internalHeader === internalSecret && bodyJson.user_id) {
      userId = bodyJson.user_id;
      console.log(`🔧 INTERNAL_SECRET_CALL: Processing fetch-profit-loss for user ${userId}`);
      supabase = createClient(supabaseUrl, supabaseKey);
    } else if (isServiceRoleCall) {
      userId = bodyJson.user_id;
      console.log(`🔧 SERVICE_ROLE_CALL: Processing fetch-profit-loss for user ${userId}`);
      supabase = createClient(supabaseUrl, supabaseKey);
    } else if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else {
      const token = authHeader.replace('Bearer ', '');
      supabase = createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: authHeader } },
      });

      // Tier 1: try getClaims (local, no DB call)
      try {
        const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
        if (!claimsError && claimsData?.claims?.sub) {
          userId = claimsData.claims.sub as string;
        }
      } catch (_) { /* fall through */ }

      // Manual JWT decode removed — verified signatures only (getClaims/getUser).

      // Tier 3: network call (last resort)
      if (!userId) {
        try {
          const { data: { user }, error: userError } = await supabase.auth.getUser(token);
          if (!userError && user) {
            userId = user.id;
          }
        } catch (_) { /* fall through */ }
      }
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseService = createClient(supabaseUrl, serviceKey);

    // Load live FX rates from database (Phase 2)
    await loadFxRates(supabaseService);
    // Reset FX tracking per request
    fxCurrenciesConverted = new Set<string>();

    const body = (req as any)._parsedBody || await req.json();
    const { startDate, endDate, forceRefresh, continueFromMonth, progressId: providedProgressId } = body;

    if (!startDate || !endDate) {
      return new Response(JSON.stringify({ error: 'startDate and endDate are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get seller authorization - fetch ALL rows and filter for preferred marketplace
    // This handles multi-marketplace users (US, CA, MX, BR)
    const { data: authRows, error: authError } = await supabaseService
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', userId);

    // Prefer US marketplace, fallback to first available
    const authData = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (authError || !authData?.refresh_token) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`P&L request: ${startDate} to ${endDate}, forceRefresh=${forceRefresh}, continueFromMonth=${continueFromMonth}`);

    // Check sync state
    const { data: syncState } = await supabaseService
      .from('financial_sync_state')
      .select('last_synced_date')
      .eq('user_id', userId)
      .single();

    const requestedEndDate = new Date(endDate);
    const maxEndDate = new Date(Date.now() - 3 * 60 * 1000);
    const effectiveEndDate = requestedEndDate > maxEndDate ? maxEndDate : requestedEndDate;

    const lastSyncedDate = syncState?.last_synced_date ? new Date(syncState.last_synced_date) : null;

    // IMPORTANT:
    // - forceRefresh=true is the ONLY signal to perform a slow Amazon sync.
    // - forceRefresh=false must return immediately from the database cache (even if stale/partial),
    //   so the report UI can render fast like InventoryLab.
    const shouldSync = forceRefresh === true || continueFromMonth !== undefined;
    const cacheIsStale = !lastSyncedDate || requestedEndDate > lastSyncedDate;

    // FAST PATH (cache-only): always return summary immediately when not explicitly syncing.
    if (!shouldSync && continueFromMonth === undefined) {
      const fastPathStart = Date.now();
      console.log(`[FAST PATH] entry ${startDate} → ${endDate} user=${userId}`);
      const aggStart = Date.now();
      const financialSummary = await aggregateFromCache(
        supabaseService,
        userId,
        startDate.split('T')[0],
        endDate.split('T')[0]
      );
      console.log(`[FAST PATH] phase=aggregateFromCache elapsed_ms=${Date.now() - aggStart}`);

      // Calculate COGS from sold orders (unit_cost × quantity)
      const cogsStart = Date.now();
      const PAGE_SIZE = 1000;
      let offset = 0;
      let totalCOGS = 0;
      let cogsRowsScanned = 0;

      while (true) {
        const { data: salesPage, error: salesError } = await supabaseService
          .from('sales_orders')
          .select('quantity, unit_cost')
          .eq('user_id', userId)
          .gte('order_date', startDate.split('T')[0])
          .lte('order_date', endDate.split('T')[0])
          .range(offset, offset + PAGE_SIZE - 1);

        if (salesError) {
          console.error('Error fetching sales_orders for COGS:', salesError);
          break;
        }

        const rows = salesPage || [];
        cogsRowsScanned += rows.length;
        for (const order of rows) {
          const unitCost = Number(order.unit_cost) || 0;
          const quantity = Number(order.quantity) || 1;
          totalCOGS += unitCost * quantity;
        }

        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      console.log(`[FAST PATH] phase=cogs_scan rows=${cogsRowsScanned} elapsed_ms=${Date.now() - cogsStart}`);

      const netProfit = financialSummary.totalIncome - financialSummary.totalExpenses - totalCOGS;

      // Attach FX metadata
      financialSummary.fxMetadata = getFxMetadata();

      console.log(`[FAST PATH] exit total_elapsed_ms=${Date.now() - fastPathStart} cogs=${totalCOGS.toFixed(2)} income=${financialSummary.totalIncome?.toFixed(2)} expenses=${financialSummary.totalExpenses?.toFixed(2)}`);

      return new Response(
        JSON.stringify({
          cached: true,
          stale: cacheIsStale,
          last_synced_date: syncState?.last_synced_date ?? null,
          summary: financialSummary,
          cogs: totalCOGS,
          net_profit: netProfit,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // If we are syncing, decide if a sync is actually needed.
    // (continueFromMonth implies we are already mid-sync.)
    // IMPORTANT: when forceRefresh=true, always sync (even if last_synced_date is newer),
    // because users may have cleared a specific month and need to backfill it.
    const needsSync = (continueFromMonth !== undefined) || (forceRefresh === true);

    // Create or reuse progress record (IMPORTANT: keep a single record per run)
    let progressId: string;

    if (typeof providedProgressId === 'string' && providedProgressId.length > 0) {
      // Trust but verify ownership
      const { data: existingById } = await supabaseService
        .from('pl_sync_progress')
        .select('id, user_id')
        .eq('id', providedProgressId)
        .maybeSingle();

      if (existingById && existingById.user_id === userId) {
        progressId = existingById.id;
      } else {
        // Fall back to creating a new record (should be rare)
        const { data: progressRecord } = await supabaseService
          .from('pl_sync_progress')
          .insert({
            user_id: userId,
            status: 'running',
            message: needsSync ? 'Starting sync...' : 'Loading from cache...',
          })
          .select()
          .single();
        progressId = progressRecord?.id;
      }
    } else if (continueFromMonth !== undefined) {
      // Continuing existing sync - find the latest active progress record
      const { data: existingProgress } = await supabaseService
        .from('pl_sync_progress')
        .select('id')
        .eq('user_id', userId)
        .in('status', ['running', 'continue'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingProgress?.id) {
        progressId = existingProgress.id;
      } else {
        const { data: newProgress } = await supabaseService
          .from('pl_sync_progress')
          .insert({ user_id: userId, status: 'running', message: 'Continuing sync...' })
          .select()
          .single();
        progressId = newProgress?.id;
      }
    } else {
      // New sync: delete old progress rows so we can't accidentally attach to an old run
      await supabaseService.from('pl_sync_progress').delete().eq('user_id', userId);

      const { data: progressRecord, error: progressError } = await supabaseService
        .from('pl_sync_progress')
        .insert({
          user_id: userId,
          status: 'running',
          message: needsSync ? 'Starting sync...' : 'Loading from cache...',
        })
        .select()
        .single();

      if (progressError) {
        console.error('Failed to create progress record:', progressError);
      }
      progressId = progressRecord?.id;
    }

    // Ensure progress is marked running for this invocation
    await updateProgress(supabaseService, progressId, { status: 'running' });

    // Generate all months
    const startDateObj = new Date(startDate);
    const months = generateMonthChunks(startDateObj, effectiveEndDate);
    const startMonthIndex = continueFromMonth ?? 0;

    console.log(`Processing months ${startMonthIndex + 1} to ${months.length}: ${months.map(m => m.label).join(', ')}`);

    // Return immediately with progress ID
    const responsePromise = new Response(JSON.stringify({ 
      progressId,
      message: needsSync ? 'Syncing one month at a time...' : 'Loading from cache...',
      cached: !needsSync,
      totalMonths: months.length,
      currentMonth: startMonthIndex,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

    // Background task: process ONE non-cached month, then signal for continuation
    const backgroundTask = async () => {
      try {
        if (needsSync && startMonthIndex < months.length) {
          // Sprint 1: skip already-cached months instead of re-pulling SP-API for them.
          // A single missing/partial month used to force a full-year resync (~80s/month
          // × 7 = ~10min). Now we scan forward from startMonthIndex, skipping any month
          // whose cache is complete per the RPC rule, and only fetch the first
          // non-cached month. Clear Cache & Resync remains the escape hatch when a
          // user wants to bypass this and re-pull every event type.
          let currentIndex = startMonthIndex;
          const loopStartedAt = Date.now();
          console.log(`[skip-loop] entry startMonthIndex=${startMonthIndex} totalMonths=${months.length}`);

          // Sprint 1.1: Prefetch all remaining months' FEC counts in ONE RPC
          // round-trip. Removes ~30s of PostgREST tail-latency from the
          // previous per-month HTTP shape. If the RPC fails, isMonthCached
          // falls back to the original 3-parallel-counts path per month.
          const remainingMonths = months.slice(currentIndex);
          const { counts: prefetchedCounts, ok: prefetchOk } =
            await prefetchMonthCounts(supabaseService, userId, remainingMonths);
          const prefetchArg = prefetchOk ? prefetchedCounts : null;

          while (currentIndex < months.length) {
            const m = months[currentIndex];
            const cached = await isMonthCached(supabaseService, userId, m, prefetchArg);
            if (!cached) break;
            currentIndex++;
          }
          const scanElapsedMs = Date.now() - loopStartedAt;
          console.log(`[skip-loop] scan_complete elapsed_ms=${scanElapsedMs} skipped=${currentIndex - startMonthIndex} next_index=${currentIndex} prefetch=${prefetchOk ? 'rpc' : 'http-fallback'}`);

          // All remaining months were cached — fall through to totals calculation
          if (currentIndex >= months.length) {
            console.log('[skip-loop] all remaining months cached; skipping to totals.');
          } else {
            const month = months[currentIndex];
            console.log(`[process-month] ${month.label} entry ts=${new Date().toISOString()}`);

            const lwaStart = Date.now();
            const accessToken = await getLWAAccessToken(authData.refresh_token);
            console.log(`[process-month] ${month.label} phase=lwa_exchange elapsed_ms=${Date.now() - lwaStart}`);

            await updateProgress(supabaseService, progressId, {
              current_chunk: currentIndex + 1,
              total_chunks: months.length,
              message: `Syncing ${month.label} (month ${currentIndex + 1}/${months.length})...`,
            });

            const procStart = Date.now();
            const entriesCount = await processSingleMonth(
              accessToken,
              month,
              userId,
              supabaseService,
              progressId
            );
            const procElapsed = Date.now() - procStart;

            console.log(`[process-month] ${month.label} exit entries=${entriesCount} phase=processSingleMonth_total elapsed_ms=${procElapsed}`);

            // Check if more months to process
            if (currentIndex + 1 < months.length) {
              // Signal continuation needed
              await updateProgress(supabaseService, progressId, {
                current_chunk: currentIndex + 1,
                total_chunks: months.length,
                message: `Completed ${month.label}. Continue to next month...`,
                status: 'continue',
              });
              return; // Exit - frontend will re-invoke for next month
            }
          }
        }

        // All months done or cache-only mode - calculate final totals
        await updateProgress(supabaseService, progressId, {
          message: 'Calculating totals...',
        });

        // Update sync state
        const endDateStr = effectiveEndDate.toISOString().split('T')[0];
        await supabaseService
          .from('financial_sync_state')
          .upsert({
            user_id: userId,
            last_synced_date: endDateStr,
            last_sync_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });

        // Aggregate from cache
        const financialSummary = await aggregateFromCache(
          supabaseService,
          userId,
          startDate.split('T')[0],
          endDate.split('T')[0]
        );

        // Calculate COGS from sold orders (unit_cost × quantity)
        const PAGE_SIZE = 1000;
        let allSalesData: any[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const { data: salesPage, error: salesError } = await supabaseService
            .from('sales_orders')
            .select('quantity, unit_cost')
            .eq('user_id', userId)
            .gte('order_date', startDate.split('T')[0])
            .lte('order_date', endDate.split('T')[0])
            .range(offset, offset + PAGE_SIZE - 1);

          if (salesError) {
            console.error('Error fetching sales_orders for COGS:', salesError);
            break;
          }

          if (salesPage && salesPage.length > 0) {
            allSalesData = [...allSalesData, ...salesPage];
            offset += PAGE_SIZE;
            hasMore = salesPage.length === PAGE_SIZE;
          } else {
            hasMore = false;
          }
        }

        let totalCOGS = 0;
        for (const order of allSalesData) {
          const unitCost = Number(order.unit_cost) || 0;
          const quantity = Number(order.quantity) || 1;
          totalCOGS += unitCost * quantity;
        }

        console.log(`COGS from ${allSalesData.length} sales_orders: $${totalCOGS.toFixed(2)}`);

        const netProfit = financialSummary.totalIncome - financialSummary.totalExpenses - totalCOGS;
        // Attach FX metadata
        financialSummary.fxMetadata = getFxMetadata();

        console.log(`P&L complete: Income=${financialSummary.totalIncome.toFixed(2)}, Expenses=${financialSummary.totalExpenses.toFixed(2)}, COGS=${totalCOGS.toFixed(2)}`);

        // Update progress with final results
        await updateProgress(supabaseService, progressId, {
          status: 'completed',
          message: `Complete! Sales: $${financialSummary.sales.toFixed(0)}, ${financialSummary.refundRecords.length} refunds`,
          summary: financialSummary,
          cogs: totalCOGS,
          net_profit: netProfit,
        });

      } catch (error: any) {
        console.error('Background P&L error:', error);
        await updateProgress(supabaseService, progressId, {
          status: 'error',
          error: (error as Error).message,
          message: `Error: ${(error as Error).message}`,
        });
      }
    };

    // Start background processing
    (globalThis as any).EdgeRuntime?.waitUntil(backgroundTask());

    return responsePromise;

  } catch (error: any) {
    console.error('Error fetching P&L:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
