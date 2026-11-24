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
// NOTE: the two oversize rows carry Amazon's PRE-2023 names and cutoffs
// ("Large Oversize" / "Oversize" / "Heavy/Bulky"); Amazon now uses Large Bulky
// and four Extra-large weight bands. Carried over verbatim from the panel so
// this change is a correctness fix rather than a silent renaming of tiers the
// seller recognises. Standard-size, where this catalog almost entirely sits,
// is current.

export const FBA_TIERS = {
  SMALL_STANDARD: { longest: 15, median: 12, shortest: 0.75, maxLb: 1 },
  LARGE_STANDARD: { longest: 18, median: 14, shortest: 8, maxLb: 20 },
  LARGE_OVERSIZE: { longest: 60, girth: 130, maxLb: 50 },
  OVERSIZE: { longest: 108, girth: 165 },
} as const;

export type SizeTierText =
  | 'Small Standard'
  | 'Large Standard'
  | 'Large Oversize'
  | 'Oversize'
  | 'Heavy/Bulky'
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
  const girth = longest + 2 * (median + shortest);

  const ss = FBA_TIERS.SMALL_STANDARD;
  if (longest <= ss.longest && median <= ss.median && shortest <= ss.shortest && lb <= ss.maxLb) {
    return { text: 'Small Standard', status: 'good' };
  }
  const ls = FBA_TIERS.LARGE_STANDARD;
  if (longest <= ls.longest && median <= ls.median && shortest <= ls.shortest && lb <= ls.maxLb) {
    return { text: 'Large Standard', status: 'good' };
  }
  const lo = FBA_TIERS.LARGE_OVERSIZE;
  if (longest <= lo.longest && girth <= lo.girth && lb <= lo.maxLb) {
    return { text: 'Large Oversize', status: 'warn' };
  }
  const os = FBA_TIERS.OVERSIZE;
  if (longest <= os.longest && girth <= os.girth) {
    return { text: 'Oversize', status: 'warn' };
  }
  return { text: 'Heavy/Bulky', status: 'bad' };
}
