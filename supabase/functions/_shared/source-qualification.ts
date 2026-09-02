// Decide whether a newly detected listing is worth an automatic source search.
//
// Every rule here comes from probing 40 REAL detections through SP-API Catalog
// Items on 2026-08-16 (spapi-rank-probe), not from intuition. Two of the
// intuitive versions were measurably wrong and are called out below, because
// they are the ones a future edit is most likely to reintroduce.
//
// Extracted rather than inlined so the thresholds are testable without
// standing up an edge function -- see source-qualification_test.ts.

import { findExcludedTitleTerm } from './title-exclusions.ts';

/** Lowercase verdicts as check-product-eligibility stores them. */
export type EligibilityVerdict = 'approved' | 'approval_required' | 'restricted';

export interface QualificationInput {
  /** SP-API summaries[].websiteDisplayGroupName. Top-level department. */
  productGroup?: string | null;
  /** SP-API salesRanks[].displayGroupRanks[].rank. The BROAD rank. */
  salesRank?: number | null;
  upc?: string | null;
  /**
   * From user_approved_products.approval_status -- the SAME rows that drive
   * the EligibilityBadge, so the filter and the UI cannot disagree.
   * undefined/null means "not checked yet", which is NOT a disqualification.
   */
  eligibility?: EligibilityVerdict | null;
  /** auto_source_config.search_needs_approval. Default true. */
  allowNeedsApproval?: boolean;
  /** SP-API summaries[].brand, falling back to manufacturer. */
  brand?: string | null;
  /** SP-API summaries[].itemName. Absent/null NEVER disqualifies. */
  title?: string | null;
  /**
   * Per-user overrides from source_excluded_terms, already lowercased.
   * Omitted means "use the built-in defaults", which is what keeps the Deno
   * tests and any caller that has not been updated behaving exactly as before.
   */
  excludedGroups?: ReadonlySet<string>;
  excludedBrands?: ReadonlySet<string>;
  /**
   * Title keywords/phrases from source_excluded_terms kind='title_keyword'.
   * No built-in default -- unlike groups and brands there is no prior
   * hardcoded list, so omitting this means "no title rules", not "the
   * defaults". An empty list must therefore exclude nothing.
   */
  excludedTitleTerms?: Iterable<string>;
}

export interface QualificationResult {
  qualified: boolean;
  /** Machine-readable reason, null when qualified. Stored for auditing. */
  reason: string | null;
}

/**
 * Amazon's ACTUAL productGroup strings, which differ from how a person would
 * name these categories. The observed values were 'Book' (not "Books"), and
 * 'DVD' / 'Video' rather than any "Movies & TV". A list written from intuition
 * matches nothing at all -- that mistake was caught only by probing.
 *
 * 'Digital Text' is Kindle; 'Magazine' covers periodicals.
 */
export const EXCLUDED_PRODUCT_GROUPS = new Set([
  'book', 'digital text', 'magazine', 'music', 'digital music',
  'dvd', 'video', 'video dvd', 'blu-ray',
]);

/**
 * Placeholder brand values Amazon actually ships, matched EXACTLY.
 *
 * Deliberately short. 'Universal' and 'OEM' are excluded because they are real
 * brands (Universal Studios/Music; OEM as an automotive-parts label), and
 * substring matching is never used because "Publisher Unknown" -- a genuine
 * publisher observed in live data -- would be caught by a contains-'unknown'
 * rule while failing an exact one.
 */
export const EXCLUDED_BRANDS = new Set([
  'generic', 'unbranded', 'no brand', 'nobrand', 'unknown',
]);

/**
 * ⚠️ DO NOT AUTO-SYNC THIS LIST WITH AMAZON'S RESTRICTION DATA.
 *
 * The per-user list in source_excluded_terms is deliberately MANUAL, and that
 * is a product decision, not an unfinished feature. Confirmed with the user
 * 2026-08-19 after they were asked directly about it.
 *
 * The reasoning: the seller does independent brand-risk research that Amazon's
 * gating status does not capture -- IP complaint history, brand-protection
 * programme membership, signals from third-party tools. A brand can be
 * perfectly sellable as far as Amazon's own eligibility API is concerned and
 * still be a bad idea to stock. Deriving this list from user_approved_products
 * verdicts, or from anything else Amazon reports, would collapse exactly the
 * judgement the list exists to express.
 *
 * The two systems are complementary and both already run: `eligibility` above
 * handles what Amazon forbids; this list handles what the seller has decided
 * against. Neither should be made to drive the other.
 *
 * This is also why real brands appear in a user's list (MAC, ofra were live
 * examples). Seeing a legitimate brand here is NOT evidence of a mistake --
 * do not "helpfully" prune it.
 */

