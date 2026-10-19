/**
 * Which channel is this listing fulfilled through?
 *
 * WHY THIS IS SHARED. The inventory table has no fulfillment_channel column --
 * one row per SKU, one `available` figure, and the channel has to be inferred
 * from surrounding evidence. That inference was written once in
 * src/components/repricer/AssignmentsTable.tsx and then needed again in
 * auto-assign-bulk (to stop the dedup collapsing an FBA/FBM pair) and in
 * fbm-quick-check (to confirm a candidate really is merchant-fulfilled before
 * writing a quantity into it). Three partial copies of the same precedence
 * rules is how the FBM mislabelling bug got in; this is the one definition.
 *
 * PRECEDENCE, and why it is in this order:
 *
 *   1. An explicit FBM source with no FBA stock wins outright. An FNSKU
 *      SURVIVES an FBA -> FBM conversion, so it proves only what the listing
 *      used to be -- checked before the FNSKU test for exactly that reason.
 *      Confirmed live on B001GQ2DB6, converted to FBM and still carrying its
 *      FNSKU.
 *   2. An FNSKU, or units reserved/inbound at Amazon, means FBA. Reserved and
 *      inbound quantities only exist for stock Amazon holds.
 *   3. An FBM source with no other evidence means FBM.
 *   4. Default FBA. Most of the catalogue is FBA and the FBA inventory feed is
 *      what creates most rows, so this is the safer assumption when nothing
 *      else is known.
 *
 * NOTE the default is a guess, not a fact. A caller that needs certainty --
 * writing a quantity, say -- should confirm against the Listings Items API
 * `fulfillmentChannelCode` rather than trusting this, and then persist
 * source = 'amazon_sync_fbm' so the next caller does not have to guess again.
 */
export interface FulfillmentEvidence {
  source?: string | null;
  fnsku?: string | null;
  reserved?: number | null;
  inbound?: number | null;
}

export function detectIsFba(item: FulfillmentEvidence): boolean {
  const src = String(item.source || "").toLowerCase();
  const hasFnsku = !!item.fnsku && String(item.fnsku).trim().length > 0;
  const reservedOrInbound = (Number(item.reserved) || 0) + (Number(item.inbound) || 0);
  const srcSaysFbm = src === "amazon_sync_fbm" || (src.includes("fbm") && !src.includes("fba"));

  if (srcSaysFbm && reservedOrInbound === 0) return false;
  if (hasFnsku || reservedOrInbound > 0) return true;
  if (srcSaysFbm) return false;
  return true;
}

/** 'FBA' | 'FBM' — the same call, named for use as a grouping key. */
export function channelOf(item: FulfillmentEvidence): "FBA" | "FBM" {
  return detectIsFba(item) ? "FBA" : "FBM";
}

/**
 * Amazon's own answer, when the Listings Items API has been asked.
 * `fulfillmentChannelCode` is DEFAULT for merchant-fulfilled and a region code
 * (AMAZON_NA, AMAZON_EU, …) for Amazon-fulfilled. Returns null when the field
 * is absent, which is not the same as "FBA" and must not be treated as such.
 */
export function channelFromListingsApi(listingData: any): "FBA" | "FBM" | null {
  const avail = Array.isArray(listingData?.fulfillmentAvailability)
    ? listingData.fulfillmentAvailability
    : [];
  for (const entry of avail) {
    const code = String(entry?.fulfillmentChannelCode || "").toUpperCase();
    if (!code) continue;
    if (code === "DEFAULT" || code === "MERCHANT") return "FBM";
    if (code.startsWith("AMAZON")) return "FBA";
  }
  return null;
}

/* ───────────────────────── ORDER channel ─────────────────────────
 *
 * Everything above infers a LISTING's channel from inventory evidence. This
 * section is about an ORDER, where Amazon states the answer directly in the
 * Orders API `FulfillmentChannel` field — so there is nothing to infer, only
 * a value to record faithfully or admit is missing.
 *
 * WHY THIS IS HERE. The same two lines were written independently in
 * fetch-live-orders and sync-sales-orders, both as
 * `amazonOrder?.FulfillmentChannel || 'AFN'`, and that default is how 14,068
 * rows ended up carrying an AFN that cannot be distinguished from a fact.
 * Measured 2026-10-19: 57,509 rows have no channel at all, and the column is
 * read in ten places that each decide for themselves what a missing value
 * means. One definition, two functions, tested.
 *
 * THE SPLIT THAT MATTERS, and it is not symmetric:
 *
 *   storedOrderChannel()  what to WRITE. Amazon's value or NULL. Never a
 *                         guess, because a stored guess is permanent and
 *                         indistinguishable from data.
 *   orderIsFbm()          what to READ. Only a stated MFN is FBM. An unknown
 *                         channel reads as NOT FBM, i.e. it behaves as FBA —
 *                         which is what every existing caller already did, so
 *                         adopting this changes no existing figure.
 *
 * Those two are deliberately different. Writing NULL while reading it as FBA
 * is not a contradiction: it records honestly what Amazon said, and keeps
 * every downstream fee and ROI calculation exactly as it was.
 */

/** Amazon's answer, normalised — or null when it did not give one. */
export function storedOrderChannel(raw: unknown): "AFN" | "MFN" | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (v === "AFN") return "AFN";
  if (v === "MFN") return "MFN";
  return null;
}

/**
 * Is this order merchant-fulfilled?
 *
 * Only a stated MFN qualifies. Unknown returns false — the caller is assuming
 * FBA, which preserves existing behaviour. Use orderChannelIsKnown() when the
 * difference between "Amazon said FBA" and "nobody knows" actually matters,
 * such as deciding whether to promise a shipping label fee.
 */
export function orderIsFbm(storedChannel: unknown): boolean {
  return storedOrderChannel(storedChannel) === "MFN";
}

/** True only when Amazon actually stated a channel. */
export function orderChannelIsKnown(storedChannel: unknown): boolean {
  return storedOrderChannel(storedChannel) !== null;
}

/** 'FBM' for a stated MFN, otherwise 'FBA' — the assumption made explicit. */
export function orderChannelKey(storedChannel: unknown): "FBA" | "FBM" {
  return orderIsFbm(storedChannel) ? "FBM" : "FBA";
}
