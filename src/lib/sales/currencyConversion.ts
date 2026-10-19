/**
 * Shared FX conversion helper for sales_orders rows.
 *
 * CONTRACT (mixed historical data):
 *  - marketplace = 'US' → monetary fields are USD.
 *  - marketplace != 'US' → confirmed sold_price / total_sale_amount may be USD
 *    (settlement/new writers) OR native (older Orders API paths).
 *  - Read paths must use source-aware guards before converting with fx_rates.
 *
 * fxRates map is keyed by quote currency code, value = USD→quote rate
 * (e.g. fxRates['BRL'] = 5.37 means 1 USD = 5.37 BRL).
 *
 * DOUBLE-CONVERT GUARD:
 *  - This function does nothing for US rows or for unknown marketplaces.
 *  - Callers MUST pass the row's native amount; do not pre-convert.
 */

export const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD",
  CA: "CAD",
  MX: "MXN",
  BR: "BRL",
  UK: "GBP",
  DE: "EUR",
  ES: "EUR",
  FR: "EUR",
  IT: "EUR",
  JP: "JPY",
  AU: "AUD",
  IN: "INR",
  SG: "SGD",
  AE: "AED",
  SA: "SAR",
  NL: "EUR",
  SE: "SEK",
  PL: "PLN",
  BE: "EUR",
  TR: "TRY",
};

export function getMarketplaceCurrency(marketplace: string | null | undefined): string {
  const mp = String(marketplace || "US").trim().toUpperCase();
  return MARKETPLACE_CURRENCY[mp] || "USD";
}

/**
 * Convert an amount stored in the row's NATIVE marketplace currency
 * into the seller's home currency (default USD).
 *
 * Returns { amount, fxRate, fromCurrency, toCurrency } for UI display/debug.
 */
export function convertNativeToHome(
  amount: number | null | undefined,
  marketplace: string | null | undefined,
  fxRates: Record<string, number>,
  homeCurrency: string = "USD",
): { amount: number; fxRate: number; fromCurrency: string; toCurrency: string } {
  const safe = Number.isFinite(amount as number) ? Number(amount) : 0;
  const fromCurrency = getMarketplaceCurrency(marketplace);
  const toCurrency = (homeCurrency || "USD").toUpperCase();

  if (fromCurrency === toCurrency) {
    return { amount: safe, fxRate: 1, fromCurrency, toCurrency };
  }

  // Cross-rate via USD: amount × (USD→to) / (USD→from)
  const usdToFrom = fromCurrency === "USD" ? 1 : fxRates[fromCurrency] || 0;
  const usdToTo = toCurrency === "USD" ? 1 : fxRates[toCurrency] || 0;

  if (!usdToFrom || !usdToTo) {
    // FX missing — return raw to avoid silent zero
    return { amount: safe, fxRate: 1, fromCurrency, toCurrency };
  }

  const fxRate = usdToTo / usdToFrom;
  return { amount: safe * fxRate, fxRate, fromCurrency, toCurrency };
}

/**
 * Convenience for the common case: native → USD (legacy "toUsd").
 */
export function convertNativeToUsd(
  amount: number | null | undefined,
  marketplace: string | null | undefined,
  fxRates: Record<string, number>,
): number {
  return convertNativeToHome(amount, marketplace, fxRates, "USD").amount;
}

export type ConfirmedSalesRevenueRow = {
  marketplace?: string | null;
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  price_source?: string | null;
  price_calc_mode?: string | null;
  order_status?: string | null;
  order_date?: string | null;
};

export type ToUsdConverter = (amount: number, marketplace?: string | null) => number;

const TRUSTED_USD_PRICE_SOURCES = new Set([
  "financial_events",
  "reconciled_fec",
  "settled",
  "orders_api",
  "orders_api_ca_reconciled",
  "data_repair",
  "orders_itemprice_usd",
]);

const SUSPECT_NATIVE_PRICE_SOURCES = [
  "",
  "orders_itemprice",
  "order_items_api",
  "order_total_pending",
  "fees_api",
  "listings_api",
  "pricing_api",
  "estimate",
  "estimated:",
];

function nativeMagnitudeThreshold(marketplace: string, fxRate: number): number {
  if (marketplace === "MX") return Math.max(120, fxRate * 7);
  if (marketplace === "BR") return Math.max(75, fxRate * 14);
  if (marketplace === "CA") return 150;
  return 150;
}

