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

  // Amazon's US tier boundaries. Named so the test can assert the Deno copy in
  // supabase/functions/analyzer-product-snapshot/fbaSizeTier.ts still matches:
  // the panel and the web analyser describing the same ASIN differently is the
  // other half of the bug this file fixes.
  //
  // NOTE: the two oversize rows carry Amazon's PRE-2023 names and cutoffs
  // ("Large Oversize" / "Oversize" / "Heavy/Bulky"). Amazon now uses Large
  // Bulky and four Extra-large weight bands. Left as-is here deliberately so
  // this change stays a units fix; standard-size, which is where the reported
  // misread happened and where almost all of this catalog sits, is correct.
  var TIERS = {
    SMALL_STANDARD:  { longest: 15, median: 12, shortest: 0.75, maxLb: 1 },
    LARGE_STANDARD:  { longest: 18, median: 14, shortest: 8,    maxLb: 20 },
    LARGE_OVERSIZE:  { longest: 60, girth: 130, maxLb: 50 },
    OVERSIZE:        { longest: 108, girth: 165 },
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
    var girth = longest + 2 * (median + shortest);

    var ss = TIERS.SMALL_STANDARD;
    if (longest <= ss.longest && median <= ss.median && shortest <= ss.shortest && lb <= ss.maxLb) {
      return { level: "good", text: "Small Standard" };
    }
    var ls = TIERS.LARGE_STANDARD;
    if (longest <= ls.longest && median <= ls.median && shortest <= ls.shortest && lb <= ls.maxLb) {
      return { level: "good", text: "Large Standard" };
    }
    var lo = TIERS.LARGE_OVERSIZE;
    if (longest <= lo.longest && girth <= lo.girth && lb <= lo.maxLb) {
      return { level: "caution", text: "Large Oversize" };
    }
    var os = TIERS.OVERSIZE;
    if (longest <= os.longest && girth <= os.girth) {
      return { level: "caution", text: "Oversize" };
    }
    return { level: "bad", text: "Heavy/Bulky" };
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
