// Does the create-listing extension tell the truth about a deleted ASIN?
//
// WHY THIS EXISTS. Reported 2026-11-16 on B0187YMN5K (Cow Camp garlic
// seasoning), an ASIN the seller had deleted in Seller Central. Print Label
// said:
//
//   "Not safe to print - no valid Amazon FNSKU found."
//   "No Amazon FNSKU (X00...) is stored for this listing yet. If Seller
//    Central shows one, type it in the FNSKU box below - or press Find again
//    in a minute once Amazon has synced."
//
// Both sentences are about a sync that is never going to happen. Amazon does
// not issue an FNSKU for a listing that no longer exists, so the advice sends
// the seller back every minute for ever. One message was answering two
// different questions -- "we have no FNSKU" and "this listing is alive" -- and
// only the second one decides what to do next.
//
// Add Purchase had the same blind spot from the other side: the handler drops
// ghost rows silently, so a deleted ASIN fell through to the seller's own
// purchase history and was rendered with the same card as a live listing.
//
// These checks EXECUTE the extension's own functions rather than reading them.
// background.js is a service worker and cannot be imported; panel.js expects a
// DOM. Both are extracted by name and run in a bare context -- the same
// technique as replenishmentExtensionParity.test.ts, which exists because a
// grep-only test in this file's position passed while the bug was live.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { isGhostRow } from '../ghostFilter';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BG = path.join(ROOT, 'extension-create', 'background.js');
const PANEL = path.join(ROOT, 'extension-create', 'panel.js');

type InvRow = {
  sku?: string | null;
  listing_status?: string | null;
  ghost_reason?: string | null;
  deleted_reason?: string | null;
};
type Verdict = {
  asin: string;
  state: 'live' | 'ghost' | 'absent';
  inventory_rows: number;
  live_skus: string[];
  ghosts: { sku: string | null; listing_status: string | null; reason: string | null }[];
  purchase_history: number;
};

/** Pull one named function (plus any constants it needs) out of a file. */
function extract(src: string, pattern: RegExp, what: string): string {
  const m = src.match(pattern);
  expect(m, `${what} is gone -- if it was renamed or inlined, this test is blind`).toBeTruthy();
  return m![0];
}

function backgroundRules() {
  const src = readFileSync(BG, 'utf8');
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(
    [
      extract(src, /const GHOST_LISTING_STATUSES = \[[^\]]*\];/, 'GHOST_LISTING_STATUSES'),
      extract(src, /function isGhostInventoryRow\([\s\S]*?\r?\n\}/, 'isGhostInventoryRow'),
      extract(src, /function listingPresenceVerdict\([\s\S]*?\r?\n\}/, 'listingPresenceVerdict'),
      'this.__ghost = isGhostInventoryRow; this.__verdict = listingPresenceVerdict;',
    ].join('\n'),
    sandbox,
  );
  return {
    isGhost: sandbox.__ghost as (r: InvRow | null) => boolean,
    verdict: sandbox.__verdict as (
      asin: string,
      inv: InvRow[] | null,
      live: InvRow[] | null,
      cl: unknown[] | null,
    ) => Verdict,
  };
}

function panelMessages() {
  const src = readFileSync(PANEL, 'utf8');
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(
    [
      // Stubs for the two things these functions touch outside themselves. A
      // DOM is not needed: every function under test returns a string.
      'const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");',
      'const printState = { presence: null };',
      'const VALID_FNSKU_RE = /^X[A-Z0-9]{9}$/;',
      extract(src, /function normalizeFnsku\([\s\S]*?\r?\n\}/, 'normalizeFnsku'),
      extract(src, /function isValidFnsku\([\s\S]*?\r?\n\}/, 'isValidFnsku'),
      extract(src, /function presenceFor\([\s\S]*?\r?\n\}/, 'presenceFor'),
      extract(src, /function ghostEvidenceHtml\([\s\S]*?\r?\n\}/, 'ghostEvidenceHtml'),
      extract(src, /function missingFnskuDetail\([\s\S]*?\r?\n\}/, 'missingFnskuDetail'),
      extract(src, /function fnskuBlockReason\([\s\S]*?\r?\n\}/, 'fnskuBlockReason'),
      'this.__detail = missingFnskuDetail; this.__reason = fnskuBlockReason;',
    ].join('\n'),
    sandbox,
  );
  return {
    detail: sandbox.__detail as (p: Partial<Verdict> | null) => string,
    reason: sandbox.__reason as (fnsku: unknown, asin: unknown, presence: Partial<Verdict> | null) => string | null,
  };
}

/** The reported ASIN, as the handler would have seen it. */
const DELETED_ASIN = 'B0187YMN5K';
const GHOST_ROWS: InvRow[] = [
  { sku: 'CC-GARLIC-15', listing_status: 'DELETED' },
  { sku: 'CC-GARLIC-15-B', listing_status: 'NOT_IN_CATALOG' },
];