function shouldTreatConfirmedRevenueAsNative(
  row: ConfirmedSalesRevenueRow,
  rawTotal: number,
  qty: number,
  marketplace: string,
  fxRate: number,
): boolean {
  const priceSource = String(row.price_source || "").trim().toLowerCase();
  const calcMode = String(row.price_calc_mode || "").trim().toLowerCase();
  const hasTrustedUsdMarker =
    TRUSTED_USD_PRICE_SOURCES.has(priceSource) ||
    TRUSTED_USD_PRICE_SOURCES.has(calcMode) ||
    priceSource.endsWith("_usd") ||
    calcMode.endsWith("_usd") ||
    priceSource.includes("_reconciled") ||
    calcMode.includes("_reconciled");
  if (hasTrustedUsdMarker) return false;

  const suspectSource = SUSPECT_NATIVE_PRICE_SOURCES.some((prefix) => (
    prefix === "" ? priceSource === "" : priceSource.startsWith(prefix) || calcMode.startsWith(prefix)
  ));
  if (!suspectSource) return false;

  const estimatedTotal = Number(row.estimated_price || 0) * qty;
  if (estimatedTotal > 0) {
    const usdLikeRatio = rawTotal / estimatedTotal;
    // If raw is already roughly native/fx while estimate is native, do not convert again.
    // AUDIT §15 (CA order 702-1959389-6640252, pending, ratio 0.956): the old
    // ×1.35 upper bound was tuned generically, but for low-fxRate currencies
    // like CAD (~1.41) it stretches this "already-USD" band up to ~0.96 —
    // almost touching 1.0, the signature of a genuinely-native row whose raw
    // total is just a few % off its own native estimate (price drift between
    // estimate capture and actual sale). That swallowed real native CA rows
    // before the correct "native ratio" band below ever got a chance, under-
    // reporting revenue ~1.4x (displayed CA$86.40 as if already $86.40 USD).
    // Tightened to ×1.15 so the two bands no longer overlap for CAD; verified
    // against all 2,095 of this account's non-US confirmed-revenue rows —
    // only the 2 genuinely-misclassified rows flip, nothing else changes.
    if (usdLikeRatio >= (1 / fxRate) * 0.75 && usdLikeRatio <= (1 / fxRate) * 1.15) return false;
  }

  // AUDIT §14 (BR confirmed revenue): the previous startsWith branch hard-coded
  // every `orders_itemprice` / `order_items_api` / `order_total_pending` row as
  // native marketplace currency. Production scan (BR YTD 2026) proved the
  // writer (`sync-sales-orders`) already stores USD on these paths — see the
  // [Sales Currency Contract] memory. Treating them as native caused the
  // reader to divide by FX again, understating BR revenue ~5.4× (CA ~1.4×).
  // The branch is intentionally removed. Genuine legacy native rows are still
  // caught by the estimated-ratio guard below and the magnitude threshold.


  if (estimatedTotal > 0) {
    const ratio = rawTotal / estimatedTotal;
    // AUDIT §14c (BR order 702-6403753-5454661): the previous `ratio ≈ 1.0`
    // branch caused false positives. The new USD writer path stores
    // sold_price = estimated_price (both USD), so ratio=1.0 no longer means
    // "both native" — it also matches healthy USD rows. Dividing those by FX
    // again under-reported BR ~5.4× ($32.86 → $6.11). Removed.
    // The fxRate-band detector (raw=native vs est=USD) still fires for the
    // genuine half-converted legacy shape, and the magnitude threshold catches
    // large pure-native rows. Small pure-native legacy rows fall through and
    // display close to their (already small) native magnitude — preferable to
    // the previous double-conversion regression.
    if (ratio >= fxRate * 0.65 && ratio <= fxRate * 1.45) return true;
  }

  return rawTotal >= nativeMagnitudeThreshold(marketplace, fxRate);
}

