// US FBA size tier, and the unit conversion that both the tier and the panel's
// own dimension display go through.
//
// Pure functions, no DOM and no chrome.* -- same pattern as plRisk.js and
// decisionSignal.js -- so this file loads standalone in Node for unit tests
// (see sizeTier.test.js) as well as in the extension panel.
//
// WHY THIS LEFT panel.js
//
// The tier used to be computed inline in panel.js with its own conversion
// block that handled only mm and cm. The display went through toInches(),
// which also handles metres and -- crucially -- returns null for a unit it
// does not recognise. So the two disagreed in the dangerous direction: the
// display converted correctly while the tier silently treated the raw number
// as inches. A source in millimetres with an absent or unrecognised unit
// string read 241 x 203 x 127 as INCHES, which is girth 901 in and comes out
// as "Heavy/Bulky" -- a small item confidently labelled the most expensive
// tier there is. Observed 2026-11-23 on an item whose package is
// 9.5 x 8 x 5 in at 8 oz.
//
// The rule here is the one readPage.js states for ranks and units: never
// guess. An unreadable unit returns "Unknown", because a tier is used to
// judge whether an item is worth sourcing, and a wrong tier that LOOKS
// confident is worse than an admitted gap.
//
// Absent is treated as unreadable too, not as inches. That is a deliberate
// change from the old inline behaviour: an absent unit was the exact case
// that produced the Heavy/Bulky misread, and defaulting it to inches is a
// guess that happens to be right only for one of the four units Amazon's
// catalog uses.
(function (root) {
  function normDimUnit(u) {
    if (!u) return "";
    const s = String(u).toLowerCase().trim();
    if (s.startsWith("centim")) return "cm";
    if (s.startsWith("millim")) return "mm";
    if (s.startsWith("inch")) return "in";
    if (s.startsWith("meter") || s.startsWith("metre")) return "m";
    return s;
  }

  function normWtUnit(u) {
    if (!u) return "";
    const s = String(u).toLowerCase().trim();
    if (s.startsWith("gram")) return "g";
    if (s.startsWith("kilo")) return "kg";
    if (s.startsWith("pound")) return "lb";
    if (s.startsWith("ounce")) return "oz";
    return s;
  }

  /** Inches, or null when the value or its unit cannot be read. */
  function toInches(n, unit) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = normDimUnit(unit);
    if (u === "in") return n;
    if (u === "cm") return n / 2.54;
    if (u === "mm") return n / 25.4;
    if (u === "m") return n * 39.3701;
    return null;
  }

  /** Pounds, or null when the value or its unit cannot be read. */
  function toPounds(n, unit) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = normWtUnit(unit);
    if (u === "lb") return n;
    if (u === "oz") return n / 16;
    if (u === "g") return n / 453.592;
    if (u === "kg") return n * 2.20462;
    return null;
  }

  // Amazon's US tier boundaries, CURRENT as of 2026-11-26. Named so the test
  // can assert the Deno copy in
  // supabase/functions/analyzer-product-snapshot/fbaSizeTier.ts still matches:
  // the panel and the web analyser describing the same ASIN differently is the
  // other half of the bug this file fixes.
  //
  // Updated 2026-11-26 from the pre-2023 ladder ("Large Oversize" / "Oversize"
  // / "Heavy/Bulky", caps 60/108 in and girth 130/165) to Amazon's present
  // one. SMALL_BULKY is genuinely new -- Amazon introduced it on 15 January
  // 2026 between Large Standard and Large Bulky -- so an item that was Large
  // Bulky under the old table may now sit a tier cheaper.
  //
  // `lengthPlusGirth` is Amazon's own term: girth is 2 x (median + shortest),
  // and length + girth adds the longest side. The variable below computes
  // exactly that; it was previously called `girth`, which understated what it
  // held by one whole side.
  //
  // The three XL_* rows carry ONLY a weight cap. Extra-large is defined by
  // exclusion -- anything past Large Bulky's envelope, or over 50 lb -- and is
  // then split by weight alone, so there are no dimensions to record. They are
  // kept as flat numeric objects because the Deno parity test regex-parses
  // this literal; an array or a string in here is invisible to it, and a tier
  // the test cannot see is a tier that can drift.
  //
  // SHIPPING WEIGHT (closed 2026-11-26).
  //
  // Amazon places a tier on SHIPPING weight: the greater of unit weight and
  // dimensional weight, volume / 139 for the US. This used actual weight
  // alone, so a large light item was classified a tier -- sometimes several
  // tiers -- too cheap.
  //
  // The small-standard and extra-large-150+ exceptions people cite are about
  // the FEE BASIS, not tier placement: those two are BILLED on unit weight.
  // Placement uses shipping weight throughout, so this applies it throughout.
  //
  // THE CIRCULARITY, AND WHY IT IS NOT ONE. The 2 in floor on the two smaller
  // sides applies only to bulky and extra-large, so reading it naively you
  // need the tier to compute the weight that picks the tier. It dissolves
  // because the standard-size ENVELOPE is a test on dimensions alone
  // (18/14/8): which side of it an item falls on is known before any weight
  // is involved.
  //
  // Two facts worth knowing before anyone "simplifies" this:
  //   - Dimensional weight can NEVER change a standard-size verdict. The
  //     largest standard box, 18 x 14 x 8, is 2,016 cu in = 14.5 lb, under the
  //     20 lb cap; the largest small-standard box, 15 x 12 x 0.75, is 0.97 lb,
  //     under its 1 lb cap. So the floor's absence inside the envelope costs
  //     nothing, and applying the floor there WOULD break it -- flooring a
  //     0.75 in side to 2 in turns a 1 lb small-standard item into 2.59 lb.
  //   - length + girth is measured on the REAL sides, never the floored ones.
  //     The floor exists to price air inside a shipping box, not to inflate
  //     the envelope an item is tested against.
  var TIERS = {
    SMALL_STANDARD:  { longest: 15, median: 12,   shortest: 0.75, maxLb: 1 },
    LARGE_STANDARD:  { longest: 18, median: 14,   shortest: 8,    maxLb: 20 },
    SMALL_BULKY:     { longest: 37, median: 28,   shortest: 20, lengthPlusGirth: 130, maxLb: 50 },
    LARGE_BULKY:     { longest: 59, median: 33,   shortest: 33, lengthPlusGirth: 130, maxLb: 50 },
    XL_TO_50:        { maxLb: 50 },
    XL_TO_70:        { maxLb: 70 },
    XL_TO_150:       { maxLb: 150 },
    // Not a tier: the dimensional-weight constants. They live in this literal
    // on purpose, because the Deno parity test compares its keys and numbers
    // field by field -- a divisor kept outside it could drift between the two
    // runtimes silently, which is the one failure this whole arrangement
    // exists to prevent.
    DIM_WEIGHT:      { divisor: 139, bulkyMinSide: 2 },
  };

  /**
   * @param d {{length,width,height,dimUnit,weight,weightUnit}}
   * @returns {{level:"good"|"caution"|"bad"|"unknown", text:string, reason?:string}}
   */
  function classifyFbaSizeTier(d) {
    if (!d) return { level: "unknown", text: "Unknown", reason: "no_dimensions" };

    var inches = [d.length, d.width, d.height].map(function (n) {
      return toInches(n, d.dimUnit);
    });
    if (inches.some(function (v) { return v == null; })) {
      return { level: "unknown", text: "Unknown", reason: "unreadable_dimensions" };
    }
    var lb = toPounds(d.weight, d.weightUnit);
    if (lb == null) {
      return { level: "unknown", text: "Unknown", reason: "unreadable_weight" };
    }

    var sides = inches.slice().sort(function (a, b) { return b - a; });
    var longest = sides[0], median = sides[1], shortest = sides[2];
    // Amazon's "length + girth": the longest side plus twice the other two.
    // Always on the REAL sides -- see the note on the 2 in floor above.
    var lengthPlusGirth = longest + 2 * (median + shortest);

    var ss = TIERS.SMALL_STANDARD;
    var ls = TIERS.LARGE_STANDARD;
    var dw = TIERS.DIM_WEIGHT;

    // Dimensions alone, so this is answerable before any weight is known.
    var withinStandardEnvelope =
      longest <= ls.longest && median <= ls.median && shortest <= ls.shortest;
    var dimMedian = withinStandardEnvelope ? median : Math.max(median, dw.bulkyMinSide);
    var dimShortest = withinStandardEnvelope ? shortest : Math.max(shortest, dw.bulkyMinSide);
    var dimLb = (longest * dimMedian * dimShortest) / dw.divisor;

    // Shipping weight is what Amazon places the tier on.
    var shipLb = Math.max(lb, dimLb);
    var weigh = {
      shippingLb: shipLb,
      dimWeightLb: dimLb,
      unitLb: lb,
      // Named so a caller can explain a surprising tier rather than just
      // assert it: "Extra-large because it bills on 86 lb of air, not 5 lb".
      weightBasis: dimLb > lb ? "dimensional" : "unit",
    };

    if (longest <= ss.longest && median <= ss.median && shortest <= ss.shortest && shipLb <= ss.maxLb) {
      return Object.assign({ level: "good", text: "Small Standard" }, weigh);
    }
    if (longest <= ls.longest && median <= ls.median && shortest <= ls.shortest && shipLb <= ls.maxLb) {
      return Object.assign({ level: "good", text: "Large Standard" }, weigh);
    }
    var sb = TIERS.SMALL_BULKY;
    if (longest <= sb.longest && median <= sb.median && shortest <= sb.shortest
        && lengthPlusGirth <= sb.lengthPlusGirth && shipLb <= sb.maxLb) {
      return Object.assign({ level: "caution", text: "Small Bulky" }, weigh);
    }
    var lbk = TIERS.LARGE_BULKY;
    if (longest <= lbk.longest && median <= lbk.median && shortest <= lbk.shortest
        && lengthPlusGirth <= lbk.lengthPlusGirth && shipLb <= lbk.maxLb) {
      return Object.assign({ level: "caution", text: "Large Bulky" }, weigh);
    }
    // Extra-large by exclusion, then split on shipping weight alone.
    if (shipLb <= TIERS.XL_TO_50.maxLb) return Object.assign({ level: "bad", text: "Extra-large (0-50 lb)" }, weigh);
    if (shipLb <= TIERS.XL_TO_70.maxLb) return Object.assign({ level: "bad", text: "Extra-large (50-70 lb)" }, weigh);
    if (shipLb <= TIERS.XL_TO_150.maxLb) return Object.assign({ level: "bad", text: "Extra-large (70-150 lb)" }, weigh);
    return Object.assign({ level: "bad", text: "Extra-large (150+ lb)" }, weigh);
  }

  root.INVSPRNT_UNITS = {
    normDimUnit: normDimUnit,
    normWtUnit: normWtUnit,
    toInches: toInches,
    toPounds: toPounds,
  };
  root.INVSPRNT_SIZE_TIERS = TIERS;
  root.classifyFbaSizeTier = classifyFbaSizeTier;
})(typeof self !== "undefined" ? self : globalThis);
