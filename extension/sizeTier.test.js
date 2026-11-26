// Unit tests for extension/sizeTier.js. Run with:
//   node --test extension/sizeTier.test.js
//
// The cases that matter are the ones where a wrong answer is plausible:
//
//   same box, four units     a tier must not depend on how the source spells mm
//   metric numbers, no unit  the exact misread that produced "Heavy/Bulky"
//   unrecognised unit        null, never a guess
//   0.75 in boundary         the only thing separating Small from Large Standard
//   long thin item           standard-size caps the LONGEST side, not the height
//
// Every dimension here is synthetic except the first, which is the item from
// the 2026-11-23 report: a 3.75 in cube in a 9.5 x 8 x 5 in box at 8 oz.

const test = require('node:test');
const assert = require('node:assert/strict');

global.self = global; // sizeTier.js attaches to `self`; Node has no self by default
require('./sizeTier.js');

const { classifyFbaSizeTier, INVSPRNT_UNITS } = global;

function box(overrides) {
  return {
    length: 9.5, width: 8, height: 5, dimUnit: 'inches',
    weight: 8, weightUnit: 'ounces',
    ...overrides,
  };
}

test('the reported item is Large Standard, not an oversize tier', () => {
  const r = classifyFbaSizeTier(box());
  assert.equal(r.text, 'Large Standard');
  assert.equal(r.level, 'good');
});

test('Small Standard needs the shortest side under 3/4 inch, so a 3.75 in cube is not it', () => {
  const r = classifyFbaSizeTier(box({ length: 3.75, width: 3.75, height: 3.75 }));
  assert.equal(r.text, 'Large Standard');
});

test('the same box in cm, mm and m gives the same tier', () => {
  const inch = classifyFbaSizeTier(box()).text;
  const cm = classifyFbaSizeTier(box({ length: 24.13, width: 20.32, height: 12.7, dimUnit: 'centimeters' })).text;
  const mm = classifyFbaSizeTier(box({ length: 241.3, width: 203.2, height: 127, dimUnit: 'millimeters' })).text;
  const m = classifyFbaSizeTier(box({ length: 0.2413, width: 0.2032, height: 0.127, dimUnit: 'meters' })).text;
  assert.equal(cm, inch);
  assert.equal(mm, inch);
  assert.equal(m, inch);
});

test('unit spelling variants are all understood', () => {
  for (const u of ['mm', 'MM', 'millimeters', 'millimetres', 'Millimeter']) {
    const r = classifyFbaSizeTier(box({ length: 241.3, width: 203.2, height: 127, dimUnit: u }));
    assert.equal(r.text, 'Large Standard', `failed for dim unit ${u}`);
  }
  for (const u of ['g', 'grams', 'Gram']) {
    const r = classifyFbaSizeTier(box({ weight: 226.8, weightUnit: u }));
    assert.equal(r.text, 'Large Standard', `failed for weight unit ${u}`);
  }
});

// THE REGRESSION TEST. These metric numbers with no unit are what the old
// inline code read as inches, producing girth 901 in and "Heavy/Bulky".
test('metric numbers with a missing unit return Unknown, not a tier', () => {
  const r = classifyFbaSizeTier(box({ length: 241.3, width: 203.2, height: 127, dimUnit: null }));
  assert.equal(r.text, 'Unknown');
  assert.equal(r.level, 'unknown');
  assert.equal(r.reason, 'unreadable_dimensions');
  assert.notEqual(r.text, 'Heavy/Bulky');
});

test('an unrecognised unit returns Unknown rather than a guessed tier', () => {
  assert.equal(classifyFbaSizeTier(box({ dimUnit: 'cubits' })).text, 'Unknown');
  assert.equal(classifyFbaSizeTier(box({ weightUnit: 'stones' })).text, 'Unknown');
  assert.equal(classifyFbaSizeTier(box({ weightUnit: null })).reason, 'unreadable_weight');
});

test('a missing or zero dimension returns Unknown', () => {
  assert.equal(classifyFbaSizeTier(box({ height: null })).text, 'Unknown');
  assert.equal(classifyFbaSizeTier(box({ height: 0 })).text, 'Unknown');
  assert.equal(classifyFbaSizeTier(null).reason, 'no_dimensions');
});

test('Small Standard boundary: 0.75 in is in, 0.76 in is out', () => {
  const dims = { length: 15, width: 12, dimUnit: 'inches', weight: 16, weightUnit: 'ounces' };
  assert.equal(classifyFbaSizeTier({ ...dims, height: 0.75 }).text, 'Small Standard');
  assert.equal(classifyFbaSizeTier({ ...dims, height: 0.76 }).text, 'Large Standard');
});

test('Small Standard boundary: 16 oz is in, 17 oz is out', () => {
  const dims = { length: 15, width: 12, height: 0.75, dimUnit: 'inches', weightUnit: 'ounces' };
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 16 }).text, 'Small Standard');
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 17 }).text, 'Large Standard');
});

