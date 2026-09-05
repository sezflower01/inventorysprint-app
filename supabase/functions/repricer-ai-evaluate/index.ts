import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { convertCurrency, getSellerHomeCurrency } from '../_shared/fx-utils.ts';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';
import { getListingUnitCost, getInventoryUnitCost } from '../_shared/cost-contract.ts';
import {
  detectMarketAnomalies,
  computeUnderpricedRecovery,
  computeFastLaneCooldown,
} from './_recovery.ts';
import {
  PROFILE_KEY_TO_LABEL,
  PROFILE_PRESETS,
  USER_CONTROLLED_FIELDS,
} from './_presets.ts';
import {
  evaluatePostRaiseCooldown,
  evaluateMarketSupportedRaise,
} from './_v2gates.ts';
import { scoreMarketVolatility, wasMoveProductive } from '../_shared/marketVolatility.ts';
import { resolveMinRoiEnabled } from '../_shared/min-roi-enabled.ts';
import { isInternalCaller } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Marketplace currency mapping for FX conversion
const MARKETPLACE_CURRENCIES: Record<string, string> = {
  US: 'USD',
  CA: 'CAD',
  MX: 'MXN',
  BR: 'BRL',
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  CAD: 'C$',
  MXN: 'MX$',
  BRL: 'R$',
  GBP: '£',
  EUR: '€',
};

function currencySymbolFor(code: string): string {
  return CURRENCY_SYMBOLS[code] || `${code} `;
}

function formatMoney(amount: number | null | undefined, currencyCode: string): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return `${currencySymbolFor(currencyCode)}${amount.toFixed(2)} ${currencyCode}`;
}

// Fetch FX rate from Supabase fx_rates table
async function getFxRate(supabase: any, targetCurrency: string): Promise<number> {
  if (targetCurrency === 'USD') return 1;
  
  const { data, error } = await supabase
    .from('fx_rates')
    .select('rate')
    .eq('base', 'USD')
    .eq('quote', targetCurrency)
    .single();
  
  if (error || !data) {
    console.log(`[repricer-ai-evaluate] FX rate not found for ${targetCurrency}, using fallback`);
    const fallbacks: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0 };
    return fallbacks[targetCurrency] || 1;
  }
  
  return data.rate;
}

interface AiEvaluateRequest {
  assignmentId?: string;
  asin?: string;
  sku?: string;
  marketplace?: string;
  ruleId?: string;
  currentPrice?: number;
  testMode?: boolean;
  is_priority?: boolean;
  trigger_source?: string | null;
  // Manual "Force Smart Raise" — controlled BB-owner profit probe.
  // Bypasses cooldown + bb_owner_protection only when isBuyboxOwner AND
  // filtered anchor is above current AND no lower eligible FBA exists.
  force_mode?: 'smart_raise' | null;
}

interface IntelligenceFactors {
  // Sales velocity comparison (your sales vs market)
  salesVelocityScore: number; // 0-100, higher = you're selling well
  yourDailySales: number;
  estimatedMarketDailySales: number;
  
  // Weighted velocity (7d/30d blend)
  units7d: number;
  units30d: number;
  ads7d: number;
  ads30d: number;
  adsEffective: number; // weighted blend
  
  // Today momentum — detects sudden demand drops
  unitsToday: number;
  todayMomentumDrop: boolean; // true if today's sales are significantly below 7d daily avg
  momentumMarketDropped: boolean; // true if anchor/BB price dropped since last snapshot
  anchorPriceNow: number | null;
  anchorPrice24hAgo: number | null;
  marketDropPct: number | null; // % drop in anchor price
  marketDropAmount: number | null; // $ drop in anchor price
  momentumTriggered: boolean; // final: both conditions met
  
  // Your stock levels
  yourUnitsAvailable: number;
  yourDaysOfStock: number | null; // null = unknown
  stockAggressionModifier: number; // multiplier (0.75 – 1.30)
  stockOverlayTag: string | null; // e.g. 'STOCK_OVERLAY(daysOfStock=123, mod=1.10)'
  
  // Buy Box win rate
  buyboxWinRate: number; // 0-100 percent
  buyboxWinStreak: number; // consecutive wins
  buyboxLossStreak: number; // consecutive losses
  
  // Competitor stock levels
  competitorStockSignal: 'LOW' | 'NORMAL' | 'HIGH' | 'UNKNOWN';
  competitorCount: number;
  fbaCompetitorCount: number;
  amazonSelling: boolean;
  
  // Time on market
  daysSinceFirstListed: number;
  daysWithoutSale: number;
  inventoryAge: number; // days
  urgencyScore: number; // 0-100, higher = more urgent to sell
  [key: string]: any;
}

// Competitor quality filter settings
interface CompetitorQualitySettings {
  minSellerRating: number; // 0-100
  maxHandlingDays: number;
  shipsFromFilter: 'US_ONLY' | 'DOMESTIC' | 'ANY';
  topNCompetitors: number;
  preset: 'conservative' | 'balanced' | 'aggressive' | 'custom';
}

// Get preset values for competitor quality
function getCompetitorQualityPreset(preset: string): Partial<CompetitorQualitySettings> {
  switch (preset) {
    case 'conservative':
      return { minSellerRating: 90, maxHandlingDays: 1 };
    case 'aggressive':
      return { minSellerRating: 70, maxHandlingDays: 3 };
    case 'balanced':
    default:
      return { minSellerRating: 80, maxHandlingDays: 2 };
  }
}

// Helper: Parse handling time ranges like "0 to 8 days" → 8 (use MAX value for conservative filtering)
function parseHandlingDays(raw: any): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  
  const str = String(raw).toLowerCase();
  // Match "X to Y days" or "X-Y days"
  const rangeMatch = str.match(/(\d+)\s*(?:to|-)\s*(\d+)/);
  if (rangeMatch) {
    return Math.max(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
  }
  // Single number
  const singleMatch = str.match(/(\d+)/);
  if (singleMatch) return parseInt(singleMatch[1], 10);
  return null;
}

// NOTE: detectMarketAnomalies + computeUnderpricedRecovery moved to ./_recovery.ts
// so they can be unit-tested directly. See `_tests/repricer-ai-evaluate/recovery_test.ts`.

// ═══════════════════════════════════════════════════════════════════
// RAISE OFFSET POLICY — Match ($0.00) vs Undercut ($0.01)
// When raising toward a competitor, decide whether to match their price
// or stay $0.01 below. Equal price is better when the penny is pure
// margin gain without meaningful BB advantage loss.
// ═══════════════════════════════════════════════════════════════════
interface RaiseOffsetContext {
  isBuyboxOwner: boolean;
  buyboxLost: boolean;            // active BB loss / recovery mode
  bbRecoveryMode: boolean;        // duration-based escalation active
  myFulfillment: 'FBA' | 'FBM' | null;
  buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | 'unknown' | null; // best proxy for competitor type
  clusterDetected: boolean;
  targetPrice: number;            // the raise target price
  fbaCompetitorCount: number;     // FBA sellers near the target price
  isOnlySeller: boolean;
  isMonopoly: boolean;            // monopoly mode would fire
  smartProfile: string;           // VELOCITY_DOMINATOR, MOMENTUM_BUILDER, etc.
}

function computeRaiseOffset(ctx: RaiseOffsetContext): { offset: number; reason: string } {
  const isAggressive = ctx.smartProfile === 'VELOCITY_DOMINATOR';

  // ── Priority 0: CLUSTER MATCH PROTECTION ──
  // In a tight rotating cluster, undercutting by $0.01 does NOT meaningfully
  // improve Buy Box share but DOES erode profit and can trigger downward spirals.
  // Only skip this if we are in active BB recapture (buyboxLost + escalation)
  // or running an explicitly aggressive liquidation strategy.
  if (ctx.clusterDetected && !ctx.buyboxLost && !ctx.bbRecoveryMode && !isAggressive) {
    return { offset: 0.00, reason: 'match:cluster_rotating_bb_protection' };
  }

  // ── Priority 1: Strong reasons to UNDERCUT ($0.01) ──
  if (ctx.buyboxLost || ctx.bbRecoveryMode) {
    return { offset: 0.01, reason: 'undercut:bb_recapture' };
  }
  if (isAggressive) {
    return { offset: 0.01, reason: 'undercut:aggressive_strategy' };
  }
  // FBM sellers: respect profile intent for match-only profiles (Profit Extractor, Match Buy Box, Match Lowest)
  // Only force undercut for profiles that are NOT match-only
  if (ctx.myFulfillment === 'FBM') {
    const isMatchOnlyProfile = ctx.smartProfile === 'PROFIT_EXTRACTOR' || ctx.smartProfile === 'MATCH_BUYBOX' || ctx.smartProfile === 'MATCH_LOWEST' || ctx.smartProfile === 'SMART_MATCH';
    if (isMatchOnlyProfile) {
      return { offset: 0.00, reason: 'match:fbm_match_only_profile' };
    }
    return { offset: 0.01, reason: 'undercut:fbm_seller' };
  }
  if (ctx.targetPrice < 15) {
    return { offset: 0.01, reason: 'undercut:low_price_item' };
  }
  if (ctx.fbaCompetitorCount >= 5) {
    return { offset: 0.01, reason: 'undercut:dense_fba_competition' };
  }

  // ── Priority 2: Strong reasons to MATCH ($0.00) ──
  if (ctx.isBuyboxOwner) {
    return { offset: 0.00, reason: 'match:bb_owner_raising' };
  }
  if (ctx.isMonopoly || ctx.isOnlySeller) {
    return { offset: 0.00, reason: 'match:monopoly_or_only_seller' };
  }
  // FBA vs FBA — Amazon rotates BB at equal price
  if (ctx.myFulfillment === 'FBA' && (ctx.buyboxSellerType === 'FBA' || ctx.buyboxSellerType === 'Amazon')) {
    return { offset: 0.00, reason: 'match:fba_vs_fba' };
  }
  if (ctx.clusterDetected) {
    return { offset: 0.00, reason: 'match:cluster_detected' };
  }
  // FBA vs FBM — Prime advantage is enough
  if (ctx.myFulfillment === 'FBA' && ctx.buyboxSellerType === 'FBM') {
    return { offset: 0.00, reason: 'match:fba_vs_fbm' };
  }
  if (ctx.targetPrice >= 100) {
    return { offset: 0.00, reason: 'match:high_price_item' };
  }

  // ── Default: undercut is safer ──
  return { offset: 0.01, reason: 'undercut:default' };
}

// Build raise offset context from the evaluation state
function buildRaiseOffsetContext(context: PricingContext, smartProfile: string): RaiseOffsetContext {
  const intel = context.intelligence;
  const bbLossDuration = (intel as any).bbLossDurationMinutes ?? 0;
  return {
    isBuyboxOwner: context.isBuyboxOwner || context.smartRaise.isBuyboxOwner,
    buyboxLost: !context.isBuyboxOwner && !context.smartRaise.isBuyboxOwner && bbLossDuration > 0,
    bbRecoveryMode: (intel as any).bbRecoveryEscalation > 0,
    myFulfillment: context.yourFulfillmentType,
    buyboxSellerType: context.buyboxSellerType,
    clusterDetected: context.smartRaise.isInPriceCluster,
    targetPrice: context.currentPrice ?? 0,
    fbaCompetitorCount: intel.fbaCompetitorCount,
    isOnlySeller: context.isOnlySeller,
    isMonopoly: intel.fbaCompetitorCount === 0 && !context.isOnlySeller,
    smartProfile,
  };
}

// Apply raise offset: returns competitor price minus the conditional offset
function applyRaiseOffset(competitorPrice: number, offsetResult: { offset: number; reason: string }): number {
  return Math.round((competitorPrice - offsetResult.offset) * 100) / 100;
}

interface ProfitRaiseProtectionContext {
  currentPrice: number;
  isBuyboxOwner: boolean;
  inPriceCluster: boolean;
  rawLowestPrice: number | null;
}

function getProfitRaiseProtection(context: ProfitRaiseProtectionContext): {
  isAllowed: boolean;
  hasCompetitorAtOrBelowCurrent: boolean;
  blockers: string[];
} {
  const hasCompetitorAtOrBelowCurrent = context.rawLowestPrice != null
    && context.rawLowestPrice <= context.currentPrice + 0.005;
  const blockers: string[] = [];

  if (!context.isBuyboxOwner) {
    blockers.push('buybox_not_owned');
  }
  if (context.inPriceCluster) {
    blockers.push('price_cluster');
  }
  if (hasCompetitorAtOrBelowCurrent) {
    blockers.push('competitor_at_or_below_current');
  }

  return {
    isAllowed: blockers.length === 0,
    hasCompetitorAtOrBelowCurrent,
    blockers,
  };
}

function suppressUnsafeMinSuggestions(result: PricingResult, context: PricingContext): PricingResult {
  if (!result.requiresMinPriceLower || result.suggestedNewMinPrice == null) {
    return result;
  }

  const currentPrice = context.currentPrice;
  const lowestFbaPrice = context.lowestFbaPrice;
  const isBuyboxOwner = Boolean(context.smartRaise.isBuyboxOwner);
  const isComparable = currentPrice != null && lowestFbaPrice != null && lowestFbaPrice > 0;
  const isAlreadyLowestFba = isComparable ? currentPrice <= lowestFbaPrice + 0.01 : false;
  const isAboveLowestFba = isComparable ? currentPrice > lowestFbaPrice + 0.01 : false;
  const gapToLowestFbaPct = isComparable
    ? (Math.abs(currentPrice - lowestFbaPrice) / lowestFbaPrice) * 100
    : null;

  // ── REVISED LOGIC (v2) ──────────────────────────────────────────────
  // Previously, BB loss SUPPRESSED suggestions. This was backwards:
  // auto-floor is specifically designed to help when LOSING the BB.
  //
  // New policy:
  //   ALLOW suggestions when losing BB (the auto-floor system will
  //   enforce ROI/profit guards downstream at line ~3930).
  //   Only suppress UPWARD suggestions in losing/risky positions.
  // ────────────────────────────────────────────────────────────────────

  let blockReason: string | null = null;

  if (isBuyboxOwner && isAlreadyLowestFba) {
    // Owning BB & already lowest — no need to lower floor
    blockReason = 'already_winning';
  } else if (isBuyboxOwner && !isAboveLowestFba && gapToLowestFbaPct != null && gapToLowestFbaPct < 3) {
    // Owning BB with close gap — hold position
    blockReason = 'close_gap_holding_bb';
  }
  // NOTE: !isBuyboxOwner is now ALLOWED through (the whole point of auto-floor)
  // NOTE: isAboveLowestFba when losing BB is ALLOWED (need to compete)

  if (!blockReason) {
    console.log(
      `[MIN_SUGGESTION] ALLOWED: bb_owner=${isBuyboxOwner}, current=$${currentPrice?.toFixed(2) ?? 'null'}, lowest_fba=$${lowestFbaPrice?.toFixed(2) ?? 'null'}, suggested_min=$${result.suggestedNewMinPrice.toFixed(2)}`
    );
    return result;
  }

  const guardsApplied = [...(result.guardsApplied || [])];
  if (!guardsApplied.includes('MIN_PRICE_SUGGESTION_SUPPRESSED')) {
    guardsApplied.push('MIN_PRICE_SUGGESTION_SUPPRESSED');
  }
  const guardTag = `suggestion_block_${blockReason}`;
  if (!guardsApplied.includes(guardTag)) {
    guardsApplied.push(guardTag);
  }

  console.log(
    `[MIN_SUGGESTION] suppressed=${blockReason}, current=$${currentPrice?.toFixed(2) ?? 'null'}, lowest_fba=$${lowestFbaPrice?.toFixed(2) ?? 'null'}, suggested_min=$${result.suggestedNewMinPrice.toFixed(2)}`
  );

  return {
    ...result,
    guardsApplied,
    requiresMinPriceLower: false,
    suggestedNewMinPrice: undefined,
    minGapAmount: undefined,
    minGapPercent: undefined,
  };
}

// === CLUSTER-BASED COMPETITIVE PRICING ===
// Detects price clusters among competitors to avoid chasing outlier low prices
// Returns the dominant cluster price band and whether the lowest offer is an outlier
interface ClusterAnalysis {
  clusters: { median: number; count: number; range: [number, number] }[];
  dominantClusterMedian: number | null;
  lowestIsOutlier: boolean;
  outlierGap: number; // gap between outlier and cluster ($)
  outlierGapPct: number; // gap as percentage
  clusterAnchorPrice: number | null; // recommended anchor (cluster bottom or lowest if no outlier)
}

function analyzeCompetitorClusters(offers: any[]): ClusterAnalysis {
  const result: ClusterAnalysis = {
    clusters: [],
    dominantClusterMedian: null,
    lowestIsOutlier: false,
    outlierGap: 0,
    outlierGapPct: 0,
    clusterAnchorPrice: null,
  };
  
  const prices = offers
    .map(o => o.total_price || o.price || 0)
    .filter(p => p > 0)
    .sort((a, b) => a - b);
  
  if (prices.length < 3) {
    // Not enough data for cluster analysis
    result.clusterAnchorPrice = prices[0] || null;
    return result;
  }
  
  // Simple cluster detection: group prices within 3% or $0.50 of each other
  const clusters: number[][] = [];
  let currentCluster: number[] = [prices[0]];
  
  for (let i = 1; i < prices.length; i++) {
    const prevPrice = prices[i - 1];
    const currPrice = prices[i];
    const gap = currPrice - prevPrice;
    const gapPct = prevPrice > 0 ? (gap / prevPrice) * 100 : 0;
    
    // Same cluster if within 3% AND $0.50
    if (gapPct <= 3 && gap <= 0.50) {
      currentCluster.push(currPrice);
    } else {
      clusters.push(currentCluster);
      currentCluster = [currPrice];
    }
  }
  clusters.push(currentCluster);
  
  // Build cluster info
  result.clusters = clusters.map(c => ({
    median: c[Math.floor(c.length / 2)],
    count: c.length,
    range: [c[0], c[c.length - 1]] as [number, number],
  }));
  
  // Find dominant cluster (most sellers)
  const dominant = result.clusters.reduce((a, b) => b.count > a.count ? b : a, result.clusters[0]);
  result.dominantClusterMedian = dominant.median;
  
  // Check if lowest price is an outlier (alone in its cluster AND far from dominant)
  const lowestCluster = result.clusters[0];
  if (lowestCluster.count === 1 && result.clusters.length >= 2) {
    const nextCluster = result.clusters[1];
    const gap = nextCluster.range[0] - lowestCluster.range[0];
    const gapPct = lowestCluster.range[0] > 0 ? (gap / lowestCluster.range[0]) * 100 : 0;
    
    // Outlier: single seller > 3% or > $0.75 below the next cluster
    if (gapPct > 3 || gap > 0.75) {
      result.lowestIsOutlier = true;
      result.outlierGap = Math.round(gap * 100) / 100;
      result.outlierGapPct = Math.round(gapPct * 10) / 10;
      // Use bottom of next cluster as anchor instead of the outlier
      result.clusterAnchorPrice = nextCluster.range[0];
    } else {
      result.clusterAnchorPrice = lowestCluster.range[0];
    }
  } else {
    result.clusterAnchorPrice = lowestCluster?.range[0] || null;
  }
  
  return result;
}

// === TIME-BASED AGGRESSION ===
// Returns a multiplier based on current hour (Pacific Time / Amazon business hours)
function getTimeBasedAggressionMultiplier(): { multiplier: number; tag: string | null } {
  const now = new Date();
  // Pacific Time offset (PST = -8, PDT = -7; approximate with -8)
  const pacificOffset = -8 * 60;
  const pacificTime = new Date(now.getTime() + (pacificOffset + now.getTimezoneOffset()) * 60000);
  const hour = pacificTime.getHours();
  
  // Peak buying hours: 9 AM - 9 PM PT → slightly more aggressive
  if (hour >= 9 && hour < 21) {
    return { multiplier: 1.05, tag: `PEAK_HOURS(${hour}PT)` };
  }
  // Off-peak: 9 PM - 6 AM PT → more conservative (less competition, hold margins)
  if (hour >= 21 || hour < 6) {
    return { multiplier: 0.90, tag: `OFF_PEAK(${hour}PT)` };
  }
  // Early morning: 6 AM - 9 AM PT → neutral transition
  return { multiplier: 1.0, tag: null };
}

// Filter competitors by quality before pricing - this cleans inputs and eliminates noise
// Returns detailed debug counters for logging: found, removed_by_rating, removed_by_handling, etc.
function filterCompetitorsByQuality(
  offers: any[],
  settings: CompetitorQualitySettings,
  marketplace: string
): { 
  filtered: any[]; 
  excluded: number; 
  reasons: string[];
  debug: {
    competitors_found: number;
    removed_low_rating: number;
    removed_handling: number;
    removed_ships_from: number;
    removed_top_n_tail: number;
    competitors_used: number;
    // NEW: Track unknown/missing data counts
    unknown_rating: number;
    unknown_handling: number;
    unknown_ships_from: number;
  };
  clusterAnalysis?: any;
} {
  const reasons: string[] = [];
  let filtered = [...offers];
  const initialCount = filtered.length;
  
  // Debug counters - now includes unknown_* for missing data visibility
  const debug = {
    competitors_found: initialCount,
    removed_low_rating: 0,
    removed_handling: 0,
    removed_ships_from: 0,
    removed_top_n_tail: 0,
    competitors_used: 0,
    unknown_rating: 0,
    unknown_handling: 0,
    unknown_ships_from: 0,
  };

  // 1. Filter by seller rating
  // MISSING DATA POLICY (CONSERVATIVE): If rating is missing, default to minSellerRating (barely passes)
  // This prevents unknown sellers from being treated as "perfect 100%" and distorting the anchor
  if (settings.minSellerRating > 0) {
    const beforeCount = filtered.length;
    filtered = filtered.filter(o => {
      const rawRating = o.seller_rating ?? o.positive_rating ?? o.positive_feedback_rating ?? o.rating;
      
      // Track unknowns for debugging
      if (rawRating === null || rawRating === undefined) {
        debug.unknown_rating++;
      }
      
      // CONSERVATIVE DEFAULT: missing rating = minSellerRating (barely passes, not "perfect 100")
      const rating = rawRating ?? settings.minSellerRating;
      return rating >= settings.minSellerRating;
    });
    debug.removed_low_rating = beforeCount - filtered.length;
    if (debug.removed_low_rating > 0) {
      reasons.push(`rating<${settings.minSellerRating}%: ${debug.removed_low_rating}`);
    }
  }

  // 2. Filter by handling time
  // CRITICAL: Parse ranges like "0 to 8 days" → 8 (use MAX for conservative filtering)
  // MISSING DATA POLICY (CONSERVATIVE): If handling is missing, default to maxHandlingDays (barely passes)
  // This prevents unknown handling sellers from being treated as "fastest 0 days" and becoming anchors
  if (settings.maxHandlingDays > 0) {
    const beforeCount = filtered.length;
    filtered = filtered.filter(o => {
      // Try multiple field names and parse ranges
      const rawHandling = o.handling_days ?? o.max_handling_time ?? o.handling_time;
      const handlingDays = parseHandlingDays(rawHandling);
      
      // Track unknowns for debugging
      if (handlingDays === null) {
        debug.unknown_handling++;
      }
      
      // CONSERVATIVE DEFAULT: missing handling = maxHandlingDays (barely passes, not "fastest 0")
      const effectiveHandling = handlingDays ?? settings.maxHandlingDays;
      return effectiveHandling <= settings.maxHandlingDays;
    });
    debug.removed_handling = beforeCount - filtered.length;
    if (debug.removed_handling > 0) {
      reasons.push(`handling>${settings.maxHandlingDays}d: ${debug.removed_handling}`);
    }
  }

  // 3. Filter by ships-from location
  // MISSING DATA POLICY: If ships_from is missing/empty:
  //   - US_ONLY: EXCLUDE (conservative - assume foreign)
  //   - DOMESTIC: EXCLUDE (conservative)
  //   - ANY: INCLUDE
  // 3. Filter by ships-from location
  // First, count unknowns (even for ANY mode, for visibility)
  for (const o of filtered) {
    const shipsFrom = (o.ships_from || o.ship_from_country || o.country || '').toUpperCase().trim();
    if (shipsFrom === '') {
      debug.unknown_ships_from++;
    }
  }
  
  if (settings.shipsFromFilter !== 'ANY') {
    const beforeCount = filtered.length;
    filtered = filtered.filter(o => {
      const shipsFrom = (o.ships_from || o.ship_from_country || o.country || '').toUpperCase().trim();
      
      if (settings.shipsFromFilter === 'US_ONLY') {
        // Only include if explicitly US (ambiguous/missing = exclude for safety)
        if (shipsFrom === '') return false; // MISSING = exclude
        return shipsFrom === 'US' || shipsFrom === 'UNITED STATES' || shipsFrom === 'USA';
      }
      if (settings.shipsFromFilter === 'DOMESTIC') {
        // Domestic = same country as marketplace
        const marketplaceCountry = marketplace === 'US' ? 'US' : 
                                   marketplace === 'CA' ? 'CA' : 
                                   marketplace === 'MX' ? 'MX' : 
                                   marketplace === 'BR' ? 'BR' : '';
        if (shipsFrom === '') return false; // MISSING = exclude
        // Normalize country names
        const normalizedShipsFrom = shipsFrom === 'UNITED STATES' ? 'US' :
                                    shipsFrom === 'USA' ? 'US' :
                                    shipsFrom === 'CANADA' ? 'CA' :
                                    shipsFrom === 'MEXICO' ? 'MX' :
                                    shipsFrom === 'BRAZIL' ? 'BR' :
                                    shipsFrom === 'BRASIL' ? 'BR' : shipsFrom;
        return normalizedShipsFrom === marketplaceCountry;
      }
      return true;
    });
    debug.removed_ships_from = beforeCount - filtered.length;
    if (debug.removed_ships_from > 0) {
      reasons.push(`ships-from: ${debug.removed_ships_from}`);
    }
  }

  // 4. Limit to Top N competitors (after quality filtering)
  // SORT BY LANDED PRICE (total_price = price + shipping) - this is what BQool does
  if (settings.topNCompetitors > 0 && filtered.length > settings.topNCompetitors) {
    filtered.sort((a, b) => (a.total_price || a.price || 999) - (b.total_price || b.price || 999));
    debug.removed_top_n_tail = filtered.length - settings.topNCompetitors;
    filtered = filtered.slice(0, settings.topNCompetitors);
    if (debug.removed_top_n_tail > 0) {
      reasons.push(`top-${settings.topNCompetitors}: ${debug.removed_top_n_tail} tail`);
    }
  }

  debug.competitors_used = filtered.length;

  return {
    filtered,
    // === CLUSTER ANALYSIS: detect price clusters vs outliers ===
    clusterAnalysis: analyzeCompetitorClusters(filtered),
    excluded: initialCount - filtered.length,
    reasons,
    debug,
  };
}

interface PricingContext {
  asin: string;
  currentPrice: number | null;
  buyboxPrice: number | null;
  buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | 'unknown' | null;
  isBuyboxOwner: boolean;
  lowestFbaPrice: number | null;
  lowestFbmPrice: number | null;
  lowestOverallPrice: number | null;
  qualifyingFbaCompetitorCount?: number | null;
  fbmOfferCount?: number | null;
  offersCount: number;
  isOnlySeller: boolean;
  isBuyboxEligible: boolean;
  isBuyboxSuppressed: boolean;
  isBackordered: boolean;
  conditionIsUsed: boolean;
  minPrice: number | null;
  maxPrice: number | null;
  undercutAmount: number;
  // SUPPRESSED BUY BOX UNDERCUT — per-rule undercut applied ONLY when the Buy Box
  // is suppressed. There is no default: the user must set this field explicitly.
  // Set to 0 to match the lowest valid competitor exactly. Positive values undercut.
  // This overrides the legacy density-based suppressed-BB minimum undercut.
  // null = user has not set it. Suppressed-BB pricing path is SKIPPED entirely
  // when null (no implicit default). 0 = match exactly. Positive = undercut.
  suppressedBbUndercut: number | null;
  // MATCH EXACTLY — true whenever undercutAmount is exactly 0 (the rule's
  // undercut_amount is the sole source of truth for this; there is no
  // separate strict-match flag anymore). Forces final price to match anchor
  // exactly: disables ALL undercut multipliers, AI tuning undercut
  // adjustments, intel boosters, suppressed-BB minimum-undercut overrides,
  // and aggressive oscillation-mode undercut bumps. Also lets a corrective
  // raise back to the anchor bypass cooldown (rule compliance ≠ aggressive move).
  matchExactly: boolean;
  maxStepAmount: number;
  maxStepPercent: number;
  cooldownMinutes: number;
  // Asymmetric-cooldown override (MOMENTUM_SMART preset). null = not set,
  // engine falls back to the single cooldownMinutes value above for every
  // tier, matching every other preset's existing behavior unchanged.
  cooldownMinutesLosingBb: number | null;
  cooldownMinutesWinningBb: number | null;
  competitorDropCount: number;
  competitorDropBuckets: { recent0_10: number; recent10_30: number; recent30_60: number };
  recentDownwardMoves: { count: number; totalDelta: number }; // drop budget tracking
  isPriority: boolean;
  lastRepricedAt: string | null;
  competeWithAmazon: boolean;
  competeWithFba: boolean;
  competeWithFbm: boolean;
  fbmPremiumPercent: number;
  fbmPremiumFixed: number;
  yourFulfillmentType: 'FBA' | 'FBM' | null;
  yourSellerId: string | null;
  targetAnchor: 'buybox' | 'lowest_fba' | 'lowest_offer' | 'smart' | 'smart_recapture';
  useAiTuning: boolean;
  stockGatedMaximize?: boolean;
  // New intelligence factors
  intelligence: IntelligenceFactors;
  // Profit Guard context
  profitGuard: {
    unitCost: number | null;
    localCost: number | null;
    referralRate: number;
    fbaFeeFixed: number;
    estimatedFees: number | null;
    minProfitDollars: number | null;
    minRoiPercent: number | null;
    minRoiPercentBase?: number | null;
    minRoiPercentHighRisk?: number | null;
    minRoiEnabled?: boolean;
    includeFeesInFloor: boolean;
    globalAbsoluteFloor: number;
    profitFloorPrice: number | null;
    mode: 'strict' | 'respect_min_max' | 'off';
    [key: string]: any;
  };
  // Smart Raise context
  smartRaise: {
    enabled: boolean;
    triggerPercent: number;
    maxRaiseStepDollars: number;
    maxRaiseStepPercent: number;
    onlyRaiseWhenBuyboxOwner: boolean;
    previousBuyboxPrice: number | null;
    isBuyboxOwner: boolean;
    // Rolling window: historical BB prices at different intervals
    rollingBuyboxPrices: {
      price30min: number | null;
      price2hr: number | null;
      price6hr: number | null;
    };
    // Rolling window: historical lowest-FBA (competitor floor) prices at the
    // SAME intervals as rollingBuyboxPrices, used only when
    // requireMarketSupportedRaise is true (MOMENTUM_SMART) to confirm a BB
    // price rise is backed by the actual competitor floor also rising, not
    // just a Buy Box price move no competitor is really following.
    rollingLowestFbaPrices: {
      price30min: number | null;
      price2hr: number | null;
      price6hr: number | null;
    };
    // MOMENTUM_SMART gate: require the competitor floor to have risen
    // alongside the Buy Box before enable_smart_raise fires.
    requireMarketSupportedRaise: boolean;
    // V2: null = "floor rose at all" (original behavior). Set = floor's rise
    // must be at least this fraction of the Buy Box's rise at the same
    // reference point (e.g. 0.5 = floor must cover at least half the BB's
    // move) -- filters out a BB price drift with no real competitor backing.
    minFloorSupportRatio: number | null;
    // V2: null = no cooldown (original behavior). Set = block another raise
    // attempt on this assignment for this many hours after ANY raise,
    // regardless of outcome -- read alongside lastRaiseAt below.
    postRaiseCooldownHours: number | null;
    lastRaiseAt: string | null;
    // Gap-close percentage (0-1, e.g. 0.15 = close 15% of gap per cycle)
    gapCloseRatio: number;
    // Lowest eligible competitor price (for raise-at-buybox detection)
    lowestEligibleCompetitorPrice: number | null;
    // Whether the eligible competitor lane is FBM-only (FBM seller with FBM competition)
    isEligibleLaneFbmOnly?: boolean;
    // Cluster detection: multiple sellers at same lowest price
    isInPriceCluster: boolean;
    clusterSellerCount: number;
    // Hard safety ceiling above Buy Box (null = disabled)
    maxRaiseAboveBuyboxPercent: number | null;
  };
  // Buy Box Owner Protection
  skipLowerWhenBbOwner: boolean;
  // Monopoly Mode context
  monopolyMode: {
    enabled: boolean;
    raiseStepDollars: number;
    raiseStepPercent: number;
    cooldownMinutes: number;
    mode: 'conservative' | 'aggressive';
  };
  // FBM handling
  ignoreFbmUnlessBuyboxOwner: boolean;
  fbmCompetitionMode?: 'fba_priority' | 'all_sellers' | 'lowest_seller';
  // Competitor quality filtering (NEW - beats BQool)
  competitorQuality: CompetitorQualitySettings;
  marketplace: string;
  currencyCode: string;
  _bbSource: 'winner_offer' | 'summary_fallback' | 'missing';
  // BB loss tracking for raise softening
  bbLossAfterRaiseCount: number;
  // Manual eval signals — used for cooldown bypass diagnostics + force-raise mode.
  triggerSource?: string | null;
  forceMode?: 'smart_raise' | null;
}

interface PricingResult {
  mode: 'DO_NOT_REPRICE' | 'MIN_PRICE' | 'CUSTOM_PRICE' | 'AI_REPRICE' | 'SMART_RAISE' | 'MONOPOLY_RAISE' | 'SKIP' | 'LOWER' | 'HOLD' | string;
  newPrice: number | null;
  rawTargetPrice: number | null;
  reason: string;
  aiAggressiveness?: number;
  aiNote?: string;
  guardsApplied: string[];
  requiresMinPriceLower?: boolean;
  suggestedNewMinPrice?: number;
  effectiveFloor?: number;
  userMinFloor?: number;
  effectiveProfitFloor?: number | null;
  effectiveFloorSource?: 'user_min' | 'roi_profit' | 'both_equal' | 'none';
  currentPriceFloorLock?: boolean;
  minGapAmount?: number;
  minGapPercent?: number;
  intelligenceFactors?: IntelligenceFactors;
  blockedByProfitGuard?: boolean;
  profitFloorUsed?: number;
  isRaise?: boolean; // Flag to indicate this is a price raise
  anchorDiagnostics?: any;
  [key: string]: any;
}

// Calculate intelligence-based aggressiveness multiplier
function calculateIntelligenceMultiplier(intel: IntelligenceFactors, rule: any): { multiplier: number; factors: string[] } {
  let multiplier = 1.0;
  const factors: string[] = [];

  // === Sales Velocity Factor (now uses weighted ADS) ===
  if (intel.salesVelocityScore < 30) {
    multiplier += 0.3;
    factors.push(`Low velocity (${intel.salesVelocityScore}%) +30%`);
  } else if (intel.salesVelocityScore < 50) {
    multiplier += 0.15;
    factors.push(`Below-avg velocity (${intel.salesVelocityScore}%) +15%`);
  } else if (intel.salesVelocityScore > 80) {
    multiplier -= 0.2;
    factors.push(`Strong velocity (${intel.salesVelocityScore}%) -20%`);
  }

  // === Buy Box Win Rate Factor (ENHANCED: BB Loss Recovery Mode) ===
  // Duration-based escalation: the longer we lose BB, the more aggressive we get
  const bbLossDurationMin = (intel as any).bbLossDurationMinutes ?? 0;
  const bbRecoveryEscalation = (intel as any).bbRecoveryEscalation ?? 0;
  
  if (intel.buyboxWinRate < 20) {
    // Base: low win rate boost
    let bbBoost = 0.25;
    // BB LOSS RECOVERY: escalate based on loss duration
    if (bbLossDurationMin > 120) {
      bbBoost = 0.40; // 2+ hours losing → very aggressive
      factors.push(`BB_RECOVERY_MODE(duration=${Math.round(bbLossDurationMin)}m, escalation=3) +40%`);
    } else if (bbLossDurationMin > 60) {
      bbBoost = 0.35; // 1-2 hours losing → aggressive
      factors.push(`BB_RECOVERY_MODE(duration=${Math.round(bbLossDurationMin)}m, escalation=2) +35%`);
    } else if (bbLossDurationMin > 30) {
      bbBoost = 0.30; // 30-60 min losing → moderate boost
      factors.push(`BB_RECOVERY_MODE(duration=${Math.round(bbLossDurationMin)}m, escalation=1) +30%`);
    } else {
      factors.push(`Low BB win rate (${intel.buyboxWinRate}%) +25%`);
    }
    multiplier += bbBoost;
  } else if (intel.buyboxLossStreak >= 3) {
    // Loss streak with duration-based escalation
    let streakBoost = 0.2;
    if (bbLossDurationMin > 60 && intel.buyboxLossStreak >= 5) {
      streakBoost = 0.35;
      factors.push(`BB_RECOVERY_MODE(streak=${intel.buyboxLossStreak}, duration=${Math.round(bbLossDurationMin)}m) +35%`);
    } else if (bbLossDurationMin > 30) {
      streakBoost = 0.25;
      factors.push(`BB loss streak (${intel.buyboxLossStreak}) + recovery boost +25%`);
    } else {
      factors.push(`BB loss streak (${intel.buyboxLossStreak}) +20%`);
    }
    multiplier += streakBoost;
  } else if (intel.buyboxWinRate > 80 && intel.buyboxWinStreak >= 2) {
    multiplier -= 0.15;
    factors.push(`Strong BB control (${intel.buyboxWinRate}%) -15%`);
  }

  // === Competitor Stock Factor ===
  if (intel.competitorStockSignal === 'LOW') {
    multiplier -= 0.25;
    factors.push('Competitor low stock -25%');
  } else if (intel.competitorStockSignal === 'HIGH') {
    multiplier += 0.1;
    factors.push('Competitor high stock +10%');
  }
  
  if (intel.amazonSelling) {
    multiplier += 0.15;
    factors.push('Amazon selling +15%');
  }

  // === Time on Market / Urgency Factor ===
  if (intel.urgencyScore > 80) {
    multiplier += 0.3;
    factors.push(`High urgency (${intel.urgencyScore}) +30%`);
  } else if (intel.urgencyScore > 60) {
    multiplier += 0.15;
    factors.push(`Medium urgency (${intel.urgencyScore}) +15%`);
  } else if (intel.daysWithoutSale > 14) {
    multiplier += 0.2;
    factors.push(`No sale ${intel.daysWithoutSale}d +20%`);
  }

  // === YOUR STOCK / Days-of-Stock Aggression Modifier (NEW) ===
  // Only apply if stock overlay is enabled in the rule AND we have valid data
  const stockOverlayEnabled = rule?.stock_overlay_enabled ?? false;
  
  if (stockOverlayEnabled && intel.stockAggressionModifier !== 1.0 && intel.yourDaysOfStock !== null) {
    // Apply as multiplicative modifier
    multiplier *= intel.stockAggressionModifier;
    const modPct = Math.round((intel.stockAggressionModifier - 1) * 100);
    const sign = modPct >= 0 ? '+' : '';
    factors.push(`STOCK_OVERLAY(daysOfStock=${Math.round(intel.yourDaysOfStock)}, mod=${intel.stockAggressionModifier.toFixed(2)}) ${sign}${modPct}%`);
  }

  // === TIME-BASED AGGRESSION (NEW) ===
  const timeAggression = getTimeBasedAggressionMultiplier();
  if (timeAggression.tag) {
    multiplier *= timeAggression.multiplier;
    const modPct = Math.round((timeAggression.multiplier - 1) * 100);
    const sign = modPct >= 0 ? '+' : '';
    factors.push(`${timeAggression.tag} ${sign}${modPct}%`);
  }

  // Clamp multiplier — allow up to 1.8 during BB recovery mode for faster recapture
  const maxMultiplier = bbLossDurationMin > 60 ? 1.8 : 1.5;
  multiplier = Math.max(0.5, Math.min(maxMultiplier, multiplier));

  return { multiplier, factors };
}

// Core deterministic pricing logic with intelligence
function computeAiWinSalesBoosterPrice(
  context: PricingContext,
  rule: any,
  offers: any[]
): PricingResult {
  const guardsApplied: string[] = [];
  if (context.matchExactly) {
    guardsApplied.push('strict_match_mode_active');
  }
    const { 
    currentPrice, buyboxPrice, buyboxSellerType, lowestFbaPrice, lowestFbmPrice,
    lowestOverallPrice, offersCount, isOnlySeller, isBuyboxEligible, isBuyboxSuppressed,
    isBackordered, conditionIsUsed, minPrice, maxPrice, undercutAmount,
    maxStepAmount, maxStepPercent, competeWithAmazon, competeWithFba, competeWithFbm,
    lastRepricedAt, cooldownMinutes, cooldownMinutesLosingBb, cooldownMinutesWinningBb, intelligence, smartRaise, stockGatedMaximize
  } = context;
    const money = (amount: number | null | undefined) => formatMoney(amount, context.currencyCode || 'USD');

  const anchorDiagnostics: {
    raw_lowest_fba: number | null;
    filtered_lowest_fba: number | null;
    selected_anchor: string;
    override_reason: string | null;
    enforced_target: number | null;
    final_output_price: number | null;
    ai_override_after_enforcement: boolean;
    post_enforcement_override_reason: string | null;
  } = {
    raw_lowest_fba: lowestFbaPrice ?? null,
    filtered_lowest_fba: null,
    selected_anchor: context.targetAnchor || 'smart',
    override_reason: null,
    enforced_target: null,
    final_output_price: null,
    ai_override_after_enforcement: false,
    post_enforcement_override_reason: null,
  };

  // ═══ RAISE OFFSET: Compute once, use across all raise paths ═══
  const _raiseSmartProfile = rule.smart_profile || 'CUSTOM';
  const _raiseOffsetCtx = buildRaiseOffsetContext(context, _raiseSmartProfile);
  const _raiseOffset = computeRaiseOffset(_raiseOffsetCtx);
  // Tag will be added to guardsApplied on any raise path that fires
  const _raiseOffsetGuard = `raise_offset_${_raiseOffset.reason}`;

  // FBM market-awareness anchor: quality filters may exclude low FBM offers from
  // execution, but an FBM-owned listing must still know when a lower FBM peer exists.
  const externalOfferPrice = (o: any): number | null => {
    const price = Number(o?.total_price ?? o?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  };
  const conditionMatchesListing = (o: any): boolean => {
    const condition = o?.condition == null ? '' : String(o.condition).toLowerCase();
    if (conditionIsUsed) return !condition || condition.includes('used');
    return !condition || condition !== 'used';
  };
  const rawExternalFbmPrices = offers
    .filter((o: any) => !o.is_self && !(context.yourSellerId && o.seller_id === context.yourSellerId))
    .filter((o: any) => o.is_fba === false && conditionMatchesListing(o))
    .map(externalOfferPrice)
    .filter((p): p is number => p != null)
    .sort((a, b) => a - b);
  const rawLowestExternalFbmPrice = rawExternalFbmPrices[0] ?? null;
  const inferredFbmFromOverall = (
    lowestOverallPrice && lowestOverallPrice > 0 &&
    lowestFbaPrice && lowestFbaPrice > 0 &&
    lowestOverallPrice < lowestFbaPrice - 0.005
  ) ? lowestOverallPrice : null;
  // RULE-MODE GATING: the FBM-cohort competition fixes apply primarily in
  // "All Sellers (Aggressive) — Treat FBM Same as FBA" mode
  // (rule.ignore_fbm_unless_buybox_owner === false). In "FBA Priority — Ignore
  // FBM Unless They Own Buy Box" mode, FBM peers are intentionally ignored
  // UNLESS one of them owns the Buy Box.
  // Three-way FBM Competition Mode (new): fba_priority | all_sellers | lowest_seller
  // Falls back to legacy boolean when column is null.
  const fbmCompetitionMode: 'fba_priority' | 'all_sellers' | 'lowest_seller' =
    (context as any)?.fbmCompetitionMode === 'lowest_seller' ? 'lowest_seller'
    : (context as any)?.fbmCompetitionMode === 'all_sellers' ? 'all_sellers'
    : (context as any)?.fbmCompetitionMode === 'fba_priority' ? 'fba_priority'
    : (rule as any)?.fbm_competition_mode === 'lowest_seller' ? 'lowest_seller'
    : (rule as any)?.fbm_competition_mode === 'all_sellers' ? 'all_sellers'
    : (rule as any)?.fbm_competition_mode === 'fba_priority' ? 'fba_priority'
    : ((rule as any)?.ignore_fbm_unless_buybox_owner === false ? 'all_sellers' : 'fba_priority');
  const lowestSellerMode = fbmCompetitionMode === 'lowest_seller';
  const ignoreFbmRule = fbmCompetitionMode === 'fba_priority';
  const userWantsAllSellers = fbmCompetitionMode === 'all_sellers' || fbmCompetitionMode === 'lowest_seller';
  const fbmOwnsBuyBox = (context as any)?.buyboxSellerType === 'FBM';
  const respectFbmCohort = !ignoreFbmRule || fbmOwnsBuyBox;
  const explicitFbmAnchorPrice = rawLowestExternalFbmPrice
    ?? (lowestFbmPrice && lowestFbmPrice > 0 ? lowestFbmPrice : null)
    ?? (fbmOwnsBuyBox && buyboxPrice && buyboxPrice > 0 ? buyboxPrice : null)
    ?? inferredFbmFromOverall;
  const fbmMarketAnchorPrice = (context.yourFulfillmentType === 'FBM' && respectFbmCohort)
    ? explicitFbmAnchorPrice
    : null;
  const hasLowerFbmCompetitor = Boolean(
    context.yourFulfillmentType === 'FBM' &&
    respectFbmCohort &&
    currentPrice && currentPrice > 0 &&
    fbmMarketAnchorPrice && fbmMarketAnchorPrice > 0 &&
    fbmMarketAnchorPrice < currentPrice - 0.004
  );
  // V2: block stacking another raise on this assignment until there's been
  // time to observe whether the last one actually held the Buy Box.
  const postRaiseCooldown = evaluatePostRaiseCooldown({
    lastRaiseAt: smartRaise.lastRaiseAt,
    postRaiseCooldownHours: smartRaise.postRaiseCooldownHours,
  });
  // LOWEST_SELLER MODE: when our FBM listing has a lower same-fulfillment competitor,
  // hard-disable smart_raise (no eligible_gap_recovery_raise / no smart_raise / no
  // FBA fallback). The engine must always chase the lowest FBM seller using
  // fbm_undercut_amount.
  if (lowestSellerMode && context.yourFulfillmentType === 'FBM' && hasLowerFbmCompetitor && smartRaise) {
    (smartRaise as any).enabled = false;
    guardsApplied.push('lowest_seller_mode_disable_raise');
  }
  console.log(`[FBM_RULE_MODE] mode=${fbmCompetitionMode} ignore_fbm_unless_buybox_owner=${ignoreFbmRule} fbmOwnsBuyBox=${fbmOwnsBuyBox} respectFbmCohort=${respectFbmCohort} fbmMarketAnchor=${fbmMarketAnchorPrice ?? 'null'} hasLowerFbm=${hasLowerFbmCompetitor} lowestSellerMode=${lowestSellerMode}`);
  console.log(`[OFFER_TRACE] asin=${context.asin ?? 'unknown'} mode=${fbmCompetitionMode} myFulfillment=${context.yourFulfillmentType ?? 'unknown'} buybox=$${buyboxPrice?.toFixed(2) ?? 'null'}/${buyboxSellerType ?? 'null'} lowestFbm=$${lowestFbmPrice?.toFixed(2) ?? 'null'} rawExternalFbm=$${rawLowestExternalFbmPrice?.toFixed(2) ?? 'null'} lowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'} explicitFbmAnchor=$${explicitFbmAnchorPrice?.toFixed(2) ?? 'null'} offers=${offers.map((o: any) => `${o.is_self ? 'SELF' : 'EXT'}:${o.is_fba ? 'FBA' : 'FBM'}${o.is_buybox_winner ? ':BB' : ''}:$${externalOfferPrice(o)?.toFixed(2) ?? 'null'}:${o.seller_id ?? 'unknown'}`).join('|')}`);

  // ═══════════════════════════════════════════════════════════════════════
  // UNIVERSAL FLOOR GUARD — HIGHEST PRIORITY, RUNS BEFORE ALL OTHER LOGIC
  // If current price is below the effective floor (manual min or ROI floor),
  // force immediate upward correction. This cannot be blocked by cooldown,
  // BB owner hold, cluster hold, patience hold, monopoly, or any other guard.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const ufgManualMin = minPrice || 0;
    const ufgRoiFloor = context.profitGuard?.minRoiEnabled
      ? (context.profitGuard?.profitFloorPrice || 0)
      : 0;
    const ufgRoiPct = context.profitGuard?.minRoiEnabled
      ? context.profitGuard?.minRoiPercent
      : null;
    const ufgEffectiveFloor = Math.max(ufgManualMin, ufgRoiFloor);
    if (ufgEffectiveFloor > 0 && currentPrice && currentPrice < ufgEffectiveFloor - 0.005) {
      let ufgRecoveryPrice = Math.round(ufgEffectiveFloor * 100) / 100;
      if (maxPrice && ufgRecoveryPrice > maxPrice) ufgRecoveryPrice = maxPrice;
        const ufgEmergency = currentPrice < ufgEffectiveFloor * 0.7;
      const ufgFloorWinner = ufgRoiFloor > ufgManualMin ? 'ROI floor'
        : ufgManualMin > ufgRoiFloor ? 'Manual min' : 'Both equal';
      const ufgDetailParts = [`Manual min: ${money(ufgManualMin)}`];
      if (ufgRoiFloor > 0) {
        const ufgRoiLabel = ufgRoiPct != null
          ? `${money(ufgRoiFloor)} (min ROI: ${ufgRoiPct}%)`
          : money(ufgRoiFloor);
        ufgDetailParts.push(`ROI floor: ${ufgRoiLabel}`);
      }
      ufgDetailParts.push(`Effective floor: ${money(ufgEffectiveFloor)} (${ufgFloorWinner})`);
      const ufgDetail = ufgDetailParts.join(', ');
      console.log(`[UNIVERSAL FLOOR GUARD] currency=${context.currencyCode} emergency=${ufgEmergency} Price ${money(currentPrice)} is below effective floor ${money(ufgEffectiveFloor)} → forcing correction to ${money(ufgRecoveryPrice)} | ${ufgDetail}`);
      return {
        mode: 'LOWER' as const,
        newPrice: ufgRecoveryPrice,
        rawTargetPrice: ufgRecoveryPrice,
        reason: `Universal floor guard: ${money(currentPrice)} → ${money(ufgRecoveryPrice)} | ${ufgDetail}`,
        guardsApplied: ['universal_floor_guard', ...(ufgEmergency ? ['emergency_floor_guard'] : [])],
        intelligenceFactors: intelligence,
        isRaise: true,
        anchorDiagnostics,
      };
    }
  }

  const isLosingBuybox = !smartRaise.isBuyboxOwner && currentPrice && buyboxPrice && currentPrice > buyboxPrice;
  // Also detect when we're overpriced vs raw competitors (critical for suppressed BB correction)
  const rawRef = lowestFbaPrice && lowestFbaPrice > 0 ? lowestFbaPrice : lowestOverallPrice;
  const isOverpricedVsRaw = currentPrice != null && rawRef != null && rawRef > 0 && currentPrice > rawRef;
  
  // SUPPRESSED BB MICRO-GAP COOLDOWN BYPASS:
  // When BB is suppressed and we're within $0.03 of lowest competitor but NOT the lowest,
  // bypass cooldown entirely — timing is critical to win suppressed BB rotation.
  const lowestEligible = smartRaise.lowestEligibleCompetitorPrice ?? lowestFbaPrice ?? lowestOverallPrice;
  const suppressedBbMicroGapBypass = Boolean(
    isBuyboxSuppressed
    && currentPrice != null
    && lowestEligible != null
    && lowestEligible > 0
    && currentPrice > lowestEligible  // we are NOT the lowest
    && (currentPrice - lowestEligible) <= 0.03  // micro-gap
  );
  if (suppressedBbMicroGapBypass) {
    console.log(`[COOLDOWN] SUPPRESSED BB MICRO-GAP BYPASS: current=$${currentPrice!.toFixed(2)}, lowest=$${lowestEligible!.toFixed(2)}, gap=$${(currentPrice! - lowestEligible!).toFixed(2)} — bypassing cooldown for immediate undercut`);
    guardsApplied.push('suppressed_bb_cooldown_bypass');
  }

  // ADAPTIVE COOLDOWN: Context-aware cooldown based on BB status + competitor drop frequency.
  // Applied to ALL ASINs with 5 tiers + hold-once-lowest + drop budget safety.
  const dropCount = context.competitorDropCount;
  const dropBuckets = context.competitorDropBuckets;
  const isBbOwner = smartRaise.isBuyboxOwner;
  const gapToBb = (currentPrice && buyboxPrice && buyboxPrice > 0) ? Math.abs(currentPrice - buyboxPrice) : null;
  const isLosingBbClose = !isBbOwner && gapToBb !== null && gapToBb <= 0.10;
  
  // HOLD-ONCE-LOWEST: If we're already the lowest and no new competitor dropped below us,
  // don't keep cutting just because the weighted score is high.
  const weAreLowest = currentPrice != null && lowestEligible != null && currentPrice <= lowestEligible + 0.005;
  const holdOnceLowest = weAreLowest && dropBuckets.recent0_10 === 0;
  if (holdOnceLowest && dropCount > 0) {
    console.log(`[COOLDOWN] HOLD-ONCE-LOWEST: we are lowest ($${currentPrice?.toFixed(2)}) and no new drops in last 10min — preventing unnecessary further lowering`);
    guardsApplied.push('hold_once_lowest');
  }
  
  // DROP BUDGET: Max 4 downward changes in 15 min OR $0.20 total downward movement.
  // If exceeded, force a 3-min cooldown floor to prevent spiral.
  const dropBudget = context.recentDownwardMoves;
  const DROP_BUDGET_MAX_COUNT = 4;
  const DROP_BUDGET_MAX_DELTA = 0.20;
  const dropBudgetExceeded = dropBudget.count >= DROP_BUDGET_MAX_COUNT || dropBudget.totalDelta >= DROP_BUDGET_MAX_DELTA;
  if (dropBudgetExceeded) {
    console.log(`[COOLDOWN] DROP BUDGET EXCEEDED: ${dropBudget.count} drops / $${dropBudget.totalDelta.toFixed(2)} in 15min (limits: ${DROP_BUDGET_MAX_COUNT} moves / $${DROP_BUDGET_MAX_DELTA}) — enforcing 3min floor`);
    guardsApplied.push('drop_budget_cap');
  }
  
  let adaptiveCooldownMinutes: number;
  let cooldownTier: string;
  // MOMENTUM_SMART asymmetric baseline: react fast while losing the Buy Box
  // (defense), slow while holding it (no reason to disturb a profitable
  // position). Only overrides the *baseline* each tier falls back to when
  // recent competitor-drop activity is low (dropCount < 3) — the existing
  // drop-count acceleration above still applies on top unchanged.
  const losingBbBaseline = cooldownMinutesLosingBb ?? cooldownMinutes;
  const winningBbBaseline = cooldownMinutesWinningBb ?? cooldownMinutes;

  if (isBuyboxSuppressed) {
    adaptiveCooldownMinutes = dropCount >= 10 ? 0 : dropCount >= 6 ? 0.5 : dropCount >= 3 ? 1 : Math.min(losingBbBaseline, 3);
    cooldownTier = 'suppressed_bb';
  } else if (isLosingBbClose) {
    adaptiveCooldownMinutes = dropCount >= 10 ? 0 : dropCount >= 6 ? 0.5 : dropCount >= 3 ? 1 : Math.min(losingBbBaseline, 3);
    cooldownTier = 'losing_bb_close';
  } else if (isLosingBuybox) {
    adaptiveCooldownMinutes = dropCount >= 10 ? 1 : dropCount >= 6 ? 2 : dropCount >= 3 ? 3 : losingBbBaseline;
    cooldownTier = 'losing_bb_far';
  } else if (isBbOwner) {
    const rawAdaptive = dropCount >= 10 ? 1 : dropCount >= 6 ? 2 : dropCount >= 3 ? 3 : winningBbBaseline;
    adaptiveCooldownMinutes = Math.max(rawAdaptive, 1);
    cooldownTier = 'winning_bb';
  } else {
    adaptiveCooldownMinutes = dropCount >= 10 ? 2 : dropCount >= 6 ? 3 : cooldownMinutes;
    cooldownTier = 'stable';
  }
  
  // Apply drop budget floor: if budget exceeded, enforce minimum 3 min cooldown
  if (dropBudgetExceeded) {
    adaptiveCooldownMinutes = Math.max(adaptiveCooldownMinutes, 3);
  }
  
  // Pre-cooldown: detect underpriced recovery (used for severe-gap fast-lane cooldown reduction).
  const _ufrManualMin = minPrice || 0;
  const _ufrRoiFloor = context.profitGuard?.minRoiEnabled ? (context.profitGuard?.profitFloorPrice || 0) : 0;
  const _ufrEffectiveFloor = Math.max(_ufrManualMin, _ufrRoiFloor);
  const _underpriced = computeUnderpricedRecovery({
    currentPrice, buyboxPrice, lowestFbaPrice,
    lowestEligibleCompetitorPrice: smartRaise.lowestEligibleCompetitorPrice ?? null,
    isBuyboxOwner: smartRaise.isBuyboxOwner,
    isBuyboxSuppressed,
    maxRaiseStepDollars: smartRaise.maxRaiseStepDollars,
    maxRaiseStepPercent: smartRaise.maxRaiseStepPercent,
    smartRaiseEnabled: smartRaise.enabled,
    effectiveFloor: _ufrEffectiveFloor,
    maxPrice: maxPrice ?? null,
  });
  const _underpricedIsSevere = _underpriced?.isSevere ?? false;
  // Always log recovery decision so production behavior is observable.
  if (_underpriced?.applies) {
    console.log(`[UNDERPRICED_DETECTED] asin=${context.asin} gap=${_underpriced.gapPct.toFixed(1)}% anchor=$${_underpriced.marketAnchor.toFixed(2)} current=$${currentPrice?.toFixed(2)} target=$${_underpriced.targetPrice.toFixed(2)} severe=${_underpricedIsSevere} floor=$${_ufrEffectiveFloor.toFixed(2)} max=${maxPrice?.toFixed(2) ?? 'null'}`);
  } else if (_underpriced?.skipReason) {
    console.log(`[UNDERPRICED_SKIPPED] asin=${context.asin} reason=${_underpriced.skipReason} current=$${currentPrice?.toFixed(2) ?? 'null'} bb=$${buyboxPrice?.toFixed(2) ?? 'null'} lowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'} eligible=$${smartRaise.lowestEligibleCompetitorPrice?.toFixed(2) ?? 'null'} bbOwner=${smartRaise.isBuyboxOwner} suppressed=${isBuyboxSuppressed} smartRaise=${smartRaise.enabled}`);
  }

  // SAFETY-FIRST FAST-LANE (not a blanket bypass): when severely underpriced
  // (gap ≥ 20% vs market anchor), reduce cooldown to a 2-min cap instead of
  // bypassing it entirely. This prevents oscillation while still letting the
  // engine react quickly to recover obvious money-on-the-table cases.
  // Spec: "faster cooldown when gap > 20%" — verified by recovery_test.ts.
  const FAST_LANE_CAP_MINUTES = 2;
  const _cooldownAfterFastLane = computeFastLaneCooldown(adaptiveCooldownMinutes, _underpricedIsSevere, FAST_LANE_CAP_MINUTES);
  if (_underpricedIsSevere && _cooldownAfterFastLane !== adaptiveCooldownMinutes) {
    console.log(`[COOLDOWN] UNDERPRICED FAST-LANE: severe gap ${_underpriced!.gapPct.toFixed(1)}% — reducing cooldown ${adaptiveCooldownMinutes}min → ${_cooldownAfterFastLane}min`);
    guardsApplied.push('underpriced_fast_lane_cooldown');
  }
  const effectiveCooldownMinutes = _cooldownAfterFastLane;
  if (adaptiveCooldownMinutes !== cooldownMinutes || dropBudgetExceeded || holdOnceLowest) {
    console.log(`[COOLDOWN] ADAPTIVE DETAIL: tier=${cooldownTier} weighted_score=${dropCount} buckets=[0-10m:${dropBuckets.recent0_10}, 10-30m:${dropBuckets.recent10_30}, 30-60m:${dropBuckets.recent30_60}] applied_cooldown=${effectiveCooldownMinutes}min drop_budget=${dropBudget.count}/${DROP_BUDGET_MAX_COUNT} ($${dropBudget.totalDelta.toFixed(2)}/$${DROP_BUDGET_MAX_DELTA}) hold_lowest=${holdOnceLowest}`);
    if (adaptiveCooldownMinutes !== cooldownMinutes) guardsApplied.push('adaptive_cooldown');
  }

  // Anomaly detection — tag low-confidence/inconsistent market data so UI can explain.
  const _anomalies = detectMarketAnomalies({
    currentPrice, buyboxPrice, lowestFbaPrice,
    lowestOverallPrice: lowestOverallPrice ?? null,
    rawTargetPrice: null,
    isBuyboxSuppressed,
    effectiveFloor: _ufrEffectiveFloor,
  });
  for (const t of _anomalies.tags) if (!guardsApplied.includes(t)) guardsApplied.push(t);
  if (_anomalies.notes.length) console.log(`[ANOMALY] ${_anomalies.notes.join(' | ')}`);

  // MATCH EXACTLY: corrective raise bypass. If undercut is 0 (match anchor
  // exactly) and current price is below the anchor (buybox, then lowest_fba),
  // allow a corrective move back UP to the anchor through cooldown — matching
  // the rule is compliance, not aggression.
  const strictAnchorForRaise = context.matchExactly
    ? (buyboxPrice ?? lowestFbaPrice ?? null)
    : null;
  const strictModeCorrectiveRaise = Boolean(
    context.matchExactly
    && strictAnchorForRaise != null
    && currentPrice != null
    && currentPrice + 0.005 < strictAnchorForRaise
  );
  if (strictModeCorrectiveRaise) {
    console.log(`[COOLDOWN] STRICT_MATCH_MODE corrective raise bypass: current=$${currentPrice!.toFixed(2)} < anchor=$${strictAnchorForRaise!.toFixed(2)} — bypassing cooldown to match anchor`);
    guardsApplied.push('strict_match_mode_corrective_raise_bypass');
  }

  const manualForceRaise = context.forceMode === 'smart_raise';
  if (manualForceRaise) {
    console.log(`[COOLDOWN] MANUAL_FORCE_RAISE bypass: trigger=${context.triggerSource ?? 'unknown'} — cooldown skipped for controlled BB-owner raise`);
    guardsApplied.push('force_raise_bypassed_cooldown');
  }
  if (lastRepricedAt && effectiveCooldownMinutes > 0 && !context.isPriority && !isLosingBuybox && !isOverpricedVsRaw && !suppressedBbMicroGapBypass && !strictModeCorrectiveRaise && !manualForceRaise) {
    const lastRepricedTime = new Date(lastRepricedAt).getTime();
    const cooldownMs = effectiveCooldownMinutes * 60 * 1000;
    const now = Date.now();
    if (now - lastRepricedTime < cooldownMs) {
      const remainingMins = Math.ceil((cooldownMs - (now - lastRepricedTime)) / 60000);
      const budgetNote = dropBudgetExceeded ? `, DROP BUDGET: ${dropBudget.count} moves/$${dropBudget.totalDelta.toFixed(2)} in 15min` : '';
      const isManualTrigger = context.triggerSource === 'manual_run_selected' || context.triggerSource === 'manual';
      const cooldownGuards = ['cooldown', ...guardsApplied.filter(g => g.startsWith('adaptive') || g.startsWith('drop_budget') || g.startsWith('hold_once') || g.startsWith('underpriced_fast_lane') || g === 'data_low_confidence' || g === 'market_inconsistent')];
      if (isManualTrigger) cooldownGuards.push('manual_eval_respected_cooldown');
      return {
        mode: 'SKIP', newPrice: null, rawTargetPrice: null,
        reason: isManualTrigger
          ? `Manual eval respected cooldown: ${remainingMins} min remaining (tier=${cooldownTier}, score=${dropCount}${budgetNote})`
          : `Cooldown: ${remainingMins} min remaining (tier=${cooldownTier}, score=${dropCount}${budgetNote})`,
        guardsApplied: cooldownGuards,
        intelligenceFactors: intelligence,
      };
    }
  }


  // Underpriced recovery — fires before GLOBAL RAISE GUARD so significantly-below-market
  // prices climb toward cluster instead of HOLDing. Floor + max already respected.
  //
  // MATCH EXACTLY GUARD: when undercut=0, the user has explicitly opted into
  // "anchor to BB / lowest FBA exactly". The underpriced_recovery raise (which
  // targets the *next higher* eligible competitor) would silently override
  // that intent — e.g. raising $27.99 → $28.99 because next competitor is
  // $29.50, even though BB/lowest FBA is $27.99. Block it; the corrective
  // raise path above already handles the legitimate "below the anchor" case
  // by moving back to the anchor exactly.
  if (_underpriced && _underpriced.applies && context.matchExactly) {
    console.log(`[UNDERPRICED RECOVERY] BLOCKED by match-exactly (undercut=0): would raise $${currentPrice?.toFixed(2)} → $${_underpriced.targetPrice.toFixed(2)} but anchor is BB=$${buyboxPrice?.toFixed(2) ?? 'null'} / lowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'}`);
    guardsApplied.push('strict_match_blocks_underpriced_recovery');
    // Fall through to normal competitive logic which will match the anchor.
  } else if (_underpriced && _underpriced.applies && hasLowerFbmCompetitor) {
    console.log(`[UNDERPRICED RECOVERY] BLOCKED by lower FBM competitor: lowest_fbm=$${fbmMarketAnchorPrice?.toFixed(2)} current=$${currentPrice?.toFixed(2)} — FBM must compete with FBM first`);
    guardsApplied.push('fbm_lower_competitor_blocks_raise');
    // Fall through to normal competitive logic anchored to the FBM ladder.
  } else if (_underpriced && _underpriced.applies) {
    console.log(`[UNDERPRICED RECOVERY] ${_underpriced.reason}`);
    guardsApplied.push(_underpriced.guardTag);
    return {
      mode: 'SMART_RAISE',
      newPrice: _underpriced.targetPrice,
      rawTargetPrice: _underpriced.targetPrice,
      reason: _underpriced.reason,
      guardsApplied, intelligenceFactors: intelligence, isRaise: true, anchorDiagnostics,
    };
  }

  // === FIX 4: GLOBAL RAISE GUARD — If we DON'T own BB and price is above BB, force undercut ===
  // This prevents any raise path from firing when we're clearly overpriced
  if (currentPrice && buyboxPrice && !smartRaise.isBuyboxOwner && currentPrice > buyboxPrice) {
    // EXCEPTION: If we're trivially above BB (≤$0.02) and the next eligible competitor is
    // significantly higher, blocking the raise destroys profit. Allow Smart Raise to evaluate.
    const trivialBbGap = (currentPrice - buyboxPrice) <= 0.02;
    const nextEligible = smartRaise.lowestEligibleCompetitorPrice;
    const significantEligibleGap = nextEligible != null && nextEligible > currentPrice * 1.02 && nextEligible > currentPrice + 0.15;
    
    if (trivialBbGap && significantEligibleGap) {
      console.log(`[Smart Raise] GLOBAL GUARD BYPASSED: trivial BB gap $${(currentPrice - buyboxPrice).toFixed(2)}, next eligible $${nextEligible!.toFixed(2)} is significantly above — allowing profit-max raise`);
      guardsApplied.push('global_guard_bypassed_trivial_gap');
      // Fall through to Smart Raise logic below
    } else {
      console.log(`[Smart Raise] GLOBAL GUARD: Price $${currentPrice.toFixed(2)} > BB $${buyboxPrice.toFixed(2)} and NOT BB owner — skipping ALL raise logic, will undercut`);
      guardsApplied.push('above_bb_not_owner_no_raise');
      // Fall through to normal undercut/competitive pricing below
    }
  }

  // === SMART RAISE LOGIC (v2: Rolling Window + Proportional Gap-Close + Raise-at-Buybox) ===
  // Check if market has gone up and we should raise prices
  // CRITICAL: Skip Smart Raise if Buy Box is suppressed - we should be LOWERING prices, not raising
  else if (isBuyboxSuppressed) {
    console.log(`[Smart Raise] SKIPPED: Buy Box is suppressed (no Featured Offer). Will handle in suppressed logic.`);
  } else if (smartRaise.enabled && currentPrice && buyboxPrice && hasLowerFbmCompetitor) {
    console.log(`[Smart Raise] BLOCKED: lower FBM competitor $${fbmMarketAnchorPrice?.toFixed(2)} exists below current $${currentPrice.toFixed(2)} — FBM competes with lowest FBM first`);
    guardsApplied.push('fbm_lower_competitor_blocks_raise');
  } else if (smartRaise.enabled && currentPrice && buyboxPrice && postRaiseCooldown.active) {
    console.log(`[Smart Raise] POST_RAISE_COOLDOWN: last raise ${smartRaise.lastRaiseAt}, ${postRaiseCooldown.remainingMinutes}min remaining of ${smartRaise.postRaiseCooldownHours}h cooldown — blocking further raises`);
    guardsApplied.push('post_raise_cooldown_active');
  } else if (smartRaise.enabled && currentPrice && buyboxPrice) {
    // Build raise offset context for conditional match/undercut decisions
    console.log(`[Raise Offset] policy=${_raiseOffset.reason} offset=$${_raiseOffset.offset.toFixed(2)} (profile=${_raiseSmartProfile}, fulfillment=${context.yourFulfillmentType}, bbOwner=${context.smartRaise.isBuyboxOwner}, fbaCount=${intelligence.fbaCompetitorCount}, price=$${currentPrice.toFixed(2)})`);
    // ── ROLLING WINDOW COMPARISON ──
    // Compare current BB against multiple historical reference points to catch gradual rises
    const rolling = smartRaise.rollingBuyboxPrices;
    const referencePoints: { label: string; price: number }[] = [];
    if (smartRaise.previousBuyboxPrice) referencePoints.push({ label: 'previous_snapshot', price: smartRaise.previousBuyboxPrice });
    if (rolling.price30min) referencePoints.push({ label: '30min_ago', price: rolling.price30min });
    if (rolling.price2hr) referencePoints.push({ label: '2hr_ago', price: rolling.price2hr });
    if (rolling.price6hr) referencePoints.push({ label: '6hr_ago', price: rolling.price6hr });

    // MOMENTUM_SMART gate: a Buy Box rise only counts as a real market move
    // if the underlying competitor floor rose alongside it at that SAME
    // reference point — otherwise this is Amazon's BB price drifting with
    // nobody actually following, and raising into it is how Momentum
    // Builder alone can lose the Buy Box to its own decision. No floor data
    // for a reference point (e.g. previous_snapshot has none fetched) is
    // treated as unsupported, not as a free pass.
    const floorRollingByLabel: Record<string, number | null> = {
      previous_snapshot: null,
      '30min_ago': smartRaise.rollingLowestFbaPrices?.price30min ?? null,
      '2hr_ago': smartRaise.rollingLowestFbaPrices?.price2hr ?? null,
      '6hr_ago': smartRaise.rollingLowestFbaPrices?.price6hr ?? null,
    };

    // Find the best (oldest) reference that shows a meaningful rise
    let bestRef: { label: string; price: number; increasePercent: number } | null = null;
    let anyMarketSupportRejected = false;
    for (const ref of referencePoints) {
      if (ref.price > 0 && buyboxPrice > ref.price) {
        const pct = ((buyboxPrice - ref.price) / ref.price) * 100;
        if (pct >= smartRaise.triggerPercent) {
          let marketSupported = true;
          if (smartRaise.requireMarketSupportedRaise) {
            const floorRef = floorRollingByLabel[ref.label] ?? null;
            const check = evaluateMarketSupportedRaise({
              buyboxPrice, refPrice: ref.price,
              lowestFbaPrice, floorRefPrice: floorRef,
              minFloorSupportRatio: smartRaise.minFloorSupportRatio,
            });
            marketSupported = check.supported;
            if (!marketSupported) {
              anyMarketSupportRejected = true;
              console.log(`[Smart Raise] MARKET_SUPPORTED_RAISE gate (ratio=${smartRaise.minFloorSupportRatio ?? 'v1_any_rise'}): ${ref.label} ${check.reason} — skipping this reference`);
            }
          }
          if (marketSupported && (!bestRef || pct > bestRef.increasePercent)) {
            bestRef = { ...ref, increasePercent: pct };
          }
        }
      }
    }
    if (bestRef && smartRaise.requireMarketSupportedRaise) {
      guardsApplied.push('market_supported_raise_confirmed');
    } else if (anyMarketSupportRejected) {
      // Distinct from "no BB rise at all" -- this fires specifically when a
      // BB rise existed but the competitor floor didn't back it up, so the
      // raise-safety dashboard can count floor-support rejections separately
      // from cooldown blocks and from cycles with no raise signal at all.
      guardsApplied.push('market_supported_raise_rejected');
    }

    const eligibleRaiseAnchor = smartRaise.lowestEligibleCompetitorPrice;
    const eligibleRaiseHeadroom = eligibleRaiseAnchor && eligibleRaiseAnchor > currentPrice
      ? eligibleRaiseAnchor - currentPrice
      : 0;
    const safeEligibleRaiseGap = Math.max(0.15, currentPrice * 0.02);
    const rawCheaperGap = lowestFbaPrice && lowestFbaPrice > 0
      ? currentPrice - lowestFbaPrice
      : 0;
    const allowEligibleGapRaiseOverride = Boolean(
      smartRaise.isBuyboxOwner &&
      !smartRaise.isInPriceCluster &&
      eligibleRaiseAnchor &&
      eligibleRaiseHeadroom >= safeEligibleRaiseGap &&
      rawCheaperGap > 0 &&
      rawCheaperGap <= 0.02 &&
      Math.abs(currentPrice - buyboxPrice) <= 0.02
    );

    // ── RAISE-AT-BUYBOX: Detect raise opportunity even when currentPrice == buyboxPrice ──
    // Safety: only allow this path when we actually own the Buy Box
    let raiseAtBuyboxOpportunity = false;
    let raiseAtBuyboxTarget: number | null = null;
    if (!bestRef && currentPrice >= buyboxPrice && smartRaise.isBuyboxOwner) {
      // === FIX 1: GLOBAL SANITY — Never raise if already priced above Buy Box ===
      // If our price is already > BB + 1% tolerance, something went wrong. Do NOT raise further.
      if (currentPrice > buyboxPrice * 1.01 && currentPrice > buyboxPrice + 0.02) {
        console.log(`[Smart Raise] BLOCKED: Price $${currentPrice.toFixed(2)} already ABOVE Buy Box $${buyboxPrice.toFixed(2)} — raise would worsen position`);
        guardsApplied.push('raise_blocked_above_bb');
      } else if (smartRaise.isInPriceCluster && !stockGatedMaximize) {
        // === CLUSTER GUARD: Multiple sellers at same price — raising would lose BB ===
        console.log(`[Smart Raise] CLUSTER HOLD: ${smartRaise.clusterSellerCount} sellers at same price — raising would leave cluster and lose BB rotation`);
        guardsApplied.push('cluster_hold');
        // Do NOT set raiseAtBuyboxOpportunity — effectively blocks the raise
      } else {
        const lowestComp = eligibleRaiseAnchor;
        if (lowestComp && lowestComp > currentPrice) {
          const headroom = lowestComp - currentPrice;
          if (headroom >= 0.02) { // At least 2 cents headroom
            raiseAtBuyboxOpportunity = true;
            // Target: close toward the competitor, stay below them
            raiseAtBuyboxTarget = applyRaiseOffset(lowestComp, _raiseOffset);
            console.log(`[Smart Raise] RAISE-AT-BUYBOX: At BB $${currentPrice.toFixed(2)}, lowest eligible competitor $${lowestComp.toFixed(2)}, headroom $${headroom.toFixed(2)}`);
          }
        } else if (intelligence.fbaCompetitorCount > 1 && (!lowestComp || lowestComp <= currentPrice)) {
          // === FIX 2: Missing competitor data = insufficient info, NOT a raise signal ===
          // When lowestComp is null AND there are 3+ FBA competitors, we simply don't have
          // visibility. Raising blind caused B0CKJNCZLY to climb from $16.18 → $19.19.
          if (!lowestComp && intelligence.fbaCompetitorCount > 2) {
            console.log(`[Smart Raise] FBA-LEADER-RAISE BLOCKED: lowestComp=null with ${intelligence.fbaCompetitorCount} FBA competitors — insufficient data to raise safely`);
            guardsApplied.push('fba_leader_raise_blocked_no_data');
          } else {
            // FBA LEADER RAISE: Only safe with ≤2 FBA competitors where we can infer position
            const stepAmount = Math.min(
              smartRaise.maxRaiseStepDollars || 0.25,
              currentPrice * ((smartRaise.maxRaiseStepPercent || 2) / 100)
            );
            raiseAtBuyboxOpportunity = true;
            raiseAtBuyboxTarget = currentPrice + stepAmount;
            console.log(`[Smart Raise] FBA-LEADER-RAISE: Lowest FBA at $${currentPrice.toFixed(2)}, ${intelligence.fbaCompetitorCount - 1} FBA competitors above, step $${stepAmount.toFixed(2)}`);
          }
        }
      }
    }

    // CRITICAL: Do NOT raise if a real FBA competitor is cheaper than us
    // This prevents Smart Raise from overriding the undercut logic downstream
    const hasCheaperRawFba = Boolean(lowestFbaPrice && lowestFbaPrice > 0 && currentPrice && lowestFbaPrice < currentPrice - 0.004);
    // QUALITY-FILTER BYPASS: If the cheaper raw lowest was excluded by quality filters
    // (rating/handling) and the filtered eligible market is at-or-above current price,
    // the raw outlier must NOT block raises. Previously this created a contradiction where
    // the engine simultaneously (a) filtered the raw low out of strategic anchoring and
    // (b) still let that same raw low veto upward repricing — freezing the listing.
    // Example: ASIN B009AX7E3E — sole FBA at $5.76 raw (FBM junk), filtered $14.72,
    // current $13.99 → engine refused to raise toward filtered market.
    const rawCheaperWasQualityFiltered = Boolean(
      hasCheaperRawFba &&
      eligibleRaiseAnchor &&
      eligibleRaiseAnchor >= (currentPrice as number) - 0.004 &&
      // Filtered competitor is meaningfully above raw → quality filter removed the raw outlier
      lowestFbaPrice && eligibleRaiseAnchor > lowestFbaPrice + 0.01
    );
    const fbaCompetitorCheaper = hasCheaperRawFba && !allowEligibleGapRaiseOverride && !rawCheaperWasQualityFiltered;
    if (hasCheaperRawFba && allowEligibleGapRaiseOverride && eligibleRaiseAnchor) {
      console.log(`[Smart Raise] ELIGIBLE GAP OVERRIDE: raw lowest FBA $${lowestFbaPrice!.toFixed(2)} is only $${rawCheaperGap.toFixed(2)} below current while BB is held; next eligible competitor is $${eligibleRaiseAnchor.toFixed(2)} — allowing safe raise toward eligible market`);
      guardsApplied.push('eligible_gap_override');
    } else if (hasCheaperRawFba && rawCheaperWasQualityFiltered) {
      console.log(`[Smart Raise] RAW-OUTLIER-FILTERED BYPASS: raw lowest FBA $${lowestFbaPrice!.toFixed(2)} was quality-filtered (eligible market $${eligibleRaiseAnchor!.toFixed(2)} ≥ current $${currentPrice!.toFixed(2)}) — not blocking raise toward filtered market`);
      guardsApplied.push('raise_unblocked_raw_outlier_filtered');
    } else if (fbaCompetitorCheaper) {
      console.log(`[Smart Raise] BLOCKED: lowest FBA $${lowestFbaPrice!.toFixed(2)} is cheaper than current $${currentPrice!.toFixed(2)} — falling through to undercut logic`);
      guardsApplied.push('raise_blocked_competitor_cheaper');
    }

    const canRaise = !fbaCompetitorCheaper && (!smartRaise.onlyRaiseWhenBuyboxOwner || smartRaise.isBuyboxOwner);

    // === RAISE SOFTENING: Dampen raises for ASINs that repeatedly lose Buy Box after raise ===
    const bbLossCount = context.bbLossAfterRaiseCount;
    if (canRaise && bbLossCount >= 3) {
      // 3+ BB losses after raise: completely disable raises — this ASIN consistently loses BB after raising
      console.log(`[Smart Raise] DISABLED for ${context.intelligence.asin || 'ASIN'}: bb_loss_after_raise_count=${bbLossCount} (≥3). Raises blocked until stability improves.`);
      guardsApplied.push('raise_disabled_bb_loss');
    } else if (canRaise && (bestRef || raiseAtBuyboxOpportunity)) {
      // Apply dampening factor for ASINs with 2 BB losses (aggressive dampening early)
      const raiseDampenFactor = bbLossCount >= 2 ? 0.25 : bbLossCount >= 1 ? 0.50 : 1.0;
      if (raiseDampenFactor < 1.0) {
        console.log(`[Smart Raise] DAMPENED: bb_loss_count=${bbLossCount}, factor=${raiseDampenFactor}`);
        guardsApplied.push(`raise_dampened_${Math.round(raiseDampenFactor * 100)}pct`);
      }

      let targetRaisePrice: number;
      let raiseReason: string;
      let raisePath: string;

      if (bestRef && currentPrice < buyboxPrice) {
        // ── PROPORTIONAL GAP-CLOSE (replaces fixed step) ──
        const idealTarget = buyboxPrice - undercutAmount;
        const gap = idealTarget - currentPrice;
        const gapCloseRatio = smartRaise.gapCloseRatio;
        const proportionalStep = gap * gapCloseRatio;

        const maxRaiseDollar = smartRaise.maxRaiseStepDollars || 0.25;
        const maxRaisePct = smartRaise.maxRaiseStepPercent || 2;
        const oldFixedMax = Math.min(maxRaiseDollar, currentPrice * (maxRaisePct / 100));

        // SNAP-TO-TARGET: If remaining gap is ≤ $0.05, jump directly to target
        // Prevents asymptotic stall where fractional steps + rounding = no movement
        if (gap <= 0.05 && gap > 0) {
          targetRaisePrice = idealTarget;
          console.log(`[Smart Raise] SNAP-TO-TARGET (rolling): gap=$${gap.toFixed(3)} ≤ $0.05, jumping directly to $${idealTarget.toFixed(2)}`);
          guardsApplied.push('snap_to_target');
        } else {
          const raiseAmount = Math.max(proportionalStep, oldFixedMax);
          targetRaisePrice = currentPrice + Math.min(raiseAmount, gap);
          console.log(`[Smart Raise] Rolling window triggered via ${bestRef.label}: +${bestRef.increasePercent.toFixed(1)}%. Gap=$${gap.toFixed(2)}, proportional=$${proportionalStep.toFixed(2)}, oldMax=$${oldFixedMax.toFixed(2)}, using=$${Math.min(raiseAmount, gap).toFixed(2)}`);
        }
        raisePath = 'rolling_raise';
        raiseReason = `Smart Raise (rolling/${bestRef.label}): Market +${bestRef.increasePercent.toFixed(1)}% ($${bestRef.price.toFixed(2)} → $${buyboxPrice.toFixed(2)}), gap-close ${(gapCloseRatio * 100).toFixed(0)}%`;
        guardsApplied.push(`rolling_ref_${bestRef.label}`);
        guardsApplied.push('proportional_raise');
      } else if (raiseAtBuyboxOpportunity && raiseAtBuyboxTarget) {
        // ── RAISE-AT-BUYBOX PATH ──
        // When we own BB and are clearly underpriced vs next competitor,
        // use an accelerated (but safe) gap-close: floor of 30%, still subject
        // to jump limiter and max step protections downstream.
        const gap = raiseAtBuyboxTarget - currentPrice;
        const RAISE_AT_BB_GAP_CLOSE_FLOOR = 0.30;
        const raiseGapClose = Math.max(smartRaise.gapCloseRatio, RAISE_AT_BB_GAP_CLOSE_FLOOR);
        
        // SNAP-TO-TARGET: If remaining gap is ≤ $0.15, jump directly to target
        // Wider snap threshold for raise-at-buybox to avoid multi-cycle micro-raises
        if (gap <= 0.15 && gap > 0) {
          targetRaisePrice = raiseAtBuyboxTarget;
          console.log(`[Smart Raise] SNAP-TO-TARGET (raise-at-buybox): gap=$${gap.toFixed(3)} ≤ $0.15, jumping directly to $${raiseAtBuyboxTarget.toFixed(2)}`);
          guardsApplied.push('snap_to_target');
        } else {
          const raiseAmount = Math.max(gap * raiseGapClose, 0.01);
          targetRaisePrice = currentPrice + Math.min(raiseAmount, gap);
          console.log(`[Smart Raise] Raise-at-buybox: gap=$${gap.toFixed(2)}, step=$${Math.min(raiseAmount, gap).toFixed(2)} (gapClose=${raiseGapClose.toFixed(2)})`);
        }
        raisePath = 'raise_at_buybox';
        raiseReason = `Smart Raise (raise-at-buybox): At BB $${buyboxPrice.toFixed(2)}, next competitor $${raiseAtBuyboxTarget.toFixed(2)}, initial target $${targetRaisePrice.toFixed(2)}`;
        guardsApplied.push('raise_at_buybox');
        guardsApplied.push('proportional_raise');
      } else {
        targetRaisePrice = currentPrice; // No raise (will be caught by check below)
        raisePath = 'none';
        raiseReason = '';
      }

      // === APPLY RAISE DAMPENING FOR BB-LOSS-PRONE ASINs ===
      if (raiseDampenFactor < 1.0 && targetRaisePrice > currentPrice) {
        const originalRaise = targetRaisePrice - currentPrice;
        const dampenedRaise = originalRaise * raiseDampenFactor;
        targetRaisePrice = currentPrice + Math.max(dampenedRaise, 0.01);
        console.log(`[Smart Raise] DAMPENED: original raise $${originalRaise.toFixed(2)} → dampened $${dampenedRaise.toFixed(2)} (factor=${raiseDampenFactor})`);
      }

      // ===================================================================
      // FBM GAP RECAPTURE OVERRIDE — bypass bb_cap and jump_limiter
      // When FBM_ONLY lane, BB owner, large gap to next FBM competitor,
      // Amazon holds BB even if we raise, so gradual raise = permanent underpricing.
      // Snap directly to next competitor - epsilon in one step.
      // ===================================================================
      const isFbmGapRecaptureInSmartRaise = smartRaise.isEligibleLaneFbmOnly === true
        && smartRaise.isBuyboxOwner
        && !smartRaise.isInPriceCluster
        && raisePath === 'raise_at_buybox'
        && raiseAtBuyboxTarget != null
        && (raiseAtBuyboxTarget - currentPrice) >= 0.75
        && ((raiseAtBuyboxTarget - currentPrice) / currentPrice) >= 0.04;

      if (isFbmGapRecaptureInSmartRaise && raiseAtBuyboxTarget != null) {
        // Snap to next FBM competitor - small epsilon
        const epsilon = currentPrice < 20 ? 0.01 : (currentPrice < 50 ? 0.02 : 0.05);
        targetRaisePrice = Math.round((raiseAtBuyboxTarget - epsilon) * 100) / 100;
        if (maxPrice && targetRaisePrice > maxPrice) targetRaisePrice = maxPrice;
        if (minPrice && targetRaisePrice < minPrice) targetRaisePrice = minPrice;
        console.log(`[Smart Raise] FBM GAP RECAPTURE OVERRIDE: Bypassing bb_cap/jump_limiter. Snapping $${currentPrice.toFixed(2)} → $${targetRaisePrice.toFixed(2)} (next FBM @ $${raiseAtBuyboxTarget.toFixed(2)})`);
        guardsApplied.push('fbm_gap_recapture_snap');
        raisePath = 'fbm_gap_recapture';
        raiseReason = `FBM gap recapture: snapping from $${currentPrice.toFixed(2)} to $${targetRaisePrice.toFixed(2)} (next FBM competitor $${raiseAtBuyboxTarget.toFixed(2)})`;
      } else {
        // ===================================================================
        // PRICE JUMP LIMITER - Max +10% OR +$2 per run (whichever is SMALLER for safety)
        // ===================================================================
        const MAX_JUMP_PERCENT = 10;
        const MAX_JUMP_DOLLARS = 2.0;
        const maxJumpAllowed = Math.min(MAX_JUMP_DOLLARS, currentPrice * (MAX_JUMP_PERCENT / 100));

        if ((targetRaisePrice - currentPrice) > maxJumpAllowed) {
          console.log(`[Smart Raise] JUMP LIMITER: Would raise $${currentPrice.toFixed(2)} → $${targetRaisePrice.toFixed(2)} (+$${(targetRaisePrice - currentPrice).toFixed(2)}), limiting to +$${maxJumpAllowed.toFixed(2)}`);
          targetRaisePrice = currentPrice + maxJumpAllowed;
          guardsApplied.push('jump_limiter');
        }

        // ===================================================================
        // FIX 3: BUY BOX CEILING CAP — Applied to ALL raise paths (including raise_at_buybox)
        // Previously raise_at_buybox was exempted, which let prices drift far above BB.
        // The raise_at_buybox target is bounded by competitor price, but this cap acts as
        // the final safety net to prevent runaway pricing if competitor data is stale/wrong.
        // ===================================================================
        if (buyboxPrice && smartRaise.maxRaiseAboveBuyboxPercent !== null) {
          const buyboxCap = buyboxPrice * (1 + (smartRaise.maxRaiseAboveBuyboxPercent / 100));
          if (targetRaisePrice > buyboxCap) {
            console.log(`[Smart Raise] BUYBOX CAP: $${targetRaisePrice.toFixed(2)} → $${buyboxCap.toFixed(2)} (cap +${smartRaise.maxRaiseAboveBuyboxPercent.toFixed(2)}% above BB, path=${raisePath})`);
            targetRaisePrice = buyboxCap;
            guardsApplied.push(`bb_cap_${smartRaise.maxRaiseAboveBuyboxPercent.toFixed(2)}pct`);
          }
        }
      }

      // ===================================================================
      // FINAL HARD CLAMP for Smart Raise
      // ===================================================================
      if (minPrice && targetRaisePrice < minPrice) {
        targetRaisePrice = minPrice;
        guardsApplied.push('FINAL_CLAMP_MIN');
      }
      if (maxPrice && targetRaisePrice > maxPrice) {
        console.log(`[Smart Raise] FINAL CLAMP MAX: $${targetRaisePrice.toFixed(2)} → $${maxPrice.toFixed(2)}`);
        targetRaisePrice = maxPrice;
        guardsApplied.push('FINAL_CLAMP_MAX');
      }

      // Make sure we're actually raising
      if (targetRaisePrice > currentPrice) {
        const roundedPrice = Math.round(targetRaisePrice * 100) / 100;

        // SAFETY ASSERT: Abort if price is STILL outside bounds
        if (maxPrice && roundedPrice > maxPrice) {
          console.error(`[FATAL] Smart Raise price $${roundedPrice} > max $${maxPrice} AFTER CLAMP. Aborting.`);
          return {
            mode: 'SKIP',
            newPrice: null,
            rawTargetPrice: targetRaisePrice,
            reason: `SAFETY ABORT: Smart Raise $${roundedPrice} exceeds max $${maxPrice}`,
            guardsApplied: ['SAFETY_ABORT_MAX'],
            intelligenceFactors: intelligence,
          };
        }
        if (minPrice && roundedPrice < minPrice) {
          console.error(`[FATAL] Smart Raise price $${roundedPrice} < min $${minPrice} AFTER CLAMP. Aborting.`);
          return {
            mode: 'SKIP',
            newPrice: null,
            rawTargetPrice: targetRaisePrice,
            reason: `SAFETY ABORT: Smart Raise $${roundedPrice} below min $${minPrice}`,
            guardsApplied: ['SAFETY_ABORT_MIN'],
            intelligenceFactors: intelligence,
          };
        }

        console.log(`[Smart Raise] ${raisePath}: Raising $${currentPrice.toFixed(2)} → $${roundedPrice.toFixed(2)}`);

        return {
          mode: 'SMART_RAISE',
          newPrice: roundedPrice,
          rawTargetPrice: targetRaisePrice,
          reason: raiseReason + `. Final price after guards: $${roundedPrice.toFixed(2)}`,
          guardsApplied,
          intelligenceFactors: intelligence,
          isRaise: true,
        };
      }
    }
  }

  // === MANUAL FORCE SMART RAISE (controlled BB-owner / suppressed-BB profit probe) ===
  // Bypasses cooldown + bb_owner_protection but still respects ROI/min/max/drop budget.
  // Eligibility: (isBuyboxOwner OR suppressed/stale BB with I-am-lowest-filtered)
  //   AND filtered anchor > current
  //   AND no lower eligible FBA competitor.
  // Step: min($0.20, 25% of gap). Aborts on detected BB loss after prior raise.
  if (context.forceMode === 'smart_raise' && currentPrice) {
    const forceRaiseBlockedByFbmMode = Boolean(
      userWantsAllSellers && explicitFbmAnchorPrice && explicitFbmAnchorPrice < currentPrice - 0.005
    );
    if (forceRaiseBlockedByFbmMode) {
      console.log(`[MANUAL_FORCE_RAISE] BLOCKED by FBM mode=${fbmCompetitionMode}: FBM anchor $${explicitFbmAnchorPrice!.toFixed(2)} is below current $${currentPrice.toFixed(2)} — must compete down, not raise toward FBA`);
      guardsApplied.push('manual_force_raise_blocked_fbm_anchor');
    } else {
    const fsrAnchor = smartRaise.lowestEligibleCompetitorPrice ?? anchorDiagnostics?.filtered_lowest_fba ?? null;
    const fsrHasLowerFba = lowestFbaPrice != null && lowestFbaPrice < currentPrice - 0.005;
    // I-am-lowest-filtered: my current price is at or below the filtered competitor lane (excluding self).
    const fsrFilteredLow = anchorDiagnostics?.filtered_lowest_fba ?? null;
    const fsrIAmLowestFiltered = fsrFilteredLow == null
      ? true
      : currentPrice <= fsrFilteredLow + 0.005;
    // Treat suppressed/stale/unknown BB as eligible when I am the lowest filtered offer and
    // no lower eligible FBA exists — this is exactly the "profit probe" case the user requested.
    const fsrBbOwnerOrLowest = smartRaise.isBuyboxOwner || fsrIAmLowestFiltered;
    const fsrEligible = fsrBbOwnerOrLowest && fsrAnchor != null && fsrAnchor > currentPrice + 0.01 && !fsrHasLowerFba;
    if (fsrEligible) {
      const fsrBbLoss = context.bbLossAfterRaiseCount ?? 0;
      if (fsrBbLoss >= 1) {
        console.warn(`[MANUAL_FORCE_RAISE] ABORT: bb_loss_after_raise=${fsrBbLoss} — protective halt`);
        guardsApplied.push('manual_force_raise', 'manual_force_raise_bb_loss_detected');
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: null,
          reason: `Force Smart Raise aborted: Buy Box was lost after a prior raise (loss_count=${fsrBbLoss}). Wait for recovery before retrying.`,
          guardsApplied,
          intelligenceFactors: intelligence,
        };
      }
      const fsrGap = fsrAnchor - currentPrice;
      const fsrStep = Math.min(0.20, fsrGap * 0.25);
      let fsrTarget = Math.round((currentPrice + fsrStep) * 100) / 100;
      const fsrCeiling = Math.round((fsrAnchor - 0.01) * 100) / 100;
      if (fsrTarget > fsrCeiling) fsrTarget = fsrCeiling;
      if (maxPrice && fsrTarget > maxPrice) fsrTarget = maxPrice;
      if (minPrice && fsrTarget < minPrice) fsrTarget = minPrice;
      if (fsrTarget > currentPrice + 0.005) {
        const actualStep = fsrTarget - currentPrice;
        console.log(`[MANUAL_FORCE_RAISE] $${currentPrice.toFixed(2)} → $${fsrTarget.toFixed(2)} (anchor=$${fsrAnchor.toFixed(2)}, gap=$${fsrGap.toFixed(2)}, step=$${actualStep.toFixed(2)})`);
        const probeMode = smartRaise.isBuyboxOwner ? 'bb_owner' : 'suppressed_or_stale_bb';
        guardsApplied.push(
          'manual_force_raise',
          'force_raise_bypassed_bb_owner_hold',
          `force_raise_mode:${probeMode}`,
          `force_raise_step:${actualStep.toFixed(2)}`,
          `force_raise_anchor:${fsrAnchor.toFixed(2)}`,
          `force_raise_gap:${fsrGap.toFixed(2)}`,
        );
        const probeLabel = smartRaise.isBuyboxOwner
          ? 'Force Smart Raise'
          : 'Force Smart Raise (suppressed/unknown BB profit probe)';
        return {
          mode: 'SMART_RAISE',
          newPrice: fsrTarget,
          rawTargetPrice: fsrAnchor,
          reason: `${probeLabel}: $${currentPrice.toFixed(2)} → $${fsrTarget.toFixed(2)} (filtered anchor $${fsrAnchor.toFixed(2)}, gap $${fsrGap.toFixed(2)}, controlled step $${actualStep.toFixed(2)}) — bypassed cooldown + BB-owner hold`,
          guardsApplied,
          intelligenceFactors: intelligence,
          isRaise: true,
          anchorDiagnostics,
        };
      }
    } else {
      console.log(`[MANUAL_FORCE_RAISE] Not eligible: bbOwnerOrLowest=${fsrBbOwnerOrLowest}, anchor=${fsrAnchor}, current=${currentPrice}, hasLowerFba=${fsrHasLowerFba} — falling through to standard logic`);
      guardsApplied.push('manual_force_raise_not_eligible');
    }
    }
  }

  // === BUY BOX OWNER PROTECTION ===
  // If we already own the Buy Box and skip_lower_when_bb_owner is enabled, don't lower price
  // EXCEPTIONS:
  // 1. Momentum triggered (sales dropped AND market dropped)
  // 2. Stock-gated maximize mode (available=0, reserved>0) — allow profit recovery raises
  if (context.skipLowerWhenBbOwner && smartRaise.isBuyboxOwner && currentPrice && buyboxPrice && !intelligence.momentumTriggered && !stockGatedMaximize) {
    // We own the BB - normal target may be a hold/match, but FBM gap recapture must still be evaluated.
    const targetPrice = buyboxPrice - undercutAmount;
    const targetWouldLower = targetPrice < currentPrice;



    // Block profit raise if current price is already above the live Buy Box
    // (e.g. after floor recovery pushed us above BB — market hasn't confirmed yet)
    const alreadyAboveBb = currentPrice > buyboxPrice + 0.02;
    if (alreadyAboveBb) {
      // We are ABOVE the Buy Box — we are NOT truly winning. Bypass BB owner protection entirely
      // so the normal pricing logic can lower us to compete.
      console.log(`[BB Owner Protection] BYPASSED: current $${currentPrice.toFixed(2)} is ABOVE live BB $${buyboxPrice.toFixed(2)} — not truly winning, allowing normal pricing`);
      guardsApplied.push('bb_owner_bypassed_above_bb');
      // Fall through to normal pricing logic below
    } else {
      // Normal BB owner protection path — we are at or below BB price
      const bbProtNextEligible = smartRaise.lowestEligibleCompetitorPrice
        ?? anchorDiagnostics?.filtered_lowest_fba
        ?? null;
      const bbProtRaiseGap = bbProtNextEligible != null ? bbProtNextEligible - currentPrice : 0;
      const bbProtBbLoss = context.bbLossAfterRaiseCount ?? 0;

      if (bbProtNextEligible != null
          && bbProtRaiseGap > 0.03
          && smartRaise.enabled
          && !smartRaise.isInPriceCluster
          && bbProtBbLoss < 3) {

        // === FBM GAP RECAPTURE SNAP ===
        const isFbmSeller = context.yourFulfillmentType === 'FBM';
        const nextCompetitorIsFbm = smartRaise.isEligibleLaneFbmOnly === true
          || (lowestFbmPrice != null
              && bbProtNextEligible != null
              && Math.abs(lowestFbmPrice - bbProtNextEligible) <= 0.02);
        const isFbmGapRecapture = isFbmSeller
          && nextCompetitorIsFbm
          && bbProtRaiseGap >= 0.75
          && (bbProtRaiseGap / currentPrice) >= 0.04;

        let bbProtRaisePrice: number;

        if (isFbmGapRecapture) {
          const epsilon = currentPrice < 20 ? 0.01 : (currentPrice < 50 ? 0.02 : 0.05);
          bbProtRaisePrice = Math.round((bbProtNextEligible - epsilon) * 100) / 100;
          if (maxPrice && bbProtRaisePrice > maxPrice) bbProtRaisePrice = maxPrice;
          if (minPrice && bbProtRaisePrice < minPrice) bbProtRaisePrice = minPrice;

          if (bbProtBbLoss >= 1) {
            const dampen = bbProtBbLoss >= 2 ? 0.25 : 0.50;
            const fullStep = bbProtRaisePrice - currentPrice;
            bbProtRaisePrice = Math.round((currentPrice + Math.max(fullStep * dampen, 0.01)) * 100) / 100;
            guardsApplied.push(`fbm_gap_recapture_dampened_${Math.round(dampen * 100)}pct`);
          }

          if (bbProtRaisePrice > currentPrice) {
            console.log(`[FBM Gap Recapture] BB owner at $${currentPrice.toFixed(2)}, next eligible $${bbProtNextEligible.toFixed(2)} (gap $${bbProtRaiseGap.toFixed(2)}) — snap raising to $${bbProtRaisePrice.toFixed(2)}`);
            guardsApplied.push('fbm_gap_recapture_raise');
            return {
              mode: 'SMART_RAISE',
              newPrice: bbProtRaisePrice,
              rawTargetPrice: bbProtNextEligible,
              reason: `FBM gap recapture: lower pressure gone, snapping from $${currentPrice.toFixed(2)} to $${bbProtRaisePrice.toFixed(2)} (next seller $${bbProtNextEligible.toFixed(2)})`,
              guardsApplied,
              intelligenceFactors: intelligence,
              isRaise: true,
              anchorDiagnostics,
            };
          }
        }

        // Standard micro-step raise for FBA or smaller BB-owner headroom
        const bbProtStep = Math.min(
          Math.max(0.05, currentPrice * 0.005),
          bbProtRaiseGap - _raiseOffset.offset,
          0.20
        );

        if (bbProtStep >= 0.01) {
          bbProtRaisePrice = Math.round((currentPrice + bbProtStep) * 100) / 100;
          if (maxPrice && bbProtRaisePrice > maxPrice) bbProtRaisePrice = maxPrice;
          if (minPrice && bbProtRaisePrice < minPrice) bbProtRaisePrice = minPrice;

          if (bbProtBbLoss >= 1) {
            const dampen = bbProtBbLoss >= 2 ? 0.25 : 0.50;
            const originalStep = bbProtRaisePrice - currentPrice;
            bbProtRaisePrice = Math.round((currentPrice + Math.max(originalStep * dampen, 0.01)) * 100) / 100;
            guardsApplied.push(`bb_prot_raise_dampened_${Math.round(dampen * 100)}pct`);
          }

          if (bbProtRaisePrice > currentPrice) {
            console.log(`[BB Owner Profit Raise] BB owner at $${currentPrice.toFixed(2)}, next eligible $${bbProtNextEligible.toFixed(2)} (gap $${bbProtRaiseGap.toFixed(2)}) — raising to $${bbProtRaisePrice.toFixed(2)} instead of holding`);
            guardsApplied.push('bb_owner_protection_raise');
            return {
              mode: 'SMART_RAISE',
              newPrice: bbProtRaisePrice,
              rawTargetPrice: applyRaiseOffset(bbProtNextEligible, _raiseOffset),
              reason: `BB owner profit raise: winning at $${currentPrice.toFixed(2)}, next eligible $${bbProtNextEligible.toFixed(2)} — raising to $${bbProtRaisePrice.toFixed(2)}`,
              guardsApplied,
              intelligenceFactors: intelligence,
              isRaise: true,
              anchorDiagnostics,
            };
          }
        }
      }

      // FLOOR RECOVERY: If current price is below the effective floor (manual min or ROI floor),
      // raise to floor instead of holding at a below-floor price
      const manualMinForRecovery = minPrice || 0;
      const roiFloorForRecovery = context.profitGuard?.minRoiEnabled
        ? (context.profitGuard?.profitFloorPrice || 0)
        : 0;
      const roiPctForRecovery = context.profitGuard?.minRoiEnabled
        ? context.profitGuard?.minRoiPercent
        : null;
      const effectiveFloorForRecovery = Math.max(manualMinForRecovery, roiFloorForRecovery);
      if (effectiveFloorForRecovery > 0 && currentPrice < effectiveFloorForRecovery - 0.005) {
        let floorRecoveryPrice = Math.round(effectiveFloorForRecovery * 100) / 100;
        if (maxPrice && floorRecoveryPrice > maxPrice) floorRecoveryPrice = maxPrice;
        const floorWinner = roiFloorForRecovery > manualMinForRecovery ? 'ROI floor' 
          : manualMinForRecovery > roiFloorForRecovery ? 'Manual min' : 'Both equal';
        const floorDetailParts = [`Manual min: $${manualMinForRecovery.toFixed(2)}`];
        if (roiFloorForRecovery > 0) {
          const roiFloorLabel = roiPctForRecovery != null
            ? `$${roiFloorForRecovery.toFixed(2)} (min ROI: ${roiPctForRecovery}%)`
            : `$${roiFloorForRecovery.toFixed(2)}`;
          floorDetailParts.push(`ROI floor: ${roiFloorLabel}`);
        }
        floorDetailParts.push(`Effective floor: $${effectiveFloorForRecovery.toFixed(2)} (${floorWinner})`);
        const floorDetail = floorDetailParts.join(', ');
        console.log(`[BB Owner Floor Recovery] Current $${currentPrice.toFixed(2)} → $${floorRecoveryPrice.toFixed(2)} | ${floorDetail}`);
        guardsApplied.push('bb_owner_floor_recovery');
        return {
          mode: 'LOWER',
          newPrice: floorRecoveryPrice,
          rawTargetPrice: floorRecoveryPrice,
          reason: `Floor recovery: $${currentPrice.toFixed(2)} → $${floorRecoveryPrice.toFixed(2)} | ${floorDetail}`,
          guardsApplied,
          intelligenceFactors: intelligence,
          isRaise: true,
          anchorDiagnostics,
        };
      }

      if (targetWouldLower) {
        console.log(`[AI Eval] BB Owner Protection: Skipping lower from $${currentPrice.toFixed(2)} → $${targetPrice.toFixed(2)} (you own Buy Box)`);
      } else {
        console.log(`[AI Eval] BB Owner Protection: Holding current price at $${currentPrice.toFixed(2)} while owning Buy Box`);
      }
      return {
        mode: 'SKIP',
        newPrice: null,
        rawTargetPrice: targetPrice,
        reason: `Buy Box owner protection: keeping $${currentPrice.toFixed(2)} (already winning)`,
        guardsApplied: ['bb_owner_protection'],
        intelligenceFactors: intelligence,
      };
    }
  } else if (context.skipLowerWhenBbOwner && smartRaise.isBuyboxOwner && (intelligence.momentumTriggered || stockGatedMaximize)) {
    console.log(`[AI Eval] BB Owner Protection BYPASSED: ${stockGatedMaximize ? 'stock-gated maximize active' : 'momentum triggered'}`);
    guardsApplied.push(stockGatedMaximize ? 'bb_protection_bypassed_stock_gated_maximize' : 'bb_protection_bypassed_momentum_drop');
  }

  // === UNIVERSAL FLOOR RECOVERY ===
  // Runs for ALL ASINs (not just BB owners). If current price is below the effective
  // floor (manual min or ROI floor), force-raise to the floor immediately.
  // The BB-owner-specific recovery above handles the owner case with more detail;
  // this catches the non-owner case (e.g., losing BB but price stuck below floor).
  if (!smartRaise.isBuyboxOwner && currentPrice) {
    const ufrManualMin = minPrice || 0;
    const ufrRoiFloor = context.profitGuard?.minRoiEnabled
      ? (context.profitGuard?.profitFloorPrice || 0)
      : 0;
    const ufrRoiPct = context.profitGuard?.minRoiEnabled
      ? context.profitGuard?.minRoiPercent
      : null;
    const ufrEffectiveFloor = Math.max(ufrManualMin, ufrRoiFloor);
    if (ufrEffectiveFloor > 0 && currentPrice < ufrEffectiveFloor - 0.005) {
      let ufrRecoveryPrice = Math.round(ufrEffectiveFloor * 100) / 100;
      if (maxPrice && ufrRecoveryPrice > maxPrice) ufrRecoveryPrice = maxPrice;
      const ufrFloorWinner = ufrRoiFloor > ufrManualMin ? 'ROI floor'
        : ufrManualMin > ufrRoiFloor ? 'Manual min' : 'Both equal';
      const ufrDetailParts = [`Manual min: $${ufrManualMin.toFixed(2)}`];
      if (ufrRoiFloor > 0) {
        const ufrRoiLabel = ufrRoiPct != null
          ? `$${ufrRoiFloor.toFixed(2)} (min ROI: ${ufrRoiPct}%)`
          : `$${ufrRoiFloor.toFixed(2)}`;
        ufrDetailParts.push(`ROI floor: ${ufrRoiLabel}`);
      }
      ufrDetailParts.push(`Effective floor: $${ufrEffectiveFloor.toFixed(2)} (${ufrFloorWinner})`);
      const ufrDetail = ufrDetailParts.join(', ');
      console.log(`[Universal Floor Recovery] NOT BB owner — current $${currentPrice.toFixed(2)} is below effective floor $${ufrEffectiveFloor.toFixed(2)} → raising to $${ufrRecoveryPrice.toFixed(2)} | ${ufrDetail}`);
      guardsApplied.push('universal_floor_recovery');
      return {
        mode: 'LOWER',
        newPrice: ufrRecoveryPrice,
        rawTargetPrice: ufrRecoveryPrice,
        reason: `Universal floor recovery: $${currentPrice.toFixed(2)} → $${ufrRecoveryPrice.toFixed(2)} | ${ufrDetail}`,
        guardsApplied,
        intelligenceFactors: intelligence,
        isRaise: true,
        anchorDiagnostics,
      };
    }
  }

  // === MONOPOLY MODE ===
  // Only engage when qualifying FBA competitor count is truly zero (self excluded).
  // HARDENING: Also check total competitor count from snapshot — if snapshot shows multiple offers
  // but fbaCompetitorCount is 0 (possibly from stale/throttled data), require additional proof
  const snapshotOfferCount = intelligence.competitorCount || offersCount || 0;
  const fbaCountReliable = intelligence.fbaCompetitorCount === 0 
    && (snapshotOfferCount <= 2 || intelligence.competitorCount === 0);
  const hasNoFbaCompetitors = fbaCountReliable && !intelligence.amazonSelling;
  
  if (intelligence.fbaCompetitorCount === 0 && snapshotOfferCount > 2) {
    console.log(`[Monopoly Mode] GUARD: fbaCompetitorCount=0 but snapshot shows ${snapshotOfferCount} total offers — monopoly suppressed (data may be stale)`);
  }
  
  const fbmBuyboxOwner = buyboxSellerType === 'FBM';
  const isFbmMode = context.yourFulfillmentType === 'FBM';
  
  // Treat suppressed BB as effective ownership when we have zero qualifying FBA competitors.
  const effectiveBbOwner = smartRaise.isBuyboxOwner || (isBuyboxSuppressed && hasNoFbaCompetitors);
  if (isBuyboxSuppressed && hasNoFbaCompetitors && !smartRaise.isBuyboxOwner) {
    console.log(`[Monopoly Mode] BB suppressed but no qualifying FBA competitors — treating as effective BB owner`);
  }
  
  // Monopoly mode is FBA-only — skip entirely in FBM mode
  if (context.monopolyMode.enabled && hasNoFbaCompetitors && effectiveBbOwner && currentPrice && !isFbmMode) {
    // We are the only qualifying FBA seller and own the Buy Box - enter monopoly pricing mode
    console.log(`[Monopoly Mode] ENGAGED: No qualifying FBA competitors (${intelligence.fbaCompetitorCount} qualifying FBA, ${intelligence.competitorCount} total, ${snapshotOfferCount} snapshot offers), we own BB`);
    
    // Don't raise if FBM is the Buy Box owner (they beat us somehow)
    if (fbmBuyboxOwner) {
      console.log(`[Monopoly Mode] SKIPPED: FBM owns Buy Box, need to compete`);
    } else {
      const { monopolyMode } = context;
      
      // Calculate raise step based on mode
      let raiseAmount: number;
      if (monopolyMode.mode === 'aggressive') {
        // Aggressive: Larger steps, maximize quickly
        raiseAmount = Math.max(monopolyMode.raiseStepDollars || 0.15, currentPrice * ((monopolyMode.raiseStepPercent || 2) / 100));
      } else {
        // Conservative: Smaller steps, protect sales
        raiseAmount = Math.min(monopolyMode.raiseStepDollars || 0.10, currentPrice * ((monopolyMode.raiseStepPercent || 1) / 100));
      }
      
      let targetRaisePrice = currentPrice + raiseAmount;
      
      // CRITICAL: If current price is below min, jump to min first
      if (minPrice && currentPrice < minPrice) {
        console.log(`[Monopoly Mode] Current price $${currentPrice.toFixed(2)} is below min $${minPrice.toFixed(2)} — jumping to min`);
        targetRaisePrice = minPrice;
        guardsApplied.push('monopoly_min_recovery');
      }
      
      // Check cooldown specific to monopoly mode
      if (lastRepricedAt && monopolyMode.cooldownMinutes > 0) {
        const lastRepricedTime = new Date(lastRepricedAt).getTime();
        const monopolyCooldownMs = monopolyMode.cooldownMinutes * 60 * 1000;
        const now = Date.now();
        if (now - lastRepricedTime < monopolyCooldownMs) {
          const remainingMins = Math.ceil((monopolyCooldownMs - (now - lastRepricedTime)) / 60000);
          return {
            mode: 'SKIP',
            newPrice: null,
            rawTargetPrice: null,
            reason: `Monopoly cooldown: ${remainingMins} min remaining`,
            guardsApplied: ['monopoly_cooldown'],
            intelligenceFactors: intelligence,
          };
        }
      }
      
      // Apply profit guard / max price limits
      const { profitGuard } = context;
      if (maxPrice && targetRaisePrice > maxPrice) {
        targetRaisePrice = maxPrice;
        guardsApplied.push('monopoly_max_price');
      }
      
      // Safety: Don't raise above 10% in one step
      const maxJump = Math.min(2.0, currentPrice * 0.10);
      if ((targetRaisePrice - currentPrice) > maxJump) {
        targetRaisePrice = currentPrice + maxJump;
        guardsApplied.push('monopoly_jump_limit');
      }
      
      // FINAL HARD CLAMP: ensure min is respected after all adjustments
      if (minPrice && targetRaisePrice < minPrice) {
        console.log(`[Monopoly Mode] FINAL CLAMP MIN: $${targetRaisePrice.toFixed(2)} → $${minPrice.toFixed(2)}`);
        targetRaisePrice = minPrice;
        guardsApplied.push('FINAL_CLAMP_MIN');
      }
      
      // Round to cents
      targetRaisePrice = Math.round(targetRaisePrice * 100) / 100;
      
      // SAFETY ASSERT: Abort if still below min after clamp
      if (minPrice && targetRaisePrice < minPrice) {
        console.error(`[FATAL] Monopoly price $${targetRaisePrice} < min $${minPrice} AFTER CLAMP. Aborting.`);
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: targetRaisePrice,
          reason: `SAFETY ABORT: Monopoly price $${targetRaisePrice} below min $${minPrice}`,
          guardsApplied: ['SAFETY_ABORT_MIN'],
          intelligenceFactors: intelligence,
        };
      }
      
      // Only raise if we're actually going up and not at max
      if (targetRaisePrice > currentPrice && (!maxPrice || targetRaisePrice <= maxPrice)) {
        console.log(`[Monopoly Mode] RAISING: $${currentPrice.toFixed(2)} → $${targetRaisePrice.toFixed(2)} (${monopolyMode.mode} mode)`);
        return {
          mode: 'MONOPOLY_RAISE',
          newPrice: targetRaisePrice,
          rawTargetPrice: targetRaisePrice,
          reason: `Monopoly Mode (${monopolyMode.mode}): Only FBA + BB owner. Raising $${currentPrice.toFixed(2)} → $${targetRaisePrice.toFixed(2)}`,
          guardsApplied,
          intelligenceFactors: intelligence,
          isRaise: true,
        };
      } else if (maxPrice && currentPrice > maxPrice) {
        // Current price is ABOVE the ceiling -- e.g. min/max was lowered
        // after the price was already set, or a stale/unsynced price. The
        // old code always fell through to SKIP/null here, permanently
        // leaving an over-ceiling price stuck forever with no corrective
        // action. Confirmed live: B01JIA5DOK held at $34.31 (max $32) for
        // 7+ evaluation cycles over an hour, each logging "At ceiling
        // $32.00" with no actual price change. Actively lower to the
        // ceiling instead.
        console.log(`[Monopoly Mode] LOWERING to ceiling: $${currentPrice.toFixed(2)} → $${maxPrice.toFixed(2)} (price was above max)`);
        return {
          mode: 'LOWER',
          newPrice: maxPrice,
          rawTargetPrice: maxPrice,
          reason: `Monopoly Mode: Price $${currentPrice.toFixed(2)} was above ceiling — lowering to $${maxPrice.toFixed(2)}`,
          guardsApplied: ['monopoly_max_price'],
          intelligenceFactors: intelligence,
          isRaise: false,
        };
      } else {
        // Already at max or can't raise further
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: maxPrice || currentPrice,
          reason: `Monopoly Mode: At ceiling $${maxPrice?.toFixed(2) || currentPrice.toFixed(2)}`,
          guardsApplied: ['at_max'],
          intelligenceFactors: intelligence,
        };
      }
    }
  }
  
  // === IGNORE FBM UNLESS THEY OWN BUY BOX ===
  // CRITICAL FIX: When "Ignore FBM unless BB" is enabled, we must:
  // 1. Completely ignore FBM offers when Buy Box is FBA-owned
  // 2. Only consider FBM offers when FBM actually wins the Buy Box OR Buy Box is suppressed
  // 3. Never chase FBM prices that don't affect Buy Box eligibility
  //
  // This prevents the margin-destroying behavior where FBA sellers lower prices to match
  // cheaper FBM sellers who have no chance of winning Buy Box anyway.
  
  let shouldIgnoreFbm = false;
  let fbmIgnoreReason = '';
  
  // === FBM MODE: If YOU are FBM, never blanket-ignore FBM competitors ===
  if (context.yourFulfillmentType === 'FBM') {
    shouldIgnoreFbm = false;
    fbmIgnoreReason = 'FBM mode: you are FBM — competing with all sellers';
    console.log(`[FBM Filter] FBM MODE: Never ignoring FBM competitors (you are FBM)`);
  } else if (context.ignoreFbmUnlessBuyboxOwner) {
    // FBA mode: keep existing behavior
    const buyboxIsFba = buyboxSellerType === 'FBA' || buyboxSellerType === 'Amazon';
    const buyboxIsFbm = buyboxSellerType === 'FBM';
    const noBuybox = !buyboxPrice || isBuyboxSuppressed;
    
    if (buyboxIsFba || smartRaise.isBuyboxOwner) {
      shouldIgnoreFbm = true;
      fbmIgnoreReason = `FBA owns Buy Box (seller_type: ${buyboxSellerType}, we_own: ${smartRaise.isBuyboxOwner})`;
      console.log(`[FBM Filter] IGNORING FBM: ${fbmIgnoreReason}`);
    } else if (buyboxIsFbm) {
      shouldIgnoreFbm = false;
      fbmIgnoreReason = 'FBM owns Buy Box - competing';
      console.log(`[FBM Filter] COMPETING: FBM owns Buy Box at $${buyboxPrice?.toFixed(2)}`);
    } else if (noBuybox) {
      shouldIgnoreFbm = false;
      fbmIgnoreReason = 'Buy Box suppressed/unavailable - competing with all';
      console.log(`[FBM Filter] COMPETING: Buy Box suppressed, considering all offers`);
    } else {
      shouldIgnoreFbm = false;
      fbmIgnoreReason = 'Unknown Buy Box state';
    }
  }

  // Explicit, human-readable FBM-decision tag for the Action Log so the
  // narrative makes clear WHY a lower FBM offer was (or was not) chased.
  if (context.yourFulfillmentType === 'FBA') {
    if (shouldIgnoreFbm) {
      guardsApplied.push('fbm_offers_ignored_fba_only_rule');
    } else if (buyboxSellerType === 'FBM') {
      guardsApplied.push('fbm_owns_buybox_competing');
    }
  }

  // === FBM MODE: Monopoly mode should NOT trigger for FBM sellers ===
  // (Monopoly mode is FBA-centric — only valid when you're the sole FBA seller)

  // A) Only seller → DO_NOT_REPRICE (but respect monopoly mode if enabled)
  if (isOnlySeller || offersCount <= 1) {
    const behavior = rule.when_only_seller || 'DO_NOT_REPRICE';
    // If monopoly mode is enabled and we didn't already handle it, check if we should raise
    if (context.monopolyMode.enabled && currentPrice && maxPrice && currentPrice < maxPrice) {
      // Let monopoly logic above handle it on next run
    }
    if (behavior === 'DO_NOT_REPRICE') {
      return {
        mode: 'DO_NOT_REPRICE',
        newPrice: null,
        rawTargetPrice: null,
        reason: 'Only seller - keeping current price',
        guardsApplied: ['no_competitors'],
        intelligenceFactors: intelligence,
      };
    }
  }

  // B) Not Buy Box eligible → CUSTOM_PRICE
  // FBM sellers: "Not BB eligible" is EXPECTED — treat as soft signal, continue repricing
  // FBA sellers: bypass for aggressive/liquidation, block for others
  if (!isBuyboxEligible) {
    const currentSmartProfile = rule.smart_profile || 'CUSTOM';
    const isFbmSoftBypass = context.yourFulfillmentType === 'FBM';
    const aggressiveProfiles = ['VELOCITY_DOMINATOR'];
    const isAggressiveBypass = aggressiveProfiles.includes(currentSmartProfile);

    if (isFbmSoftBypass) {
      // FBM: "not BB eligible" is normal — continue repricing with soft signal
      console.log(`[BB_ELIGIBILITY_SOFT] asin=${context.asin} FBM seller — "not BB eligible" is expected for FBM, continuing repricing`);
      guardsApplied.push('bb_eligible_soft_fbm');
    } else if (isAggressiveBypass) {
      // Aggressive/Liquidation profiles bypass the BB eligibility block
      console.log(`[BB_ELIGIBILITY_BYPASS] asin=${context.asin} profile=${currentSmartProfile} — bypassing "not eligible" block to allow controlled price descent`);
      guardsApplied.push('bb_eligibility_bypass');
    } else {
      const behavior = rule.when_not_buybox_eligible || 'CUSTOM_PRICE';
      if (behavior === 'CUSTOM_PRICE') {
        if (currentPrice && currentPrice > 0) {
          return {
            mode: 'CUSTOM_PRICE',
            newPrice: currentPrice,
            rawTargetPrice: currentPrice,
            reason: 'Not Buy Box eligible - keeping current price',
            guardsApplied: [],
            intelligenceFactors: intelligence,
          };
        }
        let fallback = buyboxPrice || lowestOverallPrice || minPrice || 0;
        if (minPrice && fallback < minPrice) fallback = minPrice;
        if (maxPrice && fallback > maxPrice) fallback = maxPrice;
        return {
          mode: 'CUSTOM_PRICE',
          newPrice: fallback,
          rawTargetPrice: fallback,
          reason: `Not Buy Box eligible - set to fallback $${fallback?.toFixed(2)}`,
          guardsApplied: minPrice || maxPrice ? ['price_bounds'] : [],
          intelligenceFactors: intelligence,
        };
      }
    }
  }

  // C) Backordered → MIN_PRICE
  if (isBackordered) {
    const behavior = rule.when_backordered || 'MIN_PRICE';
    if (behavior === 'MIN_PRICE' && minPrice) {
      return {
        mode: 'MIN_PRICE',
        newPrice: minPrice,
        rawTargetPrice: minPrice,
        reason: `Product backordered - set to min price $${minPrice.toFixed(2)}`,
        guardsApplied: ['min_price'],
        intelligenceFactors: intelligence,
      };
    }
  }

  // D) Buy Box suppressed → use lowest overall price or lower toward floor
  // EXCEPTION: If we're the only FBA seller, don't lower — Monopoly Mode should have handled this above
  // If we reach here with only-FBA status, it means monopoly mode is disabled or cooldown, so just hold
  if (isBuyboxSuppressed) {
    if (hasNoFbaCompetitors && !isFbmMode) {
      console.log(`[Suppressed BB] Only FBA seller — holding price instead of lowering (monopoly territory)`);
      return {
        mode: 'SKIP',
        newPrice: null,
        rawTargetPrice: currentPrice,
        reason: `Buy Box suppressed but only FBA seller — holding price (monopoly hold)`,
        guardsApplied: ['monopoly_suppressed_hold'],
        intelligenceFactors: intelligence,
      };
    }
    const behavior = rule.when_buybox_suppressed || 'AI_REPRICE';
    if (behavior === 'MIN_PRICE' && minPrice) {
      return {
        mode: 'MIN_PRICE',
        newPrice: minPrice,
        rawTargetPrice: minPrice,
        reason: `Buy Box suppressed - set to min price $${minPrice.toFixed(2)}`,
        guardsApplied: ['min_price'],
        intelligenceFactors: intelligence,
      };
    }
    
    // For AI_REPRICE mode: try to find a target price to win the Buy Box
    // When Buy Box is suppressed (price too high), we need to lower toward market prices
    if (behavior === 'AI_REPRICE') {
      // Suppressed BB must use the configured live market anchor only.
      // Do NOT use smartRaise.lowestEligibleCompetitorPrice here: when BB is suppressed
      // there is no active Buy Box winner, so a hidden "eligible" anchor is misleading
      // and can cause unexpected jumps to the next higher seller.
      const isFbmMode = context.yourFulfillmentType === 'FBM';
      // Anchor choice must follow the STRATEGY, not merely our own fulfilment
      // type. This read `!isFbmMode` alone, so an FBA seller always demanded a
      // "lowest competitor FBA" anchor even when the rule was explicitly
      // "FBA competes with FBM".
      //
      // For a seller who is the ONLY FBA offer that is unsatisfiable by
      // definition: there are no FBA competitors, so referencePrice is null,
      // the guard below records suppressed_bb_anchor_unavailable, and the
      // price holds forever while FBM competitors sit underneath it.
      //
      // Observed 2026-09-04 on B0G2YNN87D (US): strategy "FBA competes with
      // FBM", sole FBA seller, held at $48.75 against FBM offers at $39.93 and
      // $39.95 for two days, and the log carried both
      // "FBA competes with FBM" and
      // "suppressed_anchor_source_lowest_competitor_fba" -- the contradiction
      // in one line. Selling only resumed when the price was dropped by hand
      // in Seller Central.
      //
      // competeWithFbm is already honoured everywhere else in this file; it
      // was simply never consulted on the suppressed-Buy-Box path.
      const shouldUseFbaOnly = !isFbmMode && !competeWithFbm;
      // BUGFIX: When BB is suppressed, the anchor must be the lowest COMPETITOR offer
      // (excluding our own seller_id). Using lowestFbaPrice/lowestOverallPrice directly
      // can include our own offer, which causes the repricer to incorrectly believe it
      // is already at the lowest FBA and hold equal (tied) instead of undercutting by $0.01.
      const isSelfOffer = (o: any): boolean => {
        if (o?.is_self === true) return true;
        if (context.yourSellerId && o?.seller_id === context.yourSellerId) return true;
        return false;
      };
      const competitorOffers = (offers || []).filter((o: any) => !isSelfOffer(o));
      const competitorPrices = (filterFn: (o: any) => boolean): number[] =>
        competitorOffers
          .filter(filterFn)
          .map(externalOfferPrice)
          .filter((p): p is number => p != null && p > 0)
          .sort((a, b) => a - b);
      const competitorFbaPrices = competitorPrices((o: any) => o.is_fba === true);
      const competitorAllPrices = competitorPrices(() => true);
      const lowestCompetitorFbaPrice = competitorFbaPrices[0] ?? null;
      const lowestCompetitorOverallPrice = competitorAllPrices[0] ?? null;
      // Fall back to the aggregate values only if we have no per-offer data
      // (otherwise per-offer competitor-only data is authoritative).
      const hasOfferLevelData = (offers || []).length > 0;
      const referencePrice = shouldUseFbaOnly
        ? (hasOfferLevelData
            ? (lowestCompetitorFbaPrice && lowestCompetitorFbaPrice > 0 ? lowestCompetitorFbaPrice : null)
            : (lowestFbaPrice && lowestFbaPrice > 0 ? lowestFbaPrice : null))
        : (hasOfferLevelData
            ? (lowestCompetitorOverallPrice && lowestCompetitorOverallPrice > 0 ? lowestCompetitorOverallPrice : null)
            : (lowestOverallPrice && lowestOverallPrice > 0 ? lowestOverallPrice : null));
      const anchorSourceLabel = shouldUseFbaOnly ? 'lowest competitor FBA' : 'lowest competitor overall';
      const usedFiltered = false;
      const rawCompetitorBelowMe = referencePrice != null && referencePrice > 0
        && currentPrice != null && currentPrice > referencePrice + 0.005;
      guardsApplied.push(`suppressed_anchor_source_${shouldUseFbaOnly ? 'lowest_competitor_fba' : 'lowest_competitor_overall'}`);
      if (referencePrice != null) guardsApplied.push(`suppressed_anchor_price_${referencePrice.toFixed(2)}`);
      console.log(`[Suppressed BB AI_REPRICE] anchorSource=${anchorSourceLabel}, referencePrice=$${referencePrice?.toFixed(2) ?? 'null'}, rawBelowMe=${rawCompetitorBelowMe}, ignoredEligibleAnchor=$${smartRaise.lowestEligibleCompetitorPrice?.toFixed(2) ?? 'null'}, lowestCompetitorFba=$${lowestCompetitorFbaPrice?.toFixed(2) ?? 'null'}, lowestCompetitorOverall=$${lowestCompetitorOverallPrice?.toFixed(2) ?? 'null'}, aggregateLowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'}, aggregateLowestOverall=$${lowestOverallPrice?.toFixed(2) ?? 'null'}, offerCount=${(offers || []).length}, competitorCount=${competitorOffers.length}`);
      
      // PROTECTION: If we are already at/below the configured suppressed-BB target,
      // do NOT undercut further. IMPORTANT: equality with a competitor is NOT safe
      // when BB is suppressed. Equal-price competitors must count, so current ==
      // anchor should still move to anchor - suppressed_bb_undercut.
      const rawSuppressedUndercutForHold = context.suppressedBbUndercut;
      const hasExplicitUndercutForHold = rawSuppressedUndercutForHold != null && !Number.isNaN(Number(rawSuppressedUndercutForHold));
      const configuredSuppressedUndercutForHold = hasExplicitUndercutForHold
        ? Math.max(0, Number(rawSuppressedUndercutForHold) || 0)
        : null;
      const suppressedAnchorTargetForHold = referencePrice != null && configuredSuppressedUndercutForHold != null
        ? Math.round((referencePrice - configuredSuppressedUndercutForHold) * 100) / 100
        : null;
      const amIAlreadyAtOrBelowSuppressedTarget = currentPrice != null && suppressedAnchorTargetForHold != null
        && currentPrice <= suppressedAnchorTargetForHold + 0.005;
      const amIAlreadyLowestFiltered = currentPrice != null && referencePrice != null 
        && currentPrice <= referencePrice + 0.01;
      
      if (amIAlreadyLowestFiltered && !isFbmMode && !rawCompetitorBelowMe && (!hasExplicitUndercutForHold || amIAlreadyAtOrBelowSuppressedTarget)) {
        // SMART RAISE: if rule has explicit suppressed_bb_undercut and our current price
        // is meaningfully BELOW (configured suppressed anchor - undercut), raise toward that target.
        // Anchor is ONLY the visible configured anchor (lowest FBA for FBA listings, lowest overall for FBM).
        const rawSU = rawSuppressedUndercutForHold;
        const hasExplicitUndercut = hasExplicitUndercutForHold;
        const smartRaiseAnchor = referencePrice != null && currentPrice != null && referencePrice > currentPrice + 0.005
          ? referencePrice
          : null;
        const undercutForLog = hasExplicitUndercut ? Math.max(0, Number(rawSU) || 0) : null;
        const targetForLog = (hasExplicitUndercut && smartRaiseAnchor != null)
          ? Math.round((smartRaiseAnchor - (undercutForLog ?? 0)) * 100) / 100
          : null;
        const branchDecision = !hasExplicitUndercut
          ? 'hold(no_explicit_undercut)'
          : smartRaiseAnchor == null
            ? 'hold(no_anchor_above)'
            : (targetForLog != null && currentPrice != null && targetForLog > currentPrice + 0.005)
              ? 'raise'
              : 'hold(at_target)';
        console.log(`[Suppressed BB] suppressed_bb_target=$${targetForLog?.toFixed(2) ?? 'null'} suppressed_bb_branch=${branchDecision} (current=$${currentPrice?.toFixed(2)} anchor=$${smartRaiseAnchor?.toFixed(2) ?? 'null'} source=${anchorSourceLabel} undercut=${undercutForLog?.toFixed(3) ?? 'null'} ignoredEligibleAnchor=$${smartRaise.lowestEligibleCompetitorPrice?.toFixed(2) ?? 'null'} lowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'})`);
        guardsApplied.push(`suppressed_bb_branch_${branchDecision.replace(/[^a-z0-9]+/gi,'_')}`);
        if (targetForLog != null) guardsApplied.push(`suppressed_bb_target_${targetForLog.toFixed(2)}`);

        if (hasExplicitUndercut && currentPrice != null && smartRaiseAnchor != null && smartRaiseAnchor > 0) {
          const undercut = Math.max(0, Number(rawSU) || 0);
          let raiseTarget = Math.round((smartRaiseAnchor - undercut) * 100) / 100;
          if (raiseTarget > currentPrice + 0.005) {
            // Apply min/max + max_step + ceiling clamps
            if (minPrice && raiseTarget < minPrice) { raiseTarget = minPrice; guardsApplied.push('min_price'); }
            if (maxPrice && raiseTarget > maxPrice) { raiseTarget = maxPrice; guardsApplied.push('max_price'); }
            const maxChangeDollar = Math.max(maxStepAmount || 0.50, currentPrice * ((maxStepPercent || 5) / 100));
            const delta = raiseTarget - currentPrice;
            if (Math.abs(delta) > maxChangeDollar) {
              raiseTarget = Math.round((currentPrice + maxChangeDollar) * 100) / 100;
              guardsApplied.push('max_step');
            }
            raiseTarget = Math.round(raiseTarget * 100) / 100;
            if (raiseTarget > currentPrice + 0.005) {
              guardsApplied.push('suppressed_bb_smart_raise_to_configured_anchor');
              console.log(`[Suppressed BB] SMART RAISE — current $${currentPrice.toFixed(2)} below anchor $${smartRaiseAnchor.toFixed(2)} - undercut $${undercut.toFixed(2)} = target $${raiseTarget.toFixed(2)}`);
              return {
                mode: 'AI_REPRICE',
                newPrice: raiseTarget,
                rawTargetPrice: smartRaiseAnchor,
                reason: `Buy Box suppressed — raising toward ${anchorSourceLabel} while staying $${undercut.toFixed(2)} below it: $${currentPrice.toFixed(2)} → $${raiseTarget.toFixed(2)} (anchor $${smartRaiseAnchor.toFixed(2)})`,
                guardsApplied,
                intelligenceFactors: intelligence,
              };
            }
          }
        }

        console.log(`[Suppressed BB] Already lowest against ${anchorSourceLabel} ($${currentPrice?.toFixed(2)} <= anchor $${referencePrice?.toFixed(2)}) and no raw competitor below — holding`);
        guardsApplied.push('suppressed_bb_anchor_hold');
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: currentPrice,
          reason: `Buy Box suppressed — already at or below ${anchorSourceLabel}; holding $${currentPrice?.toFixed(2)} (anchor $${referencePrice?.toFixed(2)})`,
          guardsApplied: [...guardsApplied],
          intelligenceFactors: intelligence,
        };
      }

      if (amIAlreadyLowestFiltered && !isFbmMode && !rawCompetitorBelowMe && hasExplicitUndercutForHold && !amIAlreadyAtOrBelowSuppressedTarget) {
        guardsApplied.push('suppressed_bb_equal_competitor_counts');
        console.log(`[Suppressed BB] Equal/near-equal competitor counts — current $${currentPrice?.toFixed(2)} is tied with anchor $${referencePrice?.toFixed(2)}, forcing target $${suppressedAnchorTargetForHold?.toFixed(2)} instead of holding`);
      }
      
      // If already lowest against the anchor but a raw competitor IS below us, override the hold and compete
      if (amIAlreadyLowestFiltered && !isFbmMode && rawCompetitorBelowMe) {
        console.log(`[Suppressed BB] Already lowest against configured anchor but raw competitor at $${referencePrice?.toFixed(2)} is below current $${currentPrice?.toFixed(2)} — overriding hold to compete`);
        guardsApplied.push('suppressed_bb_filtered_hold_override_raw_below');
      }

      if (referencePrice && referencePrice > 0) {
        // SUPPRESSED BB UNDERCUT — per-rule USER-REQUIRED setting (NO default).
        // The user must explicitly set `suppressed_bb_undercut` on the rule.
        // - null/undefined → SKIP suppressed-BB pricing entirely (no implicit fallback).
        // - 0 → match exactly.
        // - positive → undercut lowest valid by that amount.
        // This explicit suppressed-BB value wins even when the normal rule is match-only.
        const rawSuppressedUndercut = context.suppressedBbUndercut;
        if (rawSuppressedUndercut == null || Number.isNaN(Number(rawSuppressedUndercut))) {
          console.log(`[Suppressed BB] SKIP — rule has no suppressed_bb_undercut configured (user-required, no default).`);
          return {
            mode: 'SKIP',
            newPrice: null,
            rawTargetPrice: referencePrice,
            reason: 'Buy Box suppressed — skipped: rule has no Suppressed BB Undercut configured. Set the value in the rule editor.',
            guardsApplied: [...guardsApplied, 'suppressed_bb_undercut_unset'],
            intelligenceFactors: intelligence,
          };
        }
        const fbaCompCount = intelligence.fbaCompetitorCount ?? 0;
        const userSuppressedUndercut = Math.max(0, Number(rawSuppressedUndercut) || 0);
        const effectiveSuppressedUndercut = userSuppressedUndercut;

        if (context.matchExactly) {
          console.log(`[Suppressed BB] MATCH_EXACTLY present, but explicit suppressed_bb_undercut=$${userSuppressedUndercut.toFixed(3)} controls suppressed-BB pricing`);
          guardsApplied.push('suppressed_bb_explicit_undercut_overrode_strict_match');
        } else {
          console.log(`[Suppressed BB] User suppressed-BB undercut: $${userSuppressedUndercut.toFixed(3)} (rule_undercut=$${undercutAmount.toFixed(3)}, fba_competitors=${fbaCompCount})`);
          guardsApplied.push(`suppressed_bb_user_undercut_${userSuppressedUndercut.toFixed(3)}`);
        }

        let targetPrice = referencePrice - effectiveSuppressedUndercut;
        const competitiveTargetBeforeGuards = Math.round(targetPrice * 100) / 100;
        guardsApplied.push(`suppressed_bb_target_${competitiveTargetBeforeGuards.toFixed(2)}`);
        
        const { profitGuard } = context;
        if (profitGuard.profitFloorPrice && targetPrice < profitGuard.profitFloorPrice) {
          console.log(`[AI Eval] ROI floor analytics only: target $${targetPrice.toFixed(2)} is below ROI floor $${profitGuard.profitFloorPrice.toFixed(2)} — min price remains the only blocking floor`);
        }
        
        // Apply min/max bounds
        if (minPrice && targetPrice < minPrice) {
          targetPrice = minPrice;
          guardsApplied.push('min_price');
        }
        if (maxPrice && targetPrice > maxPrice) {
          targetPrice = maxPrice;
          guardsApplied.push('max_price');
        }
        
        // Suppressed-BB explicit undercut is a POSITIONING rule, not a gradual move.
        // max_step would land us short of the promised "anchor − undercut" target and
        // make the log message ("$0.01 undercut") misleading. We bypass max_step here
        // and rely on min_price + ROI floor + max_price as the real safety rails.
        // For diagnostics, record the would-be clamp so we can audit big drops.
        if (currentPrice && currentPrice > 0) {
          const maxChangeDollar = Math.max(maxStepAmount || 0.50, currentPrice * ((maxStepPercent || 5) / 100));
          const priceDelta = targetPrice - currentPrice;
          if (Math.abs(priceDelta) > maxChangeDollar) {
            guardsApplied.push('suppressed_bb_max_step_bypassed');
            guardsApplied.push(`suppressed_bb_drop_${Math.abs(priceDelta).toFixed(2)}`);
            console.log(`[Suppressed BB] max_step BYPASSED — explicit undercut is a positioning rule. delta=$${priceDelta.toFixed(2)} would-be-cap=$${maxChangeDollar.toFixed(2)} target=$${targetPrice.toFixed(2)} (floors still enforced: min=$${minPrice?.toFixed(2) ?? 'null'})`);
          }
        }
        
        targetPrice = Math.round(targetPrice * 100) / 100;
        
        // POST-ROUNDING VALIDATION: Ensure we're truly BELOW reference, not matching.
        // Even with the undercut override, rounding can still produce a match.
        // If user entered 0.00, matching the reference is the desired outcome.
        const referenceCents = Math.round(referencePrice * 100);
        const targetCents = Math.round(targetPrice * 100);
        if (effectiveSuppressedUndercut > 0 && targetCents >= referenceCents && !guardsApplied.includes('min_price')) {
          // Still matching or above after rounding — force $0.01 below
          targetPrice = (referenceCents - 1) / 100;
          console.log(`[Suppressed BB] Post-rounding fix: target rounded to match/above reference $${referencePrice.toFixed(2)} → forced to $${targetPrice.toFixed(2)}`);
          guardsApplied.push('suppressed_bb_rounding_fix');
          // Re-check min price after rounding fix
          if (minPrice && targetPrice < minPrice) {
            targetPrice = minPrice;
            if (!guardsApplied.includes('min_price')) guardsApplied.push('min_price');
            console.log(`[Suppressed BB] Rounding fix blocked by min floor $${minPrice.toFixed(2)} — override attempted but floor takes priority`);
          }
        } else if (effectiveSuppressedUndercut === 0 && targetCents >= referenceCents) {
          console.log(`[Suppressed BB] Explicit $0.00 suppressed-BB undercut — keeping target $${targetPrice.toFixed(2)} matching reference $${referencePrice.toFixed(2)}`);
          guardsApplied.push('suppressed_bb_explicit_match');
        }
        
        // Skip if change too small (use cents to avoid floating-point precision errors)
        if (currentPrice && Math.round(targetPrice * 100) === Math.round(currentPrice * 100)) {
          // Smart suggestion for suppressed Buy Box SKIP path (min clamp can hide competitiveness)
          let requiresMinPriceLower = false;
          let suggestedNewMinPrice: number | undefined = undefined;
          let minGapAmount: number | undefined = undefined;
          let minGapPercent: number | undefined = undefined;

          const wasClampedByMin = guardsApplied.includes('min_price');
          const constraintPrice = minPrice || 0;

          if (wasClampedByMin && constraintPrice > 0 && competitiveTargetBeforeGuards < constraintPrice) {
            const gap = constraintPrice - competitiveTargetBeforeGuards;
            const gapPct = (gap / constraintPrice) * 100;

            // Small gaps matter in competitive markets; include >= $0.005 moves
            if (gap >= 0.005 || gapPct > 0.05) {
              const candidateMin = Math.floor(competitiveTargetBeforeGuards * 20) / 20; // nearest $0.05 down
              const candidateSuggestion = Math.round(candidateMin * 100) / 100;

              if (candidateSuggestion < constraintPrice) {
                requiresMinPriceLower = true;
                suggestedNewMinPrice = candidateSuggestion;
                minGapAmount = Math.round(gap * 100) / 100;
                minGapPercent = Math.round(gapPct * 10) / 10;
                guardsApplied.push('MIN_PRICE_SUGGESTION');
                console.log(`[MIN_SUGGESTION] bb_suppressed_no_change, min=$${constraintPrice.toFixed(2)}, competitive=$${competitiveTargetBeforeGuards.toFixed(2)}, gap=$${gap.toFixed(3)}, suggested_new_min=$${candidateSuggestion.toFixed(2)}`);
              }
            }
          }

          const constraintTag = guardsApplied.length > 0
            ? ` [constrained_by: ${guardsApplied.join(',')}]`
            : ' [constrained_by: market_stable]';

          return {
            mode: 'SKIP',
            newPrice: null,
            // For UI/log clarity this should represent the market anchor (e.g., lowest FBA),
            // not the undercut-adjusted target.
            rawTargetPrice: referencePrice,
            reason: (guardsApplied.includes('min_price') || guardsApplied.includes('effective_floor') || guardsApplied.includes('MIN_PRICE_SUGGESTION'))
              ? `Buy Box suppressed — competitive target $${competitiveTargetBeforeGuards?.toFixed(2) ?? '?'} blocked by effective floor $${(minPrice || 0).toFixed(2)}${constraintTag}`
              : `Buy Box suppressed - price change too small (<$0.01)${constraintTag}`,
            guardsApplied,
            requiresMinPriceLower,
            suggestedNewMinPrice: suggestedNewMinPrice ? Math.round(suggestedNewMinPrice * 100) / 100 : undefined,
            effectiveFloor: Math.round(constraintPrice * 100) / 100,
            minGapAmount,
            minGapPercent,
            intelligenceFactors: intelligence,
          };
        }
        
        // Build reason with explicit safeguard mention when min floor clamped the price
        const competitiveTarget = referencePrice - effectiveSuppressedUndercut;
        const wasClampedToMin = guardsApplied.includes('min_price') && minPrice && competitiveTarget < minPrice;
        const overrideTag = ` [suppressed_bb_undercut: $${effectiveSuppressedUndercut.toFixed(3)}]`;
        const roundingFixTag = guardsApplied.includes('suppressed_bb_rounding_fix') ? ' [rounding_fixed]' : '';
        const anchorLabel = usedFiltered ? 'filtered FBA' : (shouldUseFbaOnly ? 'FBA' : '');
        const suppressedReason = wasClampedToMin
          ? `Buy Box suppressed - lowering toward lowest ${anchorLabel} ($${referencePrice.toFixed(2)}) → raw target $${competitiveTarget.toFixed(2)} ⚠️ Safeguard: clamped to Min floor $${minPrice.toFixed(2)}${overrideTag}`
          : `Buy Box suppressed - lowering toward lowest ${anchorLabel} ($${referencePrice.toFixed(2)}) → $${targetPrice.toFixed(2)}${overrideTag}${roundingFixTag}`;

        return {
          mode: 'AI_REPRICE',
          newPrice: targetPrice,
          rawTargetPrice: referencePrice,
          reason: suppressedReason,
          guardsApplied,
          intelligenceFactors: intelligence,
        };
      }
      
      // If the configured suppressed anchor is unavailable, HOLD. Do not invent an
      // anchor or drift toward min floor while Buy Box is suppressed.
      if (!referencePrice || referencePrice <= 0) {
        guardsApplied.push('suppressed_bb_anchor_unavailable');
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: null,
          reason: `Buy Box suppressed — ${anchorSourceLabel} anchor unavailable; holding price`,
          guardsApplied,
          intelligenceFactors: intelligence,
        };
      }

      // Legacy fallback kept for defensive reachability only.
      const fallbackFloor = minPrice || null;
      
      if (currentPrice && fallbackFloor && fallbackFloor > 0) {
        // If we're above the configured min floor, lower by max_step toward it
        if (currentPrice > fallbackFloor) {
          const maxChangeDollar = Math.max(maxStepAmount || 0.50, currentPrice * ((maxStepPercent || 5) / 100));
          let targetPrice = Math.max(fallbackFloor, currentPrice - maxChangeDollar);
          
          if (minPrice && targetPrice < minPrice) {
            targetPrice = minPrice;
            guardsApplied.push('min_price');
          }
          
          targetPrice = Math.round(targetPrice * 100) / 100;
          
          if (currentPrice && Math.abs(targetPrice - currentPrice) < 0.01) {
            return {
              mode: 'SKIP',
              newPrice: null,
              rawTargetPrice: fallbackFloor,
              reason: 'Buy Box suppressed - already at or near min price',
              guardsApplied: minPrice ? ['min_price'] : [],
              intelligenceFactors: intelligence,
            };
          }
          
          guardsApplied.push('buybox_suppressed_lower');
          return {
            mode: 'AI_REPRICE',
            newPrice: targetPrice,
            rawTargetPrice: fallbackFloor,
            reason: `Buy Box suppressed - lowering toward min floor ($${fallbackFloor.toFixed(2)}) → $${targetPrice.toFixed(2)}`,
            guardsApplied,
            intelligenceFactors: intelligence,
          };
        }
      }
      
      return {
        mode: 'SKIP',
        newPrice: null,
        rawTargetPrice: null,
        reason: 'Buy Box suppressed - cannot lower further (no min floor room)',
        guardsApplied: minPrice ? ['min_price'] : [],
        intelligenceFactors: intelligence,
      };
    }
  }

  // E) Used condition handling
  if (conditionIsUsed) {
    const behavior = rule.when_condition_used || 'AI_REPRICE';
    if (behavior === 'MIN_PRICE' && minPrice) {
      return {
        mode: 'MIN_PRICE',
        newPrice: minPrice,
        rawTargetPrice: minPrice,
        reason: `Used condition - set to min price $${minPrice.toFixed(2)}`,
        guardsApplied: ['min_price'],
        intelligenceFactors: intelligence,
      };
    }
  }

  // F) AI_REPRICE: Build competitor set and calculate target price
  // CRITICAL: Exclude own offer from eligible competitors to prevent self-undercut
  const { yourSellerId } = context;
  let eligibleOffers = offers.filter((o: any) => {
    if (o.is_self) return false;
    if (yourSellerId && o.seller_id === yourSellerId) return false;
    // Condition-aware filtering: Used items only compete with Used, New with New
    if (conditionIsUsed && o.condition && o.condition !== 'Used' && !o.condition?.toLowerCase?.().includes('used')) return false;
    if (!conditionIsUsed && o.condition && o.condition === 'Used') return false;
    return true;
  });
  
  // Filter based on "compete with" settings
  if (!competeWithAmazon) {
    eligibleOffers = eligibleOffers.filter(o => 
      !(o.seller_name?.toLowerCase().includes('amazon') || o.seller_id === 'ATVPDKIKX0DER')
    );
  }
  if (!competeWithFba) {
    eligibleOffers = eligibleOffers.filter(o => !o.is_fba);
  }
  
  // CRITICAL FIX: Apply smart FBM filtering based on Buy Box ownership
  // If shouldIgnoreFbm is true, filter out ALL FBM offers completely
  // This prevents chasing FBM prices that don't affect FBA Buy Box eligibility
  // EXCEPTION: If YOU are FBM, never strip FBM competitors — they are your real market
  const iAmFbm = context.yourFulfillmentType === 'FBM';
  if (shouldIgnoreFbm && !iAmFbm) {
    const fbmCount = eligibleOffers.filter(o => !o.is_fba).length;
    eligibleOffers = eligibleOffers.filter(o => o.is_fba);
    if (fbmCount > 0) {
      guardsApplied.push(`fbm_ignored_${fbmCount}`);
      console.log(`[FBM Filter] Removed ${fbmCount} FBM offers from competition (${fbmIgnoreReason})`);
    }
  } else if (!competeWithFbm && !iAmFbm) {
    // Legacy behavior: compete_with_fbm = false (only for FBA sellers)
    eligibleOffers = eligibleOffers.filter(o => o.is_fba);
  } else if (iAmFbm && (!competeWithFbm || shouldIgnoreFbm)) {
    console.log(`[FBM Filter] FBM SELLER OVERRIDE: keeping ${eligibleOffers.filter(o => !o.is_fba).length} FBM competitors in pool (you are FBM — FBM is your real market)`);
    guardsApplied.push('fbm_seller_keep_fbm');
  }

  // === NEW: COMPETITOR QUALITY FILTERING ===
  // This is what makes us BETTER than BQool - clean inputs before pricing
  // Filter by: rating threshold, handling time, ships-from, top-N limit
  const qualityResult = filterCompetitorsByQuality(
    eligibleOffers, 
    context.competitorQuality, 
    context.marketplace
  );
  
  // DEBUG LOGGING - ChatGPT requested: show found vs filtered vs used
  console.log(`[Quality Filter] DEBUG COUNTERS:`, JSON.stringify(qualityResult.debug));
  
  // === CLUSTER-BASED PRICING: Detect outlier low offers vs market clusters ===
  const clusterInfo = qualityResult.clusterAnalysis;
  if (clusterInfo.lowestIsOutlier && clusterInfo.clusterAnchorPrice) {
    console.log(`[CLUSTER_PRICING] OUTLIER DETECTED: lowest offer is $${clusterInfo.outlierGap.toFixed(2)} (${clusterInfo.outlierGapPct.toFixed(1)}%) below cluster at $${clusterInfo.clusterAnchorPrice.toFixed(2)} | clusters: ${JSON.stringify(clusterInfo.clusters.map((c: any) => `${c.count}@$${c.median.toFixed(2)}`))}`);
    guardsApplied.push(`cluster_outlier_detected_gap_${clusterInfo.outlierGapPct.toFixed(0)}pct`);
  }
  
  if (qualityResult.excluded > 0) {
    eligibleOffers = qualityResult.filtered;
    guardsApplied.push(`quality_filter_${qualityResult.excluded}`);
    console.log(`[Quality Filter] Removed ${qualityResult.excluded} competitors: ${qualityResult.reasons.join(', ')} | Used: ${qualityResult.debug.competitors_used}`);
  } else {
    console.log(`[Quality Filter] All ${qualityResult.debug.competitors_found} competitors passed quality checks`);
  }

  if (eligibleOffers.length === 0) {
    // All competitors were filtered out (quality/FBM filters), but the snapshot has real offers.
    const snapshotHadOffers = offers.length > 0;
    const weOwnBuybox = smartRaise?.isBuyboxOwner || context.isBuyboxOwner;
    const hasExplicitExternalFbaCompetitor = context.qualifyingFbaCompetitorCount != null
      ? context.qualifyingFbaCompetitorCount > 0
      : null;
    const hasMaterialExternalFbaPrice = !!(
      lowestFbaPrice &&
      lowestFbaPrice > 0 &&
      currentPrice &&
      Math.abs(lowestFbaPrice - currentPrice) > 0.004
    );
    const hasExternalFbaCompetitor = hasExplicitExternalFbaCompetitor ?? hasMaterialExternalFbaPrice;
    
    // === FBM-ONLY PREMIUM LOGIC ===
    // If all external competitors were FBM (even when snapshot lowest_fba is our own offer),
    // price at a configurable premium above the lowest FBM instead of blocking.
    // SKIP when rule is "All Sellers (Aggressive)" — treat FBM as regular competitors instead.
    if (snapshotHadOffers && lowestFbmPrice && lowestFbmPrice > 0 && !hasExternalFbaCompetitor && context.ignoreFbmUnlessBuyboxOwner) {
      const fbmPremiumPct = (context.fbmPremiumPercent ?? 10) / 100;
      const fbmPremiumFixed = context.fbmPremiumFixed ?? 2.0;
      const pctPrice = Math.round(lowestFbmPrice * (1 + fbmPremiumPct) * 100) / 100;
      const fixedPrice = Math.round((lowestFbmPrice + fbmPremiumFixed) * 100) / 100;
      let fbmPremiumTarget = Math.max(pctPrice, fixedPrice);
      
      // Respect min/max bounds
      if (minPrice && fbmPremiumTarget < minPrice) fbmPremiumTarget = minPrice;
      if (maxPrice && fbmPremiumTarget > maxPrice) fbmPremiumTarget = maxPrice;
      
      console.log(`[FBM Premium] Only FBM competitors exist. Lowest FBM: $${lowestFbmPrice.toFixed(2)}, Premium target: $${fbmPremiumTarget.toFixed(2)} (pct=$${pctPrice.toFixed(2)}, fixed=$${fixedPrice.toFixed(2)}, qualifyingFbaCompetitors=${context.qualifyingFbaCompetitorCount ?? 'unknown'}, lowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'}, current=$${currentPrice?.toFixed(2) ?? 'null'})`);
      
      return {
        mode: 'CUSTOM_PRICE',
        newPrice: fbmPremiumTarget,
        rawTargetPrice: fbmPremiumTarget,
        reason: `FBM-only market: pricing at premium above lowest FBM $${lowestFbmPrice.toFixed(2)} → $${fbmPremiumTarget.toFixed(2)}`,
        guardsApplied: [...guardsApplied, 'fbm_premium_mode'],
        intelligenceFactors: intelligence,
      };
    } else if (snapshotHadOffers && lowestFbmPrice && lowestFbmPrice > 0 && !hasExternalFbaCompetitor && !context.ignoreFbmUnlessBuyboxOwner) {
      // "All Sellers (Aggressive)" mode: treat FBM as regular competitors, skip premium markup
      console.log(`[FBM Filter] ALL SELLERS mode: FBM-only market but treating FBM as regular competitors (no premium). Lowest FBM: $${lowestFbmPrice.toFixed(2)}`);
      // Fall through to normal pricing logic — FBM offers stay in eligible pool
    }
    
    if (snapshotHadOffers && weOwnBuybox && currentPrice) {
      console.log(`[Filtered Empty] ${offers.length} offers existed but all filtered out. We own BB — holding current price $${currentPrice.toFixed(2)}`);
      return {
        mode: 'HOLD',
        newPrice: currentPrice,
        rawTargetPrice: currentPrice,
        reason: `All ${offers.length} competitors filtered out (${qualityResult.reasons.join(', ')}${guardsApplied.filter(g => g.startsWith('fbm_ignored')).join(', ')}) — holding price (BB owned)`,
        guardsApplied: [...guardsApplied, 'filtered_empty_hold'],
        intelligenceFactors: intelligence,
      };
    }
    
    // === BUY BOX FALLBACK: Never block when Buy Box price exists ===
    // If all competitors were filtered out but we have a real Buy Box price,
    // use it as a synthetic anchor instead of returning "no competitors"
    if (snapshotHadOffers && buyboxPrice && buyboxPrice > 0 && currentPrice) {
      console.log(`[BB Fallback] All ${offers.length} competitors filtered out but Buy Box exists at $${buyboxPrice.toFixed(2)} — using as fallback anchor`);
      guardsApplied.push('bb_fallback_anchor');
      // Inject Buy Box as a synthetic eligible offer so normal pricing continues
      eligibleOffers = [{
        price: buyboxPrice,
        total_price: buyboxPrice,
        is_fba: context.buyboxSellerType === 'FBA',
        is_self: false,
        seller_id: 'buybox_fallback',
        seller_name: 'Buy Box (fallback)',
        condition: conditionIsUsed ? 'Used' : 'New',
        _synthetic: true,
      }];
      // Continue to normal pricing logic below (don't return)
    } else {
      return {
        mode: 'DO_NOT_REPRICE',
        newPrice: null,
        rawTargetPrice: null,
        reason: `No eligible competitors after filtering (${qualityResult.reasons.join(', ')})`,
        guardsApplied: ['no_competitors'],
        intelligenceFactors: intelligence,
      };
    }
  }

  // Find target price - prefer buybox winner, else lowest
  let targetPrice: number | null = null;
  let targetSource = '';

  // === BB CONFIDENCE GUARDRAIL ===
  // When bb_source is NOT 'winner_offer', the Buy Box price may be unreliable
  // (e.g., BuyBoxPrices summary often returns lowest competitive price, not actual winner)
  const bbSource = context._bbSource || 'missing';
  const bbIsReliable = bbSource === 'winner_offer';
  
  const hasSuppressedCompetitiveSnapshot =
    isBuyboxSuppressed && (((lowestFbaPrice ?? 0) > 0) || ((lowestOverallPrice ?? 0) > 0));

  // STRICT GUARD: If bbSource is 'missing' or offers are empty, NEVER lower price
  // EXCEPTION: In suppressed-BB mode, a real lowest-FBA/overall snapshot is enough
  // to allow the fallback lower path even when live offers are temporarily unavailable.
  if (bbSource === 'missing' || eligibleOffers.length === 0) {
    if (currentPrice) {
      if (hasSuppressedCompetitiveSnapshot) {
        console.log(
          `[BB Confidence] PARTIAL DATA: bbSource=${bbSource}, offers=${eligibleOffers.length}, suppressed BB with snapshot anchor (lowestFba=$${(lowestFbaPrice ?? 0).toFixed(2)}, lowestOverall=$${(lowestOverallPrice ?? 0).toFixed(2)}). Allowing fallback lower.`
        );
      } else {
        console.log(`[BB Confidence] NO DATA: bbSource=${bbSource}, offers=${eligibleOffers.length}. Will not lower price below current $${currentPrice.toFixed(2)}.`);
        // Allow the algorithm to continue but we'll clamp later to prevent lowering
        // Set a flag so downstream logic knows not to go below current
        (context as any)._noLowerFlag = true;
      }
    }
  }
  
  // BB confidence: when BB source is unreliable and price looks suspicious,
  // DON'T fully block — just mark BB as untrusted so we fall through to Lowest FBA anchor
  let bbUntrusted = false;
  if (!bbIsReliable && buyboxPrice && currentPrice) {
    const bbDropPercent = ((currentPrice - buyboxPrice) / currentPrice) * 100;
    if (bbDropPercent > 25) {
      // Check if we have solid Lowest FBA data to fall back to
      const lowestFbaFromOffers = eligibleOffers.filter(o => o.is_fba).length > 0
        ? Math.min(...eligibleOffers.filter(o => o.is_fba).map(o => o.total_price || o.price || Infinity))
        : null;
      
      if (lowestFbaFromOffers && lowestFbaFromOffers < Infinity) {
        // We have real FBA offer data — don't block, just skip BB as anchor
        bbUntrusted = true;
        console.log(`[BB Confidence] BB $${buyboxPrice.toFixed(2)} is ${bbDropPercent.toFixed(1)}% below current $${currentPrice.toFixed(2)} (source: ${bbSource}) — BB untrusted, will use Lowest FBA $${lowestFbaFromOffers.toFixed(2)} as anchor instead`);
      } else {
        // No reliable FBA data either — hold price
        console.log(`[BB Confidence] SUSPICIOUS: BB $${buyboxPrice.toFixed(2)} is ${bbDropPercent.toFixed(1)}% below current $${currentPrice.toFixed(2)} (source: ${bbSource}), no FBA fallback. Holding price.`);
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: buyboxPrice,
          reason: `BB confidence guard: BB $${buyboxPrice.toFixed(2)} is ${bbDropPercent.toFixed(0)}% below current (source: ${bbSource}) — holding price (no FBA fallback)`,
          guardsApplied: ['bb_confidence_guard'],
          intelligenceFactors: intelligence,
        };
      }
    }
  }

  // === FBM MODE vs FBA MODE target anchor ===
  const isFbmModeTarget = context.yourFulfillmentType === 'FBM';
  
  if (isFbmModeTarget) {
    // FBM mode: anchor selection depends on rule aggressiveness
    const buyboxWinner = eligibleOffers.find(o => o.is_buybox_winner);
    const bbIsFbm = buyboxSellerType === 'FBM' || buyboxSellerType === null || buyboxSellerType === 'unknown';
    const lowestEligible = Math.min(...eligibleOffers.map(o => o.total_price || o.price || Infinity));
    const lowestEligibleValid = lowestEligible && lowestEligible < Infinity ? lowestEligible : null;

    // Determine rule class for anchor selection
    const aggressiveProfiles = ['VELOCITY_DOMINATOR'];
    const currentFbmProfile = rule.smart_profile || 'CUSTOM';
    const isAggressiveFbm = aggressiveProfiles.includes(currentFbmProfile);
    
    if (fbmMarketAnchorPrice && fbmMarketAnchorPrice > 0) {
      // FBM-owned listings fight the FBM ladder first. Quality filters may remove
      // low FBM offers from execution, but they must not erase market awareness.
      targetPrice = fbmMarketAnchorPrice;
      targetSource = `Lowest FBM ($${fbmMarketAnchorPrice.toFixed(2)}) [anchor:lowest_fbm — FBM seller competes with FBM first]`;
      guardsApplied.push('fbm_compete_lowest_fbm');
      if (hasLowerFbmCompetitor) guardsApplied.push('fbm_lower_competitor_blocks_raise');
      console.log(`[FBM Target] Anchoring to lowest FBM $${fbmMarketAnchorPrice.toFixed(2)} (current=$${currentPrice?.toFixed(2) ?? 'null'}, rawExternalFbm=${rawLowestExternalFbmPrice ?? 'null'}, inferred=${inferredFbmFromOverall ?? 'null'}, profile=${currentFbmProfile})`);
      if (lowestSellerMode) {
        anchorDiagnostics.selected_anchor = 'lowest_fbm';
        anchorDiagnostics.override_reason = 'lowest_seller_mode_forced_lowest_fbm';
        if (!guardsApplied.includes('lowest_seller_mode_disable_raise')) guardsApplied.push('lowest_seller_mode_disable_raise');
        guardsApplied.push('effective_fbm_competition_mode=lowest_seller');
      }
    } else if (bbIsFbm && buyboxPrice && buyboxPrice > 0 && bbIsReliable && !isAggressiveFbm) {
      // Non-aggressive FBM→FBM: anchor to FBM Buy Box (the real market)
      targetPrice = buyboxPrice;
      targetSource = `FBM\u2192FBM: Buy Box anchor ($${buyboxPrice.toFixed(2)}) [${bbSource}]`;
      console.log(`[FBM Target] FBM\u2192FBM non-aggressive: anchoring to FBM BB $${buyboxPrice.toFixed(2)} (profile=${currentFbmProfile})`);
      guardsApplied.push('fbm_fbm_bb_anchor');
    } else if (isAggressiveFbm && lowestEligibleValid) {
      // Aggressive/Liquidation FBM→FBM: chase lowest eligible for sales
      targetPrice = lowestEligibleValid;
      targetSource = `FBM\u2192FBM aggressive: lowest eligible ($${lowestEligibleValid.toFixed(2)})`;
      console.log(`[FBM Target] FBM\u2192FBM aggressive: chasing lowest eligible $${lowestEligibleValid.toFixed(2)} (profile=${currentFbmProfile})`);
    } else if (buyboxPrice && buyboxPrice > 0) {
      targetPrice = buyboxPrice;
      targetSource = `FBM mode: Buy Box fallback ($${buyboxPrice.toFixed(2)})`;
    } else if (lowestEligibleValid) {
      targetPrice = lowestEligibleValid;
      targetSource = `FBM mode: lowest eligible fallback ($${lowestEligibleValid.toFixed(2)})`;
    }
  } else {
    // FBA mode: anchor selection depends on context.targetAnchor setting
    const buyboxWinnerInSet = eligibleOffers.find(o => o.is_buybox_winner);
    const bbWinnerIsFbm = buyboxSellerType === 'FBM';
    const anchor = context.targetAnchor || 'smart';
    const explicitFbmModeFbmAnchor = userWantsAllSellers && explicitFbmAnchorPrice && explicitFbmAnchorPrice > 0
      ? explicitFbmAnchorPrice
      : null;
    
    // CRITICAL: When user chose "FBA Only" (competeWithFbm=false), ignore FBM Buy Box entirely.
    const shouldIgnoreFbmBb = bbWinnerIsFbm && !competeWithFbm;
    
    // Helper: get lowest FBA from eligible offers
    const fbaEligible = eligibleOffers.filter(o => o.is_fba);
    const lowestEligibleFba = fbaEligible.length > 0 ? Math.min(...fbaEligible.map(o => o.total_price || o.price || Infinity)) : null;
    const lowestEligibleAll = eligibleOffers.length > 0 ? Math.min(...eligibleOffers.map(o => o.total_price || o.price || Infinity)) : null;

    // === ANCHOR DIAGNOSTICS — track for every eval ===
    anchorDiagnostics.raw_lowest_fba = lowestFbaPrice ?? null;
    anchorDiagnostics.filtered_lowest_fba = (lowestEligibleFba && lowestEligibleFba < Infinity) ? lowestEligibleFba : null;
    anchorDiagnostics.selected_anchor = anchor;

    if (explicitFbmModeFbmAnchor) {
      targetPrice = explicitFbmModeFbmAnchor;
      targetSource = `Lowest FBM ($${explicitFbmModeFbmAnchor.toFixed(2)}) [FBM mode=${fbmCompetitionMode} — user chose to compete with FBM sellers]`;
      guardsApplied.push('fbm_mode_explicit_anchor');
      if (clusterInfo.lowestIsOutlier && clusterInfo.clusterAnchorPrice && !guardsApplied.includes('cluster_override_skipped_user_fbm_mode')) {
        guardsApplied.push('cluster_override_skipped_user_fbm_mode');
      }
      console.log(`[FBA Target] Explicit FBM competition mode=${fbmCompetitionMode} → anchoring to FBM $${explicitFbmModeFbmAnchor.toFixed(2)} instead of FBA ladder`);
    } else if (shouldIgnoreFbmBb) {
      // FBM owns BB but user chose FBA-only competition — use lowest FBA price regardless of anchor
      if (lowestFbaPrice && lowestFbaPrice > 0) {
        targetPrice = lowestFbaPrice;
        targetSource = `Lowest FBA ($${lowestFbaPrice.toFixed(2)}) [FBM BB $${buyboxPrice?.toFixed(2)} ignored — FBA-only mode]`;
        console.log(`[FBA Target] FBM owns BB at $${buyboxPrice?.toFixed(2)}, competeWithFbm=false → FBA anchor: $${lowestFbaPrice.toFixed(2)}`);
      } else if (currentPrice) {
        console.log(`[FBA Target] FBM owns BB at $${buyboxPrice?.toFixed(2)}, no FBA competitors — holding price`);
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: currentPrice,
          reason: `FBM owns Buy Box ($${buyboxPrice?.toFixed(2)}) — FBA-only mode, no FBA competitors to anchor, holding price`,
          guardsApplied: ['fbm_bb_no_fba_anchor'],
          intelligenceFactors: intelligence,
          anchorDiagnostics,
        };
      }
    } else if (bbUntrusted) {
      // BB is untrusted (suspicious drop) — force Lowest FBA anchor
      if (lowestEligibleFba && lowestEligibleFba < Infinity) {
        targetPrice = lowestEligibleFba;
        targetSource = `Lowest FBA ($${lowestEligibleFba.toFixed(2)}) [bb_untrusted — BB $${buyboxPrice?.toFixed(2)} skipped, source: ${bbSource}]`;
        console.log(`[BB Untrusted] Using Lowest FBA $${lowestEligibleFba.toFixed(2)} instead of untrusted BB $${buyboxPrice?.toFixed(2)}`);
      } else if (lowestFbaPrice && lowestFbaPrice > 0) {
        targetPrice = lowestFbaPrice;
        targetSource = `Lowest FBA snapshot ($${lowestFbaPrice.toFixed(2)}) [bb_untrusted — BB skipped]`;
      } else {
        // No FBA data at all — shouldn't reach here due to guard above, but safety
        console.log(`[BB Untrusted] No FBA anchor available — holding price`);
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: currentPrice,
          reason: `BB untrusted and no FBA fallback — holding price`,
          guardsApplied: ['bb_untrusted_no_fba'],
          intelligenceFactors: intelligence,
          anchorDiagnostics,
        };
      }
    } else {
      // Apply target_anchor selection
      switch (anchor) {
        case 'buybox':
          if (buyboxPrice && (buyboxWinnerInSet || bbIsReliable)) {
            targetPrice = buyboxPrice;
            const fbmTag = bbWinnerIsFbm ? ' (FBM — competing per Both mode)' : '';
            targetSource = `Buy Box ($${buyboxPrice.toFixed(2)}) [${bbSource}]${fbmTag} [anchor:buybox]`;
          }
          break;

        case 'lowest_fba':
          if (lowestEligibleFba && lowestEligibleFba < Infinity) {
            targetPrice = lowestEligibleFba;
            targetSource = `Lowest FBA ($${lowestEligibleFba.toFixed(2)}) [anchor:lowest_fba]`;
          } else if (lowestFbaPrice && lowestFbaPrice > 0) {
            targetPrice = lowestFbaPrice;
            targetSource = `Lowest FBA snapshot ($${lowestFbaPrice.toFixed(2)}) [anchor:lowest_fba]`;
          }
          break;

        case 'lowest_offer':
          if (lowestEligibleAll && lowestEligibleAll < Infinity) {
            targetPrice = lowestEligibleAll;
            targetSource = `Lowest offer ($${lowestEligibleAll.toFixed(2)}) [anchor:lowest_offer]`;
          }
          break;

        case 'smart_recapture': {
          // Smart when already lowest; switch to lowest FBA when not
          const myPriceForCheck = currentPrice;
          const bestFba = lowestEligibleFba && lowestEligibleFba < Infinity ? lowestEligibleFba : (lowestFbaPrice && lowestFbaPrice > 0 ? lowestFbaPrice : null);
          
          if (bestFba && myPriceForCheck && bestFba < myPriceForCheck) {
            // NOT lowest — recapture by anchoring to lowest FBA
            targetPrice = bestFba;
            targetSource = `Lowest FBA ($${bestFba.toFixed(2)}) [anchor:smart_recapture — not lowest]`;
            console.log(`[smart_recapture] NOT lowest ($${myPriceForCheck.toFixed(2)} > $${bestFba.toFixed(2)}) → anchoring to Lowest FBA`);
          } else if (buyboxPrice && (buyboxWinnerInSet || bbIsReliable)) {
            // Already lowest — use normal Smart BB logic
            targetPrice = buyboxPrice;
            const fbmTag = bbWinnerIsFbm ? ' (FBM — competing per Both mode)' : '';
            targetSource = `Buy Box ($${buyboxPrice.toFixed(2)}) [${bbSource}]${fbmTag} [anchor:smart_recapture — already lowest]`;
            console.log(`[smart_recapture] Already lowest → anchoring to BB $${buyboxPrice.toFixed(2)}`);
          }
          break;
        }

        case 'smart':
        default:
          // Smart: Buy Box first, then lowest FBA, then lowest eligible
          if (buyboxPrice && (buyboxWinnerInSet || bbIsReliable)) {
            targetPrice = buyboxPrice;
            const fbmTag = bbWinnerIsFbm ? ' (FBM — competing per Both mode)' : '';
            targetSource = `Buy Box ($${buyboxPrice.toFixed(2)}) [${bbSource}]${fbmTag}`;
          }
          break;
      }
    }
    
    // Fallback: lowest eligible offer (for all anchor modes if no target found yet)
    if (!targetPrice) {
      const lowestEligible = Math.min(...eligibleOffers.map(o => o.total_price || o.price || Infinity));
      if (lowestEligible && lowestEligible < Infinity) {
        targetPrice = lowestEligible;
        targetSource = `Lowest eligible ($${lowestEligible.toFixed(2)}) [fallback]`;
      }
    }

    // =======================================================================
    // ANCHOR ENFORCEMENT: smart_recapture hard override when losing Buy Box
    // If the user selected smart_recapture AND is losing the BB, the final
    // target MUST NOT stay anchored to Buy Box when a valid raw lowest FBA
    // exists below current price and above min floor.
    // This prevents quality filters or AI layers from silently overriding
    // the user's chosen recapture strategy.
    // =======================================================================
    if (anchor === 'smart_recapture' && currentPrice && !smartRaise.isBuyboxOwner) {
      const rawFba = lowestFbaPrice;
      const effectiveMin = minPrice || 0;
      
      if (rawFba && rawFba > 0 && rawFba < currentPrice - 0.004) {
        // Raw lowest FBA is cheaper than us — enforce recapture anchor
        if (targetPrice && targetPrice >= currentPrice) {
          // Target ended up at or above current (e.g. anchored to BB) — override
          const prevTarget = targetPrice;
          const prevSource = targetSource;
          targetPrice = rawFba;
          targetSource = `Lowest FBA ($${rawFba.toFixed(2)}) [anchor:smart_recapture — ENFORCED: raw FBA below current, was anchored to ${prevSource}]`;
          anchorDiagnostics.override_reason = `smart_recapture_enforced: target was $${prevTarget.toFixed(2)} (${prevSource}) but raw lowest FBA $${rawFba.toFixed(2)} is below current $${currentPrice.toFixed(2)} — overriding to recapture`;
          guardsApplied.push('smart_recapture_enforced');
          console.log(`[ANCHOR ENFORCEMENT] smart_recapture: target was $${prevTarget.toFixed(2)} (${prevSource}), but raw lowest FBA $${rawFba.toFixed(2)} < current $${currentPrice.toFixed(2)} — FORCING recapture anchor`);
        } else if (!targetPrice) {
          // No target found at all — use raw FBA
          targetPrice = rawFba;
          targetSource = `Lowest FBA ($${rawFba.toFixed(2)}) [anchor:smart_recapture — ENFORCED: no target found]`;
          anchorDiagnostics.override_reason = `smart_recapture_enforced: no target found, using raw lowest FBA $${rawFba.toFixed(2)}`;
          guardsApplied.push('smart_recapture_enforced');
          console.log(`[ANCHOR ENFORCEMENT] smart_recapture: no target found, raw lowest FBA $${rawFba.toFixed(2)} available — FORCING recapture anchor`);
        }
      }
    }

    // === CLUSTER-BASED ANCHOR OVERRIDE ===
    // If the lowest offer is an outlier and cluster analysis found a real market band,
    // use the cluster anchor instead of chasing the outlier — unless we're losing BB badly
    if (targetPrice && currentPrice && clusterInfo.lowestIsOutlier && clusterInfo.clusterAnchorPrice) {
      const clusterAnchor = clusterInfo.clusterAnchorPrice;
      const targetIsOutlierLevel = Math.abs(targetPrice - (clusterInfo.clusters[0]?.range[0] ?? 0)) < 0.02;
      const isLosingBbBadly = !smartRaise.isBuyboxOwner && intelligence.buyboxLossStreak >= 5;

      // USER-INTENT GATE: if the user explicitly opted into all/lowest seller competition
      // AND the outlier is an FBM offer, respect the user's choice and do NOT silently
      // override their FBM competition setting. We match the outlier to FBM via THREE
      // independent signals (any one is sufficient) so a missing lowestFbmPrice in the
      // snapshot can't silently re-enable the override:
      //   1. outlierPrice ≈ lowestFbmPrice
      //   2. BuyBox is FBM AND outlierPrice ≈ buyboxPrice
      //   3. No FBA offer at or below outlierPrice (so the outlier can't be FBA)
      const outlierPrice = clusterInfo.clusters[0]?.range[0] ?? null;
      const matchByFbm = !!(outlierPrice && lowestFbmPrice && Math.abs(outlierPrice - lowestFbmPrice) < 0.02);
      const matchByBb = !!(outlierPrice && buyboxPrice && buyboxSellerType === 'FBM' && Math.abs(outlierPrice - buyboxPrice) < 0.02);
      const matchByFbaFloor = !!(outlierPrice && lowestFbaPrice && lowestFbaPrice > outlierPrice + 0.02);
      const outlierIsFbm = matchByFbm || matchByBb || matchByFbaFloor;
      const userOverridesOutlier = userWantsAllSellers && outlierIsFbm;

      console.log(`[CLUSTER_PRICING] gate check: mode=${fbmCompetitionMode} outlier=$${outlierPrice?.toFixed(2) ?? 'null'} lowestFbm=$${lowestFbmPrice?.toFixed(2) ?? 'null'} bb=$${buyboxPrice?.toFixed(2) ?? 'null'}/${buyboxSellerType ?? 'null'} lowestFba=$${lowestFbaPrice?.toFixed(2) ?? 'null'} matchByFbm=${matchByFbm} matchByBb=${matchByBb} matchByFbaFloor=${matchByFbaFloor} → skip=${userOverridesOutlier}`);

      if (userOverridesOutlier) {
        guardsApplied.push('cluster_override_skipped_user_fbm_mode');
        console.log(`[CLUSTER_PRICING] SKIPPED override: user mode=${fbmCompetitionMode}, outlier $${outlierPrice?.toFixed(2)} is FBM — respecting user choice to compete with FBM`);
      } else if (targetIsOutlierLevel && !isLosingBbBadly) {
        const prevTarget = targetPrice;
        targetPrice = clusterAnchor;
        targetSource = `Cluster anchor ($${clusterAnchor.toFixed(2)}) [outlier $${prevTarget.toFixed(2)} ignored — ${clusterInfo.clusters.length} clusters, dominant ${clusterInfo.clusters.reduce((a: any, b: any) => b.count > a.count ? b : a).count} sellers at $${clusterInfo.dominantClusterMedian?.toFixed(2)}]`;
        anchorDiagnostics.override_reason = `cluster_override: outlier $${prevTarget.toFixed(2)} → cluster $${clusterAnchor.toFixed(2)} (gap ${clusterInfo.outlierGapPct.toFixed(1)}%)`;
        guardsApplied.push('cluster_anchor_override');
        console.log(`[CLUSTER_PRICING] ANCHOR OVERRIDE: target was outlier $${prevTarget.toFixed(2)}, using cluster anchor $${clusterAnchor.toFixed(2)} (gap $${clusterInfo.outlierGap.toFixed(2)}, ${clusterInfo.outlierGapPct.toFixed(1)}%)`);
      }

    }

    // ═══════════════════════════════════════════════════════════════════
    // FBM COHORT ANCHOR OVERRIDE — when seller is FBM and an FBM cohort
    // exists, the anchor MUST be the FBM ladder, not the FBA Buy Box.
    // Without this, "smart" / fallback selection lands on the FBA BB and
    // the engine prices against the wrong cohort even though the FBA hold
    // math is bypassed downstream.
    // ═══════════════════════════════════════════════════════════════════
    {
      const myFulfillment = context.yourFulfillmentType;
      const bbIsFba = buyboxSellerType === 'FBA' || buyboxSellerType === 'Amazon';
      if (myFulfillment === 'FBM' && bbIsFba) {
        // Find lowest FBM (non-self) offer in eligible set
        const fbmOffersInSet = eligibleOffers.filter((o: any) => o.is_fba === false && !o.is_self);
        const lowestFbmInSet = fbmOffersInSet.length > 0
          ? Math.min(...fbmOffersInSet.map((o: any) => Number(o.total_price ?? o.price) || Infinity))
          : Infinity;
        // Inferred FBM price from snapshot: when lowest_overall is strictly below
        // lowest_fba, the lowest_overall offer must be FBM. This rescues cases
        // where snapshot.lowest_fbm_price is null but FBM is clearly the cohort
        // floor (and where quality_filter stripped the real FBM offer from the
        // eligible set, replacing it with a synthetic FBA Buy Box fallback).
        const inferredFbmFromOverall = (
          lowestOverallPrice && lowestOverallPrice > 0 &&
          lowestFbaPrice && lowestFbaPrice > 0 &&
          lowestOverallPrice < lowestFbaPrice - 0.005
        ) ? lowestOverallPrice : null;
        const fbmAnchorCandidate = fbmMarketAnchorPrice
          ?? ((lowestFbmInSet > 0 && lowestFbmInSet < Infinity)
            ? lowestFbmInSet
            : (lowestFbmPrice && lowestFbmPrice > 0 ? lowestFbmPrice
              : (inferredFbmFromOverall ?? null)));
        const fbmCohortPresent = respectFbmCohort && (fbmAnchorCandidate != null || (context.fbmOfferCount ?? 0) > 0);
        if (fbmCohortPresent && fbmAnchorCandidate != null && targetPrice && Math.abs(targetPrice - fbmAnchorCandidate) > 0.005) {
          const prevTarget = targetPrice;
          const prevSource = targetSource;
          targetPrice = fbmAnchorCandidate;
          targetSource = `Lowest FBM ($${fbmAnchorCandidate.toFixed(2)}) [anchor:fbm_cohort — FBM seller, FBM peers present, was ${prevSource}]`;
          anchorDiagnostics.override_reason = `fbm_cohort_anchor: was $${prevTarget.toFixed(2)} (${prevSource}) → FBM ladder $${fbmAnchorCandidate.toFixed(2)}`;
          guardsApplied.push('fbm_cohort_anchor_override');
          console.log(`[FBM_COHORT_ANCHOR] OVERRIDE: was $${prevTarget.toFixed(2)} (${prevSource}) → FBM ladder $${fbmAnchorCandidate.toFixed(2)} (fbmOffersInSet=${fbmOffersInSet.length}, lowestFbmPrice=${lowestFbmPrice ?? 'null'}, fbmOfferCount=${context.fbmOfferCount ?? 'null'})`);
        } else if (fbmCohortPresent && fbmAnchorCandidate == null) {
          console.log(`[FBM_COHORT_ANCHOR] cohort signaled by count but no priced FBM offer found in eligible set — keeping ${targetSource}`);
        }
      }
    }

    // Log anchor diagnostics for every eval
    console.log(`[ANCHOR DIAGNOSTICS] anchor=${anchor}, raw_lowest_fba=$${lowestFbaPrice?.toFixed(2) ?? 'null'}, filtered_lowest_fba=$${(lowestEligibleFba && lowestEligibleFba < Infinity) ? lowestEligibleFba.toFixed(2) : 'null'}, selected_target=$${targetPrice?.toFixed(2) ?? 'null'}, source=${targetSource}, override=${anchorDiagnostics.override_reason || 'none'}, cluster_outlier=${clusterInfo.lowestIsOutlier}`);
  }

  if (!targetPrice) {
    return {
      mode: 'DO_NOT_REPRICE',
      newPrice: null,
      rawTargetPrice: null,
      reason: 'No valid target price found',
      guardsApplied: [],
      intelligenceFactors: intelligence,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // FBM COMPETITIVE THRESHOLD — FBM cannot win BB from FBA with tiny
  // undercuts. Require a meaningful price gap before chasing.
  // Conservative rules: hold for profit when gap is insufficient.
  // Aggressive rules: allow controlled descent with larger steps.
  // ═══════════════════════════════════════════════════════════════════
  const isFbmVsFba = context.yourFulfillmentType === 'FBM' && 
    (buyboxSellerType === 'FBA' || buyboxSellerType === 'Amazon');

  // COHORT-AWARE BYPASS: if an FBM cohort exists in any form, the FBM seller
  // competes within the FBM ladder — do NOT evaluate hold/discount math against
  // the FBA Buy Box. We accept multiple signals because lowest_fbm_price can be
  // null even when FBM offers are present (e.g. when lowest FBM ties lowest FBA,
  // or when qualifying-filter strips the lowest FBM out).
  const fbmCohortByPrice = lowestFbmPrice != null && lowestFbmPrice > 0;
  const fbmCohortByCount = (context.fbmOfferCount ?? 0) > 0;
  const fbmCohortExists = (fbmCohortByPrice || fbmCohortByCount) && respectFbmCohort;
  if (isFbmVsFba && fbmCohortExists) {
    console.log(`[FBM_COMPETITIVE_THRESHOLD] BYPASS: FBM cohort exists (lowestFbm=${lowestFbmPrice ?? 'null'}, fbmOfferCount=${context.fbmOfferCount ?? 'null'}, respectFbmCohort=${respectFbmCohort}) — ignoring FBA BB hold math, trusting FBM cohort target`);
    guardsApplied.push('fbm_cohort_bypass_fba_bb');
  }

  if (isFbmVsFba && !fbmCohortExists && currentPrice && targetPrice && buyboxPrice && buyboxPrice > 0) {
    const currentSmartProfile = rule.smart_profile || 'CUSTOM';
    const fbmGapFixed = 0.75; // minimum $0.75 gap required
    const fbmGapPercent = 0.04; // minimum 4% gap required
    const fbmCompetitiveGap = Math.max(fbmGapFixed, buyboxPrice * fbmGapPercent);
    const actualGap = currentPrice - buyboxPrice; // positive = we are above BB
    const gapSufficient = actualGap >= fbmCompetitiveGap || currentPrice <= buyboxPrice;
    
    const conservativeProfiles = ['PROFIT_EXTRACTOR', 'MOMENTUM_BUILDER', 'MATCH_BUYBOX', 'MATCH_LOWEST', 'SMART_MATCH', 'MOMENTUM_SMART'];
    const aggressiveProfilesFbm = ['VELOCITY_DOMINATOR'];
    const isConservative = conservativeProfiles.includes(currentSmartProfile);
    const isAggressive = aggressiveProfilesFbm.includes(currentSmartProfile);
    
    if (!gapSufficient && currentPrice > buyboxPrice) {
      if (isConservative) {
        // Conservative FBM: hold for profit — chasing FBA BB with small gap is wasteful
        console.log(`[FBM_COMPETITIVE_THRESHOLD] HOLD: asin=${context.asin} profile=${currentSmartProfile} gap=$${actualGap.toFixed(2)} < required=$${fbmCompetitiveGap.toFixed(2)} — holding for profit (FBM cannot win FBA BB with small discount)`);
        guardsApplied.push('fbm_competitive_hold');
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: targetPrice,
          reason: (() => {
            const inCluster = !!(smartRaise as any)?.isInPriceCluster;
            const clusterCount = (smartRaise as any)?.clusterSellerCount ?? 0;
            const clusterNote = inCluster
              ? ` Buy Box price has a cluster of ${clusterCount} sellers — matching it likely won't win the BB as FBM.`
              : '';
            return `FBM cannot reliably win FBA Buy Box with a small discount. Current gap is $${actualGap.toFixed(2)}; required at least $${fbmCompetitiveGap.toFixed(2)} below BB ($${buyboxPrice.toFixed(2)}) to justify the move — holding for profit.${clusterNote}`;
          })(),
          guardsApplied,
          intelligenceFactors: intelligence,
          anchorDiagnostics,
        };
      } else if (isAggressive) {
        // Aggressive FBM: use larger descent steps instead of micro-undercuts
        const fbmAggressiveStep = Math.max(0.25, buyboxPrice * 0.02); // min $0.25 or 2%
        console.log(`[FBM_COMPETITIVE_THRESHOLD] AGGRESSIVE_DESCENT: asin=${context.asin} step=$${fbmAggressiveStep.toFixed(2)} (gap $${actualGap.toFixed(2)} < required $${fbmCompetitiveGap.toFixed(2)})`);
        guardsApplied.push('fbm_aggressive_descent');
        // Override target to use larger meaningful steps
        targetPrice = currentPrice - fbmAggressiveStep;
        targetSource = `FBM aggressive descent: -$${fbmAggressiveStep.toFixed(2)} from $${currentPrice.toFixed(2)} (chasing FBA BB $${buyboxPrice.toFixed(2)})`;
      }
    } else if (gapSufficient) {
      console.log(`[FBM_COMPETITIVE_THRESHOLD] PASS: asin=${context.asin} gap=$${actualGap.toFixed(2)} >= required=$${fbmCompetitiveGap.toFixed(2)} — FBM can meaningfully compete`);
      guardsApplied.push('fbm_competitive_pass');
    }
  }

  // === APPLY INTELLIGENCE MULTIPLIER ===
  // FBM mode uses FBM-specific undercut amount from rule settings
  // FBM listings use a dedicated `fbm_undercut_amount` rule field. When unset (null),
  // fall back to legacy `undercut_amount_fbm` and finally to the FBA undercut.
  const fbmUndercutOverride = (rule as any).fbm_undercut_amount ?? (rule as any).undercut_amount_fbm ?? null;
  const effectiveUndercut = context.matchExactly && !lowestSellerMode
    ? 0  // MATCH EXACTLY: match means match, except Lowest Seller mode explicitly chases FBM using FBM Undercut
    : (context.yourFulfillmentType === 'FBM'
      ? (fbmUndercutOverride != null ? Number(fbmUndercutOverride) : undercutAmount)
      : undercutAmount);
  if (context.yourFulfillmentType === 'FBM' && fbmUndercutOverride != null) {
    console.log(`[FBM_UNDERCUT] Using FBM-specific undercut $${Number(fbmUndercutOverride).toFixed(4)} (FBA undercut would have been $${Number(undercutAmount).toFixed(4)})`);
  }
  const { multiplier: intelMultiplier, factors: intelFactors } = calculateIntelligenceMultiplier(intelligence, rule);
  const visibleIntelMultiplier = context.matchExactly ? 1.0 : intelMultiplier;
  // MATCH EXACTLY: neutralize the multiplier on undercut. (intelMultiplier still
  // logged for transparency, but it cannot turn 0 into $0.01 anymore.)
  let adjustedUndercut = context.matchExactly && !lowestSellerMode ? 0 : (effectiveUndercut * visibleIntelMultiplier);

  // ═══════════════════════════════════════════════════════════════════
  // CLUSTER MATCH OVERRIDE — In a tight rotating cluster, match instead of undercut.
  // This prevents unnecessary profit erosion when Amazon is already rotating
  // the Buy Box among sellers at near-identical prices.
  // Only applies when NOT in active BB recapture / recovery mode.
  // ═══════════════════════════════════════════════════════════════════
  const isAggressiveProfile = (rule.smart_profile || '') === 'VELOCITY_DOMINATOR';
  const bbLossDurationMin = (intelligence as any).bbLossDurationMinutes ?? 0;
  const bbRecoveryEscalation = (intelligence as any).bbRecoveryEscalation ?? 0;
  const isActiveRecapture = bbLossDurationMin > 30 && bbRecoveryEscalation > 0;

  // FBM-aware cluster matching: FBM sellers should NOT be forced to match FBA clusters
  // because matching an FBA cluster price doesn't give FBM the same BB rotation benefit
  const isFbmSeller = context.yourFulfillmentType === 'FBM';
  const fbmClusterBypass = isFbmSeller && smartRaise.isInPriceCluster && !isActiveRecapture;

  if (smartRaise.isInPriceCluster && !isActiveRecapture && !isAggressiveProfile && !fbmClusterBypass) {
    console.log(`[CLUSTER_MATCH_OVERRIDE] asin=${context.asin} cluster detected (${smartRaise.clusterSellerCount} sellers) — forcing match offset $0.00 (was $${adjustedUndercut.toFixed(4)})`);
    adjustedUndercut = 0;
    guardsApplied.push('cluster_match_override');
  } else if (fbmClusterBypass) {
    console.log(`[CLUSTER_MATCH_OVERRIDE] BYPASSED for FBM seller: cluster matching weakened — FBM does not get same BB rotation benefit from matching FBA cluster`);
    guardsApplied.push('fbm_cluster_bypass');
    // Keep the original adjustedUndercut — FBM keeps its undercut against the cluster
  }

  const smartRecaptureFinalGuardActive = Boolean(
    anchorDiagnostics.selected_anchor === 'smart_recapture' &&
    currentPrice &&
    !smartRaise.isBuyboxOwner &&
    anchorDiagnostics.raw_lowest_fba &&
    anchorDiagnostics.raw_lowest_fba > 0 &&
    anchorDiagnostics.raw_lowest_fba < currentPrice - 0.004
  );

  if (smartRecaptureFinalGuardActive && anchorDiagnostics.raw_lowest_fba) {
    anchorDiagnostics.enforced_target = Math.round(
      Math.max(0.01, anchorDiagnostics.raw_lowest_fba - adjustedUndercut) * 100
    ) / 100;
  }
  
  if (intelMultiplier !== 1.0) {
    guardsApplied.push(`intel_${intelMultiplier.toFixed(2)}x`);
  }

  // === SELF-UNDERCUT GUARD ===
  // If we're already at or below the target (after undercut), hold price — don't erode further
  // This uses the FILTERED competitor set (same filters applied to eligibleOffers above)
  // SAFETY OVERRIDE: If raw lowest FBA is cheaper than us, we are NOT actually lowest in the market
  if (currentPrice && currentPrice > 0 && currentPrice <= targetPrice) {
    // Check raw lowest FBA (unfiltered) — if someone cheaper exists in reality, don't hold
    const rawLowestFba = lowestFbaPrice;
    const filteredRaiseAnchor = smartRaise.lowestEligibleCompetitorPrice
      ?? anchorDiagnostics.filtered_lowest_fba
      ?? null;
    const filteredRaiseGap = filteredRaiseAnchor && filteredRaiseAnchor > currentPrice
      ? filteredRaiseAnchor - currentPrice
      : 0;
    const rawLowerFbaGap = rawLowestFba && rawLowestFba > 0 && rawLowestFba < currentPrice - 0.004
      ? currentPrice - rawLowestFba
      : 0;
    const allowFilteredRecoveryRaise = Boolean(
      !smartRaise.isBuyboxOwner &&
      smartRaise.enabled &&
      !hasLowerFbmCompetitor &&
      !smartRaise.isInPriceCluster &&
      filteredRaiseAnchor &&
      filteredRaiseGap >= 0.03 &&
      (rawLowerFbaGap === 0 || rawLowerFbaGap <= 0.02)
    );

    if (allowFilteredRecoveryRaise) {
      const filteredRecoveryStep = Math.min(
        Math.max(0.05, currentPrice * 0.005),
        Math.max(filteredRaiseGap - _raiseOffset.offset, 0.01),
        0.20,
      );
      let filteredRecoveryPrice = Math.round((currentPrice + filteredRecoveryStep) * 100) / 100;

      if (maxPrice && filteredRecoveryPrice > maxPrice) {
        filteredRecoveryPrice = maxPrice;
      }

      // Floor is a lower bound only — it must never block an upward recovery raise.
      filteredRecoveryPrice = Math.round(filteredRecoveryPrice * 100) / 100;

      if (filteredRaiseAnchor != null && filteredRecoveryPrice > currentPrice) {
        console.log(`[Eligible Gap Recovery] RAISING: $${currentPrice.toFixed(2)} → $${filteredRecoveryPrice.toFixed(2)} (filtered next eligible $${filteredRaiseAnchor.toFixed(2)}, raw lower gap $${rawLowerFbaGap.toFixed(2)})`);
        guardsApplied.push('eligible_gap_recovery_raise');
        if (rawLowerFbaGap > 0) {
          guardsApplied.push('raw_lower_gap_ignored_trivial');
        }
        return {
          mode: 'SMART_RAISE',
          newPrice: filteredRecoveryPrice,
          rawTargetPrice: applyRaiseOffset(filteredRaiseAnchor as number, _raiseOffset),
          reason: `Eligible-gap recovery: filtered next eligible $${(filteredRaiseAnchor as number).toFixed(2)}${rawLowerFbaGap > 0 ? `, raw lower gap only $${rawLowerFbaGap.toFixed(2)}` : ''} — raising to $${filteredRecoveryPrice.toFixed(2)}`,
          guardsApplied,
          intelligenceFactors: intelligence,
          isRaise: true,
          anchorDiagnostics,
        };
      }
    }

    if (rawLowestFba && rawLowestFba > 0 && rawLowestFba < currentPrice - 0.004) {
      // A real FBA competitor is cheaper than us but was filtered out — override hold
      console.log(`[Self-Undercut Guard] OVERRIDE: filtered says hold ($${currentPrice.toFixed(2)} ≤ $${targetPrice.toFixed(2)}), but raw lowest FBA $${rawLowestFba.toFixed(2)} is cheaper — lowering to compete`);
      guardsApplied.push('raw_lowest_override');
      // Use rawLowestFba as the new target
      targetPrice = rawLowestFba;
      targetSource = `Raw lowest FBA ($${rawLowestFba.toFixed(2)}) [filter-override — competitor exists below filtered set]`;
      // Fall through to normal pricing logic below
    } else if (!smartRaise.isBuyboxOwner && currentPrice && currentPrice > 0) {
      // We're lowest among eligible competitors BUT not winning the Buy Box

      // =====================================================================
      // BELOW-MARKET RECOVERY RAISE
      // When we are significantly below the lowest FBA competitor AND the
      // Buy Box, lowering further is irrational — we should RAISE toward
      // the market instead. This prevents margin erosion when the seller
      // is already the cheapest FBA but the engine keeps micro-stepping down.
      //
      // Conditions:
      //  1. Lowest FBA (raw) exists and is ABOVE our current price
      //  2. Buy Box is above our current price
      //  3. Gap between current and lowest FBA is meaningful (> 2%)
      //  4. No raw FBA competitor is cheaper than us
      // =====================================================================
      // Use ONLY competitor-safe anchors for stock-gated recovery.
      // Never fall back to raw lowestFbaPrice here because it may be our own offer.
      // NOTE: do not touch positionProof here — it is built later in the function.
      const recoveryAnchor = (() => {
        const candidates = [
          smartRaise.lowestEligibleCompetitorPrice,
          anchorDiagnostics.filtered_lowest_fba,
        ].filter((p): p is number => p != null && p > currentPrice + 0.02);
        return candidates.length > 0 ? Math.min(...candidates) : null;
      })();
      const recoveryForced = Boolean(
        stockGatedMaximize
        && recoveryAnchor
        && recoveryAnchor > currentPrice + 0.02
        && (smartRaise.isBuyboxOwner || (buyboxPrice && buyboxPrice > currentPrice))
      );
      const hasFbaAbove = recoveryAnchor && recoveryAnchor > 0 && recoveryAnchor > currentPrice + 0.02;
      const hasBbAbove = buyboxPrice && buyboxPrice > currentPrice;
      const gapToFbaPct = hasFbaAbove ? ((recoveryAnchor - currentPrice) / currentPrice) * 100 : 0;
      // noFbaCheaper: ensure no raw FBA competitor is cheaper than us
      const noFbaCheaper = !(lowestFbaPrice && lowestFbaPrice > 0 && lowestFbaPrice < currentPrice - 0.004);

      if (hasFbaAbove && hasBbAbove && gapToFbaPct > 2 && noFbaCheaper && (smartRaise.enabled || stockGatedMaximize)) {
        // Recovery raise: close the gap toward the lowest FBA competitor
        const recoveryTarget = recoveryAnchor - (undercutAmount || 0);
        const recoveryGap = recoveryTarget - currentPrice;
        const gapCloseRatio = smartRaise.gapCloseRatio || 0.15;

        let recoveryPrice: number;
        if (recoveryGap <= 0.10 && recoveryGap > 0) {
          recoveryPrice = recoveryTarget;
          guardsApplied.push('recovery_snap_to_target');
          console.log(`[Below-Market Recovery] SNAP: gap=$${recoveryGap.toFixed(3)} ≤ $0.10, jumping to $${recoveryTarget.toFixed(2)}`);
        } else if (recoveryGap > 0) {
          const step = Math.max(recoveryGap * gapCloseRatio, 0.02);
          recoveryPrice = currentPrice + Math.min(step, recoveryGap);
          console.log(`[Below-Market Recovery] STEP: gap=$${recoveryGap.toFixed(2)}, gapClose=${gapCloseRatio}, step=$${Math.min(step, recoveryGap).toFixed(2)}`);
        } else {
          recoveryPrice = currentPrice;
        }

        const maxJump = Math.min(2.0, currentPrice * 0.10);
        if (recoveryPrice - currentPrice > maxJump) {
          recoveryPrice = currentPrice + maxJump;
          guardsApplied.push('recovery_jump_limiter');
        }

        if (minPrice && recoveryPrice < minPrice) recoveryPrice = minPrice;
        if (maxPrice && recoveryPrice > maxPrice) recoveryPrice = maxPrice;

        if (buyboxPrice && recoveryPrice > buyboxPrice) {
          // FIX: use ?? so an explicit undercut of 0 (match-exact mode) is respected.
          // Previously `|| 0.01` forced a $0.01 undercut even when the user set 0.
          recoveryPrice = buyboxPrice - (undercutAmount ?? 0.01);
          guardsApplied.push('recovery_bb_ceiling');
        }

        recoveryPrice = Math.round(recoveryPrice * 100) / 100;

        if (recoveryPrice > currentPrice) {
          console.log(`[Below-Market Recovery] ${recoveryForced ? 'FORCED ' : ''}RAISING: $${currentPrice.toFixed(2)} → $${recoveryPrice.toFixed(2)} (next FBA $${recoveryAnchor.toFixed(2)}, BB $${buyboxPrice?.toFixed(2)}, gap ${gapToFbaPct.toFixed(1)}%)`);
          guardsApplied.push(recoveryForced ? 'stock_gated_recovery_forced' : 'below_market_recovery_raise');
          return {
            mode: 'SMART_RAISE',
            newPrice: recoveryPrice,
            rawTargetPrice: recoveryTarget,
            reason: `${recoveryForced ? 'Stock-gated recovery' : 'Below-market recovery'}: current $${currentPrice.toFixed(2)}, next FBA $${recoveryAnchor.toFixed(2)}, BB $${buyboxPrice?.toFixed(2)} — raising to $${recoveryPrice.toFixed(2)}`,
            guardsApplied,
            intelligenceFactors: intelligence,
            isRaise: true,
            anchorDiagnostics,
          };
        }
        console.log(`[Below-Market Recovery] SKIPPED: recovery price $${recoveryPrice.toFixed(2)} not above current $${currentPrice.toFixed(2)} after clamps`);
      }

      // PATIENCE CHECK: If we're within $0.01 of the BB price, Amazon may just need
      // time to rotate the BB to us. Don't erode price further — patience wins here.
      const bbGap = buyboxPrice ? Math.abs(currentPrice - buyboxPrice) : Infinity;
      const isWithinPennyOfBb = buyboxPrice && bbGap <= 0.015;
      
      if (isWithinPennyOfBb) {
        // High urgency items (long time without sale, aging stock) should NOT patience-hold
        // They need to keep pushing to win the BB, not wait for rotation
        const urgency = intelligence?.urgencyScore ?? 0;
        const daysWithoutSale = intelligence?.daysWithoutSale ?? 0;
        const bbLossStreak = intelligence?.buyboxLossStreak ?? 0;
        // PROFIT-MAX OVERRIDE: If the next eligible competitor is significantly above us,
        // patience-holding wastes profit opportunity. We should raise, not wait.
        const nextEligibleForPatience = smartRaise.lowestEligibleCompetitorPrice
          ?? anchorDiagnostics.filtered_lowest_fba
          ?? null;
        // For RAISE decisions, we need the next competitor ABOVE us, not the absolute lowest.
        // If lowestEligibleCompetitorPrice is at or below current price, fall back to
        // filtered_lowest_fba or the next competitor above us from eligible offers.
        const nextAboveForPatience = (() => {
          if (nextEligibleForPatience != null && nextEligibleForPatience > currentPrice + 0.02) {
            return nextEligibleForPatience;
          }
          // Try filtered lowest FBA (excludes outlier low offers)
          const filteredFba = anchorDiagnostics.filtered_lowest_fba ?? null;
          if (filteredFba != null && filteredFba > currentPrice + 0.02) {
            return filteredFba;
          }
          // Try next competitor above us from eligible offers
          const competitorPricesAbove = eligibleOffers
            .map(o => o.total_price || o.price || Infinity)
            .filter(p => p > currentPrice + 0.02 && p < Infinity)
            .sort((a, b) => a - b);
          if (competitorPricesAbove.length > 0) {
            return competitorPricesAbove[0];
          }
          return null;
        })();
        const usedFilteredFallbackForPatience = nextAboveForPatience !== nextEligibleForPatience;
        const patienceFilteredGap = nextAboveForPatience != null
          ? nextAboveForPatience - currentPrice
          : 0;
        const patienceFilteredGapPct = currentPrice > 0
          ? (patienceFilteredGap / currentPrice) * 100
          : 0;
        const hasRaiseOpportunity = nextAboveForPatience != null
          && (patienceFilteredGap >= 0.30 || patienceFilteredGapPct >= 1.5);
        // NOTE: positionProof is built later in the outer handler — derive equivalents from local context here.
        // Semantic parity verified: smartRaise.isInPriceCluster uses same cluster algorithm as positionProof.is_price_cluster
        // (lowest ± $0.01, ≥2 sellers). lowestFbaPrice ?? lowestOverallPrice is safer/aligned with FBA-first anchor convention.
        const localRawLowestPrice = lowestFbaPrice ?? lowestOverallPrice ?? null;
        const localInPriceCluster = Boolean(smartRaise.isInPriceCluster);
        // [PARITY_VERIFY] gated behind REPRICER_DEBUG_PARITY=1 — enable on demand for spot-checks; off by default in prod.
        if (Deno.env.get("REPRICER_DEBUG_PARITY") === "1") {
          console.log(
            `[PARITY_VERIFY] asin=${context.asin} cluster_flag=${localInPriceCluster} raw_lowest_anchor=${localRawLowestPrice != null ? '$' + localRawLowestPrice.toFixed(2) : 'null'} (lowestFba=${lowestFbaPrice != null ? '$' + lowestFbaPrice.toFixed(2) : 'null'}, lowestOverall=${lowestOverallPrice != null ? '$' + lowestOverallPrice.toFixed(2) : 'null'}) bb_owner=${smartRaise.isBuyboxOwner} current=$${currentPrice.toFixed(2)}`
          );
        }
        const patienceRaiseProtection = getProfitRaiseProtection({
          currentPrice,
          isBuyboxOwner: smartRaise.isBuyboxOwner,
          inPriceCluster: localInPriceCluster,
          rawLowestPrice: localRawLowestPrice,
        });
        const canUseRaiseOpportunity = hasRaiseOpportunity && patienceRaiseProtection.isAllowed;
        const shouldOverridePatience = urgency >= 75 || daysWithoutSale >= 14 || bbLossStreak >= 15 || canUseRaiseOpportunity || stockGatedMaximize;

        if (hasRaiseOpportunity && !canUseRaiseOpportunity) {
          console.log(
            `[FINAL_PATIENCE_RAISE] BLOCKED: asin=${context.asin} current_price=$${currentPrice.toFixed(2)} buy_box_price=$${buyboxPrice?.toFixed(2) ?? 'null'} blockers=${patienceRaiseProtection.blockers.join(',')} raw_lowest=$${localRawLowestPrice?.toFixed(2) ?? 'null'}`,
          );
        }
        
        if (!shouldOverridePatience) {
          console.log(`[Self-Undercut Guard] PATIENCE: $${currentPrice.toFixed(2)} is within $0.01 of BB $${buyboxPrice?.toFixed(2)} — waiting for BB rotation instead of lowering`);
          return {
            mode: 'SKIP',
            newPrice: null,
            rawTargetPrice: targetPrice,
            reason: `Within $0.01 of BB ($${buyboxPrice?.toFixed(2)}) — patience hold (BB rotation pending)`,
            guardsApplied: [...guardsApplied, 'bb_rotation_patience'],
            intelligenceFactors: intelligence,
            anchorDiagnostics,
          };
        }

        if (canUseRaiseOpportunity && smartRaise.enabled && !smartRaise.isInPriceCluster) {
          const patienceRaiseAnchor = nextAboveForPatience!;
          // Snap directly to competitor - $0.01 for immediate profit capture
          const patienceRaiseTarget = Math.round(
            Math.max(0.01, applyRaiseOffset(patienceRaiseAnchor, _raiseOffset)) * 100,
          ) / 100;
          let finalPatienceRaise = Math.round(
            Math.min(
              patienceRaiseTarget,
              maxPrice || Number.POSITIVE_INFINITY,
            ) * 100,
          ) / 100;
          if (maxPrice && finalPatienceRaise > maxPrice) {
            finalPatienceRaise = Math.round(maxPrice * 100) / 100;
          }
          const finalDelta = Math.round((finalPatienceRaise - currentPrice) * 100) / 100;

          console.log(
            `[FINAL_PATIENCE_RAISE] asin=${context.asin} current_price=$${currentPrice.toFixed(2)} buy_box_price=$${buyboxPrice?.toFixed(2) ?? 'null'} filtered_anchor_price=$${patienceRaiseAnchor.toFixed(2)} filtered_gap=$${patienceFilteredGap.toFixed(2)} gap_pct=${patienceFilteredGapPct.toFixed(1)}% snap_target=$${patienceRaiseTarget.toFixed(2)} final_target_after_validation=$${finalPatienceRaise.toFixed(2)} final_delta=$${finalDelta.toFixed(2)} final_winning_guard=patience_snap_raise`,
          );

          if (finalPatienceRaise > currentPrice) {
            guardsApplied.push('patience_raise_override');
            if (usedFilteredFallbackForPatience) {
              guardsApplied.push('patience_raise_override_filtered_anchor');
            }
            guardsApplied.push('patience_micro_raise');
            return {
              mode: 'SMART_RAISE',
              newPrice: finalPatienceRaise,
              rawTargetPrice: patienceRaiseTarget,
              reason: `Patience override raise: BB $${buyboxPrice?.toFixed(2)}, next eligible $${patienceRaiseAnchor.toFixed(2)} — raising to $${finalPatienceRaise.toFixed(2)}`,
              guardsApplied,
              intelligenceFactors: intelligence,
              isRaise: true,
              anchorDiagnostics,
            };
          }
        }

        const overrideReason = canUseRaiseOpportunity
          ? `raise_opportunity($${nextEligibleForPatience!.toFixed(2)})${usedFilteredFallbackForPatience ? '_filtered_fallback' : ''}`
          : stockGatedMaximize
            ? 'stock_gated'
            : hasRaiseOpportunity
              ? `raise_opportunity_blocked(${patienceRaiseProtection.blockers.join(',')})`
            : `urgency=${urgency},daysWithoutSale=${daysWithoutSale},bbLossStreak=${bbLossStreak}`;
        console.log(`[Self-Undercut Guard] PATIENCE OVERRIDE: ${overrideReason} — bypassing patience hold`);
        guardsApplied.push(canUseRaiseOpportunity ? 'patience_raise_override' : 'patience_urgency_override');
        if (canUseRaiseOpportunity && usedFilteredFallbackForPatience) {
          guardsApplied.push('patience_raise_override_filtered_anchor');
        }
        // Fall through to micro-step logic below
      }
      
      // === PROFIT-MAX RAISE INTERCEPT ===
      // If patience was overridden specifically because of a raise opportunity,
      // we should RAISE toward the next eligible competitor, NOT micro-step down.
      const profitMaxEligible = smartRaise.lowestEligibleCompetitorPrice ?? anchorDiagnostics.filtered_lowest_fba ?? null;
      const hasProfitMaxGap = profitMaxEligible != null 
        && profitMaxEligible > currentPrice + 0.03;
      
      if (hasProfitMaxGap && (guardsApplied.includes('patience_raise_override') || stockGatedMaximize)) {
        // Raise toward next eligible competitor
        const raiseTarget = applyRaiseOffset(profitMaxEligible, _raiseOffset);
        const raiseGap = raiseTarget - currentPrice;
        const raiseGapCloseRatio = smartRaise.gapCloseRatio || 0.15;
        const RAISE_FLOOR = 0.30; // At least 30% gap close for profit-max
        const effectiveRatio = Math.max(raiseGapCloseRatio, RAISE_FLOOR);
        
        let profitRaisePrice: number;
        if (raiseGap <= 0.15 && raiseGap > 0) {
          profitRaisePrice = raiseTarget; // Snap to target
          guardsApplied.push('profit_raise_snap');
        } else if (raiseGap > 0) {
          const step = Math.max(raiseGap * effectiveRatio, 0.05);
          profitRaisePrice = currentPrice + Math.min(step, raiseGap);
        } else {
          profitRaisePrice = currentPrice;
        }
        
        // Safety clamps
        const maxJump = Math.min(2.0, currentPrice * 0.10);
        if (profitRaisePrice - currentPrice > maxJump) {
          profitRaisePrice = currentPrice + maxJump;
          guardsApplied.push('profit_raise_jump_limiter');
        }
        if (minPrice && profitRaisePrice < minPrice) profitRaisePrice = minPrice;
        if (maxPrice && profitRaisePrice > maxPrice) profitRaisePrice = maxPrice;
        
        profitRaisePrice = Math.round(profitRaisePrice * 100) / 100;
        
        if (profitRaisePrice > currentPrice) {
          console.log(`[Profit-Max Raise] RAISING: $${currentPrice.toFixed(2)} → $${profitRaisePrice.toFixed(2)} (next eligible $${profitMaxEligible.toFixed(2)}, BB $${buyboxPrice?.toFixed(2)}, gap $${raiseGap.toFixed(2)})`);
          guardsApplied.push('profit_max_raise');
          return {
            mode: 'SMART_RAISE',
            newPrice: profitRaisePrice,
            rawTargetPrice: raiseTarget,
            reason: `Profit-max raise: near BB $${buyboxPrice?.toFixed(2)}, next eligible $${profitMaxEligible.toFixed(2)} — raising to $${profitRaisePrice.toFixed(2)}`,
            guardsApplied,
            intelligenceFactors: intelligence,
            isRaise: true,
            anchorDiagnostics,
          };
        }
      }

      // Apply a competitive micro-undercut to try to capture the BB
      // Graduated: smaller steps for lower prices, bigger for higher
      const microStep = currentPrice < 10 ? 0.01 : currentPrice < 20 ? 0.02 : currentPrice < 50 ? 0.03 : 0.05;
      const microTarget = Math.round((currentPrice - microStep) * 100) / 100;
      const hardFloor = minPrice || 0;
      const fallbackFilteredRaiseAnchor = smartRaise.lowestEligibleCompetitorPrice
        ?? anchorDiagnostics.filtered_lowest_fba
        ?? null;
      const fallbackFilteredRaiseGap = fallbackFilteredRaiseAnchor && fallbackFilteredRaiseAnchor > currentPrice
        ? fallbackFilteredRaiseAnchor - currentPrice
        : 0;
      
      if (microTarget >= hardFloor) {
        console.log(`[Self-Undercut Guard] MICRO-STEP: lowest at $${currentPrice.toFixed(2)} but NOT BB owner → competitive step to $${microTarget.toFixed(2)} (floor $${hardFloor.toFixed(2)})`);
        guardsApplied.push('competitive_micro_step');
        targetPrice = microTarget + adjustedUndercut; // Will be reduced by undercut below
        targetSource = `Competitive micro-step ($${microTarget.toFixed(2)}) [not BB owner — already lowest]`;
        // Fall through to normal pricing logic
      } else if (fallbackFilteredRaiseAnchor && fallbackFilteredRaiseGap >= 0.03 && !smartRaise.isInPriceCluster && smartRaise.enabled) {
        const fallbackRaiseStep = Math.min(
          Math.max(0.05, currentPrice * 0.005),
          Math.max(fallbackFilteredRaiseGap - _raiseOffset.offset, 0.01),
          0.20,
        );
        let fallbackRaisePrice = Math.round((currentPrice + fallbackRaiseStep) * 100) / 100;
        if (maxPrice && fallbackRaisePrice > maxPrice) {
          fallbackRaisePrice = maxPrice;
        }
        fallbackRaisePrice = Math.round(fallbackRaisePrice * 100) / 100;

        if (fallbackRaisePrice > currentPrice) {
          console.log(`[Self-Undercut Guard] FLOOR BYPASS RAISE: downward micro-step blocked by floor $${hardFloor.toFixed(2)}, but filtered competitor $${fallbackFilteredRaiseAnchor.toFixed(2)} leaves raise headroom — raising to $${fallbackRaisePrice.toFixed(2)}`);
          guardsApplied.push('floor_bypass_raise');
          return {
            mode: 'SMART_RAISE',
            newPrice: fallbackRaisePrice,
            rawTargetPrice: applyRaiseOffset(fallbackFilteredRaiseAnchor, _raiseOffset),
            reason: `Filtered recovery raise: downward micro-step blocked by floor, next eligible $${fallbackFilteredRaiseAnchor.toFixed(2)} — raising to $${fallbackRaisePrice.toFixed(2)}`,
            guardsApplied,
            intelligenceFactors: intelligence,
            isRaise: true,
            anchorDiagnostics,
          };
        }
      } else if (currentPrice > hardFloor) {
        // Can't do full micro-step, but can still move to floor if not already there
        const floorTarget = hardFloor;
        if (Math.round(floorTarget * 100) !== Math.round(currentPrice * 100)) {
          console.log(`[Self-Undercut Guard] FLOOR-STEP: micro-step blocked, moving to floor $${hardFloor.toFixed(2)} from $${currentPrice.toFixed(2)}`);
          guardsApplied.push('competitive_floor_step');
          targetPrice = floorTarget + adjustedUndercut;
          targetSource = `Floor step ($${hardFloor.toFixed(2)}) [micro-step blocked, moving to floor]`;
        } else {
          console.log(`[Self-Undercut Guard] AT_FLOOR: already at floor $${hardFloor.toFixed(2)}, can't go lower`);
          return {
            mode: 'SKIP',
            newPrice: null,
            rawTargetPrice: targetPrice,
            reason: `At floor ($${hardFloor.toFixed(2)}) — cannot lower further`,
            guardsApplied: [...guardsApplied, 'self_undercut_guard', 'at_floor'],
            intelligenceFactors: intelligence,
            anchorDiagnostics,
          };
        }
      } else {
        // Can't go lower. Before holding, do one FINAL recovery-raise check.
        // This branch was still leaking a downward floor guard into an upward opportunity.
        const finalRecoveryAllowed = Boolean(
          fallbackFilteredRaiseAnchor
          && fallbackFilteredRaiseGap >= 0.03
          && !smartRaise.isInPriceCluster
          && !hasLowerFbmCompetitor
          && (rawLowerFbaGap === 0 || rawLowerFbaGap <= 0.02)
        );

        if (finalRecoveryAllowed) {
          const finalRecoveryStep = Math.min(
            Math.max(0.05, currentPrice * 0.005),
            Math.max(fallbackFilteredRaiseGap - _raiseOffset.offset, 0.01),
            0.20,
          );
          let finalRecoveryPrice = Math.round((currentPrice + finalRecoveryStep) * 100) / 100;
          if (maxPrice && finalRecoveryPrice > maxPrice) finalRecoveryPrice = maxPrice;
          finalRecoveryPrice = Math.round(finalRecoveryPrice * 100) / 100;

          if (finalRecoveryPrice > currentPrice) {
            console.log(`[Self-Undercut Guard] FINAL FLOOR-BYPASS RECOVERY: floor $${hardFloor.toFixed(2)} cannot block upward recovery $${currentPrice.toFixed(2)} → $${finalRecoveryPrice.toFixed(2)} (filtered next eligible $${fallbackFilteredRaiseAnchor!.toFixed(2)}, raw lower gap $${rawLowerFbaGap.toFixed(2)})`);
            guardsApplied.push('final_floor_bypass_recovery_raise');
            return {
              mode: 'SMART_RAISE',
              newPrice: finalRecoveryPrice,
              rawTargetPrice: applyRaiseOffset(fallbackFilteredRaiseAnchor!, _raiseOffset),
              reason: `Final recovery raise: floor $${hardFloor.toFixed(2)} cannot block upward move, next eligible $${fallbackFilteredRaiseAnchor!.toFixed(2)} — raising to $${finalRecoveryPrice.toFixed(2)}`,
              guardsApplied,
              intelligenceFactors: intelligence,
              isRaise: true,
              anchorDiagnostics,
            };
          }
        }

        console.log(`[Self-Undercut Guard] HOLDING: lowest at $${currentPrice.toFixed(2)}, micro-step $${microTarget.toFixed(2)} blocked by floor $${hardFloor.toFixed(2)}`);
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: targetPrice,
          reason: `Already lowest ($${currentPrice.toFixed(2)}) — micro-step blocked by floor ($${hardFloor.toFixed(2)})`,
          guardsApplied: [...guardsApplied, 'self_undercut_guard', 'floor_blocked_micro_step'],
          intelligenceFactors: intelligence,
          anchorDiagnostics,
        };
      }
    } else {
      const stockGatedRecoveryAnchor = smartRaise.lowestEligibleCompetitorPrice
        ?? anchorDiagnostics.filtered_lowest_fba
        ?? null;
      if (stockGatedMaximize && stockGatedRecoveryAnchor && stockGatedRecoveryAnchor > currentPrice + 0.02) {
        console.log(`[Self-Undercut Guard] BYPASSED: stock-gated maximize sees filtered gap $${currentPrice.toFixed(2)} → $${stockGatedRecoveryAnchor.toFixed(2)}`);
      } else {
        // Check if there's a profit-max raise opportunity even while holding
        // Use quality-filtered eligible price, falling back to anchor diagnostics filtered_lowest_fba
        const bbOwnerNextEligible = smartRaise.lowestEligibleCompetitorPrice 
          ?? anchorDiagnostics.filtered_lowest_fba 
          ?? null;
        const bbOwnerHasRaiseGap = bbOwnerNextEligible != null
          && bbOwnerNextEligible > currentPrice + 0.15
          && bbOwnerNextEligible > currentPrice * 1.02
          && smartRaise.enabled
          && !hasLowerFbmCompetitor
          && !smartRaise.isInPriceCluster;
        
        if (bbOwnerHasRaiseGap) {
          // BB owner with significant room above — raise toward next competitor
          const bbRaiseTarget = applyRaiseOffset(bbOwnerNextEligible, _raiseOffset);
          const bbRaiseGap = bbRaiseTarget - currentPrice;
          const bbRaiseRatio = Math.max(smartRaise.gapCloseRatio || 0.15, 0.30);
          
          let bbRaisePrice: number;
          if (bbRaiseGap <= 0.15 && bbRaiseGap > 0) {
            bbRaisePrice = bbRaiseTarget;
            guardsApplied.push('bb_owner_raise_snap');
          } else if (bbRaiseGap > 0) {
            const step = Math.max(bbRaiseGap * bbRaiseRatio, 0.02);
            bbRaisePrice = currentPrice + Math.min(step, bbRaiseGap);
          } else {
            bbRaisePrice = currentPrice;
          }
          
          // Safety clamps
          const maxJump = Math.min(2.0, currentPrice * 0.10);
          if (bbRaisePrice - currentPrice > maxJump) {
            bbRaisePrice = currentPrice + maxJump;
            guardsApplied.push('bb_owner_raise_jump_limiter');
          }
          if (minPrice && bbRaisePrice < minPrice) bbRaisePrice = minPrice;
          if (maxPrice && bbRaisePrice > maxPrice) bbRaisePrice = maxPrice;
          
          // Check BB loss dampening
          const bbLossCount = context.bbLossAfterRaiseCount;
          if (bbLossCount >= 3) {
            console.log(`[Self-Undercut Guard] BB-OWNER RAISE BLOCKED: bb_loss_after_raise=${bbLossCount} — too many BB losses after raises`);
            guardsApplied.push('bb_owner_raise_blocked_bb_loss');
          } else {
            if (bbLossCount >= 1) {
              const dampen = bbLossCount >= 2 ? 0.25 : 0.50;
              const originalStep = bbRaisePrice - currentPrice;
              bbRaisePrice = currentPrice + Math.max(originalStep * dampen, 0.01);
              guardsApplied.push(`bb_owner_raise_dampened_${Math.round(dampen * 100)}pct`);
            }
            
            bbRaisePrice = Math.round(bbRaisePrice * 100) / 100;
            
            if (bbRaisePrice > currentPrice) {
              console.log(`[Self-Undercut Guard] BB-OWNER PROFIT RAISE: $${currentPrice.toFixed(2)} → $${bbRaisePrice.toFixed(2)} (next eligible $${bbOwnerNextEligible.toFixed(2)}, gap $${bbRaiseGap.toFixed(2)})`);
              guardsApplied.push('bb_owner_profit_raise');
              return {
                mode: 'SMART_RAISE',
                newPrice: bbRaisePrice,
                rawTargetPrice: bbRaiseTarget,
                reason: `BB owner profit raise: lowest at $${currentPrice.toFixed(2)}, next eligible $${bbOwnerNextEligible.toFixed(2)} — raising to $${bbRaisePrice.toFixed(2)}`,
                guardsApplied,
                intelligenceFactors: intelligence,
                isRaise: true,
                anchorDiagnostics,
              };
            }
          }
        }

        // === GENERAL MICRO-RAISE PROFIT RECOVERY (FINAL STAGE) ===
        // Even if the gap doesn't meet the $0.15/2% threshold above, try a small 
        // controlled raise if there's ANY room above us. This recovers margin in
        // small steps without needing a large gap to justify action.
        // Requirements: BB owner, smart raise enabled, not in cluster, some room above
        const microRaiseEligible = smartRaise.lowestEligibleCompetitorPrice 
          ?? anchorDiagnostics.filtered_lowest_fba 
          ?? null;
        const microRaiseGap = microRaiseEligible != null ? microRaiseEligible - currentPrice : 0;
        const microRaiseBbLoss = context.bbLossAfterRaiseCount ?? 0;
        
        if (microRaiseEligible != null 
            && microRaiseGap > 0.03  // At least 3 cents of room
            && smartRaise.enabled 
            && !hasLowerFbmCompetitor
            && !smartRaise.isInPriceCluster
            && microRaiseBbLoss < 2) {  // Not repeatedly losing BB after raises
          
          // Small controlled step: $0.05-$0.20 depending on price level and gap
          const microStep = Math.min(
            Math.max(0.05, currentPrice * 0.005),  // 0.5% of price or $0.05 min
            microRaiseGap - _raiseOffset.offset,  // Stay below next competitor (match or $0.01)
            0.20  // Hard cap at $0.20 per cycle
          );
          
          if (microStep >= 0.01) {
            let microRaiseTarget = Math.round((currentPrice + microStep) * 100) / 100;
            
            // Safety clamps
            if (maxPrice && microRaiseTarget > maxPrice) microRaiseTarget = maxPrice;
            if (minPrice && microRaiseTarget < minPrice) microRaiseTarget = minPrice;
            
            // Dampen if 1 BB loss after raise
            if (microRaiseBbLoss === 1) {
              const dampened = Math.max((microRaiseTarget - currentPrice) * 0.50, 0.01);
              microRaiseTarget = Math.round((currentPrice + dampened) * 100) / 100;
            }
            
            if (microRaiseTarget > currentPrice) {
              console.log(`[Micro-Raise Recovery] BB owner profit step: $${currentPrice.toFixed(2)} → $${microRaiseTarget.toFixed(2)} (next eligible $${microRaiseEligible.toFixed(2)}, gap $${microRaiseGap.toFixed(2)}, step $${microStep.toFixed(2)})`);
              guardsApplied.push('micro_raise_profit_recovery');
              return {
                mode: 'SMART_RAISE',
                newPrice: microRaiseTarget,
                rawTargetPrice: applyRaiseOffset(microRaiseEligible, _raiseOffset),
                reason: `Micro-raise profit recovery: BB owner at $${currentPrice.toFixed(2)}, next eligible $${microRaiseEligible.toFixed(2)} — stepping to $${microRaiseTarget.toFixed(2)}`,
                guardsApplied,
                intelligenceFactors: intelligence,
                isRaise: true,
                anchorDiagnostics,
              };
            }
          }
        }

        // We're truly lowest AND winning BB — hold
        console.log(`[Self-Undercut Guard] HOLDING: current $${currentPrice.toFixed(2)} already ≤ target anchor $${targetPrice.toFixed(2)} — BB owner, no need to lower`);
        return {
          mode: 'SKIP',
          newPrice: null,
          rawTargetPrice: targetPrice,
          reason: `Already lowest among eligible competitors ($${currentPrice.toFixed(2)} ≤ $${targetPrice.toFixed(2)}) — holding price (BB owner)`,
          guardsApplied: [...guardsApplied, 'self_undercut_guard'],
          intelligenceFactors: intelligence,
          anchorDiagnostics,
        };
      }
    }
  }

  // Apply adjusted undercut
  let proposedPrice = targetPrice - adjustedUndercut;
  const rawTargetPrice = proposedPrice;

  // === PROFIT GUARD REMOVED (manual-min-only policy) ===
  // The user's manual min_price is the ONLY price floor. ROI floor is
  // structurally NOT allowed to influence the effective floor here.
  // These variables stay declared for backward-compat with downstream trace
  // fields, but they are hard-pinned so they can never clamp a price.
  // ⚠ DO NOT reintroduce hardProfitFloor logic. See mem://strategy/repricer/manual-min-only-v1
  const blockedByProfitGuard = false;
  const profitFloorUsed: number | undefined = undefined;
  const hardProfitFloor: number | null = null;

  // Track if we need to auto-lower min_price (populated after FINAL_CLAMP)
  let requiresMinPriceLower = false;
  let suggestedNewMinPrice: number | undefined = undefined;
  let minGapAmount: number | undefined = undefined;
  let minGapPercent: number | undefined = undefined;

  // Effective floor = manual min ONLY.
  const effectiveFloor = minPrice || 0;

  if (effectiveFloor > 0 && proposedPrice < effectiveFloor) {
    proposedPrice = effectiveFloor;
    guardsApplied.push('min_price');
  }
  
  if (maxPrice && proposedPrice > maxPrice) {
    proposedPrice = maxPrice;
    guardsApplied.push('max_price');
  }

  // Check if change is too small (use cents to avoid floating-point precision errors)
  if (currentPrice && Math.round(proposedPrice * 100) === Math.round(currentPrice * 100)) {
    // Preserve WHY the price ended up unchanged — guards that clamped it back to currentPrice
    const constraintTag = guardsApplied.length > 0
      ? ` [constrained_by: ${guardsApplied.join(',')}]`
      : (blockedByProfitGuard ? ' [constrained_by: profit_guard]' : ' [constrained_by: market_stable]');

    const initialTarget = Math.round(rawTargetPrice * 1000) / 1000;
    const adjustedTarget = Math.round(proposedPrice * 1000) / 1000;
    const finalTarget = Math.round(proposedPrice * 100) / 100;
    const deltaFromCurrent = Math.round((finalTarget - currentPrice) * 1000) / 1000;
    anchorDiagnostics.final_output_price = finalTarget;

    const floorBlockedMove = rawTargetPrice < effectiveFloor && Math.abs(effectiveFloor - currentPrice) < 0.015;
    const traceLabel = floorBlockedMove ? 'floor_blocked' : 'blocked_small_change';

    // === FLOOR SOURCE ATTRIBUTION ===
    // The "effective floor" the engine enforces is MAX(user_min, ROI/profit floor).
    // Surface WHICH floor actually blocked the move so the UI no longer conflates
    // a user-configured min with a hidden ROI/profit-protection floor.
    const userMinFloor = Math.round((minPrice || 0) * 100) / 100;
    const roiProfitFloor = hardProfitFloor !== null ? Math.round(hardProfitFloor * 100) / 100 : null;
    let floorSource: 'user_min' | 'roi_profit' | 'both_equal' | 'none' = 'none';
    if (effectiveFloor > 0) {
      if (roiProfitFloor !== null && userMinFloor > 0 && Math.abs(roiProfitFloor - userMinFloor) < 0.005) {
        floorSource = 'both_equal';
      } else if (roiProfitFloor !== null && roiProfitFloor > userMinFloor) {
        floorSource = 'roi_profit';
      } else if (userMinFloor > 0) {
        floorSource = 'user_min';
      }
    }
    const currentPriceFloorLock = floorBlockedMove && Math.abs(effectiveFloor - currentPrice) < 0.015;
    const floorSourceLabel =
      floorSource === 'roi_profit' ? 'ROI protection floor'
      : floorSource === 'user_min' ? 'user min floor'
      : floorSource === 'both_equal' ? 'min floor (= ROI floor)'
      : 'effective floor';

    console.log(
      `[PRICE_TRACE] current=${currentPrice.toFixed(2)} lowest_fba_used=${lowestFbaPrice?.toFixed(2) ?? 'null'} buybox_used=${buyboxPrice?.toFixed(2) ?? 'null'} initial_target=${initialTarget.toFixed(3)} adjusted_target=${adjustedTarget.toFixed(3)} final_target=${finalTarget.toFixed(2)} delta=${deltaFromCurrent.toFixed(3)} applied_or_blocked=${traceLabel}`
    );

    // Smart suggestion for no-change path when the configured min holds the price
    const wasClampedByMin = guardsApplied.includes('FINAL_CLAMP_MIN') || guardsApplied.includes('min_price');
    const constraintPrice = minPrice || 0;

    if (wasClampedByMin && constraintPrice > 0 && rawTargetPrice < constraintPrice) {
      const gap = constraintPrice - rawTargetPrice;
      const gapPct = constraintPrice > 0 ? (gap / constraintPrice) * 100 : 0;

      // Small gaps matter in competitive markets; include >= $0.005 moves
      if (gap >= 0.005 || gapPct > 0.05) {
        const candidateMin = Math.floor(rawTargetPrice * 20) / 20; // round down to nearest $0.05
        const candidateSuggestion = Math.round(candidateMin * 100) / 100;

        // Only surface actionable suggestions
        if (candidateSuggestion < constraintPrice) {
          requiresMinPriceLower = true;
          minGapAmount = Math.round(gap * 100) / 100;
          minGapPercent = Math.round(gapPct * 10) / 10;
          suggestedNewMinPrice = candidateSuggestion;
          guardsApplied.push('MIN_PRICE_SUGGESTION');
          console.log(`[MIN_SUGGESTION] no_change, constraint=$${constraintPrice.toFixed(2)}, competitive=$${rawTargetPrice.toFixed(2)}, gap=$${gap.toFixed(3)}, suggested_new_min=$${suggestedNewMinPrice.toFixed(2)}`);
        }
      }
    }

    return {
      mode: 'SKIP',
      newPrice: null,
      rawTargetPrice,
      reason: floorBlockedMove
        ? `Competitive target $${rawTargetPrice.toFixed(2)} blocked by ${floorSourceLabel} $${effectiveFloor.toFixed(2)} — holding current price${constraintTag}`
        : `Price change too small (<$0.01)${constraintTag}`,
      guardsApplied,
      requiresMinPriceLower,
      suggestedNewMinPrice: suggestedNewMinPrice ? Math.round(suggestedNewMinPrice * 100) / 100 : undefined,
      effectiveFloor: Math.round(effectiveFloor * 100) / 100,
      userMinFloor,
      effectiveProfitFloor: roiProfitFloor,
      effectiveFloorSource: floorSource,
      currentPriceFloorLock,
      minGapAmount,
      minGapPercent,
      intelligenceFactors: {
        ...intelligence,
        decision_trace: {
          current_price: currentPrice,
          lowest_fba_used: lowestFbaPrice,
          buybox_used: buyboxPrice,
          initial_target: initialTarget,
          adjusted_target: adjustedTarget,
          final_target: finalTarget,
          delta: deltaFromCurrent,
          applied_or_blocked: traceLabel,
          anchor_diagnostics: anchorDiagnostics,
        },
      },
      blockedByProfitGuard,
      profitFloorUsed,
    };
  }

  // === REPEATED-FAILURE STEP ESCALATION ===
  // If consecutive failed undercuts exceed threshold, widen the allowed step
  const failedUndercuts = (context as any)._consecutiveFailedUndercuts ?? 0;
  let stepEscalationApplied = false;

  // Apply max step safety — allow larger steps when losing Buy Box OR repeated failures
  if (currentPrice && currentPrice > 0) {
    // If our current price is ABOVE the buybox / lowest FBA, we CANNOT be earning the
    // BB right now — treat `isBuyboxOwner` as stale in that case. Without this override,
    // a stale BB-owner flag forces the 5% max_step cap and creates a slow multi-cycle
    // crawl toward the competitive anchor (e.g. $16.31 → $15.49 → … instead of straight
    // to $14.74). See B00JNR7928 investigation.
    const lowestFbaCtx = (context as any)?.lowestFbaPrice ?? null;
    const priceAboveBB = !!(buyboxPrice && currentPrice > buyboxPrice + 0.01);
    const priceAboveLowestFba = !!(lowestFbaCtx && currentPrice > lowestFbaCtx + 0.01);
    const losingBB = priceAboveBB || priceAboveLowestFba || (!smartRaise.isBuyboxOwner && !!buyboxPrice && currentPrice > buyboxPrice);
    const maxStepDollar = maxStepAmount || 0.50;
    let maxStepPct = losingBB ? 30 : (maxStepPercent || 5);

    // Escalate step after repeated failures: 3+ failures → +50%, 5+ → +100%
    if (failedUndercuts >= 5 && !losingBB) {
      maxStepPct = Math.min(maxStepPct * 2, 15); // double but cap at 15%
      stepEscalationApplied = true;
      guardsApplied.push(`step_escalation_${failedUndercuts}_failures`);
      console.log(`[STEP_ESCALATION] ${failedUndercuts} consecutive failed undercuts → maxStepPct doubled to ${maxStepPct}%`);
    } else if (failedUndercuts >= 3 && !losingBB) {
      maxStepPct = Math.min(maxStepPct * 1.5, 10); // 50% increase, cap at 10%
      stepEscalationApplied = true;
      guardsApplied.push(`step_escalation_${failedUndercuts}_failures`);
      console.log(`[STEP_ESCALATION] ${failedUndercuts} consecutive failed undercuts → maxStepPct increased to ${maxStepPct}%`);
    }

    const maxChangeDollar = Math.max(maxStepDollar, currentPrice * (maxStepPct / 100));

    const priceDelta = proposedPrice - currentPrice;

    if (Math.abs(priceDelta) > maxChangeDollar) {
      const direction = priceDelta > 0 ? 1 : -1;
      proposedPrice = currentPrice + (direction * maxChangeDollar);
      const stepTag = losingBB
        ? (priceAboveBB || priceAboveLowestFba ? 'max_step_30pct_above_market' : 'max_step_30pct_bb_loss')
        : 'max_step';
      guardsApplied.push(stepTag);
      console.log(`[max_step] ${stepTag}: $${currentPrice.toFixed(2)} → $${proposedPrice.toFixed(2)} (max change $${maxChangeDollar.toFixed(2)}) [aboveBB=${priceAboveBB} aboveLowestFba=${priceAboveLowestFba} isBBOwnerFlag=${smartRaise.isBuyboxOwner}]`);
    }
  }

  // ===================================================================
  // CRITICAL FIX: FINAL HARD CLAMP - MUST RUN AFTER ALL CALCULATIONS
  // This is the ABSOLUTE LAST STEP before returning a price.
  // No logic is allowed to modify the price after this clamp.
  // ===================================================================
  const preClampPrice = proposedPrice;
  
  // HARD CLAMP: Enforce min/max as absolute bounds
  if (minPrice !== null && minPrice !== undefined && proposedPrice < minPrice) {
    proposedPrice = minPrice;
    guardsApplied.push('FINAL_CLAMP_MIN');
    console.log(`[CRITICAL] FINAL CLAMP MIN: $${preClampPrice.toFixed(2)} → $${minPrice.toFixed(2)}`);
  }
  if (maxPrice !== null && maxPrice !== undefined && proposedPrice > maxPrice) {
    proposedPrice = maxPrice;
    guardsApplied.push('FINAL_CLAMP_MAX');
    console.log(`[CRITICAL] FINAL CLAMP MAX: $${preClampPrice.toFixed(2)} → $${maxPrice.toFixed(2)}`);
  }

  // Round to 2 decimal places
  proposedPrice = Math.round(proposedPrice * 100) / 100;

  // ===================================================================
  // SMART MIN-PRICE SUGGESTION
  // When the configured min price holds the evaluator above the competitive target,
  // suggest a lower min based only on that competitive target.
  // ===================================================================
  const wasClampedByMin = guardsApplied.includes('FINAL_CLAMP_MIN') || guardsApplied.includes('min_price');
  const constraintPrice = minPrice || 0;

  if (wasClampedByMin && constraintPrice > 0 && rawTargetPrice < constraintPrice) {
    const gap = constraintPrice - rawTargetPrice;
    const gapPct = constraintPrice > 0 ? (gap / constraintPrice) * 100 : 0;
    
    if (gap > 0.02 || gapPct > 0.1) {
      requiresMinPriceLower = true;
      minGapAmount = Math.round(gap * 100) / 100;
      minGapPercent = Math.round(gapPct * 10) / 10;
      const candidateMin = Math.floor(rawTargetPrice * 20) / 20; // round down to nearest $0.05
      suggestedNewMinPrice = Math.round(candidateMin * 100) / 100;
      
      guardsApplied.push('MIN_PRICE_SUGGESTION');
      console.log(`[MIN_SUGGESTION] constraint=$${constraintPrice.toFixed(2)} (min), competitive=$${rawTargetPrice.toFixed(2)}, gap=$${gap.toFixed(2)} (${gapPct.toFixed(1)}%), suggested_new_min=$${suggestedNewMinPrice.toFixed(2)}`);
    }
  }

  // ===================================================================
  // SAFETY ASSERT: Abort if price is STILL outside bounds after clamp
  // This should never happen, but if it does, we abort instead of
  // sending a potentially damaging price to Amazon.
  // ===================================================================
  if (minPrice !== null && minPrice !== undefined && proposedPrice < minPrice) {
    console.error(`[FATAL] Price $${proposedPrice} is below min $${minPrice} AFTER CLAMP. Aborting.`);
    return {
      mode: 'SKIP',
      newPrice: null,
      rawTargetPrice,
      reason: `SAFETY ABORT: Computed price $${proposedPrice} below min $${minPrice}`,
      guardsApplied: ['SAFETY_ABORT_MIN'],
      intelligenceFactors: intelligence,
    };
  }
  if (maxPrice !== null && maxPrice !== undefined && proposedPrice > maxPrice) {
    console.error(`[FATAL] Price $${proposedPrice} is above max $${maxPrice} AFTER CLAMP. Aborting.`);
    return {
      mode: 'SKIP',
      newPrice: null,
      rawTargetPrice,
      reason: `SAFETY ABORT: Computed price $${proposedPrice} above max $${maxPrice}`,
      guardsApplied: ['SAFETY_ABORT_MAX'],
      intelligenceFactors: intelligence,
    };
  }

  // Build intelligence note
  const intelNote = intelFactors.length > 0 
    ? `Intel: ${intelFactors.join(', ')}` 
    : 'No intel adjustments';
  
  const profitGuardNote = blockedByProfitGuard 
    ? (() => {
        const pg = context.profitGuard;
        const localCostVal = pg?.localCost;
        const refRate = pg?.referralRate;
        const fbaFee = pg?.fbaFeeFixed;
        const minRoi = pg?.minRoiPercent;
        // Show breakdown if we have cost info
        if (localCostVal && localCostVal > 0 && profitFloorUsed) {
          const estRef = profitFloorUsed * (refRate || 0.15);
          const estFba = fbaFee || 0;
          const estFees = estRef + estFba;
          const estProfit = profitFloorUsed - estFees - localCostVal;
          return ` | Profit Guard: floor $${profitFloorUsed.toFixed(2)} (cost $${localCostVal.toFixed(2)} + fees ~$${estFees.toFixed(2)} + ${minRoi ?? '?'}% ROI = $${profitFloorUsed.toFixed(2)} post-fee)`;
        }
        return ` | Profit Guard: floor $${profitFloorUsed?.toFixed(2)}`;
      })()
    : '';

  // === NO-LOWER GUARD: When BB data is missing/empty, never lower price ===
  if ((context as any)._noLowerFlag && currentPrice && proposedPrice < currentPrice) {
    console.log(`[BB No-Lower Guard] BB data missing/empty — blocking lower from $${currentPrice.toFixed(2)} to $${proposedPrice.toFixed(2)}. Holding.`);

    // === CACHED-SNAPSHOT SUGGESTION FALLBACK ===
    // Even though repricing is blocked, generate a min-price suggestion if the user's
    // min price is clearly above the competitive level (rawTargetPrice).
    // This prevents the confusing "No suggested minimum" when BB < min is visible.
    let bbNoDataRequiresMinLower = false;
    let bbNoDataSuggestedMin: number | undefined = undefined;
    let bbNoDataGapAmount: number | undefined = undefined;
    let bbNoDataGapPercent: number | undefined = undefined;

    const constraintPriceForSuggestion = minPrice || 0;
    const competitiveRef = rawTargetPrice; // computed from whatever data was available (cached/partial)

    if (constraintPriceForSuggestion > 0 && competitiveRef !== null && competitiveRef > 0 && competitiveRef < constraintPriceForSuggestion) {
      const gap = constraintPriceForSuggestion - competitiveRef;
      const gapPct = (gap / constraintPriceForSuggestion) * 100;

      if (gap >= 0.005 || gapPct > 0.05) {
        const candidateMin = Math.floor(competitiveRef * 20) / 20; // nearest $0.05 down
        const candidateSuggestion = Math.round(candidateMin * 100) / 100;

        if (candidateSuggestion < constraintPriceForSuggestion) {
          bbNoDataRequiresMinLower = true;
          bbNoDataSuggestedMin = candidateSuggestion;
          bbNoDataGapAmount = Math.round(gap * 100) / 100;
          bbNoDataGapPercent = Math.round(gapPct * 10) / 10;
          console.log(`[MIN_SUGGESTION] bb_no_data_fallback, min=$${constraintPriceForSuggestion.toFixed(2)}, competitive=$${competitiveRef.toFixed(2)}, gap=$${gap.toFixed(3)}, suggested_new_min=$${candidateSuggestion.toFixed(2)} (from cached/partial data)`);
        }
      }
    }

    const bbNoDataGuards = [...guardsApplied, 'bb_no_data_hold'];
    if (bbNoDataRequiresMinLower) bbNoDataGuards.push('MIN_PRICE_SUGGESTION');

    return {
      mode: 'SKIP',
      newPrice: null,
      rawTargetPrice,
      reason: `BB no-data guard: no reliable BB/offers data (source: ${bbSource}) — will not lower price`,
      guardsApplied: bbNoDataGuards,
      intelligenceFactors: intelligence,
      requiresMinPriceLower: bbNoDataRequiresMinLower,
      suggestedNewMinPrice: bbNoDataSuggestedMin,
      minGapAmount: bbNoDataGapAmount,
      minGapPercent: bbNoDataGapPercent,
    };
  }

  // === BUILD STRUCTURED DECISION CONTEXT ===
  // This is the single source of truth for what happened in this evaluation.
  // The reason string is generated from these fields — never independently.
  // FBM Lowest-Seller mode is a hard contract: when those guards fired, the executed
  // anchor is the lowest FBM regardless of how late-stage targetSource may read.
  const lowestFbmModeActive = guardsApplied.includes('fbm_compete_lowest_fbm')
    || guardsApplied.includes('lowest_seller_mode_disable_raise')
    || guardsApplied.includes('effective_fbm_competition_mode=lowest_seller');
  const anchorSourceKey = lowestFbmModeActive ? 'lowest_fbm'
    : targetSource.includes('Buy Box') 
    ? (targetSource.includes('winner_offer') || targetSource.includes('[winner_offer]') ? 'buybox_winner_offer' 
       : targetSource.includes('summary') ? 'buybox_summary' 
       : targetSource.includes('fallback') ? 'buybox_fallback'
       : 'buybox')
    : targetSource.toLowerCase().includes('lowest fba') ? 'lowest_fba'
    : targetSource.toLowerCase().includes('lowest offer') ? 'lowest_offer'
    : targetSource.toLowerCase().includes('lowest eligible') ? 'lowest_eligible'
    : targetSource.toLowerCase().includes('lowest fbm') ? 'lowest_fbm'
    : targetSource.toLowerCase().includes('fbm') ? 'fbm_target'
    : 'unknown';

  const decisionContext = {
    anchor_source: anchorSourceKey,
    anchor_price: targetPrice,
    undercut_base: effectiveUndercut,
    multiplier_used: visibleIntelMultiplier,
    undercut_effective: Math.round(adjustedUndercut * 100) / 100,
    effective_fbm_competition_mode: fbmCompetitionMode,
    target_price_pre_guards: Math.round(rawTargetPrice * 100) / 100,
    target_price_post_guards: proposedPrice,
    floor_price: profitFloorUsed ?? null,
    blocked_by_floor: blockedByProfitGuard,
    guards_applied: guardsApplied,
    bb_source: bbSource,
    tuning_source: intelligence.tuningSource || 'deterministic',
    combined_multiplier: visibleIntelMultiplier,
    lowest_fbm_anchor_price: lowestFbmModeActive ? (typeof fbmMarketAnchorPrice === 'number' ? fbmMarketAnchorPrice : null) : null,
    ...(intelligence || {}),
  };

  // === INTERNAL CONSISTENCY CHECK ===
  // Verify anchor_price - undercut_effective ≈ target_price_pre_guards
  const expectedPreGuard = Math.round((targetPrice - adjustedUndercut) * 100) / 100;
  const actualPreGuard = decisionContext.target_price_pre_guards;
  if (Math.abs(expectedPreGuard - actualPreGuard) > 0.01) {
    console.warn(`[ANCHOR MATH MISMATCH] ${anchorSourceKey}: anchor=$${targetPrice}, undercut=$${adjustedUndercut.toFixed(4)}, expected_pre_guard=$${expectedPreGuard}, actual_pre_guard=$${actualPreGuard}`);
    (decisionContext as any).anchor_math_mismatch = true;
    (decisionContext as any).expected_pre_guard = expectedPreGuard;
  }

  // Build reason string FROM the structured fields (single source of truth)
  const anchorLabel = anchorSourceKey === 'buybox_winner_offer' ? `Buy Box ($${targetPrice.toFixed(2)}) [winner_offer]`
    : anchorSourceKey === 'buybox_summary' ? `Buy Box ($${targetPrice.toFixed(2)}) [summary]`
    : anchorSourceKey === 'buybox_fallback' ? `Buy Box ($${targetPrice.toFixed(2)}) [fallback]`
    : anchorSourceKey === 'buybox' ? `Buy Box ($${targetPrice.toFixed(2)})`
    : anchorSourceKey === 'lowest_fba' ? `Lowest FBA ($${targetPrice.toFixed(2)})`
    : anchorSourceKey === 'lowest_offer' ? `Lowest offer ($${targetPrice.toFixed(2)})`
    : anchorSourceKey === 'lowest_eligible' ? `Lowest eligible ($${targetPrice.toFixed(2)})`
    : anchorSourceKey === 'lowest_fbm' ? `Lowest FBM ($${targetPrice.toFixed(2)})`
    : anchorSourceKey === 'fbm_target' ? `FBM target ($${targetPrice.toFixed(2)})`
    : `Target ($${targetPrice.toFixed(2)})`;

  // Build safeguard note when min/max floor clamped the price
  const clampedByMin = guardsApplied.includes('FINAL_CLAMP_MIN') || guardsApplied.includes('effective_floor');
  const clampedByMax = guardsApplied.includes('FINAL_CLAMP_MAX') || guardsApplied.includes('max_price');
  const safeguardNote = clampedByMin && minPrice && rawTargetPrice < minPrice
    ? ` | ⚠️ Safeguard: raw target $${rawTargetPrice.toFixed(2)} clamped to Min $${minPrice.toFixed(2)}`
    : clampedByMax && maxPrice && rawTargetPrice > maxPrice
    ? ` | ⚠️ Safeguard: raw target $${rawTargetPrice.toFixed(2)} clamped to Max $${maxPrice.toFixed(2)}`
    : '';
  const reasonString = `${anchorLabel} - $${adjustedUndercut.toFixed(2)} undercut (${visibleIntelMultiplier.toFixed(2)}x) → $${proposedPrice.toFixed(2)}${profitGuardNote}${safeguardNote}`;

  if (currentPrice) {
    const initialTarget = Math.round(rawTargetPrice * 1000) / 1000;
    const adjustedTarget = Math.round(proposedPrice * 1000) / 1000;
    const finalTarget = Math.round(proposedPrice * 100) / 100;
    const deltaFromCurrent = Math.round((finalTarget - currentPrice) * 1000) / 1000;
    anchorDiagnostics.final_output_price = finalTarget;

    console.log(
      `[PRICE_TRACE] current=${currentPrice.toFixed(2)} lowest_fba_used=${lowestFbaPrice?.toFixed(2) ?? 'null'} buybox_used=${buyboxPrice?.toFixed(2) ?? 'null'} initial_target=${initialTarget.toFixed(3)} adjusted_target=${adjustedTarget.toFixed(3)} final_target=${finalTarget.toFixed(2)} delta=${deltaFromCurrent.toFixed(3)} applied_or_blocked=applied_candidate`
    );
  }

  return {
    mode: 'AI_REPRICE',
    newPrice: proposedPrice,
    rawTargetPrice: Math.round(rawTargetPrice * 100) / 100,
    reason: reasonString,
    guardsApplied,
    requiresMinPriceLower,
    suggestedNewMinPrice: suggestedNewMinPrice ? Math.round(suggestedNewMinPrice * 100) / 100 : undefined,
    effectiveFloor: Math.round(effectiveFloor * 100) / 100,
    minGapAmount,
    minGapPercent,
    aiNote: intelNote,
    aiAggressiveness: intelMultiplier,
    intelligenceFactors: {
      ...decisionContext,
      decision_trace: {
        current_price: currentPrice,
        lowest_fba_used: lowestFbaPrice,
        buybox_used: buyboxPrice,
        initial_target: Math.round(rawTargetPrice * 1000) / 1000,
        adjusted_target: Math.round(proposedPrice * 1000) / 1000,
        final_target: Math.round(proposedPrice * 100) / 100,
        delta: currentPrice ? Math.round((Math.round(proposedPrice * 100) / 100 - currentPrice) * 1000) / 1000 : null,
        applied_or_blocked: 'applied_candidate',
        anchor_diagnostics: anchorDiagnostics,
      },
    },
    blockedByProfitGuard,
    profitFloorUsed,
  };
}

// Gather intelligence from multiple data sources
async function gatherIntelligence(
  supabase: any,
  userId: string,
  asin: string,
  sku: string | undefined,
  marketplace: string,
  snapshot: any,
  rule: any
): Promise<IntelligenceFactors> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Default values
  const intel: IntelligenceFactors = {
    salesVelocityScore: 50,
    yourDailySales: 0,
    estimatedMarketDailySales: 0,
    units7d: 0,
    units30d: 0,
    ads7d: 0,
    ads30d: 0,
    adsEffective: 0,
    unitsToday: 0,
    todayMomentumDrop: false,
    momentumMarketDropped: false,
    anchorPriceNow: null,
    anchorPrice24hAgo: null,
    marketDropPct: null,
    marketDropAmount: null,
    momentumTriggered: false,
    yourUnitsAvailable: 0,
    yourDaysOfStock: null,
    stockAggressionModifier: 1.0,
    stockOverlayTag: null,
    buyboxWinRate: 50,
    buyboxWinStreak: 0,
    buyboxLossStreak: 0,
    competitorStockSignal: 'UNKNOWN',
    competitorCount: snapshot?.offers_count || 0,
    fbaCompetitorCount: 0,
    amazonSelling: false,
    daysSinceFirstListed: 0,
    daysWithoutSale: 0,
    inventoryAge: 0,
    urgencyScore: 0,
  };

  try {
    // === 1. SALES VELOCITY — 30-day AND 7-day windows ===
    const { data: salesData30d } = await supabase
      .from('sales_orders')
      .select('order_date, quantity, asin')
      .eq('user_id', userId)
      .eq('asin', asin)
      .gte('order_date', thirtyDaysAgo.toISOString().split('T')[0])
      .not('order_status', 'in', '("Canceled","Cancelled")')
      .is('is_cancelled', false)
      .order('order_date', { ascending: false });

    if (salesData30d && salesData30d.length > 0) {
      intel.units30d = salesData30d.reduce((sum: number, o: any) => sum + (o.quantity || 1), 0);
      intel.ads30d = intel.units30d / 30;
      
      // 7-day subset
      const cutoff7d = sevenDaysAgo.toISOString().split('T')[0];
      const sales7d = salesData30d.filter((o: any) => o.order_date >= cutoff7d);
      intel.units7d = sales7d.reduce((sum: number, o: any) => sum + (o.quantity || 1), 0);
      intel.ads7d = intel.units7d / 7;

      // Today's sales (Pacific Time = Amazon business day)
      const pacificOffset = -8 * 60; // PST offset in minutes
      const nowPacific = new Date(now.getTime() + (pacificOffset + now.getTimezoneOffset()) * 60000);
      const todayPacific = nowPacific.toISOString().split('T')[0];
      const salesToday = salesData30d.filter((o: any) => o.order_date >= todayPacific);
      intel.unitsToday = salesToday.reduce((sum: number, o: any) => sum + (o.quantity || 1), 0);

      // Weighted effective ADS
      const w7 = Number(rule?.velocity_weight_7d ?? 0.6);
      const w30 = Number(rule?.velocity_weight_30d ?? 0.4);
      intel.adsEffective = (intel.ads7d * w7) + (intel.ads30d * w30);
      intel.yourDailySales = intel.adsEffective;

      // Today momentum drop: if today's sales are less than half the daily average
      // and we normally sell at least 1 unit/day, flag as sales-side momentum drop
      const momentumThresholdPct = Number((rule as any)?._momentumThresholdPct ?? 50);
      const momentumEnabled = (rule as any)?._momentumCheckEnabled !== false;
      
      if (momentumEnabled && intel.ads7d >= 0.5 && intel.unitsToday < intel.ads7d * (momentumThresholdPct / 100)) {
        intel.todayMomentumDrop = true;
        console.log(`[Intelligence] TODAY SALES DROP: ${asin} sold ${intel.unitsToday} today vs ${intel.ads7d.toFixed(2)} avg/day (threshold: ${momentumThresholdPct}%).`);
      }
      
      // === MARKET DROP GUARDRAIL ===
      // Check if anchor/BB price dropped since last snapshot (24h ago)
      // Only trigger full momentum if BOTH sales dropped AND market moved against us
      if (intel.todayMomentumDrop) {
        // Get previous snapshot's buybox price from 12-48h ago
        const { data: prevSnapshots } = await supabase
          .from('repricer_competitor_snapshots')
          .select('buybox_price, fetched_at')
          .eq('user_id', userId)
          .eq('asin', asin)
          .eq('marketplace', marketplace)
          .lt('fetched_at', new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString())
          .order('fetched_at', { ascending: false })
          .limit(1);
        
        const prevBBPrice = prevSnapshots?.[0]?.buybox_price;
        const currentBBPrice = snapshot?.buybox_price;
        
        intel.anchorPriceNow = currentBBPrice || null;
        intel.anchorPrice24hAgo = prevBBPrice || null;
        
        if (prevBBPrice && currentBBPrice && currentBBPrice < prevBBPrice) {
          const dropDollars = prevBBPrice - currentBBPrice;
          const dropPct = (dropDollars / prevBBPrice) * 100;
          intel.marketDropAmount = Math.round(dropDollars * 100) / 100;
          intel.marketDropPct = Math.round(dropPct * 10) / 10;
          intel.momentumMarketDropped = true;
          intel.momentumTriggered = true;
          console.log(`[Intelligence] MARKET DROP CONFIRMED: BB $${prevBBPrice.toFixed(2)} → $${currentBBPrice.toFixed(2)} (-$${dropDollars.toFixed(2)}, -${dropPct.toFixed(1)}%). Full momentum triggered.`);
        } else {
          // Sales dropped but market didn't move → DON'T trigger aggressive momentum
          intel.momentumMarketDropped = false;
          intel.momentumTriggered = false;
          intel.todayMomentumDrop = false; // Reset: it's just a normal slow day
          console.log(`[Intelligence] MOMENTUM GUARDRAIL: Sales dropped (${intel.unitsToday} today) but BB stable ($${currentBBPrice?.toFixed(2) || '?'} now, $${prevBBPrice?.toFixed(2) || '?'} prev). Normal slow day — no aggression boost.`);
        }
      }
      
      // Find last sale date
      const lastSaleDate = new Date(salesData30d[0].order_date);
      intel.daysWithoutSale = Math.floor((now.getTime() - lastSaleDate.getTime()) / (1000 * 60 * 60 * 24));
      
      // Estimate market daily sales
      const competitorFactor = Math.max(1, intel.competitorCount);
      intel.estimatedMarketDailySales = intel.adsEffective * competitorFactor * 0.5;
      
      if (intel.estimatedMarketDailySales > 0) {
        intel.salesVelocityScore = Math.min(100, Math.round((intel.adsEffective / intel.estimatedMarketDailySales) * 100));
      }
    } else {
      intel.daysWithoutSale = 30;
    }

    // === 2. BUY BOX WIN RATE FROM SNAPSHOTS ===
    const { data: bbHistory } = await supabase
      .from('repricer_competitor_snapshots')
      .select('fetched_at, buybox_seller_id, buybox_price')
      .eq('user_id', userId)
      .eq('asin', asin)
      .eq('marketplace', marketplace)
      .gte('fetched_at', sevenDaysAgo.toISOString())
      .order('fetched_at', { ascending: false })
      .limit(20);

    if (bbHistory && bbHistory.length > 0) {
      const { data: sellerAuth } = await supabase
        .from('seller_authorizations')
        .select('seller_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

      const userSellerId = sellerAuth?.seller_id;
      
      if (userSellerId) {
        const wins = bbHistory.filter((s: any) => s.buybox_seller_id === userSellerId).length;
        intel.buyboxWinRate = Math.round((wins / bbHistory.length) * 100);
        
        let currentStreak = 0;
        let isWinStreak = bbHistory[0]?.buybox_seller_id === userSellerId;
        
        for (const snap of bbHistory) {
          const isWin = snap.buybox_seller_id === userSellerId;
          if (isWin === isWinStreak) {
            currentStreak++;
          } else {
            break;
          }
        }
        
        if (isWinStreak) {
          intel.buyboxWinStreak = currentStreak;
        } else {
          intel.buyboxLossStreak = currentStreak;
        }
      }
    }

    // === 3. COMPETITOR STOCK SIGNALS FROM OFFERS ===
    const offers = (snapshot?.offers_json as any[]) || [];

    intel.fbaCompetitorCount = offers.filter((o: any) => o.is_fba).length;
    intel.amazonSelling = offers.some((o: any) => 
      o.seller_id === 'ATVPDKIKX0DER' || 
      o.seller_name?.toLowerCase().includes('amazon')
    );

    // Prefer explicit SP-API qualifying competitor count when available.
    if (offers.length === 0 && snapshot?._qualifyingFbaCompetitorCount != null) {
      intel.fbaCompetitorCount = Math.max(0, Number(snapshot._qualifyingFbaCompetitorCount) || 0);
      intel.amazonSelling = snapshot._amazonSelling === true;
      console.log(`[gatherIntelligence] SP-API qualifying override: fbaCompetitorCount=${intel.fbaCompetitorCount}, amazonSelling=${intel.amazonSelling}`);
    } else if (offers.length === 0 && snapshot?._fbaOfferCount != null) {
      // Backward compatibility fallback when only raw offer counts are present.
      const spApiFbaCount = snapshot._fbaOfferCount;
      const isSelfFba = snapshot._isBuyboxOwner && snapshot.buybox_is_fba;
      intel.fbaCompetitorCount = Math.max(0, spApiFbaCount - (isSelfFba ? 1 : 0));
      intel.amazonSelling = snapshot._amazonSelling === true;
      console.log(`[gatherIntelligence] SP-API fallback override: fbaCompetitorCount=${intel.fbaCompetitorCount} (raw=${spApiFbaCount}, selfFba=${isSelfFba}), amazonSelling=${intel.amazonSelling}`);
    }
    
    const stockSignals = offers.map((o: any) => {
      const availability = o.availability?.toLowerCase() || '';
      if (availability.includes('out of stock') || availability.includes('1 left') || availability.includes('2 left')) {
        return 'LOW';
      }
      if (availability.includes('in stock') && availability.includes('order soon')) {
        return 'LOW';
      }
      return 'NORMAL';
    });
    
    const lowCount = stockSignals.filter(s => s === 'LOW').length;
    if (lowCount > offers.length * 0.5) {
      intel.competitorStockSignal = 'LOW';
    } else if (offers.length > 10) {
      intel.competitorStockSignal = 'HIGH';
    } else {
      intel.competitorStockSignal = 'NORMAL';
    }

    // === 4. TIME ON MARKET / INVENTORY AGE + YOUR STOCK LEVELS ===
    // Query inventory for stock + age data
    let inventoryQuery = supabase
      .from('inventory')
      .select('created_at, listing_created_at, available, inbound, reserved')
      .eq('user_id', userId)
      .eq('asin', asin);
    
    // If SKU is available, filter by SKU for accuracy
    if (sku) {
      inventoryQuery = inventoryQuery.eq('sku', sku);
    }
    
    const { data: inventoryItem } = await inventoryQuery.maybeSingle();

    if (inventoryItem) {
      const listingDate = new Date(inventoryItem.listing_created_at || inventoryItem.created_at);
      intel.daysSinceFirstListed = Math.floor((now.getTime() - listingDate.getTime()) / (1000 * 60 * 60 * 24));
      intel.inventoryAge = intel.daysSinceFirstListed;
      
      // === YOUR STOCK: Days of Stock calculation ===
      const avail = inventoryItem.available || 0;
      const inb = inventoryItem.inbound || 0;
      const res = inventoryItem.reserved || 0;
      intel.yourUnitsAvailable = avail + inb + res;
      
      // Compute days of stock using effective ADS (weighted 7d/30d)
      const effectiveAds = Math.max(intel.adsEffective, 0.05); // floor to avoid ÷0
      if (intel.yourUnitsAvailable > 0) {
        intel.yourDaysOfStock = Math.round(intel.yourUnitsAvailable / effectiveAds);
      } else {
        intel.yourDaysOfStock = 0;
      }
      
      // === STOCK AGGRESSION MODIFIER ===
      // Use rule thresholds if available, else defaults
      const thCritical = Number(rule?.stock_threshold_critical ?? 7);
      const thLow = Number(rule?.stock_threshold_low ?? 30);
      const thHealthyMax = Number(rule?.stock_threshold_healthy_max ?? 90);
      const thHeavy = Number(rule?.stock_threshold_heavy ?? 180);
      
      const modCritical = Number(rule?.stock_modifier_critical ?? 0.75);
      const modLow = Number(rule?.stock_modifier_low ?? 0.85);
      const modNormal = Number(rule?.stock_modifier_normal ?? 1.0);
      const modHeavy = Number(rule?.stock_modifier_heavy ?? 1.10);
      const modOverstock = Number(rule?.stock_modifier_overstock ?? 1.30);
      
      const dos = intel.yourDaysOfStock;
      if (dos !== null) {
        if (dos < thCritical) {
          intel.stockAggressionModifier = modCritical;
          intel.stockOverlayTag = `stock_critical_${dos}d`;
        } else if (dos < thLow) {
          intel.stockAggressionModifier = modLow;
          intel.stockOverlayTag = `stock_low_${dos}d`;
        } else if (dos <= thHealthyMax) {
          intel.stockAggressionModifier = modNormal;
          intel.stockOverlayTag = null; // healthy = no tag
        } else if (dos <= thHeavy) {
          intel.stockAggressionModifier = modHeavy;
          intel.stockOverlayTag = `stock_heavy_${dos}d`;
        } else {
          intel.stockAggressionModifier = modOverstock;
          intel.stockOverlayTag = `stock_overstock_${dos}d`;
        }
      }
    }

    // === CALCULATE URGENCY SCORE ===
    let urgency = 0;
    urgency += Math.min(40, intel.daysWithoutSale * 2);
    if (intel.salesVelocityScore < 50) {
      urgency += Math.round((50 - intel.salesVelocityScore) * 0.6);
    }
    if (intel.inventoryAge > 60) {
      urgency += Math.min(20, Math.round((intel.inventoryAge - 60) / 3));
    }
    if (intel.buyboxWinRate < 30) {
      urgency += 10;
    }
    intel.urgencyScore = Math.min(100, urgency);

  } catch (error) {
    console.warn('[Intelligence Gathering] Error:', error);
    // Return defaults on error
  }

  return intel;
}

// Enhanced Deterministic Intelligence Engine — replaces LLM-based getAiTuning
// Returns a 0.5–1.5 multiplier based on market signals, $0 cost, <1ms latency
function calculateEnhancedDeterministicTuning(
  context: PricingContext,
  baseResult: PricingResult
): { aggressiveness: number; note: string; factors: string[] } {
  const intel = context.intelligence;
  const factors: string[] = [];
  let multiplier = 1.0;

  // === STABILITY ZONE ===
  // If we own Buy Box AND sales are good AND urgency is low → hold steady
  // EXCEPTION: If today's momentum dropped, don't hold — market may have shifted
  if (context.smartRaise.isBuyboxOwner && intel.salesVelocityScore > 60 && intel.urgencyScore < 30 && intel.buyboxWinRate > 70 && !intel.momentumTriggered) {
    return {
      aggressiveness: 0.85,
      note: 'Stability zone: BB owner + good velocity + low urgency → hold price',
      factors: ['STABILITY_ZONE'],
    };
  }
  if (intel.momentumTriggered && context.smartRaise.isBuyboxOwner) {
    factors.push(`MOMENTUM_DROP(today=${intel.unitsToday}, avg7d=${intel.ads7d.toFixed(2)}, bb=$${intel.anchorPriceNow?.toFixed(2) || '?'}←$${intel.anchorPrice24hAgo?.toFixed(2) || '?'})`);
  }

  // === TIER 1: Sales Momentum (Weight: 0.35) ===
  // CRITICAL: Check higher thresholds FIRST to avoid shadowing
  if (intel.salesVelocityScore > 90) {
    multiplier -= 0.25;
    factors.push(`Dominant velocity (${intel.salesVelocityScore}%) -25%`);
  } else if (intel.salesVelocityScore > 75) {
    multiplier -= 0.15;
    factors.push(`Strong velocity (${intel.salesVelocityScore}%) -15%`);
  } else if (intel.salesVelocityScore < 15) {
    multiplier += 0.35;
    factors.push(`Critical low velocity (${intel.salesVelocityScore}%) +35%`);
  } else if (intel.salesVelocityScore < 30) {
    multiplier += 0.25;
    factors.push(`Low velocity (${intel.salesVelocityScore}%) +25%`);
  } else if (intel.salesVelocityScore < 50) {
    multiplier += 0.10;
    factors.push(`Below-avg velocity (${intel.salesVelocityScore}%) +10%`);
  }

  // === TIER 2: Buy Box Control (Weight: 0.25) ===
  if (intel.buyboxLossStreak >= 5) {
    multiplier += 0.30;
    factors.push(`BB loss streak ${intel.buyboxLossStreak} +30%`);
  } else if (intel.buyboxLossStreak >= 3) {
    multiplier += 0.20;
    factors.push(`BB loss streak ${intel.buyboxLossStreak} +20%`);
  } else if (intel.buyboxWinRate < 20) {
    multiplier += 0.25;
    factors.push(`Low BB win rate (${intel.buyboxWinRate}%) +25%`);
  } else if (intel.buyboxWinRate < 40) {
    multiplier += 0.10;
    factors.push(`Below-avg BB rate (${intel.buyboxWinRate}%) +10%`);
  } else if (intel.buyboxWinRate > 85 && intel.buyboxWinStreak >= 3) {
    multiplier -= 0.20;
    factors.push(`Strong BB control (${intel.buyboxWinRate}%, streak ${intel.buyboxWinStreak}) -20%`);
  } else if (intel.buyboxWinRate > 70) {
    multiplier -= 0.10;
    factors.push(`Good BB rate (${intel.buyboxWinRate}%) -10%`);
  }

  // === TIER 3: Competitive Landscape (Weight: 0.20) ===
  if (intel.amazonSelling) {
    multiplier += 0.15;
    factors.push('Amazon selling +15%');
  }

  if (intel.fbaCompetitorCount > 8) {
    multiplier += 0.15;
    factors.push(`High FBA competition (${intel.fbaCompetitorCount}) +15%`);
  } else if (intel.fbaCompetitorCount <= 1) {
    multiplier -= 0.10;
    factors.push(`Low FBA competition (${intel.fbaCompetitorCount}) -10%`);
  }

  if (intel.competitorStockSignal === 'LOW') {
    multiplier -= 0.20;
    factors.push('Competitor low stock -20%');
  } else if (intel.competitorStockSignal === 'HIGH') {
    multiplier += 0.10;
    factors.push('Competitor high stock +10%');
  }

  // === TIER 4: Urgency & Aging (Weight: 0.20) ===
  // CRITICAL: Check higher thresholds FIRST
  if (intel.urgencyScore > 85) {
    multiplier += 0.30;
    factors.push(`Critical urgency (${intel.urgencyScore}) +30%`);
  } else if (intel.urgencyScore > 60) {
    multiplier += 0.15;
    factors.push(`Medium urgency (${intel.urgencyScore}) +15%`);
  } else if (intel.urgencyScore < 20) {
    multiplier -= 0.05;
    factors.push(`Low urgency (${intel.urgencyScore}) -5%`);
  }

  if (intel.daysWithoutSale > 21) {
    multiplier += 0.20;
    factors.push(`No sale ${intel.daysWithoutSale}d +20%`);
  } else if (intel.daysWithoutSale > 14) {
    multiplier += 0.10;
    factors.push(`No sale ${intel.daysWithoutSale}d +10%`);
  }

  // === TIER 5: Cross-Factor Combos ===
  // "Triple Threat": low sales + low BB + high urgency → max aggression
  if (intel.salesVelocityScore < 30 && intel.buyboxWinRate < 30 && intel.urgencyScore > 70) {
    multiplier += 0.15;
    factors.push('Triple threat combo +15%');
  }
  // "Comfortable Position": good sales + good BB + low urgency → ease off
  // EXCEPTION: Don't ease off if today's momentum dropped
  if (intel.salesVelocityScore > 60 && intel.buyboxWinRate > 60 && intel.urgencyScore < 30 && !intel.momentumTriggered) {
    multiplier -= 0.10;
    factors.push('Comfortable position combo -10%');
  }

  // === TIER 6: Today Momentum Drop ===
  // If today's sales are significantly below the 7d daily average, boost aggression
  // This catches sudden market shifts that 7d/30d averages smooth over
  if (intel.todayMomentumDrop && intel.momentumTriggered) {
    // Scale boost based on how severe the drop is (0 sales today = max boost)
    const dropSeverity = intel.ads7d > 0 ? 1 - (intel.unitsToday / intel.ads7d) : 1;
    const momentumBoost = Math.min(0.25, dropSeverity * 0.25);
    multiplier += momentumBoost;
    factors.push(`TODAY_MOMENTUM_DROP(sold=${intel.unitsToday}, avg=${intel.ads7d.toFixed(2)}, bb_now=$${intel.anchorPriceNow?.toFixed(2) || '?'}, bb_prev=$${intel.anchorPrice24hAgo?.toFixed(2) || '?'}) +${Math.round(momentumBoost * 100)}%`);
  } else if (intel.todayMomentumDrop && !intel.momentumTriggered) {
    factors.push(`MOMENTUM_GUARDRAIL(sold=${intel.unitsToday}, avg=${intel.ads7d.toFixed(2)}, market_stable=true)`);
  }

  // Final clamp
  multiplier = Math.max(0.5, Math.min(1.5, multiplier));
  multiplier = Math.round(multiplier * 100) / 100;

  return {
    aggressiveness: multiplier,
    note: factors.length > 0 ? `Deterministic: ${factors.join(', ')}` : 'Deterministic: no adjustments',
    factors,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: AiEvaluateRequest & { user_id?: string; internal?: boolean; dry_run?: boolean; sp_api_data?: any; stock_gated_maximize?: boolean; restock_reentry?: boolean } = await req.json();
    const { assignmentId, asin, sku, marketplace = 'US', ruleId, currentPrice, testMode = false, user_id, internal, dry_run = false, is_priority = false, sp_api_data, stock_gated_maximize = false, restock_reentry = false } = body;
    const isDryRun = dry_run || testMode;

    // Auth check - support both user JWT and internal service calls
    let userId: string;
    const authHeader = req.headers.get('Authorization');
    
    let isInternalCall = false;
    // Option 1: Internal service call with user_id in body — must present the
    // shared internal secret or a service-role bearer, same as update-amazon-price;
    // otherwise any caller could impersonate a user_id and trigger evaluations
    // (or with dry_run=false, real price pushes) on another account.
    if (internal && user_id && isInternalCaller(req)) {
      console.log(`[repricer-ai-evaluate] Internal service call for user ${user_id}`);
      userId = user_id;
      isInternalCall = true;
    } 
    // Option 2: User JWT auth
    else if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        throw new Error('Unauthorized');
      }
      userId = user.id;
    } else {
      throw new Error('No authorization header');
    }

    // MODULE ACCESS GUARD: AI evaluation triggers engine logic = repricer:run (skip on internal cron path)
    if (!isInternalCall) {
      const access = await checkModuleAccess(supabase, userId, 'repricer', 'run');
      if (!access.allowed) {
        console.warn(`[repricer-ai-evaluate] MODULE BLOCKED user=${userId} reason=${access.reason}`);
        return new Response(
          JSON.stringify({ success: false, error: access.reason }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const _t0 = Date.now();
    console.log(`[repricer-ai-evaluate] User ${userId} evaluating`, { assignmentId, asin, marketplace, testMode });

    // Get assignment if provided
    let assignment: any = null;
    let rule: any = null;
    let targetAsin = asin;
    let targetSku = sku;
    let targetMarketplace = marketplace;
    let targetCurrentPrice = currentPrice;

    if (assignmentId) {
      const { data: assignmentData, error: assignmentError } = await supabase
        .from('repricer_assignments')
        .select('*, repricer_rules!repricer_assignments_rule_id_fkey(*)')
        .eq('id', assignmentId)
        .eq('user_id', userId)
        .maybeSingle();

      if (assignmentError || !assignmentData) {
        throw new Error('Assignment not found');
      }
      
      assignment = assignmentData;
      rule = assignmentData.repricer_rules;
      targetAsin = assignmentData.asin;
      targetSku = assignmentData.sku;
      targetMarketplace = assignmentData.marketplace;
    } else if (ruleId) {
      const { data: ruleData, error: ruleError } = await supabase
        .from('repricer_rules')
        .select('*')
        .eq('id', ruleId)
        .eq('user_id', userId)
        .maybeSingle();

      if (ruleError || !ruleData) {
        throw new Error('Rule not found');
      }
      rule = ruleData;
    }

    if (!targetAsin) {
      throw new Error('ASIN is required');
    }

    if (!rule || rule.strategy !== 'AI_WIN_SALES_BOOSTER') {
      throw new Error('AI Win Sales Booster rule required');
    }

    // Get current price and cost from inventory if not provided
    // CRITICAL: Query by SKU first for multi-SKU per ASIN support (New vs Used conditions)
    let unitCost: number | null = null;
    let estimatedFees: number | null = null;
    let costSource: string = 'none';
    let feesSource: string = 'none';
    let feeCache: { fba_fee_fixed: number | null; referral_rate: number | null } | null = null;
    let inventoryAvailable: number | null = null;
    let inventoryReserved = 0;
    let inventoryInbound = 0;
    let inventoryFnsku: string | null = null;
    let inventorySource: string | null = null;

    // Build inventory query - prefer SKU+ASIN, fall back to ASIN-only
    const buildInventoryQuery = (fields: string) => {
      let query = supabase
        .from('inventory')
        .select(fields)
        .eq('user_id', userId)
        .eq('asin', targetAsin);
      
      // If SKU is available, filter by it for multi-SKU support
      if (targetSku) {
        query = query.eq('sku', targetSku);
      }
      return query.maybeSingle();
    };

    // === MANUAL COST OVERRIDE (date-aware) ===
    // Check user's manual cost override first. If active, it WINS over inventory
    // blended cost and created_listings — but never affects past sale snapshots
    // (those are stored on sales_orders.unit_cost and consumed by P&L only).
    // For repricer, "today" is the relevant date.
    try {
      const { data: overrideUnitCost, error: overrideErr } = await supabase
        .rpc('resolve_cog_for_date', {
          p_user_id: userId,
          p_asin: targetAsin,
          p_on_date: new Date().toISOString().slice(0, 10),
        });
      if (!overrideErr && overrideUnitCost != null && Number(overrideUnitCost) > 0) {
        unitCost = Number(overrideUnitCost);
        costSource = `manual cost override (effective today, asin: ${targetAsin})`;
        console.log(`[repricer-ai-evaluate] MANUAL_COST_OVERRIDE asin=${targetAsin} unitCost=$${unitCost.toFixed(4)}`);
      }
    } catch (e) {
      console.warn(`[repricer-ai-evaluate] resolve_cog_for_date failed for ${targetAsin}:`, (e as Error).message);
    }

    if (targetCurrentPrice === undefined || targetCurrentPrice === null) {
      const { data: inventoryItemRaw, error: invError } = await buildInventoryQuery('price, my_price, cost, fees_json, sku, available, reserved, inbound, fnsku, source');
      const inventoryItem = inventoryItemRaw as any;

      if (invError) {
        console.warn(`[repricer-ai-evaluate] Inventory query error for ${targetAsin}/${targetSku}:`, invError);
      }

      // CRITICAL: For non-US marketplaces, use marketplace-specific price cache
      // The inventory table stores US-only prices — using them contaminates non-US evaluations
      const isUsMarket = !targetMarketplace || targetMarketplace === 'US';
      
      if (isUsMarket) {
        targetCurrentPrice = inventoryItem?.my_price || inventoryItem?.price || null;
      } else {
        // Fetch from marketplace-specific cache
        const mktIdMap: Record<string, string> = {
          'CA': 'A2EUQ1WTGCTBG2', 'MX': 'A1AM78C64UM0Y8', 'BR': 'A2Q3Y263D00KWC',
        };
        const mktId = mktIdMap[targetMarketplace];
        if (mktId && targetSku) {
          const { data: mktPrice } = await supabase
            .from('asin_my_price_cache')
            .select('my_price')
            .eq('user_id', userId)
            .eq('asin', targetAsin)
            .eq('seller_sku', targetSku)
            .eq('marketplace_id', mktId)
            .maybeSingle();
          targetCurrentPrice = mktPrice?.my_price || null;
        }
        if (!targetCurrentPrice) {
          console.warn(`[repricer-ai-evaluate] No marketplace-specific price for ${targetAsin}/${targetSku} in ${targetMarketplace}`);
        }
      }

      // === STALE PRICE OVERRIDE ===
      // When the price cache is stale (e.g., MX$13) but the repricer already applied a higher price
      // (e.g., MX$350 via last_applied_price), use last_applied_price as the baseline.
      // This prevents phantom profit extraction gaps (e.g., $13→$442 when real price is $350).
      if (
        assignment?.last_applied_price != null &&
        assignment.last_applied_price > 0 &&
        targetCurrentPrice != null &&
        targetCurrentPrice > 0 &&
        assignment.last_applied_price > targetCurrentPrice * 1.5 // last_applied is >50% higher than cache
      ) {
        console.log(
          `[STALE_PRICE_OVERRIDE] asin=${targetAsin} marketplace=${targetMarketplace} ` +
          `cache_price=$${targetCurrentPrice.toFixed(2)} last_applied=$${assignment.last_applied_price.toFixed(2)} ` +
          `— using last_applied_price as baseline to prevent phantom gap`
        );
        targetCurrentPrice = assignment.last_applied_price;
      }

      inventoryAvailable = inventoryItem?.available ?? inventoryAvailable;
      inventoryReserved = inventoryItem?.reserved ?? inventoryReserved;
      inventoryInbound = inventoryItem?.inbound ?? inventoryInbound;
      inventoryFnsku = inventoryItem?.fnsku ?? inventoryFnsku;
      inventorySource = inventoryItem?.source ?? inventorySource;

      // Manual override (set above) wins — only fall back to inventory.cost if no override
      if ((!unitCost || unitCost <= 0) && inventoryItem?.cost && inventoryItem.cost > 0) {
        unitCost = inventoryItem.cost;
        costSource = `inventory.cost (sku: ${inventoryItem.sku || targetSku || 'N/A'})`;
      }
      if ((inventoryItem?.fees_json as any)?.totalFees) {
        estimatedFees = (inventoryItem.fees_json as any).totalFees;
        feesSource = 'inventory.fees_json.totalFees';
      }
    } else {
      // Still fetch cost even if price is provided
      const { data: inventoryItemRaw, error: invError } = await buildInventoryQuery('cost, fees_json, sku, available, reserved, inbound, fnsku, source');
      const inventoryItem = inventoryItemRaw as any;

      if (invError) {
        console.warn(`[repricer-ai-evaluate] Inventory query error for ${targetAsin}/${targetSku}:`, invError);
      }

      inventoryAvailable = inventoryItem?.available ?? inventoryAvailable;
      inventoryReserved = inventoryItem?.reserved ?? inventoryReserved;
      inventoryInbound = inventoryItem?.inbound ?? inventoryInbound;
      inventoryFnsku = inventoryItem?.fnsku ?? inventoryFnsku;
      inventorySource = inventoryItem?.source ?? inventorySource;

      // Manual override (set above) wins — only fall back to inventory.cost if no override
      if ((!unitCost || unitCost <= 0) && inventoryItem?.cost && inventoryItem.cost > 0) {
        unitCost = inventoryItem.cost;
        costSource = `inventory.cost (sku: ${inventoryItem.sku || targetSku || 'N/A'})`;
      }
      if ((inventoryItem?.fees_json as any)?.totalFees) {
        estimatedFees = (inventoryItem.fees_json as any).totalFees;
        feesSource = 'inventory.fees_json.totalFees';
      }
    }
    
    const effectiveStockGatedMaximize = stock_gated_maximize || ((inventoryAvailable ?? 0) === 0 && inventoryReserved > 0);
    if (effectiveStockGatedMaximize && !stock_gated_maximize) {
      console.log(`[repricer-ai-evaluate] STOCK-GATED derived from inventory for ${targetAsin}: available=${inventoryAvailable ?? 0}, reserved=${inventoryReserved}`);
    }

    // ── RESTOCK RE-ENTRY: Log if active ──
    if (restock_reentry) {
      console.log(`[repricer-ai-evaluate] RESTOCK RE-ENTRY active for ${targetAsin}/${targetMarketplace} — snap-back pricing will be attempted`);
    }

    // CRITICAL: Query by SKU first since created_listings is keyed by SKU.
    // Contract A: created_listings.cost = TOTAL, amount = UNIT, units = purchase qty.
    // ROI floor MUST use UNIT cost via the shared helper — never the raw `cost`
    // column (which is the TOTAL batch cost and would inflate the floor).
    if (!unitCost || unitCost <= 0) {
      // Build query - prefer SKU match, fall back to ASIN
      let clQuery = supabase
        .from('created_listings')
        .select('cost, amount, units, sku')
        .eq('user_id', userId);
      
      if (targetSku) {
        clQuery = clQuery.eq('sku', targetSku);
      } else {
        clQuery = clQuery.eq('asin', targetAsin);
      }
      
      const { data: createdListing, error: clError } = await clQuery.maybeSingle();
      
      if (clError) {
        console.warn(`[repricer-ai-evaluate] Created listings query error for ${targetAsin}/${targetSku}:`, clError);
      }
      
      const resolvedUnit = createdListing
        ? getListingUnitCost({
            cost: createdListing.cost,
            amount: createdListing.amount,
            units: createdListing.units,
          })
        : null;

      if (resolvedUnit !== null && resolvedUnit > 0) {
        unitCost = resolvedUnit;
        costSource = `created_listings via cost-contract helper (cost=${createdListing?.cost}, amount=${createdListing?.amount}, units=${createdListing?.units}, sku: ${createdListing?.sku})`;
      }
    }
    
    // Get fee cache if we don't have fees from inventory
    if (!estimatedFees) {
      const { data: feeCacheData } = await supabase
        .from('asin_fee_cache')
        .select('fba_fee_fixed, referral_rate')
        .eq('user_id', userId)
        .eq('asin', targetAsin)
        .eq('marketplace', targetMarketplace)
        .maybeSingle();

      feeCache = feeCacheData ?? null;
      if (feeCache && targetCurrentPrice) {
        estimatedFees = (feeCache.fba_fee_fixed || 0) + (targetCurrentPrice * (feeCache.referral_rate || 0.15));
        feesSource = `asin_fee_cache (fba: ${feeCache.fba_fee_fixed}, ref_rate: ${feeCache.referral_rate})`;
      }
    }
    
    const _tContext = Date.now();
    // === DETAILED PROFIT GUARD LOGGING ===
    console.log(`[repricer-ai-evaluate] PROFIT GUARD DATA for ${targetAsin}/${targetSku || 'no-sku'}:`, {
      sku: targetSku,
      marketplace: targetMarketplace,
      unitCost,
      costSource,
      estimatedFees,
      feesSource,
      currentPrice: targetCurrentPrice,
    });

    // === FETCH PRICING DATA FROM SP-API (FREE) ===
    // This replaces the Rainforest-based competitor snapshots for the main repricing loop
    let snapshot: any = null;
    let offers: any[] = [];
    let usedSpApi = false;
    // Raw pricingSource from the last repricer-sp-api-pricing response this
    // cycle, if any call was actually attempted — used below to distinguish
    // "genuinely throttled" from "never even tried" when persisting
    // last_data_source for the Action Log UI.
    let lastPricingSource: string | null = null;

    // Helper: build snapshot and offers from SP-API data object
    const buildFromSpApiData = (spData: any) => {
      // Only count this as "real" SP-API data when the live fetch actually
      // returned something. When repricer-sp-api-pricing hits the rate-limit
      // slot-wait timeout (or another empty-fallback path), it still returns
      // a well-formed object (buyboxPrice: null, offerBreakdown: [], etc.)
      // tagged pricingSource: 'empty' — treating that as "used" silently
      // skipped the cached-snapshot fallback below and produced a fully
      // blank offer set, which forced DO_NOT_REPRICE even when a recent,
      // still-valid competitor snapshot existed.
      lastPricingSource = spData.pricingSource ?? null;
      usedSpApi = spData.pricingSource !== 'empty';

      snapshot = {
        buybox_price: spData.buyboxPrice,
        buybox_seller_id: spData.buyboxSellerId,
        buybox_seller_name: spData.buyboxSellerType === 'Amazon' ? 'Amazon.com' : null,
        buybox_is_fba: spData.buyboxIsFba,
        lowest_fba_price: spData.lowestFbaPrice,
        lowest_fbm_price: spData.lowestFbmPrice,
        lowest_overall_price: spData.lowestOverallPrice,
        offers_count: spData.totalOfferCount,
        fetched_at: spData.fetchedAt,
        source: 'sp-api',
        bb_source: spData.bbSource || 'missing',
        _isBuyboxOwner: spData.isBuyboxOwner,
        _isBuyboxEligible: spData.isBuyboxEligible,
        _amazonSelling: spData.amazonSelling,
        _fbaOfferCount: spData.fbaOfferCount,
        _fbmOfferCount: spData.fbmOfferCount,
        _qualifyingCompetitorCount: spData.qualifyingCompetitorCount,
        _qualifyingFbaCompetitorCount: spData.qualifyingFbaCompetitorCount,
        _offerBreakdown: spData.offerBreakdown || [],
      };
      
      const normalizedOfferBreakdown = Array.isArray(spData.offerBreakdown)
        ? spData.offerBreakdown
            .map((offer: any, index: number) => {
              const totalPrice = Number(offer?.total_price ?? offer?.price);
              const basePrice = Number(offer?.price ?? offer?.total_price);
              if (!Number.isFinite(totalPrice) || !Number.isFinite(basePrice)) return null;

              return {
                seller_id: offer?.seller_id ?? offer?.sellerId ?? `offer_${index}`,
                seller_name: offer?.seller_name ?? offer?.sellerName ?? (offer?.is_buybox_winner ? 'BuyBox Winner' : null),
                is_fba: typeof offer?.is_fba === 'boolean'
                  ? offer.is_fba
                  : (offer?.isFba ?? offer?.fulfillment === 'FBA'),
                is_buybox_winner: Boolean(offer?.is_buybox_winner ?? offer?.isBuyboxWinner),
                total_price: totalPrice,
                price: basePrice,
                shipping: Number.isFinite(Number(offer?.shipping))
                  ? Number(offer.shipping)
                  : Math.max(totalPrice - basePrice, 0),
                is_self: Boolean(offer?.is_self ?? offer?.isSelf),
                seller_rating: offer?.seller_rating ?? offer?.positive_rating ?? offer?.positive_feedback_rating ?? offer?.rating ?? null,
                handling_days: offer?.handling_days ?? offer?.max_handling_time ?? offer?.handling_time ?? null,
                ships_from: offer?.ships_from ?? offer?.ship_from ?? null,
              };
            })
            .filter((offer: any): offer is NonNullable<typeof offer> => offer != null)
        : [];

      if (normalizedOfferBreakdown.length > 0) {
        offers = normalizedOfferBreakdown;
        console.log(`[repricer-ai-evaluate] Using ${offers.length} detailed offers from SP-API offerBreakdown for ${targetAsin}`);
      } else {
        offers = [];

        if (spData.buyboxPrice && spData.buyboxSellerId) {
          const isBuyboxAmazon = spData.buyboxSellerId === 'ATVPDKIKX0DER';
          offers.push({ 
            seller_id: spData.buyboxSellerId, 
            seller_name: isBuyboxAmazon ? 'Amazon.com' : 'BuyBox Winner', 
            is_fba: spData.buyboxIsFba ?? true, 
            is_buybox_winner: true,
            total_price: spData.buyboxPrice,
            price: spData.buyboxPrice,
          });
        }

        if (spData.amazonSelling && spData.buyboxSellerId !== 'ATVPDKIKX0DER') {
          offers.push({ 
            seller_id: 'ATVPDKIKX0DER', 
            seller_name: 'Amazon.com', 
            is_fba: true, 
            is_buybox_winner: false,
            total_price: spData.lowestFbaPrice || spData.buyboxPrice,
            price: spData.lowestFbaPrice || spData.buyboxPrice,
          });
        }

        const fbaPrice = spData.lowestFbaPrice || spData.buyboxPrice;
        const addedFba = (spData.amazonSelling ? 1 : 0) + (spData.buyboxPrice ? 1 : 0);
        for (let i = 0; i < Math.max(0, spData.fbaOfferCount - addedFba); i++) {
          offers.push({ 
            seller_id: `fba_${i}`, 
            is_fba: true, 
            total_price: fbaPrice,
            price: fbaPrice,
          });
        }

        const fbmPrice = spData.lowestFbmPrice || spData.lowestOverallPrice || spData.buyboxPrice;
        for (let i = 0; i < spData.fbmOfferCount; i++) {
          offers.push({ 
            seller_id: `fbm_${i}`, 
            is_fba: false, 
            total_price: fbmPrice,
            price: fbmPrice,
          });
        }

        console.log(`[repricer-ai-evaluate] Built ${offers.length} virtual offers from SP-API (BB: $${spData.buyboxPrice}, FBA: ${spData.fbaOfferCount}, FBM: ${spData.fbmOfferCount})`);
      }
    };

    // The Repricer UI's Low/BB columns (AssignmentsTable.tsx) read from
    // repricer_competitor_snapshots, but this per-assignment live SP-API
    // check -- the same data the pricing decision itself is based on -- was
    // never written there. That table was only ever populated by sales-order
    // capture or a client-side fetch that skips ASINs which already have ANY
    // snapshot, however old, so the UI could show data from a stale check
    // (confirmed live: over 34h old) while the engine was pricing off a
    // check from minutes ago. Persist here so the UI reflects what the
    // engine actually used. Throttled since this evaluation runs every few
    // minutes per assignment and the table has no unique constraint to
    // upsert against (pure time-series, used for historical price charts).
    const SNAPSHOT_WRITE_THROTTLE_MS = 15 * 60 * 1000;
    const persistLiveCompetitorSnapshot = async () => {
      try {
        const hasSignal = snapshot?.buybox_price != null || snapshot?.lowest_fba_price != null || snapshot?.lowest_overall_price != null;
        if (!hasSignal) return;

        const { data: recent } = await supabase
          .from('repricer_competitor_snapshots')
          .select('fetched_at')
          .eq('user_id', userId)
          .eq('asin', targetAsin)
          .eq('marketplace', targetMarketplace)
          .order('fetched_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recent?.fetched_at && Date.now() - new Date(recent.fetched_at).getTime() < SNAPSHOT_WRITE_THROTTLE_MS) return;

        await supabase.from('repricer_competitor_snapshots').insert({
          user_id: userId,
          asin: targetAsin,
          sku: targetSku || null,
          marketplace: targetMarketplace,
          fetched_at: snapshot.fetched_at || new Date().toISOString(),
          buybox_price: snapshot.buybox_price,
          buybox_seller_id: snapshot.buybox_seller_id,
          buybox_seller_name: snapshot.buybox_seller_name,
          buybox_is_fba: snapshot.buybox_is_fba,
          lowest_fba_price: snapshot.lowest_fba_price,
          lowest_fbm_price: snapshot.lowest_fbm_price,
          lowest_overall_price: snapshot.lowest_overall_price,
          offers_count: snapshot.offers_count,
          offers_json: offers,
          source: 'sp-api',
          fetch_reason: 'live_eval',
          credits_used: 0,
        });
      } catch (e) {
        console.warn(`[repricer-ai-evaluate] persistLiveCompetitorSnapshot failed for ${targetAsin}:`, (e as Error).message);
      }
    };

    // OPTIMIZATION: Use pre-fetched SP-API data from scheduler if available
    // This eliminates the redundant SP-API call that was adding ~75s per evaluation
    if (sp_api_data && sp_api_data.buyboxPrice !== undefined) {
      console.log(`[repricer-ai-evaluate] Using PRE-FETCHED SP-API data for ${targetAsin} (saved ~75s)`);
      console.log(`[repricer-ai-evaluate] SP-API pricing for ${targetAsin}:`, sp_api_data);
      buildFromSpApiData(sp_api_data);
      if (usedSpApi) await persistLiveCompetitorSnapshot();
    } else {
      // Fallback: fetch SP-API data directly (for manual runs, tests, or when scheduler didn't pass data)
      try {
        const spApiResponse = await fetch(`${supabaseUrl}/functions/v1/repricer-sp-api-pricing`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            asin: targetAsin,
            sku: targetSku,
            marketplace: targetMarketplace,
            user_id: userId,
            internal: true,
            item_condition: assignment?.item_condition || (rule.condition_scope === 'Used' || (rule.condition_scope === 'Any' && targetSku?.startsWith('amzn.gr.')) ? 'Used' : 'New'),
          }),
        });
        
        const spApiData = await spApiResponse.json();
        
        if (spApiData.success && spApiData.data) {
          console.log(`[repricer-ai-evaluate] SP-API pricing for ${targetAsin}:`, spApiData.data);
          buildFromSpApiData(spApiData.data);
          if (usedSpApi) await persistLiveCompetitorSnapshot();
        } else {
          console.warn(`[repricer-ai-evaluate] SP-API pricing failed for ${targetAsin}:`, spApiData.error);
        }
      } catch (spApiError) {
        console.warn(`[repricer-ai-evaluate] SP-API call failed for ${targetAsin}:`, spApiError);
      }
    }

    // === SP-API LIVE PRICE OVERRIDE ===
    // SP-API returns the ACTUAL price currently on Amazon (myPrice).
    // This is the most authoritative source — more accurate than cache or last_applied.
    // If SP-API myPrice is significantly different from our baseline, use it.
    // This fixes the scenario where:
    //   - cache says $12.55 (stale)
    //   - last_applied says $350 (manual set)
    //   - but actual Amazon price is $434.40 (from a previous repricer raise)
    // Without this, cooldown bypass and competitive logic use wrong baseline.
    const spApiMyPrice = sp_api_data?.myPrice ?? (usedSpApi ? null : null);
    if (spApiMyPrice != null && spApiMyPrice > 0 && targetCurrentPrice != null) {
      const priceDiffPct = Math.abs(spApiMyPrice - targetCurrentPrice) / Math.max(targetCurrentPrice, 0.01);
      if (priceDiffPct > 0.05) { // >5% difference means our baseline is wrong
        console.log(
          `[SP_API_PRICE_OVERRIDE] asin=${targetAsin} marketplace=${targetMarketplace} ` +
          `baseline_was=$${targetCurrentPrice.toFixed(2)} sp_api_myPrice=$${spApiMyPrice.toFixed(2)} ` +
          `diff=${(priceDiffPct * 100).toFixed(1)}% — using SP-API live price as authoritative baseline`
        );
        targetCurrentPrice = spApiMyPrice;
      }
    }
    
    const _tSpApi = Date.now();
    
    // Fallback: Use cached competitor snapshot if SP-API failed (auth error,
    // network error) or returned empty because the rate-limit slot-wait
    // timed out this cycle. Only trust it while reasonably fresh — beyond
    // that, prices/offers may no longer reflect the real market, so we fall
    // through to the normal "no data" handling instead of guessing.
    const SNAPSHOT_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;
    if (!usedSpApi) {
      const { data: rainforestSnapshot } = await supabase
        .from('repricer_competitor_snapshots')
        .select('*')
        .eq('user_id', userId)
        .eq('asin', targetAsin)
        .eq('marketplace', targetMarketplace)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (rainforestSnapshot) {
        const snapshotAgeMs = rainforestSnapshot.fetched_at
          ? Date.now() - new Date(rainforestSnapshot.fetched_at).getTime()
          : Infinity;
        if (snapshotAgeMs <= SNAPSHOT_FALLBACK_MAX_AGE_MS) {
          offers = (rainforestSnapshot.offers_json as any[]) || [];
          // repricer_competitor_snapshots has no bb_source column, so a raw
          // row always reads as bbSource 'missing' downstream — which trips
          // the "no reliable BB data, never lower price" guard even when the
          // stored offers clearly identify a real Buy Box winner. Recover
          // the same confidence a live 'winner_offer' read would have had.
          const hasBuyboxWinnerOffer = offers.some((o: any) => o?.is_buybox_winner === true);
          snapshot = {
            ...rainforestSnapshot,
            bb_source: hasBuyboxWinnerOffer ? 'winner_offer' : (rainforestSnapshot.buybox_price ? 'summary_fallback' : 'missing'),
          };
          console.log(`[repricer-ai-evaluate] Live fetch unavailable (${sp_api_data?.keepaNote || 'no sp_api_data'}) — using cached snapshot from ${snapshot.fetched_at} (${Math.round(snapshotAgeMs / 60000)}m old, bb_source=${snapshot.bb_source})`);
        } else {
          console.log(`[repricer-ai-evaluate] Live fetch unavailable and cached snapshot is ${Math.round(snapshotAgeMs / 60000)}m old (>30m) — treating as no data`);
        }
      }
    }

    // Real per-cycle data-source diagnostic, persisted below alongside
    // last_recommendation_reason so the Action Log UI's fetch-chain panel
    // ("SP-API throttled" / "Market data ready") reflects what actually
    // happened this evaluation instead of a column nothing used to write.
    const dataSourceForDiagnostics: 'sp_api' | 'cache' | 'throttled' | 'none' =
      usedSpApi ? 'sp_api'
      : snapshot ? 'cache'
      : lastPricingSource === 'empty' ? 'throttled'
      : 'none';

    // Get previous Buy Box price for Smart Raise comparison (snapshot-to-snapshot)
    const { data: previousSnapshots } = await supabase
      .from('repricer_competitor_snapshots')
      .select('buybox_price, fetched_at')
      .eq('user_id', userId)
      .eq('asin', targetAsin)
      .eq('marketplace', targetMarketplace)
      .order('fetched_at', { ascending: false })
      .limit(2);
    
    const previousBuyboxPrice = previousSnapshots && previousSnapshots.length > 1 
      ? previousSnapshots[1].buybox_price 
      : null;

    // ── ROLLING WINDOW: Query historical BB prices at 30min, 2hr, 6hr intervals ──
    const now = new Date();
    const rollingIntervals = [
      { key: 'price30min', offsetMs: 30 * 60 * 1000 },
      { key: 'price2hr', offsetMs: 2 * 60 * 60 * 1000 },
      { key: 'price6hr', offsetMs: 6 * 60 * 60 * 1000 },
    ];
    const rollingBuyboxPrices: { price30min: number | null; price2hr: number | null; price6hr: number | null } = {
      price30min: null, price2hr: null, price6hr: null,
    };
    // Same intervals, competitor-floor side — only consumed when
    // requireMarketSupportedRaise is set (MOMENTUM_SMART); harmless/unused
    // read otherwise.
    const rollingLowestFbaPrices: { price30min: number | null; price2hr: number | null; price6hr: number | null } = {
      price30min: null, price2hr: null, price6hr: null,
    };

    // Single query per interval, both series: get the oldest snapshot within each window bracket
    for (const interval of rollingIntervals) {
      const cutoff = new Date(now.getTime() - interval.offsetMs).toISOString();
      const { data: rollingSnap } = await supabase
        .from('repricer_competitor_snapshots')
        .select('buybox_price, lowest_fba_price')
        .eq('user_id', userId)
        .eq('asin', targetAsin)
        .eq('marketplace', targetMarketplace)
        .not('buybox_price', 'is', null)
        .lte('fetched_at', cutoff)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (rollingSnap?.buybox_price) {
        (rollingBuyboxPrices as any)[interval.key] = rollingSnap.buybox_price;
      }
      if (rollingSnap?.lowest_fba_price) {
        (rollingLowestFbaPrices as any)[interval.key] = rollingSnap.lowest_fba_price;
      }
    }
    
    const _tRolling = Date.now();
    console.log(`[Smart Raise] Rolling window prices for ${targetAsin}: prev=$${previousBuyboxPrice?.toFixed(2) || 'null'}, 30m=$${rollingBuyboxPrices.price30min?.toFixed(2) || 'null'}, 2h=$${rollingBuyboxPrices.price2hr?.toFixed(2) || 'null'}, 6h=$${rollingBuyboxPrices.price6hr?.toFixed(2) || 'null'}`);

    // ── ADAPTIVE COOLDOWN: Count competitor downward price moves in last 60 min ──
    // Uses recency weighting: drops in last 10 min count 3x, 10-30 min count 2x, 30-60 min count 1x
    let competitorDropCount = 0;
    const competitorDropBuckets = { recent0_10: 0, recent10_30: 0, recent30_60: 0 };
    {
      const sixtyMinAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const { data: recentSnaps } = await supabase
        .from('repricer_competitor_snapshots')
        .select('lowest_fba_price, fetched_at')
        .eq('user_id', userId)
        .eq('asin', targetAsin)
        .eq('marketplace', targetMarketplace)
        .gte('fetched_at', sixtyMinAgo)
        .not('lowest_fba_price', 'is', null)
        .order('fetched_at', { ascending: true });
      
      if (recentSnaps && recentSnaps.length > 1) {
        const tenMinAgo = now.getTime() - 10 * 60 * 1000;
        const thirtyMinAgo = now.getTime() - 30 * 60 * 1000;
        for (let i = 1; i < recentSnaps.length; i++) {
          const prev = recentSnaps[i - 1].lowest_fba_price!;
          const curr = recentSnaps[i].lowest_fba_price!;
          if (curr < prev - 0.005) {
            const snapTime = new Date(recentSnaps[i].fetched_at).getTime();
            if (snapTime >= tenMinAgo) {
              competitorDropCount += 3;
              competitorDropBuckets.recent0_10++;
            } else if (snapTime >= thirtyMinAgo) {
              competitorDropCount += 2;
              competitorDropBuckets.recent10_30++;
            } else {
              competitorDropCount += 1;
              competitorDropBuckets.recent30_60++;
            }
          }
        }
      }
      console.log(`[ADAPTIVE COOLDOWN] ${targetAsin}: weighted_score=${competitorDropCount} buckets=[0-10m:${competitorDropBuckets.recent0_10}, 10-30m:${competitorDropBuckets.recent10_30}, 30-60m:${competitorDropBuckets.recent30_60}] from ${recentSnaps?.length || 0} snapshots`);
    }

    // ── DROP BUDGET: Query recent downward decisions to enforce safety cap ──
    let recentDownwardMoves = { count: 0, totalDelta: 0 };
    {
      const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
      const { data: recentDecisions } = await supabase
        .from('repricer_ai_decisions')
        .select('price_delta, created_at')
        .eq('user_id', userId)
        .eq('asin', targetAsin)
        .eq('marketplace', targetMarketplace)
        .gte('created_at', fifteenMinAgo)
        .lt('price_delta', 0)
        .order('created_at', { ascending: false })
        .limit(20);
      
      if (recentDecisions && recentDecisions.length > 0) {
        recentDownwardMoves.count = recentDecisions.length;
        recentDownwardMoves.totalDelta = recentDecisions.reduce((sum, d) => sum + Math.abs(d.price_delta || 0), 0);
      }
      if (recentDownwardMoves.count > 0) {
        console.log(`[DROP BUDGET] ${targetAsin}: ${recentDownwardMoves.count} downward moves in 15min, total_drop=$${recentDownwardMoves.totalDelta.toFixed(2)}`);
      }
    }

    // Determine buybox seller type and if we own it
    let buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | null = null;
    let isBuyboxOwner = false;
    
    // Get user's seller ID
    const { data: sellerAuth } = await supabase
      .from('seller_authorizations')
      .select('seller_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    
    if (snapshot?.buybox_seller_id) {
      if (snapshot.buybox_seller_id === 'ATVPDKIKX0DER' || snapshot.buybox_seller_name?.toLowerCase().includes('amazon')) {
        buyboxSellerType = 'Amazon';
      } else if (snapshot.buybox_is_fba) {
        buyboxSellerType = 'FBA';
      } else {
        buyboxSellerType = 'FBM';
      }
      
      // Check if we own the Buy Box
      if (sellerAuth?.seller_id && snapshot.buybox_seller_id === sellerAuth.seller_id) {
        isBuyboxOwner = true;
      }
    }
    
    // Fallback: use SP-API isBuyboxOwner flag when buybox_seller_id is missing (e.g. suppressed BB)
    if (!isBuyboxOwner && snapshot?._isBuyboxOwner === true) {
      isBuyboxOwner = true;
      console.log(`[BB Detection] Using SP-API _isBuyboxOwner fallback for ${targetAsin}`);
    }
    
    // === STALE BB OWNER SANITY CHECK ===
    // If snapshot says we own BB but our current price is significantly above the BB price,
    // the snapshot is stale — we cannot be winning the Buy Box at a much higher price.
    // EXCEPTION: If the snapshot's buybox_seller_id DIRECTLY matches our seller_id,
    // this is a FRESH confirmation from SP-API — trust it over price heuristics.
    // The user may genuinely own the BB at a different price (e.g., Amazon price changed
    // via auto-floor or manual Seller Central edit while system still shows old price).
    const currentPriceForCheck = targetCurrentPrice || assignment?.last_applied_price;
    const directSellerIdMatch = Boolean(
      sellerAuth?.seller_id && snapshot?.buybox_seller_id && 
      snapshot.buybox_seller_id === sellerAuth.seller_id
    );
    
    if (directSellerIdMatch) {
      console.log(`[BB Detection] DIRECT SELLER_ID MATCH confirmed — trusting snapshot BB ownership for ${targetAsin}, skipping stale overrides`);
    }
    
    if (!directSellerIdMatch && isBuyboxOwner && currentPriceForCheck && snapshot?.buybox_price) {
      const priceTolerance = snapshot.buybox_price * 1.05;
      if (currentPriceForCheck > priceTolerance) {
        console.log(`[BB Detection] STALE OVERRIDE (price>BB): isBuyboxOwner=true but currentPrice $${currentPriceForCheck.toFixed(2)} >> BB $${snapshot.buybox_price.toFixed(2)} — overriding to false`);
        isBuyboxOwner = false;
      }
    }
    // Check 2: If a cheaper FBA competitor exists and our price is significantly above them, 
    // we cannot realistically own the Buy Box — SKIP if direct seller_id match confirms ownership
    const lowestFbaForCheck = snapshot?.lowest_fba_price;
    if (!directSellerIdMatch && isBuyboxOwner && currentPriceForCheck && lowestFbaForCheck && lowestFbaForCheck > 0) {
      if (currentPriceForCheck > lowestFbaForCheck * 1.10) {
        console.log(`[BB Detection] STALE OVERRIDE (price>FBA): isBuyboxOwner=true but currentPrice $${currentPriceForCheck.toFixed(2)} >> lowest FBA $${lowestFbaForCheck.toFixed(2)} — overriding to false`);
        isBuyboxOwner = false;
      }
    }
    // Check 3: If the assignment explicitly records losing BB status, honor it — SKIP if direct match
    if (!directSellerIdMatch && isBuyboxOwner && assignment?.last_buybox_status === 'losing') {
      console.log(`[BB Detection] STALE OVERRIDE (assignment status): isBuyboxOwner=true but assignment.last_buybox_status=losing — overriding to false`);
      isBuyboxOwner = false;
    }

    const virtualBbLossForReservedOnly = effectiveStockGatedMaximize && (inventoryAvailable ?? 0) === 0 && inventoryReserved > 0;
    if (virtualBbLossForReservedOnly && isBuyboxOwner) {
      console.log(`[BB Detection] RESERVED-STOCK OVERRIDE: available=0, reserved=${inventoryReserved} — treating Buy Box ownership as inactive for pricing holds on ${targetAsin}`);
      isBuyboxOwner = false;
    }
    
    // Get global settings for absolute floor + momentum settings
    const { data: settings } = await supabase
      .from('repricer_settings')
      .select('absolute_min_price_floor, momentum_check_enabled, momentum_threshold_pct')
      .eq('user_id', userId)
      .maybeSingle();
    
    const globalAbsoluteFloor = settings?.absolute_min_price_floor || 0.99;
    
    // Pass momentum settings through rule object for intelligence gathering
    if (rule) {
      (rule as any)._momentumCheckEnabled = settings?.momentum_check_enabled ?? true;
      (rule as any)._momentumThresholdPct = settings?.momentum_threshold_pct ?? 50;
    }
    
    // === HOME-CURRENCY-AWARE FX CONVERSION ===
    // Cost is stored in seller's home currency (defaults to USD for existing users)
    // For marketplace pricing, convert to local marketplace currency
    const marketplaceCurrency = MARKETPLACE_CURRENCIES[targetMarketplace] || 'USD';
    const isNonUs = targetMarketplace !== 'US';
    let fxRate = 1;
    let localCost = unitCost;
    
    // Fetch seller's home currency once per evaluation
    const homeCurrency = await getSellerHomeCurrency(supabase, userId);
    
    if (unitCost && unitCost > 0 && homeCurrency !== marketplaceCurrency) {
      const fxResult = await convertCurrency(unitCost, homeCurrency, marketplaceCurrency, supabase);
      fxRate = fxResult.fxRate;
      localCost = fxResult.converted;
      console.log(`[repricer-ai-evaluate] FX CONVERSION for ${targetAsin}: ${homeCurrency} ${unitCost.toFixed(2)} → ${marketplaceCurrency} ${localCost.toFixed(2)} (rate: ${fxRate.toFixed(4)})`);
    }

    // === CALCULATE PROFIT FLOOR WITH DYNAMIC ROI ===
    // CRITICAL: Use localCost (converted to marketplace currency) for profit guard calculations
    // This matches the logic in calculate-roi and calculate-roi-range edge functions
    // Min ROI Protection overrides profit guard: if min_roi_enabled, force profit guard ON
    // Profit Guard permanently disabled (manual-min-only policy).
    // ROI is still computed below for DISPLAY ONLY and written to
    // trace.roi_at_price_display_only. Nothing downstream may act on it.
    const enableProfitGuard = false;
    const minProfitDollars = rule.min_profit_dollars || null;
    const includeFeesInFloor = rule.include_fees_in_floor ?? true;
    
    // Dynamic ROI: Use high-risk ROI when seller count exceeds threshold
    const enableDynamicRoi = rule.enable_dynamic_roi ?? true;
    const minRoiPercentBase = rule.min_roi_percent_base ?? rule.min_roi_percent ?? 20;
    const minRoiPercentHighRisk = rule.min_roi_percent_high_risk ?? 35;
    const highRiskThreshold = rule.high_risk_seller_count_threshold ?? 8;
    
    // Determine effective ROI based on competition level
    // Priority: assignment override > min_roi_enabled marketplace override > dynamic ROI > base ROI
    const sellerCount = snapshot?.offers_count || offers.length || 0;
    const isHighRisk = enableDynamicRoi && sellerCount >= highRiskThreshold;
    const assignmentRoiOverride = assignment?.min_roi_override;
    
    // Min ROI Protection: marketplace-specific ROI override from rule.
    // "Respect minimum ROI" is now toggled per marketplace — falls back to
    // the legacy global min_roi_enabled for marketplaces without their own override.
    const minRoiEnabled = resolveMinRoiEnabled(rule, targetMarketplace);
    const minRoiMarketplaceOverrides = rule.min_roi_marketplace_overrides || {};
    const marketplaceRoiOverride = minRoiEnabled
      ? (minRoiMarketplaceOverrides[targetMarketplace] ?? rule.min_roi_percent ?? null)
      : null;
    
    const effectiveMinRoiPercent = assignmentRoiOverride != null
      ? assignmentRoiOverride
      : marketplaceRoiOverride != null
        ? marketplaceRoiOverride
        : (isHighRisk ? minRoiPercentHighRisk : minRoiPercentBase);
    
    // Log rule settings for debugging
    console.log(`[repricer-ai-evaluate] RULE SETTINGS for ${targetAsin}/${targetSku || 'no-sku'}:`, {
      ruleId: rule.id,
      ruleName: rule.name,
      enableProfitGuard,
      minProfitDollars,
      minRoiPercentBase,
      minRoiPercentHighRisk,
      effectiveMinRoiPercent,
      assignmentRoiOverride: assignmentRoiOverride ?? null,
      sellerCount,
      isHighRisk,
      enableDynamicRoi,
      includeFeesInFloor,
      blockAutoApplyIfCostMissing: rule.block_auto_apply_if_cost_missing ?? true,
      enableAutoExitReenter: rule.enable_auto_exit_reenter ?? true,
      marketplace: targetMarketplace,
      fxRate,
      localCost: localCost?.toFixed(2),
    });
    
    let profitFloorRefRate = 0.15;
    let profitFloorFbaFee = 0;
    let profitFloorPrice: number | null = null;
    let floorBreakdown: { absolute: number; profit: number | null; roi: number | null; triggered_by: string } = {
      absolute: globalAbsoluteFloor,
      profit: null,
      roi: null,
      triggered_by: 'none',
    };
    
    // Use localCost (converted to marketplace currency) for all profit guard calculations
    // This ensures the floor is calculated in the same currency as the selling price
    let estRoiAtFloor: number = 0;
    if (enableProfitGuard && localCost && localCost > 0) {
      // CORRECT FORMULA: Referral fee is a PERCENTAGE of the floor price, not a flat amount.
      // We must solve algebraically: Price = (Cost*(1+ROI/100) + fixedFees) / (1-referralRate)
      // This ensures forward (ROI→Price) and reverse (Price→ROI) calculations converge.
      const cachedRefRate = feeCache?.referral_rate && feeCache.referral_rate > 0 ? feeCache.referral_rate : 0.15;
      const cachedFbaFee = feeCache?.fba_fee_fixed || 0;
      profitFloorRefRate = cachedRefRate;
      profitFloorFbaFee = cachedFbaFee;
      // For flat fees (FBA, variable closing, etc.) we use the flat estimatedFees minus the referral portion
      // If we have feeCache, use its components. Otherwise fall back to estimatedFees as flat.
      const fixedFeesForFloor = includeFeesInFloor ? cachedFbaFee : 0;
      const refRateForFloor = includeFeesInFloor ? cachedRefRate : 0;
      // Legacy flat fee path for profit dollar floor (where referral % matters less)
      let feesToInclude = includeFeesInFloor ? (estimatedFees || 0) : 0;
      
      // Convert min_profit_dollars to local currency if non-US
      let localMinProfitDollars = minProfitDollars;
      if (isNonUs && minProfitDollars && minProfitDollars > 0) {
        localMinProfitDollars = minProfitDollars * fxRate;
      }
      
      // Calculate floor from min_profit_dollars (now in local currency)
      let profitDollarFloor: number | null = null;
      if (localMinProfitDollars && localMinProfitDollars > 0) {
        // For dollar floors, also use algebraic solve: Price = (Cost + fixedFees + minProfit) / (1 - refRate)
        profitDollarFloor = (localCost + fixedFeesForFloor + localMinProfitDollars) / (1 - refRateForFloor);
        profitDollarFloor = Math.ceil(profitDollarFloor * 100) / 100;
        floorBreakdown.profit = profitDollarFloor;
      }
      
      // Calculate floor from effective ROI (dynamic based on seller count)
      // CORRECT: Price = (Cost × (1 + ROI/100) + fixedFees) / (1 - referralRate)
      // Then Math.ceil to ensure ROI is always MET, never under.
      let roiFloor: number | null = null;
      if (effectiveMinRoiPercent !== null) {
        // Support negative ROI (liquidation mode)
        roiFloor = (localCost * (1 + effectiveMinRoiPercent / 100) + fixedFeesForFloor) / (1 - refRateForFloor);
        roiFloor = Math.ceil(roiFloor * 100) / 100;
        floorBreakdown.roi = roiFloor;
      }
      
      // Use the highest of all floors
      const floors = [globalAbsoluteFloor];
      if (profitDollarFloor) floors.push(profitDollarFloor);
      if (roiFloor) floors.push(roiFloor);
      
      profitFloorPrice = Math.max(...floors);
      
      // Determine which floor was triggered
      if (profitFloorPrice === roiFloor) {
        floorBreakdown.triggered_by = isHighRisk ? 'roi_high_risk' : 'roi_base';
      } else if (profitFloorPrice === profitDollarFloor) {
        floorBreakdown.triggered_by = 'profit_dollars';
      } else {
        floorBreakdown.triggered_by = 'absolute';
      }
      
      // Calculate the estimated fees AT the floor price for transparency
      const estReferralAtFloor = profitFloorPrice ? profitFloorPrice * refRateForFloor : 0;
      const estTotalFeesAtFloor = estReferralAtFloor + fixedFeesForFloor;
      const estProfitAtFloor = profitFloorPrice ? profitFloorPrice - estTotalFeesAtFloor - localCost : 0;
      estRoiAtFloor = localCost > 0 && profitFloorPrice ? (estProfitAtFloor / localCost) * 100 : 0;
      
      console.log(`[repricer-ai-evaluate] PROFIT FLOOR CALCULATION for ${targetAsin}/${targetSku || 'no-sku'}:`, {
        profitFloorPrice: profitFloorPrice?.toFixed(2),
        usdCost: unitCost?.toFixed(2),
        localCost: localCost?.toFixed(2),
        marketplace: targetMarketplace,
        fxRate,
        costSource,
        feesToInclude: feesToInclude.toFixed(2),
        feesSource,
        globalAbsoluteFloor,
        floorBreakdown,
      });
      
      // Detailed ROI floor breakdown for debugging transparency
      console.log(`[ROI_FLOOR_BREAKDOWN] ${targetAsin}: Cost: $${localCost.toFixed(2)} | Referral rate: ${(refRateForFloor * 100).toFixed(1)}% | FBA fee: $${fixedFeesForFloor.toFixed(2)} | Min ROI: ${effectiveMinRoiPercent ?? 'n/a'}% | ROI floor: $${profitFloorPrice?.toFixed(2) ?? 'n/a'} | Est. fees at floor: $${estTotalFeesAtFloor.toFixed(2)} (ref $${estReferralAtFloor.toFixed(2)} + FBA $${fixedFeesForFloor.toFixed(2)}) | Est. profit at floor: $${estProfitAtFloor.toFixed(2)} | Est. ROI at floor: ${estRoiAtFloor.toFixed(1)}% | Formula: Price = (Cost×(1+ROI/100) + fixedFees) / (1-refRate) [post-fee ROI, not simple markup]`);
    } else if (!enableProfitGuard) {
      console.log(`[repricer-ai-evaluate] PROFIT GUARD DISABLED for ${targetAsin}/${targetSku || 'no-sku'}`);
    } else {
      console.warn(`[repricer-ai-evaluate] NO PROFIT FLOOR for ${targetAsin}/${targetSku || 'no-sku'}: unit cost missing or zero (${unitCost}). Cost source: ${costSource}`);
    }

    // === MANUAL-MIN-ONLY POLICY ===
    // The user's manual min_price_override is the sole floor.
    // ROI floor NEVER inflates min/max at runtime. Display-only ROI is
    // computed via _shared/roi-display.ts and written to the trace,
    // never fed back into pricing decisions.
    const storedMinPrice = assignment?.min_price_override ?? rule.min_price ?? null;
    const runtimeMinOverride = storedMinPrice;
    const maxPriceAutoRaised = false;
    const originalMaxPrice = assignment?.max_price_override ?? null;
    const runtimeMaxOverride: number | null = null;

    // === GATHER INTELLIGENCE ===
    const intelligence = await gatherIntelligence(
      supabase,
      userId,
      targetAsin,
      targetSku,
      targetMarketplace,
      snapshot,
      rule
    );

    const _tIntel = Date.now();

    // === BB LOSS RECOVERY MODE: Inject duration-based context into intelligence ===
    const bbLostAtForRecovery = assignment?.buybox_lost_at ? new Date(assignment.buybox_lost_at).getTime() : null;
    const bbLossDurationMinutes = bbLostAtForRecovery ? (Date.now() - bbLostAtForRecovery) / 60000 : 0;
    const bbRecoveryEscalation = assignment?.bb_recovery_escalation ?? 0;
    // Only inject if actually losing BB (not owner)
    if (!isBuyboxOwner && bbLossDurationMinutes > 0) {
      (intelligence as any).bbLossDurationMinutes = bbLossDurationMinutes;
      (intelligence as any).bbRecoveryEscalation = bbRecoveryEscalation;
      console.log(`[BB_RECOVERY_MODE] asin=${targetAsin} duration=${Math.round(bbLossDurationMinutes)}m escalation=${bbRecoveryEscalation} lossStreak=${intelligence.buyboxLossStreak}`);
    }

    console.log(`[repricer-ai-evaluate] Intelligence for ${targetAsin}:`, intelligence);

    // === APPLY SMART PROFILE PRESETS ===
    // If rule has a smart_profile that isn't CUSTOM, override rule fields with preset values.
    // undercut_amount is the sole source of truth for undercutting behavior —
    // the profile only serves as a template when a rule is first created/
    // copied (in the frontend); it must NEVER re-override a value the user
    // has since customized. It is therefore always excluded from the preset
    // override below, regardless of what the rule's current value is.
    const smartProfile = rule.smart_profile || 'CUSTOM';
    // Canonical profile key → UI label mapping, preset definitions, and the
    // user-controlled-fields set all live in ./_presets.ts (imported above)
    // — the single source of truth, snapshot-tested to prevent drift.
    if (smartProfile !== 'CUSTOM') {
      const preset = PROFILE_PRESETS[smartProfile];
      if (preset) {
        // Override rule fields with preset values, BUT preserve user-controlled
        // settings. undercut_amount is ALWAYS user-controlled now — the preset
        // is only a template at rule creation, never a runtime override.
        for (const [key, value] of Object.entries(preset)) {
          if (!USER_CONTROLLED_FIELDS.has(key)) {
            (rule as any)[key] = value;
          }
        }
        // ── Resolved Profile Audit (Phase 1) ──
        // Family classification: derived from preset shape, not preset name.
        // - aggressive: undercuts >$0.01 OR no BB-owner hold (chases price down)
        // - match_only: undercut_amount === 0 (matches competitor exactly)
        // - conservative: small undercut + holds when BB owner + raise gated to BB owner
        // - liquidation: profit guard disabled (clear stock at any margin)
        const fam_aggressive = (Number(rule.undercut_amount) > 0.01) || rule.skip_lower_when_bb_owner === false;
        const fam_match_only = Number(rule.undercut_amount) === 0;
        const fam_conservative = Number(rule.undercut_amount) > 0 && Number(rule.undercut_amount) <= 0.01
          && rule.skip_lower_when_bb_owner === true
          && rule.only_raise_when_buybox_owner === true;
        const fam_liquidation = rule.enable_profit_guard === false;
        // FBM treatment family flag — explicit visibility for FBM-vs-FBA branch
        const fbm_chase_blocked = rule.ignore_fbm_unless_buybox_owner === true;

        // Runtime truth log — shows exact config applied by the engine (all 13 params + family flags)
        console.log(`[resolved_profile_audit] profile=${smartProfile} label="${PROFILE_KEY_TO_LABEL[smartProfile] ?? smartProfile}" | ` +
          `undercut_amount=${rule.undercut_amount} | ` +
          `enable_smart_raise=${rule.enable_smart_raise} | ` +
          `raise_trigger_percent=${rule.raise_trigger_percent} | ` +
          `max_raise_step_dollars=${rule.max_raise_step_dollars} | ` +
          `max_raise_step_percent=${rule.max_raise_step_percent} | ` +
          `enable_monopoly_mode=${rule.enable_monopoly_mode} | ` +
          `monopoly_mode_type=${rule.monopoly_mode_type} | ` +
          `monopoly_cooldown_minutes=${rule.monopoly_cooldown_minutes} | ` +
          `cooldown_minutes=${rule.cooldown_minutes} | ` +
          `skip_lower_when_bb_owner=${rule.skip_lower_when_bb_owner} | ` +
          `stock_overlay_enabled=${rule.stock_overlay_enabled} | ` +
          `only_raise_when_buybox_owner=${rule.only_raise_when_buybox_owner} | ` +
          `ignore_fbm_unless_buybox_owner=${rule.ignore_fbm_unless_buybox_owner} | ` +
          `use_ai_tuning=${rule.use_ai_tuning} | ` +
          `enable_profit_guard=${rule.enable_profit_guard ?? 'default'} | ` +
          `family=[aggressive=${fam_aggressive}, match_only=${fam_match_only}, conservative=${fam_conservative}, liquidation=${fam_liquidation}, fbm_chase_blocked=${fbm_chase_blocked}]`
        );

        // Keep legacy log line for any dashboards still parsing it
        console.log(`[profile_config_applied] profile=${smartProfile} | undercut_amount=${rule.undercut_amount} | enable_smart_raise=${rule.enable_smart_raise} | raise_trigger_percent=${rule.raise_trigger_percent} | max_raise_step_dollars=${rule.max_raise_step_dollars} | max_raise_step_percent=${rule.max_raise_step_percent} | enable_monopoly_mode=${rule.enable_monopoly_mode} | monopoly_mode_type=${rule.monopoly_mode_type} | monopoly_cooldown_minutes=${rule.monopoly_cooldown_minutes} | cooldown_minutes=${rule.cooldown_minutes} | skip_lower_when_bb_owner=${rule.skip_lower_when_bb_owner} | stock_overlay_enabled=${rule.stock_overlay_enabled} | only_raise_when_buybox_owner=${rule.only_raise_when_buybox_owner} | ignore_fbm_unless_buybox_owner=${rule.ignore_fbm_unless_buybox_owner}`);
      }
    }

    // Property-based: any rule with min ROI disabled should not hold BB owner position
    // This applies to "No minimum Floor" and ANY custom rule with the same settings
    if (!minRoiEnabled && rule.skip_lower_when_bb_owner) {
      console.log(`[NO_FLOOR_RULE] Disabling BB owner hold for rule "${rule.name}" (min_roi_enabled=false) — applies to all no-floor rules`);
      rule.skip_lower_when_bb_owner = false;
    }

    // ── PHASE 2 BRIDGE: Apply learning-based temporary rule overrides ──
    // Reads approved tuning recommendations and applies SAFE bounded overrides
    // ALLOWED: aggression, cooldown, undercut_amount, recapture_sensitivity
    // FORBIDDEN: cost, min_price, roi_floor, safety guardrails
    const LEARNING_ALLOWED_KEYS = new Set(['aggression', 'cooldown_minutes', 'undercut_amount', 'recapture_sensitivity']);
    const LEARNING_BOUNDS: Record<string, { min: number; max: number }> = {
      aggression: { min: 0.5, max: 1.5 },
      cooldown_minutes: { min: 3, max: 60 },
      undercut_amount: { min: 0, max: 0.05 },
      recapture_sensitivity: { min: 0.5, max: 2.0 },
    };
    try {
      const { data: activeOverrides } = await supabase
        .from('smart_engine_tuning_recommendations')
        .select('parameter_key, suggested_value, confidence_score')
        .eq('user_id', userId)
        .eq('status', 'approved')
        .gt('confidence_score', 50);
      
      if (activeOverrides && activeOverrides.length > 0) {
        for (const override of activeOverrides) {
          if (!LEARNING_ALLOWED_KEYS.has(override.parameter_key)) continue;
          const bounds = LEARNING_BOUNDS[override.parameter_key];
          if (!bounds) continue;
          const val = parseFloat(override.suggested_value || '');
          if (isNaN(val)) continue;
          const clamped = Math.max(bounds.min, Math.min(bounds.max, val));
          
          if (override.parameter_key === 'cooldown_minutes') {
            (rule as any).cooldown_minutes = clamped;
          } else if (override.parameter_key === 'undercut_amount') {
            // Never override a rule deliberately set to match-exactly (0) —
            // undercut_amount is the sole source of truth for that behavior,
            // and this learning override has no per-rule scoping otherwise.
            if (Number(rule.undercut_amount) === 0) {
              console.log(`[LEARNING_OVERRIDE] ${targetAsin}: skipping undercut_amount override — rule "${rule.name}" is match-exactly (0)`);
              continue;
            }
            (rule as any).undercut_amount = clamped;
          }
          // aggression and recapture_sensitivity are applied via intelligence multiplier below
          console.log(`[LEARNING_OVERRIDE] ${targetAsin}: ${override.parameter_key}=${clamped} (confidence=${override.confidence_score})`);
        }
      }
    } catch (e) {
      // Non-critical — don't block evaluation if learning lookup fails
      console.warn(`[LEARNING_OVERRIDE] Lookup failed for ${targetAsin}:`, e);
    }

    // Final match-exactly derivation — undercut_amount is the sole source of
    // truth, computed here from the FULLY resolved value (after profile
    // presets AND learning overrides), not the rule's original pre-preset
    // value. This matters for rules whose own stored undercut_amount was
    // nonzero but whose profile preset resolves to 0 (e.g. Momentum
    // Builder's undercut_amount=0.00) — they now correctly get the full
    // match-exactly treatment (guards, disabled AI tuning), not just a
    // zeroed number with none of the surrounding protections.
    const matchExactly = Number(rule.undercut_amount ?? NaN) === 0;
    if (matchExactly && rule.use_ai_tuning !== false) {
      rule.use_ai_tuning = false;
      console.log(`[MATCH_EXACTLY] ${targetAsin}: final undercut_amount=0 (profile=${smartProfile}) — disabling AI tuning`);
    }

    const effectiveFbmCompetitionMode: 'fba_priority' | 'all_sellers' | 'lowest_seller' =
      (rule as any).fbm_competition_mode === 'lowest_seller' ? 'lowest_seller'
      : (rule as any).fbm_competition_mode === 'all_sellers' ? 'all_sellers'
      : (rule as any).fbm_competition_mode === 'fba_priority' ? 'fba_priority'
      : ((rule as any).ignore_fbm_unless_buybox_owner === false ? 'all_sellers' : 'fba_priority');
    console.log(`[FBM_MODE_RESOLVED] asin=${targetAsin} effective_fbm_competition_mode=${effectiveFbmCompetitionMode} stored=${(rule as any).fbm_competition_mode ?? 'null'} legacy_ignore=${rule.ignore_fbm_unless_buybox_owner} fbm_undercut=${(rule as any).fbm_undercut_amount ?? 'null'} match_exactly=${matchExactly}`);

    // ── GROUND TRUTH FULFILLMENT TYPE ──
    // assignment.fulfillment_type can be stale (channel reclassified, hybrid listings,
    // or wrong at onboarding) — it's written once at assignment creation and never
    // refreshed afterward. Resolve it in three tiers, most trustworthy first:
    //   1. Live SP-API snapshot: find OUR offer (is_self / matching seller_id) and
    //      read its actual is_fba flag.
    //   2. Inventory hard evidence (FNSKU / FBA reserved+inbound qty / sync source)
    //      — the same evidence-based classifier AssignmentsTable.tsx uses for
    //      display. Used when tier 1 can't find our own offer in this cycle's
    //      snapshot (e.g. a stale fallback snapshot from a non-SP-API source that
    //      never tags any offer as "self").
    //   3. The stored assignment.fulfillment_type column, only as a last resort.
    let liveOwnFulfillment: 'FBA' | 'FBM' | null = null;
    try {
      const _ownSellerId = sellerAuth?.seller_id;
      const _allOffersForFulfillment = (snapshot?._offerBreakdown || offers || []) as any[];
      const _myLiveOffer = _allOffersForFulfillment.find((o: any) =>
        o.is_self === true || (_ownSellerId && o.seller_id === _ownSellerId)
      );
      if (_myLiveOffer) {
        if (_myLiveOffer.is_fba === true) liveOwnFulfillment = 'FBA';
        else if (_myLiveOffer.is_fba === false) liveOwnFulfillment = 'FBM';
        else if (typeof _myLiveOffer.fulfillment === 'string') {
          const f = String(_myLiveOffer.fulfillment).toUpperCase();
          if (f === 'FBA' || f === 'AFN') liveOwnFulfillment = 'FBA';
          else if (f === 'FBM' || f === 'MFN') liveOwnFulfillment = 'FBM';
        }
      }
    } catch (e) {
      console.warn(`[FULFILLMENT_GROUND_TRUTH] live derivation failed for ${targetAsin}:`, e);
    }

    // Tier 2: same hard-evidence rules as AssignmentsTable.tsx's fulfillment_type
    // classifier (FNSKU presence / FBA reserved+inbound qty / sync source), kept
    // in sync intentionally — this is the fallback for when tier 1 has no data.
    let evidenceOwnFulfillment: 'FBA' | 'FBM' | null = null;
    try {
      const src = (inventorySource || '').toLowerCase();
      const hasFnsku = !!(inventoryFnsku && String(inventoryFnsku).trim().length > 0);
      const reservedOrInbound = (Number(inventoryReserved) || 0) + (Number(inventoryInbound) || 0);
      const srcSaysFba = src === 'amazon_sync' || (src.includes('fba') && !src.includes('fbm'));
      const srcSaysFbm = src === 'amazon_sync_fbm' || (src.includes('fbm') && !src.includes('fba'));
      const hardFba = hasFnsku || reservedOrInbound > 0 || srcSaysFba;
      const hardFbm = srcSaysFbm && !hasFnsku && reservedOrInbound === 0;
      if (hardFba) evidenceOwnFulfillment = 'FBA';
      else if (hardFbm) evidenceOwnFulfillment = 'FBM';
    } catch (e) {
      console.warn(`[FULFILLMENT_GROUND_TRUTH] evidence derivation failed for ${targetAsin}:`, e);
    }

    const assignmentFulfillment = (assignment?.fulfillment_type as 'FBA' | 'FBM' | undefined) ?? null;
    const effectiveOwnFulfillment: 'FBA' | 'FBM' | null =
      liveOwnFulfillment ?? evidenceOwnFulfillment ?? assignmentFulfillment;
    const groundTruthSource = liveOwnFulfillment ? 'live_sp_api' : evidenceOwnFulfillment ? 'inventory_evidence' : 'stored_assignment';

    // Self-heal: whenever a trustworthy tier (live or evidence) disagrees with the
    // stored column, persist the correction so it stops drifting stale forever —
    // previously this only logged a warning and re-derived the same fix every cycle.
    if (
      effectiveOwnFulfillment &&
      groundTruthSource !== 'stored_assignment' &&
      assignmentFulfillment &&
      effectiveOwnFulfillment !== assignmentFulfillment &&
      assignment?.id
    ) {
      console.warn(`[FULFILLMENT_GROUND_TRUTH] asin=${targetAsin} assignment=${assignmentFulfillment} but ${groundTruthSource}=${effectiveOwnFulfillment} — correcting stored value`);
      try {
        await supabase
          .from('repricer_assignments')
          .update({ fulfillment_type: effectiveOwnFulfillment })
          .eq('id', assignment.id);
        assignment.fulfillment_type = effectiveOwnFulfillment;
      } catch (e) {
        console.warn(`[FULFILLMENT_GROUND_TRUTH] failed to persist correction for ${targetAsin}:`, e);
      }
    }

    // Build pricing context
    const context: PricingContext = {
      asin: targetAsin,
      currentPrice: targetCurrentPrice ?? null,
      buyboxPrice: snapshot?.buybox_price || null,
      buyboxSellerType,
      isBuyboxOwner,
      lowestFbaPrice: snapshot?.lowest_fba_price || null,
      lowestFbmPrice: snapshot?.lowest_fbm_price || null,
      lowestOverallPrice: snapshot?.lowest_overall_price || null,
      qualifyingFbaCompetitorCount: snapshot?._qualifyingFbaCompetitorCount ?? null,
      fbmOfferCount: snapshot?._fbmOfferCount ?? null,
      offersCount: snapshot?.offers_count || offers.length || 0,
      isOnlySeller: (snapshot?.offers_count || offers.length || 0) <= 1,
      // FBM BB eligibility: soft-block instead of hard-block
      // FBM sellers are often "not eligible" by design — this should NOT stop repricing
      isBuyboxEligible: effectiveOwnFulfillment === 'FBM' 
        ? true  // FBM: always allow repricing (soft signal, not hard block)
        : true,  // FBA: generally BB eligible
      isBuyboxSuppressed: !snapshot?.buybox_price && offers.length > 0,
      isBackordered: false,
      conditionIsUsed: assignment?.item_condition === 'Used' || rule.condition_scope === 'Used' || (sp_api_data?.detectedItemCondition?.toLowerCase?.()?.startsWith?.('used')),
      minPrice: runtimeMinOverride ?? null,
      maxPrice: runtimeMaxOverride ?? assignment?.max_price_override ?? rule.max_price ?? null,
      // MATCH EXACTLY (undercut_amount === 0): force undercut to exactly 0
      // regardless of preset, so zero-undercut rules can't be turned into
      // $0.01 by Momentum Builder presets, intel multipliers, or tuning.
      undercutAmount: matchExactly ? 0 : (rule.undercut_amount ?? 0.01),
      suppressedBbUndercut: (rule.suppressed_bb_undercut == null || Number.isNaN(Number(rule.suppressed_bb_undercut))) ? null : Math.max(0, Number(rule.suppressed_bb_undercut)),
      matchExactly,
      maxStepAmount: rule.max_step_amount || 0.50,
      maxStepPercent: rule.max_step_percent || 5,
      cooldownMinutes: rule.cooldown_minutes || 15,
      cooldownMinutesLosingBb: rule.cooldown_minutes_losing_bb != null ? Number(rule.cooldown_minutes_losing_bb) : null,
      cooldownMinutesWinningBb: rule.cooldown_minutes_winning_bb != null ? Number(rule.cooldown_minutes_winning_bb) : null,
      competitorDropCount,
      competitorDropBuckets,
      recentDownwardMoves,
      isPriority: !!is_priority,
      lastRepricedAt: assignment?.last_applied_at || assignment?.last_repriced_at || null,
      competeWithAmazon: rule.compete_with_amazon ?? true,
      competeWithFba: rule.compete_with_fba ?? true,
      // The checkbox is authoritative. This used to read
      //   ignore_fbm_unless_buybox_owner === false ? true : (compete_with_fbm ?? true)
      // so an older, unrelated field silently overrode the explicit setting:
      // measured 2026-09-04, four rules had compete_with_fbm = false and
      // competed with FBM regardless -- Aggressive Capture, Match Buy Box,
      // Smart Match, and the rule actually named "Compete with FBM". Unticking
      // the box did nothing on any of them.
      //
      // Migration 20260904320000 first wrote compete_with_fbm = true onto
      // exactly those rules, so removing the override changes no pricing: the
      // stored value now equals what they were already doing. Verified 0 rules
      // would change behaviour.
      //
      // ignore_fbm_unless_buybox_owner keeps its own separate job on the
      // shouldIgnoreFbm path. The two settings simply stop overriding each
      // other, which is what the UI already implies.
      //
      // Default stays true when unset: FBM offers appear on nearly every
      // listing, so ignoring them by accident is the more damaging default.
      competeWithFbm: rule.compete_with_fbm ?? true,
      fbmPremiumPercent: rule.fbm_premium_percent ?? 10,
      fbmPremiumFixed: rule.fbm_premium_fixed ?? 2.0,
      yourFulfillmentType: effectiveOwnFulfillment,
      yourSellerId: sellerAuth?.seller_id || null,
      targetAnchor: (rule.target_anchor as 'buybox' | 'lowest_fba' | 'lowest_offer' | 'smart' | 'smart_recapture') || 'smart',
      useAiTuning: rule.use_ai_tuning ?? true,
      stockGatedMaximize: effectiveStockGatedMaximize,
      intelligence,
      profitGuard: {
        unitCost,
        localCost: localCost ?? null,
        referralRate: profitFloorRefRate,
        fbaFeeFixed: profitFloorFbaFee,
        estimatedFees,
        minProfitDollars,
        minRoiPercent: effectiveMinRoiPercent,
        minRoiPercentBase,
        minRoiPercentHighRisk,
        isHighRisk,
        sellerCount,
        includeFeesInFloor,
        globalAbsoluteFloor,
        profitFloorPrice,
        floorBreakdown,
        mode: (rule.profit_guard_mode as 'strict' | 'respect_min_max' | 'off') || 'off',
        minRoiEnabled,
        minRoiMarketplaceOverrides,
        maxPriceAutoRaised,
        originalMaxPrice,
      },
      smartRaise: (() => {
        // Compute lowestEligibleCompetitorPrice EXCLUDING own offer
        // NOW WITH QUALITY FILTERS: apply same rating/handling filters used for anchor selection
        const userSellerId = sellerAuth?.seller_id;
        const isFbmSeller = effectiveOwnFulfillment === 'FBM';
        const hasFbmCompetitors = offers.some((o: any) => {
          if (o.is_self || (userSellerId && o.seller_id === userSellerId)) return false;
          return o.is_fba === false;
        });
        const useFbmLaneOnly = isFbmSeller && hasFbmCompetitors;
        const ignoreFbm = useFbmLaneOnly ? false : (rule.ignore_fbm_unless_buybox_owner ?? true);
        const srMinRating = rule.min_seller_rating ?? 80;
        const srMaxHandling = rule.max_handling_days ?? 2;
        
        // Try offers_json first (most accurate)
        let nextCompAbove: number | null = null;
        let nextCompAboveRaw: number | null = null; // Without quality filters, for diagnostics
        if (offers.length > 0) {
          const baseEligible = offers.filter((o: any) => {
            // Exclude own offer
            if (o.is_self || (userSellerId && o.seller_id === userSellerId)) return false;
            // FBM sellers should anchor raises to the FBM lane when FBM competition exists
            if (useFbmLaneOnly && o.is_fba) return false;
            // Exclude FBM if rule ignores them
            if (ignoreFbm && !o.is_fba) return false;
            // Exclude Amazon if not competing
            if (!(rule.compete_with_amazon ?? true) && (o.seller_id === 'ATVPDKIKX0DER' || o.seller_name?.toLowerCase().includes('amazon'))) return false;
            return true;
          });
          
          // Quality-filtered eligible (same filters as anchor selection)
          const qualityFiltered = baseEligible.filter((o: any) => {
            const rawRating = o.seller_rating ?? o.positive_rating ?? o.positive_feedback_rating ?? o.rating;
            const rating = rawRating ?? srMinRating; // conservative default
            if (rating < srMinRating) return false;
            const rawHandling = o.handling_days ?? o.max_handling_time ?? o.handling_time;
            let hd: number | null = null;
            if (typeof rawHandling === 'number') hd = rawHandling;
            else if (typeof rawHandling === 'string') {
              const nums = rawHandling.match(/\d+/g);
              if (nums && nums.length > 0) hd = Math.max(...nums.map(Number));
            }
            const effectiveHandling = hd ?? srMaxHandling;
            if (effectiveHandling > srMaxHandling) return false;
            return true;
          });

          // Compute raw (no quality filter) next above — for diagnostics
          const sortedRaw = baseEligible
            .filter((o: any) => Number.isFinite(o.total_price ?? o.price))
            .sort((a: any, b: any) => (a.total_price ?? a.price) - (b.total_price ?? b.price));
          if (sortedRaw.length > 0) {
            const nextHigherRaw = targetCurrentPrice != null
              ? sortedRaw.find((o: any) => (o.total_price ?? o.price) > targetCurrentPrice + 0.01)
              : null;
            nextCompAboveRaw = nextHigherRaw
              ? (nextHigherRaw.total_price ?? nextHigherRaw.price)
              : (sortedRaw[0].total_price ?? sortedRaw[0].price);
          }

          // Compute quality-filtered next above — THIS is what Smart Raise uses
          const sorted = qualityFiltered
            .filter((o: any) => Number.isFinite(o.total_price ?? o.price))
            .sort((a: any, b: any) => (a.total_price ?? a.price) - (b.total_price ?? b.price));
          if (sorted.length > 0) {
            const nextHigher = targetCurrentPrice != null
              ? sorted.find((o: any) => (o.total_price ?? o.price) > targetCurrentPrice + 0.01)
              : null;

            nextCompAbove = nextHigher
              ? (nextHigher.total_price ?? nextHigher.price)
              : (sorted[0].total_price ?? sorted[0].price);
          }
          
          // If quality filter removed all competitors but raw has some above us, use raw as fallback
          if (nextCompAbove === null && nextCompAboveRaw !== null && targetCurrentPrice != null && nextCompAboveRaw > targetCurrentPrice + 0.01) {
            nextCompAbove = nextCompAboveRaw;
            console.log(`[Smart Raise Context] Quality filter excluded all competitors — falling back to raw next above $${nextCompAboveRaw.toFixed(2)}`);
          }
        }
        
        // Fallback to snapshot summary, but detect if it's our own price
        if (nextCompAbove === null) {
          const snapshotLowestFba = snapshot?.lowest_fba_price ?? null;
          const snapshotLowestOverall = snapshot?.lowest_overall_price ?? null;
          const candidate = ignoreFbm ? snapshotLowestFba : (snapshotLowestFba || snapshotLowestOverall);
          // If the snapshot's lowest_fba equals our current price AND there are other FBA competitors,
          // it's likely OUR price — don't use it as the competitor anchor
          if (candidate && targetCurrentPrice && Math.round(candidate * 100) === Math.round(targetCurrentPrice * 100) && intelligence.fbaCompetitorCount > 1) {
            nextCompAbove = null; // Force FBA Leader Raise path
            console.log(`[Smart Raise Context] lowestEligibleCompetitorPrice=$${candidate.toFixed(2)} matches our price — excluded (${intelligence.fbaCompetitorCount - 1} other FBA competitors exist)`);
          } else {
            nextCompAbove = candidate;
          }
        }
        
        console.log(`[Smart Raise Context] lowestEligibleCompetitorPrice=$${nextCompAbove?.toFixed(2) ?? 'null'} (raw=$${nextCompAboveRaw?.toFixed(2) ?? 'null'}), lane=${useFbmLaneOnly ? 'FBM_ONLY' : (ignoreFbm ? 'FBA_ONLY' : 'ALL')}, ignoreFbm=${ignoreFbm}, fbaCompetitorCount=${intelligence.fbaCompetitorCount}, userSellerId=${userSellerId || 'unknown'}, qualityFilters: rating>=${srMinRating}, handling<=${srMaxHandling}d`);
        
        // === CLUSTER DETECTION for Smart Raise ===
        // Count how many sellers (including self) are at the same lowest price
        const clusterThresh = 0.01;
        const clusterPool = useFbmLaneOnly
          ? offers.filter((o: any) => o.is_self || (userSellerId && o.seller_id === userSellerId) || o.is_fba === false)
          : offers;
        const refPrice = useFbmLaneOnly && nextCompAbove != null && targetCurrentPrice != null && nextCompAbove > targetCurrentPrice + 0.03
          ? nextCompAbove
          : (targetCurrentPrice ?? nextCompAbove);
        let srClusterCount = 0;
        let srIsCluster = false;
        if (refPrice && clusterPool.length > 0) {
          srClusterCount = clusterPool.filter((o: any) => o.total_price > 0 && Math.abs(o.total_price - refPrice) <= clusterThresh).length;
          srIsCluster = srClusterCount >= 2;
          if (srIsCluster) {
            console.log(`[Smart Raise Context] PRICE CLUSTER: ${srClusterCount} sellers within $${clusterThresh} of $${refPrice.toFixed(2)}`);
          }
        }
        
        const isUsMarketplace = (targetMarketplace || 'US').toUpperCase() === 'US';
        const configuredGapCloseRatio = rule.raise_gap_close_ratio ?? 0.30;
        const effectiveGapCloseRatio = isUsMarketplace
          ? Math.min(configuredGapCloseRatio, 0.15)
          : configuredGapCloseRatio;

        return {
          enabled: rule.enable_smart_raise ?? false,
          triggerPercent: rule.raise_trigger_percent ?? 2,
          maxRaiseStepDollars: rule.max_raise_step_dollars ?? 0.25,
          maxRaiseStepPercent: rule.max_raise_step_percent ?? 2,
          onlyRaiseWhenBuyboxOwner: isUsMarketplace ? true : (rule.only_raise_when_buybox_owner ?? true),
          previousBuyboxPrice,
          isBuyboxOwner,
          rollingBuyboxPrices,
          rollingLowestFbaPrices,
          requireMarketSupportedRaise: rule.require_market_supported_raise === true,
          minFloorSupportRatio: rule.min_floor_support_ratio != null ? Number(rule.min_floor_support_ratio) : null,
          postRaiseCooldownHours: rule.post_raise_cooldown_hours != null ? Number(rule.post_raise_cooldown_hours) : null,
          lastRaiseAt: assignment?.last_raise_at ?? null,
          gapCloseRatio: effectiveGapCloseRatio,
          lowestEligibleCompetitorPrice: nextCompAbove,
          isEligibleLaneFbmOnly: useFbmLaneOnly,
          isInPriceCluster: srIsCluster,
          clusterSellerCount: srClusterCount,
          // How far a raise may land above the LIVE Buy Box price before being
          // capped. Previously a flat 2% for US only (and completely disabled
          // — null — for CA/MX/BR), regardless of preset, which let raises on
          // the "aggressive" profile overshoot and lose BB in the US, while
          // international raises had no BB-anchored ceiling at all. Now scaled
          // by how aggressive the profile is meant to be, and applied in every
          // marketplace.
          maxRaiseAboveBuyboxPercent: (() => {
            switch (rule.smart_profile || 'CUSTOM') {
              case 'PROFIT_EXTRACTOR': return 0;
              case 'MATCH_BUYBOX': return 0;
              case 'MATCH_LOWEST': return 0;
              case 'SMART_MATCH': return 0;
              case 'VELOCITY_DOMINATOR': return 4;
              case 'MOMENTUM_SMART': return 1.5;
              case 'MOMENTUM_BUILDER':
              default: return 2;
            }
          })(),
        };
      })(),
      // Buy Box Owner Protection - default TRUE to preserve margin
      skipLowerWhenBbOwner: rule.skip_lower_when_bb_owner ?? true,
      // Monopoly Mode - proactive price raising when only FBA seller
      monopolyMode: {
        enabled: rule.enable_monopoly_mode ?? false,
        raiseStepDollars: rule.monopoly_raise_step_dollars ?? 0.10,
        raiseStepPercent: rule.monopoly_raise_step_percent ?? 1,
        cooldownMinutes: rule.monopoly_cooldown_minutes ?? 45,
        mode: (rule.monopoly_mode_type || 'conservative') as 'conservative' | 'aggressive',
      },
      // Ignore FBM unless they own Buy Box - default TRUE (FBA-first strategy)
      ignoreFbmUnlessBuyboxOwner: rule.ignore_fbm_unless_buybox_owner ?? true,
      fbmCompetitionMode: effectiveFbmCompetitionMode,
      // NEW: Competitor Quality Filtering - what makes us BETTER than BQool
      competitorQuality: {
        minSellerRating: rule.min_seller_rating ?? 80,
        maxHandlingDays: rule.max_handling_days ?? 2,
        shipsFromFilter: (rule.ships_from_filter || 'ANY') as 'US_ONLY' | 'DOMESTIC' | 'ANY',
        topNCompetitors: rule.top_n_competitors ?? 8,
        preset: (rule.competitor_quality_preset || 'balanced') as 'conservative' | 'balanced' | 'aggressive' | 'custom',
      },
      marketplace: targetMarketplace,
      currencyCode: marketplaceCurrency,
      _bbSource: (snapshot?.bb_source || 'missing') as 'winner_offer' | 'summary_fallback' | 'missing',
      bbLossAfterRaiseCount: assignment?.bb_loss_after_raise_count || 0,
      triggerSource: (body as any).trigger_source ?? null,
      forceMode: (body as any).force_mode ?? null,
    };

    // Inject state tracking into context for engine use. assignment is null
    // on the ruleId-only (no assignmentId) call path -- default to "no prior
    // state" rather than crash.
    (context as any)._consecutiveFailedUndercuts = assignment?.consecutive_failed_undercuts || 0;
    (context as any)._lastPriceDirection = assignment?.last_price_direction || null;
    (context as any)._directionChangedAt = assignment?.direction_changed_at || null;

    // === POSITION PROOF — answers "am I the lowest?" definitively ===
    const userSellerId = sellerAuth?.seller_id;
    const allOffers = (snapshot?._offerBreakdown || offers || []) as any[];
    const isFbmSeller = context.yourFulfillmentType === 'FBM';
    const hasFbmCompetitors = allOffers.some((o: any) => {
      if (o.is_self || (userSellerId && o.seller_id === userSellerId)) return false;
      return o.is_fba === false;
    });
    const useFbmLaneOnly = isFbmSeller && hasFbmCompetitors;
    const ignoreFbm = useFbmLaneOnly ? false : (rule.ignore_fbm_unless_buybox_owner ?? true);
    const myOffer = allOffers.find((o: any) => o.is_self || (userSellerId && o.seller_id === userSellerId));
    const myTotalPrice = myOffer?.total_price ?? targetCurrentPrice;
    
    // Raw lowest (all offers)
    const rawPrices = allOffers.filter((o: any) => o.total_price > 0).map((o: any) => o.total_price);
    const lowestRaw = rawPrices.length > 0 ? Math.min(...rawPrices) : null;
    const amILowestRaw = myTotalPrice != null && lowestRaw != null && Math.round(myTotalPrice * 100) <= Math.round(lowestRaw * 100);
    
    // Filtered lowest (excluding self, applying FBM/Amazon + quality filters)
    const baseFilteredOffers = allOffers.filter((o: any) => {
      if (o.is_self || (userSellerId && o.seller_id === userSellerId)) return false;
      if (useFbmLaneOnly && o.is_fba) return false;
      if (ignoreFbm && o.is_fba === false && o.fulfillment === 'FBM') return false;
      if (!(rule.compete_with_amazon ?? true) && (o.seller_id === 'ATVPDKIKX0DER')) return false;
      return o.total_price > 0;
    });
    const srMinRating = rule.min_seller_rating ?? 80;
    const srMaxHandling = rule.max_handling_days ?? 2;
    const filteredOffers = baseFilteredOffers.filter((o: any) => {
      const rawRating = o.seller_rating ?? o.positive_rating ?? o.positive_feedback_rating ?? o.rating;
      const rating = rawRating ?? srMinRating;
      if (rating < srMinRating) return false;
      const rawHandling = o.handling_days ?? o.max_handling_time ?? o.handling_time;
      let hd: number | null = null;
      if (typeof rawHandling === 'number') hd = rawHandling;
      else if (typeof rawHandling === 'string') {
        const nums = rawHandling.match(/\d+/g);
        if (nums && nums.length > 0) hd = Math.max(...nums.map(Number));
      }
      const effectiveHandling = hd ?? srMaxHandling;
      if (effectiveHandling > srMaxHandling) return false;
      return true;
    });
    const lowestFiltered = filteredOffers.length > 0 ? Math.min(...filteredOffers.map((o: any) => o.total_price)) : null;
    const amILowestFiltered = myTotalPrice != null && lowestFiltered != null && Math.round(myTotalPrice * 100) <= Math.round(lowestFiltered * 100);
    const lowestFilteredOffer = filteredOffers.length > 0 ? filteredOffers.reduce((a: any, b: any) => a.total_price < b.total_price ? a : b) : null;
    
    // For BB-owner profit-max diagnostics, use the next eligible competitor ABOVE us, not raw near-BB noise below us
    const blockerOffer = filteredOffers
      .filter((o: any) => o.total_price > (myTotalPrice ?? -Infinity) + 0.01)
      .sort((a: any, b: any) => a.total_price - b.total_price)[0] || null;
    
    // === CLUSTER DETECTION — are multiple sellers at the same lowest price? ===
    const clusterThreshold = 0.01; // $0.01 tolerance for "same price"
    const clusterRefPrice = lowestFiltered ?? lowestRaw;
    let clusterSellerCount = 0;
    let isInPriceCluster = false;
    if (clusterRefPrice != null) {
      // Count ALL offers (including self) that are within $0.01 of the lowest price
      const clusterOffers = allOffers.filter((o: any) => 
        o.total_price > 0 && Math.abs(o.total_price - clusterRefPrice) <= clusterThreshold
      );
      clusterSellerCount = clusterOffers.length;
      isInPriceCluster = clusterSellerCount >= 2;
      if (isInPriceCluster) {
        console.log(`[CLUSTER_DETECT] asin=${targetAsin} PRICE CLUSTER: ${clusterSellerCount} sellers within $${clusterThreshold} of lowest $${clusterRefPrice.toFixed(2)}`);
      }
    }

    const myPriceInCluster = Boolean(
      myTotalPrice != null
      && clusterRefPrice != null
      && Math.abs(myTotalPrice - clusterRefPrice) <= clusterThreshold
    );

    const positionProof = {
      my_price: myTotalPrice,
      my_item_price: myOffer?.price ?? null,
      my_shipping: myOffer?.shipping ?? null,
      lowest_price_raw: lowestRaw,
      lowest_price_filtered: lowestFiltered,
      cluster_reference_price: clusterRefPrice,
      my_price_in_cluster: myPriceInCluster,
      next_competitor_price: blockerOffer?.total_price ?? null,
      next_competitor_item_price: blockerOffer?.price ?? null,
      next_competitor_shipping: blockerOffer?.shipping ?? null,
      buy_box_price: snapshot?.buybox_price ?? null,
      am_i_lowest_raw: amILowestRaw,
      am_i_lowest_filtered: amILowestFiltered,
      lowest_offer_is_me: amILowestRaw,
      lowest_offer_channel: lowestFilteredOffer ? (lowestFilteredOffer.is_fba ? 'FBA' : 'FBM') : null,
      lowest_item_price: lowestFilteredOffer?.price ?? null,
      lowest_shipping: lowestFilteredOffer?.shipping ?? null,
      buy_box_owner_is_me: isBuyboxOwner,
      competitor_count_raw: allOffers.filter((o: any) => !o.is_self && !(userSellerId && o.seller_id === userSellerId)).length,
      competitor_count_filtered: filteredOffers.length,
      lowest_price_seller_count: clusterSellerCount,
      is_price_cluster: isInPriceCluster,
      has_shipping: Boolean((myOffer?.shipping ?? 0) > 0 || (blockerOffer?.shipping ?? 0) > 0),
      filter_gap_warning: (lowestRaw != null && lowestFiltered != null && lowestRaw < lowestFiltered - 0.01)
        ? `⚠️ Raw lowest $${lowestRaw.toFixed(2)} is cheaper than filtered lowest $${lowestFiltered.toFixed(2)} — a competitor was filtered out`
        : null,
      blocker: blockerOffer ? {
        seller_id: blockerOffer.seller_id,
        price: blockerOffer.total_price,
        item_price: blockerOffer.price ?? null,
        shipping: blockerOffer.shipping ?? null,
        channel: blockerOffer.is_fba ? 'FBA' : 'FBM',
        gap: myTotalPrice != null ? Math.round((myTotalPrice - blockerOffer.total_price) * 100) / 100 : null,
      } : null,
    };
    
    console.log(`[POSITION_PROOF] asin=${targetAsin} my=$${myTotalPrice?.toFixed(2) ?? 'null'} lowestRaw=$${lowestRaw?.toFixed(2) ?? 'null'} lowestFiltered=$${lowestFiltered?.toFixed(2) ?? 'null'} BB=$${snapshot?.buybox_price?.toFixed(2) ?? 'null'} am_i_lowest_raw=${amILowestRaw} am_i_lowest_filtered=${amILowestFiltered} bb_owner=${isBuyboxOwner} competitors_filtered=${filteredOffers.length} blocker=${blockerOffer ? blockerOffer.seller_id + '@$' + blockerOffer.total_price.toFixed(2) : 'none'}`);


    // === HARD SAFETY: Min price must exist before any pricing logic ===
    // Pure Min/Max architecture: if effectiveMinPrice is null, zero, or undefined → DO_NOT_REPRICE
    const effectiveMinPrice = context.minPrice;
    if (!effectiveMinPrice || effectiveMinPrice <= 0) {
      console.error(`[SAFETY] DO_NOT_REPRICE: effectiveMinPrice is ${effectiveMinPrice} for ${targetAsin}/${targetSku || 'no-sku'}. Min price is required.`);
      
      // Still update last_evaluated_at so UI shows it was checked
      if (!isDryRun && assignment) {
        await supabase
          .from('repricer_assignments')
          .update({
            last_evaluated_at: new Date().toISOString(),
            last_recommendation_reason: 'DO_NOT_REPRICE: Min price is required but missing or zero',
          })
          .eq('id', assignment.id);
      }
      
      return new Response(JSON.stringify({
        success: true,
        asin: targetAsin,
        sku: targetSku,
        marketplace: targetMarketplace,
        mode: 'DO_NOT_REPRICE',
        currentPrice: targetCurrentPrice,
        recommendedPrice: null,
        rawTargetPrice: null,
        reason: 'Min price is required but missing or zero — set a Min price to enable repricing',
        guardsApplied: ['MIN_PRICE_REQUIRED'],
        blockedByProfitGuard: false,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === COST MISSING SAFETY ===
    // If cost is missing but Min exists → allow repricing with clear tag
    // If cost is missing AND Min is missing → already caught by MIN_PRICE_REQUIRED above
    const costMissing = !unitCost || unitCost <= 0;
    let costMissingTag: string | null = null;
    if (costMissing) {
      costMissingTag = 'COST_MISSING_MIN_USED';
      console.warn(`[SAFETY] ${costMissingTag}: ${targetAsin}/${targetSku || 'no-sku'} — cost is null/zero, using Min price ($${effectiveMinPrice.toFixed(2)}) as sole floor`);
    }

    // Calculate base price with intelligence
    const _tCorePricing0 = Date.now();
    let result = computeAiWinSalesBoosterPrice(context, rule, offers);
    
    // Tag raise offset policy on any raise result for diagnostics
    if ((result as any).isRaise && result.guardsApplied) {
      const _roCtx = buildRaiseOffsetContext(context, rule.smart_profile || 'CUSTOM');
      const _roResult = computeRaiseOffset(_roCtx);
      result.guardsApplied.push(`raise_offset_${_roResult.reason}`);
    }

    // ── RESTOCK SNAP-BACK OVERRIDE ──
    // When restocking after being out-of-stock, aggressively move toward competitive anchor
    // This overrides normal conservative descent logic but RESPECTS floors and ROI
    if (restock_reentry && targetCurrentPrice && snapshot) {
      const bbPrice = snapshot.buybox_price;
      const lowestFba = snapshot.lowest_fba_price;
      const lowestOverall = snapshot.lowest_overall_price;
      const snapshotAge = snapshot.fetched_at
        ? (Date.now() - new Date(snapshot.fetched_at).getTime()) / (60 * 1000)
        : Infinity;
      const anchorFresh = snapshotAge < 120; // 2 hours

      // Target hierarchy: BB > lowest FBA > lowest overall > hold
      let snapbackTarget: number | null = null;
      let snapbackAnchor = 'none';

      if (anchorFresh && bbPrice && bbPrice > 0) {
        snapbackTarget = bbPrice;
        snapbackAnchor = 'buy_box';
      } else if (anchorFresh && lowestFba && lowestFba > 0) {
        snapbackTarget = lowestFba;
        snapbackAnchor = 'lowest_fba';
      } else if (anchorFresh && lowestOverall && lowestOverall > 0) {
        snapbackTarget = lowestOverall;
        snapbackAnchor = 'lowest_filtered';
      }

      if (snapbackTarget && snapbackTarget < targetCurrentPrice) {
        // Determine undercut based on rule strategy (respect match-only profiles)
        const smartProfile = rule.smart_profile || 'CUSTOM';
        const isMatchOnly = ['MARGIN_PROTECTION', 'PROFIT_EXTRACTOR'].includes(smartProfile)
          || (rule.undercut_amount != null && rule.undercut_amount === 0);
        const snapbackUndercut = isMatchOnly ? 0 : 0.01;
        const snapbackPrice = snapbackTarget - snapbackUndercut;

        // Respect floor protections
        const effectiveFloorCents = context.minPrice ? Math.round(context.minPrice * 100) : 0;
        const snapbackPriceCents = Math.round(snapbackPrice * 100);
        const clampedSnapbackCents = Math.max(snapbackPriceCents, effectiveFloorCents);
        const clampedSnapbackPrice = clampedSnapbackCents / 100;

        // Only apply if the snap-back actually moves the price meaningfully and does NOT overshoot below target
        if (clampedSnapbackPrice < targetCurrentPrice - 0.005 && clampedSnapbackPrice >= snapbackTarget - 0.02) {
          const prevPrice = result.newPrice;
          result.newPrice = clampedSnapbackPrice;
          result.reason = `restock_snapback_applied: $${targetCurrentPrice.toFixed(2)} → $${clampedSnapbackPrice.toFixed(2)} (anchor=${snapbackAnchor}, target=$${snapbackTarget.toFixed(2)})`;
          result.mode = 'LOWER';
          if (!result.guardsApplied) result.guardsApplied = [];
          result.guardsApplied.push('restock_reentry_detected');
          result.guardsApplied.push(`restock_anchor=${snapbackAnchor}`);
          result.guardsApplied.push('restock_snapback_applied');
          if (clampedSnapbackCents > snapbackPriceCents) {
            result.guardsApplied.push('restock_floor_clamped');
          }
          console.log(`[restock_snapback] ${targetAsin}/${targetMarketplace}: SNAP-BACK $${targetCurrentPrice.toFixed(2)} → $${clampedSnapbackPrice.toFixed(2)} (anchor=${snapbackAnchor}=$${snapbackTarget.toFixed(2)}, profile=${smartProfile}, prev_eval=$${prevPrice?.toFixed(2) || 'null'})`);
        } else {
          console.log(`[restock_snapback] ${targetAsin}/${targetMarketplace}: snap-back skipped — price $${targetCurrentPrice.toFixed(2)} already near target $${snapbackTarget.toFixed(2)} or floor would block`);
          if (!result.guardsApplied) result.guardsApplied = [];
          result.guardsApplied.push('restock_reentry_detected');
          result.guardsApplied.push('restock_snapback_skipped_already_competitive');
        }
      } else if (!snapbackTarget) {
        console.log(`[restock_snapback] ${targetAsin}/${targetMarketplace}: restock_snapback_skipped_stale_anchor (age=${Math.round(snapshotAge)}m, bb=${bbPrice}, fba=${lowestFba})`);
        if (!result.guardsApplied) result.guardsApplied = [];
        result.guardsApplied.push('restock_reentry_detected');
        result.guardsApplied.push('restock_snapback_skipped_stale_anchor');
      } else {
        // Target >= current price — no need to snap back down
        console.log(`[restock_snapback] ${targetAsin}/${targetMarketplace}: no downward snap needed — target $${snapbackTarget.toFixed(2)} >= current $${targetCurrentPrice.toFixed(2)}`);
        if (!result.guardsApplied) result.guardsApplied = [];
        result.guardsApplied.push('restock_reentry_detected');
        result.guardsApplied.push('restock_snapback_not_needed');
      }
    }

    // If the price direction just changed (was going up, now going down or vice versa),
    // block the flip unless enough time passed or market clearly changed
    if (result.newPrice && targetCurrentPrice && assignment) {
      const newDirection = result.newPrice > targetCurrentPrice ? 'up' : result.newPrice < targetCurrentPrice ? 'down' : null;
      const prevDirection = (context as any)._lastPriceDirection as string | null;
      const directionChangedAt = (context as any)._directionChangedAt as string | null;
      
      if (newDirection && prevDirection && newDirection !== prevDirection) {
        const timeSinceFlip = directionChangedAt ? (Date.now() - new Date(directionChangedAt).getTime()) / 60000 : Infinity;
        const ANTI_FLIP_COOLDOWN_MINUTES = 10; // minimum time between direction changes
        
        // Allow the flip if: enough time passed, or market moved significantly (>3%)
        const marketMoved = Math.abs(result.newPrice - targetCurrentPrice) / targetCurrentPrice > 0.03;
        const isUrgentBbLoss = !isBuyboxOwner && intelligence.buyboxLossStreak >= 5;
        // Overpriced correction bypass: if we're above the lowest raw competitor and trying to go DOWN,
        // this is a corrective move — bypass cooldown immediately
        const isOverpricedCorrection = newDirection === 'down'
          && positionProof.lowest_price_raw != null
          && targetCurrentPrice > positionProof.lowest_price_raw + 0.005;
        
        if (timeSinceFlip < ANTI_FLIP_COOLDOWN_MINUTES && !marketMoved && !isUrgentBbLoss && !restock_reentry && !isOverpricedCorrection) {
          console.log(`[ANTI_FLIP] BLOCKED: direction ${prevDirection}→${newDirection} after ${Math.round(timeSinceFlip)}min (cooldown ${ANTI_FLIP_COOLDOWN_MINUTES}min). Holding price.`);
          result = {
            ...result,
            mode: 'SKIP',
            newPrice: null,
            reason: `Anti-flip cooldown: direction ${prevDirection}→${newDirection} blocked (${Math.round(timeSinceFlip)}min < ${ANTI_FLIP_COOLDOWN_MINUTES}min) | ${result.reason}`,
            guardsApplied: [...(result.guardsApplied || []), 'anti_flip_cooldown'],
          };
        } else {
          console.log(`[ANTI_FLIP] ALLOWED: direction ${prevDirection}→${newDirection} after ${Math.round(timeSinceFlip)}min (marketMoved=${marketMoved}, urgentBbLoss=${isUrgentBbLoss}, overpricedCorrection=${isOverpricedCorrection})`);
          if (isOverpricedCorrection) {
            if (!result.guardsApplied) result.guardsApplied = [];
            result.guardsApplied.push('overpriced_correction_bypass');
          }
        }
      }
    }

    // Extract anchor diagnostics from the result (scoped inside computeAiWinSalesBoosterPrice)
    const resultAnchorDiagnostics = result.intelligenceFactors?.decision_trace?.anchor_diagnostics ?? {
      raw_lowest_fba: null, filtered_lowest_fba: null, selected_anchor: null, override_reason: null, enforced_target: null, final_output_price: null,
    };
    // Stock-gated pre-position override: when available=0 but reserved>0,
    // and there is a real filtered competitor above us, force a raise immediately
    // after core pricing so earlier hold branches cannot suppress it.
    if (
      effectiveStockGatedMaximize
      && targetCurrentPrice
      && resultAnchorDiagnostics.filtered_lowest_fba
      && resultAnchorDiagnostics.filtered_lowest_fba > targetCurrentPrice + 0.02
    ) {
      const forcedRaise = Math.round(
        Math.min(resultAnchorDiagnostics.filtered_lowest_fba, context.maxPrice || resultAnchorDiagnostics.filtered_lowest_fba) * 100
      ) / 100;

      if (forcedRaise > targetCurrentPrice) {
        result = {
          ...result,
          mode: 'SMART_RAISE',
          newPrice: forcedRaise,
          rawTargetPrice: resultAnchorDiagnostics.filtered_lowest_fba,
          reason: `Reserved-stock recovery: raising from $${targetCurrentPrice.toFixed(2)} to filtered competitor $${resultAnchorDiagnostics.filtered_lowest_fba.toFixed(2)} while sellable inventory is zero`,
          guardsApplied: [...(result.guardsApplied || []), 'stock_gated_preposition_forced_raise'],
        };
      }
    }

    // === LOWEST-FILTERED PROTECTION (lane-aware) ===
    // If user is already the lowest filtered seller and raw BB was filtered out,
    // block any downward price move — this is a profit zone, not a competitive zone.
    // EXCEPTION: In FBM→FBM mode, the BB seller IS your real competition — don't block.
    const rawBbIsFilteredOut = Boolean(
      positionProof.filter_gap_warning  // raw < filtered = someone was filtered
      && positionProof.buy_box_price != null
      && positionProof.lowest_price_filtered != null
      && positionProof.buy_box_price < positionProof.lowest_price_filtered - 0.02
    );
    // Also check if user is already AT the filtered competitor level (within $0.03)
    const alreadyAtFilteredLevel = positionProof.am_i_lowest_filtered
      && targetCurrentPrice != null
      && positionProof.lowest_price_filtered != null
      && Math.abs(targetCurrentPrice - positionProof.lowest_price_filtered) <= 0.03;

    // Determine if this is FBM→FBM: seller is FBM and BB is likely FBM
    const protectionIsFbm = context.yourFulfillmentType === 'FBM';
    const bbSellerIsFbm = (buyboxSellerType as any) === 'FBM' || buyboxSellerType === null || (buyboxSellerType as any) === 'unknown';
    const isFbmVsFbmMarket = protectionIsFbm && bbSellerIsFbm;

    if (
      rawBbIsFilteredOut
      && targetCurrentPrice != null
      && result.newPrice != null
      && (positionProof.am_i_lowest_filtered || alreadyAtFilteredLevel)
      && result.newPrice < targetCurrentPrice - 0.005
      && !isFbmVsFbmMarket  // Don't block in FBM→FBM — BB seller is real competition
    ) {
      console.log(
        `[LOWEST_FILTERED_PROTECTION] asin=${targetAsin} BLOCKED DOWNWARD: core wanted $${result.newPrice.toFixed(2)} but user is lowest filtered ($${targetCurrentPrice.toFixed(2)}), raw BB $${positionProof.buy_box_price?.toFixed(2)} was filtered. Holding price.`
      );
      result = {
        ...result,
        mode: 'HOLD',
        newPrice: targetCurrentPrice,
        rawTargetPrice: targetCurrentPrice,
        reason: `Lowest filtered protection: raw BB $${positionProof.buy_box_price?.toFixed(2)} filtered out, holding $${targetCurrentPrice.toFixed(2)} (profit zone)`,
        guardsApplied: [...(result.guardsApplied || []), 'lowest_filtered_protection'],
      };
    } else if (rawBbIsFilteredOut && isFbmVsFbmMarket) {
      console.log(
        `[LOWEST_FILTERED_PROTECTION] asin=${targetAsin} BYPASSED for FBM→FBM: BB at $${positionProof.buy_box_price?.toFixed(2)} is FBM competition, not filtering it out`
      );
      result = {
        ...result,
        guardsApplied: [...(result.guardsApplied || []), 'fbm_vs_fbm_bb_retained'],
      };
    }

    const finalSelectorFilteredAnchor = context.smartRaise.lowestEligibleCompetitorPrice
      ?? positionProof.lowest_price_filtered
      ?? resultAnchorDiagnostics.filtered_lowest_fba
      ?? null;
    const finalSelectorRawBuyBox = snapshot?.buybox_price ?? null;
    // Raise-safe version: only considers competitors above current price
    const finalSelectorAbove = (() => {
      const cands = [
        context.smartRaise.lowestEligibleCompetitorPrice,
        positionProof.lowest_price_filtered,
        resultAnchorDiagnostics.filtered_lowest_fba,
        positionProof.next_competitor_price,
      ].filter((p): p is number => p != null && targetCurrentPrice != null && p > targetCurrentPrice + 0.02);
      return cands.length > 0 ? Math.min(...cands) : null;
    })();
    const finalSelectorRawAnchorEligible = !Boolean(
      positionProof.filter_gap_warning
      && finalSelectorFilteredAnchor != null
      && targetCurrentPrice != null
      && finalSelectorFilteredAnchor > targetCurrentPrice + 0.03
    );
    const finalSelectorClusterSafeRaise = Boolean(
      positionProof.is_price_cluster
      && positionProof.my_price_in_cluster !== true
      && finalSelectorFilteredAnchor != null
      && targetCurrentPrice != null
      && finalSelectorFilteredAnchor > targetCurrentPrice + 0.02
    );
    const finalSelectorRaiseProtection = targetCurrentPrice != null
      ? getProfitRaiseProtection({
          currentPrice: targetCurrentPrice,
          isBuyboxOwner,
          inPriceCluster: Boolean(positionProof.is_price_cluster),
          rawLowestPrice: positionProof.lowest_price_raw ?? null,
        })
      : null;

    const finalSelectorGuards = result.guardsApplied || [];
    const finalSelectorNeedsRaiseRescue = (
      result.mode === 'SKIP' && (
        finalSelectorGuards.includes('floor_blocked_micro_step')
        || finalSelectorGuards.includes('bb_rotation_patience')
        || (finalSelectorGuards.includes('cluster_hold') && finalSelectorClusterSafeRaise)
      )
    ) || (
      // Also rescue from HOLD when lowest-filtered protection blocked a downward move
      // and there's a raise opportunity above
      result.mode === 'HOLD' && (finalSelectorGuards.includes('lowest_filtered_protection') || finalSelectorGuards.includes('lowest_filtered_fba_protection'))
    );

    if (
      targetCurrentPrice != null
      && finalSelectorNeedsRaiseRescue
      && (finalSelectorAbove ?? finalSelectorFilteredAnchor) != null
      && (finalSelectorAbove ?? finalSelectorFilteredAnchor)! > targetCurrentPrice + 0.03
      && context.smartRaise.enabled
      && finalSelectorRaiseProtection?.isAllowed
      && (!positionProof.is_price_cluster || finalSelectorClusterSafeRaise)
      && (!finalSelectorRawAnchorEligible || finalSelectorGuards.includes('bb_rotation_patience'))
    ) {
      const effectiveFinalAnchor = finalSelectorAbove ?? finalSelectorFilteredAnchor!;
      const proposedLowerTarget = result.rawTargetPrice;
      // FIX: use ?? so an explicit undercut of 0 (match-exact mode) is respected.
      // Previously `|| 0.01` forced a $0.01 undercut for users who set undercut=0,
      // producing the AI_WIN_SALES_BOOSTER override that broke "match the BB" rules.
      const finalSelectorUndercut = context.undercutAmount ?? 0.01;
      const proposedRaiseTarget = Math.round(
        Math.max(0.01, effectiveFinalAnchor - finalSelectorUndercut) * 100
      ) / 100;
      const maxRaiseStep = Math.max(
        0.05,
        Math.min(
          context.smartRaise.maxRaiseStepDollars || 0.25,
          targetCurrentPrice * ((context.smartRaise.maxRaiseStepPercent || 2) / 100),
          0.10,
        ),
      );
      const availableRaiseGap = Math.max(proposedRaiseTarget - targetCurrentPrice, 0);
      const proposedRaiseStep = availableRaiseGap >= 0.05
        ? Math.min(maxRaiseStep, availableRaiseGap)
        : availableRaiseGap;
      // === RAW BB CEILING: Never raise above raw Buy Box when filtered anchor is higher ===
      let ftsRawBbCapped = false;
      let ftsRawBbCeiling = Number.POSITIVE_INFINITY;
      if (finalSelectorRawBuyBox != null && finalSelectorRawBuyBox > 0 && positionProof.filter_gap_warning) {
        const ftsEpsilon = finalSelectorRawBuyBox >= 50 ? 0.05 : finalSelectorRawBuyBox >= 20 ? 0.02 : 0.01;
        ftsRawBbCeiling = Math.round((finalSelectorRawBuyBox - ftsEpsilon) * 100) / 100;
      }

      const finalSelectedTarget = Math.round(
        Math.min(
          targetCurrentPrice + proposedRaiseStep,
          context.maxPrice || Number.POSITIVE_INFINITY,
          proposedRaiseTarget,
          ftsRawBbCeiling,
        ) * 100
      ) / 100;
      ftsRawBbCapped = (targetCurrentPrice + proposedRaiseStep > ftsRawBbCeiling) && ftsRawBbCeiling < Number.POSITIVE_INFINITY;
      if (ftsRawBbCapped) {
        console.log(`[FINAL_TARGET_SELECTOR] RAW_BB_CAP: capping raise to $${ftsRawBbCeiling.toFixed(2)} (raw BB $${finalSelectorRawBuyBox?.toFixed(2)}) — never raise above real market`);
      }
      const finalDelta = Math.round((finalSelectedTarget - targetCurrentPrice) * 100) / 100;
      const patienceOverrideApplied = finalSelectorGuards.includes('bb_rotation_patience');
      const clusterSafeRaiseApplied = Boolean(positionProof.is_price_cluster && finalSelectorClusterSafeRaise);

      console.log(
        `[FINAL_TARGET_SELECTOR] asin=${targetAsin} current_price=$${targetCurrentPrice.toFixed(2)} bb_price=$${finalSelectorRawBuyBox?.toFixed(2) ?? 'null'} filtered_anchor=$${finalSelectorFilteredAnchor.toFixed(2)} patience_override_applied=${patienceOverrideApplied} cluster_safe_raise_applied=${clusterSafeRaiseApplied} proposed_lower_target=$${proposedLowerTarget?.toFixed(2) ?? 'null'} proposed_raise_step=$${proposedRaiseStep.toFixed(2)} final_target_before_validation=$${finalSelectedTarget.toFixed(2)} final_target_after_validation=$${finalSelectedTarget.toFixed(2)} final_delta=$${finalDelta.toFixed(2)} final_winning_guard=${patienceOverrideApplied ? 'bb_rotation_patience_rescue' : clusterSafeRaiseApplied ? 'cluster_safe_raise_selector' : 'final_filtered_raise_selector'} final_reject_reason=${finalSelectedTarget > targetCurrentPrice ? 'none' : 'raise_collapsed_before_write'}`,
      );

      if (finalSelectedTarget > targetCurrentPrice) {
        result = {
          ...result,
          mode: 'SMART_RAISE',
          newPrice: finalSelectedTarget,
          rawTargetPrice: proposedRaiseTarget,
          reason: `Filtered recovery override: raw Buy Box $${finalSelectorRawBuyBox?.toFixed(2) ?? 'n/a'} filtered out, next eligible $${finalSelectorFilteredAnchor.toFixed(2)} — raising to $${finalSelectedTarget.toFixed(2)}`,
          guardsApplied: [
            ...(result.guardsApplied || []).filter((guard) => guard !== 'floor_blocked_micro_step' && guard !== 'bb_rotation_patience' && guard !== 'cluster_hold'),
            'final_filtered_raise_selector',
            'raw_anchor_filtered_out_for_raise',
            ...(clusterSafeRaiseApplied ? ['cluster_safe_raise_selector'] : []),
            ...(patienceOverrideApplied ? ['bb_rotation_patience_rescue'] : []),
            ...(ftsRawBbCapped ? ['raw_bb_ceiling_cap'] : []),
          ],
          isRaise: true,
        };
      }
    } else if (
      targetCurrentPrice != null
      && finalSelectorNeedsRaiseRescue
      && (finalSelectorAbove ?? finalSelectorFilteredAnchor) != null
      && (finalSelectorAbove ?? finalSelectorFilteredAnchor)! > targetCurrentPrice + 0.03
      && finalSelectorRaiseProtection
      && !finalSelectorRaiseProtection.isAllowed
    ) {
      console.log(
        `[FINAL_TARGET_SELECTOR] BLOCKED: asin=${targetAsin} current_price=$${targetCurrentPrice.toFixed(2)} blockers=${finalSelectorRaiseProtection.blockers.join(',')} raw_lowest=$${positionProof.lowest_price_raw?.toFixed(2) ?? 'null'} buy_box_price=$${finalSelectorRawBuyBox?.toFixed(2) ?? 'null'}`,
      );
    }

    const _tCorePricing = Date.now();


    // Apply Enhanced Deterministic Tuning (replaces LLM AI calls — $0 cost)
    // TRANSPARENCY: tuning_source tracks which engine was used
    let tuning_source: 'enhanced' | 'none' = 'none';
    let enhanced_multiplier: number | null = null;
    let combined_multiplier: number | null = null;
    let enhanced_factors: string[] = [];

    // Hoisted so the downstream "final smart_recapture guard" block can still
    // reference these regardless of whether enhanced tuning ran.
    let resultIntelligence: Record<string, any> = {};
    let decisionTrace: Record<string, any> = {};
    let undercutBaseForTuning: number = context.undercutAmount ?? 0.01;
    let finalMultiplier: number = 1.0;

    if (result.mode === 'AI_REPRICE' && result.newPrice) {
      resultIntelligence = (result.intelligenceFactors as Record<string, any> | undefined) ?? {};
      decisionTrace = (resultIntelligence.decision_trace as Record<string, any> | undefined) ?? {};
      undercutBaseForTuning = typeof resultIntelligence.undercut_base === 'number'
        ? resultIntelligence.undercut_base
        : context.undercutAmount;

      // STRICT MATCH MODE: completely bypass enhanced tuning. Suppressed BB has
      // its own explicit user-entered undercut, so keep that result untouched too.
      const explicitSuppressedBbReprice = Boolean(
        context.isBuyboxSuppressed
        && context.suppressedBbUndercut != null
        && result.mode === 'AI_REPRICE'
        && result.reason?.startsWith('Buy Box suppressed')
      );
      if (context.matchExactly || explicitSuppressedBbReprice) {
        tuning_source = 'none';
        // Force downstream final guards not to re-derive a different undercut.
        undercutBaseForTuning = explicitSuppressedBbReprice ? (context.suppressedBbUndercut ?? 0) : 0;
        finalMultiplier = 1.0;
        console.log(`[ENHANCED_TUNING] ${explicitSuppressedBbReprice ? 'SUPPRESSED_BB_EXPLICIT_UNDERCUT' : 'MATCH_EXACTLY'}: enhanced tuning BLOCKED for asin=${targetAsin} — keeping price $${result.newPrice.toFixed(2)}`);
        if (!result.guardsApplied) result.guardsApplied = [];
        result.guardsApplied.push(explicitSuppressedBbReprice ? 'suppressed_bb_blocked_enhanced_tuning' : 'strict_match_mode_blocked_enhanced_tuning');
      } else {
        const enhancedTuning = calculateEnhancedDeterministicTuning(context, result);
        tuning_source = 'enhanced';
        enhanced_multiplier = enhancedTuning.aggressiveness;
        enhanced_factors = enhancedTuning.factors;
        const anchorPriceForTuning = typeof resultIntelligence.anchor_price === 'number'
          ? resultIntelligence.anchor_price
          : context.buyboxPrice;

        // BLEND instead of multiply to prevent over-amplification (ChatGPT recommendation)
        // 60% weight on existing intelligence multiplier, 40% on enhanced tuning
        const baseMultiplier = result.aiAggressiveness || 1.0;
        const blended = 0.6 * baseMultiplier + 0.4 * enhancedTuning.aggressiveness;
        finalMultiplier = Math.max(0.5, Math.min(1.5, Math.round(blended * 100) / 100));
        combined_multiplier = finalMultiplier;

        // === TRANSPARENCY LOG (ChatGPT verification line) ===
        console.log(`[TUNING_VERIFICATION] asin=${targetAsin} tuning_source=enhanced enhanced_multiplier=${enhanced_multiplier.toFixed(2)} base_multiplier=${baseMultiplier.toFixed(2)} combined_multiplier=${finalMultiplier.toFixed(2)} factors=[${enhanced_factors.join('; ')}]`);

        if (Math.abs(finalMultiplier - baseMultiplier) > 0.05 && anchorPriceForTuning) {
          const adjustedUndercut = undercutBaseForTuning * finalMultiplier;
          let adjustedPrice = anchorPriceForTuning - adjustedUndercut;

          // CRITICAL: Enforce min/max bounds after enhanced tuning recalculation
          // Without this, the enhanced tuning can bypass the HARD CLAMP from computeAiWinSalesBoosterPrice
          if (context.minPrice !== null && context.minPrice !== undefined && adjustedPrice < context.minPrice) {
            adjustedPrice = context.minPrice;
            console.log(`[ENHANCED_TUNING] Clamped to min: $${adjustedPrice.toFixed(2)} (was below min $${context.minPrice})`);
          }
          if (context.maxPrice && adjustedPrice > context.maxPrice) {
            adjustedPrice = context.maxPrice;
          }

          result.newPrice = Math.round(adjustedPrice * 100) / 100;
          result.aiAggressiveness = finalMultiplier;
          result.aiNote = `${result.aiNote || ''} | ${enhancedTuning.note}`;
          result.reason = `Enhanced-tuned (${finalMultiplier.toFixed(2)}x): ${result.reason}`;

          console.log(
            `[ENHANCED_TUNING] asin=${targetAsin} anchor_price=$${anchorPriceForTuning.toFixed(2)} undercut_base=$${undercutBaseForTuning.toFixed(2)} final_price=$${result.newPrice.toFixed(2)}`
          );

          if (resultAnchorDiagnostics) {
            resultAnchorDiagnostics.final_output_price = result.newPrice;
          }
        }
      }

      const finalFilteredRaiseSelectorActive = Boolean((result.guardsApplied || []).includes('final_filtered_raise_selector'));
      const rawAnchorEligibleForFinalGuard = !Boolean(
        positionProof.filter_gap_warning
        && positionProof.lowest_price_filtered != null
        && context.currentPrice != null
        && positionProof.lowest_price_filtered > context.currentPrice + 0.03
      );

      // ============================================================
      // PURE BB LOCK MODE
      // When the user explicitly asked to MATCH Buy Box exactly
      // (undercut_amount=0 + buybox anchor), no post-anchor guard is
      // allowed to lower the price below BB. This blocks
      // final_smart_recapture_guard, enhanced tuning drift, and
      // cluster-match drops in one hard gate.
      // ============================================================
      const pureBbLockEligible = Boolean(
        context.matchExactly
        && resultAnchorDiagnostics
        && (
          resultAnchorDiagnostics.selected_anchor === 'buybox_winner_offer'
          || resultAnchorDiagnostics.selected_anchor === 'buybox'
        )
        && typeof context.buyboxPrice === 'number'
        && context.buyboxPrice > 0
      );

      if (pureBbLockEligible && result.newPrice !== null && resultAnchorDiagnostics) {
        const bbTarget = Math.round((context.buyboxPrice as number) * 100) / 100;
        if (result.newPrice < bbTarget - 0.004) {
          const overriddenPrice = result.newPrice;
          result.newPrice = bbTarget;
          resultAnchorDiagnostics.enforced_target = bbTarget;
          resultAnchorDiagnostics.ai_override_after_enforcement = true;
          resultAnchorDiagnostics.post_enforcement_override_reason = 'pure_bb_lock_engaged';
          if (!result.guardsApplied) result.guardsApplied = [];
          if (!result.guardsApplied.includes('pure_bb_lock_engaged')) {
            result.guardsApplied.push('pure_bb_lock_engaged');
          }
          result.reason = `Pure BB Lock engaged: candidate $${overriddenPrice.toFixed(2)} raised to Buy Box $${bbTarget.toFixed(2)} (strict match + undercut=0 + BB anchor — post-anchor lowering blocked) | ${result.reason}`;
          console.log(
            `[PURE_BB_LOCK] asin=${targetAsin} bb=$${bbTarget.toFixed(2)} overridden_from=$${overriddenPrice.toFixed(2)} blocked_lowering=true`
          );
        } else {
          if (!result.guardsApplied) result.guardsApplied = [];
          if (!result.guardsApplied.includes('pure_bb_lock_engaged')) {
            result.guardsApplied.push('pure_bb_lock_engaged');
          }
          console.log(
            `[PURE_BB_LOCK] asin=${targetAsin} bb=$${bbTarget.toFixed(2)} candidate=$${result.newPrice.toFixed(2)} — already at/above BB, no override needed`
          );
        }
        resultAnchorDiagnostics.final_output_price = result.newPrice;
        if (decisionTrace) {
          decisionTrace.adjusted_target = result.newPrice;
          decisionTrace.final_target = result.newPrice;
          decisionTrace.delta = context.currentPrice
            ? Math.round((result.newPrice - context.currentPrice) * 1000) / 1000
            : null;
        }
      } else if (
        result.newPrice !== null &&
        resultAnchorDiagnostics &&
        resultAnchorDiagnostics.selected_anchor === 'smart_recapture' &&
        (result.guardsApplied || []).includes('fbm_mode_explicit_anchor')
      ) {
        // ============================================================
        // FBM EXPLICIT ANCHOR BYPASS
        // filtered_lowest_fba is computed from FBA offers only (see
        // fbaEligible above) — it is never a meaningful ceiling when the
        // rule's own competition settings explicitly anchored this eval
        // to an FBM Buy Box seller (fbm_mode_explicit_anchor). Without
        // this bypass, the guard below silently replaces a valid
        // FBM-derived candidate with an unrelated FBA competitor's
        // price, contradicting the anchor the engine itself just chose.
        // Other guards (min/max bounds, ROI floor, max-step) are
        // untouched and still apply independently of this bypass.
        // ============================================================
        resultAnchorDiagnostics.ai_override_after_enforcement = false;
        resultAnchorDiagnostics.post_enforcement_override_reason = 'fbm_explicit_anchor_preserved';
        resultAnchorDiagnostics.final_output_price = result.newPrice;
        if (!result.guardsApplied.includes('final_smart_recapture_guard_bypassed_fbm_anchor')) {
          result.guardsApplied.push('final_smart_recapture_guard_bypassed_fbm_anchor');
        }
        console.log(
          `[FINAL_ANCHOR_GUARD] BYPASSED (fbm_explicit_anchor): asin=${targetAsin} candidate=$${result.newPrice.toFixed(2)} filtered_lowest_fba=$${Number(resultAnchorDiagnostics.filtered_lowest_fba ?? 0).toFixed(2)} — preserving FBM-anchored target, not overriding with FBA-only ceiling`
        );
      } else if (
        result.newPrice !== null &&
        resultAnchorDiagnostics &&
        resultAnchorDiagnostics.selected_anchor === 'smart_recapture' &&
        context.currentPrice &&
        !context.smartRaise.isBuyboxOwner &&
        !finalFilteredRaiseSelectorActive &&
        rawAnchorEligibleForFinalGuard
      ) {
        // ============================================================
        // FINAL SMART_RECAPTURE GUARD
        // FIX: Use FILTERED lowest FBA instead of RAW lowest FBA so
        // the guard never re-introduces an offer the engine's
        // quality_filter already rejected (eg low-rated FBM, suppressed,
        // not BB-eligible). This keeps the guard consistent with the
        // rest of the engine.
        // Falls back to raw lowest only when filtered is not available.
        // ============================================================
        const filteredLowestFba = typeof resultAnchorDiagnostics.filtered_lowest_fba === 'number'
          ? resultAnchorDiagnostics.filtered_lowest_fba
          : null;
        const rawLowestFba = typeof resultAnchorDiagnostics.raw_lowest_fba === 'number'
          ? resultAnchorDiagnostics.raw_lowest_fba
          : null;
        const guardLowestFba = filteredLowestFba ?? rawLowestFba;
        const guardLowestSource = filteredLowestFba != null ? 'filtered' : 'raw_fallback';

        if (guardLowestFba && guardLowestFba < context.currentPrice - 0.004) {
          const guardUndercut = undercutBaseForTuning * (result.aiAggressiveness || finalMultiplier || 1);
          const enforcedTarget = Math.round(
            Math.max(0.01, guardLowestFba - guardUndercut) * 100
          ) / 100;

          resultAnchorDiagnostics.enforced_target = enforcedTarget;

          if (result.newPrice > enforcedTarget + 0.004) {
            const overriddenPrice = result.newPrice;
            result.newPrice = enforcedTarget;
            resultAnchorDiagnostics.ai_override_after_enforcement = true;
            resultAnchorDiagnostics.post_enforcement_override_reason = 'post_ai_override_blocked';
            if (!result.guardsApplied.includes('final_smart_recapture_guard')) {
              result.guardsApplied.push('final_smart_recapture_guard');
            }
            const guardDirection = enforcedTarget < overriddenPrice ? 'lowered' : 'held';
            result.reason = `Final smart_recapture guard: AI candidate $${overriddenPrice.toFixed(2)} ${guardDirection} to $${enforcedTarget.toFixed(2)} (lowest eligible FBA [${guardLowestSource}] $${guardLowestFba.toFixed(2)}, undercut $${guardUndercut.toFixed(2)}) | ${result.reason}`;
            console.log(
              `[FINAL_ANCHOR_GUARD] asin=${targetAsin} selected_anchor=smart_recapture lowest_source=${guardLowestSource} guard_lowest_fba=$${guardLowestFba.toFixed(2)} raw_lowest_fba=$${Number(rawLowestFba ?? 0).toFixed(2)} filtered_lowest_fba=$${Number(filteredLowestFba ?? 0).toFixed(2)} enforced_target=$${enforcedTarget.toFixed(2)} overridden_from=$${overriddenPrice.toFixed(2)}`
            );
          } else {
            resultAnchorDiagnostics.ai_override_after_enforcement = false;
          }

          resultAnchorDiagnostics.final_output_price = result.newPrice;

          if (decisionTrace) {
            decisionTrace.adjusted_target = result.newPrice;
            decisionTrace.final_target = result.newPrice;
            decisionTrace.delta = context.currentPrice
              ? Math.round((result.newPrice - context.currentPrice) * 1000) / 1000
              : null;
          }
        } else {
          // Filtered lowest does not justify a recapture — bypass.
          resultAnchorDiagnostics.ai_override_after_enforcement = false;
          resultAnchorDiagnostics.post_enforcement_override_reason = 'filtered_lowest_not_below_current';
          resultAnchorDiagnostics.final_output_price = result.newPrice;
          console.log(
            `[FINAL_ANCHOR_GUARD] BYPASSED (filtered-aware): asin=${targetAsin} filtered_lowest_fba=$${Number(filteredLowestFba ?? 0).toFixed(2)} raw_lowest_fba=$${Number(rawLowestFba ?? 0).toFixed(2)} current=$${context.currentPrice.toFixed(2)} reason=filtered_lowest_not_below_current`
          );
        }
      } else if (
        result.newPrice !== null
        && resultAnchorDiagnostics
        && resultAnchorDiagnostics.selected_anchor === 'smart_recapture'
        && (!rawAnchorEligibleForFinalGuard || finalFilteredRaiseSelectorActive)
      ) {
        resultAnchorDiagnostics.ai_override_after_enforcement = false;
        resultAnchorDiagnostics.post_enforcement_override_reason = finalFilteredRaiseSelectorActive
          ? 'final_filtered_raise_selector'
          : 'raw_anchor_filtered_out_for_raise';
        resultAnchorDiagnostics.final_output_price = result.newPrice;
        console.log(
          `[FINAL_ANCHOR_GUARD] BYPASSED: asin=${targetAsin} raw_lowest_fba=$${Number(resultAnchorDiagnostics.raw_lowest_fba ?? 0).toFixed(2)} filtered_lowest_fba=$${Number(positionProof.lowest_price_filtered ?? 0).toFixed(2)} reason=${resultAnchorDiagnostics.post_enforcement_override_reason}`,
        );
      }
    } else {
      console.log(`[TUNING_VERIFICATION] asin=${targetAsin} tuning_source=none mode=${result.mode} (skipped/monopoly/cooldown/raise)`);
    }

    const _tTuning = Date.now();
    // AGE OVERLAY — Removed (was no-op, no data populated)

    const _tAgeOverlay = Date.now();
    // ===================================================================
    // CRITICAL FIX: FINAL ROI VALIDATION GATE
    // This is the ABSOLUTE LAST check before a price is accepted.
    // It recalculates ROI using the FINAL proposed price and blocks
    // if the result violates the min ROI setting.
    // 
    // This prevents situations where AI tuning, undercut multipliers,
    // or other adjustments push the price below the ROI threshold.
    // ===================================================================
    if (result.newPrice !== null && enableProfitGuard && localCost && localCost > 0) {
      const finalPrice = result.newPrice;
      const feesToUse = estimatedFees || 0;
      const revenue = finalPrice;
      const profit = revenue - localCost - feesToUse;
      const calculatedRoi = (profit / localCost) * 100;
      if (calculatedRoi < effectiveMinRoiPercent) {
        console.log(`[FINAL ROI GUARD] analytics_only: Price $${finalPrice.toFixed(2)} yields ${calculatedRoi.toFixed(1)}% ROI (min: ${effectiveMinRoiPercent}%) — allowing because min/max are the only blocking bounds`);
      } else {
        console.log(`[FINAL ROI GUARD] PASSED: Price $${finalPrice.toFixed(2)} yields ${calculatedRoi.toFixed(1)}% ROI (min: ${effectiveMinRoiPercent}%)`);
      }
    }
    const _tGuards = Date.now();
    const _tPricing = Date.now();

    result = suppressUnsafeMinSuggestions(result, context);

    // ===================================================================
    // STOCK-GATED MAXIMIZE MODE
    // When available=0 but reserved>0 (FC transfer), do NOT allow normal
    // competitive lowering. If the computed result is flat/down, actively
    // force a recovery raise toward the next FBA / Buy Box corridor.
    // ===================================================================
    if (effectiveStockGatedMaximize && targetCurrentPrice) {
      const filteredGapAnchor = positionProof.lowest_price_filtered ?? null;
      const recoveryAnchor = context.smartRaise.lowestEligibleCompetitorPrice
        ?? filteredGapAnchor
        ?? resultAnchorDiagnostics.filtered_lowest_fba
        ?? null;
      const hasRecoveryOpportunity = Boolean(
        recoveryAnchor
        && recoveryAnchor > targetCurrentPrice + 0.02
      );
      const gapToNextFba = hasRecoveryOpportunity
        ? ((recoveryAnchor! - targetCurrentPrice) / targetCurrentPrice) * 100
        : 0;

      if (hasRecoveryOpportunity) {
        // In reserved-stock maximize mode, raise directly toward the next filtered competitor.
        // This is intentional pre-position pricing so returned stock doesn't sell too cheaply.
        let forcedRecoveryPrice = recoveryAnchor!;

        // GUARD: Do not raise above raw competitors if BB ownership is not confirmed
        const rawLowestForStockGate = positionProof.lowest_price_raw ?? null;
        const isBbOwnerForStockGate = (positionProof as any).is_bb_owner === true;
        const hasRawCompetitorBelow = rawLowestForStockGate != null && rawLowestForStockGate < forcedRecoveryPrice - 0.02;

        if (hasRawCompetitorBelow && !isBbOwnerForStockGate) {
          // Cap raise to current price (hold) — don't jump above active competitors without BB
          console.log(`[stock-gated-maximize] BLOCKED GAP RAISE: raw competitor at $${rawLowestForStockGate!.toFixed(2)} below target $${forcedRecoveryPrice.toFixed(2)} and BB not owned — holding at $${targetCurrentPrice.toFixed(2)}`);
          result = {
            ...result,
            mode: 'CUSTOM_PRICE',
            newPrice: targetCurrentPrice,
            reason: `Stock-gated hold: competitor at $${rawLowestForStockGate!.toFixed(2)} below raise target $${forcedRecoveryPrice.toFixed(2)} and BB not confirmed — holding $${targetCurrentPrice.toFixed(2)}`,
            guardsApplied: [...(result.guardsApplied || []), 'stock_gated_raise_blocked_competitor_below'],
          };
        } else {

        if (context.maxPrice && forcedRecoveryPrice > context.maxPrice) {
          forcedRecoveryPrice = context.maxPrice;
        }
        if (context.minPrice && forcedRecoveryPrice < context.minPrice) {
          forcedRecoveryPrice = context.minPrice;
        }

        forcedRecoveryPrice = Math.round(forcedRecoveryPrice * 100) / 100;

        if (forcedRecoveryPrice > targetCurrentPrice) {
          console.log(`[stock-gated-maximize] DIRECT GAP RAISE: current=$${targetCurrentPrice.toFixed(2)} filteredAnchor=$${recoveryAnchor!.toFixed(2)} forced=$${forcedRecoveryPrice.toFixed(2)} gap=${gapToNextFba.toFixed(1)}%`);
          result = {
            ...result,
            mode: 'SMART_RAISE',
            newPrice: forcedRecoveryPrice,
            rawTargetPrice: recoveryAnchor,
            reason: `Stock-gated recovery: direct raise from $${targetCurrentPrice.toFixed(2)} to filtered competitor $${recoveryAnchor!.toFixed(2)} while reserved stock is pending`,
            guardsApplied: [...(result.guardsApplied || []), 'stock_gated_recovery_direct_gap_raise'],
          };
        } else {
          result = {
            ...result,
            mode: 'CUSTOM_PRICE',
            newPrice: targetCurrentPrice,
            reason: `Stock-gated maximize: competitor gap detected but clamps held price at $${targetCurrentPrice.toFixed(2)}`,
            guardsApplied: [...(result.guardsApplied || []), 'stock_gated_maximize_clamped_hold'],
          };
        }
        } // end: no raw competitor below guard
      } else if (result.newPrice !== null && result.newPrice > targetCurrentPrice) {
        console.log(`[stock-gated-maximize] ALLOWING RAISE: $${targetCurrentPrice.toFixed(2)} → $${result.newPrice.toFixed(2)} (stock-gated maximize)`);
        result.guardsApplied = [...(result.guardsApplied || []), 'stock_gated_maximize_raise'];
        result.reason = `Stock-gated maximize: ${result.reason}`;
      } else if (result.newPrice !== null && result.newPrice < targetCurrentPrice) {
        console.log(`[stock-gated-maximize] BLOCKED LOWER without recovery: AI wanted $${result.newPrice.toFixed(2)} but no safe recovery target — keeping $${targetCurrentPrice.toFixed(2)}`);
        result = {
          ...result,
          mode: 'CUSTOM_PRICE',
          newPrice: targetCurrentPrice,
          reason: `Stock-gated (avail=0, reserved>0): blocked lower to $${result.newPrice.toFixed(2)}, keeping $${targetCurrentPrice.toFixed(2)} — no safe recovery target`,
          guardsApplied: [...(result.guardsApplied || []), 'stock_gated_maximize_block_lower'],
        };
      } else if (result.newPrice === null) {
        console.log(`[stock-gated-maximize] No change and no safe recovery target`);
        result.guardsApplied = [...(result.guardsApplied || []), 'stock_gated_maximize_no_change'];
      }
    }

    // AUTO-LOWER MIN PRICE — DISABLED
    // The auto floor lowering feature has been removed.
    // The repricer now uses a standard model:
    //   effective_floor = MAX(manual assignment min, ROI floor from rule)
    // No automatic min-price mutations are performed.
    // ===================================================================
    let autoFloorApplied = false;
    let autoFloorOldMin: number | null = null;
    let autoFloorNewMin: number | null = null;

    // ═══════════════════════════════════════════════════════════════════
    // PROFIT EXTRACTION MICRO-RAISE  (final-stage, nothing overrides this)
    // ═══════════════════════════════════════════════════════════════════
    // When we are winning/tied at the Buy Box AND the next quality-filtered
    // competitor is meaningfully above us, perform a small controlled raise.
    // This is a profit-recovery layer, not market-chasing.
    // Placement: AFTER all guards, stock-gated, auto-floor, ROI checks.
    //            BEFORE oscillation scoring and the final DB write.
    // Nothing downstream touches result.mode or result.newPrice.
    // ═══════════════════════════════════════════════════════════════════
    if (targetCurrentPrice != null && targetCurrentPrice > 0 && !isDryRun) {
      // For raise decisions, find the next competitor ABOVE current price
      const peFilteredAnchor: number | null = (() => {
        const candidates = [
          context.smartRaise.lowestEligibleCompetitorPrice,
          positionProof.lowest_price_filtered,
          resultAnchorDiagnostics.filtered_lowest_fba,
          positionProof.next_competitor_price,
        ].filter((p): p is number => p != null && p > targetCurrentPrice + 0.02);
        return candidates.length > 0 ? Math.min(...candidates) : null;
      })();

      const peBbPrice = snapshot?.buybox_price ?? null;
      const peBbGap = peBbPrice != null ? Math.abs(targetCurrentPrice - peBbPrice) : Infinity;
      const peIsBbOwner = isBuyboxOwner;
      const peIsNearBb = peBbGap <= 0.02;            // within $0.02
      const peIsRotating = peBbGap <= 0.015;          // within $0.015
      // NEW: If we are the lowest seller (raw or filtered), we're eligible for profit extraction
      // because being cheapest means BB will naturally rotate to us
      const peIsLowestSeller = Boolean(
        positionProof.am_i_lowest_raw === true
        || positionProof.am_i_lowest_filtered === true
      );
      const peFilteredLeaderRecovery = Boolean(
        positionProof.am_i_lowest_filtered === true
        && positionProof.filter_gap_warning
        && peFilteredAnchor != null
        && peFilteredAnchor > targetCurrentPrice + 0.03
      );
      const peWinningRule = peIsBbOwner
        ? 'bb_owner'
        : peIsNearBb
          ? 'near_buy_box'
          : peIsRotating
            ? 'bb_rotation'
            : peIsLowestSeller
              ? 'lowest_seller'
              : peFilteredLeaderRecovery
                ? 'filtered_leader_gap_override'
                : 'none';
      const peBbEligible = peWinningRule !== 'none';

      const peFilteredGap = peFilteredAnchor != null
        ? peFilteredAnchor - targetCurrentPrice
        : 0;
      const peFilteredGapPct = targetCurrentPrice > 0
        ? (peFilteredGap / targetCurrentPrice) * 100
        : 0;
      const peMeetsGapThreshold = peFilteredGap >= 0.30 || peFilteredGapPct >= 1.5;

      const peInCluster = positionProof.is_price_cluster === true;
      const peBbLossCount = assignment?.bb_loss_after_raise_count ?? 0;
      const peBbLossTooHigh = peBbLossCount >= 3;
      const peMaxCeiling = context.maxPrice ?? Number.POSITIVE_INFINITY;
      const peAtCeiling = targetCurrentPrice >= peMaxCeiling - 0.01;

      const peRaiseProtection = getProfitRaiseProtection({
        currentPrice: targetCurrentPrice,
        isBuyboxOwner: peIsBbOwner,
        inPriceCluster: peInCluster,
        rawLowestPrice: positionProof.lowest_price_raw ?? null,
      });

      // Only fire when the current result is a hold/skip/no-change
      const peCurrentDelta = result.newPrice != null
        ? Math.round((result.newPrice - targetCurrentPrice) * 100) / 100
        : 0;
      const peIsHoldOrSkip = result.mode === 'SKIP'
        || (result.newPrice !== null && Math.abs(peCurrentDelta) < 0.01)
        || (result.mode === 'CUSTOM_PRICE' && result.newPrice !== null && result.newPrice <= targetCurrentPrice + 0.005);

      if (!peRaiseProtection.isAllowed) {
        console.log(
          `[PROFIT_EXTRACTION_SNAP_RAISE] BLOCKED: asin=${targetAsin} current_price=$${targetCurrentPrice.toFixed(2)} blockers=${peRaiseProtection.blockers.join(',')} raw_lowest=$${positionProof.lowest_price_raw?.toFixed(2) ?? 'null'} buy_box_price=$${peBbPrice?.toFixed(2) ?? 'null'}`,
        );
      }

      const peShouldFire = Boolean(
        peBbEligible
        && peIsBbOwner
        && peFilteredAnchor != null
        && peMeetsGapThreshold
        && !peInCluster
        && !peBbLossTooHigh
        && !peAtCeiling
        && !peRaiseProtection.hasCompetitorAtOrBelowCurrent
        && peIsHoldOrSkip
        && context.smartRaise.enabled
      );

      if (peShouldFire) {
        // Snap directly to competitor - $0.01 for immediate profit capture
        // Compute raise offset for profit extraction (may need fresh context since PE can fire outside main eval scope)
        const _peRaiseOffset = computeRaiseOffset(buildRaiseOffsetContext(context, rule.smart_profile || 'CUSTOM'));
        const peCompetitorCeiling = applyRaiseOffset(peFilteredAnchor!, _peRaiseOffset);
        
        // FBM→FBM non-aggressive cap: never raise above the real FBM Buy Box
        const peIsFbmSeller = context.yourFulfillmentType === 'FBM';
        const peBbIsFbm = (buyboxSellerType as any) === 'FBM' || buyboxSellerType === null || (buyboxSellerType as any) === 'unknown';
        const peNonAggressiveProfiles = ['MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR', 'MATCH_BUYBOX', 'MATCH_LOWEST', 'SMART_MATCH', 'MOMENTUM_SMART'];
        const peCurrentProfile = rule.smart_profile || 'CUSTOM';
        const peIsFbmFbmCapped = peIsFbmSeller && peBbIsFbm && peNonAggressiveProfiles.includes(peCurrentProfile) && peBbPrice && peBbPrice > 0;
        
        let peEffectiveCeiling = peCompetitorCeiling;
        let peFbmBbCapApplied = false;
        if (peIsFbmFbmCapped && peBbPrice! > 0) {
          // FBM→FBM: never raise TO the Buy Box — stay just below it
          // Dynamic epsilon: $0.01 for <$20, $0.02 for $20-$50, $0.05 for $50+
          const peFbmEpsilon = peBbPrice! >= 50 ? 0.05 : peBbPrice! >= 20 ? 0.02 : 0.01;
          const peBbUndercut = Math.round((peBbPrice! - peFbmEpsilon) * 100) / 100;
          
          if (peCompetitorCeiling >= peBbPrice!) {
            // Would raise to or above BB — cap to just below BB
            peEffectiveCeiling = peBbUndercut;
            peFbmBbCapApplied = true;
            console.log(`[PROFIT_EXTRACTION_SNAP_RAISE] FBM→FBM cap: capping raise from $${peCompetitorCeiling.toFixed(2)} to $${peBbUndercut.toFixed(2)} (BB $${peBbPrice!.toFixed(2)} - epsilon $${peFbmEpsilon}) (profile=${peCurrentProfile})`);
          } else if (peCompetitorCeiling > peBbUndercut) {
            // Would raise above BB-epsilon but below BB — still cap
            peEffectiveCeiling = peBbUndercut;
            peFbmBbCapApplied = true;
            console.log(`[PROFIT_EXTRACTION_SNAP_RAISE] FBM→FBM cap: adjusted raise from $${peCompetitorCeiling.toFixed(2)} to $${peBbUndercut.toFixed(2)} (stay below BB $${peBbPrice!.toFixed(2)}) (profile=${peCurrentProfile})`);
          }
        }
        
        // === RAW BUY BOX CEILING FOR RAISES ===
        // Never raise above raw Buy Box price when filtered leader is higher.
        // The raw BB represents the real competitive landscape; filtered can exclude valid competitors.
        let peRawBbCeiling = peMaxCeiling;
        let peRawBbCapApplied = false;
        if (peBbPrice != null && peBbPrice > 0 && peFilteredLeaderRecovery) {
          // When filtered leader > raw BB, cap at raw BB - epsilon (stay competitive)
          const peRawBbEpsilon = peBbPrice >= 50 ? 0.05 : peBbPrice >= 20 ? 0.02 : 0.01;
          peRawBbCeiling = Math.round((peBbPrice - peRawBbEpsilon) * 100) / 100;
          peRawBbCapApplied = peEffectiveCeiling > peRawBbCeiling;
          if (peRawBbCapApplied) {
            console.log(
              `[PROFIT_EXTRACTION_SNAP_RAISE] RAW_BB_CAP: capping raise from $${peEffectiveCeiling.toFixed(2)} to $${peRawBbCeiling.toFixed(2)} (raw BB $${peBbPrice.toFixed(2)}, filtered leader $${peFilteredAnchor!.toFixed(2)}) — never raise above real market`
            );
            peEffectiveCeiling = peRawBbCeiling;
          }
        }

        const peFinalTargetBeforeValidation = Math.round(
          Math.min(peEffectiveCeiling, peMaxCeiling) * 100
        ) / 100;
        let peFinalTarget = peFinalTargetBeforeValidation;

        // Enforce minimum floor
        if (context.minPrice && peFinalTarget < context.minPrice) {
          peFinalTarget = context.minPrice;
        }
        peFinalTarget = Math.round(peFinalTarget * 100) / 100;

        const peFinalDelta = Math.round((peFinalTarget - targetCurrentPrice) * 100) / 100;

        console.log(
          `[PROFIT_EXTRACTION_SNAP_RAISE] asin=${targetAsin} current_price=${targetCurrentPrice.toFixed(2)} buy_box_price=${peBbPrice?.toFixed(2) ?? 'null'} filtered_anchor_price=${peFilteredAnchor!.toFixed(2)} filtered_gap=${peFilteredGap.toFixed(2)} gap_pct=${peFilteredGapPct.toFixed(1)}% snap_target=${peCompetitorCeiling.toFixed(2)} fbm_bb_cap=${peFbmBbCapApplied} raw_bb_cap=${peRawBbCapApplied} effective_ceiling=${peEffectiveCeiling.toFixed(2)} final_target=${peFinalTarget.toFixed(2)} final_delta=${peFinalDelta.toFixed(2)} final_winning_rule=${peWinningRule} bb_loss_count=${peBbLossCount}`
        );

        if (peFinalDelta >= 0.01) {
          result = {
            ...result,
            mode: 'SMART_RAISE',
            newPrice: peFinalTarget,
            rawTargetPrice: peCompetitorCeiling,
            reason: peFbmBbCapApplied
              ? `FBM→FBM raise: staying below FBM Buy Box $${peBbPrice!.toFixed(2)} (target $${peFinalTarget.toFixed(2)}, filtered leader $${peFilteredAnchor!.toFixed(2)}) — raising $${targetCurrentPrice.toFixed(2)} → $${peFinalTarget.toFixed(2)}`
              : peRawBbCapApplied
              ? `Profit extraction: capped at raw Buy Box $${peBbPrice?.toFixed(2) ?? 'n/a'} (filtered leader $${peFilteredAnchor!.toFixed(2)} excluded) — raising $${targetCurrentPrice.toFixed(2)} → $${peFinalTarget.toFixed(2)}`
              : peFilteredLeaderRecovery
              ? `Profit extraction: raw Buy Box $${peBbPrice?.toFixed(2) ?? 'n/a'} filtered out, eligible leader $${peFilteredAnchor!.toFixed(2)} (gap $${peFilteredGap.toFixed(2)}) — raising $${targetCurrentPrice.toFixed(2)} → $${peFinalTarget.toFixed(2)}`
              : `Profit extraction: BB ${peIsBbOwner ? 'owner' : `near ($${peBbPrice?.toFixed(2)})`}, next eligible $${peFilteredAnchor!.toFixed(2)} (gap $${peFilteredGap.toFixed(2)}) — raising $${targetCurrentPrice.toFixed(2)} → $${peFinalTarget.toFixed(2)}`,
            guardsApplied: [
              ...(result.guardsApplied || []).filter(
                (g: string) => g !== 'bb_rotation_patience'
                  && g !== 'floor_blocked_micro_step'
                  && g !== 'self_undercut_guard'
                  && g !== 'cluster_hold'
              ),
              ...(peFilteredLeaderRecovery ? ['raw_anchor_filtered_out_for_raise'] : []),
              ...(peFbmBbCapApplied ? ['fbm_fbm_bb_raise_cap'] : []),
              ...(peRawBbCapApplied ? ['raw_bb_ceiling_cap'] : []),
              'profit_extraction_micro_raise',
            ],
            isRaise: true,
          };
        } else {
          console.log(
            `[PROFIT_EXTRACTION_MICRO_RAISE] SKIPPED: delta ${peFinalDelta.toFixed(2)} < $0.01 after clamping`
          );
        }
      }
    }

    // ═══ MARKET VOLATILITY — distinguishes external churn from self-chasing ═══
    // Reads recent competitor snapshots and classifies the market as
    // calm | active | chaotic. Used below to soften oscillation penalties when
    // many competitors are also repricing rapidly (healthy churn ≠ self-war).
    let marketVolatility: ReturnType<typeof scoreMarketVolatility> = {
      score: 0, state: 'calm',
      competitorChurnRate: 0, bbRotationRate: 0,
      lowestFbaDriftPerHour: 0, spreadVariance: 0,
      signals: {}, windowMinutes: 60, sampleCount: 0,
    };
    if (!isDryRun && assignment) {
      try {
        const mvCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: snapRows } = await supabase
          .from('repricer_competitor_snapshots')
          .select('fetched_at, buybox_price, buybox_seller_id, lowest_fba_price, lowest_overall_price, offers_count')
          .eq('user_id', userId)
          .eq('asin', targetAsin)
          .eq('marketplace', targetMarketplace)
          .gte('fetched_at', mvCutoff)
          .order('fetched_at', { ascending: true })
          .limit(60);
        marketVolatility = scoreMarketVolatility(snapRows || [], 60);
        console.log(`[MARKET_VOLATILITY] asin=${targetAsin} score=${marketVolatility.score} state=${marketVolatility.state} churn=${marketVolatility.competitorChurnRate}/h rotation=${marketVolatility.bbRotationRate}/h drift=$${marketVolatility.lowestFbaDriftPerHour}/h samples=${marketVolatility.sampleCount}`);
      } catch (mvErr) {
        console.error(`[MARKET_VOLATILITY] Scoring error for ${targetAsin}:`, mvErr);
      }
    }

    // ═══ OSCILLATION SCORING — classifies market state per ASIN ═══
    let oscState: 'stable' | 'volatile' | 'war' = 'stable';
    let oscMode: 'aggressive' | 'balanced' | 'safe' = 'aggressive';
    let oscScore = 0; // 0–10 scale, higher = more volatile
    const oscReasonParts: string[] = [];

    if (!isDryRun && assignment) {
      try {
        // Query recent price actions for this ASIN in last 60 minutes
        const oscCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: recentActions } = await supabase
          .from('repricer_price_actions')
          .select('old_price, new_price, created_at, action_type')
          .eq('user_id', userId)
          .eq('asin', targetAsin)
          .eq('marketplace', targetMarketplace)
          .gte('created_at', oscCutoff)
          .order('created_at', { ascending: true })
          .limit(30);

        const actions = recentActions || [];
        const priceChanges = actions.filter((a: any) =>
          a.old_price && a.new_price && Math.abs(a.new_price - a.old_price) >= 0.01
        );

        // Signal 1: Price change frequency (more changes = more volatile)
        if (priceChanges.length >= 6) { oscScore += 3; oscReasonParts.push(`high_freq_${priceChanges.length}`); }
        else if (priceChanges.length >= 3) { oscScore += 1; oscReasonParts.push(`mod_freq_${priceChanges.length}`); }

        // Signal 2: Direction reversals (up→down or down→up = bot war signature)
        let reversals = 0;
        for (let i = 1; i < priceChanges.length; i++) {
          const prevDir = (priceChanges[i - 1] as any).new_price - (priceChanges[i - 1] as any).old_price;
          const currDir = (priceChanges[i] as any).new_price - (priceChanges[i] as any).old_price;
          if ((prevDir > 0 && currDir < 0) || (prevDir < 0 && currDir > 0)) reversals++;
        }
        if (reversals >= 3) { oscScore += 3; oscReasonParts.push(`reversals_${reversals}`); }
        else if (reversals >= 1) { oscScore += 1; oscReasonParts.push(`reversals_${reversals}`); }

        // Signal 3: BB loss after raise (repeated losses suggest war)
        // SKIP when BB is suppressed — cannot "lose" a non-existent Buy Box
        const isBbSuppressed = context.isBuyboxSuppressed; // canonical definition (line 5246) — !snapshot?.buybox_price && offers.length > 0
        const bbLossCount = assignment?.bb_loss_after_raise_count || 0;
        if (!isBbSuppressed) {
          if (bbLossCount >= 5) { oscScore += 3; oscReasonParts.push(`bb_loss_streak_${bbLossCount}`); }
          else if (bbLossCount >= 2) { oscScore += 1; oscReasonParts.push(`bb_loss_streak_${bbLossCount}`); }
        }

        // Signal 4: Buy Box churn — lost BB recently and price is above competitor
        // SKIP when BB is suppressed — no BB to lose/win
        if (!isBbSuppressed && !isBuyboxOwner && lowestFiltered != null && (targetCurrentPrice ?? 0) > lowestFiltered * 1.02) {
          oscScore += 1; oscReasonParts.push('losing_bb_above_competitor');
        }

        // Signal 5: Rapid price instability from guards
        const hasWarProtection = result.guardsApplied?.includes('WAR_PROTECTION_HOLD');
        if (hasWarProtection) { oscScore += 2; oscReasonParts.push('war_protection_active'); }

        // Apply user's AI style preference bias
        const aiStyle = (rule?.ai_settings as any)?.oscillation_ai_style || 'balanced';
        if (aiStyle === 'conservative') oscScore += 1; // More sensitive
        else if (aiStyle === 'aggressive') oscScore = Math.max(0, oscScore - 1); // Less sensitive

        // ─── MARKET-VOLATILITY SOFTENING ──────────────────────────────────
        // When the external market itself is churning (many fast repricers),
        // do not punish our own activity as if we were self-chasing. Reduce
        // the score and raise the war/volatile thresholds. Calm markets are
        // unaffected — destructive self-chasing still trips the score normally.
        const oscScoreBeforeMv = oscScore;
        if (marketVolatility.state === 'chaotic') {
          oscScore = Math.max(0, oscScore - 2);
          oscReasonParts.push(`mv_chaotic_-2(score=${marketVolatility.score})`);
        } else if (marketVolatility.state === 'active') {
          oscScore = Math.max(0, oscScore - 1);
          oscReasonParts.push(`mv_active_-1(score=${marketVolatility.score})`);
        }

        // ─── PRODUCTIVITY SIGNAL ──────────────────────────────────────────
        // If our last move narrowed the gap to BB (or we now own/match it),
        // shave one more point — it was a healthy, productive change, not churn.
        const curPriceCents = (targetCurrentPrice ?? 0) > 0 ? Math.round((targetCurrentPrice as number) * 100) : null;
        const bbCents = context.buyboxPrice != null ? Math.round(context.buyboxPrice * 100) : null;
        const productive = wasMoveProductive(
          assignment.last_position_gap_cents ?? null,
          curPriceCents,
          bbCents,
          isBuyboxOwner,
        );
        if (productive && oscScore > 0) {
          oscScore = Math.max(0, oscScore - 1);
          oscReasonParts.push('productive_move_-1');
        }

        // Adaptive thresholds: chaotic markets get more headroom before war/volatile
        const warThresh = marketVolatility.state === 'chaotic' ? 7 : marketVolatility.state === 'active' ? 6 : 5;
        const volThresh = marketVolatility.state === 'chaotic' ? 5 : marketVolatility.state === 'active' ? 4 : 3;

        // Classify state
        if (oscScore >= warThresh) {
          oscState = 'war';
          oscMode = 'safe';
        } else if (oscScore >= volThresh) {
          oscState = 'volatile';
          oscMode = 'balanced';
        } else {
          oscState = 'stable';
          oscMode = 'aggressive';
        }
        if (oscScoreBeforeMv !== oscScore) {
          console.log(`[OSCILLATION_MV_ADJUST] asin=${targetAsin} ${oscScoreBeforeMv}→${oscScore} (mv=${marketVolatility.state}, productive=${productive}, thresholds: war≥${warThresh}, vol≥${volThresh})`);
        }

        // Stability Decay: if market is calm (no recent changes, BB owned), downgrade from prior state
        const priorState = assignment.oscillation_state;
        if (priorState === 'war' && oscState === 'stable' && priceChanges.length === 0 && isBuyboxOwner) {
          oscState = 'volatile'; // Gradual decay: war → volatile → stable
          oscMode = 'balanced';
          oscReasonParts.push('decay_war_to_volatile');
        }

        console.log(`[OSCILLATION] asin=${targetAsin} score=${oscScore} state=${oscState} mode=${oscMode} signals=[${oscReasonParts.join(',')}] prior=${priorState || 'none'}`);
      } catch (oscErr) {
        console.error(`[OSCILLATION] Scoring error for ${targetAsin}:`, oscErr);
        // Non-fatal: default to stable/aggressive
      }
    }

    // Always update last_evaluated_at so "Last checked" banner reflects this evaluation
    // Track consecutive_zero_offers streak for dynamic backoff in dispatcher
    const isNoCompetitors = result.guardsApplied?.includes('no_competitors');
    if (!isDryRun && assignment) {
      const assignmentUpdate: Record<string, any> = {
        last_evaluated_at: new Date().toISOString(),
        last_recommended_price: result.newPrice,
        last_recommendation_reason: result.reason,
        // Real fetch-chain diagnostics for the Action Log UI — previously
        // these columns existed but nothing wrote them, so the panel showed
        // a frozen/legacy value forever regardless of what actually happened.
        last_data_source: dataSourceForDiagnostics,
        last_trigger_source: context.triggerSource ?? assignment.last_trigger_source ?? null,
        // Only touch last_throttle_at when THIS cycle was actually throttled,
        // so it keeps tracking "most recent real throttle event" over time
        // instead of being blanked out by every unrelated successful cycle.
        ...(dataSourceForDiagnostics === 'throttled' ? { last_throttle_at: new Date().toISOString() } : {}),
        // Clear skip reason on successful evaluation
        last_skip_reason: null,
        last_skip_lane: null,
        last_skip_details: null,
        // Oscillation scoring results
        oscillation_state: oscState,
        oscillation_last_mode_used: oscMode,
        anomaly_score: oscScore,
        // Market volatility awareness (Gap #1 — competitor churn vs self-chasing)
        market_volatility_score: marketVolatility.score,
        market_state: marketVolatility.state,
        competitor_churn_rate: marketVolatility.competitorChurnRate,
        bb_rotation_rate: marketVolatility.bbRotationRate,
        market_volatility_signals: {
          ...marketVolatility.signals,
          lowest_fba_drift_per_hour: marketVolatility.lowestFbaDriftPerHour,
          spread_variance: marketVolatility.spreadVariance,
          window_minutes: marketVolatility.windowMinutes,
          sample_count: marketVolatility.sampleCount,
        },
        market_volatility_checked_at: new Date().toISOString(),
        last_position_gap_cents: (() => {
          const cur = (targetCurrentPrice ?? 0) > 0 ? Math.round((targetCurrentPrice as number) * 100) : null;
          const bb = context.buyboxPrice != null ? Math.round(context.buyboxPrice * 100) : null;
          if (cur == null || bb == null) return assignment.last_position_gap_cents ?? null;
          return Math.max(0, cur - bb);
        })(),
      };

      // Update last_stable_price when transitioning to stable
      if (oscState === 'stable' && assignment.oscillation_state !== 'stable' && (targetCurrentPrice ?? 0) > 0) {
        assignmentUpdate.last_stable_price = targetCurrentPrice;
      }

      // Track oscillation detection timestamp
      if (oscState !== 'stable' && assignment.oscillation_state === 'stable') {
        assignmentUpdate.oscillation_detected_at = new Date().toISOString();
        assignmentUpdate.oscillation_count = (assignment.oscillation_count || 0) + 1;
      }

      if (isNoCompetitors) {
        // Increment streak — dispatcher uses this for progressive backoff
        assignmentUpdate.consecutive_zero_offers = (assignment.consecutive_zero_offers || 0) + 1;
      } else {
        // Reset streak on any non-no_competitors evaluation
        assignmentUpdate.consecutive_zero_offers = 0;
      }

      // === FLOOR BLOCKED CYCLES TRACKING (Adaptive Floor Relaxation) ===
      const wasFloorBlocked = result.guardsApplied?.some((g: string) => 
        g === 'FINAL_CLAMP_MIN' || g === 'min_price' || g === 'floor_blocked_micro_step' || g === 'at_floor'
      );
      if (wasFloorBlocked && !isBuyboxOwner) {
        assignmentUpdate.floor_blocked_cycles = (assignment.floor_blocked_cycles || 0) + 1;
      } else {
        // Reset when floor is NOT blocking or when we win BB
        assignmentUpdate.floor_blocked_cycles = 0;
      }

      // === BB RECOVERY ESCALATION TRACKING ===
      if (!isBuyboxOwner && bbLossDurationMinutes > 30) {
        // Escalate based on duration tiers
        const newEscalation = bbLossDurationMinutes > 120 ? 3 : bbLossDurationMinutes > 60 ? 2 : 1;
        assignmentUpdate.bb_recovery_escalation = newEscalation;
      } else if (isBuyboxOwner) {
        // Reset when BB is won back
        assignmentUpdate.bb_recovery_escalation = 0;
      }

      // === CONSECUTIVE FAILED UNDERCUTS TRACKING (Step Escalation) ===
      // A "failed undercut" = we lowered price but still don't own BB on next eval
      const currentDirection = result.newPrice && targetCurrentPrice 
        ? (result.newPrice < targetCurrentPrice ? 'down' : result.newPrice > targetCurrentPrice ? 'up' : null)
        : null;
      const wasDownward = currentDirection === 'down';
      const stillLosing = !isBuyboxOwner;
      
      if (wasDownward && stillLosing) {
        assignmentUpdate.consecutive_failed_undercuts = (assignment.consecutive_failed_undercuts || 0) + 1;
      } else if (isBuyboxOwner || currentDirection === 'up') {
        // Reset on BB win or any upward move
        assignmentUpdate.consecutive_failed_undercuts = 0;
      }

      // === ANTI-FLIP DIRECTION TRACKING ===
      if (currentDirection) {
        const prevDirection = assignment.last_price_direction;
        if (prevDirection && currentDirection !== prevDirection) {
          // Direction changed — record when
          assignmentUpdate.direction_changed_at = new Date().toISOString();
        }
        assignmentUpdate.last_price_direction = currentDirection;
      }

      await supabase
        .from('repricer_assignments')
        .update(assignmentUpdate)
        .eq('id', assignment.id);
    }

    // ── PER-DECISION LOG (always, except dry-runs) ──
    // This is the authoritative real-time decision log feeding AI Insights.
    // We log HOLDs, BLOCKED, RAISE, UNDERCUT — every evaluation outcome — so the
    // historical view stays aligned with the live engine (no daily aggregator lag).
    if (!isDryRun) {
      const decisionPayload = {
        user_id: userId,
        assignment_id: assignment?.id,
        asin: targetAsin,
        sku: targetSku,
        marketplace: targetMarketplace,
        rule_id: rule.id,
        current_price: targetCurrentPrice,
        buybox_price: snapshot?.buybox_price,
        buybox_seller_type: buyboxSellerType,
        lowest_fba_price: snapshot?.lowest_fba_price,
        lowest_fbm_price: snapshot?.lowest_fbm_price,
        lowest_overall_price: snapshot?.lowest_overall_price,
        offers_count: context.offersCount,
        is_only_seller: context.isOnlySeller,
        is_buybox_eligible: context.isBuyboxEligible,
        is_buybox_suppressed: context.isBuyboxSuppressed,
        is_backordered: context.isBackordered,
        mode: result.mode,
        new_price: result.newPrice,
        price_delta: result.newPrice != null && targetCurrentPrice != null ? result.newPrice - targetCurrentPrice : null,
        reason: result.reason,
        ai_aggressiveness: result.aiAggressiveness,
        ai_note: result.aiNote,
        ai_model: result.aiAggressiveness ? 'deterministic_v2' : null,
        min_price_used: context.minPrice,
        max_price_used: context.maxPrice,
        cooldown_applied: result.guardsApplied?.includes('cooldown') || false,
        max_step_applied: result.guardsApplied?.includes('max_step') || false,
        min_price_clamped: result.guardsApplied?.includes('FINAL_CLAMP_MIN') || result.guardsApplied?.includes('MIN_PRICE_SUGGESTION') || false,
        // Momentum Smart V2 raise-safety gates (see _v2gates.ts) -- distinct
        // signals so the Rule Performance dashboard can separate "blocked by
        // the 2h cooldown" from "rejected for lack of floor support" rather
        // than lumping both into one raise-safety bucket.
        raise_blocked_cooldown: result.guardsApplied?.includes('post_raise_cooldown_active') || false,
        raise_rejected_floor_support: result.guardsApplied?.includes('market_supported_raise_rejected') || false,
        competitive_price: result.rawTargetPrice,
        suggested_min_price: result.suggestedNewMinPrice ?? null,
        min_gap_amount: result.minGapAmount ?? null,
        min_gap_percent: result.minGapPercent ?? null,
      };

      console.info(`[decision-log] insert attempted for ${targetAsin}`, {
        asin: targetAsin,
        marketplace: targetMarketplace,
        mode: result.mode,
        has_new_price: decisionPayload.new_price != null,
      });

      try {
        const { error: decisionLogError } = await supabase.from('repricer_ai_decisions').insert(decisionPayload);

        if (decisionLogError) {
          console.error(`[decision-log] insert failed for ${targetAsin}`, {
            message: decisionLogError.message,
            code: decisionLogError.code,
            details: decisionLogError.details,
            hint: decisionLogError.hint,
          });
        } else {
          console.info(`[decision-log] insert succeeded for ${targetAsin}`, {
            asin: targetAsin,
            marketplace: targetMarketplace,
            mode: result.mode,
          });
        }
      } catch (logErr) {
        console.error(`[decision-log] unexpected failure for ${targetAsin}:`, logErr);
      }
    }

    const _tWrites = Date.now();

    // === EVAL TIMING BREAKDOWN (ChatGPT requested — granular) ===
    const _tEnd = Date.now();
    console.log(`[eval-timing] asin=${targetAsin} total_ms=${_tEnd - _t0} context_ms=${_tContext - _t0} sp_api_ms=${_tSpApi - _tContext} rolling_ms=${_tRolling - _tSpApi} intel_ms=${_tIntel - _tRolling} pricing_ms=${_tPricing - _tIntel} write_ms=${_tWrites - _tPricing} mode=${result.mode}`);
    console.log(`[eval-timing-detail] asin=${targetAsin} core_pricing_ms=${_tCorePricing - _tCorePricing0} tuning_ms=${_tTuning - _tCorePricing} age_overlay_ms=${_tAgeOverlay - _tTuning} roi_guard_ms=${_tGuards - _tAgeOverlay} db_update_ms=${_tWrites - _tPricing} assignment_write_ms=${_tWrites - _tPricing}`);

    console.log(`[repricer-ai-evaluate] Result for ${targetAsin}:`, {
      mode: result.mode,
      currentPrice: targetCurrentPrice,
      newPrice: result.newPrice,
      reason: result.reason,
      tuning_source,
      enhanced_multiplier,
      combined_multiplier,
      enhanced_factors,
      intelligence: {
        velocity: intelligence.salesVelocityScore,
        bbWinRate: intelligence.buyboxWinRate,
        urgency: intelligence.urgencyScore,
      },
    });

    // === BUILD STRUCTURED REASON CODES (ChatGPT recommendation) ===
    // These codes make every action log entry instantly readable without guessing
    const offersArray = offers || [];
    const offersEmpty = offersArray.length === 0;
    const spApiFailed = !usedSpApi && !snapshot;
    
    // Determine anchor_source
    let anchor_source: string = 'skip';
    if (result.mode === 'AI_REPRICE' || result.mode === 'CUSTOM_PRICE') {
      const bbSrc = snapshot?.bb_source || 'missing';
      if (bbSrc === 'winner_offer' && snapshot?.buybox_price) {
        anchor_source = 'buybox_winner_offer';
      } else if (bbSrc === 'summary_fallback' && snapshot?.buybox_price) {
        anchor_source = 'buybox_summary';
      } else if (snapshot?.lowest_fba_price || snapshot?.lowest_overall_price) {
        anchor_source = 'lowest_eligible';
      } else {
        anchor_source = 'skip_no_data';
      }
    } else if (result.mode === 'SMART_RAISE') {
      anchor_source = 'smart_raise';
    } else if (result.mode === 'MONOPOLY_RAISE') {
      anchor_source = 'monopoly_raise';
    } else if (result.mode === 'MIN_PRICE') {
      anchor_source = 'min_price';
    }
    // Hard override: FBM lowest-seller mode is the executed anchor regardless of BB presence
    const _g = result.guardsApplied || [];
    if (_g.includes('fbm_compete_lowest_fbm')
        || _g.includes('lowest_seller_mode_disable_raise')
        || _g.includes('effective_fbm_competition_mode=lowest_seller')) {
      anchor_source = 'lowest_fbm';
    }
    
    // Determine offers_status
    let offers_status: string = 'ok';
    if (spApiFailed) {
      offers_status = 'sp_api_failed';
    } else if (offersEmpty && usedSpApi) {
      offers_status = 'quota_exceeded';
    } else if (!snapshot?.buybox_price && offersArray.length > 0) {
      offers_status = 'suppressed_bb';
    } else if (!snapshot) {
      offers_status = 'empty';
    }
    
    // Build filters_applied list
    const filters_applied: string[] = [];
    for (const g of result.guardsApplied || []) {
      if (g.startsWith('fbm_ignored')) filters_applied.push('fbm_ignored');
      if (g.startsWith('quality_filter')) filters_applied.push('quality_filter');
      if (g === 'profit_guard') filters_applied.push('profit_guard');
      if (g === 'effective_floor') filters_applied.push('effective_floor');
      if (g === 'max_step') filters_applied.push('max_step');
      if (g === 'FINAL_CLAMP_MIN') filters_applied.push('clamp_min');
      if (g === 'FINAL_CLAMP_MAX') filters_applied.push('clamp_max');
      if (g === 'bb_no_data_hold') filters_applied.push('bb_no_data_hold');
      if (g === 'bb_confidence_guard') filters_applied.push('bb_confidence_guard');
      if (g === 'FINAL_ROI_GUARD_BLOCKED') filters_applied.push('roi_guard_blocked');
    }
    // Deduplicate
    const uniqueFilters = [...new Set(filters_applied)];
    
    // BB confidence level
    const bb_confidence = (snapshot?.bb_source === 'winner_offer') ? 'high' 
      : (snapshot?.bb_source === 'summary_fallback') ? 'medium'
      : 'low';

    const reason_codes = {
      anchor_source,
      offers_status,
      filters_applied: uniqueFilters,
      bb_confidence,
      offers_count_raw: offersArray.length,
      offers_count_after_filter: result.mode === 'AI_REPRICE' ? (offersArray.length - Number(result.guardsApplied?.find((g: string) => g.startsWith('quality_filter'))?.split('_').pop() || 0)) : null,
      tuning_source,
      enhanced_multiplier,
      combined_multiplier,
    };

    // === STRATEGY VISIBILITY: Determine if strategy actually influenced the decision ===
    const profileLabel = PROFILE_KEY_TO_LABEL[smartProfile] || smartProfile;
    const allGuards = result.guardsApplied || [];
    
    // Determine dominant decision layer
    const overrideGuards: Record<string, string> = {
      'stock_gated': 'stock_gated',
      'cluster_match_override': 'cluster_override',
      'cluster_rotating_bb_protection': 'cluster_override',
      'bb_owner_protection': 'bb_owner_hold',
      'fbm_gap_recapture_raise': 'fbm_gap_recapture',
      'bb_eligibility_bypass': 'bb_eligibility',
      'min_price': 'safeguard',
      'max_price': 'safeguard',
      'FINAL_CLAMP_MIN': 'clamp',
      'FINAL_CLAMP_MAX': 'clamp',
      'effective_floor': 'profit_guard',
      'universal_floor_guard': 'profit_guard',
      'bb_owner_floor_recovery': 'profit_guard',
      'universal_floor_recovery': 'profit_guard',
      'profit_guard': 'profit_guard',
      'cooldown': 'cooldown',
      'anti_flip_cooldown': 'cooldown',
      'monopoly_cooldown': 'cooldown',
      'no_competitors': 'no_competition',
    };
    
    let dominant_layer = 'strategy';
    for (const guard of allGuards) {
      for (const [key, layer] of Object.entries(overrideGuards)) {
        if (guard.includes(key)) {
          dominant_layer = layer;
          break;
        }
      }
      if (dominant_layer !== 'strategy') break;
    }
    
    const strategy_influenced = dominant_layer === 'strategy';
    const base_undercut = rule.undercut_amount ?? 0;
    const effective_undercut = context.undercutAmount ?? base_undercut;

    // === FULFILLMENT VISIBILITY: FBM vs FBA awareness logging ===
    const my_offer_type: 'FBA' | 'FBM' | 'unknown' = context.yourFulfillmentType || 'unknown';
    const buybox_offer_type: 'FBA' | 'FBM' | 'Amazon' | 'unknown' = buyboxSellerType || 'unknown';

    const competitorOffers = offers.filter((o: any) => !o.is_self && !(context.yourSellerId && o.seller_id === context.yourSellerId));
    const competitorHasFba = competitorOffers.some((o: any) => o.is_fba === true);
    const competitorHasFbm = competitorOffers.some((o: any) => o.is_fba === false);
    const competitor_types_summary: 'FBA_only' | 'FBM_only' | 'mixed' | 'unknown' = competitorHasFba && competitorHasFbm
      ? 'mixed'
      : competitorHasFba
      ? 'FBA_only'
      : competitorHasFbm
      ? 'FBM_only'
      : 'unknown';

    const anchor_source_key = (reason_codes.anchor_source || 'unknown') as string;
    const findOfferByPrice = (price: number | null | undefined, scope: 'all' | 'fba' | 'fbm' = 'all') => {
      if (price == null) return null;
      return competitorOffers.find((offer: any) => {
        const totalPrice = offer.total_price ?? offer.price;
        if (typeof totalPrice !== 'number') return false;
        if (Math.abs(totalPrice - price) > 0.01) return false;
        if (scope === 'fba') return offer.is_fba === true;
        if (scope === 'fbm') return offer.is_fba === false;
        return true;
      }) || null;
    };

    const inferredAnchorOffer = (() => {
      switch (anchor_source_key) {
        case 'buybox_winner_offer':
        case 'buybox_summary':
        case 'buybox':
          return findOfferByPrice(snapshot?.buybox_price ?? null, buybox_offer_type === 'FBA' || buybox_offer_type === 'Amazon' ? 'fba' : buybox_offer_type === 'FBM' ? 'fbm' : 'all');
        case 'lowest_fba':
        case 'smart_raise':
          return findOfferByPrice(snapshot?.lowest_fba_price ?? null, 'fba');
        case 'fbm_target':
          return findOfferByPrice(snapshot?.lowest_fbm_price ?? null, 'fbm');
        case 'lowest_eligible':
        case 'lowest_offer': {
          const offer = findOfferByPrice(positionProof?.lowest_price_filtered ?? null, 'all')
            || findOfferByPrice(positionProof?.lowest_price_raw ?? null, 'all')
            || findOfferByPrice(result.rawTargetPrice ?? null, 'all');
          return offer;
        }
        default:
          return findOfferByPrice(result.rawTargetPrice ?? null, 'all');
      }
    })();

    const anchor_offer_type: 'FBA' | 'FBM' | 'mixed' | 'unknown' = (() => {
      if (anchor_source_key === 'lowest_fba' || anchor_source_key === 'smart_raise') return 'FBA';
      if (anchor_source_key === 'fbm_target') return 'FBM';
      if (anchor_source_key.startsWith('buybox')) {
        if (buybox_offer_type === 'Amazon') return 'FBA';
        if (buybox_offer_type === 'FBA' || buybox_offer_type === 'FBM') return buybox_offer_type;
      }
      if (inferredAnchorOffer) return inferredAnchorOffer.is_fba ? 'FBA' : 'FBM';
      if (anchor_source_key === 'lowest_eligible' || anchor_source_key === 'lowest_offer') {
        if (competitor_types_summary === 'FBA_only') return 'FBA';
        if (competitor_types_summary === 'FBM_only') return 'FBM';
        if (competitor_types_summary === 'mixed') return 'mixed';
      }
      return 'unknown';
    })();

    // Determine fulfillment mode path
    const fulfillment_mode_path: 'fba_vs_fba' | 'fbm_vs_fba' | 'fbm_vs_fbm' | 'mixed_market' | 'unknown' = (() => {
      if (my_offer_type === 'unknown') return 'unknown';
      if (my_offer_type === 'FBA') {
        if (buybox_offer_type === 'FBM') return 'mixed_market';
        return 'fba_vs_fba';
      }
      // FBM seller
      if (competitor_types_summary === 'FBM_only') return 'fbm_vs_fbm';
      if (competitor_types_summary === 'FBA_only') return 'fbm_vs_fba';
      if (competitor_types_summary === 'mixed') return 'mixed_market';
      if (buybox_offer_type === 'FBA' || buybox_offer_type === 'Amazon') return 'fbm_vs_fba';
      if (buybox_offer_type === 'FBM') return 'fbm_vs_fbm';
      // Check competitor mix
      const hasFbaCompetitors = intelligence.fbaCompetitorCount > 0 || offers.some((o: any) => o.is_fba);
      if (hasFbaCompetitors) return 'fbm_vs_fba';
      return 'fbm_vs_fbm';
    })();

    // Track FBM-specific adjustments
    const fbm_adjustments: string[] = [];
    for (const g of allGuards) {
      if (g === 'fbm_cluster_bypass') fbm_adjustments.push('cluster_matching_weakened');
      if (g.includes('fbm_ignored')) fbm_adjustments.push('fbm_offers_filtered');
      if (g === 'fbm_premium_mode') fbm_adjustments.push('fbm_premium_pricing');
      if (g === 'bb_eligible_soft_fbm') fbm_adjustments.push('bb_eligibility_soft_signal');
      if (g === 'fbm_competitive_hold') fbm_adjustments.push('competitive_threshold_hold');
      if (g === 'fbm_aggressive_descent') fbm_adjustments.push('competitive_threshold_aggressive_descent');
      if (g === 'fbm_competitive_pass') fbm_adjustments.push('competitive_gap_sufficient');
      if (g === 'fbm_compete_lowest_fbm') fbm_adjustments.push('compete_with_lowest_fbm');
      if (g === 'fbm_lower_competitor_blocks_raise') fbm_adjustments.push('lower_fbm_competitor_blocks_raise');
    }
    // Check raise offset for FBM-specific behavior
    if (allGuards.some(g => g.includes('raise_offset_match:fbm_match_only_profile'))) {
      fbm_adjustments.push('match_only_profile_preserved');
    }
    if (allGuards.some(g => g.includes('raise_offset_undercut:fbm_seller'))) {
      fbm_adjustments.push('fbm_undercut_applied');
    }

    const fbm_adjustment_applied = fbm_adjustments.length > 0;
    const fbm_adjustment_reason = fbm_adjustments.join(', ') || null;

    // === COUNTERFACTUAL: What would FBA logic have done? ===
    // This helps tune the FBM layer by comparing against generic FBA-first behavior
    const would_fba_have_done: string | null = (() => {
      if (my_offer_type !== 'FBM') return null;
      // If FBM competitive hold fired, FBA would have undercut normally
      if (allGuards.includes('fbm_competitive_hold')) return 'undercut_toward_bb';
      // If FBM soft-blocked BB eligibility, FBA would have hard-blocked
      if (allGuards.includes('bb_eligible_soft_fbm')) return 'hard_block_not_eligible';
      // If FBM cluster bypass fired, FBA would have matched cluster
      if (allGuards.includes('fbm_cluster_bypass')) return 'cluster_match_hold';
      // If match-only profile preserved, FBA would have applied $0.01 undercut
      if (allGuards.some(g => g.includes('raise_offset_match:fbm_match_only_profile'))) return 'apply_undercut_0.01';
      if (allGuards.includes('fbm_aggressive_descent')) return 'micro_undercut_0.01';
      return 'same_as_fbm';
    })();

    console.log(`[FULFILLMENT_VISIBILITY] asin=${targetAsin} my=${my_offer_type} bb=${buybox_offer_type} anchor=${anchor_offer_type} path=${fulfillment_mode_path} fbm_adj=${fbm_adjustment_applied} reasons=${fbm_adjustment_reason || 'none'}`);

    return new Response(JSON.stringify({
      success: true,
      asin: targetAsin,
      sku: targetSku,
      marketplace: targetMarketplace,
      mode: result.mode,
      currentPrice: targetCurrentPrice,
      recommendedPrice: result.newPrice,
      rawTargetPrice: result.rawTargetPrice,
      priceDelta: result.newPrice && targetCurrentPrice ? result.newPrice - targetCurrentPrice : null,
      reason: result.reason,
      aiAggressiveness: result.aiAggressiveness,
      aiNote: result.aiNote,
      guardsApplied: [...(result.guardsApplied || []), ...(costMissingTag ? [costMissingTag] : [])],
      // === STRATEGY VISIBILITY FIELDS ===
      strategy_visibility: {
        profile_key: smartProfile,
        profile_label: profileLabel,
        strategy_influenced,
        dominant_layer,
        base_undercut,
        effective_undercut,
      },
      // === FULFILLMENT VISIBILITY FIELDS ===
      fulfillment_visibility: {
        my_offer_type,
        buybox_offer_type,
        anchor_offer_type,
        competitor_types_summary,
        fulfillment_mode_path,
        lowest_fba_price: snapshot?.lowest_fba_price ?? null,
        lowest_fbm_price: snapshot?.lowest_fbm_price ?? null,
        filtered_competitor_mix: competitor_types_summary,
        fbm_adjustment_applied,
        fbm_adjustment_reason,
        would_fba_have_done,
        // New FBM→FBM diagnostic fields
        raw_buybox_filtered: Boolean(positionProof.filter_gap_warning && positionProof.buy_box_price != null && positionProof.lowest_price_filtered != null && positionProof.buy_box_price < positionProof.lowest_price_filtered - 0.02),
        raw_buybox_filter_reason: (() => {
          if (!positionProof.filter_gap_warning) return null;
          const allG = result.guardsApplied || [];
          if (allG.some(g => g.startsWith('quality_filter'))) return 'quality_filter';
          if (allG.some(g => g.includes('fbm_ignored'))) return 'fbm_ignored';
          return 'unknown_filter';
        })(),
        nearest_valid_fbm_price: snapshot?.lowest_fbm_price ?? null,
      },
      requiresMinPriceLower: result.requiresMinPriceLower || false,
      suggestedNewMinPrice: result.suggestedNewMinPrice,
      effectiveFloor: result.effectiveFloor,
      userMinFloor: result.userMinFloor,
      effectiveProfitFloor: result.effectiveProfitFloor,
      effectiveFloorSource: result.effectiveFloorSource,
      currentPriceFloorLock: result.currentPriceFloorLock,
      minGapAmount: result.minGapAmount,
      minGapPercent: result.minGapPercent,
      // === AUTO FLOOR ADJUST (dynamic floor) ===
      autoFloorApplied,
      autoFloorOldMin,
      autoFloorNewMin,
      // === STRUCTURED REASON CODES (ChatGPT priority #1) ===
      reason_codes,
      // === TRANSPARENCY FIELDS (ChatGPT verification) ===
      tuning_source,
      enhanced_multiplier,
      combined_multiplier,
      enhanced_factors,
      // === POSITION PROOF (ChatGPT requested — proves "am I lowest" detection) ===
      position_proof: positionProof,
      // Profit Guard data
      blockedByProfitGuard: result.blockedByProfitGuard || false,
      profitFloorUsed: result.profitFloorUsed,
      profitGuardContext: {
        unitCost,
        costSource,
        estimatedFees,
        feesSource,
        referralRate: feeCache?.referral_rate ?? null,
        fbaFeeFixed: feeCache?.fba_fee_fixed ?? null,
        minProfitDollars,
        minRoiPercent: effectiveMinRoiPercent,
        minRoiPercentBase,
        minRoiPercentHighRisk,
        isHighRisk,
        sellerCount,
        includeFeesInFloor,
        profitFloorPrice,
        floorBreakdown,
      },
      // Intelligence data for UI display
      intelligence: {
        salesVelocityScore: intelligence.salesVelocityScore,
        yourDailySales: intelligence.yourDailySales,
        daysWithoutSale: intelligence.daysWithoutSale,
        buyboxWinRate: intelligence.buyboxWinRate,
        buyboxWinStreak: intelligence.buyboxWinStreak,
        buyboxLossStreak: intelligence.buyboxLossStreak,
        competitorStockSignal: intelligence.competitorStockSignal,
        competitorCount: intelligence.competitorCount,
        amazonSelling: intelligence.amazonSelling,
        inventoryAge: intelligence.inventoryAge,
        urgencyScore: intelligence.urgencyScore,
      },
      intelligenceFactors: {
        ...(result.intelligenceFactors || {}),
        // Strategy visibility embedded in intelligence for Action Log display
        strategy_visibility: {
          profile_key: smartProfile,
          profile_label: profileLabel,
          strategy_influenced,
          dominant_layer,
          base_undercut,
          effective_undercut,
        },
        // Fulfillment visibility embedded in intelligence for Action Log display
        fulfillment_visibility: {
          my_offer_type,
          buybox_offer_type,
          anchor_offer_type,
          competitor_types_summary,
          fulfillment_mode_path,
          lowest_fba_price: snapshot?.lowest_fba_price ?? null,
          lowest_fbm_price: snapshot?.lowest_fbm_price ?? null,
          filtered_competitor_mix: competitor_types_summary,
          fbm_adjustment_applied,
          fbm_adjustment_reason,
          would_fba_have_done,
        },
        reason_codes,
        position_proof: positionProof,
        // === STRUCTURED DIAGNOSTICS FOR UI POPUP ===
        tuning_source,
        enhanced_multiplier,
        combined_multiplier,
        enhanced_factors,
        guards_applied: [...(result.guardsApplied || []), ...(costMissingTag ? [costMissingTag] : [])],
        // Price trace
        price_trace: {
          current_price: targetCurrentPrice,
          buybox_price: snapshot?.buybox_price ?? null,
          lowest_fba: snapshot?.lowest_fba_price ?? null,
          lowest_overall: snapshot?.lowest_overall_price ?? null,
          raw_target: result.rawTargetPrice,
          final_price: result.newPrice,
          delta: result.newPrice && targetCurrentPrice ? Math.round((result.newPrice - targetCurrentPrice) * 1000) / 1000 : null,
          mode: result.mode,
          anchor_source,
          bb_source: snapshot?.bb_source || 'missing',
          bb_confidence,
          // Safeguard transparency: show when min/max clamped the price
          min_floor: context.minPrice ?? null,
          max_ceiling: context.maxPrice ?? null,
          clamped_by: (result.guardsApplied || []).includes('FINAL_CLAMP_MIN') ? 'min'
            : (result.guardsApplied || []).includes('FINAL_CLAMP_MAX') ? 'max'
            : (result.guardsApplied || []).includes('effective_floor') ? 'floor'
            : (result.guardsApplied || []).includes('min_price') ? 'min'
            : null,
        },
        // Profit guard context
        profit_guard: {
          enabled: enableProfitGuard,
          mode: (rule.profit_guard_mode as string) || 'respect_min_max',
          unit_cost: unitCost,
          cost_source: costSource,
          estimated_fees: estimatedFees,
          fees_source: feesSource,
          profit_floor_price: profitFloorPrice,
          effective_min_roi: effectiveMinRoiPercent,
          is_high_risk: isHighRisk,
          blocked: result.blockedByProfitGuard || false,
          floor_breakdown: floorBreakdown,
        },
        // Timing
        timing: {
          total_ms: _tEnd - _t0,
          context_ms: _tContext - _t0,
          sp_api_ms: _tSpApi - _tContext,
          rolling_ms: _tRolling - _tSpApi,
          intel_ms: _tIntel - _tRolling,
          pricing_ms: _tPricing - _tIntel,
          write_ms: _tWrites - _tPricing,
        },
        // Intelligence summary
        intelligence_summary: {
          velocity: intelligence.salesVelocityScore,
          bb_win_rate: intelligence.buyboxWinRate,
          bb_win_streak: intelligence.buyboxWinStreak,
          bb_loss_streak: intelligence.buyboxLossStreak,
          urgency: intelligence.urgencyScore,
          fba_competitors: intelligence.fbaCompetitorCount,
          competitor_stock: intelligence.competitorStockSignal,
          amazon_selling: intelligence.amazonSelling,
          days_of_stock: intelligence.yourDaysOfStock,
          stock_modifier: intelligence.stockAggressionModifier,
          units_today: intelligence.unitsToday,
          momentum_triggered: intelligence.momentumTriggered,
        },
        // Context bounds
        bounds: {
          min_price: context.minPrice,
          max_price: context.maxPrice,
          undercut_amount: context.undercutAmount,
          compete_amazon: context.competeWithAmazon,
          compete_fba: context.competeWithFba,
          compete_fbm: context.competeWithFbm,
          fulfillment_type: context.yourFulfillmentType,
        },
      },
      snapshot: snapshot ? {
        buybox_price: snapshot.buybox_price,
        buybox_seller_type: buyboxSellerType,
        bb_source: snapshot.bb_source || 'missing',
        lowest_fba_price: snapshot.lowest_fba_price,
        lowest_fbm_price: snapshot.lowest_fbm_price,
        lowest_overall_price: snapshot.lowest_overall_price,
        offers_count: snapshot.offers_count,
        fetched_at: snapshot.fetched_at,
      } : null,
      context: {
        minPrice: context.minPrice,
        maxPrice: context.maxPrice,
        undercutAmount: context.undercutAmount,
        competeWith: {
          amazon: context.competeWithAmazon,
          fba: context.competeWithFba,
          fbm: context.competeWithFbm,
        },
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[repricer-ai-evaluate] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Failed to evaluate pricing' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
