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
// SHIPPING WEIGHT (closed 2026-11-26).
//
// Amazon places a tier on SHIPPING weight: the greater of unit weight and
// dimensional weight, volume / 139 for the US. This used actual weight alone,
// so a large light item was classified a tier -- sometimes several -- too
// cheap.
//
// The small-standard and extra-large-150+ exceptions people cite are about the
// FEE BASIS, not tier placement: those two are BILLED on unit weight.
// Placement uses shipping weight throughout, so this applies it throughout.
//
// The 2 in floor on the two smaller sides applies only to bulky and
// extra-large, which reads circular -- the tier would decide the weight that
// decides the tier. It is not, because the standard-size ENVELOPE is a test on
// dimensions alone (18/14/8), answerable before any weight is involved.
//
// Two facts worth knowing before anyone "simplifies" this:
//   - Dimensional weight can NEVER change a standard-size verdict. The largest
//     standard box, 18 x 14 x 8, is 2,016 cu in = 14.5 lb against a 20 lb cap;
//     the largest small-standard box, 15 x 12 x 0.75, is 0.97 lb against 1 lb.
//     So omitting the floor inside the envelope costs nothing, and APPLYING it
//     there would break things: flooring a 0.75 in side to 2 in turns a 1 lb
//     small-standard item into 2.59 lb.
//   - length + girth is measured on the REAL sides, never the floored ones.
//     The floor prices air inside a shipping box; it does not inflate the
//     envelope an item is tested against.

export const FBA_TIERS = {
  SMALL_STANDARD: { longest: 15, median: 12, shortest: 0.75, maxLb: 1 },
  LARGE_STANDARD: { longest: 18, median: 14, shortest: 8, maxLb: 20 },
  SMALL_BULKY: { longest: 37, median: 28, shortest: 20, lengthPlusGirth: 130, maxLb: 50 },
  LARGE_BULKY: { longest: 59, median: 33, shortest: 33, lengthPlusGirth: 130, maxLb: 50 },
  XL_TO_50: { maxLb: 50 },
  XL_TO_70: { maxLb: 70 },
  XL_TO_150: { maxLb: 150 },
  // Not a tier: the dimensional-weight constants. They live in this literal on
  // purpose, because the parity test compares its keys and numbers field by
  // field -- a divisor kept outside it could drift between the two runtimes
  // silently, which is the one failure this arrangement exists to prevent.
  DIM_WEIGHT: { divisor: 139, bulkyMinSide: 2 },
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
  /** The weight the tier was actually placed on: max(unit, dimensional). */
  shippingLb?: number;
  dimWeightLb?: number;
  unitLb?: number;
  /**
   * Which of the two won. Lets a caller explain a surprising tier rather than
   * only assert it: "Extra-large because it bills on 86 lb of air, not 5 lb."
   */
  weightBasis?: 'unit' | 'dimensional';
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
  const ls = FBA_TIERS.LARGE_STANDARD;
  const dw = FBA_TIERS.DIM_WEIGHT;

  // Dimensions alone, so this is answerable before any weight is known.
  const withinStandardEnvelope =
    longest <= ls.longest && median <= ls.median && shortest <= ls.shortest;
  const dimMedian = withinStandardEnvelope ? median : Math.max(median, dw.bulkyMinSide);
  const dimShortest = withinStandardEnvelope ? shortest : Math.max(shortest, dw.bulkyMinSide);
  const dimLb = (longest * dimMedian * dimShortest) / dw.divisor;

  // Shipping weight is what Amazon places the tier on.
  const shipLb = Math.max(lb, dimLb);
  const weigh = {
    shippingLb: shipLb,
    dimWeightLb: dimLb,
    unitLb: lb,
    weightBasis: (dimLb > lb ? 'dimensional' : 'unit') as 'dimensional' | 'unit',
  };

  if (longest <= ss.longest && median <= ss.median && shortest <= ss.shortest && shipLb <= ss.maxLb) {
    return { text: 'Small Standard', status: 'good', ...weigh };
  }
  if (longest <= ls.longest && median <= ls.median && shortest <= ls.shortest && shipLb <= ls.maxLb) {
    return { text: 'Large Standard', status: 'good', ...weigh };
  }
  const sb = FBA_TIERS.SMALL_BULKY;
  if (
    longest <= sb.longest && median <= sb.median && shortest <= sb.shortest &&
    lengthPlusGirth <= sb.lengthPlusGirth && shipLb <= sb.maxLb
  ) {
    return { text: 'Small Bulky', status: 'warn', ...weigh };
  }
  const lbk = FBA_TIERS.LARGE_BULKY;
  if (
    longest <= lbk.longest && median <= lbk.median && shortest <= lbk.shortest &&
    lengthPlusGirth <= lbk.lengthPlusGirth && shipLb <= lbk.maxLb
  ) {
    return { text: 'Large Bulky', status: 'warn', ...weigh };
  }
  // Extra-large by exclusion, then split on shipping weight alone.
  if (shipLb <= FBA_TIERS.XL_TO_50.maxLb) return { text: 'Extra-large (0-50 lb)', status: 'bad', ...weigh };
  if (shipLb <= FBA_TIERS.XL_TO_70.maxLb) return { text: 'Extra-large (50-70 lb)', status: 'bad', ...weigh };
  if (shipLb <= FBA_TIERS.XL_TO_150.maxLb) return { text: 'Extra-large (70-150 lb)', status: 'bad', ...weigh };
  return { text: 'Extra-large (150+ lb)', status: 'bad', ...weigh };
}