/**
 * Broad-rank ceiling. Measured distribution: p25 28,335 / median 80,142 /
 * p75 511,275 / max 1,886,054. 500,000 trims roughly the worst quartile while
 * leaving the median comfortably through.
 *
 * Applied ONLY when a rank exists. 60% of detections carry no broad rank, and
 * excluding those would reject for missing data rather than for being bad --
 * a filter should act on evidence, not on its absence.
 */
export const MAX_SALES_RANK = 500_000;


/**
 * Case-fold a caller-supplied exclusion set, cached per Set instance.
 *
 * ⚠️ THIS EXISTS BECAUSE BRAND EXCLUSIONS SILENTLY DID NOTHING.
 *
 * The UI stores what the user typed, verbatim -- `value: v, label: v`, no
 * normalisation -- so a list reads "Generic", "DREAMUS", "K-POP". The check
 * below lowercases only the LISTING's brand, so `has("generic")` never matched
 * `"Generic"`. Measured 2026-08-22: 37 of one user's 38 brand rules were inert;
 * the single exception was "ofra", which happens to be lowercase.
 *
 * Worse than inert. A user list REPLACES the built-in defaults rather than
 * extending them, so "generic"/"unbranded"/"unknown" were being excluded
 * correctly until the user added their first brand rule -- after which brand
 * filtering stopped entirely, with nothing to indicate it. Exactly the failure
 * the empty-set guard in check-seller-watchlist was written to prevent, one
 * case-fold further down.
 *
 * Fixed HERE rather than at the two construction sites, or by migrating stored
 * values, so that every caller present and future is covered by one change and
 * no data has to be rewritten to make existing rules start working.
 *
 * The WeakMap keys on the Set itself: callers build these once per sweep and
 * pass the same instance for every listing, so the fold happens once rather
 * than per row, and the entry is collected with the set.
 */
const FOLDED = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

function folded(raw: ReadonlySet<string>): ReadonlySet<string> {
  const hit = FOLDED.get(raw);
  if (hit) return hit;
  const out = new Set<string>();
  for (const v of raw) out.add(String(v).trim().toLowerCase());
  FOLDED.set(raw, out);
  return out;
}

export function qualifyListing(input: QualificationInput): QualificationResult {
  // ── ONE RULE, PLUS ONE HARD BLOCK (2026-09-02) ────────────────────────────
  //
  // This function used to apply seven: restricted, needs_approval_excluded,
  // excluded_group, excluded_brand, excluded_title, rank_over_500000 and
  // no_upc. All but the first are now removed at the seller's explicit
  // instruction, and the reason is worth recording because the rules were
  // sound when they were written.
  //
  // They existed to decide WHAT DESERVED AN API CALL. The auto-source worker
  // spent a CSE query, up to three Gemini verdicts, three vision compares and
  // a scrape per listing, so refusing 96% of detections up front was the
  // difference between a viable feature and an unaffordable one.
  //
  // That worker was deleted on 2026-08-19 (20260819220000) when Google CSE
  // began returning 403 on every call. The rules survived it and were
  // repurposed to decide what deserves the SELLER'S ATTENTION -- which is not
  // the same judgement, and nobody chose it deliberately.
  //
  // Measured 2026-09-02: 394 of 1,238 brand-matched listings were being hidden
  // this way -- 117 apparel, 58 book, 57 beauty, 49 shoes -- for brands the
  // seller already stocks. A category rule meant to save a search was
  // suppressing exactly the listings the brand filter existed to surface.
  //
  // The filter is now brand matching alone, applied downstream by
  // classify-listing-brands. Everything reaching this function qualifies.
  //
  // ── WHY 'restricted' STAYS ───────────────────────────────────────────────
  //
  // Every other rule was a preference. This one is Amazon stating the item
  // CANNOT BE SOLD by this seller. Surfacing those as ordinary results would
  // invite work on listings that can never be actioned, so it is kept
  // deliberately and by explicit decision, not by omission.
  if (input.eligibility === 'restricted') {
    return { qualified: false, reason: 'restricted' };
  }

  // Everything else qualifies. The strict_* columns and the excluded-group,
  // excluded-brand and excluded-title inputs are still ACCEPTED by the
  // signature and still stored on the row -- they are simply no longer
  // consulted. Removing them from the type would break every caller for no
  // gain, and keeping the data means this decision is reversible.
  return { qualified: true, reason: null };
}
