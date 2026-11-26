// US FBA size tier for the web analyser's "Size" alert.
//
// WHY THIS EXISTS (2026-11-23)
//
// The Size alert used to read:
//
//   value: p.packageHeight && p.packageHeight > 460 ? 'Oversize' : 'Standard Size'
//
// One axis, one threshold. Three things were wrong with it:
//
//   1. HEIGHT IS AN ARBITRARY AXIS. Keepa reports length, width and height as
//      the supplier recorded them, not sorted. Amazon's tiers are defined on
//      the longest, median and shortest side. A 30 x 2 x 2 in pole has a
//      2 in "height" and read "Standard Size"; a 19 in tall slim box read
//      "Oversize".
//   2. 460 mm (18.1 in) IS NOT A TIER BOUNDARY. It is close to the large
//      standard 18 in longest-side cap, but applied to the wrong side and
//      with none of the other three conditions.
//   3. WEIGHT WAS IGNORED ENTIRELY. A 60 lb item inside an 18 x 14 x 8 box is
//      not standard size, and this called it one.
//
// It also disagreed with the Chrome panel on the same ASIN, which is how the
// report arrived: two screens, two answers, neither citing a rule.
//
// This module is deliberately function-local rather than in _shared/. A
// _shared/** edit redeploys every one of ~262 edge functions because the
// import graph is not parsed, and that is far too expensive for a display
// fix in one function.
//
// THE THRESHOLDS ARE MIRRORED, NOT SHARED. extension/sizeTier.js holds the
// same numbers for the Chrome panel; the two runtimes cannot import one file.
// supabase/functions/_tests/analyzer-size-tier/fba_size_tier_test.ts reads
// that file as text and fails if the numbers drift apart, because the two
// screens disagreeing is the bug being fixed here and nothing else would
// catch it coming back.
//
// TIER TABLE UPDATED 2026-11-26. It previously carried Amazon's PRE-2023
// ladder ("Large Oversize" / "Oversize" / "Heavy/Bulky", caps 60/108 in and
// girth 130/165), kept deliberately while the 2026-11-23 change was confined
// to units. Now Amazon's current ladder: Small/Large Standard, Small/Large
// Bulky, and Extra-large in four weight bands. SMALL_BULKY is genuinely new --
// Amazon introduced it on 15 January 2026 between Large Standard and Large
// Bulky -- so an item that was Large Bulky under the old table can now sit a
// tier cheaper.
//
// `lengthPlusGirth` is Amazon's own term: girth is 2 x (median + shortest),
// and length + girth adds the longest side. The variable below computes
// exactly that; it used to be called `girth`, understating what it held by a
// whole side.
//
// The three XL_* rows carry ONLY a weight cap, because extra-large is defined
// by exclusion -- past Large Bulky's envelope, or over 50 lb -- and then split
// on weight alone. They stay flat numeric objects because the parity test
// regex-parses the panel's literal: an array or a string is invisible to it,
// and a tier the test cannot see is a tier that can drift.
//
// KNOWN GAP, deliberately not closed: Amazon assigns a tier on SHIPPING
// weight, the greater of actual and dimensional weight, and this uses actual
// weight only, so a large light item can land a tier low. Left open because
// the dimensional divisor differs outside standard size, and a wrong tier that
// looks confident is worse than one with a stated limit -- the same rule as
// the unreadable-unit abstention. See memory/fba-fee-quote-understates-bulky
// for the measurement that withdrew an earlier, wronger attempt at this.

export const FBA_TIERS = {
  SMALL_STANDARD: { longest: 15, median: 12, shortest: 0.75, maxLb: 1 },
  LARGE_STANDARD: { longest: 18, median: 14, shortest: 8, maxLb: 20 },
  SMALL_BULKY: { longest: 37, median: 28, shortest: 20, lengthPlusGirth: 130, maxLb: 50 },
  LARGE_BULKY: { longest: 59, median: 33, shortest: 33, lengthPlusGirth: 130, maxLb: 50 },
  XL_TO_50: { maxLb: 50 },
  XL_TO_70: { maxLb: 70 },
  XL_TO_150: { maxLb: 150 },
} as const;

