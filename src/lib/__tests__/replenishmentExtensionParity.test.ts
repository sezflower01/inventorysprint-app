// Does the create-listing extension's reorder forecast agree with the shared
// model it claims to be a port of?
//
// WHY THIS EXISTS. extension-create/background.js carried the comment
// "verbatim port of src/lib/replenishment.ts" above a forecast that was not
// one: the shared model excludes Reserved units when the last FBA receipt is
// older than reservedFreshDays, and the extension added Reserved
// unconditionally. Two implementations of one model, and the extension was the
// optimistic one.
//
// On a real ASIN -- 54 available, 10 inbound, 23 reserved, 37 sold in 30 days
// -- that was the difference between "0 units to reorder" and 17 at a 60-day
// horizon. The arithmetic was right in both; they were answering different
// questions.
//
// This is the same failure as the P&L web/Excel drift recorded in this repo:
// one model, two implementations, a rule added to only one of them. A grep
// would not catch the next divergence, so this test EXECUTES the extension's
// own function rather than reading it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { computeReplenishmentBreakdown } from '../replenishment';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BG = path.join(ROOT, 'extension-create', 'background.js');

type PipelineFn = (
  available: number,
  inbound: number,
  reserved: number,
  daysSinceLastReceived: number | null,
  reservedFreshDays?: number,
) => { reservedExcluded: boolean; effectiveReserved: number; totalPipelineStock: number };

/**
 * Pull the extension's pipeline-stock rule out of its service worker and run
 * it. background.js cannot be imported -- it registers chrome.* listeners at
 * the top level -- so the one function that decides this is extracted by name
 * and evaluated in a bare context.
 */
function extensionPipeline(): PipelineFn {
  const src = readFileSync(BG, 'utf8');
  const fn = src.match(/function repPipelineStock[\s\S]*?\n\}/);
  expect(
    fn,
    'extension-create/background.js no longer defines repPipelineStock -- if the '
      + 'pipeline rule was inlined or renamed, this parity test is blind and the '
      + 'two implementations can drift again',
  ).toBeTruthy();

  const freshConst = src.match(/const REP_RESERVED_FRESH_DAYS = (\d+);/);
  expect(freshConst, 'the extension no longer declares its freshness window').toBeTruthy();

  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `const REP_RESERVED_FRESH_DAYS = ${freshConst![1]};\n${fn![0]}\nthis.__f = repPipelineStock;`,
    sandbox,
  );
  return sandbox.__f as PipelineFn;
}

/** The ASIN that prompted this, as the panel reported it. */
const ASIN = { available: 54, inbound: 10, reserved: 23, soldIn30Days: 37 };

/** The shared model, with everything but the Reserved inputs held constant. */
function shared(daysSinceLastReceived: number | null, coverageDays: number) {
  return computeReplenishmentBreakdown({
    available: ASIN.available,
    inbound: ASIN.inbound,
    reserved: ASIN.reserved,
    salesUnits: ASIN.soldIn30Days,
    salesPeriodDays: 30,
    coverageDays,
    supplierLeadTimeDays: 0,
    prepDays: 0,
    shippingToAmazonDays: 0,
    amazonReceivingDays: 0,
    safetyPercent: 0.1,
    daysSinceLastReceived,
  });
}