// AUDIT §16 (US pending-price gap, 2026-08-15): recent still-Pending orders
// can carry a preliminary/wrong price from Amazon before payment
// authorization finishes — confirmed live: a 10-unit order with
// price_source="orders_itemprice" showed $150.57 total while the order was
// still Pending and the seller's own current listing price (estimated_price)
// was $215.10 (the real, correct amount). This was invisible to every guard
// above because they only ever ran for non-US marketplaces — `marketplace
// === "US"` short-circuited straight past them (see contract note at top of
// file). Validated against 900 recent (order_date within 30d) Pending +
// suspect-sourced US rows: 893/900 were healthy (raw within 15% of
// estimated_price*qty); the 7 genuine outliers were ALL understated, never
// overstated. Deliberately scoped to Pending + recent + suspect-sourced +
// understated only — older or non-Pending mismatches usually mean the price
// legitimately changed since the sale (estimated_price drifted, not the
// sale data), and treating those as wrong is exactly the regression class
// AUDIT §14/§14c/§15 above already had to walk back once.
function isRecentPendingSuspectLowball(
  row: ConfirmedSalesRevenueRow,
  raw: number,
  qty: number,
): boolean {
  // US ONLY. The note above describes a US problem and says so: "Validated
  // against 900 recent (order_date within 30d) Pending + suspect-sourced US
  // rows". But the check was never actually scoped to US, and it runs BEFORE
  // the `marketplace === "US"` short-circuit further down, so it fired on
  // CA/MX/BR too -- and there it is guaranteed to misfire.
  //
  // The reason is a unit mismatch, not a tuning problem. `raw` is USD
  // (total_sale_amount / sold_price) while estimated_price is NATIVE for
  // non-US. So `raw < est * 0.85` compares dollars against pesos and is true
  // for essentially every healthy MX row: 36.43 < 669.62 * 0.85. The guard
  // then returns estimated_price * qty UNCONVERTED, replacing a correct USD
  // figure with a raw native one.
  //
  // Live example, MX order 701-8676794-7473022 on 2026-10-19: Amazon
  // MX$669.62, correctly stored as sold_price = total_sale_amount = 36.43 USD
  // with estimated_price = 669.62 native. The report showed $669.62 -- an
  // 18x overstatement of a row that had nothing wrong with it.
  //
  // Scoping to US is the fix rather than converting the estimate, because for
  // non-US the magnitude guards ABOVE already detect native-in-a-USD-column,
  // and estimated_price cannot stand in for a USD figure without conversion
  // anyway. If this is ever wanted for non-US it needs toUsd(), which this
  // function does not receive.
  const marketplace = String(row.marketplace || "US").trim().toUpperCase() || "US";
  if (marketplace !== "US") return false;

  const status = String(row.order_status || "").trim().toLowerCase();
  if (status !== "pending") return false;

  const priceSource = String(row.price_source || "").trim().toLowerCase();
  const calcMode = String(row.price_calc_mode || "").trim().toLowerCase();
  const hasTrustedUsdMarker =
    TRUSTED_USD_PRICE_SOURCES.has(priceSource) ||
    TRUSTED_USD_PRICE_SOURCES.has(calcMode) ||
    priceSource.endsWith("_usd") ||
    calcMode.endsWith("_usd") ||
    priceSource.includes("_reconciled") ||
    calcMode.includes("_reconciled");
  if (hasTrustedUsdMarker) return false;

  const suspectSource = SUSPECT_NATIVE_PRICE_SOURCES.some((prefix) => (
    prefix === "" ? priceSource === "" : priceSource.startsWith(prefix) || calcMode.startsWith(prefix)
  ));
  if (!suspectSource) return false;

  const orderDate = String(row.order_date || "");
  if (!orderDate) return false;
  const ageDays = (Date.now() - new Date(`${orderDate}T00:00:00Z`).getTime()) / 86400000;
  if (!(ageDays >= 0 && ageDays <= 30)) return false;

  const est = Number(row.estimated_price || 0) * qty;
  if (!(est > 0)) return false;

  return raw < est * 0.85;
}

/**
 * Return confirmed sales_order revenue in USD for all marketplaces.
 *
 * Historical data is mixed: settlement/FEC writers stored USD, while older
 * Orders API paths sometimes stored native CA/MX/BR amounts in sold_price or
 * total_sale_amount. This source-aware guard converts only rows with a native
 * signature and leaves known-USD settlement rows alone.
 */
export function getConfirmedSalesOrderRevenueUsd(
  row: ConfirmedSalesRevenueRow,
  toUsd: ToUsdConverter,
): number {
  const qty = Math.max(1, Number(row.quantity || 0));
  const raw = Number(row.total_sale_amount || 0) || (Number(row.sold_price || 0) * qty) || 0;
  if (raw <= 0) return 0;

  if (isRecentPendingSuspectLowball(row, raw, qty)) {
    return Number(row.estimated_price || 0) * qty;
  }

  const marketplace = String(row.marketplace || "US").trim().toUpperCase() || "US";
  if (marketplace === "US") return raw;

  const oneUsd = toUsd(1, marketplace);
  if (!(oneUsd > 0) || Math.abs(oneUsd - 1) < 0.0001) return raw;
  const fxRate = 1 / oneUsd; // fx_rates stores 1 USD = X native currency
  if (!(fxRate > 1.05)) return raw;

  if (shouldTreatConfirmedRevenueAsNative(row, raw, qty, marketplace, fxRate)) return toUsd(raw, marketplace);

  return raw;
}