describe('ghost listings in the create-listing extension', () => {
  it('calls a deleted ASIN a ghost, with the evidence', () => {
    const { verdict } = backgroundRules();
    const v = verdict(DELETED_ASIN, GHOST_ROWS, [], [{}]); // one purchase-history row

    expect(v.state).toBe('ghost');
    expect(v.inventory_rows).toBe(2);
    expect(v.live_skus).toEqual([]);
    expect(v.ghosts.map((g) => g.listing_status)).toEqual(['DELETED', 'NOT_IN_CATALOG']);
    // The verdict must be keyed, because the same loader runs for the Add
    // Purchase ASIN: an unkeyed one answers about whichever was looked up last.
    expect(v.asin).toBe(DELETED_ASIN);
    // And it must record that the card's title/image came from history, not a
    // live listing -- that is what the banner tells the user.
    expect(v.purchase_history).toBe(1);
  });

  it('one live SKU is enough to stay live, however many ghosts sit beside it', () => {
    const { verdict } = backgroundRules();
    const live: InvRow[] = [{ sku: 'CC-GARLIC-NEW', listing_status: 'ACTIVE' }];
    const v = verdict(DELETED_ASIN, [...GHOST_ROWS, ...live], live, []);
    expect(v.state).toBe('live');
    expect(v.live_skus).toEqual(['CC-GARLIC-NEW']);
    // The ghosts are still reported -- they are why the picker is shorter than
    // the row count -- but they do not condemn the listing.
    expect(v.ghosts).toHaveLength(2);
  });

  it('no inventory row at all is "absent", NOT "deleted"', () => {
    const { verdict } = backgroundRules();
    const v = verdict(DELETED_ASIN, [], [], [{}]);
    expect(v.state).toBe('absent');
    // Deleted-and-purged, never-listed and never-synced are indistinguishable
    // from here. Claiming deletion would be a verdict with no row behind it.
    expect(v.ghosts).toEqual([]);
  });

  it('treats INACTIVE as alive, which is deliberately NOT what Synced Inventory does', () => {
    const { isGhost } = backgroundRules();
    const inactive: InvRow = { sku: 'CC-GARLIC-15', listing_status: 'INACTIVE' };

    // The extension: still a listing.
    expect(isGhost(inactive)).toBe(false);
    // src/lib/ghostFilter.ts: hidden from Synced Inventory.
    expect(isGhostRow(inactive)).toBe(true);
    //
    // THE DIVERGENCE IS THE POINT, so it is pinned rather than left to be
    // "fixed" by whoever notices it next. ghostFilter also hides zero-stock
    // rows, and logging a replenishment for an out-of-stock SKU is the
    // commonest reason to open Add Purchase -- adopting it wholesale would
    // empty the picker of exactly the SKUs the seller came to buy again. This
    // repo has separately measured that an INACTIVE row holding stock is
    // usually STALE STOCK, not a dead listing, so calling it gone would tell
    // the seller to relist something that is still there.
    // Zero stock and no status: ghostFilter hides it (total 0 and not
    // "ACTIVE"), the extension keeps it. This is the replenishment case --
    // out of stock is the reason the seller is buying it again.
    const soldOut: InvRow = { sku: 'CC-GARLIC-15', listing_status: null };
    expect(isGhost(soldOut)).toBe(false);
    expect(isGhostRow({ ...soldOut, available: 0, reserved: 0, inbound: 0 })).toBe(true);
  });

  it('agrees with Synced Inventory on every status that means GONE', () => {
    const { isGhost } = backgroundRules();
    // The hard markers must never drift apart: these are the ones where both
    // modules have to reach the same answer.
    for (const listing_status of ['NOT_IN_CATALOG', 'DELETED']) {
      const row: InvRow = { sku: 'CC-GARLIC-15', listing_status };
      expect(isGhost(row), listing_status).toBe(true);
      expect(isGhostRow(row), listing_status).toBe(true);
    }
    // Amazon-grading auto-relists, both sides.
    expect(isGhost({ sku: 'amzn.gr.abc123', listing_status: 'ACTIVE' })).toBe(true);
    expect(isGhostRow({ sku: 'amzn.gr.abc123', listing_status: 'ACTIVE' })).toBe(true);
    // NOT_FOUND is a ghost for the extension. The label printer already refused
    // it; the picker used to offer it anyway, so one of the two rules was wrong.
    expect(isGhost({ sku: 'CC-GARLIC-15', listing_status: 'NOT_FOUND' })).toBe(true);
  });

  it('never tells the seller to wait for a sync that cannot happen', () => {
    // THE ACTUAL BUG, as a test. Any wording is fine as long as a dead listing
    // is not sent back to press Find again.
    const { detail } = panelMessages();

    const ghost = detail({ state: 'ghost', ghosts: GHOST_ROWS.map((r) => ({
      sku: r.sku!, listing_status: r.listing_status!, reason: null,
    })), purchase_history: 1 });
    expect(ghost).not.toMatch(/press Find again in a minute/i);
    expect(ghost).not.toMatch(/once Amazon has synced/i);
    expect(ghost).toMatch(/ghost/i);
    expect(ghost).toMatch(/Seller Central/);
    // It must name the SKUs, so the seller can check the claim rather than
    // take our word for it.
    expect(ghost).toContain('CC-GARLIC-15');
    expect(ghost).toContain('deleted');
    // And say where the card's details came from.
    expect(ghost).toMatch(/purchase history/i);

    const absent = detail({ state: 'absent', ghosts: [], purchase_history: 0 });
    expect(absent).not.toMatch(/press Find again in a minute/i);
    expect(absent).toMatch(/Seller Central/);
    // No purchase history, so no claim about where the details came from.
    expect(absent).not.toMatch(/purchase history/i);

    // The live case keeps the original advice, because there it is TRUE.
    const live = detail({ state: 'live', ghosts: [], purchase_history: 0 });
    expect(live).toMatch(/press Find again in a minute/i);

    // No verdict yet -> the generic wording, never a guess.
    expect(detail(null)).toBe(live);
  });

  it('the headline names the cause, and manufacturer-barcode mode still outranks it', () => {
    const { reason } = panelMessages();
    const ghost = { state: 'ghost' as const };

    // Missing FNSKU, listing gone.
    expect(reason('', DELETED_ASIN, ghost)).toMatch(/ghost/i);
    // Malformed FNSKU, listing gone: same cause, so the same headline.
    expect(reason('NOTANFNSKU', DELETED_ASIN, ghost)).toMatch(/ghost/i);
    // Missing FNSKU, nothing known: the original wording.
    expect(reason('', DELETED_ASIN, null)).toBe('Not safe to print — no valid Amazon FNSKU found.');
    expect(reason('', DELETED_ASIN, { state: 'absent' as const })).toMatch(/not in your Amazon inventory/i);

    // The FNSKU being the ASIN is positive evidence about the listing and must
    // keep winning: it was the one branch that already said something true.
    expect(reason(DELETED_ASIN, DELETED_ASIN, ghost)).toMatch(/manufacturer barcode/i);

    // A valid FNSKU is printable, and a ghost verdict must not block it on its
    // own -- the FBA eligibility check is what blocks, and it is separate.
    expect(reason('X0012345AB', DELETED_ASIN, ghost)).toBeNull();

    // Blank FNSKU and blank ASIN must not match each other into
    // manufacturer-barcode mode.
    expect(reason('', '', null)).toBe('Not safe to print — no valid Amazon FNSKU found.');
  });

  it('both panels read the verdict rather than re-deriving it', () => {
    // THE LESSON FROM THE RESERVED-UNITS TEST: proving the rule is right says
    // nothing about whether the code uses it. That test passed with the bug
    // reintroduced, because it only ever ran the extracted function.
    const bg = readFileSync(BG, 'utf8');
    const panel = readFileSync(PANEL, 'utf8');

    const from = bg.indexOf('case "INVSPRNT_FIND_LISTING"');
    expect(from, 'the find handler has gone').toBeGreaterThan(-1);
    const handler = bg.slice(from, bg.indexOf('case "INVSPRNT_SEARCH_BY_SUPPLIER"', from));

    expect(handler, 'the handler no longer computes the verdict')
      .toMatch(/listingPresenceVerdict\(asinRaw, invRows, liveRows, clRows\)/);
    // Outside data as well: data is null when the ASIN has no live SKU AND no
    // purchase history, which is the case where the verdict matters most.
    expect(handler, 'the verdict is no longer sent alongside data')
      .toMatch(/sendResponse\(\{ ok: true, data: row, presence \}\)/);
    // One ghost rule. A second inline copy is how the picker and the printer
    // came to disagree in the first place.
    expect(
      handler.match(/"NOT_IN_CATALOG"/g) || [],
      'the handler spells the ghost statuses out again instead of calling isGhostInventoryRow',
    ).toHaveLength(0);

    // Both panel surfaces must consume it.
    expect(panel, 'Print Label no longer reads the verdict').toMatch(/printState\.presence = r\.presence/);
    expect(panel, 'Add Purchase no longer reads the verdict').toMatch(/purchase\.presence = r\.presence/);
    expect(panel, 'Add Purchase no longer shows the ghost banner').toMatch(/renderPurchaseGhost\(\)/);
    // Cleared on a new Find, or a verdict outlives the ASIN it was about.
    expect(panel, 'the stale-verdict reset has gone').toMatch(/printState\.presence = null/);
    expect(panel, 'the stale-verdict reset has gone').toMatch(/purchase\.presence = null/);
  });
});