describe('create-listing extension reorder forecast vs the shared model', () => {
  it('agrees on the pipeline stock whichever side of the window the receipt falls', () => {
    const extPipeline = extensionPipeline();

    // OVER seven days: Reserved is more likely already committed to a customer
    // order than still checking in, so it cannot cover future demand.
    const stale = extPipeline(ASIN.available, ASIN.inbound, ASIN.reserved, 30);
    expect(stale.reservedExcluded).toBe(true);
    expect(stale.totalPipelineStock).toBe(64);
    expect(stale.totalPipelineStock).toBe(shared(30, 30).totalPipelineStock);
    expect(stale.reservedExcluded).toBe(shared(30, 30).reservedExcluded);

    // UNDER seven days: it is probably still checking in from that shipment.
    const fresh = extPipeline(ASIN.available, ASIN.inbound, ASIN.reserved, 3);
    expect(fresh.reservedExcluded).toBe(false);
    expect(fresh.totalPipelineStock).toBe(87);
    expect(fresh.totalPipelineStock).toBe(shared(3, 30).totalPipelineStock);
    expect(fresh.reservedExcluded).toBe(shared(3, 30).reservedExcluded);
  });

  it('treats the boundary and an unknown receipt date the same way as the shared model', () => {
    const extPipeline = extensionPipeline();
    // Exactly seven days is NOT stale: the shared rule is strictly greater.
    for (const days of [null, 0, 1, 7, 8, 365] as (number | null)[]) {
      const ext = extPipeline(ASIN.available, ASIN.inbound, ASIN.reserved, days);
      const lib = shared(days, 30);
      expect(
        ext.totalPipelineStock,
        `daysSinceLastReceived=${days}: extension says ${ext.totalPipelineStock}, `
          + `shared model says ${lib.totalPipelineStock}`,
      ).toBe(lib.totalPipelineStock);
      expect(ext.reservedExcluded).toBe(lib.reservedExcluded);
    }
  });

  it('unknown keeps Reserved, which is the optimistic direction and is deliberate', () => {
    // null means no received shipment was FOUND for the ASIN, not that the
    // stock is stale -- and a failed lookup lands here too. Failing the other
    // way would cut 23 units off a forecast because one query timed out.
    // Recorded as a test because it is a decision, not an accident, and it
    // belongs in one place rather than two.
    const extPipeline = extensionPipeline();
    expect(extPipeline(ASIN.available, ASIN.inbound, ASIN.reserved, null).totalPipelineStock).toBe(87);
    expect(shared(null, 30).totalPipelineStock).toBe(87);
  });

  it('carries through to the reorder quantity, which is what the user sees', () => {
    // The whole point: the pipeline difference is not academic. At a 60-day
    // horizon this ASIN needs nothing if Reserved counts, and 17 units if it
    // does not -- and "0" was what the panel showed.
    const keptReserved = shared(3, 60);
    const droppedReserved = shared(30, 60);

    expect(keptReserved.totalPipelineStock).toBe(87);
    expect(keptReserved.replenishQty).toBe(0);

    expect(droppedReserved.totalPipelineStock).toBe(64);
    expect(droppedReserved.replenishQty).toBe(17);

    // And the days-of-stock figure the panel prints moves with it.
    expect(Math.round(keptReserved.daysUntilStockout!)).toBe(71);
    expect(Math.round(droppedReserved.daysUntilStockout!)).toBe(52);
  });

  it('the extension still reports which sales window drove the rate', () => {
    // Not a parity check -- a guard on the other half of this change. The
    // panel showed 7d/30d/90d side by side as though they were equals while
    // only one fed the forecast. On this ASIN the 90-day rate was double the
    // 30-day rate, which is 38 days of cover against 71.
    const bg = readFileSync(BG, 'utf8');
    expect(bg, 'the extension no longer reports which window drove ADS').toMatch(/adsSource:/);
    expect(bg, 'the extension no longer reports the span ADS was averaged over').toMatch(/adsDays:/);

    const panel = readFileSync(path.join(ROOT, 'extension-create', 'panel.js'), 'utf8');
    expect(panel, 'the meta line no longer names the sales window').toMatch(/of sales/);
    // The span is the ACTUAL one, not a flat 30: the window is measured from
    // the first order inside it, so a single sale 9 days ago averages over 9.
    expect(panel, 'the meta line hardcodes a window instead of using the measured span')
      .toMatch(/adsDays/);
  });

  it('the forecast actually CALLS the rule, not merely defines it', () => {
    // THIS TEST EXISTS BECAUSE THE REST OF THE FILE PASSED WITHOUT IT.
    //
    // The checks above extract repPipelineStock and run it, which proves the
    // rule is right -- and says nothing about whether the forecast uses it. I
    // reintroduced the original divergence as a check, replacing the call with
    // an inline sum, and all six tests stayed green. A test that cannot fail
    // for the bug it was written about is worse than no test, because it
    // reports the bug as fixed.
    const bg = readFileSync(BG, 'utf8');
    const from = bg.indexOf('case "INVSPRNT_REPLENISH_FORECAST"');
    const to = bg.indexOf('default:', from);
    expect(from, 'the forecast handler has gone').toBeGreaterThan(-1);
    const handler = bg.slice(from, to > from ? to : from + 8000);

    // The call, with the receipt date fed in -- a call that passes null always
    // would keep Reserved for ever and look identical from the outside.
    expect(
      handler,
      'the forecast no longer calls repPipelineStock, so the Reserved rule is '
        + 'defined but unused and the two implementations have drifted again',
    ).toMatch(/repPipelineStock\(\s*available,\s*inbound,\s*reserved,\s*daysSinceLastReceived/);

    // And no second, independent pipeline sum anywhere in the handler, in any
    // spelling. This is what the previous version of this test got wrong: it
    // pinned one exact line, so the same bug in an object literal slipped past.
    const sums = handler.match(/available\s*\+\s*inbound\s*\+\s*reserved/g) || [];
    expect(
      sums,
      'the handler adds Reserved unconditionally somewhere, bypassing the rule: '
        + sums.length + ' inline sum(s) found',
    ).toHaveLength(0);

    // The receipt date must be derived from the shipment tables, not assumed.
    // It is NOT on the inventory row, which is where it was expected to be.
    expect(handler, 'the received-date lookup has gone, so Reserved is never excluded')
      .toMatch(/fba_shipment_items/);
    expect(handler, 'the newest received_date is no longer read')
      .toMatch(/fba_shipments/);
  });
});