test('Large Standard boundary: 18 x 14 x 8 at 20 lb is in, heavier is not', () => {
  const dims = { length: 18, width: 14, height: 8, dimUnit: 'inches', weightUnit: 'pounds' };
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 20 }).text, 'Large Standard');
  assert.notEqual(classifyFbaSizeTier({ ...dims, weight: 21 }).text, 'Large Standard');
});

test('standard-size caps the LONGEST side, whichever field it arrives in', () => {
  // A 30 in pole is not standard size however the axes are labelled, which is
  // what a height-only test gets wrong.
  for (const d of [
    { length: 30, width: 2, height: 2 },
    { length: 2, width: 30, height: 2 },
    { length: 2, width: 2, height: 30 },
  ]) {
    const r = classifyFbaSizeTier({ ...d, dimUnit: 'inches', weight: 2, weightUnit: 'pounds' });
    // Small Bulky since 2026-01-15; this was Large Oversize under the old table.
    assert.equal(r.text, 'Small Bulky', `failed for ${JSON.stringify(d)}`);
  }
});

test('length + girth, not length alone, pushes an item out of the bulky tiers', () => {
  const r = classifyFbaSizeTier({
    length: 50, width: 30, height: 30, dimUnit: 'inches', weight: 40, weightUnit: 'pounds',
  });
  // Every side is inside Large Bulky (59/33/33) and 40 lb is under its 50 lb
  // cap, so only length + girth = 50 + 2*(30+30) = 170 against the 130 cap
  // excludes it. That is the whole point of carrying the measure at all.
  assert.equal(r.text, 'Extra-large (0-50 lb)');
  assert.equal(r.level, 'bad');
});

// ─── the 2026 tier table ───────────────────────────────────────────────────

test('Small Bulky sits between Large Standard and Large Bulky', () => {
  // 30 x 20 x 10 at 30 lb: length + girth = 30 + 2*(20+10) = 90, inside 130.
  const r = classifyFbaSizeTier({
    length: 30, width: 20, height: 10, dimUnit: 'inches', weight: 30, weightUnit: 'pounds',
  });
  assert.equal(r.text, 'Small Bulky');
  assert.equal(r.level, 'caution');
});

test('past the Small Bulky side caps but inside Large Bulky is Large Bulky', () => {
  // Longest 45 in exceeds Small Bulky's 37, and length + girth = 125 is still
  // inside the shared 130 cap.
  const r = classifyFbaSizeTier({
    length: 45, width: 30, height: 10, dimUnit: 'inches', weight: 40, weightUnit: 'pounds',
  });
  assert.equal(r.text, 'Large Bulky');
  assert.equal(r.level, 'caution');
});

test('over 50 lb is Extra-large however small the box, and the band follows the weight', () => {
  // A small dense box. Both bulky tiers cap at 50 lb, so weight alone decides.
  const dims = { length: 20, width: 15, height: 10, dimUnit: 'inches', weightUnit: 'pounds' };
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 50 }).text, 'Small Bulky');
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 51 }).text, 'Extra-large (50-70 lb)');
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 70 }).text, 'Extra-large (50-70 lb)');
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 71 }).text, 'Extra-large (70-150 lb)');
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 150 }).text, 'Extra-large (70-150 lb)');
  assert.equal(classifyFbaSizeTier({ ...dims, weight: 151 }).text, 'Extra-large (150+ lb)');
});

test('no pre-2023 tier name can be returned any more', () => {
  // The old names are gone from Amazon's taxonomy. If one reappears here, the
  // table has been reverted rather than updated.
  const gone = new Set(['Large Oversize', 'Oversize', 'Heavy/Bulky']);
  for (const w of [2, 30, 51, 100, 200]) {
    for (const d of [[9.5, 8, 5], [30, 2, 2], [50, 30, 30], [100, 40, 40]]) {
      const r = classifyFbaSizeTier({
        length: d[0], width: d[1], height: d[2], dimUnit: 'inches',
        weight: w, weightUnit: 'pounds',
      });
      assert.ok(!gone.has(r.text), `got retired tier "${r.text}" for ${JSON.stringify(d)} at ${w} lb`);
    }
  }
});

test('the converters return null rather than a number they cannot justify', () => {
  assert.equal(INVSPRNT_UNITS.toInches(10, 'cubits'), null);
  assert.equal(INVSPRNT_UNITS.toInches(10, null), null);
  assert.equal(INVSPRNT_UNITS.toInches(0, 'inches'), null);
  assert.equal(INVSPRNT_UNITS.toPounds(10, 'stones'), null);
  assert.equal(INVSPRNT_UNITS.toInches(25.4, 'mm'), 1);
  assert.equal(INVSPRNT_UNITS.toPounds(16, 'oz'), 1);
});
