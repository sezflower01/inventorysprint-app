// What counts as "the next competitor's price" in a review case.
//
// ── THE BUG THIS EXISTS TO FIX ────────────────────────────────────────────
//
// The review case carried:
//
//     next_competitor_price: d.lowest_overall_price ?? null
//
// `lowest_overall_price` is min(lowest FBA, lowest FBM) computed in
// repricer-sp-api-pricing over an offer list that INCLUDES OUR OWN OFFER --
// there is no seller-id exclusion in that loop. So whenever we hold the
// lowest offer, lowest_overall_price IS our price.
//
// The prompt then renders it verbatim:
//
//     - Next Competitor: $${c.next_competitor_price?.toFixed(2) ?? "?"}
//
// which told the model our own price was the competition, precisely in the
// cases where we are winning. Measured on the live account: of the sampled
// price-changed events where we already held the lowest FBA offer, 348 had
// nobody actually cheaper against 2 that did -- so this was the normal case,
// not an edge case. Seven months of reviews were produced through it.
//
// ── WHY NULL RATHER THAN A GUESS ──────────────────────────────────────────
//
// We do not have the lowest COMPETING offer in this payload -- only the
// lowest overall, which may be ours. When nobody is strictly below us there
// is no honest number to supply, and the prompt already renders null as "?".
// "Unknown" is a true statement; "the competitor is at your own price" is
// not, and it is the kind of false premise a model will reason confidently
// from.
//
// The epsilon matches the comparison style already used for this field in
// repricer-ai-evaluate (`lowestOverallPrice < lowestFbaPrice - 0.005`), so a
// competitor who merely ties us does not read as undercutting us.

/** Half a cent: a tie is not a competitor being cheaper. */
export const COMPETITOR_EPSILON = 0.005;

/**
 * The lowest overall offer, but only when it is genuinely someone else's and
 * genuinely below us. Null means "no competitor below us, or unknown" --
 * never our own price wearing a competitor's label.
 */
export function resolveNextCompetitorPrice(
  currentPrice: number | null | undefined,
  lowestOverallPrice: number | null | undefined,
  epsilon: number = COMPETITOR_EPSILON,
): number | null {
  if (lowestOverallPrice == null || !Number.isFinite(lowestOverallPrice)) return null;
  if (lowestOverallPrice <= 0) return null;
  // Without our own price we cannot tell whose offer the lowest one is, so we
  // must not claim it is a competitor's.
  if (currentPrice == null || !Number.isFinite(currentPrice)) return null;
  // At or above our price => the lowest offer is ours (or a tie). No
  // competitor is below us.
  if (lowestOverallPrice >= currentPrice - epsilon) return null;
  return lowestOverallPrice;
}