export type SizeTierText =
  | 'Small Standard'
  | 'Large Standard'
  | 'Small Bulky'
  | 'Large Bulky'
  | 'Extra-large (0-50 lb)'
  | 'Extra-large (50-70 lb)'
  | 'Extra-large (70-150 lb)'
  | 'Extra-large (150+ lb)'
  | 'Unknown';

export type SizeTierStatus = 'good' | 'warn' | 'bad' | 'info';

export type SizeTierResult = {
  text: SizeTierText;
  status: SizeTierStatus;
  /** Set only when the answer is Unknown, so a caller can log WHY it abstained. */
  reason?: 'no_dimensions' | 'unreadable_dimensions' | 'unreadable_weight';
};

/**
 * Keepa reports dimensions in millimetres and weights in grams. Passing the
 * raw values plus their unit keeps the conversion in one place rather than
 * relying on the caller having already converted -- the mistake that let the
 * old test compare a millimetre figure against an inch threshold.
 */
export function classifyFbaSizeTier(d: {
  lengthMm: number | null | undefined;
  widthMm: number | null | undefined;
  heightMm: number | null | undefined;
  weightG: number | null | undefined;
}): SizeTierResult {
  const mm = [d.lengthMm, d.widthMm, d.heightMm];
  if (mm.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
    return { text: 'Unknown', status: 'info', reason: 'unreadable_dimensions' };
  }
  if (typeof d.weightG !== 'number' || !Number.isFinite(d.weightG) || d.weightG <= 0) {
    return { text: 'Unknown', status: 'info', reason: 'unreadable_weight' };
  }

  const sides = (mm as number[]).map((v) => v / 25.4).sort((a, b) => b - a);
  const [longest, median, shortest] = sides;
  const lb = d.weightG / 453.592;
  // Amazon's "length + girth": the longest side plus twice the other two.
  const lengthPlusGirth = longest + 2 * (median + shortest);

  const ss = FBA_TIERS.SMALL_STANDARD;
  if (longest <= ss.longest && median <= ss.median && shortest <= ss.shortest && lb <= ss.maxLb) {
    return { text: 'Small Standard', status: 'good' };
  }
  const ls = FBA_TIERS.LARGE_STANDARD;
  if (longest <= ls.longest && median <= ls.median && shortest <= ls.shortest && lb <= ls.maxLb) {
    return { text: 'Large Standard', status: 'good' };
  }
  const sb = FBA_TIERS.SMALL_BULKY;
  if (
    longest <= sb.longest && median <= sb.median && shortest <= sb.shortest &&
    lengthPlusGirth <= sb.lengthPlusGirth && lb <= sb.maxLb
  ) {
    return { text: 'Small Bulky', status: 'warn' };
  }
  const lbk = FBA_TIERS.LARGE_BULKY;
  if (
    longest <= lbk.longest && median <= lbk.median && shortest <= lbk.shortest &&
    lengthPlusGirth <= lbk.lengthPlusGirth && lb <= lbk.maxLb
  ) {
    return { text: 'Large Bulky', status: 'warn' };
  }
  // Extra-large by exclusion, then split on weight alone.
  if (lb <= FBA_TIERS.XL_TO_50.maxLb) return { text: 'Extra-large (0-50 lb)', status: 'bad' };
  if (lb <= FBA_TIERS.XL_TO_70.maxLb) return { text: 'Extra-large (50-70 lb)', status: 'bad' };
  if (lb <= FBA_TIERS.XL_TO_150.maxLb) return { text: 'Extra-large (70-150 lb)', status: 'bad' };
  return { text: 'Extra-large (150+ lb)', status: 'bad' };
}
