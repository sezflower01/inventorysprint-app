// Tests for the web analyser's size tier, and for its agreement with the
// Chrome panel's copy.
//
// Run with:
//   deno test --allow-read supabase/functions/_tests/analyzer-size-tier/fba_size_tier_test.ts
//
// The behavioural cases are the ones the old single-axis test got wrong. The
// last test is a source scan: the two implementations live in different
// runtimes and cannot import one file, so the only thing that can catch them
// drifting apart is reading both and comparing the numbers. That is the same
// reason _tests/internal-caller-gate/ordering_test.ts reads source -- a
// property of agreement, which no amount of calling either function reveals.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyFbaSizeTier, FBA_TIERS } from '../../analyzer-product-snapshot/fbaSizeTier.ts';

const IN = 25.4; // mm per inch
const LB = 453.592; // grams per pound

function box(inches: [number, number, number], pounds: number) {
  return {
    lengthMm: inches[0] * IN,
    widthMm: inches[1] * IN,
    heightMm: inches[2] * IN,
    weightG: pounds * LB,
  };
}

Deno.test('the reported item is Large Standard', () => {
  // 9.5 x 8 x 5 in at 8 oz -- the ASIN from the 2026-11-23 report.
  const r = classifyFbaSizeTier(box([9.5, 8, 5], 0.5));
  assertEquals(r.text, 'Large Standard');
  assertEquals(r.status, 'good');
});

Deno.test('height is no longer the only axis that counts', () => {
  // A 30 in pole. The old test looked at packageHeight only, so whichever
  // field the 30 landed in decided the answer; now all three orderings agree.
  // Small Bulky since 2026-01-15; this was Large Oversize under the old table.
  const expected = 'Small Bulky';
  assertEquals(classifyFbaSizeTier(box([30, 2, 2], 2)).text, expected);
  assertEquals(classifyFbaSizeTier(box([2, 30, 2], 2)).text, expected);
  assertEquals(classifyFbaSizeTier(box([2, 2, 30], 2)).text, expected);
});

Deno.test('a tall slim box under the caps is standard size, not Oversize', () => {
  // 17.5 in tall: the old 460 mm (18.1 in) height threshold called anything
  // near this Oversize on the wrong grounds. It is Large Standard.
  assertEquals(classifyFbaSizeTier(box([17.5, 6, 4], 3)).text, 'Large Standard');
});

Deno.test('weight is no longer ignored', () => {
  // One box, three weights. The old test could not tell these apart at all,
  // and under the 2026 table each lands in a different tier.
  assertEquals(classifyFbaSizeTier(box([18, 14, 8], 19)).text, 'Large Standard');
  assertEquals(classifyFbaSizeTier(box([18, 14, 8], 21)).text, 'Small Bulky');
  assertEquals(classifyFbaSizeTier(box([18, 14, 8], 60)).text, 'Extra-large (50-70 lb)');
  assertEquals(classifyFbaSizeTier(box([18, 14, 8], 200)).text, 'Extra-large (150+ lb)');
});

Deno.test('Small Standard boundaries', () => {
  assertEquals(classifyFbaSizeTier(box([15, 12, 0.75], 1)).text, 'Small Standard');
  assertEquals(classifyFbaSizeTier(box([15, 12, 0.76], 1)).text, 'Large Standard');
  assertEquals(classifyFbaSizeTier(box([15, 12, 0.75], 1.1)).text, 'Large Standard');
});

Deno.test('length + girth decides the top tiers', () => {
  // Every side is inside Large Bulky (59/33/33) and 40 lb is under its 50 lb
  // cap, so only length + girth = 50 + 2*(30+30) = 170 against the 130 cap
  // excludes it.
  const r = classifyFbaSizeTier(box([50, 30, 30], 40));
  assertEquals(r.text, 'Extra-large (0-50 lb)');
  assertEquals(r.status, 'bad');
});

Deno.test('the 2026 bulky split is honoured', () => {
  // Longest side is the only thing separating these two.
  assertEquals(classifyFbaSizeTier(box([30, 20, 10], 30)).text, 'Small Bulky');
  assertEquals(classifyFbaSizeTier(box([45, 30, 10], 40)).text, 'Large Bulky');
});

Deno.test('missing data abstains instead of claiming Standard Size', () => {
  // The old expression read `p.packageHeight && ... : 'Standard Size'`, so a
  // product with NO dimensions at all was reported as Standard Size -- a
  // confident answer from no data.
  assertEquals(classifyFbaSizeTier({ lengthMm: null, widthMm: null, heightMm: null, weightG: null }).text, 'Unknown');
  assertEquals(
    classifyFbaSizeTier({ lengthMm: 100, widthMm: 100, heightMm: 100, weightG: null }).reason,
    'unreadable_weight',
  );
  assertEquals(
    classifyFbaSizeTier({ lengthMm: 0, widthMm: 100, heightMm: 100, weightG: 100 }).reason,
    'unreadable_dimensions',
  );
});

Deno.test('the panel and the analyser still use the same thresholds', async () => {
  const js = await Deno.readTextFile(
    new URL('../../../../extension/sizeTier.js', import.meta.url),
  );

  // Pull the panel's TIERS literal out of the source and compare it to ours
  // field by field, so a number changed on one side alone fails here.
  const block = js.match(/var TIERS = \{([\s\S]*?)\n  \};/);
  if (!block) throw new Error('could not find the TIERS literal in extension/sizeTier.js');

  const panel: Record<string, Record<string, number>> = {};
  for (const line of block[1].split('\n')) {
    const row = line.match(/(\w+):\s*\{([^}]*)\}/);
    if (!row) continue;
    const fields: Record<string, number> = {};
    for (const pair of row[2].split(',')) {
      const kv = pair.match(/(\w+):\s*([\d.]+)/);
      if (kv) fields[kv[1]] = Number(kv[2]);
    }
    panel[row[1]] = fields;
  }

  assertEquals(
    Object.keys(panel).sort(),
    Object.keys(FBA_TIERS).sort(),
    'the two files describe a different set of tiers',
  );
  for (const [tier, fields] of Object.entries(panel)) {
    assertEquals(
      fields,
      { ...(FBA_TIERS as Record<string, Record<string, number>>)[tier] },
      `threshold drift in ${tier}`,
    );
  }
});