export function getConfirmedSalesOrderUnitRevenueUsd(
  row: ConfirmedSalesRevenueRow,
  toUsd: ToUsdConverter,
): number {
  const qty = Math.max(1, Number(row.quantity || 0));
  const total = getConfirmedSalesOrderRevenueUsd(row, toUsd);
  return total > 0 ? total / qty : 0;
}

/**
 * Price-source legacy detector. Some historical rows stored estimated_price
 * already in USD (pre-fix). After repair migration this should always be false
 * for new rows, but the detector lets us reason about legacy data if needed.
 */
export function isLegacyUsdEstimatedPriceSource(priceSource: string | null | undefined): boolean {
  if (!priceSource) return false;
  return (
    priceSource.startsWith("listings_api_") ||
    priceSource.startsWith("pricing_api_") ||
    priceSource.startsWith("seller_derived:") ||
    priceSource.startsWith("hint:")
  );
}

/**
 * THE ONE PLACE a pending order's estimate becomes USD revenue.
 *
 * estimated_price and locked_est_price are NATIVE marketplace currency for
 * non-US rows and USD for US rows (see the contract at the top of this file).
 * Multiplying either by quantity without converting puts pesos, Canadian
 * dollars or reais into a USD total. That mistake was made independently in
 * at least six places, in both directions:
 *
 *   currencyConversion   a US-only Pending guard returned estimated_price raw,
 *                        so MX order 701-8676794-7473022 reported $669.62
 *                        instead of $36.43 (fixed 2026-10-19)
 *   LiveSalesPopup       worked internally in native and called toUsd() at the
 *                        end, but fed it USD fields -- so a settled MX row came
 *                        out 18x too SMALL ($1.98) while a pending one came out
 *                        18x too BIG, because estimatedPriceToNative multiplied
 *                        an already-native value by the rate
 *   CancelledOrdersSection  read estimated_price BEFORE sold_price and never
 *                        converted it
 *   PeriodStatsBlocks    three copies of `estimated * qty` with no conversion
 *                        (currently dead code -- the component is not imported
 *                        by any page -- but it would ship the bug the moment
 *                        anyone rendered it)
 *
 * Call this instead of reaching for the columns. It returns USD for every
 * marketplace, prefers the settled figure when there is one, and leaves US
 * rows numerically untouched.
 */
export function getPendingEstimateUsd(
  row: ConfirmedSalesRevenueRow & { locked_est_price?: number | null },
  toUsd: ToUsdConverter,
): number {
  const qty = Math.max(1, Number(row.quantity || 0));

  // A settled figure outranks any estimate. These columns are USD already, so
  // they must NOT be passed through toUsd() -- doing that is the
  // LiveSalesPopup bug.
  const confirmedUsd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
  if (confirmedUsd > 0) return confirmedUsd;

  const marketplace = String(row.marketplace || "US").trim().toUpperCase() || "US";

  // locked_est_price first: a frozen snapshot of the order's own price, which
  // beats estimated_price because the latter tracks the CURRENT listing and
  // drifts when the seller reprices.
  const lockedNative = Number(row.locked_est_price || 0) * qty;
  if (lockedNative > 0) return toUsd(lockedNative, marketplace);

  const estimatedNative = Number(row.estimated_price || 0) * qty;
  if (estimatedNative > 0) return toUsd(estimatedNative, marketplace);

  return 0;
}

/**
 * USD value of a CANCELLED order's line, for "what we did not earn" displays.
 *
 * Separate from the above because a cancelled row legitimately has no settled
 * price and the estimate IS the best figure -- but it still has to be
 * converted. CancelledOrdersSection read estimated_price first and showed it
 * raw, so a cancelled MX order appeared as a four-figure dollar loss.
 */
export function getCancelledLineUsd(
  row: ConfirmedSalesRevenueRow & { locked_est_price?: number | null },
  toUsd: ToUsdConverter,
): number {
  const qty = Math.max(1, Number(row.quantity || 0));
  const marketplace = String(row.marketplace || "US").trim().toUpperCase() || "US";

  const estimatedNative = Number(row.estimated_price || 0);
  if (estimatedNative > 0) return Math.abs(toUsd(estimatedNative * qty, marketplace));

  // sold_price / total_sale_amount are USD; no conversion.
  const soldUsd = Number(row.sold_price || 0) * qty;
  if (soldUsd > 0) return Math.abs(soldUsd);
  return Math.abs(Number(row.total_sale_amount || 0));
}
